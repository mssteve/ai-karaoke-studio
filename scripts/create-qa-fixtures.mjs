import { execFile, spawn } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'

const root = path.resolve(process.argv[2] ?? path.join('scripts', 'qa-artifacts', 'fixtures'))
await mkdir(root, { recursive: true })
const execFileAsync = promisify(execFile)

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegInstaller.path, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let errorText = ''
    child.stderr.on('data', (chunk) => { errorText += chunk })
    child.on('error', reject)
    child.on('close', (code) => code === 0
      ? resolve()
      : reject(new Error(errorText.trim() || `ffmpeg exited with ${code}`)))
  })
}

const mp3 = path.join(root, 'qa-tone.mp3')
const mp4 = path.join(root, 'qa-video.mp4')
const speechWav = path.join(root, 'qa-speech.wav')
const escapedSpeechWav = speechWav.replaceAll("'", "''")
const speechScript = [
  '$ErrorActionPreference = "Stop"',
  '$voice = New-Object -ComObject SAPI.SpVoice',
  '$stream = New-Object -ComObject SAPI.SpFileStream',
  `$stream.Open('${escapedSpeechWav}', 3, $false)`,
  '$voice.AudioOutputStream = $stream',
  '$null = $voice.Speak("Karaoke Studio packaged quality assurance confirms local artificial intelligence processing and synchronized lyrics.")',
  '$stream.Close()',
].join('; ')
const encodedSpeechScript = Buffer.from(speechScript, 'utf16le').toString('base64')
await execFileAsync('powershell.exe', ['-NoProfile', '-EncodedCommand', encodedSpeechScript])
await run([
  '-y', '-i', speechWav,
  '-ar', '44100', '-ac', '2', '-metadata', 'title=QA Speech', '-q:a', '4', mp3,
])
await rm(speechWav, { force: true })
await run([
  '-y', '-f', 'lavfi', '-i', 'color=c=0x24153f:s=640x360:d=3',
  '-f', 'lavfi', '-i', 'sine=frequency=660:duration=3',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', mp4,
])

if (import.meta.url === new URL(import.meta.url).href) {
  process.stdout.write(`${JSON.stringify({ mp3, mp4 }, null, 2)}\n`)
}
