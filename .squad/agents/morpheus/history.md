# Morpheus History

## Project Context

Karaoke Studio processes music entirely on-device with FFmpeg, Demucs ONNX, and Whisper ONNX. Requested by Steve.

## Learnings

- A generated two-second MP3 successfully converted to 44.1 kHz stereo separation audio and 16 kHz mono transcription audio with the bundled FFmpeg.
- Demucs 1.0.0 accepts the current CLI invocation and writes `bass.wav`, `drums.wav`, `other.wav`, and `vocals.wav` under an input-basename subdirectory.
- The original Whisper path reader requires a browser `AudioContext` and fails under Node/Electron. Reading the known 16 kHz mono PCM WAV format directly avoids that runtime dependency.
- `onnx-community/whisper-small` does not expose the cross-attention outputs required for word timestamps. The timestamped model variant produced the expected `{ text, lines }` schema with finite start/end times.
- FFmpeg's `loudnorm` filter caused the vocal-only AAC output to default to 96 kHz; explicitly setting 44.1 kHz keeps all listening outputs consistent.
- End-to-end fixture checks produced the original MP3, all four Demucs stems, instrumental mix, enhanced vocal, enhanced remix, and a timed Whisper transcript. Invalid WAV input failed explicitly without creating an output file.
- Final packaged QA confirmed MP3 conversion, all four Demucs stems, distinct instrumental/vocal/enhanced outputs, and three ordered timed Whisper lyric lines through the release executable.

📌 Team update (2026-09-17T17:23:31.480-07:00): Local AI processing and timed lyrics are mandatory release gates and passed in the approved packaged build — decided by Neo, Trinity, Morpheus, Tank, and Switch.

- 2026-09-17 replacement-package validation used the authorized real song `陳奕楠 - 這世界有很多愛你的人.mp3`; the source remained untouched.
- The fresh packaged app completed processing in 176.34s, generated four stems and 169.79s instrumental, vocal, and enhanced outputs, produced 13 timed lyric lines, and loaded original, enhanced, vocal, and instrumental modes after restart.
- No audio code change was required; the failure and fix were limited to ASAR unpacking of Demucs runtime dependencies.

📌 Team update (2026-09-17T22:55:03.579-07:00): Morpheus approved real-song end-to-end behavior on the rebuilt package with all outputs, lyrics, persistence, and modes intact.

- 2026-09-18 original-language validation found Transformers.js 3.8.1 does not implement automatic Whisper language detection and silently defaults multilingual generation to English.
- Transcription now detects the highest-scoring Whisper language token, explicitly performs transcription in that language, preserves Unicode, orders word timestamps before line grouping, rejects invalid line timing, and stores optional language name/code metadata in `lyrics.json`.
- The authorized Chinese `speech.wav` fixture detected `Chinese`/`zh`, produced 24 ordered timed lines containing 262 CJK characters, and retained the identical source SHA-256 before and after.
- Main-process library propagation remains a conflict-safe handoff while Tank reviews `electron/main.ts`: validate optional `language`/`languageCode`, add optional Song metadata fields, assign them from the transcript before `saveLibrary()`, and preserve missing fields when loading older libraries.

- 2026-09-18 third-author playback revision fixed mode-switch drift by capturing the controller's rendered logical position as the authoritative handoff time, rather than rereading an independently advancing media clock during the React mode transition.
- Clean build passed. The unchanged focused mode suite passed 5/5 with playing deltas of +0.20s, +0.40s, +0.10s, and +0.10s; paused switches remained exact; the 6.80s near-end position safely clamped to the 3.00s replacement; rapid switching ended in vocal mode; and the process tree exposed zero TCP listeners.
- The playlist/language regression suite independently remained 16/16, including FIFO exactly-once autoplay, final-entry stopping, 0.00s song resets, seek/lyrics behavior, Chinese Unicode metadata, menus, persistence, unchanged source files, and zero renderer errors.
- Evidence: `scripts/qa-artifacts/mode-switching-morpheus-revision-2026-09-18/report.json` and `scripts/qa-artifacts/playlist-language-morpheus-revision-2026-09-18/report.json`.

📌 Team update (2026-09-18T09:32:50.972-07:00): Original-language metadata and Unicode retranscription are approved in 0.3.0; real retranscription passed 6/6, installed Demucs passed 4/4, and imported sources remained unchanged — decided by Neo, Trinity, Morpheus, Tank, Switch, Cypher, and Apoc.

📌 Team update (2026-09-18T15:07:36.120-07:00): Before release handoff for approved AI, audio, media-runtime, or shipped dependency changes, read `.squad\skills\full-windows-store-release\SKILL.md`. Full installed/package runtime evidence is required; build-only validation cannot close distributable work.

- 2026-09-18 processing-progress investigation confirmed the apparent 5% and 20% stalls were hard-coded stage markers around two blocking FFmpeg conversions and the entire Demucs child process. Subprocess output was buffered only for errors, so neither FFmpeg time nor Demucs `step/total` output reached the renderer. Whisper was similarly represented by a single 75% marker until completion.
- Processing now uses a typed, persisted schema-v1 detail contract with weighted source, Demucs, four-stem, four-listening-mode, Whisper-model, transcription, and lyrics items. Overall progress is monotonic and capped below 100 until output validation, `lyrics.json`, song metadata, and `library.json` are committed.
- FFmpeg reports media-time progress, Demucs reports its real chunk counter and written stems, and Whisper reports model loading plus language-sample completion. Whisper inference remains explicitly indeterminate because Transformers.js does not expose completion callbacks for its internal transcription chunks; elapsed timestamps are available instead of a fabricated rate.
- Deterministic QA in `scripts\qa-processing-progress.mjs` covers monotonicity, late/regressive updates, indeterminate activity, required item coverage, failure retention, and the final commit gate. `npm run build` and `npm run qa:processing-progress` pass.

- 2026-09-18 resumable pipeline work added a durable schema-v1 deliverable store independent of the compatibility progress summary. Every source, stem, listening output, transcription, and lyrics result records ready/missing/failed/blocked state, validated artifact fingerprints, and typed component failures.
- Retry planning is dependency-aware: lyrics retries reuse a valid vocal and run transcription plus finalization; enhanced retries run only enhanced mixing; invalid stems rerun Demucs and affected descendants; source-preparation retries rebuild the full dependent chain.
- Artifact readiness is revalidated from disk at startup and before planning. Legacy entries receive normalized missing states, valid legacy outputs/stems are adopted, stale ready metadata is invalidated, and interrupted queued/active outcomes become explicit retryable failures.
- Generated media and library metadata now use replacement-file commits. Each successful listening output is persisted and published to the renderer immediately, so later failures do not hide playable modes.
- Targeted retries use `retryDeliverable({ songId, component })`, share Cypher's process-wide FIFO, coalesce identical song/component requests, reject a conflicting second component for the same song, and preserve exact queue positions.
- Fresh validation passed: build, processing-progress QA, processing-scheduler QA, and 23 deterministic resumable-pipeline checks.
- 2026-09-18 scheduler/resource clarification fixed the process-wide scheduler invariant at exactly one complete song pipeline; construction with any other concurrency now fails. The next queued song cannot start until the current pipeline returns terminal success or throws terminal failure.
- The per-pipeline CPU cap is `max(1, floor(os.availableParallelism() / 2))`. FFmpeg receives decoder, encoder, filter, and complex-filter thread limits; Demucs now runs through a project-owned worker that creates its ONNX Runtime session with capped intra-op threads, one inter-op thread, sequential execution, and CPU provider; Whisper receives the same supported ONNX session options. BLAS/OpenMP environment caps are propagated to every subprocess.
- ONNX Runtime's available GPU provider configuration exposes device selection but no enforceable percentage allocation. The app therefore keeps local AI on the CPU provider, retains serial scheduling, logs and exposes this limitation through automation diagnostics, and makes no 50% GPU-cap claim.
- No existing old-version processes were inspected, terminated, or modified. Fresh build and all four focused processing suites pass; resource QA covers 23 checks across 1/2/odd/even core calculations and FFmpeg, Demucs, Whisper, ONNX, and environment propagation.
- 2026-09-18 reviewer HOLD remediation moved all processing-domain exports to legal module scope and restored a clean Electron build. Component-ready updates now remain unpublished until their `library.json` checkpoint succeeds; terminal 100% is persisted through an override snapshot before it is applied/published, and a failed final save can downgrade the tracker below 100 and publish the persistence failure.
- Scheduler identity is now the song ID, not `songId:component`. Requests for the same queued/running song share one promise and merge into a dependency-ordered target set inside that song's single terminal pipeline; the global scheduler remains fixed at one.
- Missing Demucs outputs report the exact `stem-*` component. Whisper model-load errors report `whisper-model` while marking the durable transcription outcome failed, and the same target is accepted by the retry API.
- Artifact validation now probes actual decodability through capped FFmpeg rather than relying only on file size. New QA persists a playable partial Vocal result, reloads it, verifies invalid Enhanced remains independent, then removes Vocal and proves restart invalidation.
- Final reviewer-focused validation passed a fresh build plus five suites: progress, scheduler, resumability (30 checks), resources (24 checks), and artifacts (9 checks).
- 2026-09-18 Enhanced mode moved from fixed mix weights to measured EBU R128 balancing. Vocal targets -20 LUFS, Instrumental -23 LUFS, each with ±6 dB gain bounds and -3 dBTP per-input headroom; the final normal-program target is -16 LUFS / -1.5 dBTP with a ±1.5 LU and 0.15 dBTP acceptance tolerance.
- Near-silent inputs at or below -45 LUFS are never boosted. Premixes at or below -30 LUFS skip loudness normalization and receive clipping protection only. Mild Instrumental cleanup is gated by loudness above -35 LUFS, LRA ≤2 LU, and peak-to-integrated difference ≤8 dB; this is explicitly noise reduction, not restoration.
- Enhanced processing writes a separate candidate and replaces only Enhanced after decode and final metric validation. Original, Instrumental, and Vocal hashes remain unchanged. Metrics, gains, filters, cleanup choice, final result, and caveats persist in the Enhanced deliverable and progress item.

📌 Team update (2026-09-18T20:04:53.087-07:00): Morpheus's schema-v1 progress/deliverable contracts, dependency-minimal retries, half-core CPU propagation, and measured Enhanced auto-balance are approved and packaged in 0.3.2. Whisper inference remains honestly indeterminate and GPU percentage quotas remain unsupported rather than claimed.

- 2026-09-18 Whisper overlap diagnosis reproduced the installed failure shape `76.76–101.72` followed by `80.38–85.78`. The requested word-timestamp stream contained an anomalously long timed fragment; the old grouper used that raw end, emitted a long line, then emitted the contained later fragment, and strict validation rejected it.
- Timestamp handling now validates every nonempty fragment before sorting, removes exact duplicates and empty fragments, safely sorts finite nonnegative timing, clamps long/partially overlapping fragments at the next word boundary, applies a documented 0.01s comparison epsilon and 0.04s minimum duration, clamps ends to known media duration, preserves Unicode text, and rejects ambiguous, non-finite, negative, reversed, or out-of-media timing instead of fabricating broad intervals.
- Lyric/transcription failures now publish a terminal partial song whenever any listening mode remains valid. Vocal-backed lyric retries remain dependency-minimal, persisted partial state survives restart, and the global one-song FIFO releases after failure.
- 2026-09-18 binding fallback refinement changed malformed timing from a song-level failure into per-line recovery. Each malformed nonempty fragment keeps its Unicode text, starts at the previous valid boundary (or zero), and receives a bounded positive interval ending before the next valid boundary or media duration. Consecutive malformed lines divide available space deterministically. Only globally empty/unusable transcription fails.
- Fallback usage is persisted as transcription/lyrics diagnostics and disclosed in the Lyrics UI without disabling playback. Deterministic timing QA now passes 17 checks; runtime failure/restart/retry and degraded-timing disclosure pass 5/5 scenarios with 92 assertions.

📌 Team update (2026-09-19T02:52:27.047-07:00): Neo's deterministic bounded refinement superseded the initial timestamp algorithm, Tank approved it at timing 33, and the final behavior is included in the approved frozen 0.3.3 package.
