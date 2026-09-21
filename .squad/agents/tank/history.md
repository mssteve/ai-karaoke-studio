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

- 2026-09-20 independent 0.3.4 package review: **APPROVE PACKAGE / BLOCK STORE
  SUBMISSION**. Recomputed NSIS
  `e9f4775c3c4f5cbb99012ac21714f1b11abc0636f18cda6ec4c326f14c61368f`
  (495,696,916 bytes), APPX
  `c61596c29a0306bb83b65311dcfb6682a28ee9e8b82826b9292ffc1252778a37`
  (665,535,423 bytes), provenance
  `aace0887a8b70aed429a80d1f4c0f3e51a6ee2acc9ec453c4037c34be9bd0b5f`,
  and Switch evidence
  `4f40b3275cd7141ac70e09828dab7392aeeb4d1bb3adb579bf77abc510add36a`.
  The current 82-file release source set independently reproduced aggregate
  `8495bf0c21d4dbb0aff02f2d8a2620a0227e0a2a3715fc8aaa468cd645b64b81`
  with zero missing, extra, or mismatched entries.
- Fresh nine-scope fail-closed scanning checked 24,716 entries, 22,958 files,
  21,049 text candidates, and 8,141,095,372 bytes with zero findings. NSIS,
  staging, and APPX ASARs were identical; no audio media was embedded. Packaged
  main/preload/automation/renderer hashes matched provenance, and inspection
  confirmed direct interactive Web Audio monitoring, strict trusted-origin
  audio-only permissions, required AI dependencies, APPX 0.3.4.0 x64
  `runFullTrust` plus `microphone`, all four Store assets, and default-off
  automation.
- Independent package-backed reruns passed microphone 51/51, real default-device
  low-gain toggling 25/25 with zero surviving candidate processes, rendered
  microphone UI, processing unit suites, runtime recovery 6/6/113, rendered
  processing 10/10 with two reviewed screenshots, timing 33/33, Queue/History
  8/8 with two reviewed screenshots, Demucs 4/4, retry binding, and automation
  isolation 2/2. Prior canonical device telemetry remains an output estimate
  only: 48 kHz context/capture, two channels, DSP off, 10 ms base plus 32 ms
  output latency (42 ms displayed estimate). Physical round trip and physical
  unplug remain unmeasured; wired headphones are required and Bluetooth is
  excluded.
- Store submission remains blocked by placeholder identity `KaraokeStudio` /
  publisher `CN=ms` and unsigned NSIS/APPX artifacts. No rebuild, signing,
  submission, commit, merge, or push occurred.

- 2026-09-20 microphone audibility escalation: the 0.3.4 package approval above is
  **revoked; REJECT PACKAGE**. The shipped renderer proves only an active track/context
  and directly computes monitor gain as `playerVolume * 0.25`. At player volume zero
  the destination receives zero signal while the UI can still report Mic live; the
  prior 4% package exercise used gain 0.01 (about -40 dB) and therefore did not prove
  audible monitoring. The package contains no analyser telemetry, sink identity, or
  browser mute/audibility checks.
- Added a fail-closed real signal-path gate requiring confirmed wired headphones,
  above-threshold input RMS/peak, proportional nonzero post-gain RMS/peak, running
  context, live/unmuted track, system-default sink, unmuted/audible web contents, and
  gain independent of song volume. The source revision uses dedicated 0.35 gain and
  transient analyser telemetry only; build and 74 deterministic checks pass. Real
  output testing was not run because wired headphones were not physically confirmed,
  and the gate correctly refused to start. Replacement source remains HOLD pending
  that safe real-device run, full regressions, and a fresh monotonic package.

- 2026-09-20 source follow-up: the safe real-device signal gate passed. The default
  microphone produced input peak `0.016068` and proportional post-gain peak `0.005624`
  at exact ratio `0.35`; context was running, the 48 kHz track was live/unmuted,
  default output was selected, and Electron reported unmuted/currently-audible output.
  Build, microphone 74/74, rendered validation, and Queue/History 8/8 passed.
  Replacement source is approved. Existing 0.3.4 packages and provenance remain
  invalid, and no package/release action is authorized.

- 2026-09-20 corrected 0.3.4 replacement review: **APPROVE PACKAGE / BLOCK STORE
  SUBMISSION**. Independently recomputed NSIS
  `78c5ded12345deae386d60ce9a65133887aa2ca2e608d2d90e6423ad6537e31c`,
  APPX `bf0b4b728487ab64d843690a1375e7ddb490840c2f4684ccfe128f894ccafd80`,
  ASAR `7965dd13722f1536be38d3a2a6e9e66eb5832e4d6139a695764293b3dc7240c0`,
  and provenance
  `89d386cea9259671afe33e881db361c578924a82cb33c4fd30f4d76b518d0f76`.
  Source provenance passed 83/83 with aggregate
  `39510f9f2cf10349b079eb0824d571e67667ddff1575795a777c4ca7c5985515`
  and zero differences; fresh package scanning found zero secret findings.
- Fresh package-backed microphone telemetry at song volume zero measured input
  RMS/peak `0.004000` / `0.004044`, post-gain RMS/peak `0.001400` / `0.001415`,
  and peak ratio `0.349901`. The 0.35 graph remained independent at minimum song
  volume, with a running context, live/unmuted 48 kHz track, default sink,
  unmuted/currently-audible web contents, concurrent music, 25 toggles, reload/close
  cleanup, and zero renderer errors. Human hearing and physical round-trip remain
  explicitly unclaimed.
- Fresh regressions passed microphone 74/74, Queue/History 8/8, processing retry
  6/6/113, rendered processing 10/10, timing 33/33, Demucs 4/4, and automation
  isolation 3/3. APPX 0.3.4.0 is x64 with all four assets and exactly
  `runFullTrust` plus `microphone`. The rejected `f6662f...` ASAR is superseded.
  Store submission remains blocked by placeholder `KaraokeStudio` / `CN=ms`
  identity and unsigned artifacts. Evidence:
  `scripts/qa-artifacts/release-0.3.4-tank-final/release-verdict.json`.

- 2026-09-20 Trinity invalidation notice: the fixed 0.35 design is superseded by an
  adjustable independent 0–4 monitor level with a 2.0 default, immediate live GainNode
  updates, explicit mute-at-zero, pre/post meters, and too-hot/clipping warnings. Fresh
  default-device telemetry measured input RMS/peak `0.003873` / `0.003922` and default
  output `0.007747` / `0.007843`; 4.0 remained below clipping, level zero produced zero
  monitor output, and music remained playing independently. All prior 0.3.4 artifacts,
  hashes, provenance, and package verdicts are invalid. No package/release/install is
  authorized.

- 2026-09-20 adjustable microphone independent review: **APPROVE SOURCE** and release
  ready for a fresh rebuild/install. Fresh build, microphone 95/95, rendered CDP, and
  Queue/History 8/8 passed. Real-device testing covered 0%, 100%, 200%, and 400% at
  song volumes 0 and 82% while music remained playing; measured peak ratios were 0,
  1.000, 1.997–2.000, and 4.013 with no clipping. A separate default-level window
  measured input/output peaks `0.002930` / `0.005859` (2.0 ratio, -44.6 dBFS output),
  12.3 dB above the rejected 0.35-gain output. The 48 kHz context was running, the
  48 kHz track live/enabled/unmuted with DSP off, and the system-default sink was used.
  Twenty-five toggle cycles, permission retry, synthetic track-ended retry, pagehide,
  reload, and close cleanup passed with zero renderer errors.
- Source inspection confirmed the minimal analyser/gain graph, bounded immediate live
  gain changes, independent song volume, intentional mute, accessible meters/dBFS and
  diagnostics, and no recording, persistence, upload, limiter, or buffered processing.
  The displayed 50 ms is only an output estimate. Human audibility, physical wired
  endpoint identity, physical unplug, and physical round-trip latency remain unclaimed.
  All earlier 0.3.4 binaries and evidence remain invalid. Fresh evidence:
  `scripts/qa-artifacts/microphone-adjustable-tank-fresh-2026-09-20/report.json`,
  `scripts/qa-artifacts/microphone-signal-tank-fresh-2026-09-20/report.json`,
  `scripts/qa-artifacts/microphone-monitor-rendered-fresh/`, and
  `scripts/qa-artifacts/queue-history-fresh/report.json`.

- 2026-09-20 final 0.3.4 package review: **APPROVE PACKAGE / BLOCK STORE
  SUBMISSION**. Independently recomputed final hashes
  `c02065bca43d6d3f41a56760a9a38ee59b9c6329ab24b57a27c12fa1554ee59e`
  (NSIS) and
  `5bab9405d93bb2a8773948926a202ee30d09e9c1598399d6dcd4c845297a1551`
  (APPX), matching provenance and `SHA256SUMS.txt`.
- Package evidence passed microphone 95/95, rendered controls/meters, real gain ratios
  0/1/2/4 at player volumes 0 and 82% with concurrent music, 25/25 cleanup cycles,
  permission and device-ended recovery, Queue/History 8/8, processing retry 6/6 with
  113 assertions, rendered processing 10/10, timing 33/33, Demucs 4/4, automation
  isolation 3/3, and private-source integrity 16/16 with zero differences. Exact
  staging/APPX payload comparison matched 553 files and source provenance matched all
  83 entries; nine secret-scan scopes had zero findings.
- No package QA blockers remain. Store submission is blocked by placeholder
  `KaraokeStudio` / `CN=ms` identity and unsigned artifacts. Physical audibility,
  wired endpoint identity, physical unplug, and physical round-trip latency remain
  unclaimed. Authoritative evidence:
  `scripts/qa-artifacts/release-0.3.4-final-approved/release-verdict.json`.

📌 Team update (2026-09-20T10:27:28.056-07:00): Tank's final 0.3.4 package approval is canonical. Installation preserved library/playlists/processed data, live music+mic ratio was approximately 2, and cleanup passed. Normal app PID 26988 remains running with Mic OFF and automation disabled; Store submission remains blocked.

- 2026-09-20 release/deploy automation independent re-review: **REJECT** despite deploy
  QA 61/61, clean build, packaged Demucs 4/4, and passing syntax/diff checks. Real
  default dry-run and stale `--zip` both exited 3 on dirty source and preserved all 854
  inventoried release/ZIP/lock/install/user-data files byte- and timestamp-identically.
- Approval authorization remains forgeable: an ignored/untracked, self-written envelope
  claiming Tank was accepted using arbitrary 999/999 assertions against a tracked clean
  history file. The envelope itself is not required to be tracked/clean, and referenced
  evidence content is not parsed to bind reviewer, verdict, counts, or timestamps.
- Low-level packaging authorization also remains forgeable/replayable: an attacker-created
  lock and matching environment passed the ownership gate; a nonexistent stale PID passed;
  and two concurrent invocations replaying the same token both passed. The code compares
  caller-supplied values but does not prove lock liveness/start time or actual OS parentage.
- Approval/evidence paths also lack a reparse-point and canonical real-path containment
  check. No Tank approval was created and no real build-to-ZIP exercise is authorized.
  Full decision: `.squad/decisions/inbox/tank-release-deploy-automation.md`.

- 2026-09-20 release/deploy integrity follow-up: **REJECT**. The revised deploy suite
  passed 98/98, build passed, Demucs boundary/runtime passed 14/14 and 18/18, and syntax
  plus diff checks passed. Real default dry-run and stale `--zip` both exited 3 before
  mutation; all 1,402 inventoried release, ZIP, lock, install, user-data, and
  representative source files retained identical bytes and timestamps.
- Prior capability, lock-token, approval-chain, trailer, committed-evidence, and
  reparse checks are substantially closed. One authorization blocker remains:
  `readReviewerPolicy` accepts an ambiguous reviewer registry because it selects the
  first matching identity without enforcing unique reviewer identities or unique
  allowed committer identities. A direct fixture with two conflicting `Tank` entries
  still passed valid two-commit approval validation. Neo must own the next revision;
  no approval record or release action is authorized.

- 2026-09-20 fresh reviewer-registry final gate: **APPROVE IMPLEMENTATION / RELEASE
  APPROVAL NOT YET AUTHORIZED**. The former two-conflicting-`Tank` exploit now fails
  closed before reviewer selection. Focused registry attacks passed 17/17, including
  identical/conflicting/case/whitespace duplicates, reviewer and committer name/email
  collisions, cross-reviewer committer aliases, conflicting trailer mappings, malformed
  email, absent/modified/untracked registry, and one clean canonical Tank acceptance.
- The complete deploy suite passed 114/114. Build, syntax, diff checks, Demucs boundary
  14/14, and real Demucs runtime 18/18 passed. The suite also reconfirmed arbitrary
  importer denial, argv/environment mutation denial, copied/renamed/wrapper/path-mimic
  rejection, missing/wrong/forged/replayed lock capabilities, PID/start-time/parent
  identity checks, atomic one-use consumption, exact trailers, two-commit approval
  ancestry, and committed evidence binding.
- Real default dry-run and stale `--zip` each exited 3 against the intentionally dirty
  source. Independent before/after SHA-256, byte-length, and UTC timestamp inventory
  covered 1,668 release, ZIP, lock, install, user-data, and changed-source entries with
  zero differences for either command. No lock/capability/staging residue remained.
- The new `.gitignore` entries are root-scoped disposable lock, capability, staging,
  backup, and QA scratch paths. Release/deploy implementation, QA, reviewer registry,
  approval paths, skills, README, and package metadata remain visible. Reviewer policy
  content contains only synthetic `Tank`/maintainer identities and no secret material.
  Because the implementation remains uncommitted, no schema-2 source-bound approval
  evidence was created and no package/install/commit/push/merge or artifact deletion
  was performed.

- 2026-09-20 canonical source-identity re-review: **APPROVE IMPLEMENTATION / RELEASE
  APPROVAL NOT AUTHORIZED**. Reproduced the real failure exactly: the legacy approval
  inventory was 97 files with aggregate
  `2bcb7400da2b47ed99cb01b4b512a9547f044755a4f8c6461809d5745faf75f1`,
  while the filesystem inventory was 99 files because ignored `src/types.js` and
  `src/types.js.map` were included; 63 tracked files also differed only by CRLF checkout
  representation.
- The revised shared `git ls-tree`/blob snapshot accepted a clean CRLF checkout while
  retaining canonical blob bytes, excluded both ignored generated files despite content
  changes, and passed 15/15 independent source attacks covering unstaged/staged edits,
  deletion, rename, path case, file-to-directory, untracked shadow, `.gitattributes`,
  hardlink, junction, Git symlink/gitlink modes, sorting, and determinism. Native file
  symlink creation was unavailable without Windows Developer Mode; junction and Git
  mode attacks failed closed.
- Full deploy QA passed 123/123. Build, syntax for 3 changed modules, `git diff --check`,
  Demucs boundary 14/14, and real Demucs runtime 18/18 passed. Built-output secret scan
  covered 33 files and 628,055 bytes with zero findings. Default and explicit dry-runs
  each exited 3 and preserved all 1,407 inventoried release/ZIP/lock/install/user-data/
  changed-source entries with zero hash, size, timestamp, type, or membership changes.
- Historical approval `bcbbb339` remains in Git with sole parent `53a628e`; its obsolete
  97-file identity differs from the revised canonical 98-file target identity
  `0ca712daf26bdb6508c37cce807c9b3237b6ebe8ab2fb59da7ec7f78c958591f`.
  Forward working-tree deletion of the obsolete approval/evidence therefore fails closed
  and cannot authorize the revised source. No packaging, ZIP, install, approval
  generation, commit, push, merge, tag, or release-artifact deletion was performed.

- 2026-09-20 approval checkout-normalization re-review: **REJECT**. The intended LF
  blob/clean CRLF checkout behavior passed and canonical blob hashes differed from raw
  checkout hashes as required. The shipped focused cases passed 10/10 and full deploy
  QA passed 132/132, but two independent Windows attacks bypassed the new gate.
- `scripts/release-artifact-verification.mjs:144` treats the literal attribute values
  `filter=unspecified` and `filter=unset` as though the filter were absent. A configured
  `filter.unspecified.clean` that emits the committed approval blob made a tampered
  checkout pass `git diff` and `validateApproval`.
- `scripts/release-artifact-verification.mjs:191-192` checks only Git's tracked path
  spelling, not the physical directory-entry spelling. Renaming the approval file
  case-only from `tank.json` to `TANK.JSON` left Git clean and `validateApproval`
  accepted the alias on Windows.
- Build, syntax for 3 changed modules, `git diff --check`, Demucs 14/14 and 18/18, and
  the 33-file/628,055-byte built-output secret scan otherwise passed. Real default and
  stale `--zip` dry-runs each exited 3 and preserved all 1,405 inventoried files with
  zero hash, size, timestamp, type, or membership changes; no lock/capability remained.
- Historical approval commit `48cfb8f` and parent `a28111a` remain intact, while both
  rejected files are deleted only forward. The old evidence hash binds CRLF checkout
  bytes and fails the revised canonical-blob hash check, so it cannot authorize the
  revision. Neo owns the next revision; Cypher is locked out.

- 2026-09-20 approval attribute/path re-review: **REJECT**. Neo's revision closes both
  originally reported approval/evidence bypasses: the sentinel-named clean-filter
  concealment now fails, and case-only approval/evidence file and parent-directory
  renames fail exact physical component checks. Focused approval QA passed 31/31 and
  full deploy QA passed 152/152.
- A release-source variant remains open. `assertProtectedWorktree` at
  `scripts/release-artifact-verification.mjs:596-598` trusts attribute-aware `git diff`
  for every protected source, but `.gitattributes` explicitly disables transforms only
  for JSON and `.gitattributes`, not `.mjs`, `.ts`, or other build inputs. Adding
  `src/main.ts filter=unspecified` to `.git/info/attributes`, configuring
  `filter.unspecified.clean` to emit `HEAD:src/main.ts`, and tampering the checkout made
  `git diff --quiet` return zero and `snapshotProtectedSources` accept the canonical
  snapshot while a build would consume attacker bytes.
- Additional attacks passed for global/system sentinel driver configuration, macro
  expansion, CRLF-versus-semantic JSON changes, trailing-dot/space names, Unicode
  normalization/lookalikes, ADS, hardlinks, junctions, index/tree identity, containment,
  and file/directory changes. Native symlink creation required unavailable Developer
  Mode; 8.3 availability could not be queried without elevation.
- Build, syntax/diff, Demucs 14/14 and 18/18, and secret scan of 33 files / 628055 bytes
  passed. Default and `--zip` dry-runs exited 3 and preserved 1689 entries with zero
  differences. Historical `48cfb8f` and its two rejected blobs remain intact and deleted
  only forward. No release mutation or repository-history operation occurred. Apoc owns
  the next revision; Neo is locked out.

- 2026-09-20 protected-source physical-byte re-review: **REJECT**. Apoc closed the
  reported `.git/info/attributes` plus sentinel clean-driver concealment: the exact
  `filter=unspecified` attack leaves Git clean but now fails before snapshot/build.
  Expanded focused attribute/path attacks passed 49/49 and full deploy QA passed
  165/165. Build, syntax/diff, Demucs 14/14 and 18/18, and the built-output secret scan
  (33 files, 628055 bytes, zero findings) passed.
- A practical source-to-build TOCTOU remains at `scripts/release.mjs:302,343,393`.
  The workflow snapshots physical source, later builds from the mutable worktree, and
  only snapshots again after packaging. In an isolated exact-source fixture, replacing
  `src/main.tsx` after the first snapshot, building, restoring its original bytes and
  timestamp, then taking the second snapshot produced identical complete snapshots
  while the renderer bundle retained attacker bytes. Thus actual build bytes can
  diverge from the approved source despite both gates passing.
- Real default and stale `--zip` dry-runs exited 3 with zero inventoried mutations and
  no lock/capability residue. Historical `48cfb8f` and both rejected blobs remain intact
  and forward-deleted; current validation rejects them. No package, ZIP, install,
  approval, commit, push, merge, tag, reset, amend, rewrite, or release-artifact
  deletion occurred. Trinity owns the next revision; Apoc is locked out.

- 2026-09-20 canonical staging re-review: **REJECT**. Git-object source staging closes
  the original live-worktree renderer TOCTOU: the real build test restored
  `src/main.tsx` bytes/mtime, retained equal staged snapshots, and found no live
  sentinel in staged renderer output. Full deploy QA passed 167/167.
- A practical dependency TOCTOU remains at
  `scripts/release-source-staging.mjs:103,200-211` and
  `scripts/release.mjs:386-395`: staging junctions the mutable live `node_modules`,
  excludes it from canonical snapshots, and does not bind dependency bytes to the
  approved lockfile before or after phases. After the canonical precheck, Tank modified
  `node_modules/vite/bin/vite.js`, ran the real staged build, restored exact dependency
  bytes and mtime, and obtained equal canonical snapshots while the staged renderer
  bundle contained the injected sentinel. The current workflow would hash and package
  that output rather than abort.
- Build, syntax/diff, Demucs 14/14 and 18/18, and built-output secret scan (33 files,
  628055 bytes, zero findings) passed. Default and stale `--zip` runs exited 3.
  `release-source-staging.mjs` is narrowly unignored/trackable. Historical `48cfb8f`
  remains intact and unusable; rejected evidence remains forward-deleted. No release,
  ZIP, install, approval, commit, push, merge, tag, rewrite, or user-artifact deletion
  occurred. Trinity is reviewer-locked; Neo owns the next revision.
