"""
Hive FFmpeg API
A lightweight HTTP wrapper around FFmpeg for server-side media conversion.

Endpoints:
  POST /convert     — Convert a media file to another format
  POST /thumbnail   — Extract a thumbnail from a video at a given timestamp
  POST /compress    — Compress a video to a target file size
  POST /extract-audio — Extract audio from a video file
  GET  /health      — Health check
"""

import json
import os
import subprocess
import tempfile
import uuid
from io import BytesIO
from pathlib import Path

import cv2
import numpy as np
from flask import Flask, request, send_file, jsonify

app = Flask(__name__)

# ─── Helpers ──────────────────────────────────────────────────────────────────

ALLOWED_VIDEO_IN  = {"mp4", "webm", "mov", "avi", "mkv", "flv", "wmv", "ts", "m4v", "3gp"}
ALLOWED_VIDEO_OUT = {"mp4", "webm", "mov", "avi", "mkv", "gif", "m4v"}
ALLOWED_AUDIO_IN  = {"mp3", "ogg", "wav", "flac", "aac", "m4a", "opus", "wma", "mp4", "mov", "mkv", "avi"}
ALLOWED_AUDIO_OUT = {"mp3", "ogg", "wav", "flac", "aac", "m4a", "opus"}
ALLOWED_IMAGE_OUT = {"jpg", "jpeg", "png", "webp", "gif"}
ALLOWED_SUBTITLE_IN = {"vtt", "srt", "ass", "ssa", "sub", "sbv", "ttml", "dfxp"}
MAX_SUBTITLE_FILE_SIZE = 2 * 1024 * 1024

MAX_FILE_SIZE = 1 * 1024 * 1024 * 1024  # 1 GB
MAX_IMAGE_FILE_SIZE = 20 * 1024 * 1024
MAX_IMAGE_PIXELS = 24_000_000
app.config["MAX_CONTENT_LENGTH"] = MAX_FILE_SIZE
OPENCV_OPERATIONS = {
    "smart_cutout",
    "logo_cutout",
    "background_blur",
    "auto_enhance",
    "denoise",
    "sharpen",
    "edge_sketch",
}

MIME = {
    "mp4": "video/mp4", "webm": "video/webm", "mov": "video/quicktime",
    "avi": "video/x-msvideo", "mkv": "video/x-matroska", "gif": "image/gif",
    "mp3": "audio/mpeg", "ogg": "audio/ogg", "wav": "audio/wav",
    "flac": "audio/flac", "aac": "audio/aac", "m4a": "audio/mp4",
    "opus": "audio/ogg", "png": "image/png", "jpg": "image/jpeg",
    "jpeg": "image/jpeg", "webp": "image/webp",
}


def run_ffmpeg(args: list[str], timeout: int = 300) -> tuple[bool, str]:
    """Run an ffmpeg command, return (success, stderr)."""
    try:
        result = subprocess.run(
            ["ffmpeg", "-y"] + args,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if result.returncode != 0:
            return False, result.stderr
        return True, ""
    except subprocess.TimeoutExpired:
        return False, "FFmpeg conversion timed out"
    except Exception as e:
        return False, str(e)


def probe_media_duration(path: str) -> float | None:
    """Return the source duration so packaged subtitle cues cannot extend the MP4."""
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", path,
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        duration = float(result.stdout.strip()) if result.returncode == 0 else 0.0
        return duration if duration > 0 else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def error(message: str, status: int = 400):
    return jsonify({"error": message}), status


@app.errorhandler(413)
def request_too_large(_error):
    return error("The uploaded request exceeds the 1 GB limit.", 413)


def bounded_int(value, default: int, minimum: int, maximum: int) -> int:
    """Parse a bounded integer form value without exposing conversion errors."""
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(maximum, parsed))


def decode_uploaded_image(upload) -> np.ndarray:
    """Decode an uploaded image as BGRA and enforce memory-safe limits."""
    payload = upload.read()
    if not payload:
        raise ValueError("The uploaded image is empty.")
    if len(payload) > MAX_IMAGE_FILE_SIZE:
        raise ValueError("The uploaded image exceeds the 20 MB limit.")

    encoded = np.frombuffer(payload, dtype=np.uint8)
    image = cv2.imdecode(encoded, cv2.IMREAD_UNCHANGED)
    if image is None:
        raise ValueError("OpenCV could not decode the uploaded image.")

    height, width = image.shape[:2]
    if height < 2 or width < 2:
        raise ValueError("The uploaded image is too small to process.")
    if height * width > MAX_IMAGE_PIXELS:
        raise ValueError("The uploaded image exceeds the 24 megapixel limit.")

    if image.ndim == 2:
        image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGRA)
    elif image.shape[2] == 3:
        image = cv2.cvtColor(image, cv2.COLOR_BGR2BGRA)
    elif image.shape[2] != 4:
        raise ValueError("The uploaded image uses an unsupported channel layout.")

    return image


def soften_alpha(mask: np.ndarray, feather: int) -> np.ndarray:
    """Clean small mask defects and optionally feather the resulting edge."""
    min_dimension = min(mask.shape[:2])
    kernel_size = 3 if min_dimension < 900 else 5
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
    cleaned = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    cleaned = cv2.morphologyEx(cleaned, cv2.MORPH_CLOSE, kernel)

    if feather <= 0:
        return cleaned

    blur_size = max(3, feather * 2 + 1)
    if blur_size % 2 == 0:
        blur_size += 1
    return cv2.GaussianBlur(cleaned, (blur_size, blur_size), 0)


def grabcut_alpha(bgr: np.ndarray, feather: int = 4) -> np.ndarray:
    """Estimate the main subject with GrabCut and return an alpha mask."""
    height, width = bgr.shape[:2]
    margin = max(1, int(min(width, height) * 0.035))
    rectangle = (margin, margin, max(1, width - margin * 2), max(1, height - margin * 2))
    mask = np.zeros((height, width), dtype=np.uint8)
    background_model = np.zeros((1, 65), dtype=np.float64)
    foreground_model = np.zeros((1, 65), dtype=np.float64)

    cv2.grabCut(
        bgr,
        mask,
        rectangle,
        background_model,
        foreground_model,
        5,
        cv2.GC_INIT_WITH_RECT,
    )
    foreground = np.where(
        (mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD),
        255,
        0,
    ).astype(np.uint8)

    coverage = float(np.count_nonzero(foreground)) / float(foreground.size)
    if coverage < 0.01 or coverage > 0.98:
        raise ValueError("OpenCV could not confidently separate a foreground subject.")

    return soften_alpha(foreground, feather)


def logo_background_alpha(bgr: np.ndarray, tolerance: int, feather: int) -> np.ndarray:
    """Remove only border-connected pixels similar to the median border colour."""
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    border = np.concatenate((lab[0, :, :], lab[-1, :, :], lab[:, 0, :], lab[:, -1, :]), axis=0)
    background_colour = np.median(border, axis=0)
    distance = np.linalg.norm(lab - background_colour, axis=2)
    candidate_background = (distance <= tolerance).astype(np.uint8)

    component_count, labels = cv2.connectedComponents(candidate_background, connectivity=8)
    if component_count <= 1:
        raise ValueError("OpenCV could not identify a connected logo background.")

    touching_labels = np.unique(
        np.concatenate((labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]))
    )
    touching_labels = touching_labels[touching_labels != 0]
    connected_background = np.isin(labels, touching_labels)
    alpha = np.where(connected_background, 0, 255).astype(np.uint8)

    if np.count_nonzero(alpha) == 0:
        raise ValueError("The selected tolerance removed the entire image.")

    return soften_alpha(alpha, feather)


def apply_opencv_operation(
    image: np.ndarray,
    operation: str,
    *,
    tolerance: int = 32,
    feather: int = 4,
    strength: int = 50,
) -> np.ndarray:
    """Apply one supported, deterministic OpenCV operation and return BGRA."""
    if operation not in OPENCV_OPERATIONS:
        raise ValueError(f"Unsupported OpenCV operation: {operation}")

    bgr = image[:, :, :3]
    source_alpha = image[:, :, 3]
    output_bgr = bgr.copy()
    output_alpha = source_alpha.copy()

    if operation == "smart_cutout":
        output_alpha = np.minimum(source_alpha, grabcut_alpha(bgr, feather))
    elif operation == "logo_cutout":
        output_alpha = np.minimum(source_alpha, logo_background_alpha(bgr, tolerance, feather))
    elif operation == "background_blur":
        subject_alpha = grabcut_alpha(bgr, feather).astype(np.float32) / 255.0
        blur_size = bounded_int(round(strength / 2) * 2 + 1, 31, 9, 81)
        if blur_size % 2 == 0:
            blur_size += 1
        blurred = cv2.GaussianBlur(bgr, (blur_size, blur_size), 0)
        blend = subject_alpha[:, :, np.newaxis]
        output_bgr = np.clip(bgr * blend + blurred * (1.0 - blend), 0, 255).astype(np.uint8)
    elif operation == "auto_enhance":
        lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
        luminance, channel_a, channel_b = cv2.split(lab)
        clip_limit = 1.3 + (strength / 100.0) * 2.2
        enhanced_luminance = cv2.createCLAHE(clipLimit=clip_limit, tileGridSize=(8, 8)).apply(luminance)
        output_bgr = cv2.cvtColor(cv2.merge((enhanced_luminance, channel_a, channel_b)), cv2.COLOR_LAB2BGR)
    elif operation == "denoise":
        denoise_strength = bounded_int(round(3 + strength * 0.12), 8, 3, 15)
        output_bgr = cv2.fastNlMeansDenoisingColored(
            bgr,
            None,
            denoise_strength,
            denoise_strength,
            7,
            21,
        )
    elif operation == "sharpen":
        amount = 0.35 + (strength / 100.0) * 1.4
        blurred = cv2.GaussianBlur(bgr, (0, 0), 1.2)
        output_bgr = cv2.addWeighted(bgr, 1.0 + amount, blurred, -amount, 0)
    elif operation == "edge_sketch":
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        inverse = cv2.bitwise_not(gray)
        blur_size = bounded_int(round(strength / 5) * 2 + 5, 25, 9, 45)
        if blur_size % 2 == 0:
            blur_size += 1
        softened = cv2.GaussianBlur(inverse, (blur_size, blur_size), 0)
        sketch = cv2.divide(gray, 255 - softened, scale=256)
        output_bgr = cv2.cvtColor(sketch, cv2.COLOR_GRAY2BGR)

    return np.dstack((output_bgr, output_alpha))


def encode_png(image: np.ndarray) -> bytes:
    success, encoded = cv2.imencode(".png", image, [cv2.IMWRITE_PNG_COMPRESSION, 4])
    if not success:
        raise ValueError("OpenCV could not encode the processed image.")
    return encoded.tobytes()


# ─── Routes ───────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    """Health check — also returns FFmpeg version."""
    try:
        result = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True)
        version_line = result.stdout.splitlines()[0] if result.stdout else "unknown"
        return jsonify({
            "status": "ok",
            "ffmpeg": version_line,
            "opencv": cv2.__version__,
            "opencv_operations": sorted(OPENCV_OPERATIONS),
            "video_operations": ["bottom_right_app_name_watermark"],
        })
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


@app.post("/opencv/process")
def opencv_process():
    """Apply an OpenCV operation to an uploaded image and return a PNG."""
    if "file" not in request.files:
        return error("No image file provided")

    operation = (request.form.get("operation") or "").strip().lower()
    if operation not in OPENCV_OPERATIONS:
        return error(
            "Unsupported OpenCV operation. Choose one of: " + ", ".join(sorted(OPENCV_OPERATIONS))
        )

    tolerance = bounded_int(request.form.get("tolerance"), 32, 4, 150)
    feather = bounded_int(request.form.get("feather"), 4, 0, 25)
    strength = bounded_int(request.form.get("strength"), 50, 1, 100)

    try:
        image = decode_uploaded_image(request.files["file"])
        processed = apply_opencv_operation(
            image,
            operation,
            tolerance=tolerance,
            feather=feather,
            strength=strength,
        )
        payload = encode_png(processed)
    except ValueError as exc:
        return error(str(exc), 422)
    except cv2.error:
        app.logger.exception("OpenCV failed while processing %s", operation)
        return error("OpenCV could not process this image.", 422)
    except Exception:
        app.logger.exception("Unexpected OpenCV image-processing failure")
        return error("The image processor encountered an unexpected error.", 500)

    height, width = processed.shape[:2]
    filename = f"{Path(request.files['file'].filename or 'image').stem}_{operation}.png"
    response = send_file(
        BytesIO(payload),
        mimetype="image/png",
        as_attachment=False,
        download_name=filename,
    )
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Hive-Image-Operation"] = operation
    response.headers["X-Hive-Image-Width"] = str(width)
    response.headers["X-Hive-Image-Height"] = str(height)
    return response


@app.post("/video/watermark")
def video_watermark():
    """Package a video with an optional watermark and optional WebVTT subtitle tracks."""
    if "file" not in request.files:
        return error("No video file provided")

    video = request.files["file"]
    overlay = request.files.get("overlay")
    subtitle_uploads = request.files.getlist("subtitles")[:16]
    input_ext = (video.filename or "video.mp4").rsplit(".", 1)[-1].lower()

    if input_ext not in ALLOWED_VIDEO_IN:
        return error(f"Unsupported video input format: {input_ext}")
    if overlay is None and not subtitle_uploads:
        return error("No watermark or subtitle tracks were provided", 422)

    try:
        subtitle_metadata = json.loads(request.form.get("subtitle_metadata") or "[]")
    except (TypeError, ValueError, json.JSONDecodeError):
        return error("Subtitle metadata is invalid", 422)
    if not isinstance(subtitle_metadata, list):
        return error("Subtitle metadata must be a list", 422)

    with tempfile.TemporaryDirectory() as tmpdir:
        input_path = os.path.join(tmpdir, f"input.{input_ext}")
        output_path = os.path.join(tmpdir, "packaged.mp4")
        video.save(input_path)
        source_duration = probe_media_duration(input_path)

        args = ["-i", input_path]
        overlay_index = None
        if overlay is not None:
            overlay_path = os.path.join(tmpdir, "watermark.png")
            overlay.save(overlay_path)
            try:
                overlay_image = cv2.imread(overlay_path, cv2.IMREAD_UNCHANGED)
                if overlay_image is None or overlay_image.ndim != 3 or overlay_image.shape[2] != 4:
                    return error("The watermark overlay must be a transparent PNG", 422)
            except cv2.error:
                return error("The watermark overlay could not be decoded", 422)
            overlay_index = 1
            args += ["-i", overlay_path]

        subtitle_input_indexes = []
        for subtitle_number, subtitle in enumerate(subtitle_uploads):
            subtitle_path = os.path.join(tmpdir, f"subtitle-{subtitle_number}.vtt")
            subtitle.save(subtitle_path)
            contents = Path(subtitle_path).read_text(encoding="utf-8", errors="replace")
            if not contents.lstrip().startswith("WEBVTT") or "-->" not in contents:
                return error(f"Subtitle track {subtitle_number + 1} is not valid WebVTT", 422)
            subtitle_input_indexes.append(1 + (1 if overlay_index is not None else 0) + subtitle_number)
            args += ["-i", subtitle_path]

        if overlay_index is not None:
            filter_graph = (
                f"[{overlay_index}:v:0][0:v:0]scale2ref=w=main_w:h=main_h[watermark][base];"
                "[base][watermark]overlay=0:0:format=auto:eof_action=repeat[branded]"
            )
            args += ["-filter_complex", filter_graph, "-map", "[branded]"]
        else:
            args += ["-map", "0:v:0"]

        args += ["-map", "0:a?"]
        for subtitle_index in subtitle_input_indexes:
            args += ["-map", f"{subtitle_index}:0"]

        args += [
            "-map_metadata", "-1",
            "-movflags", "+faststart",
            "-max_muxing_queue_size", "1024",
            "-pix_fmt", "yuv420p",
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-profile:v", "main",
            "-level", "4.1",
            "-crf", "23",
            "-c:a", "aac",
            "-b:a", "160k",
        ]

        if source_duration is not None:
            args += ["-t", f"{source_duration:.6f}"]

        if subtitle_input_indexes:
            args += ["-c:s", "mov_text"]
            default_assigned = False
            for index in range(len(subtitle_input_indexes)):
                metadata = subtitle_metadata[index] if index < len(subtitle_metadata) and isinstance(subtitle_metadata[index], dict) else {}
                language = str(metadata.get("language") or "und")[:12]
                label = str(metadata.get("label") or f"Subtitle {index + 1}")[:80]
                is_default = bool(metadata.get("default")) and not default_assigned
                default_assigned = default_assigned or is_default
                args += [
                    f"-metadata:s:s:{index}", f"language={language}",
                    f"-metadata:s:s:{index}", f"title={label}",
                    f"-disposition:s:{index}", "default" if is_default else "0",
                ]
            if not default_assigned:
                args += ["-disposition:s:0", "default"]

        args += ["-f", "mp4", output_path]
        ok, stderr = run_ffmpeg(args, timeout=1800)

        if not ok:
            app.logger.error("Video packaging failed: %s", stderr)
            return error("The video and subtitle tracks could not be packaged", 500)
        if not os.path.isfile(output_path) or os.path.getsize(output_path) < 1024:
            return error("The generated video output is incomplete", 500)

        stem = Path(video.filename or "video").stem
        response = send_file(
            output_path,
            mimetype="video/mp4",
            as_attachment=True,
            download_name=f"{stem}.mp4",
        )
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Hive-Video-Watermark"] = "bottom-right-app-name" if overlay is not None else "none"
        response.headers["X-Hive-Subtitle-Tracks"] = str(len(subtitle_input_indexes))
        return response


@app.post("/subtitle/convert")
def convert_subtitle():
    """Convert a supported timed-caption file into browser-native WebVTT."""
    if "file" not in request.files:
        return error("No subtitle file provided")

    upload = request.files["file"]
    extension = Path(upload.filename or "").suffix.lower().lstrip(".")
    if extension not in ALLOWED_SUBTITLE_IN:
        return error("Unsupported subtitle format. Use VTT, SRT, ASS, SSA, SUB, SBV, TTML, or DFXP.", 422)

    with tempfile.TemporaryDirectory() as tmpdir:
        input_path = os.path.join(tmpdir, f"input.{extension}")
        output_path = os.path.join(tmpdir, "subtitle.vtt")
        upload.save(input_path)

        if os.path.getsize(input_path) > MAX_SUBTITLE_FILE_SIZE:
            return error("Subtitle files must not exceed 2 MB.", 413)

        ok, stderr = run_ffmpeg([
            "-nostdin", "-hide_banner", "-loglevel", "error",
            "-i", input_path,
            "-map", "0:s:0?",
            "-f", "webvtt",
            output_path,
        ], timeout=30)
        if not ok or not os.path.isfile(output_path):
            app.logger.info("Subtitle conversion rejected: %s", stderr[-500:])
            return error("This subtitle could not be converted. Check that it contains valid timed captions.", 422)

        contents = Path(output_path).read_text(encoding="utf-8", errors="replace")
        if not contents.lstrip().startswith("WEBVTT") or "-->" not in contents:
            return error("The converted subtitle does not contain valid WebVTT cues.", 422)

        response = send_file(output_path, mimetype="text/vtt; charset=utf-8", as_attachment=True, download_name="subtitle.vtt")
        response.headers["Cache-Control"] = "no-store"
        return response


@app.post("/convert")
def convert():
    """
    Convert a video or audio file to another format.
    
    Form fields:
      file        — The input file (required)
      output_format — Target format, e.g. "mp4", "mp3", "webm" (required)
      mode        — "video" or "audio" (default: "video")
      quality     — 1-100, higher = better (default: 80)
      video_codec — e.g. "libx264", "libvpx-vp9" (optional, auto-selected)
      audio_codec — e.g. "aac", "libmp3lame" (optional, auto-selected)
      resolution  — e.g. "1280x720" (optional, keep original if not set)
    """
    if "file" not in request.files:
        return error("No file provided")

    f = request.files["file"]
    output_format = (request.form.get("output_format") or "mp4").lower().strip(".")
    mode = request.form.get("mode", "video").lower()
    quality = min(100, max(1, int(request.form.get("quality", 80))))
    resolution = request.form.get("resolution", "")

    # Validate
    input_ext = (f.filename or "").rsplit(".", 1)[-1].lower()
    if mode == "video" and output_format not in ALLOWED_VIDEO_OUT:
        return error(f"Unsupported video output format: {output_format}")
    if mode == "audio" and output_format not in ALLOWED_AUDIO_OUT:
        return error(f"Unsupported audio output format: {output_format}")

    with tempfile.TemporaryDirectory() as tmpdir:
        input_path  = os.path.join(tmpdir, f"input.{input_ext}")
        output_path = os.path.join(tmpdir, f"output.{output_format}")
        f.save(input_path)

        args = ["-i", input_path]

        if mode == "audio":
            # Extract or transcode audio, drop video stream
            args += ["-vn"]
            if output_format == "mp3":
                bitrate = int(quality * 3.2)  # maps 1-100 → ~3-320 kbps
                args += ["-codec:a", "libmp3lame", "-b:a", f"{bitrate}k"]
            elif output_format in ("aac", "m4a"):
                bitrate = int(quality * 3.2)
                args += ["-codec:a", "aac", "-b:a", f"{bitrate}k"]
            elif output_format == "ogg":
                args += ["-codec:a", "libvorbis", "-q:a", str(int(quality / 10))]
            elif output_format == "flac":
                args += ["-codec:a", "flac"]
            elif output_format == "opus":
                bitrate = int(quality * 1.28)
                args += ["-codec:a", "libopus", "-b:a", f"{bitrate}k"]
            elif output_format == "wav":
                args += ["-codec:a", "pcm_s16le"]

        else:
            # Video transcode
            if output_format == "gif":
                args += [
                    "-vf", "fps=10,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
                    "-loop", "0",
                ]
            else:
                crf = int(51 - (quality / 100) * 41)  # maps 100→10, 1→51
                compress = str(request.form.get("compress", "false")).lower() == "true"
                
                if resolution:
                    args += ["-vf", f"scale={resolution.replace('x', ':')}"]

                if output_format == "webm":
                    if compress:
                        args += [
                            "-codec:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-cpu-used", "1",
                            "-codec:a", "libopus", "-b:a", "64k"
                        ]
                    else:
                        args += [
                            "-codec:v", "libvpx-vp9", "-crf", str(crf), "-b:v", "0",
                            "-codec:a", "libopus",
                        ]
                elif output_format in ("mp4", "mov", "m4v"):
                    if compress:
                        args += [
                            "-codec:v", "libx264", "-crf", "28", "-preset", "slow",
                            "-codec:a", "aac", "-b:a", "96k",
                            "-movflags", "+faststart",
                        ]
                    else:
                        args += [
                            "-codec:v", "libx264", "-crf", str(crf), "-preset", "fast",
                            "-codec:a", "aac", "-b:a", "128k",
                            "-movflags", "+faststart",
                        ]
                elif output_format == "avi":
                    args += ["-codec:v", "mpeg4", "-qscale:v", str(max(1, 31 - int(quality / 3.3)))]
                elif output_format == "mkv":
                    if compress:
                        args += ["-codec:v", "libx264", "-crf", "28", "-preset", "slow"]
                    else:
                        args += ["-codec:v", "libx264", "-crf", str(crf), "-preset", "fast"]

        args.append(output_path)
        ok, stderr = run_ffmpeg(args)

        if not ok:
            app.logger.error("FFmpeg failed: %s", stderr)
            return error(f"Conversion failed: {stderr[-500:]}", 500)

        stem = Path(f.filename or "output").stem
        download_name = f"{stem}.{output_format}"
        mime = MIME.get(output_format, "application/octet-stream")

        return send_file(
            output_path,
            mimetype=mime,
            as_attachment=True,
            download_name=download_name,
        )


@app.post("/subtitle/convert")
def convert_subtitle():
    """Convert a timed subtitle file to WebVTT."""
    if "file" not in request.files:
        return error("No file provided")

    f = request.files["file"]
    input_ext = (f.filename or "subtitle.srt").rsplit(".", 1)[-1].lower()
    if input_ext not in {"vtt", "srt", "ass", "ssa", "sub", "sbv", "ttml", "dfxp"}:
        return error("Unsupported subtitle format")

    with tempfile.TemporaryDirectory() as tmpdir:
        input_path = os.path.join(tmpdir, f"input.{input_ext}")
        output_path = os.path.join(tmpdir, "output.vtt")
        f.save(input_path)

        ok, stderr = run_ffmpeg([
            "-i", input_path,
            "-f", "webvtt",
            output_path,
        ], timeout=60)
        if not ok or not os.path.exists(output_path):
            app.logger.warning("Subtitle conversion failed: %s", stderr[-500:])
            return error("This subtitle could not be converted. Check that it contains valid timed captions.")

        with open(output_path, "r", encoding="utf-8", errors="replace") as converted:
            contents = converted.read()
        if "-->" not in contents:
            return error("This subtitle could not be converted. Check that it contains valid timed captions.")

        return app.response_class(contents, mimetype="text/vtt")


@app.post("/subtitle/extract")
def extract_subtitles():
    """Extract all timed text streams embedded in a video as WebVTT."""
    if "file" not in request.files:
        return error("No file provided")

    f = request.files["file"]
    input_ext = (f.filename or "video.mp4").rsplit(".", 1)[-1].lower()

    with tempfile.TemporaryDirectory() as tmpdir:
        input_path = os.path.join(tmpdir, f"input.{input_ext}")
        f.save(input_path)
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "s",
             "-show_entries", "stream=index:stream_tags=language,title:stream_disposition=default",
             "-of", "json", input_path],
            capture_output=True, text=True, timeout=60,
        )
        if probe.returncode != 0:
            return error("Unable to inspect the video subtitle streams.", 422)

        import json
        streams = json.loads(probe.stdout or "{}").get("streams", [])
        tracks = []
        for position, stream in enumerate(streams):
            output_path = os.path.join(tmpdir, f"subtitle-{position}.vtt")
            ok, stderr = run_ffmpeg([
                "-i", input_path, "-map", f"0:{stream['index']}",
                "-f", "webvtt", output_path,
            ], timeout=120)
            if not ok:
                app.logger.warning("Embedded subtitle extraction failed: %s", stderr[-500:])
                continue
            with open(output_path, "r", encoding="utf-8", errors="replace") as extracted:
                contents = extracted.read()
            if "-->" not in contents:
                continue
            tags = stream.get("tags") or {}
            tracks.append({
                "language": tags.get("language") or "und",
                "label": tags.get("title") or tags.get("language") or f"Subtitle {position + 1}",
                "default": bool((stream.get("disposition") or {}).get("default", position == 0)),
                "contents": contents,
            })

        return jsonify({"tracks": tracks})


@app.post("/thumbnail")
def thumbnail():
    """
    Extract a single thumbnail frame from a video.
    
    Form fields:
      file        — The video file (required)
      timestamp   — Time offset, e.g. "00:00:05" or "5" seconds (default: "00:00:01")
      width       — Output width in pixels (default: 640, height auto)
      format      — "jpg" or "png" (default: "jpg")
    """
    if "file" not in request.files:
        return error("No file provided")

    f = request.files["file"]
    timestamp = request.form.get("timestamp", "00:00:01")
    width = request.form.get("width", "640")
    fmt = request.form.get("format", "jpg").lower()

    if fmt not in ("jpg", "jpeg", "png", "webp"):
        return error("Unsupported thumbnail format")

    input_ext = (f.filename or "video.mp4").rsplit(".", 1)[-1].lower()

    with tempfile.TemporaryDirectory() as tmpdir:
        input_path  = os.path.join(tmpdir, f"input.{input_ext}")
        output_path = os.path.join(tmpdir, f"thumb.{fmt}")
        f.save(input_path)

        args = [
            "-ss", str(timestamp),
            "-i", input_path,
            "-vframes", "1",
            "-vf", f"scale={width}:-1",
            output_path,
        ]

        ok, stderr = run_ffmpeg(args, timeout=60)
        if not ok:
            return error(f"Thumbnail extraction failed: {stderr[-300:]}", 500)

        stem = Path(f.filename or "thumb").stem
        return send_file(
            output_path,
            mimetype=MIME.get(fmt, "image/jpeg"),
            as_attachment=True,
            download_name=f"{stem}_thumb.{fmt}",
        )


@app.post("/extract-audio")
def extract_audio():
    """
    Extract the audio track from a video file.
    
    Form fields:
      file          — The video file (required)
      output_format — "mp3", "aac", "ogg", "wav", "flac" (default: "mp3")
      bitrate       — Audio bitrate in kbps, e.g. "192" (default: "192")
    """
    if "file" not in request.files:
        return error("No file provided")

    f = request.files["file"]
    output_format = request.form.get("output_format", "mp3").lower()
    bitrate = request.form.get("bitrate", "192")

    if output_format not in ALLOWED_AUDIO_OUT:
        return error(f"Unsupported audio format: {output_format}")

    input_ext = (f.filename or "video.mp4").rsplit(".", 1)[-1].lower()

    with tempfile.TemporaryDirectory() as tmpdir:
        input_path  = os.path.join(tmpdir, f"input.{input_ext}")
        output_path = os.path.join(tmpdir, f"audio.{output_format}")
        f.save(input_path)

        codec_map = {
            "mp3": ["libmp3lame", f"{bitrate}k"],
            "aac": ["aac", f"{bitrate}k"],
            "m4a": ["aac", f"{bitrate}k"],
            "ogg": ["libvorbis", None],
            "flac": ["flac", None],
            "opus": ["libopus", f"{bitrate}k"],
            "wav": ["pcm_s16le", None],
        }
        codec, br = codec_map.get(output_format, ["copy", None])
        args = ["-i", input_path, "-vn", "-codec:a", codec]
        if br:
            args += ["-b:a", br]
        args.append(output_path)

        ok, stderr = run_ffmpeg(args)
        if not ok:
            return error(f"Audio extraction failed: {stderr[-300:]}", 500)

        stem = Path(f.filename or "audio").stem
        return send_file(
            output_path,
            mimetype=MIME.get(output_format, "audio/mpeg"),
            as_attachment=True,
            download_name=f"{stem}.{output_format}",
        )


@app.post("/gif")
def make_gif():
    """
    Convert a video to an optimized GIF using the palette method.
    
    Form fields:
      file      — The video file (required)
      fps       — Frames per second (default: 10)
      width     — Output width in px (default: 480, height auto)
      start     — Start time in seconds (default: 0)
      duration  — Max duration in seconds (default: 10)
    """
    if "file" not in request.files:
        return error("No file provided")

    f = request.files["file"]
    fps = int(request.form.get("fps", 10))
    width = int(request.form.get("width", 480))
    start = request.form.get("start", "0")
    duration = int(request.form.get("duration", 10))
    input_ext = (f.filename or "video.mp4").rsplit(".", 1)[-1].lower()

    with tempfile.TemporaryDirectory() as tmpdir:
        input_path   = os.path.join(tmpdir, f"input.{input_ext}")
        palette_path = os.path.join(tmpdir, "palette.png")
        output_path  = os.path.join(tmpdir, "output.gif")
        f.save(input_path)

        # Step 1: Generate palette for best color quality
        ok, stderr = run_ffmpeg([
            "-ss", str(start), "-t", str(duration),
            "-i", input_path,
            "-vf", f"fps={fps},scale={width}:-1:flags=lanczos,palettegen",
            palette_path,
        ], timeout=120)
        if not ok:
            return error(f"Palette generation failed: {stderr[-300:]}", 500)

        # Step 2: Apply palette to produce GIF
        ok, stderr = run_ffmpeg([
            "-ss", str(start), "-t", str(duration),
            "-i", input_path,
            "-i", palette_path,
            "-lavfi", f"fps={fps},scale={width}:-1:flags=lanczos[x];[x][1:v]paletteuse",
            "-loop", "0",
            output_path,
        ], timeout=180)
        if not ok:
            return error(f"GIF encoding failed: {stderr[-300:]}", 500)

        stem = Path(f.filename or "video").stem
        return send_file(
            output_path,
            mimetype="image/gif",
            as_attachment=True,
            download_name=f"{stem}.gif",
        )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=9090, debug=False)
