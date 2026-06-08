# Post-Init Validation Checklist

**Purpose**: After `init.sh` generates your project scaffolding, review this checklist
before proceeding. This ensures the human-frames / agent-executes / human-reviews loop
is closed — generated artifacts don't ship without explicit confirmation.

---

## Generated Artifact Summary

After init completes, the following were generated (LLM-authored):

| Artifact | Path | Review Focus |
|----------|------|--------------|
| Guardrail snapshots | `.copilot/guardrails/*.yml` | Pattern/NFR fidelity, hard requirements |
| Orchestrator instructions | `.copilot/instructions.md` | Role boundaries, queue protocol, delegation rules |
| Specialist + critic agents | `<child>/.github/agents/*.agent.md` | Correct repo mapping, stack detection, queue semantics |
| Copilot instructions | `.copilot/instructions.md` | Workflow accuracy, tool references |
| MCP tool config (optional) | `.copilot/mcp.json` | Server paths, env vars |
| Contracts (if extracted) | `.contracts/*.yml` | Endpoint accuracy, type correctness |
| Decision log | `.decisions/log.md` | Reasonable initial entries |

---

## Review Checklist

### 1. Specialist Boundaries

- [ ] Each specialist maps to exactly one child repo in `.repo-index.yml`
- [ ] No repo is owned by multiple specialists
- [ ] Stack detection is correct (language, framework, test runner)
- [ ] Validate commands are runnable (`lint`, `test`, `build`)
- [ ] `reads:` and `writes:` paths are accurate

### 2. Contract Definitions

- [ ] Contracts reflect actual or intended API boundaries
- [ ] No hallucinated endpoints (check against existing code if any)
- [ ] Types are consistent across producer/consumer contracts
- [ ] Error response shapes are defined

### 3. Orchestrator Protocol

- [ ] Red-team criteria match your risk tolerance
- [ ] Delegation rules align with specialist boundaries
- [ ] Lifecycle reflects implementation/evaluation split (specialists implement, critic evaluates)
- [ ] Acceptance explicitly requires critic `STATUS: PASS` (`STATUS: FAIL` blocks merge)
- [ ] Queue flow is explicit: `work/todo → work/ready-for-review → work/done`
- [ ] NFR section references your actual requirements
- [ ] Decision log format is clear

### 4. Copilot Instructions

- [ ] Workflow steps are accurate and ordered correctly
- [ ] If MCP is enabled, MCP tool references match what's in `.copilot/mcp.json`
- [ ] No references to tools or repos that don't exist

### 5. MCP Configuration

- [ ] If MCP is enabled, all server paths resolve correctly
- [ ] If MCP is enabled, required environment variables are documented
- [ ] If MCP is enabled, no extraneous servers configured

---

## How to Review

```bash
# Quick diff of all generated files:
git diff --stat HEAD

# Review each file:
git diff HEAD -- .repo-index.yml
git diff HEAD -- ../*/.github/agents/
git diff HEAD -- .contracts/
git diff HEAD -- .copilot/
git diff HEAD -- .decisions/

# If something is wrong, edit directly then:
git add -A && git commit --amend --no-edit
```

---

## Common Issues to Watch For

| Issue | Symptom | Fix |
|-------|---------|-----|
| Hallucinated endpoints | Contract references APIs that don't exist | Remove from `.contracts/`, or add to requirements |
| Wrong specialist boundary | Two repos share a concern | Merge specialists or add cross-repo contract |
| Stale stack detection | Wrong test/lint/build commands | Edit child repo `.agent.md` directly |
| Missing specialist | A repo has no agent | Run init phase 2 again or create manually |
| Missing critic gate | Acceptance can proceed without explicit evaluation verdict | Add critic lifecycle step + enforce `STATUS: PASS` |
| Over-broad orchestrator | Orchestrator owns implementation details | Move to specialist, keep orchestrator strategic |

---

## Sign-Off

After reviewing all items above:

```bash
# Confirm the init is correct:
git log --oneline -1  # Should show the init commit

# If changes were needed:
git add -A && git commit --amend -m "feat: initialize enterprise-copilot-fleet-controller for <project>

Reviewed and corrected post-init artifacts.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

> **Rule**: Do not proceed with `copilot -p` tasks until this review is complete.
> The framework assumes correct specialist boundaries and contracts from this point forward.
