import type { Song } from './types.js'
import { componentFailure, normalizeDeliverableStore } from './processing-domain.js'

export interface ScheduledJob<T> {
  key: string
  run: () => Promise<T>
  onQueuePosition?: (position: number) => void
}

interface QueueEntry<T> extends ScheduledJob<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

export class PendingProcessingPlans<T> {
  private readonly plans = new Map<string, Set<T>>()

  add(songId: string, target: T) {
    const existing = this.plans.get(songId)
    if (existing) {
      existing.add(target)
      return false
    }
    this.plans.set(songId, new Set([target]))
    return true
  }

  has(songId: string) {
    return this.plans.has(songId)
  }

  take(songId: string) {
    const plan = this.plans.get(songId)
    if (!plan) return []
    const targets = [...plan]
    plan.clear()
    return targets
  }

  hasPending(songId: string) {
    return Boolean(this.plans.get(songId)?.size)
  }

  finish(songId: string) {
    this.plans.delete(songId)
  }
}

export class ProcessingScheduler {
  private readonly queue: QueueEntry<unknown>[] = []
  private readonly jobs = new Map<string, QueueEntry<unknown>>()
  private active = 0
  private pumpScheduled = false

  constructor(readonly concurrency = 1) {
    if (concurrency !== 1) {
      throw new Error('Local AI processing concurrency is fixed at one complete song pipeline.')
    }
  }

  enqueue<T>(job: ScheduledJob<T>): Promise<T> {
    const existing = this.jobs.get(job.key)
    if (existing) return existing.promise as Promise<T>

    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    const entry: QueueEntry<T> = { ...job, promise, resolve, reject }
    this.jobs.set(job.key, entry as QueueEntry<unknown>)
    this.queue.push(entry as QueueEntry<unknown>)
    this.reportQueuePositions()
    this.schedulePump()
    return promise
  }

  has(key: string) {
    return this.jobs.has(key)
  }

  get<T>(key: string) {
    return this.jobs.get(key)?.promise as Promise<T> | undefined
  }

  snapshot() {
    return { active: this.active, queued: this.queue.length, total: this.jobs.size }
  }

  keys() {
    return [...this.jobs.keys()]
  }

  private schedulePump() {
    if (this.pumpScheduled) return
    this.pumpScheduled = true
    queueMicrotask(() => {
      this.pumpScheduled = false
      this.pump()
    })
  }

  private pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const entry = this.queue.shift()!
      this.active += 1
      this.reportQueuePositions()
      void (async () => {
        try {
          const result = await entry.run()
          this.jobs.delete(entry.key)
          this.active -= 1
          entry.resolve(result)
        } catch (error) {
          this.jobs.delete(entry.key)
          this.active -= 1
          entry.reject(error)
        } finally {
          this.schedulePump()
        }
      })()
    }
  }

  private reportQueuePositions() {
    this.queue.forEach((entry, index) => entry.onQueuePosition?.(index + 1))
  }
}

const interruptedStages = new Set<Song['processingStage']>([
  'queued',
  'preparing',
  'separating',
  'enhancing',
  'transcribing',
])

export function recoverInterruptedProcessing(song: Song, now = Date.now()) {
  if (!interruptedStages.has(song.processingStage)) return false

  const message = 'Processing was interrupted by app shutdown. Retry to safely rebuild the outputs.'
  song.processingStage = 'error'
  song.processingMessage = message
  if (song.processingDetails) {
    const interruptedItem = song.processingDetails.items.find(
      (item) => item.id === song.processingDetails?.activeItem,
    ) ?? song.processingDetails.items.find((item) => item.status !== 'complete')
    if (interruptedItem) {
      interruptedItem.status = 'error'
      interruptedItem.error = message
    }
    song.processingDetails.activeItem = interruptedItem?.id
    song.processingDetails.queuePosition = undefined
    song.processingDetails.updatedAt = new Date(now).toISOString()
    if (interruptedItem) {
      const component = interruptedItem.id === 'whisper-model'
        ? 'whisper-transcription'
        : interruptedItem.id
      const id = component
      song.deliverables = normalizeDeliverableStore(song.deliverables, now)
      const failure = componentFailure(component, message, { code: 'interrupted' }, now)
      song.deliverables.outcomes[id] = {
        id,
        state: 'failed',
        artifacts: song.deliverables.outcomes[id].artifacts,
        updatedAt: new Date(now).toISOString(),
        failure,
      }
      song.processingFailure = failure
    }
  }
  return true
}
