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

### 2026-09-18: Demucs inference boundary reliability

- Reproduced the packaged TypeError exactly: `Object.create(ONNXHTDemucs.prototype)` bypassed JavaScript class-field initialization, leaving `model.sources` undefined at `applySplits`; ONNX Runtime thread caps and CPU provider settings were not causal.
- Replaced prototype-only construction with initialized model construction plus a local validated inference boundary. Session input/output names, tensor ranks, shapes, and data lengths now fail with explicit Demucs stage/name/shape context before dependency dereferences.
- Session release is guaranteed on failure, stems remain staged until all four validate, and separation errors retain the retryable `demucs` component while the global FIFO scheduler continues.
- Added deterministic boundary tests and a real installed-dependency run covering short padding and a 6-second trailing split. All four stems retained exact input frame counts.
- Fresh build and focused inference, resources, scheduler, resumability, artifact, and real Demucs suites passed.

### 2026-09-18: Private real-library Demucs acceptance

- With explicit authorization, inventoried 16 supported files under the user's Music folder without placing names or content in evidence.
- Built an isolated unpacked package and verified its packaged `demucs-inference`, runner, and resource-policy JavaScript were byte-identical to the fresh build.
- Hashed and timestamped every source, converted only into an isolated QA root, and ran all files sequentially through the packaged runner with one active extraction, CPU provider, four-thread half-core cap, and thread-limiting environment variables.
- Result: 16/16 passed, 64/64 stems were nonempty and FFmpeg-decodable, maximum duration delta was zero, no retries or failures occurred, FIFO terminal continuation held, and every source hash, size, creation timestamp, and modification timestamp was unchanged.
- Total tested audio duration was 3,241.622 seconds; total elapsed separation time was 1,943.311 seconds. Existing injected-failure runtime evidence separately passed Demucs partial-state persistence, zero partial-stem publication, FIFO continuation, restart, and targeted retry.
- Follow-up installed-path diagnosis reproduced Steve's error against the currently installed 0.3.2: its packaged runner still uses prototype-only construction and does not contain the validated inference boundary. It exited before publishing stems.
- A packaged-runtime probe against the isolated fixed build explicitly returned initialized model metadata: four sources (`drums`, `bass`, `other`, `vocals`), two channels, 44.1 kHz, and 7.8-second segments. The installed 0.3.2 remains unfixed until a corrected package is rebuilt and reinstalled (or superseded by a newer fixed version).

📌 Team update (2026-09-19T02:52:27.047-07:00): Tank approved Apoc's initialized Demucs inference boundary after real Music acceptance at 16/16 files and 64/64 stems. The fix is included in the approved frozen 0.3.3 package; Store submission remains blocked.
