import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

export class ReleaseSourceStagingError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ReleaseSourceStagingError'
  }
}

function gitBuffer(root, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    let stderr = ''
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => code === 0
      ? resolve(Buffer.concat(stdout))
      : reject(new ReleaseSourceStagingError(stderr.trim() || 'Git object read failed.')))
  })
}

function safeRelative(relative) {
  if (!relative || relative !== relative.normalize('NFC') || path.isAbsolute(relative)
    || relative.includes('\\') || relative.includes('\0') || relative.includes(':')
    || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new ReleaseSourceStagingError(`Unsafe committed source path: ${relative}.`)
  }
  return relative
}

async function commitEntries(root, commit) {
  const resolved = (await gitBuffer(root, ['rev-parse', `${commit}^{commit}`])).toString().trim()
  if (!/^[0-9a-f]{40}$/.test(resolved)) {
    throw new ReleaseSourceStagingError('Approved source commit is invalid.')
  }
  const tree = await gitBuffer(root, ['ls-tree', '-r', '-z', resolved])
  const entries = []
  const folded = new Set()
  for (const record of tree.toString('utf8').split('\0').filter(Boolean)) {
    const match = record.match(/^(\d{6}) (blob|tree|commit) ([0-9a-f]{40})\t(.+)$/s)
    if (!match || match[2] !== 'blob' || !['100644', '100755'].includes(match[1])) {
      throw new ReleaseSourceStagingError('Approved source tree contains a non-regular entry.')
    }
    const relative = safeRelative(match[4])
    const key = relative.toLowerCase()
    if (folded.has(key)) {
      throw new ReleaseSourceStagingError(`Approved source tree has a case-colliding path: ${relative}.`)
    }
    folded.add(key)
    entries.push({ path: relative, mode: match[1], objectId: match[3] })
  }
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return { commit: resolved, entries }
}

async function assertPlainDirectory(directory, expectedParent) {
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new ReleaseSourceStagingError('Release source staging contains a reparse or non-directory.')
  }
  const [actual, expected] = await Promise.all([realpath(directory), realpath(expectedParent)])
  const relative = path.relative(expected, actual)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ReleaseSourceStagingError('Release source staging escapes its owned parent.')
  }
}

function aggregate(entries) {
  const hash = createHash('sha256')
  for (const entry of entries) hash.update(`${entry.path}\0${entry.sha256}\n`)
  return hash.digest('hex')
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function runCaptured(command, args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
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
      : reject(new ReleaseSourceStagingError(
        `${command} exited with code ${code}.\n${stderr || stdout}`,
      )))
  })
}

function validateLockfile(packageJson, lockfile) {
  if (lockfile.lockfileVersion !== 3
    || lockfile.name !== packageJson.name
    || lockfile.version !== packageJson.version
    || lockfile.packages?.['']?.name !== packageJson.name
    || lockfile.packages?.['']?.version !== packageJson.version) {
    throw new ReleaseSourceStagingError(
      'package-lock.json is not an exact lockfile for the staged package metadata.',
    )
  }
  const origins = new Set()
  for (const [dependencyPath, dependency] of Object.entries(lockfile.packages ?? {})) {
    if (!dependencyPath) continue
    if (!dependency.integrity || !dependency.version) {
      throw new ReleaseSourceStagingError(
        `Locked dependency lacks version or integrity: ${dependencyPath}.`,
      )
    }
    if (dependency.resolved) {
      let resolved
      try {
        resolved = new URL(dependency.resolved)
      } catch {
        throw new ReleaseSourceStagingError(
          `Locked dependency has an invalid resolved URL: ${dependencyPath}.`,
        )
      }
      if (resolved.protocol !== 'https:') {
        throw new ReleaseSourceStagingError(
          `Locked dependency does not use HTTPS: ${dependencyPath}.`,
        )
      }
      origins.add(resolved.origin)
    }
  }
  if (origins.size !== 1) {
    throw new ReleaseSourceStagingError(
      `Lockfile must use one pinned HTTPS registry origin; found ${origins.size}.`,
    )
  }
  return [...origins][0]
}

async function dependencyEntries(dependencyRoot) {
  await realpath(dependencyRoot)
  const pendingFiles = []
  async function walk(directory, relative = '') {
    const directoryInfo = await lstat(directory)
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw new ReleaseSourceStagingError(
        `Dependency tree contains a linked or non-directory path: ${relative || 'node_modules'}.`,
      )
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name
      const absolute = path.join(directory, entry.name)
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) {
        throw new ReleaseSourceStagingError(
          `Dependency tree contains a symbolic link or junction: ${childRelative}.`,
        )
      }
      if (entry.isDirectory()) {
        await walk(absolute, childRelative)
      } else if (!entry.isFile() || info.nlink !== 1) {
        throw new ReleaseSourceStagingError(
          `Dependency is linked or not a regular file: ${childRelative}.`,
        )
      } else {
        pendingFiles.push({
          absolute,
          path: childRelative,
          bytes: info.size,
          mode: info.mode & 0o777,
        })
      }
    }
  }
  await walk(dependencyRoot)
  const entries = []
  for (let index = 0; index < pendingFiles.length; index += 16) {
    const batch = pendingFiles.slice(index, index + 16)
    entries.push(...await Promise.all(batch.map(async ({ absolute, ...entry }) => ({
      ...entry,
      sha256: await hashFile(absolute),
    }))))
  }
  entries.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  return entries
}

function aggregateDependencies(entries) {
  const hash = createHash('sha256')
  for (const entry of entries) {
    hash.update(`${entry.path}\0${entry.bytes}\0${entry.mode}\0${entry.sha256}\n`)
  }
  return hash.digest('hex')
}

export async function snapshotIsolatedDependencies(dependencyRoot, expected) {
  const entries = await dependencyEntries(dependencyRoot)
  const snapshot = {
    files: entries,
    fileCount: entries.length,
    sha256: aggregateDependencies(entries),
  }
  if (expected && (snapshot.fileCount !== expected.fileCount
    || snapshot.sha256 !== expected.sha256)) {
    throw new ReleaseSourceStagingError('Isolated dependency snapshot changed during release.')
  }
  return snapshot
}

async function currentUserSid() {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR
  const { stdout } = await runCaptured(
    path.join(systemRoot, 'System32', 'whoami.exe'),
    ['/user', '/fo', 'csv', '/nh'],
    {
      cwd: process.cwd(),
      env: process.env,
    },
  )
  const match = stdout.match(/"(S-\d+(?:-\d+)+)"/i)
  if (!match) throw new ReleaseSourceStagingError('Unable to determine the Windows user SID.')
  return match[1]
}

async function setWindowsTreeAccess(target, permission) {
  const sid = await currentUserSid()
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR
  await runCaptured(path.join(systemRoot, 'System32', 'icacls.exe'), [
    target,
    '/inheritance:r',
    '/grant:r',
    `*${sid}:(OI)(CI)${permission}`,
    '/q',
  ], { cwd: path.dirname(target), env: process.env })
}

async function restoreWindowsTreeAccess(target) {
  const sid = await currentUserSid()
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR
  await runCaptured(path.join(systemRoot, 'System32', 'icacls.exe'), [
    target,
    '/grant',
    `*${sid}:(OI)(CI)F`,
    '/t',
    '/c',
    '/q',
  ], { cwd: path.dirname(target), env: process.env })
}

export async function lockIsolatedDependencies(dependencyRoot, cacheRoot) {
  if (process.platform === 'win32') {
    if (dependencyRoot) await setWindowsTreeAccess(dependencyRoot, 'RX')
    if (cacheRoot) await setWindowsTreeAccess(cacheRoot, 'RX')
  } else {
    if (dependencyRoot) await makeReadOnly(dependencyRoot)
    if (cacheRoot) await makeReadOnly(cacheRoot)
  }
}

async function makeReadOnly(target) {
  const info = await lstat(target)
  if (info.isDirectory() && !info.isSymbolicLink()) {
    for (const entry of await readdir(target)) await makeReadOnly(path.join(target, entry))
    await chmod(target, 0o555)
  } else {
    await chmod(target, 0o444)
  }
}

function isolatedEnvironment(stageRoot, cacheRoot, registryOrigin) {
  const runtimeRoot = path.join(stageRoot, '.release-runtime')
  const temp = path.join(runtimeRoot, 'temp')
  const home = path.join(cacheRoot, 'home')
  const appData = path.join(home, 'AppData', 'Roaming')
  const localAppData = path.join(home, 'AppData', 'Local')
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR
  if (!systemRoot) throw new ReleaseSourceStagingError('SystemRoot is unavailable.')
  return {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    ComSpec: process.env.ComSpec ?? path.join(systemRoot, 'System32', 'cmd.exe'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    PATH: [path.dirname(process.execPath), path.join(systemRoot, 'System32')].join(path.delimiter),
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: temp,
    TMP: temp,
    npm_config_userconfig: path.join(cacheRoot, 'user.npmrc'),
    npm_config_globalconfig: path.join(cacheRoot, 'global.npmrc'),
    npm_config_cache: path.join(cacheRoot, 'npm'),
    npm_config_registry: registryOrigin,
    npm_config_prefix: path.join(cacheRoot, 'prefix'),
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_ignore_scripts: 'false',
    ELECTRON_CACHE: path.join(cacheRoot, 'electron'),
    ELECTRON_BUILDER_CACHE: path.join(cacheRoot, 'electron-builder'),
    KARAOKE_ISOLATED_RELEASE_ROOT: stageRoot,
  }
}

export function assertIsolatedResolvedPath(stageRoot, resolvedPath, label) {
  const dependencyRoot = path.join(stageRoot, 'node_modules')
  const resolved = path.resolve(resolvedPath)
  if (!isWithin(dependencyRoot, resolved)) {
    throw new ReleaseSourceStagingError(
      `${label} resolved outside isolated staged dependencies: ${resolved}.`,
    )
  }
  return resolved
}

export async function installIsolatedDependencies(stageRoot) {
  await assertPlainDirectory(stageRoot, path.dirname(stageRoot))
  const packagePath = path.join(stageRoot, 'package.json')
  const lockPath = path.join(stageRoot, 'package-lock.json')
  const [packageBytes, lockBytes] = await Promise.all([readFile(packagePath), readFile(lockPath)])
  const packageJson = JSON.parse(packageBytes)
  const lockfile = JSON.parse(lockBytes)
  const registryOrigin = validateLockfile(packageJson, lockfile)
  const cacheRoot = path.join(stageRoot, '.release-dependency-cache')
  await mkdir(path.join(stageRoot, '.release-runtime', 'temp'), { recursive: true })
  await mkdir(path.join(cacheRoot, 'home', 'AppData', 'Roaming'), { recursive: true })
  await mkdir(path.join(cacheRoot, 'home', 'AppData', 'Local'), { recursive: true })
  await writeFile(path.join(cacheRoot, 'user.npmrc'), '')
  await writeFile(path.join(cacheRoot, 'global.npmrc'), '')
  const env = isolatedEnvironment(stageRoot, cacheRoot, registryOrigin)
  const npmCli = process.env.npm_execpath
  if (!npmCli || path.basename(npmCli).toLowerCase() !== 'npm-cli.js') {
    throw new ReleaseSourceStagingError(
      'Release dependency installation must be launched by the canonical npm CLI.',
    )
  }
  const npmVersionResult = await runCaptured(process.execPath, [npmCli, '--version'], {
    cwd: stageRoot,
    env,
  })
  const npmVersion = npmVersionResult.stdout.trim()
  if (!/^\d+\.\d+\.\d+$/.test(npmVersion)) {
    throw new ReleaseSourceStagingError('Unable to bind an exact npm version.')
  }
  await runCaptured(process.execPath, [
    npmCli,
    'ci',
    '--foreground-scripts',
    '--no-audit',
    '--no-fund',
  ], { cwd: stageRoot, env })
  const dependencyRoot = path.join(stageRoot, 'node_modules')
  const require = createRequire(packagePath)
  const tools = {}
  for (const [label, definition] of Object.entries({
    typescript: ['typescript', 'bin/tsc'],
    vite: ['vite', 'bin/vite.js'],
    electronBuilder: ['electron-builder', 'out/cli/cli.js'],
    asar: ['@electron/asar', 'lib/asar.js'],
  })) {
    const [packageName, relative] = definition
    const packageRoot = path.dirname(require.resolve(`${packageName}/package.json`))
    const resolved = await realpath(path.join(packageRoot, ...relative.split('/')))
    tools[label] = {
      path: path.relative(stageRoot, assertIsolatedResolvedPath(stageRoot, resolved, label))
        .replaceAll('\\', '/'),
      sha256: await hashFile(resolved),
    }
  }
  const dependencies = await snapshotIsolatedDependencies(dependencyRoot)
  const cache = await snapshotIsolatedDependencies(cacheRoot)
  return {
    root: dependencyRoot,
    cacheRoot,
    env,
    require,
    packageJsonSha256: createHash('sha256').update(packageBytes).digest('hex'),
    lockfileSha256: createHash('sha256').update(lockBytes).digest('hex'),
    registryOrigin,
    npm: {
      version: npmVersion,
      cli: path.basename(npmCli),
      cliSha256: await hashFile(npmCli),
      nodeVersion: process.version,
      nodeExecutableSha256: await hashFile(process.execPath),
    },
    tools,
    dependencies,
    cache,
  }
}

export async function snapshotCanonicalStage(stageRoot, expectedEntries, {
  allowedGenerated = [],
} = {}) {
  await assertPlainDirectory(stageRoot, path.dirname(stageRoot))
  const expectedPaths = new Set(expectedEntries.map((entry) => entry.path))
  const allowed = new Set(allowedGenerated)
  async function walk(directory, relative = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name
      if (child === 'node_modules') continue
      if ([...allowed].some((item) => child === item || child.startsWith(`${item}/`))) continue
      const absolute = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        throw new ReleaseSourceStagingError(`Staged source contains an unexpected link: ${child}.`)
      }
      if (entry.isDirectory()) await walk(absolute, child)
      else if (!entry.isFile() || !expectedPaths.has(child)) {
        throw new ReleaseSourceStagingError(`Staged source contains an unexpected path: ${child}.`)
      }
    }
  }
  await walk(stageRoot)
  const files = []
  for (const expected of expectedEntries) {
    const absolute = path.join(stageRoot, ...expected.path.split('/'))
    const relative = path.relative(stageRoot, absolute)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new ReleaseSourceStagingError(`Staged source escapes its root: ${expected.path}.`)
    }
    const info = await lstat(absolute)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw new ReleaseSourceStagingError(`Staged source is linked or not regular: ${expected.path}.`)
    }
    const resolved = await realpath(absolute)
    const relativeResolved = path.relative(await realpath(stageRoot), resolved)
    if (relativeResolved.startsWith('..') || path.isAbsolute(relativeResolved)) {
      throw new ReleaseSourceStagingError(`Staged source path escapes through a reparse point: ${expected.path}.`)
    }
    const content = await readFile(absolute)
    const sha256 = createHash('sha256').update(content).digest('hex')
    if (content.length !== expected.bytes || sha256 !== expected.sha256) {
      throw new ReleaseSourceStagingError(`Staged canonical source changed: ${expected.path}.`)
    }
    files.push({ path: expected.path, bytes: content.length, sha256 })
  }
  return { files, sha256: aggregate(files) }
}

async function makeWritable(target) {
  try {
    if (process.platform === 'win32') {
      try {
        await restoreWindowsTreeAccess(target)
        await chmod(target, 0o755)
        return
      } catch {
        // Fall through to chmod/rm so partially-created trees can still be cleaned.
      }
    }
    const info = await lstat(target)
    if (info.isDirectory() && !info.isSymbolicLink()) {
      for (const entry of await readdir(target)) await makeWritable(path.join(target, entry))
    }
    await chmod(target, info.isDirectory() ? 0o755 : 0o644)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

export async function removeCanonicalStage(stageRoot) {
  await makeWritable(stageRoot)
  await rm(stageRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

export async function materializeCanonicalSource({
  repositoryRoot,
  commit,
  stageRoot,
}) {
  const parent = path.dirname(stageRoot)
  if (parent !== path.resolve(repositoryRoot)
    || !path.basename(stageRoot).startsWith('.release-source-')) {
    throw new ReleaseSourceStagingError(
      'Release source staging must be an owned directory directly under the repository root.',
    )
  }
  const creating = `${stageRoot}.creating`
  await removeCanonicalStage(stageRoot)
  await removeCanonicalStage(creating)
  const { commit: resolvedCommit, entries } = await commitEntries(repositoryRoot, commit)
  const manifest = []
  try {
    await mkdir(creating)
    for (const entry of entries) {
      const absolute = path.join(creating, ...entry.path.split('/'))
      await mkdir(path.dirname(absolute), { recursive: true })
      const content = await gitBuffer(repositoryRoot, ['cat-file', 'blob', entry.objectId])
      await writeFile(absolute, content, { flag: 'wx', mode: entry.mode === '100755' ? 0o755 : 0o644 })
      manifest.push({
        path: entry.path,
        bytes: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
      })
    }
    await snapshotCanonicalStage(creating, manifest)
    await rename(creating, stageRoot)
    await assertPlainDirectory(stageRoot, parent)

    for (const entry of manifest) {
      await chmod(path.join(stageRoot, ...entry.path.split('/')), 0o444)
    }
    const snapshot = await snapshotCanonicalStage(stageRoot, manifest)
    return {
      root: stageRoot,
      commit: resolvedCommit,
      files: manifest,
      sha256: snapshot.sha256,
      dependencyMode: 'fresh-lockfile-npm-ci-isolated-read-only',
    }
  } catch (error) {
    await removeCanonicalStage(creating)
    await removeCanonicalStage(stageRoot)
    throw error
  }
}
