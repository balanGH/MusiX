import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Play,
  Pause,
  Download,
  Music,
  Mic2,
  Radio,
  RotateCcw,
  Home,
  Volume2
} from 'lucide-react';
import { getDownloadUrl } from '../lib/api';

export default function Player() {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [vocalVolume, setVocalVolume] = useState(1);
  const [instrumentalVolume, setInstrumentalVolume] = useState(1);

  const vocalsAudioRef = useRef<HTMLAudioElement>(null);
  const instrumentalAudioRef = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>();

  useEffect(() => {
    if (!jobId) return;

    const vocalsAudio = vocalsAudioRef.current;
    const instrumentalAudio = instrumentalAudioRef.current;

    if (vocalsAudio && instrumentalAudio) {
      vocalsAudio.src = getDownloadUrl(jobId, 'vocals');
      instrumentalAudio.src = getDownloadUrl(jobId, 'instrumental');

      vocalsAudio.addEventListener('loadedmetadata', () => {
        setDuration(vocalsAudio.duration);
      });

      const timeUpdate = () => {
        setCurrentTime(vocalsAudio.currentTime);
      };

      vocalsAudio.addEventListener('timeupdate', timeUpdate);

      return () => {
        vocalsAudio.removeEventListener('timeupdate', timeUpdate);
      };
    }
  }, [jobId]);

  useEffect(() => {
    const vocalsAudio = vocalsAudioRef.current;
    const instrumentalAudio = instrumentalAudioRef.current;

    if (vocalsAudio && instrumentalAudio) {
      vocalsAudio.volume = vocalVolume;
      instrumentalAudio.volume = instrumentalVolume;
    }
  }, [vocalVolume, instrumentalVolume]);

  useEffect(() => {
    drawWaveform();
  }, [currentTime, duration]);

  const togglePlayPause = () => {
    const vocalsAudio = vocalsAudioRef.current;
    const instrumentalAudio = instrumentalAudioRef.current;

    if (vocalsAudio && instrumentalAudio) {
      if (isPlaying) {
        vocalsAudio.pause();
        instrumentalAudio.pause();
      } else {
        vocalsAudio.play();
        instrumentalAudio.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    setCurrentTime(time);

    const vocalsAudio = vocalsAudioRef.current;
    const instrumentalAudio = instrumentalAudioRef.current;

    if (vocalsAudio && instrumentalAudio) {
      vocalsAudio.currentTime = time;
      instrumentalAudio.currentTime = time;
    }
  };

  const setKaraokeMode = () => {
    setVocalVolume(0);
    setInstrumentalVolume(1);
  };

  const setVocalsOnly = () => {
    setVocalVolume(1);
    setInstrumentalVolume(0);
  };

  const resetMix = () => {
    setVocalVolume(1);
    setInstrumentalVolume(1);
  };

  const downloadTrack = (type: 'vocals' | 'instrumental') => {
    if (!jobId) return;
    const url = getDownloadUrl(jobId, type);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${type}.wav`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const formatTime = (time: number) => {
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const drawWaveform = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);

    const bars = 60;
    const barWidth = width / bars;
    const progress = duration > 0 ? currentTime / duration : 0;

    for (let i = 0; i < bars; i++) {
      const barHeight = Math.random() * height * 0.6 + height * 0.2;
      const x = i * barWidth;
      const isPast = i / bars <= progress;

      ctx.fillStyle = isPast
        ? 'rgba(168, 85, 247, 0.8)'
        : 'rgba(107, 114, 128, 0.3)';

      ctx.fillRect(x, (height - barHeight) / 2, barWidth - 2, barHeight);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-purple-900 to-gray-900 p-6">
      <audio ref={vocalsAudioRef} />
      <audio ref={instrumentalAudioRef} />

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

        <div className="bg-gray-800/50 backdrop-blur-lg rounded-2xl p-8 shadow-2xl border border-gray-700">
          <div className="mb-8">
            <canvas
              ref={canvasRef}
              width={800}
              height={120}
              className="w-full h-32 rounded-lg bg-gray-900/50"
            />
          </div>

          <div className="mb-6">
            <div className="flex items-center justify-between text-sm text-gray-400 mb-2">
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(duration)}</span>
            </div>
            <input
              type="range"
              min="0"
              max={duration || 0}
              value={currentTime}
              onChange={handleSeek}
              className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer slider"
            />
          </div>

          <div className="flex justify-center mb-8">
            <button
              onClick={togglePlayPause}
              className="w-16 h-16 flex items-center justify-center bg-purple-600 hover:bg-purple-700 text-white rounded-full transition-colors shadow-lg"
            >
              {isPlaying ? (
                <Pause className="w-8 h-8" />
              ) : (
                <Play className="w-8 h-8 ml-1" />
              )}
            </button>
          </div>

          <div className="grid md:grid-cols-2 gap-6 mb-8">
            <div className="bg-gray-900/50 rounded-lg p-6">
              <div className="flex items-center gap-2 mb-4">
                <Mic2 className="w-5 h-5 text-purple-400" />
                <h3 className="text-white font-medium">Vocals</h3>
              </div>
              <div className="flex items-center gap-3">
                <Volume2 className="w-5 h-5 text-gray-400" />
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={vocalVolume}
                  onChange={(e) => setVocalVolume(parseFloat(e.target.value))}
                  className="flex-1 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer slider"
                />
                <span className="text-gray-400 text-sm w-12 text-right">
                  {Math.round(vocalVolume * 100)}%
                </span>
              </div>
            </div>

            <div className="bg-gray-900/50 rounded-lg p-6">
              <div className="flex items-center gap-2 mb-4">
                <Radio className="w-5 h-5 text-purple-400" />
                <h3 className="text-white font-medium">Instrumental</h3>
              </div>
              <div className="flex items-center gap-3">
                <Volume2 className="w-5 h-5 text-gray-400" />
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={instrumentalVolume}
                  onChange={(e) => setInstrumentalVolume(parseFloat(e.target.value))}
                  className="flex-1 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer slider"
                />
                <span className="text-gray-400 text-sm w-12 text-right">
                  {Math.round(instrumentalVolume * 100)}%
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-3 mb-8">
            <button
              onClick={setKaraokeMode}
              className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors"
            >
              <Radio className="w-4 h-4" />
              Karaoke Mode
            </button>
            <button
              onClick={setVocalsOnly}
              className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors"
            >
              <Mic2 className="w-4 h-4" />
              Vocals Only
            </button>
            <button
              onClick={resetMix}
              className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
            >
              <RotateCcw className="w-4 h-4" />
              Reset Mix
            </button>
          </div>

          <div className="border-t border-gray-700 pt-6">
            <h3 className="text-white font-medium mb-4">Download Tracks</h3>
            <div className="flex flex-wrap gap-3">
              <button
                onClick={() => downloadTrack('vocals')}
                className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
              >
                <Download className="w-4 h-4" />
                Vocals
              </button>
              <button
                onClick={() => downloadTrack('instrumental')}
                className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
              >
                <Download className="w-4 h-4" />
                Instrumental
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
