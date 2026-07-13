"""Tests for cross-platform env detection (envinfo) and the adapt-env fixup."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def _load_module(rel_path: str, module_name: str):
    spec = importlib.util.spec_from_file_location(module_name, ROOT / rel_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def envinfo():
    return _load_module("scripts/init/envinfo.py", "fleet_envinfo")


@pytest.fixture
def adapt_env():
    return _load_module("scripts/adapt-env.py", "fleet_adapt_env")


def test_venv_python_layout_matches_os(envinfo):
    fw = Path("/opt/framework")
    result = envinfo.venv_python(fw)
    if envinfo.is_windows():
        assert result.endswith(".venv/Scripts/python.exe")
    else:
        assert result.endswith(".venv/bin/python")


def test_venv_python_is_posix_style(envinfo):
    # mcp.json values must be forward-slash so they never need JSON escaping.
    assert "\\" not in envinfo.venv_python(Path("/opt/framework"))


def test_detect_reports_framework_paths(envinfo):
    info = envinfo.detect(Path("/opt/framework"))
    assert info["venv_dir"] == info["framework_dir"] + "/.venv"
    assert info["framework_dir"].endswith("/opt/framework")
    assert info["is_windows"] in {"true", "false"}


def test_reroot_tool_arg_matches_by_suffix(adapt_env):
    fw = Path("/new/framework")
    # A foreign-OS absolute path is re-rooted by its tools/ suffix.
    linux_arg = "/home/old/enterprise-copilot-fleet-controller/tools/repo-index/server.py"
    assert adapt_env._reroot_tool_arg(linux_arg, fw) == "/new/framework/tools/repo-index/server.py"
    # A Windows-style path is handled too.
    win_arg = r"C:\old\framework\tools\usage-tracker\server.py"
    assert adapt_env._reroot_tool_arg(win_arg, fw) == "/new/framework/tools/usage-tracker/server.py"
    # Non-framework args are left alone.
    assert adapt_env._reroot_tool_arg("--flag", fw) == "--flag"


def test_adapt_mcp_config_rewrites_interpreter_and_paths(adapt_env, tmp_path):
    fw = tmp_path / "framework"
    proj = tmp_path / "project"
    cfg_path = proj / ".github" / "mcp.json"
    cfg_path.parent.mkdir(parents=True)
    cfg_path.write_text(
        json.dumps(
            {
                "mcpServers": {
                    "repo-index": {
                        "command": "/home/old/fw/.venv/bin/python",
                        "args": ["/home/old/fw/tools/repo-index/server.py"],
                        "env": {"PROJECT_DIR": "/home/old/project"},
                    }
                }
            }
        ),
        encoding="utf-8",
    )

    interpreter = "C:/framework/.venv/Scripts/python.exe"
    new_cfg, changed = adapt_env.adapt_mcp_config(cfg_path, fw, proj, interpreter)

    assert changed is True
    server = new_cfg["mcpServers"]["repo-index"]
    assert server["command"] == interpreter
    assert server["args"] == [(fw / "tools/repo-index/server.py").as_posix()]
    assert server["env"]["PROJECT_DIR"] == proj.as_posix()


def test_adapt_mcp_config_is_idempotent(adapt_env, tmp_path):
    fw = tmp_path / "framework"
    proj = tmp_path / "project"
    cfg_path = proj / ".github" / "mcp.json"
    cfg_path.parent.mkdir(parents=True)
    interpreter = adapt_env.venv_python(fw)
    cfg_path.write_text(
        json.dumps(
            {
                "mcpServers": {
                    "repo-index": {
                        "command": interpreter,
                        "args": [(fw / "tools/repo-index/server.py").as_posix()],
                        "env": {"PROJECT_DIR": proj.as_posix()},
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    _, changed = adapt_env.adapt_mcp_config(cfg_path, fw, proj, interpreter)
    assert changed is False


def test_adapt_ignores_non_tool_servers(adapt_env, tmp_path):
    fw = tmp_path / "framework"
    proj = tmp_path / "project"
    cfg_path = proj / ".github" / "mcp.json"
    cfg_path.parent.mkdir(parents=True)
    original = {
        "mcpServers": {
            "some-remote": {
                "command": "npx",
                "args": ["-y", "@vendor/mcp-server"],
            }
        }
    }
    cfg_path.write_text(json.dumps(original), encoding="utf-8")
    new_cfg, changed = adapt_env.adapt_mcp_config(cfg_path, fw, proj, adapt_env.venv_python(fw))
    assert changed is False
    assert new_cfg == original
