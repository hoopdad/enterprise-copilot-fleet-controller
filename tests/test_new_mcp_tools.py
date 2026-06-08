from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]


def _load_module(rel_path: str, module_name: str):
    module_path = ROOT / rel_path
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def azure_module():
    return _load_module("tools/azure-resource-status/server.py", "azure_resource_status_server")


@pytest.fixture
def azure_inspector_module():
    return _load_module("tools/azure-inspector/server.py", "azure_inspector_server")


@pytest.fixture
def lint_module():
    return _load_module("tools/lint-local/server.py", "lint_local_server")


@pytest.fixture
def terraform_module():
    return _load_module("tools/terraform-local/server.py", "terraform_local_server")


def test_azure_list_resources_persists_inventory(azure_module, monkeypatch):
    test_root = ROOT / ".test-work" / "pytest-azure-list"
    local_dir = test_root / ".local"
    resource_file = local_dir / "azure-resources.json"
    resources = [
        {
            "id": "/subscriptions/s1/resourceGroups/rg/providers/Microsoft.App/containerApps/api",
            "name": "api",
            "type": "Microsoft.App/containerApps",
            "resourceGroup": "rg",
            "location": "eastus2",
        }
    ]

    monkeypatch.setattr(azure_module, "_LOCAL_DIR", local_dir)
    monkeypatch.setattr(azure_module, "_RESOURCE_FILE", resource_file)
    monkeypatch.setattr(azure_module, "_run_az", lambda args, timeout=90: resources)

    payload = json.loads(azure_module.list_azure_resources(resource_group="rg"))
    assert payload["ok"] is True
    assert payload["resource_count"] == 1
    assert resource_file.exists()


def test_azure_run_az_strips_warning_lines(azure_module, monkeypatch):
    fake_proc = SimpleNamespace(returncode=0, stdout="", stderr='WARNING: noisy\n{"foo": "bar"}\n')
    monkeypatch.setattr(azure_module.subprocess, "run", lambda *args, **kwargs: fake_proc)

    output = azure_module._run_az(["resource", "show", "--ids", "id-a"])
    assert output == {"foo": "bar"}


def test_azure_find_error_includes_context(azure_module, monkeypatch):
    inventory = [{"id": "id-a", "name": "api", "type": "Microsoft.App/containerApps"}]
    events = [
        {"eventTimestamp": "2026-05-28T12:00:00Z", "level": "Informational", "status": {"value": "Started"}},
        {
            "eventTimestamp": "2026-05-28T12:00:03Z",
            "level": "Error",
            "status": {"value": "Failed"},
            "subStatus": {"value": "BadRequest"},
            "properties": {"statusMessage": "Image pull failed"},
        },
        {"eventTimestamp": "2026-05-28T12:00:05Z", "level": "Informational", "status": {"value": "Completed"}},
    ]

    monkeypatch.setattr(azure_module, "_load_resource_inventory", lambda: inventory)
    monkeypatch.setattr(azure_module, "_run_az", lambda args, timeout=90: events)

    payload = json.loads(azure_module.find_error(all_resources=True, context_window=1))
    assert payload["ok"] is True
    assert payload["results"][0]["error_count"] == 1
    assert len(payload["results"][0]["errors"][0]["context"]) == 3


def test_azure_status_handles_malformed_inventory(azure_module, monkeypatch):
    inventory = [{"id": "id-a", "name": "api", "type": "Microsoft.App/containerApps"}, "bad-entry"]

    monkeypatch.setattr(azure_module, "_load_resource_inventory", lambda: inventory)
    monkeypatch.setattr(
        azure_module,
        "_status_for_resource",
        lambda resource: {"status": "ready"} if isinstance(resource, dict) else {"status": "unknown"},
    )

    payload = json.loads(azure_module.get_azure_status(all_resources=True))
    assert payload["ok"] is True
    assert payload["checked_count"] == 2
    assert payload["results"][1]["status"]["status"] == "unknown"


def test_azure_inspector_rejects_string_json(azure_inspector_module, monkeypatch):
    fake_proc = SimpleNamespace(returncode=0, stdout='"oops"', stderr="")
    monkeypatch.setattr(azure_inspector_module.subprocess, "run", lambda *args, **kwargs: fake_proc)

    payload = json.loads(azure_inspector_module.inspect_container_app(name="app", resource_group="rg"))
    assert payload["error"].startswith("Invalid response shape")


def test_lint_local_rejects_unknown_linter(lint_module):
    payload = json.loads(lint_module.run_local_lint(linter="flake8"))
    assert payload["ok"] is False
    assert payload["error"]["code"] == "UNSUPPORTED_LINTER"


def test_lint_local_executes_whitelisted_command(lint_module, monkeypatch):
    commands = []

    def fake_run(command, capture_output, text, timeout):
        commands.append(command)
        return SimpleNamespace(returncode=0, stdout="[]", stderr="")

    monkeypatch.setattr(lint_module.subprocess, "run", fake_run)

    payload = json.loads(lint_module.run_local_lint(linter="ruff", target="tools"))
    assert payload["ok"] is True
    assert payload["passed"] is True
    assert commands[0][0:3] == ["ruff", "check", "--output-format"]


def test_lint_local_rejects_target_outside_workspace(lint_module):
    payload = json.loads(lint_module.run_local_lint(linter="ruff", target="../"))
    assert payload["ok"] is False
    assert payload["error"]["code"] == "INVALID_TARGET"


def test_terraform_init_validate_happy_path(terraform_module, monkeypatch):
    tf_dir = ROOT / ".test-work" / "terraform-happy"
    tf_dir.mkdir(parents=True, exist_ok=True)
    (tf_dir / "main.tf").write_text("terraform {}\n", encoding="utf-8")

    calls = []

    def fake_run(args, cwd, capture_output, text, timeout):
        calls.append(args)
        if args[1] == "init":
            return SimpleNamespace(returncode=0, stdout="init ok", stderr="")
        return SimpleNamespace(returncode=0, stdout="validate ok", stderr="")

    monkeypatch.setattr(terraform_module.subprocess, "run", fake_run)

    payload = json.loads(terraform_module.terraform_init_validate(terraform_dir=str(tf_dir)))
    assert payload["ok"] is True
    assert payload["validate"]["valid"] is True
    assert calls[0][0:2] == ["terraform", "init"]


def test_terraform_plan_detects_changes(terraform_module, monkeypatch):
    tf_dir = ROOT / ".test-work" / "terraform-plan"
    tf_dir.mkdir(parents=True, exist_ok=True)
    (tf_dir / "main.tf").write_text("terraform {}\n", encoding="utf-8")

    def fake_run(args, cwd, capture_output, text, timeout):
        return SimpleNamespace(returncode=2, stdout="Plan: 1 to add", stderr="")

    monkeypatch.setattr(terraform_module.subprocess, "run", fake_run)

    payload = json.loads(terraform_module.terraform_plan_check(terraform_dir=str(tf_dir)))
    assert payload["ok"] is True
    assert payload["changes_present"] is True


def test_terraform_rejects_dir_outside_workspace(terraform_module):
    payload = json.loads(terraform_module.terraform_fmt_check(terraform_dir="../"))
    assert payload["ok"] is False
    assert payload["error"]["code"] == "INVALID_TERRAFORM_DIR"
