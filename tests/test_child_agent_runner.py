from __future__ import annotations

import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


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


if __name__ == "__main__":
    unittest.main()
