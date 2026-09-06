// Integration tests for the signaling backend (waiting room, passcode
// enforcement, and private chat). Run with: npm test
//
// The compiled server (dist/) is imported in-process on an ephemeral port,
// with DATA_DIR pointed at a throwaway temp directory so the real backend/data
// files are never touched.

"use strict";

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { io: createClient } = require("socket.io-client");

// ---------------------------------------------------------------------------
// Isolated environment — MUST be set before importing the server modules
// ---------------------------------------------------------------------------
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "zoom-clone-test-"));
process.env.DATA_DIR = DATA_DIR;
process.env.AUTH_TOKEN_SECRET = "integration-test-secret";

const { server, io, signSessionToken } = require("../dist/server");
const db = require("../dist/db");

let port;
const sockets = [];

before(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

after(async () => {
  sockets.forEach(s => s.disconnect());
  await new Promise(resolve => io.close(resolve));
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

// Reset persisted state between tests (server in-memory room maps use
// test-unique room IDs, so no cleanup is needed there).
beforeEach(() => {
  db.saveUsers([]);
  db.saveScheduledMeetings([]);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestUser(name, email) {
  const user = db.createUser({ name, email, authProvider: "local" });
  return { user, token: signSessionToken(user) };
}

function connectSocket(token) {
  const socket = createClient(`http://127.0.0.1:${port}`, {
    auth: { token },
    transports: ["websocket"],
    forceNew: true,
  });
  sockets.push(socket);
  return socket;
}

function waitForConnect(socket) {
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", err => reject(err));
  });
}

function waitForEvent(socket, event, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const handler = payload => {
      cleanup();
      resolve(payload);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for "${event}"`));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      socket.off(event, handler);
    }
    socket.on(event, handler);
  });
}

async function joinRoom(socket, roomId, userName, passcode) {
  const joined = waitForEvent(socket, "room-joined");
  socket.emit("join-room", { roomId, userName, passcode });
  return joined;
}

function getLiveKitToken(token, roomId) {
  return fetch(
    `http://127.0.0.1:${port}/api/livekit/token?roomId=${encodeURIComponent(roomId)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

// ---------------------------------------------------------------------------
// Waiting room
// ---------------------------------------------------------------------------

test("waiting room: joiners wait, host admits or denies, media tokens are gated", async () => {
  const alice = createTestUser("Alice", "alice@test.local");
  const bob = createTestUser("Bob", "bob@test.local");
  const carol = createTestUser("Carol", "carol@test.local");
  const room = "waitingroom1";

  // Alice joins first and becomes host
  const sa = connectSocket(alice.token);
  await waitForConnect(sa);
  const aJoined = waitForEvent(sa, "room-joined");
  sa.emit("join-room", { roomId: room, userName: "Alice" });
  assert.equal((await aJoined).hostId, alice.user.id);

  // Bob joins -> placed in waiting room, host notified
  const sb = connectSocket(bob.token);
  await waitForConnect(sb);
  const bWaiting = waitForEvent(sb, "waiting-room");
  const aJoinRequest = waitForEvent(sa, "join-request");
  sb.emit("join-room", { roomId: room, userName: "Bob" });
  assert.equal((await bWaiting).roomId, room);
  const request = await aJoinRequest;
  assert.equal(request.userId, bob.user.id);
  assert.equal(request.userName, "Bob");

  // A waiting participant must NOT be able to obtain a media token
  let res = await getLiveKitToken(bob.token, room);
  assert.equal(res.status, 403);

  // Carol joins -> also waits
  const sc = connectSocket(carol.token);
  await waitForConnect(sc);
  const cWaiting = waitForEvent(sc, "waiting-room");
  sc.emit("join-room", { roomId: room, userName: "Carol" });
  await cWaiting;

  // Host admits Bob
  const bAdmitted = waitForEvent(sb, "room-joined");
  const aUserJoined = waitForEvent(sa, "user-joined");
  sa.emit("admit-user", { roomId: room, targetUserId: bob.user.id });
  assert.equal((await bAdmitted).roomId, room);
  assert.equal((await aUserJoined).userId, bob.user.id);

  // An admitted participant can now get a media token
  res = await getLiveKitToken(bob.token, room);
  assert.equal(res.status, 200);
  const tokenData = await res.json();
  assert.equal(tokenData.roomId, room);

  // Host denies Carol
  const cDenied = waitForEvent(sc, "join-denied");
  const aCancelled = waitForEvent(sa, "join-request-cancelled");
  sa.emit("deny-user", { roomId: room, targetUserId: carol.user.id });
  assert.match((await cDenied).message, /host/i);
  assert.equal((await aCancelled).socketId, sc.id);

  sa.disconnect();
  sb.disconnect();
  sc.disconnect();
});

test("waiting room: auto-admits the first waiter when the last member leaves", async () => {
  const alice = createTestUser("Alice2", "alice2@test.local");
  const bob = createTestUser("Bob2", "bob2@test.local");
  const room = "waitingroom2";

  const sa = connectSocket(alice.token);
  await waitForConnect(sa);
  await joinRoom(sa, room, "Alice");

  const sb = connectSocket(bob.token);
  await waitForConnect(sb);
  const bWaiting = waitForEvent(sb, "waiting-room");
  sb.emit("join-room", { roomId: room, userName: "Bob" });
  await bWaiting;

  // Host leaves -> room empties -> Bob is admitted and becomes host
  const bAdmitted = waitForEvent(sb, "room-joined");
  sa.disconnect();
  const payload = await bAdmitted;
  assert.equal(payload.roomId, room);
  assert.equal(payload.hostId, bob.user.id);

  sb.disconnect();
});

// ---------------------------------------------------------------------------
// Passcode enforcement
// ---------------------------------------------------------------------------

test("passcode: wrong passcode rejected, correct passcode admits, room-joined carries the passcode", async () => {
  const alice = createTestUser("Alice3", "alice3@test.local");
  const bob = createTestUser("Bob3", "bob3@test.local");

  // Seed a scheduled meeting protected by a passcode
  const meetingId = "meeting-pass-1";
  db.saveScheduledMeetings([
    {
      id: meetingId,
      userId: alice.user.id,
      topic: "Daily Standup",
      startTime: new Date(Date.now() + 3600_000).toISOString(),
      duration: 30,
      passcode: "123456",
    },
  ]);

  // Media token denied before joining
  let res = await getLiveKitToken(bob.token, meetingId);
  assert.equal(res.status, 403);

  const sb = connectSocket(bob.token);
  await waitForConnect(sb);

  // Wrong passcode -> explicit error, not admitted
  const bErr = waitForEvent(sb, "join-room-error");
  sb.emit("join-room", { roomId: meetingId, userName: "Bob", passcode: "wrong-pass" });
  assert.match((await bErr).message, /passcode/i);

  // Correct passcode -> admitted (first joiner becomes host)
  const bJoined = waitForEvent(sb, "room-joined");
  sb.emit("join-room", { roomId: meetingId, userName: "Bob", passcode: "123456" });
  const joined = await bJoined;
  assert.equal(joined.roomId, meetingId);
  assert.equal(joined.passcode, "123456"); // used to embed in in-meeting invite links

  // Media token now granted
  res = await getLiveKitToken(bob.token, meetingId);
  assert.equal(res.status, 200);

  // A plain instant room (no scheduled meeting) needs no passcode
  const sa = connectSocket(alice.token);
  await waitForConnect(sa);
  const aJoined = waitForEvent(sa, "room-joined");
  sa.emit("join-room", { roomId: "instantroom1", userName: "Alice" });
  const instantPayload = await aJoined;
  assert.equal(instantPayload.roomId, "instantroom1");
  assert.equal(instantPayload.passcode, "");

  sa.disconnect();
  sb.disconnect();
});

// ---------------------------------------------------------------------------
// Private chat
// ---------------------------------------------------------------------------

test("private chat: DMs relay to room members only, with a sender echo", async () => {
  const alice = createTestUser("Alice4", "alice4@test.local");
  const bob = createTestUser("Bob4", "bob4@test.local");
  const carol = createTestUser("Carol4", "carol4@test.local");
  const room = "dmroom1";

  // Alice hosts, Bob joins and is admitted
  const sa = connectSocket(alice.token);
  await waitForConnect(sa);
  await joinRoom(sa, room, "Alice");

  const sb = connectSocket(bob.token);
  await waitForConnect(sb);
  const bWaiting = waitForEvent(sb, "waiting-room");
  sb.emit("join-room", { roomId: room, userName: "Bob" });
  await bWaiting;
  const bAdmitted = waitForEvent(sb, "room-joined");
  sa.emit("admit-user", { roomId: room, targetUserId: bob.user.id });
  await bAdmitted;

  // Alice DMs Bob -> delivered to Bob, echoed to Alice with isSelf
  const bReceived = waitForEvent(sb, "private-message-received");
  const aEcho = waitForEvent(sa, "private-message-received");
  sa.emit("send-private-message", { roomId: room, targetUserId: bob.user.id, text: "Hey Bob, secret plan" });

  const received = await bReceived;
  assert.equal(received.text, "Hey Bob, secret plan");
  assert.equal(received.senderId, alice.user.id);
  assert.equal(received.private, true);
  assert.equal(received.isSelf, undefined);

  const echo = await aEcho;
  assert.equal(echo.isSelf, true);
  assert.equal(echo.text, "Hey Bob, secret plan");

  // Carol in a different room cannot DM Bob
  const sc = connectSocket(carol.token);
  await waitForConnect(sc);
  await joinRoom(sc, "dmroom2", "Carol");

  const cError = waitForEvent(sc, "socket-error");
  sc.emit("send-private-message", { roomId: "dmroom2", targetUserId: bob.user.id, text: "sneaky" });
  assert.match((await cError).message, /no longer in the meeting/i);

  sa.disconnect();
  sb.disconnect();
  sc.disconnect();
});
