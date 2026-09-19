import type {
  EnhancedProcessingDiagnostics,
  LoudnessMetrics,
} from './types.js'
import type { ProcessingResourcePolicy } from './processing-resources.js'
import { ffmpegThreadArguments } from './processing-resources.js'

export const ENHANCED_TARGET_LUFS = -16 as const
export const ENHANCED_TRUE_PEAK_DBTP = -1.5 as const
export const STEM_GAIN_LIMIT_DB = 6
export const NEAR_SILENT_LUFS = -45
export const MASTERING_FLOOR_LUFS = -30

function finiteMetric(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value))
  return Number.isFinite(parsed) ? parsed : null
}

export function parseLoudnormMetrics(output: string): LoudnessMetrics {
  const reports = [...output.matchAll(/\{[\s\S]*?"input_i"[\s\S]*?\}/g)]
  const report = reports.at(-1)?.[0]
  if (!report) throw new Error('FFmpeg did not return an EBU R128 loudness report.')
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(report) as Record<string, unknown>
  } catch {
    throw new Error('FFmpeg returned malformed EBU R128 loudness metrics.')
  }
  return {
    integratedLufs: finiteMetric(parsed.input_i),
    truePeakDbtp: finiteMetric(parsed.input_tp),
    loudnessRangeLu: finiteMetric(parsed.input_lra),
    thresholdLufs: finiteMetric(parsed.input_thresh),
  }
}

export function loudnessAnalysisArguments(filePath: string, policy: ProcessingResourcePolicy) {
  return [
    ...ffmpegThreadArguments(policy),
    '-hide_banner',
    '-nostats',
    '-i', filePath,
    '-af', `loudnorm=I=${ENHANCED_TARGET_LUFS}:TP=${ENHANCED_TRUE_PEAK_DBTP}:LRA=11:print_format=json`,
    '-threads', String(policy.cpuThreads),
    '-f', 'null',
    '-',
  ]
}

function boundedStemGain(metrics: LoudnessMetrics, target: number) {
  if (metrics.integratedLufs === null || metrics.integratedLufs <= NEAR_SILENT_LUFS) return 0
  const loudnessGain = target - metrics.integratedLufs
  const peakLimitedGain = metrics.truePeakDbtp === null
    ? loudnessGain
    : Math.min(loudnessGain, -3 - metrics.truePeakDbtp)
  return Math.max(-STEM_GAIN_LIMIT_DB, Math.min(STEM_GAIN_LIMIT_DB, peakLimitedGain))
}

export function chooseEnhancementPlan(
  vocal: LoudnessMetrics,
  instrumental: LoudnessMetrics,
) {
  const vocalGainDb = boundedStemGain(vocal, -20)
  const instrumentalGainDb = boundedStemGain(instrumental, -23)
  const instrumentalCrest = instrumental.integratedLufs === null || instrumental.truePeakDbtp === null
    ? null
    : instrumental.truePeakDbtp - instrumental.integratedLufs
  const cleanupApplied = instrumental.integratedLufs !== null
    && instrumental.integratedLufs > -35
    && instrumental.loudnessRangeLu !== null
    && instrumental.loudnessRangeLu <= 2
    && instrumentalCrest !== null
    && instrumentalCrest <= 8
  const vocalFilters = [
    `volume=${vocalGainDb.toFixed(2)}dB`,
    'highpass=f=70',
    'lowpass=f=15000',
    'acompressor=threshold=-16dB:ratio=1.6:attack=20:release=180:makeup=1',
  ]
  const instrumentalFilters = [
    `volume=${instrumentalGainDb.toFixed(2)}dB`,
    ...(cleanupApplied
      ? ['highpass=f=35', 'lowpass=f=15500', 'afftdn=nr=3:nf=-45']
      : []),
  ]
  return {
    vocalGainDb,
    instrumentalGainDb,
    vocalFilters,
    instrumentalFilters,
    cleanupApplied,
    mixFilter: `[0:a]${vocalFilters.join(',')}[v];`
      + `[1:a]${instrumentalFilters.join(',')}[i];`
      + '[v][i]amix=inputs=2:duration=longest,volume=2,alimiter=limit=0.90[enhanced]',
  }
}

export function createMasterFilter(metrics: LoudnessMetrics) {
  if (metrics.integratedLufs === null || metrics.truePeakDbtp === null
    || metrics.loudnessRangeLu === null || metrics.thresholdLufs === null) {
    return {
      filter: `alimiter=limit=${10 ** (ENHANCED_TRUE_PEAK_DBTP / 20)}`,
      caveat: 'The premix was too quiet for finite EBU R128 normalization; no loudness boost was applied.',
    }
  }
  if (metrics.integratedLufs <= MASTERING_FLOOR_LUFS) {
    return {
      filter: `alimiter=limit=${10 ** (ENHANCED_TRUE_PEAK_DBTP / 20)}`,
      caveat: `Premix loudness was ${metrics.integratedLufs.toFixed(1)} LUFS; normalization was skipped to avoid amplifying silence or noise.`,
    }
  }
  return {
    filter: `loudnorm=I=${ENHANCED_TARGET_LUFS}:TP=${ENHANCED_TRUE_PEAK_DBTP}:LRA=11`
      + `:measured_I=${metrics.integratedLufs}:measured_TP=${metrics.truePeakDbtp}`
      + `:measured_LRA=${metrics.loudnessRangeLu}:measured_thresh=${metrics.thresholdLufs}`
      + ':linear=true:print_format=summary',
  }
}

export function enhancementSummary(
  diagnostics: Omit<EnhancedProcessingDiagnostics, 'standard' | 'targetIntegratedLufs' | 'truePeakCeilingDbtp'>,
): EnhancedProcessingDiagnostics {
  return {
    standard: 'EBU R128',
    targetIntegratedLufs: ENHANCED_TARGET_LUFS,
    truePeakCeilingDbtp: ENHANCED_TRUE_PEAK_DBTP,
    ...diagnostics,
  }
}
