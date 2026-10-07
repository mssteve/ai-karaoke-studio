import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  cp,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'
import { createRequire } from 'node:module'
import {
  atomicPromote,
  createFriendZip,
  createStoredZip,
  DeployError,
  EXIT,
  installApprovedRelease,
  killExactTree,
  normalizeError,
  parseArguments,
  promoteOwnedRelease,
  redact,
  runDeploy,
  verifyFriendZip,
} from './deploy-release.mjs'
import {
  ArtifactVerificationError,
  compareSnapshots,
  hashFile,
  snapshotProtectedCommit,
  snapshotProtectedSources,
  validateApproval,
  verifyApprovedRelease,
} from './release-artifact-verification.mjs'
import {
  acquireOperationLock,
  assertCanonicalNodeProcess,
  consumeReleaseCapability,
  hashLockToken,
  readLockState,
  ReleaseLockError,
} from './release-operation-lock.mjs'
import {
  assertIsolatedResolvedPath,
  materializeCanonicalSource,
  installIsolatedDependencies,
  lockIsolatedDependencies,
  removeCanonicalStage,
  snapshotCanonicalStage,
  snapshotIsolatedDependencies,
} from './release-source-staging.mjs'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const fixtureRoots = []

test.after(async () => {
  await Promise.all(fixtureRoots.map((root) => rm(root, { recursive: true, force: true })))
})

test('release lock module exposes no general-purpose capability issuer', async () => {
  const module = await import('./release-operation-lock.mjs')
  assert.equal('issueReleaseCapability' in module, false)
})

test('arbitrary importer direct issue call cannot create a capability artifact', async () => {
  const capabilityPath = path.join(process.cwd(), '.release-capability')
  await rm(capabilityPath, { force: true })
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    "import * as lock from './scripts/release-operation-lock.mjs';"
      + "if(typeof lock.issueReleaseCapability!=='function')process.exit(23);"
      + "await lock.issueReleaseCapability({capabilityPath:'.release-capability'});",
  ], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(result.status, 23)
  assert.equal(existsSync(capabilityPath), false)
})

const SAFE_FIXTURE_ATTRIBUTES = '* text=auto -eol -filter -ident -working-tree-encoding\n'
  + '*.html text eol=lf\n'
  + '*.json text eol=lf -filter -ident -working-tree-encoding\n'
  + '*.ts text eol=lf\n'
  + '*.txt text eol=lf\n'
  + '.gitattributes text eol=lf -filter -ident -working-tree-encoding\n'
  + '.gitignore text eol=lf -filter -ident -working-tree-encoding\n'

async function fixture(name = 'deploy', mutateReviewerRegistry, attributes = SAFE_FIXTURE_ATTRIBUTES) {
  const root = await mkdtemp(path.join(process.cwd(), `.qa-${name}-`))
  fixtureRoots.push(root)
  for (const directory of ['electron', 'src', 'build', 'scripts', 'release', 'zip']) {
    await mkdir(path.join(root, directory), { recursive: true })
  }
  await writeFile(path.join(root, 'electron', 'main.ts'), 'export {}\n')
  await writeFile(path.join(root, 'src', 'main.ts'), 'export {}\n')
  await writeFile(path.join(root, 'build', 'icon.txt'), 'icon\n')
  await writeFile(path.join(root, 'index.html'), '<main></main>\n')
  for (const config of [
    'tsconfig.json',
    'tsconfig.app.json',
    'tsconfig.electron.json',
    'tsconfig.node.json',
  ]) await writeFile(path.join(root, config), '{}\n')
  await writeFile(path.join(root, 'vite.config.ts'), 'export default {}\n')
  await writeFile(
    path.join(root, '.gitattributes'),
    attributes,
  )
  const packageJson = {
    name: 'karaoke-studio',
    version: '0.3.4',
    type: 'module',
    build: {
      productName: 'Karaoke Studio',
      appx: { identityName: 'KaraokeStudio', applicationId: 'KaraokeStudio' },
    },
  }
  await writeFile(path.join(root, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`)
  await writeFile(path.join(root, 'package-lock.json'), `${JSON.stringify({
    name: 'karaoke-studio',
    version: '0.3.4',
    packages: { '': { name: 'karaoke-studio', version: '0.3.4' } },
  }, null, 2)}\n`)
  await mkdir(path.join(root, '.squad'), { recursive: true })
  const reviewerRegistry = {
    schemaVersion: 1,
    reviewers: [{
      identity: 'Tank',
      role: 'independent-release-reviewer',
      name: 'Tank Reviewer',
      email: 'tank@squad.local',
    }],
    approvalPolicy: {
      reviewerIdentity: 'Tank',
      requiredTrailers: {
        'Reviewed-by': 'Tank <tank@squad.local>',
        'Reviewer-Role': 'independent-release-reviewer',
      },
      allowedCommitters: [
        { identity: 'Tank', name: 'Tank Reviewer', email: 'tank@squad.local' },
        {
          identity: 'project-maintainer',
          name: 'Karaoke Studio Maintainer',
          email: 'maintainer@squad.local',
        },
      ],
    },
  }
  mutateReviewerRegistry?.(reviewerRegistry)
  await writeFile(
    path.join(root, '.squad', 'reviewers.json'),
    `${JSON.stringify(reviewerRegistry, null, 2)}\n`,
  )
  spawnSync('git', ['init', '--quiet'], { cwd: root })
  spawnSync('git', ['config', 'user.email', 'qa@example.invalid'], { cwd: root })
  spawnSync('git', ['config', 'user.name', 'Release Author'], { cwd: root })
  spawnSync('git', ['add', '.'], { cwd: root })
  spawnSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root })
  return root
}

function aggregate(entries) {
  const hash = createHash('sha256')
  for (const entry of entries) hash.update(`${entry.path}\0${entry.sha256}\n`)
  return hash.digest('hex')
}

async function approvedFixture(mutateReviewerRegistry, attributes) {
  const root = await fixture('approved', mutateReviewerRegistry, attributes)
  const targetCommit = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root, encoding: 'utf8',
  }).stdout.trim()
  const sources = await snapshotProtectedSources(root)
  const evidencePath = path.join(root, '.squad', 'agents', 'tank', 'report.json')
  await mkdir(path.dirname(evidencePath), { recursive: true })
  const evidenceCreatedAt = new Date(Date.now() - 60_000).toISOString()
  await writeFile(evidencePath, `${JSON.stringify({
    kind: 'karaoke-release-evidence',
    reviewer: {
      identity: 'Tank',
      role: 'independent-release-reviewer',
    },
    verdict: 'APPROVE',
    status: 'passed',
    passed: 3,
    total: 3,
    createdAt: evidenceCreatedAt,
  })}\n`)
  const branch = spawnSync('git', ['branch', '--show-current'], {
    cwd: root, encoding: 'utf8',
  }).stdout.trim()
  const approvalPath = path.join(root, '.squad', 'approvals', 'tank.json')
  await mkdir(path.dirname(approvalPath), { recursive: true })
  const createdAt = new Date().toISOString()
  const approval = {
    schemaVersion: 2,
    kind: 'karaoke-release-approval',
    reviewer: { identity: 'Tank', role: 'independent-release-reviewer' },
    verdict: 'APPROVE',
    packageVersion: '0.3.4',
    appxVersion: '0.3.4.0',
    branch,
    targetCommit,
    source: { sha256: sources.sha256, fileCount: sources.files.length },
    evidence: [{
      name: 'tank-release-verdict',
      path: '.squad/agents/tank/report.json',
      sha256: await hashFile(evidencePath),
      status: 'passed',
      passed: 3,
      total: 3,
      createdAt: evidenceCreatedAt,
    }],
    createdAt,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  }

  await writeFile(approvalPath, `${JSON.stringify(approval)}\n`)
  spawnSync('git', ['add', '.squad'], { cwd: root })
  const approvalCommitResult = spawnSync('git', [
    '-c', 'user.name=Karaoke Studio Maintainer',
    '-c', 'user.email=maintainer@squad.local',
    'commit', '--quiet', '-m',
    'Approve release target\n\nReviewed-by: Tank <tank@squad.local>\nReviewer-Role: independent-release-reviewer',
    '--author=Tank Reviewer <tank@squad.local>',
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(approvalCommitResult.status, 0, approvalCommitResult.stderr)
  const approvalCommit = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root, encoding: 'utf8',
  }).stdout.trim()
  const appDir = path.join(root, 'app-input')
  await mkdir(path.join(appDir, 'dist-electron'), { recursive: true })
  await writeFile(path.join(appDir, 'package.json'), JSON.stringify({ version: '0.3.4' }))
  await writeFile(path.join(appDir, 'dist-electron', 'main.js'), 'main')
  const releaseDir = path.join(root, 'release', '0.3.4')
  const appAsar = path.join(releaseDir, 'win-unpacked', 'resources', 'app.asar')
  await mkdir(path.dirname(appAsar), { recursive: true })
  await asar.createPackage(appDir, appAsar)
  const outputHash = createHash('sha256').update('main').digest('hex')
  const exeName = 'Karaoke Studio-Setup-0.3.4.exe'
  const appxName = 'Karaoke Studio-Setup-0.3.4.appx'
  await writeFile(path.join(releaseDir, exeName), 'approved-installer')
  await createStoredZip(path.join(releaseDir, appxName), [{
    name: 'AppxManifest.xml',
    buffer: Buffer.from(
      `<?xml version="1.0" encoding="utf-8"?><Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10" xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"><Identity Name="KaraokeStudio" Version="0.3.4.0" ProcessorArchitecture="x64" Publisher="CN=qa"/><Properties/><Resources/><Applications><Application Id="KaraokeStudio" Executable="app\\Karaoke Studio.exe" EntryPoint="Windows.FullTrustApplication"/></Applications><Capabilities><DeviceCapability Name="microphone"/></Capabilities></Package>`,
    ),
  }])
  const artifacts = []
  for (const name of [exeName, appxName]) {
    const filePath = path.join(releaseDir, name)
    artifacts.push({
      path: `release/0.3.4/${name}`,
      bytes: (await stat(filePath)).size,
      sha256: await hashFile(filePath),
    })

  }
  const provenance = {
    verdict: 'APPROVE',
    packageVersion: '0.3.4',
    approval: {
      path: '.squad/approvals/tank.json',
      sha256: await hashFile(approvalPath),
      verdict: 'APPROVE',
      passed: 3,
      total: 3,
    },
    source: {
      files: sources.files,
      sha256: aggregate(sources.files),
      fileCount: sources.files.length,
      branch,
      head: targetCommit,
      approvalCommit,
    },
    buildOutputs: { 'dist-electron/main.js': outputHash },
    verification: {
      sourceUnchangedDuringRelease: true,
      sourceComparison: { missing: [], extra: [], mismatched: [] },
      liveSourceComparison: { missing: [], extra: [], mismatched: [] },
      canonicalStaging: {
        commit: targetCommit,
        sha256: sources.sha256,
        fileCount: sources.files.length,
        fullTreeFileCount: sources.files.length,
        fullTreeSha256: sources.sha256,
        dependencyMode: 'fresh-lockfile-npm-ci-isolated-read-only',
        dependencies: {
          root: 'node_modules',
          fileCount: 1,
          sha256: 'a'.repeat(64),
          cacheFileCount: 1,
          cacheSha256: 'b'.repeat(64),
          packageJsonSha256: 'c'.repeat(64),
          lockfileSha256: 'd'.repeat(64),
          registryOrigin: 'https://registry.example.invalid',
          npm: {
            version: '11.12.1',
            cli: 'npm-cli.js',
            cliSha256: 'e'.repeat(64),
            nodeVersion: process.version,
            nodeExecutableSha256: 'f'.repeat(64),
          },
          tools: {
            typescript: { path: 'node_modules/typescript/bin/tsc', sha256: '1'.repeat(64) },
          },
          mutationProtection: 'windows-acl-read-execute',
          verifiedAfterPackaging: true,
        },
        cleanedAfterRelease: true,
      },
      appxManifest: {
        identity: { name: 'KaraokeStudio', version: '0.3.4.0', processorArchitecture: 'x64' },
        microphoneCapability: true,
      },
      secretScans: {
        verdict: 'APPROVE',
        findings: 0,
        scans: [{
          findings: [],
          prohibitedPathFindings: 0,
          credentialContentFindings: 0,
        }],
      },
    },
    artifacts,
    hashesPath: 'release/0.3.4/SHA256SUMS.txt',
  }
  await writeFile(
    path.join(releaseDir, 'provenance.json'),
    `${JSON.stringify(provenance, null, 2)}\n`,
  )
  await writeFile(
    path.join(releaseDir, 'SHA256SUMS.txt'),
    `${artifacts.map((entry) => `${entry.sha256}  ${path.basename(entry.path)}`).join('\n')}\n`,
  )
  return {
    root, releaseDir, provenance, approval, approvalPath, evidencePath, exeName, appxName,
    targetCommit, approvalCommit,
  }
}

async function amendApproval(data, mutate, extraPaths = []) {
  mutate(data.approval)
  await writeFile(data.approvalPath, `${JSON.stringify(data.approval)}\n`)
  spawnSync('git', ['add', '.squad', ...extraPaths], { cwd: data.root })
  const result = spawnSync('git', [
    '-c', 'user.name=Karaoke Studio Maintainer',
    '-c', 'user.email=maintainer@squad.local',
    'commit', '--amend', '--quiet', '--no-edit',
    '--author=Tank Reviewer <tank@squad.local>',
  ], { cwd: data.root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}

async function amendApprovalMessage(data, message, {
  committerName = 'Karaoke Studio Maintainer',
  committerEmail = 'maintainer@squad.local',
} = {}) {
  const result = spawnSync('git', [
    '-c', `user.name=${committerName}`,
    '-c', `user.email=${committerEmail}`,
    'commit', '--amend', '--quiet', '-m', message,
    '--author=Tank Reviewer <tank@squad.local>',
  ], { cwd: data.root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}

test('no arguments defaults to dry-run', () => {
  assert.deepEqual(parseArguments([]), {
    dryRun: true, build: false, zip: false, install: false,
  })
})

test('combined modes retain build, ZIP, install order intent', () => {
  assert.deepEqual(parseArguments(['--build', '--approval=x', '--zip', '--install']), {
    dryRun: false, build: true, zip: true, install: true, approval: 'x',
  })
})

test('npm release is the sole completion entry and low-level release rejects bypass', async () => {
  const packageJson = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8'))
  assert.equal(packageJson.scripts.release, 'node scripts/release-version.mjs')
  assert.equal(packageJson.scripts.dist, 'npm run release --')
  assert.equal(packageJson.scripts['dist:store'], 'npm run release --')
  const source = await readFile(path.join(process.cwd(), 'scripts', 'release-version.mjs'), 'utf8')
  assert.equal(source.includes('scripts/deploy-release.mjs'), true)
  assert.equal(source.includes('issueReleaseCapability('), false)
  assert.equal(source.includes("from './deploy-release.mjs'"), false)
  assert.equal(source.includes("from './release-operation-lock.mjs'"), false)
  assert.equal(/spawn\([\s\S]{0,120}release\.mjs/.test(source), false)
  const result = spawnSync(process.execPath, ['scripts/release.mjs', '--approval=anything.json'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      KARAOKE_RELEASE_CAPABILITY_PATH: '',
      KARAOKE_RELEASE_CAPABILITY_NONCE: '',
    },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Low-level packaging is internal/)
})

test('direct low-level release rejects an attacker-written capability record', async () => {
  const capabilityPath = path.join(process.cwd(), '.release-capability')
  const nonce = 'ef'.repeat(32)
  await writeFile(capabilityPath, `${JSON.stringify({
    schema: 1,
    nonce,
    operation: 'package-release',
    parent: { pid: 999998, parentPid: 1, startTime: 'forged' },
    child: { pid: 999999, parentPid: 999998, startTime: 'forged' },
    head: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    sourceSha256: (await snapshotProtectedCommit(
      process.cwd(),
      spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    )).sha256,
    version: '0.3.4',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })}\n`)
  try {
    const result = spawnSync(process.execPath, [
      'scripts/release.mjs', '--approval=.squad/approvals/forged.json',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        KARAOKE_RELEASE_CAPABILITY_PATH: capabilityPath,
        KARAOKE_RELEASE_CAPABILITY_NONCE: nonce,
      },
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /capability|Low-level packaging is internal/i)
  } finally {
    await rm(capabilityPath, { force: true })
  }
})

for (const [name, args] of [
  ['unknown flag', ['--skip-build']],
  ['removed legacy migration flag', ['--migrate-legacy-release']],
  ['missing approval', ['--build']],
  ['dry-run mutation', ['--dry-run', '--zip']],
  ['approval without build', ['--zip', '--approval=x']],
]) {
  test(`argument validation rejects ${name}`, () => {
    assert.throws(() => parseArguments(args), (error) => error.exitCode === EXIT.USAGE)
  })
}

test('documented exit codes and failure classes map completely', () => {
  assert.deepEqual(Object.values(EXIT), [0, 2, 3, 4, 5, 6, 7, 8])
  for (const [error, code] of [
    [new DeployError('usage', EXIT.USAGE), EXIT.USAGE],
    [new DeployError('source', EXIT.SOURCE), EXIT.SOURCE],
    [new ReleaseLockError('lock'), EXIT.LOCK],
    [new ArtifactVerificationError('artifact'), EXIT.ARTIFACT],
    [new DeployError('zip', EXIT.ZIP), EXIT.ZIP],
    [new DeployError('install', EXIT.INSTALL), EXIT.INSTALL],
    [new DeployError('promotion', EXIT.PROMOTION), EXIT.PROMOTION],
  ]) assert.equal(normalizeError(error).exitCode, code)
})

test('logs redact repository, user paths, tokens, keys, passwords, and bearer values', () => {
  const malicious = [
    process.cwd(),
    process.env.USERPROFILE,
    'C:\\Users\\victim\\private\\song.mp3',
    '--token=abc123',
    '--api-key=secret-value',
    'password hunter2',
    'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
  ].filter(Boolean).join(' ')
  const output = redact(process.cwd(), malicious)
  assert.doesNotMatch(output, /abc123|secret-value|hunter2|eyJhbGci|victim|karaoke-player/i)
  assert.match(output, /redacted/i)
})

test('approved release verifies exact names, hashes, source, ASAR, secret and approval results', async () => {
  const { root } = await approvedFixture()
  const approved = await verifyApprovedRelease({ root })
  assert.equal(approved.version, '0.3.4')
  assert.equal(approved.artifacts.exe.name, 'Karaoke Studio-Setup-0.3.4.exe')
})

for (const [label, mutate] of [
  ['wrong reviewer', (approval) => { approval.reviewer.identity = 'Switch' }],
  ['wrong reviewer role', (approval) => { approval.reviewer.role = 'release-author' }],
  ['wrong version', (approval) => { approval.packageVersion = '0.3.5' }],
  ['wrong APPX version', (approval) => { approval.appxVersion = '0.3.5.0' }],
  ['wrong branch', (approval) => { approval.branch = 'main' }],
  ['wrong target', (approval) => { approval.targetCommit = '0'.repeat(40) }],
  ['wrong source aggregate', (approval) => { approval.source.sha256 = '0'.repeat(64) }],
  ['wrong source count', (approval) => { approval.source.fileCount += 1 }],
  ['evidence hash mismatch', (approval) => { approval.evidence[0].sha256 = '0'.repeat(64) }],
  ['failed evidence', (approval) => { approval.evidence[0].status = 'failed' }],
  ['bad pass count', (approval) => { approval.evidence[0].passed = 2 }],
  ['stale approval', (approval) => {
    approval.createdAt = '2020-01-01T00:00:00.000Z'
    approval.expiresAt = '2020-01-02T00:00:00.000Z'
  }],
  ['path escape', (approval) => { approval.evidence[0].path = '..\\outside.json' }],
  ['unknown field', (approval) => { approval.fabricated = true }],
]) {
  test(`strict approval rejects ${label}`, async () => {
    const data = await approvedFixture()
    mutate(data.approval)
    await writeFile(data.approvalPath, JSON.stringify(data.approval))
    await assert.rejects(validateApproval(data.root, '.squad/approvals/tank.json'))
  })
}

test('strict approval rejects mutable and ignored evidence', async () => {
  const mutable = await approvedFixture()
  await writeFile(mutable.evidencePath, '{"changed":true}\n')
  mutable.approval.evidence[0].sha256 = await hashFile(mutable.evidencePath)
  await writeFile(mutable.approvalPath, JSON.stringify(mutable.approval))
  await assert.rejects(
    validateApproval(mutable.root, '.squad/approvals/tank.json'),
    /mutable|physical bytes/,
  )

  const ignored = await approvedFixture()
  const ignoredPath = path.join(ignored.root, '.squad', 'agents', 'tank', 'ignored.json')
  await writeFile(path.join(ignored.root, '.git', 'info', 'exclude'), '.squad/agents/tank/ignored.json\n')
  await writeFile(ignoredPath, '{}\n')
  ignored.approval.evidence[0].path = '.squad/agents/tank/ignored.json'
  ignored.approval.evidence[0].sha256 = await hashFile(ignoredPath)
  await writeFile(ignored.approvalPath, JSON.stringify(ignored.approval))
  await assert.rejects(validateApproval(
    ignored.root, '.squad/approvals/tank.json',
  ), /regular file|ignored|mutable|physical bytes/)
})

test('valid two-commit approval binds the target parent and current approval blob', async () => {
  const data = await approvedFixture()
  const result = await validateApproval(data.root, '.squad/approvals/tank.json')
  assert.equal(result.targetCommit, data.targetCommit)
  assert.equal(result.approvalCommit, data.approvalCommit)
  assert.equal(result.sha256, await hashFile(data.approvalPath))
})

test('approval accepts LF Git blobs with policy-authorized CRLF checkout bytes and hashes canonical blobs', async () => {
  const data = await approvedFixture(undefined, SAFE_FIXTURE_ATTRIBUTES
    + '.squad/approvals/*.json text eol=crlf\n'
    + '.squad/agents/tank/*.json text eol=crlf\n')
  for (const filePath of [data.approvalPath, data.evidencePath]) {
    const text = await readFile(filePath, 'utf8')
    await writeFile(filePath, text.replace(/\r?\n/g, '\r\n'))
  }
  assert.equal(spawnSync('git', [
    'diff', '--quiet', 'HEAD', '--',
    '.squad/approvals/tank.json',
    '.squad/agents/tank/report.json',
  ], { cwd: data.root }).status, 0)
  const result = await validateApproval(data.root, '.squad/approvals/tank.json')
  const approvalBlob = spawnSync('git', [
    'show', 'HEAD:.squad/approvals/tank.json',
  ], { cwd: data.root }).stdout
  const evidenceBlob = spawnSync('git', [
    'show', 'HEAD:.squad/agents/tank/report.json',
  ], { cwd: data.root }).stdout
  assert.equal(result.sha256, createHash('sha256').update(approvalBlob).digest('hex'))
  assert.equal(
    result.approval.evidence[0].sha256,
    createHash('sha256').update(evidenceBlob).digest('hex'),
  )
  assert.notEqual(await hashFile(data.approvalPath), result.sha256)
  assert.notEqual(await hashFile(data.evidencePath), result.approval.evidence[0].sha256)
})

for (const [label, relative, mutate] of [
  ['unstaged approval content', '.squad/approvals/tank.json', async (filePath) => {
    await writeFile(filePath, '{"tampered":true}\n')
  }],
  ['staged evidence content', '.squad/agents/tank/report.json', async (filePath, root) => {
    await writeFile(filePath, '{"tampered":true}\n')
    spawnSync('git', ['add', '.squad/agents/tank/report.json'], { cwd: root })
  }],
  ['deleted approval', '.squad/approvals/tank.json', async (filePath) => {
    await rm(filePath)
  }],
  ['type-changed evidence', '.squad/agents/tank/report.json', async (filePath) => {
    await rm(filePath)
    await mkdir(filePath)
  }],
]) {
  test(`approval canonical blob gate rejects ${label}`, async () => {
    const data = await approvedFixture()
    await mutate(path.join(data.root, relative), data.root)
    await assert.rejects(validateApproval(
      data.root, '.squad/approvals/tank.json',
    ), /Approval|evidence|mutable|regular|index/)
  })
}

test('approval canonical blob gate rejects an untracked alternate approval file', async () => {
  const data = await approvedFixture()
  const alternate = path.join(data.root, '.squad', 'approvals', 'alternate.json')
  await writeFile(alternate, await readFile(data.approvalPath))
  await assert.rejects(
    validateApproval(data.root, '.squad/approvals/alternate.json'),
    /tracked regular file|index/,
  )
})

test('approval canonical blob gate rejects an untracked alternate evidence file', async () => {
  const data = await approvedFixture()
  const evidence = await readFile(data.evidencePath)
  const alternateRelative = '.squad/agents/tank/alternate.json'
  data.approval.evidence[0].path = alternateRelative
  await writeFile(data.approvalPath, `${JSON.stringify(data.approval)}\n`)
  spawnSync('git', ['add', '.squad/approvals/tank.json'], { cwd: data.root })
  await amendApprovalMessage(
    data,
    'Approve release target\n\nReviewed-by: Tank <tank@squad.local>\nReviewer-Role: independent-release-reviewer',
  )
  await writeFile(path.join(data.root, ...alternateRelative.split('/')), evidence)
  await assert.rejects(
    validateApproval(data.root, '.squad/approvals/tank.json'),
    /tracked regular file|index/,
  )
})

test('approval canonical blob gate rejects modified Git attributes', async () => {
  const data = await approvedFixture()
  await writeFile(path.join(data.root, '.gitattributes'), '*.json -text\n')
  await assert.rejects(
    validateApproval(data.root, '.squad/approvals/tank.json'),
    /Git attributes.*(?:mutable|Git attribute)/,
  )
})

test('approval canonical blob gate rejects malicious clean and smudge filters', async () => {
  const data = await approvedFixture()
  await writeFile(
    path.join(data.root, '.git', 'info', 'attributes'),
    '.squad/approvals/*.json filter=approval-rewrite\n'
      + '.squad/agents/tank/*.json filter=approval-rewrite\n',
  )
  spawnSync('git', ['config', 'filter.approval-rewrite.clean', 'node -e "process.stdin.pipe(process.stdout)"'], {
    cwd: data.root,
  })
  spawnSync('git', ['config', 'filter.approval-rewrite.smudge', 'node -e "process.stdin.pipe(process.stdout)"'], {
    cwd: data.root,
  })
  await assert.rejects(
    validateApproval(data.root, '.squad/approvals/tank.json'),
    /Git attribute|Git filter|content transform/,
  )
})

for (const [label, rule] of [
  ['missing transform attributes', 'text eol=lf !filter !ident !working-tree-encoding'],
  ['literal unspecified filter', 'text eol=lf filter=unspecified -ident -working-tree-encoding'],
  ['explicit filter driver', 'text eol=lf filter=approval-rewrite -ident -working-tree-encoding'],
  ['enabled ident', 'text eol=lf -filter ident -working-tree-encoding'],
  ['working-tree encoding', 'text eol=lf -filter -ident working-tree-encoding=UTF-8'],
  ['automatic text state', 'text=auto eol=lf -filter -ident -working-tree-encoding'],
  ['missing EOL state', 'text !eol -filter -ident -working-tree-encoding'],
]) {
  test(`approval canonical blob gate rejects ${label}`, async () => {
    const attributes = SAFE_FIXTURE_ATTRIBUTES
      + `.squad/approvals/*.json ${rule}\n`
      + `.squad/agents/tank/*.json ${rule}\n`
    const data = await approvedFixture(undefined, attributes)
    await assert.rejects(
      validateApproval(data.root, '.squad/approvals/tank.json'),
      /Git attribute|Git filter|content transform|text\/EOL/,
    )
  })
}

for (const [label, attribute, config] of [
  ['literal unspecified local filter', 'filter=unspecified',
    ['filter.unspecified.clean', 'git cat-file blob HEAD:.squad/approvals/tank.json']],
  ['literal unset local filter', 'filter=unset',
    ['filter.unset.clean', 'git cat-file blob HEAD:.squad/approvals/tank.json']],
  ['unknown local filter', 'filter=unknown-driver',
    ['filter.unknown-driver.clean', 'node -e "process.stdin.pipe(process.stdout)"']],
  ['process-only local filter', 'filter=process-driver',
    ['filter.process-driver.process', 'node -e "process.stdin.pipe(process.stdout)"']],
  ['local ident transform', 'ident', undefined],
  ['local working-tree encoding', 'working-tree-encoding=UTF-16', undefined],
  ['local unsafe EOL override', 'text=auto -eol', undefined],
]) {
  test(`approval canonical blob gate rejects ${label}`, async () => {
    const data = await approvedFixture()
    await writeFile(
      path.join(data.root, '.git', 'info', 'attributes'),
      `.squad/approvals/tank.json ${attribute}\n`,
    )
    if (config) spawnSync('git', ['config', ...config], { cwd: data.root })
    await assert.rejects(
      validateApproval(data.root, '.squad/approvals/tank.json'),
      /Git attribute|Git filter|content transform|text\/EOL/,
    )
  })
}

test('approval canonical blob gate accepts explicit unset transforms with core.autocrlf', async () => {
  const data = await approvedFixture(undefined, SAFE_FIXTURE_ATTRIBUTES
    + '.squad/approvals/*.json text eol=crlf\n'
    + '.squad/agents/tank/*.json text eol=crlf\n')
  spawnSync('git', ['config', 'core.autocrlf', 'true'], { cwd: data.root })
  for (const filePath of [data.approvalPath, data.evidencePath]) {
    const text = await readFile(filePath, 'utf8')
    await writeFile(filePath, text.replace(/\r?\n/g, '\r\n'))
  }
  assert.equal(spawnSync('git', [
    'diff', '--quiet', 'HEAD', '--',
    '.squad/approvals/tank.json',
    '.squad/agents/tank/report.json',
  ], { cwd: data.root }).status, 0)
  const result = await validateApproval(data.root, '.squad/approvals/tank.json')
  assert.equal(result.approval.verdict, 'APPROVE')
})

for (const [label, relative, renamed] of [
  ['case-only approval file rename', '.squad/approvals/tank.json', 'TANK.JSON'],
  ['case-only approval parent rename', '.squad/approvals', 'APPROVALS'],
  ['case-only evidence file rename', '.squad/agents/tank/report.json', 'REPORT.JSON'],
  ['case-only evidence parent rename', '.squad/agents/tank', 'TANK'],
]) {
  test(`approval canonical blob gate rejects ${label} on Windows`, {
    skip: process.platform !== 'win32',
  }, async () => {
    const data = await approvedFixture()
    const original = path.join(data.root, ...relative.split('/'))
    await rename(original, path.join(path.dirname(original), renamed))
    assert.equal(spawnSync('git', ['diff', '--quiet', 'HEAD', '--', relative], {
      cwd: data.root,
    }).status, 0)
    await assert.rejects(
      validateApproval(data.root, '.squad/approvals/tank.json'),
      /path case or identity is not canonical/,
    )
  })
}

test('approval canonical blob gate rejects Unicode-normalized physical aliases where supported', async (t) => {
  const data = await approvedFixture()
  const canonicalRelative = '.squad/agents/tank/r\u00e9port.json'
  const canonicalPath = path.join(data.root, ...canonicalRelative.split('/'))
  await rename(data.evidencePath, canonicalPath)
  spawnSync('git', ['config', 'core.quotePath', 'false'], { cwd: data.root })
  await amendApproval(data, (approval) => {
    approval.evidence[0].path = canonicalRelative
  })
  const aliasPath = path.join(path.dirname(canonicalPath), 're\u0301port.json')
  await rename(canonicalPath, aliasPath)
  const names = await (await import('node:fs/promises')).readdir(path.dirname(aliasPath))
  if (names.includes(path.basename(canonicalPath))) {
    t.skip('Filesystem normalizes Unicode directory-entry names.')
    return
  }
  await assert.rejects(
    validateApproval(data.root, '.squad/approvals/tank.json'),
    /path case or identity is not canonical/,
  )
})

test('canonical protected snapshot accepts a clean CRLF worktree', async () => {
  const root = await fixture(
    'crlf',
    undefined,
    `${SAFE_FIXTURE_ATTRIBUTES}src/main.ts text eol=crlf\n`,
  )
  const sourcePath = path.join(root, 'src', 'main.ts')
  await writeFile(sourcePath, 'export {}\r\n')
  assert.equal(spawnSync('git', ['diff', '--quiet', 'HEAD', '--', 'src/main.ts'], {
    cwd: root,
  }).status, 0)
  const snapshot = await snapshotProtectedSources(root)
  const source = snapshot.files.find((entry) => entry.path === 'src/main.ts')
  const blob = spawnSync('git', ['show', 'HEAD:src/main.ts'], { cwd: root }).stdout
  assert.equal(source.sha256, createHash('sha256').update(blob).digest('hex'))
  assert.equal(source.bytes, blob.length)
  assert.equal(source.worktreeBytes, Buffer.byteLength('export {}\r\n'))
})

test('canonical protected snapshot accepts authorized CRLF for an explicit LF text policy', async () => {
  const root = await fixture('source-authorized-lf-crlf')
  spawnSync('git', ['config', 'core.autocrlf', 'true'], { cwd: root })
  const sourcePath = path.join(root, 'src', 'main.ts')
  await writeFile(sourcePath, 'export {}\r\n')
  assert.equal(spawnSync('git', ['diff', '--quiet', 'HEAD', '--', 'src/main.ts'], {
    cwd: root,
  }).status, 0)
  const snapshot = await snapshotProtectedSources(root)
  const source = snapshot.files.find((entry) => entry.path === 'src/main.ts')
  const blob = spawnSync('git', ['show', 'HEAD:src/main.ts'], { cwd: root }).stdout
  assert.equal(blob.toString('utf8'), 'export {}\n')
  assert.equal(source.sha256, createHash('sha256').update(blob).digest('hex'))
  assert.equal(source.bytes, blob.length)
  assert.equal(source.worktreeBytes, Buffer.byteLength('export {}\r\n'))
  assert.notEqual(source.sha256, createHash('sha256').update(await readFile(sourcePath)).digest('hex'))
})

test('canonical protected snapshot accepts uniform LF when EOL policy is crlf', async () => {
  const root = await fixture(
    'source-crlf-policy-lf-checkout',
    undefined,
    `${SAFE_FIXTURE_ATTRIBUTES}src/main.ts text eol=crlf\n`,
  )
  const snapshot = await snapshotProtectedSources(root)
  const source = snapshot.files.find((entry) => entry.path === 'src/main.ts')
  const blob = spawnSync('git', ['show', 'HEAD:src/main.ts'], { cwd: root }).stdout
  assert.equal(blob.toString('utf8'), 'export {}\n')
  assert.equal(source.bytes, blob.length)
  assert.equal(source.worktreeBytes, blob.length)
  assert.equal(source.sha256, createHash('sha256').update(blob).digest('hex'))
})

test('canonical protected snapshot rejects a real CRLF content edit', async () => {
  const root = await fixture('source-crlf-content-edit')
  await writeFile(path.join(root, 'src', 'main.ts'), 'export const edited = true\r\n')
  await assert.rejects(
    snapshotProtectedSources(root),
    /physical bytes differ from committed content/,
  )
})

test('canonical protected snapshot rejects a staged blob mismatch', async () => {
  const root = await fixture('source-staged-blob-mismatch')
  await writeFile(path.join(root, 'src', 'main.ts'), 'export const staged = true\r\n')
  assert.equal(spawnSync('git', ['add', '--', 'src/main.ts'], { cwd: root }).status, 0)
  await assert.rejects(
    snapshotProtectedSources(root),
    /index differs from the committed tree/,
  )
})

test('canonical protected snapshot reports every mixed-EOL file in one failure', async () => {
  const root = await fixture('source-mixed-eol-all')
  for (const relative of ['src/main.ts', 'electron/main.ts']) {
    await writeFile(path.join(root, relative), 'line1\nline2\n')
  }
  assert.equal(spawnSync('git', ['add', '--', 'src/main.ts', 'electron/main.ts'], { cwd: root }).status, 0)
  assert.equal(spawnSync('git', ['commit', '--quiet', '-m', 'two lines'], { cwd: root }).status, 0)
  await writeFile(path.join(root, 'src', 'main.ts'), 'line1\r\nline2\n')
  await writeFile(path.join(root, 'electron', 'main.ts'), 'line1\nline2\r\n')
  await assert.rejects(snapshotProtectedSources(root), (error) => {
    assert.match(error.message, /2 files/)
    assert.match(error.message, /mixed EOL\): src\/main\.ts/)
    assert.match(error.message, /mixed EOL\): electron\/main\.ts/)
    return true
  })
})

test('canonical protected snapshot rejects mixed EOL even if stripping CR would match', async () => {
  const root = await fixture('source-mixed-eol')
  await writeFile(path.join(root, 'src', 'main.ts'), 'line1\nline2\n')
  assert.equal(spawnSync('git', ['add', '--', 'src/main.ts'], { cwd: root }).status, 0)
  assert.equal(spawnSync('git', ['commit', '--quiet', '-m', 'two lines'], { cwd: root }).status, 0)
  await writeFile(path.join(root, 'src', 'main.ts'), 'line1\r\nline2\n')
  await assert.rejects(
    snapshotProtectedSources(root),
    /physical bytes differ from committed content/,
  )
})

test('canonical protected snapshot rejects a lone CR even if stripping it would match', async () => {
  const root = await fixture('source-lone-cr')
  await writeFile(path.join(root, 'src', 'main.ts'), 'exp\rort {}\n')
  await assert.rejects(
    snapshotProtectedSources(root),
    /physical bytes differ from committed content/,
  )
})

test('canonical protected snapshot rejects a doubled CR conversion', async () => {
  const root = await fixture('source-doubled-cr')
  await writeFile(path.join(root, 'src', 'main.ts'), 'export {}\r\r\n')
  await assert.rejects(
    snapshotProtectedSources(root),
    /physical bytes differ from committed content/,
  )
})

test('canonical protected snapshot rejects a non-LF-canonical text blob', async () => {
  const root = await fixture('source-noncanonical-blob')
  const bytes = Buffer.from('export {}\r\n')
  const hashed = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: bytes })
  assert.equal(hashed.status, 0, hashed.stderr.toString())
  const oid = hashed.stdout.toString().trim()
  assert.equal(spawnSync('git', [
    'update-index', '--cacheinfo', `100644,${oid},src/main.ts`,
  ], { cwd: root }).status, 0)
  assert.equal(spawnSync('git', ['commit', '--quiet', '-m', 'raw crlf blob'], { cwd: root }).status, 0)
  await writeFile(path.join(root, 'src', 'main.ts'), bytes)
  await assert.rejects(
    snapshotProtectedSources(root),
    /committed text is not LF-canonical/,
  )
})

test('canonical protected snapshot rejects CRLF conversion of binary content', async () => {
  const root = await fixture(
    'source-binary-crlf',
    undefined,
    `${SAFE_FIXTURE_ATTRIBUTES}build/payload.bin -text -eol -filter -ident -working-tree-encoding\n`,
  )
  const relative = 'build/payload.bin'
  const bytes = Buffer.from('icon\n')
  await writeFile(path.join(root, 'build', 'payload.bin'), bytes)
  assert.equal(spawnSync('git', ['add', '--', '.gitattributes', relative], { cwd: root }).status, 0)
  assert.equal(spawnSync('git', ['commit', '--quiet', '-m', 'binary payload'], { cwd: root }).status, 0)
  const accepted = await snapshotProtectedSources(root)
  const binary = accepted.files.find((entry) => entry.path === relative)
  assert.equal(binary.sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(binary.worktreeBytes, bytes.length)
  await writeFile(path.join(root, 'build', 'payload.bin'), Buffer.from('icon\r\n'))
  await assert.rejects(
    snapshotProtectedSources(root),
    /physical bytes differ from committed content/,
  )
})

test('canonical protected snapshot rejects NUL text as non-canonical', async () => {
  const root = await fixture('source-nul-text')
  const bytes = Buffer.from('export {}\0\n')
  const hashed = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: bytes })
  assert.equal(hashed.status, 0, hashed.stderr.toString())
  assert.equal(spawnSync('git', [
    'update-index', '--cacheinfo', `100644,${hashed.stdout.toString().trim()},src/main.ts`,
  ], { cwd: root }).status, 0)
  assert.equal(spawnSync('git', ['commit', '--quiet', '-m', 'nul text'], { cwd: root }).status, 0)
  await writeFile(path.join(root, 'src', 'main.ts'), bytes)
  await assert.rejects(snapshotProtectedSources(root), /committed text is not LF-canonical/)
})

for (const [label, attribute, config] of [
  ['local filter override', 'filter=unspecified',
    ['filter.unspecified.clean', 'git cat-file blob HEAD:src/main.ts']],
  ['local ident override', 'ident', undefined],
  ['local working-tree-encoding override', 'working-tree-encoding=UTF-8', undefined],
  ['local inherited text override', 'text=auto -eol', undefined],
]) {
  test(`canonical protected snapshot rejects ${label} on an otherwise authorized CRLF checkout`, async () => {
    const root = await fixture(`source-${label.replaceAll(' ', '-')}`)
    await writeFile(path.join(root, '.git', 'info', 'attributes'), `src/main.ts ${attribute}\n`)
    if (config) assert.equal(spawnSync('git', ['config', ...config], { cwd: root }).status, 0)
    await writeFile(path.join(root, 'src', 'main.ts'), 'export {}\r\n')
    await assert.rejects(
      snapshotProtectedSources(root),
      /Git attribute|Git filter|content transform|text\/EOL/,
    )
  })
}

for (const [label, rule] of [
  ['unspecified filter state', 'text eol=lf !filter -ident -working-tree-encoding'],
  ['automatic text state', 'text=auto eol=lf -filter -ident -working-tree-encoding'],
  ['missing EOL state', 'text !eol -filter -ident -working-tree-encoding'],
  ['enabled ident state', 'text eol=lf -filter ident -working-tree-encoding'],
  ['working-tree encoding state', 'text eol=lf -filter -ident working-tree-encoding=UTF-8'],
]) {
  test(`canonical protected snapshot rejects unsupported ${label}`, async () => {
    const root = await fixture(
      `source-unsupported-${label.replaceAll(' ', '-')}`,
      undefined,
      `${SAFE_FIXTURE_ATTRIBUTES}src/main.ts ${rule}\n`,
    )
    await assert.rejects(
      snapshotProtectedSources(root),
      /Git attribute|Git filter|content transform|text\/EOL/,
    )
  })
}

test('canonical protected snapshot rejects content hidden by an inherited clean filter', async () => {
  const root = await fixture('source-inherited-filter')
  const attributesPath = path.join(root, 'inherited.attributes')
  await writeFile(attributesPath, 'src/main.ts filter=external-driver\n')
  const configPath = path.join(root, 'inherited.gitconfig')
  await writeFile(
    configPath,
    `[core]\n\tattributesFile = ${attributesPath.replaceAll('\\', '/')}\n`
      + '[filter "external-driver"]\n\tclean = git cat-file blob HEAD:src/main.ts\n',
  )
  await writeFile(path.join(root, 'src', 'main.ts'), 'export const inherited = true\r\n')
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `import { snapshotProtectedSources } from ${JSON.stringify(
      new URL('./release-artifact-verification.mjs', import.meta.url).href,
    )}; await snapshotProtectedSources(process.argv[1]);`,
    root,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: configPath },
  })
  assert.notEqual(result.status, 0)
  assert.match(`${result.stderr}${result.stdout}`, /Git attribute|Git filter|physical bytes/)
})

for (const [label, attribute, driverKey] of [
  ['info clean filter sentinel', 'filter=unspecified', 'filter.unspecified.clean'],
  ['info unset-named clean filter', 'filter=unset', 'filter.unset.clean'],
  ['info smudge-only filter', 'filter=source-smudge', 'filter.source-smudge.smudge'],
  ['info process-only filter', 'filter=source-process', 'filter.source-process.process'],
]) {
  test(`canonical protected snapshot rejects ${label} concealment`, async () => {
    const root = await fixture(`source-${label.replaceAll(' ', '-')}`)
    await writeFile(
      path.join(root, '.git', 'info', 'attributes'),
      `src/main.ts ${attribute}\n`,
    )
    spawnSync('git', ['config', driverKey, 'git cat-file blob HEAD:src/main.ts'], { cwd: root })
    await writeFile(path.join(root, 'src', 'main.ts'), 'export const attacker = true\n')
    if (driverKey.endsWith('.clean')) {
      assert.equal(spawnSync('git', ['diff', '--quiet', 'HEAD', '--', 'src/main.ts'], {
        cwd: root,
      }).status, 0)
    }
    await assert.rejects(
      snapshotProtectedSources(root),
      /Git attribute|Git filter|physical bytes/,
    )
  })
}

test('canonical protected snapshot ignores malicious hash-object --path normalization', async () => {
  const root = await fixture('source-hash-object')
  await writeFile(
    path.join(root, '.git', 'info', 'attributes'),
    'src/main.ts filter=unspecified\n',
  )
  spawnSync('git', [
    'config', 'filter.unspecified.clean', 'git cat-file blob HEAD:src/main.ts',
  ], { cwd: root })
  await writeFile(path.join(root, 'src', 'main.ts'), 'export const attacker = true\n')
  const canonical = spawnSync('git', ['rev-parse', 'HEAD:src/main.ts'], {
    cwd: root, encoding: 'utf8',
  }).stdout.trim()
  const pathHash = spawnSync('git', ['hash-object', '--path', 'src/main.ts', 'src/main.ts'], {
    cwd: root, encoding: 'utf8',
  }).stdout.trim()
  assert.equal(pathHash, canonical)
  await assert.rejects(snapshotProtectedSources(root), /Git attribute|Git filter|physical bytes/)
})

test('real renderer build uses immutable isolated dependencies while live source and Vite change', {
  timeout: 600_000,
}, async () => {
  const root = process.cwd()
  const stage = path.join(root, `.release-source-qa-live-toctou-${process.pid}`)
  const sourcePath = path.join(root, 'src', 'main.tsx')
  const liveVitePath = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')
  const sourceMarker = `__KARAOKE_LIVE_TOCTOU_${process.pid}__`
  const dependencyMarker = `__KARAOKE_DEPENDENCY_TOCTOU_${process.pid}__`
  const original = await readFile(sourcePath)
  const originalInfo = await stat(sourcePath)
  const originalVite = await readFile(liveVitePath)
  const originalViteInfo = await stat(liveVitePath)
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
  let materialized
  try {
    materialized = await materializeCanonicalSource({
      repositoryRoot: root,
      commit,
      stageRoot: stage,
    })
    const before = await snapshotCanonicalStage(stage, materialized.files)
    const isolated = await installIsolatedDependencies(stage)
    const dependencyBefore = isolated.dependencies
    const cacheBefore = isolated.cache
    await lockIsolatedDependencies(isolated.root, isolated.cacheRoot)
    const stagedVitePath = path.join(stage, isolated.tools.vite.path)
    await assert.rejects(
      writeFile(stagedVitePath, Buffer.concat([await readFile(stagedVitePath), Buffer.from('x')])),
      /EPERM|EACCES|permission/i,
    )
    const build = new Promise((resolve, reject) => {
      const commands = [
        [path.join(stage, 'scripts', 'clean.mjs')],
        [path.join(stage, isolated.tools.typescript.path), '-b'],
        [stagedVitePath, 'build', '--configLoader', 'runner'],
        [path.join(stage, isolated.tools.typescript.path), '-p', 'tsconfig.electron.json'],
      ]
      const runNext = (index = 0, output = '') => {
        if (index === commands.length) {
          resolve()
          return
        }
        const [script, ...args] = commands[index]
        const child = spawn(process.execPath, [script, ...args], {
          cwd: stage,
          env: isolated.env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        child.stdout.on('data', (chunk) => { output += chunk })
        child.stderr.on('data', (chunk) => { output += chunk })
        child.on('error', reject)
        child.on('close', (code) => code === 0
          ? runNext(index + 1, output)
          : reject(new Error(output)))
      }
      runNext()
    })
    await writeFile(sourcePath, Buffer.concat([
      original,
      Buffer.from(`\nconsole.info('${sourceMarker}')\n`),
    ]))
    await writeFile(liveVitePath, Buffer.concat([
      originalVite,
      Buffer.from(`\nconsole.info('${dependencyMarker}')\n`),
    ]))
    await build
    await writeFile(sourcePath, original)
    await utimes(sourcePath, originalInfo.atime, originalInfo.mtime)
    await writeFile(liveVitePath, originalVite)
    await utimes(liveVitePath, originalViteInfo.atime, originalViteInfo.mtime)
    const after = await snapshotCanonicalStage(stage, materialized.files, {
      allowedGenerated: [
        '.release-dependency-cache',
        '.release-runtime',
        'dist',
        'dist-electron',
        'src/types.js',
        'src/types.js.map',
        'tsconfig.app.tsbuildinfo',
        'tsconfig.node.tsbuildinfo',
      ],
    })
    await snapshotIsolatedDependencies(isolated.root, dependencyBefore)
    await snapshotIsolatedDependencies(isolated.cacheRoot, cacheBefore)
    assert.deepEqual(after, before)
    assert.equal((await stat(sourcePath)).mtimeMs, originalInfo.mtimeMs)
    assert.equal((await stat(liveVitePath)).mtimeMs, originalViteInfo.mtimeMs)
    let sourceMarkerFound = false
    let dependencyMarkerFound = false
    async function scan(directory) {
      for (const entry of await (await import('node:fs/promises')).readdir(directory, {
        withFileTypes: true,
      })) {
        const child = path.join(directory, entry.name)
        if (entry.isDirectory()) await scan(child)
        else {
          const content = await readFile(child)
          if (content.includes(Buffer.from(sourceMarker))) sourceMarkerFound = true
          if (content.includes(Buffer.from(dependencyMarker))) dependencyMarkerFound = true
        }
      }
    }
    await scan(path.join(stage, 'dist'))
    assert.equal(sourceMarkerFound, false)
    assert.equal(dependencyMarkerFound, false)
    assert.equal(path.relative(stage, stagedVitePath).startsWith('node_modules'), true)
  } finally {
    await writeFile(sourcePath, original)
    await utimes(sourcePath, originalInfo.atime, originalInfo.mtime)
    await writeFile(liveVitePath, originalVite)
    await utimes(liveVitePath, originalViteInfo.atime, originalViteInfo.mtime)
    await removeCanonicalStage(stage)
  }
  assert.equal(existsSync(stage), false)
})

test('canonical source staging creates no live dependency link or reference', async () => {
  const root = process.cwd()
  const stage = path.join(root, `.release-source-qa-no-live-deps-${process.pid}`)
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
  try {
    const materialized = await materializeCanonicalSource({
      repositoryRoot: root,
      commit,
      stageRoot: stage,
    })
    assert.equal(materialized.dependencyMode, 'fresh-lockfile-npm-ci-isolated-read-only')
    await assert.rejects(
      stat(path.join(stage, 'node_modules')),
      (error) => error?.code === 'ENOENT',
    )
  } finally {
    await removeCanonicalStage(stage)
  }
})

test('build tool path validation rejects every path outside staged node_modules', () => {
  const stage = path.join(process.cwd(), '.release-source-path-boundary')
  assert.throws(
    () => assertIsolatedResolvedPath(stage, path.join(process.cwd(), 'node_modules', 'vite'), 'Vite'),
    /outside isolated staged dependencies/,
  )
  assert.equal(
    assertIsolatedResolvedPath(
      stage,
      path.join(stage, 'node_modules', 'vite', 'bin', 'vite.js'),
      'Vite',
    ),
    path.join(stage, 'node_modules', 'vite', 'bin', 'vite.js'),
  )
})

test('canonical staging blocks source mutation and cleans the owned directory', async () => {
  const root = process.cwd()
  const stage = path.join(root, `.release-source-qa-mutation-${process.pid}`)
  const live = path.join(root, `.qa-canonical-live-${process.pid}`)
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
  try {
    const materialized = await materializeCanonicalSource({
      repositoryRoot: root,
      commit,
      stageRoot: stage,
    })
    await assert.rejects(
      writeFile(path.join(stage, 'src', 'main.tsx'), 'stage mutation sentinel\n'),
      /EPERM|EACCES|permission/i,
    )
    await snapshotCanonicalStage(stage, materialized.files)
    await mkdir(live)
    await writeFile(path.join(live, 'approved.txt'), 'approved\n')
    await chmod(path.join(stage, 'src', 'main.tsx'), 0o644)
    await writeFile(path.join(stage, 'src', 'main.tsx'), 'forced stage mutation sentinel\n')
    await assert.rejects(
      snapshotCanonicalStage(stage, materialized.files),
      /Staged canonical source changed/,
    )
    assert.equal(await readFile(path.join(live, 'approved.txt'), 'utf8'), 'approved\n')
  } finally {
    await removeCanonicalStage(stage)
    await rm(live, { recursive: true, force: true })
  }
  assert.equal(existsSync(stage), false)
})

test('canonical protected snapshot rejects committed attribute macros', async () => {
  const root = await fixture('source-macro')
  await writeFile(
    path.join(root, '.gitattributes'),
    `${SAFE_FIXTURE_ATTRIBUTES}[attr]source-safe -filter -ident -working-tree-encoding text eol=lf\n`
      + 'src/main.ts source-safe\n',
  )
  spawnSync('git', ['add', '.gitattributes'], { cwd: root })
  spawnSync('git', ['commit', '--quiet', '-m', 'add attribute macro'], { cwd: root })
  await assert.rejects(snapshotProtectedSources(root), /attribute macros/)
})

for (const scope of ['global', 'system']) {
  test(`canonical protected snapshot defeats ${scope} attribute-file filter concealment`, async () => {
    const root = await fixture(`source-${scope}-attributes`)
    const attributesPath = path.join(root, `${scope}.attributes`)
    await writeFile(attributesPath, 'src/main.ts filter=external-driver\n')
    const configPath = path.join(root, `${scope}.gitconfig`)
    await writeFile(
      configPath,
      `[core]\n\tattributesFile = ${attributesPath.replaceAll('\\', '/')}\n`
        + '[filter "external-driver"]\n\tclean = git cat-file blob HEAD:src/main.ts\n',
    )
    await writeFile(path.join(root, 'src', 'main.ts'), 'export const attacker = true\n')
    const environment = scope === 'global'
      ? { GIT_CONFIG_GLOBAL: configPath }
      : { GIT_CONFIG_SYSTEM: configPath }
    const result = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `import { snapshotProtectedSources } from ${JSON.stringify(
        new URL('./release-artifact-verification.mjs', import.meta.url).href,
      )}; await snapshotProtectedSources(process.argv[1]);`,
      root,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, ...environment },
    })
    assert.notEqual(result.status, 0)
    assert.match(`${result.stderr}${result.stdout}`, /Git attribute|Git filter|physical bytes/)
  })
}

test('canonical protected snapshot defeats local core.attributesFile precedence', async () => {
  const root = await fixture('source-local-attributes')
  const attributesPath = path.join(root, 'local.attributes')
  await writeFile(attributesPath, 'src/main.ts filter=local-driver\n')
  spawnSync('git', ['config', 'core.attributesFile', attributesPath], { cwd: root })
  spawnSync('git', [
    'config', 'filter.local-driver.clean', 'git cat-file blob HEAD:src/main.ts',
  ], { cwd: root })
  await writeFile(path.join(root, 'src', 'main.ts'), 'export const attacker = true\n')
  await assert.rejects(snapshotProtectedSources(root), /Git attribute|Git filter|physical bytes/)
})

test('canonical protected snapshot rejects Git attribute source environment overrides', async () => {
  const root = await fixture('source-attribute-environment')
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `import { snapshotProtectedSources } from ${JSON.stringify(
      new URL('./release-artifact-verification.mjs', import.meta.url).href,
    )}; await snapshotProtectedSources(process.argv[1]);`,
    root,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, GIT_ATTR_SOURCE: 'HEAD' },
  })
  assert.notEqual(result.status, 0)
  assert.match(`${result.stderr}${result.stdout}`, /environment override/)
})

test('canonical protected snapshot excludes ignored generated source outputs', async () => {
  const root = await fixture('ignored-generated')
  await writeFile(path.join(root, '.gitignore'), '/src/types.js\n/src/types.js.map\n')
  spawnSync('git', ['add', '.gitignore'], { cwd: root })
  spawnSync('git', ['commit', '--quiet', '-m', 'ignore generated outputs'], { cwd: root })
  const before = await snapshotProtectedSources(root)
  await writeFile(path.join(root, 'src', 'types.js'), 'generated\r\n')
  await writeFile(path.join(root, 'src', 'types.js.map'), '{}\r\n')
  const after = await snapshotProtectedSources(root)
  assert.deepEqual(after, before)
  assert.equal(after.files.some((entry) => entry.path.startsWith('src/types.js')), false)
})

for (const [label, mutate] of [
  ['unstaged content tamper', async (root) => {
    await writeFile(path.join(root, 'src', 'main.ts'), 'export const tampered = true\n')
  }],
  ['staged content tamper', async (root) => {
    await writeFile(path.join(root, 'src', 'main.ts'), 'export const staged = true\n')
    spawnSync('git', ['add', 'src/main.ts'], { cwd: root })
  }],
  ['deleted tracked source', async (root) => {
    await rm(path.join(root, 'src', 'main.ts'))
  }],
  ['type-changed tracked source', async (root) => {
    await rm(path.join(root, 'src', 'main.ts'))
    await mkdir(path.join(root, 'src', 'main.ts'))
  }],
  ['untracked shadow at a protected path', async (root) => {
    spawnSync('git', ['rm', '--cached', '--quiet', 'src/main.ts'], { cwd: root })
  }],
]) {
  test(`canonical protected snapshot rejects ${label}`, async () => {
    const root = await fixture(`source-${label.replaceAll(' ', '-')}`)
    await mutate(root)
    await assert.rejects(snapshotProtectedSources(root), /Protected source/)
  })
}

test('canonical protected snapshot rejects a protected symlink or reparse point where permitted', async (t) => {
  const root = await fixture('source-link')
  const sourcePath = path.join(root, 'src', 'main.ts')
  await rm(sourcePath)
  try {
    await symlink(path.join(root, 'package.json'), sourcePath, 'file')
    await assert.rejects(snapshotProtectedSources(root), /Protected source/)
  } catch (error) {
    if (error.code === 'EPERM') t.diagnostic('Source symlink creation requires Windows Developer Mode.')
    else throw error
  }
})

test('canonical protected snapshot rejects a protected hardlink', async () => {
  const root = await fixture('source-hardlink')
  await link(path.join(root, 'src', 'main.ts'), path.join(root, 'src', 'main-alias.ts'))
  await assert.rejects(snapshotProtectedSources(root), /hard links/)
})

test('canonical protected snapshot rejects a physical case-only source rename on Windows', {
  skip: process.platform !== 'win32',
}, async () => {
  const root = await fixture('source-case')
  await rename(path.join(root, 'src', 'main.ts'), path.join(root, 'src', 'MAIN.TS'))
  assert.equal(spawnSync('git', ['diff', '--quiet', 'HEAD', '--', 'src/main.ts'], {
    cwd: root,
  }).status, 0)
  await assert.rejects(snapshotProtectedSources(root), /path case or identity is not canonical/)
})

test('approval replay from a prior HEAD is rejected', async () => {
  const data = await approvedFixture()
  await writeFile(path.join(data.root, 'README.md'), 'later source revision\n')
  spawnSync('git', ['add', 'README.md'], { cwd: data.root })
  spawnSync('git', ['commit', '--quiet', '-m', 'later source revision'], { cwd: data.root })
  await assert.rejects(
    validateApproval(data.root, '.squad/approvals/tank.json'),
    /provenance|target parent|product or release|branch or target-parent/,
  )
})

test('valid reviewer author with configured maintainer committer is accepted', async () => {
  const data = await approvedFixture()
  const identity = spawnSync('git', [
    'show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce', 'HEAD',
  ], { cwd: data.root, encoding: 'utf8' }).stdout.trim().split('\0')
  assert.deepEqual(identity, [
    'Tank Reviewer', 'tank@squad.local',
    'Karaoke Studio Maintainer', 'maintainer@squad.local',
  ])
  await validateApproval(data.root, '.squad/approvals/tank.json')
})

for (const [label, mutate] of [
  ['duplicate identical reviewer identity', (registry) => {
    registry.reviewers.push({ ...registry.reviewers[0] })
  }],
  ['duplicate conflicting reviewer identity', (registry) => {
    registry.reviewers.push({
      identity: 'Tank',
      role: 'conflicting-release-reviewer',
      name: 'Conflicting Tank',
      email: 'conflicting-tank@squad.local',
    })
  }],
  ['case-variant reviewer identity', (registry) => {
    registry.reviewers.push({
      identity: 'tank',
      role: 'other-release-reviewer',
      name: 'Other Reviewer',
      email: 'other-reviewer@squad.local',
    })
  }],
  ['whitespace-variant reviewer identity', (registry) => {
    registry.reviewers.push({
      identity: ' Tank ',
      role: 'other-release-reviewer',
      name: 'Other Reviewer',
      email: 'other-reviewer@squad.local',
    })
  }],
  ['duplicate reviewer name', (registry) => {
    registry.reviewers.push({
      identity: 'Backup',
      role: 'other-release-reviewer',
      name: 'tank reviewer',
      email: 'backup@squad.local',
    })
  }],
  ['duplicate reviewer email', (registry) => {
    registry.reviewers.push({
      identity: 'Backup',
      role: 'other-release-reviewer',
      name: 'Backup Reviewer',
      email: 'TANK@SQUAD.LOCAL',
    })
  }],
  ['duplicate committer identity across reviewers', (registry) => {
    registry.reviewers.push({
      identity: 'Backup',
      role: 'independent-release-reviewer',
      name: 'Backup Reviewer',
      email: 'backup@squad.local',
    })
    registry.approvalPolicy.allowedCommitters.push({
      identity: 'Backup',
      name: 'Backup Reviewer',
      email: 'backup@squad.local',
    }, {
      identity: 'backup',
      name: 'Alias Reviewer',
      email: 'alias@squad.local',
    })
  }],
  ['duplicate identical committer record', (registry) => {
    registry.approvalPolicy.allowedCommitters.push({
      ...registry.approvalPolicy.allowedCommitters[0],
    })
  }],
  ['duplicate committer name', (registry) => {
    registry.approvalPolicy.allowedCommitters.push({
      identity: 'backup-maintainer',
      name: 'karaoke studio maintainer',
      email: 'backup-maintainer@squad.local',
    })
  }],
  ['duplicate committer email', (registry) => {
    registry.approvalPolicy.allowedCommitters.push({
      identity: 'backup-maintainer',
      name: 'Backup Maintainer',
      email: 'MAINTAINER@SQUAD.LOCAL',
    })
  }],
  ['conflicting committer name mapping', (registry) => {
    registry.approvalPolicy.allowedCommitters[0].name = 'Conflicting Tank'
  }],
  ['conflicting committer email mapping', (registry) => {
    registry.approvalPolicy.allowedCommitters[0].email = 'conflicting-tank@squad.local'
  }],
  ['conflicting committer trailer identity mapping', (registry) => {
    registry.approvalPolicy.allowedCommitters[0].identity = 'Tank alias'
  }],
  ['malformed committer email', (registry) => {
    registry.approvalPolicy.allowedCommitters[0].email = 'not-an-email'
  }],
]) {
  test(`reviewer registry rejects ${label}`, async () => {
    const data = await approvedFixture(mutate)
    await assert.rejects(
      validateApproval(data.root, '.squad/approvals/tank.json'),
      /Reviewer registry contains (?:invalid entries|ambiguous identities|ambiguous mappings)/,
    )
  })
}

test('reviewer registry rejects a conflicting required trailer mapping', async () => {
  const data = await approvedFixture((registry) => {
    registry.approvalPolicy.requiredTrailers['Reviewed-by'] = 'Other <other@squad.local>'
  })
  await assert.rejects(
    validateApproval(data.root, '.squad/approvals/tank.json'),
    /Reviewer registry policy is inconsistent/,
  )
})

test('reviewer registry accepts one clean canonical Tank record', async () => {
  const data = await approvedFixture()
  await validateApproval(data.root, '.squad/approvals/tank.json')
})

for (const [label, message] of [
  ['prefixed fake trailer', 'Approve\n\nX-Reviewed-by: Tank <tank@squad.local>\nReviewer-Role: independent-release-reviewer'],
  ['substring trailer value', 'Approve\n\nReviewed-by: Fake Tank <tank@squad.local>\nReviewer-Role: independent-release-reviewer'],
  ['case-variant trailer', 'Approve\n\nreviewed-by: Tank <tank@squad.local>\nReviewer-Role: independent-release-reviewer'],
  ['Unicode-confusable trailer', 'Approve\n\nRevіewed-by: Tank <tank@squad.local>\nReviewer-Role: independent-release-reviewer'],
  ['duplicate exact trailer', 'Approve\n\nReviewed-by: Tank <tank@squad.local>\nReviewed-by: Tank <tank@squad.local>\nReviewer-Role: independent-release-reviewer'],
  ['conflicting exact trailer', 'Approve\n\nReviewed-by: Other <other@squad.local>\nReviewed-by: Tank <tank@squad.local>\nReviewer-Role: independent-release-reviewer'],
]) {
  test(`approval rejects ${label}`, async () => {
    const data = await approvedFixture()
    await amendApprovalMessage(data, message)
    await assert.rejects(validateApproval(
      data.root, '.squad/approvals/tank.json',
    ), /provenance/)
  })
}

test('approval rejects an unauthorized committer', async () => {
  const data = await approvedFixture()
  await amendApprovalMessage(data,
    'Approve\n\nReviewed-by: Tank <tank@squad.local>\nReviewer-Role: independent-release-reviewer',
    { committerName: 'Unlisted Committer', committerEmail: 'unlisted@squad.local' })
  await assert.rejects(validateApproval(data.root, '.squad/approvals/tank.json'), /provenance/)
})

test('approval rejects absent, modified, and untracked reviewer registries', async () => {
  const absent = await approvedFixture()
  await rm(path.join(absent.root, '.squad', 'reviewers.json'))
  await assert.rejects(validateApproval(absent.root, '.squad/approvals/tank.json'))

  const modified = await approvedFixture()
  await writeFile(path.join(modified.root, '.squad', 'reviewers.json'), '{}\n')
  await assert.rejects(
    validateApproval(modified.root, '.squad/approvals/tank.json'),
    /mutable|blob|physical bytes/,
  )

  const untracked = await approvedFixture()
  spawnSync('git', ['rm', '--quiet', '.squad/reviewers.json'], { cwd: untracked.root })
  spawnSync('git', [
    '-c', 'user.name=Karaoke Studio Maintainer',
    '-c', 'user.email=maintainer@squad.local',
    'commit', '--amend', '--quiet', '--no-edit',
    '--author=Tank Reviewer <tank@squad.local>',
  ], { cwd: untracked.root })
  await writeFile(path.join(untracked.root, '.squad', 'reviewers.json'), '{}\n')
  await assert.rejects(validateApproval(untracked.root, '.squad/approvals/tank.json'))
})

test('untracked fabricated Tank approval with 999/999 evidence is rejected', async () => {
  const data = await approvedFixture()
  const forged = path.join(data.root, 'forged.json')
  data.approval.evidence[0].passed = 999
  data.approval.evidence[0].total = 999
  await writeFile(forged, JSON.stringify(data.approval))
  await assert.rejects(validateApproval(data.root, 'forged.json'), /approval path/i)
})

test('approval committed on the wrong parent is rejected', async () => {
  const data = await approvedFixture()
  await writeFile(path.join(data.root, '.squad', 'agents', 'tank', 'note.txt'), 'later\n')
  spawnSync('git', ['add', '.squad'], { cwd: data.root })
  spawnSync('git', [
    '-c', 'user.name=Karaoke Studio Maintainer', '-c', 'user.email=maintainer@squad.local',
    'commit', '--quiet', '-m',
    'Later review\n\nReviewed-by: Tank <tank@squad.local>\nReviewer-Role: independent-release-reviewer',
    '--author=Tank Reviewer <tank@squad.local>',
  ], { cwd: data.root })
  await assert.rejects(
    validateApproval(data.root, '.squad/approvals/tank.json'),
  )
})

test('approval commit changing a product file is rejected', async () => {
  const data = await approvedFixture()
  await writeFile(path.join(data.root, 'src', 'main.ts'), 'export const changed = true\n')
  await amendApproval(data, () => {}, ['src/main.ts'])
  await assert.rejects(
    validateApproval(data.root, '.squad/approvals/tank.json'),
    /product or release/,
  )
})

test('amended or rebased target invalidates approval', async () => {
  const data = await approvedFixture()
  spawnSync('git', ['reset', '--hard', 'HEAD^'], { cwd: data.root })
  await writeFile(path.join(data.root, 'src', 'main.ts'), 'export const amended = true\n')
  spawnSync('git', ['add', 'src/main.ts'], { cwd: data.root })
  spawnSync('git', ['commit', '--amend', '--quiet', '--no-edit'], { cwd: data.root })
  await mkdir(path.dirname(data.approvalPath), { recursive: true })
  await writeFile(data.approvalPath, `${JSON.stringify(data.approval)}\n`)
  await assert.rejects(validateApproval(data.root, '.squad/approvals/tank.json'))
})

test('dirty approval and dirty evidence are rejected', async () => {
  const approval = await approvedFixture()
  await writeFile(approval.approvalPath, `${JSON.stringify({ ...approval.approval, verdict: 'REJECT' })}\n`)
  await assert.rejects(
    validateApproval(approval.root, '.squad/approvals/tank.json'),
    /mutable|blob|physical bytes/,
  )
  const evidence = await approvedFixture()
  await writeFile(evidence.evidencePath, '{"dirty":true}\n')
  await assert.rejects(
    validateApproval(evidence.root, '.squad/approvals/tank.json'),
    /mutable|blob|physical bytes/,
  )
})

test('approval evidence rejects ADS, case tricks, and path escape', async () => {
  for (const badPath of [
    '.squad/agents/tank/report.json:stream',
    '.SQUAD/agents/tank/report.json',
    '../outside.json',
  ]) {
    const data = await approvedFixture()
    await amendApproval(data, (approval) => { approval.evidence[0].path = badPath })
    await assert.rejects(validateApproval(data.root, '.squad/approvals/tank.json'))
  }
})

test('approval evidence rejects file symlinks and hardlinks where detectable', async (t) => {
  const linked = await approvedFixture()
  const original = await readFile(linked.evidencePath)
  await rm(linked.evidencePath)
  try {
    await symlink(path.join(linked.root, 'package.json'), linked.evidencePath, 'file')
    await assert.rejects(validateApproval(linked.root, '.squad/approvals/tank.json'), /symlink|reparse/)
  } catch (error) {
    if (error.code === 'EPERM') t.diagnostic('File symlink creation requires Windows Developer Mode.')
    else throw error
  } finally {
    await rm(linked.evidencePath, { force: true })
    await writeFile(linked.evidencePath, original)
  }
  const hardlinked = await approvedFixture()
  const alias = path.join(hardlinked.root, '.squad', 'agents', 'tank', 'alias.json')
  await link(hardlinked.evidencePath, alias)
  if ((await stat(hardlinked.evidencePath)).nlink > 1) {
    await assert.rejects(validateApproval(
      hardlinked.root, '.squad/approvals/tank.json',
    ), /hard links/)
  }
})

test('approval record and evidence path components reject reparse points on Windows', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const approval = await approvedFixture()
  const approvalBytes = await readFile(approval.approvalPath)
  await rm(approval.approvalPath)
  try {
    await symlink(path.join(approval.root, 'package.json'), approval.approvalPath, 'file')
    await assert.rejects(validateApproval(
      approval.root, '.squad/approvals/tank.json',
    ), /symlink|reparse/)
  } catch (error) {
    if (error.code === 'EPERM') t.diagnostic('Approval symlink requires Windows Developer Mode.')
    else throw error
  } finally {
    await rm(approval.approvalPath, { force: true })
    await writeFile(approval.approvalPath, approvalBytes)
  }

  const junction = await approvedFixture()
  const tankDir = path.dirname(junction.evidencePath)
  const target = path.join(junction.root, 'junction-target')
  await rename(tankDir, target)
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `New-Item -ItemType Junction -Path '${tankDir.replaceAll("'", "''")}' `
      + `-Target '${target.replaceAll("'", "''")}' -ErrorAction Stop | Out-Null`,
  ], { encoding: 'utf8' })
  if (result.status === 0) {
    await assert.rejects(validateApproval(
      junction.root, '.squad/approvals/tank.json',
    ), /symlink|reparse/)
  } else {
    t.diagnostic(`Junction creation unavailable: ${result.stderr || result.stdout}`)
  }
})

test('package and lockfile version inconsistency is rejected', async () => {
  const { root } = await approvedFixture()
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  packageJson.version = '0.3.5'
  await writeFile(path.join(root, 'package.json'), JSON.stringify(packageJson))
  await assert.rejects(verifyApprovedRelease({ root }))
})

for (const mutation of [
  ['missing installer', async ({ releaseDir, exeName }) => rm(path.join(releaseDir, exeName))],
  ['installer hash mismatch', async ({ releaseDir, exeName }) =>
    writeFile(path.join(releaseDir, exeName), 'tampered')],
  ['source mismatch', async ({ root }) => writeFile(path.join(root, 'src', 'main.ts'), 'dirty')],
  ['provenance rejection', async ({ root, provenance }) => {
    provenance.verdict = 'REJECT'
    await writeFile(path.join(root, 'release', '0.3.4', 'provenance.json'), JSON.stringify(provenance))
  }],
  ['secret scan rejection', async ({ root, provenance }) => {
    provenance.verification.secretScans.findings = 1
    await writeFile(path.join(root, 'release', '0.3.4', 'provenance.json'), JSON.stringify(provenance))
  }],
  ['approval hash mismatch', async ({ approvalPath }) => writeFile(approvalPath, '{}')],
]) {
  test(`artifact verification rejects ${mutation[0]}`, async () => {
    const data = await approvedFixture()
    await mutation[1](data)
    await assert.rejects(verifyApprovedRelease({ root: data.root }))
  })
}

test('dry-run does not mutate release, ZIP, install, user data, or locks', async () => {
  const { root } = await approvedFixture()
  const before = await snapshot(root)
  const result = await runDeploy(parseArguments([]), {
    root,
    writeLog: () => {},
    processStartTime: async () => 'fixture-process',
    installExe: path.join(root, 'installed', 'Karaoke Studio.exe'),
    userDataDir: path.join(root, 'user-data'),
  })
  assert.equal(result.mode, 'dry-run')
  assert.deepEqual(await snapshot(root), before)
  assert.equal(existsSync(path.join(root, '.deploy-release.lock')), false)
})

test('dry-run rejects dirty package source', async () => {
  const { root } = await approvedFixture()
  await writeFile(path.join(root, 'src', 'main.ts'), 'dirty worktree')
  await assert.rejects(runDeploy(parseArguments([]), {
    root,
    writeLog: () => {},
    processStartTime: async () => 'fixture-process',
  }), (error) => error.exitCode === EXIT.SOURCE)
})

test('imported runDeploy cannot issue a capability outside the canonical deploy process', async () => {
  const data = await approvedFixture()
  await assert.rejects(runDeploy(parseArguments([
    '--build',
    '--approval=.squad/approvals/tank.json',
  ]), {
    root: data.root,
    token: 'orchestration-token',
    writeLog: () => {},
    processStartTime: async (pid) => `start-${pid}`,
    run: async (_command, args, options) => {
      await options.onSpawn({ pid: 200 })
      return { code: 0 }
    },
  }), /canonical entry script|identity/)
  assert.equal(existsSync(path.join(data.root, '.release-capability')), false)
  assert.equal(existsSync(path.join(data.root, '.deploy-release.lock')), false)
  assert.equal(existsSync(path.join(data.root, '.release.lock')), false)
})

async function snapshot(root) {
  const result = {}
  async function walk(directory, relative = '') {
    for (const entry of await (await import('node:fs/promises')).readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const child = path.join(directory, entry.name)
      const logical = path.join(relative, entry.name)
      if (entry.isDirectory()) await walk(child, logical)
      else result[logical] = await hashFile(child)
    }
  }
  await walk(root)
  return result
}

test('live lock contention preserves the owner record', async () => {
  const root = await fixture('live-lock')
  const lockPath = path.join(root, '.deploy-release.lock')
  const lock = await acquireOperationLock({
    lockPath,
    command: 'first',
    token: 'aa'.repeat(32),
    processStartTime: async () => 'start',
  })
  await assert.rejects(acquireOperationLock({
    lockPath,
    command: 'second',
    token: 'bb'.repeat(32),
    processStartTime: async () => 'start',
  }))
  assert.equal(JSON.parse(await readFile(lockPath)).token, 'aa'.repeat(32))
  await lock.release()
})

test('stale lock requires positive dead-owner evidence and is replaced', async () => {
  const root = await fixture('stale-lock')
  const lockPath = path.join(root, '.release.lock')
  await writeFile(lockPath, JSON.stringify({
    schema: 2, token: 'ab'.repeat(32), pid: 22, processStartTime: 'old', command: 'old', acquiredAt: '',
  }))
  assert.equal((await readLockState(lockPath, async () => null)).state, 'stale')
  const lock = await acquireOperationLock({
    lockPath,
    command: 'new',
    token: 'bb'.repeat(32),
    processStartTime: async (pid) => pid === process.pid ? 'new-start' : null,
  })
  assert.equal(JSON.parse(await readFile(lockPath)).token, 'bb'.repeat(32))
  await lock.release()
})

test('owner-token mismatch never removes another lock', async () => {
  const root = await fixture('token-lock')
  const lockPath = path.join(root, '.release.lock')
  const lock = await acquireOperationLock({
    lockPath, command: 'owner', token: 'aa'.repeat(32), processStartTime: async () => 'start',
  })
  const record = JSON.parse(await readFile(lockPath))
  record.token = 'bb'.repeat(32)
  await writeFile(lockPath, JSON.stringify(record))
  await assert.rejects(lock.release())
  assert.equal(existsSync(lockPath), true)
})

function capabilityIdentity(root, overrides = {}) {
    return async (pid) => {
      const identities = {
        100: {
          pid: 100,
          parentPid: 1,
          startTime: 'parent-start',
          executablePath: process.execPath,
          commandLine: [process.execPath, path.join(root, 'scripts', 'deploy-release.mjs')],
        },
        200: {
          pid: 200,
          parentPid: 100,
          startTime: 'child-start',
          executablePath: process.execPath,
          commandLine: [process.execPath, path.join(root, 'scripts', 'release.mjs')],
        },
        ...overrides,
      }
      return identities[pid] ?? null
    }
}

async function capabilityFixture(name = 'capability', options = {}) {
    const root = await fixture(name)
    const capabilityPath = path.join(root, '.release-capability')
    const lockPath = path.join(root, '.release.lock')
    const nonce = 'ab'.repeat(32)
    const lockToken = 'cd'.repeat(32)
    await writeFile(lockPath, `${JSON.stringify({
      schema: 2,
      token: lockToken,
      pid: 100,
      processStartTime: 'parent-start',
      command: 'deploy-release-coordinated',
      acquiredAt: new Date().toISOString(),
    })}\n`)
    const createdAt = options.now?.() ?? new Date()
    await writeFile(capabilityPath, `${JSON.stringify({
      schema: 2,
      nonce,
      operation: 'package-release',
      parent: await capabilityIdentity(root)(100),
      child: await capabilityIdentity(root)(200),
      lock: {
        path: lockPath,
        tokenSha256: hashLockToken(lockToken),
        ownerPid: 100,
        ownerStartTime: 'parent-start',
      },
      head: '1'.repeat(40),
      sourceSha256: '2'.repeat(64),
      version: '0.3.4',
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + (options.ttlMs ?? 30_000)).toISOString(),
    })}\n`)
    return { root, capabilityPath, lockPath, lockToken, nonce }
}

function consumeFixture(data, overrides = {}) {
    return consumeReleaseCapability({
      capabilityPath: data.capabilityPath,
      nonce: data.nonce,
      operation: 'package-release',
      expectedHead: '1'.repeat(40),
      expectedSourceSha256: '2'.repeat(64),
      expectedVersion: '0.3.4',
      lockPath: data.lockPath,
      lockToken: data.lockToken,
      root: data.root,
      canonicalDeployPath: path.join(data.root, 'scripts', 'deploy-release.mjs'),
      canonicalReleasePath: path.join(data.root, 'scripts', 'release.mjs'),
      pid: 200,
      parentPid: 100,
      processIdentity: capabilityIdentity(data.root),
      ...overrides,
    })
}

test('one-time 256-bit capability is atomically consumed and replay fails', async () => {
    const data = await capabilityFixture('capability-replay')
    const consumed = await consumeFixture(data)
    assert.equal(consumed.nonce, data.nonce)
    await assert.rejects(consumeFixture(data), /already consumed|unavailable/)
})

for (const [label, lockToken] of [
  ['missing lock token', undefined],
  ['wrong lock token', 'ef'.repeat(32)],
]) {
  test(`capability rejects ${label}`, async () => {
    const data = await capabilityFixture(`capability-${label.replaceAll(' ', '-')}`)
    await assert.rejects(consumeFixture(data, { lockToken }), /lock token|lock ownership/)
  })
}

test('concurrent capability consumers permit exactly one winner', async () => {
    const data = await capabilityFixture('capability-concurrent')
    const results = await Promise.allSettled([consumeFixture(data), consumeFixture(data)])
    assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 1)
    assert.equal(results.filter((entry) => entry.status === 'rejected').length, 1)
})

  for (const [label, overrides] of [
    ['wrong PID', { pid: 201 }],
    ['wrong parent', { parentPid: 101 }],
    ['wrong HEAD', { expectedHead: '3'.repeat(40) }],
    ['wrong source', { expectedSourceSha256: '4'.repeat(64) }],
    ['wrong version', { expectedVersion: '9.9.9' }],
    ['wrong operation', { operation: 'zip-release' }],
  ]) {
  test(`capability rejects ${label}`, async () => {
      const data = await capabilityFixture(`capability-${label.replace(' ', '-')}`)
      await assert.rejects(consumeFixture(data, overrides), /identity|scope|lifetime/)
  })
}

test('expired capability is rejected', async () => {
    const created = new Date('2026-09-20T12:00:00.000Z')
    const data = await capabilityFixture('capability-expired', {
      now: () => created,
      ttlMs: 1_000,
})
    await assert.rejects(consumeFixture(data, {
      now: () => new Date(created.getTime() + 2_000),
    }), /identity|scope|lifetime/)
  })

test('forged capability and stale PID reuse are rejected', async () => {
    const forged = await capabilityFixture('capability-forged')
    const record = JSON.parse(await readFile(forged.capabilityPath, 'utf8'))
    record.nonce = 'cd'.repeat(32)
    await writeFile(forged.capabilityPath, JSON.stringify(record))
    await assert.rejects(consumeFixture(forged), /identity|scope|lifetime/)

    const reused = await capabilityFixture('capability-reused')
    await assert.rejects(consumeFixture(reused, {
      processIdentity: capabilityIdentity(reused.root, {
        200: {
          pid: 200,
          parentPid: 100,
          startTime: 'reused-child-start',
          executablePath: process.execPath,
          commandLine: [process.execPath, path.join(reused.root, 'scripts', 'release.mjs')],
        },
      }),
    }), /identity|scope|lifetime/)

    const parentReused = await capabilityFixture('capability-parent-reused')
    await assert.rejects(consumeFixture(parentReused, {
      processIdentity: capabilityIdentity(parentReused.root, {
        100: {
          pid: 100,
          parentPid: 1,
          startTime: 'reused-parent-start',
          executablePath: process.execPath,
          commandLine: [
            process.execPath,
            path.join(parentReused.root, 'scripts', 'deploy-release.mjs'),
          ],
        },
      }),
    }), /identity|scope|lifetime/)
})

test('capability rejects a forged canonical parent command line', async () => {
  const data = await capabilityFixture('capability-parent-command')
  await assert.rejects(consumeFixture(data, {
    processIdentity: capabilityIdentity(data.root, {
      100: {
        pid: 100,
        parentPid: 1,
        startTime: 'parent-start',
        executablePath: process.execPath,
        commandLine: [process.execPath, path.join(data.root, 'scripts', 'wrapper.mjs')],
      },
    }),
  }), /canonical entry script/)
})

test('canonical process checks reject wrapper, renamed copy, and path substring mimicry', async () => {
  const root = await fixture('canonical-paths')
  const expected = path.join(root, 'scripts', 'deploy-release.mjs')
  for (const entry of [
    path.join(root, 'scripts', 'wrapper.mjs'),
    path.join(root, 'scripts', 'deploy-release-copy.mjs'),
    `${expected}.evil`,
  ]) {
    await assert.rejects(assertCanonicalNodeProcess({
      pid: 100,
      parentPid: 1,
      startTime: 'parent-start',
      executablePath: process.execPath,
      commandLine: [process.execPath, entry],
    }, {
      expectedPid: 100,
      expectedScript: expected,
      root,
    }), /canonical entry script/)
  }
})

test('mutating process argv and release environment cannot authorize imported issuance', async () => {
  const data = await approvedFixture()
  const originalArgv = [...process.argv]
  const originalToken = process.env.KARAOKE_RELEASE_LOCK_TOKEN
  try {
    process.argv[1] = path.join(data.root, 'scripts', 'deploy-release.mjs')
    process.env.KARAOKE_RELEASE_LOCK_TOKEN = 'ab'.repeat(32)
    await assert.rejects(runDeploy(parseArguments([
      '--build', '--approval=.squad/approvals/tank.json',
    ]), {
      root: data.root,
      writeLog: () => {},
      processStartTime: async (pid) => `start-${pid}`,
      run: async (_command, _args, options) => {
        await options.onSpawn({ pid: 200 })
        return { code: 1 }
      },
    }), /canonical entry script|identity/)
    assert.equal(existsSync(path.join(data.root, '.release-capability')), false)
  } finally {
    process.argv.splice(0, process.argv.length, ...originalArgv)
    if (originalToken === undefined) delete process.env.KARAOKE_RELEASE_LOCK_TOKEN
    else process.env.KARAOKE_RELEASE_LOCK_TOKEN = originalToken
  }
})

test('capability issuance rejects a child without the expected OS parent', async () => {
    const root = await fixture('capability-parent')
    await assert.rejects(assertCanonicalNodeProcess({
      ...(await capabilityIdentity(root)(200)),
      parentPid: 999,
    }, {
      expectedPid: 200,
      expectedParentPid: 100,
      expectedScript: path.join(root, 'scripts', 'release.mjs'),
      root,
    }), /identity/)
})

test('friend ZIP has exact root whitelist, hashes, README and Windows-compatible names', async () => {
  const { root } = await approvedFixture()
  const approved = await verifyApprovedRelease({ root })
  const result = await createFriendZip({ root, approved, token: 'zip-success' })
  assert.deepEqual(result.entries, [approved.artifacts.exe.name, 'README.txt', 'SHA256SUMS.txt'])
  assert.match((await readFile(result.path)).subarray(0, 4).toString('hex'), /^504b0304$/)
})

for (const [label, names] of [
  ['traversal', ['../evil.exe']],
  ['nested entry', ['folder/evil.exe']],
  ['alternate data stream', ['README.txt:secret']],
  ['drive path', ['C:evil.exe']],
  ['duplicate case-folded name', ['README.txt', 'readme.TXT']],
  ['extra entry', ['extra.txt']],
]) {
  test(`ZIP verification rejects ${label}`, async () => {
    const { root } = await approvedFixture()
    const approved = await verifyApprovedRelease({ root })
    const zipPath = path.join(root, 'bad.zip')
    await createStoredZip(zipPath, names.map((name) => ({ name, buffer: Buffer.from('x') })))
    await assert.rejects(verifyFriendZip(zipPath, approved))
  })
}

test('friend ZIP extracts with Windows tooling and creates no alternate data streams', {
  skip: process.platform !== 'win32',
}, async () => {
  const { root } = await approvedFixture()
  const approved = await verifyApprovedRelease({ root })
  const result = await createFriendZip({ root, approved, token: 'windows-extract' })
  const extracted = path.join(root, 'windows-extracted')
  const command = [
    `Expand-Archive -LiteralPath '${result.path.replaceAll("'", "''")}' -DestinationPath '${extracted.replaceAll("'", "''")}' -Force`,
    `$items=Get-ChildItem -LiteralPath '${extracted.replaceAll("'", "''")}' -File`,
    `if($items.Count -ne 3){exit 11}`,
    `foreach($item in $items){if((Get-Item -LiteralPath $item.FullName -Stream *).Count -ne 1){exit 12}}`,
  ].join(';')
  const extraction = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', command,
  ], { encoding: 'utf8' })
  assert.equal(extraction.status, 0, extraction.stderr)
})

test('ZIP hash mismatch is rejected and prior good ZIP survives failed refresh', async () => {
  const { root } = await approvedFixture()
  const approved = await verifyApprovedRelease({ root })
  const good = await createFriendZip({ root, approved, token: 'first' })
  const before = await hashFile(good.path)
  await writeFile(approved.artifacts.exe.path, 'tampered-after-approval')
  await assert.rejects(createFriendZip({ root, approved, token: 'second' }))
  assert.equal(await hashFile(good.path), before)
})

test('artifact timestamp-only changes preserve content identity', async () => {
  const { root, exeName } = await approvedFixture()
  const approvedBefore = await verifyApprovedRelease({ root })
  const installer = path.join(root, 'release', '0.3.4', exeName)
  const time = new Date(Date.now() + 60_000)
  await utimes(installer, time, time)
  const approvedAfter = await verifyApprovedRelease({ root })
  assert.equal(approvedAfter.artifacts.exe.sha256, approvedBefore.artifacts.exe.sha256)
})

test('protected source timestamp-only mutation fails stable operation snapshot', async () => {
  const { root } = await approvedFixture()
  const before = await snapshotProtectedSources(root)
  const source = path.join(root, 'src', 'main.ts')
  const time = new Date(Date.now() + 60_000)
  await utimes(source, time, time)
  const after = await snapshotProtectedSources(root)
  assert.equal(after.sha256, before.sha256)
  assert.throws(() => compareSnapshots(before, after), /Source changed/)
})

test('atomic promotion restores old output when staged rename fails', async () => {
  const root = await fixture('rollback')
  const live = path.join(root, 'release')
  const staged = path.join(root, '.release-staging-rollback')
  await rm(live, { recursive: true })
  await mkdir(live)
  await writeFile(path.join(live, 'old.txt'), 'old')
  await mkdir(staged)
  await writeFile(path.join(staged, 'new.txt'), 'new')
  let calls = 0
  await assert.rejects(atomicPromote(staged, live, 'rollback', {
    rename: async (from, to) => {
      calls += 1
      if (calls === 2) throw Object.assign(new Error('injected'), { code: 'EIO' })
      return rename(from, to)
    },
  }))
  assert.equal(await readFile(path.join(live, 'old.txt'), 'utf8'), 'old')
})

test('version promotion replaces only the target folder and restores it on failure', async () => {
  const root = await fixture('version-rollback')
  const sibling = path.join(root, 'release', '0.3.4', 'keep.txt')
  await mkdir(path.dirname(sibling), { recursive: true })
  await writeFile(sibling, 'keep')
  const live = path.join(root, 'release', '0.3.5')
  await mkdir(live)
  await writeFile(path.join(live, 'old.txt'), 'old')
  const staged = path.join(root, '.release-staging-rollback')
  await mkdir(staged)
  await writeFile(path.join(staged, 'new.txt'), 'new')
  let calls = 0
  await assert.rejects(promoteOwnedRelease(staged, root, '0.3.5', 'rollback', {
    rename: async (from, to) => {
      calls += 1
      if (calls === 2) throw Object.assign(new Error('injected'), { code: 'EIO' })
      return rename(from, to)
    },
  }), /Atomic promotion failed/)
  assert.equal(await readFile(path.join(live, 'old.txt'), 'utf8'), 'old')
  assert.equal(await readFile(sibling, 'utf8'), 'keep')
  assert.equal(existsSync(path.join(staged, 'new.txt')), true)
  await promoteOwnedRelease(staged, root, '0.3.5', 'rollback')
  assert.equal(await readFile(path.join(root, 'release', '0.3.5', 'new.txt'), 'utf8'), 'new')
  assert.equal(await readFile(sibling, 'utf8'), 'keep')
  assert.equal(existsSync(path.join(root, 'release', '0.3.4')), true)
})

test('version promotion refuses to overwrite an approved version folder', async () => {
  const root = await fixture('version-overwrite')
  const live = path.join(root, 'release', '0.3.5')
  await mkdir(live, { recursive: true })
  await writeFile(path.join(live, 'provenance.json'), JSON.stringify({
    verdict: 'APPROVE', packageVersion: '0.3.5',
  }))
  const staged = path.join(root, '.release-staging-overwrite')
  await mkdir(staged)
  await writeFile(path.join(staged, 'new.txt'), 'new')
  await assert.rejects(
    promoteOwnedRelease(staged, root, '0.3.5', 'overwrite'),
    /Refusing to overwrite approved release/,
  )
  assert.equal(existsSync(path.join(staged, 'new.txt')), true)
  assert.equal(existsSync(path.join(live, 'provenance.json')), true)
})

test('current verification does not accept root-level release artifacts', async () => {
  const { root, releaseDir } = await approvedFixture()
  const legacy = path.join(root, 'legacy-release')
  await rename(releaseDir, legacy)
  for (const name of await readdir(legacy)) {
    await rename(path.join(legacy, name), path.join(root, 'release', name))
  }
  await assert.rejects(verifyApprovedRelease({ root }), /missing or invalid/)
})

test('install is exact-path scoped, preserves user data, and conditionally relaunches', async () => {
  const { root } = await approvedFixture()
  const approved = await verifyApprovedRelease({ root })
  const installDir = path.join(root, 'installed')
  const installExe = path.join(installDir, 'Karaoke Studio.exe')
  await mkdir(path.join(installDir, 'resources'), { recursive: true })
  await writeFile(installExe, 'exe')
  await writeFile(path.join(installDir, 'resources', 'app.asar'), await readFile(approved.staging.asarPath))
  const userData = path.join(root, 'user-data')
  await mkdir(userData)
  await writeFile(path.join(userData, 'library.json'), '{"safe":true}')
  const calls = []
  const result = await installApprovedRelease({
    approved,
    installExe,
    userDataDir: userData,
    adapter: {
      listExactProcesses: async () => [
        { pid: 41, executablePath: installExe },
        { pid: 99, executablePath: path.join(root, 'other.exe') },
      ],
      gracefulStopExact: async (pids) => calls.push(['stop', pids]),
      runInstaller: async () => calls.push(['install']),
      relaunch: async (exe) => { calls.push(['relaunch', exe, []]); return 77 },
    },
  })
  assert.deepEqual(calls[0], ['stop', [41]])
  assert.deepEqual(calls.at(-1), ['relaunch', installExe, []])
  assert.equal(result.relaunchedPid, 77)
})

test('install leaves a previously stopped app stopped', async () => {
  const { root } = await approvedFixture()
  const approved = await verifyApprovedRelease({ root })
  const installDir = path.join(root, 'installed')
  const installExe = path.join(installDir, 'Karaoke Studio.exe')
  await mkdir(path.join(installDir, 'resources'), { recursive: true })
  await writeFile(installExe, 'exe')
  await writeFile(path.join(installDir, 'resources', 'app.asar'), await readFile(approved.staging.asarPath))
  let relaunched = false
  await installApprovedRelease({
    approved, installExe, userDataDir: path.join(root, 'missing-user-data'),
    adapter: {
      listExactProcesses: async () => [],
      gracefulStopExact: async () => {},
      runInstaller: async () => {},
      relaunch: async () => { relaunched = true },
    },
  })
  assert.equal(relaunched, false)
})

test('installer timeout cleanup kills only the exact descendant tree', async () => {
  const killed = []
  await killExactTree(100, {
    listProcesses: async () => [
      { ProcessId: 100, ParentProcessId: 1 },
      { ProcessId: 101, ParentProcessId: 100 },
      { ProcessId: 102, ParentProcessId: 101 },
      { ProcessId: 999, ParentProcessId: 1 },
    ],
    killProcess: async (pid) => killed.push(pid),
  })
  assert.deepEqual(killed, [102, 101, 100])
})

for (const [label, adapterFactory] of [
  ['installer failure', () => ({
    listExactProcesses: async () => [],
    gracefulStopExact: async () => {},
    runInstaller: async () => { throw new Error('nonzero') },
    relaunch: async () => {},
  })],
  ['installer timeout', () => ({
    listExactProcesses: async () => [],
    gracefulStopExact: async () => {},
    runInstaller: async () => { throw new Error('timeout') },
    relaunch: async () => {},
  })],
]) {
  test(`install propagates ${label} with stable exit code`, async () => {
    const { root } = await approvedFixture()
    const approved = await verifyApprovedRelease({ root })
    await assert.rejects(installApprovedRelease({
      approved,
      installExe: path.join(root, 'missing.exe'),
      userDataDir: path.join(root, 'user-data'),
      adapter: adapterFactory(),
    }), (error) => error.exitCode === EXIT.INSTALL)
  })
}

test('installed version and ASAR mismatch rejects before relaunch', async () => {
  const { root } = await approvedFixture()
  const approved = await verifyApprovedRelease({ root })
  const installDir = path.join(root, 'wrong-install')
  const source = path.join(root, 'wrong-asar')
  await mkdir(source)
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ version: '9.9.9' }))
  await mkdir(path.join(installDir, 'resources'), { recursive: true })
  await writeFile(path.join(installDir, 'Karaoke Studio.exe'), 'exe')
  await asar.createPackage(source, path.join(installDir, 'resources', 'app.asar'))
  let relaunched = false
  await assert.rejects(installApprovedRelease({
    approved,
    installExe: path.join(installDir, 'Karaoke Studio.exe'),
    userDataDir: path.join(root, 'user-data'),
    adapter: {
      listExactProcesses: async () => [],
      gracefulStopExact: async () => {},
      runInstaller: async () => {},
      relaunch: async () => { relaunched = true },
    },
  }), (error) => error.exitCode === EXIT.INSTALL)
  assert.equal(relaunched, false)
})

test('user-data content or timestamp mutation rejects before relaunch', async () => {
  const { root } = await approvedFixture()
  const approved = await verifyApprovedRelease({ root })
  const installDir = path.join(root, 'data-install')
  const installExe = path.join(installDir, 'Karaoke Studio.exe')
  await mkdir(path.join(installDir, 'resources'), { recursive: true })
  await writeFile(installExe, 'exe')
  await writeFile(path.join(installDir, 'resources', 'app.asar'), await readFile(approved.staging.asarPath))
  const userData = path.join(root, 'user-data')
  await mkdir(userData)
  await writeFile(path.join(userData, 'playlists.json'), '{}')
  let relaunched = false
  await assert.rejects(installApprovedRelease({
    approved, installExe, userDataDir: userData,
    adapter: {
      listExactProcesses: async () => [],
      gracefulStopExact: async () => {},
      runInstaller: async () => writeFile(path.join(userData, 'playlists.json'), '{"changed":true}'),
      relaunch: async () => { relaunched = true },
    },
  }), (error) => error.exitCode === EXIT.INSTALL)
  assert.equal(relaunched, false)
})

test('user-data timestamp-only mutation rejects before relaunch', async () => {
  const { root } = await approvedFixture()
  const approved = await verifyApprovedRelease({ root })
  const installDir = path.join(root, 'timestamp-install')
  const installExe = path.join(installDir, 'Karaoke Studio.exe')
  await mkdir(path.join(installDir, 'resources'), { recursive: true })
  await writeFile(installExe, 'exe')
  await writeFile(path.join(installDir, 'resources', 'app.asar'), await readFile(approved.staging.asarPath))
  const userData = path.join(root, 'user-data')
  await mkdir(userData)
  const playlists = path.join(userData, 'playlists.json')
  await writeFile(playlists, '{}')
  await assert.rejects(installApprovedRelease({
    approved, installExe, userDataDir: userData,
    adapter: {
      listExactProcesses: async () => [],
      gracefulStopExact: async () => {},
      runInstaller: async () => {
        const time = new Date(Date.now() + 120_000)
        await utimes(playlists, time, time)
      },
      relaunch: async () => assert.fail('must not relaunch'),
    },
  }), (error) => error.exitCode === EXIT.INSTALL)
})

test('external user-data references are preserved and mutations are detected', async () => {
  const data = await approvedFixture()
  const approved = await verifyApprovedRelease({ root: data.root })
  const installDir = path.join(data.root, 'external-install')
  const installExe = path.join(installDir, 'Karaoke Studio.exe')
  await mkdir(path.join(installDir, 'resources'), { recursive: true })
  await writeFile(installExe, 'exe')
  await writeFile(path.join(installDir, 'resources', 'app.asar'), await readFile(approved.staging.asarPath))
  const userData = path.join(data.root, 'user-data')
  const external = path.join(data.root, 'external-media', 'song.mp3')
  await mkdir(path.dirname(external), { recursive: true })
  await mkdir(userData)
  await writeFile(external, 'private-media')
  await writeFile(path.join(userData, 'library.json'), JSON.stringify({ path: external }))
  const baseAdapter = {
    listExactProcesses: async () => [],
    gracefulStopExact: async () => {},
    relaunch: async () => assert.fail('stopped app must remain stopped'),
  }
  const passed = await installApprovedRelease({
    approved,
    installExe,
    userDataDir: userData,
    adapter: { ...baseAdapter, runInstaller: async () => {} },
  })
  assert.equal(passed.referencedPaths, 1)
  await assert.rejects(installApprovedRelease({
    approved,
    installExe,
    userDataDir: userData,
    adapter: { ...baseAdapter, runInstaller: async () => writeFile(external, 'mutated') },
  }), (error) => error.exitCode === EXIT.INSTALL)
})

test('external user-data timestamp-only mutation is rejected', async () => {
  const data = await approvedFixture()
  const approved = await verifyApprovedRelease({ root: data.root })
  const installDir = path.join(data.root, 'external-time-install')
  const installExe = path.join(installDir, 'Karaoke Studio.exe')
  await mkdir(path.join(installDir, 'resources'), { recursive: true })
  await writeFile(installExe, 'exe')
  await writeFile(path.join(installDir, 'resources', 'app.asar'), await readFile(approved.staging.asarPath))
  const userData = path.join(data.root, 'user-data')
  const external = path.join(data.root, 'external-media', 'song.mp3')
  await mkdir(path.dirname(external), { recursive: true })
  await mkdir(userData)
  await writeFile(external, 'private-media')
  await writeFile(path.join(userData, 'library.json'), JSON.stringify({ path: external }))
  await assert.rejects(installApprovedRelease({
    approved,
    installExe,
    userDataDir: userData,
    adapter: {
      listExactProcesses: async () => [],
      gracefulStopExact: async () => {},
      runInstaller: async () => {
        const time = new Date(Date.now() + 120_000)
        await utimes(external, time, time)
      },
      relaunch: async () => assert.fail('must not relaunch'),
    },
  }), (error) => error.exitCode === EXIT.INSTALL)
})

test('user-data deletion rejects before relaunch', async () => {
  const { root } = await approvedFixture()
  const approved = await verifyApprovedRelease({ root })
  const installDir = path.join(root, 'delete-install')
  const installExe = path.join(installDir, 'Karaoke Studio.exe')
  await mkdir(path.join(installDir, 'resources'), { recursive: true })
  await writeFile(installExe, 'exe')
  await writeFile(path.join(installDir, 'resources', 'app.asar'), await readFile(approved.staging.asarPath))
  const userData = path.join(root, 'user-data')
  await mkdir(userData)
  const library = path.join(userData, 'library.json')
  await writeFile(library, '{}')
  let relaunched = false
  await assert.rejects(installApprovedRelease({
    approved, installExe, userDataDir: userData,
    adapter: {
      listExactProcesses: async () => [],
      gracefulStopExact: async () => {},
      runInstaller: async () => rm(library),
      relaunch: async () => { relaunched = true },
    },
  }), (error) => error.exitCode === EXIT.INSTALL)
  assert.equal(relaunched, false)
})
