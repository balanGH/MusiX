"""
MusiX online music downloader.

Provides:
- YouTube Music search through yt-dlp
- audio download
- MP3 conversion
- metadata
- embedded artwork
- download progress

This module does not create its own web server.
backend/main.py owns the FastAPI server.
"""

from __future__ import annotations

import threading
import uuid
from pathlib import Path
from typing import Any

import yt_dlp


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------

BACKEND_DIR = Path(__file__).resolve().parent

DOWNLOAD_DIR = BACKEND_DIR / "storage" / "downloads"
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------

jobs: dict[str, dict[str, Any]] = {}


# ---------------------------------------------------------------------------
# Online search
# ---------------------------------------------------------------------------

def search_online(query: str, limit: int = 5) -> list[dict[str, Any]]:
    """
    Search YouTube for the query.

    yt-dlp has no working "ytmsearch" scheme in current releases — that prefix
    falls through to the generic extractor and raises "Unsupported url
    scheme". "ytsearch" is the extractor that actually exists.
    """

    query = query.strip()

    if not query:
        return []

    options = {
        "quiet": True,
        "skip_download": True,
        "extract_flat": True,
        "noplaylist": True,
    }

    with yt_dlp.YoutubeDL(options) as ydl:

        result = ydl.extract_info(
            f"ytsearch{limit}:{query}",
            download=False,
        )

    results: list[dict[str, Any]] = []

    for item in result.get("entries", []):

        if not item:
            continue

        video_id = item.get("id")

        if not video_id:
            continue

        # `extract_flat` search results carry artwork under "thumbnails", not
        # the single "thumbnail" key a fully-resolved entry would have.
        thumbnails = item.get("thumbnails") or []

        results.append(
            {
                "id": video_id,

                "title": item.get("title")
                or "Unknown title",

                "url": (
                    item.get("webpage_url")
                    or f"https://music.youtube.com/watch?v={video_id}"
                ),

                "thumbnail": item.get("thumbnail") or (thumbnails[-1]["url"] if thumbnails else None),

                "channel": (
                    item.get("channel")
                    or item.get("uploader")
                    or "Unknown artist"
                ),

                "artist": (
                    item.get("artist")
                    or item.get("channel")
                    or item.get("uploader")
                ),

                "album": item.get("album"),

                "duration": item.get("duration"),
            }
        )

    return results


# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------

def _download_song(job_id: str, url: str) -> None:

    jobs[job_id] = {
        "status": "starting",
        "progress": 0,
        "title": None,
        "artist": None,
        "album": None,
        "filename": None,
        "error": None,
    }

    def progress_hook(data: dict[str, Any]):

        if data["status"] == "downloading":

            total = (
                data.get("total_bytes")
                or data.get("total_bytes_estimate")
            )

            downloaded = data.get(
                "downloaded_bytes",
                0,
            )

            if total:
                progress = round(
                    downloaded / total * 100,
                    1,
                )
            else:
                progress = 0

            jobs[job_id]["status"] = "downloading"
            jobs[job_id]["progress"] = progress

        elif data["status"] == "finished":

            jobs[job_id]["status"] = "processing"
            jobs[job_id]["progress"] = 100

    options = {
        "format": "bestaudio/best",

        # Safe filename template.
        "outtmpl": str(
            DOWNLOAD_DIR / "%(id)s.%(ext)s"
        ),

        "writethumbnail": True,

        "postprocessors": [

            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "320",
            },

            {
                "key": "FFmpegMetadata",
            },

            {
                "key": "EmbedThumbnail",
            },
        ],

        "progress_hooks": [
            progress_hook
        ],

        "noplaylist": True,

        "quiet": True,

        # Better metadata where available.
        "addmetadata": True,
    }

    try:

        with yt_dlp.YoutubeDL(options) as ydl:

            info = ydl.extract_info(
                url,
                download=True,
            )

            video_id = info.get("id")

            filename = (
                DOWNLOAD_DIR
                / f"{video_id}.mp3"
            )

            jobs[job_id] = {
                "status": "complete",
                "progress": 100,

                "title": (
                    info.get("track")
                    or info.get("title")
                    or "Unknown title"
                ),

                "artist": (
                    info.get("artist")
                    or info.get("uploader")
                    or "Unknown artist"
                ),

                "album": (
                    info.get("album")
                    or ""
                ),

                "filename": str(filename),

                "thumbnail": info.get(
                    "thumbnail"
                ),

                "error": None,
            }

    except Exception as error:

        jobs[job_id] = {
            "status": "error",
            "progress": 0,
            "title": None,
            "artist": None,
            "album": None,
            "filename": None,
            "error": str(error),
        }


def start_download(url: str) -> str:

    job_id = uuid.uuid4().hex

    thread = threading.Thread(
        target=_download_song,
        args=(job_id, url),
        daemon=True,
    )

    thread.start()

    return job_id


def get_job(job_id: str) -> dict[str, Any] | None:

    return jobs.get(job_id)
