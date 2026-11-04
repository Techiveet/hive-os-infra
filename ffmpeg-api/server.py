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

import os
import subprocess
import tempfile
import uuid
from pathlib import Path

from flask import Flask, request, send_file, jsonify

app = Flask(__name__)

# ─── Helpers ──────────────────────────────────────────────────────────────────

ALLOWED_VIDEO_IN  = {"mp4", "webm", "mov", "avi", "mkv", "flv", "wmv", "ts", "m4v", "3gp"}
ALLOWED_VIDEO_OUT = {"mp4", "webm", "mov", "avi", "mkv", "gif", "m4v"}
ALLOWED_AUDIO_IN  = {"mp3", "ogg", "wav", "flac", "aac", "m4a", "opus", "wma", "mp4", "mov", "mkv", "avi"}
ALLOWED_AUDIO_OUT = {"mp3", "ogg", "wav", "flac", "aac", "m4a", "opus"}
ALLOWED_IMAGE_OUT = {"jpg", "jpeg", "png", "webp", "gif"}

MAX_FILE_SIZE = 1 * 1024 * 1024 * 1024  # 1 GB

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


def error(message: str, status: int = 400):
    return jsonify({"error": message}), status


# ─── Routes ───────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    """Health check — also returns FFmpeg version."""
    try:
        result = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True)
        version_line = result.stdout.splitlines()[0] if result.stdout else "unknown"
        return jsonify({"status": "ok", "ffmpeg": version_line})
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


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
