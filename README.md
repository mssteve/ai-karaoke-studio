# Karaoke Studio

Karaoke Studio is a Windows desktop app for importing MP3 and MP4 songs, creating local-AI audio versions, and generating synchronized lyrics. Audio stays on the user's PC.

Each processed song includes:

- Original audio
- Vocal-clarity enhanced full mix
- Isolated and clarity-processed vocal
- Instrumental karaoke mix
- Locally transcribed, word-timed lyrics
- Detected original-language metadata, displayed without translating Unicode lyrics

The desktop library includes a persistent FIFO Queue and named playlists. A song can
appear more than once because each queue entry has its own identity. Playlist order,
the selected playlist, and its current cursor survive restart; playback itself always
restores paused at 0:00.

Runtime diagnostics are stored locally under the app data `logs` directory. The title bar's **Diagnostics** button opens that folder. No diagnostic server or browser interface is exposed.

For local development and support, the running app exposes a Windows named pipe—not a network port—at `\\.\pipe\karaoke-studio-control`. Use `npm run control -- status`, `screenshot`, `add <path>`, `process <song-id>`, `remove <song-id>`, or `control <play|pause|toggle|select|mode|seek> [value]`.

## Development

```powershell
npm install
npm run dev
```

## Windows installer

```powershell
npm run release
```

The isolated release command takes an exclusive lock, removes prior outputs, performs one build followed by sequential NSIS and APPX packaging, verifies packaged preload and automation files, silently installs the NSIS artifact, extracts the APPX artifact, and launches Demucs with `ELECTRON_RUN_AS_NODE` from both artifact payloads against a generated short WAV. This runtime gate verifies that Demucs, Mediabunny, its MP3 encoder, ONNX Runtime, and generated stems work from the ASAR-unpacked layout. Evidence, artifact hashes, and source provenance are written under `release`. The first transcription downloads the selected Whisper model into the app's private data directory; future processing works offline.

## Microsoft Store package

Configure the publisher identity assigned by Partner Center in `package.json`, then run the same isolated release:

```powershell
npm run release
```

Before publishing, add production icons, privacy/support URLs, Store screenshots, age ratings, and license notices for the bundled AI models and media components.

## Packaged QA

Packaged private automation is disabled by default and is enabled only by the explicit `--enable-private-automation` process flag. The full release gate drives the rendered Add Songs button and native Windows file dialog, runs local AI processing, and exercises all four playback modes:

```powershell
node scripts\create-qa-fixtures.mjs
node scripts\qa-harness.mjs --app "release\win-unpacked\Karaoke Studio.exe" --process
```
