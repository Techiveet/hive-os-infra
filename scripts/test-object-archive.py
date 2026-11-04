"""Synthetic archive checks: no real objects, storage credentials or network."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import unittest

VERIFIER = Path(__file__).with_name('verify-object-archive.py')

def fixture(*, corrupt=False, missing=False, duplicate=False, traversal=False):
    payload = b'hive-backup-test-only'
    name = 'objects/' + hashlib.sha256(b'dummy-bucket\0dummy-key').hexdigest()
    manifest = {'format':'hive-s3-logical-v1', 'objects':[{
        'entry':name, 'bytes':len(payload),
        'sha256':hashlib.sha256(payload).hexdigest()}]}
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w', format=tarfile.USTAR_FORMAT) as archive:
        entries = [(('../escape' if traversal else name), payload if not corrupt else b'x'*len(payload))]
        if duplicate:
            entries *= 2
        if not missing:
            entries.append(('manifest.json', json.dumps(manifest).encode()))
        for entry_name, content in entries:
            entry=tarfile.TarInfo(entry_name)
            entry.size=len(content)
            archive.addfile(entry, io.BytesIO(content))
    return output.getvalue()

class ArchiveChecks(unittest.TestCase):
    def verify(self, archive):
        return subprocess.run([sys.executable, str(VERIFIER)], input=archive, capture_output=True)

    def test_valid(self):
        result=self.verify(fixture())
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertIn(b'1 objects', result.stdout)

    def test_corrupt_rejected(self):
        self.assertNotEqual(self.verify(fixture(corrupt=True)).returncode, 0)

    def test_incomplete_rejected(self):
        self.assertNotEqual(self.verify(fixture(missing=True)).returncode, 0)

    def test_duplicate_rejected(self):
        self.assertNotEqual(self.verify(fixture(duplicate=True)).returncode, 0)

    def test_unexpected_path_rejected(self):
        self.assertNotEqual(self.verify(fixture(traversal=True)).returncode, 0)

if __name__ == '__main__':
    unittest.main()
