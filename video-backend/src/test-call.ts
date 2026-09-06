import { Room, RoomEvent } from "livekit-client";
import { io } from "socket.io-client";

const API_BASE = "https://gubae.techiveet.com";
const email = `testuser_${Math.floor(Math.random() * 10000)}@example.com`;
const password = "TestPassword123!";
const name = "Test Runner";
const roomId = "testroom";

async function runTest() {
  console.log("1. Registering user...");
  const regRes = await fetch(`${API_BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, password }),
  });

  if (!regRes.ok) {
    throw new Error(`Register failed: ${await regRes.text()}`);
  }

  const regData = await regRes.json() as any;
  const token = regData.token;
  console.log("User registered. JWT Token acquired.");

  console.log("2. Connecting to Socket.io signaling server...");
  const socket = io(API_BASE, {
    auth: { token },
    transports: ["websocket"],
  });

  await new Promise<void>((resolve, reject) => {
    socket.on("connect", () => {
      console.log("Socket.io connected successfully! Socket ID:", socket.id);
      resolve();
    });
    socket.on("connect_error", (err) => {
      reject(new Error(`Socket.io connection error: ${err.message}`));
    });
    setTimeout(() => reject(new Error("Socket.io connection timeout")), 10000);
  });

  console.log("3. Joining room via signaling...");
  socket.emit("join-room", { roomId, userName: name });

  await new Promise<void>((resolve) => {
    socket.on("room-joined", (data) => {
      console.log("Signaling room joined successfully:", data);
      resolve();
    });
  });

  console.log("4. Fetching LiveKit token...");
  const lkRes = await fetch(`${API_BASE}/api/livekit/token?roomId=${roomId}`, {
    headers: { "Authorization": `Bearer ${token}` },
  });

  if (!lkRes.ok) {
    throw new Error(`Failed to fetch LiveKit token: ${await lkRes.text()}`);
  }

  const lkData = await lkRes.json() as any;
  console.log("LiveKit token received. URL:", lkData.url);

  console.log("5. Connecting to LiveKit SFU...");
  const lkRoom = new Room();

  lkRoom.on(RoomEvent.Connected, () => {
    console.log("SUCCESS: Connected to LiveKit SFU room!");
  });

  lkRoom.on(RoomEvent.Disconnected, (reason) => {
    console.log("LiveKit room disconnected. Reason:", reason);
  });

  try {
    // In Node.js, we disable local track publishing since there's no camera/mic
    await lkRoom.connect(lkData.url, lkData.token, {
      autoSubscribe: true,
    });
    console.log("LiveKit room state:", lkRoom.state);

    // Wait a bit to ensure it stays connected
    await new Promise((resolve) => setTimeout(resolve, 5000));

    console.log("6. Disconnecting...");
    await lkRoom.disconnect();
    socket.disconnect();
    console.log("Test finished successfully. End-to-end connection works!");
  } catch (err: any) {
    console.error("LiveKit connection failed:", err.message || err);
    socket.disconnect();
    process.exit(1);
  }
}

runTest().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
