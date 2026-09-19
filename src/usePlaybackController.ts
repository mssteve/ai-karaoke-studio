import { useEffect, useRef, useState } from 'react'
import type { PlaybackStatus, Song } from './types'

export type AudioMode = 'original' | 'enhanced' | 'vocal' | 'instrumental'

interface PlaybackControllerOptions {
  selected?: Song
  mode: AudioMode
  onError: (message: string, reason?: unknown) => void
}

function finiteDuration(audio: HTMLAudioElement) {
  return Number.isFinite(audio.duration) && audio.duration >= 0 ? audio.duration : 0
}

function clampTime(time: number, duration: number) {
  return Math.max(0, duration > 0 ? Math.min(time, duration) : time)
}

export function getModeSource(song: Song, mode: AudioMode) {
  const sources: Record<AudioMode, string | undefined> = {
    original: song.sourceUrl,
    enhanced: song.enhancedUrl,
    vocal: song.vocalUrl,
    instrumental: song.instrumentalUrl,
  }
  return sources[mode]
}

export function usePlaybackController({
  selected,
  mode,
  onError,
}: PlaybackControllerOptions) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const logicalTimeRef = useRef(0)
  const desiredPlayingRef = useRef(false)
  const generationRef = useRef(0)
  const playAttemptRef = useRef(0)
  const capturedPositionRef = useRef<number | undefined>(undefined)
  const manualSeekTargetRef = useRef<number | undefined>(undefined)
  const lastProgressTimeRef = useRef(0)
  const lastProgressAtRef = useRef(Date.now())
  const pendingSeekRef = useRef<{
    generation: number
    target: number
    mutedBefore?: boolean
    issued?: boolean
  } | undefined>(undefined)
  const selectedIdRef = useRef<string | undefined>(undefined)
  const errorHandlerRef = useRef(onError)
  const statusRef = useRef<PlaybackStatus>('idle')
  const eventSequenceRef = useRef(0)
  const mediaTraceRef = useRef<Array<Record<string, unknown>>>([])
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [status, setStatus] = useState<PlaybackStatus>('idle')
  const [loadedSourceKey, setLoadedSourceKey] = useState('')
  const updateStatus = (nextStatus: PlaybackStatus) => {
    statusRef.current = nextStatus
    if (audioRef.current) audioRef.current.dataset.playbackStatus = nextStatus
    setStatus(nextStatus)
  }
  const recordMediaState = (event: string) => {
    const audio = audioRef.current
    if (!audio) return
    const pendingSeek = pendingSeekRef.current
    const entry = {
      sequence: ++eventSequenceRef.current,
      event,
      at: Date.now(),
      currentTime: audio.currentTime,
      duration: audio.duration,
      readyState: audio.readyState,
      networkState: audio.networkState,
      paused: audio.paused,
      ended: audio.ended,
      playingIntent: desiredPlayingRef.current,
      pendingSeek: pendingSeek
        ? { generation: pendingSeek.generation, target: pendingSeek.target, issued: pendingSeek.issued }
        : undefined,
      sourceGeneration: generationRef.current,
      mode,
      status: statusRef.current,
    }
    mediaTraceRef.current = [...mediaTraceRef.current.slice(-39), entry]
    audio.dataset.playbackTrace = JSON.stringify(mediaTraceRef.current)
    audio.dataset.playbackGeneration = String(generationRef.current)
    audio.dataset.playbackIntent = String(desiredPlayingRef.current)
    audio.dataset.playbackPendingSeek = pendingSeek
      ? JSON.stringify({ generation: pendingSeek.generation, target: pendingSeek.target, issued: pendingSeek.issued })
      : ''
    audio.dataset.playbackMode = mode
  }

  useEffect(() => {
    errorHandlerRef.current = onError
  }, [onError])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const source = selected ? getModeSource(selected, mode) : undefined
    const songChanged = selectedIdRef.current !== selected?.id
    selectedIdRef.current = selected?.id
    const generation = ++generationRef.current
    ++playAttemptRef.current
    pendingSeekRef.current = undefined
    const requestedPosition = songChanged
      ? 0
      : capturedPositionRef.current ?? logicalTimeRef.current
    capturedPositionRef.current = undefined
    lastProgressTimeRef.current = 0
    lastProgressAtRef.current = Date.now()
    if (songChanged) {
      logicalTimeRef.current = 0
      setCurrentTime(0)
    }

    const isCurrent = () => generationRef.current === generation
      && audio.dataset.playbackGeneration === String(generation)
      && audio.currentSrc === source

    const updateDuration = () => {
      if (!isCurrent()) return 0
      const nextDuration = finiteDuration(audio)
      setDuration(nextDuration)
      return nextDuration
    }

    let positionApplied = false
    let resumeStarted = false
    let pauseRecoveryFrame: number | undefined
    const restorePendingMute = () => {
      const pendingSeek = pendingSeekRef.current
      if (pendingSeek?.generation !== generation || pendingSeek.mutedBefore === undefined) return
      audio.muted = pendingSeek.mutedBefore
      pendingSeek.mutedBefore = undefined
    }
    const settleEnded = () => {
      if (!isCurrent()) return
      const nextDuration = finiteDuration(audio)
      const endTime = nextDuration || audio.currentTime
      restorePendingMute()
      pendingSeekRef.current = undefined
      manualSeekTargetRef.current = undefined
      desiredPlayingRef.current = false
      ++playAttemptRef.current
      logicalTimeRef.current = endTime
      setCurrentTime(endTime)
      updateStatus('ended')
      recordMediaState('controller:settled-ended')
    }
    const applyPositionOnce = () => {
      if (!isCurrent() || positionApplied) return
      const nextDuration = updateDuration()
      const nextTime = clampTime(manualSeekTargetRef.current ?? requestedPosition, nextDuration)
      if (manualSeekTargetRef.current !== undefined) {
        manualSeekTargetRef.current = nextTime
      }
      positionApplied = true
      pendingSeekRef.current = nextTime > 0.1
        ? { generation, target: nextTime, issued: true }
        : undefined
      audio.currentTime = nextTime
      logicalTimeRef.current = nextTime
      setCurrentTime(nextTime)
      recordMediaState('controller:position-applied')
    }

    const finishPendingSeek = () => {
      const pendingSeek = pendingSeekRef.current
      if (pendingSeek?.generation !== generation) return false
      if (audio.currentTime < pendingSeek.target - 0.1) return false
      pendingSeekRef.current = undefined
      if (pendingSeek.mutedBefore !== undefined) audio.muted = pendingSeek.mutedBefore
      logicalTimeRef.current = audio.currentTime
      setCurrentTime(audio.currentTime)
      if (desiredPlayingRef.current) {
        updateStatus(audio.paused ? 'loading' : 'playing')
        if (audio.paused) {
          void audio.play().catch((reason) => {
            if (!isCurrent() || !desiredPlayingRef.current) return
            desiredPlayingRef.current = false
            updateStatus('error')
            errorHandlerRef.current('Unable to resume playback after seeking', reason)
          })
        }
      } else updateStatus('paused')
      return true
    }

    const requestResume = async () => {
      if (
        !isCurrent()
        || resumeStarted
        || !desiredPlayingRef.current
        || pendingSeekRef.current?.generation === generation
        || audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA
      ) return
      resumeStarted = true
      applyPositionOnce()
      const attempt = playAttemptRef.current
      recordMediaState('controller:resume-requested')
      try {
        await audio.play()
      } catch (reason) {
        if (
          isCurrent()
          && attempt === playAttemptRef.current
          && desiredPlayingRef.current
        ) {
          const pendingSeek = pendingSeekRef.current
          if (pendingSeek?.generation === generation && pendingSeek.mutedBefore !== undefined) {
            audio.muted = pendingSeek.mutedBefore
          }
          desiredPlayingRef.current = false
          updateStatus('error')
          errorHandlerRef.current('Unable to start playback', reason)
        }
      }
    }

    const onLoadedMetadata = () => {
      recordMediaState('media:loadedmetadata')
      updateDuration()
    }
    const onCanPlay = () => {
      recordMediaState('media:canplay')
      if (!isCurrent()) return
      applyPositionOnce()
      setLoadedSourceKey(`${selected?.id ?? ''}:${mode}`)
      if (desiredPlayingRef.current) {
        void requestResume()
      } else {
        updateStatus('paused')
      }
    }
    const onDurationChange = () => {
      recordMediaState('media:durationchange')
      const nextDuration = updateDuration()
      if (!positionApplied || !isCurrent()) return
      const nextTime = clampTime(logicalTimeRef.current, nextDuration)
      if (nextTime !== logicalTimeRef.current) {
        audio.currentTime = nextTime
        logicalTimeRef.current = nextTime
        setCurrentTime(nextTime)
      }
      if (manualSeekTargetRef.current !== undefined) {
        manualSeekTargetRef.current = nextTime
      }
      const pendingSeek = pendingSeekRef.current
      if (pendingSeek?.generation === generation && pendingSeek.target !== nextTime) {
        pendingSeek.target = nextTime
      }
    }
    const onTimeUpdate = () => {
      recordMediaState('media:timeupdate')
      if (!isCurrent() || !Number.isFinite(audio.currentTime)) return
      const pendingSeek = pendingSeekRef.current
      if (pendingSeek?.generation === generation) {
        if (!finishPendingSeek()) return
        return
      }
      logicalTimeRef.current = audio.currentTime
      setCurrentTime(audio.currentTime)
      if (Math.abs(audio.currentTime - lastProgressTimeRef.current) >= 0.01) {
        lastProgressTimeRef.current = audio.currentTime
        lastProgressAtRef.current = Date.now()
      }
      const manualTarget = manualSeekTargetRef.current
      if (manualTarget !== undefined && audio.currentTime > manualTarget + 0.2) {
        manualSeekTargetRef.current = undefined
      }
    }
    const onSeeked = () => {
      recordMediaState('media:seeked')
      if (!isCurrent()) return
      const pendingSeek = pendingSeekRef.current
      if (pendingSeek?.generation !== generation) return
      if (audio.currentTime < pendingSeek.target - 0.1) {
        return
      }
      finishPendingSeek()
    }
    const onPlay = () => {
      recordMediaState('media:play')
      if (
        isCurrent()
        && desiredPlayingRef.current
        && pendingSeekRef.current?.generation !== generation
      ) updateStatus('playing')
    }
    const onPlaying = () => {
      recordMediaState('media:playing')
      if (!isCurrent()) return
      if (desiredPlayingRef.current) updateStatus('playing')
    }
    const onPause = () => {
      recordMediaState('media:pause')
      if (!isCurrent()) return
      if (desiredPlayingRef.current) {
        const nextDuration = finiteDuration(audio)
        if (audio.ended || (nextDuration > 0 && audio.currentTime >= nextDuration - 0.05)) {
          settleEnded()
          return
        }
        if (pauseRecoveryFrame !== undefined) cancelAnimationFrame(pauseRecoveryFrame)
        pauseRecoveryFrame = requestAnimationFrame(() => {
          pauseRecoveryFrame = undefined
          if (!isCurrent() || !desiredPlayingRef.current || !audio.paused || audio.ended) return
          const attempt = playAttemptRef.current
          void audio.play().catch((reason) => {
            if (!isCurrent() || !desiredPlayingRef.current || attempt !== playAttemptRef.current) return
            restorePendingMute()
            desiredPlayingRef.current = false
            updateStatus('error')
            errorHandlerRef.current('Unable to continue playback', reason)
          })
        })
        return
      }
      if (pendingSeekRef.current?.generation === generation) return
      if (statusRef.current !== 'ended' && statusRef.current !== 'error') updateStatus('paused')
    }
    const onEnded = () => {
      recordMediaState('media:ended')
      settleEnded()
    }
    const onError = () => {
      recordMediaState('media:error')
      if (!isCurrent()) return
      const pendingSeek = pendingSeekRef.current
      if (pendingSeek?.generation === generation && pendingSeek.mutedBefore !== undefined) {
        audio.muted = pendingSeek.mutedBefore
      }
      desiredPlayingRef.current = false
      ++playAttemptRef.current
      updateStatus('error')
      const mediaError = audio.error
      errorHandlerRef.current(
        'Unable to load this audio version',
        mediaError ? `Media error ${mediaError.code}: ${mediaError.message}` : 'Unknown media error',
      )
    }

    const listeners: Array<[keyof HTMLMediaElementEventMap, EventListener]> = [
      ['loadedmetadata', onLoadedMetadata],
      ['canplay', onCanPlay],
      ['durationchange', onDurationChange],
      ['timeupdate', onTimeUpdate],
      ['seeked', onSeeked],
      ['play', onPlay],
      ['playing', onPlaying],
      ['pause', onPause],
      ['ended', onEnded],
      ['error', onError],
    ]
    for (const [name, listener] of listeners) audio.addEventListener(name, listener)
    const endWatchdog = window.setInterval(() => {
      if (!isCurrent() || !desiredPlayingRef.current) return
      const nextDuration = finiteDuration(audio)
      if (nextDuration <= 0) return
      const remaining = nextDuration - audio.currentTime
      if (audio.ended || remaining <= 0.05) {
        settleEnded()
        return
      }
      if (
        remaining <= 0.5
        && Date.now() - lastProgressAtRef.current >= 1200
      ) {
        audio.currentTime = nextDuration
        settleEnded()
      }
    }, 250)

    audio.pause()
    audio.dataset.playbackGeneration = String(generation)
    recordMediaState('controller:source-replacement')
    setDuration(0)
    if (!source) {
      audio.removeAttribute('src')
      audio.load()
      updateStatus(selected ? 'error' : 'idle')
      if (selected) errorHandlerRef.current(`The requested audio version is not available`)
    } else {
      updateStatus('loading')
      audio.src = source
      audio.load()
    }

    return () => {
      if (pauseRecoveryFrame !== undefined) cancelAnimationFrame(pauseRecoveryFrame)
      window.clearInterval(endWatchdog)
      const pendingSeek = pendingSeekRef.current
      if (pendingSeek?.generation === generation && pendingSeek.mutedBefore !== undefined) {
        audio.muted = pendingSeek.mutedBefore
      }
      for (const [name, listener] of listeners) audio.removeEventListener(name, listener)
    }
  }, [
    mode,
    selected?.id,
    selected?.sourceUrl,
    selected?.enhancedUrl,
    selected?.vocalUrl,
    selected?.instrumentalUrl,
  ])

  function capturePosition(authoritativeTime?: number) {
    if (authoritativeTime !== undefined && Number.isFinite(authoritativeTime)) {
      logicalTimeRef.current = authoritativeTime
      setCurrentTime(authoritativeTime)
      capturedPositionRef.current = authoritativeTime
      return
    }
    const audio = audioRef.current
    const pendingSeek = pendingSeekRef.current
    if (pendingSeek?.generation === generationRef.current) {
      logicalTimeRef.current = pendingSeek.target
      setCurrentTime(pendingSeek.target)
      capturedPositionRef.current = pendingSeek.target
      return
    }
    if (
      audio
      && audio.readyState > HTMLMediaElement.HAVE_NOTHING
      && Number.isFinite(audio.currentTime)
    ) {
      logicalTimeRef.current = audio.currentTime
      setCurrentTime(audio.currentTime)
      capturedPositionRef.current = audio.currentTime
    }
  }

  function resetForSong() {
    ++playAttemptRef.current
    logicalTimeRef.current = 0
    capturedPositionRef.current = undefined
    setCurrentTime(0)
    setDuration(0)
    manualSeekTargetRef.current = undefined
  }

  function seekTo(requestedTime: number) {
    if (!Number.isFinite(requestedTime)) return
    const audio = audioRef.current
    const maximum = audio ? finiteDuration(audio) : duration
    const nextTime = clampTime(requestedTime, maximum)
    manualSeekTargetRef.current = nextTime
    logicalTimeRef.current = nextTime
    setCurrentTime(nextTime)
    if (audio && audio.readyState > HTMLMediaElement.HAVE_NOTHING) {
      const generation = generationRef.current
      pendingSeekRef.current = nextTime > 0.1
        ? { generation, target: nextTime, issued: true }
        : undefined
      audio.currentTime = nextTime
      if (audio.paused && !desiredPlayingRef.current) updateStatus('paused')
    }
    recordMediaState('controller:seek')
    if (statusRef.current === 'ended' && nextTime < maximum) {
      updateStatus(desiredPlayingRef.current ? 'playing' : 'paused')
    }
  }

  async function play() {
    const audio = audioRef.current
    if (!audio || !selected) return
    desiredPlayingRef.current = true
    lastProgressTimeRef.current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0
    lastProgressAtRef.current = Date.now()
    const generation = generationRef.current
    const attempt = ++playAttemptRef.current
    recordMediaState('controller:play')

    if (statusRef.current === 'ended') {
      seekTo(0)
    }
    const pendingSeek = pendingSeekRef.current
    if (pendingSeek?.generation === generation) {
      updateStatus('loading')
      recordMediaState('controller:play-awaiting-seek')
      return
    }
    if (audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) updateStatus('loading')
    try {
      await audio.play()
    } catch (reason) {
      if (
        generation === generationRef.current
        && attempt === playAttemptRef.current
        && desiredPlayingRef.current
      ) {
        const pendingSeek = pendingSeekRef.current
        if (pendingSeek?.generation === generation && pendingSeek.mutedBefore !== undefined) {
          audio.muted = pendingSeek.mutedBefore
        }
        desiredPlayingRef.current = false
        updateStatus('error')
        errorHandlerRef.current('Unable to start playback', reason)
      }
    }
  }

  function pause() {
    const audio = audioRef.current
    desiredPlayingRef.current = false
    ++playAttemptRef.current
    capturePosition()
    const pendingSeek = pendingSeekRef.current
    if (
      audio
      && pendingSeek?.generation === generationRef.current
      && pendingSeek.mutedBefore !== undefined
    ) {
      audio.muted = pendingSeek.mutedBefore
      pendingSeek.mutedBefore = undefined
      pendingSeek.issued = false
    }
    audio?.pause()
    if (selected && statusRef.current !== 'ended' && statusRef.current !== 'error') updateStatus('paused')
    recordMediaState('controller:pause')
  }

  function toggle() {
    if (desiredPlayingRef.current) pause()
    else void play()
  }

  return {
    audioRef,
    currentTime,
    duration,
    status,
    loadedSourceKey,
    isPlaying: status === 'playing',
    desiredPlayingRef,
    capturePosition,
    resetForSong,
    seekTo,
    play,
    pause,
    toggle,
  }
}
