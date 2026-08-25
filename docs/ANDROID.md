# MusiX on Android

Branch: **`Mobile`**. The web app lives on `main`; this branch adds the
Capacitor shell on top of it and nothing else.

MusiX ships as a WebView app rather than a rewrite. `src/core/` is pure
TypeScript with no DOM assumptions, so the database, scanner, tag parsers,
queue, search, equaliser and all 17 screens run unchanged inside the shell.
Only the filesystem provider and the playback backend need native code — and
both sit behind interfaces that already exist.

---

## Prerequisites

Nothing on this list is optional; Gradle will not build without all three.

| | Version | Where |
|---|---|---|
| **JDK** | 21 (Capacitor 7 requires it) | [Temurin 21](https://adoptium.net/temurin/releases/?version=21) |
| **Android Studio** | Ladybug or newer | [developer.android.com/studio](https://developer.android.com/studio) |
| **Android SDK** | Platform 35, Build-Tools 35 | Installed via Android Studio → SDK Manager |

After installing, set these so the command line can find them. On Windows
(PowerShell, as your user):

```powershell
setx JAVA_HOME "C:\Program Files\Eclipse Adoptium\jdk-21.0.5.11-hotspot"
setx ANDROID_HOME "$env:LOCALAPPDATA\Android\Sdk"
setx PATH "$env:PATH;$env:ANDROID_HOME\platform-tools"
```

Open a **new** terminal, then confirm:

```bash
java -version      # should say 21
adb --version      # should print a version
```

---

## Building the APK

```bash
git checkout Mobile
npm install
npm run android:apk
```

The APK lands at:

```
android/app/build/outputs/apk/debug/app-debug.apk
```

Copy it to a phone and install it (you will need "install from unknown
sources"), or push it over USB:

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

### The other commands

| Command | Does |
|---|---|
| `npm run android:sync` | Builds the web assets and copies them into the Android project. Run after **any** change to `src/` |
| `npm run android:run` | Sync, build, install and launch on an attached device or emulator |
| `npm run android:open` | Sync, then open the project in Android Studio |
| `npm run android:apk` | Debug APK, no Android Studio needed |
| `npm run android:apk:release` | Unsigned release build — see *Signing* below |

`npm run dev` alone does **not** update the APK. The web assets are copied into
the Android project at sync time; without a sync you are running the previous
build.

### Debugging on a device

The WebView is inspectable exactly like a browser tab:

1. Connect the phone with USB debugging on
2. Open `chrome://inspect` in desktop Chrome
3. Click **inspect** under MusiX

Full DevTools — console, network, and the IndexedDB inspector, which is the one
you will want when a scan behaves oddly.

---

## What works today, and what does not

The shell is real but thin. Being precise about this matters more than a
feature list, because two gaps change how the app feels.

### Works

Library scanning, tag and artwork extraction, all browsing screens, search,
playlists, favourites, ratings, the equaliser, ReplayGain, crossfade, the queue,
synchronised lyrics, themes, and the lock-screen controls the Media Session API
provides.

### Gap 1 — music is copied, not indexed in place

Android's WebView has no File System Access API, and its file chooser ignores
`webkitdirectory`. So MusiX falls back to the same path a mobile browser uses:
you pick audio files, and they are **copied into the app's private storage**.

That works and survives reinstall-free reloads, but it **duplicates your library
on disk**, which is wrong for a music app.

**The fix** is a small Kotlin plugin exposing one of:

- **`MediaStore.Audio`** — the OS already indexes every music file on the
  device. Fast, needs only `READ_MEDIA_AUDIO`, and is what most Android music
  players use. Best default.
- **SAF `ACTION_OPEN_DOCUMENT_TREE`** + `takePersistableUriPermission` — lets
  the user grant one folder, permanently. The direct analogue of the desktop's
  `FileSystemDirectoryHandle`, and the right answer for an SD card or an
  unusual layout.

Either becomes a third `SourceProvider` alongside `DirectorySource` and
`ImportedSource` (`src/core/platform/`). The scanner, the player and the folder
browser do not change — that is what the interface is for.

Estimate: 3–4 days, roughly 200 lines of Kotlin plus a TypeScript provider.

### Gap 2 — playback stops when the app is backgrounded

Android suspends a WebView's `AudioContext` when the app leaves the foreground,
so the Web Audio graph MusiX plays through goes silent. Lock-screen metadata
still appears; the audio does not keep going.

**The fix** is a `PlaybackBackend` interface with two implementations:

- web/desktop → the existing dual-deck Web Audio graph (keeps the EQ, crossfade
  and ReplayGain exactly as they are)
- Android → a native player behind a **foreground service** with a media
  notification

Consequence worth deciding deliberately: with a native backend, **the equaliser
stops applying while backgrounded** unless it is also moved native. Android
provides `android.media.audiofx.Equalizer`, which maps onto the existing
ten-band model almost directly.

Estimate: 2–3 days.

---

## Permissions

The current build requests **none** — the file chooser needs no permission. The
native provider will need:

```xml
<!-- Android 13+ -->
<uses-permission android:name="android.permission.READ_MEDIA_AUDIO" />
<!-- Android 12 and below -->
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE"
                 android:maxSdkVersion="32" />
<!-- Background playback -->
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

MusiX requests **no internet permission**, and should not gain one. The app has
no network path; leaving `INTERNET` out of the manifest makes that a guarantee
the OS enforces rather than a claim in a README.

---

## The audio studio from a phone

Stem separation runs on a desktop, not on the phone — Demucs is a ~2 GB model.
The Studio page will report the service as unavailable, which is correct.

To point the APK at a service on your desktop you would need to allow cleartext
traffic to that host (`android:allowMixedContent` and a network-security config
pinned to your LAN address). It is off by default on purpose: it widens what the
app can talk to, for a feature most phone users will not use.

---

## Signing a release build

Debug APKs are signed with a throwaway debug key and cannot be published or
upgraded in place. For a real build:

```bash
keytool -genkey -v -keystore musix-release.keystore \
  -alias musix -keyalg RSA -keysize 2048 -validity 10000
```

Keep that file out of the repository — `.gitignore` already excludes
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

For the Play Store, build an App Bundle instead:

```bash
cd android && gradlew.bat bundleRelease
```

---

## Roadmap

| | Task | Effort |
|---|---|---|
| ✅ | Capacitor shell, back button, status bar, build scripts | done |
| ⬜ | Launcher icons, splash screen, app identity | ~1 hr |
| ⬜ | Native `SourceProvider` (MediaStore or SAF) — **gap 1** | 3–4 days |
| ⬜ | `PlaybackBackend` + foreground service — **gap 2** | 2–3 days |
| ⬜ | Audio focus: pause on call, duck on notification, headset unplug | ~1 day |
| ⬜ | Native equaliser via `audiofx.Equalizer` | ~1 day |
| ⬜ | Release signing, R8, Play Store listing | ~half day |

Do them in that order. The `PlaybackBackend` split is worth doing even if you
later move to a fully native app, because it is the interface that would sit in
front of a Kotlin player either way.
