# MusiX — build status

Branch `WebApp`. Target: **Phase 1 of the spec, complete and real** — a fast,
offline, low-power local music player — on an architecture the later phases plug
into. Spec §41 applies throughout: nothing ships as a button that does nothing,
and anything unfinished is listed here rather than faked.

**Verification:** `npm run verify` → typecheck clean · lint clean · **165 tests
passing** (13 files, counted 2026-09-26 while more are being added — rerun
`npx vitest run` for the current number) · production build succeeds
(code-split).

Legend: ✅ done · ⏭️ deliberately a later phase · ⛔ blocked by the web platform

---

## Done

### Foundation
- ✅ Vite + TypeScript strict (`noImplicitReturns`, `noImplicitOverride`, no unused), path aliases, ESLint, Vitest
- ✅ PWA: precached app shell, install manifest, generated icons, non-disruptive update prompt
- ✅ Four themes (light / dark / AMOLED / system) applied before first paint, accent colours, artwork-derived accent
- ✅ Reduced-motion and high-contrast support, keyboard shortcuts, screen-reader labels

### Core — storage (§7)
- ✅ Typed IndexedDB wrapper: ordered migrations, key cursors, commit-awaited transactions
- ✅ Schema v1 — 14 stores, 31 indexes; booleans mapped to sparse nullable timestamps so they are indexable
- ✅ Persistent-storage request, quota reporting, per-store row counts
- ✅ Repositories: tracks, albums/artists/folders/sources, playlists, artwork, lyrics, history, scans, session

### Core — metadata (§8)
- ✅ Ranged `ByteSource` — parsers read only what they need
- ✅ ID3v1 + ID3v2.2/2.3/2.4: tag- and frame-level unsynchronisation, extended headers, non-synchsafe v2.4 sizes, TXXX, COMM, USLT, UFID, APIC/PIC, numeric TCON genres
- ✅ MPEG: Xing/Info and VBRI frame counts for exact VBR duration, CBR fallback
- ✅ FLAC: STREAMINFO, Vorbis comments, PICTURE blocks
- ✅ MP4 / M4A / ALAC: atom walker (handles `moov` at either end), `ilst`, freeform `----`, `covr`, `stsd`
- ✅ Ogg Vorbis + Opus: page walker, multi-page comment packets, duration from the final granule position
- ✅ WAV + AIFF: `fmt `/`COMM`, LIST/INFO, embedded ID3 chunks, 80-bit extended float sample rate

### Core — platform (§9, §31, §36)
- ✅ Capability detection driving the desktop/mobile split
- ✅ `DirectorySource` — File System Access API, persisted handle, re-permission flow
- ✅ `ImportedSource` — streamed OPFS copies for browsers that cannot reopen a folder
- ✅ Source registry with startup restore and "needs reconnecting" reporting

### Core — library (§4, §24)
- ✅ Incremental scanner: fingerprint key-cursor, zero record reads on an unchanged library
- ✅ Runs in a Web Worker, with an in-thread fallback; cancellable; per-file failures never abort a scan
- ✅ User data (favourite, rating, play count, `addedAt`) preserved across rescans
- ✅ Artwork: content-hash dedup, thumbnails, dominant-colour extraction
- ✅ Album / artist / folder-tree derivation
- ✅ Library Health with two-stage duplicate clustering

### Core — playback (§15, §16)
- ✅ Dual-deck Web Audio engine, crossfade, near-gapless handoff, playback speed with pitch preserved
- ✅ ReplayGain (track/album) with peak-aware clipping protection
- ✅ 10-band equaliser, 11 presets, live response curve, automatic bypass when flat
- ✅ Idle teardown: context suspend, EQ disconnect, analyser released
- ✅ Queue: seeded shuffle, repeat off/all/one, reorder, play-next, prune-missing
- ✅ Play threshold and history, skip counting, session resume, sleep timer
- ✅ Media Session — lock screen, media keys, position state

### Core — retrieval (§14, §22, §23)
- ✅ Offline fuzzy search with field weighting and single-edit tolerance
- ✅ Smart-playlist rule engine + 13 built-ins
- ✅ LRC engine: parse/format, offsets, multi-stamp lines, binary-search lookup

### UI
- ✅ App shell, sidebar, mobile tab bar, persistent player bar, queue panel
- ✅ Own virtualised list and grid — 100k rows, ~30 mounted nodes
- ✅ Onboarding, Home, Songs, Albums, Album, Artists, Artist, Folders, Favourites, Playlists, Playlist, Search, Now Playing, Equaliser, Library Health, Settings, Audio Studio
- ✅ Toasts with undo, single confirmation path for every destructive action, add-to-playlist picker, error boundary
- ✅ Touch: row actions always visible and a single tap plays on devices without hover (desktop keeps hover + double-click); 44 px hit areas on row buttons; safe-area insets on the tab bar, player bar, drawer and full-screen overlays; no horizontal page scroll at 360 px

### Online extras (all opt-in, click-triggered, off the critical path)
- ✅ Lyrics lookup from LRCLIB, straight from the browser (Settings → online lyrics)
- ✅ Artist photos from Deezer, on request from the artist page (Settings → online artwork); "Look for a different photo" moves through the other candidates
- ✅ Song downloader: search + download through the optional local service (yt-dlp, `backend/downloader.py`), imported into the library with embedded lyrics
- The web app reaches the local service through `src/core/net/apiBase.ts`: same-origin `/api` by default (proxied by Vite in dev and preview); set `VITE_MUSIX_API_BASE` (e.g. `http://127.0.0.1:8000`) for a build that can't proxy, and allow that origin in the service's `MUSIX_ALLOWED_ORIGINS`

### Audio Studio (§18, §19)
- ✅ Rebuilt on a contract the client and server agree on
- ✅ Stem mixer with per-frame drift correction, volume/mute/solo/download
- ✅ Karaoke, Acapella and Reduce Vocals presets
- ✅ Backend repaired — see below

### Backend repairs
The previous service could not complete a single job. Fixed:
- ✅ `main.py` unpacked a 2-tuple from a function returning a 5-key dict → `ValueError` on every job
- ✅ Download route knew 2 of the 5 stems the player requested
- ✅ Progress jumped 10 → 100; now parsed from Demucs' own output
- ✅ Upload limit declared but never enforced, whole file buffered in memory → now streamed with the limit applied as it arrives
- ✅ `allow_origins=["*"]` with `allow_credentials=True` → rejected by browsers; now restricted to the local app
- ✅ Jobs lost on restart → persisted, with in-flight jobs marked failed rather than hanging
- ✅ `requirements.txt` pinned a non-existent `demucs==3.0` and had FastAPI commented out
- ✅ Stem downloads resolved through the job record, so a crafted id cannot escape the storage directory

### Tests — 165 passing
13 files, including `metadata`, `queue`, `lrc`, `library`, `utils`,
`equalizer`, `lyricsOnline`, `audioExclusivity`, `smartRules`, `gridLayout`
and `artistPhotoRank` (count as of 2026-09-26; rerun `npx vitest run`).
Run against a real IndexedDB, with audio fixtures assembled byte by byte.

Two real bugs were caught by writing them: `decodeLatin1` trimmed the trailing
space out of the `"fmt "` WAV chunk id, and the artist splitter's `\bfeat\.?\b`
left a stray `.` on the following name.

---

## Not in this release

### ⏭️ Phase 2 — online metadata (§10, §11, §12, §13)
MusicBrainz lookup, Cover Art Archive, metadata matching, batch editing, file
renaming. (Online lyrics and Deezer artist photos *are* in — see "Online
extras" above.) The remaining switches exist in Settings, default off, and are
disabled with the reason shown.

### ⛔ Tag writing — the one real platform limit
MusiX asks for **read-only** folder access. Writing tags back would need
`readwrite`, and even then would only work for a `DirectorySource` — never for
an `ImportedSource`, where MusiX owns only a copy. A metadata editor that
silently worked on part of a library and not the rest would be worse than none.
This is the strongest argument for the native shell in
[ARCHITECTURE.md](ARCHITECTURE.md) §7.

### ⏭️ Phase 3 — lyrics editor (§14)
Timestamping editor, TTML. Embedded LRC works offline, and online lyrics come
from LRCLIB.

### ⏭️ Phase 4 — effects rack (§17)
Compressor, reverb, delay, pitch shift. The EQ, ReplayGain and crossfade from
§16 are done.

### ⏭️ Phase 5 — waveform and multi-track editor (§20, §21)
The Studio page states plainly that its mixer is a mixer, not a DAW.

### ⏭️ Phase 7 — full download manager (§25, §26)
A basic downloader exists (see "Online extras"); a queue with pause/resume,
history and per-source settings does not.

---

## Housekeeping left in the repo

Nothing left: the inert `supabase/` migration (a hosted `jobs` table nothing
referenced — job state is local, in `backend/storage/jobs.json`) and the saved
`MusiX_chatgpt.html` page have both been deleted.
