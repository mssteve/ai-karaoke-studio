---
name: "immutable-release-staging"
description: "Command-oriented invariant for Git-object source and isolated lockfile dependency staging"
domain: "release-security"
confidence: "high"
canonical: true
triggers:
  - "release source staging or source identity changes"
  - "dependency installation, module resolution, build-tool, or cache changes"
  - "release provenance or package-input verification changes"
  - "TOCTOU, filter, CRLF, path-case, reparse, junction, or hardlink findings"
---

# Immutable Release Staging

Use with `.squad\skills\full-windows-store-release\SKILL.md`. This skill defines the
immutable build-input boundary; the full release skill remains authoritative for
approval, packaging, QA, artifact promotion, ZIP, installation, and Store blockers.

## Invariants

1. Build only from the approved target commit's Git object bytes. Never compile or
   package from the live checkout.
2. Install dependencies freshly in the owned source stage with the exact committed
   package and lockfiles. Never link, junction, hardlink, reflink, or resolve through
   live `node_modules`.
3. Scrub inherited Node/npm resolution, configuration, proxy, credential, workspace,
   prefix, and cache variables. Use owned empty home/config paths and owned isolated
   npm, Electron, and electron-builder caches.
4. Resolve every executable tool beneath staged `node_modules`; record and hash the
   resolved TypeScript, Vite, ASAR, electron-builder, npm, and Node identities.
5. Treat filters, EOL conversion, path spelling, file type, links, hardlinks, path
   escapes, cache mutation, and phase-boundary races as hostile.
6. Fail before promotion. Existing release artifacts, ZIPs, installation, and user data
   remain untouched on every rejection.

## Architecture and Commands

1. Validate the clean, tracked approval-only HEAD and derive its sole parent as the
   target implementation commit.
2. Enumerate the target with sorted `git ls-tree` output. Read blobs by object ID; do
   not use checkout filters to materialize canonical source.
3. Create one token-owned `.release-source-*` immediate child. Materialize exact
   canonical paths and modes, reject unsupported Git modes, verify exact physical case
   and containment, then make committed inputs read-only.
4. Copy only the committed package manifests into that stage and validate package
   version, lockfile version, package manager metadata, integrity fields, and one
   expected HTTPS registry origin.
5. Run staged `npm ci` with explicit staged home/config/cache paths and a minimal
   allowlisted environment. Reject any live worktree dependency reference.
6. Walk dependencies without following links. Reject reparse points, symlinks,
   junctions, non-regular files, path escapes, and detectable multi-link files. Record
   path, size, mode, and SHA-256 for every file plus a deterministic aggregate.
7. Resolve build tools from staged `node_modules` only and bind their paths and hashes.
8. Prime Electron/builder caches into the owned stage using discarded, non-promotable
   output. Inventory the caches, remove priming output, and ACL-lock dependency/cache
   trees read/execute-only on Windows.
9. Run TypeScript, Vite, and electron-builder with the stage as working directory. Use
   Vite's runner config loader so it does not write into the locked dependency tree.
10. Reverify source, dependency, cache, config, tool, and package-input inventories
    immediately before and after each compile/package boundary and before promotion.
11. Write provenance containing target commit/tree aggregate; package/lock hashes; npm,
    Node, registry, and tool identities; dependency/cache counts and aggregates;
    mutation protection; phase checks; package hashes; and stage cleanup result.
12. Remove only the verified token-owned stage in `finally`.

## Required Attack Tests

- Modify and restore a live source file during the real staged renderer build; the
  sentinel must not enter output.
- Modify and restore live `node_modules\vite\bin\vite.js`; staged output and inventories
  must remain independent.
- Attempt direct mutation of staged source, Vite, dependency, and cache files after
  protection; writes must be denied or detected before promotion.
- Inject clean/smudge/process filters, sentinel-named attribute values, `ident`,
  `working-tree-encoding`, CRLF/LF variants, attribute macros, and repository attribute
  overrides; unsafe or ambiguous states must reject.
- Exercise path-case aliases, Unicode normalization/lookalikes, trailing dot/space,
  ADS, path escapes, reparse points, junctions, symlinks, hardlinks, non-regular files,
  untracked shadows, Git symlink/gitlink modes, and dependency resolution outside the
  stage.
- Change dependency/cache bytes between every meaningful phase boundary and prove the
  next gate rejects without replacing production artifacts.
- Run default and stale-artifact dry-runs and prove byte, timestamp, type, and membership
  nonmutation for release, ZIP, lock/capability state, installation, and user data.

## Cleanup and Evidence

- Never remove a stage, cache, lock, backup, or capability by broad path or process
  name. Verify token ownership, immediate-parent containment, PID creation identity, and
  exact path first.
- Never log credentials, proxy values, secret matches, user-data contents, or absolute
  private paths. Evidence may include relative paths, counts, modes, hashes, versions,
  timestamps, and redacted commands.
- Preserve rejected approval/evidence history and delete obsolete files only in a
  forward revision. Never reset, amend, or rewrite the chain.
- Any staging/pipeline change requires Tank's independent review. If rejected, the
  author is locked out and a different owner must revise.

## Anti-Patterns

- Live `node_modules` junctions, symlinks, directory links, or fallback resolution.
- Building from the worktree and comparing it only before/after.
- Trusting `git diff` alone when filters or checkout normalization may conceal bytes.
- Hashing manifests while leaving executable tools, transitive dependencies, configs,
  or caches unbound.
- Priming shared user caches or allowing inherited npm/Node configuration.
- Packaging before post-build inventories pass.
- Reusing a historical approval for a changed implementation or staging protocol.
