import { spawn, spawnSync } from 'node:child_process'
import {
  copyFile,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { snapshotProtectedCommit } from './release-artifact-verification.mjs'

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUMP_KINDS = new Set(['major', 'minor', 'patch'])
export const RESTORED_LOCK_BLOB = 'd1be93dbae5d91a4be10d0323607bac44dfdcf9a'
const CONFLICT_MARKER = /^[ \t]*(?:<{7}|={7}|>{7})(?:[ \t]|$)/m
const REQUIRED_LOCK_EXPORTS = [
  'ReleaseLockError',
  'acquireOperationLock',
  'assertActiveReleaseLock',
  'assertCanonicalNodeProcess',
  'consumeReleaseCapability',
  'currentProcessIdentity',
  'hashLockToken',
  'readLockState',
]
const STRIPPED_CHILD_ENV = [
  'KARAOKE_RELEASE_CAPABILITY_PATH',
  'KARAOKE_RELEASE_CAPABILITY_NONCE',
  'KARAOKE_RELEASE_LOCK_TOKEN',
  'KARAOKE_RELEASE_DIR',
  'KARAOKE_RELEASE_SOURCE_DIR',
]

export class ReleaseVersionError extends Error {
  constructor(message, exitCode = 2) {
    super(message)
    this.name = 'ReleaseVersionError'
    this.exitCode = exitCode
  }
}

export function completionInstructions() {
  return [
    'npm run release builds the Windows NSIS setup into release/<version>/ and links it at release/.',
    '  npm run release',
    'That rebuilds the app and packages the setup. It does not bump versions or require an approval file.',
    'The approval-gated store workflow remains:',
    '  npm run release -- --approval=.squad/approvals/<approval>.json',
    'That builds NSIS and APPX and does not change package versions.',
    'Optional --zip or --install may be added only with that explicit approval.',
    'To prepare a future version without packaging:',
    '  npm run release -- --bump=patch',
    'Preparation exits non-zero, does not package, and is not release completion.',
    'Do not invoke scripts/deploy-release.mjs or scripts/release.mjs directly.',
  ].join('\n')
}

export function nextReleaseVersion(current, kind) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current)
  if (!BUMP_KINDS.has(kind) || !match) {
    throw new ReleaseVersionError(
      `Cannot apply ${kind} to ${current}. Use major, minor, or patch on MAJOR.MINOR.PATCH.`,
    )
  }
  let major = Number(match[1])
  let minor = Number(match[2])
  let patch = Number(match[3])
  if (kind === 'major') {
    major += 1
    minor = 0
    patch = 0
  } else if (kind === 'minor') {
    minor += 1
    patch = 0
  } else {
    patch += 1
  }
  return `${major}.${minor}.${patch}`
}

export function normalizeApprovalPath(value) {
  const relative = String(value ?? '').replaceAll('\\', '/')
  if (!relative.startsWith('.squad/approvals/')
    || relative.length <= '.squad/approvals/'.length
    || relative.includes('..')
    || relative.includes(':')
    || relative.includes('\0')
    || relative.includes('//')
    || relative.endsWith('/')
    || !relative.endsWith('.json')) {
    throw new ReleaseVersionError(
      'Approval must be a repository path under .squad/approvals/<approval>.json. '
      + 'Working-tree, ignored, absolute, and fabricated reports are not accepted.',
    )
  }
  return relative
}

export function parseReleaseArguments(argv) {
  if (!Array.isArray(argv)) throw new ReleaseVersionError('Release arguments must be an array.')
  let bump = null
  let approval = null
  let build = false
  let dryRun = false
  let zip = false
  let install = false
  const rejectDuplicate = (name) => {
    throw new ReleaseVersionError(`${name} may be supplied only once.`)
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') continue
    if (argument === '--bump' || argument.startsWith('--bump=')) {
      if (bump) rejectDuplicate('--bump')
      const kind = argument === '--bump' ? argv[index + 1] : argument.slice('--bump='.length)
      if (argument === '--bump') index += 1
      if (!kind || kind.startsWith('-') || !BUMP_KINDS.has(kind)) {
        throw new ReleaseVersionError('--bump requires major, minor, or patch.')
      }
      bump = kind
      continue
    }
    if (argument === '--build') {
      if (build) rejectDuplicate('--build')
      build = true
      continue
    }
    if (argument === '--dry-run') {
      if (dryRun) rejectDuplicate('--dry-run')
      dryRun = true
      continue
    }
    if (argument === '--zip') {
      if (zip) rejectDuplicate('--zip')
      zip = true
      continue
    }
    if (argument === '--install') {
      if (install) rejectDuplicate('--install')
      install = true
      continue
    }
    if (argument === '--approval' || argument.startsWith('--approval=')) {
      if (approval) rejectDuplicate('--approval')
      const value = argument === '--approval' ? argv[index + 1] : argument.slice('--approval='.length)
      if (argument === '--approval') index += 1
      if (!value || value.startsWith('-')) {
        throw new ReleaseVersionError('--approval requires a path under .squad/approvals/.')
      }
      approval = normalizeApprovalPath(value)
      continue
    }
    if (argument.startsWith('-')) throw new ReleaseVersionError(`Unknown option: ${argument}.`)
    throw new ReleaseVersionError(`Unknown argument: ${argument}.`)
  }
  const packaging = build || dryRun || zip || install
  if (bump && (approval || packaging)) {
    throw new ReleaseVersionError(
      'Version preparation cannot be combined with --approval, --build, --zip, --install, or --dry-run.',
    )
  }
  if (dryRun && (build || zip || install)) {
    throw new ReleaseVersionError('--dry-run cannot be combined with --build, --zip, or --install.')
  }
  if (packaging && !approval) {
    throw new ReleaseVersionError(
      '--build, --zip, --install, and --dry-run require --approval=.squad/approvals/<approval>.json.',
    )
  }
  if (bump) return { mode: 'bump', bump }
  if (!approval) {
    return { mode: 'package', approval: null, dryRun: false, zip: false, install: false, build: true }
  }
  return {
    mode: 'package',
    approval,
    dryRun,
    zip: dryRun ? false : zip,
    install: dryRun ? false : install,
    build: !dryRun,
  }
}

export function deployArguments(options) {
  if (options.dryRun) return ['--dry-run', `--approval=${options.approval}`]
  const args = ['--build', `--approval=${options.approval}`]
  if (options.zip) args.push('--zip')
  if (options.install) args.push('--install')
  return args
}

export function releaseChildEnv(base = process.env) {
  const env = { ...base }
  for (const key of STRIPPED_CHILD_ENV) delete env[key]
  return env
}

function versionSet(packageText, lockText) {
  let packageJson
  let packageLock
  try {
    packageJson = JSON.parse(packageText)
    packageLock = JSON.parse(lockText)
  } catch {
    throw new ReleaseVersionError('package.json or package-lock.json is not valid JSON.', 3)
  }
  return {
    packageJson: packageJson.version,
    lockfile: packageLock.version,
    lockRoot: packageLock.packages?.['']?.version,
  }
}

function replaceFirstVersion(text, from, to) {
  const pattern = new RegExp(
    `("version"\\s*:\\s*")${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(")`,
  )
  if (!pattern.test(text)) {
    throw new ReleaseVersionError('Could not locate a version field to update.', 3)
  }
  return text.replace(pattern, `$1${to}$2`)
}

function assertOnlyRootVersionsChanged(beforeText, afterText, expected, label) {
  const before = JSON.parse(beforeText)
  const after = JSON.parse(afterText)
  before.version = expected
  if (before.packages?.['']) before.packages[''].version = expected
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new ReleaseVersionError(`${label} changed more than its root version fields.`, 3)
  }
}

function sameBytes(left, right) {
  return Buffer.from(left).equals(Buffer.from(right))
}

export function defaultGit(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0) {
    throw new ReleaseVersionError(
      (result.stderr || result.stdout || `git ${args.join(' ')} failed.`).trim(),
      3,
    )
  }
  return (result.stdout ?? '').trim()
}

export function checkScriptParses(root, relative = 'scripts/release.mjs') {
  const result = spawnSync(process.execPath, ['--check', path.join(root, relative)], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0) {
    throw new ReleaseVersionError((result.stderr || `${relative} failed to parse.`).trim(), 3)
  }
}

function hasConflictMarker(text) {
  return CONFLICT_MARKER.test(String(text))
}

function normalizeProtectedPath(relative) {
  const normalized = String(relative ?? '').replaceAll('\\', '/')
  if (!normalized || path.win32.isAbsolute(normalized) || path.posix.isAbsolute(normalized)
    || normalized.includes('\0') || normalized.includes(':')
    || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new ReleaseVersionError('Protected source inventory contains an unsafe path.', 3)
  }
  return normalized
}

async function listProtectedReleaseSources(root, dependencies) {
  if (typeof dependencies.listProtectedSources === 'function') {
    const listed = await dependencies.listProtectedSources(root)
    if (!Array.isArray(listed)) {
      throw new ReleaseVersionError('Protected source inventory is invalid.', 3)
    }
    return listed.map(normalizeProtectedPath)
  }
  const snapshot = await snapshotProtectedCommit(root, 'HEAD')
  if (!snapshot || !Array.isArray(snapshot.files)) {
    throw new ReleaseVersionError('Protected source inventory is invalid.', 3)
  }
  return snapshot.files.map((file) => normalizeProtectedPath(file.path))
}

function readCommittedBlob(root, relative) {
  const result = spawnSync('git', ['cat-file', 'blob', `HEAD:${relative}`], {
    cwd: root,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new ReleaseVersionError(
      (result.stderr || `Committed protected source could not be read: ${relative}`).toString().trim(),
      3,
    )
  }
  return Buffer.from(result.stdout ?? []).toString('utf8')
}

export async function assertWorktreeReady(root, dependencies = {}) {
  const git = dependencies.git ?? defaultGit
  const read = dependencies.readFile ?? readFile
  const blockers = []
  try {
    const top = await git(root, ['rev-parse', '--show-toplevel'])
    if (path.resolve(top).toLowerCase() !== path.resolve(root).toLowerCase()) {
      blockers.push('The release root is not the Git worktree root.')
    }
    const status = await git(root, ['status', '--porcelain=v1', '--untracked-files=all'])
    if (status) {
      blockers.push('The worktree is not clean. Commit or remove every change before release or version preparation.')
    }
  } catch (error) {
    blockers.push(`Git worktree status could not be proven clean: ${error.message}`)
  }
  let releaseHasMarker = false
  let protectedPaths = []
  let inventoryFailed = false
  try {
    protectedPaths = await listProtectedReleaseSources(root, dependencies)
    if (protectedPaths.length === 0) {
      blockers.push('Protected source inventory is empty, so conflict markers cannot be ruled out.')
      inventoryFailed = true
    }
  } catch (error) {
    blockers.push(`Protected source inventory could not be read: ${error.message}`)
    inventoryFailed = true
  }
  const scanCommittedBlobs = typeof dependencies.listProtectedSources !== 'function'
  if (!inventoryFailed) {
    for (const relative of protectedPaths) {
      let marked = false
      try {
        const text = await read(path.join(root, ...relative.split('/')), 'utf8')
        if (hasConflictMarker(text)) marked = true
      } catch {
        blockers.push(`${relative} cannot be read, so release cannot start.`)
        if (relative === 'scripts/release.mjs') releaseHasMarker = true
      }
      if (scanCommittedBlobs) {
        try {
          if (hasConflictMarker(readCommittedBlob(root, relative))) marked = true
        } catch (error) {
          blockers.push(`${relative} committed bytes cannot be read, so release cannot start: ${error.message}`)
          if (relative === 'scripts/release.mjs') releaseHasMarker = true
        }
      }
      if (marked) {
        blockers.push(`${relative} contains unresolved conflict markers.`)
        if (relative === 'scripts/release.mjs') releaseHasMarker = true
      }
    }
  }
  if (!releaseHasMarker) {
    try {
      await (dependencies.checkSyntax ?? checkScriptParses)(root, 'scripts/release.mjs')
    } catch (error) {
      blockers.push(`scripts/release.mjs does not parse, so the canonical packager cannot start: ${error.message}`)
    }
  }
  if (blockers.length) throw new ReleaseVersionError(blockers.join('\n'), 3)
}

export async function loadReleaseLock(root) {
  const lockPath = path.join(root, 'scripts', 'release-operation-lock.mjs')
  let lockModule
  try {
    lockModule = await import(pathToFileURL(lockPath).href)
  } catch {
    throw new ReleaseVersionError(
      'Canonical release cannot start: scripts/release-operation-lock.mjs is missing or failed to load. No version files were changed.',
      3,
    )
  }
  if (typeof lockModule.issueReleaseCapability === 'function') {
    throw new ReleaseVersionError(
      'Release lock module exposes a general-purpose capability issuer. No version files were changed.',
      3,
    )
  }
  for (const name of REQUIRED_LOCK_EXPORTS) {
    if (typeof lockModule[name] !== 'function') {
      throw new ReleaseVersionError(
        `Release lock gate is incomplete: missing ${name}. No version files were changed.`,
        3,
      )
    }
  }
  return lockModule
}

async function assertRestoredLockBlob(root, git) {
  let working
  let committed
  try {
    working = await git(root, ['hash-object', '--', 'scripts/release-operation-lock.mjs'])
    committed = await git(root, ['rev-parse', 'HEAD:scripts/release-operation-lock.mjs'])
  } catch (error) {
    throw new ReleaseVersionError(
      `scripts/release-operation-lock.mjs is not the restored committed lock blob ${RESTORED_LOCK_BLOB}. ${error.message}`,
      3,
    )
  }
  if (working !== RESTORED_LOCK_BLOB || committed !== RESTORED_LOCK_BLOB) {
    throw new ReleaseVersionError(
      `scripts/release-operation-lock.mjs must be committed blob ${RESTORED_LOCK_BLOB}. No packaging was started.`,
      3,
    )
  }
}

async function assertLocksAvailable(root, lockModule) {
  for (const name of ['.release.lock', '.deploy-release.lock']) {
    const state = await lockModule.readLockState(path.join(root, name))
    if (state?.state === 'live' || state?.state === 'invalid') {
      throw new ReleaseVersionError(
        `A release/deploy lock is ${state.state} and cannot be recovered. No version or artifact write was started.`,
        4,
      )
    }
  }
}

export async function prepareReleaseVersion(root, kind, dependencies = {}) {
  await (dependencies.assertGate ?? loadReleaseLock)(root)
  const read = dependencies.readFile ?? readFile
  const write = dependencies.writeFile ?? writeFile
  const packagePath = path.join(root, 'package.json')
  const lockPath = path.join(root, 'package-lock.json')
  const packageBytes = await read(packagePath)
  const lockBytes = await read(lockPath)
  const packageText = packageBytes.toString('utf8')
  const lockText = lockBytes.toString('utf8')
  const before = versionSet(packageText, lockText)
  if (!before.packageJson || before.packageJson !== before.lockfile || before.packageJson !== before.lockRoot) {
    throw new ReleaseVersionError('package.json and package-lock.json versions differ.', 3)
  }
  const expected = nextReleaseVersion(before.packageJson, kind)
  const nextPackage = replaceFirstVersion(packageText, before.packageJson, expected)
  const nextLock = replaceFirstVersion(
    replaceFirstVersion(lockText, before.packageJson, expected),
    before.packageJson,
    expected,
  )
  assertOnlyRootVersionsChanged(packageText, nextPackage, expected, 'package.json')
  assertOnlyRootVersionsChanged(lockText, nextLock, expected, 'package-lock.json')
  try {
    await write(packagePath, nextPackage)
    await write(lockPath, nextLock)
    const written = versionSet(
      (await read(packagePath)).toString('utf8'),
      (await read(lockPath)).toString('utf8'),
    )
    if (written.packageJson !== expected || written.lockfile !== expected || written.lockRoot !== expected) {
      throw new ReleaseVersionError('package.json and package-lock.json versions were not synchronized.', 3)
    }
    return expected
  } catch (error) {
    await write(packagePath, packageBytes)
    await write(lockPath, lockBytes)
    throw error
  }
}

function bumpResultText(version) {
  return [
    `Prepared package version ${version}.`,
    'No package was released.',
    'This command exits non-zero because version preparation is not release completion.',
    'Build the current Windows setup with:',
    '  npm run release',
    'Store packaging still requires a fresh schema-2 approval:',
    '  npm run release -- --approval=.squad/approvals/<approval>.json',
  ].join('\n')
}

async function runBump(root, kind, dependencies) {
  await assertWorktreeReady(root, dependencies)
  const git = dependencies.git ?? defaultGit
  await assertRestoredLockBlob(root, git)
  const lockModule = await (dependencies.loadReleaseLock ?? loadReleaseLock)(root)
  await assertLocksAvailable(root, lockModule)
  const read = dependencies.readFile ?? readFile
  const before = versionSet(
    (await read(path.join(root, 'package.json'))).toString('utf8'),
    (await read(path.join(root, 'package-lock.json'))).toString('utf8'),
  )
  if (!before.packageJson || before.packageJson !== before.lockfile || before.packageJson !== before.lockRoot) {
    throw new ReleaseVersionError('package.json and package-lock.json versions differ.', 3)
  }
  const handle = await lockModule.acquireOperationLock({
    lockPath: path.join(root, '.release.lock'),
    command: 'release-version-bump',
  })
  try {
    const version = await prepareReleaseVersion(root, kind, {
      ...dependencies,
      assertGate: async () => lockModule,
    })
    return {
      code: 3,
      version,
      prepared: true,
      packaged: false,
      text: bumpResultText(version),
    }
  } finally {
    await handle.release()
  }
}

const APPROVAL_COMMIT_PREFIXES = [
  '.squad/approvals/',
  '.squad/agents/tank/',
  '.squad/decisions/inbox/',
]
const APPROVAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

function committedApprovalCandidate(relative) {
  const normalized = String(relative ?? '').replaceAll('\\', '/')
  if (!normalized.startsWith('.squad/approvals/') || !normalized.endsWith('.json')
    || normalized.includes('\0') || normalized.includes('..') || normalized.includes(':')
    || normalized.includes('//')) {
    return null
  }
  const base = normalized.slice('.squad/approvals/'.length)
  return {
    path: normalized,
    canonical: /^[A-Za-z0-9._-]+\.json$/.test(base),
  }
}

export async function discoverCanonicalApproval(root, dependencies = {}) {
  const git = dependencies.git ?? defaultGit
  const now = dependencies.now ?? new Date()
  const head = await git(root, ['rev-parse', 'HEAD'])
  if (!/^[0-9a-f]{40}$/i.test(head)) {
    throw new ReleaseVersionError('HEAD is not a valid approval commit.', 3)
  }
  const parents = (await git(root, ['rev-list', '--parents', '-n', '1', 'HEAD']))
    .split(/\s+/).slice(1).filter(Boolean)
  if (parents.length !== 1 || !/^[0-9a-f]{40}$/i.test(parents[0])) {
    throw new ReleaseVersionError('HEAD is not a valid approval-only child commit.', 3)
  }
  const parent = parents[0].toLowerCase()
  const changed = (await git(root, [
    'diff-tree', '--no-commit-id', '--name-only', '-r', parent, 'HEAD',
  ])).split(/\r?\n/).filter(Boolean)
  if (!changed.length || changed.some((entry) =>
    entry.includes('\\') || entry.includes('..')
    || !APPROVAL_COMMIT_PREFIXES.some((prefix) => entry.replaceAll('\\', '/').startsWith(prefix)))) {
    throw new ReleaseVersionError('HEAD is not a valid approval-only child commit.', 3)
  }
  const listed = await git(root, [
    'ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', '.squad/approvals',
  ])
  const candidates = listed.split('\0').filter(Boolean).map(committedApprovalCandidate).filter(Boolean)
  if (candidates.length === 0) {
    throw new ReleaseVersionError('No canonical approval is committed in HEAD.', 3)
  }
  if (candidates.length !== 1 || !candidates[0].canonical) {
    throw new ReleaseVersionError('Multiple or non-canonical candidate approvals are committed in HEAD.', 3)
  }
  const approvalPath = normalizeApprovalPath(candidates[0].path)
  let approval
  try {
    approval = JSON.parse(await git(root, ['show', `HEAD:${approvalPath}`]))
  } catch (error) {
    if (error instanceof ReleaseVersionError) throw error
    throw new ReleaseVersionError('Committed approval is stale or mismatched.', 3)
  }
  const committed = await readCommittedVersions(root, git)
  const branch = await git(root, ['branch', '--show-current'])
  const createdAt = Date.parse(approval?.createdAt)
  const expiresAt = Date.parse(approval?.expiresAt)
  const current = now.getTime()
  const versionMatches = approval?.packageVersion
    && approval.packageVersion === committed.packageJson
    && committed.lockfile === approval.packageVersion
    && committed.lockRoot === approval.packageVersion
    && approval.appxVersion === `${approval.packageVersion}.0`
  const fresh = Number.isFinite(createdAt) && Number.isFinite(expiresAt)
    && createdAt <= current + 60_000 && expiresAt > createdAt && current <= expiresAt
    && current - createdAt <= APPROVAL_MAX_AGE_MS
  if (approval?.schemaVersion !== 2 || approval?.kind !== 'karaoke-release-approval'
    || approval?.verdict !== 'APPROVE' || !versionMatches || !branch
    || approval.branch !== branch || !fresh) {
    throw new ReleaseVersionError('Committed approval is stale or mismatched.', 3)
  }
  if (String(approval.targetCommit ?? '').toLowerCase() !== parent) {
    throw new ReleaseVersionError('Committed approval does not bind the sole parent target.', 3)
  }
  return approvalPath
}

async function readCommittedVersions(root, git) {
  const packageText = await git(root, ['show', 'HEAD:package.json'])
  const lockText = await git(root, ['show', 'HEAD:package-lock.json'])
  return versionSet(packageText, lockText)
}

export async function spawnCanonicalDeploy(root, args, env = releaseChildEnv()) {
  const script = path.join(root, 'scripts', 'deploy-release.mjs')
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      env,
      windowsHide: true,
      stdio: 'inherit',
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1 }))
  })
}

async function runPackage(root, options, dependencies) {
  await assertWorktreeReady(root, dependencies)
  const git = dependencies.git ?? defaultGit
  const read = dependencies.readFile ?? readFile
  await assertRestoredLockBlob(root, git)
  const lockModule = await (dependencies.loadReleaseLock ?? loadReleaseLock)(root)
  if (typeof lockModule.issueReleaseCapability === 'function') {
    throw new ReleaseVersionError('Release lock module exposes a general-purpose capability issuer.', 3)
  }
  await assertLocksAvailable(root, lockModule)
  try {
    await git(root, ['ls-files', '--error-unmatch', '--', '.squad/reviewers.json'])
  } catch (error) {
    throw new ReleaseVersionError(
      `Tracked reviewer registry .squad/reviewers.json is required before packaging. ${error.message}`,
      3,
    )
  }
  const validate = dependencies.validateApproval ?? (async (approvalPath) => {
    const imported = await import('./release-artifact-verification.mjs')
    return imported.validateApproval(root, approvalPath)
  })
  let approvalPath = options.approval
  if (!approvalPath) {
    approvalPath = await discoverCanonicalApproval(root, { git, now: dependencies.now })
  }
  let approvalResult
  try {
    approvalResult = await validate(approvalPath, root)
  } catch (error) {
    if (error instanceof ReleaseVersionError) throw error
    throw new ReleaseVersionError(error.message, error.exitCode ?? 5)
  }
  const packageVersion = approvalResult?.approval?.packageVersion
  const committed = await readCommittedVersions(root, git)
  if (!packageVersion || committed.packageJson !== packageVersion
    || committed.lockfile !== packageVersion || committed.lockRoot !== packageVersion) {
    throw new ReleaseVersionError(
      'approval.packageVersion must equal the committed package.json version and both root package-lock.json version fields. This entry will not bump or package.',
      3,
    )
  }
  const packageBefore = await read(path.join(root, 'package.json'))
  const lockBefore = await read(path.join(root, 'package-lock.json'))
  const args = deployArguments({ ...options, approval: approvalPath })
  const spawnDeploy = dependencies.spawnDeploy ?? (
    (deployArgs) => spawnCanonicalDeploy(root, deployArgs, releaseChildEnv(dependencies.env))
  )
  let spawned
  try {
    spawned = await spawnDeploy(args)
  } catch (error) {
    throw new ReleaseVersionError(`Canonical deploy could not be started: ${error.message}`, 1)
  }
  const packageAfter = await read(path.join(root, 'package.json'))
  const lockAfter = await read(path.join(root, 'package-lock.json'))
  if (!sameBytes(packageBefore, packageAfter) || !sameBytes(lockBefore, lockAfter)) {
    throw new ReleaseVersionError(
      'Packaging path observed a package manifest change. Exit 0 is refused and no completion is claimed.',
      3,
    )
  }
  const code = spawned?.code ?? 1
  if (options.dryRun) {
    if (code === 0) {
      return {
        code: 3,
        packaged: false,
        text: 'Dry-run finished without promoting a package. Exit 0 is reserved for a verified NSIS and APPX release.',
      }
    }
    return {
      code,
      packaged: false,
      text: `Dry-run failed with exit ${code}. No package was promoted.`,
    }
  }
  if (code !== 0) {
    return {
      code,
      packaged: false,
      text: `Canonical deploy failed with exit ${code}. No package was promoted by this entry.`,
    }
  }
  return {
    code: 0,
    packaged: true,
    version: packageVersion,
    text: 'Canonical deploy exited 0. This entry did not change package manifests and did not submit to the Store.',
  }
}

const MIN_SETUP_BYTES = 1024 * 1024

function runInherited(command, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: 'inherit',
      windowsHide: true,
    })
    child.on('error', reject)
    child.on('close', (code) => code === 0
      ? resolve()
      : reject(new Error(`${path.basename(command)} ${args.join(' ')} exited with code ${code}.`)))
  })
}

export async function defaultRunSetupBuild(request) {
  const { root, outputRelative, setupName } = request
  const node = process.execPath
  const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
  const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')
  const builder = path.join(root, 'node_modules', 'electron-builder', 'cli.js')
  console.log(`Building ${setupName} into ${outputRelative}`)
  await runInherited(node, [path.join(root, 'scripts', 'clean.mjs')], root)
  await runInherited(node, [tsc, '-b'], root)
  await runInherited(node, [vite, 'build'], root)
  await runInherited(node, [tsc, '-p', 'tsconfig.electron.json'], root)
  await runInherited(node, [
    builder,
    '--win', 'nsis',
    '--x64',
    '--publish', 'never',
    `--config.directories.output=${outputRelative}`,
  ], root, {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  })
}

async function readExecutableHeader(filePath) {
  const handle = await open(filePath, 'r')
  try {
    const header = Buffer.alloc(2)
    const result = await handle.read(header, 0, 2, 0)
    if (result.bytesRead < 2) return ''
    return header.toString('ascii')
  } finally {
    await handle.close()
  }
}

async function locateSetup(outputDir, setupName) {
  const expected = path.join(outputDir, setupName)
  try {
    const info = await stat(expected)
    if (info.isFile()) return expected
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  let entries = []
  try {
    entries = await readdir(outputDir)
  } catch (error) {
    if (error.code === 'ENOENT') return expected
    throw error
  }
  const match = entries.find((name) => /setup/i.test(name) && name.toLowerCase().endsWith('.exe'))
  return match ? path.join(outputDir, match) : expected
}

export async function buildLocalSetup(root, dependencies = {}) {
  const read = dependencies.readFile ?? readFile
  let packageJson
  try {
    packageJson = JSON.parse((await read(path.join(root, 'package.json'))).toString('utf8'))
  } catch (error) {
    throw new ReleaseVersionError(`Cannot read package.json for setup build: ${error.message}`, 3)
  }
  const version = packageJson.version
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
    throw new ReleaseVersionError(`Cannot build a setup for version ${version}.`, 3)
  }
  const productName = packageJson.build?.productName || 'Karaoke Studio'
  if (/[<>:"/\\|?*\u0000]/.test(productName)) {
    throw new ReleaseVersionError('Product name cannot be used in a setup filename.', 3)
  }
  const setupName = `${productName}-Setup-${version}.exe`
  const outputRelative = `release/${version}`
  const outputDir = path.join(root, 'release', version)
  const setupPath = path.join(outputDir, setupName)
  const run = dependencies.runSetupBuild ?? defaultRunSetupBuild
  try {
    await run({
      root,
      version,
      outputDir,
      outputRelative,
      setupName,
      setupPath,
      packageJson,
    })
  } catch (error) {
    if (error instanceof ReleaseVersionError) throw error
    throw new ReleaseVersionError(`Setup build failed: ${error.message}`, error.exitCode ?? 1)
  }
  const produced = await locateSetup(outputDir, setupName)
  let info
  try {
    info = await stat(produced)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    throw new ReleaseVersionError(`Setup was not written to ${outputRelative}/${setupName}.`, 1)
  }
  const relativeSetup = `${outputRelative}/${path.basename(produced)}`
  if (!info.isFile() || info.size < MIN_SETUP_BYTES) {
    throw new ReleaseVersionError(`Setup at ${relativeSetup} is missing or too small.`, 1)
  }
  if (await readExecutableHeader(produced) !== 'MZ') {
    throw new ReleaseVersionError(`Setup at ${relativeSetup} is not a Windows executable.`, 1)
  }
  const topLevel = path.join(root, 'release', setupName)
  let linked = false
  try {
    await mkdir(path.dirname(topLevel), { recursive: true })
    await rm(topLevel, { force: true })
    await link(produced, topLevel)
    linked = true
  } catch {
    try {
      await copyFile(produced, topLevel)
      linked = true
    } catch {
      linked = false
    }
  }
  const lines = [`Built ${relativeSetup}.`]
  if (linked) lines.push(`Setup is also available at release/${setupName}.`)
  else lines.push(`Could not link release/${setupName}; use ${relativeSetup}.`)
  return {
    code: 0,
    packaged: true,
    version,
    setupPath: relativeSetup,
    text: lines.join('\n'),
  }
}

export async function runRelease(argv = [], dependencies = {}) {
  const root = path.resolve(dependencies.root ?? moduleRoot)
  const options = parseReleaseArguments(argv)
  if (options.mode === 'bump') return runBump(root, options.bump, dependencies)
  if (!options.approval) return buildLocalSetup(root, dependencies)
  return runPackage(root, options, dependencies)
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const result = await runRelease(argv)
    if (result.text) {
      if (result.code === 0) console.log(result.text)
      else console.error(result.text)
    }
    process.exitCode = result.code
  } catch (error) {
    console.error(error.message)
    process.exitCode = error.exitCode ?? 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
