const API_BASE_URL = 'http://localhost:8000/api';

export interface JobStatus {
  job_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  vocals_url?: string;
  instrumental_url?: string;
  error_message?: string;
}

export async function uploadFile(file: File): Promise<{ job_id: string }> {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(`${API_BASE_URL}/upload`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    throw new Error('Upload failed');
  }

  return response.json();
}

export async function processYouTubeUrl(url: string): Promise<{ job_id: string }> {
  const response = await fetch(`${API_BASE_URL}/process`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ youtube_url: url }),
  });

  if (!response.ok) {
    throw new Error('Processing failed');
  }

  return response.json();
}

export async function getJobStatus(jobId: string): Promise<JobStatus> {
  const response = await fetch(`${API_BASE_URL}/status/${jobId}`);

  if (!response.ok) {
    throw new Error('Failed to get job status');
  }

  return response.json();
}

export function getDownloadUrl(jobId: string, type: 'vocals' | 'instrumental'): string {
  return `${API_BASE_URL}/download/${jobId}/${type}`;
}
