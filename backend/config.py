"""Configuration for the MusiX audio-studio service.

Everything is overridable by environment variable so a user can point storage at
a different disk or switch to a GPU without editing code.
"""

from __future__ import annotations

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

for folder in (STORAGE_DIR, UPLOAD_DIR, OUTPUT_DIR):
    folder.mkdir(parents=True, exist_ok=True)

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
        "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173",
    ).split(",")
    if origin.strip()
]


def ffmpeg_available() -> bool:
    """FFmpeg is required to normalise input to WAV before separation."""
    return shutil.which("ffmpeg") is not None


def torch_device() -> str:
    """Prefer CUDA when it is genuinely usable, else CPU."""
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
