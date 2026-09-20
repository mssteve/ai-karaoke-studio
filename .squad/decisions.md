# Squad Decisions

## Active Decisions

### 2026-09-20T10:12:08-07:00: Final adjustable microphone 0.3.4 package approved

**By:** Tank, Switch

**What:** Supersede every earlier 0.3.4 binary, hash, provenance file, and package
verdict with the clean adjustable-monitor release built from Tank's approved source.
The only final artifacts are `release/Karaoke Studio-Setup-0.3.4.exe`
(`c02065bca43d6d3f41a56760a9a38ee59b9c6329ab24b57a27c12fa1554ee59e`) and
`release/Karaoke Studio-Setup-0.3.4.appx`
(`5bab9405d93bb2a8773948926a202ee30d09e9c1598399d6dcd4c845297a1551`).
The authoritative provenance SHA-256 is
`45bb836bfa8fbbfb7118d3404225066fa5d173e0f9be8d4cf7339ea85c378d00`.
Tank independently reviewed the package-backed evidence and approved it with no QA
blocker. The authoritative verdict is
`scripts/qa-artifacts/release-0.3.4-final-approved/release-verdict.json`.

**Why:** The canonical workflow built both targets from one clean build and recorded 83
source entries with aggregate
`dac4a71eab0027b4ccc0c6d86c45897bfe548b3b02a089e5747585e2c94d1917`, zero source
differences, and zero secret findings across nine scopes. Exact staging and APPX
payload comparison matched 553/553 files and ASAR
`92d31eadb3ad5a7fffdb6816de0aabf6a9b43863a1e595da2dbf80a4baef0073`.
Package QA passed microphone 95/95 plus real 0/1/2/4 gain ratios, rendered meters and
diagnostics, 25 cleanup cycles, permission/device recovery, Queue 8/8, processing retry
6/6 with 113 assertions, rendered processing 10/10, timing 33/33, Demucs 4/4,
automation isolation 3/3, and private sources 16/16 unchanged. APPX is x64 0.3.4.0
with exactly `runFullTrust` and `microphone`. Store submission remains blocked by
placeholder `KaraokeStudio` / `CN=ms` identity and unsigned artifacts.

The final approved package was installed successfully without losing the existing
library, playlists, or processed data. Installed validation observed simultaneous
music and microphone output at an approximate ratio of 2, followed by successful
cleanup. The normal app remains running as PID 26988 with Mic OFF and automation
disabled. Nothing was signed, submitted, committed, merged, or pushed, and the normal
app must not be stopped.

This final adjustable implementation supersedes both rejected microphone packages:
the original player-volume-scaled `playerVolume * 0.25` monitor was inaudible at low
music volume, and the later fixed 0.35 monitor remained too conservative for the
actual microphone. The canonical implementation uses an independent 0–400% level in
5% steps, defaults to 200% (+6 dB), exposes analyser meters, diagnostics, and clipping
warnings, and preserves a direct graph with no latency-adding processing while music
volume remains independent.

### 2026-09-20T09:37:07-07:00: Adjustable microphone monitor source approval

**By:** Tank

**What:** Independently approve the adjustable microphone monitor source for release
rebuild and installation. Fresh validation passed the production build, all 95
deterministic microphone checks, rendered CDP validation, Queue/History 8/8, and a
real-device matrix at 0%, 100%, 200%, and 400% monitor levels with song volume at both
0 and 82%. The measured post/input peak ratios were 0, 1.000, 1.997–2.000, and
4.013; level zero remained Live with output at or below 0.000007, all nonzero levels
produced nonzero output, and no tested phase clipped. A separate fresh default-level
window measured input/output peaks 0.002930/0.005859 (ratio 2.0), approximately
-44.6 dBFS output and 12.3 dB above the rejected 0.35-gain result.

The context was running at 48 kHz with a live, enabled, unmuted 48 kHz track, DSP off,
the system-default sink, 10 ms base plus 40 ms output latency, and concurrent music
playback. Twenty-five on/off cycles, permission-denial retry, synthetic track-ended
retry, pagehide, reload, and process-close cleanup passed with zero renderer errors.
Only aggregate analyser telemetry was observed; no audio was recorded or persisted.

**Why:** Source inspection confirms the minimal
`source → input analyser → bounded gain → output analyser → destination` graph, immediate
updates on the existing GainNode, independent song volume, explicit mute at zero, and
accessible meters, dBFS, no-input, output-route, too-hot, and clipping diagnostics.
Analyser nodes add no buffering stage or limiter; the displayed 50 ms is an output-side
API estimate, not measured physical round-trip latency. Physical audibility, wired
headphone identity, physical unplug, and acoustic feedback were not claimed. All older
0.3.4 packages, hashes, provenance, and QA artifacts remain invalid; a fresh release
rebuild/install is required.

### 2026-09-20T09:36:00-07:00: Adjustable independent microphone monitor level

**By:** Trinity

**What:** The fixed 0.35 monitor attenuation is replaced by a renderer-local
`Mic monitor level` from 0.0–4.0 in 0.05 steps, defaulting to 2.0 (+6.0 dB).
The value updates the existing `GainNode` immediately without rebuilding the stream or
`AudioContext`; it is independent of song volume and is session-only because the
renderer has no established local-settings persistence convention. Level zero keeps
the microphone Live while intentionally muting monitor output. The minimal graph remains
`getUserMedia → input analyser → bounded GainNode → output analyser → destination`.
No compressor was added, so there is no additional look-ahead latency. Output ≥0.85
full scale is marked too hot and ≥0.98 is marked clipping; high-boost UI warns about
feedback and requires wired headphones for physical acceptance.

**Why:** Package telemetry measured approximately 0.004 RMS/peak input and only 0.0014
post-gain at 0.35, making the approved replacement likely inaudible. A 2.0 default
produced 0.007747 RMS / 0.007843 peak in fresh default-device telemetry, over five times
the rejected output, while the bounded 4.0 check remained far below clipping. The
0.3.4 EXE, APPX, hashes, provenance, and all prior package approvals are invalidated.
This revision must not be packaged, installed, released, committed, or pushed.

### 2026-09-19T09:56:19.057-07:00: Experimental live microphone monitor architecture and source approval (consolidated)

**By:** Morpheus, Trinity, Tank

**What:** The `feature/live-mic-monitor` experiment uses renderer-owned Web Audio:
`getUserMedia` → `MediaStreamAudioSourceNode` → `GainNode` →
`AudioContext.destination`, with `latencyHint: 'interactive'`. AudioWorklet is
unnecessary for passthrough, and native WASAPI is deferred unless representative wired
loopback measurements show that Chromium cannot meet the experimental target. The
accessible Mic toggle sits beside Volume and exposes off, requesting, active, and
retryable-error states, a wired-headphone/Bluetooth warning, and an explicitly
output-only latency estimate. Monitor gain follows player volume with a 0.25 cap.

Microphone audio remains renderer-only: no recording, persistence, sample-bearing IPC,
AI path, or networking. Electron permissions default deny and allow only top-level,
audio-only media requests from the main `webContents` at `karaoke://app`; APPX declares
the microphone device capability. Source validation is approved after a clean build,
microphone QA 51/51, rendered CDP validation, Queue/History 8/8, and zero renderer
errors. Real-device testing passed 25/25 toggle cycles at 48 kHz, two channels, DSP
off, 10 ms `baseLatency`, 32 ms `outputLatency`, and a displayed 42 ms estimate, with
cleanup after off, pagehide, reload, and close.

This remains an unreleased experimental branch. Testing began muted and used about
0.01 monitor gain; no safe speaker-monitoring claim is made. No Bluetooth or
headphone-named endpoint was detected. Physical wired round-trip latency and physical
device unplug remain manual gaps; wired headphones are recommended and Bluetooth is
excluded from acceptance.

**Why:** Direct Web Audio preserves the sandboxed architecture and minimizes latency,
dependency, packaging, and lifecycle risk while providing sufficient gain control and
telemetry. The measured API values describe only the output-side estimate, not physical
microphone-to-output latency, so source approval must not be represented as release
approval or as proof of safe low-latency speaker monitoring.

### 2026-09-19T02:52:27.047-07:00: Deterministic lyric timestamp normalization and fallback (consolidated)

**By:** Steve, Morpheus, Neo, Tank

**What:** Classify nonempty Whisper fragments before ordering, stable-sort valid timing
by start, end, and original index, and repair overlaps against chronological boundaries.
Malformed Unicode text is never discarded: associate it with the preceding valid input
fragment, place it at that boundary, or anchor it at zero when none exists. Consecutive
fallback text divides available gaps into intervals of at least 40ms; when space is
insufficient, merge text deterministically into an available or adjacent valid line.
Only globally unusable timelines—empty output, invalid duration, or no constructible
40ms interval—fail. Persist independent counts for sorting, overlap repair,
invalid-duration expansion, fallback placement, merging, and discard.

Transcription and timed lyrics remain separately retryable from audio outputs. Tank's
independent re-review approved the final behavior after timing 33, rendered UI 9/9,
runtime recovery 6/6 with 110 assertions, and Queue/History 8/8. The installed
`76.76–101.72` / `80.38–85.78` case now normalizes to `76.76–80.38` followed by
`80.38–85.78`; 30ms and 39ms expand while exactly 40ms remains unchanged.

**Why:** One malformed or broad timestamp must not suppress later valid lyrics or fail
otherwise usable processing. Deterministic bounded recovery preserves all lyric text,
keeps synchronization degradation explicit, and maintains valid monotonic,
non-overlapping output without inventing sub-minimum timing.

### Whisper timed transcription

**What:** Whisper transcription uses `onnx-community/whisper-small_timestamped`.

**Why:** Karaoke timing requires word-level timestamps, and the non-timestamped ONNX export lacks the required cross-attention outputs.

### Transcription audio contract

**What:** The transcription subprocess accepts only 16 kHz mono 16-bit PCM WAV and decodes it locally before inference.

**Why:** This matches the main-process FFmpeg contract, avoids browser-only audio APIs, and provides explicit format failures.

### Complete Demucs output

**What:** Demucs processing requires all four named stems before downstream mixing; partial output fails separation.

**Why:** An incomplete stem set cannot safely produce the instrumental, vocal, or enhanced listening outputs.

### Listening output sample rate

**What:** Produced vocal audio is pinned to 44.1 kHz, matching source separation and instrumental/remix outputs.

**Why:** Explicitly setting the output rate prevents FFmpeg filters from producing inconsistent 96 kHz vocal output.

### 2026-09-17T17:23:31.480-07:00: Secure packaged runtime and isolated Windows release (consolidated)

**By:** Neo, Switch

**What:** Production content loads privately from `karaoke://app/` with context isolation, sandboxing, disabled Node integration, relative assets, and restrictive CSP. The preload contract is `dist-electron/preload.cjs`, and release verification must read the main, preload, automation, and renderer entries from packaged ASARs. Releases run only through the exclusive, clean, provenance-locked `npm run release` workflow, using one build for NSIS and APPX with publishing disabled and source/output hash checks. Automation uses newline-framed request/response over the private Windows named pipe, is disabled in packaged launches by default, and is enabled only by `--enable-private-automation`. No HTTP server or listening network port exists.

**Why:** These constraints prevent stale or concurrently corrupted artifacts, preserve the hardened renderer boundary, ensure every automation command returns a parseable result, and keep release-only mutation and screenshot controls inaccessible during normal packaged use.

### 2026-09-17T17:23:31.480-07:00: Final Windows release approval

**By:** Neo, Trinity, Morpheus, Tank, Switch

**What:** The isolated NSIS and APPX release is approved. Neo's final integration review approved after initial and Sprint 2 rejections were resolved. Tank independently approved 26/26 gates, and the full packaged harness approved 22/22 cases with no skips. Required evidence is `release/provenance.json`, `release/SHA256SUMS.txt`, and `scripts/qa-artifacts/sprint-3-final-approved/report.json` plus its screenshots. The approved EXE SHA-256 is `7ed042ab544c26b54409d52be7f6e0bc64fe4d68ec81c2c54a9e2af7dc093943`; the approved APPX SHA-256 is `1223aec17eab496ad8605d9326e911ec8206b78ceb210f2ebea56b3908388410`.

**Why:** Packaged QA proved the real rendered Add Songs path and Windows common file dialog, library persistence and controls, MP3/MP4 import, Demucs outputs, Whisper timed lyrics, all four playback modes, default-disabled/explicitly-enabled private automation, zero listening TCP endpoints, provenance, and artifact hashes.

### 2026-09-17T21:23:57.955-07:00: Seamless playback-mode switching release

**By:** Trinity, Neo, Tank, Switch

**What:** Playback-mode changes preserve a logical timeline rather than merely copying the outgoing media element timestamp. Playing switches carry a wall-clock anchor through replacement-source loading and enforce a clamped resume target until the new media clock reaches it; paused switches preserve the captured timestamp exactly. Near-end switches clamp to the replacement duration, and rapid requests resolve to the final requested mode. Reviewer lockout was enforced after Trinity's initial implementation failed continuity with a 0.70s→0.20s backward jump; Neo independently revised the timeline handling before Tank re-reviewed and approved 5/5. Official NSIS and APPX packages were then rebuilt sequentially from one clean build and passed focused packaged QA 5/5.

**Why:** The approved behavior keeps playing deltas within -0.12s..+0.45s, preserves 1.60s exactly while paused across all modes, clamps 6.80s to a 3.00s replacement, ends rapid switching in vocal mode, and exposes zero listening TCP endpoints. Canonical evidence is `scripts/qa-artifacts/mode-switching-packaged-approved-2026-09-17/report.json`. Approved SHA-256 hashes are NSIS `edecc067b9122c6898d8c961b2a0f862402ea7c777c103e4ae6f92bfc7465b4b` and APPX `eea9ad3cc8340e1ff07dbf55ef2daa1d0e7a9aff3842366dc78a7fe5cdd99280`.

### 2026-09-17T22:55:03.579-07:00: Installed Demucs dependency unpacking and replacement release

**By:** Switch, Tank, Morpheus

**What:** Any dependency loaded by unpacked Demucs code must be unpacked with it. The release configuration now explicitly unpacks `mediabunny` and `@mediabunny/mp3-encoder`, fixing the installed-app `ERR_MODULE_NOT_FOUND` raised from unpacked `demucs/dist/mp3-encoder.js` when those dependencies remained inside ASAR. Switch rebuilt the official NSIS and APPX. Tank independently ran the installed-path Electron-as-Node Demucs regression outside project ancestors and validated all four stems. Morpheus validated an authorized real song end to end against the fresh packaged app without changing audio code.

**Why:** Electron module resolution cannot reliably cross from unpacked Demucs code into dependencies retained inside ASAR. The replacement packages are approved by installed-path evidence at `scripts/qa-artifacts/installed-demucs-current-hashes-approved-2026-09-17/report.json` and the real-song run: processing completed in 176.34s, produced four stems plus 169.79s instrumental/vocal/enhanced outputs and 13 timed lyric lines, and loaded all four modes after restart while leaving the source untouched. These hashes supersede the prior artifacts: NSIS `9929d547d0b471379061c62ae2e1275311c0ea9927efb6dbf20e029332e89145`; APPX `5cc93034536fc622d9a9888cee7fbae182a5f9be72ba9fcbd9a7bc9c93b8a675`.

### 2026-09-18T09:32:50.972-07:00: Playlist, original-language lyrics, and deterministic playback contract (consolidated)

**By:** Neo, Trinity, Morpheus, Cypher, Switch

**What:** Karaoke Studio 0.3.0 removes AI Studio and retains Library and Playlists navigation. Song rows expose non-selecting Add to playlist menus. Electron persists a schema-versioned `playlists.json` with one immutable default Queue, named playlists, stable entry identities, duplicate-safe insertion order, and a cursor independent of song identity. Every direct song or playlist-entry change starts at 0:00 in Original mode. Natural media `ended` advances exactly once to the next surviving FIFO entry and auto-plays from 0:00; the final entry remains selected at duration in terminal `ended` state without wrapping or deletion. Mode carry is allowed only during automatic advance and falls back visibly to Original when unavailable.

Lyrics are always bound to the selected song and recomputed immediately after forward or backward seek. Whisper detects language from language-token logits, explicitly retranscribes in that language, preserves Unicode, and persists normalized `languageCode`, user-facing `languageName`, and `languageSource`. Legacy processed songs retranscribe from existing vocal output without rerunning Demucs or mutating imported sources. Replacement-source playback applies its position at `canplay`, waits for seek settlement, binds resume/autoplay to the exact source generation, and reports playing only after media playback starts.

**Why:** Entry identity rather than song identity permits duplicates while preserving deterministic FIFO and removal behavior. Genuine media `ended`, guarded by song, entry, and playback generation, prevents skipped or double advances and distinguishes natural completion from pause, manual seek, error, or library selection. Source-bound seek settlement eliminates delayed-canplay, rapid-switch, and autoplay races. Explicit Whisper language selection avoids Transformers.js defaulting multilingual audio to English and preserves original-script timed lyrics.

### 2026-09-18T09:32:50.972-07:00: Strict playback and retranscription acceptance (consolidated)

**By:** Cypher, Apoc, Tank

**What:** Playback QA uses the media element's actual reported duration and a duration-derived 0.5–2.0 second terminal runway. Evidence records requested and observed seek targets, replacement clamping, source generation, readiness/network state, play intent, pending seek, mode, and ordered media/controller events. A near-end pass requires terminal `ended` at duration with `paused=true` and both media and controller playing intent false; merely observing `playing` is insufficient. Renderer errors are read through process-scoped diagnostics rather than intentionally querying an absent selector. The QA CLI maps retranscription requests to the real `songId` and gives local-AI work the one-hour processing timeout.

**Why:** Earlier long-song runs timed out because the harness omitted its intended near-end seek, while a later revision could pass at a nonterminal playing state and generated renderer exceptions during an absence check. A short fixture also left an unobservable millisecond-scale runway, and the retranscription adapter omitted its required identifier and timed out at 30 seconds. Actual-duration terminal assertions and correct command wiring separate product behavior from harness races.

### 2026-09-18T09:32:50.972-07:00: Karaoke Studio 0.3.0 final approval

**By:** Neo, Trinity, Morpheus, Tank, Switch, Cypher, Apoc

**What:** Karaoke Studio 0.3.0 is approved. Reviewer lockouts remained enforced across rejected revisions; Cypher and Apoc were added as independent playback-reliability and test-integrity authors to break the playback/acceptance deadlocks. Final runtime QA passed strict mode switching 5/5 in five consecutive runs, playlist/language 16/16, real retranscription 6/6, and installed Demucs 4/4, with zero renderer errors, zero listening TCP endpoints, unchanged imported sources, and packaged automation disabled by default.

The approved NSIS is `release/Karaoke Studio-Setup-0.3.0.exe`, SHA-256 `b382db3978a19c1cb2562010ff72ae995de1b6c2d92b7ce0d3a9b0a14b92d89a`. The approved APPX is `release/Karaoke Studio-Setup-0.3.0.appx`, SHA-256 `579e33fdd0c0e83d66e4c8ed44b9e6ca998a7a53d42cee2637202341112a9382`. `release/provenance.json` tracks all 47 entries with zero missing, extra, or mismatched files and aggregate SHA-256 `8f2455146a918ebb8e0ce0737183777316c05e0f290cf4a63a66fe8efdc8b6b0`.

**Why:** The two processed-song runtime established playable modes, rapid switching, play/pause, progress seek, synchronized lyrics, and 0:00 song reset. Final evidence proves duplicate-safe persistent FIFO, exactly-once auto-advance, terminal final-entry behavior, original-language Unicode persistence, source immutability, installed AI processing, private default-off automation, binary identity, and complete provenance. The earlier Switch candidate rejection and Tank provenance-only rejection are superseded by corrected QA integrity/CLI metadata and the refreshed zero-mismatch provenance manifest; product binaries did not require rebuilding.

### 2026-09-18T13:57:36.118-07:00: Protected Queue History boundary and acceptance

**By:** Neo, Tank

**What:** Ordinary `addSongToPlaylist` requests must reject History-kind playlists in the Electron main process; renderer filtering is not an authorization boundary. Only the atomic Queue archival operation may insert History entries. Neo's boundary revision is approved after a fresh build and focused rendered/private-pipe QA passed 8/8, covering migration, plus-menu visibility, Queue/user-playlist insertion, natural completion, manual Next, newest-first History, navigation, restart persistence, and zero renderer errors.

**Why:** History is a protected record of completed Queue entries and must not be writable through direct preload/IPC calls. Main-process enforcement preserves that invariant while retaining supported Queue and user-playlist behavior. Canonical evidence is `scripts/qa-artifacts/queue-history-focused-2026-09-18/report.json` with `plus-menu-rendered.png` and `history-navigation.png`. Hostile arbitrary IPC invocation remains static/build-time evidence because private automation does not expose it; exceptionally long rendered-menu scrolling remains a manual-only check.

### 2026-09-18T14:19:38.738-07:00: Canonical Queue/History validation skill (consolidated directive)

**By:** Steve, Tank

**What:** `.squad/skills/queue-history-validation/SKILL.md` is the canonical, mandatory default process for future Queue/History and playlist transport validation, including Previous/Next controls, Queue archival, History protection and persistence, and playlist plus-menu behavior. The skill must remain detailed and directly reproducible rather than becoming a summary. Its stable entry point is `scripts/qa-queue-history-run.ps1`, backed by `scripts/qa-queue-history.mjs`; future agents must read and apply the skill before approving relevant changes.

**Why:** Steve explicitly required the proven end-to-end procedure to be reusable without relying on retained evidence or live user data. Tank verified the canonical no-seed flow by deleting generated seed data, regenerating local fixtures and an isolated profile, building, and passing all 8/8 checks with rendered screenshots, restart persistence, protected-History validation, unchanged fixture hashes, and zero renderer errors. Canonical proof is under `scripts/qa-artifacts/queue-history-canonical-proof/`.

### 2026-09-18T15:07:36.120-07:00: Automatic full Windows release trigger (consolidated directive)

**By:** Steve, Neo, Switch

**What:** Every independently approved user-facing or shipped-runtime change automatically routes to Switch and remains open until the complete Windows release workflow is finished. This includes UI, controls, navigation, playback, persistence, migration, Electron main/preload/IPC/API boundaries, automation, security, AI/media runtime, shipped dependencies, package configuration, manifests, icons, versions, installers, and explicit update/release/package/ship/publish/Store requests. Before any release work, agents must read and follow `.squad\skills\full-windows-store-release\SKILL.md`. The sole official packaging entry is its documented `npm run release -- --approval=<fresh-report>` workflow; `npm run build`, source-only QA, an unpacked app, or a single installer is an intermediate result and never release completion.

After feature-source approval, completion requires fresh versioned NSIS and APPX artifacts from one clean sequential build, hashes, zero-difference provenance, packaged/installed changed-feature QA, default-off private automation, zero renderer errors, applicable restart/persistence checks, and independent package review. Store submission may be claimed only after Partner Center accepts it. Non-shipped team records, documentation, test tooling, rejected revisions, and source-only diagnosis may stop at build/source validation.

**Why:** Queue/History initially stopped after 8/8 source QA because orchestration did not route Switch, while `npm run build` only compiled `dist` and `dist-electron`. The stale 0.3.0 provenance differed from accepted Queue/History inputs. Automatic routing and the canonical skill prevent future validation-only completion and prohibit substituting stale or unrelated evidence.

### 2026-09-18T15:07:36.120-07:00: Karaoke Studio 0.3.1 package approval and Store block

**By:** Switch, Tank

**What:** Karaoke Studio 0.3.1 is approved as a local Windows package release but blocked from Microsoft Store submission. Switch ran the exclusive canonical workflow against the Queue/History 8/8 approval and produced:

- NSIS `release\Karaoke Studio-Setup-0.3.1.exe`, SHA-256 `f76ed3a9b01c68e4c7a84e69f3ee9d752145d58610a421055fa444b634ad288d`.
- APPX `release\Karaoke Studio-Setup-0.3.1.appx`, SHA-256 `cbcc91acc5af14d23c6b41d5b862f35042533bdd383f433fe124de5265c32a6b`.
- Provenance covering 50 tracked files with zero missing, extra, or mismatched entries and aggregate SHA-256 `7e49bbc60c68c4c535890d572bce32bcdfd5ce57b1758963a68c557e673d52cf`.

Tank independently returned **APPROVE PACKAGE / BLOCK STORE SUBMISSION**. Installed packaged Queue/History QA passed 8/8 with rendered evidence, migration and History protection, natural-end and manual-Next archival, newest-first History, navigation, restart persistence, default-off automation, and zero renderer errors. Installed NSIS and APPX payloads matched provenance; APPX structure passed at 0.3.1.0, x64, Windows.Desktop full trust, with required assets. Canonical reviewer evidence is `scripts\qa-artifacts\queue-history-packaged-0.3.1-tank-2026-09-18\`.

Store submission did not occur. The APPX still uses placeholder Partner Center identity `KaraokeStudio` and publisher `CN=ms`, and both artifacts are unsigned. The reserved Partner Center identity and signing configuration must be supplied, followed by a fresh complete canonical release, before upload.

**Why:** The exact packages, hashes, contents, runtime behavior, and provenance passed independent review, but placeholder identity and absent signatures prevent a truthful or valid Store-submission claim.

### 2026-09-18T15:33:38.954-07:00: Safe initial Git repository setup

**By:** Switch, Tank

**What:** `C:\git\karaoke-player` is initialized as a Git repository on unborn branch `main`. No initial commit, staging/index entries, remotes, or tags were created. `.gitignore` excludes dependencies, generated builds and releases, QA evidence and profiles, caches, logs, environment files and credentials, signing material, local AI models and runtimes, editor/OS files, and local Squad runtime state while retaining required source, safe environment examples, canonical skills, decisions, and agent records. `.gitattributes` applies union merges to append-only team records, normalizes source/configuration line endings, preserves CRLF for Windows scripts, and marks shipped binary/media/signing formats as binary.

The first commit remains intentionally unmade. Before creating it, selectively stage and review the exact prospective file list and staged diff, do not force-add ignored private/generated artifacts, and preserve the unborn `main` state until intentional initialization. After the first stable commit, create the development branch with `git switch -c dev`.

**Why:** Tank independently approved the setup with zero staged files, commits, remotes, or tags; 175 prospective initial files; 60/60 private/generated ignore checks; 2/2 safe environment examples visible; 20/20 required-path checks; zero unsafe or greater-than-1-MiB prospective files; and correct union-merge, normalization, and binary rules. This establishes safe repository boundaries without exceeding Steve's setup-only request.

### 2026-09-18T20:04:53.087-07:00: Processing progress, resumability, resource bounds, Enhanced balance, and UX acceptance (consolidated)

**By:** Steve, Morpheus, Cypher, Trinity, Neo, Tank

**What:** Local-AI processing exposes schema-versioned, persisted component progress and deliverable outcomes for source preparation, Demucs and all four stems, listening outputs, Whisper, timed lyrics, and final library persistence. Compatibility stage/progress/message fields remain. Measurable work uses real FFmpeg, Demucs, model-load, validation, and output signals; inherently unobservable Whisper inference is indeterminate with elapsed time. Overall progress is monotonic only within one `startedAt` run and cannot reach 100% before validated artifacts, lyrics, metadata, and `library.json` are durably saved.

Component recovery is dependency-aware and minimal. Valid playable modes remain available after sibling failures; failed components retain exact typed attribution and blocked dependents name their prerequisites. Lyrics retry reuses valid Vocal, Enhanced retry reuses valid Instrumental/Vocal, invalid stems rerun Demucs and affected descendants, and final `library-save` failure retries persistence without repeating successful media work. Disk validation, not metadata alone, establishes readiness after restart. Renderer retries are per component, locally coalesced, and remain disabled while queued or active.

All full, lyrics, and targeted retry work shares exactly one process-wide FIFO song pipeline. A second song starts only after terminal success or failure, duplicate requests for the same song share the existing work, and restart converts interrupted queued/active state to a retryable interruption. Each pipeline uses at most `max(1, floor(available logical cores / 2))`; FFmpeg, Demucs, Whisper, ONNX Runtime, OpenMP, and BLAS receive the supported thread limits. ONNX GPU percentage quotas are not enforceable, so processing remains serial and CPU-provider-bound and diagnostics must not claim a 50% GPU cap.

Enhanced alone uses measured EBU R128 auto-balancing: Vocal targets -20 LUFS, Instrumental -23 LUFS, gains are clamped to ±6 dB and -3 dBTP input headroom, and normal program output targets -16 LUFS / -1.5 dBTP with conservative limiting. Near-silent material is not boosted; noisy Instrumental cleanup is mild and measurement-gated. Original, Instrumental, and Vocal are not replaced by this step. Metrics, gains, filters, cleanup decisions, final measurements, and caveats are persisted, and UI copy says “auto-balanced” without implying source restoration.

The renderer presents backend states directly in a compact scroll-bounded checklist, keeps ready modes playable, disables only unavailable modes with accessible reasons, and keeps lyrics failure/retry within the lyrics panel. Library single click selects and pauses at 0:00 in Original; double click selects, restarts at exactly 0:00 in Original, and plays, including an already selected row. Nested controls suppress double-click propagation.

Neo's revision is approved. Fresh validation passed all seven focused processing suites, rendered processing UI 9/9, runtime failure/restart 5/5 with 90 assertions, Queue/History 8/8, and exact minimal retry/resource/restart behavior. Destructive failure controls require both private automation and the separate private QA-hooks flag and are unavailable in normal release launches.

**Why:** Static progress markers, whole-song failure, unconditional rebuilds, and unbounded concurrent Demucs/Whisper jobs hid healthy work, wasted valid outputs, and saturated the machine. Durable component outcomes, truthful progress, minimal retries, conservative measured mixing, and a serial half-core CPU policy provide deterministic recovery and usable partial results without making unsupported GPU or restoration claims.

### 2026-09-18T20:04:53.087-07:00: Karaoke Studio 0.3.2 secret-safe package approval and Store block

**By:** Neo, Tank, Switch

**What:** The first 0.3.2 candidate is rejected and superseded because broad dependency unpacking shipped a dependency `.env`; Git ignore rules are not a packaging boundary. The approved replacement excludes secret/development material at the electron-builder layer while retaining required FFmpeg, Demucs, Whisper/Transformers, and Windows x64 ONNX Runtime payloads. The canonical release scan fails closed across nine complete package scopes, reports only paths and SHA-256 values, and found zero issues across 24,697 entries, 22,939 files, 21,030 text-like files, and 8,140,773,108 bytes. The local dependency `.env` remains Git-ignored and is absent from all shipped views; its value was not read or tested.

The final approved artifacts are:

- NSIS `release\Karaoke Studio-Setup-0.3.2.exe`, SHA-256 `da92c3aa353e1bafcff25e02775ab52396e8becfdd5f3f1c1b71ad5ffa27e28b`.
- APPX `release\Karaoke Studio-Setup-0.3.2.appx`, SHA-256 `a6b43fb07778a9d05c7cfa3501452304d10756b47e29493888456c03a612f491`.
- `release\provenance.json`, SHA-256 `42a683ae733b4ff87ab466c29506641e42c8eb5b69b2bb9e3a0b346de55a7c45`.
- Source provenance: 69 files, aggregate SHA-256 `33fdc1c947c5d10dc4cfe5e238c9e7ff128e199074d1de0f6e4d799939fa414b`, with zero missing, extra, or mismatched files.

Tank independently returned **APPROVE PACKAGE / BLOCK STORE SUBMISSION**. Package-backed QA passed seven focused processing suites, rendered UI 9/9, runtime recovery 5/5 with 90 assertions, Queue/History 8/8, installed Demucs 4/4, and automation isolation 3/3. All provenance build outputs matched the NSIS install, APPX staging, and extracted APPX payloads; imported sources and retained evidence were unchanged. Canonical evidence is `scripts\qa-artifacts\processing-packaged-0.3.2-neo-revision\revision-verdict.json` and `scripts\qa-artifacts\processing-packaged-0.3.2-tank-rereview\tank-verdict.json`.

Store submission did not occur. APPX identity `KaraokeStudio` and publisher `CN=ms` remain placeholders, and both artifacts are unsigned. The reserved Partner Center identity and signing configuration require a fresh complete canonical release before upload. Potentially live material in the locally ignored dependency `.env` should be rotated or revoked externally without reading or logging its value.

**Why:** Functional package success is insufficient when dependency traversal can include private files. The replacement binds the approved runtime to complete package-scope secret scanning, independent hashes, zero-difference provenance, installed behavior, and explicit external Store blockers.

### 2026-09-18T20:04:53.087-07:00: Pending initial GitHub publication directive

**By:** Steve

**What:** After the repository and current work are organized, validated, selectively staged, and committed on `main`, Switch must add `https://github.com/mssteve/ai-karaoke-studio.git` as `origin`, ensure the publication branch is `main`, and push it with upstream tracking. Scribe must not commit or push during decision consolidation.

**Why:** The user requested publication only after the initial repository contents and safety boundaries are complete and reviewed. The remote operation remains pending for Switch rather than being mixed into documentation consolidation.

### 2026-09-19T02:52:27.047-07:00: Validated Demucs inference boundary and acceptance (consolidated)

**By:** Apoc, Tank

**What:** The application must construct the installed `ONNXHTDemucs` model with its JavaScript class fields initialized, then attach the CPU-capped ONNX session. Every inference validates session names and both model outputs for presence, rank, compatible shape prefix, and data length before Demucs split code may dereference them. Failures carry safe stage/name/shape context, release the session and single FIFO slot, publish no partial stems, persist as retryable `demucs` separation failures, and preserve already valid Original or listening outputs. Short inputs and trailing splits are padded and trimmed only through the dependency's deterministic path and must preserve exact audio frame duration.

Tank approved the corrected source/runtime after inference 14/14, contracts 6/6,
resources 24/24, resume 31/31, artifacts 9/9, real short/trailing inference 18/18,
runtime 6/6/110, timing 33/33, and Queue/History 8/8. Real-library acceptance produced
16/16 files and 64/64 valid stems; the fresh packaged subset produced 2/2 and 8/8.

**Why:** The packaged crash was not caused by CPU half-core limits, execution provider,
memory pressure, splitting, or path resolution. `Object.create(ONNXHTDemucs.prototype)`
skipped the model's `sources`, `audioChannels`, `samplerate`, and `segment` fields, so
`applySplits` read `.length` from undefined. Application-local initialization and
validation avoid an untracked vendor edit while producing actionable contract errors.

## Governance

- All meaningful changes require team consensus
- Document architectural decisions here
- Keep history focused on work, decisions focused on direction

### 2026-09-18T21:46:00-07:00: Guarded source-tree launch invariant

**By:** Switch

**What:** The repository-supported local launch command is `npm start`. It must build current source, verify the renderer, Electron main/preload, transcription, and Demucs entries, and only then start Electron using the explicit compiled main path. Direct `electron .` launch is not a supported source-tree entry because the package main is generated output and the clean build intentionally removes it before recompilation. Packaged executable launches remain unchanged.

**Why:** Launching the package root while `dist-electron\main.js` is absent or during a clean-build window produces Electron's “Unable to find Electron app” / missing-module dialog. A guarded local entry makes the dependency explicit without slowing normal packaged launches.

### 2026-09-19T02:52:27.047-07:00: Persisted failure compatibility for targeted retry (consolidated)

**By:** Trinity, Tank

**What:** Renderer issue derivation must merge a song's normalized top-level `processingFailure` whenever its exact component is not already represented by a failed deliverable outcome. This includes stale installed records where terminal Demucs failure is retryable at the top level but the separation outcome remains `missing`. The merged issue exposes the exact component's Try again action; current-schema failures remain deduplicated.

Tank approved source and packaged behavior after a fresh build, processing UI 24/24,
resume 31/31, rendered DOM 10/10, and runtime 6/6 with 113 assertions. A real previously
failed source recovered through the rendered Try again action with one effective job
after duplicate clicks, four decodable duration-exact stems, all modes ready, cleared
failure/scheduler state, restart persistence, and unchanged source hash/timestamp.

**Why:** Installed 0.3.2 persisted real Demucs `model.sources` TypeErrors as terminal
retryable failures while the separation outcome remained `missing`; the renderer hid
them solely because a deliverable store existed. Compatibility rendering restores
recovery across restart while preserving deduplication, per-component validation, and
FIFO scheduling.

### 2026-09-19T02:52:27.047-07:00: Frozen 0.3.3 package approval and Store block (consolidated)

**By:** Steve, Switch, Tank

**What:** Per Steve's version directive, the approved lyric, Demucs, persisted retry,
safe local launch, Queue/History, and processing source is packaged as 0.3.3 / APPX
0.3.3.0. Switch's preliminary 0.3.3 candidates are superseded by the authoritative
frozen candidates approved for package use:
NSIS SHA-256 `04d9c06191ea28fefbdd4cfa5f809aa05ab3b9606dad001ce64cfe801ee9e6f8`,
APPX SHA-256 `fe78e626287096a16111d937c722d70d255bf0ec0749e267a2e66dcacf175a09`,
and provenance SHA-256
`fecd4474affcc053016482b1d4ed2dc56e62ba1412eb12ab313d32b11fac0048`.
Independent review confirmed the 77-file source aggregate
`c5975f34e39fa9ce8306df033bf917815bc4f2018d8bbbcefb8dd2eeb4fcbb5f`
with zero differences, exact packaged build outputs, payload EXE
`68f68cade5eef50593646ae2f205b351a251108587ad0cda6b4c5d62247fe3b5`,
payload ASAR
`ad142508e73179857f11da30f152440c3df56a00014f2eaa180235d5546fa707`,
zero secret findings, all mandatory functional gates, and unchanged authorized private
sources.

The verdict is **APPROVE PACKAGE / BLOCK STORE SUBMISSION**. APPX 0.3.3.0 is x64,
full-trust, readable, and contains all required assets, but its identity
`KaraokeStudio` and publisher `CN=ms` remain placeholders and both NSIS and APPX are
unsigned. QA passed rendered 10/10, runtime 6/6 with 113 assertions, timing 33,
Queue/History 8/8, Demucs 4/4, and zero secret findings. Partner Center
association/configuration and a fresh full release are required before Store
submission. The local initial commit remains pending, and GitHub push remains blocked
by noninteractive `mssteve` authentication. No commit or push occurred.

**Why:** The frozen package is internally consistent and independently validated, but
placeholder Store identity metadata and absent signatures prevent submission.
