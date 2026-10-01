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
  * CORS only decides who may *read* a response, so mutating routes also check
    `Origin` and `Content-Type`, and unknown `Host` headers are refused — see
    `LocalRequestGuard`.
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
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from starlette.datastructures import Headers
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.types import ASGIApp, Message, Receive, Scope, Send

import audio_processor
import config
import downloader

app = FastAPI(title="MusiX Audio Studio", version="1.0.0")

MUTATING_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
UPLOAD_ROUTE = "/api/jobs"
# Room for the multipart framing and the small form fields around the file,
# so the body cap below never rejects a file the handler itself would accept.
MULTIPART_OVERHEAD_BYTES = 1024 * 1024


def _upload_too_large() -> str:
    return f"That file is larger than the {config.MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit."


class LocalRequestGuard:
    """Refuses cross-site writes, and caps the upload body before it is parsed.

    CORS alone does not protect a local service: a page on any site can send a
    `no-cors` POST whose body FastAPI happily parses — it just cannot read the
    reply. So for every mutating request:

      * a present `Origin` must be one of `ALLOWED_ORIGINS` (browsers always
        send it on POST/DELETE; tools like curl send none and are allowed);
      * JSON routes require `Content-Type: application/json`, which a
        cross-site page cannot send without a CORS preflight, and the upload
        route requires `multipart/form-data`.

    The upload cap lives here rather than in the handler because `UploadFile`
    has already spooled the whole body to disk by the time the handler runs.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] not in MUTATING_METHODS:
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        origin = headers.get("origin")
        if origin is not None and origin not in config.ALLOWED_ORIGINS:
            await _reject(403, "Origin not allowed.", scope, receive, send)
            return

        is_upload = scope["path"] == UPLOAD_ROUTE and scope["method"] == "POST"

        if scope["method"] == "POST":
            content_type = headers.get("content-type", "").split(";")[0].strip().lower()
            expected = "multipart/form-data" if is_upload else "application/json"
            if content_type != expected:
                await _reject(415, f"Expected a {expected} request body.", scope, receive, send)
                return

        if not is_upload:
            await self.app(scope, receive, send)
            return

        limit = config.MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES
        declared = headers.get("content-length")
        if declared is not None:
            try:
                too_large = int(declared) > limit
            except ValueError:
                await _reject(400, "Invalid Content-Length.", scope, receive, send)
                return
            if too_large:
                await _reject(413, _upload_too_large(), scope, receive, send)
                return

        # A chunked upload declares no length, so count as it streams too.
        received = 0

        async def capped_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    # FastAPI re-raises HTTPExceptions from body parsing, so
                    # this reaches the client as a 413 rather than a 400.
                    raise HTTPException(413, _upload_too_large())
            return message

        await self.app(scope, capped_receive, send)


async def _reject(status: int, detail: str, scope: Scope, receive: Receive, send: Send) -> None:
    await JSONResponse({"detail": detail}, status_code=status)(scope, receive, send)


# The last one added runs first: host check, then CORS, then the guard — so an
# allowed origin can still read the guard's error responses.
app.add_middleware(LocalRequestGuard)
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type"],
)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=config.ALLOWED_HOSTS)


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

# Demucs needs several GB of RAM per run: one at a time, the rest queue.
DEMUCS_SLOT = asyncio.Semaphore(1)


def save_state() -> None:
    """Persist jobs so a restart does not lose completed work.

    Written atomically, so a crash mid-write cannot wipe every job.
    """
    try:
        payload = [asdict(job) for job in JOBS.values()]
        config.write_atomically(config.STATE_FILE, json.dumps(payload))
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
    # Both import torch, which takes seconds; keep that off the event loop.
    device = await asyncio.to_thread(config.torch_device)
    model_ready = await asyncio.to_thread(audio_processor.model_is_downloaded, config.MODEL_NAME)
    return {
        "status": "ok",
        "model": config.MODEL_NAME,
        "device": device,
        "modelReady": model_ready,
        "maxUploadBytes": config.MAX_UPLOAD_BYTES,
        "availableStems": config.SIX_STEMS,
        "ffmpeg": config.ffmpeg_available(),
    }


# ---------------------------------------------------------------------------
# Online music search / download
# ---------------------------------------------------------------------------


@app.get("/api/online/search")
async def online_search(q: str = "") -> list[dict]:
    """
    Search YouTube Music through yt-dlp.
    """

    query = q.strip()

    if not query:
        return []

    try:

        return await asyncio.to_thread(
            downloader.search_online,
            query,
            5,
        )

    except Exception as error:

        raise HTTPException(
            500,
            f"Online search failed: {error}",
        ) from error


@app.get("/api/online/download-path")
async def get_download_path() -> dict[str, object]:
    """Where downloads are written, and whether the user may change it."""
    current = config.download_dir()
    return {
        "path": str(current),
        "default": str(config.DEFAULT_DOWNLOAD_DIR),
        "isDefault": current == config.DEFAULT_DOWNLOAD_DIR,
        # Pinned by MUSIX_DOWNLOAD_DIR; the UI hides the control when set.
        "fixed": config.download_dir_is_fixed(),
    }


class DownloadPathRequest(BaseModel):
    """An absolute folder path on this machine.

    A model rather than a bare dict so an empty or malformed body is rejected
    with a clear 422 instead of reaching the filesystem code.
    """

    path: str


@app.post("/api/online/download-path")
async def set_download_path(request: DownloadPathRequest) -> dict[str, object]:
    """Choose a different download folder.

    The folder is created and write-tested before being accepted, so a bad
    choice fails here with a reason rather than silently breaking every
    later download.
    """
    try:
        chosen = config.set_download_dir(request.path)
    except config.DownloadDirError as error:
        raise HTTPException(400, str(error)) from error

    return {"path": str(chosen), "isDefault": chosen == config.DEFAULT_DOWNLOAD_DIR}


@app.post("/api/online/download")
async def online_download(payload: dict) -> dict[str, str]:

    url = payload.get("url")

    if not url or not isinstance(url, str):
        raise HTTPException(
            400,
            "Missing URL.",
        )

    # Only YouTube video links (or a bare video id) reach yt-dlp. Anything else
    # would let its generic extractor fetch arbitrary URLs, including ones on
    # the user's own network.
    video_id = downloader.video_id_from(url)
    if video_id is None:
        raise HTTPException(400, "Only YouTube or YouTube Music video links can be downloaded.")

    # Lyrics are looked up from an online service, so the client's privacy
    # setting decides (spec §32). Defaults to on: the user is already
    # downloading from the internet at this point.
    want_lyrics = payload.get("lyrics", True) is not False

    job_id = downloader.start_download(video_id, want_lyrics)

    return {
        "jobId": job_id,
    }


@app.get("/api/online/download/{job_id}")
async def online_download_status(
    job_id: str,
) -> dict:

    job = downloader.get_job(job_id)

    if job is None:

        raise HTTPException(
            404,
            "Download job not found.",
        )

    return job


@app.get("/api/online/download/{job_id}/file")
async def online_download_file(job_id: str) -> FileResponse:
    """Serve the finished MP3 so the client can add it to the library.

    The path comes only from the job's own record, never from `job_id`
    directly, so a crafted job id cannot escape the downloads directory.
    """
    job = downloader.get_job(job_id)

    if job is None:
        raise HTTPException(404, "Download job not found.")

    if job.get("status") != "complete" or not job.get("filename"):
        raise HTTPException(409, "That download has not finished yet.")

    path = Path(job["filename"])
    if not path.is_file():
        raise HTTPException(410, "That download's file has been removed from disk.")

    # The on-disk name, already made filename-safe by `safe_filename`. A name
    # built from the raw tags keeps a `/` ("AC/DC"), which the client cannot
    # use as a file name.
    return FileResponse(
        path,
        media_type="audio/mpeg",
        filename=path.name,
    )


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
    needed_stems = config.kept_stems(requested)

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


async def _acquire_demucs_slot(cancel_event: asyncio.Event) -> None:
    """Wait for the Demucs slot, giving up early if the job is cancelled meanwhile."""
    while True:
        try:
            await asyncio.wait_for(DEMUCS_SLOT.acquire(), timeout=0.5)
            return
        except TimeoutError:
            if cancel_event.is_set():
                raise audio_processor.ProcessingError("Cancelled.") from None


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

        if DEMUCS_SLOT.locked():
            job.touch(status="queued", stage="Waiting for another separation to finish")
        await _acquire_demucs_slot(cancel_event)
        try:
            job.touch(status="separating", progress=10, stage="Separating stems")
            result = await audio_processor.separate(
                wav_path, job_id, requested_stems, report, cancel_event
            )
        finally:
            DEMUCS_SLOT.release()

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
