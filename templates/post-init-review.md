# Post-Init Validation Checklist

After `init.sh` completes, review these items before proceeding.

---

## Review Checklist

### 1. Specialist Boundaries
- [ ] Each specialist maps to exactly one child repo in `.repo-index.yml`
- [ ] No repo is owned by multiple specialists
- [ ] Stack detection is correct (language, framework, test runner)
- [ ] Validate commands are runnable (`lint`, `test`, `build`)

### 2. Contract Definitions
- [ ] Contracts reflect actual or intended API boundaries
- [ ] No hallucinated endpoints
- [ ] Types are consistent across producer/consumer contracts

### 3. Orchestrator Protocol
- [ ] Red-team criteria match your risk tolerance
- [ ] Delegation rules align with specialist boundaries
- [ ] Queue flow: `work/todo → work/ready-for-review → work/done`
- [ ] Acceptance requires critic `STATUS: PASS`

### 4. Copilot Instructions
- [ ] Workflow steps are accurate and ordered correctly
- [ ] All tool references exist

### 5. MCP Configuration (if enabled)
- [ ] Server paths resolve correctly
- [ ] Required environment variables are documented

---

## Quick Review

```bash
# See all generated files:
git diff --stat HEAD

# Review each:
git diff HEAD -- .repo-index.yml
git diff HEAD -- .contracts/
git diff HEAD -- .github/copilot-instructions.md
git diff HEAD -- .decisions/log.md
```

## Common Issues

| Issue | Symptom | Fix |
|-------|---------|-----|
| Hallucinated endpoints | Contract references APIs that don't exist | Remove or add to requirements |
| Wrong specialist boundary | Two repos share a concern | Merge specialists or add cross-repo contract |
| Stale stack detection | Wrong test/lint/build commands | Edit child repo `.agent.md` |
| Missing specialist | A repo has no agent | Create manually |
| Missing critic gate | Acceptance proceeds without verdict | Add critic step + enforce `STATUS: PASS` |

---

## Sign-Off

After review, confirm init is correct:

```bash
git add -A && git commit --amend -m "feat: initialize fleet-controller

Reviewed and corrected post-init artifacts.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```
