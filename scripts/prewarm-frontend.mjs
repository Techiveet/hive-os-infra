#!/usr/bin/env node
//
// prewarm-frontend.mjs — warms the key routes of the Next.js dev server so the
// first human visit is fast, including the per-tenant dashboards.
//
// Why this exists: `next dev` compiles each route on first request — measured
// at 1.2-30s for the busiest routes of this app.
// The entrypoint now keeps that cache across a plain restart (see
// hive-os-frontend/docker-entrypoint.sh: it only resets when the
// Next.js/Node/dependency signature changes), but the cache is still empty
// whenever the image or dependencies change, when entries get evicted under
// memory pressure, or after a deliberate reset, so warming still has to
// happen again on a cold start. Hence its own `restart: unless-stopped`
// service: it comes back with the stack, waits for the dev server, warms the
// routes, and keeps them warm on an interval. It also watches the dev server
// while idle and warms the moment it answers again after a restart, so a
// restart does not leave a window where the next visitor pays the compile.
//
// About the tenant pass: Next dev compiles per route path, not per host — a
// tenant-host request does NOT trigger a recompile once the shared route is warm
// (verified: `next.js: 3-144ms` for tenant requests after a shared warm-up). What
// the tenant pass removes is the first-request server-render cost per tenant
// (measured 0.7-1.3s of application-code time, dropping to 0.1-0.3s once warm).
// Tenant requests need a Host header, which the fetch API deliberately ignores —
// so every request here goes through node:http, which lets us set Host.
//
// WHY THE PASS IS ADAPTIVE
//
// A full pass is 5 shared routes + 12 tenants x 2 routes = 29 requests. On an
// idle box that takes ~9-19s, but on a saturated host it was measured at
// 505.8s: eight and a half minutes of extra requests piled onto a machine that
// was already struggling, competing with the very visitors the warmer exists to
// serve. So the pass now:
//
//   * walks the queue in value order — every shared entry point first, then ONE
//     route across every tenant before any tenant's second route. A stop part-way
//     through therefore still leaves every tenant's most valuable page warm,
//     instead of leaving three tenants fully warm and nine cold;
//   * within a tenant tier, warms the routes already measured as cheapest first,
//     so more of the queue completes before anything forces a stop;
//   * reads the host's 1-minute load average before the pass and before every
//     request, and stops early once it crosses the contended threshold: a
//     contended host gets the shared entry points plus a small slice of tenants,
//     a severely contended one gets the first WARMUP_MIN_ROUTES shared routes;
//   * orders the routes inside a tenant tier by need — never warmed first, then
//     least recently warmed — so a long busy spell still covers every tenant's
//     landing page instead of re-warming the same two forever. Backing off must
//     delay the tenant pass, not silently cancel it. Measured cost was tried as
//     the within-tier order first and it does not converge: the order shifts as
//     costs are learned, so tenants that were never reached stay at the back
//     while the same cheap ones get re-warmed pass after pass;
//   * retries whatever it deferred after WARMUP_BACKOFF_SECONDS instead of
//     sleeping out the full refresh interval, so a busy spell delays the rest of
//     the warming rather than cancelling it.
//
// Configuration (all optional):
//   WARMUP_BASE_URL          default: http://frontend:3000
//   WARMUP_ROUTES            default: / /sign-in /forgot-password /dashboard /hivedocs
//                            (this order is the value order: earlier = warmer sooner)
//   WARMUP_TENANT_HOSTS      space-separated tenant hosts, default: none
//                            e.g. "techive.localhost afya-clinic.localhost"
//   WARMUP_TENANT_ROUTES     default: / /dashboard — the first route is warmed
//                            across ALL hosts before the second one starts
//   WARMUP_REFRESH_SECONDS   default: 300
//   WARMUP_TIMEOUT_MS        per-request timeout, default: 180000
//   WARMUP_READY_TIMEOUT_MS  how long to wait for the dev server, default: 300000
//   WARMUP_PROBE_SECONDS     how often to check the dev server is alive,
//                            default: 10 — this is what lets the warmer
//                            notice a restart instead of sleeping through it
//   WARMUP_PROBE_TIMEOUT_MS  timeout for that liveness probe, default: 5000.
//                            NOTE: read in SECONDS despite the name, so 5000
//                            means 5000s. A passing 8000 here once let a single
//                            stalled socket hang the loop.
//   WARMUP_PROBE_FAILURES    consecutive failed probes that mean the dev
//                            server restarted, default: 2
//   WARMUP_COLD_THRESHOLD_MS what counts as a slow request, default: 2000ms
//                            (informational only; it changes nothing about
//                            which routes get warmed)
//   WARMUP_LOAD_BACKOFF      what counts as a contended host, in 1-minute load
//                            average, default: 1.5 x CPU count (6 on a 4-core box)
//   WARMUP_LOAD_SEVERE       load average at which only WARMUP_MIN_ROUTES are
//                            warmed, default: 2 x WARMUP_LOAD_BACKOFF
//   WARMUP_MIN_ROUTES        requests still warmed when severely contended,
//                            default: 2 (the first, highest-value shared routes)
//   WARMUP_CONTENDED_REQUESTS
//                            tenant requests still warmed when only contended,
//                            default: 2. Successive passes work through the
//                            least-recently-warmed tenants, so a long busy
//                            spell still covers every tenant.
//                            0 = a contended host gets the shared routes only.
//   WARMUP_PROBE_BACKOFF_MS  a liveness probe slower than this also counts as a
//                            contended host, default: 3000. MILLISECONDS — not
//                            seconds like the _TIMEOUT_MS settings above
//   WARMUP_BACKOFF_SECONDS   when a pass is cut short, how soon to retry the
//                            routes it deferred, default: 60
//
// A note on "slow": the dev server reports compile time (next.js) separately
// from application-code time, and a slow request here is usually not a
// recompile. Under host memory pressure the application-code share alone has
// been measured at 10s+ while next.js reported ~15ms for the same request.
// That is also why contention is judged from the load average and not from how
// long a request took: a genuinely cold route compiles slowly too, and aborting
// the pass for that would strand the warming exactly when it is needed.
import http from "node:http";
import os from "node:os";
import { writeFileSync } from "node:fs";

const HEARTBEAT = "/tmp/warmup-heartbeat";
const BASE_URL = new URL(process.env.WARMUP_BASE_URL ?? "http://frontend:3000");
const ROUTES = list("WARMUP_ROUTES", ["/", "/sign-in", "/forgot-password", "/dashboard", "/hivedocs"]);
const TENANT_HOSTS = list("WARMUP_TENANT_HOSTS", []);
const TENANT_ROUTES = list("WARMUP_TENANT_ROUTES", ["/", "/dashboard"]);
const REFRESH_MS = seconds("WARMUP_REFRESH_SECONDS", 300) * 1000;
const REQUEST_TIMEOUT_MS = seconds("WARMUP_TIMEOUT_MS", 180) * 1000;
const READY_TIMEOUT_MS = seconds("WARMUP_READY_TIMEOUT_MS", 300) * 1000;
const COLD_THRESHOLD_MS = seconds("WARMUP_COLD_THRESHOLD_MS", 2) * 1000;
const PROBE_MS = seconds("WARMUP_PROBE_SECONDS", 10) * 1000;
const PROBE_TIMEOUT_MS = seconds("WARMUP_PROBE_TIMEOUT_MS", 5) * 1000;
const PROBE_FAILURES = integer("WARMUP_PROBE_FAILURES", 2);
const MAX_REDIRECTS = 5;

const CPU_COUNT = Math.max(1, os.cpus()?.length ?? 1);
const LOAD_BACKOFF = number("WARMUP_LOAD_BACKOFF", CPU_COUNT * 1.5);
const LOAD_SEVERE = number("WARMUP_LOAD_SEVERE", LOAD_BACKOFF * 2);
const MIN_ROUTES_WHEN_SEVERE = integer("WARMUP_MIN_ROUTES", 2);
const CONTENDED_TENANT_REQUESTS = count("WARMUP_CONTENDED_REQUESTS", 2);
// A real millisecond value, unlike the _TIMEOUT_MS settings above, which are
// read in seconds despite the name.
const PROBE_BACKOFF_MS = number("WARMUP_PROBE_BACKOFF_MS", 3000);
const BACKOFF_MS = seconds("WARMUP_BACKOFF_SECONDS", 60) * 1000;

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

function number(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Like integer(), except that 0 is meaningful: "when contended, warm nothing
// beyond the shared tier".
function count(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function log(message) {
  console.log(`${new Date().toISOString()} ${message}`);
}

// Touched at the start of every pass and after every route, so the container
// healthcheck can tell "loop is alive" from "loop wedged".
function heartbeat() {
  try {
    writeFileSync(HEARTBEAT, new Date().toISOString());
  } catch {
    /* best effort: the heartbeat must never break warming */
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One HTTP GET that drains the whole body. Draining matters: if the client hangs
// up early the dev server can cancel the very compile the request triggered.
function httpGet(path, host, timeoutMs) {
  return new Promise((resolve) => {
    const request = http.request(
      {
        host: BASE_URL.hostname,
        port: BASE_URL.port || 80,
        path,
        method: "GET",
        // The Host header is the whole point of the tenant pass, and only
        // node:http lets us set it (fetch ignores it).
        headers: host ? { Host: host } : {},
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            location: response.headers.location,
            bytes: Buffer.concat(chunks).length,
          }),
        );
      },
    );

    request.on("error", (error) => resolve({ status: 0, error: error.message }));
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`no response within ${timeoutMs}ms`)));
    request.end();
  });
}

async function request(path, { host, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const started = Date.now();
  let target = path;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const result = await httpGet(target, host, timeoutMs);
    if (result.status === 0) {
      return { status: 0, ms: Date.now() - started, error: result.error ?? "no response" };
    }
    if (result.status >= 300 && result.status < 400 && result.location) {
      target = result.location;
      continue;
    }
    return { status: result.status, ms: Date.now() - started, bytes: result.bytes };
  }

  return { status: 0, ms: Date.now() - started, error: `more than ${MAX_REDIRECTS} redirects` };
}

async function waitForServer() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts += 1;
    // Keep this warmer's own heartbeat fresh while the frontend is away: the
    // frontend's healthcheck already reports that outage, and the warmer
    // should not be flagged for a fault that is not its own.
    heartbeat();
    const probe = await request("/health", { timeoutMs: 10000 });
    if (probe.status > 0) {
      log(`dev server answered GET /health with ${probe.status} after ${attempts} probe(s)`);
      return true;
    }
    if (attempts === 1 || attempts % 5 === 0) {
      log(`waiting for the dev server at ${BASE_URL.origin} (attempt ${attempts})`);
    }
    await sleep(2000);
  }

  log(`dev server did not answer within ${READY_TIMEOUT_MS / 1000}s; continuing to retry`);
  return false;
}

const taskKey = (task) => `${task.host ?? "-"} ${task.path}`;

// When each route was last warmed. A constrained pass only reaches the front of
// a tier, so this — and not the route's measured cost — decides which tenants get
// warmed on a busy host. Ordering by measured cost was tried first and does not
// converge: the order shifts as costs are learned, so tenants that were never
// reached stay at the back while the same cheap ones get re-warmed pass after
// pass. Ordering by need makes every constrained pass advance coverage instead.
const lastWarmedAt = new Map();

// The queue, in the order to warm it. Tier 0 is the shared entry points, in the
// order they were configured — that order IS the value ranking, and these are
// also the cheapest to keep warm, being what every visitor hits and what real
// traffic already keeps hot. Each following tier is one tenant route across
// every host, so an early stop never leaves a tenant without its most valuable
// page. Inside a tier the least-recently-warmed routes come first, and routes
// that have never been warmed at all come before those.
function buildQueue() {
  const queue = ROUTES.map((path) => ({ path, host: undefined, tier: 0 }));

  TENANT_ROUTES.forEach((path, index) => {
    const tier = index + 1;
    const tasks = TENANT_HOSTS.map((host) => ({ path, host, tier }));
    tasks.sort((a, b) => (lastWarmedAt.get(taskKey(a)) ?? 0) - (lastWarmedAt.get(taskKey(b)) ?? 0));
    queue.push(...tasks);
  });

  return queue;
}

// What the host looks like right now. Deliberately built from the load average
// plus how the liveness probe just behaved, NOT from how long a route request
// took: a cold route compiles slowly for reasons that have nothing to do with
// contention, and treating that as contention would abort the pass precisely
// when a cold cache needs it most.
function contention() {
  const load = os.loadavg()[0];

  if (load >= LOAD_SEVERE) return { level: "severe", load, why: `load ${load.toFixed(1)} >= ${LOAD_SEVERE}` };
  if (load >= LOAD_BACKOFF) return { level: "contended", load, why: `load ${load.toFixed(1)} >= ${LOAD_BACKOFF}` };
  if (lastProbeMs !== null && lastProbeMs >= PROBE_BACKOFF_MS) {
    return { level: "contended", load, why: `probe ${lastProbeMs}ms >= ${PROBE_BACKOFF_MS}ms` };
  }
  return { level: "ok", load, why: `load ${load.toFixed(1)} < ${LOAD_BACKOFF}` };
}

let lastProbeMs = null;

// Warms one route for one host; returns how long it took and whether that was
// slow enough (>= WARMUP_COLD_THRESHOLD_MS) that a human would have noticed.
async function warmRoute(path, host) {
  const result = await request(path, { host });
  heartbeat();

  if (result.status === 0) {
    return { ok: false, ms: result.ms, text: `${path} FAILED after ${(result.ms / 1000).toFixed(1)}s (${result.error})` };
  }

  const elapsed = (result.ms / 1000).toFixed(1);
  const slow = result.ms >= COLD_THRESHOLD_MS;
  return {
    ok: result.status < 400,
    slow,
    ms: result.ms,
    text: `${path} ${result.status} in ${elapsed}s${slow ? " (slow)" : ""}`,
  };
}

// One adaptive pass. Returns how much of the queue it warmed and whether it
// stopped early, so the caller can decide when to come back.
async function warmPass(reason) {
  heartbeat();
  const started = Date.now();
  const queue = buildQueue();
  const sharedCount = Math.min(ROUTES.length, queue.length);

  const opening = contention();
  let allowed = queue.length;
  if (opening.level === "severe") allowed = Math.min(allowed, MIN_ROUTES_WHEN_SEVERE);
  else if (opening.level === "contended") allowed = Math.min(allowed, sharedCount + CONTENDED_TENANT_REQUESTS);

  log(
    `${reason}: ${queue.length} request(s) queued (${sharedCount} shared + ${queue.length - sharedCount} tenant) — host ${opening.level} (${opening.why})`,
  );

  let warmed = 0;
  let slow = 0;
  let failures = 0;
  let stopWhy = null;
  let tier = null;
  let tierLabel = "";
  let tierParts = [];

  const flushTier = () => {
    if (tierParts.length) log(`  ${tierLabel}: ${tierParts.join(" · ")}`);
    tierParts = [];
  };

  for (let index = 0; index < queue.length; index += 1) {
    const task = queue[index];

    if (index > 0) {
      // Re-checked before every request: the machine can become contended while
      // the pass is running, and the whole point is to stop adding to it.
      const now = contention();
      if (now.level === "severe") allowed = Math.min(allowed, Math.max(index, MIN_ROUTES_WHEN_SEVERE));
      else if (now.level === "contended") {
        allowed = Math.min(allowed, Math.max(index, sharedCount + CONTENDED_TENANT_REQUESTS));
      }
      if (index >= allowed) {
        stopWhy = now.why;
        break;
      }
    } else if (index >= allowed) {
      stopWhy = opening.why;
      break;
    }

    if (task.tier !== tier) {
      flushTier();
      tier = task.tier;
      tierLabel = tier === 0 ? "shared" : `tenant ${task.path}`;
    }

    const result = await warmRoute(task.path, task.host);
    // Recorded on any attempt, so a route that answers slowly or fails is not
    // retried ahead of the ones that have been waiting longer.
    lastWarmedAt.set(taskKey(task), Date.now());
    if (result.slow) slow += 1;
    if (!result.ok) failures += 1;
    warmed += 1;
    tierParts.push(task.host ? `${task.host} ${result.text}` : result.text);
  }

  flushTier();

  const total = ((Date.now() - started) / 1000).toFixed(1);
  const deferred = queue.length - warmed;
  const parts = [`${warmed} of ${queue.length} request(s) in ${total}s`, slow ? `${slow} slow` : "all already fast"];
  if (failures) parts.push(`${failures} FAILED`);
  if (deferred) {
    parts.push(`backed off (${stopWhy ?? "contention"}) — ${deferred} deferred, retry in ${BACKOFF_MS / 1000}s`);
  }
  log(`${reason}: ${parts.join(", ")}`);

  return { warmed, deferred, slow, failures, ms: Date.now() - started };
}

process.on("SIGTERM", () => {
  log("received SIGTERM, exiting");
  process.exit(0);
});
heartbeat();
log(
  `prewarming ${BASE_URL.origin} — shared: ${ROUTES.join(" ")}` +
    (TENANT_HOSTS.length ? ` — tenants: ${TENANT_HOSTS.join(" ")} (${TENANT_ROUTES.join(" ")})` : " — no tenant hosts configured") +
    ` — refresh every ${REFRESH_MS / 1000}s, backing off above load ${LOAD_BACKOFF} (${CPU_COUNT} cpu)`,
);
// The loop watches the dev server rather than only sleeping between
// refreshes. A frontend restart rebuilds the Next dev cache (see
// hive-os-frontend/docker-entrypoint.sh), so warming has to follow the
// restart rather than the clock. A restarting frontend is unreachable for
// ~75s — npm ci check, then the dev server's own boot — which is far longer
// than the probe interval, so a restart cannot slip between two probes.
let firstPass = true;
let nextPassAt = 0;
let failures = 0;

for (;;) {
  const probe = await request("/health", { timeoutMs: PROBE_TIMEOUT_MS });

  if (probe.status === 0) {
    failures += 1;
    // A stopped container drops packets rather than refusing them, so this
    // arrives as a timeout as often as a connection error — which is why a
    // single failure is not enough to call it: /health has been measured at
    // 11.6s under load. Logged every time so a silent retry loop cannot hide
    // a missed restart again.
    log(
      `probe ${failures}/${PROBE_FAILURES} failed (${probe.error ?? `status ${probe.status}`})`,
    );
  } else {
    failures = 0;
    lastProbeMs = probe.ms;
  }

  if (failures >= PROBE_FAILURES) {
    failures = 0;
    log(firstPass ? "waiting for the dev server to start" : "restart detected — warming as soon as it answers");
    await waitForServer();
    const pass = await warmPass(firstPass ? "startup pass" : "frontend restart detected");
    firstPass = false;
    nextPassAt = Date.now() + (pass.deferred ? BACKOFF_MS : REFRESH_MS);
  } else if (failures === 0 && (firstPass || Date.now() >= nextPassAt)) {
    const pass = await warmPass(firstPass ? "startup pass" : "periodic refresh");
    firstPass = false;
    nextPassAt = Date.now() + (pass.deferred ? BACKOFF_MS : REFRESH_MS);
  }

  await sleep(PROBE_MS);
}
