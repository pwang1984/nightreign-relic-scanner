import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { createChineseOcrEngine } from '../src/lib/chineseOcr.js'

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function fakeFactory({ provider = 'wasm', initialize = () => {}, predict = async (image) => image } = {}) {
  const workers = []
  const attempts = []
  let active = 0
  let maxActive = 0
  return {
    workers,
    attempts,
    get maxActive() { return maxActive },
    async create(options) {
      attempts.push(options)
      await initialize(options, attempts.length)
      const worker = {
        options,
        calls: [],
        active: false,
        disposed: false,
        getInitializationSummary: () => ({
          detProvider: options.ortOptions.backend === 'auto' ? provider : 'wasm',
          recProvider: options.ortOptions.backend === 'auto' ? provider : 'wasm',
        }),
        async predict(image) {
          assert.equal(worker.active, false, 'a Worker must never run concurrent inference')
          assert.equal(worker.disposed, false)
          worker.active = true
          worker.calls.push(image)
          maxActive = Math.max(maxActive, ++active)
          try {
            return [{ items: [{ text: await predict(image, worker) }] }]
          } finally {
            active -= 1
            worker.active = false
          }
        },
        async dispose() {
          assert.equal(worker.active, false, 'wait for inference before disposing')
          worker.disposed = true
        },
      }
      workers.push(worker)
      return worker
    },
  }
}

test('GPU is preferred, stays serial and preserves Chinese normalization', async () => {
  const factory = fakeFactory({ provider: 'webgpu' })
  const engine = await createChineseOcrEngine(factory.create)
  assert.equal(factory.workers.length, 1)
  assert.equal(factory.attempts[0].ortOptions.backend, 'auto')
  const results = await Promise.all([engine.recognize('強化荊棘的魔法'), engine.recognize('生命力+3')])
  assert.deepEqual(results, ['强化荆棘的魔法', '生命力+3'])
  assert.equal(factory.maxActive, 1)
  await engine.terminate()
  assert.ok(factory.workers.every((worker) => worker.disposed))
})

test('CPU uses four single-threaded Workers and gives queued frames to the next idle Worker', async () => {
  const gates = Array.from({ length: 7 }, deferred)
  const factory = fakeFactory({ predict: async (image) => { await gates[image].promise; return String(image) } })
  const engine = await createChineseOcrEngine(factory.create)
  assert.equal(factory.workers.length, 4)
  assert.ok(factory.attempts.every((options) => options.worker && options.ortOptions.numThreads === 1))
  const results = gates.map((_, i) => engine.recognize(i))
  assert.deepEqual(factory.workers.map((worker) => worker.calls), [[0], [1], [2], [3]])
  gates[2].resolve()
  assert.equal(await results[2], '2')
  assert.deepEqual(factory.workers[2].calls, [2, 4])
  for (const gate of gates) gate.resolve()
  assert.deepEqual(await Promise.all(results), ['0', '1', '2', '3', '4', '5', '6'])
  assert.equal(factory.maxActive, 4)
  await engine.terminate()
  assert.ok(factory.workers.every((worker) => worker.disposed))
})

test('GPU initialization failure falls back to four CPU Workers', async () => {
  const factory = fakeFactory({ initialize: (options) => {
    if (options.ortOptions.backend === 'auto') throw new Error('GPU initialization failed')
  } })
  const engine = await createChineseOcrEngine(factory.create)
  assert.equal(factory.workers.length, 4)
  assert.ok(factory.workers.every((worker) => worker.options.ortOptions.backend === 'wasm'))
  assert.equal(await engine.recognize('生命力+3'), '生命力+3')
  await engine.terminate()
})

test('GPU inference failure retries the frame and drains queued work on four CPU Workers', async () => {
  const gate = deferred()
  const factory = fakeFactory({ provider: 'webgpu', predict: async (image, worker) => {
    if (worker.options.ortOptions.backend === 'auto') throw new Error('GPU device lost')
    await gate.promise
    return image
  } })
  const engine = await createChineseOcrEngine(factory.create)
  const images = ['a', 'b', 'c', 'd', 'e', 'f']
  const results = images.map((image) => engine.recognize(image))
  // Termination must wait through fallback, retry and every already queued job.
  const stopped = engine.terminate()
  await setImmediate()
  assert.equal(factory.workers.length, 5)
  assert.equal(factory.workers[0].disposed, true)
  assert.equal(factory.maxActive, 4)
  assert.deepEqual(factory.workers.slice(1).flatMap((worker) => worker.calls), images.slice(0, 4))
  gate.resolve()
  assert.deepEqual(await Promise.all(results), images)
  await stopped
  assert.ok(factory.workers.every((worker) => worker.disposed))
  await assert.rejects(engine.recognize('late'), /terminated/)
  assert.equal(engine.terminate(), stopped)
})

test('a failed CPU frame does not stall the remaining queue', async () => {
  const factory = fakeFactory({ predict: async (image) => {
    if (image === 'bad') throw new Error('bad image')
    return image
  } })
  const engine = await createChineseOcrEngine(factory.create)
  const results = await Promise.allSettled(['bad', 'a', 'b', 'c', 'd', 'e'].map((image) => engine.recognize(image)))
  assert.equal(results[0].status, 'rejected')
  assert.deepEqual(results.slice(1).map((result) => result.value), ['a', 'b', 'c', 'd', 'e'])
  await engine.terminate()
})

test('partial CPU initialization failure disposes all successful Workers', async () => {
  const factory = fakeFactory({ initialize: (_, attempt) => {
    if (attempt === 3) throw new Error('model allocation failed')
  } })
  await assert.rejects(createChineseOcrEngine(factory.create), /model allocation failed/)
  assert.equal(factory.workers.length, 3)
  assert.ok(factory.workers.every((worker) => worker.disposed))
})

test('failed CPU fallback rejects all queued frames and can still terminate', async () => {
  const factory = fakeFactory({
    provider: 'webgpu',
    initialize: (options) => {
      if (options.ortOptions.backend === 'wasm') throw new Error('CPU unavailable')
    },
    predict: async () => { throw new Error('GPU lost') },
  })
  const engine = await createChineseOcrEngine(factory.create)
  const results = await Promise.allSettled(['a', 'b', 'c'].map((image) => engine.recognize(image)))
  assert.ok(results.every((result) => result.status === 'rejected' && result.reason.message === 'CPU unavailable'))
  await assert.rejects(engine.recognize('later'), /CPU unavailable/)
  await engine.terminate()
  assert.ok(factory.workers.every((worker) => worker.disposed))
})
