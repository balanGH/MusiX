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


Why this searches YouTube Music rather than YouTube
---------------------------------------------------
A plain `ytsearch` returns *videos*. A video has an uploader and a description;
it has no track, artist or album. yt-dlp's metadata post-processor falls back
through `artist -> artists -> creator -> creators -> uploader`, so a music video
uploaded by a label ends up tagged with the **channel name** — which is how a
download previously came out as `artist=SonyMusicSouthVEVO`, `genre=<the
video's SEO keyword list>` and `title=<the full YouTube video title>`.

`https://music.youtube.com/search?q=` returns YouTube Music entries instead.
Those resolve with real `track`, `artists`, `album` and `release_year`, which is
what the reference library in Music/spotify was built from — every file there
carries a `music.youtube.com/watch?v=...` comment tag.

Note the *watch* URL host makes no difference: `music.youtube.com/watch?v=X` and
`www.youtube.com/watch?v=X` return identical metadata for the same id. What
matters is picking a music entry in the first place. The music URL is still what
gets recorded in the comment tag, to match the reference files.
"""

from __future__ import annotations

import re
import threading
import unicodedata
import urllib.parse
import uuid
from concurrent.futures import ThreadPoolExecutor
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
# Helpers
# ---------------------------------------------------------------------------

#: A YouTube video id. Music search also returns album/playlist browse ids
#: (`MPREb_...`), which cannot be downloaded and have to be filtered out.
VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")

#: Characters Windows forbids in a filename, plus control characters.
ILLEGAL_FILENAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def music_url(video_id: str) -> str:
    return f"https://music.youtube.com/watch?v={video_id}"


def _artist_list(info: dict[str, Any]) -> list[str]:
    """Every credited artist, in order, from whichever field carries them.

    Deliberately does *not* fall back to `uploader`/`channel`: an absent artist
    is better than the channel name, which is what made downloads look tagged
    when they were not.
    """
    for key in ("artists", "creators"):
        value = info.get(key)
        if isinstance(value, list) and value:
            return [str(item).strip() for item in value if str(item).strip()]

    for key in ("artist", "creator"):
        value = info.get(key)
        if isinstance(value, str) and value.strip():
            # yt-dlp joins multiple artists with ", " in the scalar field.
            return [part.strip() for part in value.split(",") if part.strip()]

    return []


def _clean_title(info: dict[str, Any]) -> str:
    """The song title, preferring the music `track` field over a video title."""
    track = info.get("track")
    if isinstance(track, str) and track.strip():
        return track.strip()

    # No music metadata. Strip the worst of the YouTube video-title noise
    # rather than storing "Song | Actor, Actor | Composer" as a title.
    title = str(info.get("title") or "Unknown title")
    title = re.sub(
        r"\s*[\(\[]\s*(official|full)?\s*(music\s*)?"
        r"(video|audio|song|lyric[s]?|4k|hd)\b[^)\]]*[\)\]]",
        "",
        title,
        flags=re.IGNORECASE,
    )
    title = title.split("|")[0]
    return title.strip(" -–—") or "Unknown title"


def _number_pair(index: Any, total: Any) -> str:
    """`5/7` when both are known, `5` when only the index is, else empty."""
    if not isinstance(index, int) or index <= 0:
        return ""
    if isinstance(total, int) and total > 0:
        return f"{index}/{total}"
    return str(index)


def safe_filename(name: str, fallback: str = "track") -> str:
    """Make a display name usable as a filename on Windows."""
    name = unicodedata.normalize("NFC", name)
    name = ILLEGAL_FILENAME.sub("", name)
    name = re.sub(r"\s+", " ", name).strip(" .")
    # Leave headroom for the extension and the directory prefix.
    name = name[:150].strip(" .")
    return name or fallback


def display_name(title: str, artists: list[str]) -> str:
    """`Title - Artist One, Artist Two`, matching the reference library."""
    return f"{title} - {', '.join(artists)}" if artists else title


# ---------------------------------------------------------------------------
# Online search
# ---------------------------------------------------------------------------

_FLAT_OPTIONS = {
    "quiet": True,
    "no_warnings": True,
    "skip_download": True,
    "extract_flat": True,
    "noplaylist": True,
}

_RESOLVE_OPTIONS = {
    "quiet": True,
    "no_warnings": True,
    "skip_download": True,
    "noplaylist": True,
}


def _candidate_ids(query: str, wanted: int) -> list[str]:
    """Video ids from a YouTube Music search, best first."""
    url = "https://music.youtube.com/search?q=" + urllib.parse.quote(query)

    options = {**_FLAT_OPTIONS, "playlist_items": f"1-{wanted * 3}"}

    with yt_dlp.YoutubeDL(options) as ydl:
        result = ydl.extract_info(url, download=False)

    ids: list[str] = []
    for entry in (result or {}).get("entries") or []:
        if not entry:
            continue
        video_id = entry.get("id")
        # Album and playlist entries carry a browse id, not a video id.
        if isinstance(video_id, str) and VIDEO_ID.match(video_id) and video_id not in ids:
            ids.append(video_id)

    return ids[:wanted]


def _resolve(video_id: str) -> dict[str, Any] | None:
    """Full metadata for one entry, or None if it cannot be read."""
    try:
        with yt_dlp.YoutubeDL(_RESOLVE_OPTIONS) as ydl:
            return ydl.extract_info(music_url(video_id), download=False)
    except Exception:
        # One unavailable video must not fail the whole search.
        return None


def search_online(query: str, limit: int = 5) -> list[dict[str, Any]]:
    """Search YouTube Music and return entries with real music metadata.

    Each candidate is resolved fully, because a flat search result carries only
    an id and a title — `track`, `artists` and `album` only appear once the
    entry is resolved. The resolutions run concurrently; serially they would
    take about three seconds each.
    """
    query = query.strip()
    if not query:
        return []

    video_ids = _candidate_ids(query, limit)
    if not video_ids:
        return []

    with ThreadPoolExecutor(max_workers=min(len(video_ids), 6)) as pool:
        resolved = list(pool.map(_resolve, video_ids))

    results: list[dict[str, Any]] = []

    for video_id, info in zip(video_ids, resolved):
        if not info:
            continue

        artists = _artist_list(info)

        results.append(
            {
                "id": video_id,
                "title": _clean_title(info),
                "url": music_url(video_id),
                "thumbnail": _best_thumbnail(info),
                "channel": info.get("channel") or info.get("uploader"),
                "artist": ", ".join(artists) if artists else None,
                "album": info.get("album"),
                "year": info.get("release_year"),
                "duration": info.get("duration"),
                # Lets the UI mark entries that will import fully tagged.
                "hasMetadata": bool(info.get("track") and artists),
            }
        )

    # Entries with real music metadata first; they tag correctly on import.
    results.sort(key=lambda entry: not entry["hasMetadata"])
    return results


def _best_thumbnail(info: dict[str, Any]) -> str | None:
    thumbnail = info.get("thumbnail")
    if isinstance(thumbnail, str) and thumbnail:
        return thumbnail
    thumbnails = info.get("thumbnails") or []
    return thumbnails[-1].get("url") if thumbnails else None


# ---------------------------------------------------------------------------
# Tagging
# ---------------------------------------------------------------------------


def build_tags(info: dict[str, Any]) -> dict[str, str]:
    """The tags to write, as yt-dlp `meta_*` overrides.

    Any `meta_<name>` key in the info dict replaces whatever yt-dlp's metadata
    post-processor computed for `<name>`, and an empty value clears that tag
    entirely. That is how the YouTube cruft — the SEO keyword list in `genre`,
    the whole video description in `description`/`synopsis`, and `purl` — is
    kept out of the file.

    Field choices follow the reference library in Music/spotify:
      artist        multiple artists separated by `/`, the ID3 convention
      album_artist  the primary artist
      date          the release year, not the upload year
      comment       the music.youtube.com URL
    """
    artists = _artist_list(info)
    album_artists = info.get("album_artists")

    if isinstance(album_artists, list) and album_artists:
        album_artist = str(album_artists[0])
    else:
        album_artist = str(info.get("album_artist") or (artists[0] if artists else ""))

    year = info.get("release_year")
    if not year:
        release_date = info.get("release_date")
        # `release_date` is YYYYMMDD. `upload_date` is deliberately not used:
        # it is when the video was posted, which for a re-upload of a 2011 song
        # is simply wrong.
        year = str(release_date)[:4] if release_date else ""

    return {
        "meta_title": _clean_title(info),
        "meta_artist": "/".join(artists),
        "meta_album_artist": album_artist,
        "meta_album": str(info.get("album") or ""),
        "meta_date": str(year or ""),
        "meta_track": _number_pair(info.get("track_number"), info.get("n_entries")),
        "meta_disc": _number_pair(info.get("disc_number"), None),
        "meta_comment": music_url(str(info.get("id") or "")),
        # Cleared: YouTube's own fields, none of which belong in a music tag.
        "meta_genre": str(info.get("genre") or ""),
        "meta_description": "",
        "meta_synopsis": "",
        "meta_purl": "",
    }


class _WriteMusicTags(yt_dlp.postprocessor.PostProcessor):
    """Injects the `meta_*` overrides before the metadata post-processor runs.

    Registered with `when='pre_process'`, so the values are in the info dict by
    the time `FFmpegMetadataPP` assembles its `-metadata` arguments.
    """

    def run(self, info):  # noqa: ANN001, ANN201 - yt-dlp's PP signature
        info.update(build_tags(info))
        return [], info


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
        "thumbnail": None,
        "error": None,
    }

    def progress_hook(data: dict[str, Any]) -> None:
        if data["status"] == "downloading":
            total = data.get("total_bytes") or data.get("total_bytes_estimate")
            downloaded = data.get("downloaded_bytes", 0)

            jobs[job_id]["status"] = "downloading"
            jobs[job_id]["progress"] = round(downloaded / total * 100, 1) if total else 0

        elif data["status"] == "finished":
            # The download is done; transcoding and tagging still follow.
            jobs[job_id]["status"] = "processing"
            jobs[job_id]["progress"] = 100

    options = {
        "format": "bestaudio/best",
        # Downloaded under the video id, then renamed once the real title is
        # known — a template cannot express the reference naming reliably.
        "outtmpl": str(DOWNLOAD_DIR / "%(id)s.%(ext)s"),
        "writethumbnail": True,
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "320",
            },
            # The reference library embeds JPEG covers; YouTube serves WebP.
            {
                "key": "FFmpegThumbnailsConvertor",
                "format": "jpg",
            },
            {
                "key": "FFmpegMetadata",
                "add_metadata": True,
            },
            {
                "key": "EmbedThumbnail",
            },
        ],
        "progress_hooks": [progress_hook],
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
    }

    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            ydl.add_post_processor(_WriteMusicTags(), when="pre_process")

            info = ydl.extract_info(url, download=True)

            video_id = str(info.get("id") or "")
            downloaded = DOWNLOAD_DIR / f"{video_id}.mp3"

            title = _clean_title(info)
            artists = _artist_list(info)

            final_path = _rename_to_display_name(downloaded, title, artists)

            jobs[job_id] = {
                "status": "complete",
                "progress": 100,
                "title": title,
                "artist": ", ".join(artists) if artists else None,
                "album": info.get("album") or "",
                "filename": str(final_path),
                "thumbnail": _best_thumbnail(info),
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
            "thumbnail": None,
            "error": str(error),
        }


def _rename_to_display_name(path: Path, title: str, artists: list[str]) -> Path:
    """`<id>.mp3` -> `Title - Artist One, Artist Two.mp3`.

    Falls back to the original path if the rename cannot be done, since a file
    with an awkward name is still a perfectly good download.
    """
    if not path.is_file():
        return path

    target = path.with_name(safe_filename(display_name(title, artists)) + ".mp3")
    if target == path:
        return path

    try:
        # Re-downloading the same song should overwrite, not accumulate copies.
        target.unlink(missing_ok=True)
        path.replace(target)
        return target
    except OSError:
        return path


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
