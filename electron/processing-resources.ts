import os from 'node:os'

export interface ProcessingResourcePolicy {
  logicalCores: number
  cpuThreads: number
  executionProvider: 'cpu'
  gpuLimitEnforced: false
  gpuLimitation: string
}

export function calculateProcessingThreadLimit(logicalCores: number) {
  if (!Number.isFinite(logicalCores) || logicalCores < 1) return 1
  return Math.max(1, Math.floor(logicalCores / 2))
}

export function createProcessingResourcePolicy(
  logicalCores = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length,
): ProcessingResourcePolicy {
  return {
    logicalCores,
    cpuThreads: calculateProcessingThreadLimit(logicalCores),
    executionProvider: 'cpu',
    gpuLimitEnforced: false,
    gpuLimitation: 'ONNX Runtime GPU providers do not expose an enforceable percentage quota; local AI uses the CPU provider so the configured CPU thread cap is enforceable.',
  }
}

export function processingWorkerEnvironment(
  policy: ProcessingResourcePolicy,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const threads = String(policy.cpuThreads)
  return {
    ...base,
    OMP_NUM_THREADS: threads,
    OMP_THREAD_LIMIT: threads,
    MKL_NUM_THREADS: threads,
    OPENBLAS_NUM_THREADS: threads,
    NUMEXPR_NUM_THREADS: threads,
    VECLIB_MAXIMUM_THREADS: threads,
  }
}

export function ffmpegThreadArguments(policy: ProcessingResourcePolicy) {
  const threads = String(policy.cpuThreads)
  return ['-threads', threads, '-filter_threads', threads, '-filter_complex_threads', threads]
}

export function ffmpegValidationArguments(filePath: string, policy: ProcessingResourcePolicy) {
  return [
    ...ffmpegThreadArguments(policy),
    '-v', 'error',
    '-i', filePath,
    '-t', '0.1',
    '-threads', String(policy.cpuThreads),
    '-f', 'null',
    '-',
  ]
}

export function onnxSessionOptions(policy: ProcessingResourcePolicy) {
  return {
    executionProviders: [policy.executionProvider],
    intraOpNumThreads: policy.cpuThreads,
    interOpNumThreads: 1,
    executionMode: 'sequential' as const,
  }
}
