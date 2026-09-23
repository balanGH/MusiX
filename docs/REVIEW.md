# MusiX — bug report and mobile plan

Review of branch `WebApp` at `c628c88`, 2026-09-23. Read-only review; no code
was changed.

**Baseline:** `npm run typecheck` clean · `npm run lint` 0 errors, 5
fast-refresh warnings · `npm test` **132/132 passing**. None of the bugs below
are caught by the current suite.

Severity: **High** = data loss, security, or a core feature visibly broken ·
**Medium** = wrong behaviour in a realistic scenario · **Low** = edge case.
✔ = re-checked against the source by hand after the automated pass.

---

## Part 1 — Bugs

### Top 10 to fix first

| # | Sev | Where | Problem |
|---|---|---|---|
| 1 | High ✔ | `backend/main.py:240,256,344` | Local service has no Origin/Host check → any website can change the download folder, start downloads, start Demucs jobs (CSRF / DNS rebinding) |
| 2 | High ✔ | `src/features/studio/StudioPage.tsx:79,274-277` | **Cancel deletes the previous finished separation** — `active` is never reset when a new job starts |
| 3 | High ✔ | `src/core/playback/controller.ts:508-514` | Missing file → old song keeps playing, UI shows the new one, Play can't stop it |
| 4 | High ✔ | `controller.ts:477-527` | Rapid Next/Prev: overlapping loads race; audio and UI end up on different tracks |
| 5 | High ✔ | `src/core/db/repositories/artwork.ts:50-59` | "Prune orphan artwork" deletes **all Deezer artist photos** (they're not counted as references) |
| 6 | High ✔ | `src/state/libraryStore.ts:322-339` | Removing a source leaves ghost albums/artists and stale playlist entries |
| 7 | High ✔ | `tracks.ts` / `schema.ts:128,142` | "Recently played" sort hides every never-played song; "Year" sort hides albums without a year (sparse IDB index) |
| 8 | High ✔ | `src/features/playlists/PlaylistPage.tsx:60,78` | "Remove from playlist" can remove the **wrong** row when the playlist has a deleted track |
| 9 | High ✔ | `src/ui/VirtualList.tsx:237-270` + `AlbumsPage.tsx:53` | Album/artist grid tiles overlap the next row (row height fixed, tile width stretches) — badly on phones |
| 10 | High ✔ | `src/ui/TrackRow.tsx:72,164,183` | On touch devices row actions are invisible (hover-only) and single tap does nothing (double-click to play) |

### Backend and Studio

1. **High — CSRF on the local service.** `main.py:240` (`/api/online/download-path`), `:256` (`/api/online/download`), `:344` (`/api/jobs`). CORS only controls who can *read* the response. A `fetch(..., {mode:'no-cors', body: new Blob([json])})` has no Content-Type, so there's no preflight, and FastAPI parses the body as JSON. With no `Host` check, DNS rebinding also works.
   *Fix:* require `Content-Type: application/json` (or multipart for `/api/jobs`), check `Origin` against `ALLOWED_ORIGINS` on every mutating route, and add `TrustedHostMiddleware(["127.0.0.1","localhost"])`.
2. **High — Studio Cancel destroys the wrong job.** `StudioPage.tsx:79-99`, `:274-277`. Start separating B while A is open, then press Cancel during B's upload. The code calls `cancelJob(A.jobId)`, and since A is finished the server runs `cleanup_job(A)`, which deletes A's stems.
   *Fix:* `setActive(null)` at the start of `separate()`; keep the in-flight job id in a ref and cancel that one.
3. **Medium — the upload limit isn't enforced while streaming.** `main.py:346,383-395`. `UploadFile` spools the whole body to temp storage *before* the handler checks the size.
   *Fix:* check `Content-Length` first, or read `request.stream()` with the cap applied.
4. **Medium — no limit on concurrent Demucs runs.** `main.py:436`. Every POST starts a new subprocess using several GB of RAM. *Fix:* `asyncio.Semaphore(1)`.
5. **Medium — `/` in artist or title breaks the import.** `main.py:315-322`, `importedSource.ts:258`. The `/file` route builds its name from the raw `f"{artist} - {title}.mp3"`, so a song by "AC/DC" fails in the browser's `getFileHandle`. *Fix:* serve `path.name` (already cleaned by `safe_filename`).
6. **Medium — any URL goes to yt-dlp.** `main.py:259-272`. That's SSRF into the LAN through yt-dlp's generic extractor. *Fix:* allow-list YouTube watch URLs, or accept a video id only.
7. **Low/Med — progress panel stuck after Cancel;** polling not aborted on unmount. `StudioPage.tsx:121-125,270`.
8. **Low — the stem mixer has no `ended` handler** (the Pause icon stays, its per-frame loop runs forever), and drift correction re-seeks while `el.seeking`. `StemMixer.tsx:136-150,239`.
9. **Low — `jobs.json` is written in place** (`main.py:96-103`); a crash mid-write loses every job. *Fix:* write a temp file, then `os.replace`.
10. **Low — `import torch` blocks the event loop** inside async handlers (`config.py:204-216`).
11. **Low — download jobs:** the job entry is created inside the thread (an early status request gets a 404); the `jobs` dict is never pruned; `.part` files are left behind; threads are unbounded. `downloader.py:327-339,487-497`.
12. **Low — client/server mismatches:**
    - The server ignores the stem subset the UI sends.
    - `waitForJob` adds a new abort listener every 1.5 s (`studio/client.ts:221-231`).
    - `onlineDownloader.ts:35` hard-codes `http://127.0.0.1:8000`, while the Studio client uses the `/api` proxy.
    - The unused `supabase/migrations/…sql` has open RLS policies (anyone can read, insert and update); delete it.

> **Legal note:** the downloader pulls from YouTube via yt-dlp. That breaches
> YouTube's Terms of Service and can breach copyright. Keep it out of any
> public or app-store build.

### Playback and audio

1. **High — missing file keeps the old track playing.** `controller.ts:508-514`. `fail()` runs without stopping the engine. On an automatic advance into a missing file playback stalls instead of skipping. *Fix:* call `audioEngine.stop()` before `fail()`; auto-skip when the reason is `'auto'`.
2. **High — load race.** `controller.ts:477-527`, `engine.ts:202-238`. Nothing marks a superseded load as stale; whichever file opens last is what you hear. Keyboard auto-repeat makes it easy to trigger (`event.repeat` isn't checked). Also, the `AbortError` from an interrupted `play()` is treated as a real failure. *Fix:* a `loadSeq` token checked after every await; ignore `AbortError`.
3. **Medium — stale `onNearEnd` double-advances** the queue if the user presses Next during the crossfade preload. `controller.ts:563-606`.
4. **Medium ✔ — removing the only queue item leaves audio playing** with the Play button disabled. `controller.ts:324-331,479-482`. *Fix:* stop the engine and clear the media session when the queue is empty.
5. **Medium ✔ — Pause during a crossfade only pauses the incoming deck.** `engine.ts:321-327`.
6. **Medium — seeking near the end while paused starts the next track** (`checkNearEnd` runs on the seek's `timeupdate`). `engine.ts:563-611`.
7. **Medium — unknown duration (0) counts as a full play immediately.** `controller.ts:637`.
8. **Medium — the session is never saved during playback.** The trailing debounce is reset every 250 ms, and nothing flushes on `pagehide`/`visibilitychange`. The queue and position are lost if the tab or mobile OS kills the app. `controller.ts:93,544`. Important for mobile.
9. **Medium — the sleep timer's "finish track" doesn't stop playback, and its listener leaks** (latent: nothing calls it yet). `controller.ts:418-437`.
10. **Med/Low — restored session lands on the wrong track** after a rescan removed earlier items (the index is clamped, not remapped). `controller.ts:154`.
11. **Low — repeat-one loops after the first aren't counted.** `controller.ts:244-247`.
12. **Low — "Find lyrics" result can be shown on the next track.** `NowPlaying.tsx:176-193`.
13. **Minor:**
    - At 2× speed the crossfade lead isn't scaled by the playback rate (`engine.ts:604`).
    - Pause is lost while `context.resume()` is pending.
    - Any settings change resets an in-progress crossfade ramp (`playerStore.ts:91`).
    - The LRC `[la:]` tag isn't recognised (`lrc.ts:18`).

### Library, database, metadata

1. **High ✔ — `forgetSource` doesn't rebuild aggregates or prune playlists.** `libraryStore.ts:322-339`. *Fix:* call `rebuildAggregates()` and `pruneMissingEntries()`.
2. **High ✔ — sparse-index sorts drop rows** (null `lastPlayedAt` / `year` aren't in the index). *Fix:* append the missing ids from the primary store, or store a `0` sentinel.
3. **High ✔ — prune deletes artist photos.** `artwork.ts:50-59`. *Fix:* also add every `listArtistPhotos()` `artworkId` to `referenced`.
4. **Medium — a rescan of a changed file wipes online lyrics** (`hasLyrics` isn't carried over; embedded lyrics overwrite the user's). `trackBuilder.ts:166`, `scanner.ts:312`.
5. **Medium — `albumArtistId` comes from the first *track* artist,** so "Various Artists" compilations land on a random artist's page. `importer.ts:531`.
6. **Medium — the one-scan-at-a-time guard doesn't work** (`scan` stays null until the first progress message). Double rescans inflate `trackCount`, and a download imported during a scan is silently never indexed. `libraryStore.ts:270-281`.
7. **Medium — a failed OPFS copy leaves a 0-byte "track".** `importedSource.ts:208-217,258`. *Fix:* `removeEntry` in the catch.
8. **Medium — Ogg/Opus with covers over 128 KB lose the cover and every later tag.** `ogg.ts:78,91-134`.
9. **Medium — M4B / chaptered M4A: the last `trak` wins,** so the codec shows as "TEXT" and the duration is wrong. `mp4.ts:153-174`. *Fix:* check `hdlr == 'soun'`.
10. **Low/Med — ID3v2.4 with tag-level unsync is decoded twice,** which corrupts JPEG covers. `id3.ts:165,228`.
11. **Low — tag precedence is inverted:**
    - MP3: the ID3v1 genre is appended.
    - FLAC: ID3 beats Vorbis comments.
    - WAV/AIFF: INFO beats ID3.

    `metadata/index.ts:446-485`, `riff.ts:88`.
12. **Low — Cancel does nothing in the no-Worker fallback.** `worker/client.ts:143-146,190`.
13. **Minor — unhandled rejection on every failed transaction.** `idb.ts:143-154`.

### UI, state, search

1. **High ✔ — playlist removal by index** removes the wrong entry. `PlaylistPage.tsx:60,78`.
2. **High — no cancellation in `PlaylistPage` `load()`** (an older playlist can overwrite a newer one) and no catch (the spinner stays forever). `PlaylistPage.tsx:40-67`.
3. **High ✔ — grid tiles overlap rows.** `VirtualList.tsx:237-270`. *Fix:* row height = `tileWidth + captionHeight`.
4. **High ✔ — hover-only row actions / double-click to play** make the track list unusable on touch. `TrackRow.tsx`, `AlbumsPage.tsx:150`. *Fix:* `@media (hover:none)` shows the controls; single tap plays on coarse pointers.
5. **Medium — global shortcuts fire inside menus and dialogs** (arrow keys change volume, Space toggles play on focused buttons). `useKeyboardShortcuts.ts:138-169`. *Fix:* honour `defaultPrevented`, skip buttons/menuitems, skip when a dialog is open.
6. **Medium — `VirtualList` cache evicts visible rows,** which get stuck as skeletons when scrolling back up. `VirtualList.tsx:336-343`.
7. **Medium — search index build races invalidation;** a stale index survives a scan. `core/search/index.ts:44-73`. *Fix:* a generation counter.
8. **Medium — grid ignores container padding,** so the last column spills 32–48 px and scrolls horizontally. `VirtualList.tsx:219-268`.
9. **Medium — the mobile tab bar is squashed by the home-indicator inset** (fixed 60 px with border-box), and toasts cover the mobile player bar. `Overlays.tsx:62,328`.
10. **Low/Med — smart-playlist rules:** multi-genre tracks fail `genre is X`; `rating 0` matches both *empty* and *not empty*. `smart.ts:36,92-94`.
11. **Low — a photo lookup lands on the wrong artist after navigating;** "Look for a different photo" always returns the same one. `ArtistPage.tsx:101-117`.
12. **Low — `AlbumPage` spins forever on a read error** (`AlbumPage.tsx:39-44`); the current folder isn't in the URL, so Back leaves the Folders page (`FoldersPage.tsx:31`).

### Docs out of date

- `docs/STATUS.md` says "97 tests passing"; there are now 132.
- `docs/STATUS.md` lists the download manager and online metadata as "not in this release". Both now exist: the yt-dlp downloader, LRCLIB lyrics and Deezer photos. `ARCHITECTURE.md` §8 says the same.

### Checked and fine

- No shell injection: `create_subprocess_exec` takes argument lists, and yt-dlp is used as a Python API.
- Stem-download path traversal is prevented.
- IndexedDB transactions never await non-IDB work.
- Parser loops on malformed files are bounded.
- Object URLs are revoked.
- Search typing is cancel-guarded.
- Route ids are hashes, so special characters in names are safe.

---

## Part 2 — Converting MusiX to a mobile app

### Recommendation: Capacitor

Wrap the existing app in **Capacitor**, add one small custom native plugin for
file access, and add a media-session plugin.

| Option | Verdict |
|---|---|
| PWA as-is | Works today, but phones have no folder access, so music is always *copied* into browser storage. iOS background audio is unreliable. Fine as a stopgap. |
| **Capacitor** | **Recommended.** `core/` has no React; file access already goes through one interface (`SourceProvider`, `src/core/platform/fs.ts:181-209`); a mobile tab bar, drawer and safe areas already exist; `ARCHITECTURE.md` §7 already plans for this. |
| React Native / Expo | A rewrite: the audio engine, worker scanner, IndexedDB, Tailwind and every screen. Not worth it. |
| Tauri 2 mobile | Same WebView audio limits as Capacitor, a smaller mobile plugin set, and adds Rust. |

### Step 1 — shell (about a day)

```bash
npm i @capacitor/core @capacitor/app @capacitor/filesystem @capacitor/preferences \
      @capacitor/status-bar @capacitor/splash-screen @capacitor/keyboard
npm i -D @capacitor/cli @capacitor/assets
npx cap init MusiX com.yourname.musix --web-dir dist
npm i @capacitor/android @capacitor/ios
npm run build && npx cap add android && npx cap add ios
npx capacitor-assets generate
npx cap sync && npx cap run android      # iOS: npx cap open ios (needs a Mac + Xcode)
```

Then:

- **Turn off the service worker in native builds.** Skip `registerSW` in `src/main.tsx:37` when `Capacitor.isNativePlatform()`, and disable VitePWA for a `--mode native` build. Otherwise app updates serve a stale bundle.
- **Skip `navigator.storage.persist()`** on native (`src/core/db/database.ts:94`).

At this point the app runs using the existing "copy files in" import mode.

### Step 2 — backend URLs (these break immediately)

- `src/core/studio/client.ts:25` uses a relative `/api` that only works through the Vite dev proxy.
- `src/features/search/onlineDownloader.ts:35` hard-codes `http://127.0.0.1:8000`. On a phone that address is the phone itself, and cleartext HTTP is blocked there anyway.

Fix:

- Add `src/core/net/apiBase.ts` backed by a "Server URL" setting, and use it in both clients.
- Hide the Studio and Download features when `/api/health` fails.
- Add `capacitor://localhost` and `https://localhost` to `ALLOWED_ORIGINS` (`backend/config.py:189`).

What to do with the backend on mobile:

- **Demucs stem separation:** can't run on a phone. Drop it on mobile, or point at a server the user runs on their PC or LAN (which needs **auth + HTTPS**, and bug #1 fixed first).
- **yt-dlp downloader:** exclude it from store builds; it will be rejected under App Store and Play policies.
- **Lyrics:** already fetched from LRCLIB in the browser, so no change needed.

### Step 3 — native music files (the main work)

1. **Types.** Add `'native'` to `SourceKind` (`src/core/types.ts:172`), plus a `uri`/bookmark field on `MusicSource`.
2. **New `src/core/platform/nativeSource.ts`,** implementing the `SourceProvider` methods:
   - `list()` — call the plugin.
   - `open()` — return a URL from `Capacitor.convertFileSrc(uri)`, never `Filesystem.readFile`. That returns base64 over the bridge and would kill scan speed.
3. **Wiring.** Add the new source in:
   - `platform/index.ts:46-50`
   - `capabilities.ts:37-80`
   - `libraryStore.ts:137-166`
   - `WelcomePage.tsx`
4. **Audio and tag reading from URLs.** `engine.ts:540` (`assignFile`) and `metadata/reader.ts:52` must accept a URL and read byte ranges, not only a Blob.
5. **Worker.** Capacitor plugins don't run inside Web Workers. List files on the main thread and pass the URLs to `scan.worker.ts`; it can range-fetch them itself.
6. **Custom plugin, about 200 lines of Kotlin + Swift:**
   - **Android:** query MediaStore.Audio (`READ_MEDIA_AUDIO`), or use a folder the user picks through Android's folder picker (SAF) with a persisted permission.
   - **iOS:** there's no system-wide music folder, and Apple Music files are DRM-protected. Use the app's Documents folder (`UIFileSharingEnabled` + `LSSupportsOpeningDocumentsInPlace`) and/or a folder picked in the Files app, saved as a security-scoped bookmark. `@capawesome/capacitor-file-picker` covers the pickers.

### Step 4 — background playback and lock screen

- **Media session.** Replace `src/core/audio/mediaSession.ts` with a plugin-backed version, e.g. `@jofr/capacitor-media-session`. Keep the same exports so `controller.ts` doesn't change. Pass artwork as a data URL, because native code can't read `blob:` URLs.
- **Android:**
  - Run a foreground media-playback service so the OS doesn't kill playback.
  - Manifest permissions: `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, `WAKE_LOCK`, `POST_NOTIFICATIONS`, `READ_MEDIA_AUDIO`.
- **iOS:**
  - Add `UIBackgroundModes: audio` to Info.plist.
  - Set `AVAudioSession` category `.playback` in AppDelegate.
- **Biggest risk: Web Audio on iOS.** The engine routes every `<audio>` element through `createMediaElementSource` (`engine.ts:118-160`) for the EQ and crossfade. WebKit suspends that graph in the background or on a phone call, so music stops.
  - Short term: a "direct" engine mode on iOS with no Web Audio graph. That means no EQ or ReplayGain, and crossfade done with `element.volume`.
  - Long term: a native player plugin (AVPlayer/ExoPlayer).
- **Prerequisite:** fix playback bug #8 (session not saved) first. Mobile OSes kill backgrounded apps routinely.

### Step 5 — mobile UI polish

- Fix the touch-related bugs first: UI #3, #4, #8, #9.
- Add `env(safe-area-inset-*)` to the full-screen overlays, which currently sit under the notch:
  - `NowPlaying.tsx:206`
  - `Overlays.tsx:126,232`
  - `AppShell.tsx:92`
- Android back button (`@capacitor/app` `backButton`): close Now Playing, the drawer or the queue first, then go back one route. This also needs the folder level in the URL (UI #12).
- `@capacitor/status-bar`, synced from `ThemeManager.tsx`.
- `@capacitor/keyboard`, for the Search page.

### Top risks — prototype these first

1. **iOS background audio** with the Web Audio graph.
2. **`convertFileSrc` URLs** supporting HTTP Range requests, for both `<audio>` streaming and tag parsing. Verify on real devices before building anything else.
3. **iOS file access model.** Users add files to the app; it can't scan "the whole phone".
4. **Store policy.** Remove the downloader.
5. **The OS clearing WebView storage.** Add a library export/backup.

The plugin names above haven't been installed or tested. Check each one's
current docs, especially the foreground-service behaviour of the media-session
plugin.

### Suggested order

1. Fix the High bugs, plus playback #8.
2. PWA touch fixes (UI #3, #4, #9).
3. Capacitor shell with import mode.
4. Background audio on Android, then iOS.
5. The native file-source plugin.
6. Optional remote Studio server.
