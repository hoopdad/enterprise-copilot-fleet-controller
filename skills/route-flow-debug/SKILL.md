---
name: route-flow-debug
description: Diagnose request-flow mismatches across user→WAF→API/Web layers. Use when seeing 404, 405, 502 errors, CORS failures, payload mismatches, or when API routes don't align with frontend calls. Validates path, method, port, hostname, and field-name alignment in one pass.
---

# Route Flow Debug Skill

## Purpose

Diagnose and fix request routing issues in the WAF→Web/API→Agent chain.
Eliminates the repeated curl→grep→check→rebuild cycles that consumed 10+ turns
in recent troubleshooting sessions.

## Invoke When

- 404 Not Found on API calls through WAF
- 405 Method Not Allowed (OWASP CRS rule 911100 or missing route)
- 502 Bad Gateway (upstream unreachable)
- CORS errors in browser
- Request body rejected (field name mismatch: camelCase vs snake_case)
- "Connection refused" or "No healthy upstream" in WAF logs
- API works directly but fails through WAF

## One-Pass Diagnostic (Run This First)

```bash
WAF="https://__PROJECT_NAME__-waf.__ACA_ENV_SUFFIX__.__REGION__.azurecontainerapps.io"

echo "=== Route Flow Verification ==="
echo "1. WAF health"
curl -s -o /dev/null -w "%{http_code}" "$WAF/health"

echo "2. SPA (GET /)"
curl -s -o /dev/null -w "%{http_code}" "$WAF/"

echo "3. API health (GET /api/scores/game-count)"
curl -s -o /dev/null -w "%{http_code}" "$WAF/api/scores/game-count"

echo "4. API auth route (GET /api/users/active) - expects 401 without token"
curl -s -o /dev/null -w "%{http_code}" "$WAF/api/users/active"

echo "5. Registration (POST /api/users/register) - expects 401 without token"
curl -s -o /dev/null -w "%{http_code}" -X POST "$WAF/api/users/register" \
  -H "Content-Type: application/json" -d '{"display_name":"test"}'

echo "6. Agent (POST /agent/analyze) - expects 401 without token"
curl -s -o /dev/null -w "%{http_code}" -X POST "$WAF/agent/analyze"
```

Expected results: health=200, SPA=200, game-count=200, others=401.
Any 404/405/502 indicates a routing issue.

## Decision Tree

| Status Code | Where | Cause | Fix |
|-------------|-------|-------|-----|
| 404 | WAF | nginx location block missing | Add `location /api/path` to WAF nginx.conf.template |
| 405 | WAF | OWASP CRS rule 911100 | Exclude rule for that path in modsecurity-override.conf |
| 405 | API | Route not registered in FastAPI | Add route handler in __PROJECT_NAME__-api/app/routes/ |
| 502 | WAF | Upstream app not running | Check target app with `diagnose_container_app` |
| 502 | WAF | Wrong upstream port | Check WAF env var for FQDN, verify target port in nginx |
| CORS | Browser | Missing CORS header | Check WAF CSP headers and API CORS config |
| 422 | API | Field name mismatch | Frontend must send snake_case (e.g., display_name not displayName) |

## Key Files to Check (in order)

1. **WAF nginx routing**: `__PROJECT_NAME__-waf/docker/nginx/nginx.conf.template`
   - Verify `location /api/` proxies to API FQDN
   - Verify `location /agent/` proxies to Agent FQDN
   - Verify `location /` proxies to Web FQDN

2. **WAF ModSecurity rules**: `__PROJECT_NAME__-waf/docker/modsecurity/modsecurity-override.conf`
   - Rule 911100 blocks PUT/PATCH/DELETE unless excluded
   - Excluded paths must match actual API paths

3. **API routes**: `__PROJECT_NAME__-api/app/main.py` and `__PROJECT_NAME__-api/app/routes/`
   - Route prefixes must match what WAF forwards (strip `/api` prefix if WAF passes it through)

4. **Frontend API calls**: `__PROJECT_NAME__-web/src/services/apiClient.ts`
   - Base URL must be `/api` (relative)
   - Field names in request bodies must be snake_case

5. **Contract alignment**: `.contracts/game-api.yml`
   - Source of truth for all endpoints, methods, and field names

## Bundle Inspection (One Command)

Verify what the deployed SPA is actually calling:

```bash
WAF="https://__PROJECT_NAME__-waf.__ACA_ENV_SUFFIX__.__REGION__.azurecontainerapps.io"
JS=$(curl -s "$WAF/" | grep -oP '/assets/index-[^"]+\.js' | head -1)
echo "Bundle: $JS"
curl -s "$WAF$JS" | grep -oP '"/api/[^"]*"' | sort -u
```

This shows every API path the frontend calls. Compare against `game-api.yml`.

## OWASP CRS 911100 Fix Recipe

When PUT/PATCH/DELETE returns 405 through WAF:

```
# In __PROJECT_NAME__-waf/docker/modsecurity/modsecurity-override.conf
SecRule REQUEST_URI "@beginsWith /api/" \
  "id:1001,\
  phase:1,\
  pass,\
  nolog,\
  ctl:ruleRemoveById=911100"
```

## Token Efficiency Rules

1. Run the one-pass diagnostic FIRST — it identifies the layer in 6 curl calls (one turn)
2. Never curl individual endpoints one-at-a-time in separate turns
3. Check `.contracts/game-api.yml` before looking at source code — it's the source of truth
4. Consult `.copilot/topology.md` for all file paths — never use `find`
5. Fix and rebuild in one turn: edit → build → deploy → verify (not 4 separate turns)
