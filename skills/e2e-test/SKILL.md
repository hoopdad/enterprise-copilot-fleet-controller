---
name: e2e-test
description: Run authenticated end-to-end API tests against the deployed __PROJECT_NAME__ environment. Validates all critical API flows through the WAF with real Entra tokens. Use after deployments, when verifying bug fixes, or as a pre-merge gate.
---

# E2E Test Skill

## Purpose

Run authenticated end-to-end API tests against the deployed __PROJECT_NAME__ environment.
Uses `az account get-access-token` to obtain a valid Entra ID token, then exercises
all critical API flows through the WAF, validating response codes and payload shapes.

## Invoke When

- After any deployment (`azd up`, `azd provision`, `scripts/azd-deploy.sh`)
- When verifying bug fixes that involve API→Cosmos or API→auth flows
- When validating that routing/WAF/API chain works end-to-end
- As a pre-merge gate for API or infra changes
- "Run e2e tests", "validate deployment", "check if APIs work"

## Prerequisites

1. **Azure CLI logged in**: `az login` with an account that has consent for the API scope
2. **API scope consent**: `api://__API_CLIENT_ID__/access_as_user`
3. **Deployed environment**: WAF container app must be running

## Quick Run

```bash
cd __PROJECT_NAME__-harness
chmod +x scripts/e2e-test.sh
./scripts/e2e-test.sh
```

Or with explicit FQDN:
```bash
./scripts/e2e-test.sh __PROJECT_NAME__-waf.__ACA_ENV_SUFFIX__.__REGION__.azurecontainerapps.io
```

## What It Tests

| # | Category | Endpoints | Auth Required |
|---|----------|-----------|---------------|
| 1 | Health | `/health`, `/version` | No |
| 2 | User Management | `GET /api/users/active` | Yes |
| 3 | Categories | `GET /api/categories/config` | Yes |
| 4 | Scores | `GET /api/scores/{game-count,all-time,today}` | Yes |
| 5 | Game | `GET /api/game/status` | Yes |
| 6 | CORS | `OPTIONS /api/users/register` | No |
| 7 | WebSocket | `POST /api/auth/ws-ticket` | Yes |

## Expected Output

```
╔══════════════════════════════════════════════════════════════╗
║           End-to-End Authenticated API Tests                ║
╚══════════════════════════════════════════════════════════════╝
  Target: https://__PROJECT_NAME__-waf.__ACA_ENV_SUFFIX__.__REGION__.azurecontainerapps.io
  Scope:  api://__API_CLIENT_ID__/access_as_user

── Acquiring Token ──
  ✅ Token acquired (1847 chars)

── 1. Infrastructure Health ──
  GET /health → 200                                            ✅
  GET /version → 200                                           ✅
...
══════════════════════════════════════════════════════════════
  Results: 12 passed, 0 failed, 0 skipped
══════════════════════════════════════════════════════════════
  ✅ E2E TESTS PASSED
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Cannot acquire token" | Not logged in or no consent | `az login` then visit API app registration to grant consent |
| All authenticated tests return 401 | Token audience mismatch | Check API_CLIENT_ID in script matches Entra app reg |
| 500 on Cosmos-backed endpoints | Cosmos unreachable | Check private DNS zone for `privatelink.documents.azure.com` |
| 502 on any endpoint | Upstream container not running | Use `container-app-troubleshoot` skill |
| 405 on PUT/POST | OWASP CRS rule 911100 | Check WAF modsecurity-override.conf |

## Integration with CI

This script exits with code 0 on success, 1 on failure. Use in CI:

```yaml
- name: E2E Tests
  run: |
    az login --service-principal ...
    ./scripts/e2e-test.sh
```

## Related

- `scripts/verify-deploy.sh` — Unauthenticated smoke test (route reachability only)
- `scripts/audit-routes.sh` — Static route alignment check
- `.contracts/game-api.yml` — API contract (source of truth for endpoints)
