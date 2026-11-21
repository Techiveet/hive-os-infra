from pathlib import Path
import unittest

class ProducerReleasePathsTest(unittest.TestCase):
    def test_producer_workflows_cannot_trigger_or_retarget_the_shared_stack(self):
        root = Path(__file__).resolve().parents[2]
        for repo in ('hive-os-backend', 'hive-os-frontend'):
            text = (root / repo / '.github/workflows/build-and-push.yml').read_text()
            self.assertNotIn('\n  deploy:', text)
            self.assertNotIn('COOLIFY_API_TOKEN', text)
            self.assertNotIn('coolify_git_repository', text)
            self.assertNotIn('deploy_only', text)
            self.assertIn('candidate_digest:', text)
            self.assertIn('org.opencontainers.image.revision=', text)

