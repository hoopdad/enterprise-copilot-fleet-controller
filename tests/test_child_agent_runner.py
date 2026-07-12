from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch


SERVER_PATH = Path(__file__).resolve().parents[1] / "tools" / "child-agent-runner" / "server.py"
SPEC = importlib.util.spec_from_file_location("child_agent_runner_server", SERVER_PATH)
assert SPEC is not None and SPEC.loader is not None
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class ChildAgentRunnerTests(unittest.TestCase):
    def test_compact_job_omits_large_fields_by_default(self) -> None:
        job = {
            "job_id": "job-1",
            "status": "completed",
            "prompt": "p" * 10_000,
            "command": ["copilot", "x" * 10_000],
            "output": "o" * 10_000,
        }

        compact = runner._compact_job(job)

        self.assertEqual(compact["job_id"], "job-1")
        self.assertNotIn("prompt", compact)
        self.assertNotIn("command", compact)
        self.assertNotIn("output", compact)

    def test_compact_job_truncates_requested_output(self) -> None:
        job = {"job_id": "job-1", "status": "completed", "output": "o" * 500}

        compact = runner._compact_job(job, include_output=True, max_output_chars=200)

        self.assertEqual(len(compact["output"]), 200)
        self.assertTrue(compact["output"].endswith("..."))

    def test_stop_job_cancels_process_and_releases_lock(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_dir = Path(temp_dir)
            lock_file = runner._lock_path(project_dir, "repo-one")
            lock_file.write_text("test", encoding="utf-8")
            proc = subprocess.Popen(["sleep", "60"], start_new_session=True)
            job_id = "job-stop"
            runner._save_job(
                project_dir,
                job_id,
                {
                    "job_id": job_id,
                    "status": "running",
                    "repo": "repo-one",
                    "worker_pid": proc.pid,
                    "copilot_pid": proc.pid,
                    "lock_file": str(lock_file),
                    "created_at": runner._now_iso(),
                },
            )

            result = runner._stop_job_core(
                project_dir,
                job_id,
                force=False,
                grace_seconds=2,
                reason="unit test",
            )
            proc.wait(timeout=5)
            saved = json.loads(runner._job_path(project_dir, job_id).read_text(encoding="utf-8"))

            self.assertTrue(result["ok"])
            self.assertEqual(saved["status"], "cancelled")
            self.assertEqual(saved["cancel_reason"], "unit test")
            self.assertFalse(lock_file.exists())

    def test_stop_job_is_idempotent_for_terminal_job(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_dir = Path(temp_dir)
            runner._save_job(
                project_dir,
                "job-done",
                {
                    "job_id": "job-done",
                    "status": "completed",
                    "ok": True,
                    "created_at": runner._now_iso(),
                },
            )

            result = runner._stop_job_core(
                project_dir,
                "job-done",
                force=False,
                grace_seconds=1,
                reason="not needed",
            )

            self.assertTrue(result["ok"])
            self.assertEqual(result["status"], "already_finished")

    def test_recent_live_startup_lock_is_not_reclaimed(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_dir = Path(temp_dir)
            lock_file = runner._lock_path(project_dir, "repo-one")
            lock_file.write_text(str(os.getpid()), encoding="utf-8")

            acquired, returned_lock, holder = runner._acquire_repo_lock(project_dir, "repo-one")

            self.assertFalse(acquired)
            self.assertEqual(returned_lock, lock_file)
            self.assertEqual(holder["status"], "starting")
            self.assertEqual(holder["worker_pid"], os.getpid())

    def test_stale_startup_lock_is_reclaimed(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_dir = Path(temp_dir)
            lock_file = runner._lock_path(project_dir, "repo-one")
            lock_file.write_text(str(os.getpid()), encoding="utf-8")
            stale = time.time() - runner.LOCK_STARTUP_GRACE_SECONDS - 1
            os.utime(lock_file, (stale, stale))

            acquired, returned_lock, holder = runner._acquire_repo_lock(project_dir, "repo-one")

            self.assertTrue(acquired)
            self.assertEqual(returned_lock, lock_file)
            self.assertIsNone(holder)
            runner._release_lock(lock_file)

    def test_fast_worker_completion_is_not_overwritten_by_startup_handoff(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_dir = Path(temp_dir)
            repo_dir = project_dir / "child"
            (repo_dir / "work" / "todo").mkdir(parents=True)
            (repo_dir / "work" / "todo" / "request.md").write_text("work", encoding="utf-8")
            (project_dir / ".repo-index.yml").write_text(
                "repos:\n  - name: child\n    role: backend\n    local_path: child\n",
                encoding="utf-8",
            )

            class FastProc:
                pid = 43210

                def __init__(self, *args, **kwargs):
                    job_path = next((project_dir / ".metrics" / "child-agent-runner" / "jobs").glob("*.json"))
                    job = json.loads(job_path.read_text(encoding="utf-8"))
                    job.update({"status": "completed", "ok": True, "finished_at": runner._now_iso()})
                    runner._save_job(project_dir, job["job_id"], job)

            old_project_dir = os.environ.get("PROJECT_DIR")
            os.environ["PROJECT_DIR"] = str(project_dir)
            try:
                with patch.object(runner.subprocess, "Popen", FastProc):
                    result = runner._start_child_agent_job("child", 60, 1000)
            finally:
                if old_project_dir is None:
                    os.environ.pop("PROJECT_DIR", None)
                else:
                    os.environ["PROJECT_DIR"] = old_project_dir

            saved = runner._load_job(project_dir, result["job_id"])
            self.assertEqual(result["status"], "completed")
            self.assertTrue(result["ok"])
            self.assertEqual(saved["status"], "completed")
            runner._release_lock(Path(saved["lock_file"]))

    def test_async_worker_does_not_inherit_mcp_transport_stdin(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_dir = Path(temp_dir)
            repo_dir = project_dir / "child"
            (repo_dir / "work" / "todo").mkdir(parents=True)
            (repo_dir / "work" / "todo" / "request.md").write_text("work", encoding="utf-8")
            (project_dir / ".repo-index.yml").write_text(
                "repos:\n  - name: child\n    role: backend\n    local_path: child\n",
                encoding="utf-8",
            )
            captured: dict[str, object] = {}

            class WorkerProc:
                pid = 43211

                def __init__(self, *args, **kwargs):
                    captured.update(kwargs)

            old_project_dir = os.environ.get("PROJECT_DIR")
            os.environ["PROJECT_DIR"] = str(project_dir)
            try:
                with patch.object(runner.subprocess, "Popen", WorkerProc):
                    result = runner._start_child_agent_job("child", 60, 1000)
            finally:
                if old_project_dir is None:
                    os.environ.pop("PROJECT_DIR", None)
                else:
                    os.environ["PROJECT_DIR"] = old_project_dir

            self.assertEqual(captured["stdin"], subprocess.DEVNULL)
            job = runner._load_job(project_dir, result["job_id"])
            runner._release_lock(Path(job["lock_file"]))

    def test_child_copilot_does_not_inherit_mcp_transport_stdin(self) -> None:
        captured: dict[str, object] = {}

        class CopilotProc:
            pid = 43212
            stdout = None
            stderr = None

            def __init__(self, *args, **kwargs):
                captured.update(kwargs)

            def poll(self):
                return 0

            def communicate(self):
                return "", ""

        with patch.object(runner.subprocess, "Popen", CopilotProc), patch.object(runner.time, "sleep"):
            rc, stdout, stderr, error = runner._run_copilot_with_progress(
                project_dir=None,
                job_id=None,
                job=None,
                command=["copilot"],
                repo_dir=Path.cwd(),
                timeout_seconds=30,
            )

        self.assertEqual(rc, 0)
        self.assertEqual(stdout, "")
        self.assertEqual(stderr, "")
        self.assertIsNone(error)
        self.assertEqual(captured["stdin"], subprocess.DEVNULL)

    def test_job_command_scopes_parent_reference_directories(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_dir = Path(temp_dir)
            repo_dir = project_dir / "child"
            (repo_dir / "work" / "todo").mkdir(parents=True)
            (repo_dir / "work" / "todo" / "request.md").write_text("work", encoding="utf-8")
            for relative in (".requirements", ".contracts", ".copilot/guardrails", ".decisions", "docs"):
                (project_dir / relative).mkdir(parents=True)
            (project_dir / ".repo-index.yml").write_text(
                "repos:\n  - name: child\n    role: backend\n    local_path: child\n",
                encoding="utf-8",
            )
            old_project_dir = os.environ.get("PROJECT_DIR")
            os.environ["PROJECT_DIR"] = str(project_dir)
            try:
                setup = runner._resolve_job_setup("child", 60, 1000, "full")
            finally:
                if old_project_dir is None:
                    os.environ.pop("PROJECT_DIR", None)
                else:
                    os.environ["PROJECT_DIR"] = old_project_dir

            self.assertTrue(setup["ok"])
            command = setup["command"]
            added_dirs = [command[index + 1] for index, value in enumerate(command[:-1]) if value == "--add-dir"]
            self.assertIn(str(repo_dir), added_dirs)
            self.assertIn(str(project_dir / ".requirements"), added_dirs)
            self.assertIn(str(project_dir / ".contracts"), added_dirs)
            self.assertIn(str(project_dir / ".copilot" / "guardrails"), added_dirs)
            runner._release_lock(Path(setup["lock_file"]))

    def _make_repo(self, temp_dir: str) -> Path:
        project_dir = Path(temp_dir)
        repo_dir = project_dir / "child"
        (repo_dir / "work" / "todo").mkdir(parents=True)
        (repo_dir / "work" / "todo" / "request.md").write_text("work", encoding="utf-8")
        (project_dir / ".repo-index.yml").write_text(
            "repos:\n  - name: child\n    role: backend\n    local_path: child\n",
            encoding="utf-8",
        )
        return project_dir

    def test_setup_assigns_session_id_and_flag(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_dir = self._make_repo(temp_dir)
            with patch.dict(os.environ, {"PROJECT_DIR": str(project_dir)}):
                setup = runner._resolve_job_setup("child", 60, 1000, "specialist")
            self.assertTrue(setup["ok"])
            session_id = setup["session_id"]
            self.assertTrue(session_id)
            self.assertFalse(setup["resumed_session"])
            command = setup["command"]
            self.assertIn("--session-id", command)
            self.assertEqual(command[command.index("--session-id") + 1], session_id)
            runner._release_lock(Path(setup["lock_file"]))

    def test_setup_reuses_resume_session_id(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_dir = self._make_repo(temp_dir)
            with patch.dict(os.environ, {"PROJECT_DIR": str(project_dir)}):
                setup = runner._resolve_job_setup("child", 60, 1000, "specialist", resume_session_id="prior-123")
            self.assertEqual(setup["session_id"], "prior-123")
            self.assertTrue(setup["resumed_session"])
            runner._release_lock(Path(setup["lock_file"]))

    def test_parse_child_result_status_line(self) -> None:
        self.assertEqual(runner._parse_child_result("noise\nSTATUS: PASS\nmore")["verdict"], "PASS")
        self.assertEqual(runner._parse_child_result("STATUS: blocked")["verdict"], "BLOCKED")
        self.assertIsNone(runner._parse_child_result("no verdict here"))

    def test_parse_child_result_json_block_wins(self) -> None:
        output = (
            "prose\n```json\n"
            '{"verdict": "FAIL", "blocker": "tests red", "changed_commit": "abc123", "next_action": "fix"}\n'
            "```\ntrailing STATUS: PASS"
        )
        result = runner._parse_child_result(output)
        self.assertEqual(result["verdict"], "FAIL")
        self.assertEqual(result["blocker"], "tests red")
        self.assertEqual(result["changed_commit"], "abc123")
        self.assertEqual(result["source"], "result_block")

    def test_read_session_usage_sums_events(self) -> None:
        import sqlite3

        with tempfile.TemporaryDirectory() as temp_dir:
            store = Path(temp_dir) / "session-store.db"
            con = sqlite3.connect(store)
            con.execute(
                "CREATE TABLE assistant_usage_events (session_id TEXT, input_tokens INT, output_tokens INT, "
                "cache_read_tokens INT, cache_write_tokens INT, reasoning_tokens INT, total_nano_aiu INT)"
            )
            con.executemany(
                "INSERT INTO assistant_usage_events VALUES (?,?,?,?,?,?,?)",
                [("sess-A", 100, 10, 5, 1, 2, 500), ("sess-A", 200, 20, 0, 0, 3, 700), ("sess-B", 999, 9, 0, 0, 0, 9)],
            )
            con.commit()
            con.close()
            with patch.dict(os.environ, {"COPILOT_SESSION_STORE": str(store)}):
                usage = runner._read_session_usage("sess-A")
                self.assertEqual(usage["prompt_tokens"], 300)
                self.assertEqual(usage["completion_tokens"], 30)
                self.assertEqual(usage["total_tokens"], 330)
                self.assertEqual(usage["total_nano_aiu"], 1200)
                self.assertEqual(usage["usage_event_count"], 2)
                self.assertIsNone(runner._read_session_usage("sess-missing"))

    def test_tally_verdicts(self) -> None:
        results = [
            {"result": {"verdict": "PASS"}},
            {"result": {"verdict": "FAIL"}},
            {"status": "no_work"},
        ]
        tally = runner._tally_verdicts(results)
        self.assertEqual(tally, {"PASS": 1, "FAIL": 1, "BLOCKED": 0, "none": 1})


if __name__ == "__main__":
    unittest.main()
