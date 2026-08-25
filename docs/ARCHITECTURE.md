# Architecture

This document records the decisions that were not obvious, and the reasoning
behind them. Anything self-evident from reading the code is left out.

---

## 1. The shape

```
                    ┌─────────────────────────────────────────┐
   features/  ──────▶            state/  (zustand)            │
   ui/        ──────▶   thin subscribers, no business logic   │
                    └──────────────────┬──────────────────────┘
                                       │
                    ┌──────────────────▼──────────────────────┐
                    │                core/                    │
                    │   no React · no DOM · no globals        │
                    │                                         │
                    │  platform/ ─▶ library/ ─▶ db/           │
                    │       │           │        ▲            │
                    │       │      metadata/     │            │
                    │       └──▶ audio/ ─▶ playback/          │
                    └─────────────────────────────────────────┘
```

The rule that keeps this honest: **`core/` imports nothing from `state/`, `ui/`
or `features/`, and touches no React.** It is the layer a native shell would
keep.

`state/` holds summaries only — counts, the current track, scan progress. Track
lists never enter React state; at 100k tracks that would be tens of megabytes
re-rendering on every change.

---

## 2. IndexedDB where the spec says SQLite

The specification describes a SQLite schema. On the web there is no SQLite
without shipping a WASM build plus a persistence shim, so IndexedDB stands in.
Two consequences shaped the whole data layer.

**No joins.** So `Track` carries denormalised `album`, `albumArtist`, `artist`
strings *and* the user's `favorite`, `rating` and `playCount`. `Album` and
`Artist` are derived aggregate records, rebuilt from the tracks store at the end
of every scan. Every list view then reads one store through one index instead of
fanning out N lookups.

**No boolean indexes.** IndexedDB valid keys are numbers, strings, dates,
binaries and arrays — not booleans. Rather than filter the whole library to find
favourites, the flags that need an index are stored as *nullable timestamps*:

```ts
favorite: boolean          // for logic
favoritedAt: number | null // for the index — null rows are absent from it
```

An index over a nullable field is sparse, so "list the favourites" becomes an
index scan over exactly the favourites, and "count the favourites" is
`index.count()`. The same trick backs `lastPlayedAt`.

### Sorted views cost one request

A sorted list is an array of *ids*, from a single `index.getAllKeys()`.
IndexedDB returns primary keys already ordered by the index key, so "all 100k
songs, title A→Z" costs one request and about 2 MB of strings — no records are
deserialised. The virtualised list then fetches the ~30 records it can show.

That is the entire performance story of the app.

---

## 3. The scanner reads nothing on an unchanged library

Spec §4 is emphatic about not rescanning thousands of files unnecessarily. The
mechanism is a compound index whose *key* is the whole fingerprint:

```ts
{ keyPath: ['sourceId', 'path', 'fileModifiedAt', 'sizeBytes'] }
```

The scanner walks it with `openKeyCursor`, so mtime and size come out of the
index key and **no record is ever fetched**. For a source with N files of which
C changed:

| Step | Cost |
|---|---|
| Build the fingerprint map | one key cursor, zero record reads |
| Walk the directory | N `getFile()` stats |
| Parse tags | C files, at concurrency 4 |
| Read existing rows (to preserve user data) | C records |
| Rebuild folders and aggregates | one cursor pass |

A rescan of an unchanged 50,000-track library therefore does N stats and nothing
else. That is the difference between a rescan being something a user does freely
and something they learn to avoid.

The whole scan runs in a Web Worker. `FileSystemDirectoryHandle` is
structured-cloneable, so the handle granted on the main thread is passed to the
worker and used directly — tag parsing, image decoding and database writes all
happen off the UI thread. Permission must still be *requested* on the main
thread, because that needs a user gesture.

---

## 4. Parsers, not a dependency

Tag reading is hand-written (`core/metadata/`). The reasons:

- **Offline-first means no runtime download**, and a bundled parser library is a
  large dependency for something that has to work on eight container formats.
- **Ranged reads.** The parsers pull only the ranges they need through a
  `ByteSource`. A 60 MB FLAC is fully described by its first few kilobytes; an
  M4A with `moov` at the end costs a handful of small reads instead of a full
  file read.
- **Control over the quirks.** Real collections are full of them, and each one
  is handled in a named place with a comment saying why:
  ID3v2.4 sizes written non-synchsafe, tag- and frame-level unsynchronisation,
  numeric `TCON` genre references, iTunes' `iTunNORM` comments, UTF-8 written
  into a latin1-declared frame.

Duration is derived rather than guessed: FLAC and WAV give it exactly, MP3 uses
the Xing/VBRI frame count when present and a CBR estimate otherwise, Ogg reads
the final page's granule position from the tail of the file.

---

## 5. `HTMLAudioElement`, not `decodeAudioData`

Decoding a track to an `AudioBuffer` gives sample-accurate scheduling and costs
about 50 MB of float32 for five minutes of stereo, plus a full decode before the
first sample plays. `HTMLAudioElement` streams through the platform's own
decoder — hardware-accelerated where available — which is what spec §4 and §37
ask for. Its output still goes into a Web Audio graph, so the equaliser,
ReplayGain and crossfade are all real:

```
elementA ─▶ sourceA ─▶ gainA ┐
elementB ─▶ sourceB ─▶ gainB ┴▶ equaliser ─▶ limiter ─▶ master ─▶ out
```

Two decks, because crossfade and the end-of-track handoff both need the next
track decoding while the current one plays. Each deck's gain carries both the
crossfade envelope and that track's ReplayGain.

**Honest limitation:** this is near-gapless, not gapless. The next element is
started a fraction early and unmuted on the audio clock, which is tight enough
that album transitions do not audibly gap — but it is not the sample-accurate
concatenation a native decoder gives you.

### Idle cost

Spec §37 asks for close-to-idle CPU when nothing is playing. Three things
deliver it:

- the `AudioContext` is **suspended** after 15 s of no playback;
- the equaliser **disconnects its filter chain** entirely when every band is at
  0 dB, rather than multiplying by one eleven times per sample frame;
- the `AnalyserNode` is only connected while a visualiser is mounted, and the
  lyrics animation loop only runs while the lyrics panel is open *and* playing.

---

## 6. Two filesystems behind one interface

`core/platform/` exposes a `SourceProvider` with two implementations, and
nothing above it can tell them apart:

| | `DirectorySource` | `ImportedSource` |
|---|---|---|
| Backed by | `FileSystemDirectoryHandle` | Origin-private file system |
| Files are | left exactly where they are | copied once, streamed |
| Survives reload | handle persists, permission does not | yes |
| Available on | Chromium desktop | everywhere |

The copy in `ImportedSource` is the one place a web build cannot honour "never
copy the user's files" (spec §9), and the reason is worth stating: a browser
without the File System Access API cannot reopen *any* file after a reload — a
`File` from an `<input>` is a one-session reference. So either MusiX copies the
bytes into storage it can reopen, or the user re-picks their whole library every
launch. Copying once is the only version of that which is offline-first, and the
import screen says so.

---

## 7. What a native shell would change

`core/` is pure TypeScript with no React and no DOM assumptions, so it drops
into a Capacitor shell largely unchanged. What that would buy:

| | Web | Native shell |
|---|---|---|
| Folder access on mobile | ❌ copy required | ✅ real filesystem |
| **Writing tags back to files** | folder handles only | ✅ everywhere |
| Background audio on iOS | partial | ✅ |
| Filesystem-wide browsing (§31) | within granted sources | ✅ |
| On-device stem separation | ❌ needs the local service | ✅ possible |

Tag writing is the one that matters most, and it is why spec §11–§12 are not in
this release: MusiX asks for **read-only** access, so it can play and index your
files but cannot rename, move or modify them. Requesting `readwrite` would let
it write tags into a `DirectorySource`, but never into an `ImportedSource`,
where it only owns a copy. Shipping a metadata editor that silently works on
some of a user's library and not the rest would be worse than not shipping one.

Mobile guidance: **one `Mobile` branch for Android and iOS**, not two. They share
`core/` entirely; the differences belong in a `platform/` folder inside that
branch, not in the branch name.

---

## 8. Deliberate non-goals in this release

Listed so they are decisions rather than omissions. Full detail in
[STATUS.md](STATUS.md).

- **Online metadata and artwork** (§10, §13). The switches exist in Settings,
  default off, and are disabled with the reason shown. Phase 2.
- **Tag writing and file reorganisation** (§11, §12). See above.
- **Waveform editor and multi-track timeline** (§20, §21). The Studio page says
  plainly that its mixer is a mixer, not a DAW. Phase 5.
- **Download manager** (§25, §26). Phase 7.

The rule from spec §41 was applied throughout: no button exists that does
nothing, and no feature is faked. Where something is missing, the UI says what
is missing and why.

---

## 9. Conventions

- **TypeScript strict**, plus `noImplicitReturns`, `noImplicitOverride`,
  `noUnusedLocals`, `noUnusedParameters`. No `any` outside the IndexedDB
  boundary, where it is confined to typed wrappers.
- **Errors are values at the edges.** The scanner, the parsers and the platform
  layer never throw for expected conditions — a corrupt file, a missing
  permission, an unreadable directory all produce a reported, recoverable
  outcome (spec §34).
- **Comments explain why, never what.** A comment that restates the code is
  deleted.
- **Tests target logic, not rendering.** The parsers, queue, rule engine, LRC
  and database layer are covered; React components are not, because their bugs
  are visual and their tests are brittle.
