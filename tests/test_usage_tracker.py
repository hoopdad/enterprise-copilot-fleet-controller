from __future__ import annotations

import importlib.util
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


SERVER_PATH = Path(__file__).resolve().parents[1] / "tools" / "usage-tracker" / "server.py"
SPEC = importlib.util.spec_from_file_location("usage_tracker_server", SERVER_PATH)
assert SPEC is not None and SPEC.loader is not None
tracker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(tracker)


def _entry(ts: datetime, *, run_id: str = "run-1") -> dict:
    return {
        "ts": ts.isoformat(),
        "event_id": f"event-{ts.timestamp()}",
        "run_id": run_id,
        "agent": "tool-auto",
        "action": "tool_call",
        "tool": "child-agent-runner",
        "detail": "get_child_agent_job",
        "origin": "top_level",
        "status": "success",
    }


class UsageTrackerTests(unittest.TestCase):
    def test_duplicate_report_requires_a_short_same_run_burst(self) -> None:
        start = datetime.now(timezone.utc)
        entries = [
            _entry(start),
            _entry(start + timedelta(seconds=2)),
            _entry(start + timedelta(minutes=1)),
            _entry(start + timedelta(seconds=3), run_id="run-2"),
        ]

        report = tracker._build_quality_report(entries, min_events=1)

        self.assertEqual(len(report["duplicate_bursts"]), 1)
        burst = report["duplicate_bursts"][0]
        self.assertEqual(burst["run_id"], "run-1")
        self.assertEqual(burst["count"], 2)
        self.assertEqual(burst["window_seconds"], 2)

    def test_repeated_calls_over_time_are_not_reported_as_a_burst(self) -> None:
        start = datetime.now(timezone.utc)
        entries = [_entry(start), _entry(start + timedelta(seconds=30))]

        report = tracker._build_quality_report(entries, min_events=1)

        self.assertEqual(report["duplicate_bursts"], [])
        self.assertNotIn("duplicate_bursts", {flag["type"] for flag in report["flags"]})


if __name__ == "__main__":
    unittest.main()
