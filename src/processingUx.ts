import type {
  DeliverableId,
  DeliverableOutcome,
  ProcessingComponentId,
  ProcessingItem,
  ProcessingItemId,
  Song,
} from './types'
import type { AudioMode } from './usePlaybackController'

export const componentLabels: Record<ProcessingItemId | 'library-save', string> = {
  original: 'Original audio',
  'source-preparation': 'Source preparation',
  demucs: 'Stem separation',
  'stem-vocals': 'Vocal stem',
  'stem-drums': 'Drums stem',
  'stem-bass': 'Bass stem',
  'stem-other': 'Other stem',
  instrumental: 'Instrumental',
  vocal: 'Vocal',
  enhanced: 'Enhanced',
  'whisper-model': 'Lyrics model',
  'whisper-transcription': 'Lyrics transcription',
  lyrics: 'Timed lyrics',
  'library-save': 'Library save',
}

const modeDeliverables: Partial<Record<AudioMode, DeliverableId>> = {
  enhanced: 'enhanced',
  vocal: 'vocal',
  instrumental: 'instrumental',
}

export interface DeliverableIssue {
  component: ProcessingComponentId
  state: 'failed' | 'blocked'
  label: string
  reason: string
  retryable: boolean
  blockedBy: DeliverableId[]
}

export function deliverableIssues(song: Song): DeliverableIssue[] {
  if (!song.deliverables) return song.processingFailure
    ? [{
        component: song.processingFailure.component,
        state: 'failed',
        label: componentLabels[song.processingFailure.component],
        reason: song.processingFailure.message,
        retryable: song.processingFailure.retryable,
        blockedBy: [],
      }]
    : []

  const issues: DeliverableIssue[] = Object.values(song.deliverables.outcomes)
    .filter((outcome): outcome is DeliverableOutcome & { state: 'failed' | 'blocked' } =>
      outcome.state === 'failed' || outcome.state === 'blocked')
    .map((outcome) => ({
      component: outcome.id,
      state: outcome.state,
      label: componentLabels[outcome.id],
      reason: outcome.state === 'blocked'
        ? `Waiting for ${outcome.blockedBy?.map((id) => componentLabels[id]).join(', ') || 'a required component'}`
        : outcome.failure?.message || 'This component did not finish.',
      retryable: outcome.state === 'failed' && Boolean(outcome.failure?.retryable),
      blockedBy: outcome.blockedBy ?? [],
    }))
  if (song.processingFailure?.component === 'library-save') {
    issues.unshift({
      component: 'library-save',
      state: 'failed',
      label: componentLabels['library-save'],
      reason: song.processingFailure.message,
      retryable: song.processingFailure.retryable,
      blockedBy: [],
    })
  }
  return issues
}

export function modeAvailability(song: Song, mode: AudioMode) {
  const source = mode === 'original'
    ? song.sourceUrl
    : mode === 'enhanced'
      ? song.enhancedUrl
      : mode === 'vocal'
        ? song.vocalUrl
        : song.instrumentalUrl
  if (source) return { available: true, reason: undefined }

  const deliverableId = modeDeliverables[mode]
  const label = deliverableId ? componentLabels[deliverableId] : 'Original audio'
  const outcome = deliverableId ? song.deliverables?.outcomes[deliverableId] : undefined
  if (outcome?.state === 'failed') {
    return {
      available: false,
      reason: `${label} unavailable: ${outcome.failure?.message || 'processing failed'}`,
    }
  }
  if (outcome?.state === 'blocked') {
    const dependencies = outcome.blockedBy?.map((id) => componentLabels[id]).join(', ')
    return {
      available: false,
      reason: `${label} unavailable; waiting for ${dependencies || 'a required component'}`,
    }
  }
  if (outcome?.state === 'queued' || outcome?.state === 'active') {
    return { available: false, reason: `${label} is still processing` }
  }
  return { available: false, reason: `${label} has not been created yet` }
}

export function retryKey(songId: string, component: ProcessingComponentId) {
  return `${songId}:${component}`
}

export function claimRetry(
  pending: Set<string>,
  songId: string,
  component: ProcessingComponentId,
) {
  const key = retryKey(songId, component)
  if (pending.has(key)) return false
  pending.add(key)
  return true
}

export function retryActivity(song: Song, component: ProcessingComponentId, locallyPending: boolean) {
  if (locallyPending) return 'Requesting…'
  const outcome = component === 'library-save' ? undefined : song.deliverables?.outcomes[component]
  if (outcome?.state === 'queued' || song.processingStage === 'queued') {
    return song.processingDetails?.queuePosition
      ? `Queued #${song.processingDetails.queuePosition}`
      : 'Queued'
  }
  if (outcome?.state === 'active') {
    const item = song.processingDetails?.items.find((candidate) => candidate.id === component)
    return item?.progress === undefined ? 'Working…' : `Working ${Math.round(item.progress)}%`
  }
  return undefined
}

export function enhancedSummary(song: Song) {
  const diagnostics = song.deliverables?.outcomes.enhanced.diagnostics
    ?? song.processingDetails?.items.find((item: ProcessingItem) => item.id === 'enhanced')?.diagnostics
  if (!song.enhancedUrl || !diagnostics) return undefined
  const output = diagnostics.output
  const measurements = output.integratedLufs === null || output.truePeakDbtp === null
    ? 'Output was too quiet for reliable loudness measurement.'
    : `Output ${output.integratedLufs.toFixed(1)} LUFS · ${output.truePeakDbtp.toFixed(1)} dBTP`
  const adjustments = `Vocal ${diagnostics.vocalGainDb >= 0 ? '+' : ''}${diagnostics.vocalGainDb.toFixed(1)} dB`
    + ` · Instrumental ${diagnostics.instrumentalGainDb >= 0 ? '+' : ''}${diagnostics.instrumentalGainDb.toFixed(1)} dB`
  return {
    measurements,
    adjustments,
    cleanup: diagnostics.cleanupApplied
      ? 'Mild noise reduction was applied; separation artifacts may remain.'
      : undefined,
    caveat: diagnostics.caveat,
  }
}
