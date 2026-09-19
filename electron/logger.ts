import { app } from 'electron'
import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const MAX_LOG_BYTES = 2 * 1024 * 1024
let writeQueue = Promise.resolve()

export function getDiagnosticsPath() {
  return path.join(app.getPath('userData'), 'logs')
}

function serialize(detail: unknown) {
  if (detail instanceof Error) {
    return detail.stack ?? `${detail.name}: ${detail.message}`
  }
  if (typeof detail === 'string') return detail
  try {
    return JSON.stringify(detail)
  } catch {
    return String(detail)
  }
}

export function logDiagnostic(level: 'INFO' | 'WARN' | 'ERROR', message: string, detail?: unknown) {
  writeQueue = writeQueue.then(async () => {
    const directory = getDiagnosticsPath()
    const logPath = path.join(directory, 'karaoke-studio.log')
    await mkdir(directory, { recursive: true })
    try {
      const info = await stat(logPath)
      if (info.size >= MAX_LOG_BYTES) {
        await writeFile(logPath, `${new Date().toISOString()} INFO Log rotated.\n`, 'utf8')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const suffix = detail === undefined ? '' : `\n${serialize(detail).slice(0, 12000)}`
    await appendFile(logPath, `${new Date().toISOString()} ${level} ${message}${suffix}\n`, 'utf8')
  }).catch((error) => {
    console.error('Unable to write diagnostics log:', error)
  })
}
