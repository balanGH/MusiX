# MusiX

**MusiX is an offline-first music library, player, and audio studio.**

It scans your local music files, reads metadata, artwork, and lyrics, and stores your library locally on your device.

## Platforms

* `webapp` — Web application
* `desktop` — Windows / macOS / Linux
* `mobile` — Android / iOS
* `main` — Main/stable branch

## Features

* 🎵 Music library and player
* 🔎 Offline search
* 📁 Local music folder scanning
* 📝 Lyrics and artwork
* 📋 Playlists and favourites
* 🎚️ Equalizer
* 🔀 Shuffle and repeat
* 🎧 Crossfade and ReplayGain
* 🎤 Optional audio studio / stem separation
* 🔒 Offline and privacy-focused

## Tech Stack

* React
* TypeScript
* Vite
* Tailwind CSS
* IndexedDB
* Capacitor
* Python / Demucs

## Run

```bash
npm install
npm run dev
```

## Build Android

```bash
git switch mobile
npm install
npm run android:apk
```

## License

MIT
