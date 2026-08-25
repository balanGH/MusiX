"""Audio conversion and stem separation.

Runs Demucs as a subprocess rather than importing it, for two reasons: the
import pulls in the whole PyTorch stack at server start even when nobody ever
separates anything, and a subprocess can be killed cleanly when the user
cancels — an in-process inference cannot.

Progress is parsed from Demucs' own stderr, so the percentage the UI shows is
real. The previous version reported 10% and then 100%, which told the user
nothing during the several minutes in between.
"""

from __future__ import annotations

import asyncio
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

import config


class ProcessingError(RuntimeError):
    """Raised for any failure that should reach the user as a message."""


@dataclass
class SeparationResult:
    stems: dict[str, Path]
    model: str


ProgressCallback = Callable[[float, str], None]

# Demucs writes a tqdm-style bar to stderr; this pulls the fraction out of it.
_PROGRESS_PATTERN = re.compile(r"(\d+)%\|")


async def convert_to_wav(source: Path, destination: Path) -> Path:
    """Normalise any input to 44.1 kHz stereo 16-bit WAV.

    Demucs wants a consistent input format, and doing the conversion up front
    means one predictable failure point instead of a decode error deep inside
    the model.
    """
    if not config.ffmpeg_available():
        raise ProcessingError(
            "FFmpeg was not found on PATH. Install it and restart the studio service."
        )

    process = await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-nostdin",
        "-loglevel",
        "error",
        "-i",
        str(source),
        "-acodec",
        "pcm_s16le",
        "-ar",
        "44100",
        "-ac",
        "2",
        "-y",
        str(destination),
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await process.communicate()

    if process.returncode != 0:
        detail = stderr.decode("utf-8", "replace").strip()[:400]
        raise ProcessingError(f"Could not decode this audio file. {detail}")

    if not destination.exists() or destination.stat().st_size == 0:
        raise ProcessingError("Conversion produced no audio.")

    return destination


async def encode_stem(source_wav: Path, destination_mp3: Path) -> None:
    """Transcode one separated stem from WAV to MP3.

    Demucs' output is uncompressed WAV; left as-is, a handful of full-length
    stems would each be roughly 10x the size of a typical compressed source
    file. MP3 at a fixed bitrate keeps them close to the original's size and
    is more than good enough for listening and remixing.
    """
    process = await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-nostdin",
        "-loglevel",
        "error",
        "-i",
        str(source_wav),
        "-codec:a",
        "libmp3lame",
        "-b:a",
        config.STEM_BITRATE,
        "-y",
        str(destination_mp3),
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await process.communicate()

    if process.returncode != 0 or not destination_mp3.exists():
        detail = stderr.decode("utf-8", "replace").strip()[:400]
        raise ProcessingError(f"Could not encode the “{source_wav.stem}” stem. {detail}")


async def separate(
    source_wav: Path,
    job_id: str,
    requested_stems: Iterable[str],
    on_progress: ProgressCallback,
    cancel_event: asyncio.Event,
) -> SeparationResult:
    """Run Demucs and collect the stems it produced."""
    model, produced = config.stems_for(list(requested_stems))
    output_root = config.OUTPUT_DIR / job_id
    output_root.mkdir(parents=True, exist_ok=True)

    device = config.torch_device()

    command = [
        sys.executable,
        "-m",
        "demucs.separate",
        "-n",
        model,
        "--device",
        device,
        "-o",
        str(output_root),
        str(source_wav),
    ]

    process = await asyncio.create_subprocess_exec(
        *command,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )

    async def watch_cancel() -> None:
        await cancel_event.wait()
        if process.returncode is None:
            process.terminate()

    cancel_task = asyncio.create_task(watch_cancel())
    stderr_tail: list[str] = []

    try:
        assert process.stderr is not None
        # Demucs redraws its progress bar with carriage returns, so lines have
        # to be split on \r as well as \n.
        buffer = b""
        while True:
            chunk = await process.stderr.read(256)
            if not chunk:
                break
            buffer += chunk
            parts = re.split(rb"[\r\n]", buffer)
            buffer = parts.pop()
            for part in parts:
                text = part.decode("utf-8", "replace").strip()
                if not text:
                    continue
                stderr_tail.append(text)
                del stderr_tail[:-20]
                match = _PROGRESS_PATTERN.search(text)
                if match:
                    # Demucs' own bar covers the separation only, which is the
                    # bulk of the work; map it onto 10–95% of the job.
                    fraction = int(match.group(1)) / 100
                    on_progress(10 + fraction * 85, "Separating stems")

        await process.wait()
    finally:
        # The watcher is only alive to terminate the subprocess; once the
        # process has exited it has nothing left to do.
        cancel_task.cancel()

    if cancel_event.is_set():
        raise ProcessingError("Cancelled.")

    if process.returncode != 0:
        detail = " ".join(stderr_tail[-4:])[:400]
        if "No such file or directory" in detail or "not found" in detail.lower():
            raise ProcessingError(
                "Demucs is not installed. Run: pip install -r requirements.txt"
            )
        raise ProcessingError(f"Separation failed. {detail}")

    on_progress(96, "Collecting stems")

    # Demucs writes to <output>/<model>/<input stem name>/<stem>.wav
    separated_dir = output_root / model / source_wav.stem
    if not separated_dir.exists():
        raise ProcessingError("Demucs produced no output directory.")

    candidates = [
        (name, separated_dir / f"{name}.wav")
        for name in produced
        if (separated_dir / f"{name}.wav").exists()
    ]
    if not candidates:
        raise ProcessingError("Demucs finished but produced no stems.")

    on_progress(97, "Encoding stems")
    stems: dict[str, Path] = {}
    for index, (name, candidate) in enumerate(candidates):
        destination = output_root / f"{name}.mp3"
        await encode_stem(candidate, destination)
        stems[name] = destination
        on_progress(97 + (index + 1) / len(candidates) * 3, "Encoding stems")

    # Remove the nested working directory, keeping only the flat stem files.
    shutil.rmtree(output_root / model, ignore_errors=True)

    return SeparationResult(stems=stems, model=model)


def cleanup_job(job_id: str) -> None:
    """Delete everything belonging to one job."""
    shutil.rmtree(config.OUTPUT_DIR / job_id, ignore_errors=True)
    for leftover in config.UPLOAD_DIR.glob(f"{job_id}*"):
        leftover.unlink(missing_ok=True)


def model_is_downloaded(model: str) -> bool:
    """Have the model weights already been fetched?

    Used only to warn the user that the first run will pull ~2 GB.
    """
    try:
        from torch.hub import get_dir  # noqa: PLC0415 - optional heavy import
    except Exception:  # noqa: BLE001
        return False

    checkpoints = Path(get_dir()) / "checkpoints"
    if not checkpoints.exists():
        return False
    return any(checkpoints.iterdir())


def probe_demucs() -> bool:
    """Is Demucs importable in this environment?"""
    try:
        subprocess.run(
            [sys.executable, "-c", "import demucs"],
            check=True,
            capture_output=True,
            timeout=30,
        )
        return True
    except Exception:  # noqa: BLE001
        return False
