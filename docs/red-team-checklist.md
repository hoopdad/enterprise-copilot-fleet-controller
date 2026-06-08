# Red-Team Review Checklist

Explicit criteria for when and how to red-team generated artifacts.

## Trigger Criteria — MUST Red-Team When

A change must be red-teamed if **any** of these apply:

- [ ] Touches authentication, authorization, or session management
- [ ] Modifies or creates a `.contracts/*.yml` file (API boundary change)
- [ ] Crosses repository boundaries (affects >1 specialist)
- [ ] Changes data models, database schemas, or storage contracts
- [ ] Modifies non-functional requirements (latency budgets, SLOs, rate limits)
- [ ] Introduces new external dependencies or third-party integrations
- [ ] Changes infrastructure (Terraform, Docker, CI/CD pipelines)
- [ ] Handles PII, financial data, or security-sensitive information
- [ ] Modifies error handling or retry/fallback behavior

## Skip Criteria — Safe to Skip When ALL Apply

- Single-file cosmetic change (formatting, typo, comment)
- Documentation-only update
- No contract or requirement file modified
- Change is confined to a single specialist's repo with no cross-repo effect

## Red-Team Review Steps

For each triggered review:

1. **Adversarial requirements check**
   - Are there missing acceptance scenarios?
   - Can any "given/when/then" be misinterpreted?
   - Are there implicit assumptions not stated?

2. **Security analysis**
   - Input validation gaps?
   - Injection vectors (SQL, command, template)?
   - Auth bypass paths?
   - Secrets exposure risk?

3. **Failure mode analysis**
   - What happens when upstream is down?
   - Race conditions under concurrent access?
   - Partial failure states (half-written data)?
   - Timeout/retry storm potential?

4. **NFR violation check**
   - Will this realistically meet stated latency budgets?
   - Does it scale to stated load targets?
   - Test coverage: are acceptance criteria testable?

5. **Contract consistency**
   - Do all affected `.contracts/*.yml` files agree on types, shapes, error codes?
   - Are there consumers of this contract that weren't updated?
   - Version compatibility: will existing clients break?

6. **Edge cases**
   - Empty/null inputs
   - Boundary values (max length, zero, negative)
   - Unicode, special characters, very large payloads
   - Clock skew, timezone issues

## Output

For each flaw found, the red-team step MUST:
1. State the flaw clearly (one sentence)
2. Classify severity: `critical` | `high` | `medium` | `low`
3. Add a mitigation to the `.requirements/*.yml` or `.contracts/*.yml` **before** delegating to specialists

## Audit Trail

Append a one-line entry to `.decisions/log.md`:
```
YYYY-MM-DD | red-team | <feature> | <N flaws found, N mitigated> | <critical findings if any>
```
