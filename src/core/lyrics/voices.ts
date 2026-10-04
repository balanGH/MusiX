/**
 * Who sings each lyric line: male, female, or both.
 *
 * There is no standard field for this. Karaoke and duet lyric files mark it in
 * the text itself, at the start of a line:
 *
 *   [00:12.30]M: I've been waiting all night
 *   [00:16.10]F: So have I
 *   [00:20.00]D: Together now
 *
 * Also seen: `Male:` / `Female:` / `Both:` / `All:`, Chinese `男：` / `女：` /
 * `合：` with the full-width colon, and bracketed `(M)` / `[F]`. A marker
 * carries over to the following lines until the next one, which is how those
 * files are written: one marker per verse, not per line.
 *
 * Read at display time rather than stored, so lyrics saved before this
 * existed — embedded, sidecar or fetched online — get voices without a rescan.
 */

export type LyricsVoice = 'male' | 'female' | 'duet';

export interface VoicedText {
  /** The line with its marker removed. */
  text: string;
  /** Null when the sheet has no markers at all, or before the first one. */
  voice: LyricsVoice | null;
}

const WORDS: Record<string, LyricsVoice> = {
  m: 'male',
  male: 'male',
  man: 'male',
  men: 'male',
  boy: 'male',
  boys: 'male',
  f: 'female',
  female: 'female',
  woman: 'female',
  women: 'female',
  girl: 'female',
  girls: 'female',
  d: 'duet',
  duet: 'duet',
  both: 'duet',
  all: 'duet',
  // Chinese duet sheets: 男 (man), 女 (woman), 合 (together).
  男: 'male',
  女: 'female',
  合: 'duet',
};

const WORD = Object.keys(WORDS).join('|');
/**
 * `M: text`, `F：text`, `(M) text`, `[F] text`. The word must be the whole
 * marker: "Many:" or "Mind: …" are lyrics, not markers.
 */
const MARKER = new RegExp(
  `^\\s*(?:(${WORD})\\s*[:：]|\\(\\s*(${WORD})\\s*\\)|\\[\\s*(${WORD})\\s*\\])\\s*`,
  'i',
);

/** Split one line into its marker (if any) and the sung text. */
export function splitVoice(line: string): { text: string; voice: LyricsVoice | null } {
  const match = MARKER.exec(line);
  if (!match) return { text: line, voice: null };
  const word = (match[1] ?? match[2] ?? match[3])!.toLowerCase();
  return { text: line.slice(match[0].length), voice: WORDS[word] ?? null };
}

/**
 * Voices for a whole sheet, markers stripped.
 *
 * A sheet with no markers comes back unchanged with every voice null, so the
 * caller can show it exactly as before.
 */
export function assignVoices(lines: readonly string[]): VoicedText[] {
  let current: LyricsVoice | null = null;
  return lines.map((line) => {
    const { text, voice } = splitVoice(line);
    if (voice) current = voice;
    return { text, voice: current };
  });
}

/** Whether any line in the sheet names a singer. */
export function hasVoices(voiced: readonly VoicedText[]): boolean {
  return voiced.some((line) => line.voice !== null);
}
