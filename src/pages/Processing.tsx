import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Music, Loader2 } from 'lucide-react';
import { getJobStatus, JobStatus } from '../lib/api';

export default function Processing() {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!jobId) return;

    const pollStatus = async () => {
      try {
        const jobStatus = await getJobStatus(jobId);
        setStatus(jobStatus);

        if (jobStatus.status === 'completed') {
          setTimeout(() => {
            navigate(`/player/${jobId}`);
          }, 1000);
        } else if (jobStatus.status === 'failed') {
          setError(jobStatus.error_message || 'Processing failed');
        }
      } catch (err) {
        setError('Failed to get job status');
      }
    };

    pollStatus();
    const interval = setInterval(pollStatus, 2000);

    return () => clearInterval(interval);
  }, [jobId, navigate]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-purple-900 to-gray-900 flex items-center justify-center p-6">
      <div className="max-w-md w-full">
        <div className="bg-gray-800/50 backdrop-blur-lg rounded-2xl p-12 shadow-2xl border border-gray-700 text-center">
          <div className="mb-8">
            <div className="relative inline-block">
              <Music className="w-20 h-20 text-purple-400 mx-auto" />
              <Loader2 className="w-8 h-8 text-purple-300 absolute -bottom-1 -right-1 animate-spin" />
            </div>
          </div>

          <h2 className="text-3xl font-bold text-white mb-4">
            {status?.status === 'pending' && 'Preparing...'}
            {status?.status === 'processing' && 'Separating Audio...'}
            {status?.status === 'completed' && 'Complete!'}
            {status?.status === 'failed' && 'Failed'}
          </h2>

          <p className="text-gray-300 mb-8">
            {status?.status === 'pending' && 'Initializing audio processing'}
            {status?.status === 'processing' && 'Separating vocals and instruments using AI'}
            {status?.status === 'completed' && 'Redirecting to player...'}
            {status?.status === 'failed' && 'An error occurred'}
          </p>

          {status && status.status !== 'failed' && (
            <div className="space-y-4">
              <div className="w-full bg-gray-700 rounded-full h-3 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-purple-600 to-pink-600 transition-all duration-500 ease-out"
                  style={{ width: `${status.progress}%` }}
                />
              </div>
              <p className="text-sm text-gray-400">{status.progress}% complete</p>
            </div>
          )}

          {error && (
            <div className="mt-6 p-4 bg-red-500/10 border border-red-500/50 rounded-lg text-red-400 text-sm">
              {error}
            </div>
          )}

          <div className="mt-8 flex items-center justify-center gap-2">
            <div className="w-2 h-2 bg-purple-400 rounded-full animate-pulse" />
            <div className="w-2 h-2 bg-purple-400 rounded-full animate-pulse delay-75" />
            <div className="w-2 h-2 bg-purple-400 rounded-full animate-pulse delay-150" />
          </div>
        </div>
      </div>
    </div>
  );
}
