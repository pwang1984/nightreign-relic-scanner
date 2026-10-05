import { SCAN_INTERVAL_SEC } from './videoFrames.js'

function hasConstantFrameRate(metrics) {
  const fps = metrics?.underlyingFrameRate
  return metrics?.frameRateIsConstant && metrics.probedPacketCount >= 2 && Number.isFinite(fps) && fps > 0
}

export function scanIntervalFromMetrics(metrics) {
  if (!hasConstantFrameRate(metrics)) return SCAN_INTERVAL_SEC
  // Retain fractional rates such as 30000/1001; rounding down can skip frames
  // over a long recording. Videos above 60 fps use the existing 60 Hz cap.
  return Math.max(SCAN_INTERVAL_SEC, 1 / metrics.underlyingFrameRate)
}

// Read packet timestamps without decoding or playing the video. Inspect the
// full track so a slow opening cannot hide a later switch to 60 fps. If the
// format is unsupported, timing varies, or inspection is slow, keep 60 Hz.
export async function detectScanTiming(file, { timeoutMs = 3000 } = {}) {
  const fallback = { intervalSec: SCAN_INTERVAL_SEC }
  if (!file) return fallback
  let input
  let timer
  let expired = false
  async function inspect() {
    const { Input, BlobSource, ALL_FORMATS } = await import('mediabunny')
    if (expired) return fallback
    input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
    const track = await input.getPrimaryVideoTrack()
    if (!track) return fallback
    const metrics = await track.computeFrameRateMetrics({ targetPacketCount: Infinity })
    if (!hasConstantFrameRate(metrics)) return fallback
    const frameOriginSec = await track.getFirstTimestamp()
    if (!Number.isFinite(frameOriginSec)) return fallback
    return { intervalSec: scanIntervalFromMetrics(metrics), frameOriginSec }
  }
  try {
    return await Promise.race([
      inspect(),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          expired = true
          resolve(fallback)
        }, timeoutMs)
      }),
    ])
  } catch {
    return fallback
  } finally {
    clearTimeout(timer)
    input?.dispose()
  }
}
