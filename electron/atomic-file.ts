import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout } from 'node:timers/promises'

export async function replaceTextFile(targetPath: string, contents: string) {
  await mkdir(path.dirname(targetPath), { recursive: true })
  const temporary = `${targetPath}.${process.pid}.${randomUUID()}.new`
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx' })
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, targetPath)
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (attempt >= 7 || !['EBUSY', 'EPERM', 'EACCES'].includes(code ?? '')) throw error
        // Windows readers and antivirus may briefly deny replacement; never unlink
        // the complete old file or expose a missing target while waiting.
        await setTimeout(Math.min(160, 10 * 2 ** attempt))
      }
    }
  } catch (error) {
    try {
      await rm(temporary, { force: true })
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError],
        `Atomic file save and cleanup failed: ${String(error)}; ${String(cleanupError)}`)
    }
    throw error
  }
}
