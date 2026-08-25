# MusiX — build status

Branch `WebApp`. Target: **Phase 1 of the spec, complete and real** — a fast,
offline, low-power local music player — on an architecture the later phases plug
into. Spec §41 applies throughout: nothing ships as a button that does nothing,
and anything unfinished is listed here rather than faked.

**Verification:** `npm run verify` → typecheck clean · lint clean · **97 tests
passing** · production build succeeds (105 kB gzipped entry, code-split).

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

### Tests — 97 passing
`metadata` (19) · `queue` (22) · `lrc` (13) · `library` (24) · `utils` (19).
Run against a real IndexedDB, with audio fixtures assembled byte by byte.

Two real bugs were caught by writing them: `decodeLatin1` trimmed the trailing
space out of the `"fmt "` WAV chunk id, and the artist splitter's `\bfeat\.?\b`
left a stray `.` on the following name.

---

## Not in this release

### ⏭️ Phase 2 — online metadata (§10, §11, §12, §13)
MusicBrainz lookup, Cover Art Archive, metadata matching, batch editing, file
renaming. The privacy switches for these exist in Settings, default off, and are
disabled with the reason shown.

### ⛔ Tag writing — the one real platform limit
MusiX asks for **read-only** folder access. Writing tags back would need
`readwrite`, and even then would only work for a `DirectorySource` — never for
an `ImportedSource`, where MusiX owns only a copy. A metadata editor that
silently worked on part of a library and not the rest would be worse than none.
This is the strongest argument for the native shell in
[ARCHITECTURE.md](ARCHITECTURE.md) §7.

### ⏭️ Phase 3 — lyrics editor (§14)
Timestamping editor, TTML, online lyrics. Embedded LRC already works offline.

### ⏭️ Phase 4 — effects rack (§17)
Compressor, reverb, delay, pitch shift. The EQ, ReplayGain and crossfade from
§16 are done.

### ⏭️ Phase 5 — waveform and multi-track editor (§20, §21)
The Studio page states plainly that its mixer is a mixer, not a DAW.

### ⏭️ Phase 7 — download manager (§25, §26)

---

## Housekeeping left in the repo

Two files predate this build and are now inert. Left in place rather than
deleted, since removing files is the owner's call:

- `supabase/migrations/…create_jobs_table.sql` — describes a hosted `jobs` table
  that nothing references any more. Job state is local (`backend/storage/jobs.json`),
  and MusiX no longer has a cloud dependency. Safe to delete.
- `MusiX_chatgpt.html` — a 1.2 MB saved web page. Not referenced by anything.
