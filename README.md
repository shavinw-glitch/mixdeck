# Mixdeck

Mixdeck is a private, Apple-Music-inspired player for your own audio files. It imports music from the device, extracts metadata and embedded lyrics in the browser, builds playlists, and creates an auto-mixed queue. Audio, artwork, metadata, playlists, playback position, and fetched lyrics are stored locally in IndexedDB; nothing is uploaded.

## Run locally

If Node.js is installed, run `node server.js` from this folder. The app will be available on your PC at `http://localhost:8000`; on your iPhone, use your PC's IPv4 address from `ipconfig` instead of `localhost`. Both devices must be on the same Wi-Fi network. A secure HTTPS URL is recommended for the most reliable iPhone PWA install experience.

## Offline library

1. Open Mixdeck once while online.
2. Choose **Import music** and select audio files from the device's Files app.
3. Play each track you want available offline; imported files are retained in IndexedDB.
4. Open **Settings** and choose **Ask to keep files permanently** when available.
5. Install the PWA with **Share → Add to Home Screen**.
6. Test offline by turning off Wi-Fi/cellular data and reopening Mixdeck from the Home Screen.

The service worker caches the local app shell. Imported audio remains device-local and is not synchronized between devices. iOS can still evict browser storage, so the app reports best-effort versus persistent storage in Settings; keep an original copy of your music files.

## Lyrics

Embedded lyrics are used first. If a track has no embedded lyrics, Mixdeck can look them up from LRCLIB while online. Plain lyrics and timestamped LRC lyrics are saved with the track, so a successful lookup is available offline afterward. Automatic lookup is best-effort: a missing match, no network, API availability, or incomplete metadata will not affect playback.

## Install on iPhone without the App Store

1. Open the hosted HTTPS URL in Safari.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Launch Mixdeck from the new Home Screen icon.
4. Tap **Import music** and choose files from the iPhone Files app.

This is a web app/PWA rather than a signed native `.ipa`. A true native iPhone app still needs Apple code signing and must be installed through Xcode, TestFlight, an ad-hoc profile, or a sideloading tool such as AltStore.
