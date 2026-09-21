import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { lstat, readFile, realpath, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')

export class ArtifactVerificationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ArtifactVerificationError'
    this.exitCode = 5
  }
}

export async function hashFile(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

export async function readPackageMetadata(root) {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const packageLock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'))
  const lockVersion = packageLock.version ?? packageLock.packages?.['']?.version
  const rootLockVersion = packageLock.packages?.['']?.version ?? lockVersion
  if (!packageJson.version || packageJson.version !== lockVersion
    || packageJson.version !== rootLockVersion) {
    throw new ArtifactVerificationError('package.json and package-lock.json versions differ.')
  }
  return { packageJson, packageLock, version: packageJson.version }
}

function captured(command, args, cwd) {
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
      ? resolve(stdout.trim())
      : reject(new ArtifactVerificationError(stderr.trim() || `${command} failed.`)))
  })
}

function capturedBuffer(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    let stderr = ''
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => code === 0
      ? resolve(Buffer.concat(stdout))
      : reject(new ArtifactVerificationError(stderr.trim() || `${command} failed.`)))
  })
}

function gitQuiet(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(true)
      else if (code === 1) resolve(false)
      else reject(new ArtifactVerificationError(stderr.trim() || 'git failed.'))
    })
  })
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ArtifactVerificationError(`${label} must be an object.`)
  }
  const actual = Object.keys(value).sort()
  const allowed = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(allowed)) {
    throw new ArtifactVerificationError(`${label} contains missing or unknown fields.`)
  }
}

const APPROVAL_PATH_PREFIX = '.squad/approvals/'
const TANK_EVIDENCE_PREFIXES = ['.squad/agents/tank/', '.squad/decisions/inbox/']
const APPROVAL_COMMIT_PATHS = [APPROVAL_PATH_PREFIX, ...TANK_EVIDENCE_PREFIXES]
const PROTECTED_SOURCE_PATHS = [
  '.gitattributes',
  '.gitignore',
  '.squad/reviewers.json',
  'README.md',
  'index.html',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.electron.json',
  'tsconfig.node.json',
  'vite.config.ts',
  'electron',
  'src',
  'build',
  'scripts',
  '.squad/skills',
  '.copilot/skills',
]

function safeRepositoryPath(root, relative, label) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)
    || relative.includes('\0') || relative.includes('\\') || relative.includes(':')
    || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new ArtifactVerificationError(`${label} must be a repository-relative path.`)
  }
  const absolute = path.resolve(root, relative)
  const prefix = `${path.resolve(root)}${path.sep}`.toLowerCase()
  if (!absolute.toLowerCase().startsWith(prefix)) {
    throw new ArtifactVerificationError(`${label} escapes the repository.`)
  }
  return absolute
}

const SAFE_COMMITTED_FILE_ATTRIBUTES = [
  'filter',
  'ident',
  'working-tree-encoding',
  'text',
  'eol',
]

const GIT_ENVIRONMENT_OVERRIDES = [
  'GIT_DIR',
  'GIT_COMMON_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_ATTR_SOURCE',
  'GIT_ATTR_NOSYSTEM',
  'GIT_CONFIG_NOSYSTEM',
]

function assertSafeGitEnvironment() {
  const override = GIT_ENVIRONMENT_OVERRIDES.find((name) => process.env[name] !== undefined)
  if (override) {
    throw new ArtifactVerificationError(
      `Git repository or attribute environment override is not allowed: ${override}.`,
    )
  }
}

function parseAttributeRecords(buffer, label) {
  const records = buffer.toString('utf8').split('\0')
  const paths = new Map()
  for (let index = 0; index + 2 < records.length; index += 3) {
    const relative = records[index]
    const attribute = records[index + 1]
    if (!relative || !SAFE_COMMITTED_FILE_ATTRIBUTES.includes(attribute)) {
      throw new ArtifactVerificationError(`${label} has invalid Git attribute output.`)
    }
    const attributes = paths.get(relative) ?? new Map()
    if (attributes.has(attribute)) {
      throw new ArtifactVerificationError(`${label} has ambiguous Git attributes.`)
    }
    attributes.set(attribute, records[index + 2])
    paths.set(relative, attributes)
  }
  return paths
}

function attributePatternMatches(pattern, relative) {
  if (!/^[A-Za-z0-9._/*?-]+$/.test(pattern) || pattern.startsWith('!')) {
    throw new ArtifactVerificationError(
      `Git attributes use an unsupported protected-source pattern: ${pattern}.`,
    )
  }
  const target = pattern.includes('/') ? relative : path.posix.basename(relative)
  let expression = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '*' && pattern[index + 1] === '*') {
      expression += '.*'
      index += 1
    } else if (character === '*') {
      expression += '[^/]*'
    } else if (character === '?') {
      expression += '[^/]'
    } else {
      expression += character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
    }
  }
  return new RegExp(`${expression}$`).test(target)
}

function parseCommittedAttributePolicy(content, relative, label) {
  const attributes = new Map(SAFE_COMMITTED_FILE_ATTRIBUTES.map((name) => [name, 'unspecified']))
  const text = content.toString('utf8')
  if (text.includes('\0')) {
    throw new ArtifactVerificationError('Committed Git attributes contain a NUL byte.')
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const tokens = line.split(/\s+/)
    const pattern = tokens.shift()
    if (pattern.startsWith('[attr]')) {
      throw new ArtifactVerificationError('Git attribute macros are not allowed.')
    }
    const relevant = tokens.filter((token) => {
      const name = token.replace(/^[-!]/, '').split('=', 1)[0]
      return SAFE_COMMITTED_FILE_ATTRIBUTES.includes(name)
    })
    if (!relevant.length || !attributePatternMatches(pattern, relative)) continue
    for (const token of relevant) {
      const marker = token[0]
      const body = ['-', '!'].includes(marker) ? token.slice(1) : token
      const separator = body.indexOf('=')
      const name = separator === -1 ? body : body.slice(0, separator)
      const value = marker === '-' ? 'unset'
        : marker === '!' ? 'unspecified'
          : separator === -1 ? 'set' : body.slice(separator + 1)
      attributes.set(name, value)
    }
  }
  assertSafeAttributeState(attributes, label)
  return attributes
}

function assertSafeAttributeState(attributes, label) {
  for (const attribute of ['filter', 'ident', 'working-tree-encoding']) {
    if (attributes.get(attribute) !== 'unset') {
      throw new ArtifactVerificationError(
        `${label} does not explicitly disable Git content transform: ${attribute}.`,
      )
    }
  }
  const text = attributes.get('text')
  const eol = attributes.get('eol')
  if (!((text === 'set' && ['lf', 'crlf'].includes(eol))
    || (text === 'unset' && eol === 'unset'))) {
    throw new ArtifactVerificationError(
      `${label} does not explicitly declare a safe Git text/EOL policy.`,
    )
  }
}

async function configuredFilterDrivers(root) {
  const output = await new Promise((resolve, reject) => {
    const child = spawn('git', [
      'config', '--null', '--name-only', '--get-regexp',
      '^filter\\..*\\.(clean|smudge|process|required)$',
    ], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    let stderr = ''
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0 || code === 1) resolve(Buffer.concat(stdout))
      else reject(new ArtifactVerificationError(stderr.trim() || 'git config failed.'))
    })
  })
  return new Set(output.toString('utf8').split('\0').filter(Boolean).map((key) => {
    const match = key.toLowerCase().match(/^filter\.(.+)\.(?:clean|smudge|process|required)$/)
    return match?.[1]
  }).filter(Boolean))
}

async function committedAttributeFile(root, commit) {
  const treeLine = (await capturedBuffer(
    'git', ['ls-tree', '-z', commit, '--', '.gitattributes'], root,
  )).toString('utf8')
  const match = treeLine.match(/^100(?:644|755) blob ([0-9a-f]{40})\t\.gitattributes\0$/)
  if (!match) throw new ArtifactVerificationError('Git attributes are not committed.')
  return capturedBuffer('git', ['cat-file', 'blob', match[1]], root)
}

async function committedAttributes(root, commit, relative, label) {
  return parseCommittedAttributePolicy(
    await committedAttributeFile(root, commit),
    relative,
    label,
  )
}

async function effectiveAttributes(root, relativePaths, label) {
  const output = await capturedBuffer('git', [
    'check-attr', '-z', ...SAFE_COMMITTED_FILE_ATTRIBUTES, '--', ...relativePaths,
  ], root)
  return parseAttributeRecords(output, label)
}

async function assertSafeCommittedFileAttributes(root, relative, commit, label) {
  assertSafeGitEnvironment()
  const committed = await committedAttributes(root, commit, relative, label)
  const effective = (await effectiveAttributes(root, [relative], label)).get(relative)
  if (!effective) throw new ArtifactVerificationError(`${label} has no Git attribute state.`)
  for (const attribute of SAFE_COMMITTED_FILE_ATTRIBUTES) {
    const committedValue = committed.get(attribute)
    const effectiveValue = effective.get(attribute)
    if (committedValue !== effectiveValue) {
      throw new ArtifactVerificationError(
        `${label} has locally overridden or inherited Git attribute: ${attribute}.`,
      )
    }
  }
  const drivers = await configuredFilterDrivers(root)
  if (drivers.has(effective.get('filter')?.toLowerCase())) {
    throw new ArtifactVerificationError(
      `${label} has an ambiguous configured Git filter driver: ${effective.get('filter')}.`,
    )
  }
  return committed
}

function allowedWorktreeContent(blob, attributes) {
  if (attributes.get('text') === 'unset' || attributes.get('eol') === 'lf') return blob
  const bytes = []
  for (let index = 0; index < blob.length; index += 1) {
    if (blob[index] === 0x0a && (index === 0 || blob[index - 1] !== 0x0d)) bytes.push(0x0d)
    bytes.push(blob[index])
  }
  return Buffer.from(bytes)
}

async function exactPhysicalFile(root, relative, label) {
  const absolute = safeRepositoryPath(root, relative, label)
  const rootReal = await realpath(root)
  let cursor = root
  for (const component of relative.split('/')) {
    const names = await readdir(cursor)
    if (!names.includes(component)) {
      throw new ArtifactVerificationError(
        `${label} path case or identity is not canonical: ${relative}.`,
      )
    }
    cursor = path.join(cursor, component)
    let info
    try { info = await lstat(cursor) } catch (error) {
      if (error.code === 'ENOENT') {
        throw new ArtifactVerificationError(`${label} is missing: ${relative}.`)
      }
      throw error
    }
    if (info.isSymbolicLink()) {
      throw new ArtifactVerificationError(`${label} contains a symlink or reparse point: ${relative}.`)
    }
    if (cursor === absolute && !info.isFile()) {
      throw new ArtifactVerificationError(`${label} is not a regular worktree file: ${relative}.`)
    }
    if (info.nlink > 1 && info.isFile()) {
      throw new ArtifactVerificationError(`${label} has ambiguous hard links: ${relative}.`)
    }
  }
  const resolved = await realpath(absolute)
  const prefix = `${rootReal}${path.sep}`.toLowerCase()
  if (!resolved.toLowerCase().startsWith(prefix)) {
    throw new ArtifactVerificationError(`${label} resolves outside the repository.`)
  }
  return { absolute, info: await lstat(absolute) }
}

async function readValidatedWorktreeFile(root, relative, label, blob, attributes) {
  const physical = await exactPhysicalFile(root, relative, label)
  const content = await readFile(physical.absolute)
  const after = await lstat(physical.absolute)
  if (!after.isFile() || after.isSymbolicLink() || after.nlink > 1
    || after.dev !== physical.info.dev || after.ino !== physical.info.ino
    || after.size !== physical.info.size
    || Math.trunc(after.mtimeMs) !== Math.trunc(physical.info.mtimeMs)) {
    throw new ArtifactVerificationError(`${label} changed while it was being validated: ${relative}.`)
  }
  if (!content.equals(allowedWorktreeContent(blob, attributes))) {
    throw new ArtifactVerificationError(
      `${label} physical bytes differ from committed content: ${relative}.`,
    )
  }
  return {
    absolute: physical.absolute,
    content,
    size: after.size,
    mtimeMs: Math.trunc(after.mtimeMs),
    sha256: createHash('sha256').update(content).digest('hex'),
  }
}

async function assertCanonicalCommittedFile(root, relative, commit, label) {
  const attributes = await assertSafeCommittedFileAttributes(root, relative, commit, label)
  const treeLine = (await capturedBuffer(
    'git', ['ls-tree', '-z', commit, '--', relative], root,
  )).toString('utf8')
  const match = treeLine.match(/^100(644|755) blob ([0-9a-f]{40})\t([^\0]+)\0$/)
  if (!match || match[3] !== relative) {
    throw new ArtifactVerificationError(`${label} is not an exact tracked regular file: ${relative}.`)
  }
  const index = (await capturedBuffer(
    'git', ['ls-files', '--stage', '-z', '--', relative], root,
  )).toString('utf8')
  const indexMatch = index.match(/^100(644|755) ([0-9a-f]{40}) 0\t([^\0]+)\0$/)
  if (!indexMatch || indexMatch[3] !== relative
    || indexMatch[1] !== match[1] || indexMatch[2] !== match[2]) {
    throw new ArtifactVerificationError(`${label} index differs from the committed blob: ${relative}.`)
  }
  const trackedCase = await captured('git', ['ls-files', '--full-name', '--', relative], root)
  if (trackedCase !== relative || indexMatch[3] !== relative) {
    throw new ArtifactVerificationError(`${label} path case is not canonical: ${relative}.`)
  }
  const ignored = await new Promise((resolve, reject) => {
    const child = spawn('git', ['check-ignore', '--quiet', '--', relative], {
      cwd: root, windowsHide: true, stdio: 'ignore',
    })
    child.on('error', reject)
    child.on('close', (code) => resolve(code === 0))
  })
  if (ignored) throw new ArtifactVerificationError(`${label} is ignored: ${relative}.`)
  const blob = await capturedBuffer('git', ['cat-file', 'blob', match[2]], root)
  const worktree = await readValidatedWorktreeFile(root, relative, label, blob, attributes)
  return {
    absolute: worktree.absolute,
    content: blob,
    objectId: match[2],
    sha256: createHash('sha256').update(blob).digest('hex'),
  }
}

const APPROVAL_KEYS = [
  'schemaVersion', 'kind', 'reviewer', 'verdict', 'packageVersion', 'appxVersion',
  'branch', 'targetCommit', 'source', 'evidence', 'createdAt', 'expiresAt',
]
const REVIEWER_REGISTRY_PATH = '.squad/reviewers.json'

function canonicalRegistryValue(value) {
  return value.normalize('NFKC').trim().toLowerCase()
}

function validateRegistryEntry(entry, fields, label) {
  exactKeys(entry, fields, label)
  for (const field of fields) {
    const value = entry[field]
    if (typeof value !== 'string' || !value || value !== value.trim()
      || value !== value.normalize('NFKC') || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new ArtifactVerificationError('Reviewer registry contains invalid entries.')
    }
    if (field === 'email' && !/^[^\s<>@]+@[^\s<>@]+$/.test(value)) {
      throw new ArtifactVerificationError('Reviewer registry contains invalid entries.')
    }
  }
}

function assertUniqueRegistryFields(entries, fields) {
  for (const field of fields) {
    const seen = new Set()
    for (const entry of entries) {
      const canonical = canonicalRegistryValue(entry[field])
      if (seen.has(canonical)) {
        throw new ArtifactVerificationError('Reviewer registry contains ambiguous identities.')
      }
      seen.add(canonical)
    }
  }
}

function validateReviewerRegistry(registry) {
  for (const reviewer of registry.reviewers) {
    validateRegistryEntry(
      reviewer, ['identity', 'role', 'name', 'email'], 'Reviewer registry entry',
    )
  }
  const committers = registry.approvalPolicy.allowedCommitters
  for (const committer of committers) {
    validateRegistryEntry(committer, ['identity', 'name', 'email'], 'Allowed committer')
  }
  for (const value of [
    registry.approvalPolicy.reviewerIdentity,
    registry.approvalPolicy.requiredTrailers['Reviewed-by'],
    registry.approvalPolicy.requiredTrailers['Reviewer-Role'],
  ]) {
    if (typeof value !== 'string' || !value || value !== value.trim()
      || value !== value.normalize('NFKC') || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new ArtifactVerificationError('Reviewer registry contains invalid policy.')
    }
  }
  assertUniqueRegistryFields(registry.reviewers, ['identity', 'name', 'email'])
  assertUniqueRegistryFields(committers, ['identity', 'name', 'email'])

  for (const reviewer of registry.reviewers) {
    const reviewerValues = ['identity', 'name', 'email']
      .map((field) => canonicalRegistryValue(reviewer[field]))
    for (const committer of committers) {
      const committerValues = ['identity', 'name', 'email']
        .map((field) => canonicalRegistryValue(committer[field]))
      if (reviewerValues.some((value, index) => value === committerValues[index])
        && (reviewer.identity !== committer.identity
          || reviewer.name !== committer.name
          || reviewer.email !== committer.email)) {
        throw new ArtifactVerificationError('Reviewer registry contains ambiguous mappings.')
      }
    }
  }
}

function parseCommitTrailers(message) {
  const lines = String(message).replace(/\r\n/g, '\n').split('\n')
  while (lines.at(-1) === '') lines.pop()
  const trailers = []
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (!line) break
    const match = line.match(/^([^:\s][^:]*):[ \t]+(.+)$/)
    if (!match) break
    trailers.unshift({ key: match[1], value: match[2].trim() })
  }
  return trailers
}

async function readReviewerPolicy(root, commit) {
  const registryFile = await assertCanonicalCommittedFile(
    root, REVIEWER_REGISTRY_PATH, commit, 'Reviewer registry',
  )
  let registry
  try { registry = JSON.parse(registryFile.content.toString('utf8')) } catch {
    throw new ArtifactVerificationError('Reviewer registry is invalid.')
  }
  exactKeys(registry, ['schemaVersion', 'reviewers', 'approvalPolicy'], 'Reviewer registry')
  exactKeys(
    registry.approvalPolicy,
    ['reviewerIdentity', 'requiredTrailers', 'allowedCommitters'],
    'Reviewer approval policy',
  )
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.reviewers)
    || registry.reviewers.length === 0 || !Array.isArray(registry.approvalPolicy.allowedCommitters)
    || registry.approvalPolicy.allowedCommitters.length === 0) {
    throw new ArtifactVerificationError('Reviewer registry schema or policy is invalid.')
  }
  exactKeys(
    registry.approvalPolicy.requiredTrailers,
    ['Reviewed-by', 'Reviewer-Role'],
    'Required reviewer trailers',
  )
  validateReviewerRegistry(registry)
  const reviewer = registry.reviewers.find(
    (entry) => entry.identity === registry.approvalPolicy.reviewerIdentity,
  )
  if (!reviewer || !reviewer.identity || !reviewer.role || !reviewer.name || !reviewer.email
    || registry.approvalPolicy.requiredTrailers['Reviewed-by']
      !== `${reviewer.identity} <${reviewer.email}>`
    || registry.approvalPolicy.requiredTrailers['Reviewer-Role'] !== reviewer.role) {
    throw new ArtifactVerificationError('Reviewer registry policy is inconsistent.')
  }
  return { registry, reviewer, sha256: registryFile.sha256 }
}

export async function validateApproval(root, approvalPath, {
  now = new Date(),
  expectedSource,
  expectedBranch,
  expectedHead,
  maxAgeMs = 7 * 24 * 60 * 60 * 1000,
} = {}) {
  if (!approvalPath) throw new ArtifactVerificationError('Reviewer approval evidence is required.')
  const relativeApproval = String(approvalPath).replaceAll('\\', '/')
  if (!relativeApproval.startsWith(APPROVAL_PATH_PREFIX)) {
    throw new ArtifactVerificationError('Approval must use the repository approval path.')
  }
  const approvalCommit = expectedHead ?? await captured('git', ['rev-parse', 'HEAD'], root)
  const parents = (await captured('git', ['rev-list', '--parents', '-n', '1', approvalCommit], root))
    .split(/\s+/).slice(1)
  if (parents.length !== 1) {
    throw new ArtifactVerificationError('Approval commit must have exactly one target parent.')
  }
  const [parent] = parents
  await assertCanonicalCommittedFile(root, '.gitattributes', approvalCommit, 'Git attributes')
  const approvalFile = await assertCanonicalCommittedFile(
    root, relativeApproval, approvalCommit, 'Approval',
  )
  const reviewerPolicy = await readReviewerPolicy(root, approvalCommit)
  const absolute = approvalFile.absolute
  let approval
  try {
    approval = JSON.parse(approvalFile.content.toString('utf8'))
  } catch {
    throw new ArtifactVerificationError('Reviewer approval evidence is missing or invalid.')
  }
  exactKeys(approval, APPROVAL_KEYS, 'Approval')
  exactKeys(approval.reviewer, ['identity', 'role'], 'Approval reviewer')
  exactKeys(approval.source, ['sha256', 'fileCount'], 'Approval source')
  if (approval.schemaVersion !== 2 || approval.kind !== 'karaoke-release-approval'
    || approval.verdict !== 'APPROVE') {
    throw new ArtifactVerificationError('Approval schema, kind, or verdict is invalid.')
  }
  const configured = reviewerPolicy.reviewer
  if (approval.reviewer.identity !== configured.identity
    || approval.reviewer.role !== configured.role) {
    throw new ArtifactVerificationError('Approval reviewer does not match repository reviewer configuration.')
  }
  const format = '%an%x00%ae%x00%cn%x00%ce%x00%B'
  const commitIdentity = (await captured('git', ['show', '-s', `--format=${format}`, approvalCommit], root)).split('\0')
  const [authorName, authorEmail, committerName, committerEmail, message = ''] = commitIdentity
  const trailers = parseCommitTrailers(message)
  const requiredTrailers = reviewerPolicy.registry.approvalPolicy.requiredTrailers
  const exactTrailer = (key) => trailers.filter((trailer) => trailer.key === key)
  const requiredKeys = Object.keys(requiredTrailers)
  const confusingTrailer = trailers.some(({ key }) => {
    if (requiredKeys.includes(key)) return false
    if (!/^[\x21-\x7e]+$/.test(key)) return true
    const folded = key.toLowerCase()
    return requiredKeys.some((required) => folded.includes(required.toLowerCase()))
  })
  const committerAllowed = reviewerPolicy.registry.approvalPolicy.allowedCommitters.some(
    (entry) => entry.name === committerName && entry.email === committerEmail,
  )
  if (authorName !== configured.name || authorEmail !== configured.email
    || !committerAllowed || confusingTrailer
    || exactTrailer('Reviewed-by').length !== 1
    || exactTrailer('Reviewed-by')[0].value !== requiredTrailers['Reviewed-by']
    || exactTrailer('Reviewer-Role').length !== 1
    || exactTrailer('Reviewer-Role')[0].value !== requiredTrailers['Reviewer-Role']) {
    throw new ArtifactVerificationError('Approval commit reviewer provenance is invalid.')
  }
  const targetAuthor = await captured('git', ['show', '-s', '--format=%ae', parent], root)
  if (targetAuthor.toLowerCase() === configured.email.toLowerCase()) {
    throw new ArtifactVerificationError('Source and approval commits must have different authors.')
  }
  const changed = (await captured('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', parent, approvalCommit], root))
    .split(/\r?\n/).filter(Boolean)
  if (!changed.length || changed.some((entry) =>
    !APPROVAL_COMMIT_PATHS.some((prefix) => entry.startsWith(prefix)))) {
    throw new ArtifactVerificationError('Approval commit changes product or release implementation files.')
  }
  const { version } = await readPackageMetadata(root)
  if (approval.packageVersion !== version || approval.appxVersion !== `${version}.0`) {
    throw new ArtifactVerificationError('Approval version does not match package metadata.')
  }
  const branch = expectedBranch ?? await captured('git', ['branch', '--show-current'], root)
  if (!branch || approval.branch !== branch || approval.targetCommit !== parent
    || !/^[0-9a-f]{40}$/i.test(approval.targetCommit)) {
    throw new ArtifactVerificationError('Approval branch or target-parent identity does not match.')
  }
  const source = await snapshotProtectedCommit(root, parent)
  if (approval.source.sha256 !== source.sha256
    || approval.source.fileCount !== source.files.length) {
    throw new ArtifactVerificationError('Approval source aggregate or protected file count differs.')
  }
  const createdAt = Date.parse(approval.createdAt)
  const expiresAt = Date.parse(approval.expiresAt)
  const current = now.getTime()
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)
    || createdAt > current + 60_000 || expiresAt <= createdAt || current > expiresAt
    || current - createdAt > maxAgeMs) {
    throw new ArtifactVerificationError('Approval is stale, expired, or has invalid timestamps.')
  }
  if (!Array.isArray(approval.evidence) || approval.evidence.length === 0) {
    throw new ArtifactVerificationError('Approval must reference reviewer-owned evidence.')
  }
  const names = new Set()
  for (const item of approval.evidence) {
    exactKeys(item, [
      'name', 'path', 'sha256', 'status', 'passed', 'total', 'createdAt',
    ], 'Approval evidence item')
    if (typeof item.name !== 'string' || !item.name || names.has(item.name)
      || item.status !== 'passed' || !Number.isInteger(item.passed)
      || !Number.isInteger(item.total) || item.total <= 0 || item.passed !== item.total
      || !/^[0-9a-f]{64}$/.test(item.sha256 ?? '')) {
      throw new ArtifactVerificationError('Approval evidence status or pass counts are invalid.')
    }
    names.add(item.name)
    const evidenceCreatedAt = Date.parse(item.createdAt)
    if (!Number.isFinite(evidenceCreatedAt) || evidenceCreatedAt > createdAt
      || createdAt - evidenceCreatedAt > maxAgeMs) {
      throw new ArtifactVerificationError(`Approval evidence is stale: ${item.name}.`)
    }
    if (!TANK_EVIDENCE_PREFIXES.some((prefix) => item.path.startsWith(prefix))) {
      throw new ArtifactVerificationError(`Approval evidence is outside Tank-owned paths: ${item.name}.`)
    }
    const evidenceFile = await assertCanonicalCommittedFile(
      root, item.path, approvalCommit, 'Approval evidence',
    )
    if (evidenceFile.sha256 !== item.sha256) {
      throw new ArtifactVerificationError(`Approval evidence hash mismatch: ${item.name}.`)
    }
    let report
    try { report = JSON.parse(evidenceFile.content.toString('utf8')) } catch {
      throw new ArtifactVerificationError(`Approval evidence is not a structured report: ${item.name}.`)
    }
    if (report.kind !== 'karaoke-release-evidence'
      || report.reviewer?.identity !== configured.identity
      || report.reviewer?.role !== configured.role
      || report.verdict !== 'APPROVE'
      || report.status !== item.status
      || report.passed !== item.passed
      || report.total !== item.total
      || report.createdAt !== item.createdAt) {
      throw new ArtifactVerificationError(`Approval evidence claims do not match: ${item.name}.`)
    }
  }
  if (expectedSource && (expectedSource.sha256 !== source.sha256
    || expectedSource.files.length !== source.files.length)) {
    throw new ArtifactVerificationError('Expected source does not match the approved target commit.')
  }
  return {
    absolute,
    approval,
    approvalCommit,
    targetCommit: parent,
    source,
    sha256: approvalFile.sha256,
  }
}

function aggregateSource(entries) {
  const aggregate = createHash('sha256')
  for (const entry of entries) aggregate.update(`${entry.path}\0${entry.sha256}\n`)
  return aggregate.digest('hex')
}

function parseTreeEntries(buffer) {
  const entries = []
  for (const record of buffer.toString('utf8').split('\0').filter(Boolean)) {
    const match = record.match(/^(\d{6}) (blob|tree|commit) ([0-9a-f]{40})\t(.+)$/s)
    if (!match) throw new ArtifactVerificationError('Protected Git tree inventory is invalid.')
    const [, mode, type, objectId, relative] = match
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) {
      throw new ArtifactVerificationError(
        `Protected source is not a tracked regular file: ${relative}.`,
      )
    }
    entries.push({ path: relative, mode, objectId })
  }
  return entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

async function protectedTreeEntries(root, commit) {
  const resolved = await captured('git', ['rev-parse', `${commit}^{commit}`], root)
  if (!/^[0-9a-f]{40}$/.test(resolved)) {
    throw new ArtifactVerificationError('Protected source commit is invalid.')
  }
  const output = await capturedBuffer(
    'git', ['ls-tree', '-r', '-z', resolved, '--', ...PROTECTED_SOURCE_PATHS], root,
  )
  return { commit: resolved, entries: parseTreeEntries(output) }
}

async function assertProtectedWorktree(root, commit, treeEntries) {
  const relativePaths = treeEntries.map((entry) => entry.path)
  assertSafeGitEnvironment()

  const index = await capturedBuffer(
    'git', ['ls-files', '--stage', '-z', '--', ...relativePaths], root,
  )
  const indexEntries = new Map()
  for (const record of index.toString('utf8').split('\0').filter(Boolean)) {
    const match = record.match(/^(\d{6}) ([0-9a-f]{40}) 0\t(.+)$/s)
    if (!match || indexEntries.has(match[3])) {
      throw new ArtifactVerificationError('Protected source index inventory is invalid.')
    }
    indexEntries.set(match[3], { mode: match[1], objectId: match[2] })
  }
  if (indexEntries.size !== treeEntries.length || treeEntries.some((entry) => {
    const indexed = indexEntries.get(entry.path)
    return !indexed || indexed.mode !== entry.mode || indexed.objectId !== entry.objectId
  })) {
    throw new ArtifactVerificationError('Protected source index differs from the committed tree.')
  }

  const effective = await effectiveAttributes(root, relativePaths, 'Protected source')
  const drivers = await configuredFilterDrivers(root)
  const attributeFile = await committedAttributeFile(root, commit)
  const worktree = new Map()
  for (const entry of treeEntries) {
    const committed = parseCommittedAttributePolicy(
      attributeFile, entry.path, `Protected source ${entry.path}`,
    )
    const current = effective.get(entry.path)
    if (!current) {
      throw new ArtifactVerificationError(`Protected source has no Git attributes: ${entry.path}.`)
    }
    for (const attribute of SAFE_COMMITTED_FILE_ATTRIBUTES) {
      if (committed.get(attribute) !== current.get(attribute)) {
        throw new ArtifactVerificationError(
          `Protected source has overridden Git attribute ${attribute}: ${entry.path}.`,
        )
      }
    }
    if (drivers.has(current.get('filter')?.toLowerCase())) {
      throw new ArtifactVerificationError(
        `Protected source has an ambiguous configured Git filter: ${entry.path}.`,
      )
    }
    const blob = await capturedBuffer('git', ['cat-file', 'blob', entry.objectId], root)
    const physical = await readValidatedWorktreeFile(
      root, entry.path, 'Protected source', blob, committed,
    )
    worktree.set(entry.path, {
      worktreeBytes: physical.size,
      worktreeSha256: physical.sha256,
      mtimeMs: physical.mtimeMs,
    })
  }
  return worktree
}

export async function snapshotProtectedSources(root) {
  const head = await captured('git', ['rev-parse', 'HEAD'], root)
  const { entries: treeEntries } = await protectedTreeEntries(root, head)
  const canonical = await snapshotProtectedCommit(root, head)
  const worktree = await assertProtectedWorktree(root, head, treeEntries)
  const entries = canonical.files.map((entry) => ({ ...entry, ...worktree.get(entry.path) }))
  return { files: entries, sha256: aggregateSource(entries) }
}

export async function snapshotProtectedCommit(root, commit) {
  const { entries: treeEntries } = await protectedTreeEntries(root, commit)
  const entries = []
  for (const { path: relative, objectId } of treeEntries) {
    const content = await capturedBuffer('git', ['cat-file', 'blob', objectId], root)
    entries.push({
      path: relative,
      bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    })
  }
  return { files: entries, sha256: aggregateSource(entries) }
}

function compareProtectedSources(provenance, current) {
  const expected = new Map(
    provenance.source.files.map((entry) => [entry.path, entry.sha256]),
  )
  const actual = new Map(current.files.map((entry) => [entry.path, entry.sha256]))
  const missing = [...expected.keys()].filter((entry) => !actual.has(entry))
  const extra = [...actual.keys()].filter((entry) => !expected.has(entry))
  const mismatched = [...expected.keys()].filter((entry) =>
    actual.has(entry) && actual.get(entry) !== expected.get(entry))
  if (missing.length || extra.length || mismatched.length) {
    throw new ArtifactVerificationError(
      `Current package source differs from approved provenance `
      + `(missing=${missing.length}, extra=${extra.length}, mismatched=${mismatched.length}).`,
    )
  }
}

function parseHashFile(contents) {
  const result = new Map()
  for (const line of contents.split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^([0-9a-f]{64})  ([^\\/]+)$/)
    if (!match || result.has(match[2].toLowerCase())) {
      throw new ArtifactVerificationError('SHA256SUMS.txt has invalid or duplicate entries.')
    }
    result.set(match[2].toLowerCase(), match[1])
  }
  return result
}

function verifyProvenanceShape(provenance, version) {
  if (provenance.verdict !== 'APPROVE' || provenance.packageVersion !== version) {
    throw new ArtifactVerificationError('Release provenance is not approved for the current version.')
  }
  if (!Array.isArray(provenance.source?.files)
    || provenance.source.fileCount !== provenance.source.files.length
    || !provenance.source.branch
    || !/^[0-9a-f]{40}$/i.test(provenance.source.head ?? '')
    || aggregateSource(provenance.source.files) !== provenance.source.sha256) {
    throw new ArtifactVerificationError('Release provenance source aggregate is invalid.')
  }
  const comparison = provenance.verification?.sourceComparison
  const liveComparison = provenance.verification?.liveSourceComparison
  const canonicalStaging = provenance.verification?.canonicalStaging
  if (!provenance.verification?.sourceUnchangedDuringRelease
    || comparison?.missing?.length || comparison?.extra?.length || comparison?.mismatched?.length
    || liveComparison?.missing?.length || liveComparison?.extra?.length
    || liveComparison?.mismatched?.length
    || canonicalStaging?.commit !== provenance.source.head
    || canonicalStaging?.sha256 !== provenance.source.sha256
    || canonicalStaging?.fileCount !== provenance.source.fileCount
    || canonicalStaging?.fullTreeFileCount < canonicalStaging?.fileCount
    || !/^[0-9a-f]{64}$/.test(canonicalStaging?.fullTreeSha256 ?? '')
    || canonicalStaging?.dependencyMode
      !== 'fresh-lockfile-npm-ci-isolated-read-only'
    || !/^[0-9a-f]{64}$/.test(canonicalStaging?.dependencies?.sha256 ?? '')
    || !/^[0-9a-f]{64}$/.test(canonicalStaging?.dependencies?.cacheSha256 ?? '')
    || !/^[0-9a-f]{64}$/.test(canonicalStaging?.dependencies?.packageJsonSha256 ?? '')
    || !/^[0-9a-f]{64}$/.test(canonicalStaging?.dependencies?.lockfileSha256 ?? '')
    || canonicalStaging?.dependencies?.fileCount < 1
    || canonicalStaging?.dependencies?.cacheFileCount < 1
    || canonicalStaging?.dependencies?.verifiedAfterPackaging !== true
    || !['windows-acl-read-execute', 'read-only-mode-bits']
      .includes(canonicalStaging?.dependencies?.mutationProtection)
    || !/^\d+\.\d+\.\d+$/.test(canonicalStaging?.dependencies?.npm?.version ?? '')
    || !/^[0-9a-f]{64}$/.test(canonicalStaging?.dependencies?.npm?.cliSha256 ?? '')
    || !/^[0-9a-f]{64}$/.test(
      canonicalStaging?.dependencies?.npm?.nodeExecutableSha256 ?? '',
    )
    || !canonicalStaging?.dependencies?.tools
    || Object.values(canonicalStaging.dependencies.tools).some((tool) =>
      !tool.path?.startsWith('node_modules/')
      || !/^[0-9a-f]{64}$/.test(tool.sha256 ?? ''))
    || canonicalStaging?.cleanedAfterRelease !== true) {
    throw new ArtifactVerificationError('Release provenance reports source differences.')
  }
  const scans = provenance.verification?.secretScans
  if (scans?.verdict !== 'APPROVE' || scans.findings !== 0
    || !Array.isArray(scans.scans) || scans.scans.length === 0
    || scans.scans.some((scan) => scan.findings?.length
      || scan.prohibitedPathFindings !== 0 || scan.credentialContentFindings !== 0)) {
    throw new ArtifactVerificationError('Release provenance does not prove clean secret scans.')
  }
  const manifest = provenance.verification?.appxManifest
  if (manifest?.identity?.version !== `${version}.0`
    || manifest.identity.name !== 'KaraokeStudio'
    || manifest.identity.processorArchitecture !== 'x64'
    || !manifest.microphoneCapability) {
    throw new ArtifactVerificationError('Release provenance has an unexpected APPX identity.')
  }
}

async function verifyActualAppx(appxPath, packageJson, version) {
  if (process.platform !== 'win32') {
    throw new ArtifactVerificationError('Actual APPX identity verification requires Windows.')
  }
  const escaped = appxPath.replaceAll("'", "''")
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem;`
        + `$z=[IO.Compression.ZipFile]::OpenRead('${escaped}');try{`
        + `$e=$z.Entries|Where-Object FullName -eq 'AppxManifest.xml';`
        + `if(!$e){throw 'missing manifest'};`
        + `$r=[IO.StreamReader]::new($e.Open());try{$x=[xml]$r.ReadToEnd()}finally{$r.Dispose()};`
        + `$i=$x.Package.Identity;$a=$x.Package.Applications.Application;`
        + `$mic=[bool]($x.SelectSingleNode(\"//*[local-name()='DeviceCapability' and @Name='microphone']\"));`
        + `[pscustomobject]@{Name=[string]$i.Name;Version=[string]$i.Version;`
        + `Architecture=[string]$i.ProcessorArchitecture;ApplicationId=[string]$a.Id;`
        + `Executable=[string]$a.Executable;EntryPoint=[string]$a.EntryPoint;Microphone=$mic}`
        + `|ConvertTo-Json -Compress}finally{$z.Dispose()}`,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.on('error', reject)
    child.on('close', (code) => code === 0
      ? resolve(output.trim())
      : reject(new ArtifactVerificationError('APPX manifest is unreadable.')))
  })
  let identity
  try { identity = JSON.parse(stdout) } catch {
    throw new ArtifactVerificationError('APPX manifest identity is invalid.')
  }
  if (identity.Name !== packageJson.build?.appx?.identityName
    || identity.Version !== `${version}.0`
    || identity.Architecture !== 'x64'
    || identity.ApplicationId !== packageJson.build?.appx?.applicationId
    || identity.Executable !== `app\\${packageJson.build?.productName}.exe`
    || identity.EntryPoint !== 'Windows.FullTrustApplication'
    || identity.Microphone !== true) {
    throw new ArtifactVerificationError('Actual APPX identity does not match package metadata.')
  }
}

async function verifyAsarOutputs(releaseDir, provenance) {
  const asarPath = path.join(releaseDir, 'win-unpacked', 'resources', 'app.asar')
  await stat(asarPath)
  const listed = new Set(asar.listPackage(asarPath).map((entry) => entry.replaceAll('\\', '/')))
  for (const [relative, expectedHash] of Object.entries(provenance.buildOutputs ?? {})) {
    if (!listed.has(`/${relative}`)) {
      throw new ArtifactVerificationError(`Approved NSIS staging ASAR is missing ${relative}.`)
    }
    const archivePath = process.platform === 'win32' ? relative.replaceAll('/', '\\') : relative
    const actual = createHash('sha256').update(asar.extractFile(asarPath, archivePath)).digest('hex')
    if (actual !== expectedHash) {
      throw new ArtifactVerificationError(`Approved NSIS staging ASAR contains stale ${relative}.`)
    }
  }
  return { asarPath, sha256: await hashFile(asarPath) }
}

export async function verifyApprovedRelease({
  root,
  releaseDir = path.join(root, 'release'),
  requireCurrentSource = true,
}) {
  const { packageJson, version } = await readPackageMetadata(root)
  let provenance
  try {
    provenance = JSON.parse(await readFile(path.join(releaseDir, 'provenance.json'), 'utf8'))
  } catch {
    throw new ArtifactVerificationError('Release provenance is missing or invalid.')
  }
  verifyProvenanceShape(provenance, version)
  if (provenance.approval?.verdict !== 'APPROVE' || !provenance.approval.path
    || !/^[0-9a-f]{64}$/.test(provenance.approval.sha256 ?? '')) {
    throw new ArtifactVerificationError('Release provenance lacks reviewer approval evidence.')
  }
  const currentSource = await snapshotProtectedSources(root)
  const approval = await validateApproval(root, provenance.approval.path, {
    expectedSource: currentSource,
  })
  if (approval.sha256 !== provenance.approval.sha256
    || approval.approval.branch !== provenance.source.branch
    || approval.approval.targetCommit !== provenance.source.head
    || approval.approvalCommit !== provenance.source.approvalCommit
    || approval.approval.source.sha256 !== provenance.source.sha256
    || approval.approval.source.fileCount !== provenance.source.fileCount
    || approval.approval.evidence.reduce((sum, item) => sum + item.passed, 0)
      !== provenance.approval.passed
    || approval.approval.evidence.reduce((sum, item) => sum + item.total, 0)
      !== provenance.approval.total) {
    throw new ArtifactVerificationError('Reviewer approval evidence no longer matches provenance.')
  }
  if (requireCurrentSource) compareProtectedSources(provenance, currentSource)
  const expectedNames = [
    `Karaoke Studio-Setup-${version}.exe`,
    `Karaoke Studio-Setup-${version}.appx`,
  ]
  const artifacts = new Map((provenance.artifacts ?? []).map((item) => [
    path.basename(item.path).toLowerCase(),
    item,
  ]))
  const sums = parseHashFile(await readFile(path.join(releaseDir, 'SHA256SUMS.txt'), 'utf8'))
  const verifiedArtifacts = {}
  for (const name of expectedNames) {
    const recorded = artifacts.get(name.toLowerCase())
    const sum = sums.get(name.toLowerCase())
    if (!recorded || recorded.sha256 !== sum) {
      throw new ArtifactVerificationError(`Provenance/hash identity is missing for ${name}.`)
    }
    const artifactPath = path.join(releaseDir, name)
    const info = await stat(artifactPath)
    const actual = await hashFile(artifactPath)
    if (actual !== recorded.sha256 || info.size !== recorded.bytes) {
      throw new ArtifactVerificationError(`${name} does not match approved provenance.`)
    }
    verifiedArtifacts[path.extname(name).slice(1)] = {
      path: artifactPath,
      name,
      sha256: actual,
      bytes: info.size,
    }
  }
  await verifyActualAppx(verifiedArtifacts.appx.path, packageJson, version)
  const staging = await verifyAsarOutputs(releaseDir, provenance)
  return { packageJson, version, provenance, approval, artifacts: verifiedArtifacts, staging }
}

export function compareSnapshots(before, after) {
  const left = JSON.stringify(before)
  const right = JSON.stringify(after)
  if (left !== right) throw new ArtifactVerificationError('Source changed during the operation.')
}

export async function snapshotTree(rootPath) {
  const output = []
  async function walk(directory, relative = '') {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const childRelative = path.join(relative, entry.name)
      const absolute = path.join(directory, entry.name)
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) {
        throw new ArtifactVerificationError('Reparse points are not allowed in protected data.')
      }
      if (info.isDirectory()) await walk(absolute, childRelative)
      else output.push({
        path: childRelative.replaceAll('\\', '/'),
        bytes: info.size,
        mtimeMs: Math.trunc(info.mtimeMs),
        sha256: await hashFile(absolute),
      })
    }
  }
  await walk(rootPath)
  output.sort((a, b) => a.path.localeCompare(b.path))
  return output
}
