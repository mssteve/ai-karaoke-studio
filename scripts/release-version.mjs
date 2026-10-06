import { spawn, spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUMP_KINDS = new Set(['major', 'minor', 'patch'])
export const RESTORED_LOCK_BLOB = 'd1be93dbae5d91a4be10d0323607bac44dfdcf9a'
const CONFLICT_FILES = [
  'scripts/release.mjs',
  'README.md',
  '.squad/skills/full-windows-store-release/SKILL.md',
]
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
    'npm run release did not complete a release.',
    'The only exit-0 release path is a fresh schema-2 approval of the already versioned source:',
    '  npm run release -- --approval=.squad/approvals/<approval>.json',
    'That routes through the canonical deploy workflow, builds NSIS and APPX, and does not change package versions.',
    'Optional --zip or --install may be added to that same command and still require the same approval.',
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
  if (!bump && !approval) throw new ReleaseVersionError(completionInstructions())
  if (bump) return { mode: 'bump', bump }
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
  for (const relative of CONFLICT_FILES) {
    try {
      const text = await read(path.join(root, relative), 'utf8')
      if (CONFLICT_MARKER.test(text)) {
        blockers.push(`${relative} contains unresolved conflict markers.`)
        if (relative === 'scripts/release.mjs') releaseHasMarker = true
      }
    } catch {
      blockers.push(`${relative} cannot be read, so release cannot start.`)
      if (relative === 'scripts/release.mjs') releaseHasMarker = true
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
    'Commit this version, then obtain a fresh schema-2 approval whose sole parent is that exact source.',
    'Complete the release only with:',
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
  let approvalResult
  try {
    approvalResult = await validate(options.approval, root)
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
  const args = deployArguments(options)
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

export async function runRelease(argv = [], dependencies = {}) {
  const root = path.resolve(dependencies.root ?? moduleRoot)
  const options = parseReleaseArguments(argv)
  if (options.mode === 'bump') return runBump(root, options.bump, dependencies)
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
