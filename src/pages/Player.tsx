import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Play,
  Pause,
  Download,
  Music,
  RotateCcw,
  Home,
  Volume2
} from 'lucide-react';
import { getDownloadUrl } from '../lib/api';

const STEMS = ['vocals', 'drums', 'bass', 'piano', 'other'];

export default function Player() {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volumes, setVolumes] = useState<Record<string, number>>(
    Object.fromEntries(STEMS.map((stem) => [stem, 1]))
  );

  const audioRefs = useRef<Record<string, HTMLAudioElement | null>>(
    Object.fromEntries(STEMS.map((stem) => [stem, null]))
  );

  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Initialize audio sources
  useEffect(() => {
    if (!jobId) return;

    STEMS.forEach((stem) => {
      const audioEl = audioRefs.current[stem];
      if (audioEl) {
        audioEl.src = getDownloadUrl(jobId, stem);
        audioEl.volume = volumes[stem];
        audioEl.addEventListener('loadedmetadata', () => {
          if (audioEl.duration > duration) setDuration(audioEl.duration);
        });
        audioEl.addEventListener('timeupdate', () => setCurrentTime(audioEl.currentTime));
      }
    });
  }, [jobId]);

  // Sync volume changes
  useEffect(() => {
    STEMS.forEach((stem) => {
      const audioEl = audioRefs.current[stem];
      if (audioEl) audioEl.volume = volumes[stem];
    });
  }, [volumes]);

  const togglePlayPause = () => {
    STEMS.forEach((stem) => {
      const audioEl = audioRefs.current[stem];
      if (!audioEl) return;
      if (isPlaying) audioEl.pause();
      else audioEl.play();
    });
    setIsPlaying(!isPlaying);
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    setCurrentTime(time);
    STEMS.forEach((stem) => {
      const audioEl = audioRefs.current[stem];
      if (audioEl) audioEl.currentTime = time;
    });
  };

  const setMixMode = (mode: 'karaoke' | 'vocals-only' | 'reset') => {
    const newVolumes: Record<string, number> = {};
    STEMS.forEach((stem) => {
      if (mode === 'karaoke') newVolumes[stem] = stem === 'vocals' ? 0 : 1;
      else if (mode === 'vocals-only') newVolumes[stem] = stem === 'vocals' ? 1 : 0;
      else newVolumes[stem] = 1;
    });
    setVolumes(newVolumes);
  };

  const downloadTrack = (stem: string) => {
    if (!jobId) return;
    const url = getDownloadUrl(jobId, stem);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${stem}.wav`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const formatTime = (time: number) => {
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-purple-900 to-gray-900 p-6">
      {STEMS.map((stem) => (
        <audio key={stem} ref={(el) => (audioRefs.current[stem] = el)} />
      ))}

      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <Music className="w-8 h-8 text-purple-400" />
            <h1 className="text-4xl font-bold text-white">MusiX</h1>
          </div>
          <button
            onClick={() => navigate('/')}
            className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
          >
            <Home className="w-4 h-4" />
            New Track
          </button>
        </div>

        {/* Waveform */}
        <div className="bg-gray-800/50 backdrop-blur-lg rounded-2xl p-8 shadow-2xl border border-gray-700 mb-8">
          <canvas
            ref={canvasRef}
            width={800}
            height={120}
            className="w-full h-32 rounded-lg bg-gray-900/50"
          />
        </div>

        {/* Playback controls */}
        <div className="flex justify-center mb-8">
          <button
            onClick={togglePlayPause}
            className="w-16 h-16 flex items-center justify-center bg-purple-600 hover:bg-purple-700 text-white rounded-full transition-colors shadow-lg"
          >
            {isPlaying ? <Pause className="w-8 h-8" /> : <Play className="w-8 h-8 ml-1" />}
          </button>
        </div>

        {/* Volume sliders for each stem */}
        <div className="grid md:grid-cols-2 gap-6 mb-8">
          {STEMS.map((stem) => (
            <div key={stem} className="bg-gray-900/50 rounded-lg p-6">
              <div className="flex items-center gap-2 mb-4">
                <Volume2 className="w-5 h-5 text-purple-400" />
                <h3 className="text-white font-medium">{stem.charAt(0).toUpperCase() + stem.slice(1)}</h3>
              </div>
              <div className="flex items-center gap-3">
                <Volume2 className="w-5 h-5 text-gray-400" />
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={volumes[stem]}
                  onChange={(e) =>
                    setVolumes({ ...volumes, [stem]: parseFloat(e.target.value) })
                  }
                  className="flex-1 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer slider"
                />
                <span className="text-gray-400 text-sm w-12 text-right">
                  {Math.round(volumes[stem] * 100)}%
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* Mix mode buttons */}
        <div className="flex flex-wrap gap-3 mb-8">
          <button
            onClick={() => setMixMode('karaoke')}
            className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors"
          >
            Karaoke Mode
          </button>
          <button
            onClick={() => setMixMode('vocals-only')}
            className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors"
          >
            Vocals Only
          </button>
          <button
            onClick={() => setMixMode('reset')}
            className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
          >
            Reset Mix
          </button>
        </div>

        {/* Download buttons */}
        <div className="border-t border-gray-700 pt-6">
          <h3 className="text-white font-medium mb-4">Download Tracks</h3>
          <div className="flex flex-wrap gap-3">
            {STEMS.map((stem) => (
              <button
                key={stem}
                onClick={() => downloadTrack(stem)}
                className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
              >
                <Download className="w-4 h-4" />
                {stem.charAt(0).toUpperCase() + stem.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}