import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import {
  DEFAULT_APP_SETTINGS,
  applyAppSettingsUpdate,
  readOrCreateAppSettings,
  updateAppSettingsFile,
  writeAppSettings,
  formatRecognitionArgument,
} from '../dist-electron/app-settings.js'

const root = path.resolve('scripts', 'qa-artifacts', `app-settings-${process.pid}`)
let checks = 0
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks += 1
}
const rejects = async (action, pattern, message) => {
  await assert.rejects(action, pattern, message)
  checks += 1
}

await rm(root, { recursive: true, force: true })
await mkdir(root, { recursive: true })

const created = await readOrCreateAppSettings(root)
equal(created, DEFAULT_APP_SETTINGS, 'first read creates English, automatic recognition, and en')
equal(JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8')), DEFAULT_APP_SETTINGS,
  'created settings.json matches the defaults')

const french = await updateAppSettingsFile(root, { uiLocale: 'fr' })
equal(french, {
  schemaVersion: 1,
  uiLocale: 'fr',
  recognitionLanguageMode: 'auto',
  recognitionLanguageCode: 'en',
}, 'a locale update must not change recognition settings or rewrite song data')
equal(formatRecognitionArgument(french), 'auto', 'automatic mode stays auto for future jobs')

const manual = await updateAppSettingsFile(root, {
  recognitionLanguageMode: 'manual',
  recognitionLanguageCode: 'FR',
})
equal(manual.recognitionLanguageCode, 'fr', 'manual recognition codes are canonicalized')
equal(formatRecognitionArgument(manual), 'manual:fr', 'manual recognition is explicit for future jobs')

const libraryPath = path.join(root, 'library.json')
await writeFile(libraryPath, '[{"languageCode":"zh"}]', 'utf8')
await updateAppSettingsFile(root, { recognitionLanguageMode: 'auto' })
equal(await readFile(libraryPath, 'utf8'), '[{"languageCode":"zh"}]',
  'settings updates must not rewrite library language metadata')

await rejects(() => updateAppSettingsFile(root, { uiLocale: 'de' }),
  /Unsupported interface language\./, 'unsupported interface language is rejected')
await rejects(() => updateAppSettingsFile(root, { recognitionLanguageCode: 'xx' }),
  /Unsupported recognition language\./, 'unsupported recognition language is rejected')
await rejects(() => updateAppSettingsFile(root, { recognitionLanguageMode: 'detect' }),
  /Malformed application settings\./, 'malformed recognition mode is rejected')
equal(JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8')).uiLocale, 'fr',
  'rejected updates must not persist')

const malformedPath = path.join(root, 'broken')
await mkdir(malformedPath, { recursive: true })
const malformed = '{"schemaVersion":2,"uiLocale":"en"}\n'
await writeFile(path.join(malformedPath, 'settings.json'), malformed, 'utf8')
await rejects(() => readOrCreateAppSettings(malformedPath), /Malformed application settings\./,
  'malformed settings are rejected instead of being replaced')
equal(await readFile(path.join(malformedPath, 'settings.json'), 'utf8'), malformed,
  'malformed settings.json is left unchanged')

equal(applyAppSettingsUpdate(DEFAULT_APP_SETTINGS, {}).uiLocale, 'en',
  'an empty update preserves every default')

const concurrentRoot = path.join(root, 'concurrent')
await Promise.all(Array.from({ length: 20 }, () => readOrCreateAppSettings(concurrentRoot)))
const target = path.join(concurrentRoot, 'settings.json')
for (let iteration = 0; iteration < 25; iteration += 1) {
  await writeAppSettings(concurrentRoot, DEFAULT_APP_SETTINGS)
  let reads = 0
  const reader = (async () => {
    // A bounded external read burst exercises replacement visibility without
    // holding Windows sharing locks indefinitely and starving every writer.
    for (let sample = 0; sample < 12; sample += 1) {
      const snapshot = JSON.parse(await readFile(target, 'utf8'))
      equal(snapshot.schemaVersion, 1, 'concurrent filesystem readers always see complete JSON')
      reads += 1
      await setTimeout(1)
    }
  })()
  try {
    const updates = await Promise.all([
      updateAppSettingsFile(concurrentRoot, { uiLocale: 'fr' }),
      updateAppSettingsFile(path.join(concurrentRoot, '.'), {
        recognitionLanguageMode: 'manual',
        recognitionLanguageCode: 'ru',
      }),
      readOrCreateAppSettings(concurrentRoot),
    ])
    equal(updates[1], { schemaVersion: 1, uiLocale: 'fr', recognitionLanguageMode: 'manual',
      recognitionLanguageCode: 'ru' }, 'independent concurrent updates compose without losing fields')
  } finally {
    await reader
  }
  assert.ok(reads > 0, 'real reader ran during each update batch')
  equal(await readOrCreateAppSettings(concurrentRoot), {
    schemaVersion: 1, uiLocale: 'fr', recognitionLanguageMode: 'manual', recognitionLanguageCode: 'ru',
  }, 'queued reads never recreate defaults during replacement')
}
equal(await readdir(concurrentRoot), ['settings.json'], 'atomic replacements leave no scratch files')
const restarted = spawnSync(process.execPath, ['--input-type=module', '-e',
  `const { readOrCreateAppSettings } = await import(${JSON.stringify(pathToFileURL(path.resolve('dist-electron', 'app-settings.js')).href)});
   console.log(JSON.stringify(await readOrCreateAppSettings(${JSON.stringify(concurrentRoot)})));`,
], { encoding: 'utf8' })
equal(restarted.status, 0, 'a fresh process can reopen persisted concurrent updates')
equal(JSON.parse(restarted.stdout), await readOrCreateAppSettings(concurrentRoot),
  'restart observes both persisted settings updates')

const brokenJsonRoot = path.join(root, 'broken-json')
await mkdir(brokenJsonRoot)
await writeFile(path.join(brokenJsonRoot, 'settings.json'), '{"partial":', 'utf8')
await rejects(() => updateAppSettingsFile(brokenJsonRoot, { uiLocale: 'fr' }), /not valid JSON/,
  'an update cannot silently reset corrupted settings')
equal(await readFile(path.join(brokenJsonRoot, 'settings.json'), 'utf8'), '{"partial":',
  'corrupted bytes are preserved for recovery')
const failedWriteRoot = path.join(root, 'failed-write')
await mkdir(path.join(failedWriteRoot, 'settings.json'), { recursive: true })
await rejects(() => writeAppSettings(failedWriteRoot, DEFAULT_APP_SETTINGS), /EISDIR|EPERM|EACCES/,
  'a failed atomic replacement surfaces the filesystem error')
equal(await readdir(failedWriteRoot), ['settings.json'], 'a failed rename cleans its unique new file')

await rm(root, { recursive: true, force: true })
console.log(`PASS app settings: ${checks} deterministic checks.`)
