---
name: entra-vite-spa-auth
description: Diagnose and fix Entra ID (MSAL) authentication issues in Vite+React SPAs deployed to Azure Container Apps. Covers redirect URI misconfigurations, COOP popup warnings, token version mismatches, audience/issuer validation failures, and build-time vs runtime env var pitfalls. Use when login popups are blank, auth redirects go to localhost, tokens return 401, or MSAL errors appear in browser console.
---

# Entra + Vite SPA Auth Skill

## Purpose

Use this skill to systematically diagnose and fix authentication issues in
Vite-built React SPAs that use MSAL.js (@azure/msal-browser) with Entra ID
(Azure AD), especially when deployed as Docker containers to Azure Container Apps.

## Invoke When

Use this skill when the user mentions any of:

- Login popup is blank / about:blank
- Auth redirect goes to localhost in production
- MSAL redirect URI mismatch
- "No account found" errors after login
- 401 Unauthorized on API calls after login
- Token validation error / invalid token
- Cross-Origin-Opener-Policy (COOP) warnings
- MSAL popup blocked or not closing
- "audience must be a string" errors
- Token version mismatch (v1 vs v2)
- `VITE_*` env vars empty in production build
- Login works locally but not in production

## Key Concepts

### Vite Build-Time vs Runtime Variables

**CRITICAL**: Vite inlines `import.meta.env.VITE_*` at build time via string
replacement. In Docker builds, these values must be available as environment
variables WHEN `npm run build` (or `vite build`) runs — not at container start.

```dockerfile
# ✅ Correct: ARG → ENV before build step
ARG VITE_MSAL_CLIENT_ID
ENV VITE_MSAL_CLIENT_ID=$VITE_MSAL_CLIENT_ID
RUN npm run build

# ❌ Wrong: ENV set after build — too late, already inlined as empty string
RUN npm run build
ENV VITE_MSAL_CLIENT_ID=$VITE_MSAL_CLIENT_ID
```

**Best practice**: Prefer `window.location.origin` for values that change per
environment (like redirect URIs) to avoid build-time coupling entirely:

```typescript
// ✅ Runtime-derived — works everywhere
redirectUri: `${window.location.origin}/welcome`

// ❌ Build-time — breaks if env var missing at build
redirectUri: import.meta.env.VITE_MSAL_REDIRECT_URI || 'http://localhost:3000'
```

### MSAL Configuration Checklist

```typescript
const msalConfig = {
  auth: {
    clientId: import.meta.env.VITE_MSAL_CLIENT_ID,      // Build-time OK (stable)
    authority: import.meta.env.VITE_MSAL_AUTHORITY,      // Build-time OK (stable)
    redirectUri: `${window.location.origin}/welcome`,    // RUNTIME (env-agnostic)
  },
  cache: {
    cacheLocation: 'sessionStorage',
    storeAuthStateInCookie: false,
  },
}
```

## Diagnostic Protocol

### Step 1: Identify the Symptom Category

| Symptom | Likely Cause | Jump To |
|---------|-------------|---------|
| Blank popup / about:blank | Empty MSAL config (clientId/authority) | Step 2 |
| Redirect to localhost | redirectUri hardcoded or VITE_* not set | Step 3 |
| 401 on API calls | Token validation failure | Step 4 |
| "No account found" | WebSocket/API called before auth completes | Step 5 |
| COOP warnings in console | Missing COOP header on server | Step 6 |
| Popup doesn't close | Redirect URI not registered in Entra | Step 3 |

### Step 2: Blank Popup — Empty MSAL Config

**Diagnose**: Check if VITE_* variables were passed at Docker build time.

```bash
# Check what's in the built JS bundle
az containerapp exec --name <web-app> --resource-group <rg> -- \
  grep -o 'clientId:"[^"]*"' /usr/share/nginx/html/assets/*.js
```

If `clientId:""`, the env var was empty at build time.

**Fix**:
1. Add `ARG` + `ENV` to Dockerfile BEFORE the `RUN npm run build` step
2. Pass `--build-arg VITE_MSAL_CLIENT_ID=<value>` to `az acr build`

### Step 3: Redirect to Localhost

**Diagnose**: Check the MSAL redirectUri in the source code and Entra app
registration.

```bash
# Check source code
grep -n 'redirectUri' src/App.tsx src/main.tsx src/auth*.ts*

# Check Entra SPA redirect URIs
az ad app show --id <web-client-id> --query 'spa.redirectUris' -o json
```

**Fix**:
1. Change `redirectUri` to use `window.location.origin`:
   ```typescript
   redirectUri: `${window.location.origin}/welcome`
   ```
2. Ensure the production URL is registered as a SPA redirect URI:
   ```bash
   # Add production redirect URI
   CURRENT=$(az ad app show --id <id> --query 'spa.redirectUris' -o json)
   az ad app update --id <id> --spa-redirect-uris \
     "http://localhost:3000/welcome" \
     "https://<production-fqdn>/welcome"
   ```
3. Use SPA platform (not Web platform) for redirect URIs — MSAL.js
   requires SPA type for PKCE/implicit flows.

### Step 4: 401 Unauthorized on API Calls

Token validation failures have multiple possible causes. Check in order:

#### 4a: Token Version Mismatch (v1 vs v2)

```bash
# Check API app's accessTokenAcceptedVersion
az ad app show --id <api-client-id> \
  --query 'api.requestedAccessTokenVersion' -o json
```

- `null` or `1` → v1 tokens (issuer: `https://sts.windows.net/{tenant}/`)
- `2` → v2 tokens (issuer: `https://login.microsoftonline.com/{tenant}/v2.0`)

**Fix**: Set to v2 to match v2 OIDC metadata:
```bash
az rest --method PATCH \
  --uri "https://graph.microsoft.com/v1.0/applications/<object-id>" \
  --body '{"api":{"requestedAccessTokenVersion":2}}'
```

⚠️ After changing version, users must clear sessionStorage and re-login to
get new format tokens. Cached tokens retain the old format until they expire.

#### 4b: Audience Mismatch

v1 and v2 tokens use different `aud` claim formats:
- v1: `aud` = app ID URI (e.g., `api://<api-client-id>`)
- v2: `aud` = application GUID (e.g., `<api-client-id>`)

**Fix**: API validation code should accept both formats:
```python
# Accept both GUID and api:// URI
bare = configured_audience.removeprefix("api://")
token_aud = claims.get("aud")
if isinstance(token_aud, str) and token_aud in {bare, f"api://{bare}"}:
    expected_aud = token_aud  # Use token's own format
```

Or set `JWT_AUDIENCE` to the bare GUID and accept both in code.

#### 4c: Issuer Mismatch

If `JWT_ISSUER` is set but doesn't match the token's `iss` claim:

**Fix**: Either set `JWT_ISSUER` to empty (rely on JWKS signature only) or
ensure it matches the token version's issuer format.

#### 4d: Scope Mismatch

```bash
# Check what scopes the API exposes
az ad app show --id <api-client-id> --query 'api.oauth2PermissionScopes[].value'
```

Frontend must request matching scope:
```typescript
scopes: [`api://${API_CLIENT_ID}/<scope-value>`]
```

#### 4e: Missing Pre-authorization

The web app must be pre-authorized on the API app for the scope:
```bash
az ad app show --id <api-client-id> --query 'api.preAuthorizedApplications'
```

### Step 5: "No account found" / Premature API Calls

**Diagnose**: Check if components that require auth tokens (e.g., WebSocket
providers, API clients) are rendered before authentication completes.

**Fix**: Only render auth-dependent components inside authenticated routes:
```tsx
// ✅ Correct: WebSocket only for authenticated routes
<Route path="/dashboard" element={
  <AuthGuard><WebSocketProvider><Dashboard /></WebSocketProvider></AuthGuard>
} />

// ❌ Wrong: WebSocket wraps all routes including unauthenticated
<WebSocketProvider>
  <Routes>
    <Route path="/welcome" element={<LandingPage />} />
  </Routes>
</WebSocketProvider>
```

### Step 6: COOP Warnings

`Cross-Origin-Opener-Policy policy would block the window.closed call`

**Diagnose**: MSAL popup flow needs COOP `same-origin-allow-popups` on the
page that opens the popup.

**Fix**: Set header on nginx / WAF:
```nginx
add_header Cross-Origin-Opener-Policy "same-origin-allow-popups" always;
```

⚠️ Some COOP warnings are unavoidable — Microsoft's login page sets its own
stricter COOP which conflicts. These don't break auth, just generate warnings.

### Step 7: Dual CSP Headers

If both WAF (reverse proxy) and web app nginx serve CSP headers, browsers
enforce ALL of them (intersection). Both must allow MSAL-related origins:

```
connect-src 'self' https://login.microsoftonline.com https://*.microsoftonline.com;
frame-src 'self' https://login.microsoftonline.com;
```

## Quick Reference: Entra App Registration Commands

```bash
# Show web app registration
az ad app show --id <web-client-id> --query '{appId:appId, spa:spa, signInAudience:signInAudience}'

# Show API app registration
az ad app show --id <api-client-id> --query '{appId:appId, tokenVersion:api.requestedAccessTokenVersion, scopes:api.oauth2PermissionScopes[].value, preAuth:api.preAuthorizedApplications}'

# Add SPA redirect URI
az ad app update --id <web-client-id> --spa-redirect-uris "http://localhost:3000/welcome" "https://<prod>/welcome"

# Set token version to v2
OBJECT_ID=$(az ad app show --id <api-client-id> --query id -o tsv)
az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/${OBJECT_ID}" \
  --body '{"api":{"requestedAccessTokenVersion":2}}'

# Pre-authorize web app on API
az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/${OBJECT_ID}" \
  --body '{"api":{"preAuthorizedApplications":[{"appId":"<web-client-id>","delegatedPermissionIds":["<scope-id>"]}]}}'

# Check OIDC metadata
curl -s "https://login.microsoftonline.com/<tenant>/v2.0/.well-known/openid-configuration" | jq .issuer
```

## Remediation Actions

After fixing code:

1. **Rebuild web**: `az acr build --registry __ACR_NAME__ --image __PROJECT_NAME__-web:<tag> --build-arg VITE_MSAL_CLIENT_ID=__WEB_CLIENT_ID__ --build-arg VITE_MSAL_AUTHORITY=https://login.microsoftonline.com/__TENANT_ID__ --build-arg VITE_MSAL_API_CLIENT_ID=__API_CLIENT_ID__ ../__PROJECT_NAME__-web`
2. **Deploy web**: `az containerapp update --name __PROJECT_NAME__-web -g __RESOURCE_GROUP__ --image __ACR_NAME__.azurecr.io/__PROJECT_NAME__-web:<tag>`
3. **User action**: Hard-refresh browser (Ctrl+Shift+R) to load new JS bundle
4. **If token issues**: Clear browser sessionStorage → re-login for fresh tokens

## Pre-Deploy Validation (Run BEFORE building)

Before every web image build, verify these in ONE pass:

```bash
# 1. Source code checks (2 seconds)
grep -q 'acquireTokenPopup' src/hooks/useAuth.ts || echo "FAIL: must use popup not redirect"
grep -q 'window.location.origin' src/App.tsx || echo "FAIL: redirectUri must be runtime-derived"
grep -q 'VITE_MSAL_API_CLIENT_ID' src/hooks/useAuth.ts || echo "FAIL: scope must use API client ID"

# 2. Dockerfile checks (instant)
grep -n 'ARG VITE_MSAL' Dockerfile | head -5  # Must appear BEFORE RUN npm run build

# 3. Entra registration checks (5 seconds)
az ad app show --id __WEB_CLIENT_ID__ \
  --query '{spa:spa.redirectUris, audience:signInAudience}' -o json
# spa.redirectUris MUST include the production WAF FQDN + /welcome
```

If any check fails, fix BEFORE building. This eliminates the build→deploy→debug→rebuild loop
that consumed 5+ iterations in past sessions.

## Word-Game Specific IDs (copy-paste ready)

```
WEB_CLIENT_ID=__WEB_CLIENT_ID__
API_CLIENT_ID=__API_CLIENT_ID__
TENANT_ID=__TENANT_ID__
AUTHORITY=https://login.microsoftonline.com/__TENANT_ID__
SCOPE=api://__API_CLIENT_ID__/access_as_user
WAF_FQDN=__PROJECT_NAME__-waf.__ACA_ENV_SUFFIX__.__REGION__.azurecontainerapps.io
REDIRECT_URI=https://__PROJECT_NAME__-waf.__ACA_ENV_SUFFIX__.__REGION__.azurecontainerapps.io/welcome
```

## Token Efficiency Rules

1. **Consult `.copilot/topology.md`** before searching — all file paths and IDs are there
2. **Never run `find` for known files** — useAuth.ts, App.tsx, Dockerfile locations are fixed
3. **Validate BEFORE building** — the pre-deploy checks above take 7 seconds vs 3+ minutes per failed build cycle
4. **One `az ad app show` call with compound `--query`** — never multiple calls for different fields
5. **Check deployed bundle with one curl** — `curl -s "$WAF/" | grep -oP '/assets/index-[^"]+\.js'` then inspect

## Output Format

Present findings as:

1. **Symptom**: What the user sees (console errors, blank popup, 401, etc.)
2. **Root Cause**: Which misconfiguration causes it
3. **Evidence**: Specific config values, log lines, or response codes
4. **Fix**: Code changes + commands to apply
5. **Verify**: How to confirm the fix (expected console output, HTTP status)
6. **URL**: Always end with the URL the user can visit to verify
