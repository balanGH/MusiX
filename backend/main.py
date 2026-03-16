from fastapi import FastAPI, UploadFile, File, HTTPException, BackgroundTasks
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from pathlib import Path
import uuid
import asyncio

import config
import audio_processor

app = FastAPI(title="MusiX API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory job tracker
jobs = {}

class ProcessRequest(BaseModel):
    youtube_url: str

class JobResponse(BaseModel):
    job_id: str
    status: str
    progress: int
    vocals_url: str | None = None
    instrumental_url: str | None = None
    error_message: str | None = None

async def process_job_background(job_id: str, file_path: Path = None, youtube_url: str = None):
    try:
        jobs[job_id]["status"] = "processing"
        jobs[job_id]["progress"] = 10

        vocals_path, instrumental_path = await audio_processor.process_audio(
            job_id, file_path, youtube_url
        )

        jobs[job_id]["status"] = "completed"
        jobs[job_id]["progress"] = 100
        jobs[job_id]["vocals_path"] = str(vocals_path)
        jobs[job_id]["instrumental_path"] = str(instrumental_path)

    except Exception as e:
        jobs[job_id]["status"] = "failed"
        jobs[job_id]["error_message"] = str(e)

@app.post("/api/upload")
async def upload_file(background_tasks: BackgroundTasks, file: UploadFile = File(...)):
    file_ext = Path(file.filename).suffix.lower()
    if file_ext not in config.ALLOWED_EXTENSIONS:
        raise HTTPException(400, "Invalid file type")

    job_id = str(uuid.uuid4())

    jobs[job_id] = {
        "status": "pending",
        "progress": 0,
        "vocals_path": None,
        "instrumental_path": None,
        "error_message": None
    }

    file_path = config.UPLOAD_DIR / f"{job_id}{file_ext}"
    with open(file_path, "wb") as f:
        f.write(await file.read())

    background_tasks.add_task(process_job_background, job_id, file_path=file_path)
    return {"job_id": job_id}

@app.post("/api/process")
async def process_youtube(request: ProcessRequest, background_tasks: BackgroundTasks):
    job_id = str(uuid.uuid4())

    jobs[job_id] = {
        "status": "pending",
        "progress": 0,
        "vocals_path": None,
        "instrumental_path": None,
        "error_message": None
    }

    background_tasks.add_task(process_job_background, job_id, youtube_url=request.youtube_url)
    return {"job_id": job_id}

@app.get("/api/status/{job_id}")
async def get_status(job_id: str):
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")

    job = jobs[job_id]

    response = JobResponse(
        job_id=job_id,
        status=job["status"],
        progress=job["progress"],
        error_message=job.get("error_message")
    )

    if job["status"] == "completed":
        response.vocals_url = f"/api/download/{job_id}/vocals"
        response.instrumental_url = f"/api/download/{job_id}/instrumental"

    return response

@app.get("/api/download/{job_id}/{track_type}")
async def download_track(job_id: str, track_type: str):
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")

    job = jobs[job_id]

    if job["status"] != "completed":
        raise HTTPException(400, "Job not completed")

    if track_type == "vocals":
        file_path = Path(job["vocals_path"])
    elif track_type == "instrumental":
        file_path = Path(job["instrumental_path"])
    else:
        raise HTTPException(400, "Invalid track type")

    if not file_path.exists():
        raise HTTPException(404, "File not found")

    return FileResponse(file_path, media_type="audio/wav", filename=f"{track_type}.wav")

@app.get("/api/health")
async def health():
    return {"status": "healthy"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)