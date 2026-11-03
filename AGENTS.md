# Local QA scripts

- Put new local or one-off QA scripts, fixtures, and generated artifacts in the root `qa` directory. This directory is Git-ignored; do not force-add its contents.
- Keep the existing tracked QA suite in `scripts` and preserve its commands.
- Do not add package scripts or shared automation that depends on files in the ignored `qa` directory. Run local QA scripts directly, for example: `node qa\qa-microphone-echo.cjs`.
