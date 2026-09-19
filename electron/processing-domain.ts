import type {
  ArtifactFingerprint,
  ComponentFailure,
  DeliverableId,
  DeliverableOutcome,
  DeliverableStore,
  ProcessingComponentId,
} from './types.js'

export const deliverableIds: DeliverableId[] = [
  'original',
  'source-preparation',
  'demucs',
  'stem-vocals',
  'stem-drums',
  'stem-bass',
  'stem-other',
  'instrumental',
  'vocal',
  'enhanced',
  'whisper-transcription',
  'lyrics',
]

export const deliverableDependencies: Record<DeliverableId, DeliverableId[]> = {
  original: [],
  'source-preparation': ['original'],
  demucs: ['source-preparation'],
  'stem-vocals': ['demucs'],
  'stem-drums': ['demucs'],
  'stem-bass': ['demucs'],
  'stem-other': ['demucs'],
  instrumental: ['stem-drums', 'stem-bass', 'stem-other'],
  vocal: ['stem-vocals'],
  enhanced: ['instrumental', 'vocal'],
  'whisper-transcription': ['vocal'],
  lyrics: ['whisper-transcription'],
}

const executionOrder: DeliverableId[] = [
  'original',
  'source-preparation',
  'demucs',
  'stem-vocals',
  'stem-drums',
  'stem-bass',
  'stem-other',
  'instrumental',
  'vocal',
  'enhanced',
  'whisper-transcription',
  'lyrics',
]

const stemIds = new Set<DeliverableId>([
  'stem-vocals',
  'stem-drums',
  'stem-bass',
  'stem-other',
])

export function isDeliverableId(value: unknown): value is DeliverableId {
  return typeof value === 'string' && deliverableIds.includes(value as DeliverableId)
}

export function isProcessingComponentId(value: unknown): value is ProcessingComponentId {
  return value === 'library-save' || isDeliverableId(value)
}

export function normalizeComponentFailure(value: unknown): ComponentFailure | undefined {
  if (!value || typeof value !== 'object') return undefined
  const failure = value as Partial<ComponentFailure>
  if (!isProcessingComponentId(failure.component)
    || !['execution-failed', 'invalid-artifact', 'missing-dependency', 'interrupted', 'invalid-request']
      .includes(failure.code ?? '')
    || typeof failure.message !== 'string'
    || typeof failure.retryable !== 'boolean'
    || typeof failure.occurredAt !== 'string'
    || (failure.dependency !== undefined && !isDeliverableId(failure.dependency))) return undefined
  return failure as ComponentFailure
}

export function createDeliverableStore(now = Date.now()): DeliverableStore {
  const updatedAt = new Date(now).toISOString()
  const outcomes = {} as Record<DeliverableId, DeliverableOutcome>
  for (const id of deliverableIds) {
    outcomes[id] = { id, state: 'missing', artifacts: [], updatedAt }
  }
  return {
    schemaVersion: 1,
    outcomes,
  }
}

export function normalizeDeliverableStore(value: unknown, now = Date.now()): DeliverableStore {
  const store = createDeliverableStore(now)
  if (!value || typeof value !== 'object') return store
  const candidate = value as Partial<DeliverableStore>
  if (candidate.schemaVersion !== 1 || !candidate.outcomes || typeof candidate.outcomes !== 'object') {
    return store
  }

  for (const id of deliverableIds) {
    const outcome = candidate.outcomes[id]
    if (!outcome || outcome.id !== id) continue
    if (!['queued', 'active', 'ready', 'failed', 'blocked', 'missing'].includes(outcome.state)) continue
    store.outcomes[id] = {
      id,
      state: outcome.state,
      artifacts: Array.isArray(outcome.artifacts) ? outcome.artifacts.filter((artifact) => (
        artifact
        && typeof artifact.path === 'string'
        && Number.isFinite(artifact.size)
        && Number.isFinite(artifact.modifiedAt)
        && typeof artifact.validatedAt === 'string'
      )) : [],
      updatedAt: typeof outcome.updatedAt === 'string' ? outcome.updatedAt : new Date(now).toISOString(),
      failure: normalizeComponentFailure(outcome.failure),
      blockedBy: Array.isArray(outcome.blockedBy)
        ? outcome.blockedBy.filter(isDeliverableId)
        : undefined,
      diagnostics: outcome.diagnostics,
    }
  }
  return store
}

export function reconcileArtifactOutcome(
  previous: DeliverableOutcome,
  artifacts: ArtifactFingerprint[] | undefined,
  now = Date.now(),
): DeliverableOutcome {
  const updatedAt = new Date(now).toISOString()
  if (artifacts?.length) {
    return {
      id: previous.id,
      state: 'ready',
      artifacts,
      updatedAt,
      diagnostics: previous.diagnostics,
    }
  }
  if (previous.state === 'failed') return previous
  if (previous.state === 'ready') {
    return {
      id: previous.id,
      state: 'failed',
      artifacts: [],
      updatedAt,
      failure: componentFailure(previous.id, 'A previously ready artifact is missing or invalid.', {
        code: 'invalid-artifact',
      }, now),
    }
  }
  return { id: previous.id, state: 'missing', artifacts: [], updatedAt }
}

export function blockedByFailure(
  plan: readonly DeliverableId[],
  failed: DeliverableId,
): Partial<Record<DeliverableId, DeliverableId[]>> {
  const blocked: Partial<Record<DeliverableId, DeliverableId[]>> = {}
  const unavailable = new Set<DeliverableId>([failed])
  for (const id of plan) {
    if (id === failed) continue
    const dependencies = deliverableDependencies[id].filter((dependency) => unavailable.has(dependency))
    if (dependencies.length) {
      blocked[id] = dependencies
      unavailable.add(id)
    }
  }
  return blocked
}

export function computeRetryPlan(
  requested: DeliverableId,
  valid: ReadonlySet<DeliverableId>,
): DeliverableId[] {
  const planned = new Set<DeliverableId>()
  const includeDependencies = (id: DeliverableId) => {
    for (const dependency of deliverableDependencies[id]) {
      if (!valid.has(dependency)) {
        includeDependencies(dependency)
        planned.add(dependency)
      }
    }
  }

  includeDependencies(requested)
  planned.add(requested)

  if (requested === 'lyrics') {
    includeDependencies('whisper-transcription')
    planned.add('whisper-transcription')
  }
  if (stemIds.has(requested) || [...planned].some((id) => stemIds.has(id))) {
    includeDependencies('demucs')
    planned.add('demucs')
    for (const stem of stemIds) planned.add(stem)
  }

  let changed = true
  while (changed) {
    changed = false
    for (const id of executionOrder) {
      if (planned.has(id)) continue
      if (deliverableDependencies[id].some((dependency) => planned.has(dependency))) {
        planned.add(id)
        changed = true
      }
    }
  }

  return executionOrder.filter((id) => planned.has(id))
}

export function computeMergedRetryPlan(
  requested: readonly DeliverableId[],
  valid: ReadonlySet<DeliverableId>,
) {
  const merged = new Set(requested.flatMap((component) => computeRetryPlan(component, valid)))
  return executionOrder.filter((id) => merged.has(id))
}

export function componentFailure(
  component: ProcessingComponentId,
  message: string,
  options: Partial<Pick<ComponentFailure, 'code' | 'retryable' | 'dependency'>> = {},
  now = Date.now(),
): ComponentFailure {
  return {
    component,
    code: options.code ?? 'execution-failed',
    message,
    retryable: options.retryable ?? true,
    dependency: options.dependency,
    occurredAt: new Date(now).toISOString(),
  }
}
