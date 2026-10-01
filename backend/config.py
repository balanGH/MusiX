"""Configuration for the MusiX audio-studio service.

Everything is overridable by environment variable so a user can point storage at
a different disk or switch to a GPU without editing code.
"""

from __future__ import annotations

import functools
import json
import os
import shutil
from pathlib import Path

BASE_DIR = Path(__file__).parent

# --------------------------------------------------------------------------
# Storage
# --------------------------------------------------------------------------

STORAGE_DIR = Path(os.environ.get("MUSIX_STORAGE", BASE_DIR / "storage"))
UPLOAD_DIR = STORAGE_DIR / "uploads"
OUTPUT_DIR = STORAGE_DIR / "outputs"
STATE_FILE = STORAGE_DIR / "jobs.json"
SETTINGS_FILE = STORAGE_DIR / "settings.json"

for folder in (STORAGE_DIR, UPLOAD_DIR, OUTPUT_DIR):
    folder.mkdir(parents=True, exist_ok=True)


# --------------------------------------------------------------------------
# Download folder
# --------------------------------------------------------------------------

#: Where finished downloads are written when the user has not chosen anywhere.
DEFAULT_DOWNLOAD_DIR = STORAGE_DIR / "downloads"

#: Precedence: the env var pins the folder and cannot be changed from the UI;
#: otherwise a folder chosen in Settings wins; otherwise the default above.
_ENV_DOWNLOAD_DIR = os.environ.get("MUSIX_DOWNLOAD_DIR")


def _read_settings() -> dict:
    try:
        return json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def write_atomically(path: Path, text: str) -> None:
    """Replace `path` with `text` so a crash mid-write cannot leave it half-written.

    The new content goes to a sibling temp file first; `os.replace` then swaps
    it in, which is atomic on the same filesystem.
    """
    temp = path.with_name(f"{path.name}.tmp")
    try:
        temp.write_text(text, encoding="utf-8")
        os.replace(temp, path)
    except OSError:
        temp.unlink(missing_ok=True)
        raise


def _write_settings(settings: dict) -> None:
    try:
        write_atomically(SETTINGS_FILE, json.dumps(settings, indent=2))
    except OSError:
        # A settings file that cannot be written is not worth failing a
        # download over; the choice simply will not survive a restart.
        pass


def download_dir() -> Path:
    """The folder downloads are written to right now.

    Read on every use rather than captured at import, so a folder chosen in
    Settings takes effect immediately instead of after a restart.
    """
    if _ENV_DOWNLOAD_DIR:
        folder = Path(_ENV_DOWNLOAD_DIR)
    else:
        chosen = _read_settings().get("downloadDir")
        folder = Path(chosen) if chosen else DEFAULT_DOWNLOAD_DIR

    try:
        folder.mkdir(parents=True, exist_ok=True)
    except OSError:
        # The chosen folder has gone — an unplugged drive, say. Fall back
        # rather than failing every download from then on.
        DEFAULT_DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
        return DEFAULT_DOWNLOAD_DIR

    return folder


def download_dir_is_fixed() -> bool:
    """True when MUSIX_DOWNLOAD_DIR pins the folder, so the UI must not offer
    to change it."""
    return bool(_ENV_DOWNLOAD_DIR)


class DownloadDirError(ValueError):
    """A folder the user chose that cannot be used, with a reason to show."""


def set_download_dir(raw: str) -> Path:
    """Validate and persist a user-chosen download folder.

    Checks that it can actually be written to *now*, because the alternative is
    accepting the path and failing on every download afterwards with no clue
    why.
    """
    if download_dir_is_fixed():
        raise DownloadDirError(
            "The download folder is fixed by the MUSIX_DOWNLOAD_DIR environment variable."
        )

    candidate = Path(raw.strip().strip('"')).expanduser()

    if not candidate.is_absolute():
        raise DownloadDirError("Enter a full path, for example C:\\Users\\You\\Music\\MusiX.")

    if candidate.exists() and not candidate.is_dir():
        raise DownloadDirError("That path is a file, not a folder.")

    try:
        candidate.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise DownloadDirError(f"That folder could not be created: {error.strerror or error}") from error

    # Prove it is writable rather than trusting the permission bits.
    probe = candidate / ".musix-write-test"
    try:
        probe.write_text("", encoding="utf-8")
        probe.unlink(missing_ok=True)
    except OSError as error:
        raise DownloadDirError(
            f"That folder is not writable: {error.strerror or error}"
        ) from error

    settings = _read_settings()
    settings["downloadDir"] = str(candidate)
    _write_settings(settings)

    return candidate

# --------------------------------------------------------------------------
# Limits
# --------------------------------------------------------------------------

# 512 MB covers a long lossless track with room to spare. Enforced while
# streaming the upload, not after it — the previous version declared a limit and
# never checked it, so a large file was fully buffered in memory first.
MAX_UPLOAD_BYTES = int(os.environ.get("MUSIX_MAX_UPLOAD", 512 * 1024 * 1024))

# Read the upload in chunks rather than all at once.
UPLOAD_CHUNK_BYTES = 1024 * 1024

ALLOWED_EXTENSIONS = {
    ".mp3",
    ".flac",
    ".wav",
    ".m4a",
    ".aac",
    ".ogg",
    ".opus",
    ".aiff",
    ".aif",
}

# Completed jobs are kept so the user can come back to a mix, but not forever.
MAX_JOBS_KEPT = int(os.environ.get("MUSIX_MAX_JOBS", 20))

# --------------------------------------------------------------------------
# Model
# --------------------------------------------------------------------------

# `htdemucs` gives vocals/drums/bass/other. `htdemucs_6s` adds guitar and piano
# and is roughly twice as slow.
MODEL_NAME = os.environ.get("MUSIX_MODEL", "htdemucs")
SIX_STEM_MODEL = "htdemucs_6s"

FOUR_STEMS = ["vocals", "drums", "bass", "other"]
SIX_STEMS = ["vocals", "drums", "bass", "guitar", "piano", "other"]

# Demucs writes stems as uncompressed WAV — a full-length 44.1kHz/16-bit/stereo
# file per stem, so a 4 MB source MP3 becomes four or six ~35 MB files. Each
# stem is transcoded to MP3 right after separation so what lands on disk (and
# gets served/downloaded) is close to the original's size instead of ~10x it.
STEM_BITRATE = os.environ.get("MUSIX_STEM_BITRATE", "192k")

# --------------------------------------------------------------------------
# Server
# --------------------------------------------------------------------------

HOST = os.environ.get("MUSIX_HOST", "127.0.0.1")
PORT = int(os.environ.get("MUSIX_PORT", 8000))

# Only the local dev server and the built app are allowed.
#
# The previous version sent `allow_origins=["*"]` together with
# `allow_credentials=True`, which browsers reject outright — and which would be
# wrong anyway for a service holding the user's audio.
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.environ.get(
        "MUSIX_ALLOWED_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173,"
        # The Capacitor shells (iOS and Android WebViews respectively).
        "capacitor://localhost,https://localhost",
    ).split(",")
    if origin.strip()
]

# Host names the service answers to. Anything else is refused, which is what
# stops DNS rebinding: a page on evil.example that re-points its own name at
# 127.0.0.1 still sends `Host: evil.example`. The Vite proxy forwards the
# browser's own Host (`changeOrigin: false`), i.e. `localhost` or `127.0.0.1`.
# Add a LAN name or address here only if you deliberately expose the service.
ALLOWED_HOSTS = [
    host.strip()
    for host in os.environ.get("MUSIX_ALLOWED_HOSTS", "127.0.0.1,localhost").split(",")
    if host.strip()
]


def ffmpeg_available() -> bool:
    """FFmpeg is required to normalise input to WAV before separation."""
    return shutil.which("ffmpeg") is not None


@functools.lru_cache(maxsize=1)
def torch_device() -> str:
    """Prefer CUDA when it is genuinely usable, else CPU.

    Cached: the answer cannot change while the process runs, and the first call
    imports torch, which takes seconds. Async callers should still make that
    first call through `asyncio.to_thread` so it does not stall the event loop.
    """
    override = os.environ.get("MUSIX_DEVICE")
    if override:
        return override
    try:
        import torch  # noqa: PLC0415 - optional heavy import

        if torch.cuda.is_available():
            return "cuda"
    except Exception:  # noqa: BLE001 - torch missing or broken is not fatal here
        pass
    return "cpu"


def stems_for(requested: list[str]) -> tuple[str, list[str]]:
    """Pick the model that can produce the requested stems.

    Returns (model name, the stems that model will actually write). Asking for
    guitar or piano forces the six-stem model; anything else uses the faster
    four-stem one.
    """
    wanted = {stem.strip().lower() for stem in requested if stem.strip()}
    if wanted & {"guitar", "piano"}:
        return SIX_STEM_MODEL, SIX_STEMS
    return MODEL_NAME, FOUR_STEMS


def kept_stems(requested: list[str]) -> list[str]:
    """The stems a job keeps: the requested ones the chosen model produces.

    Demucs always writes every stem of its model, but only the ones asked for
    are encoded and kept. An empty or unrecognised request keeps them all.
    """
    _model, produced = stems_for(requested)
    wanted = {stem.strip().lower() for stem in requested if stem.strip()}
    return [name for name in produced if name in wanted] or produced
