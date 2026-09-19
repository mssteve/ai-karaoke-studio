import type { ProcessUpdate, ProcessingItem, ProcessingItemStatus, Song } from './types'

export const processingStatusLabels: Record<ProcessingItemStatus, string> = {
  pending: 'Queued',
  active: 'Active',
  indeterminate: 'Active',
  complete: 'Complete',
  error: 'Failed',
}

export function mergeProcessUpdate(song: Song, update: ProcessUpdate): Song {
  const currentDetails = song.processingDetails
  const incomingDetails = update.details
  const sameRun = Boolean(
    currentDetails
    && incomingDetails
    && currentDetails.startedAt === incomingDetails.startedAt,
  )

  if (sameRun && Date.parse(incomingDetails!.updatedAt) < Date.parse(currentDetails!.updatedAt)) {
    return song
  }

  if (
    currentDetails
    && incomingDetails
    && Date.parse(incomingDetails.startedAt) < Date.parse(currentDetails.startedAt)
  ) {
    return song
  }

  return {
    ...(update.song ?? song),
    processingStage: update.stage,
    processingProgress: sameRun
      ? Math.max(song.processingProgress, update.progress)
      : update.progress,
    processingMessage: update.message,
    processingDetails: incomingDetails ?? currentDetails,
  }
}

export function formatProcessingElapsed(milliseconds?: number) {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return undefined
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes ? `${minutes}m ${seconds.toString().padStart(2, '0')}s elapsed` : `${seconds}s elapsed`
}

export function processingItemDetail(item: ProcessingItem) {
  const parts: string[] = []
  if (item.message) parts.push(item.message)
  if (item.id === 'enhanced' && item.diagnostics) {
    const output = item.diagnostics.output
    parts.push(
      `EBU R128 · Vocal ${item.diagnostics.vocalGainDb.toFixed(1)} dB`
      + ` · Instrumental ${item.diagnostics.instrumentalGainDb.toFixed(1)} dB`
      + ` · Output ${output.integratedLufs?.toFixed(1) ?? 'silent'} LUFS`
      + ` / ${output.truePeakDbtp?.toFixed(1) ?? 'no finite'} dBTP`,
    )
    if (item.diagnostics.cleanupApplied) parts.push('Mild instrumental noise cleanup applied')
    if (item.diagnostics.caveat) parts.push(item.diagnostics.caveat)
  }
  if (item.status === 'active' && item.progress !== undefined) {
    parts.push(`${Math.round(item.progress)}%`)
  }
  if (item.status === 'indeterminate') {
    const elapsed = formatProcessingElapsed(item.elapsedMs)
    if (elapsed) parts.push(elapsed)
  }
  return parts.join(' · ')
}
