import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  assertSecretScansClean,
  scanAsar,
  scanDirectory,
} from './package-secret-scan.mjs'
import {
  consumeReleaseCapability,
} from './release-operation-lock.mjs'
import {
  releaseVersionDirectory,
  snapshotProtectedSources,
  validateApproval,
} from './release-artifact-verification.mjs'
import {
  materializeCanonicalSource,
  installIsolatedDependencies,
  lockIsolatedDependencies,
  removeCanonicalStage,
  snapshotCanonicalStage,
  snapshotIsolatedDependencies,
} from './release-source-staging.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const configuredSourceDir = process.env.KARAOKE_RELEASE_SOURCE_DIR
const sourceDir = configuredSourceDir ? path.resolve(configuredSourceDir) : undefined
const configuredReleaseDir = process.env.KARAOKE_RELEASE_DIR
const releaseDir = configuredReleaseDir
  ? path.resolve(configuredReleaseDir)
  : path.join(root, 'release')
if (configuredReleaseDir
  && (path.dirname(releaseDir) !== root
    || !path.basename(releaseDir).startsWith('.release-staging-'))) {
  throw new Error('KARAOKE_RELEASE_DIR must be an owned staging directory directly under the repository root.')
}
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const approvalArgument = process.argv.find((value) => value.startsWith('--approval='))
const approvalPath = approvalArgument
  ? path.resolve(root, approvalArgument.slice('--approval='.length))
  : undefined
const ALLOWED_STAGE_OUTPUTS = [
  'dist',
  'dist-electron',
  'src/types.js',
  'src/types.js.map',
  'tsconfig.app.tsbuildinfo',
  'tsconfig.node.tsbuildinfo',
  '.release-dependency-cache',
  '.release-runtime',
]

function promotedReleasePath(absolutePath) {
  releaseVersionDirectory(root, packageJson.version)
  const relative = path.relative(releaseDir, absolutePath).replaceAll('\\', '/')
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Release evidence escaped the owned staging directory.')
  }
  return `release/${packageJson.version}/${relative}`
}

function run(command, args, cwd = root, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', windowsHide: true })
    child.on('error', reject)
    child.on('close', (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} exited with code ${code}.`)))
  })
}

function runCaptured(command, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${command} exited with code ${code}.\n${stderr || stdout}`)))
  })
}

async function hashFile(filePath) {
  const hash = createHash('sha256')
  hash.update(await readFile(filePath))
  return hash.digest('hex')
}

async function snapshotSources() {
  return snapshotProtectedSources(root)
}

function compareSnapshots(before, after) {
  const beforeFiles = new Map(before.files.map((entry) => [entry.path, entry]))
  const afterFiles = new Map(after.files.map((entry) => [entry.path, entry]))
  const missing = [...beforeFiles.keys()].filter((file) => !afterFiles.has(file))
  const extra = [...afterFiles.keys()].filter((file) => !beforeFiles.has(file))
  const mismatched = [...beforeFiles.keys()].filter((file) =>
    afterFiles.has(file)
      && JSON.stringify(afterFiles.get(file)) !== JSON.stringify(beforeFiles.get(file)))
  return { missing, extra, mismatched }
}

async function collectBuildOutputs(buildRoot, relativeRoot) {
  const outputs = {}
  async function walk(relative) {
    const absolute = path.join(buildRoot, relative)
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      const child = path.join(relative, entry.name)
      if (entry.isDirectory()) await walk(child)
      else outputs[child.replaceAll('\\', '/')] = await hashFile(path.join(buildRoot, child))
    }
  }
  await walk(relativeRoot)
  return outputs
}

function verifyAutomationModule(module) {
  if (module.isPrivateAutomationEnabled(true, [])) {
    throw new Error('Packaged automation unexpectedly defaults to enabled.')
  }
  if (!module.isPrivateAutomationEnabled(true, ['--enable-private-automation'])) {
    throw new Error('Packaged automation flag is not accepted.')
  }
}

function xmlAttribute(xml, element, attribute) {
  const match = xml.match(new RegExp(`<${element}\\b[^>]*\\b${attribute}=(?:\"([^\"]*)\"|'([^']*)')`, 'i'))
  return match?.[1] ?? match?.[2]
}

async function verifyAppxManifest(appxRoot) {
  const manifestPath = path.join(appxRoot, 'AppxManifest.xml')
  let manifest
  try {
    manifest = await readFile(manifestPath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('APPX is missing AppxManifest.xml.')
    throw error
  }
  const expectedVersion = `${packageJson.version}.0`
  const expectedIdentity = packageJson.build?.appx?.identityName
  const expectedApplicationId = packageJson.build?.appx?.applicationId
  const identity = {
    name: xmlAttribute(manifest, 'Identity', 'Name'),
    publisher: xmlAttribute(manifest, 'Identity', 'Publisher'),
    version: xmlAttribute(manifest, 'Identity', 'Version'),
    processorArchitecture: xmlAttribute(manifest, 'Identity', 'ProcessorArchitecture'),
  }
  const application = {
    id: xmlAttribute(manifest, 'Application', 'Id'),
    executable: xmlAttribute(manifest, 'Application', 'Executable'),
    entryPoint: xmlAttribute(manifest, 'Application', 'EntryPoint'),
  }
  if (identity.name !== expectedIdentity) {
    throw new Error(`APPX identity ${identity.name} does not match package metadata ${expectedIdentity}.`)
  }
  if (identity.version !== expectedVersion) {
    throw new Error(`APPX version ${identity.version} does not match package version ${expectedVersion}.`)
  }
  if (identity.processorArchitecture !== 'x64') {
    throw new Error(`APPX architecture ${identity.processorArchitecture} is not x64.`)
  }
  if (application.id !== expectedApplicationId
    || application.executable !== `app\\${packageJson.build.productName}.exe`
    || application.entryPoint !== 'Windows.FullTrustApplication') {
    throw new Error('APPX application identity or executable entry is inconsistent.')
  }
  if (!/<DeviceCapability\b[^>]*\bName=(?:"microphone"|'microphone')[^>]*\/?>/i.test(manifest)) {
    throw new Error('APPX manifest is missing the microphone device capability.')
  }
  const requiredAssets = [
    'assets/StoreLogo.png',
    'assets/Square150x150Logo.png',
    'assets/Square44x44Logo.png',
    'assets/Wide310x150Logo.png',
  ]
  const missingAssets = []
  for (const entry of requiredAssets) {
    try {
      await stat(path.join(appxRoot, ...entry.split('/')))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      missingAssets.push(entry)
    }
  }
  if (missingAssets.length) throw new Error(`APPX is missing assets: ${missingAssets.join(', ')}.`)
  return {
    identity,
    application,
    microphoneCapability: true,
    requiredAssets,
    partnerCenterIdentityConfigured: identity.publisher !== 'CN=ms',
  }
}

async function verifyAsar(asarPath, expected, label) {
  const listed = new Set(asar.listPackage(asarPath).map((value) => value.replaceAll('\\', '/')))
  for (const relative of Object.keys(expected)) {
    if (!listed.has(`/${relative}`)) throw new Error(`${label} is missing ${relative}.`)
    const archivePath = process.platform === 'win32' ? relative.replaceAll('/', '\\') : relative
    const actualHash = createHash('sha256').update(asar.extractFile(asarPath, archivePath)).digest('hex')
    if (actualHash !== expected[relative]) {
      throw new Error(`${label} contains stale ${relative}.`)
    }
  }
  return { label, verifiedFiles: expected }
}

async function scanStagingTree(appDir, label) {
  const asarPath = path.join(appDir, 'resources', 'app.asar')
  const scans = [
    await scanDirectory(appDir, `${label} tree`, {
      skipContent: ['resources/app.asar'],
    }),
    await scanAsar(asar, asarPath, `${label} packed ASAR`),
  ]
  const unpackedPath = `${asarPath}.unpacked`
  try {
    await stat(unpackedPath)
    scans.push(await scanDirectory(unpackedPath, `${label} ASAR unpacked`))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  assertSecretScansClean(scans)
  return scans
}

async function verifyPackagedDemucs(appDir, label) {
  const evidenceDir = path.join(releaseDir, 'runtime-evidence', label)
  const verificationScript = path.join(sourceDir, 'scripts', 'verify-packaged-demucs.mjs')
  const { stdout } = await runCaptured(process.execPath, [verificationScript, appDir, evidenceDir])
  const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1))
  return {
    ...result,
    executable: path.relative(root, result.executable).replaceAll('\\', '/'),
    command: result.command.replaceAll(root, '.'),
    fixture: {
      ...result.fixture,
      path: path.relative(root, result.fixture.path).replaceAll('\\', '/'),
    },
    evidencePath: promotedReleasePath(path.join(evidenceDir, 'report.json')),
  }
}

async function verifyNsisInstaller(installerPath) {
  const installDir = path.join(
    process.env.LOCALAPPDATA ?? path.dirname(root),
    'KaraokeStudioReleaseVerification',
    `${packageJson.version}-${process.pid}`,
  )
  await rm(installDir, { recursive: true, force: true })
  await runCaptured(installerPath, ['/S', `/D=${installDir}`])
  try {
    return await verifyPackagedDemucs(installDir, 'nsis-installed')
  } finally {
    const uninstaller = path.join(installDir, 'Uninstall Karaoke Studio.exe')
    try {
      await runCaptured(uninstaller, ['/S'])
    } finally {
      await rm(installDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
    }
  }
}

async function extractAppx(appxPath) {
  const extractionDir = path.join(releaseDir, '.appx-runtime-verification')
  await rm(extractionDir, { recursive: true, force: true })
  const escapePowerShell = (value) => value.replaceAll("'", "''")
  await runCaptured('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; `
      + `[IO.Compression.ZipFile]::ExtractToDirectory('${escapePowerShell(appxPath)}',`
      + `'${escapePowerShell(extractionDir)}')`,
  ])
  async function decodeEntryNames(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const source = path.join(directory, entry.name)
      if (entry.isDirectory()) await decodeEntryNames(source)
      const decodedName = decodeURIComponent(entry.name)
      if (decodedName !== entry.name) await rename(source, path.join(directory, decodedName))
    }
  }
  await decodeEntryNames(extractionDir)
  let entries = 0
  async function countEntries(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      entries += 1
      if (entry.isDirectory()) await countEntries(path.join(directory, entry.name))
    }
  }
  await countEntries(extractionDir)
  if (!entries) throw new Error('APPX archive readability verification failed.')
  return { extractionDir, entries }
}

async function main() {
  const capabilityPath = process.env.KARAOKE_RELEASE_CAPABILITY_PATH
  const capabilityNonce = process.env.KARAOKE_RELEASE_CAPABILITY_NONCE
  const releaseLockToken = process.env.KARAOKE_RELEASE_LOCK_TOKEN
  if (capabilityPath !== path.join(root, '.release-capability')
    || !capabilityNonce || !releaseLockToken) {
    throw new Error(
      'Low-level packaging is internal; use npm run release -- --approval=<committed-reviewer-approval>.',
    )
  }
  const startedAt = new Date().toISOString()
  const before = await snapshotSources()
  const { stdout: branchOutput } = await runCaptured('git', ['branch', '--show-current'])
  const { stdout: headOutput } = await runCaptured('git', ['rev-parse', 'HEAD'])
  const branch = branchOutput.trim()
  const head = headOutput.trim()
  let capability
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      capability = await consumeReleaseCapability({
        capabilityPath,
        nonce: capabilityNonce,
        operation: 'package-release',
        expectedHead: head,
        expectedSourceSha256: before.sha256,
        expectedVersion: packageJson.version,
        lockPath: path.join(root, '.release.lock'),
        lockToken: releaseLockToken,
        root,
        canonicalDeployPath: path.join(root, 'scripts', 'deploy-release.mjs'),
        canonicalReleasePath: path.join(root, 'scripts', 'release.mjs'),
      })
      break
    } catch (error) {
      if (attempt === 199 || !/unavailable/.test(error.message)) throw error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  if (!capability) throw new Error('Release capability was not consumed.')
  delete process.env.KARAOKE_RELEASE_CAPABILITY_PATH
  delete process.env.KARAOKE_RELEASE_CAPABILITY_NONCE
  delete process.env.KARAOKE_RELEASE_LOCK_TOKEN
  if (!configuredReleaseDir || path.dirname(releaseDir) !== root
    || !path.basename(releaseDir).startsWith('.release-staging-')) {
    throw new Error(
      'KARAOKE_RELEASE_DIR must be an owned staging directory directly under the repository root.',
    )
  }
  if (!sourceDir || path.dirname(sourceDir) !== root
    || !path.basename(sourceDir).startsWith('.release-source-')) {
    throw new Error(
      'KARAOKE_RELEASE_SOURCE_DIR must be an owned staging directory directly under the repository root.',
    )
  }
  const approvalResult = await validateApproval(root, approvalPath, {
    expectedSource: before,
    expectedBranch: branch,
    expectedHead: head,
  })
  const approval = approvalResult.approval
  let canonicalStage
  let isolatedDependencies
  let asar
  try {
    canonicalStage = await materializeCanonicalSource({
      repositoryRoot: root,
      commit: approvalResult.targetCommit,
      stageRoot: sourceDir,
    })
    const fullStagedBefore = await snapshotCanonicalStage(sourceDir, canonicalStage.files)
    const approvedStagedBefore = await snapshotCanonicalStage(
      sourceDir,
      approvalResult.source.files,
      { allowedGenerated: canonicalStage.files
        .filter((entry) => !approvalResult.source.files.some((source) => source.path === entry.path))
        .map((entry) => entry.path) },
    )
    if (approvedStagedBefore.sha256 !== approvalResult.source.sha256) {
      throw new Error('Canonical staging source does not match the approved source aggregate.')
    }
    const stagedPackageJson = JSON.parse(await readFile(path.join(sourceDir, 'package.json'), 'utf8'))
    if (JSON.stringify(stagedPackageJson) !== JSON.stringify(packageJson)) {
      throw new Error('Staged package metadata differs from the approval checkout.')
    }
    await rm(releaseDir, { recursive: true, force: true })
    await mkdir(releaseDir, { recursive: true })

    isolatedDependencies = await installIsolatedDependencies(sourceDir)
    const dependencySnapshot = isolatedDependencies.dependencies
    await lockIsolatedDependencies(isolatedDependencies.root)
    asar = isolatedDependencies.require('@electron/asar')
    const cleanScript = path.join(sourceDir, 'scripts', 'clean.mjs')
    const tsc = path.join(sourceDir, isolatedDependencies.tools.typescript.path)
    const vite = path.join(sourceDir, isolatedDependencies.tools.vite.path)
    const builder = path.join(sourceDir, isolatedDependencies.tools.electronBuilder.path)
    const buildFromIsolatedDependencies = async () => {
      await run(process.execPath, [cleanScript], sourceDir, isolatedDependencies.env)
      await run(process.execPath, [tsc, '-b'], sourceDir, isolatedDependencies.env)
      await run(process.execPath, [
        vite, 'build', '--configLoader', 'runner',
      ], sourceDir, isolatedDependencies.env)
      await run(process.execPath, [
        tsc, '-p', 'tsconfig.electron.json',
      ], sourceDir, isolatedDependencies.env)
    }
    await buildFromIsolatedDependencies()

    const cachePrimeDir = path.join(sourceDir, '.release-cache-prime')
    for (const target of ['nsis', 'appx']) {
      await run(process.execPath, [
        builder,
        '--win',
        target,
        '--x64',
        '--publish',
        'never',
        '--config.directories.output',
        cachePrimeDir,
      ], sourceDir, isolatedDependencies.env)
    }
    await rm(cachePrimeDir, { recursive: true, force: true })
    await snapshotIsolatedDependencies(isolatedDependencies.root, dependencySnapshot)
    const dependencyCacheSnapshot = await snapshotIsolatedDependencies(
      isolatedDependencies.cacheRoot,
    )
    await lockIsolatedDependencies(undefined, isolatedDependencies.cacheRoot)
    await buildFromIsolatedDependencies()
    const stagedAfterBuild = await snapshotCanonicalStage(
      sourceDir,
      canonicalStage.files,
      { allowedGenerated: ALLOWED_STAGE_OUTPUTS },
    )
    const sourceComparison = compareSnapshots(fullStagedBefore, stagedAfterBuild)
    if (sourceComparison.missing.length
      || sourceComparison.extra.length
      || sourceComparison.mismatched.length) {
      throw new Error('Canonical staged source changed during build; artifacts were rejected.')
    }
    const automationUrl = pathToFileURL(path.join(sourceDir, 'dist-electron', 'automation.js'))
    const automationModule = await import(`${automationUrl.href}?release=${Date.now()}`)
    verifyAutomationModule(automationModule)

    const expected = {
      ...await collectBuildOutputs(sourceDir, 'dist'),
    }
  for (const relative of [
    'dist-electron/main.js',
    'dist-electron/preload.cjs',
    'dist-electron/automation.js',
  ]) {
    expected[relative] = await hashFile(path.join(sourceDir, relative))
  }

  await run(process.execPath, [
    builder,
    '--win',
    'nsis',
    '--x64',
    '--publish',
    'never',
    '--config.directories.output',
    releaseDir,
    ], sourceDir, isolatedDependencies.env)
  const unpackedApp = path.join(releaseDir, 'win-unpacked')
  const unpackedAsar = path.join(releaseDir, 'win-unpacked', 'resources', 'app.asar')
  const nsisVerification = await verifyAsar(unpackedAsar, expected, 'NSIS staging app.asar')
  const nsisSecretScans = await scanStagingTree(unpackedApp, 'NSIS staging')
  const nsisStagingDemucsRuntime = await verifyPackagedDemucs(unpackedApp, 'nsis-staging')
  const exePath = path.join(releaseDir, `Karaoke Studio-Setup-${packageJson.version}.exe`)
  const nsisInstalledDemucsRuntime = await verifyNsisInstaller(exePath)

  await run(process.execPath, [
    builder,
    '--win',
    'appx',
    '--x64',
    '--publish',
    'never',
    '--config.directories.output',
    releaseDir,
    ], sourceDir, isolatedDependencies.env)
  const appxStagingDemucsRuntime = await verifyPackagedDemucs(unpackedApp, 'appx-staging')
  const appxStagingSecretScans = await scanStagingTree(unpackedApp, 'APPX staging')

    const stagedAfterPackaging = await snapshotCanonicalStage(
      sourceDir,
      canonicalStage.files,
      { allowedGenerated: ALLOWED_STAGE_OUTPUTS },
    )
    await snapshotIsolatedDependencies(isolatedDependencies.root, dependencySnapshot)
    await snapshotIsolatedDependencies(
      isolatedDependencies.cacheRoot,
      dependencyCacheSnapshot,
    )
    const packageSourceComparison = compareSnapshots(fullStagedBefore, stagedAfterPackaging)
    if (packageSourceComparison.missing.length
      || packageSourceComparison.extra.length
      || packageSourceComparison.mismatched.length) {
      throw new Error('Canonical staged source changed while packaging; artifacts were rejected.')
    }
    const liveAfter = await snapshotSources()
    const liveSourceComparison = compareSnapshots(before, liveAfter)
    if (liveSourceComparison.missing.length
      || liveSourceComparison.extra.length
      || liveSourceComparison.mismatched.length) {
      throw new Error('Live protected source changed while packaging; artifacts were rejected.')
    }

  const appxStagingVerification = await verifyAsar(unpackedAsar, expected, 'APPX staging app.asar')
  const appxPath = path.join(releaseDir, `Karaoke Studio-Setup-${packageJson.version}.appx`)
  const { extractionDir, entries: appxEntries } = await extractAppx(appxPath)
  let appxManifest
  let appxVerification
  let appxExtractedDemucsRuntime
  let appxPayloadSecretScans
  try {
    appxManifest = await verifyAppxManifest(extractionDir)
    const appxAsarPath = path.join(extractionDir, 'app', 'resources', 'app.asar')
    appxVerification = await verifyAsar(appxAsarPath, expected, 'APPX app.asar')
    appxPayloadSecretScans = await scanStagingTree(
      path.join(extractionDir, 'app'),
      'APPX payload',
    )
    appxExtractedDemucsRuntime = await verifyPackagedDemucs(
      path.join(extractionDir, 'app'),
      'appx-extracted',
    )
  } finally {
    await rm(extractionDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
  }

  const artifacts = []
  for (const artifactPath of [exePath, appxPath]) {
    const info = await stat(artifactPath)
    artifacts.push({
      path: promotedReleasePath(artifactPath),
      bytes: info.size,
      sha256: await hashFile(artifactPath),
    })
  }
  const finalApprovalResult = await validateApproval(root, approvalPath, {
    expectedSource: before,
    expectedBranch: branch,
    expectedHead: head,
  })
  if (finalApprovalResult.sha256 !== approvalResult.sha256) {
    throw new Error('Reviewer approval evidence changed during release.')
  }
  const hashPath = path.join(releaseDir, 'SHA256SUMS.txt')
  await writeFile(hashPath, `${artifacts.map((item) => `${item.sha256}  ${path.basename(item.path)}`).join('\n')}\n`)

  const report = {
    verdict: 'APPROVE',
    startedAt,
    completedAt: new Date().toISOString(),
    commands: [
      'electron-builder --win nsis --x64 --publish never',
      'electron-builder --win appx --x64 --publish never',
    ],
    packageVersion: packageJson.version,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    approval: approvalPath ? {
      path: path.relative(root, approvalPath).replaceAll('\\', '/'),
      sha256: approvalResult.sha256,
      verdict: approval.verdict,
      passed: approval.evidence.reduce((sum, item) => sum + item.passed, 0),
      total: approval.evidence.reduce((sum, item) => sum + item.total, 0),
    } : undefined,
    source: {
      ...approvalResult.source,
      fileCount: approvalResult.source.files.length,
      branch,
      head: approvalResult.targetCommit,
      approvalCommit: approvalResult.approvalCommit,
    },
    buildOutputs: expected,
    verification: {
      oneBuildForBothTargets: true,
      targetsBuiltSequentially: ['nsis', 'appx'],
      sourceUnchangedDuringRelease: true,
      sourceComparison: packageSourceComparison,
      liveSourceComparison,
      canonicalStaging: {
        commit: canonicalStage.commit,
        sha256: approvedStagedBefore.sha256,
        fileCount: approvedStagedBefore.files.length,
        fullTreeSha256: fullStagedBefore.sha256,
        fullTreeFileCount: canonicalStage.files.length,
        dependencyMode: canonicalStage.dependencyMode,
        dependencies: {
          root: 'node_modules',
          fileCount: dependencySnapshot.fileCount,
          sha256: dependencySnapshot.sha256,
          cacheFileCount: dependencyCacheSnapshot.fileCount,
          cacheSha256: dependencyCacheSnapshot.sha256,
          packageJsonSha256: isolatedDependencies.packageJsonSha256,
          lockfileSha256: isolatedDependencies.lockfileSha256,
          registryOrigin: isolatedDependencies.registryOrigin,
          npm: isolatedDependencies.npm,
          tools: isolatedDependencies.tools,
          mutationProtection: process.platform === 'win32'
            ? 'windows-acl-read-execute'
            : 'read-only-mode-bits',
          verifiedAfterPackaging: true,
        },
        cleanedAfterRelease: true,
      },
      packagedAutomationDefault: 'disabled',
      packagedAutomationOptInFlag: '--enable-private-automation',
      appxManifest,
      archiveReadability: {
        appxZip: true,
        appxEntries,
        nsisAsar: true,
        appxAsar: true,
      },
      nsisVerification,
      nsisStagingDemucsRuntime,
      nsisInstalledDemucsRuntime,
      appxStagingVerification,
      appxStagingDemucsRuntime,
      appxExtractedDemucsRuntime,
      appxVerification,
      secretScans: {
        verdict: 'APPROVE',
        findings: 0,
        scans: [
          ...nsisSecretScans,
          ...appxStagingSecretScans,
          ...appxPayloadSecretScans,
        ],
      },
    },
    artifacts,
    hashesPath: promotedReleasePath(hashPath),
  }
  const reportPath = path.join(releaseDir, 'provenance.json')
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`APPROVE: isolated release completed.\nProvenance: ${reportPath}\nHashes: ${hashPath}`)
  } finally {
    await removeCanonicalStage(sourceDir)
  }
}

try {
  await main()
} catch (error) {
  console.error(`REJECT: ${error instanceof Error ? error.stack : String(error)}`)
  process.exitCode = 1
}
