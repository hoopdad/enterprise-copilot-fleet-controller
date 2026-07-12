"""Usage Tracker MCP Server — logs agent/tool/skill usage to a project-local JSONL file."""

import json
import os
import subprocess
import uuid
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("usage-tracker")

METRICS_DIR = ".metrics"
METRICS_FILE = "usage.jsonl"
_PROCESS_RUN_ID = (
    os.environ.get("USAGE_RUN_ID")
    or os.environ.get("RUN_ID")
    or os.environ.get("COPILOT_SESSION_ID")
    or str(uuid.uuid4())
)
_SENSITIVE_PATTERNS = (
    re.compile(r"(?i)\bsk-[A-Za-z0-9_-]{8,}\b"),
    re.compile(r"(?i)\bgh[pousr]_[A-Za-z0-9_]{8,}\b"),
    re.compile(r"\b[A-Fa-f0-9]{32,}\b"),
)
DUPLICATE_BURST_WINDOW_SECONDS = 10


def get_project_dir() -> Path:
    """Resolve the project directory from env or git root."""
    project_dir = os.environ.get("PROJECT_DIR")
    if project_dir:
        return Path(project_dir)
    # Fallback: git root
    result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        capture_output=True, text=True, timeout=5
    )
    if result.returncode == 0:
        return Path(result.stdout.strip())
    return Path.cwd()


def ensure_metrics_dir(project_dir: Path) -> Path:
    metrics_path = project_dir / METRICS_DIR
    metrics_path.mkdir(parents=True, exist_ok=True)
    return metrics_path


def append_entry(entry: dict) -> Path:
    """Append a JSON entry to the usage log. Returns the file path."""
    project_dir = get_project_dir()
    metrics_path = ensure_metrics_dir(project_dir)
    log_file = metrics_path / METRICS_FILE

    entry["ts"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    entry["project"] = os.environ.get("PROJECT_NAME", project_dir.name)

    with open(log_file, "a") as f:
        f.write(json.dumps(entry, separators=(",", ":")) + "\n")

    return log_file


def _parse_iso_timestamp(value: str) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _redact_text(value: object, limit: int = 120) -> str:
    text = str(value)
    for pattern in _SENSITIVE_PATTERNS:
        text = pattern.sub("[redacted]", text)
    if len(text) > limit:
        text = text[: limit - 3] + "..."
    return text


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
) -> dict:
    entry: dict = {
        "event_id": event_id or str(uuid.uuid4()),
        "run_id": run_id or _PROCESS_RUN_ID,
        "agent": agent,
        "action": action,
        "origin": _normalize_origin(origin, parent_event_id),
    }
    if task_id:
        entry["task_id"] = task_id
    if parent_event_id:
        entry["parent_event_id"] = parent_event_id
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


def _load_usage_entries(days: int) -> list[dict]:
    project_dir = get_project_dir()
    log_file = project_dir / METRICS_DIR / METRICS_FILE

    if not log_file.exists():
        return []

    cutoff = datetime.now(timezone.utc).timestamp() - (days * 86400)
    entries: list[dict] = []

    with open(log_file) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue

            entry_ts = _parse_iso_timestamp(entry.get("ts", ""))
            if entry_ts is None:
                continue
            if entry_ts.timestamp() >= cutoff:
                entries.append(entry)

    return entries


def _percentile(values: list[int], pct: float) -> Optional[int]:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    index = (len(ordered) - 1) * pct
    lower = int(index)
    upper = min(lower + 1, len(ordered) - 1)
    if lower == upper:
        return ordered[lower]
    fraction = index - lower
    return int(round(ordered[lower] + (ordered[upper] - ordered[lower]) * fraction))


def _duration_stats(durations: list[int]) -> dict:
    if not durations:
        return {"count": 0}
    ordered = sorted(durations)
    total = sum(ordered)
    return {
        "count": len(ordered),
        "min_ms": ordered[0],
        "median_ms": _percentile(ordered, 0.5),
        "p95_ms": _percentile(ordered, 0.95),
        "max_ms": ordered[-1],
        "avg_ms": round(total / len(ordered), 1),
    }


def _coerce_non_negative_int(value: object) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        int_value = int(value)
    elif isinstance(value, str):
        try:
            int_value = int(float(value.strip()))
        except ValueError:
            return None
    else:
        return None
    if int_value < 0:
        return None
    return int_value


def _coerce_score(value: object) -> Optional[float]:
    if isinstance(value, bool):
        return None
    try:
        score = float(value)
    except (TypeError, ValueError):
        return None
    if score < 0:
        return None
    return round(score, 3)


def _average(values: list[float]) -> Optional[float]:
    if not values:
        return None
    return round(sum(values) / len(values), 3)


def _tool_health(entries: list[dict]) -> list[dict]:
    per_tool: dict[str, dict] = {}
    for entry in entries:
        tool = entry.get("tool")
        if not tool:
            continue
        bucket = per_tool.setdefault(tool, {"calls": 0, "failures": 0, "durations": []})
        bucket["calls"] += 1
        if entry.get("status") == "failure":
            bucket["failures"] += 1
        duration = entry.get("duration_ms")
        if isinstance(duration, (int, float)):
            bucket["durations"].append(int(duration))

    results = []
    for tool, bucket in sorted(per_tool.items(), key=lambda item: (-item[1]["calls"], item[0])):
        calls = bucket["calls"]
        failures = bucket["failures"]
        failure_rate = round(failures / calls, 3) if calls else 0.0
        results.append({
            "tool": tool,
            "calls": calls,
            "failures": failures,
            "failure_rate": failure_rate,
            "duration": _duration_stats(bucket["durations"]),
        })
    return results


def _build_quality_report(entries: list[dict], min_events: int) -> dict:
    total = len(entries)
    event_ids = sum(1 for e in entries if e.get("event_id"))
    run_ids = sum(1 for e in entries if e.get("run_id"))
    durations = [int(e["duration_ms"]) for e in entries if isinstance(e.get("duration_ms"), (int, float))]
    top_level = sum(1 for e in entries if e.get("origin") == "top_level")
    nested = sum(1 for e in entries if e.get("origin") == "nested")
    successes = sum(1 for e in entries if e.get("status") == "success")
    failures = sum(1 for e in entries if e.get("status") == "failure")
    outcome_actions = {"task_complete", "deploy_verified", "pr_merged", "acceptance_passed", "ci_green"}
    outcome_events = [e for e in entries if e.get("action") in outcome_actions]
    prompt_tokens = [_coerce_non_negative_int(e.get("prompt_tokens")) for e in entries]
    completion_tokens = [_coerce_non_negative_int(e.get("completion_tokens")) for e in entries]
    total_tokens = []
    estimated_token_savings = []
    baseline_total_tokens = []
    turn_counts = []
    retry_counts = []
    loop_hint_events = 0
    quality_scores = []
    consistency_scores = []
    outcome_confidences = []
    for entry in entries:
        prompt = _coerce_non_negative_int(entry.get("prompt_tokens"))
        completion = _coerce_non_negative_int(entry.get("completion_tokens"))
        total_token_value = _coerce_non_negative_int(entry.get("total_tokens"))
        if total_token_value is None and (prompt is not None or completion is not None):
            total_token_value = (prompt or 0) + (completion or 0)
        if total_token_value is not None:
            total_tokens.append(total_token_value)

        token_savings = _coerce_non_negative_int(entry.get("estimated_token_savings"))
        if token_savings is not None:
            estimated_token_savings.append(token_savings)
        baseline_tokens = _coerce_non_negative_int(entry.get("baseline_total_tokens"))
        if baseline_tokens is not None:
            baseline_total_tokens.append(baseline_tokens)

        turn_count = _coerce_non_negative_int(entry.get("turn_count"))
        if turn_count is not None:
            turn_counts.append(turn_count)
        retry_count = _coerce_non_negative_int(entry.get("retry_count"))
        if retry_count is not None:
            retry_counts.append(retry_count)

        if entry.get("loop_hint") is True:
            loop_hint_events += 1

        quality = _coerce_score(entry.get("quality_score"))
        if quality is not None:
            quality_scores.append(quality)
        consistency = _coerce_score(entry.get("consistency_score"))
        if consistency is not None:
            consistency_scores.append(consistency)
        confidence = _coerce_score(entry.get("outcome_confidence"))
        if confidence is not None:
            outcome_confidences.append(confidence)

    prompt_token_values = [v for v in prompt_tokens if v is not None]
    completion_token_values = [v for v in completion_tokens if v is not None]
    retry_total = sum(retry_counts)
    run_turns: dict[str, int] = {}
    for entry in entries:
        run_id = entry.get("run_id")
        if not isinstance(run_id, str) or not run_id:
            continue
        turn_count = _coerce_non_negative_int(entry.get("turn_count"))
        if turn_count is None:
            continue
        run_turns[run_id] = max(run_turns.get(run_id, 0), turn_count)

    estimated_savings_total = sum(estimated_token_savings)
    baseline_total = sum(baseline_total_tokens)
    savings_rate = round(estimated_savings_total / baseline_total, 3) if baseline_total else None
    avg_turns_per_run = round(sum(run_turns.values()) / len(run_turns), 3) if run_turns else None
    retry_event_count = sum(1 for retry in retry_counts if retry > 0)
    low_confidence_events = sum(1 for score in outcome_confidences if score < 0.5)
    low_consistency_events = sum(1 for score in consistency_scores if score < 0.5)
    legacy_or_missing = total - sum(1 for e in entries if e.get("origin") in {"top_level", "nested"})
    sorted_entries = sorted(
        [e for e in entries if _parse_iso_timestamp(e.get("ts", "")) is not None],
        key=lambda e: _parse_iso_timestamp(e.get("ts", "")).timestamp(),
    )
    duplicate_sequences: dict[tuple, list[list[dict]]] = {}
    for entry in sorted_entries:
        key = (
            entry.get("run_id", ""),
            entry.get("agent", ""),
            entry.get("action", ""),
            entry.get("tool", ""),
            entry.get("skill", ""),
            entry.get("detail", ""),
        )
        sequences = duplicate_sequences.setdefault(key, [])
        timestamp = _parse_iso_timestamp(entry.get("ts", ""))
        if sequences:
            previous = _parse_iso_timestamp(sequences[-1][-1].get("ts", ""))
            if previous is not None and timestamp is not None:
                if (timestamp - previous).total_seconds() <= DUPLICATE_BURST_WINDOW_SECONDS:
                    sequences[-1].append(entry)
                    continue
        sequences.append([entry])

    duplicate_bursts = [
        {
            "run_id": key[0],
            "agent": key[1],
            "action": key[2],
            "tool": key[3],
            "detail": _redact_text(key[5]),
            "count": len(sequence),
            "window_seconds": int(
                (
                    _parse_iso_timestamp(sequence[-1].get("ts", ""))
                    - _parse_iso_timestamp(sequence[0].get("ts", ""))
                ).total_seconds()
            ),
        }
        for key, sequences in duplicate_sequences.items()
        for sequence in sequences
        if len(sequence) >= 2
    ]
    duplicate_bursts.sort(key=lambda item: (-item["count"], item["run_id"], item["tool"], item["detail"]))

    flags = []
    if total < min_events:
        flags.append({
            "type": "low_volume",
            "message": f"Only {total} events in the lookback window; metrics are directional at best.",
        })
    if total and nested / total > 0.6:
        flags.append({
            "type": "high_nested_ratio",
            "message": f"Nested events make up {round((nested / total) * 100, 1)}% of the window.",
        })
    if total and failures / total > 0.2:
        flags.append({
            "type": "high_failure_rate",
            "message": f"Failures make up {round((failures / total) * 100, 1)}% of the window.",
        })
    if duplicate_bursts:
        flags.append({
            "type": "duplicate_bursts",
            "message": (
                f"Repeated identical calls within {DUPLICATE_BURST_WINDOW_SECONDS}s "
                "suggest fan-out or retry loops."
            ),
            "count": len(duplicate_bursts),
        })
    if outcome_events:
        flags.append({
            "type": "outcome_signal_present",
            "message": f"Observed {len(outcome_events)} outcome-linked events.",
        })
    avg_tokens_per_event = _average(total_tokens)
    if avg_tokens_per_event is not None and avg_tokens_per_event > 4000:
        flags.append({
            "type": "high_token_spend",
            "message": f"Average tokens per instrumented event is {avg_tokens_per_event}.",
        })
    if savings_rate is not None and savings_rate < 0.05:
        flags.append({
            "type": "low_token_savings",
            "message": f"Estimated token savings rate is {round(savings_rate * 100, 1)}%.",
        })
    if avg_turns_per_run is not None and avg_turns_per_run > 10:
        flags.append({
            "type": "high_turn_count",
            "message": f"Average turn count per run is {avg_turns_per_run}.",
        })
    retry_rate = round(retry_event_count / len(retry_counts), 3) if retry_counts else 0.0
    if retry_total > 0 or loop_hint_events > 0:
        flags.append({
            "type": "retry_loop_hints",
            "message": f"Observed {retry_total} retries and {loop_hint_events} loop hints.",
        })
    confidence_avg = _average(outcome_confidences)
    if confidence_avg is not None and confidence_avg < 0.6:
        flags.append({
            "type": "low_outcome_confidence",
            "message": f"Average outcome confidence is {confidence_avg}.",
        })
    consistency_avg = _average(consistency_scores)
    if consistency_avg is not None and consistency_avg < 0.6:
        flags.append({
            "type": "low_consistency",
            "message": f"Average consistency score is {consistency_avg}.",
        })

    recommendations = []
    if total < min_events:
        recommendations.append("Collect more runs before making strong claims about usage quality.")
    if failures and failures / max(total, 1) > 0.1:
        recommendations.append("Reduce failing tool invocations or improve preflight checks.")
    if duplicate_bursts:
        recommendations.append("Separate orchestrated fan-out from retries so repeated calls are explicit.")
    if not outcome_events:
        recommendations.append("Add explicit outcome events such as task_complete, ci_green, or deploy_verified.")
    if avg_tokens_per_event is not None and avg_tokens_per_event > 4000:
        recommendations.append("Trim prompts/tool payloads or cache context to reduce token use.")
    if savings_rate is not None and savings_rate < 0.05:
        recommendations.append("Instrument baseline_total_tokens + estimated_token_savings with stronger token optimization tactics.")
    if avg_turns_per_run is not None and avg_turns_per_run > 10:
        recommendations.append("Reduce turn count by clarifying plans up front and tightening delegation boundaries.")
    if retry_total > 0 or loop_hint_events > 0:
        recommendations.append("Tag retries explicitly and add loop guards when repeated calls are expected.")
    if confidence_avg is not None and confidence_avg < 0.6:
        recommendations.append("Increase outcome confidence by adding stronger acceptance checks before task completion.")
    if consistency_avg is not None and consistency_avg < 0.6:
        recommendations.append("Investigate high-variance runs and standardize execution paths for better consistency.")
    if not recommendations:
        recommendations.append("Usage appears healthy; keep monitoring the same signals over time.")

    evidence = []
    for entry in sorted_entries[:5]:
        evidence.append({
            "event_id": entry.get("event_id"),
            "run_id": entry.get("run_id"),
            "agent": entry.get("agent"),
            "action": entry.get("action"),
            "tool": entry.get("tool"),
            "origin": entry.get("origin"),
            "status": entry.get("status"),
            "detail": _redact_text(entry.get("detail", "")),
            "error_message": _redact_text(entry.get("error_message", "")) if entry.get("error_message") else "",
        })

    return {
        "summary": {
            "total_events": total,
            "events_with_event_id": event_ids,
            "events_with_run_id": run_ids,
            "top_level_events": top_level,
            "nested_events": nested,
            "successes": successes,
            "failures": failures,
            "top_level_ratio": round(top_level / total, 3) if total else 0.0,
            "nested_ratio": round(nested / total, 3) if total else 0.0,
            "success_rate": round(successes / total, 3) if total else 0.0,
            "failure_rate": round(failures / total, 3) if total else 0.0,
            "legacy_or_missing_origin": legacy_or_missing,
            "outcome_events": len(outcome_events),
            "duration": _duration_stats(durations),
            "token_metrics": {
                "events_with_prompt_tokens": len(prompt_token_values),
                "events_with_completion_tokens": len(completion_token_values),
                "events_with_total_tokens": len(total_tokens),
                "total_prompt_tokens": sum(prompt_token_values),
                "total_completion_tokens": sum(completion_token_values),
                "total_tokens": sum(total_tokens),
                "avg_total_tokens_per_event": avg_tokens_per_event,
                "p95_total_tokens_per_event": _percentile(total_tokens, 0.95),
                "events_with_estimated_savings": len(estimated_token_savings),
                "estimated_token_savings_total": estimated_savings_total,
                "baseline_total_tokens": baseline_total,
                "estimated_token_savings_rate": savings_rate,
            },
            "turn_metrics": {
                "events_with_turn_count": len(turn_counts),
                "avg_turn_count": _average(turn_counts),
                "p95_turn_count": _percentile(turn_counts, 0.95),
                "max_turn_count": max(turn_counts) if turn_counts else None,
                "tracked_runs_with_turns": len(run_turns),
                "avg_turns_per_run": avg_turns_per_run,
                "events_with_retry_count": len(retry_counts),
                "retry_count_total": retry_total,
                "retry_event_rate": retry_rate,
                "loop_hint_events": loop_hint_events,
            },
            "quality_signals": {
                "events_with_quality_score": len(quality_scores),
                "quality_score_avg": _average(quality_scores),
                "events_with_consistency_score": len(consistency_scores),
                "consistency_score_avg": consistency_avg,
                "events_with_outcome_confidence": len(outcome_confidences),
                "outcome_confidence_avg": confidence_avg,
                "low_outcome_confidence_events": low_confidence_events,
                "low_consistency_events": low_consistency_events,
            },
        },
        "tool_health": _tool_health(entries),
        "flags": flags,
        "recommendations": recommendations,
        "duplicate_bursts": duplicate_bursts[:10],
        "evidence": evidence,
    }


@mcp.tool()
def log_usage(
    agent: str,
    action: str,
    tool: str = "",
    skill: str = "",
    detail: str = "",
    event_id: str = "",
    run_id: str = "",
    task_id: str = "",
    parent_event_id: str = "",
    origin: str = "",
    status: str = "",
    duration_ms: Optional[int] = None,
    error_type: str = "",
    error_message: str = "",
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
    """Use to record orchestration-level events to `.metrics/usage.jsonl`.

    Call this at key workflow moments: task start, tool invocation, task completion.

    Args:
        agent: Agent identifier (e.g., "orchestrator", "specialist/api", "specialist/web")
        action: What happened (e.g., "task_start", "tool_call", "task_complete", "delegation")
        tool: MCP tool used, if applicable (e.g., "security-scanner", "ci-monitor")
        skill: Skill or capability exercised (e.g., "code-review", "scaffold", "deploy-verify")
        detail: Optional free-text context (e.g., requirement file, error summary)
    """
    entry = _build_usage_entry(
        agent=agent,
        action=action,
        tool=tool,
        skill=skill,
        detail=detail,
        event_id=event_id or None,
        run_id=run_id or None,
        task_id=task_id or None,
        parent_event_id=parent_event_id or None,
        origin=origin or None,
        status=status or None,
        duration_ms=duration_ms,
        error_type=error_type or None,
        error_message=error_message or None,
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

    log_file = append_entry(entry)
    return json.dumps({"status": "logged", "file": str(log_file)})


@mcp.tool()
def get_usage_summary(days: int = 7) -> str:
    """Use to quickly review recent agent/tool activity trends.

    Aggregates usage events from the local metrics log for a lookback window and
    returns counts by agent, tool, skill, and action.

    Args:
        days: Number of days to look back (default: 7)
    """
    entries = _load_usage_entries(days)
    if not entries:
        project_dir = get_project_dir()
        log_file = project_dir / METRICS_DIR / METRICS_FILE
        if not log_file.exists():
            return json.dumps({"message": "No usage data yet", "file": str(log_file)})
        return json.dumps({"message": f"No usage in the last {days} days", "total_entries": 0})

    agents = {}
    tools = {}
    skills = {}
    actions = {}

    for e in entries:
        agent = e.get("agent", "unknown")
        agents[agent] = agents.get(agent, 0) + 1
        if e.get("tool"):
            tools[e["tool"]] = tools.get(e["tool"], 0) + 1
        if e.get("skill"):
            skills[e["skill"]] = skills.get(e["skill"], 0) + 1
        action = e.get("action", "unknown")
        actions[action] = actions.get(action, 0) + 1

    return json.dumps({
        "period_days": days,
        "total_events": len(entries),
        "by_agent": dict(sorted(agents.items(), key=lambda x: -x[1])),
        "by_tool": dict(sorted(tools.items(), key=lambda x: -x[1])),
        "by_skill": dict(sorted(skills.items(), key=lambda x: -x[1])),
        "by_action": dict(sorted(actions.items(), key=lambda x: -x[1])),
    })


@mcp.tool()
def get_usage_quality_report(days: int = 7, min_events: int = 20) -> str:
    """Report whether usage looks correct and valuable.

    Produces a read-only quality snapshot from `.metrics/usage.jsonl` with behavior
    ratios, tool health, duplicate bursts, outcome signals, and redacted examples.
    """
    entries = _load_usage_entries(days)
    if not entries:
        project_dir = get_project_dir()
        log_file = project_dir / METRICS_DIR / METRICS_FILE
        return json.dumps({"message": "No usage data yet", "file": str(log_file)})
    return json.dumps({
        "period_days": days,
        "min_events": min_events,
        "total_events": len(entries),
        "report": _build_quality_report(entries, min_events),
    })


if __name__ == "__main__":
    mcp.run()
