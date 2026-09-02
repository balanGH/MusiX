"""
Lyrics lookup and embedding for downloaded songs.

Lyrics come from LRCLIB (https://lrclib.net), a free, open, no-account lyrics
database built for music players. It returns both plain text and synchronised
LRC, which matters here: MusiX's tag reader already detects LRC timestamps in an
embedded lyrics frame and renders them line-by-line in Now Playing, so writing
the synced form gets scrolling lyrics with no client-side work at all.

Two things this module is careful about:

  * **Matching the right recording.** A search hit with the same title and
    artist is often a *different* recording — a remaster, a live take, an edit.
    Synced timings from the wrong recording drift immediately and are worse than
    no lyrics, so synced lyrics are only accepted when the duration is close.
    A looser match still contributes plain text, where timing does not matter.

  * **Staying optional.** Every failure here is non-fatal. A song with no
    lyrics available downloads exactly as before.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

API_ROOT = "https://lrclib.net/api/"

#: LRCLIB asks clients to identify themselves.
USER_AGENT = "MusiX/0.1 (offline-first local music player)"

REQUEST_TIMEOUT = 20

#: Synced lyrics are only trusted when the recording length is within this many
#: seconds. Beyond it the timings would visibly drift.
SYNCED_TOLERANCE_SEC = 8

#: Plain lyrics tolerate a much looser match, since nothing is timed to them.
PLAIN_TOLERANCE_SEC = 45


@dataclass
class Lyrics:
    """What was found, and how well it matched."""

    text: str
    synced: bool
    source_id: int | None
    #: How far the matched recording's length was from ours, in seconds.
    duration_delta: float | None


def _request(path: str, params: dict[str, Any], attempts: int = 3) -> Any:
    """GET with a small backoff.

    LRCLIB returns a plain 404 when it simply has no match, which is an answer
    rather than a failure, so that is reported as None instead of raised.
    """
    url = API_ROOT + path + "?" + urllib.parse.urlencode(params)
    last_error: Exception | None = None

    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            # 503s from this service are routinely transient.
            last_error = error
        except Exception as error:  # noqa: BLE001 - network, DNS, timeouts
            last_error = error

        if attempt < attempts - 1:
            time.sleep(1.5 * (attempt + 1))

    if last_error:
        raise last_error
    return None


def _pick(entry: dict[str, Any], duration: float | None) -> Lyrics | None:
    """Turn one LRCLIB record into a result, if it is a good enough match."""
    if entry.get("instrumental"):
        return None

    synced = (entry.get("syncedLyrics") or "").strip()
    plain = (entry.get("plainLyrics") or "").strip()
    if not synced and not plain:
        return None

    delta: float | None = None
    if duration and entry.get("duration"):
        delta = abs(float(entry["duration"]) - float(duration))

    # Unknown duration on either side: fall back to plain text only, since
    # there is nothing to justify trusting the timings.
    if delta is None:
        return Lyrics(plain, False, entry.get("id"), None) if plain else None

    if synced and delta <= SYNCED_TOLERANCE_SEC:
        return Lyrics(synced, True, entry.get("id"), delta)

    if plain and delta <= PLAIN_TOLERANCE_SEC:
        return Lyrics(plain, False, entry.get("id"), delta)

    return None


def fetch(
    title: str,
    artists: list[str],
    album: str | None = None,
    duration: float | None = None,
) -> Lyrics | None:
    """Find lyrics for one track, or None.

    Tries the exact endpoint first — it is a single indexed lookup — and only
    falls back to a search, which is heavier on the service.
    """
    title = (title or "").strip()
    if not title:
        return None

    primary = artists[0] if artists else ""
    candidates: list[Lyrics] = []

    # 1. Exact match, most specific first. A hit here is the right *recording*,
    #    but LRCLIB may only hold plain text for it.
    for params in (
        {
            "track_name": title,
            "artist_name": primary,
            "album_name": album or "",
            "duration": int(duration) if duration else 0,
        },
        {"track_name": title, "artist_name": primary},
    ):
        if not params.get("artist_name"):
            continue
        try:
            found = _request("get", params)
        except Exception:
            found = None
        if isinstance(found, dict):
            picked = _pick(found, duration)
            if picked:
                candidates.append(picked)
                # Synced from an exact match is the best possible answer.
                if picked.synced:
                    return picked

    # 2. Search as well, even when an exact match already returned plain text:
    #    another upload of the same recording often has a synced version, and
    #    scrolling lyrics are the point of the feature.
    query = f"{title} {primary}".strip()
    try:
        results = _request("search", {"q": query})
    except Exception:
        results = None

    if isinstance(results, list):
        for entry in results[:20]:
            if not isinstance(entry, dict):
                continue
            picked = _pick(entry, duration)
            if picked:
                candidates.append(picked)

    if not candidates:
        return None

    # Prefer synced, then the closest duration.
    candidates.sort(
        key=lambda item: (
            not item.synced,
            item.duration_delta if item.duration_delta is not None else 1e9,
        )
    )
    return candidates[0]


# ---------------------------------------------------------------------------
# Embedding
# ---------------------------------------------------------------------------


def embed(path: Path, lyrics: Lyrics, language: str = "eng") -> bool:
    """Write the lyrics into the MP3 as an ID3 `USLT` frame.

    mutagen rather than ffmpeg: ffmpeg's MP3 muxer has no mapping for `USLT`
    and would write the text into a `TXXX` frame instead, which is not where
    any player — including MusiX's own tag reader — looks for lyrics.
    """
    try:
        from mutagen.id3 import ID3, USLT
        from mutagen.mp3 import MP3
    except ImportError:
        # mutagen is optional; without it the track simply keeps no lyrics.
        return False

    if not path.is_file() or not lyrics.text.strip():
        return False

    try:
        audio = MP3(path, ID3=ID3)
        if audio.tags is None:
            audio.add_tags()

        # Replace rather than append: re-downloading a track should not
        # accumulate several lyric frames.
        audio.tags.delall("USLT")
        audio.tags.add(USLT(encoding=3, lang=language, desc="", text=lyrics.text))

        # ID3v2.3 is the most widely readable version for this frame.
        audio.tags.save(path, v2_version=3)
        return True
    except Exception:
        return False


def read_embedded(path: Path) -> str | None:
    """The lyrics currently embedded in a file, if any. Used by the tests."""
    try:
        from mutagen.id3 import ID3

        tags = ID3(path)
        frames = tags.getall("USLT")
        return str(frames[0].text) if frames else None
    except Exception:
        return None
