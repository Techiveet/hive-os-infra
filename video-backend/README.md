# Backend

Signaling server (Express + Socket.io) for the Zoom-clone frontend. All auth,
billing, meeting, and realtime-signaling endpoints live here.

## Running tests

```bash
npm test        # builds (tsc) then runs the integration suite via node --test
```

The suite boots the compiled server in-process on a test port with an isolated
temp data directory (via the `DATA_DIR` env override) — your real `backend/data`
files are never touched. It covers:

- Waiting room (host admit/deny, media-token gating, auto-admission)
- Meeting passcode enforcement + `room-joined` passcode delivery
- Private chat (DM relay, sender echo, cross-room rejection)
- The full OAuth/OIDC pipeline against a mock identity provider (PKCE, nonce,
  JWKS signature verification, single-use auth_result codes, forged-state rejection)

## Social sign-in / SSO configuration

The login page shows **Continue with SSO / Google / Microsoft / Facebook / Apple**
buttons. A provider only lights up (enabled) once its credentials are configured;
until then the button is dimmed and clicking it says "not configured yet".

All providers are configured with environment variables. Register the app in
each provider's console and use this **redirect URI** in every one:

```
<PUBLIC_API_URL>/api/auth/oauth/<provider>/callback
```

e.g. `https://meet.example.com/api/auth/oauth/google/callback`

| Provider   | Required env vars                                                       | Notes |
| ---------- | ---------------------------------------------------------------------- | ----- |
| **SSO**    | `AUTH_SSO_CLIENT_ID`, `AUTH_SSO_CLIENT_SECRET`, `AUTH_SSO_AUTHORIZATION_URL`, `AUTH_SSO_TOKEN_URL`, `AUTH_SSO_USERINFO_URL`, `AUTH_SSO_JWKS_URL`, `AUTH_SSO_ISSUER` | Generic OIDC (Keycloak, Authentik, Azure AD via SSO, etc.). Optional: `AUTH_SSO_LABEL`, `AUTH_SSO_PKCE` (default `true`) |
| **Google** | `AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET`                    | Enable the "Google+ API"/OAuth consent screen with `openid email profile` scopes |
| **Microsoft** | `AUTH_MICROSOFT_CLIENT_ID`, `AUTH_MICROSOFT_CLIENT_SECRET`          | Optional: `AUTH_MICROSOFT_TENANT` (default `common`) |
| **Facebook** | `AUTH_FACEBOOK_CLIENT_ID`, `AUTH_FACEBOOK_CLIENT_SECRET`             | Requires `email` + `public_profile` permissions from Facebook review for production |
| **Apple**  | `AUTH_APPLE_CLIENT_ID`, plus **either** a pre-made `AUTH_APPLE_CLIENT_SECRET` **or** `AUTH_APPLE_PRIVATE_KEY` + `AUTH_APPLE_KEY_ID` + `AUTH_APPLE_TEAM_ID` | Apple's `client_secret` must be an ES256 JWT signed with your Apple key. If you provide the private key + key ID + team ID, the server mints a fresh secret automatically (Apple caps these at 180 days) |

Also set globally:

- `PUBLIC_API_URL` — public URL of this backend (used to build redirect URIs).
- `PUBLIC_FRONTEND_URL` — public URL of the frontend (used for the post-login redirect).

### Generic SSO example (Keycloak)

```
AUTH_SSO_CLIENT_ID=zoom-clone
AUTH_SSO_CLIENT_SECRET=xxxxxxxx
AUTH_SSO_AUTHORIZATION_URL=https://sso.example.com/realms/myrealm/protocol/openid-connect/auth
AUTH_SSO_TOKEN_URL=https://sso.example.com/realms/myrealm/protocol/openid-connect/token
AUTH_SSO_USERINFO_URL=https://sso.example.com/realms/myrealm/protocol/openid-connect/userinfo
AUTH_SSO_JWKS_URL=https://sso.example.com/realms/myrealm/protocol/openid-connect/certs
AUTH_SSO_ISSUER=https://sso.example.com/realms/myrealm
AUTH_SSO_LABEL=Company SSO
```

## Security notes

- The OAuth callback verifies state + PKCE + nonce, validates the ID token's
  signature against the provider's JWKS, and requires a verified email address.
- The LiveKit media token endpoint only issues tokens to users who have joined
  the meeting through signaling (passcode + waiting room enforced there first).
- Test data isolation is achieved with `DATA_DIR`; set it to a temp directory in
  any environment that must not touch the production JSON files.
