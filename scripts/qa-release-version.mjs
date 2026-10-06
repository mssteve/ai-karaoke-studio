import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import {
  assertWorktreeReady,
  completionInstructions,
  deployArguments,
  loadReleaseLock,
  nextReleaseVersion,
  parseReleaseArguments,
  prepareReleaseVersion,
  releaseChildEnv,
  ReleaseVersionError,
  RESTORED_LOCK_BLOB,
  runRelease,
} from './release-version.mjs'

const fixtureRoots = []
const approval = '.squad/approvals/tank.json'

test.after(async () => {
  await Promise.all(fixtureRoots.map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(version = '1.2.3') {
  const root = await mkdtemp(path.join(process.cwd(), '.qa-release-version-'))
  fixtureRoots.push(root)
  await mkdir(path.join(root, 'scripts'), { recursive: true })
  await mkdir(path.join(root, '.squad', 'skills', 'full-windows-store-release'), { recursive: true })
  await mkdir(path.join(root, '.squad', 'approvals'), { recursive: true })
  const packageJson = { name: 'karaoke-studio', version, type: 'module' }
  const packageLock = {
    name: 'karaoke-studio',
    version,
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'karaoke-studio', version, dependencies: { demucs: '1.0.0' } } },
    dependencies: { demucs: { version: '1.0.0' } },
  }
  await writeFile(path.join(root, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`)
  await writeFile(path.join(root, 'package-lock.json'), `${JSON.stringify(packageLock, null, 2)}\n`)
  await writeFile(path.join(root, 'scripts', 'release.mjs'), 'export const internal = true\n')
  await writeFile(path.join(root, 'README.md'), 'Karaoke Studio\n')
  await writeFile(
    path.join(root, '.squad', 'skills', 'full-windows-store-release', 'SKILL.md'),
    'canonical\n',
  )
  await writeFile(path.join(root, '.gitignore'), '/.release.lock\n/.release-capability\n/.release-source-*/\n')
  return root
}

const FIXTURE_PROTECTED_SOURCES = [
  '.gitignore',
  '.squad/skills/full-windows-store-release/SKILL.md',
  'README.md',
  'package-lock.json',
  'package.json',
  'scripts/release.mjs',
]

function lockModule(overrides = {}) {
  return {
    ReleaseLockError: class ReleaseLockError extends Error {},
    acquireOperationLock: async () => ({ release: async () => {} }),
    assertActiveReleaseLock: () => {},
    assertCanonicalNodeProcess: () => {},
    consumeReleaseCapability: () => {
      throw new Error('capability consume must not run from the public entry')
    },
    currentProcessIdentity: () => {},
    hashLockToken: () => {},
    readLockState: async () => ({ state: 'available' }),
    ...overrides,
  }
}

function gitDouble(root, version = '1.2.3') {
  const packageText = JSON.stringify({ version })
  const lockText = JSON.stringify({ version, packages: { '': { version } } })
  return async (_cwd, args) => {
    const command = args.join(' ')
    if (command === 'rev-parse --show-toplevel') return root
    if (command === 'status --porcelain=v1 --untracked-files=all') return ''
    if (command === 'hash-object -- scripts/release-operation-lock.mjs') return RESTORED_LOCK_BLOB
    if (command === 'rev-parse HEAD:scripts/release-operation-lock.mjs') return RESTORED_LOCK_BLOB
    if (command === 'ls-files --error-unmatch -- .squad/reviewers.json') return '.squad/reviewers.json'
    if (command === 'show HEAD:package.json') return packageText
    if (command === 'show HEAD:package-lock.json') return lockText
    throw new Error(`unexpected git ${command}`)
  }
}

function ready(root, version, overrides = {}) {
  let acquired = 0
  let released = 0
  const module = lockModule({
    acquireOperationLock: async () => {
      acquired += 1
      return { release: async () => { released += 1 } }
    },
    ...overrides.lock,
  })
  return {
    acquired: () => acquired,
    released: () => released,
    dependencies: {
      root,
      git: overrides.git ?? gitDouble(root, version),
      checkSyntax: async () => {},
      loadReleaseLock: async () => module,
      validateApproval: overrides.validateApproval ?? (async () => ({
        approval: { packageVersion: version, schemaVersion: 2 },
      })),
      spawnDeploy: overrides.spawnDeploy,
      listProtectedSources: overrides.listProtectedSources ?? (async () => FIXTURE_PROTECTED_SOURCES),
    },
  }
}

function showCommittedJson(spec) {
  const result = spawnSync('git', ['show', spec], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

async function assertLiveVersionsMatchCommitted() {
  const headPackage = showCommittedJson('HEAD:package.json')
  const headLock = showCommittedJson('HEAD:package-lock.json')
  const version = headPackage.version
  assert.match(version, /^\d+\.\d+\.\d+$/)
  assert.equal(headLock.version, version)
  assert.equal(headLock.packages[''].version, version)
  const packageJson = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8'))
  const packageLock = JSON.parse(await readFile(path.join(process.cwd(), 'package-lock.json'), 'utf8'))
  assert.equal(packageJson.version, version, 'worktree package.json version drifted from HEAD')
  assert.equal(packageLock.version, version, 'worktree package-lock.json version drifted from HEAD')
  assert.equal(packageLock.packages[''].version, version, 'worktree lock root version drifted from HEAD')
  assert.notEqual(nextReleaseVersion(version, 'patch'), version)
  return version
}

test('completion requires an approval path and forwards build without a bump', () => {
  assert.throws(() => parseReleaseArguments([]), /only exit-0 release path/)
  assert.throws(() => parseReleaseArguments(['--build']), /require --approval/)
  assert.throws(() => parseReleaseArguments(['--zip']), /require --approval/)
  assert.throws(() => parseReleaseArguments(['--install']), /require --approval/)
  assert.throws(() => parseReleaseArguments(['--dry-run']), /require --approval/)
  assert.throws(() => parseReleaseArguments(['--approval=report.json']), /under \.squad\/approvals/)
  assert.throws(() => parseReleaseArguments(['--approval', '.squad/approvals/../secret.json']), /not accepted/)
  assert.throws(() => parseReleaseArguments(['--ship']), /Unknown option/)
  assert.throws(() => parseReleaseArguments(['patch']), /Unknown argument/)
  assert.throws(() => parseReleaseArguments(['--bump=prepatch']), /major, minor, or patch/)
  assert.throws(() => parseReleaseArguments(['--bump']), /requires major, minor, or patch/)
  assert.throws(
    () => parseReleaseArguments(['--bump=patch', `--approval=${approval}`]),
    /cannot be combined/,
  )
  assert.throws(() => parseReleaseArguments(['--dry-run', '--build', `--approval=${approval}`]), /cannot be combined/)
  assert.deepEqual(parseReleaseArguments([`--approval=${approval}`]), {
    mode: 'package', approval, dryRun: false, zip: false, install: false, build: true,
  })
  assert.deepEqual(parseReleaseArguments(['--zip', `--approval=${approval}`, '--install']), {
    mode: 'package', approval, dryRun: false, zip: true, install: true, build: true,
  })
  assert.deepEqual(
    deployArguments(parseReleaseArguments([`--approval=${approval}`])),
    ['--build', `--approval=${approval}`],
  )
  assert.deepEqual(
    deployArguments(parseReleaseArguments(['--install', '--zip', `--approval=${approval}`, '--build'])),
    ['--build', `--approval=${approval}`, '--zip', '--install'],
  )
  assert.deepEqual(
    deployArguments(parseReleaseArguments(['--dry-run', `--approval=${approval}`])),
    ['--dry-run', `--approval=${approval}`],
  )
  assert.equal(nextReleaseVersion('0.3.4', 'patch'), '0.3.5')
  assert.match(completionInstructions(), /npm run release -- --approval=/)
  const env = releaseChildEnv({
    PATH: 'x',
    KARAOKE_RELEASE_CAPABILITY_PATH: 'forged',
    KARAOKE_RELEASE_CAPABILITY_NONCE: 'forged',
    KARAOKE_RELEASE_LOCK_TOKEN: 'forged',
    KARAOKE_RELEASE_DIR: 'forged',
    KARAOKE_RELEASE_SOURCE_DIR: 'forged',
  })
  assert.equal(env.PATH, 'x')
  assert.equal(env.KARAOKE_RELEASE_CAPABILITY_PATH, undefined)
  assert.equal(env.KARAOKE_RELEASE_LOCK_TOKEN, undefined)
})

test('approval forwarding builds through deploy and does not mutate manifests', async () => {
  const root = await fixture('1.2.3')
  const packageBefore = await readFile(path.join(root, 'package.json'))
  const lockBefore = await readFile(path.join(root, 'package-lock.json'))
  let spawned = null
  let writes = 0
  const harness = ready(root, '1.2.3', {
    spawnDeploy: async (args) => {
      spawned = args
      return { code: 0 }
    },
  })
  harness.dependencies.writeFile = async () => { writes += 1 }
  const result = await runRelease([`--approval=${approval}`, '--build'], harness.dependencies)
  assert.equal(result.code, 0)
  assert.equal(result.packaged, true)
  assert.deepEqual(spawned, ['--build', `--approval=${approval}`])
  assert.equal(writes, 0)
  assert.equal(harness.acquired(), 0)
  assert.deepEqual(await readFile(path.join(root, 'package.json')), packageBefore)
  assert.deepEqual(await readFile(path.join(root, 'package-lock.json')), lockBefore)
  assert.match(result.text, /did not change package manifests/)
  assert.match(result.text, /did not submit to the Store/)
})

test('explicit zip and install are forwarded only with build and approval', async () => {
  const root = await fixture()
  let spawned = null
  const harness = ready(root, '1.2.3', {
    spawnDeploy: async (args) => {
      spawned = args
      return { code: 7 }
    },
  })
  const result = await runRelease(['--install', `--approval=${approval}`, '--zip'], harness.dependencies)
  assert.equal(result.code, 7)
  assert.equal(result.packaged, false)
  assert.deepEqual(spawned, ['--build', `--approval=${approval}`, '--zip', '--install'])
  assert.match(result.text, /No package was promoted/)
})

test('dry-run is forwarded and cannot exit 0', async () => {
  const root = await fixture()
  let spawned = null
  const harness = ready(root, '1.2.3', {
    spawnDeploy: async (args) => {
      spawned = args
      return { code: 0 }
    },
  })
  const result = await runRelease(['--dry-run', `--approval=${approval}`], harness.dependencies)
  assert.equal(result.code, 3)
  assert.equal(result.packaged, false)
  assert.deepEqual(spawned, ['--dry-run', `--approval=${approval}`])
  assert.match(result.text, /without promoting a package/)
})

test('invalid approval, live lock, and manifest mismatch do not spawn or write', async () => {
  const root = await fixture('1.2.3')
  const before = await readFile(path.join(root, 'package.json'))
  const rejected = ready(root, '1.2.3', {
    validateApproval: async () => {
      const error = new Error('Approval commit must have exactly one target parent.')
      error.exitCode = 5
      throw error
    },
    spawnDeploy: async () => { throw new Error('spawned') },
  })
  await assert.rejects(runRelease([`--approval=${approval}`], rejected.dependencies), /exactly one target parent/)
  const live = ready(root, '1.2.3', {
    lock: { readLockState: async () => ({ state: 'live' }) },
    spawnDeploy: async () => { throw new Error('spawned') },
  })
  await assert.rejects(runRelease([`--approval=${approval}`], live.dependencies), /lock is live/)
  const mismatch = ready(root, '9.9.9', {
    validateApproval: async () => ({ approval: { packageVersion: '1.2.3' } }),
    spawnDeploy: async () => { throw new Error('spawned') },
  })
  await assert.rejects(
    runRelease([`--approval=${approval}`], mismatch.dependencies),
    /will not bump or package/,
  )
  assert.equal(live.acquired(), 0)
  assert.deepEqual(await readFile(path.join(root, 'package.json')), before)
})

test('bump prepares a version, exits non-zero, and never spawns packaging', async () => {
  const root = await fixture('1.2.3')
  let spawned = false
  const harness = ready(root, '1.2.3', {
    spawnDeploy: async () => { spawned = true; return { code: 0 } },
  })
  const result = await runRelease(['--bump=minor'], harness.dependencies)
  assert.equal(result.code, 3)
  assert.equal(result.prepared, true)
  assert.equal(result.packaged, false)
  assert.equal(result.version, '1.3.0')
  assert.equal(spawned, false)
  assert.equal(harness.acquired(), 1)
  assert.equal(harness.released(), 1)
  assert.match(result.text, /Prepared package version 1\.3\.0/)
  assert.match(result.text, /No package was released/)
  assert.match(result.text, /npm run release -- --approval=/)
  assert.doesNotMatch(result.text, /deploy-release/)
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const packageLock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'))
  assert.equal(packageJson.version, '1.3.0')
  assert.equal(packageLock.version, '1.3.0')
  assert.equal(packageLock.packages[''].version, '1.3.0')
  assert.equal(packageLock.dependencies.demucs.version, '1.0.0')
})

test('bump refuses a dirty tree, conflict markers, and a live lock before writing', async () => {
  const root = await fixture('4.5.6')
  const before = await readFile(path.join(root, 'package.json'))
  const dirty = ready(root, '4.5.6', {
    git: async (_cwd, args) => {
      if (args[0] === 'status') return ' M package.json'
      return gitDouble(root, '4.5.6')(_cwd, args)
    },
  })
  await assert.rejects(runRelease(['--bump=patch'], dirty.dependencies), /not clean/)
  assert.equal(dirty.acquired(), 0)
  await writeFile(path.join(root, 'scripts', 'release.mjs'), '<<<<<<< ours\nexport {}\n>>>>>>> theirs\n')
  const conflicted = ready(root, '4.5.6')
  await assert.rejects(runRelease(['--bump', 'major'], conflicted.dependencies), /conflict markers/)
  assert.equal(conflicted.acquired(), 0)
  const live = ready(root, '4.5.6', {
    lock: { readLockState: async () => ({ state: 'invalid' }) },
  })
  await writeFile(path.join(root, 'scripts', 'release.mjs'), 'export {}\n')
  await assert.rejects(runRelease(['--bump=patch'], live.dependencies), /lock is invalid/)
  assert.equal(live.acquired(), 0)
  assert.deepEqual(await readFile(path.join(root, 'package.json')), before)
})

test('a failed lock write rolls both version files back and releases the lock', async () => {
  const root = await fixture('9.9.9')
  const packagePath = path.join(root, 'package.json')
  const lockPath = path.join(root, 'package-lock.json')
  const packageBefore = await readFile(packagePath)
  const lockBefore = await readFile(lockPath)
  const harness = ready(root, '9.9.9')
  harness.dependencies.writeFile = async (file, contents) => {
    if (file === lockPath && !Buffer.isBuffer(contents)) throw new Error('lock write failed')
    await writeFile(file, contents)
  }
  await assert.rejects(runRelease(['--bump=patch'], harness.dependencies), /lock write failed/)
  assert.equal(harness.released(), 1)
  assert.deepEqual(await readFile(packagePath), packageBefore)
  assert.deepEqual(await readFile(lockPath), lockBefore)
})

test('unsynchronized manifests and a capability issuer are rejected before a write', async () => {
  const root = await fixture('1.2.3')
  const lockPath = path.join(root, 'package-lock.json')
  const lock = JSON.parse(await readFile(lockPath, 'utf8'))
  lock.version = '1.2.4'
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`)
  const packageBefore = await readFile(path.join(root, 'package.json'))
  let writes = 0
  await assert.rejects(prepareReleaseVersion(root, 'patch', {
    assertGate: async () => lockModule(),
    writeFile: async () => { writes += 1 },
  }), /versions differ/)
  assert.equal(writes, 0)
  assert.deepEqual(await readFile(path.join(root, 'package.json')), packageBefore)
  await writeFile(
    path.join(root, 'scripts', 'release-operation-lock.mjs'),
    'export function issueReleaseCapability() { return true }\n',
  )
  await assert.rejects(prepareReleaseVersion(root, 'patch'), /capability issuer/)
})

test('package script wiring is the sole release entry and does not recurse', async () => {
  const packageJson = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8'))
  assert.equal(packageJson.scripts.release, 'node scripts/release-version.mjs')
  assert.equal(packageJson.scripts.dist, 'npm run release --')
  assert.equal(packageJson.scripts['dist:store'], 'npm run release --')
  await assertLiveVersionsMatchCommitted()
  const source = await readFile(path.join(process.cwd(), 'scripts', 'release-version.mjs'), 'utf8')
  assert.equal(source.includes('scripts/deploy-release.mjs'), true)
  assert.equal(source.includes('npm run release'), true)
  assert.equal(source.includes("spawn('npm'") || source.includes('spawn("npm"'), false)
  assert.equal(source.includes('issueReleaseCapability('), false)
  assert.equal(/consumeReleaseCapability\s*\(/.test(source), false)
  assert.equal(/spawn\([\s\S]{0,120}release\.mjs/.test(source), false)
  const lock = await loadReleaseLock(process.cwd())
  assert.equal(typeof lock.issueReleaseCapability, 'undefined')
  assert.equal(typeof lock.consumeReleaseCapability, 'function')
  assert.equal(typeof lock.acquireOperationLock, 'function')
})

test('command fails closed on invalid args and conflicted approval without changing the committed version', async () => {
  const packagePath = path.join(process.cwd(), 'package.json')
  const lockPath = path.join(process.cwd(), 'package-lock.json')
  const packageBefore = await readFile(packagePath)
  const lockBefore = await readFile(lockPath)
  const cases = [
    [['--bump=nope'], 2, /major, minor, or patch/],
    [[], 2, /only exit-0 release path/],
    [['--approval=report.json'], 2, /under \.squad\/approvals/],
    [['--bump=patch', `--approval=${approval}`], 2, /cannot be combined/],
    [[`--approval=${approval}`], 3, /not clean|conflict markers|does not parse|restored committed lock blob/],
    [['--bump=patch'], 3, /not clean|conflict markers|restored committed lock blob/],
  ]
  for (const [args, status, pattern] of cases) {
    const result = spawnSync(process.execPath, ['scripts/release-version.mjs', ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })
    assert.equal(result.status, status, `${args.join(' ')} => ${result.status}\n${result.stderr}`)
    assert.match(result.stderr, pattern)
    assert.doesNotMatch(result.stderr, /REJECT:|electron-builder|No package was released\.\nThis command exits non-zero because version preparation/)
    assert.equal(result.stdout.includes('Canonical deploy exited 0'), false)
  }
  assert.deepEqual(await readFile(packagePath), packageBefore)
  assert.deepEqual(await readFile(lockPath), lockBefore)
  const version = await assertLiveVersionsMatchCommitted()
  const packageJson = JSON.parse(packageBefore.toString('utf8'))
  const packageLock = JSON.parse(lockBefore.toString('utf8'))
  assert.equal(packageJson.version, version)
  assert.equal(packageLock.version, version)
  assert.equal(packageLock.packages[''].version, version)
})

test('canonical reviewer registry matches approval validation identities and is not ignored', async () => {
  const registry = JSON.parse(await readFile(path.join(process.cwd(), '.squad', 'reviewers.json'), 'utf8'))
  assert.equal(registry.schemaVersion, 1)
  assert.deepEqual(registry.reviewers, [{
    identity: 'Tank',
    role: 'independent-release-reviewer',
    name: 'Tank Reviewer',
    email: 'tank@squad.local',
  }])
  assert.equal(registry.approvalPolicy.reviewerIdentity, 'Tank')
  assert.equal(registry.approvalPolicy.requiredTrailers['Reviewed-by'], 'Tank <tank@squad.local>')
  assert.equal(registry.approvalPolicy.requiredTrailers['Reviewer-Role'], 'independent-release-reviewer')
  assert.deepEqual(registry.approvalPolicy.allowedCommitters, [
    { identity: 'Tank', name: 'Tank Reviewer', email: 'tank@squad.local' },
    {
      identity: 'project-maintainer',
      name: 'Karaoke Studio Maintainer',
      email: 'maintainer@squad.local',
    },
  ])
  const ignored = spawnSync('git', ['check-ignore', '--quiet', '--', '.squad/reviewers.json'], {
    cwd: process.cwd(),
  })
  assert.equal(ignored.status, 1)
  const verification = await readFile(path.join(process.cwd(), 'scripts', 'release-artifact-verification.mjs'), 'utf8')
  assert.match(verification, /'\.squad\/reviewers\.json'/)
  assert.match(verification, /'\.gitignore'/)
  const entry = await readFile(path.join(process.cwd(), 'scripts', 'release-version.mjs'), 'utf8')
  assert.match(entry, /snapshotProtectedCommit/)
  assert.doesNotMatch(entry, /CONFLICT_FILES/)
})

test('protected-source conflict markers stop bump and package before writes', async () => {
  const root = await fixture('4.5.6')
  const before = await readFile(path.join(root, 'package.json'))
  await writeFile(
    path.join(root, '.gitignore'),
    '<<<<<<< Updated upstream\n/.release.lock\n=======\n>>>>>>> Stashed changes\n',
  )
  let spawned = false
  const harness = ready(root, '4.5.6', {
    spawnDeploy: async () => {
      spawned = true
      return { code: 0 }
    },
  })
  await assert.rejects(
    runRelease(['--bump=patch'], harness.dependencies),
    /\.gitignore contains unresolved conflict markers/,
  )
  await assert.rejects(
    runRelease([`--approval=${approval}`], harness.dependencies),
    /\.gitignore contains unresolved conflict markers/,
  )
  assert.equal(harness.acquired(), 0)
  assert.equal(spawned, false)
  assert.deepEqual(await readFile(path.join(root, 'package.json')), before)
})

async function committedMarkerRepository(relative, contents) {
  const root = await fixture('1.2.3')
  await mkdir(path.join(root, '.git'), { recursive: true })
  await rm(path.join(root, '.git'), { recursive: true, force: true })
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, `${args.join(' ')} => ${result.stderr}`)
  }
  git(['init', '--quiet'])
  git(['config', 'user.email', 'qa@example.invalid'])
  git(['config', 'user.name', 'Release Author'])
  await mkdir(path.dirname(path.join(root, ...relative.split('/'))), { recursive: true })
  await writeFile(path.join(root, ...relative.split('/')), contents)
  git(['add', '.'])
  git(['commit', '--quiet', '-m', 'fixture'])
  return root
}

test('committed protected-source markers fail before deploy through the shared inventory', async () => {
  const gitignore = await committedMarkerRepository(
    '.gitignore',
    '<<<<<<< Updated upstream\n/.release.lock\n=======\n>>>>>>> Stashed changes\n',
  )
  await assert.rejects(assertWorktreeReady(gitignore), /\.gitignore contains unresolved conflict markers/)
  const nested = await committedMarkerRepository(
    'scripts/nested-protected.txt',
    'clean\n<<<<<<< ours\n=======\n>>>>>>> theirs\n',
  )
  await assert.rejects(
    assertWorktreeReady(nested),
    /scripts\/nested-protected\.txt contains unresolved conflict markers/,
  )
  const packageBefore = await readFile(path.join(nested, 'package.json'))
  await assert.rejects(runRelease(['--bump=patch'], { root: nested }), /conflict markers/)
  assert.deepEqual(await readFile(path.join(nested, 'package.json')), packageBefore)
})
