from __future__ import annotations

import importlib.util
import json
import shutil
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


@pytest.fixture
def child_runner_module():
    return _load_module("tools/child-agent-runner/server.py", "child_agent_runner_server")


@pytest.fixture
def repo_index_module():
    return _load_module("tools/repo-index/server.py", "repo_index_server")


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


def test_child_runner_rejects_unknown_repo(child_runner_module, monkeypatch):
    project_dir = ROOT / ".test-work" / "child-runner-unknown"
    project_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / ".repo-index.yml").write_text("repos: []\n", encoding="utf-8")
    monkeypatch.setenv("PROJECT_DIR", str(project_dir))

    payload = json.loads(child_runner_module.run_child_agent(repo="missing-repo"))
    assert payload["ok"] is False
    assert payload["error"]["code"] == "REPO_NOT_FOUND"


def test_child_runner_returns_no_work(child_runner_module, monkeypatch):
    project_dir = ROOT / ".test-work" / "child-runner-no-work" / "parent"
    child_dir = project_dir.parent / "api-no-work"
    child_dir.mkdir(parents=True, exist_ok=True)
    (child_dir / "work" / "todo").mkdir(parents=True, exist_ok=True)
    (project_dir / ".repo-index.yml").parent.mkdir(parents=True, exist_ok=True)
    (project_dir / ".repo-index.yml").write_text(
        "repos:\n"
        '  - name: "api-no-work"\n'
        '    role: "backend"\n'
        '    local_path: "../api-no-work"\n',
        encoding="utf-8",
    )
    monkeypatch.setenv("PROJECT_DIR", str(project_dir))

    payload = json.loads(child_runner_module.run_child_agent(repo="api-no-work"))
    assert payload["ok"] is True
    assert payload["status"] == "no_work"
    assert payload["queue_depth"] == 0


def test_child_runner_launches_scoped_copilot(child_runner_module, monkeypatch):
    project_dir = ROOT / ".test-work" / "child-runner-success" / "parent"
    child_dir = project_dir.parent / "api-success"
    todo_dir = child_dir / "work" / "todo"
    todo_dir.mkdir(parents=True, exist_ok=True)
    request_file = todo_dir / "request-001.md"
    request_file.write_text("request", encoding="utf-8")
    (project_dir / ".repo-index.yml").parent.mkdir(parents=True, exist_ok=True)
    (project_dir / ".repo-index.yml").write_text(
        "repos:\n"
        '  - name: "api-success"\n'
        '    role: "backend"\n'
        '    local_path: "../api-success"\n',
        encoding="utf-8",
    )
    monkeypatch.setenv("PROJECT_DIR", str(project_dir))

    seen: dict[str, object] = {}

    def fake_popen(command, cwd, **kwargs):
        seen["command"] = command
        seen["cwd"] = cwd
        # No stdout/stderr streams: the progress loop takes the sleep path,
        # then poll() reports a clean exit and communicate() yields the tail.
        return SimpleNamespace(
            pid=4321,
            stdout=None,
            stderr=None,
            poll=lambda: 0,
            communicate=lambda timeout=None: ("done", ""),
            kill=lambda: None,
            wait=lambda timeout=None: 0,
        )

    monkeypatch.setattr(child_runner_module.subprocess, "Popen", fake_popen)

    payload = json.loads(child_runner_module.run_child_agent(repo="api-success", timeout_seconds=90))
    assert payload["ok"] is True
    assert payload["status"] == "completed"
    assert payload["request_file"] == "work/todo/request-001.md"
    assert payload["exit_code"] == 0
    assert Path(payload["log_file"]).exists()

    command = seen["command"]
    assert isinstance(command, list)
    assert command[0] == "copilot"
    assert "--autopilot" in command
    assert "--no-ask-user" in command
    assert "--add-dir" in command
    assert "--session-id" in command
    assert str(child_dir.resolve()) in command
    assert seen["cwd"] == str(child_dir.resolve())


def test_child_runner_reports_lock(child_runner_module, monkeypatch):
    project_dir = ROOT / ".test-work" / "child-runner-lock" / "parent"
    child_dir = project_dir.parent / "api-lock"
    todo_dir = child_dir / "work" / "todo"
    todo_dir.mkdir(parents=True, exist_ok=True)
    (todo_dir / "request-001.md").write_text("request", encoding="utf-8")
    (project_dir / ".repo-index.yml").parent.mkdir(parents=True, exist_ok=True)
    (project_dir / ".repo-index.yml").write_text(
        "repos:\n"
        '  - name: "api-lock"\n'
        '    role: "backend"\n'
        '    local_path: "../api-lock"\n',
        encoding="utf-8",
    )
    monkeypatch.setenv("PROJECT_DIR", str(project_dir))

    lock_file = child_runner_module._lock_path(project_dir.resolve(), "api-lock")
    lock_file.parent.mkdir(parents=True, exist_ok=True)
    lock_file.write_text("123", encoding="utf-8")

    payload = json.loads(child_runner_module.run_child_agent(repo="api-lock"))
    assert payload["ok"] is False
    assert payload["error"]["code"] == "REPO_LOCKED"


def test_child_runner_batch_dispatches_multiple_repos(child_runner_module, monkeypatch):
    project_dir = ROOT / ".test-work" / "child-runner-batch" / "parent"
    api_dir = project_dir.parent / "api-batch"
    web_dir = project_dir.parent / "web-batch"
    (api_dir / "work" / "todo").mkdir(parents=True, exist_ok=True)
    (web_dir / "work" / "todo").mkdir(parents=True, exist_ok=True)
    (api_dir / "work" / "todo" / "request-api.md").write_text("api request", encoding="utf-8")
    (web_dir / "work" / "todo" / "request-web.md").write_text("web request", encoding="utf-8")
    (project_dir / ".repo-index.yml").parent.mkdir(parents=True, exist_ok=True)
    (project_dir / ".repo-index.yml").write_text(
        "repos:\n"
        '  - name: "api-batch"\n'
        '    role: "backend"\n'
        '    local_path: "../api-batch"\n'
        '  - name: "web-batch"\n'
        '    role: "frontend"\n'
        '    local_path: "../web-batch"\n',
        encoding="utf-8",
    )
    monkeypatch.setenv("PROJECT_DIR", str(project_dir))

    def fake_run(command, cwd, capture_output, text, timeout):
        return SimpleNamespace(returncode=0, stdout=f"ok:{Path(cwd).name}", stderr="")

    monkeypatch.setattr(child_runner_module.subprocess, "run", fake_run)

    payload = json.loads(child_runner_module.run_child_agents_batch(max_parallel=2, timeout_seconds=90))
    assert payload["ok"] is True
    assert payload["status"] == "completed"
    assert payload["summary"]["total"] == 2
    assert payload["summary"]["completed"] == 2
    assert payload["summary"]["failed"] == 0
    assert payload["summary"]["no_work"] == 0
    assert payload["worker_count"] == 2

    repos = {item["repo"] for item in payload["results"] if item.get("repo")}
    assert repos == {"api-batch", "web-batch"}


def test_repo_index_reports_queue_state(repo_index_module, monkeypatch):
    project_dir = ROOT / ".test-work" / "repo-index-queues" / "parent"
    api_dir = project_dir.parent / "api-queues"
    (api_dir / "work" / "todo").mkdir(parents=True, exist_ok=True)
    (api_dir / "work" / "ready-for-review").mkdir(parents=True, exist_ok=True)
    (api_dir / "work" / "done").mkdir(parents=True, exist_ok=True)
    (api_dir / "work" / "todo" / "todo-1.yml").write_text("todo", encoding="utf-8")
    (api_dir / "work" / "ready-for-review" / "rfr-1.yml").write_text("rfr", encoding="utf-8")
    (api_dir / "work" / "done" / "done-1.yml").write_text("done", encoding="utf-8")

    (project_dir / ".repo-index.yml").parent.mkdir(parents=True, exist_ok=True)
    (project_dir / ".repo-index.yml").write_text(
        "repos:\n"
        '  - name: "api-queues"\n'
        '    role: "backend"\n'
        '    local_path: "../api-queues"\n',
        encoding="utf-8",
    )
    monkeypatch.setenv("PROJECT_DIR", str(project_dir))

    payload = json.loads(repo_index_module.check_repo_queues(project_dir=str(project_dir)))
    assert payload["ok"] is True
    assert len(payload["repos"]) == 1
    repo = payload["repos"][0]
    assert repo["name"] == "api-queues"
    assert repo["queues"]["todo"]["count"] == 1
    assert repo["queues"]["ready_for_review"]["count"] == 1
    assert repo["queues"]["done"]["count"] == 1
    assert repo["queues"]["todo"]["files"] == ["todo-1.yml"]


def test_child_runner_start_async_returns_job(child_runner_module, monkeypatch):
    project_dir = ROOT / ".test-work" / "child-runner-async-start" / "parent"
    child_dir = project_dir.parent / "api-async"
    todo_dir = child_dir / "work" / "todo"
    todo_dir.mkdir(parents=True, exist_ok=True)
    (todo_dir / "request-001.md").write_text("request", encoding="utf-8")
    (project_dir / ".repo-index.yml").parent.mkdir(parents=True, exist_ok=True)
    (project_dir / ".repo-index.yml").write_text(
        "repos:\n"
        '  - name: "api-async"\n'
        '    role: "backend"\n'
        '    local_path: "../api-async"\n',
        encoding="utf-8",
    )
    monkeypatch.setenv("PROJECT_DIR", str(project_dir))

    class FakeProc:
        def __init__(self, pid: int):
            self.pid = pid

    monkeypatch.setattr(child_runner_module.subprocess, "Popen", lambda *args, **kwargs: FakeProc(12345))
    monkeypatch.setattr(child_runner_module, "_is_pid_alive", lambda pid: True)

    payload = json.loads(child_runner_module.start_child_agent(repo="api-async", timeout_seconds=90))
    assert payload["ok"] is True
    assert payload["status"] == "started"
    assert payload["repo"] == "api-async"
    assert payload["worker_pid"] == 12345
    assert payload.get("job_id")

    job_payload = json.loads(child_runner_module.get_child_agent_job(job_id=payload["job_id"]))
    assert job_payload["ok"] is True
    assert job_payload["job"]["job_id"] == payload["job_id"]
    assert job_payload["job"]["status"] == "running"

    child_runner_module._release_lock(Path(job_payload["job"]["lock_file"]))


def test_child_runner_async_batch_start(child_runner_module, monkeypatch):
    project_dir = ROOT / ".test-work" / "child-runner-async-batch" / "parent"
    # Clean any leftover job state: this test stubs _is_pid_alive to always-True,
    # so stale job records from a prior run would otherwise consume all slots.
    shutil.rmtree(project_dir.parent, ignore_errors=True)
    api_dir = project_dir.parent / "api-async-batch"
    web_dir = project_dir.parent / "web-async-batch"
    (api_dir / "work" / "todo").mkdir(parents=True, exist_ok=True)
    (web_dir / "work" / "todo").mkdir(parents=True, exist_ok=True)
    (api_dir / "work" / "todo" / "request-api.md").write_text("api request", encoding="utf-8")
    (web_dir / "work" / "todo" / "request-web.md").write_text("web request", encoding="utf-8")
    (project_dir / ".repo-index.yml").parent.mkdir(parents=True, exist_ok=True)
    (project_dir / ".repo-index.yml").write_text(
        "repos:\n"
        '  - name: "api-async-batch"\n'
        '    role: "backend"\n'
        '    local_path: "../api-async-batch"\n'
        '  - name: "web-async-batch"\n'
        '    role: "frontend"\n'
        '    local_path: "../web-async-batch"\n',
        encoding="utf-8",
    )
    monkeypatch.setenv("PROJECT_DIR", str(project_dir))

    class FakeProc:
        def __init__(self, pid: int):
            self.pid = pid

    pids = iter([20001, 20002])
    monkeypatch.setattr(child_runner_module.subprocess, "Popen", lambda *args, **kwargs: FakeProc(next(pids)))
    monkeypatch.setattr(child_runner_module, "_is_pid_alive", lambda pid: True)

    payload = json.loads(child_runner_module.start_child_agents_batch(max_parallel=2, timeout_seconds=90))
    assert payload["ok"] is True
    assert payload["summary"]["requested"] == 2
    assert payload["summary"]["started"] == 2
    assert payload["summary"]["deferred_capacity"] == 0

    for result in payload["results"]:
        if result.get("status") == "started":
            job = json.loads(child_runner_module.get_child_agent_job(job_id=result["job_id"]))
            child_runner_module._release_lock(Path(job["job"]["lock_file"]))
