import assert from 'node:assert/strict'
import {
  PendingProcessingPlans,
  ProcessingScheduler,
  recoverInterruptedProcessing,
} from '../dist-electron/processing-scheduler.js'

assert.throws(
  () => new ProcessingScheduler(2),
  /fixed at one/,
  'the process-wide scheduler must not permit parallel whole-song pipelines',
)

const mergedPlans = new PendingProcessingPlans()
assert.equal(mergedPlans.add('same-song', 'lyrics'), true)
assert.equal(mergedPlans.add('same-song', 'enhanced'), false)
assert.deepEqual(new Set(mergedPlans.take('same-song')), new Set(['lyrics', 'enhanced']))
assert.equal(mergedPlans.hasPending('same-song'), false)
assert.equal(mergedPlans.add('same-song', 'vocal'), false)
assert.deepEqual(mergedPlans.take('same-song'), ['vocal'])
mergedPlans.finish('same-song')
assert.equal(mergedPlans.has('same-song'), false)

const scheduler = new ProcessingScheduler(1)
const starts = []
const finishes = []
const positions = new Map()
const releases = []
let active = 0
let maximumActive = 0

const jobs = Array.from({ length: 12 }, (_, index) => {
  const key = `song-${index + 1}`
  let release
  releases.push(() => release?.())
  return scheduler.enqueue({
    key,
    onQueuePosition: (position) => positions.set(key, position),
    run: async () => {
      starts.push(key)
      active += 1
      maximumActive = Math.max(maximumActive, active)
      try {
        await new Promise((resolve) => { release = resolve })
        if (index === 3) throw new Error('expected failure')
        return key
      } finally {
        active -= 1
        finishes.push(key)
      }
    },
  })
})

const duplicate = scheduler.enqueue({
  key: 'song-2',
  run: async () => {
    throw new Error('duplicate started')
  },
})
assert.equal(duplicate, jobs[1], 'duplicate enqueue must share the original terminal promise')
const settledPromise = Promise.allSettled(jobs)

await new Promise((resolve) => setImmediate(resolve))
assert.deepEqual(starts, ['song-1'])
assert.equal(maximumActive, 1)
assert.equal(positions.get('song-2'), 1)

for (let index = 0; index < releases.length; index += 1) {
  releases[index]()
  await new Promise((resolve) => setImmediate(resolve))
  if (index === 3) {
    await assert.rejects(jobs[index], /expected failure/)
  }
}

const settled = await settledPromise
assert.equal(settled.filter((result) => result.status === 'rejected').length, 1)
assert.deepEqual(starts, Array.from({ length: 12 }, (_, index) => `song-${index + 1}`))
assert.equal(maximumActive, 1)
assert.deepEqual(finishes, starts)
assert.deepEqual(scheduler.snapshot(), { active: 0, queued: 0, total: 0 })
assert.equal(scheduler.has('song-2'), false)

const interrupted = {
  id: 'interrupted',
  processingStage: 'queued',
  processingMessage: 'Queued',
  processingDetails: {
    schemaVersion: 1,
    operation: 'full',
    queuedAt: new Date(1_000).toISOString(),
    queuePosition: 4,
    startedAt: new Date(1_000).toISOString(),
    updatedAt: new Date(1_000).toISOString(),
    items: [{ id: 'original', label: 'Original', status: 'pending' }],
  },
}
assert.equal(recoverInterruptedProcessing(interrupted, 2_000), true)
assert.equal(interrupted.processingStage, 'error')
assert.equal(interrupted.processingDetails.queuePosition, undefined)
assert.equal(interrupted.processingDetails.items[0].status, 'error')
assert.match(interrupted.processingMessage, /Retry/)
assert.equal(recoverInterruptedProcessing({ processingStage: 'complete' }, 2_000), false)

for (const terminal of ['success', 'failure']) {
  const terminalScheduler = new ProcessingScheduler()
  const events = []
  let release
  const first = terminalScheduler.enqueue({
    key: `${terminal}-first`,
    run: async () => {
      events.push('first:start')
      await new Promise((resolve) => { release = resolve })
      events.push(`first:terminal-${terminal}`)
      if (terminal === 'failure') throw new Error('terminal failure')
      return 'ok'
    },
  })
  const second = terminalScheduler.enqueue({
    key: `${terminal}-second`,
    run: async () => {
      events.push('second:start')
      return 'ok'
    },
  })
  const settled = Promise.allSettled([first, second])
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['first:start'])
  release()
  await settled
  assert.deepEqual(events, [
    'first:start',
    `first:terminal-${terminal}`,
    'second:start',
  ], `next song must wait for terminal ${terminal}`)
}

console.log('PASS processing scheduler: exactly-one FIFO, duplicate suppression, terminal-gated continuation, cleanup, restart recovery.')
