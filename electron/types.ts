export type ProcessingStage = 'idle' | 'queued' | 'preparing' | 'separating' | 'enhancing' | 'transcribing' | 'partial' | 'complete' | 'error'
export type ProcessingItemId =
  | 'source-preparation'
  | 'demucs'
  | 'stem-vocals'
  | 'stem-drums'
  | 'stem-bass'
  | 'stem-other'
  | 'original'
  | 'instrumental'
  | 'vocal'
  | 'enhanced'
  | 'whisper-model'
  | 'whisper-transcription'
  | 'lyrics'
export type ProcessingItemStatus = 'pending' | 'active' | 'indeterminate' | 'complete' | 'error'
export type DeliverableId =
  | 'original'
  | 'source-preparation'
  | 'demucs'
  | 'stem-vocals'
  | 'stem-drums'
  | 'stem-bass'
  | 'stem-other'
  | 'instrumental'
  | 'vocal'
  | 'enhanced'
  | 'whisper-transcription'
  | 'lyrics'
export type DeliverableState = 'queued' | 'active' | 'ready' | 'failed' | 'blocked' | 'missing'
export type ProcessingComponentId = DeliverableId | 'library-save'

export interface ArtifactFingerprint {
  path: string
  size: number
  modifiedAt: number
  validatedAt: string
}

export interface LoudnessMetrics {
  integratedLufs: number | null
  truePeakDbtp: number | null
  loudnessRangeLu: number | null
  thresholdLufs: number | null
}

export interface EnhancedProcessingDiagnostics {
  standard: 'EBU R128'
  targetIntegratedLufs: -16
  truePeakCeilingDbtp: -1.5
  vocal: LoudnessMetrics
  instrumental: LoudnessMetrics
  premix: LoudnessMetrics
  output: LoudnessMetrics
  vocalGainDb: number
  instrumentalGainDb: number
  vocalFilters: string[]
  instrumentalFilters: string[]
  masterFilter: string
  cleanupApplied: boolean
  caveat?: string
}

export interface TranscriptionTimingDiagnostics {
  fallbackUsed: boolean
  fallbackLineCount: number
  repairedOverlapCount: number
  invalidDurationExpansionCount: number
  sortedFragmentCount: number
  mergedFragmentCount: number
  discardedFragmentCount: number
  messages: string[]
}

export type ProcessingDiagnostics = EnhancedProcessingDiagnostics | TranscriptionTimingDiagnostics

export interface ComponentFailure {
  component: ProcessingComponentId
  code: 'execution-failed' | 'invalid-artifact' | 'missing-dependency' | 'interrupted' | 'invalid-request'
  message: string
  retryable: boolean
  dependency?: DeliverableId
  occurredAt: string
}

export interface DeliverableOutcome {
  id: DeliverableId
  state: DeliverableState
  artifacts: ArtifactFingerprint[]
  updatedAt: string
  failure?: ComponentFailure
  blockedBy?: DeliverableId[]
  diagnostics?: ProcessingDiagnostics
}

export interface DeliverableStore {
  schemaVersion: 1
  outcomes: Record<DeliverableId, DeliverableOutcome>
}

export interface RetryDeliverableRequest {
  songId: string
  component: ProcessingComponentId
}

export interface ProcessingItem {
  id: ProcessingItemId
  label: string
  status: ProcessingItemStatus
  progress?: number
  message?: string
  startedAt?: string
  completedAt?: string
  elapsedMs?: number
  error?: string
  diagnostics?: ProcessingDiagnostics
}

export interface ProcessingDetails {
  schemaVersion: 1
  operation: 'full' | 'lyrics' | 'retry'
  activeItem?: ProcessingItemId
  queuedAt?: string
  queuePosition?: number
  startedAt: string
  updatedAt: string
  items: ProcessingItem[]
}

export interface LyricLine {
  text: string
  start: number
  end: number
}

export interface TranscriptionResult {
  text: string
  language?: string
  languageCode?: string
  languageName?: string
  languageSource?: LyricLanguage['languageSource']
  lines: LyricLine[]
  timingDiagnostics?: TranscriptionTimingDiagnostics
}

export interface LyricLanguage {
  songId?: string
  languageCode: string
  languageName: string
  languageSource: 'detected' | 'user' | 'legacy'
}

export interface Song {
  id: string
  title: string
  artist: string
  sourcePath: string
  sourceUrl: string
  format: 'mp3' | 'mp4'
  addedAt: string
  duration?: number
  instrumentalPath?: string
  instrumentalUrl?: string
  vocalPath?: string
  vocalUrl?: string
  enhancedPath?: string
  enhancedUrl?: string
  lyrics: LyricLine[]
  lyricLanguage: LyricLanguage
  languageCode: string
  languageName: string
  languageSource: LyricLanguage['languageSource']
  processingStage: ProcessingStage
  processingProgress: number
  processingMessage?: string
  processingDetails?: ProcessingDetails
  deliverables?: DeliverableStore
  processingFailure?: ComponentFailure
}

export interface ProcessUpdate {
  songId: string
  stage: ProcessingStage
  progress: number
  message: string
  details?: ProcessingDetails
  failure?: ComponentFailure
  song?: Song
}

export interface DesktopControl {
  action: 'play' | 'pause' | 'toggle' | 'select' | 'mode' | 'seek'
  value?: string | number
}

export type PlaybackStatus = 'idle' | 'loading' | 'paused' | 'playing' | 'ended' | 'error'

export interface PlaylistEntry {
  id: string
  songId: string
  addedAt: string
}

export interface Playlist {
  id: string
  name: string
  kind: 'queue' | 'history' | 'playlist'
  entries: PlaylistEntry[]
  currentEntryId?: string
  createdAt: string
  updatedAt: string
}

export interface PlaylistStore {
  schemaVersion: 1
  selectedPlaylistId?: string
  playlists: Playlist[]
}

export interface PlaylistMutationRequest {
  playlistId: string
  expectedUpdatedAt?: string
}

export interface CreatePlaylistRequest {
  name: string
}

export interface RenamePlaylistRequest extends PlaylistMutationRequest {
  name: string
}

export interface DeletePlaylistRequest extends PlaylistMutationRequest {}

export interface AddSongToPlaylistRequest extends PlaylistMutationRequest {
  songId: string
}

export interface RemovePlaylistEntryRequest extends PlaylistMutationRequest {
  entryId: string
}

export interface ArchiveQueueEntryRequest extends PlaylistMutationRequest {
  entryId: string
}

export interface SelectPlaylistRequest {
  playlistId: string
}

export interface SetPlaylistCursorRequest extends PlaylistMutationRequest {
  entryId?: string
}

export type PlaylistTransitionReason =
  | 'manual-library'
  | 'manual-playlist'
  | 'natural-end'
  | 'entry-removed'
  | 'song-removed'
  | 'restore'

export interface PlaylistAutomationState {
  selectedPlaylistId?: string
  activePlaylistId?: string
  currentEntryId?: string
  nextEntryId?: string
  revision: number
  transitionReason?: PlaylistTransitionReason
  transitionCount: number
  playlists: Array<{
    id: string
    name: string
    kind: Playlist['kind']
    currentEntryId?: string
    entries: Array<{ id: string; songId: string }>
  }>
}

export interface PlaybackAutomationStatus {
  songId?: string
  mode: 'original' | 'enhanced' | 'vocal' | 'instrumental'
  status: PlaybackStatus
  playingIntent: boolean
  currentTime: number
  duration: number
  activeLyricIndex: number
  activeLyricStart?: number
  activeLyricText?: string
  lyricLanguage?: LyricLanguage
  lyricSongId?: string
  playlist?: PlaylistAutomationState
  error?: string
}

export interface KaraokeApi {
  getLibrary: () => Promise<Song[]>
  importSongs: () => Promise<Song[]>
  removeSong: (id: string) => Promise<Song[]>
  processSong: (id: string) => Promise<Song>
  retranscribeSong: (id: string) => Promise<Song>
  retryDeliverable: (request: RetryDeliverableRequest) => Promise<Song>
  getPlaylists: () => Promise<PlaylistStore>
  createPlaylist: (request: CreatePlaylistRequest) => Promise<PlaylistStore>
  renamePlaylist: (request: RenamePlaylistRequest) => Promise<PlaylistStore>
  deletePlaylist: (request: DeletePlaylistRequest) => Promise<PlaylistStore>
  addSongToPlaylist: (request: AddSongToPlaylistRequest) => Promise<PlaylistStore>
  removePlaylistEntry: (request: RemovePlaylistEntryRequest) => Promise<PlaylistStore>
  archiveQueueEntry: (request: ArchiveQueueEntryRequest) => Promise<PlaylistStore>
  clearPlaylist: (request: PlaylistMutationRequest) => Promise<PlaylistStore>
  selectPlaylist: (request: SelectPlaylistRequest) => Promise<PlaylistStore>
  setPlaylistCursor: (request: SetPlaylistCursorRequest) => Promise<PlaylistStore>
  revealFile: (path: string) => Promise<void>
  openDiagnostics: () => Promise<void>
  reportRendererError: (message: string, detail?: string) => Promise<void>
  updateAutomationStatus: (status: PlaybackAutomationStatus) => void
  onProcessUpdate: (callback: (update: ProcessUpdate) => void) => () => void
  onDesktopControl: (callback: (command: DesktopControl) => void) => () => void
}
