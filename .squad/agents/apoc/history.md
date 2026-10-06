# Apoc History

## Project Context

Karaoke Studio needs deterministic four-mode playback, timed lyrics, and FIFO queue behavior verified against real processed songs. Requested by Steve.

## Learnings

### 2026-10-06: Reviewer registry and protected-source conflict scan

- Tank rejected `b5d27391` because `.squad/reviewers.json` was absent from the target and from Git history, committed conflict markers in `.gitignore` were outside the three-file preflight, and release QA still required `0.3.4`.
- Cypher remains locked out of this release entry. The registry was restored from the committed approval-validation fixture in `scripts/qa-deploy-release.mjs`, which is the identity contract `validateReviewerRegistry` already enforces. It was not invented and was not placed in an approval commit.
- Schema 1 reviewer: identity `Tank`, role `independent-release-reviewer`, name `Tank Reviewer`, email `tank@squad.local`. Required trailers are exactly `Reviewed-by: Tank <tank@squad.local>` and `Reviewer-Role: independent-release-reviewer`. Allowed committers are that Tank identity and `project-maintainer` / `Karaoke Studio Maintainer` / `maintainer@squad.local`.
- `assertWorktreeReady` now inventories protected tracked sources through `snapshotProtectedCommit` and rejects conflict markers in every protected path, including `.gitignore` and nested `scripts` files, in both worktree and committed blob bytes, before bump or deploy. The sole completion entry, approval path, and non-zero bump stop are unchanged.
- Live version assertions now compare worktree `package.json` and both root lockfile version fields with `HEAD`. A real mismatch fails. Explicit `0.3.4` fixture calculations remain fixture-scoped.
- Focused release QA passed 14/14. `node scripts/release-version.mjs --approval=.squad/approvals/missing.json` exited 3 on the dirty tree and `.gitignore` markers without changing manifest hashes. `git diff --check` passed. Full deploy QA was 168/169 when launched directly by Node; the remaining failure is the pre-existing `npm_execpath` canonical-CLI gate in `installIsolatedDependencies`, not a version assertion.
- No package, install, version bump, commit, stage, approval, or `.gitignore` edit was performed. Switch still owns marker removal. The registry is not ignored, but it is not tracked until a later source commit.

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

📌 Team update (2026-09-20T10:27:28.056-07:00): The final installed and package-approved 0.3.4 retained Demucs 4/4 and processed-data preservation. Store submission remains blocked; no commit or push occurred.

### 2026-09-20: Protected release-source attribute hardening

- Reproduced Tank's remaining bypass before editing: `.git/info/attributes` assigned
  `src/main.ts filter=unspecified`, the clean driver emitted `HEAD:src/main.ts`, and
  attacker-controlled checkout bytes produced `git diff --quiet` exit 0 while
  `snapshotProtectedSources()` accepted the canonical blob hash.
- Replaced attribute-aware worktree cleanliness trust with direct physical-byte
  validation for every protected source, approval, evidence, reviewer-registry, and
  `.gitattributes` file. Canonical blobs are read by object ID; working bytes are read
  directly without `hash-object --path` or clean filters and may differ only by the
  committed explicit `eol=crlf` conversion.
- The committed policy now requires `-filter`, `-ident`, and
  `-working-tree-encoding`, plus explicit text/EOL or binary state. Effective
  attributes must match it. Attribute macros and Git repository/attribute environment
  redirection fail closed; info/global/system/local precedence, clean/smudge/process
  drivers, sentinel-looking values, and configured-driver ambiguity are covered.
- Exact component case, regular-file type, containment, symlink/reparse rejection,
  hardlink rejection, and stable device/inode/size/mtime identity are shared across
  protected source and approval/evidence reads.
- Validation passed focused attribute/source QA 28/28, full deploy QA 165/165, build,
  syntax/diff, Demucs 14/14 and 18/18, and built-output secret scan
  33 files / 628055 bytes / zero findings. Default and stale `--zip` dry-runs exited 3
  and preserved 1662 inventoried entries exactly.
- Historical approval commit `48cfb8f` and both rejected blobs remain intact in Git;
  the files remain deleted only forward. No approval, package, ZIP, install, commit,
  push, merge, tag, reset, amend, history rewrite, or ignored-artifact deletion was
  performed.

### 2026-09-20: Release approval and capability integrity revision

- Replaced working-tree approval trust with a non-circular two-commit protocol: the
  approval commit has exactly one parent (the reviewed target), changes only canonical
  approval/Tank record paths, and leaves all protected packaged source content identical
  to that parent.
- Schema-2 approvals now bind target commit, branch, package/APPX version, protected
  aggregate/count, and structured Tank evidence hashes/status/counts/timestamps. Approval
  and evidence must be exact clean committed regular-file blobs at canonical contained
  paths; path escapes, ADS, case aliases, symlink/reparse chains, and detectable hardlinks
  fail closed.
- Reviewer provenance is bound to repository-local reviewer identity/role/name/email,
  matching approval commit author and committer, explicit reviewer trailers, Tank-owned
  paths, and a source author distinct from the reviewer.
- Replaced reusable inherited tokens with an atomically consumed 256-bit capability bound
  to deploy/child PID start identities, actual parentage, approval HEAD, source, version,
  operation, and expiry. Replay and concurrent consumption fail.
- The boundary prevents accidental/script-level bypass and stale replay; it cannot protect
  against malicious same-user code able to rewrite config, code, processes, or Git history.
- Expanded Windows deploy QA from 61 to 82 cases. No approval, commit, package, install,
  release artifact, ZIP, push, or merge was created or performed.
- Final validation passed build, deploy QA 82/82, deterministic Demucs boundary 14
  checks, and real Demucs runtime 18 checks. Real default dry-run and stale `--zip`
  each exited 3 against the intentionally dirty revision; all 1,398 inventoried
  release/ZIP/lock/install/user-data files remained byte- and timestamp-identical, and
  no deploy lock, release lock, or capability remained.
