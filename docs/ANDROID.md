# MusiX on Android

Branch: **`App`**. The web app lives on `WebApp`. This branch is the same code
plus everything the phone app needs: the Capacitor shell, the committed
`android/` project and one small native plugin.

MusiX ships as a WebView app rather than a rewrite. The database, scanner, tag
parsers, queue, search, equaliser and every screen run unchanged inside the
shell. Two things are native:

- **MusicLibrary**, a small Java plugin. It lists the music already on the
  phone through Android's MediaStore, so **Scan all music on this phone** finds
  your songs where they are. Nothing is copied.
- The back button and status bar, through `@capacitor/app` and
  `@capacitor/status-bar` (`src/app/native.ts`).

| Path | What it is |
|---|---|
| `capacitor.config.ts` | App id `com.musix.app`, `https` scheme, mixed content and cleartext allowed for the PC server |
| `android/` | The Capacitor 7 Android project, committed. Build output is gitignored |
| `native/android/MusicLibraryPlugin.java` | The plugin's source of truth. A copy lives in `android/app/src/main/java/com/musix/app/` |
| `native/android/AndroidManifest.additions.xml` | Permissions and `<application>` attributes the plugin needs |
| `scripts/apply-android-native.mjs` | Copies the plugin into `android/`, registers it in `MainActivity`, merges the manifest. Safe to run repeatedly; `android:sync` runs it |
| `assets/` | Icon and splash sources for `@capacitor/assets` |

---

## Prerequisites (no Android Studio needed)

| | Version | Where |
|---|---|---|
| **Node** | 20+ | |
| **JDK** | 21 (Capacitor 7 requires it; 17 is not enough) | [Temurin 21](https://adoptium.net/temurin/releases/?version=21) |
| **Android SDK** | Platform 35, Build-Tools 35 | Command-line tools, below, or Android Studio's SDK Manager |

Android Studio is optional.

### macOS (including Apple silicon / M1)

With [Homebrew](https://brew.sh):

```bash
brew install --cask temurin@21                  # JDK 21, native arm64
brew install --cask android-commandlinetools    # sdkmanager

# Add to ~/.zshrc, then open a new terminal:
export JAVA_HOME=$(/usr/libexec/java_home -v 21)
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export PATH="$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools"

sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"
sdkmanager --licenses        # answer y to each
java -version                # should say 21
adb --version                # should print a version
```

If Gradle says *SDK location not found*, create `android/local.properties`
containing `sdk.dir=/opt/homebrew/share/android-commandlinetools`.

### Windows

1. On <https://developer.android.com/studio>, scroll to *Command line tools
   only* and download the zip.
2. Pick an SDK folder, for example `C:\Android`, and unzip so the layout is
   exactly `C:\Android\cmdline-tools\latest\bin\sdkmanager.bat`.
3. Set the environment variables (PowerShell, as your user), then open a
   **new** terminal:

   ```powershell
   setx JAVA_HOME "C:\Program Files\Eclipse Adoptium\jdk-21.0.5.11-hotspot"
   setx ANDROID_HOME "C:\Android"
   setx PATH "$env:PATH;C:\Android\cmdline-tools\latest\bin;C:\Android\platform-tools"
   ```

4. Install the SDK packages and accept the licences:

   ```bash
   sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"
   sdkmanager --licenses        # answer y to each
   ```

5. Check: `java -version` says 21 and `adb --version` prints a version.

If Gradle says *SDK location not found*, create `android/local.properties`
containing `sdk.dir=C:\\Android` (with doubled backslashes).

`npm run android:apk` works the same on both: `scripts/gradle.mjs` runs
`gradlew.bat` on Windows and `./gradlew` elsewhere. To call Gradle yourself,
use `./gradlew` on macOS and `gradlew.bat` on Windows.

---

## Building the APK

```bash
git checkout App
npm install
npm run android:apk
```

The APK lands at `android/app/build/outputs/apk/debug/app-debug.apk`. The
first Gradle run downloads Gradle and its dependencies, which takes a few
minutes.

### App icon and splash screen

The launcher icons in `android/` are still Capacitor's defaults. Generate the
MusiX ones from `assets/` once, then commit the result:

```bash
npx @capacitor/assets generate --android --iconBackgroundColor "#05051a" --splashBackgroundColor "#05051a"
```

### The other commands

| Command | Does |
|---|---|
| `npm run android:sync` | Builds the web assets, applies the native plugin, copies everything into `android/`. Run after **any** change to `src/` |
| `npm run android:native` | Only re-applies the plugin and manifest additions (after regenerating `android/`) |
| `npm run android:run` | Sync, build, install and launch on an attached device or emulator |
| `npm run android:open` | Sync, then open the project in Android Studio |
| `npm run android:apk` | Debug APK, no Android Studio needed |
| `npm run android:apk:release` | Unsigned release build; see *Signing* below |

`npm run dev` alone does **not** update the APK. The web assets are copied into
the Android project at sync time; without a sync you are running the previous
build.

### Installing on the phone

- **USB:** turn on *Developer options › USB debugging*, connect the phone, then
  `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`.
- **Copy the file:** send `app-debug.apk` to the phone, open it, and allow
  *Install unknown apps* for whichever app opened it.

If the install fails with *signatures do not match*, the installed APK was
signed with another laptop's debug key. Uninstall it first. That also deletes
the app's library, so you'll scan again.

### Debugging on a device

The WebView is inspectable like a browser tab:

1. Connect the phone with USB debugging on.
2. Open `chrome://inspect` in desktop Chrome.
3. Click **inspect** under MusiX.

You get the full DevTools, including the IndexedDB inspector, which helps when a
scan behaves oddly.

---

## What works today, and what does not

### Works

- **Your phone's music, in place.** *Scan all music on this phone* adds every
  song (skipping WhatsApp audio, recordings, ringtones and alarms). *Choose
  music folders* lets you tick only the folders you want. Rescan picks up added
  and deleted songs. *Pick individual files* still copies single files in.
- Tag and artwork extraction, all browsing screens, search, playlists,
  favourites, the equaliser, ReplayGain, crossfade, the queue, synchronised
  lyrics, themes, and the lock-screen controls the Media Session API provides.
- **Studio and Download through your PC**, once connected (below).

### Gap — playback stops when the app is backgrounded

Android suspends a WebView's `AudioContext` when the app leaves the foreground,
so the Web Audio graph MusiX plays through goes silent. Lock-screen metadata
still appears; the audio does not keep going.

**The fix** is a `PlaybackBackend` interface with two implementations:

- web/desktop → the existing dual-deck Web Audio graph (keeps the EQ, crossfade
  and ReplayGain exactly as they are)
- Android → a native player behind a **foreground service** with a media
  notification

With a native backend, **the equaliser stops applying while backgrounded**
unless it also moves native. Android's `android.media.audiofx.Equalizer` maps
onto the existing ten-band model almost directly.

### Known limits of the phone library

- Each song is read fully into memory to play or scan it. Handing the `<audio>`
  element the file URL directly (`NativeSource.urlFor()` is ready for it) needs
  a change in `src/core/audio/engine.ts`.
- Capacitor's bridge doesn't exist inside Web Workers, so phone scans run on
  the main thread. A first scan of a big library may stutter the UI.

---

## Permissions

```xml
<uses-permission android:name="android.permission.INTERNET" />
<!-- Android 13+ -->
<uses-permission android:name="android.permission.READ_MEDIA_AUDIO" />
<!-- Android 12 and below -->
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE"
                 android:maxSdkVersion="32" />
```

`INTERNET` is used only for the optional online lyrics and artist photos and
for the PC server; the library itself never leaves the phone. Background
playback will later add `FOREGROUND_SERVICE`,
`FOREGROUND_SERVICE_MEDIA_PLAYBACK` and `POST_NOTIFICATIONS`.

The `<application>` element also gets `requestLegacyExternalStorage` (needed to
read files by path on Android 10) and `usesCleartextTraffic` (for the PC
server).

---

## Connecting to your PC (Studio and Download)

Audio Studio (the Demucs stem splitter) and Download (yt-dlp) run on your
computer, not the phone. Until the app is connected to the MusiX backend on
your PC, they are hidden.

1. **Start the backend in LAN mode with a password** (PowerShell, from the
   MusiX folder):

   ```powershell
   .\.venv\Scripts\Activate.ps1
   cd backend
   $env:MUSIX_API_TOKEN = "choose-a-long-random-password"
   $env:MUSIX_LAN = "1"
   python main.py
   ```

   LAN mode refuses to start without `MUSIX_API_TOKEN`. At startup it prints
   the address to use, for example `http://192.168.1.5:8000`.

2. **Allow the port through Windows Firewall.** Do this once, from an
   elevated PowerShell. Windows may also ask the first time; choose
   *Private networks*.

   ```powershell
   New-NetFirewallRule -DisplayName "MusiX backend" -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow -Profile Private
   ```

   Your Wi-Fi must be set as a *Private* network (Settings > Network &
   internet > Wi-Fi > your network).

3. **Find the PC's IP address** if the startup message didn't show it: run
   `ipconfig` and use the *IPv4 Address* of your Wi-Fi adapter.

4. **In the app:** open Settings > PC server, enter `http://<your-ip>:8000`
   and the same password, then tap **Save and test**. Once it shows
   *Connected*:
   - Audio Studio appears in the menu.
   - *Split into stems* appears in Now Playing.
   - Search offers online results when nothing matches locally.

The phone and PC must be on the same Wi-Fi. Studio and Download hide again
when the PC can't be reached, and come back when you return to the app with
the server running.

The app's origin is `https://localhost`, so the plain-HTTP PC address is mixed
content. `allowMixedContent` and `cleartext` in `capacitor.config.ts` allow it;
the backend's password is what keeps other devices on the network out.

### Stems saved on the phone

The PC keeps every separation in `backend/storage/outputs/<job id>/`. The phone
also gets its own copy, so a split song plays with the PC off:

- After **Split into stems** finishes, the app saves the stems automatically to
  `Music/MusiX/Stems/<Artist - Title>/` (`vocals.mp3`, `drums.mp3`,
  `bass.mp3`, `other.mp3`). The phone downloads them from the PC itself.
- Songs split earlier show **Save to phone** under their stems while the PC is
  connected.
- Saved stems show **Saved on this phone** in Now Playing, play offline, and
  can be deleted there with **Remove** (the PC's copy is kept).
- The phone library scan skips `Music/MusiX/Stems`, so stems never appear as
  songs.
- About 23 MB per song for four stems. Needs Android 10 or newer: saving uses
  MediaStore, which lets the app create files in `Music/` without a storage
  permission.

---

## Phone test checklist

- [ ] First launch shows the MusiX icon and the welcome screen with **Scan all
      music on this phone**, **Choose music folders** and **Pick individual
      files**.
- [ ] Scanning shows Android's permission dialog. It is called *Music and
      audio* on Android 13+, *Files and media* on 11–12 and *Storage* on 10.
      Before the first scan, Settings › Apps › MusiX › Permissions lists it
      under *Not allowed*; if that page is empty, the APK is an old build.
- [ ] Deny once, then tap **Try again**. The dialog appears again.
- [ ] Deny with "Don't ask again". The app explains how to allow it, and **Open
      app settings** opens MusiX's settings page. After allowing it there, Try
      again continues.
- [ ] **Scan all music** adds everything except WhatsApp, Recordings, Call,
      Notifications, Ringtones and Alarms folders, then opens the library.
- [ ] **Choose music folders** shows the folders with song counts, nothing
      ticked. Tick one and **Add N songs** adds only that folder.
- [ ] Albums, artists, artwork and the Folders page look right.
- [ ] Songs play, seek, and go to the next track. Try a large FLAC, and a file
      whose name contains `#`, `?` or non-Latin characters.
- [ ] Songs on an SD card (if any) appear under "SD card (…)" and play.
- [ ] Close the app fully and reopen it. The library is still there.
- [ ] Copy a new song onto the phone, tap **Rescan** on "Phone music" in
      Settings, and check it appears. Delete one, rescan, check it's gone.
- [ ] Settings › **Folders**: untick a folder and save; its songs leave. Tick it
      again and they come back.
- [ ] The back button closes Now Playing, the queue and dialogs before it
      navigates, and leaves the app only from Home.
- [ ] Settings › PC server connects to the PC (see above), and Studio appears.
- [ ] **Split into stems** shows the upload with MB/s, then the PC's stages,
      then *Saving to this phone*. The mixer plays all stems.
- [ ] The Files app shows `Music/MusiX/Stems/<song>/` with the stem MP3s, and a
      rescan does not add them to the library.
- [ ] Stop the backend (or turn Wi-Fi off). The same song still shows *Saved on
      this phone* and its mixer still plays.
- [ ] **Remove** deletes the folder's files; with the PC connected, **Save to
      phone** brings them back.

---

## Signing a release build

Debug APKs are signed with a throwaway debug key and cannot be published or
upgraded in place. For a real build:

```bash
keytool -genkey -v -keystore musix-release.keystore \
  -alias musix -keyalg RSA -keysize 2048 -validity 10000
```

Keep that file out of the repository; `.gitignore` already excludes
`*.keystore`. Then add to `android/app/build.gradle`:

```groovy
android {
    signingConfigs {
        release {
            storeFile file(System.getenv("MUSIX_KEYSTORE"))
            storePassword System.getenv("MUSIX_KEYSTORE_PASSWORD")
            keyAlias "musix"
            keyPassword System.getenv("MUSIX_KEY_PASSWORD")
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
            minifyEnabled true
            shrinkResources true
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'),
                          'proguard-rules.pro'
        }
    }
}
```

Passing the credentials through environment variables keeps them out of the
build file, which is the part that gets committed.

For the Play Store, build an App Bundle instead
(`node scripts/gradle.mjs bundleRelease`). Leave the yt-dlp downloader out of any store build: it breaks
YouTube's terms and store policies.

---

## How it fits together

- `src/core/platform/native.ts` talks to Capacitor through the bridge the shell
  injects (`window.Capacitor`), so `src/core/` imports no Capacitor package and
  the same code builds for the web.
- `src/core/platform/nativeSource.ts` is the `SourceProvider` for the phone
  library. `list()` calls `MusicLibrary.scan()` on every scan, so a rescan
  re-queries MediaStore. `open()` fetches
  `https://localhost/_capacitor_file_/<absolute path>`, which Capacitor's local
  server reads straight from storage.
- The service worker is not registered in the app (`src/main.tsx`), and one
  left by an older APK is unregistered. The APK already contains the bundle, and
  a service worker would keep serving the previous version after an update.

---

## Roadmap

| | Task | Effort |
|---|---|---|
| ✅ | Capacitor shell, back button, status bar, build scripts | done |
| ✅ | Native music library (MediaStore) with folder choice | done |
| ✅ | Studio and Download through the PC server | done |
| ⬜ | Launcher icons and splash from `assets/` (one command, above) | minutes |
| ⬜ | `PlaybackBackend` + foreground service for background playback | 2–3 days |
| ⬜ | Audio focus: pause on call, duck on notification, headset unplug | ~1 day |
| ⬜ | Stream playback from the file URL instead of reading whole files | ~half day |
| ⬜ | Android folder picker (SAF) for SD cards and unusual layouts | 1–2 days |
| ⬜ | Native equaliser via `audiofx.Equalizer` | ~1 day |
| ⬜ | Release signing, R8, Play Store listing | ~half day |
