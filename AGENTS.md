# Local QA scripts

- Put all new QA scripts, task-specific QA tests, fixtures, and generated artifacts ONLY in the root `qa\` directory. This directory is Git-ignored; never force-add its contents or add ignore exceptions for them.
- Do not create or modify tracked QA tests in `scripts\` for feature work. Extend or copy tests locally in `qa\`, adjusting imports and helper paths as needed.
- Ignore all QA-related filenames and directories anywhere in the repository using the case-insensitive `*[qQ][aA]*` rule in `.gitignore`. This covers `qa-` scripts, `QA` folders, fixtures, and reports with QA in their names. Keep even generically named QA artifacts inside root `qa\`.
- Keep the existing tracked QA suite in `scripts\` intact and usable; do not mass-move, delete, or untrack it without explicit approval. Ignore rules do not affect already tracked files, which must not be edited for new feature QA.
- Do not add package scripts or shared automation that depends on files in the ignored `qa` directory. Run local QA scripts directly, for example: `node qa\qa-microphone-echo.cjs`.

## Before editing

- Read this policy and `.gitignore`; inspect `git status --short`, `git diff`, and `git diff --cached` to distinguish existing user changes, including staged changes.
- Choose root `qa\` paths for every new QA script, test, fixture, and generated output (including screenshots, profiles, logs, and build output produced for QA). Before creating or running them, use `git check-ignore -v -- <path>` for each intended path and verify it is ignored. Also check `git ls-files -- <path>`: an ignored-looking path must not already be tracked.
- Keep production/shared automation independent of ignored QA. Never use `git add -f` for QA. Preserve unrelated work and the existing index; any QA-placement repair must remove only identified task-authored changes, with path-specific index cleanup only after verifying the staged diff contains no user changes.

## Before handoff

- Run the smallest applicable local QA commands directly from `qa\`; ensure every generated output stays under that directory.
- Run `git check-ignore -v -- <path>` for each new QA script, test, fixture, and output, and verify none is tracked with `git ls-files -- <path>`.
- Inspect `git status --short`, `git diff --name-only`, and `git diff --cached --name-only`, then inspect both staged and unstaged diffs for any QA leakage. New task QA must appear in neither diff, and feature work must introduce no tracked QA changes in `scripts\`.
- Report commands/results and any pre-existing tracked QA changes that remain; do not erase unrelated user changes to obtain a clean diff.
