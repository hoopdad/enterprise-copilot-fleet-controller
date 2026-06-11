# External User Authentication Pattern

Reusable architecture for self-service signup with Microsoft Entra External ID (CIAM).

## When to Use

- App needs public signup (not just org employees)
- Want Microsoft-managed email verification and MFA
- Don't want to build/maintain a custom identity system

## Architecture

Landing Page (public) → Entra Sign-In (email OTP, MFA) → App (authenticated, profile creation)

## Key Decisions

| Decision | Implementation |
|----------|----------------|
| Email verification | Entra-managed OTP (never trust unverified claims) |
| Signup form | Use Entra-hosted UI (eliminates phishing) |
| Token storage | `sessionStorage` (XSS resilience over localStorage) |
| Auth flow | MSAL.js with PKCE (no client secrets in browser) |
| User ID | Use `sub` claim (emails can change) |
| Tokens | Validate issuer, audience, expiry, scopes server-side |

## Entra Configuration

### App Registration (Web SPA)
```yaml
display_name: "<app-name>-web"
spa:
  redirect_uris:
    - "https://<production-url>"
    # REMOVE localhost from production
supported_account_types: "External"
```

### API App Registration
```yaml
display_name: "<app-name>-api"
exposed_api:
  scopes:
    - value: "access_as_user"
      type: "User"
```

### User Flow
- Sign up and sign in
- Identity providers: Email + password (minimum)
- MFA: Email OTP at minimum
- Conditional access: Block suspicious sign-ups

## Frontend Routes

- `/welcome` → Public landing page (no auth)
- `/profile` → Authenticated, allows missing profile
- `/` → Authenticated + profile required

## API Contracts

| Endpoint | Method | Purpose |
|----------|--------|---------|
| /api/profile | GET | Retrieve profile (200/404) |
| /api/profile | POST | Create profile (201/409) |
| /version | GET | Build metadata |

Use `sub` claim from JWT as unique user ID. Handle race conditions from multiple tabs (upsert-safe).

## Security Checklist

- [ ] Can unauthenticated users access app routes? (Only /welcome should work)
- [ ] Tokens validated server-side (signature, aud, iss, exp)?
- [ ] Can user create multiple profiles? (Should prevent)
- [ ] Graceful handling of expired/revoked tokens?
- [ ] CORS headers restrictive (not `*`)?
- [ ] CSP prevents inline scripts?
