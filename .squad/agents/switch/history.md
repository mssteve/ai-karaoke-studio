# Switch History

## Project Context

Karaoke Studio targets Windows and later Microsoft Store distribution. Requested by Steve.

## Learnings

- 2026-09-17 packaging audit: the current TypeScript build emits `dist-electron\preload.cjs`, matching the BrowserWindow preload path, but the existing 0.2.0 APPX contains `dist-electron\preload.js` instead. Existing release artifacts therefore predate the preload fix and must not ship.
- The existing APPX manifest still uses placeholder identity `KaraokeStudio` and publisher `CN=ms`; Partner Center identity values and signing are required before Store submission.
- The existing NSIS EXE, APPX, and unpacked executable are unsigned. No QA approval report is present under `scripts\qa-artifacts`.
- The APPX includes Windows FFmpeg and the Demucs model, but broad native-module unpack rules also include unused Linux, macOS, ARM64, and duplicate ONNX Runtime payloads. Whisper is downloaded on first transcription rather than bundled for first-run offline use.
- Runtime automation uses the Windows named pipe `\\.\pipe\karaoke-studio-control`; no TCP/HTTP listening port is configured. The renderer and media are served internally through the privileged `karaoke://` Electron protocol.
- 2026-09-17 Sprint 3 revision: added the exclusive `npm run release` workflow. It removes stale outputs, takes a process lock, records source provenance, builds once for NSIS and APPX, disables publishing, verifies current main/preload/automation hashes inside staging and APPX ASARs, and emits SHA-256 hashes.
- Packaged private automation is disabled by default and enabled only by `--enable-private-automation`. Final packaged QA proved the default pipe is absent, the flagged pipe answers, and neither process tree owns a listening TCP port.
- Packaged QA now drives the rendered Add Songs button and the real Windows common file dialog using Windows UI Automation plus SendKeys. It imports both MP3 and MP4 fixtures without the removed fixture-dialog bypass.
- The final full packaged run passed 22/22 gates, including Demucs/Whisper processing, three timed lyric lines, and distinct enhanced, vocal, instrumental, and original controls.
- Final isolated artifacts are provenance-locked in `release/provenance.json`; `release/SHA256SUMS.txt` records EXE hash `7ed042ab544c26b54409d52be7f6e0bc64fe4d68ec81c2c54a9e2af7dc093943` and APPX hash `1223aec17eab496ad8605d9326e911ec8206b78ceb210f2ebea56b3908388410`.

📌 Team update (2026-09-17T17:23:31.480-07:00): The fresh isolated NSIS/APPX artifacts and all packaged release gates received final approval — decided by Neo, Trinity, Morpheus, Tank, and Switch.

- 2026-09-17 seamless-mode release: the official workflow now records the approved 5/5 source report, hashes every current renderer output plus `preload.cjs`, builds NSIS then APPX sequentially from one build, and verifies staging/APPX ASAR and APPX ZIP readability.
- Final packaged focused QA passed 5/5 with explicit private automation and zero listening TCP ports. Evidence: `scripts/qa-artifacts/mode-switching-packaged-approved-2026-09-17/report.json`.
- 2026-09-18 fourth-author near-end playback revision: the hang came from treating an unexpected media `pause` while play intent remained active as a no-op, combined with event handlers reading a stale rendered status. A near-end pause could therefore remain logically “playing” forever, while a later pause event could also overwrite a completed `ended` transition.
- Playback status now has an authoritative ref updated with React state, unexpected non-terminal pauses recover playback, terminal settlement atomically clears pending seek/mute/play intent, and the watchdog settles only at the actual end or a tightly bounded stalled tail instead of the previous three-second window. Mode targets are clamped back into shared logical state when switching to shorter tracks.
- Clean build passed. The unchanged exact mode suite passed 5/5 in three stress runs and a final canonical run at `scripts/qa-artifacts/mode-switching-switch-fourth-author-final-2026-09-18/report.json`; playlist/language passed 16/16 at `scripts/qa-artifacts/playlist-language-switch-fourth-author-final-2026-09-18/report.json`, including FIFO exactly-once autoplay, final ended state, 0:00 reset, lyrics, and zero TCP listeners.

- The official seamless-mode artifacts were rebuilt sequentially and passed packaged QA 5/5. Verified SHA-256: NSIS `edecc067b9122c6898d8c961b2a0f862402ea7c777c103e4ae6f92bfc7465b4b`; APPX `eea9ad3cc8340e1ff07dbf55ef2daa1d0e7a9aff3842366dc78a7fe5cdd99280`.

📌 Team update (2026-09-17T21:23:57.955-07:00): Switch completed the clean sequential NSIS/APPX rebuild; the packaged focused suite approved all 5 gates with zero TCP listeners.

- 2026-09-17 installed-app incident: unpacked `demucs/dist/mp3-encoder.js` could not resolve `mediabunny` because Demucs was outside ASAR while `mediabunny` and `@mediabunny/mp3-encoder` remained inside it.
- Explicitly unpacked both dependencies and rebuilt the official NSIS and APPX. Final SHA-256: NSIS `9929d547d0b471379061c62ae2e1275311c0ea9927efb6dbf20e029332e89145`; APPX `5cc93034536fc622d9a9888cee7fbae182a5f9be72ba9fcbd9a7bc9c93b8a675`.

📌 Team update (2026-09-17T22:55:03.579-07:00): The replacement Windows release fixes installed Demucs module resolution by unpacking its media encoder dependencies; installed-path and real-song QA approved the new artifacts.

- 2026-09-18 Karaoke Studio 0.3.0 packaging: version and lockfile were synchronized, and the official exclusive workflow built NSIS then APPX from one clean source snapshot. Provenance verified current renderer/main/preload/automation hashes, readable staging and APPX ASARs, APPX ZIP readability, unchanged release inputs, and packaged Demucs from NSIS and APPX payloads.
- The NSIS package was installed outside project ancestors at `%LOCALAPPDATA%\KaraokeStudio-QA-0.3.0`. Installed Demucs produced 4/4 valid stems; canonical playlist/language QA passed 16/16 with zero renderer errors and zero TCP listeners; native common-dialog import, default-disabled automation, explicit-flag automation, full AI processing, timed lyrics, and all four controls passed before the harness's later cleanup step failed.
- Final 0.3.0 release approval is withheld. The strict installed mode suite repeatedly timed out waiting for terminal `ended` under its normal runner, although an instrumented observation run captured 5/5 and a true `ended` event. A forced legacy-language retranscription reported detected Chinese in memory but left `library.json` persisted as `und`/`Unknown`, causing that focused persistence run to fail 15/16.
- Candidate artifact SHA-256 values: NSIS `b382db3978a19c1cb2562010ff72ae995de1b6c2d92b7ce0d3a9b0a14b92d89a`; APPX `579e33fdd0c0e83d66e4c8ed44b9e6ca998a7a53d42cee2637202341112a9382`.

- 2026-09-18 final 0.3.0 approval: Apoc corrected the actual-duration terminal acceptance and retranscription CLI songId/timeout defects; Tank then approved refreshed provenance with all 47 entries and zero mismatches. The existing product binaries remained byte-correct and required no rebuild.
- Approved hashes: NSIS `b382db3978a19c1cb2562010ff72ae995de1b6c2d92b7ce0d3a9b0a14b92d89a`; APPX `579e33fdd0c0e83d66e4c8ed44b9e6ca998a7a53d42cee2637202341112a9382`; provenance aggregate `8f2455146a918ebb8e0ce0737183777316c05e0f290cf4a63a66fe8efdc8b6b0`.

📌 Team update (2026-09-18T09:32:50.972-07:00): Switch's previously withheld 0.3.0 candidate is now approved after strict runtime and provenance remediation; automation remains default-off and all renderer/TCP checks are clean — decided by Neo, Trinity, Morpheus, Tank, Switch, Cypher, and Apoc.

- 2026-09-18 Queue/History Windows release: bumped the smallest monotonic version from 0.3.0 to 0.3.1 and ran the exclusive `npm run release -- --approval=scripts\qa-artifacts\queue-history-canonical-proof\report.json` workflow. The workflow accepted the canonical 8/8 approval, built NSIS then APPX from one clean build with publishing disabled, and verified installed/staged/extracted Demucs 4/4.
- Provenance tracks 50 source entries with aggregate SHA-256 `7e49bbc60c68c4c535890d572bce32bcdfd5ce57b1758963a68c557e673d52cf` and zero missing, extra, or mismatched files. Main, preload, automation, and all renderer entries matched across NSIS staging, APPX staging, and the APPX payload. Automation remains disabled by default.
- Final local artifacts: NSIS `release\Karaoke Studio-Setup-0.3.1.exe`, SHA-256 `f76ed3a9b01c68e4c7a84e69f3ee9d752145d58610a421055fa444b634ad288d`; APPX `release\Karaoke Studio-Setup-0.3.1.appx`, SHA-256 `cbcc91acc5af14d23c6b41d5b862f35042533bdd383f433fe124de5265c32a6b`.
- APPX version `0.3.1.0`, x64 application entry, ASAR, and all four Store assets passed. Both artifacts are intentionally unsigned. Microsoft Store submission remains blocked because the manifest still has placeholder identity `KaraokeStudio` / publisher `CN=ms`; Partner Center's reserved identity must be supplied and the official workflow rerun before upload.
- Added and executed the canonical mandatory `.squad\skills\full-windows-store-release\SKILL.md` process. The approved Queue/History report, screenshots, fixture hashes, sizes, timestamps, and the 16,611-file QA-artifact inventory remained unchanged.

📌 Team update (2026-09-18T15:07:36.120-07:00): `.squad\skills\full-windows-store-release\SKILL.md` is mandatory reading before every release. Approved user-facing or shipped-runtime changes automatically route to Switch; completion requires the full NSIS/APPX, provenance, packaged-QA, and reviewer workflow, never build-only validation.

- 2026-09-18 Git initialization: initialized the released baseline on `main`; generated packages, QA evidence, temporary profiles, local AI downloads, secrets, signing keys, caches, and Squad runtime state are excluded while source, lockfiles, build icons, release/QA runners, and canonical Squad records remain visible.
- 2026-09-18 cleanup audit: safe release cleanup should retain provenance-bound 0.3.1 binaries, current `dist`/`dist-electron`, staging/runtime evidence, canonical approvals, referenced historical evidence, reusable fixtures, and ambiguous successful runs. Exact rejected runs, abandoned probe/debug profiles, empty isolated install roots, builder debug metadata, and unused blockmaps can be removed after recording per-path sizes and confirming their superseding approvals.

- 2026-09-18 exact disposable-profile cleanup: re-inspected and removed only `scripts\qa-artifacts\2026-09-18T00-31-52.127Z`, `scripts\qa-artifacts\2026-09-18T00-34-03.328Z`, and `scripts\qa-artifacts\2026-09-18T00-35-34.301Z`. Each remained a direct non-reparse child of `scripts\qa-artifacts` containing only generated `profile` data; 5,518,228 logical bytes were reclaimed.
- Reverified the existing 0.3.1 release without rebuilding. NSIS SHA-256 remains `f76ed3a9b01c68e4c7a84e69f3ee9d752145d58610a421055fa444b634ad288d`; APPX remains `cbcc91acc5af14d23c6b41d5b862f35042533bdd383f433fe124de5265c32a6b`; the recorded 50-entry provenance aggregate remains `7e49bbc60c68c4c535890d572bce32bcdfd5ce57b1758963a68c557e673d52cf`. APPX readability and all six provenance-bound packaged build outputs passed, canonical Queue/History approval remains 8/8 with both screenshots intact, and all four Demucs evidence reports remain PASS with 4/4 stems.

- 2026-09-18 processing recovery Windows release: selected the smallest monotonic version, 0.3.2 / APPX 0.3.2.0. The exclusive workflow built NSIS then APPX from one clean build with publishing disabled. APPX validation was corrected to use Windows `System.IO.Compression.ZipFile`, because Store APPX data descriptors are readable by Windows but rejected by `adm-zip`.
- Final artifacts: NSIS `release\Karaoke Studio-Setup-0.3.2.exe`, SHA-256 `728d8fbbaa286c0bc931aa00923951224bea75fd3c41b8a5213337098912a06c`; APPX `release\Karaoke Studio-Setup-0.3.2.appx`, SHA-256 `ae361e711580542791ee9a0b61feea6ec64b7bddbe918bff66b73e4c17ea83a4`.
- Provenance covers 68 current source/reusable release and QA files with aggregate SHA-256 `eee23fdd13fc4f32c4839a099c959308742747f21a6f2a17940ce9f3c353185a` and zero missing, extra, or mismatched entries. Installed NSIS and APPX payload ASAR hashes are identical (`5cf9eb23d24d6408e2cdb2c7e75edc64523f8aa4508204bf304f16a1ad3bca64`); all six main/preload/automation/renderer outputs match provenance.
- Packaged QA passed: seven focused processing suites; rendered processing UI 9/9; runtime failure/restart 5/5 with 90 assertions; Queue/History 8/8; installed Demucs 4/4; default-off automation and the separate QA-hook gate. CPU policy and Demucs/Whisper propagation are packaged, while GPU percentage limiting remains truthfully unsupported.
- All 11 critical approval reports/screenshots/imported fixture songs retained exact hashes, sizes, and timestamps. Across the pre-release inventory, 14,559 retained files were unchanged. The NSIS upgrade removed 588 files belonging only to the superseded 0.3.1 installed-application copy; no imported source, report, screenshot, or approval document was affected.
- Package verdict is **APPROVE PACKAGE / BLOCK STORE SUBMISSION**. Both artifacts are unsigned, and APPX identity `KaraokeStudio` / publisher `CN=ms` remain placeholders. No signing credentials were used and no Store submission occurred. Canonical evidence: `scripts\qa-artifacts\processing-packaged-0.3.2-switch\release-verdict.json`.
- Added the reusable packaged processing failure/restart and dual-gate procedure to `.squad\skills\full-windows-store-release\SKILL.md`.

- 2026-09-18 replacement release handoff: the first 0.3.2 artifacts (`728d8fbb...` / `ae361e71...`) are rejected and superseded by Neo's secret-safe rebuild and Tank's independent approval. Authoritative hashes are NSIS `da92c3aa353e1bafcff25e02775ab52396e8becfdd5f3f1c1b71ad5ffa27e28b`, APPX `a6b43fb07778a9d05c7cfa3501452304d10756b47e29493888456c03a612f491`, and provenance `42a683ae733b4ff87ab466c29506641e42c8eb5b69b2bb9e3a0b346de55a7c45`.
- Pending publication directive: after selective staging/review and the initial commit, add `https://github.com/mssteve/ai-karaoke-studio.git` as `origin`, ensure `main`, and push with upstream tracking. Store publication remains blocked and is separate from GitHub publication.

📌 Team update (2026-09-18T20:04:53.087-07:00): Switch owns the next Git publication step. Scribe performed no commit, remote addition, or push.

- 2026-09-18 local launch recovery: the supported source-tree launch is now `npm start`. It runs the clean current-source build, verifies renderer, main, preload, transcription, and Demucs outputs, then launches Electron by the explicit compiled main entry. Direct `electron .` launches are unsupported because `package.json` points at generated `dist-electron\main.js`, which is intentionally removed at the start of every build.
- Repository QA launchers that accept a local Electron entry now validate the executable plus main, preload, transcription, and Demucs outputs before spawning Electron, producing a CLI build instruction instead of Electron's missing-app dialog. No matching repository, Desktop, Start Menu, or pinned Taskbar shortcut was found; `scripts\control.mjs` only connects to an already-running app.

- 2026-09-18 Karaoke Studio 0.3.3 release: bumped package and lockfile versions to
  0.3.3 and ran the exclusive canonical workflow from one clean build. NSIS then APPX
  were produced sequentially with publishing disabled. Final SHA-256 values are NSIS
  `ac32f31262430f2aa1f0a6ee95e481023839a91f42e07e5be11b543b883c2cab`
  and APPX
  `797e6c59c9cd413c78a50c922f77c9b736636224807609cfb72432a25c9b31b1`.
- Provenance SHA-256 is
  `7605da0a4830187f53e6736461610e20c70c97eeb4afa5bfed7dbe9c5a9776b5`;
  it records 77 source/release/QA inputs, aggregate
  `c5975f34e39fa9ce8306df033bf917815bc4f2018d8bbbcefb8dd2eeb4fcbb5f`,
  and zero missing, extra, or mismatched entries. Nine fail-closed package scan scopes
  checked 22,952 files and 8,141,006,572 bytes with zero findings.
- Package-backed validation passed processing suites, rendered UI 9/9, failure/restart
  6/6 with 113 assertions, lyric timing 33/33, Queue/History 8/8, Demucs 4/4,
  a representative private Music subset 2/2 with 8/8 stems, and automation isolation
  3/3. All 16 authorized private source files retained their hashes, sizes, and
  timestamps; evidence records only an anonymized aggregate.
- NSIS staging, isolated NSIS install, and APPX payload ASARs are byte-identical and
  contain initialized validated Demucs inference, lyric normalization/fallback,
  resumability, the serial scheduler and CPU caps, Enhanced UI, Queue/History, and
  double-click behavior. The safe `npm start` launcher is provenance-bound and builds
  and verifies generated outputs before launching.
- APPX 0.3.3.0 is x64/full-trust and contains all four required Store assets.
  Package verdict is **APPROVE PACKAGE / BLOCK STORE SUBMISSION**: identity
  `KaraokeStudio` / publisher `CN=ms` remain placeholders and both artifacts are
  unsigned. No signing, Store submission, commit, or push occurred. Canonical evidence:
  `scripts\qa-artifacts\release-0.3.3-cdp-final\release-verdict.json`
  (SHA-256 `98e8a406b01e695d1e6d2288ac7a78dc9ef6f47b75475a06baf9b9d6ef25f69e`).

📌 Team update (2026-09-19T02:52:27.047-07:00): Switch's preliminary 0.3.3 hashes are superseded by Tank's frozen approval: NSIS `04d9c061...`, APPX `fe78e626...`, provenance `fecd4474...`. The local initial commit remains pending; GitHub push is blocked by noninteractive `mssteve` authentication.

📌 Team update (2026-09-19T09:56:19.057-07:00): `feature/live-mic-monitor` is source-approved but explicitly unpackageable in this consolidation; any future release must preserve APPX microphone capability verification and run the full Windows release workflow.

- 2026-09-20 Karaoke Studio 0.3.4 release candidate: verified clean
  `feature/live-mic-monitor` at `e54d5ee97e96010c58e890c0aa68737ee9799998`,
  selected monotonic package 0.3.4 / APPX 0.3.4.0, and ran the exclusive canonical
  workflow. NSIS and APPX were built sequentially from one clean build with publishing
  disabled. Source provenance covers 82 files with aggregate
  `8495bf0c21d4dbb0aff02f2d8a2620a0227e0a2a3715fc8aaa468cd645b64b81`
  and zero missing, extra, or mismatched entries.
- Final candidate hashes: NSIS
  `e9f4775c3c4f5cbb99012ac21714f1b11abc0636f18cda6ec4c326f14c61368f`;
  APPX `c61596c29a0306bb83b65311dcfb6682a28ee9e8b82826b9292ffc1252778a37`;
  provenance `aace0887a8b70aed429a80d1f4c0f3e51a6ee2acc9ec453c4037c34be9bd0b5f`.
  Nine fail-closed scan scopes checked 22,958 files / 8,141,095,372 bytes with zero
  findings.
- Package-backed QA passed microphone 51/51, installed default-device 25/25 at safe
  low gain, rendered microphone UI, permission/device-ended recovery evidence,
  processing/retry 6/6 with 113 assertions, rendered processing 10/10, timing 33/33,
  Queue/History 8/8, Demucs 4/4, and automation isolation 2/2. The package preserves
  sandbox/context isolation, default-disabled private automation, direct renderer-only
  Web Audio monitoring, and no microphone recording/persistence/network path.
- APPX is x64, version 0.3.4.0, with exactly `runFullTrust` and `microphone` capabilities
  plus all required assets. Both artifacts are unsigned; placeholder identity
  `KaraokeStudio` / publisher `CN=ms` blocks Store submission. No signing, submission,
  merge, push, or commit occurred.

📌 Team update (2026-09-20T08:12:45-07:00): Product source changed during the
inaudible-microphone investigation. The current 0.3.4 EXE, APPX, hashes, provenance,
and package-backed evidence are invalid and must not be approved or reused. The user
explicitly prohibited packaging/release for this revision.

- 2026-09-20 corrected 0.3.4 replacement candidate: after Tank approved the audibility
  source revision, reran build, microphone 74/74, rendered microphone validation, and
  Queue/History 8/8, then executed the exclusive canonical release workflow. The prior
  `f6662f...` ASAR was replaced by `7965dd...`. New hashes are NSIS
  `78c5ded12345deae386d60ce9a65133887aa2ca2e608d2d90e6423ad6537e31c`,
  APPX `bf0b4b728487ab64d843690a1375e7ddb490840c2f4684ccfe128f894ccafd80`,
  and provenance `89d386cea9259671afe33e881db361c578924a82cb33c4fd30f4d76b518d0f76`.
- Provenance covers 83 inputs with aggregate
  `39510f9f2cf10349b079eb0824d571e67667ddff1575795a777c4ca7c5985515`
  and zero missing/extra/mismatched files. Nine secret-scan scopes checked 22,958
  files / 8,141,120,026 bytes with zero findings.
- Package-backed microphone evidence captured a running 48 kHz context, live enabled
  unmuted track, default sink, unmuted/audible web contents, dedicated gain 0.35, and
  nonzero pre/post signal at song volume zero. Music simultaneously remained playing
  while the microphone graph reached the destination. Twenty-five toggle cycles,
  reload cleanup, close cleanup, permission/device-ended simulations, and zero renderer
  errors passed. This is objective path evidence only, not a physical-audibility claim.
- Package regressions passed Queue/History 8/8, processing failure/retry 6/6 with 113
  assertions, rendered processing 10/10, timing 33/33, Demucs 4/4, default-off
  automation, QA-hook denial, and approved private-source integrity with zero
  differences. APPX 0.3.4.0 is x64 with exactly `runFullTrust` and `microphone`.
- Candidate remains **HOLD FOR TANK REVIEW / BLOCK STORE SUBMISSION**. It was not
  signed, submitted, committed, pushed, or installed for use. Placeholder Partner
  Center identity/publisher and unsigned artifacts remain blockers.

- 2026-09-20 Trinity invalidation notice: do not package, install, release, approve, or
  reuse any 0.3.4 EXE, APPX, ASAR, hash, provenance, or package-backed evidence. The
  fixed 0.35 monitor was replaced by a session-only adjustable 0–4 control with a 2.0
  default, live GainNode updates, mute-at-zero, independent song volume, and clipping
  diagnostics. Current work is source/QA only under Steve's explicit no-release order.

- 2026-09-20 final adjustable-monitor 0.3.4 release: after Tank's fresh source approval,
  ran the exclusive canonical workflow and replaced every invalid 0.3.4 candidate. The
  final NSIS SHA-256 is
  `c02065bca43d6d3f41a56760a9a38ee59b9c6329ab24b57a27c12fa1554ee59e`;
  final APPX SHA-256 is
  `5bab9405d93bb2a8773948926a202ee30d09e9c1598399d6dcd4c845297a1551`;
  provenance SHA-256 is
  `45bb836bfa8fbbfb7118d3404225066fa5d173e0f9be8d4cf7339ea85c378d00`.
  Provenance recorded 83 source files, aggregate
  `dac4a71eab0027b4ccc0c6d86c45897bfe548b3b02a089e5747585e2c94d1917`,
  zero source differences, and zero secret findings across nine scopes.
- Exact APPX/staging comparison matched 553/553 files with no missing, extra, or
  mismatched payload and common ASAR
  `92d31eadb3ad5a7fffdb6816de0aabf6a9b43863a1e595da2dbf80a4baef0073`.
  Tank approved package QA: microphone 95/95 and real 0/1/2/4 ratios, Queue 8/8,
  retry 6/6/113, rendered processing 10/10, timing 33/33, Demucs 4/4, automation
  isolation 3/3, and private sources 16/16 unchanged. APPX is x64 0.3.4.0 with exactly
  `runFullTrust` and `microphone`.
- Final verdict:
  `scripts/qa-artifacts/release-0.3.4-final-approved/release-verdict.json`. Both
  artifacts are unsigned and `KaraokeStudio` / `CN=ms` remains a Store blocker. No
  signing, submission, user installation, commit, merge, or push occurred.

📌 Team update (2026-09-20T10:27:28.056-07:00): The final approved 0.3.4 package was installed successfully with library, playlists, and processed data preserved. Live music+mic ratio was approximately 2 and cleanup passed; normal app PID 26988 remains running with Mic OFF and automation disabled. Final provenance is `45bb836b...`; Store remains blocked.
