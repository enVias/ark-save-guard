import { config } from './config'
import {
  checkForCorruption,
  CorruptionAlert,
  Recovery,
  getStatus,
  loadHistory,
  markAlertDelivered,
  markRecoveryDelivered,
  ServerStatus,
  formatBytes,
} from './detector'
import {
  initDiscord,
  sendCorruptionAlert,
  sendActiveCorruptionNotice,
  sendErrorNotice,
  sendHeartbeat,
  deleteResolvedEventMessages,
  destroyDiscord,
} from './discord'

// Makes sure we don't start a new check while the previous one is still going
// (e.g. if FTP servers are being really slow).
let checking = false

function applyCurrentEventsToStatus(status: ServerStatus[], alerts: CorruptionAlert[], recoveries: Recovery[]): ServerStatus[] {
  const alertsByServer = new Map(alerts.map(alert => [alert.serverName, alert]))
  const recoveriesByServer = new Map(recoveries.map(recovery => [recovery.serverName, recovery]))

  return status.map(serverStatus => {
    const alert = alertsByServer.get(serverStatus.server)
    if (alert) {
      return {
        ...serverStatus,
        latestSize: formatBytes(alert.currentSize),
        state: 'alert',
        detail: `down ${alert.dropPercent}% from ${formatBytes(alert.peakSize)}`,
      }
    }

    const recovery = recoveriesByServer.get(serverStatus.server)
    if (recovery) {
      return {
        ...serverStatus,
        latestSize: formatBytes(recovery.currentSize),
        state: 'ok',
        hasFtpError: undefined,
        detail: undefined,
      }
    }

    return serverStatus
  })
}

async function runCheck() {
  if (checking) {
    console.log(`[${new Date().toISOString()}] Previous check still running, skipping this one`)
    return
  }
  checking = true
  try {
    console.log(`[${new Date().toISOString()}] Checking save files...`)

    const { alerts, errors, recoveries } = await checkForCorruption()
    // Once a save is back to normal, clear the active alert state. The old
    // incident message is deleted by the cleanup pass below.
    for (const recovery of recoveries) {
      console.log(`RECOVERED: ${recovery.serverName} is back to normal (${recovery.currentSize} bytes)`)
      markRecoveryDelivered(recovery.serverName)
    }

    // Send each corruption alert to Discord. We only mark it as "delivered"
    // after Discord actually receives it — if sending fails, we'll try again
    // next cycle instead of silently dropping the alert.
    for (const alert of alerts) {
      console.warn(`ALERT: ${alert.serverName} dropped ${alert.dropPercent}% (${alert.currentSize} -> peak was ${alert.peakSize})`)
      try {
        await sendCorruptionAlert(alert)
        markAlertDelivered(alert.serverName, alert.peakSize)
      } catch (err) {
        console.error(`Failed to send alert for ${alert.serverName} to Discord (will retry next cycle):`, err)
      }
    }

    const status = applyCurrentEventsToStatus(getStatus(), alerts, recoveries)
    const newAlertServerNames = new Set(alerts.map(alert => alert.serverName))
    for (const serverStatus of status) {
      if (serverStatus.state !== 'alert' || newAlertServerNames.has(serverStatus.server)) continue

      try {
        await sendActiveCorruptionNotice(serverStatus)
      } catch (err) {
        console.error(`Failed to update active corruption notice for ${serverStatus.server}:`, err)
      }
    }

    const ftpErrorServerNames = status.filter(s => s.hasFtpError).map(s => s.server)

    // Keep one active FTP incident message current while connection issues exist.
    if (ftpErrorServerNames.length > 0) {
      const ftpErrorDetails = errors.length > 0
        ? errors.map(e => `${e.serverName}: ${e.reason}`).join('; ')
        : ftpErrorServerNames.join(', ')
      console.warn('FTP errors:', ftpErrorDetails)
      try {
        await sendErrorNotice(ftpErrorServerNames)
      } catch (err) {
        console.error('Failed to update FTP error notice in Discord:', err)
      }
    }

    const allOk = status.every(s => s.state === 'ok')
    console.log(
      `${allOk ? 'All OK' : 'Current status'}.`,
      status.map(s => `${s.server}: ${s.latestSize} (${s.historyLength} readings${s.detail ? `, ${s.detail}` : ''})`).join(', ')
    )

    // Routine checks edit the dashboard in place. Only delete resolved
    // incident messages after the dashboard reflects the current state.
    let statusUpdated = false
    try {
      await sendHeartbeat(status)
      statusUpdated = true
    } catch (err) {
      console.error('Failed to update save file status in Discord:', err)
    }

    if (statusUpdated) {
      try {
        await deleteResolvedEventMessages(status)
      } catch (err) {
        console.error('Failed to clean up resolved Discord event messages:', err)
      }
    }
  } catch (err) {
    console.error('Check cycle failed:', err)
  } finally {
    checking = false
  }
}

async function main() {
  console.log('ARK Save Guard starting...')
  console.log(`  Servers: ${config.servers.map(s => s.name).join(', ')}`)
  console.log(`  Check interval: ${config.checkIntervalMs / 60000} minutes`)
  console.log(`  Drop threshold: ${config.dropThreshold * 100}%`)
  console.log(`  History depth: ${config.historyDepth}`)

  // Load any saved history from last time we ran
  loadHistory()

  await initDiscord()

  // Check right away, then keep checking on a timer
  await runCheck()
  setInterval(runCheck, config.checkIntervalMs)

  console.log('Save Guard is running. Press Ctrl+C to stop.')
}

// Clean up when shutting down
process.on('SIGINT', () => {
  console.log('\nShutting down...')
  destroyDiscord()
  process.exit(0)
})

process.on('SIGTERM', () => {
  destroyDiscord()
  process.exit(0)
})

main().catch(err => {
  console.error('\n❌ ' + (err instanceof Error ? err.message : err))
  destroyDiscord()
  process.exit(1)
})
