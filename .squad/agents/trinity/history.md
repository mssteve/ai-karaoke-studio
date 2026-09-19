# Trinity History

## Project Context

Karaoke Studio is a professional Windows karaoke desktop app. Requested by Steve.

## Learnings

- Renderer playback must treat song changes differently from mode changes: selecting a song resets the timeline, while switching among original, enhanced, vocal, and instrumental preserves position and resumes playback after metadata loads.
- Mode changes now snapshot playback position and intent before React replaces the audio element. Keying the element by song, mode, and source isolates stale metadata events, while a persistent playback-intent ref preserves pause/play state across rapid switches and metadata clamping handles shorter replacement sources.
- Library rows cannot be buttons containing remove buttons. Using keyboard-focusable listbox options preserves row selection and makes the nested remove action valid and accessible.
- The preload `.cts` source cleanly emits `dist-electron/preload.cjs`; its seven invoke channels and two event channels match the main-process registrations.
- Desktop automation commands need renderer-side validation so unknown song IDs, unavailable modes, invalid seeks, and rejected playback promises become visible, logged errors rather than stale UI or unhandled rejections.
- Private named-pipe automation is safe for release QA only when packaged launches require an explicit support flag; development remains enabled for local tooling.
- The QA fixture dialog is gated by the same private automation switch and proves the real rendered Add songs button, preload bridge, and main import handler path through an invocation counter rather than bypassing the UI with direct add commands.
- Stable `data-testid` selectors let the no-port QA harness exercise selection, seeking, playback, mode buttons, and removal through the rendered Electron UI.
- The final revision independently replaced fixture-only dialog automation with the real rendered Add Songs path and Windows common file dialog, while preserving production gating for the private QA surface.
- Packaged automation is disabled by default and enabled only with `--enable-private-automation`; both normal and automation-enabled packaged process trees were verified to own no listening TCP endpoints.

📌 Team update (2026-09-17T17:23:31.480-07:00): The repaired renderer/preload and real UI automation paths passed the final approved packaged release gates — decided by Neo, Trinity, Morpheus, Tank, and Switch.

- 2026-09-17 seamless-mode sprint: implemented initial timestamp-preserving mode changes, but Tank rejected playing continuity after observing a 0.70s→0.20s backward jump. Reviewer lockout was enforced and the implementation was handed to Neo for an independent revision.

📌 Team update (2026-09-17T21:23:57.955-07:00): Trinity's initial implementation established the mode-switching path but did not pass the playing-continuity gate; ownership transferred under reviewer lockout.

📌 Team update (2026-09-17T22:55:03.579-07:00): The rebuilt installed app passed Demucs and real-song regression without renderer or audio changes; only dependent package unpacking changed.

- 2026-09-18 playlist integration implemented Neo's persisted FIFO contract across Electron and renderer: immutable Queue, named playlist lifecycle, duplicate entry identity, removal cascade, cursor restoration, accessible song menus, natural-end coordination, mode fallback, and private automation state.
- Morpheus's detected transcription language now hydrates and persists as `languageCode`, `languageName`, and `languageSource`, while legacy songs migrate in memory to `und` / `Unknown` / `legacy`.
- AI Studio navigation was removed. Lyrics use controller time, clear selection-bound refs, expose no line in timing gaps, retain the final line through media duration, and display original-language metadata without translating Unicode.
- Clean build passed. Focused Electron QA proved navigation removal, language/Unicode persistence, bidirectional lyric seek, song reset versus mode preservation, FIFO duplicates, removal order, restart cursor at paused 0:00, source integrity, and zero TCP listeners. Short synthetic media exposed intermittent end-event timing in the focused harness; no playback-controller code was changed.
- 2026-09-18 Tank's first independent playlist run rejected 12/16: legacy APPDATA transcripts were pre-detector ASCII files, a pre-canplay seek was overwritten when the menu rerendered, and mode-duration races sought beyond shorter vocal media.
- Follow-up fixes keep logical seek time authoritative through delayed canplay, report a song/mode only after that exact source is ready, and treat a genuinely playing near-end media stall as completion while excluding exact manual seek-to-end. The menu side-effect gate then passed.
- Both legacy APPDATA songs were retranscribed with the built Morpheus detector as Chinese (`zh`) Unicode; prior library/transcript files were backed up under `scripts/qa-artifacts/transcript-migration-verification`.
- Tank's fourth independent rerun approved 16/16 gates. It proved detected Chinese/Unicode persistence, seek/lyrics behavior, exact song reset and mode preservation, side-effect-free menus, FIFO duplicates, one natural-end advance with auto-play, removal/cursor rules, restart paused at 0:00, last-entry/empty behavior, unchanged source hashes, zero TCP listeners, and no renderer errors. Canonical report: `scripts/qa-artifacts/playlist-language-neo-ready-run4-2026-09-18/report.json`.
- Final integration restored `aria-selected` on stable song options for the existing mode harness, captured the rendered authoritative clock during mode clicks, and bounded playing-switch handoff latency without changing paused timestamps.
- Final local regression approved playlist/language 16/16 at `scripts/qa-artifacts/playlist-language-final-integrated-2026-09-18/report.json` and mode switching 5/5 at `scripts/qa-artifacts/mode-switching-playlist-regression-final-2-2026-09-18/report.json`.
- Tank independently approved the final remediation 16/16 after a fresh clean build, including original-language Unicode, menu invariance, mode preservation, FIFO natural-end auto-play, removal/cursor behavior, restart, and empty/last-entry rules. Canonical independent evidence: `scripts/qa-artifacts/playlist-language-remediation-final-2026-09-18/report.json`.

📌 Team update (2026-09-18T09:32:50.972-07:00): Trinity's 0.3.0 playlist integration is approved: AI Studio removal, Add to playlist menus, persistent Queue/named playlists, duplicate-safe FIFO, song reset, lyric synchronization, and final-ended behavior passed the final runtime gates — decided by Neo, Trinity, Morpheus, Tank, Switch, Cypher, and Apoc.

📌 Team update (2026-09-18T14:19:38.738-07:00): Before implementing or handing off Queue/History, Previous/Next, plus-menu, archival, persistence, or playlist transport changes, read `.squad/skills/queue-history-validation/SKILL.md`; it is the canonical validation contract.

📌 Team update (2026-09-18T15:07:36.120-07:00): Before release handoff for any approved user-facing or shipped renderer/Electron change, read `.squad\skills\full-windows-store-release\SKILL.md`. Build/source QA is not completion; hand off unchanged approved sources for fresh NSIS/APPX and packaged review.

- 2026-09-18 detailed processing UX: the selected-song AI card now renders Morpheus's schema-versioned items as a compact, scroll-bounded checklist. Pending, active/indeterminate, complete, and error states remain distinct; Demucs exposes all four stem states; measured backend messages retain chunk/media units; and honest indeterminate work shows elapsed time without an item-level fake percentage.
- Renderer progress merging rejects older `updatedAt` events and prevents overall regression within the same `startedAt` run, while allowing a newer retry generation to reset. Focused QA covers those guards and presentation helpers. `npm run build` and `npm run qa:processing-progress` pass.
- 2026-09-18 component recovery UX: partial songs now preserve every ready playback mode, disable only unavailable modes with screen-reader reasons, render exact failed versus dependency-blocked deliverables, and expose per-component targeted retry actions with local duplicate suppression plus FIFO queue/active feedback. Lyrics failures stay inside the lyrics panel without interrupting audio. Enhanced success exposes a compact EBU R128 output/gain summary and the backend caveat without claiming restoration.
- Library single click remains select-only and paused; double click always detaches from playlists, switches to Original, seeks exactly 0:00, and starts playback even for the already-selected song. Row controls explicitly isolate double-clicks. Private rendered automation gained a double-click primitive and isolated pipe override for deterministic evidence.
- Fresh build passed. Deterministic QA passed processing UI 21 checks, resumability 30 checks, artifacts 9 checks, scheduler coverage, progress coverage, enhancement FFmpeg coverage, and rendered UI 9/9 with two screenshots under `scripts/qa-artifacts/processing-ui-rendered/evidence`.

📌 Team update (2026-09-18T20:04:53.087-07:00): Trinity's component-aware partial-mode UX, targeted retries, Enhanced summary, and exact single-click/double-click behavior are approved in the final 0.3.2 package. Future renderer work must preserve backend deliverable states and the serial scheduler contract.
