import type {
  ProcessingDetails,
  ProcessingItem,
  ProcessingItemId,
  ProcessingItemStatus,
  ProcessingStage,
  ProcessUpdate,
} from './types.js'

interface PlanItem {
  id: ProcessingItemId
  label: string
  weight: number
}

const fullPlan: PlanItem[] = [
  { id: 'original', label: 'Original', weight: 1 },
  { id: 'source-preparation', label: 'Source preparation', weight: 11 },
  { id: 'demucs', label: 'Demucs separation', weight: 42 },
  { id: 'stem-vocals', label: 'Vocal stem', weight: 1 },
  { id: 'stem-drums', label: 'Drum stem', weight: 1 },
  { id: 'stem-bass', label: 'Bass stem', weight: 1 },
  { id: 'stem-other', label: 'Other stem', weight: 1 },
  { id: 'instrumental', label: 'Instrumental output', weight: 10 },
  { id: 'vocal', label: 'Vocal output', weight: 8 },
  { id: 'enhanced', label: 'Enhanced output', weight: 8 },
  { id: 'whisper-model', label: 'Whisper model', weight: 5 },
  { id: 'whisper-transcription', label: 'Whisper transcription', weight: 9 },
  { id: 'lyrics', label: 'Timed lyrics', weight: 2 },
]

const lyricsPlan: PlanItem[] = [
  { id: 'source-preparation', label: 'Transcription audio preparation', weight: 15 },
  { id: 'whisper-model', label: 'Whisper model', weight: 25 },
  { id: 'whisper-transcription', label: 'Whisper transcription', weight: 55 },
  { id: 'lyrics', label: 'Timed lyrics', weight: 5 },
]

function cloneDetails(details: ProcessingDetails): ProcessingDetails {
  return { ...details, items: details.items.map((item) => ({ ...item })) }
}

export class ProcessingProgress {
  private readonly plan: PlanItem[]
  private readonly details: ProcessingDetails
  private overall = 0
  private stage: ProcessingStage
  private message = ''

  constructor(
    readonly songId: string,
    operation: ProcessingDetails['operation'],
    now = Date.now(),
  ) {
    this.plan = operation === 'lyrics' ? lyricsPlan : fullPlan
    const timestamp = new Date(now).toISOString()
    this.stage = operation === 'full' ? 'preparing' : 'transcribing'
    this.details = {
      schemaVersion: 1,
      operation,
      startedAt: timestamp,
      updatedAt: timestamp,
      items: this.plan.map(({ id, label }) => ({ id, label, status: 'pending' })),
    }
  }

  queued(position: number, now = Date.now()): ProcessUpdate {
    const timestamp = new Date(now).toISOString()
    this.stage = 'queued'
    this.message = `Queued for local AI processing (position ${position})`
    this.details.queuedAt ??= timestamp
    this.details.queuePosition = position
    this.details.updatedAt = timestamp
    return this.snapshot()
  }

  update(
    id: ProcessingItemId,
    status: ProcessingItemStatus,
    options: {
      progress?: number
      message?: string
      stage?: ProcessingStage
      error?: string
      diagnostics?: ProcessingItem['diagnostics']
      now?: number
    } = {},
  ): ProcessUpdate {
    const now = options.now ?? Date.now()
    const item = this.details.items.find((candidate) => candidate.id === id)
    if (!item) throw new Error(`Processing item is not part of this operation: ${id}`)
    if (item.status === 'complete' && status !== 'complete' && status !== 'error') return this.snapshot()

    const timestamp = new Date(now).toISOString()
    if (!item.startedAt && status !== 'pending') item.startedAt = timestamp
    item.status = status
    item.progress = status === 'complete'
      ? 100
      : options.progress === undefined
        ? item.progress
        : Math.max(item.progress ?? 0, Math.min(99, Math.max(0, options.progress)))
    item.message = options.message ?? item.message
    item.elapsedMs = item.startedAt ? Math.max(0, now - Date.parse(item.startedAt)) : undefined
    item.error = options.error
    item.diagnostics = options.diagnostics ?? item.diagnostics
    if (status === 'complete') item.completedAt = timestamp
    else if (status === 'error') item.completedAt = undefined

    this.details.activeItem = status === 'active' || status === 'indeterminate' || status === 'error'
      ? id
      : this.details.activeItem === id ? undefined : this.details.activeItem
    this.details.queuePosition = undefined
    this.details.updatedAt = timestamp
    this.stage = options.stage ?? this.stageFor(id, status)
    this.message = options.message ?? item.message ?? item.label
    this.overall = Math.max(this.overall, Math.min(99, this.calculateOverall()))
    return this.snapshot()
  }

  fail(id: ProcessingItemId, error: string, now = Date.now()) {
    this.overall = Math.min(this.overall, 99)
    return this.update(id, 'error', { error, message: error, stage: 'error', now })
  }

  failCurrent(error: string, now = Date.now()) {
    const id = this.details.activeItem
      ?? this.details.items.find((item) => item.status === 'pending')?.id
      ?? this.details.items.at(-1)?.id
    if (!id) throw new Error(error)
    return this.fail(id, error, now)
  }

  heartbeat(now = Date.now()) {
    const item = this.details.items.find((candidate) => candidate.id === this.details.activeItem)
    if (!item) return this.snapshot()
    return this.update(item.id, item.status, { message: item.message, now })
  }

  complete(message: string, now = Date.now()): ProcessUpdate {
    this.overall = 100
    this.stage = 'complete'
    this.message = message
    this.details.activeItem = undefined
    this.details.updatedAt = new Date(now).toISOString()
    return this.snapshot()
  }

  snapshot(): ProcessUpdate {
    return {
      songId: this.songId,
      stage: this.stage,
      progress: this.overall,
      message: this.message,
      details: cloneDetails(this.details),
    }
  }

  private calculateOverall() {
    const totalWeight = this.plan.reduce((sum, item) => sum + item.weight, 0)
    const earned = this.plan.reduce((sum, planned) => {
      const item = this.details.items.find((candidate) => candidate.id === planned.id) as ProcessingItem
      const fraction = item.status === 'complete'
        ? 1
        : item.progress === undefined ? 0 : item.progress / 100
      return sum + planned.weight * fraction
    }, 0)
    return Math.floor(earned / totalWeight * 100)
  }

  private stageFor(id: ProcessingItemId, status: ProcessingItemStatus): ProcessingStage {
    if (status === 'error') return 'error'
    if (id === 'source-preparation' || id === 'original') return 'preparing'
    if (id === 'demucs' || id.startsWith('stem-')) return 'separating'
    if (id === 'instrumental' || id === 'vocal' || id === 'enhanced') return 'enhancing'
    if (id === 'whisper-model' || id === 'whisper-transcription' || id === 'lyrics') return 'transcribing'
    return this.stage
  }
}
