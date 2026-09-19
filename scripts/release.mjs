import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  assertSecretScansClean,
  scanAsar,
  scanDirectory,
} from './package-secret-scan.mjs'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = path.join(root, 'release')
const lockPath = path.join(root, '.release.lock')
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const approvalArgument = process.argv.find((value) => value.startsWith('--approval='))
const approvalPath = approvalArgument
  ? path.resolve(root, approvalArgument.slice('--approval='.length))
  : undefined
let lock

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true })
    child.on('error', reject)
    child.on('close', (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} exited with code ${code}.`)))
  })
}

function runCaptured(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
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

async function acquireLock() {
  try {
    lock = await open(lockPath, 'wx')
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const existing = JSON.parse(await readFile(lockPath, 'utf8'))
    try {
      process.kill(existing.pid, 0)
      throw new Error(`Release is already running as process ${existing.pid}.`)
    } catch (probeError) {
      if (probeError.code !== 'ESRCH') throw probeError
      await unlink(lockPath)
      lock = await open(lockPath, 'wx')
    }
  }
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
}

async function hashFile(filePath) {
  const hash = createHash('sha256')
  hash.update(await readFile(filePath))
  return hash.digest('hex')
}

async function sourceFiles() {
  const roots = ['electron', 'src', 'scripts', 'build']
  const files = [
    'package.json',
    'package-lock.json',
    'README.md',
    'index.html',
    'tsconfig.json',
    'tsconfig.app.json',
    'tsconfig.electron.json',
    'tsconfig.node.json',
    'vite.config.ts',
  ]
  async function walk(relative) {
    const absolute = path.join(root, relative)
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      const child = path.join(relative, entry.name)
      if (entry.isDirectory()) {
        if (relative === 'scripts' && entry.name === 'qa-artifacts') continue
        await walk(child)
      } else {
        files.push(child)
      }
    }
  }
  for (const directory of roots) await walk(directory)
  return files.sort()
}

async function snapshotSources() {
  const entries = []
  for (const relative of await sourceFiles()) {
    const absolute = path.join(root, relative)
    try {
      entries.push({ path: relative.replaceAll('\\', '/'), sha256: await hashFile(absolute) })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  const aggregate = createHash('sha256')
  for (const entry of entries) aggregate.update(`${entry.path}\0${entry.sha256}\n`)
  return { sha256: aggregate.digest('hex'), files: entries }
}

function compareSnapshots(before, after) {
  const beforeFiles = new Map(before.files.map((entry) => [entry.path, entry.sha256]))
  const afterFiles = new Map(after.files.map((entry) => [entry.path, entry.sha256]))
  const missing = [...beforeFiles.keys()].filter((file) => !afterFiles.has(file))
  const extra = [...afterFiles.keys()].filter((file) => !beforeFiles.has(file))
  const mismatched = [...beforeFiles.keys()].filter((file) =>
    afterFiles.has(file) && afterFiles.get(file) !== beforeFiles.get(file))
  return { missing, extra, mismatched }
}

async function collectBuildOutputs(relativeRoot) {
  const outputs = {}
  async function walk(relative) {
    const absolute = path.join(root, relative)
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      const child = path.join(relative, entry.name)
      if (entry.isDirectory()) await walk(child)
      else outputs[child.replaceAll('\\', '/')] = await hashFile(path.join(root, child))
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
  const verificationScript = path.join(root, 'scripts', 'verify-packaged-demucs.mjs')
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
    evidencePath: path.relative(root, path.join(evidenceDir, 'report.json')).replaceAll('\\', '/'),
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
  await acquireLock()
  const startedAt = new Date().toISOString()
  let approval
  if (approvalPath) {
    approval = JSON.parse(await readFile(approvalPath, 'utf8'))
    if (approval.verdict !== 'APPROVE'
      || !Array.isArray(approval.cases)
      || approval.cases.length === 0
      || !approval.cases.every((item) => item.status === 'passed')) {
      throw new Error('Release approval evidence must be APPROVE with every reported gate passing.')
    }
  }
  const before = await snapshotSources()
  await rm(releaseDir, { recursive: true, force: true })
  await mkdir(releaseDir, { recursive: true })

  if (process.platform === 'win32') {
    await run(process.env.ComSpec, ['/d', '/s', '/c', 'npm run build'])
  } else {
    await run('npm', ['run', 'build'])
  }
  const automationModule = await import(`${new URL('../dist-electron/automation.js', import.meta.url).href}?release=${Date.now()}`)
  verifyAutomationModule(automationModule)

  const expected = {
    ...await collectBuildOutputs('dist'),
  }
  for (const relative of [
    'dist-electron/main.js',
    'dist-electron/preload.cjs',
    'dist-electron/automation.js',
  ]) {
    expected[relative] = await hashFile(path.join(root, relative))
  }

  const builder = require.resolve('electron-builder/out/cli/cli.js')
  await run(process.execPath, [builder, '--win', 'nsis', '--x64', '--publish', 'never'])
  const unpackedApp = path.join(releaseDir, 'win-unpacked')
  const unpackedAsar = path.join(releaseDir, 'win-unpacked', 'resources', 'app.asar')
  const nsisVerification = await verifyAsar(unpackedAsar, expected, 'NSIS staging app.asar')
  const nsisSecretScans = await scanStagingTree(unpackedApp, 'NSIS staging')
  const nsisStagingDemucsRuntime = await verifyPackagedDemucs(unpackedApp, 'nsis-staging')
  const exePath = path.join(releaseDir, `Karaoke Studio-Setup-${packageJson.version}.exe`)
  const nsisInstalledDemucsRuntime = await verifyNsisInstaller(exePath)

  await run(process.execPath, [builder, '--win', 'appx', '--x64', '--publish', 'never'])
  const appxStagingDemucsRuntime = await verifyPackagedDemucs(unpackedApp, 'appx-staging')
  const appxStagingSecretScans = await scanStagingTree(unpackedApp, 'APPX staging')

  const after = await snapshotSources()
  const sourceComparison = compareSnapshots(before, after)
  if (sourceComparison.missing.length
    || sourceComparison.extra.length
    || sourceComparison.mismatched.length) {
    throw new Error('Release inputs changed while packaging; artifacts were rejected.')
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
      path: path.relative(root, artifactPath).replaceAll('\\', '/'),
      bytes: info.size,
      sha256: await hashFile(artifactPath),
    })
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
      sha256: await hashFile(approvalPath),
      verdict: approval.verdict,
      passed: approval.cases.length,
      total: approval.cases.length,
    } : undefined,
    source: before,
    buildOutputs: expected,
    verification: {
      oneBuildForBothTargets: true,
      targetsBuiltSequentially: ['nsis', 'appx'],
      sourceUnchangedDuringRelease: true,
      sourceComparison,
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
    hashesPath: path.relative(root, hashPath).replaceAll('\\', '/'),
  }
  const reportPath = path.join(releaseDir, 'provenance.json')
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`APPROVE: isolated release completed.\nProvenance: ${reportPath}\nHashes: ${hashPath}`)
}

try {
  await main()
} catch (error) {
  console.error(`REJECT: ${error instanceof Error ? error.stack : String(error)}`)
  process.exitCode = 1
} finally {
  if (lock) await lock.close()
  await rm(lockPath, { force: true })
}
