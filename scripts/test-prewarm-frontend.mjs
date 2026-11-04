#!/usr/bin/env node
//
// test-prewarm-frontend.mjs — the acceptance test for the adaptive pass logic in
// scripts/prewarm-frontend.mjs.
//
// The warmer is normally driven by a real Next dev server on a real host, which
// makes "did it stop early because the box was contended?" impossible to assert
// reproducibly. So this harness starts a FAKE frontend whose per-route latency
// it controls, runs the real warmer against it as a child process, and asserts
// on two things that are actually observable: the exact sequence of requests the
// warmer made, and the lines it logged. Nothing is stubbed inside the warmer.
//
//   node scripts/test-prewarm-frontend.mjs
//
// Exits non-zero if any case fails.
//
// Proving the test can fail: copy the scripts directory, and in the copy make
// contention() report "ok" unconditionally (prefix each of its three return
// conditions with `false &&`). Running this file from that copy fails five of the
// six cases and exits 1 — a contract test nobody has ever seen fail proves
// nothing. WARMER_CONTRACT_SCRIPTS in scripts/healthcheck.sh exists for that.
import http from "node:http";
import os from "node:os";
import { readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WARMER = path.join(HERE, "prewarm-frontend.mjs");
const ROUTES = ["/", "/sign-in", "/dashboard"];
const HOSTS = ["a.localhost", "b.localhost", "c.localhost"];
const TENANT_ROUTES = ["/", "/dashboard"];
const TOTAL = ROUTES.length + HOSTS.length * TENANT_ROUTES.length; // 9
// WARMUP_CONTENDED_REQUESTS default: how many tenant requests a merely contended
// host still warms, on top of the shared tier.
const CONTENDED_SLICE = 2;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(100);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

// A frontend that records every request it is asked to serve, in order, and
// answers after a scripted delay. Node's real http server is used (not a raw
// socket) so keep-alive behaves exactly as it does against `next dev`.
function startFake({ healthDelay = () => 0, delay = () => 10, refuseFor = {} }) {
  const state = { requests: [], pass: 0 };

  const server = http.createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    const host = req.headers.host ?? "";
    const wait = url === "/health" ? healthDelay() : delay(host, url);
    state.requests.push({ url, host, wait, pass: state.pass });
    // Scripted 401s for the alert-hook cases: host -> true (refuse every
    // warm request) or a pass count (refuse while the pass index is below
    // it), so a case can walk the warmer through consecutive refusals and
    // then a recovery — the broken-tenant lifecycle the marker file surfaces.
    const refuse = refuseFor[host] !== undefined && (refuseFor[host] === true || state.pass < refuseFor[host]);
    setTimeout(() => {
      res.writeHead(refuse ? 401 : 200, { "content-type": "text/html" });
      res.end(refuse ? "Unauthorized" : "<html><body>ok</body></html>");
    }, wait);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        state,
        // Called by the runner when a pass summary appears in the warmer's
        // output, so each recorded request can be attributed to a pass.
        advancePass: () => {
          state.pass += 1;
        },
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

const labelOf = (port) => (request) =>
  request.host === `127.0.0.1:${port}` ? `shared ${request.url}` : `${request.host} ${request.url}`;

async function runCase(testCase) {
  // Fresh marker-file state per run: the alert cases point WARMUP_TENANT_ALERT_FILE
  // at their own /tmp path, and a leftover marker from an earlier run would lie.
  for (const check of testCase.expect.alertFile ?? []) {
    try { unlinkSync(check.path); } catch { /* not there — fine */ }
  }
  const fake = await startFake(testCase);
  const child = spawn(process.execPath, [WARMER], {
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("WARMUP_"))),
      WARMUP_BASE_URL: `http://127.0.0.1:${fake.port}`,
      WARMUP_ROUTES: ROUTES.join(" "),
      WARMUP_TENANT_HOSTS: HOSTS.join(" "),
      WARMUP_TENANT_ROUTES: TENANT_ROUTES.join(" "),
      WARMUP_PROBE_SECONDS: "1",
      WARMUP_REFRESH_SECONDS: "300",
      // Never let the probe-sized load default or the probe-latency default
      // interfere with a case: each case opts in to the signal it tests.
      WARMUP_LOAD_BACKOFF: "1000",
      WARMUP_PROBE_BACKOFF_MS: "1000",
      ...testCase.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let passesSeen = 0;
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  const pump = () => {
    const seen = (output.match(/request\(s\) in /g) ?? []).length;
    if (seen > passesSeen) {
      passesSeen = seen;
      fake.advancePass();
    }
  };

  try {
    await waitFor(
      () => {
        pump();
        // When waitForLog is set it is the ONLY finish condition; the pass
        // fallback would otherwise kill the child mid-scenario.
        return testCase.waitForLog ? output.includes(testCase.waitForLog) : passesSeen >= (testCase.passes ?? 1);
      },
      25000,
      testCase.waitForLog ? `log line ${JSON.stringify(testCase.waitForLog)}` : `${testCase.passes ?? 1} warm pass summary line(s)`,
    );
    // Let the pass finish writing the rest of its output.
    await sleep(300);
  } catch (error) {
    // Surface what the child actually did before the wait gave up.
    throw new Error(
      `${error.message}\n      child output tail:\n${output.split("\n").slice(-12).map((l) => `        ${l}`).join("\n")}`,
    );
  } finally {
    child.kill("SIGTERM");
    await new Promise((done) => child.once("exit", done));
    await fake.close();
  }

  const labels = fake.state.requests.filter((request) => request.url !== "/health").map(labelOf(fake.port));
  const problems = [];

  if (testCase.expect.count !== undefined && labels.length !== testCase.expect.count) {
    problems.push(`expected ${testCase.expect.count} route request(s), saw ${labels.length}: ${labels.join(", ")}`);
  }

  if (testCase.expect.order) {
    const actual = fake.state.requests
      .filter((request) => request.url !== "/health")
      .map(labelOf(fake.port));

    if (actual.join(" | ") !== testCase.expect.order.join(" | ")) {
      problems.push(`order mismatch\n      expected: ${testCase.expect.order.join(" | ")}\n      actual:   ${actual.join(" | ")}`);
    }
  }

  for (const [passIndex, expected] of (testCase.expect.tenantPasses ?? []).entries()) {
    const actual = fake.state.requests
      .filter((request) => request.url !== "/health" && request.pass === passIndex && request.host !== `127.0.0.1:${fake.port}`)
      .map((request) => `${request.host} ${request.url}`);

    if (actual.join(" | ") !== expected.join(" | ")) {
      problems.push(
        `tenant slice of pass ${passIndex + 1} mismatch\n      expected: ${expected.join(" | ")}\n      actual:   ${actual.join(" | ")}`,
      );
    }
  }

  for (const needle of testCase.expect.logIncludes ?? []) {
    if (!output.includes(needle)) problems.push(`log did not include ${JSON.stringify(needle)}`);
  }

  for (const needle of testCase.expect.logExcludes ?? []) {
    if (output.includes(needle)) problems.push(`log unexpectedly included ${JSON.stringify(needle)}`);
  }

  // The alert hook's observable output is a marker file in the warmer's own
  // filesystem (the same /tmp — the harness runs the real warmer as a child
  // process), asserted here after the child is gone.
  for (const check of testCase.expect.alertFile ?? []) {
    let content = null;
    try {
      content = readFileSync(check.path, "utf8");
    } catch {
      /* absent */
    }
    if (check.absent) {
      if (content !== null) {
        problems.push(`alert file ${check.path} unexpectedly exists: ${JSON.stringify(content)}`);
      }
    } else if (content === null) {
      problems.push(`expected alert file ${check.path}, saw none`);
    } else {
      for (const needle of check.includes ?? []) {
        if (!content.includes(needle)) problems.push(`alert file missing ${JSON.stringify(needle)}: ${JSON.stringify(content)}`);
      }
      for (const needle of check.excludes ?? []) {
        if (content.includes(needle)) problems.push(`alert file unexpectedly includes ${JSON.stringify(needle)}`);
      }
    }
    try { unlinkSync(check.path); } catch { /* already gone */ }
  }

  return { name: testCase.name, problems, output, labels };
}

const SHARED_THEN_BREADTH = [
  "shared /",
  "shared /sign-in",
  "shared /dashboard",
  "a.localhost /",
  "b.localhost /",
  "c.localhost /",
  "a.localhost /dashboard",
  "b.localhost /dashboard",
  "c.localhost /dashboard",
];

const load = os.loadavg()[0];
// A threshold below the host's current load is the whole point: it makes "this
// box counts as contended" true without needing to actually load the machine.
const contendedLoad = (load * 0.5).toFixed(4);
const severeLoad = (load * 0.5).toFixed(4);

const cases = [
  {
    name: "idle: full pass, value order (shared, then one route per tenant)",
    expect: {
      count: TOTAL,
      order: SHARED_THEN_BREADTH,
      logIncludes: [
        `${TOTAL} request(s) queued (${ROUTES.length} shared + ${HOSTS.length * TENANT_ROUTES.length} tenant) — host ok (load`,
        `${TOTAL} of ${TOTAL} request(s) in `,
        "all already fast",
      ],
      logExcludes: ["backed off"],
    },
  },
  load > 0.05
    ? {
        name: `contended by load (threshold ${contendedLoad} below current ${load.toFixed(2)}): shared routes + the tenant slice`,
        env: { WARMUP_LOAD_BACKOFF: contendedLoad, WARMUP_LOAD_SEVERE: (load * 10).toFixed(4) },
        expect: {
          count: ROUTES.length + CONTENDED_SLICE,
          order: SHARED_THEN_BREADTH.slice(0, ROUTES.length + CONTENDED_SLICE),
          logIncludes: [
            "host contended (load",
            `${ROUTES.length + CONTENDED_SLICE} of ${TOTAL} request(s) in `,
            "backed off (load ",
            `${TOTAL - ROUTES.length - CONTENDED_SLICE} deferred, retry in 60s`,
          ],
        },
      }
    : null,
  load > 0.05
    ? {
        name: "contended with WARMUP_CONTENDED_REQUESTS=0: shared entry points only",
        env: {
          WARMUP_LOAD_BACKOFF: contendedLoad,
          WARMUP_LOAD_SEVERE: (load * 10).toFixed(4),
          WARMUP_CONTENDED_REQUESTS: "0",
        },
        expect: {
          count: ROUTES.length,
          order: SHARED_THEN_BREADTH.slice(0, ROUTES.length),
          logIncludes: [`${ROUTES.length} of ${TOTAL} request(s) in `, "backed off (load "],
        },
      }
    : null,
  load > 0.05
    ? {
        name: "contended across passes: the least-recently-warmed tenants come first, so every tenant is reached",
        passes: 3,
        // The latencies only need to be distinct so the fake's answers differ;
        // the slice order asserted below comes from when each tenant was last
        // warmed, not from its cost.
        delay: (host) => (host.startsWith("a.") ? 10 : host.startsWith("b.") ? 60 : 120),
        env: {
          WARMUP_LOAD_BACKOFF: contendedLoad,
          WARMUP_LOAD_SEVERE: (load * 10).toFixed(4),
          WARMUP_BACKOFF_SECONDS: "2",
        },
        expect: {
          count: 3 * (ROUTES.length + CONTENDED_SLICE),
          // Three hosts, two warmed per pass: a,b then c,a then b,c. Warm the
          // same two every time and nine of twelve real tenants would never be
          // warmed while the box stayed busy. Derived from last-warmed time:
          // pass 1 has no history so the configured order stands; pass 2 puts the
          // never-warmed c first, then the stalest of a/b; pass 3 starts at b,
          // which pass 1 warmed first.
          tenantPasses: [
            ["a.localhost /", "b.localhost /"],
            ["c.localhost /", "a.localhost /"],
            ["b.localhost /", "c.localhost /"],
          ],
          logIncludes: [`${ROUTES.length + CONTENDED_SLICE} of ${TOTAL} request(s) in `, "host contended (load"],
        },
      }
    : null,
  {
    name: "severely contended: only WARMUP_MIN_ROUTES are warmed",
    env: { WARMUP_LOAD_BACKOFF: severeLoad, WARMUP_LOAD_SEVERE: severeLoad, WARMUP_MIN_ROUTES: "3" },
    expect: {
      count: 3,
      order: SHARED_THEN_BREADTH.slice(0, 3),
      logIncludes: ["host severe (load", `3 of ${TOTAL} request(s) in `, "backed off (load"],
    },
  },
  {
    name: "contended by a slow liveness probe: shared routes + the tenant slice",
    env: { WARMUP_PROBE_BACKOFF_MS: "50" },
    healthDelay: () => 200,
    expect: {
      count: ROUTES.length + CONTENDED_SLICE,
      order: SHARED_THEN_BREADTH.slice(0, ROUTES.length + CONTENDED_SLICE),
      logIncludes: ["host contended (probe ", "backed off (probe "],
    },
  },
  {
    // The alert hook: 401s across passes must end up in the marker file the
    // healthcheck surfaces. Pass cadence depends on cold detection and refresh
    // timing, so the finish is pinned to the ALERT log line, not a pass count.
    name: "alert hook: consecutive tenant 401s write the marker file with the host",
    refuseFor: { "a.localhost": true },
    waitForLog: "tenant warm ALERT: a.localhost has now answered 2 auth refusals",
    env: {
      WARMUP_REFRESH_SECONDS: "2",
      WARMUP_TENANT_ALERT_THRESHOLD: "2",
      WARMUP_TENANT_ALERT_FILE: "/tmp/prewarm-frontend-harness-alert-write",
    },
    expect: {
      logIncludes: ["tenant warm ALERT: a.localhost has now answered 2 auth refusals (401/403) in a row"],
      logExcludes: ["alert cleared"],
      alertFile: [
        {
          path: "/tmp/prewarm-frontend-harness-alert-write",
          includes: ["a.localhost", "2 consecutive tenant warm 401/403s"],
          excludes: ["b.localhost", "c.localhost"],
        },
      ],
    },
  },
  {
    name: "alert hook: a later clean warm clears the marker",
    // Refuse pass 0 and pass 1, then answer 200 from pass 2 on.
    refuseFor: { "a.localhost": 2 },
    waitForLog: "tenant warm alert cleared: a.localhost answered",
    env: {
      WARMUP_REFRESH_SECONDS: "2",
      WARMUP_TENANT_ALERT_THRESHOLD: "2",
      WARMUP_TENANT_ALERT_FILE: "/tmp/prewarm-frontend-harness-alert-clear",
    },
    expect: {
      logIncludes: ["tenant warm ALERT: a.localhost has now answered 2 auth refusals"],
      alertFile: [{ path: "/tmp/prewarm-frontend-harness-alert-clear", absent: true }],
    },
  },
].filter(Boolean);

let failed = 0;
console.log(`fake frontend on 127.0.0.1, host load average ${load.toFixed(2)}\n`);

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
