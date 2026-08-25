"""MusiX audio-studio service.

A small, local-only FastAPI app that does the one thing a browser cannot:
run Demucs to split a track into stems.

It is *optional*. MusiX works completely without it; the Studio page detects
its absence and says so.

What changed from the previous version, and why:

  * The API contract now matches the client. `process_audio` returns a dict of
    stems, so the old `vocals, instrumental = await process_audio(...)` unpack
    raised `ValueError` on every job, and the download route only knew two of
    the five stems the player requested.
  * Jobs are persisted to disk, so a restart does not lose completed work.
  * Progress is real, parsed from Demucs' output, rather than 10 → 100.
  * The upload size limit is enforced while streaming, instead of being
    declared and ignored while the whole file was read into memory.
  * CORS is restricted to the local app. `allow_origins=["*"]` together with
    `allow_credentials=True` is rejected by browsers anyway.
  * Stem downloads are served by name from a fixed set, so a crafted job id or
    stem name cannot escape the storage directory.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

import audio_processor
import config

app = FastAPI(title="MusiX Audio Studio", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type"],
)


# ---------------------------------------------------------------------------
# Job state
# ---------------------------------------------------------------------------


@dataclass
class StemInfo:
    name: str
    url: str
    sizeBytes: int  # noqa: N815 - matches the TypeScript client


@dataclass
class Job:
    jobId: str  # noqa: N815
    status: str
    progress: float
    stage: str
    sourceName: str  # noqa: N815
    stems: list[StemInfo] = field(default_factory=list)
    error: str | None = None
    # sha256 of the uploaded audio, used to skip re-separating a file that was
    # already processed. None for jobs persisted before this field existed.
    sourceHash: str | None = None  # noqa: N815
    createdAt: float = field(default_factory=lambda: time.time() * 1000)  # noqa: N815
    updatedAt: float = field(default_factory=lambda: time.time() * 1000)  # noqa: N815

    def touch(self, *, status: str | None = None, progress: float | None = None, stage: str | None = None) -> None:
        if status is not None:
            self.status = status
        if progress is not None:
            self.progress = round(progress, 1)
        if stage is not None:
            self.stage = stage
        self.updatedAt = time.time() * 1000


JOBS: dict[str, Job] = {}
CANCELS: dict[str, asyncio.Event] = {}


def save_state() -> None:
    """Persist jobs so a restart does not lose completed work."""
    try:
        payload = [asdict(job) for job in JOBS.values()]
        config.STATE_FILE.write_text(json.dumps(payload), encoding="utf-8")
    except OSError:
        # Losing the index is survivable; failing a request over it is not.
        pass


def load_state() -> None:
    if not config.STATE_FILE.exists():
        return
    try:
        raw = json.loads(config.STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return

    for entry in raw:
        try:
            stems = [StemInfo(**stem) for stem in entry.pop("stems", [])]
            job = Job(**entry, stems=stems)
        except TypeError:
            continue

        # A job that was mid-flight when the server stopped cannot be resumed.
        if job.status not in {"complete", "failed"}:
            job.status = "failed"
            job.error = "The service restarted while this job was running."

        # Drop jobs whose files are gone.
        if job.status == "complete" and not (config.OUTPUT_DIR / job.jobId).exists():
            continue

        JOBS[job.jobId] = job


def find_reusable_job(source_hash: str, needed_stems: list[str]) -> Job | None:
    """A completed job for the same audio that already has the needed stems.

    Keyed on content hash rather than filename or track id, so the same song
    reuploaded under a different name — or re-run from the library after being
    renamed — still hits the cache instead of re-running Demucs.
    """
    needed = set(needed_stems)
    for job in JOBS.values():
        if job.status != "complete" or job.sourceHash != source_hash:
            continue
        available = {stem.name for stem in job.stems}
        if not needed.issubset(available):
            continue
        if all((config.OUTPUT_DIR / job.jobId / f"{name}.mp3").is_file() for name in needed):
            return job
    return None


def prune_jobs() -> None:
    """Keep the job list bounded, deleting the oldest jobs' files with them."""
    if len(JOBS) <= config.MAX_JOBS_KEPT:
        return
    ordered = sorted(JOBS.values(), key=lambda job: job.createdAt)
    for job in ordered[: len(JOBS) - config.MAX_JOBS_KEPT]:
        audio_processor.cleanup_job(job.jobId)
        JOBS.pop(job.jobId, None)


load_state()


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------


@app.get("/api/health")
async def health() -> dict[str, object]:
    """What the Studio page probes on open."""
    device = config.torch_device()
    return {
        "status": "ok",
        "model": config.MODEL_NAME,
        "device": device,
        "modelReady": audio_processor.model_is_downloaded(config.MODEL_NAME),
        "maxUploadBytes": config.MAX_UPLOAD_BYTES,
        "availableStems": config.SIX_STEMS,
        "ffmpeg": config.ffmpeg_available(),
    }


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------


@app.get("/api/jobs")
async def list_jobs() -> list[dict]:
    return [asdict(job) for job in sorted(JOBS.values(), key=lambda job: -job.createdAt)]


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str) -> dict:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "That job no longer exists.")
    return asdict(job)


@app.post("/api/jobs")
async def create_job(
    file: UploadFile = File(...),
    stems: str = Form("vocals,drums,bass,other"),
    name: str = Form(""),
) -> dict[str, object]:
    """Accept an upload and start separating it."""
    if not config.ffmpeg_available():
        raise HTTPException(
            503, "FFmpeg is not installed on the server. Install it and restart the service."
        )

    filename = Path(file.filename or "audio")
    extension = filename.suffix.lower()
    if extension not in config.ALLOWED_EXTENSIONS:
        # Quote what actually arrived. A missing extension and an unsupported
        # one need completely different fixes, and the old wording ("this file
        # type") hid which of the two had happened.
        received = f"“{file.filename}”" if file.filename else "an unnamed upload"
        problem = (
            f"{received} has no file extension, so the format cannot be determined"
            if not extension
            else f"“{extension}” is not supported"
        )
        raise HTTPException(
            400,
            f"{problem}. Use one of: {', '.join(sorted(config.ALLOWED_EXTENSIONS))}.",
        )

    job_id = uuid.uuid4().hex
    upload_path = config.UPLOAD_DIR / f"{job_id}{extension}"

    # Stream to disk with the limit enforced as we go, so an oversized upload is
    # rejected before it has been fully received — never buffered in memory.
    # Hashed on the way past so a repeat upload of the same audio can be
    # recognised without a second read of the file.
    written = 0
    hasher = hashlib.sha256()
    try:
        with upload_path.open("wb") as sink:
            while chunk := await file.read(config.UPLOAD_CHUNK_BYTES):
                written += len(chunk)
                if written > config.MAX_UPLOAD_BYTES:
                    sink.close()
                    upload_path.unlink(missing_ok=True)
                    raise HTTPException(
                        413,
                        f"That file is larger than the "
                        f"{config.MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit.",
                    )
                hasher.update(chunk)
                sink.write(chunk)
    except HTTPException:
        raise
    except OSError as error:
        upload_path.unlink(missing_ok=True)
        raise HTTPException(500, f"Could not save the upload: {error}") from error

    if written == 0:
        upload_path.unlink(missing_ok=True)
        raise HTTPException(400, "The uploaded file was empty.")

    source_hash = hasher.hexdigest()
    requested = [stem.strip() for stem in stems.split(",") if stem.strip()]
    _model, needed_stems = config.stems_for(requested)

    reusable = find_reusable_job(source_hash, needed_stems)
    if reusable is not None:
        # Same audio, already separated (possibly under a different name or
        # for a different stem selection covered by the same model) — the
        # stems are still on disk, so there is nothing to run again.
        upload_path.unlink(missing_ok=True)
        return {"jobId": reusable.jobId, "reused": True}

    job = Job(
        jobId=job_id,
        status="queued",
        progress=0,
        stage="Queued",
        # The client's label if it sent one, otherwise the filename without its
        # extension. Used for the UI and for naming downloaded stems.
        sourceName=name.strip() or filename.stem,
        sourceHash=source_hash,
    )
    JOBS[job_id] = job
    CANCELS[job_id] = asyncio.Event()
    prune_jobs()
    save_state()

    # `create_task`, not FastAPI's BackgroundTasks: the response must return
    # immediately so the client can start polling, and BackgroundTasks runs
    # after the response is sent but blocks the worker while it does.
    asyncio.create_task(run_job(job_id, upload_path, requested))

    return {"jobId": job_id, "reused": False}


@app.delete("/api/jobs/{job_id}")
async def cancel(job_id: str) -> dict[str, bool]:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "That job no longer exists.")

    event = CANCELS.get(job_id)
    if event and job.status not in {"complete", "failed"}:
        event.set()
        return {"cancelled": True}

    # Already finished: cancelling means deleting it.
    audio_processor.cleanup_job(job_id)
    JOBS.pop(job_id, None)
    CANCELS.pop(job_id, None)
    save_state()
    return {"cancelled": True}


@app.get("/api/jobs/{job_id}/stems/{stem}")
async def download_stem(job_id: str, stem: str) -> FileResponse:
    """Serve one stem.

    The job's own record is the only source of truth for which files exist, so
    neither `job_id` nor `stem` is ever used to build a path directly — a
    crafted value cannot reach outside the storage directory.
    """
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "That job no longer exists.")
    if job.status != "complete":
        raise HTTPException(409, "That job has not finished yet.")

    if not any(info.name == stem for info in job.stems):
        available = ", ".join(info.name for info in job.stems) or "none"
        raise HTTPException(404, f"No “{stem}” stem in this job. Available: {available}.")

    path = config.OUTPUT_DIR / job_id / f"{stem}.mp3"
    if not path.is_file():
        raise HTTPException(410, "That stem file has been removed from disk.")

    return FileResponse(
        path,
        media_type="audio/mpeg",
        filename=f"{job.sourceName} - {stem}.mp3",
        # Lets the browser seek within the stem while the mixer plays it.
        headers={"Accept-Ranges": "bytes"},
    )


# ---------------------------------------------------------------------------
# Worker
# ---------------------------------------------------------------------------


async def run_job(job_id: str, upload_path: Path, requested_stems: list[str]) -> None:
    """Convert, separate, and record the result."""
    job = JOBS.get(job_id)
    cancel_event = CANCELS.get(job_id)
    if not job or cancel_event is None:
        return

    def report(progress: float, stage: str) -> None:
        job.touch(progress=progress, stage=stage)

    try:
        job.touch(status="converting", progress=2, stage="Decoding audio")
        wav_path = config.UPLOAD_DIR / f"{job_id}.wav"
        await audio_processor.convert_to_wav(upload_path, wav_path)

        if cancel_event.is_set():
            raise audio_processor.ProcessingError("Cancelled.")

        job.touch(status="separating", progress=10, stage="Separating stems")
        result = await audio_processor.separate(
            wav_path, job_id, requested_stems, report, cancel_event
        )

        job.stems = [
            StemInfo(
                name=name,
                url=f"/api/jobs/{job_id}/stems/{name}",
                sizeBytes=path.stat().st_size,
            )
            for name, path in sorted(result.stems.items())
        ]
        job.touch(status="complete", progress=100, stage="Done")

    except audio_processor.ProcessingError as error:
        cancelled = str(error) == "Cancelled."
        job.error = None if cancelled else str(error)
        job.touch(status="failed", stage="Cancelled" if cancelled else "Failed")
        if cancelled:
            job.error = "Cancelled."
        audio_processor.cleanup_job(job_id)

    except Exception as error:  # noqa: BLE001 - a worker must never die silently
        job.error = f"Unexpected error: {error}"
        job.touch(status="failed", stage="Failed")
        audio_processor.cleanup_job(job_id)

    finally:
        # The converted WAV is large and only needed during separation.
        (config.UPLOAD_DIR / f"{job_id}.wav").unlink(missing_ok=True)
        upload_path.unlink(missing_ok=True)
        CANCELS.pop(job_id, None)
        save_state()


if __name__ == "__main__":
    import uvicorn

    print(f"MusiX audio studio on http://{config.HOST}:{config.PORT}")
    print(f"  model:  {config.MODEL_NAME} ({config.torch_device()})")
    print(f"  ffmpeg: {'found' if config.ffmpeg_available() else 'MISSING — install it'}")
    print(f"  demucs: {'found' if audio_processor.probe_demucs() else 'MISSING — pip install -r requirements.txt'}")
    uvicorn.run(app, host=config.HOST, port=config.PORT)
