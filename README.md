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
npm start
```

`npm start` rebuilds the current renderer and Electron sources, verifies the required
local runtime entries, and then launches Electron. Use `npm run dev` only for the
renderer and Electron compiler watch processes.

## Windows installer

Build the NSIS setup with:

```powershell
npm run release
```

That rebuilds the app and writes `release/<version>/Karaoke Studio-Setup-<version>.exe`,
then links the same setup at `release/Karaoke Studio-Setup-<version>.exe`. It does not
bump the version and does not submit to the Store.

The approval-gated store workflow is separate. It requires a fresh Tank schema-2 approval
of an already versioned source commit, then delegates packaging to the canonical deploy
workflow with the same approval. It does not bump during that packaging. Unknown flags,
and any mix of `--bump` with `--approval`, `--build`, `--zip`, `--install`, or
`--dry-run`, fail before any write. Direct `node scripts\deploy-release.mjs` is not a
second public completion path.

```powershell
npm run release -- --approval=.squad\approvals\<fresh-approval>.json
```

Version selection, if retained on this same entry, is a separate mode and is not release
completion:

```powershell
npm run release -- --bump=patch
```

`--bump=minor` and `--bump=major` are the other kinds. That mode must not be combined
with approval or packaging flags, must not auto-commit, must not spawn packaging, and
must not exit 0. Optional friend ZIP and per-user install remain explicit flags on the
completion entry, still require the same approval, and are not implied:

```powershell
npm run release -- --approval=.squad\approvals\<fresh-approval>.json --zip
npm run release -- --approval=.squad\approvals\<fresh-approval>.json --install
```

Direct `node scripts\release.mjs` is internal. It rejects bypass before work unless it
receives the deploy-owned release-lock token and consumes a matching one-use capability. Capability issuance is private to a
process whose immutable OS command line identifies the canonical realpath
`scripts\deploy-release.mjs`; importing the module, changing `process.argv`/environment,
or running a wrapper/renamed copy cannot mint one. The consumer verifies both canonical
process images/entry scripts, PID creation identities, actual parentage, the active lock,
and its random 256-bit token before packaging. It materializes every file in the
approved target commit from Git object bytes into an owned, read-only canonical source
staging directory. It performs a fresh `npm ci` there from the committed
`package-lock.json` under an empty staged home/config, staged npm/Electron/builder
caches, a single lockfile registry origin, and a scrubbed environment with no inherited
`NODE_PATH`, npm prefix/config, workspace, credential, or proxy variables. No live
`node_modules` link or path is used. TypeScript, Vite, ASAR, and electron-builder are
resolved and hashed only below staged `node_modules`.

The complete dependency/cache file, size, mode, and content inventory is recorded.
Windows ACLs make dependencies read/execute-only before any build. After non-promotable
cache priming, its verified cache is also made read/execute-only;
Vite's runner config loader avoids its normal `node_modules/.vite-temp` write. The
locked inventories are reverified after packaging, so direct writes, replacement,
hardlinks, reparse points, path swaps, and package-binary substitution either fail or
reject promotion. Live worktree changes therefore cannot enter build output. The staged
source tree is independently hash/type/path checked before and after build and packaging,
then specifically removed. The isolated workflow performs one final build
followed by sequential NSIS and APPX
packaging, verifies packaged preload and automation files, silently installs the NSIS
artifact, extracts the APPX artifact, and launches Demucs with `ELECTRON_RUN_AS_NODE`
from both payloads. Evidence, artifact hashes, and source provenance are written under
`release`.

Release approval uses two commits. Commit the product/release implementation first
(the **target commit**). Tank then reviews that exact commit and creates a second
**approval commit** containing only `.squad/approvals/`,
`.squad/agents/tank/`, and `.squad/decisions/inbox/` records. The canonical reviewer and
committer policy is source-controlled at `.squad/reviewers.json`; local Git configuration
is not authorization. The approval commit author must exactly be the configured Tank
identity. Its committer must exactly be either Tank or the configured project maintainer,
allowing the maintainer to commit a reviewer-produced record. Its terminal trailer block
must contain exactly one `Reviewed-by: Tank <tank@squad.local>` and exactly one
`Reviewer-Role: independent-release-reviewer`. Prefixed, suffixed, case-varied,
Unicode-confusable, duplicate, conflicting, or substring matches are rejected.
Approval JSON is
fail-closed and has exact fields: `schemaVersion: 2`,
`kind: "karaoke-release-approval"`, reviewer `{ identity: "Tank", role:
"independent-release-reviewer" }`, `verdict: "APPROVE"`, exact `packageVersion`,
four-part `appxVersion`, current branch and full 40-character `targetCommit`, protected-source
`sha256` and `fileCount`, `createdAt`, `expiresAt`, and one or more evidence entries.
Each evidence entry has exactly `name`, a Tank-owned repository-relative committed `path`,
SHA-256, `status: "passed"`, equal positive `passed`/`total`, and `createdAt`. The
reviewer creates this envelope from their committed reports; release/deploy commands
only validate it and never fabricate approval. Evidence reports repeat and bind the
reviewer, role, APPROVE verdict, status, counts, and timestamp. Unknown fields, wrong
parent, product changes in the approval commit, path escapes/case tricks/ADS, dirty,
ignored, untracked, symlink/reparse, or detectably hardlinked records, stale timestamps,
unsafe or ambiguous Git clean/smudge/process/encoding/ident transforms, non-explicit
text/EOL policy, physical path case/normalization aliases, and any identity/hash/source
mismatch are rejected. Approval/evidence JSON is parsed and hashed from its canonical
committed Git blob; Git's attribute-aware index/worktree comparison permits only
explicitly declared legitimate checkout EOL representation differences. Protected packaged source at the
approval commit must be content-identical to the target parent.

The deploy-to-packager handoff is bound to the active deploy-owned release lock and its
separate one-use random token as well as deploy/child process identities/start times,
OS command lines/images and parent relation, approval HEAD, source, version, operation,
and expiry. The capability is atomically consumed before packaging; replay, missing or
wrong tokens, stale PID identities, and forged parent command lines fail closed. Handoff
environment values are deleted from the low-level process immediately after consumption.

Protected-source identity hashes file paths and contents across application source,
all scripts (excluding generated `scripts\qa-artifacts`), package metadata/lockfile,
build/configuration, and canonical skills. In-operation stability additionally records
byte lengths and modification times. Artifact provenance is bound to the approved
canonical staging aggregate; live-worktree stability remains a separate defense and is
not the source consumed by compilers or packagers. Provenance additionally binds
`package.json` and `package-lock.json` hashes, npm/Node executable hashes and versions,
the dependency/cache aggregates and counts, registry origin, resolved tool paths/hashes,
mutation protection, and post-package verification.

The internal deploy orchestrator is non-mutating unless ZIP or install was explicitly
requested on the completion entry. Reusing an existing installer requires current
version, source, approval, provenance, hashes, APPX identity, ASAR contents, and
secret-scan results to match exactly. ZIP output is atomically replaced and contains
only the installer, `README.txt`, and `SHA256SUMS.txt`. Installation is always opt-in,
targets only the exact normal per-user executable, preserves user data, and relaunches
only if that executable was running. On any failure, nothing is promoted and existing
`release`, ZIP, installation, and user data stay untouched. The workflow never publishes,
signs, changes the version during completion, enables private automation, or submits to
the Microsoft Store.

The isolated verification installs the NSIS artifact outside normal user data, extracts
the APPX artifact, and launches Demucs with `ELECTRON_RUN_AS_NODE` from both payloads
against a generated short WAV. This runtime gate verifies that Demucs, Mediabunny, its
MP3 encoder, ONNX Runtime, and generated stems work from the ASAR-unpacked layout. The
first transcription downloads the selected Whisper model into the app's private data
directory; future processing works offline.

## Microsoft Store package

Configure the publisher identity assigned by Partner Center in `package.json`, then run the same isolated release:

```powershell
npm run release -- --approval=.squad\approvals\<fresh-approval>.json
```

Before publishing, add production icons, privacy/support URLs, Store screenshots, age ratings, and license notices for the bundled AI models and media components.

## Packaged QA

Packaged private automation is disabled by default and is enabled only by the explicit `--enable-private-automation` process flag. The full release gate drives the rendered Add Songs button and native Windows file dialog, runs local AI processing, and exercises all four playback modes:

```powershell
node scripts\create-qa-fixtures.mjs
node scripts\qa-harness.mjs --app "release\win-unpacked\Karaoke Studio.exe" --process
```
