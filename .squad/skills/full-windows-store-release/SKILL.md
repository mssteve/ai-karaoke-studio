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
prepare a Microsoft Store submission. `npm run build`, an unpacked app, or a single
installer is never release completion.

## 1. Approval and Safety Gates

Do not package until the responsible QA owner has approved the exact source. Read the
feature's canonical QA skill and require a fresh report whose `verdict` is `APPROVE`,
whose `cases` array is non-empty, and whose every case is `passed`. Record its path.

Before changing anything:

1. Read `.squad\agents\switch\history.md`, `.squad\decisions.md`,
   `.squad\identity\now.md`, `package.json`, `package-lock.json`,
   `scripts\release.mjs`, recent release logs, and relevant QA skills.
2. Confirm no `.release.lock` represents a live release.
3. Record SHA-256, byte length, and last-write time for imported fixtures used by the
   approval. Record SHA-256 for the approval report and screenshots.
4. Never use live `%APPDATA%\karaoke-studio`, mutate imported media, delete retained QA
   evidence, expose signing credentials, or publish during local packaging.
5. Stop on missing Partner Center identity values, missing approval, failed checks, or
   source mutation. Do not weaken a gate.

## 2. Versioning

Use semantic `MAJOR.MINOR.PATCH`. For backward-compatible user-facing fixes or features,
choose the smallest unused patch version:

```powershell
npm version patch --no-git-tag-version
```

Use minor only for an intentionally broader compatible release and major for a breaking
contract. `package.json` and both root version fields in `package-lock.json` must match.
APPX must emit the same version as `MAJOR.MINOR.PATCH.0`. The new version must be greater
than every previously approved Store package. Never overwrite an approved same-version
artifact with different bytes; bump first.

## 3. Canonical Command

There is one official release entry point. Do not invoke electron-builder manually:

```powershell
Set-Location C:\git\karaoke-player
npm run release -- --approval=scripts\qa-artifacts\<approved-run>\report.json
```

The workflow exclusively locks release production, removes stale `release`, snapshots
inputs, runs one clean build, verifies default-disabled automation, builds NSIS then APPX
sequentially from the same build with `--publish never`, installs the NSIS silently in an
isolated location, checks packaged Demucs, and regenerates provenance and hashes.

## 4. Required Package Checks

Require `release\provenance.json` to say:

- `verdict: APPROVE` and the expected package version.
- The approval path/hash and all approval gates passed.
- One build for both targets; order `nsis`, then `appx`.
- Zero source `missing`, `extra`, and `mismatched` entries.
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

## 8. Cleanup and Completion

The workflow removes its lock in `finally`, uninstalls its isolated NSIS verification
install, and removes temporary APPX extraction. If interrupted, remove only verified
stale release scratch after confirming no release PID is active. Never remove QA evidence.

Completion requires both versioned artifacts, matching independent SHA-256 values,
fresh `SHA256SUMS.txt`, provenance with zero tracked differences, package/manifest/assets
checks, zero package-secret findings across every recorded scan scope, imported-source
and QA-evidence immutability, signing status recorded, Switch history updated, and a
decision inbox entry. State remaining external steps explicitly.
Do not claim Store submission occurred unless Partner Center actually accepted it.
