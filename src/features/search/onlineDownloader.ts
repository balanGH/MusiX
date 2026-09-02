export interface OnlineSong {
    id: string;
    title: string;
    url: string;
    thumbnail?: string;
    channel?: string;
    artist?: string;
    album?: string;
    year?: number;
    duration?: number;
    /**
     * True when the entry carries real track/artist metadata, which only
     * YouTube Music entries do. A plain video result imports with its title
     * and no artist, so the two are worth distinguishing in the list.
     */
    hasMetadata?: boolean;
}

export interface DownloadJob {
    status: string;
    progress: number;
    title?: string;
    artist?: string;
    album?: string;
    filename?: string;
    thumbnail?: string;
    /**
     * What was embedded. 'synced' means timestamped lyrics that scroll with
     * playback; 'plain' means text only; null means none were found.
     */
    lyrics?: 'synced' | 'plain' | null;
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
    options: { lyrics?: boolean } = {},
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
                // Looking lyrics up contacts a third party, so the user's
                // privacy setting decides (spec §32).
                lyrics: options.lyrics ?? true,
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


export interface DownloadPath {
    /** Absolute folder on the machine running the service. */
    path: string;
    /** The built-in default, shown so the user can get back to it. */
    default?: string;
    isDefault: boolean;
    /** Pinned by MUSIX_DOWNLOAD_DIR; the UI must not offer to change it. */
    fixed?: boolean;
}

export async function getDownloadPath(): Promise<DownloadPath> {

    const response = await fetch(
        `${API_BASE}/api/online/download-path`,
    );

    if (!response.ok) {
        throw new Error(
            `Could not read the download folder (${response.status})`,
        );
    }

    return response.json();
}


/**
 * Choose a different download folder.
 *
 * The service creates and write-tests the folder before accepting it, so a
 * rejection here carries a reason worth showing the user verbatim.
 */
export async function setDownloadPath(
    path: string,
): Promise<DownloadPath> {

    const response = await fetch(
        `${API_BASE}/api/online/download-path`,
        {
            method: 'POST',

            headers: {
                'Content-Type': 'application/json',
            },

            body: JSON.stringify({ path }),
        },
    );

    if (!response.ok) {
        let detail = `Could not set the download folder (${response.status})`;
        try {
            const body = (await response.json()) as { detail?: string };
            if (body.detail) detail = body.detail;
        } catch {
            // Not JSON; the status line is the best message available.
        }
        throw new Error(detail);
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
