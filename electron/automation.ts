import { createServer } from 'node:net'

export const AUTOMATION_PIPE = process.env.KARAOKE_AUTOMATION_PIPE || '\\\\.\\pipe\\karaoke-studio-control'

export interface AutomationCommand {
  action: string
  value?: unknown
  paths?: string[]
  songs?: unknown[]
  songId?: string
  component?: string
  selector?: string
  uiAction?: 'click' | 'double-click' | 'set-value' | 'snapshot' | 'exists'
  uiValue?: string
  failurePoint?: string
  enabled?: boolean
}

export function isPrivateAutomationEnabled(isPackaged: boolean, argv: string[]) {
  return !isPackaged || argv.includes('--enable-private-automation')
}

export function startAutomationServer(
  handler: (command: AutomationCommand) => Promise<unknown>,
) {
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    const chunks: Buffer[] = []
    let handled = false
    const respond = async () => {
      if (handled) return
      handled = true
      try {
        const command = JSON.parse(Buffer.concat(chunks).toString('utf8').trim()) as AutomationCommand
        const result = await handler(command)
        socket.end(`${JSON.stringify({ ok: true, result }, null, 2)}\n`)
      } catch (error) {
        socket.end(`${JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }, null, 2)}\n`)
      }
    }
    socket.on('data', (chunk) => {
      chunks.push(Buffer.from(chunk))
      if (chunk.includes(0x0a)) void respond()
    })
    socket.on('end', () => void respond())
  })
  server.listen(AUTOMATION_PIPE)
  return server
}
