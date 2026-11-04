const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const crypto = require("crypto");
const { hiveIntegration } = require("../dist/hive-integration");
test("Hive bridge rejects unsigned, stale, tampered and non-Hive room requests", async () => {
 process.env.HIVE_VIDEO_SECRET = "a".repeat(64);
 const app=express();
 app.use(express.json({verify(req,res,b){req.rawBody=b.toString();}}));
 app.use("/api/integrations/hive",hiveIntegration());
 const server=app.listen(0,"127.0.0.1");
 await new Promise(r=>server.once("listening",r));
 try {
  const url="http://127.0.0.1:"+server.address().port+"/api/integrations/hive/token";
  const body=JSON.stringify({room:"regular-clone-room"});
  const send=async(timestamp,signature)=>fetch(url,{method:"POST",headers:{"Content-Type":"application/json","X-Hive-Timestamp":timestamp,"X-Hive-Signature":signature},body});
  assert.equal((await send("","")).status,401);
  const now=String(Math.floor(Date.now()/1000));
  assert.equal((await send(now,"0".repeat(64))).status,401);
  const sign=t=>crypto.createHmac("sha256",process.env.HIVE_VIDEO_SECRET).update(t+"\n/token\n"+body).digest("hex");
  const old=String(Number(now)-120);
  assert.equal((await send(old,sign(old))).status,401);
  assert.equal((await send(now,sign(now))).status,422);
 } finally {await new Promise(r=>server.close(r));}
});

test("Hive bridge protects the host-only end endpoint with the integration signature", async () => {
 process.env.HIVE_VIDEO_SECRET = "b".repeat(64);
 const app=express();
 app.use(express.json({verify(req,res,b){req.rawBody=b.toString();}}));
 app.use("/api/integrations/hive",hiveIntegration());
 const server=app.listen(0,"127.0.0.1");
 await new Promise(r=>server.once("listening",r));
 try {
  const response=await fetch("http://127.0.0.1:"+server.address().port+"/api/integrations/hive/end",{
   method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({room:"hive-"+"a".repeat(64)})
  });
  assert.equal(response.status,401);
 } finally {await new Promise(r=>server.close(r));}
});
