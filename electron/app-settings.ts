import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { replaceTextFile } from './atomic-file.js'
import type { AppSettings, UpdateAppSettingsRequest, UiLocale } from './types.js'

export const DEFAULT_APP_SETTINGS: AppSettings = {
  schemaVersion: 1,
  uiLocale: 'en',
  recognitionLanguageMode: 'auto',
  recognitionLanguageCode: 'en',
}

const UI_LOCALES = new Set<UiLocale>(['en', 'fr'])

/** Whisper language codes accepted by onnx-community/whisper-small lang_to_id. */
export const WHISPER_RECOGNITION_LANGUAGE_CODES = [
  'en', 'zh', 'de', 'es', 'ru', 'ko', 'fr', 'ja', 'pt', 'tr', 'pl', 'ca', 'nl', 'ar', 'sv', 'it',
  'id', 'hi', 'fi', 'vi', 'he', 'uk', 'el', 'ms', 'cs', 'ro', 'da', 'hu', 'ta', 'no', 'th', 'ur',
  'hr', 'bg', 'lt', 'la', 'mi', 'ml', 'cy', 'sk', 'te', 'fa', 'lv', 'bn', 'sr', 'az', 'sl', 'kn',
  'et', 'mk', 'br', 'eu', 'is', 'hy', 'ne', 'mn', 'bs', 'kk', 'sq', 'sw', 'gl', 'mr', 'pa', 'si',
  'km', 'sn', 'yo', 'so', 'af', 'oc', 'ka', 'be', 'tg', 'sd', 'gu', 'am', 'yi', 'lo', 'uz', 'fo',
  'ht', 'ps', 'tk', 'nn', 'mt', 'sa', 'lb', 'my', 'bo', 'tl', 'mg', 'as', 'tt', 'haw', 'ln', 'ha',
  'ba', 'jw', 'su',
] as const

const recognitionLanguages = new Set<string>(WHISPER_RECOGNITION_LANGUAGE_CODES)
const settingKeys = new Set([
  'schemaVersion',
  'uiLocale',
  'recognitionLanguageMode',
  'recognitionLanguageCode',
])
const updateKeys = new Set(['uiLocale', 'recognitionLanguageMode', 'recognitionLanguageCode'])
const settingsOperations = new Map<string, Promise<unknown>>()

function serializeSettings<T>(userDataDir: string, operation: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(appSettingsPath(userDataDir))
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  const previous = settingsOperations.get(key) ?? Promise.resolve()
  const result = previous.then(operation, operation)
  settingsOperations.set(key, result)
  const cleanup = () => {
    if (settingsOperations.get(key) === result) settingsOperations.delete(key)
  }
  void result.then(cleanup, cleanup)
  return result
}

export function appSettingsPath(userDataDir: string) {
  return path.join(userDataDir, 'settings.json')
}

export function isSupportedRecognitionLanguage(value: string) {
  return recognitionLanguages.has(value.trim().toLowerCase())
}

export function canonicalRecognitionLanguage(value: unknown) {
  if (typeof value !== 'string' || !isSupportedRecognitionLanguage(value)) {
    throw new Error('Unsupported recognition language.')
  }
  return value.trim().toLowerCase()
}

export function canonicalUiLocale(value: unknown): UiLocale {
  if (typeof value !== 'string' || !UI_LOCALES.has(value as UiLocale)) {
    throw new Error('Unsupported interface language.')
  }
  return value as UiLocale
}

function malformed(detail: string): never {
  throw new Error(`Malformed application settings. ${detail}`)
}

export function validateAppSettings(value: unknown): AppSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) malformed('Expected an object.')
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!settingKeys.has(key)) malformed(`Unexpected field ${key}.`)
  }
  if (record.schemaVersion !== 1) malformed('schemaVersion must be 1.')
  if (record.recognitionLanguageMode !== 'auto' && record.recognitionLanguageMode !== 'manual') {
    malformed('recognitionLanguageMode must be auto or manual.')
  }
  return {
    schemaVersion: 1,
    uiLocale: canonicalUiLocale(record.uiLocale),
    recognitionLanguageMode: record.recognitionLanguageMode,
    recognitionLanguageCode: canonicalRecognitionLanguage(record.recognitionLanguageCode),
  }
}

export function applyAppSettingsUpdate(current: AppSettings, request: unknown): AppSettings {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    malformed('Settings update must be an object.')
  }
  const record = request as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!updateKeys.has(key)) malformed(`Unexpected update field ${key}.`)
  }
  const next: AppSettings = { ...current }
  if ('uiLocale' in record) next.uiLocale = canonicalUiLocale(record.uiLocale)
  if ('recognitionLanguageMode' in record) {
    if (record.recognitionLanguageMode !== 'auto' && record.recognitionLanguageMode !== 'manual') {
      malformed('recognitionLanguageMode must be auto or manual.')
    }
    next.recognitionLanguageMode = record.recognitionLanguageMode
  }
  if ('recognitionLanguageCode' in record) {
    next.recognitionLanguageCode = canonicalRecognitionLanguage(record.recognitionLanguageCode)
  }
  return validateAppSettings(next)
}

async function readSettings(userDataDir: string): Promise<AppSettings> {
  const target = appSettingsPath(userDataDir)
  let raw: string
  try {
    raw = await readFile(target, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const created = { ...DEFAULT_APP_SETTINGS }
    await replaceTextFile(target, `${JSON.stringify(created, null, 2)}\n`)
    return created
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    malformed('settings.json is not valid JSON.')
  }
  return validateAppSettings(parsed)
}

async function writeSettings(userDataDir: string, settings: AppSettings) {
  const validated = validateAppSettings(settings)
  await replaceTextFile(appSettingsPath(userDataDir), `${JSON.stringify(validated, null, 2)}\n`)
  return validated
}

export function readOrCreateAppSettings(userDataDir: string): Promise<AppSettings> {
  return serializeSettings(userDataDir, () => readSettings(userDataDir))
}

export function writeAppSettings(userDataDir: string, settings: AppSettings) {
  return serializeSettings(userDataDir, () => writeSettings(userDataDir, settings))
}

export async function updateAppSettingsFile(userDataDir: string, request: UpdateAppSettingsRequest | unknown) {
  return serializeSettings(userDataDir, async () => {
    const current = await readSettings(userDataDir)
    const next = applyAppSettingsUpdate(current, request)
    return writeSettings(userDataDir, next)
  })
}

export function formatRecognitionArgument(settings: AppSettings) {
  const validated = validateAppSettings(settings)
  return validated.recognitionLanguageMode === 'manual'
    ? `manual:${validated.recognitionLanguageCode}`
    : 'auto'
}

export function parseRecognitionArgument(value: string | undefined) {
  if (value === undefined || value === '' || value === 'auto') {
    return { mode: 'auto' as const }
  }
  if (value.startsWith('manual:')) {
    const languageCode = canonicalRecognitionLanguage(value.slice('manual:'.length))
    return { mode: 'manual' as const, languageCode }
  }
  throw new Error('Unsupported recognition language.')
}
