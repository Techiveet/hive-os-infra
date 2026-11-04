import unittest
from io import BytesIO

import cv2
import numpy as np

from server import OPENCV_OPERATIONS, app, apply_opencv_operation, encode_png


def synthetic_subject() -> np.ndarray:
    image = np.full((180, 240, 4), (245, 245, 245, 255), dtype=np.uint8)
    cv2.rectangle(image, (65, 35), (175, 155), (35, 70, 220, 255), thickness=-1)
    cv2.circle(image, (120, 85), 28, (40, 190, 70, 255), thickness=-1)
    return image


class OpenCvImageOperationsTest(unittest.TestCase):
    def test_logo_cutout_removes_connected_border_background(self):
        output = apply_opencv_operation(
            synthetic_subject(),
            "logo_cutout",
            tolerance=20,
            feather=0,
        )

        self.assertEqual(0, int(output[0, 0, 3]))
        self.assertEqual(255, int(output[90, 120, 3]))

    def test_smart_cutout_retains_main_subject(self):
        output = apply_opencv_operation(synthetic_subject(), "smart_cutout", feather=0)

        self.assertLess(int(output[0, 0, 3]), 20)
        self.assertGreater(int(output[90, 120, 3]), 230)

    def test_all_visual_operations_preserve_dimensions_and_alpha_channel(self):
        source = synthetic_subject()

        for operation in OPENCV_OPERATIONS - {"smart_cutout", "logo_cutout"}:
            with self.subTest(operation=operation):
                output = apply_opencv_operation(source, operation, strength=55)
                self.assertEqual(source.shape, output.shape)
                self.assertEqual(np.uint8, output.dtype)

    def test_processed_image_encodes_as_png(self):
        payload = encode_png(apply_opencv_operation(synthetic_subject(), "auto_enhance"))

        self.assertTrue(payload.startswith(b"\x89PNG\r\n\x1a\n"))

    def test_unknown_operation_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Unsupported OpenCV operation"):
            apply_opencv_operation(synthetic_subject(), "not-real")

    def test_flask_endpoint_returns_transparent_png_and_metadata(self):
        success, encoded = cv2.imencode(".png", synthetic_subject())
        self.assertTrue(success)

        with app.test_client() as client:
            response = client.post(
                "/opencv/process",
                data={
                    "file": (BytesIO(encoded.tobytes()), "logo.png"),
                    "operation": "logo_cutout",
                    "tolerance": "20",
                    "feather": "0",
                },
                content_type="multipart/form-data",
            )

        self.assertEqual(200, response.status_code)
        self.assertEqual("logo_cutout", response.headers["X-Hive-Image-Operation"])
        self.assertEqual("240", response.headers["X-Hive-Image-Width"])
        output = cv2.imdecode(np.frombuffer(response.data, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
        self.assertEqual(0, int(output[0, 0, 3]))
        self.assertEqual(255, int(output[90, 120, 3]))


if __name__ == "__main__":
    unittest.main()
