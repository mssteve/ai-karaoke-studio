---
name: "full-windows-store-release"
description: "CANONICAL MANDATORY DEFAULT process for complete branded Windows NSIS and Microsoft Store APPX releases"
domain: "release"
confidence: "high"
source: "proven by the official 0.3.1 Windows release on 2026-09-18"
canonical: true
default_for:
  - "any user-facing change intended for distribution"
  - "update, release, package, ship, publish, or Store-submit requests"
  - "Windows NSIS or APPX artifact production"
---

# Full Windows Store Release

Run from `C:\git\karaoke-player`. This is mandatory whenever a user-facing change is
intended for distribution or anyone asks to update, release, package, ship, publish, or
prepare a Microsoft Store submission. Plain `npm run release` builds the local NSIS
setup into `release/`. Store submission still requires the approval-gated workflow.
`npm run build` or an unpacked app is not a setup.

For the command-level immutable source/dependency staging procedure, also read and apply
`.squad\skills\immutable-release-staging\SKILL.md`. Any pipeline, source-selection,
dependency-resolution, cache, packaging-input, or provenance change requires a fresh
independent Tank review before an implementation commit may be followed by approval.

## 1. Approval and Safety Gates

Do not package until Tank has issued a fresh schema-2 `karaoke-release-approval` in a
dedicated approval commit whose sole parent is the reviewed source target. The approval
commit may change only `.squad/approvals/`, `.squad/agents/tank/`, and
`.squad/decisions/inbox/`; packaged source must be content-identical to its parent.
Require the tracked, clean canonical `.squad/reviewers.json` registry. The approval
author must exactly match Tank's configured name/email. The committer must exactly match
either Tank or the configured project maintainer. Require structurally parsed, unique
exact `Reviewed-by` and `Reviewer-Role` trailers and reject lookalike, prefixed,
suffixed, case-varied, duplicate, or conflicting trailer keys/values.

Approval and evidence must be exact regular-file blobs from the approval commit, clean,
tracked, nonignored, canonically cased and contained in the repository. Reject ADS,
path escapes, symlink/junction/reparse chains, and detectable hardlinks. Tank evidence
reports must bind reviewer/role, APPROVE verdict, passed status, counts, timestamp, and
hash exactly to the envelope. Never accept working-tree, ignored, or fabricated evidence.
Parse and hash approval/evidence from the canonical committed Git blobs. Validate the
index and checkout separately with Git's attribute-aware comparison so legitimate LF
blob/CRLF checkout representation is accepted, while real edits, staging, deletion,
type/path changes, and unsafe clean/smudge/process/encoding/ident attributes fail closed.
Require explicit safe transform and text/EOL states from committed attributes, reject
local/inherited overrides and sentinel-named configured filters, and verify every
physical path component has the exact canonical Git spelling and normalization.

Before changing anything:

1. Read `.squad\agents\switch\history.md`, `.squad\decisions.md`,
   `.squad\identity\now.md`, `package.json`, `package-lock.json`,
   `scripts\release.mjs`, recent release logs, and relevant QA skills.
2. Confirm no `.release.lock` represents a live release.
3. Record SHA-256, byte length, and last-write time for imported fixtures used by the
   approval. Record SHA-256 for the approval report and screenshots.
4. Never use live `%APPDATA%\karaoke-studio`, mutate imported media, delete retained QA
   evidence, expose signing credentials, or publish during local packaging.
5. Stop on missing Partner Center identity values, missing approval, failed checks,
   conflict markers in `scripts\release.mjs`, `README.md`, or this skill, or source
   mutation. Do not weaken a gate.

## 2. Versioning

Use semantic `MAJOR.MINOR.PATCH`. Completion does not select or write a version.
`approval.packageVersion` must already equal the committed `package.json` version and
both root `package-lock.json` version fields. APPX must emit that version as
`MAJOR.MINOR.PATCH.0`. The approved version must be greater than every previously
approved Store package. Never overwrite an approved same-version artifact with different
bytes.

Version updates that should succeed are:

```powershell
npm run release:major
npm run release:minor
npm run release:patch
```

Those commands update `package.json` and both root `package-lock.json` version fields, refuse a dirty tree, do not package, do not commit, and exit 0. Version selection through `--bump` without `--version-update`, if retained on the same public entry, is a separate explicit prepare
mode and is not release completion:

```powershell
npm run release -- --bump=patch
```

`--bump=minor` and `--bump=major` are the only other kinds. This mode is mutually
exclusive with `--approval`, `--build`, `--zip`, `--install`, and `--dry-run`. It must
refuse a dirty tree, conflict markers, unsynchronized manifests, and a live lock. It
must not auto-commit, must not spawn packaging, and must not exit 0 after a successful
prepare. Exit 0 is reserved for a verified promoted package. If that prepare mode is
absent, synchronize the manifests with `npm version <kind> --no-git-tag-version`, commit
that already versioned source, and obtain a fresh approval before completion. Never bump
and then deploy in one process.

## 3. Canonical Command

Plain `npm run release` builds the local Windows NSIS setup. It rebuilds the app, writes
`release/<version>/Karaoke Studio-Setup-<version>.exe`, and links that setup at
`release/Karaoke Studio-Setup-<version>.exe`. It does not bump versions or submit to the
Store. `npm run dist` and `npm run dist:store` use that same entry. Do not invoke
`scripts\release.mjs` or `scripts\deploy-release.mjs` directly for this local setup.

The approval-gated store workflow is separate:

```powershell
Set-Location C:\git\karaoke-player
npm run release -- --approval=.squad\approvals\<fresh-approval>.json
```

That store path is sufficient only with a fresh schema-2
approval of an already versioned source commit. Unknown flags, and any
mix of version mutation with `--approval`, `--build`, `--zip`, `--install`, or
`--dry-run` fail before any write. Optional friend ZIP and per-user install remain
explicit flags on this same entry, still require the same approval, and are not implied.
Store submission stays blocked until Partner Center identity replaces `KaraokeStudio` /
`CN=ms` and a fresh signed package exists.

The public entry must delegate packaging to the canonical deploy workflow with the same
approval path. It must not reimplement a second packager and must not import a capability
issuer. Direct invocation of `scripts\release.mjs` is forbidden and is rejected before
work with `Low-level packaging is internal` unless that deploy entry has issued a
one-use 256-bit capability. Issuance exists only inside the canonical deploy entry point and verifies
the current OS process image, immutable command line, script realpath, and creation
identity; importing the module or mutating JavaScript argv/environment cannot mint.
The capability is bound to the active release lock and matching random one-use token,
deploy/child PID start identities, canonical command lines/images, actual OS parent
relation, approval HEAD, target source, version, operation, and a short expiry. The
consumer revalidates all bindings, atomically consumes the capability, and clears its
handoff environment. Missing, wrong, stale, replayed, or concurrently reused tokens fail.
The workflow exclusively locks release production, removes stale `release`, and
materializes the exact approved target commit from Git object bytes into an owned
`.release-source-*` directory without checkout filters. All committed inputs are made
read-only. Run a fresh lockfile-exact `npm ci` inside that directory with an empty staged
home, explicit empty npm config files, a staged npm/Electron/electron-builder cache, a
single validated HTTPS lockfile registry origin, and a minimal environment that does not
inherit `NODE_PATH`, npm prefix/config, workspace, proxy, or credential variables. Never
link, junction, copy-on-write reference, or otherwise resolve through live
`node_modules`.

Reject dependency reparse points, symlinks, hardlinks, non-regular files, path escapes,
or missing lockfile integrity/version metadata. Record the complete file/size/mode/hash
inventory. Resolve and hash TypeScript, Vite, ASAR, and electron-builder only beneath
the staged dependency root, then ACL-lock dependencies read/execute-only before any
build. Prime required Electron/builder caches only into the owned stage using
non-promotable output, verify and ACL-lock that cache read/execute-only on Windows
(read-only modes elsewhere), delete priming output, and perform the final build/package.
Use Vite's runner config loader so it never writes `.vite-temp` under the locked
dependency tree. Reverify both inventories before artifact promotion.

TypeScript, Vite, Electron compilation, and electron-builder run with the canonical
staging root as their working directory. The live worktree is never a compiler,
packager, module-resolution, package-binary, or cache input.
Canonical files, paths, types, hashes, and aggregate are verified before and after build
and packaging; any staging mutation rejects before promotion, and the owned source stage
is specifically cleaned in `finally`. The workflow then verifies default-disabled
automation, builds NSIS then APPX
sequentially from the same build with `--publish never`, installs the NSIS silently in an
isolated location, checks packaged Demucs, and regenerates provenance and hashes.

At every phase boundary—source materialization, dependency installation, cache priming,
compile, NSIS package, APPX package, verification, and promotion—verify the bytes
actually consumed by the next command, not merely the live worktree or a before/after
proxy. Recheck canonical path, regular-file type, exact case, containment, reparse/
symlink status, detectable hardlink identity, file inventory, and aggregate hashes.
Any mismatch or unverifiable representation fails closed while leaving existing
`release`, ZIP, installation, and user data untouched.

This is a local workflow-integrity boundary, not protection from malicious code running
as the same OS user. Such code can rewrite repository configuration, implementation,
process state, or Git history. Protect the workstation/account and independently verify
the reviewed commit when that attacker model matters.

## 4. Required Package Checks

Require `release\provenance.json` to say:

- `verdict: APPROVE` and the expected package version.
- The approval path/hash and all approval gates passed.
- One build for both targets; order `nsis`, then `appx`.
- Zero canonical-stage and live-source `missing`, `extra`, and `mismatched` entries.
- Canonical staging commit/hash/file count match the approved target source; the full
  staged Git-tree aggregate is recorded and cleanup is asserted.
- Dependency mode is `fresh-lockfile-npm-ci-isolated-read-only`; provenance records
  package/lock hashes, npm and Node versions/hashes, registry origin, complete dependency
  and cache counts/aggregates, staged tool paths/hashes, ACL/read-only protection, and a
  successful post-package inventory check.
- Main `dist-electron/main.js`, preload `dist-electron/preload.cjs`, automation
  `dist-electron/automation.js`, and every renderer output match in NSIS staging, APPX
  staging, and APPX payload ASARs.
- Automation is disabled by default and enabled only by
  `--enable-private-automation`.
- APPX ZIP and ASARs are readable; installed/staged/extracted Demucs checks pass.
- The fail-closed package secret scan reports `verdict: APPROVE`, zero findings, and
  covers the complete NSIS staging tree, APPX staging tree, extracted APPX payload,
  each packed ASAR listing/content, and every `app.asar.unpacked` directory.
- APPX identity name, application ID, executable, x64 architecture, and
  `MAJOR.MINOR.PATCH.0` version match package metadata.
- StoreLogo, Square150x150Logo, Square44x44Logo, and Wide310x150Logo exist.

Then independently recompute:

```powershell
Get-FileHash "release\Karaoke Studio-Setup-<version>.exe" -Algorithm SHA256
Get-FileHash "release\Karaoke Studio-Setup-<version>.appx" -Algorithm SHA256
Get-AuthenticodeSignature "release\Karaoke Studio-Setup-<version>.exe"
Get-AuthenticodeSignature "release\Karaoke Studio-Setup-<version>.appx"
```

Both hashes must exactly match `release\SHA256SUMS.txt` and provenance. Unsigned local
artifacts are acceptable only as credentials-free candidates for Partner Center when
the Store will sign them; never claim they are signed. `Identity Publisher='CN=ms'` or
any identity not matching the app's reserved Partner Center identity is a submission
blocker requiring association/configuration and a fresh full release.

Package ignore rules are not a security boundary: Git ignores do not control
electron-builder's production dependency traversal, and broad `asarUnpack` patterns can
copy every file in a dependency. Keep secret/development exclusions in `build.files`,
and never weaken or bypass `scripts\package-secret-scan.mjs`. The scan must reject
`.env`/`.env.*`, credential/token files, private keys, certificates, signing stores,
developer credential directories, and high-confidence credential material. Safe
environment examples may be admitted only through an explicit reviewed allowlist.
Findings and release output may contain only the package-relative path and SHA-256,
never matched values or surrounding content.

## 5. Provenance Completeness

The tracked source set is the exact set produced by `scripts\release.mjs`: `electron`,
`src`, `scripts` excluding `scripts\qa-artifacts`, `build`, and the listed root metadata.
The before/after aggregate and every per-file SHA-256 must agree. Success requires zero
missing, extra, or mismatched tracked files. Count the entries and record the aggregate
SHA-256 in the release result.

Verify the approval report, screenshots, imported fixtures, and unrelated retained QA
inventory still have their pre-release hashes, sizes, and timestamps. Release output and
`dist`/`dist-electron` are expected mutations; imported sources and QA evidence are not.

## 6. Packaged QA Handoff

The official workflow proves package structure and packaged Demucs, not every rendered
feature. Hand the exact new EXE/APPX hashes to QA for any required installed/package
feature suite. QA must use an isolated install/profile, confirm zero renderer errors and
default-off automation, and bind its report to these hashes. Do not substitute
source-built QA for packaged QA where the release plan requires installed behavior.

For processing recovery changes, the packaged gate must also run the reusable runtime
failure/restart harness against the exact candidate executable:

```powershell
node scripts\qa-processing-failure-runtime.mjs `
  "<installed-app>\Karaoke Studio.exe" `
  "C:\git\karaoke-player" `
  "scripts\qa-artifacts\fixtures\qa-tone.mp3" `
  "scripts\qa-artifacts\<candidate-run>\processing-failure-runtime"
```

Require `APPROVE`, exactly 5/5 cases, and 90 assertions. The harness must launch with
both `--enable-private-automation` and `--enable-private-qa-hooks`, prove failure state
survives restart, retain usable sibling outputs, release the global scheduler slot, and
recover through the targeted component without repeating valid prerequisites. Separately
launch the packaged app with automation alone and require `qa-configure` to reject with
`Private QA hooks are not enabled.`; normal packaged launch must still expose no pipe.

## 7. Failure Diagnosis

| Failure | First action |
|---|---|
| Lock exists | Verify its PID; never delete a live lock |
| Approval rejected | Use the exact fresh canonical report; do not edit evidence |
| Build fails | Fix source/build error, rerun approval if behavior changed |
| Source comparison differs | Inspect listed missing/extra/mismatched files; reject artifacts |
| Main/preload/renderer stale | Confirm clean build outputs and ASAR paths |
| NSIS install/Demucs fails | Inspect unpack rules and `release\runtime-evidence` |
| APPX unreadable/missing assets | Repair electron-builder APPX configuration |
| Manifest version differs | Synchronize package versions and bump monotonically |
| Publisher is `CN=ms` | Obtain Partner Center reserved identity; configure and rebuild |
| Hash mismatch | Delete the entire release directory only by rerunning the official workflow |
| Package secret finding | Reject and replace all candidate artifacts; exclude at packaging scope, rotate/revoke any potentially live credential externally, then rerun the full workflow |
| Signature absent | Record unsigned status; never improvise credentials |

## 8. Packaged Microphone Monitor Gate

When a release includes live microphone monitoring, validate the exact installed NSIS
candidate with an isolated profile and safe low player volume:

- Run the deterministic microphone controller and permission suite; require 51/51.
- Capture a rendered screenshot from the installed executable and require zero renderer
  errors.
- If a default microphone is available, complete 25 on/off cycles and require every off
  transition to release the capture track and audio context. Also verify cleanup on
  reload and close.
- Exercise permission-denied and device-ended recovery. Bind simulation evidence to the
  packaged renderer/main hashes recorded by provenance.
- Confirm the packaged renderer uses only
  `getUserMedia` → `MediaStreamAudioSourceNode` → `GainNode` → destination and contains
  no recording, sample persistence, sample IPC, or network-output path.
- Confirm the permission handlers remain fail-closed and allow only trusted top-level
  audio requests from `karaoke://app`.
- Confirm APPX declares `microphone` and `runFullTrust`, with no unrelated added
  capability.

Record only technical measurements and aggregate results. Never record device names or
captured/private audio. API latency remains an output estimate, not a physical
microphone-to-output round-trip claim.

## 9. Cleanup and Completion

The workflow removes its lock in `finally`, uninstalls its isolated NSIS verification
install, and removes temporary APPX extraction. If interrupted, remove only verified
stale release scratch after confirming no release PID is active. Never remove QA evidence.

Completion requires both versioned artifacts, matching independent SHA-256 values,
fresh `SHA256SUMS.txt`, provenance with zero tracked differences, package/manifest/assets
checks, zero package-secret findings across every recorded scan scope, imported-source
and QA-evidence immutability, signing status recorded, Switch history updated, and a
decision inbox entry. State remaining external steps explicitly.
Do not claim Store submission occurred unless Partner Center actually accepted it.
