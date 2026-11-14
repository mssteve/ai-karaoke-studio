# Local QA scripts

Before creating or running QA, or cleaning up QA artifacts, read [test-artifact-hygiene](.copilot/skills/test-artifact-hygiene/SKILL.md) and follow its preflight and handoff gates. This root AGENTS.md policy prevails over any conflicting skill guidance.

- Put ALL QA scripts, tests, fixtures, and generated artifacts ONLY in the root `qa\` directory, including generically named QA helpers. QA is local-only: no QA files may be tracked in the current Git index. Never force-add QA or add ignore exceptions.
- Create, extend, and run tests locally in `qa\`, adjusting imports and helper paths as needed. Do not introduce tracked QA in `scripts\` or elsewhere.
- Ignore all QA-related filenames and directories anywhere in the repository using the case-insensitive `*[qQ][aA]*` rule in `.gitignore`. This covers `qa-` scripts, `QA` folders, fixtures, and reports with QA in their names. Keep even generically named QA artifacts inside root `qa\`.
- The explicitly authorized migration relocated and untracked the former `scripts\` QA suite into `qa\scripts\`, including its two seed generators. Historical commits still contain the former suite; history rewriting is not part of this policy. Ignore rules alone do not untrack indexed files. Future repairs still require ownership verification, path-specific staged-diff review, and explicit authorization before untracking existing files.
- Process documentation (this file and `test-artifact-hygiene`) and genuine production/shared utilities are not QA artifacts. Do not move vendor/dependency tests, release payload copies, or historical decision records based only on their names.
- Do not add package scripts or shared automation that depends on files in the ignored `qa` directory. Run local QA scripts directly, for example: `node qa\qa-microphone-echo.cjs`.

## Before editing

- Read this policy and `.gitignore`; inspect `git status --short`, `git diff`, and `git diff --cached` to distinguish existing user changes, including staged changes.
- Choose root `qa\` paths for every new QA script, test, fixture, and generated output (including screenshots, profiles, logs, and build output produced for QA). Before creating or running them, use `git check-ignore -v -- <path>` for each intended path and verify it is ignored. Also check `git ls-files -- <path>`: an ignored-looking path must not already be tracked.
- Keep production/shared automation independent of ignored QA. Never use `git add -f` for QA. Preserve unrelated work and the existing index; any QA-placement repair must affect only positively identified, authorized QA paths, with path-specific index cleanup only after verifying the staged diff contains no user changes.
- Do not move active or absolute-path-bound release fixtures blindly. If safe relocation would invalidate evidence or current release references, leave those already-ignored paths untouched and report the exact blocked inventory; never present them as compliant root placement or fresh passing evidence.

## Before handoff

- Run the smallest applicable local QA commands directly from `qa\`; ensure every generated output stays under that directory.
- Run `git check-ignore -v -- <path>` for each new QA script, test, fixture, and output, and verify none is tracked with `git ls-files -- <path>`.
- Inspect `git status --short`, `git diff --name-only`, and `git diff --cached --name-only`, then inspect both staged and unstaged diffs for any QA leakage. No QA additions may appear in either diff; authorized source deletions for migration/untracking are expected and must be explained.
- Verify `git ls-files -- '*[qQ][aA]*' qa` prints nothing, and separately inspect generically named files for QA purpose. Report commands/results, blocked legacy placement, and any pre-existing tracked QA changes that remain; do not erase unrelated user changes to obtain a clean diff.
