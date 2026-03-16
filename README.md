# MusiX - AI-Powered Music Separation

MusiX is a full-stack web application that uses AI to separate vocals and instrumental tracks from songs. Users can upload audio files or paste YouTube links to process their music and create karaoke tracks or isolated vocals.

## Features

- **YouTube Support**: Paste a YouTube URL to process any song
- **Audio Upload**: Upload MP3, WAV, M4A, FLAC, or OGG files
- **AI-Powered Separation**: Uses Demucs AI model for high-quality vocal and instrumental separation
- **Interactive Player**: Real-time waveform visualization and playback
- **Volume Controls**: Independent volume sliders for vocals and instrumentals
- **Quick Modes**:
  - Karaoke Mode (mute vocals)
  - Vocals Only mode
  - Reset to original mix
- **Download Tracks**: Download separated vocals and instrumental tracks
- **Modern Dark UI**: Beautiful music studio-themed interface

## Tech Stack

### Frontend
- React 18 with TypeScript
- Vite for fast development
- React Router for navigation
- Tailwind CSS for styling
- Lucide React for icons
- Supabase for database

### Backend
- Python FastAPI
- Demucs AI (two-stem separation)
- yt-dlp for YouTube downloads
- FFmpeg for audio conversion
- Supabase for job tracking

## Prerequisites

Before running MusiX, ensure you have the following installed:

- Node.js (v18 or higher)
- Python (v3.9 or higher)
- FFmpeg (for audio processing)
- pip (Python package manager)

### Installing FFmpeg

**macOS:**
```bash
brew install ffmpeg
```

**Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install ffmpeg
```

**Windows:**
Download from [ffmpeg.org](https://ffmpeg.org/download.html) and add to PATH

## Setup Instructions

### 1. Clone the Repository

```bash
git clone <repository-url>
cd musix
```

### 2. Set Up Environment Variables

Create a `.env` file in the root directory:

```env
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
```

The Supabase database is already configured with the required schema.

### 3. Install Frontend Dependencies

```bash
npm install
```

### 4. Install Backend Dependencies

```bash
cd backend
pip install -r requirements.txt
```

The first time you run the backend, Demucs will download the AI model (approximately 2GB). This is a one-time download.

## Running the Application

You need to run both the frontend and backend servers.

### Terminal 1: Start the Backend

```bash
cd backend
python main.py
```

The backend will start on `http://localhost:8000`

### Terminal 2: Start the Frontend

```bash
npm run dev
```

The frontend will start on `http://localhost:5173`

## Usage

1. **Open the App**: Navigate to `http://localhost:5173`

2. **Choose Input Method**:
   - Paste a YouTube URL, or
   - Upload an audio file (drag-and-drop or browse)

3. **Process**: Click "Process Song" and wait for the AI to separate the tracks

4. **Play & Control**:
   - Use the play/pause button to control playback
   - Adjust vocal and instrumental volumes independently
   - Try Karaoke Mode to mute vocals
   - Try Vocals Only to isolate the singing

5. **Download**: Download the separated tracks for use in other applications

## How It Works

1. **Input**: User provides a YouTube URL or uploads an audio file
2. **Conversion**: Audio is converted to WAV format using FFmpeg
3. **AI Processing**: Demucs AI model separates the audio into vocals and instrumental tracks
4. **Storage**: Processed files are stored on the server
5. **Playback**: Frontend loads both tracks and plays them synchronously
6. **Control**: User can adjust volumes, download tracks, or process new songs

## Database Schema

The app uses Supabase with the following table:

**jobs**
- `id` (uuid): Unique job identifier
- `status` (text): pending, processing, completed, or failed
- `youtube_url` (text): YouTube URL if provided
- `original_filename` (text): Original file name if uploaded
- `vocals_path` (text): Path to separated vocals file
- `instrumental_path` (text): Path to separated instrumental file
- `progress` (integer): Processing progress (0-100)
- `error_message` (text): Error details if failed
- `created_at`, `updated_at`: Timestamps

## API Endpoints

- `POST /api/upload` - Upload audio file
- `POST /api/process` - Process YouTube URL
- `GET /api/status/{job_id}` - Get job status
- `GET /api/download/{job_id}/{type}` - Download vocals or instrumental track
- `GET /api/health` - Health check

## Project Structure

```
musix/
├── backend/
│   ├── main.py              # FastAPI application
│   ├── config.py            # Configuration
│   ├── audio_processor.py   # Audio processing logic
│   ├── requirements.txt     # Python dependencies
│   └── storage/             # Audio file storage
│       ├── uploads/         # Original uploads
│       └── outputs/         # Separated tracks
├── src/
│   ├── pages/
│   │   ├── Home.tsx         # Upload page
│   │   ├── Processing.tsx   # Processing status page
│   │   └── Player.tsx       # Audio player page
│   ├── lib/
│   │   ├── api.ts           # API client
│   │   └── supabase.ts      # Supabase client
│   ├── App.tsx              # Main app with routing
│   └── main.tsx             # Entry point
└── README.md
```

## Performance Notes

- Processing time depends on song length (typically 1-3 minutes for a 3-minute song)
- First run will be slower due to Demucs model download
- Demucs uses CPU by default (GPU acceleration available with CUDA)
- Files are stored locally in the `backend/storage` directory

## Troubleshooting

**"FFmpeg not found" error:**
- Ensure FFmpeg is installed and added to your system PATH

**Processing takes too long:**
- Demucs is CPU-intensive. Consider using shorter audio clips for testing
- GPU acceleration can be enabled if you have CUDA installed

**Port already in use:**
- Backend: Change port in `main.py` (default: 8000)
- Frontend: Change port in `vite.config.ts` or use a different port automatically assigned by Vite

**Audio not playing:**
- Check browser console for errors
- Ensure both audio files were successfully downloaded
- Check that the backend server is running

## Future Enhancements

- User authentication
- Job history
- Four-stem separation (vocals, bass, drums, other)
- Real-time progress updates via WebSockets
- Batch processing
- Cloud storage integration
- Mobile app

## License

MIT License - feel free to use this project for learning and development.

## Credits

- **Demucs**: Facebook Research's state-of-the-art source separation model
- **yt-dlp**: YouTube download capabilities
- **FFmpeg**: Audio processing and conversion
- **Supabase**: Database and backend infrastructure
