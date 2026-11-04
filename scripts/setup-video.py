#!/usr/bin/env python3
"""Configure local Hive video without replacing existing credentials."""
import os
import json
import argparse
import ipaddress
import re
from pathlib import Path
import secrets
import subprocess

infra = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--media-ip", help="Private IPv4 address assigned to this host; use a non-overlapping private Windows host adapter for local Firefox")
args = parser.parse_args()
if args.media_ip:
    ip = ipaddress.ip_address(args.media_ip)
    if ip.version != 4 or ip.is_unspecified or ip.is_multicast or not ip.is_private:
        raise SystemExit("Use a private IPv4 address assigned to this computer.")
    # Docker routes overlapping host addresses into its own bridge, breaking TURN.
    network_ids = subprocess.run(["docker", "network", "ls", "-q"], check=True,
                                 capture_output=True, text=True).stdout.split()
    if network_ids:
        networks = json.loads(subprocess.run(["docker", "network", "inspect", *network_ids],
                                             check=True, capture_output=True, text=True).stdout)
        for network in networks:
            for entry in network.get("IPAM", {}).get("Config") or []:
                subnet = entry.get("Subnet")
                if subnet and ip in ipaddress.ip_network(subnet):
                    raise SystemExit(f"Media address overlaps Docker network {network['Name']} ({subnet}); choose another private host adapter.")
private = infra / ".video"
hive_env = infra.parent / "hive-os-backend" / ".env"
if not hive_env.is_file():
    raise SystemExit("Configure hive-os-backend/.env first.")
private.mkdir(mode=0o700, exist_ok=True)
os.chmod(private, 0o700)
backend = private / "backend.env"
media = private / "livekit.yaml"
if backend.exists() != media.exists():
    raise SystemExit("Incomplete .video configuration: restore the missing file; existing credentials were preserved.")
if not backend.exists():
    shared, api_secret = secrets.token_hex(32), secrets.token_hex(32)
    values = {
        "PORT": "5001", "NODE_ENV": "production",
        "AUTH_TOKEN_SECRET": secrets.token_hex(32),
        "BILLING_WEBHOOK_SECRET": secrets.token_hex(32),
        "HIVE_VIDEO_SECRET": shared,
        "LIVEKIT_API_KEY": "hivevideo", "LIVEKIT_API_SECRET": api_secret,
        "LIVEKIT_HTTP_URL": "http://hive-video-media:7880",
        "LIVEKIT_WS_URL": "ws://127.0.0.1:17880",
        "ALLOWED_ORIGINS": "http://127.0.0.1:3001,http://localhost:3001",
    }
    with backend.open("x") as f:
        os.chmod(backend, 0o600)
        f.write("".join(f"{key}={value}\n" for key, value in values.items()))
    with media.open("x") as f:
        os.chmod(media, 0o600)
        f.write(f"""port: 7880
bind_addresses: ["0.0.0.0"]
keys:
  hivevideo: {api_secret}
rtc:
  node_ip: 127.0.0.1
  use_external_ip: false
  tcp_port: 17881
  udp_port: 17883
  allow_tcp_fallback: true
""")
if args.media_ip:
    config, count = re.subn(r"(?m)^  node_ip:.*$", "  node_ip: " + args.media_ip, media.read_text())
    if count != 1:
        raise SystemExit("Expected exactly one rtc.node_ip in media configuration.")
    media.write_text(config)
    compose_env = infra / ".env"
    entries = compose_env.read_text().splitlines() if compose_env.exists() else []
    entries = [line for line in entries if not line.startswith("HIVE_VIDEO_MEDIA_IP=")]
    entries.append("HIVE_VIDEO_MEDIA_IP=" + args.media_ip)
    compose_env.write_text("\n".join(entries) + "\n")
# Embedded TURN uses per-participant credentials issued by LiveKit. Limit relay
# access to the configured media address, including on private Docker networks.
media_config = media.read_text()
# Migrate the original narrow per-track UDP range to LiveKit's UDP mux. A
# single published UDP port supports conference growth without asking Docker
# Desktop to bind thousands of host ports.
rtc_config = media_config.split("\nturn:", 1)[0]
if "  udp_port: 17883\n" not in rtc_config:
    media_config = media_config.replace("  tcp_port: 17881\n", "  tcp_port: 17881\n  udp_port: 17883\n", 1)
media_config = re.sub(r"(?m)^  port_range_start: 50100\n  port_range_end: 50120\n", "", media_config, count=1)
media_config = media_config.replace("  relay_range_end: 50399\n", "  relay_range_end: 50240\n", 1)
media_ip_match = re.search(r"(?m)^  node_ip:\s*(\S+)\s*$", media_config)
if not media_ip_match:
    raise SystemExit("Missing rtc.node_ip; configure a media address before enabling TURN.")
media_ip = str(ipaddress.ip_address(media_ip_match.group(1)))
if "\nturn:" not in media_config:
    media_config += ("\nturn:\n  enabled: true\n  udp_port: 17882\n  tls_port: 0\n"
                     "  relay_range_start: 50200\n  relay_range_end: 50240\n"
                     "  allow_restricted_peer_cidrs:\n    - " + media_ip + "/32\n")
elif args.media_ip:
    # Only update the single-host allow-list produced by this setup script.
    media_config = re.sub(r"(allow_restricted_peer_cidrs:\n    - )[^\n]+/32",
                          lambda match: match.group(1) + media_ip + "/32", media_config)
media.write_text(media_config)
values = dict(line.split("=", 1) for line in backend.read_text().splitlines()
              if "=" in line and not line.startswith("#"))
shared = values.get("HIVE_VIDEO_SECRET", "")
if len(shared) < 32:
    raise SystemExit("Existing HIVE_VIDEO_SECRET must contain at least 32 characters.")
settings = {
    "HIVE_VIDEO_ENABLED": "true",
    "HIVE_VIDEO_BACKEND_URL": "http://hive-video-backend:5001",
    "HIVE_VIDEO_SECRET": shared,
}
lines = hive_env.read_text().splitlines()
updated = [line for line in lines if line.split("=", 1)[0] not in settings]
updated.extend(f"{key}={value}" for key, value in settings.items())
hive_env.write_text("\n".join(updated) + "\n")
subprocess.run(["docker", "volume", "create", "hive-video_video-data"], check=True, stdout=subprocess.DEVNULL)
print("Private video configuration ready; existing video credentials and volume preserved.")
print("Run docker compose up -d --build video-backend video-media, then reload Hive Octane.")
