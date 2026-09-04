# Mixdeck

Mixdeck is a warm, Apple-Music-inspired player for your own audio files. It imports music from the device, extracts metadata and embedded lyrics in the browser, builds playlists, and creates an auto-mixed queue.

## Run locally

If Node.js is installed, run `node server.js` from this folder. The app will be available on your PC at `http://localhost:8000`; on your iPhone, use your PC's IPv4 address from `ipconfig` instead of `localhost`. Both devices must be on the same Wi-Fi network. A secure HTTPS URL is recommended for the most reliable iPhone PWA install experience.

## Offline library

1. Open Mixdeck once while online.
2. Choose **Import music** and select audio files from the device's Files app.
3. Imported songs are saved as bytes in IndexedDB, along with metadata, artwork, playlists, lyrics, queue state, and playback position.
4. Open **Settings** and choose **Ask to keep files permanently** when available.
5. Install the PWA with **Share → Add to Home Screen**.
6. Test offline by turning off Wi-Fi/cellular data and reopening Mixdeck from the Home Screen.

When reopening, Mixdeck rebuilds a fresh Blob URL from the stored audio bytes only after a user taps Play. This avoids the iOS/Safari error where a previously stored media URL becomes unavailable after the second launch. iOS can still evict browser storage, so keep an original copy of your music files.

## Lyrics

Embedded lyrics are used first. If a track has no embedded lyrics, Mixdeck can look them up from LRCLIB while online through the Node server's `/api/lyrics` proxy. Plain lyrics and timestamped LRC lyrics are saved with the track, so a successful lookup is available offline afterward. A missing match, no network, API availability, or incomplete metadata will not affect playback.

## Shared music library

The **Share a song** and **Upload a song for everyone** controls require the Node server. They do not work on a GitHub Pages-only deployment because GitHub Pages is static and cannot accept uploads.

When `node server.js` is running:

- `POST /api/upload` accepts one audio file up to 100 MB.
- Uploaded audio is stored in the local `public-music` folder.
- Track metadata is stored beside it as JSON.
- `GET /api/public-tracks` lists shared songs for all visitors.
- Public audio is served with byte-range support so seeking works in the player.

To protect uploads, set an upload token before starting the server. In PowerShell:

```powershell
$env:UPLOAD_TOKEN = "choose-a-long-private-token"
node server.js
```

Enter the same token in **Settings → Shared library** before uploading. Do not publish the token or commit it to GitHub. The server host must remain online for other people to browse and play shared songs; uploading to your PC does not make the files available when the PC is turned off.

For a public always-on library, deploy the Node server and its `public-music` directory to a host that supports persistent storage and file uploads. GitHub Pages can still host the front-end, but the app would then need its API/media base URL configured for that separate server.

## Install on iPhone without the App Store

1. Open the hosted HTTPS URL in Safari.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Launch Mixdeck from the new Home Screen icon.
4. Tap **Import music** and choose files from the iPhone Files app.

This is a web app/PWA rather than a signed native `.ipa`. A true native iPhone app still needs Apple code signing and must be installed through Xcode, TestFlight, an ad-hoc profile, or a sideloading tool such as AltStore.
