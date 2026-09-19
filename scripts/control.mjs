import { connect } from 'node:net'
import { pathToFileURL } from 'node:url'

export const PIPE = process.env.KARAOKE_AUTOMATION_PIPE || '\\\\.\\pipe\\karaoke-studio-control'

function valueOf(raw) {
  if (raw === undefined) return undefined
  const numeric = Number(raw)
  return Number.isNaN(numeric) ? raw : numeric
}

export function commandFromArgs(argv) {
  const [action = 'status', ...args] = argv

  if (action === 'add') return { action, paths: args }
  if (action === 'process' || action === 'retranscribe' || action === 'remove') {
    return { action, songId: args[0] }
  }
  if (['select', 'mode', 'play', 'pause', 'toggle', 'seek'].includes(action)) {
    return {
      action: 'control',
      value: {
        action,
        value: valueOf(args[0]),
      },
    }
  }
  if (action === 'control') {
    return {
      action,
      value: {
        action: args[0],
        value: valueOf(args[1]),
      },
    }
  }
  return { action }
}

export function sendCommand(command, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(process.env.KARAOKE_AUTOMATION_PIPE || PIPE)
    const chunks = []
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error(`Karaoke Studio did not respond within ${timeoutMs} ms.`))
    }, timeoutMs)

    socket.on('connect', () => socket.write(`${JSON.stringify(command)}\n`))
    socket.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    socket.on('end', () => {
      clearTimeout(timeout)
      try {
        const response = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!response.ok) reject(new Error(response.error || 'Automation command failed.'))
        else resolve(response.result)
      } catch (error) {
        reject(new Error(`Invalid automation response: ${error.message}`))
      }
    })
    socket.on('error', (error) => {
      clearTimeout(timeout)
      reject(new Error(`Unable to connect to Karaoke Studio: ${error.message}`))
    })
  })
}

export function timeoutForCommand(command) {
  return command.action === 'process' || command.action === 'retranscribe'
    ? 3_600_000
    : 30_000
}

async function main() {
  const command = commandFromArgs(process.argv.slice(2))
  const result = await sendCommand(command, {
    timeoutMs: timeoutForCommand(command),
  })
  process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
