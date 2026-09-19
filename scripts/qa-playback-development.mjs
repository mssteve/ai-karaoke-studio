import { setTimeout as delay } from 'node:timers/promises'
import { sendCommand } from './control.mjs'

const modes = ['original', 'enhanced', 'vocal', 'instrumental']

async function waitFor(check, description, timeoutMs = 15_000) {
  const started = Date.now()
  let latest
  while (Date.now() - started < timeoutMs) {
    latest = await check()
    if (latest) return latest
    await delay(50)
  }
  throw new Error(`${description} was not observed. Latest state: ${JSON.stringify(latest)}`)
}

async function status() {
  return sendCommand({ action: 'status' })
}

async function playback() {
  return (await status()).playback
}

async function control(action, value) {
  await sendCommand({ action: 'control', value: { action, value } })
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const initial = await status()
const songs = initial.songs.filter((song) => modes.every((mode) => song.versions[mode]))
assert(songs.length >= 2, 'Two fully processed songs are required.')

const evidence = []
for (const [index, song] of songs.slice(0, 2).entries()) {
  await control('pause')
  const beforeSelection = await playback()
  if (beforeSelection?.songId === song.id) {
    const alternate = songs.find((candidate) => candidate.id !== song.id)
    if (alternate) {
      await control('select', alternate.id)
      await waitFor(async () => (await playback())?.songId === alternate.id, `${alternate.title} setup selection`)
    }
  }
  await control('select', song.id)
  let state = await waitFor(
    async () => {
      const candidate = await playback()
      return candidate?.songId === song.id && candidate.status === 'paused' && candidate.duration > 0
        ? candidate
        : undefined
    },
    `${song.title} selection`,
  )
  assert(state.currentTime <= 0.1, `${song.title} did not start at zero.`)

  await control('seek', 60)
  state = await waitFor(
    async () => {
      const candidate = await playback()
      return Math.abs(candidate?.currentTime - 60) <= 0.15 ? candidate : undefined
    },
    `${song.title} seek`,
  )
  assert(state.activeLyricIndex >= 0, `${song.title} did not expose an active timed lyric after seek.`)
  const activeLyric = {
    index: state.activeLyricIndex,
    start: state.activeLyricStart,
    text: state.activeLyricText,
  }

  const pausedModes = []
  for (const mode of modes) {
    const before = (await playback()).currentTime
    await control('mode', mode)
    state = await waitFor(
      async () => {
        const candidate = await playback()
        return candidate?.mode === mode && candidate.status === 'paused' && candidate.duration > 0
          ? candidate
          : undefined
      },
      `${song.title} paused ${mode} switch`,
    )
    assert(Math.abs(state.currentTime - before) <= 0.15, `${song.title} ${mode} paused switch moved position.`)
    pausedModes.push({ mode, time: state.currentTime, duration: state.duration })
  }

  await control('play')
  state = await waitFor(
    async () => {
      const candidate = await playback()
      return candidate?.status === 'playing' && candidate.currentTime > 60.2 ? candidate : undefined
    },
    `${song.title} playback progress`,
  )

  const playingModes = []
  for (const mode of modes) {
    const before = (await playback()).currentTime
    await control('mode', mode)
    state = await waitFor(
      async () => {
        const candidate = await playback()
        return candidate?.mode === mode && candidate.status === 'playing' ? candidate : undefined
      },
      `${song.title} playing ${mode} switch`,
    )
    assert(
      state.currentTime >= before - 0.15 && state.currentTime <= before + 1.5,
      `${song.title} ${mode} playing switch lost timeline continuity.`,
    )
    playingModes.push({ mode, before, after: state.currentTime, duration: state.duration })
  }

  for (const mode of [...modes, 'vocal']) await control('mode', mode)
  state = await waitFor(
    async () => {
      const candidate = await playback()
      return candidate?.mode === 'vocal' && candidate.status === 'playing' ? candidate : undefined
    },
    `${song.title} rapid final mode`,
  )

  await control('pause')
  const pausedAt = (await waitFor(
    async () => (await playback())?.status === 'paused' ? playback() : undefined,
    `${song.title} pause`,
  )).currentTime
  await delay(400)
  state = await playback()
  assert(Math.abs(state.currentTime - pausedAt) <= 0.05, `${song.title} pause did not hold position.`)

  await control('seek', Math.max(0, state.duration - 0.2))
  await control('play')
  state = await waitFor(
    async () => {
      const candidate = await playback()
      return candidate?.status === 'ended' ? candidate : undefined
    },
    `${song.title} ended state`,
  )
  assert(Math.abs(state.currentTime - state.duration) <= 0.15, `${song.title} ended at the wrong position.`)
  assert(!state.error, `${song.title} surfaced a renderer error: ${state.error}`)

  evidence.push({
    songId: song.id,
    title: song.title,
    selectedAtZero: true,
    activeLyric,
    pausedModes,
    playingModes,
    ended: { currentTime: state.currentTime, duration: state.duration },
    sequence: index + 1,
  })
}

console.log(JSON.stringify({ verdict: 'PASS', songs: evidence }, null, 2))
