"""Verify a streamed logical S3 backup without printing/extracting customer data."""
import hashlib
import json
import sys
import tarfile

observed = {}
manifest = None
with tarfile.open(fileobj=sys.stdin.buffer, mode="r|") as archive:
    for entry in archive:
        assert entry.isfile(), "Unexpected archive entry type"
        stream = archive.extractfile(entry)
        if entry.name == "manifest.json":
            assert manifest is None and entry.size < 128 * 1024 * 1024
            manifest = json.load(stream)
            continue
        assert entry.name.startswith("objects/") and entry.name not in observed
        digest = hashlib.sha256()
        size = 0
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
        observed[entry.name] = (size, digest.hexdigest())
assert manifest and manifest["format"] == "hive-s3-logical-v1"
expected = {obj["entry"]: (obj["bytes"], obj["sha256"]) for obj in manifest["objects"]}
assert len(expected) == len(manifest["objects"]) and observed == expected
print(f"Restored object archive: {len(observed)} objects; {sum(x[0] for x in observed.values())} bytes; all SHA-256 hashes match.")
