"""Child Agent Runner MCP Server — launches scoped Copilot child-repo sessions."""

from __future__ import annotations

import argparse
import json
import os
import select
import signal
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

import yaml
from mcp.server.fastmcp import FastMCP

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.instrumentation import track_usage

mcp = FastMCP("child-agent-runner")

DEFAULT_TIMEOUT_SECONDS = 1800
DEFAULT_MAX_PARALLEL = 4
PROGRESS_HEARTBEAT_SECONDS = 10
PROGRESS_EXTENSION_DECISION_WINDOW_SECONDS = 90
PROGRESS_ACTIVE_OUTPUT_WINDOW_SECONDS = 180
TIMEOUT_EXTENSION_SECONDS = 600
MAX_TIMEOUT_SECONDS = 7200


def _workspace_root() -> Path:
    project_dir = os.environ.get("PROJECT_DIR")
    return Path(project_dir).resolve() if project_dir else Path.cwd().resolve()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _error_payload(code: str, message: str, details: dict[str, Any] | None = None) -> str:
    payload: dict[str, Any] = {"ok": False, "error": {"code": code, "message": message}}
    if details:
        payload["error"]["details"] = details
    return json.dumps(payload)


def _repo_index_path(project_dir: Path) -> Path:
    return project_dir / ".repo-index.yml"


def _load_repo_index(project_dir: Path) -> tuple[list[dict[str, Any]] | None, str | None]:
    index_path = _repo_index_path(project_dir)
    if not index_path.is_file():
        return None, f"Missing .repo-index.yml at {index_path}"
    try:
        data = yaml.safe_load(index_path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as exc:
        return None, f"Invalid YAML in .repo-index.yml: {exc}"
    repos = data.get("repos")
    if not isinstance(repos, list):
        return None, "Invalid .repo-index.yml: expected top-level 'repos' list"
    return repos, None


def _resolve_repo_path(project_dir: Path, local_path: str) -> Path:
    path_obj = Path(local_path)
    if path_obj.is_absolute():
        return path_obj.resolve()
    return (project_dir / path_obj).resolve()


def _select_repo_entry(project_dir: Path, repo: str, repos: list[dict[str, Any]]) -> dict[str, Any] | None:
    repo_value = repo.strip()
    repo_value_l = repo_value.lower()
    repo_abs: Path | None = None
    if repo_value:
        try:
            repo_abs = Path(repo_value).resolve()
        except Exception:
            repo_abs = None

    for entry in repos:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name", "")).strip()
        local_path = str(entry.get("local_path", "")).strip()
        if not name or not local_path:
            continue
        resolved = _resolve_repo_path(project_dir, local_path)
        if name.lower() == repo_value_l:
            return entry
        if local_path == repo_value:
            return entry
        if repo_abs and resolved == repo_abs:
            return entry
    return None


def _queue_files(repo_dir: Path, phase: str = "specialist") -> list[Path]:
    if phase == "critic":
        queue_dir = repo_dir / "work" / "ready-for-review"
    else:
        queue_dir = repo_dir / "work" / "todo"
    if not queue_dir.is_dir():
        return []
    return sorted(path for path in queue_dir.iterdir() if path.is_file())


def _lock_path(project_dir: Path, repo_name: str) -> Path:
    lock_dir = project_dir / ".locks" / "child-agent-runner"
    lock_dir.mkdir(parents=True, exist_ok=True)
    safe_name = "".join(ch if ch.isalnum() or ch in ("-", "_") else "-" for ch in repo_name).strip("-")
    if not safe_name:
        safe_name = "repo"
    return lock_dir / f"{safe_name}.lock"


def _acquire_lock(lock_file: Path) -> bool:
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
    try:
        fd = os.open(str(lock_file), flags, 0o644)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(str(os.getpid()))
        return True
    except FileExistsError:
        return False


def _release_lock(lock_file: Path) -> None:
    try:
        lock_file.unlink(missing_ok=True)
    except Exception:
        pass


def _job_dir(project_dir: Path) -> Path:
    path = project_dir / ".metrics" / "child-agent-runner" / "jobs"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _job_path(project_dir: Path, job_id: str) -> Path:
    return _job_dir(project_dir) / f"{job_id}.json"


def _read_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp_path.replace(path)


def _is_pid_alive(pid: int | None) -> bool:
    if not pid or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _load_job(project_dir: Path, job_id: str) -> dict[str, Any] | None:
    return _read_json(_job_path(project_dir, job_id))


def _save_job(project_dir: Path, job_id: str, payload: dict[str, Any]) -> None:
    _write_json(_job_path(project_dir, job_id), payload)


def _list_jobs(project_dir: Path) -> list[dict[str, Any]]:
    jobs: list[dict[str, Any]] = []
    for path in sorted(_job_dir(project_dir).glob("*.json")):
        job = _read_json(path)
        if job is not None:
            jobs.append(job)
    jobs.sort(key=lambda item: str(item.get("created_at", "")), reverse=True)
    return jobs


def _find_running_repo_job(project_dir: Path, repo_name: str) -> dict[str, Any] | None:
    for job in _list_jobs(project_dir):
        if str(job.get("repo", "")) != repo_name:
            continue
        status = str(job.get("status", ""))
        if status in ("queued", "running"):
            if _is_pid_alive(int(job.get("worker_pid") or 0)):
                return job
    return None


def _acquire_repo_lock(project_dir: Path, repo_name: str) -> tuple[bool, Path, dict[str, Any] | None]:
    lock_file = _lock_path(project_dir, repo_name)
    if _acquire_lock(lock_file):
        return True, lock_file, None

    running_job = _find_running_repo_job(project_dir, repo_name)
    if running_job is None:
        _release_lock(lock_file)
        if _acquire_lock(lock_file):
            return True, lock_file, None

    return False, lock_file, running_job


def _build_prompt(repo_name: str, repo_role: str, request_file: Path, phase: str = "specialist") -> str:
    role_label = repo_role if repo_role else "specialist/critic"
    request_rel = request_file.as_posix()
    if phase == "critic":
        return (
            f"You are the critic for repo '{repo_name}'. "
            f"Review '{request_rel}' from work/ready-for-review/. "
            "Follow the critic agent instructions in .github/agents/*-critic.agent.md. "
            "Run the full validation checklist. If all criteria pass, append your PASS rationale "
            "and move the file to work/done/. If issues are found, append feedback with STATUS: FAIL "
            "and move the file back to work/todo/ for the specialist to address."
        )
    return (
        f"Process exactly one queued request for repo '{repo_name}' as {role_label}. "
        f"Read and execute only '{request_rel}' from work/todo. "
        "Follow the child repo agent instructions, stay within this repo, and complete the queue handoff protocol. "
        "If implementation files are missing, scaffold the minimal required project/code structure in this repo "
        "to satisfy the request and acceptance criteria; do not mark blocked solely because the repo is greenfield."
    )


def _write_run_log(
    project_dir: Path,
    repo_name: str,
    prompt: str,
    command: list[str],
    cwd: Path,
    exit_code: int,
    duration_ms: int,
    stdout: str,
    stderr: str,
    repo_dir: Path | None = None,
) -> Path:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    launched_at = datetime.now(timezone.utc).isoformat()
    payload = {
        "agent_identity": f"child-agent-runner/{repo_name}",
        "launched_at": launched_at,
        "repo": repo_name,
        "cwd": str(cwd),
        "command": command,
        "prompt": prompt,
        "exit_code": exit_code,
        "duration_ms": duration_ms,
        "stdout": stdout,
        "stderr": stderr,
    }
    content = json.dumps(payload, indent=2)

    log_dir = project_dir / ".metrics" / "child-agent-runner"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"{timestamp}-{repo_name}.log"
    log_path.write_text(content, encoding="utf-8")

    if repo_dir is not None:
        child_log_dir = repo_dir / ".metrics" / "child-agent-runner"
        child_log_dir.mkdir(parents=True, exist_ok=True)
        (child_log_dir / f"{timestamp}-{repo_name}.log").write_text(content, encoding="utf-8")

    return log_path


def _extract_progress_step(line: str) -> str | None:
    text = line.strip()
    if not text:
        return None
    if text.startswith(("● ", "MCP_MODE:", "MCP_CALL:", "MCP_SUMMARY:", "═══", "STATUS:")):
        return text[:240]
    if text.startswith(("I'm ", "I’m ")):
        return text[:240]
    return None


def _update_job_progress(
    project_dir: Path | None,
    job_id: str | None,
    job: dict[str, Any] | None,
    *,
    elapsed_seconds: int,
    timeout_seconds_effective: int,
    extension_count: int,
    phase: str = "running",
    last_step: str | None = None,
    saw_output: bool = False,
) -> None:
    if project_dir is None or not job_id or job is None:
        return
    progress = dict(job.get("progress") or {})
    progress["phase"] = phase
    progress["elapsed_seconds"] = elapsed_seconds
    progress["timeout_seconds_effective"] = timeout_seconds_effective
    progress["extension_count"] = extension_count
    progress["last_update"] = _now_iso()
    if saw_output:
        progress["last_output_at"] = _now_iso()
    if last_step:
        progress["last_step"] = last_step
    job["progress"] = progress
    job["timeout_seconds_effective"] = timeout_seconds_effective
    job["timeout_extension_count"] = extension_count
    _save_job(project_dir, job_id, job)


def _run_copilot_with_progress(
    *,
    project_dir: Path | None,
    job_id: str | None,
    job: dict[str, Any] | None,
    command: list[str],
    repo_dir: Path,
    timeout_seconds: int,
) -> tuple[int, str, str, dict[str, Any] | None]:
    stdout_chunks: list[str] = []
    stderr_chunks: list[str] = []
    error: dict[str, Any] | None = None
    start = time.monotonic()
    current_timeout = timeout_seconds
    extension_count = 0
    last_output = start
    last_heartbeat = 0.0

    proc = subprocess.Popen(
        command,
        cwd=str(repo_dir),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        start_new_session=True,
    )
    if job is not None:
        job["copilot_pid"] = proc.pid
    _update_job_progress(
        project_dir,
        job_id,
        job,
        elapsed_seconds=0,
        timeout_seconds_effective=current_timeout,
        extension_count=extension_count,
        phase="running",
        last_step="spawned child copilot process",
    )

    while True:
        now = time.monotonic()
        elapsed = int(now - start)

        if (now - last_heartbeat) >= PROGRESS_HEARTBEAT_SECONDS:
            _update_job_progress(
                project_dir,
                job_id,
                job,
                elapsed_seconds=elapsed,
                timeout_seconds_effective=current_timeout,
                extension_count=extension_count,
                phase="running",
            )
            last_heartbeat = now

        streams = [stream for stream in (proc.stdout, proc.stderr) if stream is not None]
        ready: list[Any] = []
        if streams:
            ready, _, _ = select.select(streams, [], [], 1.0)
        else:
            time.sleep(1.0)

        saw_output = False
        for stream in ready:
            line = stream.readline()
            if line == "":
                continue
            saw_output = True
            last_output = time.monotonic()
            if stream is proc.stdout:
                stdout_chunks.append(line)
            else:
                stderr_chunks.append(line)
            step = _extract_progress_step(line)
            _update_job_progress(
                project_dir,
                job_id,
                job,
                elapsed_seconds=int(last_output - start),
                timeout_seconds_effective=current_timeout,
                extension_count=extension_count,
                phase="running",
                last_step=step,
                saw_output=True,
            )

        rc = proc.poll()
        if rc is not None:
            tail_out, tail_err = proc.communicate()
            if tail_out:
                stdout_chunks.append(tail_out)
            if tail_err:
                stderr_chunks.append(tail_err)
            _update_job_progress(
                project_dir,
                job_id,
                job,
                elapsed_seconds=int(time.monotonic() - start),
                timeout_seconds_effective=current_timeout,
                extension_count=extension_count,
                phase="completed",
                last_step=f"child copilot process exited rc={rc}",
            )
            return rc, "".join(stdout_chunks), "".join(stderr_chunks), None

        # Before timing out, extend once there is fresh output activity.
        remaining = current_timeout - elapsed
        has_recent_output = (time.monotonic() - last_output) <= PROGRESS_ACTIVE_OUTPUT_WINDOW_SECONDS
        if (
            remaining <= PROGRESS_EXTENSION_DECISION_WINDOW_SECONDS
            and has_recent_output
            and current_timeout < MAX_TIMEOUT_SECONDS
        ):
            previous_timeout = current_timeout
            current_timeout = min(MAX_TIMEOUT_SECONDS, current_timeout + TIMEOUT_EXTENSION_SECONDS)
            if current_timeout != previous_timeout:
                extension_count += 1
                _update_job_progress(
                    project_dir,
                    job_id,
                    job,
                    elapsed_seconds=elapsed,
                    timeout_seconds_effective=current_timeout,
                    extension_count=extension_count,
                    phase="running",
                    last_step=f"extended timeout from {previous_timeout}s to {current_timeout}s due to active output",
                )
                continue

        if elapsed >= current_timeout:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
            try:
                tail_out, tail_err = proc.communicate(timeout=2)
            except Exception:
                tail_out, tail_err = "", ""
            if tail_out:
                stdout_chunks.append(tail_out)
            if tail_err:
                stderr_chunks.append(tail_err)
            error = {
                "code": "COPILOT_TIMEOUT",
                "message": f"copilot timed out after {current_timeout}s",
                "details": {
                    "timeout_seconds_initial": timeout_seconds,
                    "timeout_seconds_effective": current_timeout,
                    "timeout_extension_count": extension_count,
                    "had_recent_output_before_timeout": has_recent_output,
                },
            }
            _update_job_progress(
                project_dir,
                job_id,
                job,
                elapsed_seconds=int(time.monotonic() - start),
                timeout_seconds_effective=current_timeout,
                extension_count=extension_count,
                phase="timed_out",
                last_step=error["message"],
            )
            return 124, "".join(stdout_chunks), "".join(stderr_chunks), error


def _refresh_job_state(job: dict[str, Any]) -> dict[str, Any]:
    status = str(job.get("status", ""))
    if status not in ("queued", "running"):
        return job
    if _is_pid_alive(int(job.get("worker_pid") or 0)):
        return job

    project_dir = _workspace_root()
    lock_file_value = str(job.get("lock_file", "")).strip()
    if lock_file_value:
        _release_lock(Path(lock_file_value))

    job["status"] = "failed"
    job["ok"] = False
    job["finished_at"] = _now_iso()
    job["error"] = {
        "code": "WORKER_EXITED",
        "message": "child-agent worker exited before writing completion status",
    }
    _save_job(project_dir, str(job["job_id"]), job)
    return job


def _resolve_job_setup(
    repo: str,
    timeout_seconds: int,
    max_output_chars: int,
    phase: str = "specialist",
) -> dict[str, Any]:
    if not repo or not repo.strip():
        return {"ok": False, "error": {"code": "INVALID_REPO", "message": "repo must be a non-empty string"}}
    if timeout_seconds < 30 or timeout_seconds > 7200:
        return {
            "ok": False,
            "error": {"code": "INVALID_TIMEOUT", "message": "timeout_seconds must be between 30 and 7200"},
        }
    if max_output_chars < 200 or max_output_chars > 200000:
        return {
            "ok": False,
            "error": {
                "code": "INVALID_OUTPUT_LIMIT",
                "message": "max_output_chars must be between 200 and 200000",
            },
        }
    if phase not in ("specialist", "critic"):
        return {"ok": False, "error": {"code": "INVALID_PHASE", "message": "phase must be 'specialist' or 'critic'"}}

    project_dir = _workspace_root()
    repos, err = _load_repo_index(project_dir)
    if err:
        return {"ok": False, "error": {"code": "INVALID_REPO_INDEX", "message": err}}
    assert repos is not None

    entry = _select_repo_entry(project_dir, repo, repos)
    if not entry:
        return {"ok": False, "error": {"code": "REPO_NOT_FOUND", "message": f"repo '{repo}' not found in .repo-index.yml"}}

    repo_name = str(entry.get("name", "")).strip()
    repo_role = str(entry.get("role", "")).strip()
    local_path = str(entry.get("local_path", "")).strip()
    repo_dir = _resolve_repo_path(project_dir, local_path)
    if not repo_dir.is_dir():
        return {"ok": False, "error": {"code": "REPO_PATH_MISSING", "message": f"Repo path does not exist: {repo_dir}"}}

    queue_label = "work/ready-for-review" if phase == "critic" else "work/todo"
    queue = _queue_files(repo_dir, phase=phase)
    if not queue:
        return {
            "ok": True,
            "status": "no_work",
            "repo": repo_name,
            "role": repo_role,
            "repo_path": str(repo_dir),
            "queue_depth": 0,
            "message": f"No files in {queue_label}",
        }
    request_file = queue[0]

    lock_ok, lock_file, running_job = _acquire_repo_lock(project_dir, repo_name)
    if not lock_ok:
        details: dict[str, Any] = {"lock_file": str(lock_file)}
        if running_job is not None:
            details["job_id"] = running_job.get("job_id")
            details["worker_pid"] = running_job.get("worker_pid")
        return {
            "ok": False,
            "error": {
                "code": "REPO_LOCKED",
                "message": f"Repo '{repo_name}' already has a running child-agent invocation",
                "details": details,
            },
        }

    prompt = _build_prompt(repo_name, repo_role, request_file.relative_to(repo_dir), phase=phase)
    command = [
        "copilot",
        "-p",
        prompt,
        "--allow-all-tools",
        "--autopilot",
        "--no-ask-user",
        "--no-color",
        "--stream",
        "on",
        "--log-level",
        "none",
        "--model",
        "auto",
        "--add-dir",
        str(repo_dir),
    ]

    return {
        "ok": True,
        "project_dir": project_dir,
        "repo": repo_name,
        "role": repo_role,
        "repo_dir": repo_dir,
        "phase": phase,
        "queue_depth_before": len(queue),
        "request_file": str(request_file.relative_to(repo_dir)),
        "prompt": prompt,
        "command": command,
        "timeout_seconds": timeout_seconds,
        "max_output_chars": max_output_chars,
        "lock_file": str(lock_file),
    }


def _start_child_agent_job(
    repo: str,
    timeout_seconds: int,
    max_output_chars: int,
    phase: str = "specialist",
) -> dict[str, Any]:
    setup = _resolve_job_setup(repo=repo, timeout_seconds=timeout_seconds, max_output_chars=max_output_chars, phase=phase)
    if not setup.get("ok"):
        return setup
    if setup.get("status") == "no_work":
        return setup

    project_dir = Path(str(setup["project_dir"]))
    job_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + uuid4().hex[:10]
    job_payload: dict[str, Any] = {
        "job_id": job_id,
        "status": "queued",
        "ok": None,
        "created_at": _now_iso(),
        "repo": setup["repo"],
        "role": setup["role"],
        "phase": phase,
        "repo_path": str(setup["repo_dir"]),
        "request_file": setup["request_file"],
        "queue_depth_before": setup["queue_depth_before"],
        "timeout_seconds": setup["timeout_seconds"],
        "max_output_chars": setup["max_output_chars"],
        "lock_file": setup["lock_file"],
        "prompt": setup["prompt"],
        "command": setup["command"],
    }
    _save_job(project_dir, job_id, job_payload)

    worker_cmd = [sys.executable, str(Path(__file__).resolve()), "--worker", "--job-id", job_id]
    try:
        proc = subprocess.Popen(
            worker_cmd,
            cwd=str(project_dir),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except Exception as exc:
        _release_lock(Path(str(setup["lock_file"])))
        job_payload["status"] = "failed"
        job_payload["ok"] = False
        job_payload["finished_at"] = _now_iso()
        job_payload["error"] = {"code": "WORKER_START_FAILED", "message": str(exc)}
        _save_job(project_dir, job_id, job_payload)
        return {"ok": False, "error": {"code": "WORKER_START_FAILED", "message": str(exc)}}

    job_payload["status"] = "running"
    job_payload["worker_pid"] = proc.pid
    job_payload["started_at"] = _now_iso()
    _save_job(project_dir, job_id, job_payload)

    return {
        "ok": True,
        "status": "started",
        "job_id": job_id,
        "repo": setup["repo"],
        "role": setup["role"],
        "repo_path": str(setup["repo_dir"]),
        "request_file": setup["request_file"],
        "queue_depth_before": setup["queue_depth_before"],
        "worker_pid": proc.pid,
    }


def _run_worker(job_id: str) -> int:
    project_dir = _workspace_root()
    job = _load_job(project_dir, job_id)
    if job is None:
        return 1

    if str(job.get("status")) not in ("queued", "running"):
        return 0

    job["status"] = "running"
    job["started_at"] = job.get("started_at") or _now_iso()
    _save_job(project_dir, job_id, job)

    repo_name = str(job.get("repo", ""))
    repo_role = str(job.get("role", ""))
    repo_dir = Path(str(job.get("repo_path", "")))
    prompt = str(job.get("prompt", ""))
    command = list(job.get("command", []))
    timeout_seconds = int(job.get("timeout_seconds", DEFAULT_TIMEOUT_SECONDS))
    max_output_chars = int(job.get("max_output_chars", 12000))
    request_file = str(job.get("request_file", ""))
    lock_file = Path(str(job.get("lock_file", "")))

    start = time.perf_counter()
    rc = 1
    stdout = ""
    stderr = ""
    error: dict[str, Any] | None = None
    try:
        rc, stdout, stderr, error = _run_copilot_with_progress(
            project_dir=project_dir,
            job_id=job_id,
            job=job,
            command=command,
            repo_dir=repo_dir,
            timeout_seconds=timeout_seconds,
        )
    except FileNotFoundError:
        rc = 127
        error = {"code": "COPILOT_NOT_FOUND", "message": "copilot CLI not found in PATH"}
    except Exception as exc:
        rc = 1
        error = {"code": "COPILOT_EXEC_FAILED", "message": str(exc)}

    duration_ms = int((time.perf_counter() - start) * 1000)
    log_file = _write_run_log(
        project_dir=project_dir,
        repo_name=repo_name,
        prompt=prompt,
        command=command,
        cwd=repo_dir,
        exit_code=rc,
        duration_ms=duration_ms,
        stdout=stdout,
        stderr=stderr,
        repo_dir=repo_dir,
    )

    output = f"{stdout}\n{stderr}".strip()
    if len(output) > max_output_chars:
        output = output[: max_output_chars - 3] + "..."

    job["finished_at"] = _now_iso()
    job["duration_ms"] = duration_ms
    job["exit_code"] = rc
    job["log_file"] = str(log_file)
    job["output"] = output
    job["request_file"] = request_file
    job["ok"] = rc == 0 and error is None
    job["status"] = "completed" if job["ok"] else "failed"
    if error is not None:
        error.setdefault("details", {})
        error["details"]["repo"] = repo_name
        error["details"]["request_file"] = request_file
        error["details"]["log_file"] = str(log_file)
        error["details"]["duration_ms"] = duration_ms
        job["error"] = error
    _save_job(project_dir, job_id, job)

    _release_lock(lock_file)
    return 0


@mcp.tool()
@track_usage("child-agent-runner")
def run_child_agent(
    repo: str,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    max_output_chars: int = 12000,
    phase: str = "specialist",
) -> str:
    """Spawn a scoped Copilot run in one child repo using .repo-index.yml allowlist.

    Args:
        repo: Name of the repo from .repo-index.yml
        timeout_seconds: Max execution time (30-7200)
        max_output_chars: Max output to capture
        phase: 'specialist' picks from work/todo, 'critic' picks from work/ready-for-review
    """
    payload = _run_child_agent_core(
        repo=repo,
        timeout_seconds=timeout_seconds,
        max_output_chars=max_output_chars,
        phase=phase,
    )
    return json.dumps(payload)


def _run_child_agent_core(
    repo: str,
    timeout_seconds: int,
    max_output_chars: int,
    phase: str = "specialist",
) -> dict[str, Any]:
    setup = _resolve_job_setup(repo=repo, timeout_seconds=timeout_seconds, max_output_chars=max_output_chars, phase=phase)
    if not setup.get("ok") or setup.get("status") == "no_work":
        return setup

    project_dir = Path(str(setup["project_dir"]))
    repo_name = str(setup["repo"])
    repo_role = str(setup["role"])
    repo_dir = Path(str(setup["repo_dir"]))
    request_file = str(setup["request_file"])
    prompt = str(setup["prompt"])
    command = list(setup["command"])
    lock_file = Path(str(setup["lock_file"]))

    start = time.perf_counter()
    rc = 1
    stdout = ""
    stderr = ""
    error: dict[str, Any] | None = None
    try:
        rc, stdout, stderr, error = _run_copilot_with_progress(
            project_dir=None,
            job_id=None,
            job=None,
            command=command,
            repo_dir=repo_dir,
            timeout_seconds=timeout_seconds,
        )
    except FileNotFoundError:
        _release_lock(lock_file)
        return {"ok": False, "error": {"code": "COPILOT_NOT_FOUND", "message": "copilot CLI not found in PATH"}}
    except Exception as exc:
        _release_lock(lock_file)
        return {
            "ok": False,
            "error": {"code": "COPILOT_EXEC_FAILED", "message": str(exc), "details": {"repo": repo_name}},
        }

    duration_ms = int((time.perf_counter() - start) * 1000)
    log_file = _write_run_log(
        project_dir=project_dir,
        repo_name=repo_name,
        prompt=prompt,
        command=command,
        cwd=repo_dir,
        exit_code=rc,
        duration_ms=duration_ms,
        stdout=stdout,
        stderr=stderr,
        repo_dir=repo_dir,
    )
    _release_lock(lock_file)

    output = f"{stdout}\n{stderr}".strip()
    if len(output) > max_output_chars:
        output = output[: max_output_chars - 3] + "..."

    result_payload: dict[str, Any] = {
        "ok": rc == 0 and error is None,
        "status": "completed" if rc == 0 and error is None else "failed",
        "repo": repo_name,
        "role": repo_role,
        "repo_path": str(repo_dir),
        "queue_depth_before": int(setup["queue_depth_before"]),
        "request_file": request_file,
        "command": command,
        "exit_code": rc,
        "duration_ms": duration_ms,
        "log_file": str(log_file),
        "output": output,
    }
    if error is not None:
        error.setdefault("details", {})
        error["details"].setdefault("repo", repo_name)
        error["details"].setdefault("request_file", request_file)
        error["details"].setdefault("log_file", str(log_file))
        error["details"].setdefault("duration_ms", duration_ms)
        result_payload["error"] = error
    return result_payload


@mcp.tool()
@track_usage("child-agent-runner")
def run_child_agents_batch(
    repos: list[str] | None = None,
    max_parallel: int = DEFAULT_MAX_PARALLEL,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    max_output_chars: int = 12000,
    phase: str = "specialist",
) -> str:
    """Dispatch one queued request per repo concurrently using scoped child Copilot runs.

    Args:
        repos: List of repo names (defaults to all repos in .repo-index.yml)
        max_parallel: Max concurrent jobs (1-32)
        timeout_seconds: Max execution time per job (30-7200)
        max_output_chars: Max output to capture per job
        phase: 'specialist' picks from work/todo, 'critic' picks from work/ready-for-review
    """
    if max_parallel < 1 or max_parallel > 32:
        return _error_payload("INVALID_MAX_PARALLEL", "max_parallel must be between 1 and 32")
    if timeout_seconds < 30 or timeout_seconds > 7200:
        return _error_payload("INVALID_TIMEOUT", "timeout_seconds must be between 30 and 7200")
    if max_output_chars < 200 or max_output_chars > 200000:
        return _error_payload("INVALID_OUTPUT_LIMIT", "max_output_chars must be between 200 and 200000")
    if phase not in ("specialist", "critic"):
        return _error_payload("INVALID_PHASE", "phase must be 'specialist' or 'critic'")

    project_dir = _workspace_root()
    repo_index, err = _load_repo_index(project_dir)
    if err:
        return _error_payload("INVALID_REPO_INDEX", err)
    assert repo_index is not None

    if repos is None:
        target_repos = [
            str(entry.get("name", "")).strip()
            for entry in repo_index
            if isinstance(entry, dict) and str(entry.get("name", "")).strip()
        ]
    else:
        if not isinstance(repos, list):
            return _error_payload("INVALID_REPOS", "repos must be a list of repo names")
        target_repos = []
        for repo in repos:
            if not isinstance(repo, str) or not repo.strip():
                return _error_payload("INVALID_REPOS", "repos must contain non-empty repo names")
            target_repos.append(repo.strip())

    # Preserve input order and avoid duplicate dispatches in one batch.
    seen = set()
    deduped_targets: list[str] = []
    for repo_name in target_repos:
        if repo_name not in seen:
            deduped_targets.append(repo_name)
            seen.add(repo_name)

    if not deduped_targets:
        return json.dumps(
            {
                "ok": True,
                "status": "no_repos",
                "max_parallel": max_parallel,
                "results": [],
                "summary": {
                    "total": 0,
                    "completed": 0,
                    "failed": 0,
                    "blocked": 0,
                    "no_work": 0,
                },
            }
        )

    worker_count = min(max_parallel, len(deduped_targets))
    results_by_repo: dict[str, dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        future_map = {
            executor.submit(
                _run_child_agent_core,
                repo=repo_name,
                timeout_seconds=timeout_seconds,
                max_output_chars=max_output_chars,
                phase=phase,
            ): repo_name
            for repo_name in deduped_targets
        }
        for future, repo_name in ((f, future_map[f]) for f in future_map):
            try:
                results_by_repo[repo_name] = future.result()
            except Exception as exc:
                results_by_repo[repo_name] = {
                    "ok": False,
                    "error": {
                        "code": "BATCH_EXECUTION_FAILED",
                        "message": str(exc),
                        "details": {"repo": repo_name},
                    },
                }

    ordered_results = [results_by_repo[repo_name] for repo_name in deduped_targets]
    completed = sum(1 for item in ordered_results if item.get("status") == "completed")
    no_work = sum(1 for item in ordered_results if item.get("status") == "no_work")
    blocked = sum(1 for item in ordered_results if item.get("error", {}).get("code") == "REPO_LOCKED")
    failed = len(ordered_results) - completed - no_work - blocked

    return json.dumps(
        {
            "ok": failed == 0,
            "status": "completed" if failed == 0 else "completed_with_errors",
            "max_parallel": max_parallel,
            "worker_count": worker_count,
            "results": ordered_results,
            "summary": {
                "total": len(ordered_results),
                "completed": completed,
                "failed": failed,
                "blocked": blocked,
                "no_work": no_work,
            },
        }
    )


@mcp.tool()
@track_usage("child-agent-runner")
def start_child_agent(
    repo: str,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    max_output_chars: int = 12000,
    phase: str = "specialist",
) -> str:
    """Start one child-repo run asynchronously and return a job id immediately.

    Args:
        repo: Name of the repo from .repo-index.yml
        timeout_seconds: Max execution time (30-7200)
        max_output_chars: Max output to capture
        phase: 'specialist' picks from work/todo, 'critic' picks from work/ready-for-review
    """
    return json.dumps(
        _start_child_agent_job(
            repo=repo,
            timeout_seconds=timeout_seconds,
            max_output_chars=max_output_chars,
            phase=phase,
        )
    )


@mcp.tool()
@track_usage("child-agent-runner")
def start_child_agents_batch(
    repos: list[str] | None = None,
    max_parallel: int = DEFAULT_MAX_PARALLEL,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    max_output_chars: int = 12000,
    phase: str = "specialist",
) -> str:
    """Start async child-repo jobs up to max_parallel and return job ids for polling.

    Args:
        repos: List of repo names (defaults to all repos in .repo-index.yml)
        max_parallel: Max concurrent jobs (1-32)
        timeout_seconds: Max execution time per job (30-7200)
        max_output_chars: Max output to capture per job
        phase: 'specialist' picks from work/todo, 'critic' picks from work/ready-for-review
    """
    if max_parallel < 1 or max_parallel > 32:
        return _error_payload("INVALID_MAX_PARALLEL", "max_parallel must be between 1 and 32")
    if timeout_seconds < 30 or timeout_seconds > 7200:
        return _error_payload("INVALID_TIMEOUT", "timeout_seconds must be between 30 and 7200")
    if max_output_chars < 200 or max_output_chars > 200000:
        return _error_payload("INVALID_OUTPUT_LIMIT", "max_output_chars must be between 200 and 200000")
    if phase not in ("specialist", "critic"):
        return _error_payload("INVALID_PHASE", "phase must be 'specialist' or 'critic'")

    project_dir = _workspace_root()
    repo_index, err = _load_repo_index(project_dir)
    if err:
        return _error_payload("INVALID_REPO_INDEX", err)
    assert repo_index is not None

    if repos is None:
        target_repos = [
            str(entry.get("name", "")).strip()
            for entry in repo_index
            if isinstance(entry, dict) and str(entry.get("name", "")).strip()
        ]
    else:
        if not isinstance(repos, list):
            return _error_payload("INVALID_REPOS", "repos must be a list of repo names")
        target_repos = []
        for repo in repos:
            if not isinstance(repo, str) or not repo.strip():
                return _error_payload("INVALID_REPOS", "repos must contain non-empty repo names")
            target_repos.append(repo.strip())

    seen = set()
    deduped_targets: list[str] = []
    for repo_name in target_repos:
        if repo_name not in seen:
            deduped_targets.append(repo_name)
            seen.add(repo_name)

    running_jobs = [job for job in _list_jobs(project_dir) if str(job.get("status")) in ("queued", "running") and _is_pid_alive(int(job.get("worker_pid") or 0))]
    available_slots = max(0, max_parallel - len(running_jobs))

    started: list[dict[str, Any]] = []
    deferred: list[dict[str, Any]] = []
    for repo_name in deduped_targets:
        if available_slots <= 0:
            deferred.append({"repo": repo_name, "status": "deferred_capacity"})
            continue
        result = _start_child_agent_job(
            repo=repo_name,
            timeout_seconds=timeout_seconds,
            max_output_chars=max_output_chars,
            phase=phase,
        )
        started.append(result)
        if result.get("status") == "started":
            available_slots -= 1

    started_count = sum(1 for item in started if item.get("status") == "started")
    no_work_count = sum(1 for item in started if item.get("status") == "no_work")
    blocked_count = sum(1 for item in started if item.get("error", {}).get("code") == "REPO_LOCKED")
    failed_count = sum(1 for item in started if not item.get("ok") and item.get("error", {}).get("code") != "REPO_LOCKED")

    return json.dumps(
        {
            "ok": failed_count == 0,
            "status": "started" if started_count > 0 else "no_jobs_started",
            "max_parallel": max_parallel,
            "running_jobs_before": len(running_jobs),
            "available_slots_after": available_slots,
            "results": started,
            "deferred": deferred,
            "summary": {
                "requested": len(deduped_targets),
                "started": started_count,
                "no_work": no_work_count,
                "blocked": blocked_count,
                "failed_to_start": failed_count,
                "deferred_capacity": len(deferred),
            },
        }
    )


@mcp.tool()
@track_usage("child-agent-runner")
def get_child_agent_job(job_id: str) -> str:
    """Get current status/result for one async child-agent job id."""
    if not job_id or not job_id.strip():
        return _error_payload("INVALID_JOB_ID", "job_id must be a non-empty string")
    project_dir = _workspace_root()
    job = _load_job(project_dir, job_id.strip())
    if job is None:
        return _error_payload("JOB_NOT_FOUND", f"job_id '{job_id}' was not found")
    refreshed = _refresh_job_state(job)
    return json.dumps({"ok": True, "job": refreshed})


@mcp.tool()
@track_usage("child-agent-runner")
def list_child_agent_jobs(limit: int = 20, include_finished: bool = True) -> str:
    """List recent async child-agent jobs for queue polling/orchestration loops."""
    if limit < 1 or limit > 500:
        return _error_payload("INVALID_LIMIT", "limit must be between 1 and 500")

    project_dir = _workspace_root()
    jobs = _list_jobs(project_dir)
    refreshed_jobs = [_refresh_job_state(job) for job in jobs]
    if not include_finished:
        refreshed_jobs = [job for job in refreshed_jobs if str(job.get("status")) in ("queued", "running")]
    return json.dumps({"ok": True, "jobs": refreshed_jobs[:limit]})


def _main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--job-id")
    args, _ = parser.parse_known_args()
    if args.worker:
        if not args.job_id:
            return 2
        return _run_worker(args.job_id)
    mcp.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
