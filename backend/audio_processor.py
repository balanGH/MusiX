import subprocess
import shutil
from pathlib import Path
from typing import Tuple
import yt_dlp
import torchaudio
import config

# Ensure torchaudio uses a backend that can write WAVs
torchaudio.set_audio_backend("soundfile")

def download_youtube_audio(url: str, job_id: str) -> Path:
    """
    Downloads audio from a YouTube URL as a WAV file.
    """
    output_path = config.UPLOAD_DIR / f"{job_id}"

    ydl_opts = {
        'format': 'bestaudio/best',
        'postprocessors': [{
            'key': 'FFmpegExtractAudio',
            'preferredcodec': 'wav',
        }],
        'outtmpl': str(output_path),
        'quiet': True,
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])

    wav_file = output_path.with_suffix('.wav')
    return wav_file

def convert_to_wav(input_path: Path, output_path: Path) -> Path:
    """
    Converts an audio file to WAV format (PCM 16-bit, 44.1kHz, stereo).
    """
    cmd = [
        'ffmpeg',
        '-i', str(input_path),
        '-acodec', 'pcm_s16le',
        '-ar', '44100',
        '-ac', '2',
        '-y',
        str(output_path)
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    return output_path

def separate_audio(input_path: Path, job_id: str) -> Tuple[Path, Path]:
    """
    Uses Demucs to separate vocals and instrumental tracks.
    """
    output_dir = config.OUTPUT_DIR / job_id
    output_dir.mkdir(exist_ok=True, parents=True)

    cmd = [
        'python', '-m', 'demucs',
        '--two-stems', 'vocals',
        '-o', str(output_dir),
        '-n', 'htdemucs',
        '--device', 'cpu',
        str(input_path)
    ]

    subprocess.run(cmd, check=True, capture_output=True)

    separated_dir = output_dir / 'htdemucs' / input_path.stem

    vocals_path = separated_dir / 'vocals.wav'
    instrumental_path = separated_dir / 'no_vocals.wav'

    final_vocals = output_dir / 'vocals.wav'
    final_instrumental = output_dir / 'instrumental.wav'

    shutil.copy(vocals_path, final_vocals)
    shutil.copy(instrumental_path, final_instrumental)

    # Clean up Demucs intermediate folder
    shutil.rmtree(separated_dir.parent, ignore_errors=True)

    return final_vocals, final_instrumental

async def process_audio(job_id: str, file_path: Path = None, youtube_url: str = None) -> Tuple[Path, Path]:
    """
    Main processing function. Either converts a local file or downloads from YouTube,
    then separates vocals and instrumentals.
    """
    if youtube_url:
        input_file = download_youtube_audio(youtube_url, job_id)
    elif file_path:
        wav_path = config.UPLOAD_DIR / f"{job_id}.wav"
        input_file = convert_to_wav(file_path, wav_path)
    else:
        raise ValueError("Either file_path or youtube_url must be provided")

    vocals_path, instrumental_path = separate_audio(input_file, job_id)
    return vocals_path, instrumental_path