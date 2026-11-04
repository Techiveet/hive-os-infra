import io
import os
import subprocess
import tempfile
import unittest

import cv2
import numpy as np

import server


class VideoWatermarkEndpointTest(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()

    def test_requires_a_transparent_overlay(self):
        response = self.client.post(
            "/video/watermark",
            data={"file": (io.BytesIO(b"not-a-video"), "lesson.mp4")},
            content_type="multipart/form-data",
        )

        self.assertEqual(400, response.status_code)
        self.assertIn("overlay", response.get_json()["error"].lower())

    def test_burns_bottom_right_overlay_into_mp4(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            source_path = os.path.join(tmpdir, "source.mp4")
            subprocess.run(
                [
                    "ffmpeg", "-y",
                    "-f", "lavfi", "-i", "color=c=0x17324d:s=320x240:d=1:r=12",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
                    "-shortest",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    "-c:a", "aac",
                    source_path,
                ],
                check=True,
                capture_output=True,
            )

            overlay = np.zeros((240, 320, 4), dtype=np.uint8)
            cv2.putText(
                overlay,
                "HIVE PROTECTED",
                (35, 125),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.7,
                (255, 255, 255, 150),
                2,
                cv2.LINE_AA,
            )
            encoded_ok, encoded_overlay = cv2.imencode(".png", overlay)
            self.assertTrue(encoded_ok)

            with open(source_path, "rb") as source:
                response = self.client.post(
                    "/video/watermark",
                    data={
                        "file": (source, "lesson.mp4"),
                        "overlay": (io.BytesIO(encoded_overlay.tobytes()), "watermark.png"),
                    },
                    content_type="multipart/form-data",
                )

        failure = response.get_json(silent=True) if response.status_code != 200 else None
        self.assertEqual(200, response.status_code, failure)
        self.assertEqual("video/mp4", response.content_type)
        self.assertEqual("bottom-right-app-name", response.headers.get("X-Hive-Video-Watermark"))
        self.assertGreater(len(response.data), 1024)
        response.close()


if __name__ == "__main__":
    unittest.main()
