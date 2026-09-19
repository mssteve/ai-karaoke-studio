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
  Playlist,
  PlaylistEntry,
  PlaylistStore,
  PlaylistTransitionReason,
  ProcessUpdate,
  ProcessingComponentId,
  ProcessingItem,
  ProcessingItemId,
  Song,
} from './types'
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
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
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
  const songsRef = useRef<Song[]>([])
  const menuRef = useRef<HTMLDivElement>(null)
  const menuButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const lyricRefs = useRef<Array<HTMLButtonElement | null>>([])
  const handledEndRef = useRef<string | undefined>(undefined)
  const pendingRetryKeysRef = useRef(new Set<string>())

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
  const queue = playlists.playlists.find((playlist) => playlist.kind === 'queue')
  const history = playlists.playlists.find((playlist) => playlist.kind === 'history')
  const playback = usePlaybackController({ selected, mode, onError: showError })
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
    if (!selected || getModeSource(selected, mode)) return
    setMode('original')
    setNotice(`${modeLabels[mode]} became unavailable; continuing with Original.`)
  }, [selected, mode])

  useEffect(() => {
    Promise.all([karaokeApi.getLibrary(), karaokeApi.getPlaylists()])
      .then(([librarySongs, store]) => {
        setSongs(librarySongs)
        setPlaylists(store)
        const restoredPlaylist = store.playlists.find((item) => item.id === store.selectedPlaylistId)
        const restoredEntry = restoredPlaylist?.entries.find((entry) => entry.id === restoredPlaylist.currentEntryId)
        if (restoredEntry && librarySongs.some((song) => song.id === restoredEntry.songId)) {
          setSelectedId(restoredEntry.songId)
          setActivePlaylistId(restoredPlaylist?.id)
          setActiveEntryId(restoredEntry.id)
        } else {
          setSelectedId(librarySongs[0]?.id)
        }
      })
      .catch((reason) => showError('Unable to load saved songs and playlists', reason))
      .finally(() => setIsLoading(false))

    return karaokeApi.onProcessUpdate((update: ProcessUpdate) => {
      setSongs((current) => current.map((song) => song.id === update.songId
        ? mergeProcessUpdate(song, update)
        : song))
    })
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

    if (detachedNext) {
      const playlist = playlists.playlists.find((item) => item.id === detachedNext.playlistId)
      const entry = playlist?.entries.find((item) => item.id === detachedNext.entryId)
      setDetachedNext(undefined)
      if (playlist && entry) void activatePlaylistEntry(playlist, entry, 'entry-removed', true, mode)
      return
    }

    const playlist = playlists.playlists.find((item) => item.id === activePlaylistId)
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
      error,
    })
  }, [
    selected?.id, selected?.lyricLanguage, mode, playback.loadedSourceKey, playbackStatus, currentTime, duration,
    activeLyricIndex, error, playlists, activePlaylistId, activeEntryId, detachedNext,
    transitionReason, transitionCount,
  ])

  function showError(message: string, reason?: unknown) {
    const detail = reason instanceof Error ? reason.message : reason === undefined ? undefined : String(reason)
    setError(detail ? `${message}: ${detail}` : message)
    void karaokeApi.reportRendererError(message, detail).catch(() => undefined)
  }

  function markTransition(reason: PlaylistTransitionReason) {
    setTransitionReason(reason)
    setTransitionCount((count) => count + 1)
    setSelectionGeneration((generation) => generation + 1)
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
    if (id === selectedId && !activeEntryId) return
    setActivePlaylistId(undefined)
    setActiveEntryId(undefined)
    setDetachedNext(undefined)
    markTransition('manual-library')
    startSong(id, 'original', false)
  }

  function playLibrarySong(song: Song) {
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
    try {
      const store = await karaokeApi.setPlaylistCursor({
        playlistId: playlist.id,
        entryId: entry.id,
        expectedUpdatedAt: playlist.updatedAt,
      })
      setPlaylists(store)
      setActivePlaylistId(playlist.id)
      setActiveEntryId(entry.id)
      setDetachedNext(undefined)
      markTransition(reason)
      startSong(song.id, nextMode, autoPlay)
    } catch (reasonValue) {
      showError('Unable to select the playlist entry', reasonValue)
    }
  }

  async function finishQueueEntry(playlist: Playlist, entry: PlaylistEntry, autoPlayNext: boolean) {
    try {
      const store = await karaokeApi.archiveQueueEntry({
        playlistId: playlist.id,
        entryId: entry.id,
        expectedUpdatedAt: playlist.updatedAt,
      })
      setPlaylists(store)
      const updatedQueue = store.playlists.find((item) => item.kind === 'queue')
      const nextEntry = updatedQueue?.entries[0]
      if (updatedQueue && nextEntry) {
        await activatePlaylistEntry(updatedQueue, nextEntry, 'natural-end', autoPlayNext, mode)
      } else {
        playback.pause()
        setActivePlaylistId(undefined)
        setActiveEntryId(undefined)
        setPendingAutoPlay(false)
        markTransition('natural-end')
      }
    } catch (reason) {
      showError('Unable to move the played song to History', reason)
    }
  }

  async function playNext() {
    const playlist = playlists.playlists.find((item) => item.id === activePlaylistId)
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
    const playlist = playlists.playlists.find((item) => item.id === activePlaylistId)
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
    try {
      const wasSelected = selectedId === song.id
      const librarySongs = await karaokeApi.removeSong(song.id)
      const store = await karaokeApi.getPlaylists()
      setSongs(librarySongs)
      setPlaylists(store)
      if (wasSelected) {
        playback.pause()
        playback.resetForSong()
        setSelectedId(librarySongs[0]?.id)
        setMode('original')
        setActivePlaylistId(undefined)
        setActiveEntryId(undefined)
        markTransition('song-removed')
      }
    } catch (reason) {
      showError(`Unable to remove ${song.title}`, reason)
    }
  }

  async function choosePlaylist(playlist: Playlist) {
    try {
      const store = await karaokeApi.selectPlaylist({ playlistId: playlist.id })
      setPlaylists(store)
    } catch (reason) {
      showError('Unable to open the playlist', reason)
    }
  }

  async function addToPlaylist(songId: string, playlist: Playlist) {
    try {
      const store = await karaokeApi.addSongToPlaylist({
        playlistId: playlist.id,
        songId,
        expectedUpdatedAt: playlist.updatedAt,
      })
      setPlaylists(store)
      setNotice(`Added to ${playlist.name}.`)
      closeMenu()
    } catch (reason) {
      showError(`Unable to add the song to ${playlist.name}`, reason)
    }
  }

  async function createPlaylist(event: React.FormEvent) {
    event.preventDefault()
    try {
      let store = await karaokeApi.createPlaylist({ name: playlistName })
      const created = store.playlists.at(-1)
      if (created && createForSongId) {
        store = await karaokeApi.addSongToPlaylist({
          playlistId: created.id,
          songId: createForSongId,
          expectedUpdatedAt: created.updatedAt,
        })
        setNotice(`Created ${created.name} and added the song.`)
      } else if (created) {
        store = await karaokeApi.selectPlaylist({ playlistId: created.id })
        setNotice(`Created ${created.name}.`)
      }
      setPlaylists(store)
      setPlaylistName('')
      setShowCreatePlaylist(false)
      setCreateForSongId(undefined)
      closeMenu()
    } catch (reason) {
      showError('Unable to create the playlist', reason)
    }
  }

  async function removeEntry(playlist: Playlist, entry: PlaylistEntry) {
    const index = playlist.entries.findIndex((item) => item.id === entry.id)
    const followingCandidate = playlist.entries[index + 1]
    const pausedCandidate = followingCandidate ?? playlist.entries[index - 1]
    const removingActive = activePlaylistId === playlist.id && activeEntryId === entry.id
    try {
      const store = await karaokeApi.removePlaylistEntry({
        playlistId: playlist.id,
        entryId: entry.id,
        expectedUpdatedAt: playlist.updatedAt,
      })
      setPlaylists(store)
      if (!removingActive) return
      if (isPlaying) {
        setActiveEntryId(undefined)
        setDetachedNext(followingCandidate ? { playlistId: playlist.id, entryId: followingCandidate.id } : undefined)
        markTransition('entry-removed')
      } else if (pausedCandidate) {
        const updatedPlaylist = store.playlists.find((item) => item.id === playlist.id)
        const updatedEntry = updatedPlaylist?.entries.find((item) => item.id === pausedCandidate.id)
        if (updatedPlaylist && updatedEntry) {
          await activatePlaylistEntry(updatedPlaylist, updatedEntry, 'entry-removed', false)
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
    try {
      const store = await karaokeApi.clearPlaylist({
        playlistId: selectedPlaylist.id,
        expectedUpdatedAt: selectedPlaylist.updatedAt,
      })
      setPlaylists(store)
      if (activePlaylistId === selectedPlaylist.id) {
        playback.pause()
        setActivePlaylistId(undefined)
        setActiveEntryId(undefined)
      }
    } catch (reason) {
      showError('Unable to clear the playlist', reason)
    }
  }

  async function renameCurrentPlaylist(event: React.FormEvent) {
    event.preventDefault()
    if (!selectedPlaylist || selectedPlaylist.kind === 'queue') return
    try {
      const store = await karaokeApi.renamePlaylist({
        playlistId: selectedPlaylist.id,
        name: renameName,
        expectedUpdatedAt: selectedPlaylist.updatedAt,
      })
      setPlaylists(store)
      setShowRenamePlaylist(false)
      setNotice(`Renamed playlist to ${renameName.trim()}.`)
    } catch (reason) {
      showError('Unable to rename the playlist', reason)
    }
  }

  async function deleteCurrentPlaylist() {
    if (!selectedPlaylist || selectedPlaylist.kind === 'queue') return
    try {
      const deletingId = selectedPlaylist.id
      const store = await karaokeApi.deletePlaylist({
        playlistId: deletingId,
        expectedUpdatedAt: selectedPlaylist.updatedAt,
      })
      setPlaylists(store)
      setConfirmDelete(false)
      if (activePlaylistId === deletingId) {
        setActivePlaylistId(undefined)
        setActiveEntryId(undefined)
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

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="brand-mark"><AudioLines size={18} /></div>
        <span className="brand-name">Karaoke Studio</span>
        <span className="privacy-pill"><HardDrive size={12} /> Private · On-device AI</span>
        <button className="diagnostics-link" onClick={() => void karaokeApi.openDiagnostics()
          .catch((reason) => showError('Unable to open diagnostics', reason))} aria-label="Open diagnostics folder">
          <Bug size={12} /> Diagnostics
        </button>
      </header>

      <aside className="sidebar">
        <nav aria-label="Main navigation">
          <button data-testid="nav-library" className={`nav-item ${view === 'library' ? 'active' : ''}`}
            aria-current={view === 'library' ? 'page' : undefined} onClick={() => setView('library')}>
            <Library size={18} /> Library
          </button>
          <button data-testid="nav-playlists" className={`nav-item ${view === 'playlists' ? 'active' : ''}`}
            aria-current={view === 'playlists' ? 'page' : undefined} onClick={() => setView('playlists')}>
            <ListMusic size={18} /> Playlists
          </button>
        </nav>
        <div className="sidebar-spacer" />
        <div className="local-card">
          <div className="local-card-icon"><WandSparkles size={18} /></div>
          <div><strong>Runs locally</strong><p>Your music never leaves this PC.</p></div>
        </div>
      </aside>

      <main className="content">
        <section className="library-pane">
          {view === 'library' ? (
            <>
              <div className="page-heading">
                <div><span className="eyebrow">YOUR COLLECTION</span><h1>Song Library</h1>
                  <p>{songs.length} {songs.length === 1 ? 'track' : 'tracks'} ready for your next performance</p></div>
                <button className="primary-button" data-testid="add-songs" onClick={importSongs} disabled={isImporting}>
                  {isImporting ? <LoaderCircle className="spin" size={18} /> : <Plus size={18} />}
                  {isImporting ? 'Adding…' : 'Add songs'}
                </button>
              </div>
              <div className="toolbar">
                <label className="search"><Search size={17} /><input value={query}
                  onChange={(event) => setQuery(event.target.value)} placeholder="Search songs or artists" /></label>
                <span className="filter-button">FIFO playlists <ChevronRight size={15} /></span>
              </div>
              {isLoading ? (
                <div className="empty-state loading-state" role="status"><span className="empty-icon">
                  <LoaderCircle className="spin" size={30} /></span><strong>Loading your library</strong>
                  <span>Finding songs stored on this PC.</span></div>
              ) : songs.length === 0 ? (
                <button className="empty-state" onClick={importSongs} disabled={isImporting}>
                  <span className="empty-icon"><Music2 size={30} /></span><strong>Bring your music to the stage</strong>
                  <span>Import MP3 or MP4 files to create karaoke versions with local AI.</span>
                  <span className="empty-action"><FolderOpen size={16} /> Choose songs</span>
                </button>
              ) : (
                <div className="song-list" role="listbox" aria-label="Song library">
                  <div className="song-list-header"><span>TRACK</span><span>STATUS</span><span>ADDED</span><span /></div>
                  {filteredSongs.map((song, index) => {
                    const isSelected = selected?.id === song.id
                    const isProcessing = ['preparing', 'separating', 'enhancing', 'transcribing'].includes(song.processingStage)
                    return (
                      <div className={`song-row ${isSelected ? 'selected' : ''}`} key={song.id}>
                        <button className="song-select" data-testid="song-row" data-song-id={song.id}
                          role="option" aria-selected={isSelected}
                          onClick={() => selectLibrarySong(song.id)}
                          onDoubleClick={() => playLibrarySong(song)}
                          aria-label={`Select ${song.title} by ${song.artist}`}>
                          <span className="track-cell"><span className="track-art">
                            {isSelected && isPlaying ? <AudioLines size={19} /> : <span>{index + 1}</span>}
                          </span><span className="track-copy"><strong>{song.title}</strong>
                            <small>{song.artist} · {song.format.toUpperCase()}</small></span></span>
                        </button>
                        <span>{song.processingStage === 'queued' ? (
                          <span className="status queued"><Clock3 size={13} /> {song.processingDetails?.queuePosition
                            ? `Queued #${song.processingDetails.queuePosition}` : 'Queued'}</span>
                        ) : isProcessing ? (
                          <span className="status processing"><LoaderCircle className="spin" size={13} />
                            {song.processingProgress}%</span>
                        ) : song.processingStage === 'complete' ? (
                          <span className="status ready"><Check size={13} /> Karaoke ready</span>
                        ) : song.processingStage === 'partial' ? (
                          <span className="status partial">Partial · {[song.enhancedUrl, song.vocalUrl, song.instrumentalUrl]
                            .filter(Boolean).length + 1} modes</span>
                        ) : song.processingStage === 'error' ? (
                          <span className="status error">Needs attention</span>
                        ) : <span className="status original">Original</span>}</span>
                        <span className="date-cell">{new Date(song.addedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                        <span className="row-actions">
                          <button data-testid={`song-menu-${song.id}`} ref={(button) => {
                            if (button) menuButtonRefs.current.set(song.id, button)
                          }} aria-label={`Add ${song.title} to a playlist`} aria-haspopup="menu"
                            aria-expanded={menuSongId === song.id}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.stopPropagation()
                              openMenu(song.id, event.currentTarget)
                            }}
                            onDoubleClick={(event) => event.stopPropagation()}><Plus size={18} /></button>
                          <button data-testid="remove-song" aria-label={`Remove ${song.title} from library`}
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
              <div className="page-heading"><div><span className="eyebrow">FIFO COLLECTIONS</span><h1>Playlists</h1>
                <p>Queue order is preserved exactly as added.</p></div>
                <button className="primary-button" onClick={() => {
                  setCreateForSongId(undefined)
                  setShowCreatePlaylist(true)
                }}><Plus size={18} /> New playlist</button>
              </div>
              <div className="playlist-layout">
                <div className="playlist-tabs" aria-label="Saved playlists">
                  {playlists.playlists.map((playlist) => (
                    <button key={playlist.id} data-testid={`playlist-${playlist.id}`}
                      className={selectedPlaylist?.id === playlist.id ? 'active' : ''}
                      aria-current={selectedPlaylist?.id === playlist.id ? 'true' : undefined}
                      onClick={() => void choosePlaylist(playlist)}>
                      <ListMusic size={15} /><span>{playlist.name}</span><small>{playlist.entries.length}</small>
                    </button>
                  ))}
                </div>
                <div className="playlist-contents">
                  <div className="playlist-heading"><div><span className="eyebrow">PLAYING IN ORDER</span>
                    <h2>{selectedPlaylist?.name ?? 'Playlist'}</h2></div>
                    <div>
                      <button data-testid="playlist-play" disabled={!selectedPlaylist?.entries.length} onClick={() => {
                        if (!selectedPlaylist) return
                        const entry = selectedPlaylist.entries.find((item) => item.id === selectedPlaylist.currentEntryId)
                          ?? selectedPlaylist.entries[0]
                        if (entry) void activatePlaylistEntry(selectedPlaylist, entry, 'manual-playlist', true)
                      }}><Play size={15} /> Play</button>
                      <button data-testid="playlist-clear" disabled={!selectedPlaylist?.entries.length}
                        onClick={() => setConfirmClear(true)}><Trash2 size={15} /> Clear</button>
                      {selectedPlaylist?.kind === 'playlist' && (
                        <>
                          <button onClick={() => {
                            setRenameName(selectedPlaylist.name)
                            setShowRenamePlaylist(true)
                          }}>Rename</button>
                          <button onClick={() => setConfirmDelete(true)}>Delete</button>
                        </>
                      )}
                    </div>
                  </div>
                  {!selectedPlaylist?.entries.length ? (
                    <div className="playlist-empty"><ListMusic size={28} /><strong>No songs yet</strong>
                      <span>{selectedPlaylist?.kind === 'history'
                        ? 'Songs move here after they finish playing from Queue.'
                        : 'Use a song’s plus menu in Library to add it here.'}</span></div>
                  ) : (
                    <ol className="playlist-entries">
                      {selectedPlaylist.entries.map((entry, index) => {
                        const song = songs.find((item) => item.id === entry.songId)
                        const current = activePlaylistId === selectedPlaylist.id && activeEntryId === entry.id
                        return (
                          <li key={entry.id} className={current ? 'current' : ''}>
                            <button data-testid={`playlist-entry-${entry.id}`}
                                  onClick={() => void activatePlaylistEntry(selectedPlaylist, entry, 'manual-playlist', false)}>
                              <span>{index + 1}</span><span><strong>{song?.title ?? 'Missing song'}</strong>
                                <small>{song?.artist ?? 'Unavailable'}</small></span>
                              {current && <span className="queue-current">Current</span>}
                            </button>
                            <button data-testid={`playlist-remove-${entry.id}`}
                              aria-label={`Remove ${song?.title ?? 'song'} from ${selectedPlaylist.name}`}
                              onClick={() => void removeEntry(selectedPlaylist, entry)}><X size={16} /></button>
                          </li>
                        )
                      })}
                    </ol>
                  )}
                </div>
              </div>
            </div>
          )}
        </section>

        <section className="studio-pane">
          {selected ? (
            <>
              <div className="now-playing"><div className="large-art"><Disc3 size={58} strokeWidth={1.3} />
                <span className={isPlaying ? 'pulse-ring playing' : 'pulse-ring'} /></div>
                <span className="eyebrow">NOW SELECTED</span><h2>{selected.title}</h2><p>{selected.artist}</p></div>
              <div className="mode-switch" role="group" aria-label="Audio version">
                {(['original', 'enhanced', 'vocal', 'instrumental'] as AudioMode[]).map((audioMode) => (
                  <button key={audioMode} className={mode === audioMode ? 'active' : ''}
                    data-testid={`mode-${audioMode}`} disabled={!modeAvailability(selected, audioMode).available}
                    aria-describedby={!modeAvailability(selected, audioMode).available
                      ? `mode-${audioMode}-reason` : undefined}
                    onClick={() => switchMode(audioMode)}>
                    {audioMode === 'original' ? <Music2 size={15} /> : audioMode === 'enhanced'
                      ? <Sparkles size={15} /> : audioMode === 'vocal' ? <Mic2 size={15} />
                        : <SlidersHorizontal size={15} />} {modeLabels[audioMode]}
                  </button>
                ))}
                {(['original', 'enhanced', 'vocal', 'instrumental'] as AudioMode[]).map((audioMode) => {
                  const availability = modeAvailability(selected, audioMode)
                  return !availability.available ? (
                    <span className="sr-only" id={`mode-${audioMode}-reason`} key={`${audioMode}-reason`}>
                      {availability.reason}
                    </span>
                  ) : null
                })}
              </div>
              {selectedEnhancedSummary && (
                <div className="enhanced-summary" data-testid="enhanced-summary">
                  <Sparkles size={15} aria-hidden="true" />
                  <div><strong>Enhanced auto-balanced</strong>
                    <span>{selectedEnhancedSummary.measurements} · {selectedEnhancedSummary.adjustments}</span>
                    {(selectedEnhancedSummary.cleanup || selectedEnhancedSummary.caveat)
                      && <small>{selectedEnhancedSummary.cleanup ?? selectedEnhancedSummary.caveat}</small>}
                  </div>
                </div>
              )}
              {(selected.processingStage !== 'complete' || needsLanguageRefresh || processingIssues.length > 0) && (
                <div className={`ai-card ${selected.processingStage === 'error' ? 'failed' : ''}`}>
                  <div className="ai-card-top"><span className="ai-icon"><WandSparkles size={19} /></span>
                    <div><strong>{needsLanguageRefresh
                      ? 'Refresh original-language lyrics'
                      : selected.processingStage === 'idle' ? 'Create karaoke version'
                        : processingIssues.length ? 'Some components need attention'
                          : 'Local AI is working'}</strong>
                      <p>{selected.processingMessage ?? (needsLanguageRefresh
                        ? 'Reuse the existing vocal stem to detect the original language and correct timed lyrics.'
                        : 'Create four audio versions and synchronized lyrics.')}</p></div></div>
                  {processingDetails && selected.processingStage !== 'idle' && (
                    <div className="processing-detail" data-testid="processing-detail"
                      aria-label={`Local AI progress for ${selected.title}`}>
                      <div className="processing-summary" role="status" aria-live="polite">
                        <div>
                          <span>{selected.processingStage === 'queued'
                            ? 'Waiting to start'
                            : activeProcessingItem?.label
                              ?? (selected.processingStage === 'error' || selected.processingStage === 'partial'
                                ? 'Processing needs attention' : 'Finalizing')}</span>
                          <strong data-testid="processing-action">{selected.processingMessage}</strong>
                        </div>
                        {selected.processingStage !== 'queued'
                          && <b data-testid="processing-overall">{Math.round(selected.processingProgress)}%</b>}
                      </div>
                      {selected.processingStage !== 'queued' && (
                        <div className="progress-track" role="progressbar"
                          aria-label="Overall karaoke processing progress" aria-valuemin={0} aria-valuemax={100}
                          aria-valuenow={Math.round(selected.processingProgress)}>
                          <span style={{ width: `${Math.max(0, Math.min(100, selected.processingProgress))}%` }} />
                        </div>
                      )}
                      <div className="processing-checklist" role="list" aria-label="Karaoke deliverables">
                        {visibleProcessingGroups.map(({ item, children }) => (
                          <div className={`processing-item ${item.status}`} data-status={item.status}
                            data-testid={`processing-item-${item.id}`} role="listitem" key={item.id}>
                            <span className="processing-state"><ProcessingStatusIcon item={item} /></span>
                            <div className="processing-copy">
                              <div><strong>{item.label}</strong>
                                <span>{processingStatusLabels[item.status]}{item.id === 'demucs' && children?.length
                                  ? ` · ${children.filter((child) => child.status === 'complete').length}/${children.length} stems`
                                  : ''}</span></div>
                              {processingItemDetail(item) && <small>{processingItemDetail(item)}</small>}
                              {item.error && item.error !== item.message
                                && <small className="processing-error">{item.error}</small>}
                              {children?.length ? (
                                <div className="processing-children" aria-label={`${item.label} details`}>
                                  {children.map((child) => (
                                    <span key={child.id} className={child.status} data-status={child.status}
                                      title={processingItemDetail(child) || processingStatusLabels[child.status]}>
                                      <ProcessingStatusIcon item={child} /> {child.label}
                                      <em>{processingStatusLabels[child.status]}</em>
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
                    <div className="deliverable-issues" aria-label="Processing issues">
                      {processingIssues.filter((issue) => issue.component !== 'lyrics').map((issue) => {
                        const activity = retryActivity(
                          selected,
                          issue.component,
                          pendingRetries.includes(retryKey(selected.id, issue.component)),
                        )
                        return (
                          <div className={`deliverable-issue ${issue.state}`} data-testid={`deliverable-${issue.component}`}
                            key={issue.component}>
                            <div><strong>{issue.label}</strong><span>{issue.state === 'blocked' ? 'Blocked' : 'Failed'}</span></div>
                            <p>{issue.reason}</p>
                            {issue.retryable && (
                              <button data-testid={`retry-${issue.component}`}
                                disabled={Boolean(activity)}
                                onClick={() => void retryFailedDeliverable(selected, issue.component)}>
                                {activity ?? 'Try again'}
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
                      aria-label="Overall karaoke processing progress" aria-valuemin={0} aria-valuemax={100}
                      aria-valuenow={Math.round(selected.processingProgress)}>
                      <span style={{ width: `${Math.max(0, Math.min(100, selected.processingProgress))}%` }} />
                    </div>}
                  {(selected.processingStage === 'idle' || needsLanguageRefresh) && (
                  <button className="ai-action" data-testid={needsLanguageRefresh ? 'refresh-lyrics-language' : undefined}
                    onClick={needsLanguageRefresh ? retranscribeSelected : processSelected}
                    disabled={['queued', 'preparing', 'separating', 'enhancing', 'transcribing'].includes(selected.processingStage)}>
                    {['queued', 'preparing', 'separating', 'enhancing', 'transcribing'].includes(selected.processingStage)
                      ? <><LoaderCircle className="spin" size={16} /> {selected.processingStage === 'queued'
                        ? 'Queued' : `Processing ${selected.processingProgress}%`}</>
                      : <><Sparkles size={16} /> {needsLanguageRefresh
                        ? selected.processingStage === 'error' ? 'Retry lyrics refresh' : 'Refresh lyrics & language'
                        : 'Extract with local AI'}</>}
                  </button>
                  )}
                </div>
              )}
              <div className="lyrics-panel">
                <div className="panel-title"><div><span className="eyebrow">SYNCED</span><h3>Lyrics</h3></div>
                  <span data-testid="lyrics-language"><Clock3 size={13} />
                    {selected.lyricLanguage.languageName} ({selected.lyricLanguage.languageCode}) · {selected.lyrics.length ? 'Timed' : 'Waiting'}
                  </span></div>
                {lyricsTimingSummary(selected) && (
                  <p className="lyrics-timing-warning" data-testid="lyrics-timing-warning">
                    {lyricsTimingSummary(selected)}
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
                      <p>{lyricsIssue?.reason ?? 'Timed lyrics will appear here after local AI processing.'}</p>
                      {lyricsIssue && <strong>{lyricsIssue.state === 'blocked' ? 'Lyrics blocked' : 'Lyrics failed'}</strong>}
                      {lyricsIssue?.retryable && <button data-testid="retry-lyrics" disabled={Boolean(activity)}
                        onClick={() => void retryFailedDeliverable(selected, lyricsIssue.component)}>
                        {activity ?? 'Try again'}
                      </button>}
                    </div>
                  })()}
                </div>
              </div>
            </>
          ) : <div className="no-selection"><Music2 size={34} /><p>Select or add a song to begin.</p></div>}
        </section>
      </main>

      <footer className="player">
        <audio ref={audioRef} />
        <div className="player-track"><div className="mini-art"><Music2 size={17} /></div><div>
          <strong>{selected?.title ?? 'No song selected'}</strong>
          <span>{selected ? `${modeLabels[mode]} · ${selected.artist}` : 'Add music to begin'}</span></div></div>
        <div className="player-center">
          <button className="skip-button" data-testid="playback-previous" onClick={() => void playPrevious()}
            disabled={!selected} aria-label="Previous song"><SkipBack size={19} fill="currentColor" /></button>
          <button className="play-button" data-testid="playback-toggle" onClick={() => playback.toggle()}
            disabled={!selected} aria-label={isPlaying ? 'Pause' : 'Play'}>
            {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
          </button>
          <button className="skip-button" data-testid="playback-next" onClick={() => void playNext()}
            disabled={!selected} aria-label="Next song"><SkipForward size={19} fill="currentColor" /></button>
          <div className="timeline"><span>{formatTime(currentTime)}</span>
            <input type="range" data-testid="playback-seek" min="0" max={duration || 0} step="0.1"
              value={currentTime} disabled={!selected || duration <= 0} aria-label="Playback position"
              onChange={(event) => seekTo(Number(event.target.value))} /><span>{formatTime(duration)}</span></div>
        </div>
        <div className="volume"><Volume2 size={17} /><input type="range" min="0" max="1" step="0.01"
          value={volume} aria-label="Volume" onChange={(event) => setVolume(Number(event.target.value))} /></div>
      </footer>

      {menuSongId && menuPosition && createPortal((
        <div className="playlist-menu" role="menu" ref={menuRef}
          style={menuPosition} onClick={(event) => event.stopPropagation()} onKeyDown={menuKeyDown}>
          <span>Add to playlist</span>
          {playlists.playlists.filter((playlist) => playlist.kind !== 'history').map((playlist) => (
            <button role="menuitem" key={playlist.id} data-testid={`add-to-playlist-${playlist.id}`}
              onClick={() => void addToPlaylist(menuSongId, playlist)}>{playlist.name}</button>
          ))}
          <button role="menuitem" data-testid="new-playlist" onClick={() => {
            setCreateForSongId(menuSongId)
            setShowCreatePlaylist(true)
          }}><Plus size={14} /> New playlist…</button>
        </div>
      ), document.body)}

      {showCreatePlaylist && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setShowCreatePlaylist(false)
        }}>
          <form className="playlist-dialog" role="dialog" aria-modal="true" aria-labelledby="playlist-dialog-title"
            onSubmit={(event) => void createPlaylist(event)}>
            <div><h2 id="playlist-dialog-title">New playlist</h2>
              <button type="button" aria-label="Close" onClick={() => setShowCreatePlaylist(false)}><X size={18} /></button></div>
            <label>Playlist name<input autoFocus data-testid="playlist-name" value={playlistName}
              onChange={(event) => setPlaylistName(event.target.value)} maxLength={80} /></label>
            <button className="primary-button" data-testid="playlist-create-confirm" type="submit"
              disabled={!playlistName.trim()}>Create playlist</button>
          </form>
        </div>
      )}
      {confirmClear && selectedPlaylist && (
        <div className="dialog-backdrop" role="presentation">
          <div className="playlist-dialog" role="alertdialog" aria-modal="true"
            aria-labelledby="playlist-clear-title">
            <div><h2 id="playlist-clear-title">Clear {selectedPlaylist.name}?</h2>
              <button aria-label="Cancel clearing playlist" onClick={() => setConfirmClear(false)}>
                <X size={18} />
              </button></div>
            <p>Every entry will be removed. Your library songs will stay on this PC.</p>
            <div className="dialog-actions">
              <button onClick={() => setConfirmClear(false)}>Cancel</button>
              <button className="danger-button" data-testid="playlist-clear-confirm" onClick={() => {
                setConfirmClear(false)
                void clearCurrentPlaylist()
              }}>Clear playlist</button>
            </div>
          </div>
        </div>
      )}
      {showRenamePlaylist && selectedPlaylist?.kind === 'playlist' && (
        <div className="dialog-backdrop" role="presentation">
          <form className="playlist-dialog" role="dialog" aria-modal="true"
            aria-labelledby="playlist-rename-title" onSubmit={(event) => void renameCurrentPlaylist(event)}>
            <div><h2 id="playlist-rename-title">Rename playlist</h2>
              <button type="button" aria-label="Cancel renaming playlist"
                onClick={() => setShowRenamePlaylist(false)}><X size={18} /></button></div>
            <label>Playlist name<input autoFocus value={renameName}
              onChange={(event) => setRenameName(event.target.value)} maxLength={80} /></label>
            <button className="primary-button" type="submit" disabled={!renameName.trim()}>Save name</button>
          </form>
        </div>
      )}
      {confirmDelete && selectedPlaylist?.kind === 'playlist' && (
        <div className="dialog-backdrop" role="presentation">
          <div className="playlist-dialog" role="alertdialog" aria-modal="true"
            aria-labelledby="playlist-delete-title">
            <div><h2 id="playlist-delete-title">Delete {selectedPlaylist.name}?</h2>
              <button aria-label="Cancel deleting playlist" onClick={() => setConfirmDelete(false)}>
                <X size={18} />
              </button></div>
            <p>The playlist will be deleted. Its songs will remain in your library.</p>
            <div className="dialog-actions">
              <button onClick={() => setConfirmDelete(false)}>Cancel</button>
              <button className="danger-button" onClick={() => void deleteCurrentPlaylist()}>Delete playlist</button>
            </div>
          </div>
        </div>
      )}
      {notice && <button className="notice-toast" role="status" onClick={() => setNotice(undefined)}
        aria-label={`${notice} Dismiss`}>{notice}</button>}
      {error && <button className="error-toast" role="alert" onClick={() => setError(undefined)}
        aria-label={`${error}. Dismiss`}>{error}</button>}
    </div>
  )
}

export default App
