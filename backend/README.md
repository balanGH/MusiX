# MusiX Backend

FastAPI backend for MusiX audio separation service.

## Setup

1. Install Python dependencies:
```bash
pip install -r requirements.txt
```

2. Ensure FFmpeg is installed on your system

3. Create storage directories (automatically created on first run):
```bash
mkdir -p storage/uploads storage/outputs
```

4. Set up environment variables in the root `.env` file:
```env
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
```

## Running

```bash
python main.py
```

Server will start on `http://localhost:8000`

## API Documentation

Once running, visit:
- Swagger UI: `http://localhost:8000/docs`
- ReDoc: `http://localhost:8000/redoc`

## Demucs Model

The first run will download the Demucs model (approximately 2GB). This is stored in your home directory under `.cache/torch/hub/checkpoints/`.

## Dependencies

- **FastAPI**: Web framework
- **uvicorn**: ASGI server
- **demucs**: AI audio separation
- **yt-dlp**: YouTube download
- **torch**: Deep learning framework
- **supabase**: Database client
- **python-multipart**: File upload support
- **aiofiles**: Async file operations

## Audio Processing Pipeline

1. **Input**: YouTube URL or uploaded file
2. **Download/Convert**: Get audio in WAV format (44.1kHz, stereo)
3. **Separation**: Demucs two-stem model separates vocals and instrumental
4. **Storage**: Save separated tracks to `storage/outputs/{job_id}/`
5. **Response**: Return URLs for downloading separated tracks

## Performance

- CPU-based processing (default)
- Processing time: ~1-3 minutes for a 3-minute song
- GPU acceleration available with CUDA installation

## Storage Structure

```
storage/
├── uploads/           # Original uploaded/downloaded files
│   └── {job_id}.wav
└── outputs/           # Separated tracks
    └── {job_id}/
        ├── vocals.wav
        └── instrumental.wav
```

## Error Handling

All errors are logged and stored in the database `jobs` table with status `failed` and an `error_message` field.
