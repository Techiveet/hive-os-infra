import crypto from "crypto";
import { getOAuthDbCredentials, getSsoDbSettings } from "./db";

export type OAuthProviderId = "google" | "microsoft" | "facebook" | "apple" | "sso";
export type OAuthMode = "login" | "register";

export interface OAuthProviderSummary {
  id: OAuthProviderId;
  label: string;
  enabled: boolean;
}

export interface OAuthProfile {
  provider: OAuthProviderId;
  providerUserId: string;
  email: string;
  name: string;
  emailVerified?: boolean;
}

interface OAuthProviderConfig {
  id: OAuthProviderId;
  label: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl?: string;
  jwksUrl?: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  issuers?: string[];
  usesPkce: boolean;
  usesNonce: boolean;
  extraAuthParams?: Record<string, string>;
}

interface PendingOAuthState {
  provider: OAuthProviderId;
  mode: OAuthMode;
  codeVerifier: string;
  nonce: string;
  expiresAt: number;
}

type JwksKey = Record<string, unknown> & { kid?: string; alg?: string; use?: string };

export class OAuthConfigurationError extends Error {}
export class OAuthFlowError extends Error {}

const PROVIDER_IDS: OAuthProviderId[] = ["sso", "google", "microsoft", "facebook", "apple"];
const pendingStates = new Map<string, PendingOAuthState>();
const jwksCache = new Map<string, { keys: JwksKey[]; expiresAt: number }>();
const STATE_TTL_MS = 10 * 60 * 1000;
const JWKS_TTL_MS = 60 * 60 * 1000;

export function isOAuthProviderId(value: string): value is OAuthProviderId {
  return PROVIDER_IDS.includes(value as OAuthProviderId);
}

export function getOAuthProviderSummaries(): OAuthProviderSummary[] {
  return PROVIDER_IDS.map(id => {
    const config = getProviderConfig(id);
    return {
      id,
      label: config?.label || getDefaultProviderLabel(id),
      enabled: Boolean(config),
    };
  });
}

export function createOAuthAuthorizationUrl(
  providerId: OAuthProviderId,
  mode: OAuthMode,
  callbackBaseUrl: string
): string {
  cleanupExpiredStates();

  const config = requireProviderConfig(providerId);
  const state = randomBase64Url(32);
  const codeVerifier = randomBase64Url(48);
  const nonce = randomBase64Url(24);
  const redirectUri = getRedirectUri(callbackBaseUrl, providerId);

  pendingStates.set(state, {
    provider: providerId,
    mode,
    codeVerifier,
    nonce,
    expiresAt: Date.now() + STATE_TTL_MS,
  });

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: config.scopes.join(" "),
    state,
  });

  if (config.usesPkce) {
    params.set("code_challenge", base64UrlSha256(codeVerifier));
    params.set("code_challenge_method", "S256");
  }

  if (config.usesNonce) {
    params.set("nonce", nonce);
  }

  Object.entries(config.extraAuthParams || {}).forEach(([key, value]) => {
    params.set(key, value);
  });

  return `${config.authorizationUrl}?${params.toString()}`;
}

export async function exchangeOAuthCodeForProfile(
  providerId: OAuthProviderId,
  code: string,
  state: string,
  callbackBaseUrl: string
): Promise<OAuthProfile> {
  const pending = pendingStates.get(state);
  pendingStates.delete(state);

  if (!pending || pending.provider !== providerId || pending.expiresAt < Date.now()) {
    throw new OAuthFlowError("The sign-in request expired. Please try again.");
  }

  const config = requireProviderConfig(providerId);
  const redirectUri = getRedirectUri(callbackBaseUrl, providerId);
  const tokenPayload = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  if (config.usesPkce) {
    tokenPayload.set("code_verifier", pending.codeVerifier);
  }

  // Facebook's token endpoint expects a GET with the parameters in the query
  // string; the other providers use a standard form-encoded POST.
  const isFacebook = providerId === "facebook";
  const tokenUrl = isFacebook ? `${config.tokenUrl}?${tokenPayload.toString()}` : config.tokenUrl;
  const tokenResponse = await fetchJson(tokenUrl, {
    method: isFacebook ? "GET" : "POST",
    headers: isFacebook
      ? { Accept: "application/json" }
      : { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: isFacebook ? undefined : tokenPayload.toString(),
  });

  const accessToken = getString(tokenResponse.access_token);
  const idToken = getString(tokenResponse.id_token);
  const idTokenClaims = idToken ? await verifyAndDecodeIdToken(idToken, config) : {};

  validateIdTokenClaims(idTokenClaims, config, pending.nonce);

  let userInfo: Record<string, unknown> = {};
  if (config.userInfoUrl && accessToken) {
    userInfo = await fetchJson(config.userInfoUrl, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    });
  }

  return normalizeProfile(config, userInfo, idTokenClaims);
}

function getProviderConfig(id: OAuthProviderId): OAuthProviderConfig | null {
  switch (id) {
    case "google": {
      const googleCreds = getOAuthDbCredentials("google");
      return buildConfig({
        id,
        label: "Google",
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
        jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
        clientId: googleCreds.clientId || env("AUTH_GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_ID"),
        clientSecret: googleCreds.clientSecret || env("AUTH_GOOGLE_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET"),
        scopes: envList("AUTH_GOOGLE_SCOPES", ["openid", "email", "profile"]),
        issuers: ["https://accounts.google.com", "accounts.google.com"],
        usesPkce: true,
        usesNonce: true,
        extraAuthParams: { prompt: "select_account" },
      });
    }
    case "microsoft": {
      const tenant = env("AUTH_MICROSOFT_TENANT", "MICROSOFT_TENANT") || "common";
      const msCreds = getOAuthDbCredentials("microsoft");
      return buildConfig({
        id,
        label: "Microsoft",
        authorizationUrl: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`,
        tokenUrl: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
        userInfoUrl: "https://graph.microsoft.com/oidc/userinfo",
        jwksUrl: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/discovery/v2.0/keys`,
        clientId: msCreds.clientId || env("AUTH_MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_ID"),
        clientSecret: msCreds.clientSecret || env("AUTH_MICROSOFT_CLIENT_SECRET", "MICROSOFT_CLIENT_SECRET"),
        scopes: envList("AUTH_MICROSOFT_SCOPES", ["openid", "email", "profile"]),
        usesPkce: true,
        usesNonce: true,
        extraAuthParams: { prompt: "select_account" },
      });
    }
    case "facebook": {
      const fbCreds = getOAuthDbCredentials("facebook");
      return buildConfig({
        id,
        label: "Facebook",
        authorizationUrl: "https://www.facebook.com/v20.0/dialog/oauth",
        tokenUrl: "https://graph.facebook.com/v20.0/oauth/access_token",
        userInfoUrl: "https://graph.facebook.com/v20.0/me?fields=id,name,email",
        clientId: fbCreds.clientId || env("AUTH_FACEBOOK_CLIENT_ID", "FACEBOOK_CLIENT_ID"),
        clientSecret: fbCreds.clientSecret || env("AUTH_FACEBOOK_CLIENT_SECRET", "FACEBOOK_CLIENT_SECRET"),
        scopes: envList("AUTH_FACEBOOK_SCOPES", ["email", "public_profile"]),
        usesPkce: false,
        usesNonce: false,
      });
    }
    case "apple": {
      const appleCreds = getOAuthDbCredentials("apple");
      return buildConfig({
        id,
        label: "Apple",
        authorizationUrl: "https://appleid.apple.com/auth/authorize",
        tokenUrl: "https://appleid.apple.com/auth/token",
        jwksUrl: "https://appleid.apple.com/auth/keys",
        clientId: appleCreds.clientId || env("AUTH_APPLE_CLIENT_ID", "APPLE_CLIENT_ID"),
        clientSecret: appleCreds.clientSecret || resolveAppleClientSecret(),
        scopes: envList("AUTH_APPLE_SCOPES", ["name", "email"]),
        issuers: ["https://appleid.apple.com"],
        usesPkce: true,
        usesNonce: true,
        extraAuthParams: { response_mode: "query" },
      });
    }
    case "sso": {
      const ssoSettings = getSsoDbSettings();
      return buildConfig({
        id,
        label: ssoSettings.label || "SSO",
        authorizationUrl: ssoSettings.authorizationUrl,
        tokenUrl: ssoSettings.tokenUrl,
        userInfoUrl: ssoSettings.userinfoUrl,
        jwksUrl: ssoSettings.jwksUrl,
        clientId: ssoSettings.clientId,
        clientSecret: ssoSettings.clientSecret,
        scopes: envList("AUTH_SSO_SCOPES", ["openid", "email", "profile"]),
        issuers: ssoSettings.issuer ? [ssoSettings.issuer] : undefined,
        usesPkce: ssoSettings.pkce,
        usesNonce: true,
      });
    }
  }
}

function requireProviderConfig(id: OAuthProviderId): OAuthProviderConfig {
  const config = getProviderConfig(id);
  if (!config) {
    throw new OAuthConfigurationError(`${getDefaultProviderLabel(id)} sign-in is not configured.`);
  }
  return config;
}

function buildConfig(config: OAuthProviderConfig): OAuthProviderConfig | null {
  if (!config.clientId || !config.clientSecret || !config.authorizationUrl || !config.tokenUrl) {
    return null;
  }
  return config;
}

// Apple requires client_secret to be a short-lived ES256 JWT signed with a key
// generated in the Apple Developer portal. Operators can either supply a
// pre-generated JWT via AUTH_APPLE_CLIENT_SECRET, or provide the raw pieces
// (AUTH_APPLE_PRIVATE_KEY + AUTH_APPLE_KEY_ID + AUTH_APPLE_TEAM_ID) and let the
// server mint a fresh client secret on every authorization attempt. Apple caps
// these JWTs at 180 days, so generating them on demand keeps Apple sign-in alive.
function resolveAppleClientSecret(): string {
  const preset = env("AUTH_APPLE_CLIENT_SECRET", "APPLE_CLIENT_SECRET");
  if (preset) return preset;

  const privateKeyPem = env("AUTH_APPLE_PRIVATE_KEY", "APPLE_PRIVATE_KEY");
  const keyId = env("AUTH_APPLE_KEY_ID", "APPLE_KEY_ID");
  const teamId = env("AUTH_APPLE_TEAM_ID", "APPLE_TEAM_ID");
  const clientId = env("AUTH_APPLE_CLIENT_ID", "APPLE_CLIENT_ID");
  if (!privateKeyPem || !keyId || !teamId || !clientId) return "";

  try {
    const header = toBase64Url(JSON.stringify({ alg: "ES256", kid: keyId }));
    const now = Math.floor(Date.now() / 1000);
    const payload = toBase64Url(JSON.stringify({
      iss: teamId,
      iat: now,
      exp: now + 180 * 24 * 60 * 60,
      aud: "https://appleid.apple.com",
      sub: clientId,
    }));
    const privateKey = crypto.createPrivateKey(privateKeyPem);
    const signature = crypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    });
    return `${header}.${payload}.${toBase64Url(signature)}`;
  } catch (error) {
    console.warn("Could not generate Apple client secret:", error);
    return "";
  }
}

function toBase64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

async function fetchJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  const text = await response.text();
  const json = text ? JSON.parse(text) as Record<string, unknown> : {};

  if (!response.ok) {
    const message = getString(json.error_description) || getString(json.error) || "OAuth provider request failed.";
    throw new OAuthFlowError(message);
  }

  return json;
}

function normalizeProfile(
  config: OAuthProviderConfig,
  userInfo: Record<string, unknown>,
  idTokenClaims: Record<string, unknown>
): OAuthProfile {
  const providerUserId = firstString(userInfo.sub, userInfo.id, idTokenClaims.sub);
  const rawEmail = firstString(userInfo.email, userInfo.preferred_username, idTokenClaims.email, idTokenClaims.preferred_username);
  const email = rawEmail ? rawEmail.trim().toLowerCase() : "";
  const name = firstString(userInfo.name, idTokenClaims.name, email.split("@")[0]) || `${config.label} User`;
  const emailVerified = parseBoolean(userInfo.email_verified ?? idTokenClaims.email_verified);

  if (!providerUserId || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new OAuthFlowError(`${config.label} did not return a usable email address.`);
  }

  if (emailVerified === false) {
    throw new OAuthFlowError(`${config.label} email address is not verified.`);
  }

  return {
    provider: config.id,
    providerUserId,
    email,
    name: sanitizeDisplayText(name, 80),
    emailVerified,
  };
}

function validateIdTokenClaims(
  claims: Record<string, unknown>,
  config: OAuthProviderConfig,
  nonce: string
) {
  if (Object.keys(claims).length === 0) return;

  const exp = typeof claims.exp === "number" ? claims.exp : undefined;
  if (exp && exp < Math.floor(Date.now() / 1000)) {
    throw new OAuthFlowError("The provider identity token expired.");
  }

  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (aud.some(Boolean) && !aud.includes(config.clientId)) {
    throw new OAuthFlowError("The provider identity token audience is invalid.");
  }

  const issuer = getString(claims.iss);
  if (issuer && config.issuers && !config.issuers.includes(issuer)) {
    throw new OAuthFlowError("The provider identity token issuer is invalid.");
  }

  if (config.usesNonce && getString(claims.nonce) !== nonce) {
    throw new OAuthFlowError("The provider identity token nonce is invalid.");
  }
}

async function verifyAndDecodeIdToken(jwt: string, config: OAuthProviderConfig): Promise<Record<string, unknown>> {
  const [encodedHeader, encodedPayload, encodedSignature] = jwt.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new OAuthFlowError("The provider identity token is malformed.");
  }

  const header = decodeBase64UrlJson(encodedHeader) as { alg?: string; kid?: string };
  const alg = getString(header.alg);
  const kid = getString(header.kid);
  if (!alg || alg === "none" || !kid) {
    throw new OAuthFlowError("The provider identity token header is invalid.");
  }
  if (!config.jwksUrl) {
    throw new OAuthConfigurationError(`${config.label} JWKS URL is required for secure sign-in.`);
  }

  const keys = await fetchJwks(config.jwksUrl);
  const jwk = keys.find(key => key.kid === kid && (!key.use || key.use === "sig"));
  if (!jwk) {
    throw new OAuthFlowError("The provider identity token signing key was not found.");
  }
  if (jwk.alg && jwk.alg !== alg) {
    throw new OAuthFlowError("The provider identity token algorithm does not match its signing key.");
  }

  const publicKey = crypto.createPublicKey({ key: jwk as any, format: "jwk" });
  const signingInput = Buffer.from(`${encodedHeader}.${encodedPayload}`);
  const signature = fromBase64Url(encodedSignature);
  const verified = verifyJwtSignature(alg, signingInput, publicKey, signature);
  if (!verified) {
    throw new OAuthFlowError("The provider identity token signature is invalid.");
  }

  return decodeBase64UrlJson(encodedPayload);
}

async function fetchJwks(jwksUrl: string): Promise<JwksKey[]> {
  const cached = jwksCache.get(jwksUrl);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.keys;
  }

  const response = await fetchJson(jwksUrl, {
    headers: { Accept: "application/json" },
  });
  const keys = Array.isArray(response.keys)
    ? response.keys.filter((key): key is JwksKey => typeof key === "object" && key !== null)
    : [];

  if (keys.length === 0) {
    throw new OAuthFlowError("The provider JWKS endpoint did not return signing keys.");
  }

  jwksCache.set(jwksUrl, { keys, expiresAt: Date.now() + JWKS_TTL_MS });
  return keys;
}

function verifyJwtSignature(
  alg: string,
  signingInput: Buffer,
  publicKey: crypto.KeyObject,
  signature: Buffer
): boolean {
  switch (alg) {
    case "RS256":
      return crypto.verify("RSA-SHA256", signingInput, publicKey, signature);
    case "RS384":
      return crypto.verify("RSA-SHA384", signingInput, publicKey, signature);
    case "RS512":
      return crypto.verify("RSA-SHA512", signingInput, publicKey, signature);
    default:
      throw new OAuthFlowError(`Unsupported identity token signing algorithm: ${alg}`);
  }
}

function decodeBase64UrlJson(value: string): Record<string, unknown> {
  return JSON.parse(fromBase64Url(value).toString("utf8")) as Record<string, unknown>;
}

function fromBase64Url(value: string): Buffer {
  const padded = value + "=".repeat((4 - value.length % 4) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function getRedirectUri(callbackBaseUrl: string, providerId: OAuthProviderId): string {
  return `${callbackBaseUrl.replace(/\/$/, "")}/api/auth/oauth/${providerId}/callback`;
}

function cleanupExpiredStates() {
  const now = Date.now();
  for (const [state, pending] of pendingStates.entries()) {
    if (pending.expiresAt < now) {
      pendingStates.delete(state);
    }
  }
}

function env(...keys: string[]): string {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return "";
}

function envList(key: string, fallback: string[]): string[] {
  return process.env[key]?.split(/[,\s]+/).map(scope => scope.trim()).filter(Boolean) || fallback;
}

function randomBase64Url(bytes: number): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

function base64UrlSha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const stringValue = getString(value);
    if (stringValue) return stringValue;
  }
  return undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return undefined;
}

function sanitizeDisplayText(value: string, maxLength: number): string {
  return value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, maxLength);
}

function getDefaultProviderLabel(id: OAuthProviderId): string {
  switch (id) {
    case "google":
      return "Google";
    case "microsoft":
      return "Microsoft";
    case "facebook":
      return "Facebook";
    case "apple":
      return "Apple";
    case "sso":
      return "SSO";
  }
}
