---
name: "queue-history-validation"
description: "CANONICAL DEFAULT executable validation for Queue, History, playlist transport, Previous/Next, archival, persistence, plus-menu, and protected-History tasks"
domain: "testing"
confidence: "high"
source: "earned from focused QA approval and rerun on 2026-09-18"
canonical: true
default_for:
  - "Queue/History validation"
  - "playlist transport validation"
  - "Previous/Next playback controls"
  - "Queue archival and History persistence"
---

# Queue/History Validation Runbook

Run from `C:\git\karaoke-player`. This validates source-built Electron, not an installed
package. It must produce rendered screenshots and end-to-end private-pipe evidence.

**Mandatory default:** future agents working on Queue, History, playlist transport,
Previous/Next, Queue completion/Next archival, playlist plus menus, or History persistence
must read and apply this skill before approval. This file is canonical; prior reports are
reference evidence, not required inputs.

## 1. Preconditions and Safety

Required:

- Windows PowerShell, Node/npm, and installed repository dependencies.
- `node_modules\electron\dist\electron.exe`, `dist-electron\main.js` after build, and
  `scripts\control.mjs`.
- No other Karaoke Studio instance using `\\.\pipe\karaoke-studio-control`.
- The default generated seed is
  `scripts\qa-artifacts\queue-history-seed\profile`.
- Its first two `library.json` songs must have readable local `sourcePath` files. The
  wrapper hashes these fixture files before/after.

Safety rules:

- Never pass the user's live `%APPDATA%\karaoke-studio` directory as seed or output.
- Never use the seed, repository root, or canonical evidence directory as output.
- The focused harness removes its output directory before use, copies the seed to
  `<output>\profile`, and changes only that copy.
- The wrapper refuses to overwrite
  `scripts\qa-artifacts\queue-history-focused-2026-09-18`.

## 2. Exact Reproducible Entry Point

Use a unique output path:

```powershell
Set-Location C:\git\karaoke-player
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\qa-queue-history-run.ps1 `
  -Output scripts\qa-artifacts\queue-history-focused-rerun
```

The wrapper executes these exact build/harness commands:

```powershell
npm run build
node scripts\qa-queue-history.mjs `
  node_modules\electron\dist\electron.exe `
  dist-electron\main.js `
  scripts\qa-artifacts\queue-history-seed\profile `
  scripts\qa-artifacts\queue-history-focused-rerun
```

Use `-SkipBuild` only when the same unchanged source has already completed `npm run build`
in the current review. Release approval should not skip the build.

## 3. Fixture and Temporary User Data

If the default seed is absent, the wrapper creates it before building:

```powershell
node scripts\create-qa-fixtures.mjs scripts\qa-artifacts\queue-history-seed\fixtures
node scripts\create-queue-history-seed.mjs `
  scripts\qa-artifacts\queue-history-seed\fixtures `
  scripts\qa-artifacts\queue-history-seed\profile
```

`create-qa-fixtures.mjs` creates local `qa-tone.mp3` and `qa-video.mp4` files using the
repository's pinned FFmpeg dependency and Windows SAPI. `create-queue-history-seed.mjs`
creates a clean `library.json` containing stable audio/video IDs, local source paths,
empty lyrics, legacy unknown-language metadata, and `processingStage: "idle"`. Queue/
History validation uses Original playback only, so AI processing is neither needed nor
allowed as a prerequisite. The generated seed does not reference `%APPDATA%`, a music
library, or retained historical evidence.

`scripts\qa-queue-history.mjs` performs this deterministic setup:

1. Deletes `<output>` recursively.
2. Creates `<output>`.
3. Copies `<seed-profile>` to `<output>\profile`.
4. Reads the first two songs from `<output>\profile\library.json`; at least two playable
   songs are required and the scenario uses the first two.
5. Replaces only the copied `playlists.json` with schema version 1, selected Queue, an
   empty Queue, and an empty `legacy-user` user playlist. History is deliberately absent:

```json
{
  "schemaVersion": 1,
  "selectedPlaylistId": "queue",
  "playlists": [
    {
      "id": "queue",
      "name": "Queue",
      "kind": "queue",
      "entries": [],
      "createdAt": "<current ISO time>",
      "updatedAt": "<current ISO time>"
    },
    {
      "id": "legacy-user",
      "name": "Legacy User",
      "kind": "playlist",
      "entries": [],
      "createdAt": "<same ISO time>",
      "updatedAt": "<same ISO time>"
    }
  ]
}
```

This is the migration/failure-injection fixture. The app must insert protected History
without losing or changing Queue or Legacy User.

## 4. Launch and Pipe Connection

The harness launches:

```text
<repo>\node_modules\electron\dist\electron.exe
<repo>\dist-electron\main.js
--user-data-dir=<absolute output>\profile
--enable-private-automation
```

Working directory is `node_modules\electron\dist`. Automation is explicit and private.
`scripts\control.mjs` connects to `\\.\pipe\karaoke-studio-control`, writes one
newline-terminated JSON request, and expects:

```json
{ "ok": true, "result": {} }
```

An application rejection returns `{ "ok": false, "error": "<message>" }`; malformed,
missing, or timed-out responses fail the run. Startup polls this exact request for up to
30 seconds, using 750 ms per attempt:

```json
{ "action": "status" }
```

The process is always stopped from the harness `finally` block.

## 5. Exact Request and Assertion Sequence

Selectors below exist in `src\App.tsx`; request handling exists in
`electron\automation.ts` and `scripts\control.mjs`.

### A. Migration

1. Send `{"action":"status"}`.
2. Read `result.playlists.playlists`.
3. Require all three identities and kinds:
   - `queue:queue`
   - `history:history`
   - `legacy-user:playlist`
4. Fail for a missing/duplicate system list, lost Legacy User, startup error, or any
   History content before archival.

Report case: `history-migration`.

### B. Rendered transport controls

Send these requests:

```json
{"action":"ui","uiAction":"snapshot","selector":"[data-testid=\"playback-previous\"]"}
{"action":"ui","uiAction":"snapshot","selector":"[data-testid=\"playback-toggle\"]"}
{"action":"ui","uiAction":"snapshot","selector":"[data-testid=\"playback-next\"]"}
```

Require `ariaLabel` values `Previous song`, `Play`, and `Next song`, with DOM/rendered
order Previous → Play → Next. During playback, the center label may become `Pause`.

Report case: `playback-control-placement`.

### C. Plus menu and ordinary insertion

For song 1:

```json
{"action":"ui","uiAction":"click","selector":"[data-testid=\"nav-library\"]"}
{"action":"ui","uiAction":"click","selector":"[data-testid=\"song-menu-<song-1-id>\"]"}
{"action":"ui","uiAction":"snapshot","selector":"[role=\"menu\"]"}
{"action":"screenshot"}
{"action":"ui","uiAction":"click","selector":"[data-testid=\"add-to-playlist-queue\"]"}
```

Copy the screenshot result to `<output>\plus-menu-rendered.png`; require non-zero bytes.
Require the menu snapshot text to contain `Queue`, `Legacy User`, and `New playlist` and
not contain `History`. Visually require the same menu to be viewport-level and unclipped.

Poll `status` until Queue's final `songId` is song 1. Repeat Library → song menu → click
for song 2 into Queue, then song 1 into:

```text
[data-testid="add-to-playlist-legacy-user"]
```

Require Queue order `[song1, song2]` and Legacy User order `[song1]`.

Report case: `ordinary-target-insertion`.

### D. Natural-end atomic archival

1. Click `[data-testid="nav-playlists"]`.
2. Click `[data-testid="playlist-queue"]`; poll until `selectedPlaylistId === "queue"`.
3. Click `[data-testid="playlist-entry-<first-queue-entry-id>"]`; poll until
   `currentEntryId` matches it.
4. Snapshot `audio`; require `media.duration > 1`.
5. Set the rendered seek control to `duration - 1.5`:

```json
{
  "action": "ui",
  "uiAction": "set-value",
  "selector": "[data-testid=\"playback-seek\"]",
  "uiValue": "<duration minus 1.5>"
}
```

6. Snapshot `[data-testid="playback-toggle"]`; if `ariaLabel === "Play"`, click it.
7. Poll up to 15 seconds. Require simultaneously:
   - Queue no longer contains the first entry identity.
   - Queue contains only song 2.
   - History index 0 is song 1.
   - `currentEntryId` is the second Queue entry.
   - `playback.status === "playing"` for the advanced entry.

Report case: `natural-end-atomic-history`.

### E. Rendered Next archival and newest-first History

Click:

```json
{"action":"ui","uiAction":"click","selector":"[data-testid=\"playback-next\"]"}
```

Poll until Queue is empty and History song order is `[song2, song1]`. Require the active
Queue entry was removed, its same entry identity was archived once, and song 2 is newer
than song 1.

Report case: `next-atomic-history`.

### F. History/Queue navigation

1. Add song 1 back to Queue through its rendered plus menu.
2. Click `[data-testid="nav-playlists"]`, then `[data-testid="playlist-history"]`.
3. Click `[data-testid="playlist-entry-<newest-history-entry-id>"]`.
4. Click Previous; require History remains active and current entry becomes the older
   History entry.
5. Click Next; require History remains active and current entry becomes newest History.
6. Click Next again; require `activePlaylistId === "queue"` and `currentEntryId` equals
   Queue's first entry.
7. Capture `<output>\history-navigation.png`; require non-zero bytes and visually require
   History count 2 with song 2 displayed before song 1.

Report case: `queue-history-navigation`.

### G. Restart persistence

1. Save a final pre-restart `status`.
2. Stop the exact spawned Electron child.
3. Relaunch the same executable/entry with the same isolated
   `--user-data-dir=<output>\profile` and explicit automation flag.
4. Wait for `status`.
5. Require post-restart Queue and History `songId` arrays to exactly equal pre-restart
   arrays, including order; canonical expected counts are History 2 and Queue 1.

Report case: `history-persistence`.

### H. Renderer diagnostics

Send:

```json
{"action":"diagnostics"}
```

Require `rendererErrorCount === 0` and `rendererErrors` empty. Any preload exception,
renderer exception, console error, selector failure, or unhandled rejection is a failure.

Report case: `renderer-clean`.

## 6. Protected-History Source and Compiled Checks

The wrapper runs these checks after build and fails if any are absent:

- `electron\main.ts` rejects `playlist.kind === 'history'` from ordinary add.
- `dist-electron\main.js` contains the compiled rejection message
  `Songs cannot be added directly to History.`
- Source and compiled output reject archive requests whose source is not Queue.
- Source and compiled output register `playlists:archive-queue-entry`.
- Source and compiled output each contain exactly one `history.entries.unshift` insertion
  site, inside `archiveQueueEntry`.

The directly executable check is part of `scripts\qa-queue-history-run.ps1`; do not replace
it with renderer filtering. Renderer omission of History is not an authorization boundary.

## 7. Artifacts and Thresholds

Every focused run must contain:

```text
<output>\report.json
<output>\plus-menu-rendered.png
<output>\history-navigation.png
<output>\profile\playlists.json
```

Canonical approved evidence:

```text
scripts\qa-artifacts\queue-history-focused-2026-09-18\report.json
scripts\qa-artifacts\queue-history-focused-2026-09-18\plus-menu-rendered.png
scripts\qa-artifacts\queue-history-focused-2026-09-18\history-navigation.png
```

The run remains fully reproducible if those canonical files are deleted: regenerate the
default seed and use a new `<output>`. Never use old screenshots as a substitute for a
fresh rendered run.

**PASS requires all of the following:**

- `npm run build` exit code 0.
- Wrapper and Node harness exit code 0.
- Report verdict exactly `APPROVE`.
- Exactly 8 cases, each required ID present once and `status: "passed"`.
- Both required PNG files exist, are non-empty, and pass rendered visual review.
- Renderer error count exactly 0.
- Source/compiled protection checks pass.
- Both imported source files retain exact SHA-256, length, and last-write timestamp.

There is no retry allowance, partial approval, skipped gate, or screenshot-free approval.
Any mismatch is `REJECT`, even if the other seven cases pass.

## 8. Failure Diagnosis

| Failure | Inspect first |
|---|---|
| Build/type/API mismatch | `src\types.ts`, `electron\types.ts`, `electron\preload.cts`, `src\api.ts` |
| Pipe absent/wrong response/timeout | `electron\automation.ts`, automation startup in `electron\main.ts`, `scripts\control.mjs` |
| History migration or persistence | playlist validation/load/save and `createHistory` in `electron\main.ts` |
| Direct History insertion accepted | `addSongToPlaylist` and IPC handlers in `electron\main.ts`; then confirm `dist-electron\main.js` is fresh |
| Queue archival is non-atomic/wrong order | `archiveQueueEntry` in `electron\main.ts`, then `finishQueueEntry` in `src\App.tsx` |
| Natural end does not advance/play | natural-end effect and `finishQueueEntry` in `src\App.tsx`; playback state in `src\usePlaybackController.ts` |
| Next or History navigation wrong | `playNext`, `playPrevious`, and playlist activation in `src\App.tsx` |
| Plus menu clipped/History visible | portal/menu filtering and `openMenu` in `src\App.tsx`; `.song-list` and `.playlist-menu` in `src\styles.css` |
| Screenshot is empty | `electron\main.ts` capture handler and window readiness; the harness retries capture five times at 250 ms intervals before rejecting |
| Selector/accessible-label failure | matching `data-testid` and `aria-label` in `src\App.tsx` |
| Renderer diagnostics non-zero | report details, isolated profile logs, `src\App.tsx`, and `electron\preload.cts` |
| Restart order differs | `<output>\profile\playlists.json` and playlist save/cursor logic in `electron\main.ts` |

Do not “fix” a test by weakening the assertions or suppressing renderer diagnostics.

## 9. Manual Gap A: Hostile Direct Preload/IPC Invocation

Private automation intentionally exposes no arbitrary IPC/evaluate action. This check is
manual and must not be reported as automated.

1. First run the focused wrapper successfully. Reuse only its isolated
   `<output>\profile`.
2. Launch the source-built app manually:

```powershell
Set-Location C:\git\karaoke-player
$profile = (Resolve-Path scripts\qa-artifacts\queue-history-focused-rerun\profile).Path
$electron = (Resolve-Path node_modules\electron\dist\electron.exe).Path
$entry = (Resolve-Path dist-electron\main.js).Path
$app = Start-Process -FilePath $electron `
  -ArgumentList @($entry, "--user-data-dir=$profile", '--enable-private-automation') `
  -WorkingDirectory (Split-Path $electron) -PassThru
node scripts\control.mjs status
```

3. Open DevTools with `Ctrl+Shift+I`, select Console, and execute:

```javascript
const before = await window.karaoke.getPlaylists()
const song = (await window.karaoke.getLibrary())[0]
const historyBefore = before.playlists.find((item) => item.id === 'history')
let rejection = ''
try {
  await window.karaoke.addSongToPlaylist({
    playlistId: 'history',
    songId: song.id,
    expectedUpdatedAt: historyBefore.updatedAt,
  })
} catch (error) {
  rejection = String(error)
}
const after = await window.karaoke.getPlaylists()
const historyAfter = after.playlists.find((item) => item.id === 'history')
({
  rejection,
  beforeCount: historyBefore.entries.length,
  afterCount: historyAfter.entries.length,
  beforeUpdatedAt: historyBefore.updatedAt,
  afterUpdatedAt: historyAfter.updatedAt,
})
```

4. Require rejection text containing `Songs cannot be added directly to History.`,
   unchanged count, and unchanged `updatedAt`. Save a reviewer screenshot as
   `<output>\manual-direct-history-rejection.png`.
5. Stop only this process:

```powershell
Stop-Process -Id $app.Id
```

If DevTools cannot be opened in the candidate under review, record the gap as unexecuted;
the static source/compiled checks still pass, but do not claim hostile IPC E2E coverage.

## 10. Manual Gap B: Exceptionally Long Rendered Menu Scrolling

Use the same isolated manual app/profile; never add test playlists to live user data.

1. In DevTools Console, create 30 test playlists:

```javascript
for (let index = 1; index <= 30; index += 1) {
  await window.karaoke.createPlaylist({
    name: `Scroll ${String(index).padStart(2, '0')}`,
  })
}
```

2. Reload with `Ctrl+R`, close DevTools, open Library, and click a rendered song `+`.
3. Require the menu remains wholly within the viewport, is not clipped by `.song-list`,
   has a vertical scrollbar, and can scroll from Queue/Legacy User through `Scroll 30`
   to `New playlist…`. Click one scrolled item and require the song is added to it.
4. Capture top and bottom evidence while the app is running:

```powershell
$top = node scripts\control.mjs screenshot | ConvertFrom-Json
Copy-Item $top.result.path scripts\qa-artifacts\queue-history-focused-rerun\manual-long-menu-top.png
# Scroll the open menu to its bottom in the rendered app.
$bottom = node scripts\control.mjs screenshot | ConvertFrom-Json
Copy-Item $bottom.result.path scripts\qa-artifacts\queue-history-focused-rerun\manual-long-menu-bottom.png
```

5. Require both PNGs non-empty and visually review both extremes. This remains a manual
   gate because the focused harness does not create enough playlists or drive menu scroll.

## 11. Cleanup

- Normal harness completion stops its child in `finally`.
- If a manual run remains, use `Stop-Process -Id <exact PID>`; never kill by process name.
- Keep approved output intentionally. For a throwaway run:

```powershell
Remove-Item scripts\qa-artifacts\queue-history-focused-rerun -Recurse -Force
```

- During validation, never modify the seed profile, canonical evidence, imported source
  audio, or `%APPDATA%\karaoke-studio`.
- If all generated Queue/History fixtures and seed data should be reset, remove only
  `scripts\qa-artifacts\queue-history-seed`, then rerun the canonical entry point; it
  deterministically recreates them.
