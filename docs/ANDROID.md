# Building the Android app

MusiX's Android app is the same web app inside a Capacitor shell, plus one
small native plugin, **MusicLibrary**. The plugin lists the music already on the
phone through Android's MediaStore, so "Scan phone music" finds your songs where
they are. Nothing is copied.

The `android/` project is **generated on the build machine** and is not tracked
in git (see `.gitignore`). What this repo tracks:

| Path | What it is |
|---|---|
| `capacitor.config.json` | App id `com.musix.app`, name, `webDir: dist`, `http` scheme, cleartext allowed |
| `native/android/MusicLibraryPlugin.java` | The plugin's source of truth |
| `native/android/AndroidManifest.additions.xml` | Permissions and `<application>` attributes the plugin needs |
| `scripts/apply-android-native.mjs` | Copies the plugin into `android/`, registers it in `MainActivity`, merges the manifest. Safe to run repeatedly |
| `assets/` | Icon and splash sources for `@capacitor/assets` |

The plugin is written in Java, not Kotlin. The Capacitor template is a Java
project, so Java compiles without adding the Kotlin Gradle plugin.

---

## 1. One-time setup on the build laptop (no Android Studio)

You need three things:

1. **Node 20+** and this repo.
2. **JDK 21.** Capacitor 8 compiles with Java 21 (`JavaVersion.VERSION_21` in
   its Gradle files), so JDK 17 is not enough. Any distribution works, for
   example Eclipse Temurin 21. Set `JAVA_HOME` to it and check with
   `java -version`.
3. **Android command-line tools.** On <https://developer.android.com/studio>,
   scroll to *Command line tools only* and download the zip for your OS.

   ```text
   # Pick an SDK folder, e.g. C:\Android (Windows) or ~/Android (macOS/Linux).
   # Unzip so the layout is exactly:  <sdk>/cmdline-tools/latest/bin/sdkmanager
   ```

   Then set the environment variables:

   | Variable | Value |
   |---|---|
   | `ANDROID_HOME` | the SDK folder, e.g. `C:\Android` |
   | `PATH` | add `<sdk>/cmdline-tools/latest/bin` and `<sdk>/platform-tools` |

   Install the SDK packages and accept the licences:

   ```bash
   sdkmanager "platform-tools" "platforms;android-36" "build-tools;35.0.0"
   sdkmanager --licenses        # answer y to each
   ```

   Gradle downloads any other build-tools version it needs on its own, once
   the licences are accepted.

   If Gradle later says *SDK location not found*, create
   `android/local.properties` containing `sdk.dir=C:\\Android` (escape the
   backslashes on Windows), or `sdk.dir=/home/you/Android`.

### Replacing the old `android/` folder

The APK built earlier on this laptop came from a hand-made `android/` folder.
**Delete or rename that folder** and generate a fresh one from this repo as
below. Otherwise it lacks the MusicLibrary plugin, its permissions, and the
`http` scheme.

---

## 2. Build the APK

From the repo root:

```bash
# Capacitor itself. The web build does not need it, so it is not in package.json.
# Keep all @capacitor/* packages on the same major version.
npm install
npm i @capacitor/core@8 @capacitor/android@8
npm i -D @capacitor/cli@8 @capacitor/assets

npm run build                       # type-check + Vite build into dist/
npx cap add android                 # generates android/ (only the first time)
npm run android:native              # plugin + MainActivity + manifest
npx @capacitor/assets generate --android \
  --iconBackgroundColor '#05051a' --splashBackgroundColor '#05051a'
npx cap sync android                # copies dist/ and capacitor.config.json in

cd android
./gradlew assembleDebug             # Windows: gradlew.bat assembleDebug
```

The first Gradle run downloads Gradle and its dependencies, which takes a few
minutes.

**APK:** `android/app/build/outputs/apk/debug/app-debug.apk`

### After changing the web code

```bash
npm run android:sync                # build + android:native + cap sync
cd android && ./gradlew assembleDebug
```

Run `npx cap add android` only once. If you ever delete `android/`, repeat the
full sequence above, including `android:native` and the assets step.

### Installing on the phone

- **USB:** turn on *Developer options › USB debugging* on the phone, connect it,
  then run `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`.
- **Copy the file:** send `app-debug.apk` to the phone (cable, cloud drive,
  chat), open it, and allow *Install unknown apps* for whichever app opened it.

If the install fails with *signatures do not match* or *package conflicts*, the
old APK was signed with another laptop's debug key. Uninstall the old MusiX
first.

### App data resets once

This build serves the app from `http://localhost`. The earlier hand-made APK
almost certainly used Capacitor's default, `https://localhost`. The library,
playlists and settings are stored per origin, so **the first launch of this
build starts with an empty library**. Scan the phone's music again. Later
updates keep the data, as long as you install over the app instead of
uninstalling it.

Why `http`: it lets the app reach the optional PC server over plain HTTP on the
local network. An `https` page would block those requests as mixed content.

---

## 3. Phone test checklist

- [ ] First launch shows the MusiX icon and the welcome screen, with **Scan
      phone music** as the main button and **Pick individual files** below it.
      There is no "Choose a folder" button.
- [ ] Tapping Scan phone music shows Android's *Music and audio* permission
      dialog. On Android 12 and older, the dialog says *Files and media*.
- [ ] Deny once, then tap **Try again**. The dialog appears again.
- [ ] Deny with "Don't ask again", or deny twice. The app explains how to allow
      it in Settings, and **Open app settings** opens MusiX's settings page.
      After you allow the permission there, Try again continues.
- [ ] The folder list shows your folders with song counts. WhatsApp, Recordings,
      Call, Notifications, Ringtones and Alarms start unticked.
- [ ] **Add N songs** scans and opens the library. Albums, artists, artwork and
      the Folders page look right.
- [ ] Songs play, seek, and go to the next track. Try a large FLAC, and a file
      whose name contains `#`, `?` or non-Latin characters.
- [ ] Songs on an SD card (if any) appear under "SD card (…)" and play.
- [ ] Close the app fully and reopen it. The library is still there, and a song
      plays without rescanning.
- [ ] Copy a new song onto the phone. In Settings › Music folders, tap
      **Rescan** on "Phone music" and check that the song appears. Delete a
      song, rescan, and check that it disappears.
- [ ] Settings › Music folders › **Folders**: untick a folder and save. Its songs
      leave the library. Tick it again and they come back.
- [ ] "Add folder" in the sidebar and on Home re-scans the phone library instead
      of showing an error.
- [ ] Pick individual files still works.
- [ ] Settings › Storage shows "Persistent".

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

---

## How it fits together

- `src/core/platform/native.ts` talks to Capacitor through the bridge that the
  shell injects (`window.Capacitor`), so the web build has no Capacitor
  dependency at all.
- `src/core/platform/nativeSource.ts` is the `SourceProvider` for the phone
  library. `list()` calls `MusicLibrary.scan()` on every scan, so a rescan
  re-queries MediaStore. `open()` fetches
  `http://localhost/_capacitor_file_/<absolute path>`, which Capacitor's local
  server reads straight from storage.
- Reading files by absolute path needs the media permission. On Android 10
  only, it also needs `requestLegacyExternalStorage`, which is in the manifest
  additions.
- Capacitor's bridge does not exist inside Web Workers, so phone-library scans
  run on the main thread (`src/core/library/worker/client.ts`). They take a
  little longer than desktop scans.
- The service worker is not registered in the app (`src/main.tsx`). The APK
  already contains the bundle, and a service worker would keep serving the
  previous version after an update.
