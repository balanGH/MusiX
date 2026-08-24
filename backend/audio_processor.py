import subprocess
import shutil
from pathlib import Path
from typing import Dict, Tuple
import yt_dlp
import torchaudio
import config

# Ensure torchaudio can write WAVs properly
torchaudio.set_audio_backend("soundfile")

# Default stems Demucs can separate
DEFAULT_STEMS = ["vocals", "drums", "bass", "piano", "other"]

def download_youtube_audio(url: str, job_id: str) -> Path:
    """Download audio from YouTube and save as WAV."""
    output_path = config.UPLOAD_DIR / f"{job_id}"
    ydl_opts = {
        "format": "bestaudio/best",
        "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "wav"}],
        "outtmpl": str(output_path),
        "quiet": True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])
    return output_path.with_suffix(".wav")


def convert_to_wav(input_path: Path, output_path: Path) -> Path:
    """Convert any audio file to WAV (16-bit PCM, 44.1kHz, stereo)."""
    cmd = [
        "ffmpeg",
        "-i", str(input_path),
        "-acodec", "pcm_s16le",
        "-ar", "44100",
        "-ac", "2",
        "-y",
        str(output_path),
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    return output_path


def separate_audio(
    input_path: Path,
    job_id: str,
    stems: list[str] = DEFAULT_STEMS,
    model: str = "htdemucs",
    device: str = "cpu",
) -> Dict[str, Path]:
    """
    Use Demucs to separate audio into multiple stems.
    Returns a dict of {stem_name: Path}.
    """
    output_dir = config.OUTPUT_DIR / job_id
    output_dir.mkdir(parents=True, exist_ok=True)

    # Construct Demucs command
    cmd = [
        "python",
        "-m",
        "demucs",
        "-o",
        str(output_dir),
        "-n",
        model,
        "--device",
        device,
        str(input_path),
    ]
    # Choose two-stems mode if only vocals + instrumental
    if stems == ["vocals", "other"]:
        cmd.insert(3, "--two-stems")
        cmd.insert(4, "vocals")

    subprocess.run(cmd, check=True, capture_output=True)

    # Build paths to separated stems
    separated_dir = output_dir / model / input_path.stem
    results: Dict[str, Path] = {}

    for stem in stems:
        stem_file = separated_dir / f"{stem}.wav"
        if stem_file.exists():
            target_file = output_dir / f"{stem}.wav"
            shutil.copy(stem_file, target_file)
            results[stem] = target_file

    # Clean up intermediate Demucs folder
    shutil.rmtree(separated_dir.parent, ignore_errors=True)
    return results


async def process_audio(
    job_id: str,
    file_path: Path = None,
    youtube_url: str = None,
    stems: list[str] = DEFAULT_STEMS,
) -> Dict[str, Path]:
    """
    Main processing function.
    Returns a dict of {stem_name: Path}.
    """
    if youtube_url:
        input_file = download_youtube_audio(youtube_url, job_id)
    elif file_path:
        wav_path = config.UPLOAD_DIR / f"{job_id}.wav"
        input_file = convert_to_wav(file_path, wav_path)
    else:
        raise ValueError("Either file_path or youtube_url must be provided")

    separated_files = separate_audio(input_file, job_id, stems=stems)
    return separated_files