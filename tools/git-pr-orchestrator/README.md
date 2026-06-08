# Git PR Orchestrator MCP Tool

Automates the complete release workflow: **commit → push → PR → CI monitoring → auto-merge**.

## Purpose

Designed for orchestrator agents to coordinate multi-repo releases. Handles:
- Committing changes across parent and child repos
- Creating pull requests on GitHub
- Polling GitHub Actions CI status
- Auto-merging when CI passes

## Tools Provided

### 1. `commit_and_push`
Stages, commits, and pushes changes in a sequence of repos.

**Args:**
- `repos`: List of repo paths (parent first). Example: `[".", "../api", "../web"]`
- `parent_dir`: Absolute or relative path to parent directory
- `commit_message`: Commit message (use conventional commits for auto-versioning)

**Returns:** JSON with committed repos, pushed status, and errors.

**Use case:** After local testing is done, commit work before opening PRs.

---

### 2. `create_prs`
Creates pull requests for each repo on GitHub.

**Args:**
- `repos`: List of repos in `owner/name` format (e.g., `["myorg/api", "myorg/web"]`)
- `base_branch`: Target branch (default: `main`)
- `head_branch`: Source branch (auto-detected if not specified)
- `pr_title`: PR title
- `pr_body`: PR description

**Returns:** JSON with created PR numbers, URLs, and errors.

**Use case:** Open PRs to trigger CI workflows.

---

### 3. `wait_for_ci`
Polls GitHub Actions until all repos' CI passes or fails.

**Args:**
- `repos`: List of repos in `owner/name` format
- `max_wait_seconds`: Timeout (default: 600 = 10 minutes)
- `poll_interval_seconds`: Poll frequency (default: 10s)
- `base_branch`: Branch to check CI for

**Returns:** JSON with final CI status per repo, elapsed time, and failure details.

**Use case:** Block until CI completes; extract failure logs if needed.

---

### 4. `auto_merge_prs`
Auto-merges pull requests using a specified strategy.

**Args:**
- `repos`: List of repos in `owner/name` format
- `base_branch`: The branch PRs target
- `merge_method`: Strategy: `'squash'` (default), `'merge'`, or `'rebase'`

**Returns:** JSON with merged PRs and any errors.

**Use case:** Auto-merge PRs after CI passes.

---

### 5. `orchestrate_release` (Composite)
Runs the full workflow: commit → push → PR → CI → merge.

**Args:**
- `repos`: List of repo paths (parent first)
- `parent_dir`: Path to parent directory
- `commit_message`: Commit message
- `pr_title`, `pr_body`: PR details
- `base_branch`: Target branch (default: `main`)
- `wait_ci`: Poll CI? (default: `True`)
- `max_wait_seconds`: CI timeout
- `auto_merge`: Auto-merge on success? (default: `True`)
- `merge_method`: Merge strategy

**Returns:** JSON with full workflow status (commits, PRs, CI, merge results).

**Use case:** Orchestrator calls this after coordinator approves work is complete.

## Integration with Orchestrator

Example coordinator pseudo-code:

```python
# After local tests pass and LLM approves work:
result = orchestrate_release(
    repos=[".", "../api", "../web"],
    parent_dir="/path/to/project",
    commit_message="feat: implement feature X",
    pr_title="Feature X",
    pr_body="Closes #123\n\n- [x] Local tests pass\n- [x] Reviews complete",
    wait_ci=True,
    max_wait_seconds=900,
    auto_merge=True,
    merge_method="squash"
)

# Check result
if result.phase == "complete":
    print("✓ Release workflow succeeded")
elif "failed" in result.phase:
    print(f"✗ Failed at {result.phase}")
    print(result.results)
```

## Prerequisites

- Authenticated `gh` CLI (`gh auth login`)
- Git configured in each repo
- GitHub Actions workflows defined in target repos
- Write permissions to base branches

## Error Handling

- Stops on first error (fail-fast)
- Returns detailed error messages with repo context
- CI failures include error snippets from GitHub Actions logs
- Merge failures distinguish between "already merged" and actual conflicts

## State & Webhooks

This tool is **stateless**. It:
- Does NOT listen for webhooks
- Does NOT store PR/CI state locally
- Uses polling to check CI status (via `gh run list`)
- Idempotent: can be retried safely

If webhook-based triggering is desired in the future, wrap this tool in a separate webhook service (not included here).

## Usage Example

```bash
# Via Copilot CLI (after orchestrate_release is registered in mcp.json):
copilot orchestrate_release \
  --repos '[".", "../api"]' \
  --commit-message "feat: release v1.2.0" \
  --wait-ci true
```

## Testing

See `tests/` for integration tests that mock GitHub API calls.
