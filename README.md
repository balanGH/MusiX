# MusiX

**An offline-first music library, player and audio studio that runs in your browser.**

Point MusiX at your music folder. It reads the tags, artwork and lyrics straight
out of your files, builds a local library, and plays it — with no account, no
server, and no network connection.

```
Your music folder  →  scan (tags, artwork, lyrics)  →  local database  →  play
                            all on your device, all offline
```

---

## What it does today

Everything listed here is built and working. Nothing below is a placeholder —
see [docs/STATUS.md](docs/STATUS.md) for what is *not* built yet, stated plainly.

### Library

- **Index a folder in place.** On Chromium desktop, MusiX holds a handle to your
  real music folder and never copies or moves a file.
- **Import files** on browsers without that capability (mobile, Firefox, Safari),
  copied once into private storage so they survive a reload.
- **Incremental scanning.** A rescan of an unchanged 50,000-track library reads
  zero records, parses zero tags and writes nothing — it compares file
  fingerprints straight out of a database index.
- **Songs, Albums, Artists, Folders, Favourites**, all virtualised for libraries
  of 100,000+ tracks.
- **Offline fuzzy search** across titles, artists, albums, genres, composers,
  filenames and folder names — with single-typo tolerance.
- **Playlists**, manual and smart, with 13 built-in rule sets.
- **Library Health**: metadata / artwork / lyrics completeness, unreadable files,
  and duplicate detection that finds a FLAC and its MP3 without flagging a live
  version as a copy of the studio one.

### Playback

- Gapless-style handoff, **crossfade**, **ReplayGain** with clipping protection,
  playback speed with pitch preserved, shuffle, repeat, sleep timer.
- **10-band equaliser** with presets, a live response curve, and automatic
  bypass when flat.
- **Lock-screen and media-key control** via the Media Session API.
- **Synchronised lyrics** when your files carry timed LRC in their tags — click
  a line to seek to it.
- Queue with drag-to-reorder, and a session that resumes where you left off.

### Audio Studio

- **Stem separation** — vocals, drums, bass, guitar, piano, other — via an
  optional local service (see below).
- **Stem mixer** with per-stem volume, mute, solo and download, plus one-tap
  Karaoke, Acapella and Reduce Vocals presets.

### The rest

- Four themes (light, dark, AMOLED, system), accent colours, and an optional
  accent sampled from the current album cover.
- Installable as a PWA; the app shell is precached so it opens with no network.
- Keyboard shortcuts, screen-reader labels, reduced-motion and high-contrast
  support.

---

## Privacy

MusiX has no accounts, no servers, no analytics and no telemetry. There is no
code in this repository that uploads anything.

Your music, tags, artwork, lyrics, playlists, ratings and listening history are
stored only in your browser's local database, on your device. The optional
online-lookup switches in Settings are **off by default** and, in this release,
are not yet wired to anything — they are shown so the default is visible.

The one component that touches a network is the audio-studio service, and it
runs on `127.0.0.1`, on your own machine.

---

## Running it

```bash
npm install
npm run dev          # http://localhost:5173
```

That is the whole app. The steps below are only for stem separation.

### Optional: the audio-studio service

Stem separation uses Demucs, a PyTorch model far too heavy for a browser tab, so
it runs as a small local service. **MusiX works completely without it** — the
Studio page detects its absence and explains how to start it.

```bash
cd backend
pip install -r requirements.txt
python main.py       # http://127.0.0.1:8000
```

You will also need **FFmpeg** on your `PATH`:

| Platform | |
|---|---|
| macOS | `brew install ffmpeg` |
| Debian/Ubuntu | `sudo apt install ffmpeg` |
| Windows | [ffmpeg.org](https://ffmpeg.org/download.html), then add it to `PATH` |

The first separation downloads the model — roughly 2 GB, once.

### Building

```bash
npm run build        # typecheck, then a production build into dist/
npm run preview      # serve the build
npm run verify       # typecheck + lint + tests
```

---

## Browser support

The important difference is whether the browser can hand back a *folder*.

| | Chrome / Edge (desktop) | Firefox · Safari | Android · iOS |
|---|---|---|---|
| Index a folder in place | ✅ | ❌ | ❌ |
| Import files (copied to private storage) | ✅ | ✅ | ✅ |
| Playback, EQ, search, playlists | ✅ | ✅ | ✅ |
| Lock screen / media keys | ✅ | ✅ | ✅ |
| Install as an app | ✅ | ✅ | ✅ |

Where `showDirectoryPicker()` is unavailable, a browser cannot reopen a file
after a reload — a `File` from an `<input>` lasts one session. So MusiX copies
the bytes once into the origin-private file system rather than asking you to
re-pick your library every launch. Your original files are never modified or
moved. This is stated on the import screen, not hidden.

---

## Supported formats

MP3 · FLAC · WAV · M4A / ALAC · AAC · OGG Vorbis · Opus · AIFF

Tags are read by hand-written parsers — ID3v1, ID3v2.2/2.3/2.4 (including
unsynchronisation and the common non-synchsafe-size bug), Vorbis comments, MP4
atoms, RIFF/AIFF chunks — so the whole pipeline works with no network and no
runtime dependency.

---

## How it is put together

```
src/
  core/         Zero React, zero DOM assumptions. Portable to a native shell.
    db/           IndexedDB schema, migrations, repositories
    metadata/     Tag and stream parsers, one per container format
    platform/     Filesystem abstraction: folder handles vs. imported copies
    library/      Scanner, importer, artwork, health  (runs in a Web Worker)
    audio/        Web Audio graph, equaliser, Media Session
    playback/     Pure queue logic + the player controller
    search/  lyrics/  playlists/
  state/        Zustand stores — thin subscribers to core
  ui/           Design-system primitives, virtualised list/grid, shell
  features/     One folder per screen
  app/          Routing, theme, shortcuts, error boundary
backend/        Optional local stem-separation service (Python)
```

The full reasoning — why IndexedDB instead of SQLite, why `HTMLAudioElement`
instead of `decodeAudioData`, why the scanner reads zero records on an unchanged
library, and what a native shell would change — is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Tests

```bash
npm test
```

97 tests, run against a real IndexedDB implementation rather than a mock. The
tag parsers are tested against synthetic files assembled byte by byte in
`tests/fixtures.ts`, so edge cases — a UTF-16 tag, an unsynchronised frame, a
truncated file — are explicit and no binaries live in the repository.

---

## Status and roadmap

This release is **Phase 1 of the specification, complete**: a fast, offline,
low-power local music player, on an architecture the later phases plug into.

[docs/STATUS.md](docs/STATUS.md) lists exactly what is done and what is not,
including the one constraint worth knowing up front: **writing tags back to your
files** is only possible for a folder MusiX holds a writable handle to, which is
a limit of the web platform rather than a shortcut. It is the strongest argument
for the native shell described in the architecture notes.

---

## Licence

MIT.

Built on [Demucs](https://github.com/adefossez/demucs) (optional stem
separation), [FFmpeg](https://ffmpeg.org), React, Vite and Tailwind.
