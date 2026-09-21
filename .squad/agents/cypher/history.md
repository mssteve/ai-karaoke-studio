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

### 2026-09-20: Release orchestration capability revision

- Removed reusable capability issuance from the lock module. Only the canonical
  `scripts\deploy-release.mjs` execution path can issue, after validating the immutable
  OS process command line/image, script realpath, process creation identity, spawned
  child identity/parentage, and active release-lock ownership.
- Bound the atomically consumed capability to a separate random 256-bit lock token.
  The low-level packager revalidates the live lock, token, canonical deploy parent and
  release child, PID creation identities, HEAD/source/version/operation/expiry, then
  clears all handoff environment values. Missing, wrong, replayed, forged, wrapper,
  renamed-copy, argv/environment mutation, and PID-reuse attacks fail closed.
- Added tracked `.squad/reviewers.json` as the canonical Tank/committer policy.
  Approval authors must exactly match Tank; committers may exactly match Tank or the
  project maintainer. Structurally parsed `Reviewed-by` and `Reviewer-Role` trailers
  reject substring, prefixed/suffixed, case/Unicode lookalike, duplicate, and
  conflicting forms. Absent, modified, or untracked registry state is rejected.
- Validation passed build, deploy QA 98/98, Demucs boundary 14 checks, Demucs runtime
  18 checks, syntax, and diff checks. Real dry-run and stale `--zip` each exited 3 on
  dirty source while all 1,398 inventoried release/ZIP/lock/install/user-data files
  remained byte- and timestamp-identical; no lock or capability remained.
- No approval, commit, package, install, release artifact, ZIP, push, or merge occurred.

### 2026-09-20: Approval checkout-normalization revision

- Reproduced Tank's clean-checkout failure at `48cfb8f44444d2ce5bc628c6eb2098016f021e59`.
  Git stored the approval/evidence JSON as LF blobs while the checkout contained CRLF;
  `git diff HEAD` reported clean, but the verifier compared raw filesystem bytes to blob
  bytes. The approval was 946/916 bytes and the evidence 4256/4142 bytes respectively.
- Approval, evidence, reviewer-registry, and `.gitattributes` validation now requires
  exact commit-tree and stage-0 index blob/mode identity, attribute-aware clean checkout,
  canonical path/type/realpath/link safety, and no active `filter`,
  `working-tree-encoding`, or `ident` transformation. JSON parsing and SHA-256 binding
  use canonical committed blob bytes, so only legitimate EOL checkout representation
  may differ.
- Added nine focused regressions for LF-blob/CRLF-checkout acceptance and canonical
  hashes, semantic tampering, staged evidence, deletion, type change, alternate
  untracked approval, `.gitattributes` mutation, and malicious clean/smudge filters.
  Full deploy QA passed 132/132; build, Demucs 14/14 and 18/18, syntax, diff, and the
  33-file/628055-byte built-output secret scan passed.
- The rejected approval/evidence remain in historical commit `48cfb8f` with parent
  `a28111a541e985c2bbbc992e1df72c6fdb00d0d9`; both files are deleted only in this
  forward working revision. Direct validation rejects the absent approval.
- Real dry-run and stale `--zip` both exited 3 and preserved all 1,402 inventoried
  files byte-, size-, timestamp-, type-, and membership-identically. No lock or
  capability residue remained. No package, ZIP, install, approval, commit, push, merge,
  tag, or release-artifact deletion occurred.
