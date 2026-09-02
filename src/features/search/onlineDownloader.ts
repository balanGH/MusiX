export interface OnlineSong {
    id: string;
    title: string;
    url: string;
    thumbnail?: string;
    channel?: string;
    artist?: string;
    album?: string;
    duration?: number;
}

export interface DownloadJob {
    status: string;
    progress: number;
    title?: string;
    artist?: string;
    album?: string;
    filename?: string;
    thumbnail?: string;
    error?: string | null;
}

const API_BASE = 'http://127.0.0.1:8000';

export async function searchOnline(
    query: string,
): Promise<OnlineSong[]> {

    const response = await fetch(
        `${API_BASE}/api/online/search?q=${encodeURIComponent(query)}`,
    );

    if (!response.ok) {
        throw new Error(
            `Online search failed (${response.status})`,
        );
    }

    return response.json();
}


export async function startOnlineDownload(
    url: string,
): Promise<{ jobId: string }> {

    const response = await fetch(
        `${API_BASE}/api/online/download`,
        {
            method: 'POST',

            headers: {
                'Content-Type': 'application/json',
            },

            body: JSON.stringify({
                url,
            }),
        },
    );

    if (!response.ok) {
        throw new Error(
            `Download failed (${response.status})`,
        );
    }

    return response.json();
}


export async function getOnlineDownloadStatus(
    jobId: string,
): Promise<DownloadJob> {

    const response = await fetch(
        `${API_BASE}/api/online/download/${jobId}`,
    );

    if (!response.ok) {
        throw new Error(
            `Could not get download status (${response.status})`,
        );
    }

    return response.json();
}


/** Fetch the finished MP3 for a completed job, ready to hand to the library importer. */
export async function getOnlineDownloadFile(
    jobId: string,
): Promise<File> {

    const response = await fetch(
        `${API_BASE}/api/online/download/${jobId}/file`,
    );

    if (!response.ok) {
        throw new Error(
            `Could not fetch the downloaded file (${response.status})`,
        );
    }

    // A filename with spaces or other non-ASCII-safe characters (almost every
    // song title) comes back RFC 5987-encoded as `filename*=utf-8''...`
    // rather than the plain `filename="..."` form.
    const disposition = response.headers.get('content-disposition') ?? '';
    const encodedMatch = /filename\*=utf-8''([^;]+)/i.exec(disposition);
    const quotedMatch = /filename="?([^";]+)"?/.exec(disposition);
    const filename = encodedMatch
        ? decodeURIComponent(encodedMatch[1]!)
        : (quotedMatch?.[1] ?? `${jobId}.mp3`);

    const blob = await response.blob();
    return new File([blob], filename, { type: 'audio/mpeg' });
}
