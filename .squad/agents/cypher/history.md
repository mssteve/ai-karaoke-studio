# Cypher History

## Project Context

Karaoke Studio is an Electron/React Windows app with four synchronized audio versions, timed lyrics, and FIFO playlists. Requested by Steve.

## Learnings

- 2026-09-18 playback reliability remediation: reproduced Tank's timeout with the long-song copied profile at `scripts/qa-artifacts/mode-switching-cypher-long-baseline-2026-09-18.run.log`. The mode QA assumed a short synthetic source and waited for natural playback from about 2.2 seconds to the end without issuing the documented near-end seek, making a 15-second timeout inevitable on 4–5 minute songs.
- Added private media/controller tracing (media readiness/network/terminal state, play intent, pending seek, source generation, mode, and ordered events). It also exposed a real source-replacement race: resume and FIFO autoplay were deferred through animation frames, while pending seeks were issued only after `playing`, allowing a ready replacement source to remain paused/loading.
- Reworked replacement seeks to apply on `canplay`, wait for seek settlement before resuming, and report playing only after media playback starts. FIFO autoplay now waits for the exact loaded source key rather than an animation frame. Mode QA now explicitly seeks near end and accepts only a settled playable/clamped/ended state.
- Final clean build passed. Tank's focused mode suite passed 5/5 in five consecutive long-profile runs at `scripts/qa-artifacts/mode-switching-cypher-final-verified-run{1,2,3,4,5}-2026-09-18/report.json`. Playlist/language passed 16/16 at `scripts/qa-artifacts/playlist-language-cypher-final-2026-09-18/report.json`, including FIFO exactly-once autoplay, final ended/reset behavior, Unicode, source hashes, no renderer errors, and zero TCP listeners.

📌 Team update (2026-09-18T09:32:50.972-07:00): Cypher's source-bound replacement seek and FIFO autoplay repairs are part of approved 0.3.0; Apoc's stricter terminal-state evidence closed the remaining test-integrity rejection — decided by Neo, Trinity, Morpheus, Tank, Switch, Cypher, and Apoc.

📌 Team update (2026-09-18T14:19:38.738-07:00): Before future Queue/History or playlist transport reliability work, read and apply `.squad/skills/queue-history-validation/SKILL.md`, including its exact Previous/Next, archival, persistence, and terminal transport checks.

📌 Team update (2026-09-18T15:07:36.120-07:00): Before release reliability approval for user-facing playback or shipped-runtime changes, read `.squad\skills\full-windows-store-release\SKILL.md`. Source gates are intermediate; fresh packaged-runtime evidence must bind to the official NSIS/APPX hashes.

- 2026-09-18 processing scheduling incident: Electron accepted every `ai:process` IPC invocation concurrently; the prior `activeJobs` set only rejected a second request for the same song and imposed no cross-song limit. Rapid requests therefore spawned one complete FFmpeg/Demucs/Whisper pipeline per song.
- Added a process-wide FIFO scheduler with concurrency fixed at one for CPU/memory-heavy local AI. Queue positions are published and persisted through Morpheus's schema-v1 progress details; duplicate song requests share one terminal promise, failures release the slot, and later jobs continue.
- Startup now converts persisted queued or active processing states to an explicit retryable error. Full processing does not publish output paths until all outputs validate, while transcription retains its atomic temporary-file rename, so retry safely rebuilds partial work.
- Deterministic scheduler QA covers 12 enqueues, maximum concurrency, FIFO, duplicate suppression, failure continuation, terminal cleanup, and restart recovery. `npm run build`, `npm run qa:processing-progress`, and `npm run qa:processing-scheduler` pass.

📌 Team update (2026-09-18T20:04:53.087-07:00): Cypher's exactly-one process-wide FIFO pipeline is the approved invariant in 0.3.2. Duplicate song work coalesces, failures release the slot, restart interruption is retryable, and each pipeline is capped at half available logical CPU cores with a minimum of one.
