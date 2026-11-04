// End-to-end test of the OAuth/OIDC sign-in pipeline using the configurable
// SSO provider pointed at a mock identity provider. Exercises the real flow:
// providers -> start (PKCE/nonce) -> authorize redirect -> callback -> token
// exchange (code_verifier + client credentials) -> JWKS signature verification
// -> userinfo -> auth_result exchange -> working session token.
//
// Run with: npm test

"use strict";

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

// ---------------------------------------------------------------------------
// Isolated environment — MUST be set before importing the server modules.
// PUBLIC_API_URL is read at import time, so the backend binds a fixed port.
// ---------------------------------------------------------------------------
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "zoom-clone-oauth-test-"));
process.env.DATA_DIR = DATA_DIR;
process.env.AUTH_TOKEN_SECRET = "oauth-test-secret";
process.env.PORT = "5197";
process.env.PUBLIC_API_URL = "http://127.0.0.1:5197";
process.env.PUBLIC_FRONTEND_URL = "http://localhost:5173";

const { server, io } = require("../dist/server");
const db = require("../dist/db");

const FRONTEND = "http://localhost:5173";
const PORT = 5197;

// ---------------------------------------------------------------------------
// Mock OIDC provider (RS256 JWKS + signed ID tokens)
// ---------------------------------------------------------------------------
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: "jwk" });
const KID = "mock-key-1";
let issuedNonce = "";
let lastTokenRequest = null;

const b64url = value => Buffer.from(value).toString("base64url");

function signIdToken(claims) {
  const header = b64url(JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const signature = crypto.sign("sha256", Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${b64url(signature)}`;
}

let mockIdp;
let mockIssuer;
let mockPort;

function startMockIdp() {
  return new Promise((resolve, reject) => {
    const idp = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${mockPort}`);
      const send = (status, headers, body) => {
        res.writeHead(status, headers);
        res.end(body);
      };

      if (url.pathname === "/authorize") {
        issuedNonce = url.searchParams.get("nonce") || "";
        const redirectUri = url.searchParams.get("redirect_uri");
        const state = url.searchParams.get("state");
        // Simulate the user approving: bounce straight back to the app
        send(302, { Location: `${redirectUri}?code=mock-auth-code&state=${encodeURIComponent(state)}` }, "");
        return;
      }

      if (url.pathname === "/token") {
        let body = "";
        req.on("data", chunk => (body += chunk));
        req.on("end", () => {
          lastTokenRequest = Object.fromEntries(new URLSearchParams(body));
          const now = Math.floor(Date.now() / 1000);
          const idToken = signIdToken({
            iss: mockIssuer,
            sub: "sso-user-123",
            aud: "test-client",
            exp: now + 3600,
            iat: now,
            nonce: issuedNonce,
            email: "sso.user@example.com",
            email_verified: true,
            name: "SSO User",
          });
          send(200, { "Content-Type": "application/json" }, JSON.stringify({
            access_token: "mock-access-token",
            token_type: "Bearer",
            expires_in: 3600,
            id_token: idToken,
          }));
        });
        return;
      }

      if (url.pathname === "/userinfo") {
        send(200, { "Content-Type": "application/json" }, JSON.stringify({
          sub: "sso-user-123",
          email: "sso.user@example.com",
          email_verified: true,
          name: "SSO User",
        }));
        return;
      }

      if (url.pathname === "/jwks") {
        send(200, { "Content-Type": "application/json" }, JSON.stringify({
          keys: [{ kty: "RSA", kid: KID, use: "sig", alg: "RS256", n: publicJwk.n, e: publicJwk.e }],
        }));
        return;
      }

      send(404, {}, "not found");
    });

    idp.on("error", reject);
    idp.listen(0, "127.0.0.1", () => {
      mockPort = idp.address().port;
      resolve(idp);
    });
  });
}

before(async () => {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, "127.0.0.1", resolve);
  });
  mockIdp = await startMockIdp();
  mockIssuer = `http://127.0.0.1:${mockPort}`;

  // Provider configuration is read from env on every request
  process.env.AUTH_SSO_CLIENT_ID = "test-client";
  process.env.AUTH_SSO_CLIENT_SECRET = "test-secret";
  process.env.AUTH_SSO_AUTHORIZATION_URL = `${mockIssuer}/authorize`;
  process.env.AUTH_SSO_TOKEN_URL = `${mockIssuer}/token`;
  process.env.AUTH_SSO_USERINFO_URL = `${mockIssuer}/userinfo`;
  process.env.AUTH_SSO_JWKS_URL = `${mockIssuer}/jwks`;
  process.env.AUTH_SSO_ISSUER = mockIssuer;
  process.env.AUTH_SSO_LABEL = "MockSSO";
});

after(async () => {
  mockIdp.close();
  await new Promise(resolve => io.close(resolve));
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  db.saveUsers([]);
  db.saveScheduledMeetings([]);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function startSso(mode = "login") {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/auth/oauth/sso/start?mode=${mode}`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(typeof data.authorizationUrl, "string");
  return new URL(data.authorizationUrl);
}

// Simulate the IdP authorization step: bounce back to the app's callback URL
async function followAuthorize(authUrl) {
  const authorizeRes = await fetch(authUrl.toString(), { redirect: "manual" });
  assert.equal(authorizeRes.status, 302);
  return authorizeRes.headers.get("location");
}

async function runFullLoginFlow(mode = "login") {
  const authUrl = await startSso(mode);

  // The authorization URL must carry PKCE, a nonce, and the registered redirect URI
  assert.equal(authUrl.searchParams.get("client_id"), "test-client");
  assert.equal(authUrl.searchParams.get("response_type"), "code");
  assert.ok(authUrl.searchParams.get("code_challenge"), "PKCE code_challenge missing");
  assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authUrl.searchParams.get("nonce"), "nonce missing");
  const redirectUri = authUrl.searchParams.get("redirect_uri");
  assert.equal(redirectUri, `http://127.0.0.1:${PORT}/api/auth/oauth/sso/callback`);

  // Follow the mock IdP authorization step
  const callbackUrl = await followAuthorize(authUrl);
  assert.ok(callbackUrl.startsWith(redirectUri), `callback went to ${callbackUrl}`);

  // Hit the backend callback exactly as the IdP redirect would
  const callbackRes = await fetch(callbackUrl, { redirect: "manual" });
  assert.equal(callbackRes.status, 302);
  const frontendLocation = new URL(callbackRes.headers.get("location"));
  assert.equal(frontendLocation.origin, FRONTEND);
  const resultCode = frontendLocation.searchParams.get("auth_result");
  assert.ok(resultCode, "callback did not issue an auth_result code");

  // Exchange the one-time result code for the session
  const resultRes = await fetch(`http://127.0.0.1:${PORT}/api/auth/oauth/result?code=${encodeURIComponent(resultCode)}`);
  assert.equal(resultRes.status, 200);
  const result = await resultRes.json();
  assert.equal(typeof result.token, "string");
  assert.equal(result.user.email, "sso.user@example.com");
  assert.equal(result.user.name, "SSO User");

  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("SSO: full OIDC login flow works end-to-end (PKCE, nonce, JWKS)", async () => {
  const { token, user } = await runFullLoginFlow("login");

  // The issued session token actually authenticates against protected endpoints
  const usersRes = await fetch(`http://127.0.0.1:${PORT}/api/users`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(usersRes.status, 200);

  // The token exchange carried client credentials + PKCE to the IdP
  assert.equal(lastTokenRequest.grant_type, "authorization_code");
  assert.equal(lastTokenRequest.client_id, "test-client");
  assert.equal(lastTokenRequest.client_secret, "test-secret");
  assert.equal(lastTokenRequest.redirect_uri, `http://127.0.0.1:${PORT}/api/auth/oauth/sso/callback`);
  assert.ok(lastTokenRequest.code_verifier, "PKCE code_verifier missing from token request");

  // The user was persisted through the OAuth provider path
  const stored = db.getUsers().find(u => u.email === "sso.user@example.com");
  assert.ok(stored, "OAuth user was not persisted");
  assert.equal(stored.authProvider, "sso");
  assert.equal(stored.id, user.id);
});

test("SSO: providers endpoint reports enabled/disabled correctly", async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/auth/oauth/providers`);
  assert.equal(res.status, 200);
  const { providers } = await res.json();

  const sso = providers.find(p => p.id === "sso");
  assert.equal(sso.enabled, true);
  assert.equal(sso.label, "MockSSO");

  // Unconfigured providers stay disabled (buttons show the "not configured" state)
  const google = providers.find(p => p.id === "google");
  assert.equal(google.enabled, false);
});

test("SSO: auth_result codes are single-use", async () => {
  const authUrl = await startSso("login");
  const callbackUrl = await followAuthorize(authUrl);
  const callbackRes = await fetch(callbackUrl, { redirect: "manual" });
  const resultCode = new URL(callbackRes.headers.get("location")).searchParams.get("auth_result");

  const first = await fetch(`http://127.0.0.1:${PORT}/api/auth/oauth/result?code=${encodeURIComponent(resultCode)}`);
  assert.equal(first.status, 200);
  const second = await fetch(`http://127.0.0.1:${PORT}/api/auth/oauth/result?code=${encodeURIComponent(resultCode)}`);
  assert.equal(second.status, 404);
});

test("SSO: forged state is rejected with an auth_error redirect", async () => {
  const redirectUri = `http://127.0.0.1:${PORT}/api/auth/oauth/sso/callback`;
  const res = await fetch(`${redirectUri}?code=mock-auth-code&state=forged-state`, { redirect: "manual" });
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get("location"));
  assert.equal(location.origin, FRONTEND);
  assert.ok(location.searchParams.get("auth_error"), "expected an auth_error redirect");
});
