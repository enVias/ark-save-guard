import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { ServerEntry, config } from './config'
import { fetchAllSizes, fetchSaveSize } from './ftp'

export interface CorruptionAlert {
  serverName: string
  currentSize: number
  peakSize: number
  dropPercent: number
}

interface SavedState {
  sizeHistory: Record<string, number[]>
  activeAlertPeaks: Record<string, number>
}

// If running on Railway with a volume mounted, save history there so it
// survives redeploys. Otherwise just save it in the current folder.
const HISTORY_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.cwd()
const HISTORY_FILE = join(HISTORY_DIR, 'save-history.json')

// Keeps track of each server's recent save file sizes so we can spot sudden drops.
// Saved to disk so we don't lose it when the bot restarts.
const sizeHistory = new Map<string, number[]>()

// Remembers the peak size that triggered each active corruption alert,
// so we don't spam and recovery is measured against the original healthy size.
const sentAlertPeaks = new Map<string, number>()

// Tracks servers currently failing FTP checks so the dashboard stays accurate.
const activeFtpErrors = new Set<string>()

// Tracks which active FTP errors have already been announced in Discord.
// If sending the notice fails, the server is left out of this set and retried.
const sentFtpErrors = new Set<string>()

// Large ARK saves can appear smaller over FTP while Nitrado is still writing
// them. Confirm any alert-sized drop with several short-spaced reads before notifying.
const CONFIRMATION_SAMPLE_COUNT = 3
const CONFIRMATION_SAMPLE_INTERVAL_MS = 30_000
const IN_PROGRESS_GROWTH_TOLERANCE = 0.02

function isHistoryRecord(value: unknown): value is Record<string, number[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every(history =>
    Array.isArray(history) && history.every(n => typeof n === 'number' && n > 0)
  )
}

// Loads previous size history from disk (if it exists) so we can pick
// up right where we left off after a restart.
export function loadHistory(): void {
  try {
    const raw = readFileSync(HISTORY_FILE, 'utf-8')
    const data = JSON.parse(raw) as Partial<SavedState> | Record<string, number[]>
    const loadedState = isHistoryRecord(data) ? { sizeHistory: data, activeAlertPeaks: {} } : data
    const configuredServerNames = new Set(config.servers.map(s => s.name))
    let loaded = 0
    for (const [name, history] of Object.entries(loadedState.sizeHistory || {})) {
      if (Array.isArray(history) && history.every(n => typeof n === 'number' && n > 0)) {
        sizeHistory.set(name, history.slice(-(config.historyDepth + 1)))
        loaded++
      }
    }
    let loadedAlerts = 0
    for (const [name, peakSize] of Object.entries(loadedState.activeAlertPeaks || {})) {
      if (configuredServerNames.has(name) && typeof peakSize === 'number' && peakSize > 0) {
        sentAlertPeaks.set(name, peakSize)
        loadedAlerts++
      }
    }
    console.log(`Loaded size history for ${loaded} server(s) from ${HISTORY_FILE}`)
    if (loadedAlerts > 0) {
      console.log(`Loaded ${loadedAlerts} active alert(s) from ${HISTORY_FILE}`)
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log('No existing history file — starting fresh')
    } else {
      console.warn('Failed to load history file (starting fresh):', err)
    }
  }
}

// Writes current size history to disk so it survives restarts.
function saveHistory(): void {
  try {
    const data: SavedState = {
      sizeHistory: {},
      activeAlertPeaks: {},
    }
    for (const [name, history] of sizeHistory) {
      data.sizeHistory[name] = history
    }
    for (const [name, peakSize] of sentAlertPeaks) {
      data.activeAlertPeaks[name] = peakSize
    }
    writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2))
  } catch (err) {
    console.error('Failed to save history:', err)
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export { formatBytes }

/*
 * The main corruption check. Runs every cycle.
 *
 * How it works:
 *   1. Grab the current .ark file size from each server's FTP
 *   2. Compare it to the biggest size we've seen recently (the "peak")
 *   3. If the file suddenly got way smaller (>30% drop), confirm it with
 *      several spaced FTP reads before alerting
 *
 * We only record a new size when it actually changes — since Nitrado only
 * saves about once an hour, most checks will see the exact same file size.
 * This way our history tracks real save changes, not duplicate readings.
 */
export interface Recovery {
  serverName: string
  currentSize: number
}

export interface FtpError {
  serverName: string
  reason: string
}

export interface ServerStatus {
  server: string
  historyLength: number
  latestSize: string
  state: 'ok' | 'alert' | 'ftpError'
  detail?: string
}

interface SizeAssessment {
  peakSize: number
  dropPercent: number
  isAlertSizedDrop: boolean
}

interface AlertCandidate {
  server: ServerEntry
  currentSize: number
  peakSize: number
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getHistory(name: string): number[] {
  return sizeHistory.get(name) || []
}

function recordSize(name: string, size: number): void {
  const history = getHistory(name)
  if (history.length === 0 || history[history.length - 1] !== size) {
    history.push(size)
  }

  while (history.length > config.historyDepth + 1) {
    history.shift()
  }

  sizeHistory.set(name, history)
}

function assessSize(history: number[], currentSize: number): SizeAssessment | null {
  const previousReadings =
    history.length > 0 && history[history.length - 1] === currentSize
      ? history.slice(0, -1)
      : history

  if (previousReadings.length === 0) return null

  const peakSize = Math.max(...previousReadings)
  if (peakSize <= 0) return null

  const dropPercent = currentSize < peakSize
    ? ((peakSize - currentSize) / peakSize) * 100
    : 0

  return {
    peakSize,
    dropPercent,
    isAlertSizedDrop: dropPercent > config.dropThreshold * 100,
  }
}

function queueFtpErrorNotice(server: ServerEntry, reason: string, errors: FtpError[]): void {
  activeFtpErrors.add(server.name)
  if (!sentFtpErrors.has(server.name)) {
    errors.push({ serverName: server.name, reason })
  }
}

function clearFtpError(name: string): void {
  activeFtpErrors.delete(name)
  sentFtpErrors.delete(name)
}

function hasMaterialSizeMovement(sizes: number[], peakSize: number): boolean {
  if (sizes.length < 2) return false
  return (Math.max(...sizes) - Math.min(...sizes)) / peakSize > IN_PROGRESS_GROWTH_TOLERANCE
}

async function confirmAlertCandidates(
  candidates: AlertCandidate[],
  alerts: CorruptionAlert[],
  errors: FtpError[],
): Promise<void> {
  if (candidates.length === 0) return

  console.warn(
    `Confirming ${candidates.length} possible save size drop(s) with ` +
    `${CONFIRMATION_SAMPLE_COUNT} sample(s) every ${CONFIRMATION_SAMPLE_INTERVAL_MS / 1000}s before alerting...`
  )

  const pending = new Map(candidates.map(candidate => [candidate.server.name, candidate]))
  const latestSizes = new Map(candidates.map(candidate => [candidate.server.name, candidate.currentSize]))
  const latestAssessments = new Map<string, SizeAssessment>()
  const sampledSizes = new Map(candidates.map(candidate => [candidate.server.name, [candidate.currentSize]]))

  for (let sample = 1; sample <= CONFIRMATION_SAMPLE_COUNT && pending.size > 0; sample++) {
    await sleep(CONFIRMATION_SAMPLE_INTERVAL_MS)

    const sampleCandidates = Array.from(pending.values())
    const confirmationResults = await Promise.all(sampleCandidates.map(candidate => fetchSaveSize(candidate.server)))

    for (let i = 0; i < sampleCandidates.length; i++) {
      const candidate = sampleCandidates[i]
      const result = confirmationResults[i]
      const { name } = candidate.server

      if (result.error) {
        queueFtpErrorNotice(candidate.server, result.error, errors)
        pending.delete(name)
        continue
      }
      if (result.size === null) {
        console.log(`${name}: confirmation sample returned no usable size; deferring alert`)
        pending.delete(name)
        continue
      }

      clearFtpError(name)

      const confirmedSize = result.size
      const assessment = assessSize(getHistory(name), confirmedSize)

      if (!assessment?.isAlertSizedDrop) {
        recordSize(name, confirmedSize)
        console.log(
          `${name}: ignored transient drop ` +
          `(${formatBytes(candidate.peakSize)} -> ${formatBytes(candidate.currentSize)}; ` +
          `sample ${sample} confirmed ${formatBytes(confirmedSize)})`
        )
        pending.delete(name)
        latestSizes.delete(name)
        latestAssessments.delete(name)
        continue
      }

      latestSizes.set(name, confirmedSize)
      latestAssessments.set(name, assessment)
      sampledSizes.get(name)?.push(confirmedSize)
    }
  }

  for (const candidate of pending.values()) {
    const { name } = candidate.server
    const latestSize = latestSizes.get(name)
    const assessment = latestAssessments.get(name)
    const samples = sampledSizes.get(name) || []
    if (latestSize === undefined || !assessment) continue

    if (hasMaterialSizeMovement(samples, assessment.peakSize)) {
      console.log(
        `${name}: possible drop is still changing; deferring alert ` +
        `(${samples.map(formatBytes).join(' -> ')})`
      )
      continue
    }

    recordSize(name, latestSize)
    alerts.push({
      serverName: name,
      currentSize: latestSize,
      peakSize: assessment.peakSize,
      dropPercent: Math.round(assessment.dropPercent),
    })
  }
}

export async function checkForCorruption(): Promise<{
  alerts: CorruptionAlert[]
  errors: FtpError[]
  recoveries: Recovery[]
}> {
  const results = await fetchAllSizes(config.servers)
  const alerts: CorruptionAlert[] = []
  const errors: FtpError[] = []
  const recoveries: Recovery[] = []
  const candidates: AlertCandidate[] = []

  for (const result of results) {
    // If we couldn't connect to this server's FTP, queue a notice. Once a
    // notice is delivered, further notices are suppressed until FTP recovers.
    if (result.error) {
      queueFtpErrorNotice(result.server, result.error, errors)
      continue
    }
    if (result.size === null) continue

    // FTP worked again, so future outages should be announced normally.
    clearFtpError(result.server.name)

    const { name } = result.server
    const currentSize = result.size
    const activeAlertPeak = sentAlertPeaks.get(name)

    if (activeAlertPeak !== undefined) {
      recordSize(name, currentSize)
      const dropPercent = ((activeAlertPeak - currentSize) / activeAlertPeak) * 100
      if (currentSize >= activeAlertPeak || dropPercent <= config.dropThreshold * 100) {
        recoveries.push({ serverName: name, currentSize })
      }
      continue
    }

    const assessment = assessSize(getHistory(name), currentSize)

    if (assessment?.isAlertSizedDrop) {
      candidates.push({
        server: result.server,
        currentSize,
        peakSize: assessment.peakSize,
      })
      continue
    }

    recordSize(name, currentSize)
  }

  await confirmAlertCandidates(candidates, alerts, errors)

  saveHistory()
  return { alerts, errors, recoveries }
}

// Called by index.ts after an alert is successfully sent to Discord.
// Prevents the same alert from being sent again until the size recovers.
export function markAlertDelivered(name: string, peakSize: number) {
  sentAlertPeaks.set(name, peakSize)
  saveHistory()
}

// Called after a recovery notice reaches Discord. If sending fails, the active
// alert remains in place and the recovery notice will be retried next cycle.
export function markRecoveryDelivered(name: string) {
  clearAlertsForServer(name)
  saveHistory()
}

// Called after an FTP error notice reaches Discord. If sending fails, the
// current outage stays pending and the notice will be retried next cycle.
export function markFtpErrorsDelivered(serverNames: string[]) {
  for (const name of serverNames) {
    if (activeFtpErrors.has(name)) {
      sentFtpErrors.add(name)
    }
  }
}

// Resets alert tracking for a server so it can alert again in the future
// (called when the save file size goes back to normal).
function clearAlertsForServer(name: string) {
  sentAlertPeaks.delete(name)
}

export function getStatus(): ServerStatus[] {
  return config.servers.map(s => {
    const history = sizeHistory.get(s.name) || []
    const latestSize = history.length > 0 ? history[history.length - 1] : null
    const activeAlertPeak = sentAlertPeaks.get(s.name)
    const hasFtpError = activeFtpErrors.has(s.name)

    if (activeAlertPeak !== undefined) {
      const dropPercent = latestSize !== null && latestSize < activeAlertPeak
        ? Math.round(((activeAlertPeak - latestSize) / activeAlertPeak) * 100)
        : 0
      const alertDetail = `down ${dropPercent}% from ${formatBytes(activeAlertPeak)}`

      return {
        server: s.name,
        historyLength: history.length,
        latestSize: latestSize !== null ? formatBytes(latestSize) : 'no data',
        state: 'alert',
        detail: hasFtpError ? `${alertDetail}; connection issue` : alertDetail,
      }
    }

    if (hasFtpError) {
      return {
        server: s.name,
        historyLength: history.length,
        latestSize: latestSize !== null ? formatBytes(latestSize) : 'no data',
        state: 'ftpError',
        detail: 'connection issue',
      }
    }

    return {
      server: s.name,
      historyLength: history.length,
      latestSize: latestSize !== null ? formatBytes(latestSize) : 'no data',
      state: 'ok',
    }
  })
}
