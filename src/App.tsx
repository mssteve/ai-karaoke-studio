import {
  AudioLines,
  Bug,
  Check,
  ChevronRight,
  Clock3,
  Disc3,
  FolderOpen,
  HardDrive,
  Library,
  ListMusic,
  LoaderCircle,
  Mic2,
  Music2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Plus,
  Search,
  SlidersHorizontal,
  Pencil,
  Sparkles,
  Trash2,
  Volume2,
  WandSparkles,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { karaokeApi } from './api'
import type {
  AppSettings,
  Playlist,
  PlaylistEntry,
  PlaylistStore,
  PlaylistTransitionReason,
  ProcessUpdate,
  ProcessingComponentId,
  ProcessingItem,
  ProcessingItemId,
  RecognitionLanguageMode,
  Song,
  UpdateAppSettingsRequest,
} from './types'
import {
  defaultAppSettings,
  editorTextFromSong,
  editorTextFromInput,
  replaceEditorSelection,
  hasUsableLyricLines,
  isRecognitionLanguageMode,
  localeTag,
  lyricsBusyMessage,
  lyricsEditorStatusMessage,
  lyricsRematchMessage,
  lyricsTextSourceLabel,
  normalizeAppSettings,
  playlistDisplayName,
  recognitionLanguageOptions,
  reduceLyricsEditor,
  translate,
  translateJoined,
  type LyricsEditorDraft,
  type LyricsEditorSongSnapshot,
} from './i18n'
import { mergeProcessUpdate, processingItemDetail, processingStatusLabels } from './processingUi'
import {
  claimRetry,
  componentLabels,
  deliverableIssues,
  enhancedSummary,
  lyricsTimingSummary,
  modeAvailability,
  retryActivity,
  retryKey,
} from './processingUx'
import { getModeSource, usePlaybackController, type AudioMode } from './usePlaybackController'
import { useMicrophoneMonitor } from './useMicrophoneMonitor'
import {
  ECHO_AMOUNT_STEP,
  MAX_ECHO_AMOUNT,
  MAX_MONITOR_GAIN,
  MIN_MONITOR_GAIN,
  MONITOR_GAIN_STEP,
  monitorGainDecibels,
} from './microphoneMonitor'

const modeLabels: Record<AudioMode, string> = {
  original: 'Original',
  enhanced: 'Enhanced',
  vocal: 'Vocal',
  instrumental: 'Instrumental',
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return '0:00'
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`
}

function levelDecibels(level?: number) {
  if (!level || level <= 0) return '−∞ dBFS'
  return `${(20 * Math.log10(level)).toFixed(1)} dBFS`
}

const processingGroups: Array<{ id: ProcessingItemId; children?: ProcessingItemId[] }> = [
  { id: 'source-preparation' },
  { id: 'demucs', children: ['stem-vocals', 'stem-drums', 'stem-bass', 'stem-other'] },
  { id: 'original' },
  { id: 'instrumental' },
  { id: 'vocal' },
  { id: 'enhanced' },
  { id: 'whisper-model', children: ['whisper-transcription'] },
  { id: 'lyrics' },
]

function ProcessingStatusIcon({ item }: { item: ProcessingItem }) {
  if (item.status === 'complete') return <Check size={12} aria-hidden="true" />
  if (item.status === 'active' || item.status === 'indeterminate') {
    return <LoaderCircle className="spin" size={12} aria-hidden="true" />
  }
  if (item.status === 'error') return <X size={12} aria-hidden="true" />
  return <Clock3 size={12} aria-hidden="true" />
}

function App() {
  const [songs, setSongs] = useState<Song[]>([])
  const [playlists, setPlaylists] = useState<PlaylistStore>({ schemaVersion: 1, playlists: [] })
  const [selectedId, setSelectedId] = useState<string>()
  const [view, setView] = useState<'library' | 'playlists'>('library')
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<AudioMode>('original')
  const [volume, setVolume] = useState(0.82)
  const [error, setError] = useState<{
    message: string
    detail?: string
    playlist?: Pick<Playlist, 'kind' | 'name'>
  }>()
  const [notice, setNotice] = useState<string | { addedToPlaylist: Pick<Playlist, 'kind' | 'name'> }>()
  const [isLoading, setIsLoading] = useState(true)
  const [isImporting, setIsImporting] = useState(false)
  const [menuSongId, setMenuSongId] = useState<string>()
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number; maxHeight: number }>()
  const [createForSongId, setCreateForSongId] = useState<string>()
  const [showCreatePlaylist, setShowCreatePlaylist] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [showRenamePlaylist, setShowRenamePlaylist] = useState(false)
  const [renameName, setRenameName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [playlistName, setPlaylistName] = useState('')
  const [activePlaylistId, setActivePlaylistId] = useState<string>()
  const [activeEntryId, setActiveEntryId] = useState<string>()
  const [transitionReason, setTransitionReason] = useState<PlaylistTransitionReason>('restore')
  const [transitionCount, setTransitionCount] = useState(0)
  const [selectionGeneration, setSelectionGeneration] = useState(0)
  const [pendingAutoPlay, setPendingAutoPlay] = useState(false)
  const [pendingRetries, setPendingRetries] = useState<string[]>([])
  const [detachedNext, setDetachedNext] = useState<{ playlistId: string; entryId: string }>()
  const [settings, setSettings] = useState<AppSettings>(defaultAppSettings)
  const [settingsReady, setSettingsReady] = useState(false)
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [lyricsEditor, setLyricsEditor] = useState<LyricsEditorDraft | null>(null)
  const songsRef = useRef<Song[]>([])
  const playlistsRef = useRef(playlists)
  const playlistOperationRef = useRef<Promise<unknown>>(Promise.resolve())
  const settingsRef = useRef(settings)
  const confirmedSettingsRef = useRef(settings)
  const settingsReadyRef = useRef(false)
  const settingsBusyCountRef = useRef(0)
  const lyricsSaveSeq = useRef(0)
  const latestLyricsSaveRef = useRef(new Map<string, number>())
  const lyricsPasteRef = useRef<{
    songId: string
    previousText: string
    text: string
    expectedInput: string
  } | null>(null)
  const lyricsEditorDialogRef = useRef<HTMLDivElement>(null)
  const editLyricsButtonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const lyricRefs = useRef<Array<HTMLButtonElement | null>>([])
  const handledEndRef = useRef<string | undefined>(undefined)
  const playlistActivationRef = useRef(0)
  const playlistActivationTargetRef = useRef<{ playlistId: string; entryId: string } | undefined>(undefined)
  const pendingPlaylistCursorRef = useRef<{
    playlistId: string
    entryId: string
    promise: Promise<PlaylistStore>
  } | undefined>(undefined)
  const pendingQueueArchiveRef = useRef<{
    playlistId: string
    entryId: string
    promise: Promise<PlaylistStore>
  } | undefined>(undefined)
  const pendingRetryKeysRef = useRef(new Set<string>())
  const microphoneWarningShownRef = useRef(false)
  const t = (message: string) => translate(settings.uiLocale, message)
  const tParts = (message: string) => translateJoined(settings.uiLocale, message)
  const noticeText = typeof notice === 'string' ? t(notice)
    : notice ? t(`Added to ${playlistDisplayName(settings.uiLocale, notice.addedToPlaylist)}.`) : undefined
  const errorText = error
    ? (error.playlist ? t(`Unable to add the song to ${playlistDisplayName(settings.uiLocale, error.playlist)}`) : t(error.message))
      + (error.detail ? `${settings.uiLocale === 'fr' ? ' : ' : ': '}${t(error.detail)}` : '')
    : undefined

  const selected = songs.find((song) => song.id === selectedId)
  const processingDetails = selected?.processingDetails
  const processingIssues = selected ? deliverableIssues(selected) : []
  const selectedEnhancedSummary = selected ? enhancedSummary(selected) : undefined
  const activeProcessingItem = processingDetails?.items.find(
    (item) => item.id === processingDetails.activeItem,
  )
  const visibleProcessingGroups = processingGroups
    .map((group) => ({
      item: processingDetails?.items.find((item) => item.id === group.id),
      children: group.children
        ?.map((id) => processingDetails?.items.find((item) => item.id === id))
        .filter((item): item is ProcessingItem => Boolean(item)),
    }))
    .filter((group): group is { item: ProcessingItem; children: ProcessingItem[] | undefined } => Boolean(group.item))
  const needsLanguageRefresh = Boolean(
    selected
    && selected.instrumentalUrl
    && selected.vocalUrl
    && selected.enhancedUrl
    && (selected.languageSource === 'legacy'
      || selected.languageCode === 'und'
      || selected.languageName === 'Unknown'),
  )
  const selectedPlaylist = playlists.playlists.find((playlist) => playlist.id === playlists.selectedPlaylistId)
  const editorSong = songs.find((song) => song.id === lyricsEditor?.songId)
  const editorRematchFailed = editorSong?.lyricRematchStatus === 'failed'
    && editorSong.lyricsRevision === lyricsEditor?.expectedRevision
    && lyricsEditor?.text === lyricsEditor?.baselineText
  const playback = usePlaybackController({ selected, mode, onError: showError })
  const microphone = useMicrophoneMonitor()
  const { audioRef, currentTime, duration, status: playbackStatus, isPlaying } = playback
  const filteredSongs = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (!term) return songs
    return songs.filter((song) => `${song.title} ${song.artist}`.toLowerCase().includes(term))
  }, [query, songs])
  const activeLyricIndex = selected?.lyrics.findIndex((line, index) => {
    const isFinal = index === selected.lyrics.length - 1
    return currentTime >= line.start
      && (currentTime < line.end || (isFinal && currentTime <= (duration || line.end)))
  }) ?? -1

  useEffect(() => { songsRef.current = songs }, [songs])
  useEffect(() => {
    document.documentElement.lang = settings.uiLocale
  }, [settings.uiLocale])
  useEffect(() => {
    const song = selected ? {
      songId: selected.id,
      songTitle: selected.title,
      text: editorTextFromSong(selected),
      revision: selected.lyricsRevision ?? 0,
    } : undefined
    setLyricsEditor((current) => reduceLyricsEditor(current, { type: 'song-changed', song }))
  }, [selected?.id, selected?.title, selected?.lyrics, selected?.lyricsRevision])

  useEffect(() => {
    if (!selected || getModeSource(selected, mode)) return
    setMode('original')
    setNotice(`${modeLabels[mode]} became unavailable; continuing with Original.`)
  }, [selected, mode])

  useEffect(() => {
    let active = true
    Promise.all([karaokeApi.getLibrary(), updatePlaylistStore(() => karaokeApi.getPlaylists())])
      .then(([librarySongs, store]) => {
        setSongs(librarySongs)
        const restoredPlaylist = store.playlists.find((item) => item.id === store.selectedPlaylistId)
        const restoredEntry = restoredPlaylist?.entries.find((entry) => entry.id === restoredPlaylist.currentEntryId)
        if (restoredPlaylist && restoredEntry && librarySongs.some((song) => song.id === restoredEntry.songId)) {
          setSelectedId(restoredEntry.songId)
          setActivePlaylistId(restoredPlaylist.id)
          setActiveEntryId(restoredEntry.id)
          playlistActivationTargetRef.current = { playlistId: restoredPlaylist.id, entryId: restoredEntry.id }
        } else {
          setSelectedId(librarySongs[0]?.id)
        }
      })
      .catch((reason) => showError('Unable to load saved songs and playlists', reason))
      .finally(() => setIsLoading(false))

    void karaokeApi.getSettings()
      .then((loaded) => {
        if (!active) return
        const normalized = normalizeAppSettings(loaded)
        settingsRef.current = normalized
        confirmedSettingsRef.current = normalized
        setSettings(normalized)
        settingsReadyRef.current = true
        setSettingsReady(true)
      })
      .catch((reason) => {
        if (active) showError('Unable to load interface settings', reason)
      })

    const unsubscribe = karaokeApi.onProcessUpdate((update: ProcessUpdate) => {
      setSongs((current) => current.map((song) => song.id === update.songId
        ? mergeProcessUpdate(song, update)
        : song))
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    const reportError = (message: string, detail?: string) => {
      void karaokeApi.reportRendererError(message, detail).catch(() => undefined)
    }
    const onError = (event: ErrorEvent) => reportError(event.message, event.error?.stack)
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason
      reportError(
        reason instanceof Error ? reason.message : 'Unhandled renderer promise rejection',
        reason instanceof Error ? reason.stack : String(reason),
      )
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onUnhandledRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onUnhandledRejection)
    }
  }, [])

  useEffect(() => karaokeApi.onDesktopControl((command) => {
    const audio = audioRef.current
    if (command.action === 'play') void playback.play()
    if (command.action === 'pause') playback.pause()
    if (command.action === 'toggle') playback.toggle()
    if (command.action === 'select' && typeof command.value === 'string') {
      const song = songsRef.current.find((candidate) => candidate.id === command.value)
      if (song) selectLibrarySong(song.id)
      else showError('Automation could not select the requested song', command.value)
    }
    if (command.action === 'mode' && typeof command.value === 'string'
      && ['original', 'enhanced', 'vocal', 'instrumental'].includes(command.value)) {
      const requestedMode = command.value as AudioMode
      const song = songsRef.current.find((candidate) => candidate.id === selectedId)
      if (song && getModeSource(song, requestedMode)) switchMode(requestedMode)
      else showError(`The ${modeLabels[requestedMode]} version is not available`)
    }
    if (command.action === 'seek' && typeof command.value === 'number' && audio) seekTo(command.value)
  }), [selectedId, mode])

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume
  }, [volume, selectedId, mode])

  useEffect(() => {
    lyricRefs.current = []
  }, [selected?.id])

  useEffect(() => {
    if (activeLyricIndex >= 0) {
      lyricRefs.current[activeLyricIndex]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [activeLyricIndex])

  useEffect(() => {
    if (!pendingAutoPlay || !selected) return
    if (playback.loadedSourceKey !== `${selected.id}:${mode}`) return
    setPendingAutoPlay(false)
    void playback.play()
  }, [pendingAutoPlay, selectionGeneration, selected?.id, mode, playback.loadedSourceKey])

  useEffect(() => {
    if (playbackStatus !== 'ended' || !selected) return
    const endKey = `${selectionGeneration}:${selected.id}:${activePlaylistId ?? ''}:${activeEntryId ?? ''}`
    if (handledEndRef.current === endKey) return
    handledEndRef.current = endKey

    const activationTarget = playlistActivationTargetRef.current
    if (activationTarget && (activationTarget.playlistId !== activePlaylistId || activationTarget.entryId !== activeEntryId)) return
    const store = playlistsRef.current
    if (detachedNext) {
      const playlist = store.playlists.find((item) => item.id === detachedNext.playlistId)
      const entry = playlist?.entries.find((item) => item.id === detachedNext.entryId)
      setDetachedNext(undefined)
      if (playlist && entry) void activatePlaylistEntry(playlist, entry, 'entry-removed', true, mode)
      return
    }

    const playlist = store.playlists.find((item) => item.id === activePlaylistId)
    const currentIndex = playlist?.entries.findIndex((entry) => entry.id === activeEntryId) ?? -1
    const currentEntry = currentIndex >= 0 ? playlist?.entries[currentIndex] : undefined
    if (!playlist || !currentEntry || currentEntry.songId !== selected.id) return
    if (playlist.kind === 'queue') {
      void finishQueueEntry(playlist, currentEntry, true)
      return
    }
    const nextEntry = playlist.entries[currentIndex + 1]
    if (nextEntry) void activatePlaylistEntry(playlist, nextEntry, 'natural-end', true, mode)
  }, [playbackStatus, selectionGeneration, selected?.id, activePlaylistId, activeEntryId, detachedNext, playlists, mode])

  useEffect(() => {
    if (!menuSongId) return
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) closeMenu()
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [menuSongId])

  useEffect(() => {
    const activeLyric = activeLyricIndex >= 0 ? selected?.lyrics[activeLyricIndex] : undefined
    const activePlaylist = playlists.playlists.find((item) => item.id === activePlaylistId)
    const cursorIndex = activePlaylist?.entries.findIndex((entry) => entry.id === activeEntryId) ?? -1
    karaokeApi.updateAutomationStatus({
      songId: selected?.id,
      mode,
      status: transitionReason === 'restore' && selected
        && (playbackStatus === 'idle' || playbackStatus === 'loading') ? 'paused'
        : transitionReason === 'natural-end' && pendingAutoPlay && playbackStatus === 'loading'
          ? 'playing'
          : playbackStatus,
      playingIntent: playback.desiredPlayingRef.current,
      currentTime,
      duration,
      activeLyricIndex,
      activeLyricStart: activeLyric?.start,
      activeLyricText: activeLyric?.text,
      lyricLanguage: selected ? { ...selected.lyricLanguage, songId: selected.id } : undefined,
      lyricSongId: selected?.id,
      playlist: {
        selectedPlaylistId: playlists.selectedPlaylistId,
        activePlaylistId,
        currentEntryId: activeEntryId,
        nextEntryId: cursorIndex >= 0 ? activePlaylist?.entries[cursorIndex + 1]?.id : detachedNext?.entryId,
        revision: transitionCount,
        transitionReason,
        transitionCount,
        playlists: playlists.playlists.map((playlist) => ({
          id: playlist.id,
          name: playlist.name,
          kind: playlist.kind,
          currentEntryId: playlist.currentEntryId,
          entries: playlist.entries.map((entry) => ({ id: entry.id, songId: entry.songId })),
        })),
      },
      error: error ? `${error.message}${error.detail ? `: ${error.detail}` : ''}` : undefined,
    })
  }, [
    selected?.id, selected?.lyricLanguage, mode, playback.loadedSourceKey, playbackStatus, currentTime, duration,
    activeLyricIndex, error, playlists, activePlaylistId, activeEntryId, detachedNext,
    transitionReason, transitionCount,
  ])

  function showError(message: string, reason?: unknown, playlist?: Pick<Playlist, 'kind' | 'name'>) {
    const detail = reason instanceof Error ? reason.message : reason === undefined ? undefined : String(reason)
    setError({ message, detail, playlist })
    void karaokeApi.reportRendererError(message, detail).catch(() => undefined)
  }

  function setSettingsBusyCount(delta: number) {
    settingsBusyCountRef.current += delta
    setSettingsBusy(settingsBusyCountRef.current > 0)
  }

  async function changeSettings(patch: UpdateAppSettingsRequest) {
    if (!settingsReadyRef.current || settingsBusyCountRef.current > 0) return
    const next = { ...settingsRef.current, ...patch }
    settingsRef.current = next
    setSettings(next)
    setSettingsBusyCount(1)
    try {
      const saved = normalizeAppSettings(await karaokeApi.updateSettings(patch))
      confirmedSettingsRef.current = saved
      settingsRef.current = saved
      setSettings(saved)
    } catch (reason) {
      settingsRef.current = confirmedSettingsRef.current
      setSettings(confirmedSettingsRef.current)
      showError('Unable to save interface settings', reason)
    } finally {
      setSettingsBusyCount(-1)
    }
  }

  function songLyricSnapshot(song: Song): LyricsEditorSongSnapshot {
    return {
      songId: song.id,
      songTitle: song.title,
      text: editorTextFromSong(song),
      revision: song.lyricsRevision ?? 0,
    }
  }

  function lyricsAreProtected(song?: Song) {
    return (song?.lyricTextSource ?? 'engine') === 'user'
  }

  function lyricsAreBusy(song?: Song) {
    if (!song) return false
    return ['queued', 'preparing', 'separating', 'enhancing', 'transcribing'].includes(song.processingStage)
      || (song.lyricRematchStatus ?? 'none') === 'pending'
      || (lyricsEditor?.songId === song.id && lyricsEditor.saving)
  }

  function openLyricsEditor() {
    if (!selected || lyricsAreBusy(selected)) return
    setLyricsEditor((current) => reduceLyricsEditor(current, { type: 'open', song: songLyricSnapshot(selected) }))
  }

  function requestCloseLyricsEditor() {
    setLyricsEditor((current) => {
      if (current?.discardPrompt) return reduceLyricsEditor(current, { type: 'keep-editing' })
      return reduceLyricsEditor(current, { type: 'request-close' })
    })
  }

  function reloadSavedLyrics() {
    if (!lyricsEditor || lyricsEditor.saving) return
    const song = songsRef.current.find((item) => item.id === lyricsEditor.songId)
    if (!song) return
    setLyricsEditor((current) => reduceLyricsEditor(current, {
      type: 'reload-saved',
      text: editorTextFromSong(song),
      revision: song.lyricsRevision ?? 0,
    }))
  }

  async function submitLyricsUpdate() {
    if (!lyricsEditor || lyricsEditor.saving || lyricsEditor.discardPrompt) return
    const song = songsRef.current.find((item) => item.id === lyricsEditor.songId)
    if (!song || lyricsAreBusy(song)) {
      showError('Unable to update lyrics', lyricsBusyMessage)
      return
    }
    if (!hasUsableLyricLines(lyricsEditor.text)) {
      showError('Unable to update lyrics', lyricsEditor.text.trim()
        ? 'Edited lyrics contain no usable lines.'
        : 'Edited lyrics are empty.')
      return
    }
    const saveId = ++lyricsSaveSeq.current
    const snapshot = lyricsEditor
    latestLyricsSaveRef.current.set(snapshot.songId, saveId)
    setLyricsEditor((current) => reduceLyricsEditor(current, { type: 'save-start', saveId }))
    try {
      const result = await karaokeApi.updateLyrics({
        songId: snapshot.songId,
        text: snapshot.text,
        expectedRevision: snapshot.expectedRevision,
      })
      if (latestLyricsSaveRef.current.get(snapshot.songId) !== saveId) return
      if (result.song?.id !== snapshot.songId || (result.rematch !== 'queued' && result.rematch !== 'skipped')) {
        throw new Error(lyricsBusyMessage)
      }
      setSongs((current) => current.map((item) => {
        if (item.id !== result.song.id) return item
        // A fast rematch can publish its terminal result before the save IPC acknowledges.
        if ((item.lyricsRevision ?? 0) > (result.song.lyricsRevision ?? 0)
          || (item.lyricsRevision === result.song.lyricsRevision
            && result.song.lyricRematchStatus === 'pending'
            && ['complete', 'failed', 'skipped'].includes(item.lyricRematchStatus))) return item
        return {
          ...item,
          ...result.song,
          sourceUrl: result.song.sourceUrl || item.sourceUrl,
          sourcePath: result.song.sourcePath || item.sourcePath,
          instrumentalUrl: result.song.instrumentalUrl ?? item.instrumentalUrl,
          instrumentalPath: result.song.instrumentalPath ?? item.instrumentalPath,
          vocalUrl: result.song.vocalUrl ?? item.vocalUrl,
          vocalPath: result.song.vocalPath ?? item.vocalPath,
          enhancedUrl: result.song.enhancedUrl ?? item.enhancedUrl,
          enhancedPath: result.song.enhancedPath ?? item.enhancedPath,
        }
      }))
      setLyricsEditor((current) => reduceLyricsEditor(current, {
        type: 'save-result',
        saveId,
        songId: snapshot.songId,
        ok: true,
        submittedText: snapshot.text,
        revision: result.song.lyricsRevision ?? snapshot.expectedRevision,
        rematch: result.rematch,
      }))
    } catch (reason) {
      if (latestLyricsSaveRef.current.get(snapshot.songId) !== saveId) return
      const detail = reason instanceof Error ? reason.message : String(reason)
      setLyricsEditor((current) => reduceLyricsEditor(current, {
        type: 'save-result',
        saveId,
        songId: snapshot.songId,
        ok: false,
        submittedText: snapshot.text,
        conflict: detail.includes('Lyric revision conflict.'),
        detail,
      }))
      showError('Unable to update lyrics', reason)
    }
  }

  function toggleMicrophoneMonitor() {
    if (microphone.state === 'on' || microphone.state === 'requesting') {
      void microphone.disable()
      return
    }
    if (!microphoneWarningShownRef.current) {
      microphoneWarningShownRef.current = true
      setNotice('Use wired headphones before monitoring to prevent feedback. Bluetooth latency is unsupported.')
    }
    void microphone.enable()
  }

  const monitorLatencyMs = microphone.telemetry.estimatedOutputLatency === undefined
    ? undefined
    : Math.round(microphone.telemetry.estimatedOutputLatency * 1000)
  const microphoneLevel = Math.min(1, (microphone.telemetry.inputPeak ?? 0) / 0.18)
  const monitorOutputLevel = Math.min(1, (microphone.telemetry.outputPeak ?? 0) / 0.85)
  const noMicrophoneInput = microphone.state === 'on'
    && (microphone.telemetry.silenceDurationMs ?? 0) >= 1_500
  const microphoneStatus = microphone.state === 'on' && microphone.gain === 0
    ? 'Mic live — monitor muted'
    : noMicrophoneInput
    ? 'Mic live — no input detected'
    : microphone.state === 'on' && microphone.telemetry.signalDetected
      ? 'Mic input detected'
      : 'Mic live'
  const monitorGainDb = monitorGainDecibels(microphone.gain)
  const monitorGainLabel = microphone.gain === 0
    ? '0% (muted)'
    : `${Math.round(microphone.gain * 100)}% (${monitorGainDb >= 0 ? '+' : ''}${monitorGainDb.toFixed(1)} dB)`
  const monitorOutputDb = levelDecibels(microphone.telemetry.outputPeak)
  const microphoneLabel = microphone.state === 'on'
    ? 'Turn microphone monitor off'
    : microphone.state === 'requesting'
      ? 'Cancel microphone request'
      : microphone.state === 'error'
        ? 'Retry microphone monitor'
        : 'Turn microphone monitor on'
  const microphoneErrorLabel = microphone.errorCode === 'permission-denied'
    ? 'Permission denied — retry'
    : microphone.errorCode === 'no-device'
      ? 'No microphone — retry'
      : microphone.errorCode === 'device-lost'
        ? 'Mic disconnected — retry'
        : microphone.errorCode === 'context-suspended'
          ? 'Audio interrupted — retry'
          : 'Mic unavailable — retry'

  function markTransition(reason: PlaylistTransitionReason) {
    setTransitionReason(reason)
    setTransitionCount((count) => count + 1)
    setSelectionGeneration((generation) => generation + 1)
  }

  function updatePlaylistStore(operation: (store: PlaylistStore) => Promise<PlaylistStore>) {
    const run = async () => {
      const store = await operation(playlistsRef.current)
      // Publish before resolving so dependent operations never read a pre-render snapshot.
      playlistsRef.current = store
      setPlaylists(store)
      return store
    }
    // A failed operation rejects to its caller, but must not block later user actions.
    const result = playlistOperationRef.current.then(run, run)
    playlistOperationRef.current = result
    return result
  }

  function currentPlaylist(store: PlaylistStore, id: string) {
    const playlist = store.playlists.find((item) => item.id === id)
    if (!playlist) throw new Error('The playlist no longer exists.')
    return playlist
  }

  function cancelPlaylistActivation(playlistId: string, entryId?: string) {
    const target = playlistActivationTargetRef.current
      ?? (activePlaylistId ? { playlistId: activePlaylistId, entryId: activeEntryId } : undefined)
    if (target?.playlistId !== playlistId || (entryId && target.entryId !== entryId)) return undefined
    playlistActivationTargetRef.current = undefined
    return ++playlistActivationRef.current
  }

  function startSong(songId: string, nextMode: AudioMode, autoPlay: boolean) {
    const sameSong = selectedId === songId
    if (!autoPlay) playback.pause()
    if (!sameSong) playback.resetForSong()
    playback.seekTo(0)
    setMode(nextMode)
    setSelectedId(songId)
    setPendingAutoPlay(autoPlay)
  }

  function selectLibrarySong(id: string) {
    playlistActivationRef.current += 1
    playlistActivationTargetRef.current = undefined
    if (id === selectedId && !activeEntryId) return
    setActivePlaylistId(undefined)
    setActiveEntryId(undefined)
    setDetachedNext(undefined)
    markTransition('manual-library')
    startSong(id, 'original', false)
  }

  function playLibrarySong(song: Song) {
    playlistActivationRef.current += 1
    playlistActivationTargetRef.current = undefined
    setActivePlaylistId(undefined)
    setActiveEntryId(undefined)
    setDetachedNext(undefined)
    markTransition('manual-library')
    startSong(song.id, 'original', true)
  }

  async function activatePlaylistEntry(
    playlist: Playlist,
    entry: PlaylistEntry,
    reason: PlaylistTransitionReason,
    autoPlay: boolean,
    preferredMode: AudioMode = 'original',
  ) {
    const song = songsRef.current.find((item) => item.id === entry.songId)
    if (!song) return showError('The playlist song no longer exists')
    let nextMode = preferredMode
    if (!getModeSource(song, preferredMode)) {
      nextMode = 'original'
      setNotice(`${modeLabels[preferredMode]} is unavailable for ${song.title}; using Original.`)
    }
    const activation = ++playlistActivationRef.current
    playlistActivationTargetRef.current = { playlistId: playlist.id, entryId: entry.id }
    try {
      let pending = pendingPlaylistCursorRef.current
      if (pending?.playlistId !== playlist.id || pending.entryId !== entry.id) {
        pending = {
          playlistId: playlist.id,
          entryId: entry.id,
          promise: updatePlaylistStore(async (store) => {
            const target = currentPlaylist(store, playlist.id)
            if (!target.entries.some((item) => item.id === entry.id)) {
              throw new Error('The playlist entry no longer exists.')
            }
            return karaokeApi.setPlaylistCursor({
              playlistId: playlist.id,
              entryId: entry.id,
              expectedUpdatedAt: target.updatedAt,
            })
          }),
        }
        pendingPlaylistCursorRef.current = pending
      }
      try {
        await pending.promise
      } finally {
        if (pendingPlaylistCursorRef.current === pending) pendingPlaylistCursorRef.current = undefined
      }
      if (activation !== playlistActivationRef.current) return
      setActivePlaylistId(playlist.id)
      setActiveEntryId(entry.id)
      setDetachedNext(undefined)
      markTransition(reason)
      startSong(song.id, nextMode, autoPlay)
    } catch (reasonValue) {
      if (activation === playlistActivationRef.current) {
        showError('Unable to select the playlist entry', reasonValue)
      }
    }
  }

  async function finishQueueEntry(playlist: Playlist, entry: PlaylistEntry, autoPlayNext: boolean) {
    const activation = ++playlistActivationRef.current
    playlistActivationTargetRef.current = { playlistId: playlist.id, entryId: entry.id }
    try {
      let pending = pendingQueueArchiveRef.current
      if (pending?.playlistId !== playlist.id || pending.entryId !== entry.id) {
        pending = {
          playlistId: playlist.id,
          entryId: entry.id,
          promise: updatePlaylistStore((store) => karaokeApi.archiveQueueEntry({
            playlistId: playlist.id,
            entryId: entry.id,
            expectedUpdatedAt: currentPlaylist(store, playlist.id).updatedAt,
          })),
        }
        pendingQueueArchiveRef.current = pending
      }
      let store: PlaylistStore
      try {
        store = await pending.promise
      } finally {
        if (pendingQueueArchiveRef.current === pending) pendingQueueArchiveRef.current = undefined
      }
      if (activation !== playlistActivationRef.current) return
      const updatedQueue = store.playlists.find((item) => item.kind === 'queue')
      const nextEntry = updatedQueue?.entries[0]
      if (updatedQueue && nextEntry) {
        await activatePlaylistEntry(updatedQueue, nextEntry, 'natural-end', autoPlayNext, mode)
      } else {
        if (playbackStatus !== 'ended') playback.pause()
        setActivePlaylistId(undefined)
        setActiveEntryId(undefined)
        setPendingAutoPlay(false)
        playlistActivationTargetRef.current = undefined
        markTransition('natural-end')
      }
    } catch (reason) {
      showError('Unable to move the played song to History', reason)
    }
  }

  async function playNext() {
    const store = playlistsRef.current
    const queue = store.playlists.find((item) => item.kind === 'queue')
    const playlist = store.playlists.find((item) => item.id === activePlaylistId)
    const currentIndex = playlist?.entries.findIndex((entry) => entry.id === activeEntryId) ?? -1
    const currentEntry = currentIndex >= 0 ? playlist?.entries[currentIndex] : undefined
    if (playlist?.kind === 'queue' && currentEntry) {
      await finishQueueEntry(playlist, currentEntry, true)
      return
    }
    const nextEntry = playlist?.kind === 'history' && currentIndex > 0
      ? playlist.entries[currentIndex - 1]
      : playlist && currentIndex >= 0 && playlist.kind !== 'history'
        ? playlist.entries[currentIndex + 1]
        : queue?.entries[0]
    const targetPlaylist = playlist?.kind === 'history' && currentIndex > 0
      ? playlist
      : nextEntry && playlist && currentIndex >= 0 && playlist.kind !== 'history' ? playlist : queue
    if (targetPlaylist && nextEntry) await activatePlaylistEntry(targetPlaylist, nextEntry, 'manual-playlist', true, mode)
  }

  async function playPrevious() {
    const store = playlistsRef.current
    const history = store.playlists.find((item) => item.kind === 'history')
    const playlist = store.playlists.find((item) => item.id === activePlaylistId)
    const currentIndex = playlist?.entries.findIndex((entry) => entry.id === activeEntryId) ?? -1
    const previousEntry = playlist?.kind === 'history' && currentIndex >= 0
      ? playlist.entries[currentIndex + 1]
      : playlist && currentIndex > 0 ? playlist.entries[currentIndex - 1] : history?.entries[0]
    const targetPlaylist = playlist?.kind === 'history' && previousEntry
      ? playlist
      : playlist && currentIndex > 0 ? playlist : history
    if (targetPlaylist && previousEntry) {
      await activatePlaylistEntry(targetPlaylist, previousEntry, 'manual-playlist', true, mode)
    } else if (selected) {
      playlistActivationRef.current += 1
      playlistActivationTargetRef.current = activePlaylistId && activeEntryId
        ? { playlistId: activePlaylistId, entryId: activeEntryId } : undefined
      playback.seekTo(0)
      void playback.play()
    }
  }

  function switchMode(requestedMode: AudioMode) {
    if (requestedMode === mode) return
    playback.capturePosition(Math.max(0, currentTime - (isPlaying ? 0.15 : 0)))
    setMode(requestedMode)
  }

  function seekTo(requestedTime: number) {
    playback.seekTo(requestedTime)
  }

  async function importSongs() {
    setError(undefined)
    setIsImporting(true)
    try {
      const librarySongs = await karaokeApi.importSongs()
      setSongs(librarySongs)
      if (!librarySongs.some((song) => song.id === selectedId)) setSelectedId(librarySongs[0]?.id)
    } catch (reason) {
      showError('Unable to import songs', reason)
    } finally {
      setIsImporting(false)
    }
  }

  async function processSelected() {
    if (!selected) return
    if (lyricsAreProtected(selected)) {
      showError('Unable to create the karaoke versions', 'Manual lyrics are protected from AI text replacement.')
      return
    }
    setError(undefined)
    try {
      const updated = await karaokeApi.processSong(selected.id)
      setSongs((current) => current.map((song) => song.id === updated.id ? updated : song))
      switchMode('enhanced')
    } catch (reason) {
      showError('Unable to create the karaoke versions', reason)
    }
  }

  async function retranscribeSelected() {
    if (!selected) return
    if (lyricsAreProtected(selected)) {
      showError('Unable to refresh lyrics and language', 'Manual lyrics are protected from AI text replacement.')
      return
    }
    setError(undefined)
    try {
      const updated = await karaokeApi.retranscribeSong(selected.id)
      setSongs((current) => current.map((song) => song.id === updated.id ? updated : song))
      setNotice(`${updated.languageName} lyrics and timing refreshed without re-separating audio.`)
    } catch (reason) {
      showError('Unable to refresh lyrics and language', reason)
    }
  }

  async function retryFailedDeliverable(song: Song, component: ProcessingComponentId) {
    if ((component === 'lyrics' || component === 'whisper-transcription') && lyricsAreProtected(song)) {
      showError(`Unable to retry ${componentLabels[component]}`, 'Manual lyrics are protected from AI text replacement.')
      return
    }
    if (!claimRetry(pendingRetryKeysRef.current, song.id, component)) return
    const key = retryKey(song.id, component)
    setPendingRetries((current) => [...current, key])
    setError(undefined)
    try {
      const updated = await karaokeApi.retryDeliverable({
        songId: song.id,
        component,
      })
      setSongs((current) => current.map((song) => song.id === updated.id ? updated : song))
    } catch (reason) {
      showError(`Unable to retry ${componentLabels[component]}`, reason)
    } finally {
      pendingRetryKeysRef.current.delete(key)
      setPendingRetries((current) => current.filter((candidate) => candidate !== key))
    }
  }

  async function removeSong(song: Song) {
    const target = playlistActivationTargetRef.current
    const targetEntry = target && playlistsRef.current.playlists.find((item) => item.id === target.playlistId)
      ?.entries.find((item) => item.id === target.entryId)
    const affectsSelection = targetEntry ? targetEntry.songId === song.id : selectedId === song.id
    const activation = affectsSelection ? ++playlistActivationRef.current : undefined
    if (affectsSelection) playlistActivationTargetRef.current = undefined
    try {
      await updatePlaylistStore(async () => {
        const librarySongs = await karaokeApi.removeSong(song.id)
        songsRef.current = librarySongs
        setSongs(librarySongs)
        return karaokeApi.getPlaylists()
      })
      if (activation !== undefined && activation === playlistActivationRef.current) {
        playback.pause()
        playback.resetForSong()
        setSelectedId(songsRef.current[0]?.id)
        setMode('original')
        setActivePlaylistId(undefined)
        setActiveEntryId(undefined)
        setDetachedNext(undefined)
        setPendingAutoPlay(false)
        markTransition('song-removed')
      }
    } catch (reason) {
      showError(`Unable to remove ${song.title}`, reason)
    }
  }

  async function choosePlaylist(playlist: Playlist) {
    try {
      await updatePlaylistStore(() => karaokeApi.selectPlaylist({ playlistId: playlist.id }))
      setView('playlists')
    } catch (reason) {
      showError('Unable to open the playlist', reason)
    }
  }

  async function addToPlaylist(songId: string, playlist: Playlist) {
    try {
      await updatePlaylistStore((store) => karaokeApi.addSongToPlaylist({
        playlistId: playlist.id,
        songId,
        expectedUpdatedAt: currentPlaylist(store, playlist.id).updatedAt,
      }))
      setNotice({ addedToPlaylist: { kind: playlist.kind, name: playlist.name } })
      closeMenu()
    } catch (reason) {
      showError(`Unable to add the song to ${playlist.name}`, reason, playlist)
    }
  }

  async function createPlaylist(event: React.FormEvent) {
    event.preventDefault()
    try {
      const store = await updatePlaylistStore(() => karaokeApi.createPlaylist({ name: playlistName }))
      const created = store.playlists.at(-1)
      if (created && createForSongId) {
        await updatePlaylistStore((current) => karaokeApi.addSongToPlaylist({
          playlistId: created.id,
          songId: createForSongId,
          expectedUpdatedAt: currentPlaylist(current, created.id).updatedAt,
        }))
        setNotice(`Created ${created.name} and added the song.`)
      } else if (created) {
        await updatePlaylistStore(() => karaokeApi.selectPlaylist({ playlistId: created.id }))
        setView('playlists')
        setNotice(`Created ${created.name}.`)
      }
      setPlaylistName('')
      setShowCreatePlaylist(false)
      setCreateForSongId(undefined)
      closeMenu()
    } catch (reason) {
      showError('Unable to create the playlist', reason)
    }
  }

  async function removeEntry(playlist: Playlist, entry: PlaylistEntry) {
    const removingActive = activePlaylistId === playlist.id && activeEntryId === entry.id
    const activation = cancelPlaylistActivation(playlist.id, entry.id)
    try {
      let followingId: string | undefined
      const store = await updatePlaylistStore((current) => {
        const target = currentPlaylist(current, playlist.id)
        const index = target.entries.findIndex((item) => item.id === entry.id)
        followingId = target.entries[index + 1]?.id
        return karaokeApi.removePlaylistEntry({
          playlistId: playlist.id,
          entryId: entry.id,
          expectedUpdatedAt: target.updatedAt,
        })
      })
      if (!removingActive || activation === undefined || activation !== playlistActivationRef.current) return
      const updatedPlaylist = store.playlists.find((item) => item.id === playlist.id)
      const followingCandidate = updatedPlaylist?.entries.find((item) => item.id === followingId)
      const pausedCandidate = updatedPlaylist?.entries.find((item) => item.id === updatedPlaylist.currentEntryId)
      if (isPlaying) {
        setActiveEntryId(undefined)
        setDetachedNext(followingCandidate ? { playlistId: playlist.id, entryId: followingCandidate.id } : undefined)
        markTransition('entry-removed')
      } else if (pausedCandidate) {
        if (updatedPlaylist) {
          await activatePlaylistEntry(updatedPlaylist, pausedCandidate, 'entry-removed', false)
        }
      } else {
        playback.pause()
        playback.resetForSong()
        setSelectedId(undefined)
        setActivePlaylistId(undefined)
        setActiveEntryId(undefined)
        markTransition('entry-removed')
      }
    } catch (reason) {
      showError('Unable to remove the playlist entry', reason)
    }
  }

  async function clearCurrentPlaylist() {
    if (!selectedPlaylist) return
    const activation = cancelPlaylistActivation(selectedPlaylist.id)
    try {
      await updatePlaylistStore((store) => karaokeApi.clearPlaylist({
        playlistId: selectedPlaylist.id,
        expectedUpdatedAt: currentPlaylist(store, selectedPlaylist.id).updatedAt,
      }))
      if (activation !== undefined && activation === playlistActivationRef.current) {
        playback.pause()
        setActivePlaylistId(undefined)
        setActiveEntryId(undefined)
        setDetachedNext(undefined)
        setPendingAutoPlay(false)
      }
    } catch (reason) {
      showError('Unable to clear the playlist', reason)
    }
  }

  async function renameCurrentPlaylist(event: React.FormEvent) {
    event.preventDefault()
    if (!selectedPlaylist || selectedPlaylist.kind === 'queue') return
    try {
      await updatePlaylistStore((store) => karaokeApi.renamePlaylist({
        playlistId: selectedPlaylist.id,
        name: renameName,
        expectedUpdatedAt: currentPlaylist(store, selectedPlaylist.id).updatedAt,
      }))
      setShowRenamePlaylist(false)
      setNotice(`Renamed playlist to ${renameName.trim()}.`)
    } catch (reason) {
      showError('Unable to rename the playlist', reason)
    }
  }

  async function deleteCurrentPlaylist() {
    if (!selectedPlaylist || selectedPlaylist.kind === 'queue') return
    const activation = cancelPlaylistActivation(selectedPlaylist.id)
    try {
      const deletingId = selectedPlaylist.id
      await updatePlaylistStore((store) => karaokeApi.deletePlaylist({
        playlistId: deletingId,
        expectedUpdatedAt: currentPlaylist(store, deletingId).updatedAt,
      }))
      setConfirmDelete(false)
      if (activation !== undefined && activation === playlistActivationRef.current) {
        setActivePlaylistId(undefined)
        setActiveEntryId(undefined)
        setDetachedNext(undefined)
        setPendingAutoPlay(false)
      }
      setNotice('Playlist deleted. Library songs were not removed.')
    } catch (reason) {
      showError('Unable to delete the playlist', reason)
    }
  }

  function closeMenu() {
    const priorSongId = menuSongId
    setMenuSongId(undefined)
    setMenuPosition(undefined)
    if (priorSongId) requestAnimationFrame(() => menuButtonRefs.current.get(priorSongId)?.focus())
  }

  function openMenu(songId: string, button: HTMLButtonElement) {
    if (menuSongId === songId) {
      closeMenu()
      return
    }
    const rect = button.getBoundingClientRect()
    const itemCount = playlists.playlists.filter((playlist) => playlist.kind !== 'history').length + 1
    const estimatedHeight = Math.min(420, 46 + itemCount * 36)
    const spaceBelow = window.innerHeight - rect.bottom - 12
    const top = spaceBelow >= estimatedHeight
      ? rect.bottom + 6
      : Math.max(8, rect.top - Math.min(estimatedHeight, window.innerHeight - 16) - 6)
    setMenuPosition({
      left: Math.max(8, Math.min(rect.right - 210, window.innerWidth - 218)),
      top,
      maxHeight: Math.max(120, window.innerHeight - top - 8),
    })
    setMenuSongId(songId)
    requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus())
  }

  function menuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Escape') {
      event.preventDefault()
      closeMenu()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      items[(current + delta + items.length) % items.length]?.focus()
    } else if (event.key === 'Home') {
      event.preventDefault()
      items[0]?.focus()
    } else if (event.key === 'End') {
      event.preventDefault()
      items.at(-1)?.focus()
    }
  }

  useEffect(() => {
    if (!lyricsEditor) return
    const restoreFocus = editLyricsButtonRef.current
    return () => restoreFocus?.focus()
  }, [Boolean(lyricsEditor)])
  useEffect(() => {
    if (!lyricsEditor) return
    const selector = lyricsEditor.discardPrompt
      ? '[data-testid="lyrics-editor-discard"]'
      : '[data-testid="lyrics-editor-text"]'
    lyricsEditorDialogRef.current?.querySelector<HTMLElement>(selector)?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        requestCloseLyricsEditor()
        return
      }
      if (event.key !== 'Tab') return
      const dialog = lyricsEditorDialogRef.current
      if (!dialog) return
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled])',
      )]
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (!(active instanceof HTMLElement) || !dialog.contains(active)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
        return
      }
      if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [lyricsEditor?.songId, lyricsEditor?.discardPrompt, Boolean(lyricsEditor)])

  function sidebarPlaylist(playlist: Playlist) {
    const active = view === 'playlists' && selectedPlaylist?.id === playlist.id
    return (
      <button key={playlist.id} data-testid={`playlist-${playlist.id}`}
        className={`nav-item sidebar-playlist ${active ? 'active' : ''}`}
        aria-current={active ? 'page' : undefined}
        onClick={() => void choosePlaylist(playlist)}>
        {playlist.kind === 'history' ? <Clock3 size={16} /> : <ListMusic size={16} />}
        <span>{playlistDisplayName(settings.uiLocale, playlist)}</span>
        <small>{playlist.entries.length}</small>
      </button>
    )
  }

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="brand-mark"><AudioLines size={18} /></div>
        <span className="brand-name">Karaoke Studio</span>
        <span className="privacy-pill"><HardDrive size={12} /> {t('Private · On-device AI')}</span>
        <div className="titlebar-actions">
          <div className="header-control" data-testid="recognition-language" aria-busy={!settingsReady || settingsBusy}>
            <span>{t('Recognition')}</span>
            <select data-testid="recognition-language-mode" aria-label={t('Song recognition language mode')}
              value={settings.recognitionLanguageMode} disabled={!settingsReady || settingsBusy}
              onChange={(event) => {
                if (!isRecognitionLanguageMode(event.target.value)) return
                const recognitionLanguageMode: RecognitionLanguageMode = event.target.value
                if (recognitionLanguageMode !== settings.recognitionLanguageMode) {
                  void changeSettings({ recognitionLanguageMode })
                }
              }}>
              <option value="auto">{t('Auto')}</option>
              <option value="manual">{t('Manual')}</option>
            </select>
            <select data-testid="recognition-language-code" aria-label={t('Manual song recognition language')}
              value={settings.recognitionLanguageCode}
              disabled={!settingsReady || settingsBusy || settings.recognitionLanguageMode === 'auto'}
              onChange={(event) => {
                if (event.target.value !== settings.recognitionLanguageCode) {
                  void changeSettings({ recognitionLanguageCode: event.target.value })
                }
              }}>
              {recognitionLanguageOptions(settings.uiLocale, settings.recognitionLanguageCode).map((language) => (
                <option key={language.code} value={language.code} disabled={language.unsupported}>{language.label}</option>
              ))}
            </select>
          </div>
          <div className="locale-switch" role="group" aria-label={t('Interface language')} data-testid="ui-locale">
            <button type="button" data-testid="ui-locale-en" aria-pressed={settings.uiLocale === 'en'}
              disabled={!settingsReady || settingsBusy} onClick={() => {
                if (settings.uiLocale !== 'en') void changeSettings({ uiLocale: 'en' })
              }}>English</button>
            <button type="button" data-testid="ui-locale-fr" aria-pressed={settings.uiLocale === 'fr'}
              disabled={!settingsReady || settingsBusy} onClick={() => {
                if (settings.uiLocale !== 'fr') void changeSettings({ uiLocale: 'fr' })
              }}>Français</button>
          </div>
          <button className="diagnostics-link" onClick={() => void karaokeApi.openDiagnostics()
            .catch((reason) => showError('Unable to open diagnostics', reason))} aria-label={t('Open diagnostics folder')}>
            <Bug size={12} /> {t('Diagnostics')}
          </button>
        </div>
        <span className="header-settings-note">{t('Interface language does not change a song’s saved language.')} {t('Auto detects each song. Manual applies only to new recognition.')}</span>
      </header>

      <aside className="sidebar">
        <nav aria-label={t('Main navigation')}>
          <button data-testid="nav-library" className={`nav-item ${view === 'library' ? 'active' : ''}`}
            aria-current={view === 'library' ? 'page' : undefined} onClick={() => setView('library')}>
            <Library size={18} /> {t('Library')}
          </button>
          <div className="sidebar-library-lists">
            {(['queue', 'history'] as const).map((kind) => {
              const playlist = playlists.playlists.find((item) => item.kind === kind)
              return playlist ? sidebarPlaylist(playlist) : null
            })}
          </div>
          <div className="sidebar-playlists" role="group" aria-label={t('Saved playlists')}>
            {playlists.playlists.filter((playlist) => playlist.kind === 'playlist').map(sidebarPlaylist)}
          </div>
        </nav>
        <div className="local-card">
          <div className="local-card-icon"><WandSparkles size={18} /></div>
          <div><strong>{t('Runs locally')}</strong><p>{t('Your music never leaves this PC.')}</p></div>
        </div>
        <button className="nav-item sidebar-create" data-testid="sidebar-new-playlist" onClick={() => {
          setCreateForSongId(undefined)
          setShowCreatePlaylist(true)
        }}><Plus size={18} /> {t('New playlist')}</button>
      </aside>

      <main className="content">
        <section className="library-pane">
          {view === 'library' ? (
            <>
              <div className="page-heading">
                <div><span className="eyebrow">{t('YOUR COLLECTION')}</span><h1>{t('Song Library')}</h1>
                  <p>{t(`${songs.length} ${songs.length === 1 ? 'track' : 'tracks'} ready for your next performance`)}</p></div>
                <button className="primary-button" data-testid="add-songs" onClick={importSongs} disabled={isImporting}>
                  {isImporting ? <LoaderCircle className="spin" size={18} /> : <Plus size={18} />}
                  {isImporting ? t('Adding…') : t('Add songs')}
                </button>
              </div>
              <div className="toolbar">
                <label className="search"><Search size={17} /><input value={query}
                  onChange={(event) => setQuery(event.target.value)} placeholder={t('Search songs or artists')} /></label>
                <span className="filter-button">{t('FIFO playlists')} <ChevronRight size={15} /></span>
              </div>
              {isLoading ? (
                <div className="empty-state loading-state" role="status"><span className="empty-icon">
                  <LoaderCircle className="spin" size={30} /></span><strong>{t('Loading your library')}</strong>
                  <span>{t('Finding songs stored on this PC.')}</span></div>
              ) : songs.length === 0 ? (
                <button className="empty-state" onClick={importSongs} disabled={isImporting}>
                  <span className="empty-icon"><Music2 size={30} /></span><strong>{t('Bring your music to the stage')}</strong>
                  <span>{t('Import MP3 or MP4 files to create karaoke versions with local AI.')}</span>
                  <span className="empty-action"><FolderOpen size={16} /> {t('Choose songs')}</span>
                </button>
              ) : (
                <div className="song-list" role="listbox" aria-label={t('Song library')}>
                  <div className="song-list-header"><span>{t('TRACK')}</span><span>{t('STATUS')}</span><span>{t('ADDED')}</span><span /></div>
                  {filteredSongs.map((song, index) => {
                    const isSelected = selected?.id === song.id
                    const isProcessing = ['preparing', 'separating', 'enhancing', 'transcribing'].includes(song.processingStage)
                    return (
                      <div className={`song-row ${isSelected ? 'selected' : ''}`} key={song.id}>
                        <button className="song-select" data-testid="song-row" data-song-id={song.id}
                          role="option" aria-selected={isSelected}
                          onClick={() => selectLibrarySong(song.id)}
                          onDoubleClick={() => playLibrarySong(song)}
                          aria-label={t(`Select ${song.title} by ${song.artist}`)}>
                          <span className="track-cell"><span className="track-art">
                            {isSelected && isPlaying ? <AudioLines size={19} /> : <span>{index + 1}</span>}
                          </span><span className="track-copy"><strong>{song.title}</strong>
                            <small>{song.artist} · {song.format.toUpperCase()}</small></span></span>
                        </button>
                        <span>{song.processingStage === 'queued' ? (
                          <span className="status queued"><Clock3 size={13} /> {song.processingDetails?.queuePosition
                            ? t(`Queued #${song.processingDetails.queuePosition}`) : t('Queued')}</span>
                        ) : isProcessing ? (
                          <span className="status processing"><LoaderCircle className="spin" size={13} />
                            {t(`${song.processingProgress}%`)}</span>
                        ) : song.processingStage === 'complete' ? (
                          <span className="status ready"><Check size={13} /> {t('Karaoke ready')}</span>
                        ) : song.processingStage === 'partial' ? (
                          <span className="status partial">{t(`Partial · ${[song.enhancedUrl, song.vocalUrl, song.instrumentalUrl]
                            .filter(Boolean).length + 1} modes`)}</span>
                        ) : song.processingStage === 'error' ? (
                          <span className="status error">{t('Needs attention')}</span>
                        ) : <span className="status original">{t('Original')}</span>}</span>
                        <span className="date-cell">{new Date(song.addedAt).toLocaleDateString(localeTag(settings.uiLocale), { month: 'short', day: 'numeric' })}</span>
                        <span className="row-actions">
                          <button data-testid={`song-menu-${song.id}`} ref={(button) => {
                            if (button) menuButtonRefs.current.set(song.id, button)
                          }} aria-label={t(`Add ${song.title} to a playlist`)} aria-haspopup="menu"
                            aria-expanded={menuSongId === song.id}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.stopPropagation()
                              openMenu(song.id, event.currentTarget)
                            }}
                            onDoubleClick={(event) => event.stopPropagation()}><Plus size={18} /></button>
                          <button data-testid="remove-song" aria-label={t(`Remove ${song.title} from library`)}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.stopPropagation()
                              void removeSong(song)
                            }}
                            onDoubleClick={(event) => event.stopPropagation()}><Trash2 size={16} /></button>
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          ) : (
            <div className="playlists-view">
              <div className="playlist-contents">
                <div className="playlist-heading"><div><span className="eyebrow">{t('PLAYING IN ORDER')}</span>
                  <h2>{selectedPlaylist ? playlistDisplayName(settings.uiLocale, selectedPlaylist) : t('Playlist')}</h2></div>
                  <div>
                    <button data-testid="playlist-play" disabled={!selectedPlaylist?.entries.length} onClick={() => {
                      if (!selectedPlaylist) return
                      const entry = selectedPlaylist.entries.find((item) => item.id === selectedPlaylist.currentEntryId)
                        ?? selectedPlaylist.entries[0]
                      if (entry) void activatePlaylistEntry(selectedPlaylist, entry, 'manual-playlist', true)
                    }}><Play size={15} /> {t('Play')}</button>
                    <button data-testid="playlist-clear" disabled={!selectedPlaylist?.entries.length}
                      onClick={() => setConfirmClear(true)}><Trash2 size={15} /> {t('Clear')}</button>
                    {selectedPlaylist?.kind === 'playlist' && (
                      <>
                        <button onClick={() => {
                          setRenameName(selectedPlaylist.name)
                          setShowRenamePlaylist(true)
                        }}>{t('Rename')}</button>
                        <button onClick={() => setConfirmDelete(true)}>{t('Delete')}</button>
                      </>
                    )}
                  </div>
                </div>
                {!selectedPlaylist?.entries.length ? (
                  <div className="playlist-empty"><ListMusic size={28} /><strong>{t('No songs yet')}</strong>
                    <span>{selectedPlaylist?.kind === 'history'
                      ? t('Songs move here after they finish playing from Queue.')
                      : t('Use a song’s plus menu in Library to add it here.')}</span></div>
                ) : (
                  <ol className="playlist-entries">
                    {selectedPlaylist.entries.map((entry, index) => {
                      const song = songs.find((item) => item.id === entry.songId)
                      const current = activePlaylistId === selectedPlaylist.id && activeEntryId === entry.id
                      return (
                        <li key={entry.id} className={current ? 'current' : ''}>
                          <button data-testid={`playlist-entry-${entry.id}`}
                            onClick={(event) => {
                              if (event.detail < 2) void activatePlaylistEntry(selectedPlaylist, entry, 'manual-playlist', false)
                            }}
                            onDoubleClick={() => void activatePlaylistEntry(selectedPlaylist, entry, 'manual-playlist', true)}>
                            <span>{index + 1}</span><span><strong>{song?.title ?? t('Missing song')}</strong>
                              <small>{song?.artist ?? t('Unavailable')}</small></span>
                            {current && <span className="queue-current">{t('Current')}</span>}
                          </button>
                          <button data-testid={`playlist-remove-${entry.id}`}
                            aria-label={t(`Remove ${song?.title ?? 'song'} from ${playlistDisplayName(settings.uiLocale, selectedPlaylist)}`)}
                            onClick={() => void removeEntry(selectedPlaylist, entry)}><X size={16} /></button>
                        </li>
                      )
                    })}
                  </ol>
                )}
              </div>
            </div>
          )}
        </section>

        <section className="studio-pane">
          {selected ? (
            <>
              <div className="now-playing"><div className="large-art"><Disc3 size={58} strokeWidth={1.3} />
                <span className={isPlaying ? 'pulse-ring playing' : 'pulse-ring'} /></div>
                <span className="eyebrow">{t('NOW SELECTED')}</span><h2>{selected.title}</h2><p>{selected.artist}</p></div>
              <div className="mode-switch" role="group" aria-label={t('Audio version')}>
                {(['original', 'enhanced', 'vocal', 'instrumental'] as AudioMode[]).map((audioMode) => (
                  <button key={audioMode} className={mode === audioMode ? 'active' : ''}
                    data-testid={`mode-${audioMode}`} disabled={!modeAvailability(selected, audioMode).available}
                    aria-describedby={!modeAvailability(selected, audioMode).available
                      ? `mode-${audioMode}-reason` : undefined}
                    onClick={() => switchMode(audioMode)}>
                    {audioMode === 'original' ? <Music2 size={15} /> : audioMode === 'enhanced'
                      ? <Sparkles size={15} /> : audioMode === 'vocal' ? <Mic2 size={15} />
                        : <SlidersHorizontal size={15} />} {t(modeLabels[audioMode])}
                  </button>
                ))}
                {(['original', 'enhanced', 'vocal', 'instrumental'] as AudioMode[]).map((audioMode) => {
                  const availability = modeAvailability(selected, audioMode)
                  return !availability.available ? (
                    <span className="sr-only" id={`mode-${audioMode}-reason`} key={`${audioMode}-reason`}>
                      {t(availability.reason ?? '')}
                    </span>
                  ) : null
                })}
              </div>
              {selectedEnhancedSummary && (
                <div className="enhanced-summary" data-testid="enhanced-summary">
                  <Sparkles size={15} aria-hidden="true" />
                  <div><strong>{t('Enhanced auto-balanced')}</strong>
                    <span>{t(selectedEnhancedSummary.measurements)} · {t(selectedEnhancedSummary.adjustments)}</span>
                    {(selectedEnhancedSummary.cleanup || selectedEnhancedSummary.caveat)
                      && <small>{t(selectedEnhancedSummary.cleanup ?? selectedEnhancedSummary.caveat ?? '')}</small>}
                  </div>
                </div>
              )}
              {(selected.processingStage !== 'complete' || needsLanguageRefresh || processingIssues.length > 0) && (
                <div className={`ai-card ${selected.processingStage === 'error' ? 'failed' : ''}`}>
                  <div className="ai-card-top"><span className="ai-icon"><WandSparkles size={19} /></span>
                    <div><strong>{needsLanguageRefresh
                      ? t('Refresh original-language lyrics')
                      : selected.processingStage === 'idle' ? t('Create karaoke version')
                        : processingIssues.length ? t('Some components need attention')
                          : t('Local AI is working')}</strong>
                      <p>{selected.processingMessage ? t(selected.processingMessage) : (needsLanguageRefresh
                        ? t('Reuse the existing vocal stem to detect the original language and correct timed lyrics.')
                        : t('Create four audio versions and synchronized lyrics.'))}</p></div></div>
                  {processingDetails && selected.processingStage !== 'idle' && (
                    <div className="processing-detail" data-testid="processing-detail"
                      aria-label={t(`Local AI progress for ${selected.title}`)}>
                      <div className="processing-summary" role="status" aria-live="polite">
                        <div>
                          <span>{selected.processingStage === 'queued'
                            ? t('Waiting to start')
                            : activeProcessingItem?.label
                              ? t(activeProcessingItem.label)
                              : (selected.processingStage === 'error' || selected.processingStage === 'partial'
                                ? t('Processing needs attention') : t('Finalizing'))}</span>
                          <strong data-testid="processing-action">{selected.processingMessage ? t(selected.processingMessage) : ''}</strong>
                        </div>
                        {selected.processingStage !== 'queued'
                          && <b data-testid="processing-overall">{t(`${Math.round(selected.processingProgress)}%`)}</b>}
                      </div>
                      {selected.processingStage !== 'queued' && (
                        <div className="progress-track" role="progressbar"
                          aria-label={t('Overall karaoke processing progress')} aria-valuemin={0} aria-valuemax={100}
                          aria-valuenow={Math.round(selected.processingProgress)}>
                          <span style={{ width: `${Math.max(0, Math.min(100, selected.processingProgress))}%` }} />
                        </div>
                      )}
                      <div className="processing-checklist" role="list" aria-label={t('Karaoke deliverables')}>
                        {visibleProcessingGroups.map(({ item, children }) => (
                          <div className={`processing-item ${item.status}`} data-status={item.status}
                            data-testid={`processing-item-${item.id}`} role="listitem" key={item.id}>
                            <span className="processing-state"><ProcessingStatusIcon item={item} /></span>
                            <div className="processing-copy">
                              <div><strong>{t(item.label)}</strong>
                                <span>{t(processingStatusLabels[item.status])}{item.id === 'demucs' && children?.length
                                  ? t(` · ${children.filter((child) => child.status === 'complete').length}/${children.length} stems`)
                                  : ''}</span></div>
                              {processingItemDetail(item) && <small>{tParts(processingItemDetail(item) ?? '')}</small>}
                              {item.error && item.error !== item.message
                                && <small className="processing-error">{t(item.error)}</small>}
                              {children?.length ? (
                                <div className="processing-children" aria-label={`${t(item.label)} ${t('details')}`}>
                                  {children.map((child) => (
                                    <span key={child.id} className={child.status} data-status={child.status}
                                      title={processingItemDetail(child) ? tParts(processingItemDetail(child) ?? '') : t(processingStatusLabels[child.status])}>
                                      <ProcessingStatusIcon item={child} /> {t(child.label)}
                                      <em>{t(processingStatusLabels[child.status])}</em>
                                    </span>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {processingIssues.filter((issue) => issue.component !== 'lyrics').length > 0 && (
                    <div className="deliverable-issues" aria-label={t('Processing issues')}>
                      {processingIssues.filter((issue) => issue.component !== 'lyrics').map((issue) => {
                        const activity = retryActivity(
                          selected,
                          issue.component,
                          pendingRetries.includes(retryKey(selected.id, issue.component)),
                        )
                        return (
                          <div className={`deliverable-issue ${issue.state}`} data-testid={`deliverable-${issue.component}`}
                            key={issue.component}>
                            <div><strong>{t(issue.label)}</strong><span>{issue.state === 'blocked' ? t('Blocked') : t('Failed')}</span></div>
                            <p>{t(issue.reason)}</p>
                            {issue.retryable && (
                              <button data-testid={`retry-${issue.component}`}
                                disabled={Boolean(activity)}
                                onClick={() => void retryFailedDeliverable(selected, issue.component)}>
                                {activity ? t(activity) : t('Try again')}
                              </button>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                  {!processingDetails && selected.processingStage !== 'idle' && selected.processingStage !== 'error'
                    && selected.processingStage !== 'queued'
                    && <div className="progress-track" role="progressbar"
                      aria-label={t('Overall karaoke processing progress')} aria-valuemin={0} aria-valuemax={100}
                      aria-valuenow={Math.round(selected.processingProgress)}>
                      <span style={{ width: `${Math.max(0, Math.min(100, selected.processingProgress))}%` }} />
                    </div>}
                  {(selected.processingStage === 'idle' || needsLanguageRefresh) && (
                  <button className="ai-action" data-testid={needsLanguageRefresh ? 'refresh-lyrics-language' : undefined}
                    onClick={needsLanguageRefresh ? retranscribeSelected : processSelected}
                    disabled={lyricsAreBusy(selected) || lyricsAreProtected(selected)}
                    aria-describedby={lyricsAreProtected(selected) ? 'lyrics-protected-note' : undefined}>
                    {['queued', 'preparing', 'separating', 'enhancing', 'transcribing'].includes(selected.processingStage)
                      ? <><LoaderCircle className="spin" size={16} /> {selected.processingStage === 'queued'
                        ? t('Queued') : t(`Processing ${selected.processingProgress}%`)}</>
                      : <><Sparkles size={16} /> {needsLanguageRefresh
                        ? selected.processingStage === 'error' ? t('Retry lyrics refresh') : t('Refresh lyrics & language')
                        : t('Extract with local AI')}</>}
                  </button>
                  )}
                </div>
              )}
              <div className="lyrics-panel">
                <div className="panel-title"><div><span className="eyebrow">{t('SYNCED')}</span><h3>{t('Lyrics')}</h3></div>
                  <div className="lyrics-panel-actions">
                    <span data-testid="lyrics-language"><Clock3 size={13} />
                      {selected.lyricLanguage.languageName} ({selected.lyricLanguage.languageCode}) · {selected.lyrics.length ? t('Timed') : t('Waiting')}
                      {' · '}{t(lyricsTextSourceLabel(selected.lyricTextSource))}
                    </span>
                    <button type="button" className="lyrics-edit-button" data-testid="edit-lyrics" ref={editLyricsButtonRef}
                      disabled={lyricsAreBusy(selected)} aria-haspopup="dialog"
                      aria-describedby="edit-lyrics-reason" onClick={openLyricsEditor}>
                      <Pencil size={12} aria-hidden="true" /> {t('Edit')}
                    </button>
                  </div></div>
                <span id="edit-lyrics-reason" className="sr-only">
                  {lyricsAreBusy(selected) ? t('Lyrics are busy with local processing.') : t('Edit the saved lyrics for this song')}
                </span>
                {lyricsAreProtected(selected) && (
                  <p className="lyrics-protected" id="lyrics-protected-note" data-testid="lyrics-protected" role="status">
                    {t('Manual lyrics are protected from AI text replacement.')}
                  </p>
                )}
                {lyricsRematchMessage(selected.lyricRematchStatus, selected.lyricRematchMessage) && (
                  <p className="lyrics-rematch" data-testid="lyrics-rematch-status" data-status={selected.lyricRematchStatus ?? 'none'}
                    role={selected.lyricRematchStatus === 'failed' ? 'alert' : 'status'}>
                    {t(lyricsRematchMessage(selected.lyricRematchStatus, selected.lyricRematchMessage) ?? '')}
                  </p>
                )}
                {lyricsTimingSummary(selected) && (
                  <p className="lyrics-timing-warning" data-testid="lyrics-timing-warning">
                    {t(lyricsTimingSummary(selected) ?? '')}
                  </p>
                )}
                <div className="lyrics-scroll">
                  {selected.lyrics.length ? selected.lyrics.map((line, index) => (
                    <button key={`${line.start}-${line.text}`} ref={(element) => { lyricRefs.current[index] = element }}
                      className={`lyric-line ${index === activeLyricIndex ? 'active' : ''} ${index < activeLyricIndex ? 'past' : ''}`}
                      aria-current={index === activeLyricIndex ? 'true' : undefined} onClick={() => seekTo(line.start)}>
                      <span>{formatTime(line.start)}</span><strong>{line.text}</strong>
                    </button>
                  )) : (() => {
                    const lyricsIssue = processingIssues.find((issue) => issue.component === 'lyrics')
                    const activity = lyricsIssue
                      ? retryActivity(
                          selected,
                          lyricsIssue.component,
                          pendingRetries.includes(retryKey(selected.id, lyricsIssue.component)),
                        )
                      : undefined
                    return <div className={`lyrics-empty ${lyricsIssue ? 'has-issue' : ''}`}><Mic2 size={24} />
                      <p>{lyricsIssue ? t(lyricsIssue.reason) : t('Timed lyrics will appear here after local AI processing.')}</p>
                      {lyricsIssue && <strong>{lyricsIssue.state === 'blocked' ? t('Lyrics blocked') : t('Lyrics failed')}</strong>}
                      {lyricsIssue?.retryable && <button data-testid="retry-lyrics"
                        disabled={Boolean(activity) || lyricsAreProtected(selected) || lyricsAreBusy(selected)}
                        onClick={() => void retryFailedDeliverable(selected, lyricsIssue.component)}>
                        {activity ? t(activity) : t('Try again')}
                      </button>}
                    </div>
                  })()}
                </div>
              </div>
            </>
          ) : <div className="no-selection"><Music2 size={34} /><p>{t('Select or add a song to begin.')}</p></div>}
        </section>
      </main>

      <footer className="player">
        <audio ref={audioRef} />
        <div className="player-track"><div className="mini-art"><Music2 size={17} /></div><div>
          <strong>{selected?.title ?? t('No song selected')}</strong>
          <span>{selected ? `${t(modeLabels[mode])} · ${selected.artist}` : t('Add music to begin')}</span></div></div>
        <div className="player-center">
          <button className="skip-button" data-testid="playback-previous" onClick={() => void playPrevious()}
            disabled={!selected} aria-label={t('Previous song')}><SkipBack size={19} fill="currentColor" /></button>
          <button className="play-button" data-testid="playback-toggle" onClick={() => playback.toggle()}
            disabled={!selected} aria-label={isPlaying ? t('Pause') : t('Play')}>
            {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
          </button>
          <button className="skip-button" data-testid="playback-next" onClick={() => void playNext()}
            disabled={!selected} aria-label={t('Next song')}><SkipForward size={19} fill="currentColor" /></button>
          <div className="timeline"><span>{formatTime(currentTime)}</span>
            <input type="range" data-testid="playback-seek" min="0" max={duration || 0} step="0.1"
              value={currentTime} disabled={!selected || duration <= 0} aria-label={t('Playback position')}
              onChange={(event) => seekTo(Number(event.target.value))} /><span>{formatTime(duration)}</span></div>
        </div>
        <div className="player-output-controls">
          <div className={`mic-monitor ${microphone.state}`} data-testid="mic-monitor-state"
            data-context-state={microphone.telemetry.contextState}
            data-context-sample-rate={microphone.telemetry.contextSampleRate}
            data-track-state={microphone.telemetry.trackReadyState}
            data-track-muted={String(microphone.telemetry.trackMuted ?? '')}
            data-track-enabled={String(microphone.telemetry.trackEnabled ?? '')}
            data-track-sample-rate={microphone.telemetry.trackSampleRate}
            data-track-channel-count={microphone.telemetry.trackChannelCount}
            data-track-latency={microphone.telemetry.trackLatency}
            data-echo-cancellation={String(microphone.telemetry.echoCancellation ?? '')}
            data-noise-suppression={String(microphone.telemetry.noiseSuppression ?? '')}
            data-auto-gain-control={String(microphone.telemetry.autoGainControl ?? '')}
            data-base-latency={microphone.telemetry.baseLatency}
            data-output-latency={microphone.telemetry.outputLatency}
            data-input-rms={microphone.telemetry.inputRms?.toFixed(6)}
            data-input-peak={microphone.telemetry.inputPeak?.toFixed(6)}
            data-output-rms={microphone.telemetry.outputRms?.toFixed(6)}
            data-output-peak={microphone.telemetry.outputPeak?.toFixed(6)}
            data-monitor-gain={microphone.gain.toFixed(3)}
            data-echo-enabled={String(microphone.echoEnabled)}
            data-echo-amount={microphone.echoAmount.toFixed(3)}
            data-output-too-hot={String(microphone.telemetry.outputTooHot ?? false)}
            data-output-clipping={String(microphone.telemetry.outputClipping ?? false)}
            data-output-device={microphone.telemetry.outputDevice}>
            <div className="mic-button-group" role="group" aria-label={t('Audio controls')}>
              <button type="button" className={`mic-toggle ${microphone.telemetry.outputTooHot ? 'warning' : ''}`}
                data-testid="mic-monitor-toggle" aria-label={t(microphoneLabel)}
                title={`${microphone.error ? t(microphone.error) : t(microphoneLabel)}. ${microphone.telemetry.outputTooHot ? `${t('Output too hot — lower level')}. ` : ''}${t('Wired headphones recommended. Monitor gain is independent of song volume and uses the system default output.')}`}
                aria-pressed={microphone.state === 'on'} onClick={toggleMicrophoneMonitor}>
                {microphone.state === 'requesting'
                  ? <LoaderCircle className="spin" size={17} />
                  : <Mic2 size={17} />}
              </button>
              <button type="button" className="echo-toggle" data-testid="mic-echo-toggle"
                aria-label={t('Microphone echo')} aria-pressed={microphone.echoEnabled}
                title={t('Microphone echo')} onClick={() => microphone.setEchoEnabled(!microphone.echoEnabled)}>
                <AudioLines size={17} />
              </button>
              <button type="button" data-testid="audio-controls-toggle" popoverTarget="audio-controls-panel"
                aria-label={t('Audio settings')} aria-haspopup="dialog" title={t('Audio settings')}>
                <SlidersHorizontal size={17} />
              </button>
            </div>
            <span className="sr-only" role={microphone.state === 'error' || microphone.telemetry.outputTooHot ? 'alert' : 'status'}>
              {microphone.state === 'error' ? t(microphoneErrorLabel)
                : microphone.telemetry.outputClipping ? t('Clipping — lower Mic monitor level')
                  : microphone.telemetry.outputTooHot ? t('Output too hot — lower level')
                    : microphone.state === 'on' ? t(microphoneStatus)
                      : microphone.state === 'requesting' ? t('Requesting mic…') : t('Mic off')}
            </span>
            <div id="audio-controls-panel" className="audio-controls-panel" popover="auto"
              role="dialog" aria-labelledby="audio-controls-title" data-testid="audio-controls-panel">
              <div className="audio-controls-heading">
                <strong id="audio-controls-title">{t('Audio settings')}</strong>
                <button type="button" popoverTarget="audio-controls-panel" popoverTargetAction="hide"
                  aria-label={t('Close')}><X size={16} /></button>
              </div>
              <span className="mic-status">
                {microphone.state === 'off' && t('Mic off')}
                {microphone.state === 'requesting' && t('Requesting mic…')}
                {microphone.state === 'on' && <>{t(microphoneStatus)}
                  <span className="mic-meter" aria-label={t(`Microphone level ${Math.round(microphoneLevel * 100)} percent`)}>
                    <span style={{ transform: `scaleX(${microphoneLevel})` }} />
                  </span>
                  <small data-testid="mic-monitor-input">
                    {microphone.telemetry.signalDetected ? t('Input detected') : t('Input waiting')}
                  </small>
                  <span className={`mic-meter output ${microphone.telemetry.outputTooHot ? 'hot' : ''}`}
                    aria-label={t(`Monitor output level ${Math.round(monitorOutputLevel * 100)} percent`)}>
                    <span style={{ transform: `scaleX(${monitorOutputLevel})` }} />
                  </span>
                  <small data-testid="mic-monitor-output">
                    {t(`Monitor out ${monitorOutputDb}`)}
                  </small>
                  {monitorLatencyMs !== undefined && <small data-testid="mic-monitor-latency">
                    {t(`${monitorLatencyMs} ms output estimate`)}
                  </small>}
                  <small data-testid="mic-monitor-device">{t('Default output · check Windows if silent')}</small>
                  {microphone.telemetry.outputClipping && <small className="mic-warning" role="alert"
                    data-testid="mic-monitor-clipping">{t('Clipping — lower Mic monitor level')}</small>}
                  {!microphone.telemetry.outputClipping && microphone.telemetry.outputTooHot
                    && <small className="mic-warning" role="alert" data-testid="mic-monitor-too-hot">
                      {t('Output too hot — lower level')}
                    </small>}
                  {noMicrophoneInput && <small data-testid="mic-monitor-no-input">
                    {t('Check mic mute/input device')}
                  </small>}</>}
                {microphone.state === 'error' && t(microphoneErrorLabel)}
              </span>
              <div className="mic-controls">
                <label className="mic-level" htmlFor="mic-monitor-level">
                  <span>{t('Mic monitor level')} <output>{t(monitorGainLabel)}</output></span>
                  <input id="mic-monitor-level" type="range" min={MIN_MONITOR_GAIN} max={MAX_MONITOR_GAIN}
                    step={MONITOR_GAIN_STEP} value={microphone.gain} data-testid="mic-monitor-level"
                    aria-label={t(`Mic monitor level ${monitorGainLabel}`)}
                    onChange={(event) => microphone.setGain(Number(event.target.value))} />
                  <small>{microphone.gain > 2
                    ? t('High boost: use wired headphones; lower it if feedback or clipping starts.')
                    : t('Independent of song volume.')}</small>
                </label>
                <label className="mic-level" htmlFor="mic-echo-amount">
                  <span>{t('Echo amount')} <output>{Math.round(microphone.echoAmount * 100)}%</output></span>
                  <input id="mic-echo-amount" type="range" min="0" max={MAX_ECHO_AMOUNT} step={ECHO_AMOUNT_STEP}
                    value={microphone.echoAmount} disabled={!microphone.echoEnabled}
                    data-testid="mic-echo-amount" aria-label={t('Echo amount')}
                    title={t('Echo affects repeats only; your direct voice is not delayed.')}
                    onChange={(event) => microphone.setEchoAmount(Number(event.target.value))} />
                  <small>{t('Echo affects repeats only; your direct voice is not delayed.')}</small>
                </label>
                <label className="mic-level" htmlFor="player-volume">
                  <span><span><Volume2 size={13} /> {t('Song volume')}</span>
                    <output>{Math.round(volume * 100)}%</output></span>
                  <input id="player-volume" type="range" min="0" max="1" step="0.01"
                    data-testid="player-volume" value={volume} aria-label={t('Volume')}
                    onChange={(event) => setVolume(Number(event.target.value))} />
                </label>
              </div>
            </div>
          </div>
        </div>
      </footer>

      {menuSongId && menuPosition && createPortal((
        <div className="playlist-menu" role="menu" ref={menuRef}
          style={menuPosition} onClick={(event) => event.stopPropagation()} onKeyDown={menuKeyDown}>
          <span>{t('Add to playlist')}</span>
          {playlists.playlists.filter((playlist) => playlist.kind !== 'history').map((playlist) => (
            <button role="menuitem" key={playlist.id} data-testid={`add-to-playlist-${playlist.id}`}
              onClick={() => void addToPlaylist(menuSongId, playlist)}>{playlistDisplayName(settings.uiLocale, playlist)}</button>
          ))}
          <button role="menuitem" data-testid="new-playlist" onClick={() => {
            setCreateForSongId(menuSongId)
            setShowCreatePlaylist(true)
          }}><Plus size={14} /> {t('New playlist…')}</button>
        </div>
      ), document.body)}

      {showCreatePlaylist && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setShowCreatePlaylist(false)
        }}>
          <form className="playlist-dialog" role="dialog" aria-modal="true" aria-labelledby="playlist-dialog-title"
            onSubmit={(event) => void createPlaylist(event)}>
            <div><h2 id="playlist-dialog-title">{t('New playlist')}</h2>
              <button type="button" aria-label={t('Close')} onClick={() => setShowCreatePlaylist(false)}><X size={18} /></button></div>
            <label>{t('Playlist name')}<input autoFocus data-testid="playlist-name" value={playlistName}
              onChange={(event) => setPlaylistName(event.target.value)} maxLength={80} /></label>
            <button className="primary-button" data-testid="playlist-create-confirm" type="submit"
              disabled={!playlistName.trim()}>{t('Create playlist')}</button>
          </form>
        </div>
      )}
      {confirmClear && selectedPlaylist && (
        <div className="dialog-backdrop" role="presentation">
          <div className="playlist-dialog" role="alertdialog" aria-modal="true"
            aria-labelledby="playlist-clear-title">
            <div><h2 id="playlist-clear-title">{t(`Clear ${playlistDisplayName(settings.uiLocale, selectedPlaylist)}?`)}</h2>
              <button aria-label={t('Cancel clearing playlist')} onClick={() => setConfirmClear(false)}>
                <X size={18} />
              </button></div>
            <p>{t('Every entry will be removed. Your library songs will stay on this PC.')}</p>
            <div className="dialog-actions">
              <button onClick={() => setConfirmClear(false)}>{t('Cancel')}</button>
              <button className="danger-button" data-testid="playlist-clear-confirm" onClick={() => {
                setConfirmClear(false)
                void clearCurrentPlaylist()
              }}>{t('Clear playlist')}</button>
            </div>
          </div>
        </div>
      )}
      {showRenamePlaylist && selectedPlaylist?.kind === 'playlist' && (
        <div className="dialog-backdrop" role="presentation">
          <form className="playlist-dialog" role="dialog" aria-modal="true"
            aria-labelledby="playlist-rename-title" onSubmit={(event) => void renameCurrentPlaylist(event)}>
            <div><h2 id="playlist-rename-title">{t('Rename playlist')}</h2>
              <button type="button" aria-label={t('Cancel renaming playlist')}
                onClick={() => setShowRenamePlaylist(false)}><X size={18} /></button></div>
            <label>{t('Playlist name')}<input autoFocus value={renameName}
              onChange={(event) => setRenameName(event.target.value)} maxLength={80} /></label>
            <button className="primary-button" type="submit" disabled={!renameName.trim()}>{t('Save name')}</button>
          </form>
        </div>
      )}
      {confirmDelete && selectedPlaylist?.kind === 'playlist' && (
        <div className="dialog-backdrop" role="presentation">
          <div className="playlist-dialog" role="alertdialog" aria-modal="true"
            aria-labelledby="playlist-delete-title">
            <div><h2 id="playlist-delete-title">{t(`Delete ${selectedPlaylist.name}?`)}</h2>
              <button aria-label={t('Cancel deleting playlist')} onClick={() => setConfirmDelete(false)}>
                <X size={18} />
              </button></div>
            <p>{t('The playlist will be deleted. Its songs will remain in your library.')}</p>
            <div className="dialog-actions">
              <button onClick={() => setConfirmDelete(false)}>{t('Cancel')}</button>
              <button className="danger-button" onClick={() => void deleteCurrentPlaylist()}>{t('Delete playlist')}</button>
            </div>
          </div>
        </div>
      )}
      {lyricsEditor && (
        <div className="dialog-backdrop lyrics-editor-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) requestCloseLyricsEditor()
        }}>
          <div className="playlist-dialog lyrics-editor" role="dialog" aria-modal="true" aria-labelledby="lyrics-editor-title"
            aria-describedby="lyrics-editor-status" data-testid="lyrics-editor" data-song-id={lyricsEditor.songId}
            ref={lyricsEditorDialogRef}>
            <div><h2 id="lyrics-editor-title">{t('Edit lyrics')}</h2>
              <button type="button" aria-label={t('Cancel lyrics edit')} onClick={requestCloseLyricsEditor}>
                <X size={18} /></button></div>
            <p>{lyricsEditor.songTitle}</p>
            {lyricsEditor.discardPrompt ? (
              <>
                <p className="lyrics-editor-status" id="lyrics-editor-status" data-testid="lyrics-editor-status" role="alert" data-state="conflict">
                  {t(lyricsEditorStatusMessage({
                    draft: lyricsEditor,
                    busy: false,
                  }))}
                </p>
                <div className="dialog-actions">
                  <button type="button" onClick={() => {
                    const songId = lyricsEditor.songId
                    setLyricsEditor((current) => reduceLyricsEditor(current, { type: 'keep-editing' }))
                    if (songId !== selectedId) selectLibrarySong(songId)
                  }}>
                    {t('Keep editing')}
                  </button>
                  <button type="button" className="danger-button" data-testid="lyrics-editor-discard"
                    onClick={() => setLyricsEditor((current) => reduceLyricsEditor(current, { type: 'confirm-discard' }))}>
                    {t('Discard')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <label>{t('Lyrics')}
                  <textarea data-testid="lyrics-editor-text" value={lyricsEditor.text.replace(/\r\n?/g, '\n')} spellCheck={false}
                    disabled={lyricsEditor.saving} aria-label={t('Lyrics')}
                    onChange={(event) => {
                      const text = event.target.value
                      const paste = lyricsPasteRef.current
                      lyricsPasteRef.current = null
                      setLyricsEditor((current) => reduceLyricsEditor(current, {
                        type: 'edit',
                        text: paste && paste.songId === current?.songId && paste.previousText === current.text
                          && paste.expectedInput === text ? paste.text : editorTextFromInput(current?.text ?? '', text),
                      }))
                    }}
                    onPaste={(event) => {
                      const element = event.currentTarget
                      const { selectionStart, selectionEnd } = element
                      const inserted = event.clipboardData.getData('text/plain')
                      const text = replaceEditorSelection(lyricsEditor.text, selectionStart, selectionEnd, inserted)
                      lyricsPasteRef.current = {
                        songId: lyricsEditor.songId,
                        previousText: lyricsEditor.text,
                        text,
                        expectedInput: text.replace(/\r\n?/g, '\n'),
                      }
                    }} />
                </label>
                <p className="lyrics-editor-status" id="lyrics-editor-status" data-testid="lyrics-editor-status" data-state={
                  lyricsEditor.conflict || lyricsEditor.saveState === 'failed' || editorRematchFailed ? 'failed' : lyricsEditor.saveState
                } role={lyricsEditor.conflict || lyricsEditor.saveState === 'failed' || editorRematchFailed ? 'alert' : 'status'}>
                  {t(lyricsEditorStatusMessage({
                    draft: lyricsEditor,
                    songId: editorSong?.id,
                    songRevision: editorSong?.lyricsRevision,
                    songRematchStatus: editorSong?.lyricRematchStatus,
                    songRematchMessage: editorSong?.lyricRematchMessage,
                    busy: lyricsAreBusy(editorSong),
                  }))}
                </p>
                <div className="dialog-actions">
                  {lyricsEditor.conflict && (
                    <button type="button" data-testid="lyrics-editor-reload" onClick={reloadSavedLyrics}>
                      {t('Load saved lyrics')}
                    </button>
                  )}
                  <button type="button" onClick={requestCloseLyricsEditor}>{t('Cancel')}</button>
                  <button type="button" className="primary-button" data-testid="lyrics-editor-update"
                    disabled={lyricsEditor.saving || !hasUsableLyricLines(lyricsEditor.text)
                      || lyricsAreBusy(songs.find((song) => song.id === lyricsEditor.songId))}
                    onClick={() => void submitLyricsUpdate()}>
                    {lyricsEditor.saving ? t('Saving…') : t('Update')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {notice && <button className="notice-toast" role="status" onClick={() => setNotice(undefined)}
        aria-label={`${noticeText} ${t('Dismiss')}`}>{noticeText}</button>}
      {error && <button className="error-toast" role="alert" onClick={() => setError(undefined)}
        aria-label={`${errorText}. ${t('Dismiss')}`}>{errorText}</button>}
    </div>
  )
}

export default App
