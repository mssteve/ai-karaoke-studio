# Neo History

## Project Context

Karaoke Studio is an Electron/React Windows app using local FFmpeg, Demucs ONNX, and Whisper ONNX. Requested by Steve.

## Learnings

- 2026-09-17 integration audit: the production renderer design is sound in principle—`karaoke://app/`, relative Vite assets, CSP, sandbox, context isolation, and no renderer Node integration. A live development launch rendered the complete non-blank UI.
- Electron compilation currently emits the required `dist-electron/preload.cjs`; the package file list includes the main bundle, preload, and renderer entry.
- IPC channel names and renderer API signatures align for library load/import/remove, processing, diagnostics, progress, and desktop control. Add Song and row selection have direct renderer handlers; row selection no longer nests an action button inside another button.
- The automation transport is release-blocking: the client half-closes after writing, the default server socket closes its writable side, and the server then raises `ERR_STREAM_WRITE_AFTER_END`. Status returned an empty/invalid response; screenshot execution occurred but its result could not be returned.
- The fixed pipe name has no authentication or production gate despite supporting library mutation, processing, playback control, and screenshots.
- Shared build outputs are unsafe under concurrent activity. During audit, a newly assembled `app.asar` listed expected paths but returned CSS bytes for `package.json` and `dist/index.html`, and the packaged executable exited before application logging. Release packaging needs isolated staging plus archive-content validation.
- Validation evidence: `npm run build` passed, renderer and Electron no-emit type-checks passed, helper scripts passed `node --check`, development startup logged `karaoke://app/index.html`, and a captured screenshot showed the full UI.
- 2026-09-17 Sprint 2 re-review: source now gates packaged automation behind `--enable-private-automation`, and the only listener found is the Windows named pipe; no HTTP/HTTPS listener exists. The repaired pipe returned valid structured responses in QA.
- The submitted QA run used the development Electron executable, where automation is always enabled. It did not prove either side of the packaged-launch gate.
- The current packaged archive is stale: its `main.js` lacks the automation gate and QA instrumentation and starts the pipe unconditionally. A direct normal packaged launch accepted `control status`, so the release artifact violates the private-default requirement even though current source and `dist-electron/main.js` are corrected.
- The QA harness exercises the rendered Add Songs button through preload and IPC, but its fixture branch bypasses Electron's native `dialog.showOpenDialog`; native chooser wiring remains unproved.
- Row selection, removal, original-mode seek, play, and pause were exercised with screenshots and state checks. Enhanced, vocal, and instrumental controls were explicitly skipped because AI processing was not run.
- `dist-electron/preload.cjs` exists and the current archive is readable, but build/package scripts still share and clean the global `dist`, `dist-electron`, and `release` paths. The stale package versus fresh compiled output demonstrates that release provenance and concurrency isolation remain unresolved.
- 2026-09-17 final integration review: the isolated, provenance-locked release resolved the initial automation framing/security and Sprint 2 packaged-gate/provenance objections. Final verdict: APPROVE.
- Final evidence includes a 22/22 packaged harness, Tank's independent 26/26 approval, real Windows common-dialog imports, complete AI outputs and timed lyrics, private automation disabled by default and enabled only by `--enable-private-automation`, and zero listening TCP endpoints.

📌 Team update (2026-09-17T17:23:31.480-07:00): The final NSIS/APPX release is approved with provenance and fixed hashes; packaged automation is opt-in named-pipe-only and no HTTP/listening network port exists — decided by Neo, Trinity, Morpheus, Tank, and Switch.

- 2026-09-17 seamless-mode revision: the playing switch race came from restoring the timestamp before the replacement media source had actually entered playback; Chromium could restart the stream at zero after that early seek. The renderer now carries a wall-clock playback anchor through loading, computes a clamped resume target when the new source can play, and enforces that target on initial playback time updates until the media clock reaches it.
- Paused switches still restore the exact captured media time without wall-clock advancement. Near-end switching remains clamped to the shorter target duration, and rapid requests retain the final requested mode.
- Focused evidence: `npm run build` passed, then Tank's exact `scripts/qa-mode-switching.mjs` scenario passed 5/5 at `scripts/qa-artifacts/mode-switching-neo-final-2026-09-17/report.json`. Playing transitions were original 0.80s→enhanced 1.00s→vocal 1.00s→instrumental 1.00s→original 1.30s with playback active.

- Neo independently revised the logical timeline after reviewer lockout. Tank's final re-review approved 5/5: playing deltas stayed within -0.12s..+0.45s, paused switches remained exactly 1.60s in every mode, the near-end case clamped 6.80s→3.00s, and rapid requests ended in vocal mode.

📌 Team update (2026-09-17T21:23:57.955-07:00): Neo's logical-timeline revision cleared Tank's independent 5/5 re-review and became the source for the official sequential rebuild.

📌 Team update (2026-09-17T22:55:03.579-07:00): The installed-app Demucs failure was a packaging boundary issue, not an audio implementation issue; the approved replacement release unpacks `mediabunny` and `@mediabunny/mp3-encoder`.

- 2026-09-18 playlist/queue integration design: defined a separate schema-versioned `playlists.json`, an immutable default Queue, duplicate-capable ordered entry identities, named playlist lifecycle, FIFO cursor/removal rules, restart behavior, and library-removal cascade.
- Song changes always reset to 0:00. Direct selection starts in Original; natural queue advance carries the current mode when available and visibly falls back to Original otherwise. Last entry ends without wrapping or consuming persisted entries.
- Lyrics are bound and reset by selected song and gain persisted BCP-47 language metadata. Seek matching is start-inclusive/end-exclusive, with no active line in gaps and a final-line duration exception.
- Trinity's integration surfaces and twelve acceptance gates are recorded in `.squad/decisions/inbox/neo-playlist-queue.md`. The design explicitly avoids changes to `src/usePlaybackController.ts` and existing mode-switching QA while Tank's playback review is active.

📌 Team update (2026-09-18T09:32:50.972-07:00): Neo issued Trinity's playlist/FIFO, song-reset, lyric-language, persistence, and automation acceptance contract; AI Studio is removed and the playback controller remains under Tank's review boundary.

- 2026-09-18 rejected playlist/language revision: legacy processed songs can now refresh language and timed lyrics from their existing vocal stem without rerunning Demucs. Transcript replacement is validated and atomic, exposes progress/errors, and persists detected BCP-47 metadata plus Unicode lyrics. The authorized `任然 - 无人之岛` profile migrated to `Chinese (zh)` with persisted/rendered Unicode while both source files retained identical hashes, sizes, and modification times.
- Song playlist menus are propagation-isolated and no longer alter selection or playback. Paused seeks now reach the media element immediately, so opening a menu cannot reveal a stale zero-time media clock.
- FIFO completion now uses the media element's genuine `ended` event rather than synthetic near-end thresholds. A natural end advances exactly once to the next entry at 0:00; the final entry remains selected at duration with status `ended`; clearing the playlist leaves a coherent empty cursor and disabled Play control.
- Same-song mode capture now preserves the renderer's observable logical timeline rather than recapturing a later media-clock value during command handling. Final focused evidence passed 5/5 at `scripts/qa-artifacts/playlist-language-neo-mode-regression5-2026-09-18/report.json`.
- Final validation: clean `npm run build` passed and Tank's exact playlist/language suite passed 16/16 at `scripts/qa-artifacts/playlist-language-neo-final-2026-09-18/report.json`, including Unicode language persistence, menu preservation, duplicate FIFO ordering, restart persistence, native final-ended behavior, source immutability, zero TCP listeners, and zero renderer errors.

📌 Team update (2026-09-18T09:32:50.972-07:00): Karaoke Studio 0.3.0 is finally approved with Neo's playlist/language contract intact: persistent Queue and named playlists, duplicate-safe FIFO, 0:00 song changes, exactly-once natural advance, terminal final entry, and Unicode original-language lyrics — decided by Neo, Trinity, Morpheus, Tank, Switch, Cypher, and Apoc.

- 2026-09-18 protected-History boundary revision: `addSongToPlaylist` now rejects History in the Electron main process before mutation and applies the same optimistic-concurrency validation used by adjacent playlist mutations. Queue and user-playlist insertion remain unchanged; Queue archival remains the sole direct path that inserts History entries.

📌 Team update (2026-09-18T14:19:38.738-07:00): Before future Queue/History or playlist transport integration approval, read and apply the canonical `.squad/skills/queue-history-validation/SKILL.md` runbook and its stable `scripts/qa-queue-history-run.ps1` entry point.

- 2026-09-18 release-trigger audit: Queue/History stopped at source build and focused
  8/8 QA because orchestration never routed Switch. Earlier user-facing work explicitly
  created a post-review Switch task for official NSIS/APPX and packaged QA.
- `npm run build` only regenerates `dist` and `dist-electron`; `npm run release` alone
  invokes the exclusive sequential NSIS/APPX workflow, packaged-content/runtime checks,
  SHA256 sums, and provenance.
- The official 0.3.0 release is stale relative to Queue/History: release provenance
  aggregate `8f245514...` differs from current `fab3cd005...`, with seven changed product
  inputs and three new Queue/History QA scripts.
- Future accepted user-facing or shipped-runtime changes automatically trigger Switch
  packaging and packaged feature QA after reviewer approval. Build/focused source QA is
  an intermediate gate and cannot close the request.
- No Karaoke-specific canonical release skill currently exists under `.squad/skills`;
  the only release template concerns Squad npm publishing and is inapplicable. Until a
  verified Windows full-release skill is earned, agents must use `package.json`,
  `scripts/release.mjs`, and active release decisions and must route Neo/Switch rather
  than claim release completion.
- Current rebuild hazard: Queue/History's canonical 8/8 runner is source-built, while
  `scripts/release.mjs --approval` only accepts exact 5/5 evidence. Switch must not reuse
  stale mode evidence or call the source report packaged proof.

📌 Team update (2026-09-18T15:07:36.120-07:00): Every approved user-facing or shipped-runtime change now automatically routes to Switch and remains open through full package review. Before release planning or completion, read and enforce `.squad\skills\full-windows-store-release\SKILL.md`; build-only validation is intermediate.

- 2026-09-18 independent processing-recovery revision: Queue/History automation was exposing a real startup recovery defect, not a UI regression or fixture incompatibility. `inspectDeliverables` assigned reconciliation results through a stale `song.deliverables` object while `outcome()` replaced that object, so valid media stayed `missing`. A second broad `ENOENT` catch then treated a missing processed directory as a missing `library.json` and cleared the in-memory Library. Reordered reconciliation and narrowed library-file error handling restore legacy Original-only songs; the canonical rendered suite now passes 8/8.
- Whisper model loading remains a progress substep, but the retryable domain deliverable is consistently `whisper-transcription`. Persisted failures, deliverable outcomes, processingFailure, rendered retry controls, restart recovery, and automation now use that exact component.
- Durable final persistence is a distinct retryable `library-save` component. Save failure remains below 100%, preserves completed artifacts, survives restart, and retries persistence without rerunning successful media work.
- Added explicit dual-opt-in runtime QA hooks (`--enable-private-automation` plus `--enable-private-qa-hooks`) for source preparation, missing stem, Whisper, Enhanced, and final library-save failures. They are absent from normal launches. Runtime Electron evidence passed 5/5 scenarios and 90 assertions, including exact attribution/UI retry, sibling availability, minimal retry, restart persistence, serial-slot release, queued continuation, failure removal, and recovery.
- Final validation: clean build; seven focused processing suites; rendered processing UI 9/9; canonical Queue/History 8/8; runtime failure/restart 5/5 with 90 assertions. No package or release was produced.

- 2026-09-18 independent 0.3.2 release revision: Tank correctly rejected Switch's
  functionally passing candidate because broad `asarUnpack` dependency traversal copied
  `node_modules/@ffmpeg-installer/ffmpeg/.env`. Repository `.gitignore` rules never
  governed electron-builder packaging. Neo added production package exclusions for
  environment, credential/token, private-key, certificate, signing-store, developer
  credential-directory, backup, and related secret material without removing the
  required FFmpeg binary.
- The exclusive release workflow now runs a fail-closed path and safe content scan over
  the complete NSIS staging tree, APPX staging tree, extracted APPX payload, all three
  packed ASAR views, and all three unpacked directories. It reports only paths and
  SHA-256 for findings. Nine scopes checked 24,697 entries, 22,939 files, 21,030
  text-like files, and 8,140,773,108 bytes with zero findings.
- Replacement 0.3.2 artifacts supersede the rejected hashes: NSIS
  `da92c3aa353e1bafcff25e02775ab52396e8becfdd5f3f1c1b71ad5ffa27e28b`;
  APPX `a6b43fb07778a9d05c7cfa3501452304d10756b47e29493888456c03a612f491`.
  Provenance SHA-256 is
  `42a683ae733b4ff87ab466c29506641e42c8eb5b69b2bb9e3a0b346de55a7c45`;
  69 source entries aggregate to
  `33fdc1c947c5d10dc4cfe5e238c9e7ff128e199074d1de0f6e4d799939fa414b`
  with zero differences.
- Replacement validation passed seven focused processing suites, rendered processing
  UI 9/9, runtime failure/restart 5/5 with 90 assertions, Queue/History 8/8, Demucs
  4/4, automation isolation 3/3, and zero renderer errors. The dependency `.env` remains
  locally ignored by Git and absent from 194 prospective initial-commit files; its
  content was not inspected or deleted. External rotation/revocation is advised.
- Package verdict is **APPROVE PACKAGE / BLOCK STORE SUBMISSION**. Both replacement
  artifacts remain unsigned and the APPX identity/publisher remain placeholders.
  Evidence: `scripts/qa-artifacts/processing-packaged-0.3.2-neo-revision/revision-verdict.json`.

📌 Team update (2026-09-18T20:04:53.087-07:00): Neo's processing recovery revision and secret-safe 0.3.2 replacement are canonical. The earlier 0.3.2 hashes are rejected; final NSIS/APPX/provenance hashes are `da92c3aa...`, `a6b43fb0...`, and `42a683ae...`, with zero findings across nine package scan scopes.

- 2026-09-18 independent timestamp-normalization revision under reviewer lockout:
  valid timing is classified and stably sorted independently of malformed text. Malformed
  fragments are associated with the preceding valid input fragment, then placed in the
  corresponding chronological boundary. Available gaps are subdivided with an exact
  40ms floor; excess text is deterministically merged rather than dropped or allowed to
  fail an otherwise usable transcription.
- Diagnostics now distinguish stable sorting, actual overlap clamps, invalid-duration
  expansion, fallback placement, merges, and discards. Zero/30/39ms expansion never
  increments `repairedOverlapCount`; 40ms is accepted unchanged. Final validation uses
  only floating-point tolerance, not the former 10ms duration waiver.
- Screenshot automation now proves a complete, visible, nonempty rendered root across
  two animation frames before capture and rejects empty NativeImages. Rendered and
  Queue/History harnesses require this proof instead of blind screenshot retries.
- Final evidence: clean build; transcription timing 33 checks; processing UI 21,
  resume 31, resources 24, artifacts 9, scheduler and progress suites; runtime recovery
  6/6 with 110 assertions; rendered UI 9/9 with two nonzero images; Queue/History 8/8
  with two nonzero readiness-proven images. No package was produced.
