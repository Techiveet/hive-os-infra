#!/usr/bin/env node
//
// prewarm-backend.mjs — warms the Laravel/Octane backend so that the first
// authenticated API call after a container start does not pay for cold workers.
//
// Why this exists: Octane boots the application once per worker process, on the
// first request that worker handles — routes, config, service providers, DB and
// Redis connections, and the PHP opcache entries for every file that request
// touches. Measured on this stack (see scripts/measure-backend-warmup.sh), that
// first request costs ~1.3s against ~0.015-0.02s once the worker is warm, and it
// is paid per worker. The pool is auto-sized (http.pool.num_workers=0) and is 5
// workers here. RoadRunner also recycles workers after max_jobs=500 or
// exec_ttl=3600s, so their bootstrap cost comes back on its own; hence the
// periodic refresh rather than a one-shot warm.
//
// Why the probe watches for COLD, not only for failure: the pool boot is deferred
// to each worker's first request, so a `docker restart backend` is unhealthy for
// only a couple of seconds and then answers 200 — a failure-counting probe like
// the frontend's would frequently never see the restart at all. What is reliably
// observable is that the first answer is *slow*: the worker that served it had to
// bootstrap. So a probe that answers much slower than a warm request means a
// worker just paid the cold cost, and the rest of the pool is about to bill the
// next users. That is the signal this loop warms on.
//
// Why the cold threshold is adaptive: the *ratio* between a cold and a warm
// request is what is load-invariant (~50-60x, measured at load 4 and load 21
// alike); the absolute cost is not. A fixed 1s threshold was measured to sit
// INSIDE the cold distribution on a quiet box — isolated cold probes there came
// back in 0.80-1.67s — so it detected only the slow half of real restarts and
// missed the rest outright (one 4-minute window: 0 detections, pool warmed only
// by the 300s periodic refresh). Scaling a measured warm baseline by
// WARMUP_COLD_FACTOR keeps the same margin in both regimes: ~0.2s on a quiet box
// and ~3s under heavy load, against a cold cost of ~1.3s and ~7s+ respectively.
//
// Low concurrency on purpose: the earlier version fired 8 concurrent requests,
// which occupies the whole pool and makes a user's request queue behind the
// warmer — measurably worse than not warming at all (a first burst of 12.8-16.1s
// against ~5s un-warmed, measured at load ~19). A pass now issues
// WARMUP_REQUESTS requests with at most WARMUP_CONCURRENCY in flight, leaving the
// remaining workers free for real traffic, while still guaranteeing every worker
// is handed at least one request.
//
// Why it logs in: a request to /up boots a worker but touches almost no
// application code, so the authenticated surface (permissions, tenancy, the
// modules behind the dashboard) stays cold. The warmer therefore signs in once
// and reuses that token. It does not log in on every pass: /api/v1/login is
// throttled to 5/min per email and costs ~2.4-3.3s (bcrypt, activity log, login
// history, token row). A 401 triggers one re-login, with a cooldown so the
// throttle cannot be tripped.
//
// THE PER-TENANT SURFACE
//
// The central pass above warms the *central* surface only. Tenant requests carry
// a different resolved security context: InitializeTenantContext resolves the
// tenant from the Host header (tenants.id or domains.domain — no signature is
// required for Host-header resolution), the bg_* tables that get touched look up
// the tenant's database connection, and TenancyMiddleware *then* runs the
// costly bits (module access, subscription checks). None of that work is shared
// across tenants, so a worker warmed by a central request still bills the first
// tenant dashboard call of each tenant. The tenant tier logs in once per tenant
// (POST /api/v1/tenant/login with the tenant's Host), reuses that token across
// passes, and issues the tenant-authenticated routes under that Host.
//
// WHY THE TENANT SURFACE IS ALSO LOAD-AWARE
//
// A full tenant tier is up to 12 tenants x 2+ routes. Under host contention the
// same 505s blow-up the frontend warmer was measured at applies here. The tenant
// pass therefore mirrors the frontend's structure without copying its code:
//
//   * value order — central first, then ONE route across every tenant before any
//     tenant's second route, so an early stop still leaves every tenant's most
//     valuable endpoint warm;
//   * inside a tenant tier, least-recently-warmed first (never-warmed before
//     those), so backing off still advances coverage instead of re-warming the
//     same lucky hosts forever — the same convergence argument as the frontend:
//     ordering by measured cost was tried first and does not converge, because
//     the order shifts as costs are learned;
//   * back-off before every tenant request, checked against the 1-minute load
//     average AND how the cold-detection probe just behaved (a probe slower than
//     WARMUP_PROBE_BACKOFF_MS also says the box is busy — the milliseconds
//     reading is deliberate, unlike the probe *_SECONDS settings);
//   * a contended pass warms central routes plus WARMUP_TENANT_REQUESTS tenant
//     logins+requests; a severely contended pass warms central only (a tenant
//     login is three requests and a bcrypt, and under real contention every
//     member costs more than it shields); and
//   * whatever the pass deferred is retried after WARMUP_TENANT_BACKOFF_SECONDS
//     instead of sleeping out the refresh interval.
//
// WHY LOGIN COOLDOWNS ARE PER-ROUTE AND FOUR MINUTES
//
// /api/v1/login and /api/v1/tenant/login both sit behind throttle:auth-login
// (auth.login limiter): 10/min per source IP across ALL of them, plus 5/min per
// email. Five sign-ins from one container in quick succession are past the IP
// limit already; the refusals render as 429 (an HTML "Too Many Requests" page
// here), which also poisons the failed-attempt lock when a credential is wrong.
// The cooldown is therefore LONGER than the throttle windows (60s), so any month
// of logins the warmer ever does fits under the IP limit purely from the clock.
//
// CODE SYNC CAVEAT
//
// The auth response shape (data.token) and the throttle behaviour are asserted
// by scripts/test-prewarm-backend.mjs against a fake backend, not stubbed. If
// Modules/Identity changes the token response shape, the warmer's own health
// check will keep passing and only the contract harness notices.
//
// The demo account below is the seeded central super admin (password "password"
// in Modules/Identity/database/seeders/CentralUsersSeeder.php). The tenant
// passwords come from TenantUsersSeeder (password "password") for all but the
// migrated tenants (see config/tenancy.php migrated_passwords). Override the
// credentials for any other environment.
//
// Configuration (all optional):
//   WARMUP_BACKEND_URL       default: http://backend:8000
//   WARMUP_LOGIN_PATH        default: /api/v1/login
//   WARMUP_LOGIN_EMAIL       default: super@hive.os
//   WARMUP_LOGIN_PASSWORD    default: password
//   WARMUP_SKIP_AUTH         1 = warm only the public routes
//   WARMUP_PUBLIC_ROUTES     default: /up /api/v1/languages/public
//   WARMUP_AUTH_ROUTES       default: /api/v1/dashboard /api/v1/settings/general/runtime
//   WARMUP_REQUESTS          requests per pass, default: 5 (one per worker)
//                            (WARMUP_WORKERS is honoured as a legacy alias)
//   WARMUP_CONCURRENCY       max requests in flight per pass, default: 2
//   WARMUP_REFRESH_SECONDS   default: 300
//   WARMUP_PROBE_SECONDS     how often to check the backend is alive, default: 3
//   WARMUP_PROBE_TIMEOUT_MS  timeout for that liveness probe. Read in SECONDS
//                            despite the name (seconds(), default 8) — passing
//                            8000 means 8000s, which lets one stalled socket
//                            hang the whole probe loop.
//   WARMUP_PROBE_FAILURES    consecutive failed probes that mean the backend is
//                            away, default: 2
//   WARMUP_COLD_FACTOR       a probe this many times slower than the measured
//                            warm baseline means a worker just booted, default: 10
//   WARMUP_COLD_FLOOR_MS     minimum cold threshold, default: 200
//   WARMUP_COLD_THRESHOLD_MS optional fixed threshold; set it to disable the
//                            adaptive one (it was the default before, and is not
//                            recommended — see above)
//   WARMUP_TIMEOUT_MS        per-request timeout, default: 180000
//   WARMUP_READY_TIMEOUT_MS  how long to wait for the server, default: 300000
//   WARMUP_SLOW_THRESHOLD_MS what counts as slow (informational), default: 1000
//
// Tenant tier (all optional; nothing warms unless WARMUP_TENANT_HOSTS is set):
//   WARMUP_TENANT_HOSTS      space-separated tenant hosts (the backend's docker
//                            aliases, e.g. "lanouveil.localhost techive.localhost").
//                            Must be hosts the backend answers with a resolved
//                            tenant — see the alias list in docker-compose.yml,
//                            kept in sync with TenantsSeeder.
//   WARMUP_TENANT_LOGIN_PATH default: /api/v1/tenant/login
//   WARMUP_TENANT_ROUTES     default: /api/v1/dashboard — warmed in ONE-pass-per-
//                            route order exactly like the frontend's tenant tier
//                            (first route across all hosts, then the second).
//   WARMUP_TENANT_EMAIL_SUFFIX
//                            the default admin address is admin@<host-without-
//                            .localhost><suffix>, default ".com" — that is how
//                            TenantUsersSeeder builds them: tenant id
//                            lanouveil -> admin@lanouveil.com. techive has NO
//                            admin@techive.com (it seeds a 7-person team
//                            instead), so give that host a per-host override.
//   WARMUP_TENANT_OVERRIDES  optional per-host credential overrides (suffix- and
//                            password-bypassing), comma-separated:
//                            host=email:password,host2=email:password.
//   WARMUP_TENANT_PASSWORD   default: password (TenantUsersSeeder's seeded
//                            password; config/tenancy.php carries overridden
//                            passwords for migrated tenants only).

//   WARMUP_TENANT_REQUESTS   tenant logins+requests still warmed when only
//                            contended, default: 2; successive passes work
//                            through the least-recently-warmed tenants. 0 = a
//                            contended pass warms the central tier only.
//   WARMUP_TENANT_LOAD_BACKOFF
//                            what counts as a contended host in 1-minute load
//                            average, default: 6 (frontend parity), and
//                            WARMUP_TENANT_LOAD_SEVERE above which the tenant
//                            tier is skipped entirely, default: 2x the backoff.
//   WARMUP_TENANT_PROBE_BACKOFF_MS
//                            a liveness probe slower than this also counts as
//                            contended, default: 3000 (milliseconds — not
//                            seconds like the _TIMEOUT_MS settings).
//   WARMUP_TENANT_BACKOFF_SECONDS
//                            when the tier is cut short, how soon to retry what
//                            it deferred, default: 60.
//   WARMUP_TENANT_LOGIN_COOLDOWN_SECONDS
//                            minimum gap between attempts for the same tenant.
//                            Default 240, chosen ABOVE the auth-login throttle
//                            windows (60s) with margin for re-login bursts —
//                            the backend's limiter counts 10/min per source IP
//                            ACROSS all auth routes plus 5/min per email, so
//                            240 keeps warmer logins from tripping it alone.

import http from "node:http";
import os from "node:os";
import { writeFileSync, unlinkSync } from "node:fs";

const HEARTBEAT = "/tmp/backend-warmup-heartbeat";

const BASE_URL = new URL(process.env.WARMUP_BACKEND_URL ?? "http://backend:8000");
const LOGIN_PATH = process.env.WARMUP_LOGIN_PATH ?? "/api/v1/login";
const LOGIN_EMAIL = process.env.WARMUP_LOGIN_EMAIL ?? "super@hive.os";
const LOGIN_PASSWORD = process.env.WARMUP_LOGIN_PASSWORD ?? "password";
const SKIP_AUTH = ["1", "true", "yes"].includes((process.env.WARMUP_SKIP_AUTH ?? "").toLowerCase());
const PUBLIC_ROUTES = list("WARMUP_PUBLIC_ROUTES", ["/up", "/api/v1/languages/public"]);
const AUTH_ROUTES = list("WARMUP_AUTH_ROUTES", [
  "/api/v1/dashboard",
  "/api/v1/settings/general/runtime",
]);
const REQUESTS = integer("WARMUP_REQUESTS", integer("WARMUP_WORKERS", 5));
const CONCURRENCY = integer("WARMUP_CONCURRENCY", 2);
const REFRESH_MS = seconds("WARMUP_REFRESH_SECONDS", 300) * 1000;
const PROBE_MS = seconds("WARMUP_PROBE_SECONDS", 3) * 1000;
const PROBE_TIMEOUT_MS = seconds("WARMUP_PROBE_TIMEOUT_MS", 8) * 1000;
const PROBE_FAILURES = integer("WARMUP_PROBE_FAILURES", 2);
const COLD_FACTOR = seconds("WARMUP_COLD_FACTOR", 10);
const COLD_FLOOR_MS = seconds("WARMUP_COLD_FLOOR_MS", 0.2) * 1000;
const COLD_FIXED_MS = process.env.WARMUP_COLD_THRESHOLD_MS
  ? seconds("WARMUP_COLD_THRESHOLD_MS", 1) * 1000
  : 0;
const REQUEST_TIMEOUT_MS = seconds("WARMUP_TIMEOUT_MS", 180) * 1000;
const READY_TIMEOUT_MS = seconds("WARMUP_READY_TIMEOUT_MS", 300) * 1000;
const SLOW_THRESHOLD_MS = seconds("WARMUP_SLOW_THRESHOLD_MS", 1) * 1000;

// Tenant tier.
const TENANT_HOSTS = list("WARMUP_TENANT_HOSTS", []);
const TENANT_LOGIN_PATH = process.env.WARMUP_TENANT_LOGIN_PATH ?? "/api/v1/tenant/login";
const TENANT_ROUTES = list("WARMUP_TENANT_ROUTES", ["/api/v1/dashboard"]);
const TENANT_REQUESTS_WHEN_CONTENDED = count("WARMUP_TENANT_REQUESTS", 2);
const CPU_COUNT = Math.max(1, os.cpus()?.length ?? 1);
const TENANT_LOAD_BACKOFF = number("WARMUP_TENANT_LOAD_BACKOFF", 6);
const TENANT_LOAD_SEVERE = number("WARMUP_TENANT_LOAD_SEVERE", TENANT_LOAD_BACKOFF * 2);
const TENANT_PROBE_BACKOFF_MS = number("WARMUP_TENANT_PROBE_BACKOFF_MS", 3000);
const TENANT_BACKOFF_MS = seconds("WARMUP_TENANT_BACKOFF_SECONDS", 60) * 1000;
const TENANT_LOGIN_COOLDOWN_MS =
  seconds("WARMUP_TENANT_LOGIN_COOLDOWN_SECONDS", 240) * 1000;
// The alert hook: a tenant whose login 401s this many times IN A ROW (attempts
// are already cooldown-gated, so this spans multiple passes) has broken
// credentials or a deleted user — warming cannot fix that, and a per-pass log
// line scrolls away. The failures go to TENANT_ALERT_FILE for the stack
// healthcheck to surface as a WARNING; the marker clears itself the moment a
// login for that host succeeds. 0 disables the hook.
const TENANT_ALERT_THRESHOLD = count("WARMUP_TENANT_ALERT_THRESHOLD", 3);
// Overridable so the contract harness can point each case at its own marker.
const TENANT_ALERT_FILE =
  process.env.WARMUP_TENANT_ALERT_FILE ?? "/tmp/backend-warmup-alert";

// Per-host credential overrides: "host=email:password,host2=email:password".
const TENANT_OVERRIDES = parseOverrides(process.env.WARMUP_TENANT_OVERRIDES ?? "");
const TENANT_EMAIL_SUFFIX = process.env.WARMUP_TENANT_EMAIL_SUFFIX ?? ".com";

const RELOGIN_COOLDOWN_MS = 60 * 1000;
const LOGIN_ATTEMPTS = 3;
const LOGIN_RETRY_MS = 2000;
const WARM_SAMPLES = 10;

function list(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw.split(/\s+/).filter(Boolean);
}

function seconds(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function integer(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

// Like integer(), except that 0 is meaningful: "when contended, warm nothing
// beyond the central tier".
function count(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function number(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Hosts here are docker aliases like "lanouveil.localhost"; the default seeded
// admin for that tenant is admin@lanouveil.com (TenantUsersSeeder builds
// "admin@{$tenantId}.com" from the tenant id, and the alias equals the tenant
// id). techive breaks the pattern — it seeds a named 7-person team and no
// admin@techive.com — and migrated tenants (config/tenancy.php) seed nothing,
// so both go through overrides.
function parseOverrides(raw) {
  const map = new Map();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const rest = trimmed.slice(separator + 1);
    const lastColon = rest.lastIndexOf(":");
    const email = lastColon > 0 ? rest.slice(0, lastColon) : rest;
    const password = lastColon > 0 ? rest.slice(lastColon + 1) : "";
    map.set(key, { email, password });
  }
  return map;
}

function tenantCredentials(host) {
  if (TENANT_OVERRIDES.has(host)) return TENANT_OVERRIDES.get(host);
  return { email: `admin@${host.replace(/\.localhost$/i, "")}${TENANT_EMAIL_SUFFIX}`, password: LOGIN_PASSWORD };
}

function log(message) {
  console.log(`${new Date().toISOString()} ${message}`);
}

// Touched at the start of every pass and after every request, so the container
// healthcheck can tell "loop is alive" from "loop wedged".
function heartbeat() {
  try {
    writeFileSync(HEARTBEAT, new Date().toISOString());
  } catch {
    /* best effort: never break warming over the heartbeat */
  }
}

// What does a warm request cost *right now*? Every successful probe feeds this
// window and the baseline is the minimum, which is the cleanest estimate:
// contention only ever adds time, and a cold sample is necessarily slower than
// the warm ones it sits among. Recording only samples the threshold had already
// agreed were warm was a chicken-and-egg bug — on a box whose warm cost sat above
// the floor, no sample was ever accepted, the baseline stayed 0, and the warmer
// fired a pass on every probe.
const recentProbes = [];
let warmBaselineMs = 0;

function recordProbe(ms) {
  recentProbes.push(ms);
  if (recentProbes.length > WARM_SAMPLES) recentProbes.shift();
  warmBaselineMs = Math.min(...recentProbes);
}

function coldThresholdMs() {
  if (COLD_FIXED_MS) return COLD_FIXED_MS;
  if (!warmBaselineMs) return COLD_FLOOR_MS;
  return Math.max(COLD_FLOOR_MS, warmBaselineMs * COLD_FACTOR);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One HTTP request that always drains the body: not draining can leave the
// worker waiting on a socket instead of finishing the request.
function request(path, { method = "GET", headers = {}, body, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.request(
      {
        host: BASE_URL.hostname,
        port: BASE_URL.port || 80,
        path,
        method,
        headers: {
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, ms: Date.now() - started, text, json });
        });
      },
    );

    req.on("error", (error) => resolve({ status: 0, ms: Date.now() - started, error: error.message }));
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no response within ${timeoutMs}ms`)));
    if (body) req.write(body);
    req.end();
  });
}

async function waitForServer() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts += 1;
    // Keep this warmer's own heartbeat fresh while the backend is away: the
    // container healthcheck measures this file's age, not reachability.
    heartbeat();
    const probe = await request(PUBLIC_ROUTES[0] ?? "/up", { timeoutMs: 10000 });
    if (probe.status > 0) {
      log(`backend answered GET ${PUBLIC_ROUTES[0] ?? "/up"} with ${probe.status} after ${attempts} probe(s)`);
      return true;
    }
    if (attempts === 1 || attempts % 5 === 0) {
      log(`waiting for the backend at ${BASE_URL.origin} (attempt ${attempts})`);
    }
    await sleep(2000);
  }

  log(`backend did not answer within ${READY_TIMEOUT_MS / 1000}s; continuing to retry`);
  return false;
}

let token = "";
let lastLoginAttempt = 0;

// Signs in the CENTRAL admin. Transport failures do not start the cooldown: the
// server booting can manifest as a socket hang-up, and a full-minute public-only
// window after every restart would be a colder-than-necessary backend.
async function login(reason) {
  if (SKIP_AUTH) return false;
  if (Date.now() - lastLoginAttempt < RELOGIN_COOLDOWN_MS) return false;

  // A transport failure (connection refused, or a socket hang up while the
  // server is still booting — observed in practice) never reaches the throttle,
  // so it must not start the cooldown: otherwise the warmer sits in public-only
  // mode for a full minute after a restart. Only a real response sets the clock.
  let result = { status: 0, error: "not attempted" };

  for (let attempt = 1; attempt <= LOGIN_ATTEMPTS; attempt += 1) {
    result = await request(LOGIN_PATH, {
      method: "POST",
      body: JSON.stringify({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD }),
    });

    if (result.status !== 0) break;

    log(
      `login (${reason}) attempt ${attempt}/${LOGIN_ATTEMPTS} failed at the transport level: ${result.error}`,
    );
    if (attempt < LOGIN_ATTEMPTS) await sleep(LOGIN_RETRY_MS);
  }

  if (result.status === 0) return false;

  lastLoginAttempt = Date.now();
  const token_ = result.json?.data?.token;
  if (result.status >= 200 && result.status < 300 && token_) {
    token = token_;
    log(`login (${reason}) succeeded in ${(result.ms / 1000).toFixed(1)}s — token in hand, reusing it for the pass`);
    return true;
  }

  if (result.status === 423) {
    log(`login (${reason}) refused: account temporarily locked (429/423). Warming public routes only.`);
  } else if (result.status === 401) {
    log(`login (${reason}) refused: ${LOGIN_EMAIL} rejected with 401. Check WARMUP_LOGIN_EMAIL/WARMUP_LOGIN_PASSWORD.`);
  } else {
    log(`login (${reason}) unexpected status ${result.status}: ${result.text.slice(0, 200)}`);
  }
  return false;
}

// One tenant's session. Login cooldowns are per host (the per-email limiter sees
// the tenant's own admin address; the per-IP limiter sees the warmer container).
// The cooldown default (240s) is deliberately longer than the auth-login windows
// (60s) so warmer logins cannot trip the IP limiter ALONE; see the header note.
const tenants = new Map(); // host -> { token, lastLoginAttempt, lastWarmedAt: Map(path->ts) }

function tenantState(host) {
  let state = tenants.get(host);
  if (!state) {
    state = { token: "", lastLoginAttempt: 0, lastWarmedAt: new Map(), login401s: 0 };
    tenants.set(host, state);
  }
  return state;
}

// One marker file, one line per tenant currently failing. REWRITTEN — not
// appended — after every tenant login attempt, so a recovered tenant
// disappears from it the moment it signs in. A tenant dropped from
// WARMUP_TENANT_HOSTS keeps its line until the file is cleared by hand:
// a removed-but-broken tenant should not vanish silently either.
function rewriteTenantAlerts() {
  const lines = [];
  for (const [host, st] of tenants) {
    if (TENANT_ALERT_THRESHOLD > 0 && st.login401s >= TENANT_ALERT_THRESHOLD) {
      lines.push(
        `${new Date().toISOString()} ${host} ${tenantCredentials(host).email}: ${st.login401s} consecutive tenant-login 401s`,
      );
    }
  }
  try {
    if (!lines.length) {
      unlinkSync(TENANT_ALERT_FILE);
    } else {
      writeFileSync(TENANT_ALERT_FILE, `${lines.join("\n")}\n`);
    }
  } catch {
    /* best effort: an unwritable alert file must never break warming */
  }
}

// Logs one tenant's admin in under that tenant's Host. The host decides BOTH
// which tenant's DB the limiter sees the email in AND which tenant's session the
// token belongs to, and InitializeTenantContext needs no signature for
// Host-header resolution — so the whole tenant handshake is one POST.
async function tenantLogin(host, reason) {
  const state = tenantState(host);
  if (Date.now() - state.lastLoginAttempt < TENANT_LOGIN_COOLDOWN_MS) return false;

  const { email, password } = tenantCredentials(host);
  let result = { status: 0, error: "not attempted" };

  for (let attempt = 1; attempt <= LOGIN_ATTEMPTS; attempt += 1) {
    result = await request(TENANT_LOGIN_PATH, {
      method: "POST",
      headers: { Host: host },
      body: JSON.stringify({ email, password, device_name: "backend-warmup" }),
    });

    if (result.status !== 0) break;

    log(
      `tenant login ${host} (${reason}) attempt ${attempt}/${LOGIN_ATTEMPTS} failed at the transport level: ${result.error}`,
    );
    if (attempt < LOGIN_ATTEMPTS) await sleep(LOGIN_RETRY_MS);
  }

  if (result.status === 0) return false;

  state.lastLoginAttempt = Date.now();
  const token_ = result.json?.data?.token;
  if (result.status >= 200 && result.status < 300 && token_) {
    state.token = token_;
    if (state.login401s > 0) {
      log(`tenant login alert cleared: ${host} signed in after ${state.login401s} consecutive 401(s)`);
    }
    state.login401s = 0;
    rewriteTenantAlerts();
    log(`tenant login ${host} (${reason}) succeeded in ${(result.ms / 1000).toFixed(1)}s`);
    return true;
  }

  if (result.status === 423) {
    log(`tenant login ${host} refused: temporarily locked (429/423). Trying again after the cooldown.`);
  } else if (result.status === 401) {
    state.login401s += 1;
    log(`tenant login ${host} refused: ${email} rejected with 401. Check WARMUP_TENANT_EMAIL_SUFFIX / WARMUP_TENANT_OVERRIDES (see TenantUsersSeeder for who gets what).`);
    if (state.login401s === TENANT_ALERT_THRESHOLD) {
      log(`tenant login ALERT: ${host} has now failed ${state.login401s} logins in a row with 401 — marker written to ${TENANT_ALERT_FILE}`);
    }
  } else {
    log(`tenant login ${host} unexpected status ${result.status}: ${result.text.slice(0, 200)}`);
  }
  rewriteTenantAlerts();
  return false;
}

// Need-ordered tenant tier: hosts by (lastWarmedAt[path] ?? 0) ascending, so the
// never-warmed come first and coverage advances on every constrained pass. The
// SAME ordering policy as the frontend warmer, for the same reason: ordering by
// measured cost does not converge under back-off.
function tenantTasks(path) {
  return TENANT_HOSTS.map((host) => ({ host, path }))
    .sort(
      (a, b) =>
        (tenantState(a.host).lastWarmedAt.get(a.path) ?? 0) -
        (tenantState(b.host).lastWarmedAt.get(b.path) ?? 0),
    );
}

// The single source of contention truth for the tier: 1-minute load average,
// plus how the cold-awareness probe just behaved (a slow probe also says the box
// is busy — same policy as the frontend warmer, right down to reading
// WARMUP_TENANT_PROBE_BACKOFF_MS in plain milliseconds).
let lastProbeMs = null;

function tenantContention() {
  const load = os.loadavg()[0];
  if (load >= TENANT_LOAD_SEVERE) return { level: "severe", load, why: `load ${load.toFixed(1)} >= ${TENANT_LOAD_SEVERE}` };
  if (load >= TENANT_LOAD_BACKOFF) return { level: "contended", load, why: `load ${load.toFixed(1)} >= ${TENANT_LOAD_BACKOFF}` };
  if (lastProbeMs !== null && lastProbeMs >= TENANT_PROBE_BACKOFF_MS) {
    return { level: "contended", load, why: `probe ${lastProbeMs}ms >= ${TENANT_PROBE_BACKOFF_MS}ms` };
  }
  return { level: "ok", load, why: `load ${load.toFixed(1)} < ${TENANT_LOAD_BACKOFF}` };
}

// Runs `count` requests cycling through the given routes, with at most
// `concurrency` in flight. Every worker in the Octane pool has to be handed at
// least one request for its bootstrap to happen, so a pass covers the whole pool
// — but it must not hold the whole pool at once, or a real user's request queues
// behind the warmer instead of being shielded by it.
async function burst(routes, count, concurrency = CONCURRENCY, headers = {}) {
  const results = [];
  const inFlight = Math.min(Math.max(concurrency, 1), count);
  let next = 0;

  const runners = Array.from({ length: inFlight }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= count) return;
      const path = routes[index % routes.length];
      const result = await request(path, { headers });
      heartbeat();
      results.push({ path, ...result });
    }
  });

  await Promise.all(runners);
  return results;
}

function describe(results) {
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  const failures = results.filter((r) => r.status === 0 || r.status >= 400);
  const unauthorised = results.filter((r) => r.status === 401);
  const slowest = times[times.length - 1] ?? 0;
  return {
    unauthorised,
    summary:
      `${results.length} request(s) in ${(slowest / 1000).toFixed(2)}s slowest` +
      ` (p50 ${((times[Math.floor(times.length / 2)] ?? 0) / 1000).toFixed(2)}s)` +
      (slowest >= SLOW_THRESHOLD_MS ? `, ${results.filter((r) => r.ms >= SLOW_THRESHOLD_MS).length} slow` : ", all fast") +
      (failures.length ? `, ${failures.length} FAILED` : ""),
    failures,
  };
}

// One request through an established tenant session; clears the token on 401 so
// the NEXT pass re-logins instead of hammering a dead credential this one.
async function tenantRequest(host, path, state) {
  const result = await request(path, { headers: { Host: host, Authorization: `Bearer ${state.token}` } });
  heartbeat();
  state.lastWarmedAt.set(path, Date.now());
  return {
    ok: result.status > 0 && result.status < 400,
    slow: result.ms >= SLOW_THRESHOLD_MS,
    ms: result.ms,
    status: result.status,
    text:
      result.status === 0
        ? `${path} FAILED after ${(result.ms / 1000).toFixed(1)}s (${result.error})`
        : `${path} ${result.status} in ${(result.ms / 1000).toFixed(1)}s${result.ms >= SLOW_THRESHOLD_MS ? " (slow)" : ""}`,
  };
}

// The adaptive tenant pass: central first, then value order across tenants —
// one route across ALL hosts before any host's second route; inside a tier,
// least-recently-warmed hosts first. Contention re-evaluated before every tenant
// request: severe cuts the tier to zero (central work already done), contended
// caps it at the WARMUP_TENANT_REQUESTS neediest.
async function warmTenants(reason) {
  if (!TENANT_HOSTS.length) return { warmed: 0, deferred: 0, why: null };

  const opening = tenantContention();
  let allowed = TENANT_REQUESTS_WHEN_CONTENDED;
  if (opening.level === "severe") allowed = 0;

  log(
    `${reason}: tenant tier — ${TENANT_HOSTS.length} host(s) x ${TENANT_ROUTES.length} route(s) queued, ` +
      `host ${opening.level} (${opening.why})` +
      (opening.level === "severe" ? ", tier skipped" : opening.level === "contended" ? `, capped at ${allowed}` : ""),
  );

  if (allowed === 0) return { warmed: 0, deferred: TENANT_HOSTS.length * TENANT_ROUTES.length, why: opening.why };

  const parts = [];
  let warmed = 0;
  let stopWhy = null;

  const flushTier = () => {
    if (parts.length) log(`  tenant ${tierPath}: ${parts.join(" · ")}`);
    parts.length = 0;
  };

  let tierPath = null;

  for (const path of TENANT_ROUTES) {
    const ordered = tenantTasks(path);
    for (const task of ordered) {
      const index = warmed; // re-check BEFORE each tenant request
      const now = tenantContention();
      if (now.level === "severe") {
        stopWhy = now.why;
        break;
      }
      if (now.level === "contended" && index >= allowed) {
        stopWhy = now.why;
        break;
      }

      if (tierPath !== path) {
        flushTier();
        tierPath = path;
      }

      const state = tenantState(task.host);
      if (!state.token) await tenantLogin(task.host, reason);
      if (!state.token) {
        // Include the failed host so a pass summary shows WHERE the login
        // problem is, and skip silently repeating hosts whose cooldown blocks a
        // re-try this pass.
        parts.push(`l: ${task.host}`);
        state.lastWarmedAt.set(path, Date.now());
        warmed += 1;
        continue;
      }

      const result = await tenantRequest(task.host, path, state);
      if (result.status === 401) {
        // A revoked/expired token; retrying with the same frozen token would
        // burn the pass. Also drops the lru so the next pass runs first.
        state.token = "";
        state.lastLoginAttempt = 0;
        state.lastWarmedAt.set(path, 1);
        log(`  tenant ${task.host} ${path} rejected the cached token (401), re-logging in next pass`);
      }
      parts.push(`${task.host} ${result.text}`);
      warmed += 1;
    }
    if (stopWhy) break;
  }

  flushTier();
  const deferred = TENANT_HOSTS.length * TENANT_ROUTES.length - warmed;
  if (deferred) {
    log(`${reason}: tenant tier backed off (${stopWhy ?? "contention"}) — ${deferred} deferred, retry in ${TENANT_BACKOFF_MS / 1000}s`);
  } else if (warmed) {
    log(`${reason}: tenant tier complete — ${TENANT_HOSTS.length * TENANT_ROUTES.length} of ${TENANT_HOSTS.length * TENANT_ROUTES.length} warmed`);
  }
  return { warmed, deferred, why: stopWhy };
}

async function warmAll(reason) {
  heartbeat();
  const started = Date.now();

  const publicBurst = await burst(PUBLIC_ROUTES, Math.max(REQUESTS, PUBLIC_ROUTES.length));
  const publicReport = describe(publicBurst);

  let authReport = { summary: "auth warming disabled", failures: [], unauthorised: [] };
  let authBurst = [];

  if (!SKIP_AUTH) {
    if (!token) await login("startup");
    if (token) {
      // The token rides the burst's headers parameter — the central tier is
      // what needs it (and the contract harness asserts it does carry it).
      authBurst = await burst(AUTH_ROUTES, REQUESTS, CONCURRENCY, token ? { Authorization: `Bearer ${token}` } : {});
      authReport = describe(authBurst);

      // A revoked or expired token shows up as 401; get a fresh one next pass.
      if (authReport.unauthorised.length) {
        log("token rejected (401); will re-login on the next pass");
        token = "";
      }
    }
  }

  // The tenant tier runs after the central burst: a central dashboard touches
  // the routes/config/db layers every tenant request re-uses, and warmed first
  // it shields the most calls (see the value-order note in the header).
  const tenantReport = SKIP_AUTH ? { warmed: 0, deferred: 0, why: null } : await warmTenants(reason);

  const failed = publicReport.failures.length + authReport.failures.length;
  const total = ((Date.now() - started) / 1000).toFixed(1);
  log(
    `${reason}: public ${publicReport.summary}` +
      (SKIP_AUTH ? "" : ` | auth ${authReport.summary}`) +
      (TENANT_HOSTS.length
        ? ` | tenants ${tenantReport.warmed} of ${TENANT_HOSTS.length * TENANT_ROUTES.length}` +
          (tenantReport.deferred ? `, ${tenantReport.deferred} deferred, retry in ${TENANT_BACKOFF_MS / 1000}s` : "")
        : "") +
      ` — pass took ${total}s` +
      (failed ? `, ${failed} FAILED` : ""),
  );
  return { deferred: tenantReport.deferred, tenant: tenantReport };
}

process.on("SIGTERM", () => {
  log("received SIGTERM, exiting");
  process.exit(0);
});

heartbeat();
log(
  `prewarming ${BASE_URL.origin} — public: ${PUBLIC_ROUTES.join(" ")}` +
    (SKIP_AUTH ? "" : ` — auth: ${AUTH_ROUTES.join(" ")} as ${LOGIN_EMAIL}`) +
    ` — ${REQUESTS} request(s) per pass, ${CONCURRENCY} concurrent, refresh every ${REFRESH_MS / 1000}s`,
);
log(
  `probe every ${PROBE_MS / 1000}s (timeout ${PROBE_TIMEOUT_MS / 1000}s, ${PROBE_FAILURES} failures = away); ` +
    (COLD_FIXED_MS
      ? `cold threshold FIXED at ${COLD_FIXED_MS}ms`
      : `cold threshold adaptive: max(${COLD_FLOOR_MS}ms, ${COLD_FACTOR}x measured warm baseline)`),
);
if (TENANT_HOSTS.length) {
  log(
    `tenant tier: ${TENANT_HOSTS.length} host(s) via ${TENANT_LOGIN_PATH} (${TENANT_ROUTES.join(" ")}) — ` +
      `backing off at load ${TENANT_LOAD_BACKOFF} (severe ${TENANT_LOAD_SEVERE}, ${CPU_COUNT} cpu), ` +
      `keeping ${TENANT_REQUESTS_WHEN_CONTENDED} when contended, ` +
      `login cooldown ${TENANT_LOGIN_COOLDOWN_MS / 1000}s`,
  );
  const overrides = [...TENANT_OVERRIDES.keys()];
  if (overrides.length) log(`tenant credential overrides for: ${overrides.join(", ")}`);
  log(
    `tenant alert hook: ${TENANT_ALERT_THRESHOLD || "disabled"} consecutive login 401(s) per tenant -> ${TENANT_ALERT_FILE}`,
  );
} else {
  log("tenant tier: disabled (no WARMUP_TENANT_HOSTS configured)");
}

// The loop watches the backend rather than only sleeping between refreshes, so
// warming follows a restart instead of the clock. Two things trigger a pass: the
// backend going away and coming back, and — the case that actually happens,
// because a restart is brief — a probe that answers slowly enough to prove a
// worker just paid the cold bootstrap.
let firstPass = true;
let nextPassAt = 0;
let failures = 0;

for (;;) {
  const probe = await request(PUBLIC_ROUTES[0] ?? "/up", { timeoutMs: PROBE_TIMEOUT_MS });
  heartbeat();

  const unreachable = probe.status === 0;
  const threshold = coldThresholdMs();
  const cold = !unreachable && probe.ms >= threshold;
  if (!unreachable) recordProbe(probe.ms);
  // The contention view the tenant tier uses on this cycle is the probe that
  // just answered; the tier itself reads os.loadavg() live per request.
  lastProbeMs = probe.status === 0 ? null : probe.ms;

  if (unreachable) {
    failures += 1;
    // A stopped container drops packets as often as it refuses them, so this can
    // arrive as a timeout. Logged every time so a silent retry loop cannot hide
    // a missed restart.
    log(`probe ${failures}/${PROBE_FAILURES} failed (${probe.error ?? `status ${probe.status}`})`);
  } else {
    failures = 0;
  }

  if (failures >= PROBE_FAILURES) {
    failures = 0;
    log(firstPass ? "waiting for the backend to start" : "backend away — warming as soon as it answers");
    await waitForServer();
    const result = await warmAll(firstPass ? "startup pass" : "backend restart detected (was unreachable)");
    firstPass = false;
    // A pass that stopped early (contention) retries what it deferred after the
    // back-off interval, not the full refresh — a busy spell delays the tenant
    // tier, it must not cancel it. Keeping the schedule in one place means the
    // cold/periodic branch below reads the same nextPassAt.
    nextPassAt = Date.now() + (result.deferred ? TENANT_BACKOFF_MS : REFRESH_MS);
  } else if (!unreachable && (firstPass || cold || Date.now() >= nextPassAt)) {
    const result = await warmAll(
      firstPass
        ? "startup pass"
        : cold
          ? `cold worker detected (probe ${probe.ms}ms >= ${Math.round(threshold)}ms threshold ` +
            `= ${COLD_FACTOR}x warm baseline ${Math.round(warmBaselineMs)}ms)`
          : "periodic refresh",
    );
    firstPass = false;
    nextPassAt = Date.now() + (result.deferred ? TENANT_BACKOFF_MS : REFRESH_MS);
  }

  await sleep(PROBE_MS);
}
