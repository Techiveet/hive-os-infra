import { Router } from "express";
import crypto from "crypto";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";

// Hive checks membership; this bridge cannot issue access to regular clone rooms.
export function hiveIntegration() {
  const router = Router();
  router.use((req, res, next) => {
    const secret = process.env.HIVE_VIDEO_SECRET || "";
    const timestamp = req.header("X-Hive-Timestamp") || "";
    const signature = req.header("X-Hive-Signature") || "";
    const raw = (req as typeof req & { rawBody?: string }).rawBody;
    if (secret.length < 32 || !/^\d{10}$/.test(timestamp) ||
        Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 || !raw ||
        !/^[a-f0-9]{64}$/.test(signature)) {
      return res.status(401).json({ error: "Invalid integration authentication" });
    }
    const expected = crypto.createHmac("sha256", secret)
      .update(timestamp + "\n" + req.path + "\n" + raw).digest();
    if (!crypto.timingSafeEqual(expected, Buffer.from(signature, "hex"))) {
      return res.status(401).json({ error: "Invalid integration authentication" });
    }
    if (!/^hive-[a-f0-9]{64}$/.test(req.body?.room || "")) {
      return res.status(422).json({ error: "Invalid Hive room" });
    }
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  const rooms = () => new RoomServiceClient(
    process.env.LIVEKIT_HTTP_URL || "http://livekit:7880",
    process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET,
  );
  router.post("/status", async (req, res) => {
    try {
      const found = await rooms().listRooms([req.body.room]);
      res.json({ active: (found[0]?.numParticipants || 0) > 0, participants: found[0]?.numParticipants || 0 });
    } catch {
      res.status(503).json({ error: "Media server unavailable" });
    }
  });
  router.post("/token", async (req, res) => {
    if (!/^hive-user-[a-f0-9]{64}$/.test(req.body?.identity || "") ||
        typeof req.body?.name !== "string" || !req.body.name.trim() || req.body.name.length > 100 ||
        typeof req.body?.is_host !== "boolean") {
      return res.status(422).json({ error: "Invalid participant" });
    }
    try {
      await rooms().listRooms([req.body.room]);
      const token = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
        identity: req.body.identity,
        name: req.body.name,
        ttl: 300,
        metadata: JSON.stringify({ hiveRole: req.body.is_host ? "host" : "participant" }),
      });
      token.addGrant({ roomJoin: true, room: req.body.room, canPublish: true, canSubscribe: true, canPublishData: true });
      res.json({ token: await token.toJwt(), url: process.env.LIVEKIT_WS_URL, room: req.body.room });
    } catch {
      res.status(503).json({ error: "Media server unavailable" });
    }
  });
  router.post("/remove", async (req, res) => {
    if (!/^hive-user-[a-f0-9]{64}$/.test(req.body?.identity || "")) {
      return res.status(422).json({ error: "Invalid participant" });
    }
    try {
      await rooms().removeParticipant(req.body.room, req.body.identity);
      res.json({ removed: true });
    } catch {
      res.status(503).json({ error: "Could not remove participant" });
    }
  });
  router.post("/end", async (req, res) => {
    try {
      await rooms().deleteRoom(req.body.room);
      res.json({ ended: true });
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (message.includes("not found")) {
        return res.json({ ended: true });
      }
      res.status(503).json({ error: "Could not end meeting" });
    }
  });
  return router;
}
