---
name: "test-artifact-hygiene"
description: "Use before creating, running, or reorganizing QA scripts, tests, fixtures, logs, screenshots, browser profiles, downloads, reports, or QA build outputs; also use when investigating tracked QA files or cleaning up test artifacts."
domain: "quality"
confidence: "high"
source: "repository policy (AGENTS.md)"
---

# Test artifact hygiene

## Scope and precedence

Read root `AGENTS.md` and `.gitignore` first. Root policy prevails, including over
generic instructions in `test-discipline` to commit tests. Create, copy, or extend
tests locally under root `qa\`, adjusting imports and helper paths. ALL QA is
local-only: no QA tests, fixtures, helpers, or artifacts may be tracked in the
current Git index. The explicitly approved migration moved the former `scripts\`
suite and two generic seed generators into ignored `qa\scripts\`; its historical
commits remain unchanged.

All QA scripts, tests, fixtures, and generated outputs belong
ONLY under repository-root `qa\`, even when their names contain no "qa".
The existing case-insensitive `*[qQ][aA]*` ignore rule covers QA-named paths at
any depth, but ignoring a file elsewhere does not satisfy the root-placement rule.
Never force-add QA or add ignore exceptions.

Classify by purpose, not by whether a file was tested: a genuine production or
shared utility such as `scripts\serve-docs.mjs` is not a QA artifact merely because
it was tested. This skill is repository process documentation, not a QA test;
keep its directory named `test-artifact-hygiene` so it remains discoverable and
is not hidden by the QA ignore rule.

## 1. Establish ownership before editing

From the repository root in PowerShell, inspect:

```powershell
Get-Content AGENTS.md
Get-Content .gitignore
git status --short
git --no-pager diff
git --no-pager diff --cached
git ls-files -- scripts
```

Record which modified, staged, and untracked paths predate this task, including
any pre-existing tracked QA changes. Preserve unrelated work and the index.
Do not treat an initially dirty worktree as permission to repair other work.

**Gate:** do not edit or clean up a path until its role and ownership are known.
If ownership is ambiguous, leave it untouched and report the ambiguity.

## 2. Classify every intended output before running

Inventory both the command inputs you will create and every possible output:
scripts, tests, copied helpers, fixtures, media, browser/Electron user-data
profiles, downloads, screenshots, traces, logs, reports, coverage, caches, and
build output produced for QA. Assign each a concrete root `qa\` path.
Production source is an input, not a QA artifact. Existing tracked QA is a policy
violation to report and repair only after the ownership/authorization gate below.

For example:

| Purpose | Intended path |
| --- | --- |
| Local copied/extended test | `qa\playback-check.cjs` |
| Fixture | `qa\fixtures\clip.wav` |
| Browser profile / download | `qa\profiles\playback`, `qa\downloads\clip.webm` |
| Screenshot / trace | `qa\screenshots\end.png`, `qa\traces\playback.zip` |
| Log / report / build | `qa\logs\playback.log`, `qa\reports\result.json`, `qa\build\` |

For **each exact intended path**, run both commands before creation or execution:

```powershell
git check-ignore -v -- qa\playback-check.cjs
git ls-files -- qa\playback-check.cjs
```

Repeat for every script, fixture, output file, and output directory; do not
substitute one check of `qa\` for the individual checks.

**Pass only if:** the path is under root `qa\`, `check-ignore` reports an effective
ignoring rule (not a negating `!` exception), and `ls-files` prints nothing.
Ignored and tracked are independent properties: ignore rules never untrack
already indexed files. `check-ignore` exit 1 can mean not ignored OR tracked;
it is not proof of either state by itself. Use both commands and their output.
Unexpected errors block the gate.

If needed, diagnose a tracked path's matching rules with:

```powershell
git check-ignore -v --no-index -- scripts\qa-harness.mjs
git ls-files -- scripts\qa-harness.mjs
```

`--no-index` is diagnostic only: a matching ignore rule does not prove a path
is untracked or authorize removing it from the index. Stop on any failed gate;
choose a compliant path rather than bypassing ignore rules.

## 3. Configure containment, then run the smallest check

Inspect the selected runner's output behavior before invoking it. Configure its
actual supported options/environment for profiles, downloads, screenshots,
traces, logs, reports, caches, and QA build output under the inventoried `qa\`
paths. Configure paths used inside copied scripts too; moving a script alone
does not relocate its outputs. Do not invent output flags or assume defaults
are safe. If an existing tracked runner cannot contain its outputs without
editing it, make an adjusted local copy in `qa\` or choose another focused check.

Run local QA scripts directly from the repository root, not via a new package
script or shared automation depending on ignored files:

```powershell
# Only after both exact paths have passed the two checks above:
New-Item -ItemType Directory -Force qa\logs | Out-Null
node qa\playback-check.cjs *> qa\logs\playback.log
$testExit = $LASTEXITCODE
Get-Content qa\logs\playback.log
if ($testExit -ne 0) { throw "Playback check failed: $testExit" }
```

This example redirects console output only; the script must separately contain
its other outputs. Capture native command exit codes immediately, before
another native command overwrites `$LASTEXITCODE`. Do not use Unix shell syntax.

Run the smallest applicable local test, expanding only when its result warrants
it. Do not add package scripts or shared automation importing ignored QA. Local
tests are not shipped in fresh checkouts; report unavailable tests rather than
turning their absence into a passing assertion.
For documentation-only work, validate documentation instead of creating a QA
script unnecessarily.

**Gate:** artifact hygiene is not test success. Report failed, skipped,
incomplete, or unexecuted checks as such; a contained log or zero exit code alone
does not prove an asserted acceptance outcome.

## 4. Repair only task-owned leakage

If this task created QA outside `qa\`, stop further runs. Identify the exact
task-owned files, inspect both diffs and any staged content for those paths,
then relocate only those files into preflight-verified `qa\` paths. Adjust local
imports, helper paths, and output configuration, and rerun the focused check.
Delete only positively identified, no-longer-needed task-owned artifacts.

Never use broad `reset`, `clean`, or `rm` operations, `git add -f`, or ignore
exceptions as repair. Index repair is not automatic: inventory exact source and
destination paths, detect collisions, review path-specific staged and unstaged
diffs, establish ownership, and obtain explicit approval before untracking
existing files. With authorization, preserve originals and hashes under `qa\`,
verify destination safety and import/output paths, then use path-specific
`git rm --cached -- <source>` and remove only the safely preserved source.
Stage no unrelated files. Ignoring indexed files alone does not untrack them.
Without authorization, leave the index untouched and report the blocked repair.
Preserve pre-existing user changes, even when they violate placement policy.

Check running processes, release locks, references, and size before moving old
artifact trees. Do not rewrite embedded Git histories, approvals, or historical
evidence just to relocate them. If active ownership or absolute/path-bound
release evidence prevents safe movement, preserve the already-ignored tree and
report each blocked path in a local inventory. This is a placement exception
still outstanding, not a fully compliant migration. Archive historical evidence
unchanged with source-to-destination mappings; never call it fresh acceptance.

## 5. Handoff gates

Re-enumerate actual outputs, including unexpected/generated children, and repeat
the exact per-path `git check-ignore -v -- <path>` and `git ls-files -- <path>`
checks for every new task QA script, fixture, and output. Every one must still
be ignored AND untracked under root `qa\`. Use actual Windows paths in place
of `<path>`; it is a placeholder, not a literal command argument.

Inspect all change surfaces, not just ordinary status (which hides ignored files):

```powershell
git status --short
git ls-files --others --exclude-standard
git status --short --ignored -- qa
git diff --name-only
git diff --cached --name-only
git --no-pager diff
git --no-pager diff --cached
git ls-files -- scripts
git diff --check
git diff --cached --check
```

### Acceptance checklist

- [ ] Every new QA path was classified before execution and is under root `qa\`.
- [ ] Every actual task QA file/output passes ignore and untracked checks.
- [ ] New task QA appears in neither staged nor unstaged diffs; untracked
      non-ignored files contain no task QA leakage.
- [ ] `git ls-files -- '*[qQ][aA]*' qa` is empty; generically named project
      files were also classified so QA-only helpers are not left tracked.
- [ ] Authorized migration deletions alone may be staged for QA sources;
      originals/hashes are preserved locally and unrelated index state is intact.
- [ ] Blocked legacy ignored trees, if any, are explicitly inventoried and
      reported without claiming complete root placement.
- [ ] No package/shared automation depends on ignored QA; no force-adds or
      ignore exceptions were introduced.
- [ ] Handoff lists commands, results, limitations, and unrelated changes left
      intact; it does not falsely claim a clean worktree or passing acceptance.
