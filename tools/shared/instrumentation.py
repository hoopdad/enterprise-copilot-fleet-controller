"""Auto-instrumentation for MCP tool servers — logs every invocation to .metrics/usage.jsonl.

Also provides log_usage_direct() for in-process usage tracking without MCP round-trips.
"""

import functools
import json
import os
import subprocess
import sys
import time
import uuid
from contextvars import ContextVar
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


METRICS_DIR = ".metrics"
METRICS_FILE = "usage.jsonl"
_PROCESS_RUN_ID = (
    os.environ.get("USAGE_RUN_ID")
    or os.environ.get("RUN_ID")
    or os.environ.get("COPILOT_SESSION_ID")
    or str(uuid.uuid4())
)
_CURRENT_EVENT_ID: ContextVar[Optional[str]] = ContextVar("current_usage_event_id", default=None)


def _get_project_dir() -> Path:
    """Resolve project directory from env or git root."""
    project_dir = os.environ.get("PROJECT_DIR")
    if project_dir:
        return Path(project_dir)
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            return Path(result.stdout.strip())
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
    return Path.cwd()


def _append_usage(entry: dict) -> None:
    """Append a usage entry to the project's metrics log."""
    try:
        project_dir = _get_project_dir()
        metrics_path = project_dir / METRICS_DIR
        metrics_path.mkdir(parents=True, exist_ok=True)
        log_file = metrics_path / METRICS_FILE

        entry["ts"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        entry["project"] = os.environ.get("PROJECT_NAME", project_dir.name)

        with open(log_file, "a") as f:
            f.write(json.dumps(entry, separators=(",", ":")) + "\n")
    except Exception as e:
        print(f"[instrumentation] metrics write failed: {e}", file=sys.stderr)


def _normalize_origin(origin: Optional[str], parent_event_id: Optional[str]) -> str:
    if origin in {"top_level", "nested"}:
        return origin
    return "nested" if parent_event_id else "top_level"


def _build_usage_entry(
    agent: str,
    action: str,
    tool: str = "",
    skill: str = "",
    detail: str = "",
    event_id: Optional[str] = None,
    run_id: Optional[str] = None,
    task_id: Optional[str] = None,
    parent_event_id: Optional[str] = None,
    origin: Optional[str] = None,
    status: Optional[str] = None,
    duration_ms: Optional[int] = None,
    error_type: Optional[str] = None,
    error_message: Optional[str] = None,
    prompt_tokens: Optional[int] = None,
    completion_tokens: Optional[int] = None,
    total_tokens: Optional[int] = None,
    estimated_token_savings: Optional[int] = None,
    baseline_total_tokens: Optional[int] = None,
    turn_count: Optional[int] = None,
    retry_count: Optional[int] = None,
    loop_hint: Optional[bool] = None,
    quality_score: Optional[float] = None,
    consistency_score: Optional[float] = None,
    outcome_confidence: Optional[float] = None,
    inherit_parent: bool = True,
) -> dict:
    parent = parent_event_id
    if inherit_parent and parent is None:
        parent = _CURRENT_EVENT_ID.get()
    entry: dict = {
        "event_id": event_id or str(uuid.uuid4()),
        "run_id": run_id or _PROCESS_RUN_ID,
        "agent": agent,
        "action": action,
        "origin": _normalize_origin(origin, parent),
    }
    if task_id:
        entry["task_id"] = task_id
    if parent:
        entry["parent_event_id"] = parent
    if tool:
        entry["tool"] = tool
    if skill:
        entry["skill"] = skill
    if detail:
        entry["detail"] = detail
    if status:
        entry["status"] = status
    if duration_ms is not None:
        entry["duration_ms"] = duration_ms
    if error_type:
        entry["error_type"] = error_type
    if error_message:
        entry["error_message"] = error_message
    if prompt_tokens is not None:
        entry["prompt_tokens"] = prompt_tokens
    if completion_tokens is not None:
        entry["completion_tokens"] = completion_tokens
    resolved_total_tokens = total_tokens
    if resolved_total_tokens is None and (prompt_tokens is not None or completion_tokens is not None):
        resolved_total_tokens = (prompt_tokens or 0) + (completion_tokens or 0)
    if resolved_total_tokens is not None:
        entry["total_tokens"] = resolved_total_tokens
    if estimated_token_savings is not None:
        entry["estimated_token_savings"] = estimated_token_savings
    if baseline_total_tokens is not None:
        entry["baseline_total_tokens"] = baseline_total_tokens
    if turn_count is not None:
        entry["turn_count"] = turn_count
    if retry_count is not None:
        entry["retry_count"] = retry_count
    if loop_hint is not None:
        entry["loop_hint"] = bool(loop_hint)
    if quality_score is not None:
        entry["quality_score"] = quality_score
    if consistency_score is not None:
        entry["consistency_score"] = consistency_score
    if outcome_confidence is not None:
        entry["outcome_confidence"] = outcome_confidence
    return entry


def log_usage_direct(
    agent: str,
    action: str,
    tool: str = "",
    skill: str = "",
    detail: str = "",
    event_id: Optional[str] = None,
    run_id: Optional[str] = None,
    task_id: Optional[str] = None,
    parent_event_id: Optional[str] = None,
    origin: Optional[str] = None,
    status: Optional[str] = None,
    duration_ms: Optional[int] = None,
    error_type: Optional[str] = None,
    error_message: Optional[str] = None,
    prompt_tokens: Optional[int] = None,
    completion_tokens: Optional[int] = None,
    total_tokens: Optional[int] = None,
    estimated_token_savings: Optional[int] = None,
    baseline_total_tokens: Optional[int] = None,
    turn_count: Optional[int] = None,
    retry_count: Optional[int] = None,
    loop_hint: Optional[bool] = None,
    quality_score: Optional[float] = None,
    consistency_score: Optional[float] = None,
    outcome_confidence: Optional[float] = None,
) -> str:
    """Log a usage event directly (in-process) without MCP round-trip.

    Use this from within MCP tool servers to record contextual usage events
    that include the calling agent's identity and intent.

    Args:
        agent: Agent identifier (e.g., "orchestrator", "specialist/api")
        action: What happened (e.g., "task_start", "tool_call", "task_complete")
        tool: MCP tool used, if applicable
        skill: Skill or capability exercised
        detail: Optional free-text context

    Returns:
        JSON string with status and file path.
    """
    entry = _build_usage_entry(
        agent=agent,
        action=action,
        tool=tool,
        skill=skill,
        detail=detail,
        event_id=event_id,
        run_id=run_id,
        task_id=task_id,
        parent_event_id=parent_event_id,
        origin=origin,
        status=status,
        duration_ms=duration_ms,
        error_type=error_type,
        error_message=error_message,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        total_tokens=total_tokens,
        estimated_token_savings=estimated_token_savings,
        baseline_total_tokens=baseline_total_tokens,
        turn_count=turn_count,
        retry_count=retry_count,
        loop_hint=loop_hint,
        quality_score=quality_score,
        consistency_score=consistency_score,
        outcome_confidence=outcome_confidence,
    )

    _append_usage(entry)

    project_dir = _get_project_dir()
    log_file = project_dir / METRICS_DIR / METRICS_FILE
    return json.dumps({"status": "logged", "file": str(log_file)})


def track_usage(server_name: str):
    """Decorator factory that logs tool invocations automatically.

    Usage:
        @mcp.tool()
        @track_usage("ci-monitor")
        def check_ci_status(repo: str, branch: str = "main") -> str:
            ...
    """
    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            event_id = kwargs.pop("_usage_event_id", None) or str(uuid.uuid4())
            run_id = kwargs.pop("_usage_run_id", None)
            task_id = kwargs.pop("_usage_task_id", None)
            parent_event_id = kwargs.pop("_usage_parent_event_id", None) or _CURRENT_EVENT_ID.get()
            origin = kwargs.pop("_usage_origin", None)
            start = time.perf_counter()
            token = _CURRENT_EVENT_ID.set(event_id)
            try:
                result = func(*args, **kwargs)
                _append_usage(_build_usage_entry(
                    agent="tool-auto",
                    action="tool_call",
                    tool=server_name,
                    detail=func.__name__,
                    event_id=event_id,
                    run_id=run_id,
                    task_id=task_id,
                    parent_event_id=parent_event_id,
                    origin=origin,
                    status="success",
                    duration_ms=int((time.perf_counter() - start) * 1000),
                    inherit_parent=False,
                ))
                return result
            except Exception as exc:
                _append_usage(_build_usage_entry(
                    agent="tool-auto",
                    action="tool_call",
                    tool=server_name,
                    detail=func.__name__,
                    event_id=event_id,
                    run_id=run_id,
                    task_id=task_id,
                    parent_event_id=parent_event_id,
                    origin=origin,
                    status="failure",
                    duration_ms=int((time.perf_counter() - start) * 1000),
                    error_type=type(exc).__name__,
                    error_message=str(exc),
                    inherit_parent=False,
                ))
                raise
            finally:
                _CURRENT_EVENT_ID.reset(token)
        return wrapper
    return decorator
