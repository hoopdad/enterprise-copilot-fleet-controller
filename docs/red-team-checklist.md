# Red-Team Review Checklist

Explicit criteria for when and how to red-team generated artifacts.

## Trigger: Red-Team When **ANY** Apply

- [ ] Touches authentication, authorization, or session management
- [ ] Modifies `.contracts/*.yml` (API boundary change)
- [ ] Crosses repository boundaries (affects >1 specialist)
- [ ] Changes data models or database schemas
- [ ] Modifies non-functional requirements (latency, SLOs, rate limits)
- [ ] Introduces new external dependencies or integrations
- [ ] Changes infrastructure (Terraform, Docker, CI/CD)
- [ ] Handles PII, financial data, or security-sensitive information
- [ ] Modifies error handling or retry/fallback behavior

## Skip: Safe to Skip When **ALL** Apply

- Single-file cosmetic change (formatting, typo, comment)
- Documentation-only update
- No contract or requirement file modified
- Change confined to one specialist's repo with no cross-repo effect

## Red-Team Review Steps

1. **Adversarial requirements check** — Missing scenarios? Implicit assumptions not stated?
2. **Security analysis** — Input validation gaps? Injection vectors? Auth bypasses? Secrets exposure?
3. **Failure mode analysis** — Upstream down? Race conditions? Partial failure states? Retry storms?
4. **NFR violation check** — Latency budgets? Load targets? Test coverage?
5. **Contract consistency** — Do affected `.contracts/*.yml` files agree on types and error codes?
6. **Edge cases** — Empty/null inputs? Boundary values? Unicode? Clock skew?

## Output

For each flaw:
1. State the flaw clearly (one sentence)
2. Classify severity: `critical` | `high` | `medium` | `low`
3. Add mitigation to `.requirements/*.yml` or `.contracts/*.yml` **before** delegating

## Audit Trail

Append to `.decisions/log.md`:
```
YYYY-MM-DD | red-team | <feature> | <N flaws, N mitigated> | <critical findings if any>
```
