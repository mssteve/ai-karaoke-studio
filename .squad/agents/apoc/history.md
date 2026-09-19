# Apoc History

## Project Context

Karaoke Studio needs deterministic four-mode playback, timed lyrics, and FIFO queue behavior verified against real processed songs. Requested by Steve.

## Learnings

### 2026-09-18: Strict playback terminal-state acceptance

- Reproduced the rejected integrity gap: the former near-end gate passed at `playing`, then an absent `[role="alert"]` snapshot created three renderer exceptions while claiming no visible error.
- Replaced that gate with a 99.9%-of-actual-duration scenario. The report now includes initial/actual duration, requested and observed targets, replacement clamp, ordered media/controller events, and the terminal state.
- A pass now requires `ended` at duration with `paused=true` and both media/controller playing intent false. The current controller reached that state without implementation changes, including a 286.112s original target clamped to the 285.536s instrumental duration.
- Electron automation now exposes process-scoped renderer error diagnostics. Tests query this supported state and never probe a selector expected to be absent.
- Final evidence: clean build; strict mode switching 5/5 on five consecutive runs; playlist/language 16/16; zero renderer exceptions and zero listening TCP endpoints.

### 2026-09-18: Independent 0.3.0 installed-runtime revision

- Installed `0.3.0` ASAR `main.js` and `transcribe.js` were byte-identical to the clean source build and provenance. Direct installed-runtime checks reproduced neither claimed product blocker: strict terminal playback passed, and a real legacy Chinese retranscription persisted `zh`/`Chinese`, 40 Unicode timed lines, and survived restart.
- The packaged near-end timeout was an acceptance race: a fixed 99.9% target left only about 8 ms on the short 7.683s fixture while the harness required observing transient playing before terminal settlement. The strict target now keeps a duration-derived runway bounded to 0.5–2.0s, while still forcing the shorter replacement clamp.
- The retranscription blocker was in `scripts/control.mjs`: `retranscribe` was not mapped to `songId`, and it inherited the 30s command timeout instead of the one-hour local-AI timeout. The corrected adapter was exercised by the real retranscription QA.
- Added `scripts/qa-retranscription-runtime.mjs` for isolated legacy-state creation, real AI execution, library/transcript verification, restart verification, source preservation, diagnostics, and TCP checks.
- Built only an unpacked isolated runtime. Final results: strict mode 5/5 for five runs, retranscription 6/6, playlist/language 16/16, Demucs 4/4, automation default-off, zero renderer errors, and zero TCP listeners.

📌 Team update (2026-09-18T09:32:50.972-07:00): Apoc's actual-duration terminal-ended gate and corrected retranscription songId/one-hour timeout separated harness races from product behavior and enabled final 0.3.0 approval — decided by Neo, Trinity, Morpheus, Tank, Switch, Cypher, and Apoc.

📌 Team update (2026-09-18T14:19:38.738-07:00): Before future Queue/History or playlist transport test-integrity approval, read and enforce the canonical `.squad/skills/queue-history-validation/SKILL.md` runbook rather than substituting a summarized or weakened process.

📌 Team update (2026-09-18T15:07:36.120-07:00): Before release test-integrity approval, read and enforce `.squad\skills\full-windows-store-release\SKILL.md`. Require fresh package-bound evidence, exact hashes and provenance, and distinguish package approval from blocked or completed Store submission.
