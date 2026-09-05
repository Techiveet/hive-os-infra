# Hive video calls

Hive chat and sent mail now use the backend from /home/mike/projects/zoom-clone.
Hive authorizes the current conversation/mail membership before making a signed
server-to-server request. The clone issues five-minute LiveKit credentials
restricted to a tenant-scoped Hive room. Clone meeting rooms remain separate.

## Local operation

From hive-os-infra:
```sh
python3 scripts/setup-video.py
docker compose up -d --build video-backend video-media
docker exec hive-backend php artisan octane:reload --no-ansi
```

Private settings are in .video/backend.env, .video/livekit.yaml and the Hive
backend .env. Do not commit these files. The media endpoint is
ws://127.0.0.1:17880; TCP media uses 17881, UDP media uses 50100–50120,
and TURN uses 17882 plus relay ports 50200–50240. The setup defaults to loopback for
same-host Chromium; Windows Firefox should use the private-adapter setup below. TCP
fallback is enabled for the media transport. Other computers/production require a
reachable media hostname, HTTPS/WSS, and an appropriate public or TLS TURN path.
Do not simply expose the development secrets.

Open a conversation or sent mail, select Video call, then Join call. Other
members open the same item to join; the button detects active rooms every
15 seconds while the page is visible. This version does not send ringing
notifications or external email invitations. Camera/microphone start off;
enable them explicitly. Screen sharing uses the browser picker. Escape,
Close, Leave call and navigation disconnect and stop local tracks.
Message end-to-end encryption does not apply to calls; media uses encrypted transport.

## Verification

- Zoom backend TypeScript build and all nine bridge, meeting-access and OAuth tests passed.
- Bridge test rejects missing, stale, tampered signatures and non-Hive rooms.
- Eight isolated Hive tests passed: room scope isolation, exact signatures,
  disabled service, allowed member, outsiders, drafts and deleted membership.
- Frontend TypeScript and video component ESLint passed.
- Six text/focus/tile contrast checks passed.
- Live signed status and media token issuance verified.
- Signed-in chat and sent-mail dialogs connected to LiveKit; Escape closed chat and returned focus.
- Physical camera/microphone and multi-device media remain user acceptance checks.

Existing unrelated changes in all repositories were preserved. No database
migrations or message/email dispatch is required by this integration.

## Compose ownership

Video services are part of the main hive-os-infra project as video-backend and video-media. The pre-existing hive-video_video-data volume is reused explicitly as an external volume; its name is retained to preserve data. The Zoom backend source remains in its original repository.

## Source and prerequisites

Clone https://github.com/Techiveet/zoom_clone into the sibling `../../zoom-clone` directory (relative to hive-os-infra). Run setup from WSL with Python 3 and Docker Compose v2. Setup creates local secrets only when absent, connects the Hive backend environment, and creates the named volume if needed. It preserves existing video credentials and data. Never commit `.env`, `.video`, or database backups. After changing environment settings, clear cached Laravel configuration before reloading Octane.

The optional `docker-compose.local-monitoring.yml` removes host backend/Reverb port bindings on this workstation, where other services own those ports. Use it only with an existing frontend proxy that reaches those services over the Docker network.

## Firefox on Windows with Docker Desktop

Firefox can reject loopback or private ICE candidates when no browser-reachable relay is available. Choose the IPv4 address of
a private host-only Windows adapter that does not overlap any Docker subnet, then run:

```sh
python3 scripts/setup-video.py --media-ip <private-host-adapter-IPv4>
docker compose up -d --no-deps video-media
```

This binds media ports only to that adapter and advertises the same address.
Signaling remains on localhost. Re-run after the adapter address changes.
This does not configure calls from other computers or public internet access.

## September 5 follow-up verification

The Admin role now includes dashboard and communications access in the central
catalog. Its seeder adds these permissions while preserving custom grants.
Local API checks using temporary accounts passed login, required password change,
dashboard, two-way chat persistence/read, mail delivery/read, and call tokens for
both participants. Temporary accounts and messages were removed afterward.
The 22 catalog and video regression tests passed. Browser join/leave connected
via UDP. Further relay and Firefox results are recorded below.

## Media protocol compatibility

The Hive frontend pins `livekit-client` to 2.2.0, matching the working Zoom
frontend and its room lifecycle. The media server remains on v1.13.6 because it
is backward compatible with that client and supplies the local TURN setup used
here. A later 2.22.2 client repeatedly closed its Firefox signal connection at
the 15-second negotiation checkpoint in this environment. Keep client/server
protocol compatibility when upgrading; verify a sustained connection, not only
the initial Connected status.

## Local relay fallback

Embedded TURN listens on UDP 17882 on the selected private host adapter.
LiveKit supplies short-lived participant credentials; no anonymous relay is
configured. Restricted relay peers are limited to the media adapter's /32.
This provides an ICE fallback for browsers that can reach the private adapter. Firefox deployments that filter private candidates require a browser-reachable TLS/public TURN endpoint.
Run setup-video.py again when changing the media adapter address, then recreate
video-media so its published ports and advertised address remain aligned.

TURN also uses UDP relay ports 50200–50240, published on the same private adapter.
The Windows WSL adapter may overlap Docker's default 172.17.0.0/16 network;
setup rejects overlapping addresses before changing any files. On this workstation,
172.30.112.1 is the current Hyper-V Default Switch address here. Choose the actual host
address for each machine rather than copying this value blindly.

Verified on September 5 after correcting the adapter: the signed-in chat call
stayed connected for over five minutes with relay-only ICE enforced temporarily.
Two isolated Windows native participants also connected with relay-only ICE:
the receiver decoded 20 non-silent audio frames and 20 video frames at 320x180.
After aligning the frontend with Zoom's 2.2.0 client, authenticated Chat and Mail
calls both remained connected past the previous 15-second timeout. Two browser
tabs using the same Hive account also remained connected together through
distinct per-browser media identities. Temporary browser instrumentation and
expiring test token files were removed. The equivalent WSL native client could
not connect; this local configuration is verified for clients on the Windows
host. The headless Firefox probe still reports "could not establish pc connection" when private UDP/TURN is the only relay; this requires a browser-reachable TLS/public TURN endpoint in deployments where Firefox filters private candidates. Physical-device publishing remains a separate acceptance check.
