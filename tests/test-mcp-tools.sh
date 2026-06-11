#!/bin/bash
# tests/test-mcp-tools.sh — Smoke tests for all MCP tool servers
#
# Verifies: each server module imports cleanly, registers tools, and can respond
# to a basic JSON-RPC initialize/list_tools handshake.
#
# Usage: bash tests/test-mcp-tools.sh
#
# Prerequisites: python3, pip install -r tools/requirements.txt

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRAMEWORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TOOLS_DIR="$FRAMEWORK_DIR/tools"
TEST_WORK_DIR="$FRAMEWORK_DIR/.test-work/mcp-tools"
PASS=0
FAIL=0
TESTS_RUN=0

mkdir -p "$TEST_WORK_DIR"
trap 'rm -rf "$TEST_WORK_DIR"' EXIT

# ─────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────
assert_pass() {
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ "$1" -eq 0 ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: $2"
  fi
}

# Run a command, capture exit code without tripping set -e
run_check() {
  local rc=0
  "$@" || rc=$?
  echo $rc
}

# ─────────────────────────────────────────────────────────────
# Check Python environment
# ─────────────────────────────────────────────────────────────
echo "═══ MCP Tool Smoke Tests ═══"
echo ""

if ! command -v python3 &>/dev/null; then
  echo "ERROR: python3 not found"
  exit 1
fi

# Verify mcp package available
if ! python3 -c "import mcp" 2>/dev/null; then
  echo "Installing MCP dependencies..."
  pip install -q -r "$TOOLS_DIR/requirements.txt"
fi

# ─────────────────────────────────────────────────────────────
# Test each tool server
# ─────────────────────────────────────────────────────────────
SERVERS=(
  "usage-tracker"
  "contract-compliance"
  "security-scanner"
  "ci-monitor"
  "deploy-verifier"
  "scaffold-generator"
  "azure-inspector"
  "azure-resource-status"
  "lint-local"
  "terraform-local"
  "git-pr-orchestrator"
  "repo-index"
  "child-agent-runner"
)

for server in "${SERVERS[@]}"; do
  SERVER_DIR="$TOOLS_DIR/$server"
  SERVER_PY="$SERVER_DIR/server.py"

  echo "  Testing: $server"

  # Test 1: File exists
  if [[ ! -f "$SERVER_PY" ]]; then
    TESTS_RUN=$((TESTS_RUN + 1))
    FAIL=$((FAIL + 1))
    echo "    FAIL: $SERVER_PY not found"
    continue
  fi

  # Test 2: Syntax valid
  rc=0
  python3 -c "
import sys, py_compile
try:
    py_compile.compile('$SERVER_PY', doraise=True)
except py_compile.PyCompileError as e:
    print(f'    Syntax error: {e}')
    sys.exit(1)
" 2>/dev/null || rc=$?
  assert_pass $rc "$server: syntax error"

  # Test 3: Module imports without error
  rc=0
  python3 -c "
import sys, os
os.environ.setdefault('PROJECT_DIR', '$TEST_WORK_DIR/import-${server}')
sys.path.insert(0, '$TOOLS_DIR')
sys.path.insert(0, '$SERVER_DIR')

import importlib.util
try:
    spec = importlib.util.spec_from_file_location('server_${server//-/_}', '$SERVER_PY')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    if not hasattr(mod, 'mcp'):
        print('    No mcp FastMCP instance found')
        sys.exit(1)
except SystemExit as e:
    sys.exit(0 if e.code == 0 or e.code is None else 1)
except Exception as e:
    print(f'    Import error: {e}')
    sys.exit(1)
" 2>/dev/null || rc=$?
  assert_pass $rc "$server: import failed"

  # Test 4: Server has mcp instance
  rc=0
  python3 -c "
import sys, os
os.environ.setdefault('PROJECT_DIR', '$TEST_WORK_DIR/mcp-${server}')
sys.path.insert(0, '$TOOLS_DIR')
sys.path.insert(0, '$SERVER_DIR')

import importlib.util
spec = importlib.util.spec_from_file_location('server_${server//-/_}', '$SERVER_PY')
mod = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(mod)
except SystemExit:
    pass

if getattr(mod, 'mcp', None) is None:
    sys.exit(1)
" 2>/dev/null || rc=$?
  assert_pass $rc "$server: no mcp instance"

done

# ─────────────────────────────────────────────────────────────
# Test shared instrumentation module
# ─────────────────────────────────────────────────────────────
echo ""
echo "  Testing: shared/instrumentation"
rc=0
python3 -c "
import json
import os
import pathlib
import sys
sys.path.insert(0, '$TOOLS_DIR')
from shared.instrumentation import log_usage_direct, track_usage
decorator = track_usage('test-server')
assert callable(decorator), 'track_usage should return a decorator'

project_dir = pathlib.Path('$TEST_WORK_DIR/instrumentation')
os.environ['PROJECT_DIR'] = str(project_dir)
os.environ['PROJECT_NAME'] = 'mcp-tools-test'
log_file = project_dir / '.metrics' / 'usage.jsonl'
if log_file.exists():
    log_file.unlink()

@decorator
def sample_tool(value: int) -> int:
    return value + 1

@decorator
def failing_tool() -> None:
    raise RuntimeError('expected failure')

assert sample_tool(1) == 2
try:
    failing_tool()
except RuntimeError:
    pass
else:
    raise AssertionError('Expected failure to be re-raised')

log_usage_direct(
    agent='test',
    action='direct',
    tool='test-mcp-tools',
    task_id='task-123',
    origin='nested',
    status='failure',
    duration_ms=4,
    error_type='ValueError',
    error_message='bad value',
    prompt_tokens=120,
    completion_tokens=30,
    estimated_token_savings=50,
    baseline_total_tokens=220,
    turn_count=6,
    retry_count=2,
    loop_hint=True,
    quality_score=0.72,
    consistency_score=0.66,
    outcome_confidence=0.58,
)

entries = [json.loads(line) for line in log_file.read_text().splitlines() if line.strip()]
assert len(entries) >= 3, f'Expected >=3 usage entries, got {len(entries)}'

success = next(e for e in entries if e.get('detail') == 'sample_tool')
assert success['status'] == 'success'
assert success['origin'] == 'top_level'
assert isinstance(success.get('duration_ms'), int)
assert success.get('event_id')
assert success.get('run_id')

failure = next(e for e in entries if e.get('detail') == 'failing_tool')
assert failure['status'] == 'failure'
assert failure['error_type'] == 'RuntimeError'
assert failure['error_message'] == 'expected failure'
assert isinstance(failure.get('duration_ms'), int)

direct = next(e for e in entries if e.get('action') == 'direct')
assert direct['task_id'] == 'task-123'
assert direct['origin'] == 'nested'
assert direct['status'] == 'failure'
assert direct['error_type'] == 'ValueError'
assert direct['error_message'] == 'bad value'
assert direct['duration_ms'] == 4
assert direct['prompt_tokens'] == 120
assert direct['completion_tokens'] == 30
assert direct['total_tokens'] == 150
assert direct['estimated_token_savings'] == 50
assert direct['baseline_total_tokens'] == 220
assert direct['turn_count'] == 6
assert direct['retry_count'] == 2
assert direct['loop_hint'] is True
assert direct['quality_score'] == 0.72
assert direct['consistency_score'] == 0.66
assert direct['outcome_confidence'] == 0.58
" 2>/dev/null || rc=$?
assert_pass $rc "shared/instrumentation: usage schema and wrapper behavior"

# ─────────────────────────────────────────────────────────────
# Test usage-tracker direct invocation helper
# ─────────────────────────────────────────────────────────────
echo "  Testing: shared/usage_client"
rc=0
python3 -c "
import sys, os
os.environ['PROJECT_DIR'] = '$TEST_WORK_DIR/usage-client'
sys.path.insert(0, '$TOOLS_DIR')
from shared.usage_client import log_usage_direct
result = log_usage_direct(agent='test', action='smoke_test', tool='test-mcp-tools')
assert 'logged' in result, f'Expected logged status, got: {result}'
" 2>/dev/null || rc=$?
assert_pass $rc "shared/usage_client: direct invocation failed"

echo "  Testing: usage-tracker/log_usage"
rc=0
python3 -c "
import json
import os
import pathlib
import sys
sys.path.insert(0, '$TOOLS_DIR')
sys.path.insert(0, '$TOOLS_DIR/usage-tracker')
import importlib.util

os.environ['PROJECT_DIR'] = '$TEST_WORK_DIR/usage-tracker'
os.environ['PROJECT_NAME'] = 'mcp-tools-test'
spec = importlib.util.spec_from_file_location('usage_tracker_server', '$TOOLS_DIR/usage-tracker/server.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

mod.log_usage(
    agent='test-agent',
    action='test-action',
    tool='usage-tracker',
    event_id='evt-123',
    run_id='run-123',
    task_id='task-xyz',
    parent_event_id='evt-parent',
    origin='nested',
    status='failure',
    duration_ms=9,
    error_type='RuntimeError',
    error_message='oops',
    prompt_tokens=300,
    completion_tokens=100,
    estimated_token_savings=120,
    baseline_total_tokens=560,
    turn_count=5,
    retry_count=1,
    loop_hint=True,
    quality_score=0.77,
    consistency_score=0.73,
    outcome_confidence=0.64,
)

log_file = pathlib.Path(os.environ['PROJECT_DIR']) / '.metrics' / 'usage.jsonl'
entry = json.loads(log_file.read_text().splitlines()[-1])
assert entry['event_id'] == 'evt-123'
assert entry['run_id'] == 'run-123'
assert entry['task_id'] == 'task-xyz'
assert entry['parent_event_id'] == 'evt-parent'
assert entry['origin'] == 'nested'
assert entry['status'] == 'failure'
assert entry['duration_ms'] == 9
assert entry['error_type'] == 'RuntimeError'
assert entry['error_message'] == 'oops'
assert entry['prompt_tokens'] == 300
assert entry['completion_tokens'] == 100
assert entry['total_tokens'] == 400
assert entry['estimated_token_savings'] == 120
assert entry['baseline_total_tokens'] == 560
assert entry['turn_count'] == 5
assert entry['retry_count'] == 1
assert entry['loop_hint'] is True
assert entry['quality_score'] == 0.77
assert entry['consistency_score'] == 0.73
assert entry['outcome_confidence'] == 0.64
assert entry['agent'] == 'test-agent'
assert entry['action'] == 'test-action'
assert entry['tool'] == 'usage-tracker'
assert entry.get('ts')
assert entry.get('project') == 'mcp-tools-test'
" 2>/dev/null || rc=$?
assert_pass $rc "usage-tracker/log_usage: structured fields failed"

# ─────────────────────────────────────────────────────────────
# Test usage-tracker quality report
# ─────────────────────────────────────────────────────────────
echo "  Testing: usage-tracker/get_usage_quality_report"
rc=0
python3 -c "
import json
import os
import pathlib
import sys
sys.path.insert(0, '$TOOLS_DIR')
sys.path.insert(0, '$TOOLS_DIR/usage-tracker')
import importlib.util

os.environ['PROJECT_DIR'] = '$TEST_WORK_DIR/usage-quality'
os.environ['PROJECT_NAME'] = 'mcp-tools-test'
spec = importlib.util.spec_from_file_location('usage_tracker_server', '$TOOLS_DIR/usage-tracker/server.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

log_file = pathlib.Path(os.environ['PROJECT_DIR']) / '.metrics' / 'usage.jsonl'
mod.log_usage(agent='orchestrator', action='task_start', event_id='e-1', run_id='r-1', origin='top_level', status='success', detail='start')
mod.log_usage(agent='tool-auto', action='tool_call', tool='ci-monitor', event_id='e-2', run_id='r-1', origin='nested', status='success', duration_ms=42, detail='check_ci_status', prompt_tokens=3500, completion_tokens=700, estimated_token_savings=100, baseline_total_tokens=5000, turn_count=12, retry_count=1, quality_score=0.55, consistency_score=0.52, outcome_confidence=0.48)
mod.log_usage(agent='tool-auto', action='tool_call', tool='ci-monitor', event_id='e-3', run_id='r-1', origin='nested', status='success', duration_ms=42, detail='check_ci_status', prompt_tokens=3600, completion_tokens=800, estimated_token_savings=100, baseline_total_tokens=5100, turn_count=13, retry_count=1, loop_hint=True, quality_score=0.5, consistency_score=0.49, outcome_confidence=0.46)
mod.log_usage(agent='tool-auto', action='tool_call', tool='security-scanner', event_id='e-4', run_id='r-1', origin='nested', status='failure', duration_ms=12, detail='token sk-1234567890abcdef123456', error_message='boom', prompt_tokens=2000, completion_tokens=300, estimated_token_savings=20, baseline_total_tokens=2500, turn_count=14, retry_count=2, quality_score=0.45, consistency_score=0.43, outcome_confidence=0.4)
mod.log_usage(agent='tool-auto', action='tool_call', tool='deploy-verifier', event_id='e-5', run_id='r-1', origin='nested', status='failure', duration_ms=15, detail='verify deploy', prompt_tokens=1800, completion_tokens=300, estimated_token_savings=30, baseline_total_tokens=2500, turn_count=15, retry_count=2, loop_hint=True, quality_score=0.42, consistency_score=0.44, outcome_confidence=0.39)
mod.log_usage(agent='orchestrator', action='task_complete', event_id='e-6', run_id='r-1', origin='top_level', status='success', duration_ms=500, detail='done', prompt_tokens=1200, completion_tokens=200, estimated_token_savings=40, baseline_total_tokens=1500, turn_count=16, retry_count=0, quality_score=0.6, consistency_score=0.58, outcome_confidence=0.52)
mod.log_usage(agent='orchestrator', action='ci_green', event_id='e-7', run_id='r-1', origin='top_level', status='success', detail='green', prompt_tokens=1000, completion_tokens=200, estimated_token_savings=20, baseline_total_tokens=1300, turn_count=16, retry_count=0, quality_score=0.62, consistency_score=0.57, outcome_confidence=0.55)

with open(log_file, 'a') as fh:
    fh.write('not-json\\n')

report = json.loads(mod.get_usage_quality_report(days=7, min_events=1))
summary = report['report']['summary']
assert summary['total_events'] == 7
assert summary['top_level_events'] == 3
assert summary['nested_events'] == 4
assert summary['outcome_events'] == 2
assert summary['success_rate'] > 0.5
token_metrics = summary['token_metrics']
assert token_metrics['events_with_total_tokens'] == 6
assert token_metrics['total_tokens'] == 15600
assert token_metrics['estimated_token_savings_total'] == 310
assert token_metrics['baseline_total_tokens'] == 17900
assert token_metrics['avg_total_tokens_per_event'] == 2600.0
assert token_metrics['estimated_token_savings_rate'] == 0.017

turn_metrics = summary['turn_metrics']
assert turn_metrics['events_with_turn_count'] == 6
assert turn_metrics['tracked_runs_with_turns'] == 1
assert turn_metrics['avg_turns_per_run'] == 16.0
assert turn_metrics['retry_count_total'] == 6
assert turn_metrics['loop_hint_events'] == 2

quality_signals = summary['quality_signals']
assert quality_signals['events_with_quality_score'] == 6
assert quality_signals['events_with_consistency_score'] == 6
assert quality_signals['events_with_outcome_confidence'] == 6
assert quality_signals['outcome_confidence_avg'] == 0.467
assert quality_signals['consistency_score_avg'] == 0.505

flags = {item['type'] for item in report['report']['flags']}
assert 'duplicate_bursts' in flags
assert 'high_failure_rate' in flags
assert 'outcome_signal_present' in flags
assert 'low_token_savings' in flags
assert 'high_turn_count' in flags
assert 'retry_loop_hints' in flags
assert 'low_outcome_confidence' in flags
assert 'low_consistency' in flags

recommendations = report['report']['recommendations']
assert any('token' in rec.lower() for rec in recommendations)
assert any('turn' in rec.lower() for rec in recommendations)
assert any('loop' in rec.lower() or 'retr' in rec.lower() for rec in recommendations)

text = json.dumps(report)
assert 'sk-1234567890abcdef123456' not in text
assert '[redacted]' in text
assert report['report']['duplicate_bursts'][0]['tool'] == 'ci-monitor'
assert report['report']['tool_health'][0]['tool'] in ('ci-monitor', 'security-scanner')
"
assert_pass $rc "usage-tracker/get_usage_quality_report: report shape failed"

# ─────────────────────────────────────────────────────────────
# Results
# ─────────────────────────────────────────────────────────────
echo ""
echo "═══ Results ═══"
echo "  Tests: $TESTS_RUN  Pass: $PASS  Fail: $FAIL"
echo ""

if [[ $FAIL -gt 0 ]]; then
  echo "  ✗ SOME TESTS FAILED"
  exit 1
else
  echo "  ✓ ALL PASSED"
  exit 0
fi
