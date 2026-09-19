import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const requiredOutputs = [
  'dist/index.html',
  'dist-electron/main.js',
  'dist-electron/preload.cjs',
  'dist-electron/transcribe.js',
  'dist-electron/transcription-timing.js',
  'dist-electron/demucs-runner.js',
  'dist-electron/demucs-inference.js',
]

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
      windowsHide: false,
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (signal) reject(new Error(`${command} was terminated by ${signal}.`))
      else if (code !== 0) reject(new Error(`${command} exited with code ${code}.`))
      else resolve()
    })
  })
}

async function verifyOutputs() {
  const missing = []
  for (const relative of requiredOutputs) {
    try {
      await access(path.join(root, ...relative.split('/')))
    } catch {
      missing.push(relative.replaceAll('/', '\\'))
    }
  }
  if (missing.length) {
    throw new Error(
      `Local build completed without required output:\n- ${missing.join('\n- ')}`,
    )
  }
}

async function main() {
  console.log('Building current renderer and Electron sources before local launch...')
  await run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm run build'])
  await verifyOutputs()

  const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  await access(electron).catch(() => {
    throw new Error(`Electron executable is missing: ${electron}. Run npm install first.`)
  })

  await run(electron, [
    path.join(root, 'dist-electron', 'main.js'),
    ...process.argv.slice(2),
  ])
}

main().catch((error) => {
  console.error(`Local launch failed: ${error.message}`)
  process.exitCode = 1
})
