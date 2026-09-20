# Tank History

## Project Context

Karaoke Studio requires screenshot and behavior evidence for every release. Requested by Steve.

## Learnings

- The original pipe protocol waited for the client to half-close before replying; Windows closed the writable side too, causing `ERR_STREAM_WRITE_AFTER_END`. Newline-delimited requests allow reliable request/response automation.
- Main-process imports and completed AI output paths are visible in the renderer after restart. The QA harness deliberately restarts with an isolated profile to validate both rendered state and persistence.
- Release evidence is reproducible with `node scripts\create-qa-fixtures.mjs` followed by `node scripts\qa-harness.mjs --app "release\win-unpacked\Karaoke Studio.exe" --process`.
- Final packaged run passed 17/17 gates. Evidence and screenshots are under `scripts\qa-artifacts\packaged-approved-2`.
- The final private named-pipe QA/screenshot harness independently passed 26/26 gates. The canonical full packaged report passed 22/22 cases with no skips under `scripts\qa-artifacts\sprint-3-final-approved`.
- The harness proved the named pipe is absent by default, available only with `--enable-private-automation`, and never accompanied by an HTTP server or listening TCP endpoint.

📌 Team update (2026-09-17T17:23:31.480-07:00): Final independent QA verdict is APPROVE 26/26; canonical packaged evidence and screenshots are retained in `scripts/qa-artifacts/sprint-3-final-approved` — decided by Tank.

- 2026-09-17 seamless-mode review: rejected Trinity's initial timestamp-preserving implementation after a playing switch jumped backward from 0.70s to 0.20s. After reviewer lockout and Neo's independent logical-timeline revision, re-review verdict was APPROVE 5/5.
- Final packaged evidence confirmed playing deltas of -0.12s..+0.45s, paused position exactly 1.60s across all modes, near-end clamp 6.80s→3.00s, rapid switching ending in vocal mode, and zero listening TCP endpoints.

📌 Team update (2026-09-17T21:23:57.955-07:00): Tank approved the focused packaged mode-switching release 5/5; canonical report is `scripts/qa-artifacts/mode-switching-packaged-approved-2026-09-17/report.json`.

- 2026-09-17 installed Demucs regression: independently invoked the installed `Karaoke Studio.exe` with `ELECTRON_RUN_AS_NODE=1`, using unpacked Demucs from the installed resources path and running outside project ancestors. The regression passed with valid vocals, drums, bass, and other stems.
- Canonical evidence: `scripts/qa-artifacts/installed-demucs-current-hashes-approved-2026-09-17/report.json`.

📌 Team update (2026-09-17T22:55:03.579-07:00): Tank independently confirmed the installed-path Demucs dependency fix with 4/4 valid stems.

- 2026-09-17 current-data playback baseline: REJECT 3/9 against the installed 0.2.0 app and the two already processed songs. The private pipe, zero TCP listeners, and untouched source-file hashes passed; every playback behavior gate was blocked because seek commands never moved the timeline from zero. Evidence: `scripts/qa-artifacts/current-installed-playback-baseline-2026-09-17/report.json`.
- Added repeatable current-data private named-pipe coverage at `scripts/qa-current-installed-playback.mjs`; it records screenshots, run logs, source integrity, four-mode clocks/media state, 24 rapid switches, play/pause/resume, slider/ratio, lyric timing, song reset behavior, and TCP listeners.

- 2026-09-18 post-fix source review: APPROVE 9/9 against the unchanged current two-song profile. All four modes advanced in playing media state, play/pause/resume held position correctly, both pipe and rendered slider seeks landed at 42.00s, 24 rapid switches produced no zero reset and remained playable, progress matched the media clock, lyrics advanced from index 0 to 1 at the recorded boundary, selecting the other song reset it to zero, source hashes remained unchanged, and the process tree exposed zero TCP listeners.
- Canonical final evidence: `scripts/qa-artifacts/current-source-playback-final-2026-09-18/report.json`, five screenshots, and a clean app-run log.
- After Trinity's explicit READY handoff, independently inspected `src/usePlaybackController.ts`, `src/App.tsx`, and the byte-range media response in `electron/main.ts`, then reran the exact current-data harness. Final verdict remained APPROVE 9/9; Switch may package. Independent evidence: `scripts/qa-artifacts/current-source-playback-independent-final-2026-09-18/report.json`.

- 2026-09-18 playlist/language review: added the private explicit-flag rendered-UI harness at `scripts/qa-playlists-language.mjs` without changing Trinity's implementation. Final verdict is REJECT 12/16 against isolated copies of the two current processed songs.
- Passing coverage included AI Studio removal, timestamp-driven forward/backward lyric seeking, exact one-time song reset versus same-song mode preservation, menu-backed Queue/named-playlist mutations, duplicate FIFO identity/order, paused-current removal behavior, cursor/order persistence at paused 0:00 after restart, empty-playlist stop/disable, unchanged source hashes, no renderer errors, and zero TCP listeners.
- Release blockers: both songs remain `Unknown (und)` with ASCII mistranscriptions instead of detected original-language Unicode; opening the song menu resets a paused 5.00s timeline to 0.00; queued Vocal playback freezes at 283.00s in `playing`, preventing FIFO natural-end advance; the named last entry likewise never reaches `ended`.
- Canonical evidence and eight non-empty screenshots: `scripts/qa-artifacts/playlist-language-final-verdict-2026-09-18/report.json`.
- After Trinity's explicit READY message, a fresh clean build passed and the full independent suite was rerun unchanged. Verdict remained REJECT 12/16 with the same four blockers. Canonical post-handoff evidence contains nine non-empty screenshots at `scripts/qa-artifacts/playlist-language-post-ready-verdict-2026-09-18/report.json`.
- 2026-09-18 post-fix re-review: language/Unicode hydration, menu time preservation, last-entry ending, empty behavior, and renderer cleanliness are repaired. Verdict improved to REJECT 14/16. Same-song Vocal never becomes automation-ready after a rendered mode click, and FIFO advances its cursor exactly once but leaves the next song `loading` with `playingIntent=false` rather than auto-playing. Evidence: `scripts/qa-artifacts/playlist-language-post-fix-independent-2-2026-09-18/report.json` with nine non-empty screenshots.
- 2026-09-18 final remediation review: APPROVE 16/16 after a fresh clean build. The exact independent rendered-UI suite confirmed detected Chinese metadata and Unicode persistence, lyric seeks, one-time song reset, mode-time preservation, side-effect-free menus, named playlist creation, duplicate FIFO order, exactly-once natural-end auto-play, removal/cursor rules, restart persistence at paused 0:00, terminal and empty states, unchanged source hashes, no renderer errors, and zero TCP listeners. Canonical evidence: `scripts/qa-artifacts/playlist-language-remediation-final-2026-09-18/report.json` with nine non-empty screenshots.
- Team canonical evidence is the earlier post-remediation run at `scripts/qa-artifacts/playlist-language-neo-ready-run4-2026-09-18/report.json` (APPROVE 16/16, nine non-empty screenshots). Tank's later `playlist-language-remediation-final-2026-09-18` rerun independently corroborates the same 16/16 result.
- 2026-09-18 final reviewer rerun against a fresh clean source build: focused playlist/language QA independently passed 16/16 with nine non-empty screenshots, unchanged source hashes, no renderer errors, and zero TCP listeners. However, the unchanged existing `qa-mode-switching.mjs` regression did not reach 5/5: playing switches exceeded the approved +0.45s bound (up to +0.60s), and the near-end case timed out before producing a report. Overall verdict is REJECT; Switch packaging is not approved. Evidence: `scripts/qa-artifacts/playlist-language-final-reviewer-2026-09-18/report.json` and `scripts/qa-artifacts/mode-switching-final-reviewer-2026-09-18/run.log`.
- 2026-09-18 Morpheus third-author review: clean build passed and playlist/language remained APPROVE 16/16 with nine valid screenshots. Mode playing deltas and paused preservation now pass, as does zero TCP, but the exact unchanged mode suite still times out at `near-end natural playback` against the two long processed songs and never reaches the required near-end/rapid gates. Overall REJECT; not ready for Switch packaging. Evidence: `scripts/qa-artifacts/playlist-language-third-author-final-2026-09-18/report.json` and `scripts/qa-artifacts/mode-switching-third-author-final-2026-09-18/run.log`.
- 2026-09-18 Switch fourth-author review: fresh clean build passed. Playlist/language independently passed 16/16 with nine non-empty screenshots. The exact mode regression was stress-run three times; all three passed TCP, playing continuity, and paused preservation, then identically timed out at `near-end natural playback`, never reaching near-end clamp or rapid-final-mode gates. Overall REJECT (3/3 mode runs failed); Switch packaging is not approved. Evidence: `scripts/qa-artifacts/playlist-language-fourth-author-final-2026-09-18/report.json` and `scripts/qa-artifacts/mode-switching-fourth-author-run{1,2,3}-2026-09-18/run.log`.
- 2026-09-18 Cypher review: clean build passed; revised mode suite reported APPROVE 5/5 in five consecutive runs, and playlist/language passed 16/16 with source hashes unchanged. Test-integrity review rejected approval: the near-end evidence records only `settled=playing`, and its acceptance branch can pass immediately when media is merely playing at the requested position rather than demonstrating deterministic end settlement. The requested target is not recorded explicitly. Worse, every mode run logs three renderer exceptions from the caught missing `[role="alert"]` snapshot while the report claims `renderer error visible=false` (15 current-run renderer errors across five runs). Overall REJECT on test integrity; not ready for packaging. Evidence: `scripts/qa-artifacts/mode-switching-cypher-run{1..5}-2026-09-18/report.json`, their profile logs, and `scripts/qa-artifacts/playlist-language-cypher-final-2026-09-18/report.json`.
- 2026-09-18 Apoc test-integrity review: APPROVE. Main-process changes expose read-only renderer-error and media-trace diagnostics only; no product mutation or hidden test success path was added. Continuity bounds remain -0.12s..+0.45s playing and ≤0.12s paused. Five consecutive strict mode runs passed 5/5: each recorded 286.112s actual duration, 285.826s 99.9% target, 285.800s observed seek, clamp to 285.536s replacement duration, 90 media events, terminal `ended` exactly at duration with paused=true and both intents false, zero media/renderer errors, rapid Vocal final mode, and zero TCP. Playlist/language passed 16/16 with nine valid screenshots and unchanged source hashes. Ready for Switch packaging. Evidence: `scripts/qa-artifacts/mode-switching-apoc-run{1..5}-2026-09-18/report.json` and `scripts/qa-artifacts/playlist-language-apoc-final-2026-09-18/report.json`.
- 2026-09-18 packaged runtime review: unpacked 0.3.0 product runtime passed strict mode 5/5 five consecutive times, playlist/language 16/16, real product-path retranscription 6/6, Demucs 4/4, explicit automation with zero TCP, default automation disabled, zero renderer/media errors, restart persistence, and unchanged source audio hashes. Test integrity passed: continuity thresholds are unchanged, the near-end test uses a 0.5s observable runway and requires terminal ended/paused/intent false, retranscription supplies a real song id and a one-hour command timeout. Overall release evidence verdict is REJECT only because `release/provenance.json` no longer equals current source: `scripts/control.mjs` and `scripts/qa-mode-switching.mjs` hashes differ, and `scripts/qa-retranscription-runtime.mjs` is absent from the manifest. All six product build-output hashes and both 0.3.0 binary hashes still match, so binaries are byte-correct and need no rebuild; provenance/QA metadata must be refreshed.
- 2026-09-18 final metadata-only review: APPROVE. Provenance tracks all 47 current source files with zero missing, extra, or hash mismatches; aggregate SHA-256 independently recomputes to `8f2455146a918ebb8e0ce0737183777316c05e0f290cf4a63a66fe8efdc8b6b0`. Corrected QA hashes are control `eb62a59b...`, mode `e02fa549...`, and retranscription `078d8737...`. NSIS remains `b382db39...` and APPX `579e33fd...`; file bytes, provenance entries, and SHA256SUMS all agree. Approval evidence hash also matches. Product sources/build outputs and binaries are unchanged from the independently approved packaged-runtime run, so no expensive rerun or binary rebuild is required.

📌 Team update (2026-09-18T09:32:50.972-07:00): Tank's final metadata-only approval closes 0.3.0: strict mode 5/5 x5, playlist/language 16/16, retranscription 6/6, Demucs 4/4, zero renderer/TCP errors, and 47/47 zero-mismatch provenance — decided by Neo, Trinity, Morpheus, Tank, Switch, Cypher, and Apoc.

- 2026-09-18 Queue/History feature review: REJECT after a clean `npm run build`. The renderer correctly hides History from the add menu, but the Electron mutation boundary still accepts `addSongToPlaylist({ playlistId: 'history', ... })`, allowing ordinary insertion into the protected system History list. Validation stopped at this release blocker; rendered and persistence scenarios remain unexecuted.
- 2026-09-18 Queue/History independent revalidation after Neo's revision: APPROVE. A fresh `npm run build` passed. Focused private named-pipe runtime QA passed 8/8 against an isolated migrated profile: History was inserted without losing Queue/user playlists; the rendered footer showed Previous/Play/Next in order; the plus menu rendered outside the clipped song list and exposed Queue/user playlists but not History; Queue and user-playlist insertion remained valid; natural completion and manual Next each removed the Queue entry and prepended it to newest-first History; Previous/Next traversed older/newer History and returned to Queue; Queue/History persisted across restart; and runtime diagnostics recorded zero renderer errors. Screenshots and report: `scripts/qa-artifacts/queue-history-focused-2026-09-18/`.
- The original protected-History blocker is closed in both source and freshly compiled Electron output: `addSongToPlaylist` rejects `playlist.kind === 'history'` before mutation, while the separate atomic archive handler remains the sole History insertion path. The private automation contract does not expose arbitrary IPC invocation, so the hostile direct-preload call was verified statically/build-time rather than executed through the rendered harness.
- 2026-09-18 reusable Queue/History QA workflow recorded at `.squad/skills/queue-history-validation/SKILL.md`; it preserves the exact build/focused harness, isolated-profile safety, 8/8 assertions, evidence criteria, static direct-History guard check, cleanup, and the two manual-only gaps.
- 2026-09-18 clarification: expanded the Queue/History skill into a directly executable runbook and added `scripts/qa-queue-history-run.ps1` as the stable entry point. The wrapper builds, validates source/compiled protection, runs and parses the 8/8 rendered/private-pipe harness, checks screenshots, and proves imported sources unchanged; the runbook also records exact request/state sequencing, diagnosis, restart, cleanup, and explicit manual gap procedures.
- 2026-09-18 canonicalization: Queue/History validation is now the mandatory default skill for Queue, History, playlist transport, Previous/Next, archival, plus-menu, and persistence reviews. The runner can regenerate its own local audio/video fixtures and isolated seed via `scripts/create-queue-history-seed.mjs`, so the full process no longer depends on retained historical artifacts or live user data.
- 2026-09-18 canonical proof: deleted the generated seed, recreated local MP3/MP4 fixtures and the isolated library from scratch, built, and passed the canonical wrapper 8/8 with rendered screenshots, restart persistence, zero renderer errors, protected-History checks, and unchanged fixture hashes. Evidence: `scripts/qa-artifacts/queue-history-canonical-proof/`.

📌 Team update (2026-09-18T14:19:38.738-07:00): `.squad/skills/queue-history-validation/SKILL.md` is the canonical mandatory default for Queue/History and playlist transport validation. Read and apply it before future approval work; use `scripts/qa-queue-history-run.ps1` as the stable entry point.

- 2026-09-18 independent 0.3.1 packaged release review: APPROVE PACKAGE / BLOCK STORE SUBMISSION. Recomputed NSIS `f76ed3a9b01c68e4c7a84e69f3ee9d752145d58610a421055fa444b634ad288d` and APPX `cbcc91acc5af14d23c6b41d5b862f35042533bdd383f433fe124de5265c32a6b`; both match provenance and `SHA256SUMS.txt`. Independently recomputed all 50 source entries and aggregate `7e49bbc60c68c4c535890d572bce32bcdfd5ce57b1758963a68c557e673d52cf` with zero missing, extra, or mismatched files.
- Installed the exact NSIS candidate to an isolated location and ran the Queue/History harness against that packaged executable. It passed 8/8 with rendered menu and History screenshots, natural-end and Next archival, newest-first History, navigation, migration/protection, restart persistence, and zero renderer errors. The named pipe was absent in a normal packaged launch and available only with `--enable-private-automation`.
- Independently inspected installed NSIS and APPX payload ASARs. Their ASAR hashes are identical, and every main/preload/automation/renderer hash matches provenance. APPX is locally correct at version 0.3.1.0, x64, Windows.Desktop full trust, with all required assets.
- Store submission remains blocked: APPX identity `KaraokeStudio` / publisher `CN=ms` are placeholders, and both artifacts are unsigned. Partner Center identity/signing configuration and a fresh full release are required. Evidence: `scripts/qa-artifacts/queue-history-packaged-0.3.1-tank-2026-09-18/`.

📌 Team update (2026-09-18T15:07:36.120-07:00): Before packaged QA or release approval, read and enforce `.squad\skills\full-windows-store-release\SKILL.md`. Source/build approval means ready to package, not complete; verify fresh artifacts, provenance, packaged behavior, signatures, and Store identity.

- 2026-09-18 initial Git setup review: APPROVE. Repository is an unborn `main` branch with 0 staged/index entries, commits, remotes, and tags. All 175 prospective files are unignored intentionally; none exceeds 1 MiB, and no generated release/package/model/profile/log/secret-named artifact is present. Representative private/generated paths are ignored, safe environment examples are explicitly reusable, required source/release/QA/Squad paths remain visible, and merge/line-ending/binary attributes are correct.

- 2026-09-18 cleanup safety review: APPROVE. Independently verified all 47 manifest targets are absent; the 45 repository targets were generated under ignored `release` or `scripts\qa-artifacts` trees and were empty, rejected, abandoned, or superseded, while the two external isolated install roots were empty and obsolete. No deleted target is referenced by active decisions or either canonical release/Queue-History skill.
- Recomputed the retained 0.3.1 NSIS and APPX hashes as `f76ed3a9b01c68e4c7a84e69f3ee9d752145d58610a421055fa444b634ad288d` and `cbcc91acc5af14d23c6b41d5b862f35042533bdd383f433fe124de5265c32a6b`. Provenance independently passed 50/50 with zero missing, extra, or mismatched files and aggregate `7e49bbc60c68c4c535890d572bce32bcdfd5ce57b1758963a68c557e673d52cf`; all six retained build-output hashes also match.
- Canonical 0.3.1 package evidence, Queue/History reports and rendered screenshots, reusable seed fixtures, release/runtime evidence, dist outputs, scripts, canonical skills, imported-fixture integrity records, and all 175 prospective Git candidates remain. Git has zero staged files and no deletion candidates. Manifest arithmetic exactly totals 21,489,598,424 bytes (20.014 GiB).

📌 Team update (2026-09-18T20:04:53.087-07:00): Tank's final independent verdict is APPROVE PACKAGE / BLOCK STORE SUBMISSION for the secret-safe 0.3.2 replacement. Package QA passed processing 7 suites, UI 9/9, recovery 5/5/90, Queue/History 8/8, Demucs 4/4, and isolation 3/3; the nine-scope scan found zero issues.

- 2026-09-18 processing-progress/scheduler review: REJECT. The latest combined source fails `npm run build`: `electron/main.ts:20,25` import missing exports and `electron/processing-domain.ts:85,109` illegally nest exported functions. Focused progress (27 assertions) and scheduler (17 assertions) scripts pass, but omit persistence-finalization failure injection: full, retranscription, and resumable paths set in-memory `complete`/100 before `saveLibrary`, and `ProcessingProgress` refuses to turn a completed item into an error. An executable probe reproduced a simulated library-save failure remaining `complete` at 100 with no error. Scheduler integration also keys jobs by `songId:component`, contrary to the one-slot-per-song decision, so process/retranscription requests for one song do not coalesce. Queue/History passed 8/8 with two rendered screenshots before the concurrent final source update; the final build failure prevents treating that earlier run as current-candidate approval. Rendered seeded failure UI evidence is retained at `scripts/qa-artifacts/processing-ui-tank-2026-09-18/processing-error-rendered.png`.
- 2026-09-18 expanded processing scope: HOLD pending a new implementation/reviewer handoff. Current source sketches durable per-deliverable outcomes, atomic file replacement, dependency planning, partial stage, exact retry IPC, and a visible component-labelled Try again action, but is not buildable or approvable. Constraints for the next review: completion must occur only after durable library persistence; scheduler identity must remain one slot per song across full/retranscription/retry; Demucs missing-stem and Whisper model-load failures need truthful component attribution; retained ready outputs must remain playable after sibling failure/restart; retry plans must rebuild only invalid prerequisites and affected dependents; and Library rows need an explicit double-click handler because single-click intentionally selects paused and same-song selection returns early.
- High-confidence additional retained candidates, not deleted: the unreferenced profile-only generated directories `scripts\qa-artifacts\2026-09-18T00-31-52.127Z`, `2026-09-18T00-34-03.328Z`, and `2026-09-18T00-35-34.301Z`; each has no report or approval evidence.

- 2026-09-18 independent processing recovery re-review: APPROVE after Neo's revision. A fresh build and all seven focused processing suites passed; rendered processing UI passed 9/9; a fresh canonical Queue/History rerun passed 8/8 with a visibly rendered unclipped Library plus menu, two retained Library songs, persistent Queue/History state, and zero renderer errors.
- True Electron/private-pipe runtime failure and restart coverage passed 5/5 with 90 assertions at `scripts/qa-artifacts/processing-failure-runtime-tank-rereview-2026-09-18/report.json`. Source preparation, missing `other` stem, Whisper, Enhanced, and durable library-save failures retained exact attribution and usable sibling outputs, released the one global slot, allowed the queued song to complete, persisted over restart, and recovered through the targeted component. Library-save stayed below 100% and recovered without repeating completed media work. Focused retry-plan tests separately proved minimal dependency-aware plans.
- Security review found no normal-launch exposure: packaged automation remains default-off; QA configuration requires the separate `--enable-private-qa-hooks` flag; runtime invocation with automation alone rejected `qa-configure`; and package/release launch configuration does not add the QA flag. No package was produced. Switch may run the mandatory full Windows release workflow.

- 2026-09-18 independent 0.3.2 replacement re-review: **APPROVE PACKAGE / BLOCK
  STORE SUBMISSION** after Neo's secret-safe revision. Recomputed NSIS
  `da92c3aa353e1bafcff25e02775ab52396e8becfdd5f3f1c1b71ad5ffa27e28b`,
  APPX `a6b43fb07778a9d05c7cfa3501452304d10756b47e29493888456c03a612f491`,
  and provenance `42a683ae733b4ff87ab466c29506641e42c8eb5b69b2bb9e3a0b346de55a7c45`.
  All 69 source hashes and aggregate
  `33fdc1c947c5d10dc4cfe5e238c9e7ff128e199074d1de0f6e4d799939fa414b`
  matched with zero differences.
- Independently reran the fail-closed scan over tracked release sources, NSIS installed
  image, APPX staging, packed ASARs, unpacked files, and extracted APPX contents.
  Canonical nine-scope totals exactly matched 24,697 entries, 22,939 files, 21,030
  text-like files, and 8,140,773,108 bytes with zero findings. A rejection probe proved
  output is limited to path and SHA-256, never matched values. The dependency `.env`
  remains Git-ignored and is absent from every shipped view.
- FFmpeg, Demucs, Transformers/Whisper, and Windows x64 ONNX Runtime requirements
  remain packaged. Fresh package-backed QA passed seven focused processing suites,
  rendered UI 9/9, failure/restart 5/5 with 90 assertions, Queue/History 8/8, Demucs
  4/4, and automation isolation 3/3. Imported sources and evidence were unchanged.
  Store submission remains blocked by placeholder APPX identity/publisher and unsigned
  artifacts. Evidence:
  `scripts/qa-artifacts/processing-packaged-0.3.2-tank-rereview/tank-verdict.json`.

- 2026-09-18 timestamp-normalization re-review after Neo's independent revision:
  APPROVE. Fresh build and focused suites passed: timing 33, processing UI 21,
  resume 31, resources 24, artifacts 9, scheduler/progress, runtime recovery 6/6
  with 110 assertions, rendered UI 9/9, and Queue/History 8/8.
- Every prior rejection was closed: malformed text no longer displaces sorted early
  valid lyrics, no-gap Unicode text is merged without loss, 30/39ms expand while
  40ms stays unchanged, and sorting/overlap/expansion/fallback/merge/discard counters
  report independently. The installed `76.76–101.72` containment regression clamps
  exactly to `76.76–80.38` before `80.38–85.78`; boundary-zero, consecutive,
  constrained, duration-bound, Unicode, and globally unusable cases all passed.
- Partial audio, one-slot FIFO continuation, restart recovery, targeted lyrics-only
  retry, and Queue/History behavior remained correct. Four fresh screenshots were
  visibly rendered and nonempty at 309,322, 334,158, 312,744, and 279,871 bytes;
  capture readiness requires a complete visible root, positive dimensions/children,
  two animation frames, and a nonempty NativeImage. Evidence is under
  `scripts/qa-artifacts/transcription-timing-tank-rereview-{runtime,ui,queue}-2026-09-18/`.
  No package was produced; Demucs remains a separate pending fix.

- 2026-09-18 final Demucs inference review: APPROVE for Switch packaging. The root
  cause is confirmed as prototype-only construction skipping Demucs class-field
  initialization; no tracked vendored dependency file is edited. Fresh build passed,
  followed by inference 14/14, supplemental boundary 6/6, resources 24/24, resume
  31/31, artifacts 9/9, real short/trailing Demucs 18/18, failure/restart 6/6 with
  110 assertions, transcription timing 33/33, and Queue/History 8/8.
- The retained anonymized real-library report proves 16/16 files were attempted and
  passed sequentially, yielding 64/64 nonempty decodable duration-exact stems with
  unchanged source hashes/timestamps and no private paths or descriptive metadata.
  A fresh packaged subset independently passed 2/2 files and 8/8 stems under the
  sequential CPU half-core policy with no partial publication or source mutation.
- Current installed 0.3.2 is independently confirmed stale: its ASAR hash matches the
  retained proof, it still uses prototype-only construction, reproduces the
  uninitialized-sources failure, and publishes zero stems. The fixed isolated package
  uses the validated boundary, initializes four sources, validates names/shapes, and
  releases the ONNX session. Exact component attribution, FIFO continuation, restart
  persistence, and targeted Demucs retry all passed. No package was produced by Tank.

- 2026-09-19 persisted retry availability review: APPROVE source/runtime behavior,
  pending a fresh Switch release because the rendered-DOM harness changed after the
  current provenance was generated. The compatibility merge adds a normalized
  top-level failure only when its component is absent from derived deliverable issues,
  preserving current-schema deduplication and exact Demucs targeting.
- Fresh build passed; processing UI passed 24/24, resumability 31/31, scheduler
  coverage passed, rendered DOM passed 10/10 with zero renderer errors, and failure
  runtime passed 6/6 scenarios with 113 assertions. A first concurrent rendered run
  timed out; its recursive cleanup completed, and an isolated rerun passed fully.
- The same anonymized previously failed source independently completed through the
  packaged rendered Try again action. Duplicate clicks coalesced and disabled/removed
  the action, all four stems were decodable and duration-exact at 198.089433 seconds,
  all playback modes became ready, failure and scheduler state cleared, restart
  persistence passed, and the source hash and timestamp remained unchanged.
- Screenshot removal from the focused harness is accepted: it retains real rendered
  DOM snapshots, real UI clicks, exact disabled-state checks, playback behavior, and
  renderer diagnostics. Electron capture remains available but unreliable in this
  environment; the harness no longer treats capture failure as product failure.
  Reports contain no private source path, title, or artist, and packaged automation is
  still unavailable without its explicit flag. Switch must rebuild NSIS/APPX and
  provenance from the unchanged approved product source plus the current harness.

- 2026-09-19 final frozen 0.3.3 review: **APPROVE PACKAGE / BLOCK STORE
  SUBMISSION**. Independently recomputed NSIS
  `04d9c06191ea28fefbdd4cfa5f809aa05ab3b9606dad001ce64cfe801ee9e6f8`,
  APPX `fe78e626287096a16111d937c722d70d255bf0ec0749e267a2e66dcacf175a09`,
  and provenance
  `fecd4474affcc053016482b1d4ed2dc56e62ba1412eb12ab313d32b11fac0048`.
  The 77-file source/harness aggregate remains
  `c5975f34e39fa9ce8306df033bf917815bc4f2018d8bbbcefb8dd2eeb4fcbb5f`
  with zero missing, extra, or mismatched files. Current build outputs matched the
  packaged ASAR byte-for-byte; payload EXE/ASAR hashes remain
  `68f68cade5eef50593646ae2f205b351a251108587ad0cda6b4c5d62247fe3b5`
  and `ad142508e73179857f11da30f152440c3df56a00014f2eaa180235d5546fa707`.
- Fresh secret rescans of current staging and extracted APPX payload passed all six
  tree/packed-ASAR/unpacked-ASAR scopes with zero findings, matching the provenance
  nine-scope zero-finding result. Timing reran 33/33. Post-freeze packaged gates passed
  rendered 10/10 with two visually reviewed nonempty app-only screenshots, runtime
  6/6/113, Queue/History 8/8 with two nonempty screenshots, and Demucs 4/4. Automation
  isolation remained 3/3. The exact-payload real failed-Music retry retained 4/4
  duration-exact stems, restart persistence, and unchanged source hash/timestamp; all
  16 authorized private sources still match their baseline hashes, sizes, and times.
- APPX inspection confirmed version 0.3.3.0, x64, full-trust `runFullTrust`,
  application ID `KaraokeStudio`, executable `app\Karaoke Studio.exe`, readable
  payload, and all four required assets. Store submission remains blocked because
  identity `KaraokeStudio` and publisher `CN=ms` are placeholders and both artifacts
  are unsigned. No rebuild, signing, submission, commit, or push occurred.

📌 Team update (2026-09-19T02:52:27.047-07:00): Tank's lyric, Demucs, retry, and final frozen 0.3.3 approvals are canonical. Authoritative NSIS/APPX/provenance hashes are `04d9c061...`, `fe78e626...`, and `fecd4474...`; Store remains blocked and no commit/push occurred.

- 2026-09-19 live microphone monitor review: **APPROVE source validation with explicit
  physical-latency and hardware-unplug gaps**. Fresh build, microphone 51/51, rendered
  CDP evidence, and Queue/History 8/8 passed. The actual default capture/output path was
  exercised in an isolated profile starting muted, then at 4% player volume
  (approximately 0.01 monitor gain): 48 kHz context/capture, two applied input channels,
  DSP off, 10 ms base latency, 32 ms output latency, and a 42 ms output-only estimate.
  Playback, pause, and Vocal mode switching retained one monitor graph. All 25 toggle
  cycles reached one live track/context on and zero on off; pagehide, reload, and close
  also left zero live resources, with zero renderer errors. Permission denial and track
  end were simulated and recovered/released correctly. No Bluetooth or headphone-named
  endpoint was detected, so safe speaker monitoring and physical round-trip latency are
  not claimed. Evidence:
  `scripts/qa-artifacts/microphone-real-device-tank-2026-09-19/report.json`.

📌 Team update (2026-09-19T09:56:19.057-07:00): Tank's live microphone verdict is canonical source approval only: physical wired round-trip and physical unplug remain manual, Bluetooth is excluded, and no safe speaker-monitoring or release claim is permitted.
