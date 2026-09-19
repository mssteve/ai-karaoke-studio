import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'

const prohibitedBasenames = [
  /^\.env(?:\..+)?$/i,
  /^\.(?:npmrc|yarnrc(?:\..+)?|pypirc|netrc|git-credentials)$/i,
  /^(?:credentials?|service-account)(?:[._-].*)?\.json$/i,
  /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$/i,
  /^(?:token|tokens|secrets?)(?:[._-].*)?$/i,
]

const prohibitedExtensions = new Set([
  '.cer',
  '.crt',
  '.jks',
  '.key',
  '.kdbx',
  '.keystore',
  '.p12',
  '.p7b',
  '.pem',
  '.pfx',
  '.pvk',
  '.secret',
  '.snk',
])

const prohibitedSegments = new Set(['.aws', '.azure', '.gnupg', '.secrets', '.ssh', 'secrets'])

const credentialPatterns = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\bgh[pousr]_[0-9A-Za-z]{20,}\b/,
  /\bgithub_pat_[0-9A-Za-z_]{20,}\b/,
  /\bnpm_[0-9A-Za-z]{20,}\b/,
  /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/,
  /(?:^|[\r\n])\s*(?:NPM_TOKEN|NODE_AUTH_TOKEN|AUTH_TOKEN|ACCESS_TOKEN|API_KEY|CLIENT_SECRET|PRIVATE_KEY|PASSWORD)\s*=\s*["']?[^\s"'#]{16,}/i,
  /\/\/registry\.npmjs\.org\/:_authToken\s*=\s*[^\s]{16,}/i,
]

function normalize(value) {
  return value.replaceAll('\\', '/').replace(/^\/+/, '')
}

function isProhibitedPath(relativePath) {
  const normalized = normalize(relativePath)
  const segments = normalized.split('/')
  const basename = segments.at(-1) ?? ''
  if (segments.some((segment) => prohibitedSegments.has(segment.toLowerCase()))) return true
  if (prohibitedBasenames.some((pattern) => pattern.test(basename))) return true
  return prohibitedExtensions.has(path.extname(basename).toLowerCase())
}

function hasCredentialMaterial(text) {
  return credentialPatterns.some((pattern) => pattern.test(text))
}

function createResult(label) {
  return {
    label,
    entriesChecked: 0,
    filesChecked: 0,
    contentFilesScanned: 0,
    bytesChecked: 0,
    prohibitedPathFindings: 0,
    credentialContentFindings: 0,
    findings: [],
  }
}

function addFinding(result, logicalPath, sha256, kind) {
  if (result.findings.some((finding) => finding.path === logicalPath && finding.sha256 === sha256)) return
  result.findings.push({ path: logicalPath, sha256 })
  if (kind === 'path') result.prohibitedPathFindings += 1
  else result.credentialContentFindings += 1
}

function isProbablyText(buffer) {
  if (!buffer.length) return true
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192))
  let suspiciousControls = 0
  for (const byte of sample) {
    if (byte === 0) return false
    if (byte < 9 || (byte > 13 && byte < 32)) suspiciousControls += 1
  }
  return suspiciousControls / sample.length < 0.02
}

function scanBuffer(buffer) {
  return isProbablyText(buffer) && hasCredentialMaterial(buffer.toString('utf8'))
}

async function inspectFile(filePath, logicalPath, result) {
  const hash = createHash('sha256')
  let carry = ''
  let credentialLike = false
  let textFile
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk)
    result.bytesChecked += chunk.length
    if (textFile === undefined) {
      textFile = isProbablyText(chunk)
      if (textFile) result.contentFilesScanned += 1
    }
    if (textFile && !credentialLike) {
      const text = carry + chunk.toString('utf8')
      credentialLike = hasCredentialMaterial(text)
      carry = text.slice(-512)
    }
  }
  const sha256 = hash.digest('hex')
  if (isProhibitedPath(logicalPath)) addFinding(result, logicalPath, sha256, 'path')
  if (credentialLike) addFinding(result, logicalPath, sha256, 'content')
}

export async function scanDirectory(rootPath, label, options = {}) {
  const result = createResult(label)
  const skipContent = new Set((options.skipContent ?? []).map(normalize))

  async function walk(directory, relative = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const childRelative = normalize(path.join(relative, entry.name))
      const childPath = path.join(directory, entry.name)
      result.entriesChecked += 1
      if (entry.isDirectory()) {
        if (isProhibitedPath(childRelative)) {
          addFinding(result, childRelative, createHash('sha256').update(childRelative).digest('hex'), 'path')
        }
        await walk(childPath, childRelative)
      } else if (entry.isFile()) {
        result.filesChecked += 1
        if (skipContent.has(childRelative)) {
          const info = await lstat(childPath)
          result.bytesChecked += info.size
          const sha256 = await hashPath(childPath)
          if (isProhibitedPath(childRelative)) addFinding(result, childRelative, sha256, 'path')
        } else {
          await inspectFile(childPath, childRelative, result)
        }
      } else if (entry.isSymbolicLink()) {
        throw new Error(`Package secret scan cannot safely follow symbolic link: ${label}:${childRelative}`)
      }
    }
  }

  await walk(rootPath)
  result.findings.sort((a, b) => a.path.localeCompare(b.path))
  return result
}

export async function scanAsar(asar, asarPath, label) {
  const result = createResult(label)
  for (const listedPath of asar.listPackage(asarPath)) {
    const logicalPath = normalize(listedPath)
    result.entriesChecked += 1
    const archivePath = process.platform === 'win32' ? logicalPath.replaceAll('/', '\\') : logicalPath
    const metadata = asar.statFile(asarPath, archivePath)
    if (!metadata || metadata.files) {
      if (isProhibitedPath(logicalPath)) {
        addFinding(result, logicalPath, createHash('sha256').update(logicalPath).digest('hex'), 'path')
      }
      continue
    }
    result.filesChecked += 1
    if (metadata.unpacked) {
      if (isProhibitedPath(logicalPath)) {
        const unpackedPath = `${asarPath}.unpacked\\${logicalPath.replaceAll('/', '\\')}`
        addFinding(result, logicalPath, await hashPath(unpackedPath), 'path')
      }
      continue
    }
    const contents = asar.extractFile(asarPath, archivePath)
    result.bytesChecked += contents.length
    if (isProbablyText(contents)) result.contentFilesScanned += 1
    const sha256 = createHash('sha256').update(contents).digest('hex')
    if (isProhibitedPath(logicalPath)) addFinding(result, logicalPath, sha256, 'path')
    if (scanBuffer(contents)) addFinding(result, logicalPath, sha256, 'content')
  }
  result.findings.sort((a, b) => a.path.localeCompare(b.path))
  return result
}

export async function hashPath(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

export function assertSecretScansClean(scans) {
  const findings = scans.flatMap((scan) =>
    scan.findings.map((finding) => ({ path: `${scan.label}:${finding.path}`, sha256: finding.sha256 })))
  if (!findings.length) return
  throw new Error(`Package secret scan rejected ${findings.length} finding(s):\n${JSON.stringify(findings, null, 2)}`)
}
