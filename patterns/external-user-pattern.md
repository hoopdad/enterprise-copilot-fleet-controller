# External User Authentication Pattern

> Reusable architecture for AI-built applications requiring self-service signup with Microsoft Entra External ID (CIAM).

## Overview

This pattern enables applications to onboard external users (customers, partners, public users) without manual directory management. Entra External ID handles identity lifecycle, email verification, and credential storage.

## When to Use

- Your app needs public signup (not just your org's employees)
- You want Microsoft-managed email verification and MFA
- You need to support email/password, social logins, or federated identity
- You don't want to build or maintain a custom identity system

## Architecture

```
┌─────────────────────────────┐
│  Landing Page (public)      │  No auth required
│  ┌───────────┐ ┌─────────┐ │
│  │ Login/    │ │ 🌙/☀️   │ │
│  │ Signup    │ │ toggle  │ │
│  └─────┬─────┘ └─────────┘ │
└────────┼────────────────────┘
         │ user clicks login/signup
         ▼
┌─────────────────────────────┐
│  Entra External ID          │  Microsoft-hosted sign-in
│  (CIAM user flow)           │
│  - Email collection         │
│  - Email OTP verification   │
│  - Password creation (new)  │
│  - MFA (configurable)       │
└─────────┬───────────────────┘
          │ ID + access tokens returned
          ▼
┌─────────────────────────────┐
│  App (authenticated)        │
│  - Profile creation (new)   │
│  - Dashboard (returning)    │
└─────────────────────────────┘
```

## User Flows

### Flow 1: New User (first visit)

```
1. User lands on public landing page
2. Clicks "Login / Sign up"
3. MSAL redirects to Entra-hosted sign-in page
4. User selects "No account? Create one"
5. Enters email → receives OTP verification code
6. Creates password, completes MFA setup (if configured)
7. Entra creates identity in directory
8. Token returned to app → app creates application profile
```

> ⚠️ **Propagation delay (AADSTS50197):** After step 7, Entra may need a few seconds to
> replicate the new user across its directory. If the app immediately requests a token and
> receives `AADSTS50197` ("could not find the user"), the frontend must:
> 1. Detect the error code in `handleRedirectPromise()` rejection
> 2. Show a friendly "Setting up your account" message (never expose raw error codes)
> 3. Auto-retry login redirect after a short delay (3 seconds recommended)
> 4. Cap auto-retries (3 max) then show a manual retry button with support guidance

### Flow 2: First-Time App User (already in directory)

```
1. User lands on public landing page
2. Clicks "Login / Sign up"
3. MSAL redirects to Entra sign-in
4. User enters credentials → authenticated
5. Token returned to app
6. App checks for profile → 404 (none exists)
7. App redirects to profile creation flow
```

### Flow 3: Returning User

```
1. User lands on public landing page
2. Clicks "Login / Sign up"
3. MSAL redirects to Entra → cached session (may skip credentials)
4. Token returned to app
5. App loads existing profile → dashboard
```

## Security Requirements

| Requirement | Implementation | Rationale |
|-------------|----------------|-----------|
| Email verification | Entra-managed OTP | Never trust unverified email claims |
| No custom email collection | Use Entra-hosted UI | Eliminates phishing/abuse of signup form |
| Rate limiting | Entra built-in + API-level | Prevents directory enumeration |
| Token storage | `sessionStorage` or in-memory | XSS resilience (avoid `localStorage`) |
| PKCE auth flow | MSAL.js default for SPAs | No client secrets in browser |
| CORS | Restrict to known origins | Prevent token theft from rogue origins |
| Session timeout | Configurable token lifetime | Limit blast radius of stolen tokens |
| Consent screen | Landing page before auth redirect | Users must explicitly choose to authenticate |

## Entra Configuration Checklist

### App Registration

```yaml
display_name: "<app-name>-web"
sign_in_audience: "AzureADandPersonalMicrosoftAccount"  # or dedicated CIAM tenant
spa:
  redirect_uris:
    - "https://<production-url>"
    - "http://localhost:<dev-port>"   # REMOVE from production registration
supported_account_types: "External"  # if using CIAM tenant
```

> ⚠️ Remove `http://localhost:*` redirect URIs from production app registrations.
> Localhost URIs allow local attackers to intercept tokens.

### API App Registration

```yaml
display_name: "<app-name>-api"
sign_in_audience: "AzureADandPersonalMicrosoftAccount"
exposed_api:
  scopes:
    - value: "access_as_user"
      admin_consent_display_name: "Access API as user"
      type: "User"
```

### User Flow (Self-Service Signup)

Configure in Azure Portal → Entra External ID → User flows:

1. **Sign up and sign in** flow
2. Identity providers: Email + password (minimum)
3. User attributes to collect: Email (required), Display Name (optional)
4. MFA: Recommended (email OTP at minimum)
5. Conditional access: Block suspicious sign-ups

## Frontend Implementation

### Route Structure

```tsx
<Routes>
  {/* Public - no auth required */}
  <Route path="/welcome" element={<LandingPage />} />

  {/* Protected - requires auth, allows missing profile */}
  <Route element={<ProtectedRoute allowMissingProfile />}>
    <Route path="/profile" element={<ProfileCreate />} />
  </Route>

  {/* Protected - requires auth + profile */}
  <Route element={<ProtectedRoute />}>
    <Route path="/" element={<Dashboard />} />
    {/* ... app routes */}
  </Route>

  {/* Fallback */}
  <Route path="*" element={<Navigate to="/welcome" replace />} />
</Routes>
```

### Landing Page Requirements

- Fully functional without authentication
- Clear call-to-action (Login / Sign up) for unauthenticated users
- If user is already authenticated: show greeting, "Go to Dashboard" button, and logout button (hide login CTA)
- Value proposition messaging (bullets or short paragraph explaining the app's benefit)
- Dark/light mode toggle (persisted in localStorage — not a security concern for preferences)
- No sensitive data exposed
- Responsive design
- Accessible (WCAG 2.1 AA minimum)

### MSAL Configuration

```typescript
export const msalConfig: Configuration = {
  auth: {
    clientId: "<web-app-client-id>",
    authority: "https://login.microsoftonline.com/<tenant-id>",
    // For CIAM tenant: "https://<tenant-name>.ciamlogin.com/<tenant-id>"
    redirectUri: "https://<production-url>",  // SECURITY: always hardcode, never use window.location.origin
    navigateToLoginRequestUrl: false,
  },
  cache: {
    cacheLocation: "sessionStorage",  // Prefer over localStorage for XSS resilience
    storeAuthStateInCookie: false,
  },
};
```

> ⚠️ **Security note:** Never use `window.location.origin` as `redirectUri` in production.
> A subdomain takeover or CDN misconfiguration could redirect tokens to an attacker.
> Use environment-specific config with hardcoded origins.

### Theme Toggle Pattern

```typescript
// Theme persisted in localStorage (non-sensitive preference)
type Theme = "light" | "dark";

function getInitialTheme(): Theme {
  const stored = localStorage.getItem("theme");
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// Apply via data attribute on <html>: document.documentElement.dataset.theme = theme;
// CSS uses: [data-theme="dark"] { --bg: #1a1a2e; --fg: #e0e0e0; }
```

## API Requirements

### Profile Endpoint

```
GET  /api/profile       → 200 (profile) | 404 (not found)
POST /api/profile       → 201 (created) | 409 (already exists)
```

- Use `sub` claim from JWT as unique user identifier (not email — emails can change)
- Upsert-safe: handle race conditions from multiple tabs
- Validate token `aud` claim matches your API app registration
- Validate `scp` (scope) claim contains `access_as_user` — reject tokens minted for other purposes
- Validate `nbf` (not-before) claim — reject pre-dated tokens

### Version Endpoint

```
GET /version → { "build": "<ci-build-number>" }
```

## Red Team Checklist

Run these checks before shipping:

- [ ] Can a user access app routes without authentication? (Only landing page should work)
- [ ] Can an attacker enumerate valid emails via timing or error differences?
- [ ] Is the signup form (Entra-hosted) rate-limited?
- [ ] Can XSS steal tokens? (Test with reflected/stored XSS vectors)
- [ ] Are tokens validated server-side (signature, aud, iss, exp)?
- [ ] Can a user create multiple profiles? (Should be prevented)
- [ ] Does the app gracefully handle expired/revoked tokens?
- [ ] Is there a logout flow that clears all cached tokens?
- [ ] Are CORS headers restrictive (not `*`)?
- [ ] Does CSP prevent inline scripts?

## Migration Path (Single-Tenant → External ID)

If starting from a single-tenant `AzureADMyOrg` app:

1. Change app registration `signInAudience` to `AzureADandPersonalMicrosoftAccount`
2. Update authority URL if moving to a CIAM tenant
3. Add self-service sign-up user flow in Entra portal
4. Add landing page (unauthenticated route)
5. Change token cache from `localStorage` to `sessionStorage`
6. Test all three flows end-to-end
7. Add rate limiting and monitoring

## Files to Create/Modify (Template)

```
src/
├── pages/
│   └── Landing.tsx          # Public landing page
│   └── Landing.module.css   # Landing styles
├── components/
│   └── ThemeToggle.tsx      # Dark/light toggle
├── auth/
│   └── msalConfig.ts        # Updated cache + authority
│   └── AuthProvider.tsx     # No changes needed
├── App.tsx                  # Add /welcome route
└── theme.css               # CSS custom properties for theming
```
