import express from "express";
import { hiveIntegration } from "./hive-integration";
import http from "http";
import path from "path";
import fs from "fs";
import multer from "multer";
import { Server, Socket } from "socket.io";
import cors from "cors";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import * as db from "./db";
import { AccessToken } from "livekit-server-sdk";
import {
  OAuthConfigurationError,
  OAuthFlowError,
  createOAuthAuthorizationUrl,
  exchangeOAuthCodeForProfile,
  getOAuthProviderSummaries,
  isOAuthProviderId,
} from "./oauth";
import type { OAuthMode, OAuthProfile } from "./oauth";
import { initAuditLog, logAuditEvent, queryAuditLogs, getAuditStats } from "./audit";
import type { AuditEventType } from "./audit";

const PORT = Number(process.env.PORT || 5000);
const isProduction = process.env.NODE_ENV === "production";
const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || process.env.FRONTEND_URL || DEFAULT_ALLOWED_ORIGINS.join(","))
    .split(",")
    .map(origin => origin.trim())
    .filter(Boolean)
);

const AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || (isProduction ? "" : "dev-auth-secret-change-me");
const BILLING_WEBHOOK_SECRET = process.env.BILLING_WEBHOOK_SECRET || "";
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || (isProduction ? "" : "devkey");
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || (isProduction ? "" : "secret");
const LIVEKIT_WS_URL = process.env.LIVEKIT_WS_URL || (isProduction ? "" : "ws://localhost:7880");
const PUBLIC_FRONTEND_URL = process.env.PUBLIC_FRONTEND_URL || Array.from(allowedOrigins)[0] || "http://localhost:5173";
const PUBLIC_API_URL = process.env.PUBLIC_API_URL || `http://localhost:${PORT}`;

if (isProduction) {
  const missing = [
    !AUTH_TOKEN_SECRET && "AUTH_TOKEN_SECRET",
    !LIVEKIT_API_KEY && "LIVEKIT_API_KEY",
    !LIVEKIT_API_SECRET && "LIVEKIT_API_SECRET",
    !LIVEKIT_WS_URL && "LIVEKIT_WS_URL",
    !BILLING_WEBHOOK_SECRET && "BILLING_WEBHOOK_SECRET",
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(`Missing required production environment variables: ${missing.join(", ")}`);
  }
}

const app = express();
app.set("trust proxy", 1);

function isOriginAllowed(origin?: string) {
  return !origin || allowedOrigins.has(origin);
}

app.use(cookieParser());
app.use(cors({
  origin(origin, callback) {
    if (isOriginAllowed(origin)) {
      return callback(null, true);
    }
    console.warn(`Blocked CORS origin: ${origin}`);
    return callback(null, false);
  },
  credentials: true,
}));
app.use(express.json({ limit: "256kb", verify(req, _res, buffer) {
  (req as typeof req & { rawBody?: string }).rawBody = buffer.toString("utf8");
} }));
app.use("/api/integrations/hive", hiveIntegration());

// --- Cookie-based session token helpers ---
const COOKIE_NAME = "gubae_session";
const COOKIE_MAX_AGE = 60 * 60 * 12 * 1000; // 12 hours in ms

function isSameSiteStrict(): boolean {
  // In production behind Cloudflare, Lax is needed for OAuth redirects
  return !isProduction;
}

function setSessionCookie(res: express.Response, token: string) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "lax" : "strict",
    maxAge: COOKIE_MAX_AGE,
    path: "/",
  });
}

function clearSessionCookie(res: express.Response) {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

function getTokenFromRequest(req: express.Request): string | null {
  // 1. Check httpOnly cookie first
  const cookieToken = req.cookies?.[COOKIE_NAME];
  if (cookieToken && typeof cookieToken === "string") return cookieToken;
  // 2. Fall back to Authorization header (for API tests, scripts, mobile clients)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.split(" ")[1];
  }
  return null;
}

// File uploads
const UPLOADS_DIR = path.join(__dirname, "../data/uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
app.use("/uploads", express.static(UPLOADS_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || ".png";
      cb(null, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB max
  fileFilter: (_req, file, cb) => {
    const allowed = /^(image\/png|image\/jpeg|image\/webp|image\/gif|image\/svg\+xml|image\/x-icon|application\/octet-stream)$/;
    if (allowed.test(file.mimetype)) return cb(null, true);
    cb(new Error("Only image files (PNG, JPEG, WebP, GIF, SVG, ICO) are allowed."));
  },
});

// 1. Secure HTTP Headers Middleware
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self)");
  if (isProduction) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  const connectSrc = ["'self'", ...allowedOrigins, LIVEKIT_WS_URL]
    .filter(Boolean)
    .join(" ");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src ${connectSrc}; img-src 'self' data: blob: https:; media-src 'self' blob: data: https://assets.mixkit.co;`
  );
  next();
});

// 2. HTTP Memory Rate Limiter
const rateLimits = new Map<string, { count: number; resetTime: number }>();

function getClientIp(req: express.Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || req.socket.remoteAddress || "unknown";
}

function createRateLimiter(bucket: string, maxRequests: number, windowMs: number) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const ipKey = `${bucket}:${getClientIp(req)}`;
    const now = Date.now();
    const limit = rateLimits.get(ipKey);

    if (!limit) {
      rateLimits.set(ipKey, { count: 1, resetTime: now + windowMs });
      return next();
    }

    if (now > limit.resetTime) {
      limit.count = 1;
      limit.resetTime = now + windowMs;
      return next();
    }

    limit.count++;
    if (limit.count > maxRequests) {
      return res.status(429).json({ error: "Too many requests. Please try again later." });
    }
    next();
  };
}

// Limiters by tier
const authLimiter = createRateLimiter("auth", 15, 60 * 1000); // Max 15 auth requests/min
const adminLimiter = createRateLimiter("admin", 45, 60 * 1000); // Max 45 admin requests/min
const generalLimiter = createRateLimiter("general", 120, 60 * 1000); // Max 120 requests/min

app.use("/api/auth/", authLimiter);
app.use("/api/admin/", adminLimiter);
app.use(generalLimiter);

// 3. Small validation helpers
function sanitizeInput(value: unknown, maxLength = 200): string {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, maxLength);
}

function normalizeEmail(value: unknown): string {
  return sanitizeInput(value, 254).toLowerCase();
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isStrongEnoughPassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= 8 && value.length <= 128;
}

const ROOM_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/;

function normalizeRoomId(value: unknown): string | null {
  const roomId = sanitizeInput(value, 64).toLowerCase();
  return ROOM_ID_PATTERN.test(roomId) ? roomId : null;
}

function isSafeUrl(value: string): boolean {
  if (!value) return true;
  if (value.startsWith("/")) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || (!isProduction && parsed.protocol === "http:");
  } catch {
    return false;
  }
}

function defaultInviteLink(roomId: string): string {
  const url = new URL(PUBLIC_FRONTEND_URL);
  url.search = "";
  url.hash = "";
  url.searchParams.set("room", roomId);
  return url.toString();
}

function normalizeInviteLink(value: unknown, roomId: string): string {
  const fallback = defaultInviteLink(roomId);
  const raw = sanitizeInput(value, 600);
  if (!raw) return fallback;

  try {
    const frontendUrl = new URL(PUBLIC_FRONTEND_URL);
    const inviteUrl = new URL(raw, frontendUrl);
    const inviteRoomId = normalizeRoomId(inviteUrl.searchParams.get("room"));
    const allowedHash = /^#e2ee=[A-Za-z0-9_-]{32,128}$/;

    if (inviteUrl.origin !== frontendUrl.origin || inviteRoomId !== roomId) {
      return fallback;
    }
    if (inviteUrl.hash && !allowedHash.test(inviteUrl.hash)) {
      inviteUrl.hash = "";
    }
    return inviteUrl.toString();
  } catch {
    return fallback;
  }
}

function toBase64Url(value: Buffer | string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function fromBase64Url(value: string): Buffer {
  const padded = value + "=".repeat((4 - value.length % 4) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function signSessionToken(user: db.User): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = toBase64Url(JSON.stringify({
    sub: user.id,
    email: user.email,
    role: user.role || "user",
    iat: now,
    exp: now + 60 * 60 * 12,
  }));
  const signature = crypto.createHmac("sha256", AUTH_TOKEN_SECRET).update(payload).digest();
  return `${payload}.${toBase64Url(signature)}`;
}

function verifySessionToken(token: unknown): db.User | null {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;

  const expected = crypto.createHmac("sha256", AUTH_TOKEN_SECRET).update(payload).digest();
  const received = fromBase64Url(signature);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    return null;
  }

  try {
    const claims = JSON.parse(fromBase64Url(payload).toString("utf8")) as { sub?: string; exp?: number };
    if (!claims.sub || !claims.exp || claims.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return db.getUsers().find(u => u.id === claims.sub) || null;
  } catch {
    return null;
  }
}

function publicUser(user: db.User) {
  return { id: user.id, name: user.name, email: user.email, role: user.role || "user" };
}

type PublicUser = ReturnType<typeof publicUser>;

const oauthLoginResults = new Map<string, { token: string; user: PublicUser; expiresAt: number }>();
const OAUTH_RESULT_TTL_MS = 2 * 60 * 1000;

function cleanupOAuthLoginResults() {
  const now = Date.now();
  for (const [code, result] of oauthLoginResults.entries()) {
    if (result.expiresAt < now) {
      oauthLoginResults.delete(code);
    }
  }
}

function createOAuthLoginResult(token: string, user: PublicUser): string {
  cleanupOAuthLoginResults();
  const code = crypto.randomBytes(24).toString("base64url");
  oauthLoginResults.set(code, {
    token,
    user,
    expiresAt: Date.now() + OAUTH_RESULT_TTL_MS,
  });
  return code;
}

function frontendAuthRedirect(params: Record<string, string>): string {
  const redirectUrl = new URL(PUBLIC_FRONTEND_URL);
  redirectUrl.search = "";
  Object.entries(params).forEach(([key, value]) => {
    redirectUrl.searchParams.set(key, value);
  });
  return redirectUrl.toString();
}

function parseOAuthMode(value: unknown): OAuthMode {
  return value === "register" ? "register" : "login";
}

function createOrFindOAuthUser(profile: OAuthProfile): db.User {
  const email = normalizeEmail(profile.email);
  let user = db.findUserByEmail(email);
  if (!user) {
    user = db.createUser({
      name: sanitizeInput(profile.name, 80) || email.split("@")[0] || "User",
      email,
      authProvider: profile.provider,
    });
  }
  return user;
}

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", service: "zoom-clone-signaling" });
});

// File upload endpoint (admin only)
app.post("/api/admin/upload", authenticateAdmin, (req, res) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      console.error("Upload error:", err.message);
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    const url = `/uploads/${req.file.filename}`;
    console.log(`File uploaded: ${url}`);
    res.json({ url });
  });
});

// ================= AUTHENTICATION ENDPOINTS =================

// 1. Register Local User
app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: "Name, email, and password are required" });
    }

    const sanitizedName = sanitizeInput(name, 80);
    const sanitizedEmail = normalizeEmail(email);
    if (!sanitizedName || !isValidEmail(sanitizedEmail)) {
      return res.status(400).json({ error: "A valid name and email are required" });
    }
    if (!isStrongEnoughPassword(password)) {
      return res.status(400).json({ error: "Password must be between 8 and 128 characters" });
    }

    const existingUser = db.findUserByEmail(sanitizedEmail);
    if (existingUser) {
      return res.status(400).json({ error: "User already exists with this email" });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = db.createUser({
      name: sanitizedName,
      email: sanitizedEmail,
      passwordHash,
      authProvider: "local",
    });

    const token = signSessionToken(user);
    setSessionCookie(res, token);
    res.status(201).json({
      token,
      user: publicUser(user),
    });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 2. Login Local User
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const sanitizedEmail = normalizeEmail(email);
    if (!isValidEmail(sanitizedEmail)) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const user = db.findUserByEmail(sanitizedEmail);
    if (!user || user.authProvider !== "local" || !user.passwordHash) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = signSessionToken(user);
    setSessionCookie(res, token);
    res.json({
      token,
      user: publicUser(user),
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 3. OAuth/OIDC social login and SSO
app.get("/api/auth/oauth/providers", (_req, res) => {
  res.json({ providers: getOAuthProviderSummaries() });
});

app.get("/api/auth/oauth/:provider/start", (req, res) => {
  const providerParam = sanitizeInput(req.params.provider, 32);
  if (!isOAuthProviderId(providerParam)) {
    return res.status(404).json({ error: "Unsupported authentication provider" });
  }

  try {
    const authorizationUrl = createOAuthAuthorizationUrl(
      providerParam,
      parseOAuthMode(req.query.mode),
      PUBLIC_API_URL
    );
    res.json({ authorizationUrl });
  } catch (error) {
    if (error instanceof OAuthConfigurationError) {
      return res.status(501).json({ error: error.message });
    }
    console.error("OAuth start error:", error);
    res.status(500).json({ error: "Could not start social authentication" });
  }
});

app.get("/api/auth/oauth/:provider/callback", async (req, res) => {
  const providerParam = sanitizeInput(req.params.provider, 32);
  if (!isOAuthProviderId(providerParam)) {
    return res.redirect(frontendAuthRedirect({ auth_error: "Unsupported authentication provider" }));
  }

  const providerError = sanitizeInput(req.query.error_description || req.query.error, 200);
  if (providerError) {
    return res.redirect(frontendAuthRedirect({ auth_error: providerError }));
  }

  const code = sanitizeInput(req.query.code, 4096);
  const state = sanitizeInput(req.query.state, 512);
  if (!code || !state) {
    return res.redirect(frontendAuthRedirect({ auth_error: "Missing authentication callback data" }));
  }

  try {
    const profile = await exchangeOAuthCodeForProfile(providerParam, code, state, PUBLIC_API_URL);
    const user = createOrFindOAuthUser(profile);
    const token = signSessionToken(user);
    const resultCode = createOAuthLoginResult(token, publicUser(user));

    return res.redirect(frontendAuthRedirect({ auth_result: resultCode }));
  } catch (error) {
    const message = error instanceof OAuthConfigurationError || error instanceof OAuthFlowError
      ? error.message
      : "Social authentication failed";
    console.error("OAuth callback error:", error);
    return res.redirect(frontendAuthRedirect({ auth_error: sanitizeInput(message, 200) }));
  }
});

app.get("/api/auth/oauth/result", (req, res) => {
  cleanupOAuthLoginResults();
  const code = sanitizeInput(req.query.code, 128);
  const result = oauthLoginResults.get(code);
  if (!result || result.expiresAt < Date.now()) {
    oauthLoginResults.delete(code);
    return res.status(404).json({ error: "Authentication result expired. Please try again." });
  }

  oauthLoginResults.delete(code);
  setSessionCookie(res, result.token);
  res.json({ token: result.token, user: result.user });
});

// 4. Legacy demo social login for local prototypes only
app.post("/api/auth/social", async (req, res) => {
  try {
    if (isProduction && process.env.ALLOW_DEMO_SOCIAL_AUTH !== "true") {
      return res.status(501).json({ error: "Demo social authentication is disabled in production" });
    }

    const { name, email, provider } = req.body;
    if (!email || !provider || !name) {
      return res.status(400).json({ error: "Email, name, and provider are required" });
    }

    const allowedProviders = new Set(["google", "apple", "sso", "facebook", "microsoft"]);
    if (!allowedProviders.has(String(provider))) {
      return res.status(400).json({ error: "Unsupported authentication provider" });
    }

    const sanitizedName = sanitizeInput(name, 80);
    const sanitizedEmail = normalizeEmail(email);
    if (!sanitizedName || !isValidEmail(sanitizedEmail)) {
      return res.status(400).json({ error: "A valid name and email are required" });
    }

    let user = db.findUserByEmail(sanitizedEmail);
    if (!user) {
      user = db.createUser({
        name: sanitizedName,
        email: sanitizedEmail,
        authProvider: provider as any,
      });
    }

    const token = signSessionToken(user);
    setSessionCookie(res, token);
    res.json({
      token,
      user: publicUser(user),
    });
  } catch (error) {
    console.error("Social auth error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 5. Logout - clear session cookie
app.post("/api/auth/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ success: true, message: "Logged out successfully" });
});

// 6. Get registered users for authenticated in-app invitations
app.get("/api/users", authenticateUser, (req, res) => {
  try {
    const users = db.getUsers().map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
    }));
    res.json(users);
  } catch (error) {
    console.error("Get users error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ================= BILLING & SUBSCRIPTION ENDPOINTS =================

// Middleware to authenticate user from httpOnly cookie or Authorization header
function authenticateUser(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const user = verifySessionToken(token);
  if (!user) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
  (req as any).user = user;
  next();
}

// 1. Get Billing & Plan Status
app.get("/api/billing/status", authenticateUser, (req, res) => {
  const user = (req as any).user as db.User;
  res.json({
    subscription: user.subscription || {
      plan: "free",
      status: "active",
      expiryDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365 * 10).toISOString(),
    }
  });
});

// 2. Create Arifpay Checkout Session (Simulated Gateway)
app.post("/api/billing/checkout", authenticateUser, (req, res) => {
  try {
    const user = (req as any).user as db.User;
    const { plan } = req.body;
    if (!plan || !["pro", "business"].includes(plan)) {
      return res.status(400).json({ error: "Invalid plan type specified" });
    }

    const price = plan === "pro" ? 299 : 399; // Price in ETB
    const transactionId = "TX-" + Math.random().toString(36).substring(2, 10).toUpperCase();

    // Arifpay session payload model
    const arifpayPayload = {
      paymentInfo: {
        paymentType: "BILL_PAYMENT",
        amount: price,
        currency: "ETB",
        beneficiary: "Zoom Clone Co.",
        cancelUrl: `${PUBLIC_FRONTEND_URL}/billing?status=cancel`,
        successUrl: `${PUBLIC_FRONTEND_URL}/billing?status=success&tx=${transactionId}&plan=${plan}`,
        errorUrl: `${PUBLIC_FRONTEND_URL}/billing?status=error`,
        callbackUrl: `${PUBLIC_API_URL}/api/billing/webhook`,
      },
      beneficiaryAccount: {
        bankId: "CBE",
        accountNumber: "1000123456789",
      }
    };

    console.log("Creating Arifpay Payment Session with payload:", arifpayPayload);

    // Redirect pointing back to frontend checkout route
    const mockCheckoutUrl = `${PUBLIC_FRONTEND_URL}/billing?checkout=true&tx=${transactionId}&plan=${plan}&price=${price}&userId=${user.id}`;

    res.json({
      checkoutUrl: mockCheckoutUrl,
      transactionId,
      status: "CREATED",
    });
  } catch (error) {
    console.error("Billing checkout error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 3. Demo checkout confirmation for the in-app simulated payment flow
app.post("/api/billing/demo-confirm", authenticateUser, (req, res) => {
  try {
    const user = (req as any).user as db.User;
    const { plan, transactionId } = req.body;
    if (!["pro", "business"].includes(plan) || !transactionId) {
      return res.status(400).json({ error: "Invalid demo payment confirmation" });
    }

    const expiry = new Date();
    expiry.setMonth(expiry.getMonth() + 1);

    db.updateUserSubscription(user.id, {
      plan,
      status: "active",
      expiryDate: expiry.toISOString(),
      transactionId: sanitizeInput(transactionId, 64),
    });

    res.json({ success: true, message: "Subscription upgraded" });
  } catch (error) {
    console.error("Billing demo confirm error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 4. Webhook callback (server-to-server Arifpay callback notification)
app.post("/api/billing/webhook", (req, res) => {
  try {
    if (BILLING_WEBHOOK_SECRET && req.get("x-webhook-secret") !== BILLING_WEBHOOK_SECRET) {
      return res.status(401).json({ error: "Invalid webhook signature" });
    }

    const { userId, plan, transactionId, status } = req.body;
    if (!userId || !["pro", "business"].includes(plan) || !transactionId || status !== "SUCCESS") {
      return res.status(400).json({ error: "Missing or invalid webhook payload parameters" });
    }

    if (!db.getUsers().some(u => u.id === userId)) {
      return res.status(404).json({ error: "User not found" });
    }

    const expiry = new Date();
    expiry.setMonth(expiry.getMonth() + 1);

    db.updateUserSubscription(userId, {
      plan,
      status: "active",
      expiryDate: expiry.toISOString(),
      transactionId,
    });

    console.log(`Webhook upgraded user ${userId} to subscription tier: ${plan} successfully.`);
    res.json({ success: true, message: "Subscription upgraded" });
  } catch (error) {
    console.error("Billing webhook error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ================= SUPERADMINISTRATOR ADMIN ENDPOINTS =================

// Middleware to check if the authenticated user is a superadmin
function authenticateAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  authenticateUser(req, res, () => {
    const user = (req as any).user as db.User;
    if (user.role !== "superadmin") {
      return res.status(403).json({ error: "Access denied. Superadministrator access only." });
    }
    next();
  });
}

// 1. Get System Statistics
app.get("/api/admin/stats", authenticateAdmin, (req, res) => {
  try {
    const users = db.getUsers();
    const activeRoomsCount = rooms.size;

    // Calculate total transactions volume
    let totalRevenue = 0;
    users.forEach(u => {
      if (u.subscription && u.subscription.status === "active") {
        if (u.subscription.plan === "pro") totalRevenue += 299;
        if (u.subscription.plan === "business") totalRevenue += 399;
      }
    });

    res.json({
      totalUsers: users.length,
      activeRooms: activeRoomsCount,
      totalRevenue,
      gatewayStatus: "ONLINE"
    });
  } catch (error) {
    console.error("Admin stats error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 2. List All Users
app.get("/api/admin/users", authenticateAdmin, (req, res) => {
  try {
    const users = db.getUsers().map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
      authProvider: u.authProvider,
      role: u.role || "user",
      subscription: u.subscription || { plan: "free", status: "active", expiryDate: "" }
    }));
    res.json(users);
  } catch (error) {
    console.error("Admin list users error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 3. Update User Subscription Tier
app.put("/api/admin/users/:userId/subscription", authenticateAdmin, (req, res) => {
  try {
    const { userId } = req.params;
    const { plan } = req.body;
    if (!plan || !["free", "pro", "business"].includes(plan)) {
      return res.status(400).json({ error: "Invalid plan tier" });
    }

    const users = db.getUsers();
    const user = users.find(u => u.id === userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const expiry = new Date();
    expiry.setFullYear(expiry.getFullYear() + 1);

    db.updateUserSubscription(userId, {
      plan,
      status: "active",
      expiryDate: expiry.toISOString(),
      transactionId: "ADMIN-UPGRADE"
    });

    console.log(`Admin upgraded user ${userId} to plan: ${plan}`);
    res.json({ success: true, message: `User plan updated to ${plan}` });
  } catch (error) {
    console.error("Admin update subscription error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 4. Delete User
app.delete("/api/admin/users/:userId", authenticateAdmin, (req, res) => {
  try {
    const { userId } = req.params;
    const users = db.getUsers();
    const userExists = users.some(u => u.id === userId);
    if (!userExists) {
      return res.status(404).json({ error: "User not found" });
    }

    // Protect against self-deletion
    const requestUser = (req as any).user as db.User;
    if (requestUser.id === userId) {
      return res.status(400).json({ error: "Cannot delete your own superadministrator account." });
    }

    const updated = users.filter(u => u.id !== userId);
    db.saveUsers(updated);

    console.log(`Admin deleted user ${userId}`);
    res.json({ success: true, message: "User deleted successfully" });
  } catch (error) {
    console.error("Admin delete user error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 5. List Active Rooms
app.get("/api/admin/rooms", authenticateAdmin, (req, res) => {
  try {
    const activeRoomsList: any[] = [];
    rooms.forEach((membersSet, roomId) => {
      const hostUserId = roomHost.get(roomId);
      const hostUser = hostUserId ? db.getUsers().find(u => u.id === hostUserId) : null;
      const hostName = hostUser?.name || "Unknown Host";

      activeRoomsList.push({
        roomId,
        participantsCount: membersSet.size,
        hostName
      });
    });
    res.json(activeRoomsList);
  } catch (error) {
    console.error("Admin list rooms error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 6. Force Close/Terminate Meeting Room
app.delete("/api/admin/rooms/:roomId", authenticateAdmin, (req, res) => {
  try {
    const { roomId } = req.params;
    if (!rooms.has(roomId)) {
      return res.status(404).json({ error: "Meeting room is not active" });
    }

    console.log(`Admin forcing closure of room: ${roomId}`);

    // Broadcast expiration to all sockets in that room
    io.to(roomId).emit("meeting-expired");

    // Clean up room records
    rooms.delete(roomId);
    roomHost.delete(roomId);

    const timers = roomTimers.get(roomId);
    if (timers) {
      clearTimeout(timers.warningTimer);
      clearTimeout(timers.expiryTimer);
      roomTimers.delete(roomId);
    }

    res.json({ success: true, message: `Forced closure of room ${roomId} completed.` });
  } catch (error) {
    console.error("Admin force close room error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 7. Get Audit Logs (admin only)
app.get("/api/admin/audit-logs", authenticateAdmin, (req, res) => {
  try {
    const { roomId, userId, event, since, until, limit, offset } = req.query;
    const result = queryAuditLogs({
      roomId: typeof roomId === "string" ? roomId : undefined,
      userId: typeof userId === "string" ? userId : undefined,
      event: typeof event === "string" ? event as AuditEventType : undefined,
      since: typeof since === "string" ? parseInt(since, 10) : undefined,
      until: typeof until === "string" ? parseInt(until, 10) : undefined,
      limit: typeof limit === "string" ? parseInt(limit, 10) : 100,
      offset: typeof offset === "string" ? parseInt(offset, 10) : 0,
    });
    res.json(result);
  } catch (error) {
    console.error("Get audit logs error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 8. Get Audit Stats (admin only)
app.get("/api/admin/audit-stats", authenticateAdmin, (_req, res) => {
  try {
    const stats = getAuditStats();
    res.json({
      totalEvents: stats.totalEvents,
      eventsByType: stats.eventsByType,
      activeRooms: stats.activeRooms.size,
      uniqueUsers: stats.uniqueUsers.size,
    });
  } catch (error) {
    console.error("Get audit stats error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 9. Get Public System Settings policy
app.get("/api/settings", (req, res) => {
  try {
    const settings = db.getSystemSettings();
    res.json({
      freeLimitMinutes: settings.freeLimitMinutes,
      allowWhiteboard: settings.allowWhiteboard,
      allowRecording: settings.allowRecording,
      allowChat: settings.allowChat,
      brandLogoUrl: settings.brandLogoUrl,
      brandFaviconUrl: settings.brandFaviconUrl,
      brandTitle: settings.brandTitle,
      seoDescription: settings.seoDescription,
      seoKeywords: settings.seoKeywords,
      seoOgImage: settings.seoOgImage,
    });
  } catch (error) {
    console.error("Get settings error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get Public Translations
app.get("/api/translations", (req, res) => {
  try {
    const trans = db.getTranslations();
    res.json(trans);
  } catch (error) {
    console.error("Get translations error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get Admin Translations
app.get("/api/admin/translations", authenticateAdmin, (req, res) => {
  try {
    const trans = db.getTranslations();
    res.json(trans);
  } catch (error) {
    console.error("Get admin translations error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Update Admin Translations
app.put("/api/admin/translations", authenticateAdmin, (req, res) => {
  try {
    const trans = req.body;
    if (!trans || typeof trans !== "object") {
      return res.status(400).json({ error: "Invalid translations payload" });
    }
    db.saveTranslations(trans);
    res.json({ success: true, message: "Translations updated successfully" });
  } catch (error) {
    console.error("Update admin translations error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 8. Get Admin System Settings credentials
app.get("/api/admin/settings", authenticateAdmin, (req, res) => {
  try {
    const settings = db.getSystemSettings();
    res.json(settings);
  } catch (error) {
    console.error("Get admin settings error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 9. Update Admin System Settings credentials and toggles
app.put("/api/admin/settings", authenticateAdmin, (req, res) => {
  try {
    const body = req.body;

    if (body.freeLimitMinutes !== undefined && (typeof body.freeLimitMinutes !== "number" || body.freeLimitMinutes < 1)) {
      return res.status(400).json({ error: "Invalid freeLimitMinutes" });
    }

    const urlFields = { brandLogoUrl: body.brandLogoUrl, brandFaviconUrl: body.brandFaviconUrl, seoOgImage: body.seoOgImage };
    for (const [field, value] of Object.entries(urlFields)) {
      if (value !== undefined && !isSafeUrl(String(value))) {
        return res.status(400).json({ error: `Invalid ${field}` });
      }
    }

    const current = db.getSystemSettings();

    // Merge OAuth provider settings (Client ID + Secret)
    function mergeOAuthProvider(bodyVal: any, currentVal: any) {
      if (!bodyVal || typeof bodyVal !== "object") return currentVal;
      return {
        clientId: bodyVal.clientId !== undefined ? sanitizeInput(bodyVal.clientId) : (currentVal?.clientId || ""),
        clientSecret: bodyVal.clientSecret !== undefined ? sanitizeInput(bodyVal.clientSecret) : (currentVal?.clientSecret || ""),
      };
    }

    // Merge SSO settings
    function mergeSso(bodyVal: any, currentVal: any) {
      if (!bodyVal || typeof bodyVal !== "object") return currentVal;
      return {
        label: bodyVal.label !== undefined ? sanitizeInput(bodyVal.label) : (currentVal?.label || "SSO"),
        clientId: bodyVal.clientId !== undefined ? sanitizeInput(bodyVal.clientId) : (currentVal?.clientId || ""),
        clientSecret: bodyVal.clientSecret !== undefined ? sanitizeInput(bodyVal.clientSecret) : (currentVal?.clientSecret || ""),
        authorizationUrl: bodyVal.authorizationUrl !== undefined ? sanitizeInput(bodyVal.authorizationUrl) : (currentVal?.authorizationUrl || ""),
        tokenUrl: bodyVal.tokenUrl !== undefined ? sanitizeInput(bodyVal.tokenUrl) : (currentVal?.tokenUrl || ""),
        userinfoUrl: bodyVal.userinfoUrl !== undefined ? sanitizeInput(bodyVal.userinfoUrl) : (currentVal?.userinfoUrl || ""),
        jwksUrl: bodyVal.jwksUrl !== undefined ? sanitizeInput(bodyVal.jwksUrl) : (currentVal?.jwksUrl || ""),
        issuer: bodyVal.issuer !== undefined ? sanitizeInput(bodyVal.issuer) : (currentVal?.issuer || ""),
        pkce: bodyVal.pkce !== undefined ? bodyVal.pkce : (currentVal?.pkce ?? true),
      };
    }

    const updated: db.SystemSettings = {
      arifpayApiKey: body.arifpayApiKey !== undefined ? sanitizeInput(body.arifpayApiKey) : current.arifpayApiKey,
      arifpayMerchantId: body.arifpayMerchantId !== undefined ? sanitizeInput(body.arifpayMerchantId) : current.arifpayMerchantId,
      arifpaySandboxMode: body.arifpaySandboxMode !== undefined ? body.arifpaySandboxMode : current.arifpaySandboxMode,
      freeLimitMinutes: body.freeLimitMinutes !== undefined ? body.freeLimitMinutes : current.freeLimitMinutes,
      allowWhiteboard: body.allowWhiteboard !== undefined ? body.allowWhiteboard : current.allowWhiteboard,
      allowRecording: body.allowRecording !== undefined ? body.allowRecording : current.allowRecording,
      allowChat: body.allowChat !== undefined ? body.allowChat : current.allowChat,
      brandLogoUrl: body.brandLogoUrl !== undefined ? sanitizeInput(body.brandLogoUrl) : current.brandLogoUrl,
      brandFaviconUrl: body.brandFaviconUrl !== undefined ? sanitizeInput(body.brandFaviconUrl) : current.brandFaviconUrl,
      brandTitle: body.brandTitle !== undefined ? sanitizeInput(body.brandTitle) : current.brandTitle,
      seoDescription: body.seoDescription !== undefined ? sanitizeInput(body.seoDescription) : current.seoDescription,
      seoKeywords: body.seoKeywords !== undefined ? sanitizeInput(body.seoKeywords) : current.seoKeywords,
      seoOgImage: body.seoOgImage !== undefined ? sanitizeInput(body.seoOgImage) : current.seoOgImage,
      oauthGoogle: mergeOAuthProvider(body.oauthGoogle, current.oauthGoogle),
      oauthMicrosoft: mergeOAuthProvider(body.oauthMicrosoft, current.oauthMicrosoft),
      oauthFacebook: mergeOAuthProvider(body.oauthFacebook, current.oauthFacebook),
      oauthApple: mergeOAuthProvider(body.oauthApple, current.oauthApple),
      sso: mergeSso(body.sso, current.sso),
    };

    db.saveSystemSettings(updated);
    console.log("Admin updated system settings successfully.");
    res.json({ success: true, settings: updated });
  } catch (error) {
    console.error("Update admin settings error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 10. Update User Role (Promotions / Demotions)
app.put("/api/admin/users/:userId/role", authenticateAdmin, (req, res) => {
  try {
    const { userId } = req.params;
    const { role } = req.body;
    if (!role || !["superadmin", "user"].includes(role)) {
      return res.status(400).json({ error: "Invalid role specified" });
    }

    const users = db.getUsers();
    const user = users.find(u => u.id === userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Self demotion protection check
    const requestUser = (req as any).user as db.User;
    if (requestUser.id === userId && role !== "superadmin") {
      return res.status(400).json({ error: "You cannot demote yourself from superadministrator status." });
    }

    db.updateUserRole(userId, role);
    console.log(`Admin updated user ${userId} role to: ${role}`);
    res.json({ success: true, message: `User role updated to ${role}` });
  } catch (error) {
    console.error("Admin update user role error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ================= SCHEDULED MEETINGS CRUD ENDPOINTS =================

// 1. Get Scheduled Meetings
app.get("/api/meetings", authenticateUser, (req, res) => {
  try {
    const user = (req as any).user as db.User;
    const meetings = db.getScheduledMeetings();
    const userMeetings = meetings.filter(m => m.userId === user.id);
    res.json(userMeetings);
  } catch (error) {
    console.error("Get meetings error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 2. Create Scheduled Meeting
app.post("/api/meetings", authenticateUser, (req, res) => {
  try {
    const user = (req as any).user as db.User;
    const { topic, startTime, duration, passcode } = req.body;
    if (!topic || !startTime || !duration) {
      return res.status(400).json({ error: "Topic, start time, and duration are required" });
    }

    const normalizedTopic = sanitizeInput(topic, 120);
    const parsedStart = new Date(startTime);
    const parsedDuration = Number.parseInt(String(duration), 10);
    if (!normalizedTopic || Number.isNaN(parsedStart.getTime())) {
      return res.status(400).json({ error: "Invalid meeting topic or start time" });
    }
    if (!Number.isInteger(parsedDuration) || parsedDuration < 5 || parsedDuration > 240) {
      return res.status(400).json({ error: "Duration must be between 5 and 240 minutes" });
    }

    const meetings = db.getScheduledMeetings();
    const newMeeting: db.ScheduledMeeting = {
      id: crypto.randomBytes(6).toString("hex"),
      userId: user.id,
      topic: normalizedTopic,
      startTime: parsedStart.toISOString(),
      duration: parsedDuration,
      passcode: sanitizeInput(passcode, 32),
    };

    meetings.push(newMeeting);
    db.saveScheduledMeetings(meetings);

    console.log(`User ${user.id} scheduled meeting: ${topic}`);
    res.status(201).json(newMeeting);
  } catch (error) {
    console.error("Create meeting error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 3. Delete Scheduled Meeting
app.delete("/api/meetings/:id", authenticateUser, (req, res) => {
  try {
    const user = (req as any).user as db.User;
    const { id } = req.params;

    const meetings = db.getScheduledMeetings();
    const meeting = meetings.find(m => m.id === id);
    if (!meeting) {
      return res.status(404).json({ error: "Meeting not found" });
    }
    if (meeting.userId !== user.id && user.role !== "superadmin") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const filtered = meetings.filter(m => m.id !== id);
    db.saveScheduledMeetings(filtered);

    console.log(`Meeting deleted: ${id}`);
    res.json({ success: true, message: "Meeting deleted successfully" });
  } catch (error) {
    console.error("Delete meeting error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 4. LiveKit Token Generation Endpoint
app.get("/api/livekit/token", authenticateUser, async (req, res) => {
  try {
    const user = (req as any).user as db.User;
    const { roomId } = req.query;

    const normalizedRoomId = normalizeRoomId(roomId);
    if (!normalizedRoomId) {
      return res.status(400).json({ error: "A valid room ID is required" });
    }

    // Zoom-style gate: media tokens are only issued after the user has joined the
    // meeting through the signaling layer, where passcodes and the waiting room
    // are enforced. This prevents direct media joins that bypass security checks.
    const socketId = userToSocket.get(user.id);
    const joinedRoomId = socketId ? socketToRoom.get(socketId) : undefined;
    if (!joinedRoomId || joinedRoomId !== normalizedRoomId) {
      return res.status(403).json({ error: "Join the meeting room in the app before starting media." });
    }

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: user.id,
      name: user.name,
    });

    at.addGrant({
      roomJoin: true,
      room: normalizedRoomId,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const token = await at.toJwt();
    res.json({ token, url: LIVEKIT_WS_URL, roomId: normalizedRoomId });
  } catch (error) {
    console.error("LiveKit token generation error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      if (isOriginAllowed(origin)) {
        return callback(null, true);
      }
      console.warn(`Blocked socket origin: ${origin}`);
      return callback(null, false);
    },
    credentials: true,
    methods: ["GET", "POST"],
  },
  maxHttpBufferSize: 2 * 1024 * 1024,
});

// Map to track room membership: roomId -> Set of socketIds (userIds)
const rooms = new Map<string, Set<string>>();

// Map to track which room a socket is in: socketId -> roomId
const socketToRoom = new Map<string, string>();

// Map to track the host of each room: roomId -> userId (host)
const roomHost = new Map<string, string>();

// Map to track the timers of Free meetings: roomId -> warning & expiry timers
const roomTimers = new Map<string, { warningTimer: NodeJS.Timeout; expiryTimer: NodeJS.Timeout }>();

// Map to track user names: socketId -> userName
const socketToName = new Map<string, string>();

// Map to track user to socket mappings: userId -> socketId
const userToSocket = new Map<string, string>();
// Reverse map: socketId -> userId
const socketToUser = new Map<string, string>();

// Map to track waiting-room participants: roomId -> socketId -> { userId, userName }
const waitingRooms = new Map<string, Map<string, { userId: string; userName: string }>>();

type SocketAck = (response: { ok: boolean; message: string }) => void;

// Socket message rate limiter tracking
const socketLimits = new Map<string, { lastEmits: number[] }>();

function checkSocketRateLimit(socketId: string, limitPerSecond: number = 5): boolean {
  const now = Date.now();
  let record = socketLimits.get(socketId);
  if (!record) {
    record = { lastEmits: [] };
    socketLimits.set(socketId, record);
  }
  // Filter out emits older than 1 second
  record.lastEmits = record.lastEmits.filter(t => now - t < 1000);
  if (record.lastEmits.length >= limitPerSecond) {
    return false; // Rate limited!
  }
  record.lastEmits.push(now);
  return true;
}

function getSocketUser(socket: Socket): db.User | null {
  return (socket.data?.user as db.User | undefined) || null;
}

function getAuthorizedRoom(socket: Socket, requestedRoomId: unknown): string | null {
  const normalizedRoomId = normalizeRoomId(requestedRoomId);
  const joinedRoomId = socketToRoom.get(socket.id);
  if (!normalizedRoomId || !joinedRoomId || normalizedRoomId !== joinedRoomId) {
    socket.emit("socket-error", { message: "Join the meeting room before sending room events." });
    return null;
  }
  return normalizedRoomId;
}

function clearRoomTimers(roomId: string) {
  const timers = roomTimers.get(roomId);
  if (timers) {
    clearTimeout(timers.warningTimer);
    clearTimeout(timers.expiryTimer);
    roomTimers.delete(roomId);
  }
}

function leaveCurrentRoom(socket: Socket, notify = true, reason: "room_left" | "room_disconnected" = "room_left") {
  removeSocketFromWaitingRoom(socket);
  const roomId = socketToRoom.get(socket.id);
  if (!roomId) return;

  // Audit: Log leave event
  const userId = socketToUser.get(socket.id);
  const userName = socketToName.get(socket.id) || "Unknown";
  if (userId) {
    logAuditEvent(reason, userId, userName, roomId);
  }

  const room = rooms.get(roomId);
  if (room) {
    room.delete(socket.id);
    if (room.size === 0) {
      rooms.delete(roomId);
      roomHost.delete(roomId);
      clearRoomTimers(roomId);
      console.log(`Cleared active billing timers for empty room ${roomId}`);
      // No host remains: let the first waiting participant in so nobody is stranded
      admitNextWaiter(roomId);
    } else {
      if (notify) {
        const leavingUserId = socketToUser.get(socket.id);
        socket.to(roomId).emit("user-disconnected", { userId: leavingUserId || socket.id });
      }

      const leavingUserId = socketToUser.get(socket.id);
      if (leavingUserId && roomHost.get(roomId) === leavingUserId) {
        const nextHostSocketId = Array.from(room)[0];
        const nextHostUserId = socketToUser.get(nextHostSocketId);
        if (nextHostUserId) {
          roomHost.set(roomId, nextHostUserId);
          io.to(roomId).emit("host-changed", { hostId: nextHostUserId });
          console.log(`Migrated host of room ${roomId} to ${nextHostUserId}`);
        }
      }
    }
  }

  socketToRoom.delete(socket.id);
  socket.leave(roomId);
}

// ================= WAITING ROOM & PASSCODE HELPERS =================

// Returns the passcode of a scheduled meeting for this room ID ("" if none is set)
function getMeetingPasscode(roomId: string): string {
  const meetings = db.getScheduledMeetings();
  const meeting = meetings.find(m => m.id === roomId);
  return meeting?.passcode ? sanitizeInput(meeting.passcode, 32) : "";
}

function passcodesMatch(provided: string, stored: string): boolean {
  if (!stored) return true;
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(stored).digest();
  return crypto.timingSafeEqual(a, b);
}

// Adds a socket as a full member of a room (host assignment, timers, broadcasts)
function addSocketToRoom(socket: Socket, roomId: string, userName: string) {
  const user = getSocketUser(socket);
  if (!user) return;

  // Audit: Log join event
  logAuditEvent("room_joined", user.id, userName, roomId, {
    isHost: !roomHost.has(roomId),
  });

  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  }
  rooms.get(roomId)!.add(socket.id);
  socketToRoom.set(socket.id, roomId);
  socketToName.set(socket.id, userName);

  // Join the Socket.io room channel
  socket.join(roomId);

  // Assign host if the room doesn't have one
  if (!roomHost.has(roomId)) {
    roomHost.set(roomId, user.id);
    console.log(`Assigned host of room ${roomId} to ${user.id}`);

    // Start subscription limit timer if host is Free tier
    const hostPlan = user.subscription?.plan || "free";

    const isTestExpire = roomId.includes("test-expire");
    if (hostPlan === "free" || isTestExpire) {
      const settings = db.getSystemSettings();
      const freeLimitMin = settings.freeLimitMinutes || 40;

      console.log(`Free meeting detected for room ${roomId}. Starting ${freeLimitMin}-minute limit timers.`);
      const expiryMs = isTestExpire ? 60000 : freeLimitMin * 60 * 1000;
      const warningRemaining = isTestExpire ? 30 : Math.min(300, Math.max(30, Math.floor(expiryMs / 2000)));
      const warningMs = Math.max(0, expiryMs - warningRemaining * 1000);

      const warningTimer = setTimeout(() => {
        console.log(`Sending warning notification to free meeting room ${roomId}.`);
        io.to(roomId).emit("meeting-warning", { timeRemaining: warningRemaining });
      }, warningMs);

      const expiryTimer = setTimeout(() => {
        console.log(`Free meeting room ${roomId} expired. Terminating session.`);
        io.to(roomId).emit("meeting-expired");
        roomTimers.delete(roomId);
      }, expiryMs);

      roomTimers.set(roomId, { warningTimer, expiryTimer });
    }
  }

  // Send the current host information to the room, plus the meeting passcode
  // so in-meeting invite links can embed it (the joiner already proved it)
  io.to(roomId).emit("host-changed", { hostId: roomHost.get(roomId) });
  socket.emit("room-joined", { roomId, hostId: roomHost.get(roomId), passcode: getMeetingPasscode(roomId) });

  // Get list of all other users already in this room with their names
  const otherUsers = Array.from(rooms.get(roomId)!)
    .filter(id => id !== socket.id)
    .map(id => ({
      id: socketToUser.get(id) || id,
      name: socketToName.get(id) || "Guest",
    }));

  // Send the list of existing users to the newly joined user
  socket.emit("all-users", otherUsers);

  // Broadcast to other users in the room that a new user has joined
  socket.to(roomId).emit("user-joined", {
    userId: user.id,
    userName,
  });
}

// Parks a socket in the waiting room and notifies the host
function placeSocketInWaitingRoom(socket: Socket, roomId: string, userName: string) {
  const user = getSocketUser(socket);
  if (!user) return;

  if (!waitingRooms.has(roomId)) {
    waitingRooms.set(roomId, new Map());
  }
  waitingRooms.get(roomId)!.set(socket.id, { userId: user.id, userName });
  console.log(`User ${socket.id} (${userName}) placed in waiting room for ${roomId}`);

  socket.emit("waiting-room", {
    roomId,
    message: "You are in the waiting room. The host will let you in shortly.",
  });
  socket.to(roomId).emit("join-request", {
    socketId: socket.id,
    userId: user.id,
    userName,
  });
}

// Removes a socket from any waiting room. Returns the roomId it was waiting in, if any.
function removeSocketFromWaitingRoom(socket: Socket): string | undefined {
  for (const [roomId, waiters] of waitingRooms.entries()) {
    if (waiters.delete(socket.id)) {
      if (waiters.size === 0) {
        waitingRooms.delete(roomId);
      }
      return roomId;
    }
  }
  return undefined;
}

// Admits the first waiting participant when a room loses its last member
function admitNextWaiter(roomId: string) {
  const waiters = waitingRooms.get(roomId);
  if (!waiters || waiters.size === 0) return;

  const [socketId, info] = waiters.entries().next().value as [string, { userId: string; userName: string }];
  waiters.delete(socketId);
  if (waiters.size === 0) waitingRooms.delete(roomId);

  const waiterSocket = io.sockets.sockets.get(socketId);
  if (!waiterSocket) return;
  console.log(`Automatically admitting waiting user ${info.userId} to empty room ${roomId}`);
  addSocketToRoom(waiterSocket, roomId, info.userName);
}

function sanitizeAttachment(fileAttachment: any) {
  if (!fileAttachment || typeof fileAttachment !== "object") return undefined;
  const dataUrl = typeof fileAttachment.dataUrl === "string" ? fileAttachment.dataUrl : "";
  const allowedDataUrl = /^data:(image\/png|image\/jpeg|image\/webp|image\/gif|application\/pdf|text\/plain);base64,[a-zA-Z0-9+/=\r\n]+$/;
  if (!allowedDataUrl.test(dataUrl) || Buffer.byteLength(dataUrl, "utf8") > 2 * 1024 * 1024) {
    return null;
  }
  return {
    name: sanitizeInput(fileAttachment.name, 120) || "attachment",
    size: sanitizeInput(fileAttachment.size, 32),
    dataUrl,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

io.use((socket, next) => {
  // 1. Try auth.token from handshake (legacy / mobile clients)
  let token = socket.handshake.auth?.token;

  // 2. Fall back to httpOnly cookie from handshake headers
  if (!token) {
    const cookieHeader = socket.handshake.headers?.cookie || "";
    const cookies = cookieHeader.split(";").map(c => c.trim());
    for (const c of cookies) {
      const [name, ...rest] = c.split("=");
      if (name === COOKIE_NAME) {
        token = rest.join("=");
        break;
      }
    }
  }

  const user = verifySessionToken(token);
  if (!user) {
    return next(new Error("Unauthorized socket connection"));
  }
  socket.data.user = user;
  next();
});

io.on("connection", (socket: Socket) => {
  const authenticatedUser = getSocketUser(socket);
  if (!authenticatedUser) {
    socket.disconnect(true);
    return;
  }

  userToSocket.set(authenticatedUser.id, socket.id);
  socketToUser.set(socket.id, authenticatedUser.id);
  socketToName.set(socket.id, authenticatedUser.name);
  console.log(`User connected: ${socket.id} (${authenticatedUser.id})`);

  // Register User mapping
  socket.on("register-user", (payload: { userName?: string }) => {
    const user = getSocketUser(socket);
    if (!user) return;
    const displayName = sanitizeInput(payload?.userName, 80) || user.name;
    console.log(`Registering socket ${socket.id} to user ${user.id} (${displayName})`);
    userToSocket.set(user.id, socket.id);
    socketToUser.set(socket.id, user.id);
    socketToName.set(socket.id, displayName);
  });

  // Relay summon invitation
  socket.on("summon-user", (payload: { targetUserId: string; roomId: string; hostName: string; inviteLink?: string }, respond?: SocketAck) => {
    const roomId = getAuthorizedRoom(socket, payload?.roomId);
    if (!roomId) {
      respond?.({ ok: false, message: "The meeting is still connecting. Please try again in a moment." });
      return;
    }

    const sender = getSocketUser(socket);
    if (!sender) {
      respond?.({ ok: false, message: "Your session expired. Please sign in again." });
      return;
    }

    const targetUserId = sanitizeInput(payload?.targetUserId, 80);
    if (!targetUserId || targetUserId === sender.id) {
      respond?.({ ok: false, message: "Select another registered user to invite." });
      return;
    }

    const targetUser = db.getUsers().find(user => user.id === targetUserId);
    if (!targetUser) {
      respond?.({ ok: false, message: "That registered user no longer exists." });
      return;
    }

    const targetSocketId = userToSocket.get(targetUserId);
    const hostName = socketToName.get(socket.id) || getSocketUser(socket)?.name || "Meeting host";
    console.log(`Summon user ${targetUserId} (socket: ${targetSocketId}) to room ${roomId} by ${hostName}`);

    if (!targetSocketId || !io.sockets.sockets.has(targetSocketId)) {
      if (targetSocketId) {
        userToSocket.delete(targetUserId);
      }
      respond?.({ ok: false, message: `${targetUser.name} is registered but not online right now. Copy the invite link instead.` });
      return;
    }

    io.to(targetSocketId).emit("summon-received", {
      roomId,
      hostName,
      inviteLink: normalizeInviteLink(payload?.inviteLink, roomId),
    });
    respond?.({ ok: true, message: `Invitation sent to ${targetUser.name}.` });
  });

  // 1. Join Room Handler
  socket.on("join-room", (payload: { roomId: string; userName: string; passcode?: string }) => {
    const user = getSocketUser(socket);
    const roomId = normalizeRoomId(payload?.roomId);
    const userName = sanitizeInput(payload?.userName, 80) || user?.name || "Guest";
    if (!user || !roomId) {
      socket.emit("join-room-error", { message: "A valid room ID is required." });
      return;
    }

    // Re-joining a room you are already in: treat as already admitted
    if (socketToRoom.get(socket.id) === roomId) {
      socket.emit("room-joined", { roomId, hostId: roomHost.get(roomId), passcode: getMeetingPasscode(roomId) });
      return;
    }

    // Enforce the scheduled meeting passcode (if one is set)
    const storedPasscode = getMeetingPasscode(roomId);
    const providedPasscode = sanitizeInput(payload?.passcode, 32);
    if (storedPasscode && !passcodesMatch(providedPasscode, storedPasscode)) {
      socket.emit("join-room-error", {
        message: "This meeting requires a passcode. Check your invitation link or ask the host for the passcode.",
      });
      return;
    }

    const previousRoomId = socketToRoom.get(socket.id);
    if (previousRoomId && previousRoomId !== roomId) {
      leaveCurrentRoom(socket);
    }

    console.log(`User ${socket.id} (${userName}) joining room: ${roomId}`);

    // Zoom-style waiting room: if a host is already present, the joiner waits for admission
    if (roomHost.has(roomId) && rooms.get(roomId)?.size) {
      placeSocketInWaitingRoom(socket, roomId, userName);
      return;
    }

    addSocketToRoom(socket, roomId, userName);
  });

  // Admit a waiting participant (host only)
  socket.on("admit-user", (payload: { roomId: string; targetUserId: string }) => {
    const roomId = getAuthorizedRoom(socket, payload?.roomId);
    if (!roomId) return;
    const user = getSocketUser(socket);
    if (!user || roomHost.get(roomId) !== user.id) return;

    const targetUserId = sanitizeInput(payload?.targetUserId, 80);
    const waiters = waitingRooms.get(roomId);
    if (!waiters) return;

    let admittedSocketId: string | undefined;
    let admittedName = "Guest";
    for (const [socketId, info] of waiters.entries()) {
      if (info.userId === targetUserId) {
        admittedSocketId = socketId;
        admittedName = info.userName;
        break;
      }
    }
    if (!admittedSocketId) return;

    waiters.delete(admittedSocketId);
    if (waiters.size === 0) waitingRooms.delete(roomId);

    const admittedSocket = io.sockets.sockets.get(admittedSocketId);
    if (!admittedSocket) return;

    console.log(`Host ${user.id} admitted ${targetUserId} to room ${roomId}`);
    io.to(roomId).emit("join-request-cancelled", { socketId: admittedSocketId });
    addSocketToRoom(admittedSocket, roomId, admittedName);
  });

  // Deny a waiting participant (host only)
  socket.on("deny-user", (payload: { roomId: string; targetUserId: string }) => {
    const roomId = getAuthorizedRoom(socket, payload?.roomId);
    if (!roomId) return;
    const user = getSocketUser(socket);
    if (!user || roomHost.get(roomId) !== user.id) return;

    const targetUserId = sanitizeInput(payload?.targetUserId, 80);
    const waiters = waitingRooms.get(roomId);
    if (!waiters) return;

    let deniedSocketId: string | undefined;
    for (const [socketId, info] of waiters.entries()) {
      if (info.userId === targetUserId) {
        deniedSocketId = socketId;
        break;
      }
    }
    if (!deniedSocketId) return;

    waiters.delete(deniedSocketId);
    if (waiters.size === 0) waitingRooms.delete(roomId);

    const deniedSocket = io.sockets.sockets.get(deniedSocketId);
    if (!deniedSocket) return;

    console.log(`Host ${user.id} denied ${targetUserId} entry to room ${roomId}`);
    io.to(roomId).emit("join-request-cancelled", { socketId: deniedSocketId });
    deniedSocket.emit("join-denied", { message: "The host did not let you into the meeting." });
  });

  // Relay chat message
  socket.on("send-chat-message", (payload: { roomId: string; text: string; senderName: string; fileAttachment?: any }) => {
    const roomId = getAuthorizedRoom(socket, payload?.roomId);
    if (!roomId) return;
    const user = getSocketUser(socket);
    if (!user) return;

    // Socket Rate Limiting Check (limit to 5 messages per second)
    if (!checkSocketRateLimit(socket.id, 5)) {
      socket.emit("chat-message-received", {
        senderId: "system",
        senderName: "System Warning",
        text: "⚠️ WARNING: You are sending chat messages too fast. Please slow down.",
        timestamp: Date.now(),
      });
      return;
    }

    const sanitizedText = sanitizeInput(payload?.text, 1000);
    const sanitizedSender = socketToName.get(socket.id) || user.name;

    // Sanitize file attachment metadata if any
    let sanitizedAttachment = undefined;
    if (payload?.fileAttachment) {
      const checkedAttachment = sanitizeAttachment(payload.fileAttachment);
      if (!checkedAttachment) {
        socket.emit("chat-message-received", {
          senderId: "system",
          senderName: "System Warning",
          text: "Attachment rejected. Files must be safe image, PDF, or text files under 2 MB.",
          timestamp: Date.now(),
        });
        return;
      }
      sanitizedAttachment = checkedAttachment;
    }

    if (!sanitizedText && !sanitizedAttachment) {
      return;
    }

    io.to(roomId).emit("chat-message-received", {
      senderId: user.id,
      senderName: sanitizedSender,
      text: sanitizedText,
      timestamp: Date.now(),
      fileAttachment: sanitizedAttachment,
    });

    // Audit: Log chat message
    logAuditEvent("chat_message", user.id, sanitizedSender, roomId, {
      hasAttachment: !!sanitizedAttachment,
      textLength: sanitizedText.length,
    });
  });

  // Relay a private message (DM) to a single participant in the same room
  socket.on("send-private-message", (payload: { roomId: string; targetUserId: string; text: string }) => {
    const roomId = getAuthorizedRoom(socket, payload?.roomId);
    if (!roomId) return;
    const user = getSocketUser(socket);
    if (!user) return;

    if (!checkSocketRateLimit(socket.id, 5)) {
      socket.emit("socket-error", { message: "You are sending private messages too fast. Please slow down." });
      return;
    }

    const targetUserId = sanitizeInput(payload?.targetUserId, 80);
    if (!targetUserId || targetUserId === user.id) return;

    const targetSocketId = userToSocket.get(targetUserId);
    if (!targetSocketId || !rooms.get(roomId)?.has(targetSocketId)) {
      socket.emit("socket-error", { message: "That participant is no longer in the meeting." });
      return;
    }

    const sanitizedText = sanitizeInput(payload?.text, 1000);
    if (!sanitizedText) return;

    const senderName = socketToName.get(socket.id) || user.name;
    const timestamp = Date.now();

    io.to(targetSocketId).emit("private-message-received", {
      senderId: user.id,
      senderName,
      text: sanitizedText,
      timestamp,
      private: true,
    });
    // Echo to the sender so their own sent DMs appear instantly
    socket.emit("private-message-received", {
      senderId: user.id,
      senderName,
      text: sanitizedText,
      timestamp,
      private: true,
      isSelf: true,
    });

    // Audit: Log private message
    logAuditEvent("private_message", user.id, senderName, roomId, {
      targetUserId,
      textLength: sanitizedText.length,
    });
  });

  // Relay live captions
  socket.on("send-caption", (payload: { roomId: string; text: string; senderName: string }) => {
    const roomId = getAuthorizedRoom(socket, payload?.roomId);
    if (!roomId) return;

    // Socket Rate Limiting Check (limit to 6 captions updates per second)
    if (!checkSocketRateLimit(socket.id, 6)) {
      return; // Silently drop spam captions
    }

    socket.to(roomId).emit("caption-received", {
      senderId: getSocketUser(socket)?.id || socket.id,
      senderName: socketToName.get(socket.id) || getSocketUser(socket)?.name || "Guest",
      text: sanitizeInput(payload?.text, 500),
    });
  });

  // Relay raise hand state
  socket.on("raise-hand-toggle", (payload: { roomId: string; raised: boolean }) => {
    const roomId = getAuthorizedRoom(socket, payload?.roomId);
    if (!roomId) return;
    socket.to(roomId).emit("user-hand-toggled", {
      userId: getSocketUser(socket)?.id || socket.id,
      raised: Boolean(payload?.raised),
    });
  });

  // Relay emoji reaction
  socket.on("send-emoji-reaction", (payload: { roomId: string; emoji: string }) => {
    const roomId = getAuthorizedRoom(socket, payload?.roomId);
    if (!roomId) return;

    // Socket Rate Limiting Check (limit to 4 emojis per second)
    if (!checkSocketRateLimit(socket.id, 4)) {
      return; // Drop emoji spam
    }

    io.to(roomId).emit("emoji-reaction-received", {
      userId: getSocketUser(socket)?.id || socket.id,
      emoji: sanitizeInput(payload?.emoji, 16),
    });
  });

  // Host: Mute All Audio
  socket.on("host-mute-all", (payload: { roomId: string }) => {
    const roomId = getAuthorizedRoom(socket, payload?.roomId);
    if (!roomId) return;
    if (roomHost.get(roomId) === getSocketUser(socket)?.id) {
      socket.to(roomId).emit("mute-all-received");
    }
  });

  // Host: Kick Participant
  socket.on("host-kick-user", (payload: { roomId: string; targetUserId: string }) => {
    const roomId = getAuthorizedRoom(socket, payload?.roomId);
    if (!roomId) return;
    const targetUserId = sanitizeInput(payload?.targetUserId, 80);
    const targetSocketId = userToSocket.get(targetUserId);
    if (targetSocketId && roomHost.get(roomId) === getSocketUser(socket)?.id && rooms.get(roomId)?.has(targetSocketId)) {
      io.to(targetSocketId).emit("kicked-received");
    }
  });

  // Relay media track statuses (mic/camera on or off)
  socket.on("update-media-status", (payload: { roomId: string; videoEnabled: boolean; audioEnabled: boolean }) => {
    const roomId = getAuthorizedRoom(socket, payload?.roomId);
    if (!roomId) return;
    socket.to(roomId).emit("user-media-status-updated", {
      userId: getSocketUser(socket)?.id || socket.id,
      videoEnabled: Boolean(payload?.videoEnabled),
      audioEnabled: Boolean(payload?.audioEnabled),
    });
  });

  // Relay whiteboard toggling (open/close)
  socket.on("toggle-whiteboard", (payload: { roomId: string; open: boolean }) => {
    const roomId = getAuthorizedRoom(socket, payload?.roomId);
    if (!roomId) return;
    io.to(roomId).emit("whiteboard-toggled", { open: Boolean(payload?.open) });
  });

  // Relay whiteboard drawing lines
  socket.on("draw-line", (payload: { roomId: string; x0: number; y0: number; x1: number; y1: number; color: string; width: number }) => {
    const roomId = getAuthorizedRoom(socket, payload?.roomId);
    if (!roomId) return;
    const { x0, y0, x1, y1, width } = payload || {};
    const color = sanitizeInput(payload?.color, 24);
    const validPoint = [x0, y0, x1, y1].every(value => isFiniteNumber(value) && value >= 0 && value <= 1);
    if (!validPoint || !isFiniteNumber(width) || width < 1 || width > 32 || !/^#[0-9a-f]{6}$/i.test(color)) {
      return;
    }
    socket.to(roomId).emit("draw-line-received", { roomId, x0, y0, x1, y1, color, width });
  });

  // Relay whiteboard clearing
  socket.on("clear-whiteboard", (payload: { roomId: string }) => {
    const roomId = getAuthorizedRoom(socket, payload?.roomId);
    if (!roomId) return;
    io.to(roomId).emit("clear-whiteboard-received");
  });

  // Relay recording state toggling
  socket.on("toggle-recording", (payload: { roomId: string; recording: boolean }) => {
    const roomId = getAuthorizedRoom(socket, payload?.roomId);
    if (!roomId) return;
    if (roomHost.get(roomId) !== getSocketUser(socket)?.id) return;
    io.to(roomId).emit("recording-toggled", { recording: Boolean(payload?.recording) });
  });

  // Relay video filters between participants
  socket.on("update-video-filter", (payload: { roomId: string; filterClass: string }) => {
    const roomId = getAuthorizedRoom(socket, payload?.roomId);
    if (!roomId) return;
    const filterClass = sanitizeInput(payload?.filterClass, 32);
    socket.to(roomId).emit("user-filter-updated", {
      userId: getSocketUser(socket)?.id || socket.id,
      filterClass,
    });
  });

  // Host: Lower Participant Hand
  socket.on("host-lower-hand", (payload: { roomId: string; targetUserId: string }) => {
    const roomId = getAuthorizedRoom(socket, payload?.roomId);
    if (!roomId) return;
    const targetUserId = sanitizeInput(payload?.targetUserId, 80);
    const targetSocketId = userToSocket.get(targetUserId);
    if (targetSocketId && roomHost.get(roomId) === getSocketUser(socket)?.id && rooms.get(roomId)?.has(targetSocketId)) {
      io.to(targetSocketId).emit("lower-hand-received");
    }
  });

  // 2. Relay WebRTC Offer
  socket.on("send-offer", (payload: { target: string; caller: string; sdp: any }) => {
    const roomId = socketToRoom.get(socket.id);
    const targetSocketId = userToSocket.get(sanitizeInput(payload?.target, 80)) || sanitizeInput(payload?.target, 80);
    if (!roomId || !rooms.get(roomId)?.has(targetSocketId)) return;
    console.log(`Relaying offer from ${socket.id} to ${targetSocketId}`);
    io.to(targetSocketId).emit("offer-received", {
      sdp: payload.sdp,
      caller: getSocketUser(socket)?.id || socket.id,
    });
  });

  // 3. Relay WebRTC Answer
  socket.on("send-answer", (payload: { target: string; caller: string; sdp: any }) => {
    const roomId = socketToRoom.get(socket.id);
    const targetSocketId = userToSocket.get(sanitizeInput(payload?.target, 80)) || sanitizeInput(payload?.target, 80);
    if (!roomId || !rooms.get(roomId)?.has(targetSocketId)) return;
    console.log(`Relaying answer from ${socket.id} to ${targetSocketId}`);
    io.to(targetSocketId).emit("answer-received", {
      sdp: payload.sdp,
      caller: getSocketUser(socket)?.id || socket.id,
    });
  });

  // 4. Relay ICE Candidates
  socket.on("send-ice-candidate", (payload: { target: string; sender: string; candidate: any }) => {
    const roomId = socketToRoom.get(socket.id);
    const targetSocketId = userToSocket.get(sanitizeInput(payload?.target, 80)) || sanitizeInput(payload?.target, 80);
    if (!roomId || !rooms.get(roomId)?.has(targetSocketId)) return;
    console.log(`Relaying ICE candidate from ${socket.id} to ${targetSocketId}`);
    io.to(targetSocketId).emit("ice-candidate-received", {
      candidate: payload.candidate,
      sender: getSocketUser(socket)?.id || socket.id,
    });
  });

  // 4.5 User leaving the room manually
  socket.on("leave-room", () => {
    console.log(`User left room manually: ${socket.id}`);
    const waitingRoomId = removeSocketFromWaitingRoom(socket);
    if (waitingRoomId) {
      io.to(waitingRoomId).emit("join-request-cancelled", { socketId: socket.id });
    }
    leaveCurrentRoom(socket);
  });

  // 5. User Disconnecting
  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`);
    socketLimits.delete(socket.id);
    const waitingRoomId = removeSocketFromWaitingRoom(socket);
    if (waitingRoomId) {
      io.to(waitingRoomId).emit("join-request-cancelled", { socketId: socket.id });
    }
    leaveCurrentRoom(socket, true, "room_disconnected");
    socketToName.delete(socket.id);

    const userId = socketToUser.get(socket.id);
    if (userId) {
      userToSocket.delete(userId);
      socketToUser.delete(socket.id);
    }
  });
});

// Initialize audit logging
initAuditLog();

// Start listening only when run directly (tests import this module in-process
// and bind their own ephemeral port)
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Signaling server running on port ${PORT} - v1.1.0-prod`);
  });
}

export { server, io, signSessionToken };
