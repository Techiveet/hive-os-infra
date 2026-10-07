#!/usr/bin/env node
//
// test-prewarm-backend.mjs — the acceptance test for scripts/prewarm-backend.mjs:
// the central surface AND its per-tenant adaptive tier.
//
// The warmer is normally driven by the real Octane backend, whose token shape,
// throttling, and per-worker cold cost cannot be reproduced at will. So this
// harness starts a FAKE backend (a node http server with scripted latencies),
// runs the real warmer as a child process, and asserts on what is actually
// observable: which requests the warmer made — including the Host header each
// carried and which bearer token reused which login — and the lines it logged.
// Nothing inside the warmer is stubbed.
//
//   node scripts/test-prewarm-backend.mjs
//
// Exits non-zero if any case fails.
//
// What is deliberately NOT asserted: the exact order inside the central tiers.
// The public/auth bursts run with WARMUP_CONCURRENCY in flight, so their
// interleaving is scheduler-dependent; the tenant tier, however, is strictly
// sequential, which is why the tenant slices are asserted exactly.
//
// Proving the test can fail: copy the scripts directory, and in the copy make
// tenantContention() report "ok" unconditionally (prefix each of its three
// return conditions with `false &&`). The four contention cases then fail and
// the file exits 1 — a contract test nobody has ever seen fail proves nothing.
// WARMER_CONTRACT_CHECK in scripts/healthcheck.sh runs this file for exactly
// that reason.
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WARMER = path.join(HERE, "prewarm-backend.mjs");
const PUBLIC_ROUTES = ["/up", "/api/v1/languages/public"];
const AUTH_ROUTES = ["/api/v1/dashboard", "/api/v1/settings/general/runtime"];
const HOSTS = ["a.localhost", "b.localhost", "c.localhost"];
const TENANT_ROUTES = ["/api/v1/dashboard"];
const LOGIN_PATH = "/api/v1/tenant/login";
// What a merely-contended pass still warms when nothing else is configured.
const CONTENDED_SLICE = 2;
// The fake keeps the same serial per host for every pass, so a token reused
// across passes must stay `token-<host>-<serial>`; a re-login would mint the
// SAME string (serial is host-stable), which is why cases that re-login must
// count logins rather than compare tokens. Serial-per-host keeps both checks
// distinct and meaningful.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(100);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

// A backend that records every request in order — central requests keyed by
// their URL, tenant requests by Host+URL — and answers after a scripted delay.
// POST /api/v1/login and POST /api/v1/tenant/login mint tokens: per host for
// tenant logins (stable serial), a single serial for central. No 401 is ever
// emitted, so every login succeeds exactly once per host unless a case proves
// otherwise through the login counts.
function startFake({ delay = () => 10 } = {}) {
  const state = { requests: [], tokens: new Map(), emails: [], nextToken: 1, pass: 0 };

  const server = http.createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    const host = req.headers.host ?? "";
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const isCentralLogin = url === "/api/v1/login" && req.method === "POST";
      const isTenantLogin = url === LOGIN_PATH && req.method === "POST" && host.endsWith(".localhost");
      const wait = delay(host, url);
      state.requests.push({
        url,
        host,
        method: req.method,
        auth: req.headers.authorization ?? "",
        pass: state.pass,
      });

      const respond = (status, payload) => {
        setTimeout(() => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        }, wait);
      };

      if (isCentralLogin) {
        const serial = state.nextToken++;
        state.tokens.set("central", serial);
        state.tokens.set("central#count", (state.tokens.get("central#count") ?? 0) + 1);
        respond(200, { message: "ok", data: { token: `central-token-${serial}` } });
        return;
      }
      if (isCentralLogin) {
        const serial = state.nextToken++;
        state.tokens.set("central", serial);
        state.tokens.set("central#count", (state.tokens.get("central#count") ?? 0) + 1);
        respond(200, { message: "ok", data: { token: `central-token-${serial}` } });
        return;
      }
      if (isTenantLogin) {
        // Who is logging in: recorded, so a case can assert the warmer's
        // email mapping (admin@<tenant-id>.com by default, overrides for the
        // hosts that break that pattern).
        try {
          state.emails.push({ host, email: String(JSON.parse(body).email ?? "") });
        } catch {
          state.emails.push({ host, email: "(unparseable)" });
        }
        const count = state.tokens.get(`${host}#count`) ?? 0;
        state.tokens.set(`${host}#count`, count + 1);
        if (count === 0) {
          const serial = state.nextToken++;
          state.tokens.set(host, serial);
        }
        respond(200, { message: "ok", data: { token: `token-${host}-${state.tokens.get(host)}` } });
        return;
      }
      state.tokens.set(`${host}#${url}#count`, (state.tokens.get(`${host}#${url}#count`) ?? 0) + 1);
      respond(200, { message: "ok" });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        state,
        // Called when a new pass summary appears in the warmer's output, so
        // requests can be attributed to the pass they belong to.
        advancePass: () => {
          state.pass += 1;
        },
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

const labelOf = (port) => (request) =>
  request.host.endsWith(".localhost")
    ? `${request.method} ${request.host} ${request.url}`
    : `${request.method} ${request.url}`;

const isTenantWarm = (request) => request.host.endsWith(".localhost") && request.url !== LOGIN_PATH;
const isTenantLogin = (request) => request.host.endsWith(".localhost") && request.url === LOGIN_PATH;

async function runCase(testCase) {
  const fake = await startFake(testCase);
  const child = spawn(process.execPath, [WARMER], {
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("WARMUP_"))),
      WARMUP_BACKEND_URL: `http://127.0.0.1:${fake.port}`,
      WARMUP_PUBLIC_ROUTES: PUBLIC_ROUTES.join(" "),
      WARMUP_AUTH_ROUTES: AUTH_ROUTES.join(" "),
      WARMUP_TENANT_HOSTS: HOSTS.join(" "),
      WARMUP_TENANT_ROUTES: TENANT_ROUTES.join(" "),
      WARMUP_PROBE_SECONDS: "1",
      WARMUP_REFRESH_SECONDS: "300",
      WARMUP_REQUESTS: "5",
      WARMUP_CONCURRENCY: "2",
      // Defaults stay out of the way; each case opts into the signal it tests.
      WARMUP_TENANT_LOAD_BACKOFF: "1000",
      WARMUP_TENANT_PROBE_BACKOFF_MS: "1000",
      WARMUP_TENANT_BACKOFF_SECONDS: "2",
      ...testCase.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let passesSeen = 0;
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  const pump = () => {
    const seen = (output.match(/pass took /g) ?? []).length;
    if (seen > passesSeen) {
      passesSeen = seen;
      fake.advancePass();
    }
  };

  try {
    await waitFor(
      () => {
        pump();
        return passesSeen >= (testCase.passes ?? 1);
      },
      25000,
      `${testCase.passes ?? 1} pass summary line(s)`,
    );
    // Let the pass finish writing its summary before the process is killed.
    await sleep(300);
  } finally {
    child.kill("SIGTERM");
    await new Promise((done) => child.once("exit", done));
    await fake.close();
  }

  const requests = fake.state.requests;
  const labels = requests.map(labelOf(fake.port));
  const problems = [];

  for (const needle of testCase.expect.logIncludes ?? []) {
    if (!output.includes(needle)) problems.push(`log did not include ${JSON.stringify(needle)}`);
  }
  for (const needle of testCase.expect.logExcludes ?? []) {
    if (output.includes(needle)) problems.push(`log unexpectedly included ${JSON.stringify(needle)}`);
  }

  if (testCase.expect.count !== undefined) {
    const warm = requests.filter(isTenantWarm);
    if (warm.length !== testCase.expect.count) {
      problems.push(
        `expected ${testCase.expect.count} tenant warm request(s), saw ${warm.length}: ${warm.map(labelOf(fake.port)).join(", ")}`,
      );
    }
  }

  for (const check of testCase.expect.loginCounts ?? []) {
    const logins = requests.filter(isTenantLogin).filter((r) => r.host === check.host).length;
    const min = check.min ?? 0;
    const max = check.max ?? Number.POSITIVE_INFINITY;
    if (logins < min || logins > max) {
      problems.push(`${check.host}: expected ${min}..${max} login(s), saw ${logins}`);
    }
  }

  // Which email the warmer signed each host in with — the credential mapping
  // (TenantUsersSeeder's admin@<tenant-id>.com + per-host overrides) is part of
  // the contract: silently warming the wrong account would still return 200s.
  for (const check of testCase.expect.loginsAs ?? []) {
    const entries = fake.state.emails.filter((e) => e.host === check.host);
    if (!entries.length) {
      problems.push(`expected a login for ${check.host}, saw none`);
    } else if (entries.some((e) => e.email !== check.email)) {
      problems.push(`${check.host}: expected all logins as ${check.email}, saw: ${entries.map((e) => e.email).join(", ")}`);
    }
  }

  // The central auth tier must carry the token the central login minted — a
  // header-plumbing regression shows up on the real stack as "auth … FAILED"
  // and a stray 401-report line on every pass.
  for (const check of testCase.expect.centralAuthOn ?? []) {
    const hits = requests.filter(
      (r) => r.url === check.path && r.method === "GET" && r.pass === check.passIndex && !r.host.endsWith(".localhost"),
    );
    if (!hits.length) {
      problems.push(`expected a central ${check.path} request in pass ${check.passIndex + 1}, saw none`);
      continue;
    }
    const got = hits[0].auth.replace(/^Bearer /, "") || "(none)";
    const want = check.token(fake);
    if (got !== want) problems.push(`central ${check.path}: expected bearer ${want}, saw ${got}`);
  }

  // Which bearer token was presented on the tenant warm requests of a given
  // pass: check(host, passIndex) must return the token string every request of
  // that host in that pass carried, or null if there should be none.
  for (const check of testCase.expect.tokenOn ?? []) {
    const hits = requests.filter(
      (r) => isTenantWarm(r) && r.host === check.host && r.pass === check.passIndex,
    );
    if (!hits.length) {
      problems.push(`expected a warm request for ${check.host} in pass ${check.passIndex + 1}, saw none`);
      continue;
    }
    const got = hits[0].auth.replace(/^Bearer /, "") || "(none)";
    const want = check.token(fake);
    if (got !== want) {
      problems.push(`${check.host} pass ${check.passIndex + 1}: expected bearer ${want}, saw ${got}`);
    }
  }

  for (const [passIndex, expected] of (testCase.expect.tenantPasses ?? []).entries()) {
    const actual = requests
      .filter((r) => r.pass === passIndex && isTenantWarm(r))
      .map((r) => `${r.host} ${r.url}`);
    if (actual.join(" | ") !== expected.join(" | ")) {
      problems.push(
        `tenant slice of pass ${passIndex + 1} mismatch\n      expected: ${expected.join(" | ")}\n      actual:   ${actual.join(" | ")}`,
      );
    }
  }

  return { name: testCase.name, problems, output, labels };
}

const tokenOfHost = (fake, host) => `token-${host}-${fake.state.tokens.get(host)}`;

const load = os.loadavg()[0];
// A threshold below the host's current load makes "this box counts as
// contended" true without needing to actually load the machine.
const contendedLoad = (load * 0.5).toFixed(4);
const severeLoad = (load * 0.5).toFixed(4);

const cases = [
  {
    name: "idle: one login per host, one dashboard per host, in configured order",
    env: {},
    expect: {
      loginsAs: [
        { host: "a.localhost", email: "admin@a.com" },
        { host: "b.localhost", email: "admin@b.com" },
        { host: "c.localhost", email: "admin@c.com" },
      ],
      tenantPasses: [
        ["a.localhost /api/v1/dashboard", "b.localhost /api/v1/dashboard", "c.localhost /api/v1/dashboard"],
      ],
      tokenOn: [
        { host: "a.localhost", passIndex: 0, token: (fake) => tokenOfHost(fake, "a.localhost") },
        { host: "b.localhost", passIndex: 0, token: (fake) => tokenOfHost(fake, "b.localhost") },
        { host: "c.localhost", passIndex: 0, token: (fake) => tokenOfHost(fake, "c.localhost") },
      ],
      loginCounts: [
        { host: "a.localhost", min: 1, max: 1 },
        { host: "b.localhost", min: 1, max: 1 },
        { host: "c.localhost", min: 1, max: 1 },
      ],
      centralAuthOn: [
        { path: AUTH_ROUTES[0], passIndex: 0, token: (fake) => `central-token-${fake.state.tokens.get("central")}` },
        { path: AUTH_ROUTES[1], passIndex: 0, token: (fake) => `central-token-${fake.state.tokens.get("central")}` },
      ],
      logIncludes: [
        "tenant tier: 3 host(s) via /api/v1/tenant/login",
        "tenants 3 of 3",
        "tenant tier complete — 3 of 3 warmed",
      ],
      logExcludes: ["backed off", "refused", "FAILED"],
    },
  },
  load > 0.05
    ? {
        name: `contended (threshold ${contendedLoad} < current ${load.toFixed(2)}): central tiers plus ${CONTENDED_SLICE} tenant logins`,
        env: {
          WARMUP_TENANT_LOAD_BACKOFF: contendedLoad,
          WARMUP_TENANT_LOAD_SEVERE: (load * 10).toFixed(4),
        },
        expect: {
          count: CONTENDED_SLICE,
          loginsAs: [
            { host: "a.localhost", email: "admin@a.com" },
            { host: "b.localhost", email: "admin@b.com" },
          ],
          tenantPasses: [["a.localhost /api/v1/dashboard", "b.localhost /api/v1/dashboard"]],
          loginCounts: [
            { host: "a.localhost", min: 1, max: 1 },
            { host: "b.localhost", min: 1, max: 1 },
            { host: "c.localhost", min: 0, max: 0 },
          ],
          logIncludes: [
            "host contended (load",
            "capped at 2",
            "tenant tier backed off (load",
            "deferred, retry in",
          ],
        },
      }
    : null,
  load > 0.05
    ? {
        name: "contended across 3 passes: least-recently-warmed hosts rotate, every tenant reached",
        passes: 3,
        env: {
          WARMUP_TENANT_LOAD_BACKOFF: contendedLoad,
          WARMUP_TENANT_LOAD_SEVERE: (load * 10).toFixed(4),
          WARMUP_TENANT_REQUESTS: "2",
        },
        expect: {
          count: 3 * CONTENDED_SLICE,
          tenantPasses: [
            ["a.localhost /api/v1/dashboard", "b.localhost /api/v1/dashboard"],
            ["c.localhost /api/v1/dashboard", "a.localhost /api/v1/dashboard"],
            ["b.localhost /api/v1/dashboard", "c.localhost /api/v1/dashboard"],
          ],
          // a.localhost signed in on pass 1; its pass-2 dashboard rides the SAME
          // token — only 2 login hurdles total (a on pass 1, c on pass 2).
          tokenOn: [
            { host: "a.localhost", passIndex: 0, token: (fake) => tokenOfHost(fake, "a.localhost") },
            { host: "a.localhost", passIndex: 1, token: (fake) => tokenOfHost(fake, "a.localhost") },
          ],
          loginCounts: [
            { host: "a.localhost", min: 1, max: 1 },
            { host: "c.localhost", min: 1, max: 1 },
          ],
          logIncludes: ["host contended (load", "capped at 2"],
        },
      }
    : null,
  load > 0.05
    ? {
        name: "severely contended: central tiers only, zero tenant logins",
        env: {
          WARMUP_TENANT_LOAD_BACKOFF: severeLoad,
          WARMUP_TENANT_LOAD_SEVERE: severeLoad,
        },
        expect: {
          count: 0,
          loginCounts: [{ host: "a.localhost", min: 0, max: 0 }],
          logIncludes: ["host severe (load", "tier skipped"],
        },
      }
    : null,
  load > 0.05
    ? {
        name: "contended by probe latency: the slow liveness probe caps the tier too",
        env: { WARMUP_TENANT_PROBE_BACKOFF_MS: "50" },
        delay: (_host, url) => (url === "/up" ? 200 : 10),
        expect: {
          count: CONTENDED_SLICE,
          logIncludes: ["host contended (probe ", "capped at 2", "tenant tier backed off (probe "],
        },
      }
    : null,
  {
    name: "WARMUP_SKIP_AUTH=1: public tier only; no tenant logins or warm requests",
    env: { WARMUP_SKIP_AUTH: "1" },
    expect: {
      count: 0,
      loginCounts: [{ host: "a.localhost", min: 0, max: 0 }],
      // The summary proves the tier was not driven: "tenants 0 of 3" with no
      // tenant login line anywhere (skip-auth skips the login AND the tier).
      logIncludes: ["tenants 0 of 3"],
      logExcludes: ["tenant login", "refused", "POST /api/v1/login"],
    },
  },
].filter(Boolean);

let failed = 0;
console.log(`fake backend on 127.0.0.1, host 1-minute load average ${load.toFixed(2)}\n`);

for (const testCase of cases) {
  let result;
  try {
    result = await runCase(testCase);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${testCase.name}\n      ${error.message}`);
    continue;
  }

  if (result.problems.length === 0) {
    console.log(`PASS  ${testCase.name}\n      ${result.labels.length} request(s): ${result.labels.join(", ")}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${testCase.name}\n      ${result.problems.join("\n      ")}`);
  }
}

console.log(`\n${cases.length - failed}/${cases.length} case(s) passed`);
process.exit(failed ? 1 : 0);
