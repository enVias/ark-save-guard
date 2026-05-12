import { config } from './config'
import {
  checkForCorruption,
  CorruptionAlert,
  Recovery,
  getStatus,
  loadHistory,
  markAlertDelivered,
  markFtpErrorsDelivered,
  markRecoveryDelivered,
  ServerStatus,
  formatBytes,
} from './detector'
import { initDiscord, sendCorruptionAlert, sendRecoveryNotice, sendErrorNotice, sendHeartbeat, sendStartupMessage, destroyDiscord } from './discord'

// Makes sure we don't start a new check while the previous one is still going
// (e.g. if FTP servers are being really slow).
let checking = false
// Startup and event messages should leave the dashboard at the bottom of the
// channel. Keep retrying that recreation until the status update succeeds.
let statusRecreatePending = true

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
    // Let Discord know when a server's save is back to normal
    for (const recovery of recoveries) {
      console.log(`RECOVERED: ${recovery.serverName} is back to normal (${recovery.currentSize} bytes)`)
      try {
        await sendRecoveryNotice(recovery)
        markRecoveryDelivered(recovery.serverName)
        statusRecreatePending = true
      } catch (err) {
        console.error('Failed to send recovery notice to Discord:', err)
      }
    }

    // Let Discord know about connection problems (just server names, no technical details)
    if (errors.length > 0) {
      const errorServerNames = errors.map(e => e.serverName)
      console.warn('FTP errors:', errors.map(e => `${e.serverName}: ${e.reason}`).join('; '))
      try {
        await sendErrorNotice(errorServerNames)
        markFtpErrorsDelivered(errorServerNames)
        statusRecreatePending = true
      } catch (err) {
        console.error('Failed to send error notice to Discord:', err)
      }
    }

    // Send each corruption alert to Discord. We only mark it as "delivered"
    // after Discord actually receives it — if sending fails, we'll try again
    // next cycle instead of silently dropping the alert.
    for (const alert of alerts) {
      console.warn(`ALERT: ${alert.serverName} dropped ${alert.dropPercent}% (${alert.currentSize} -> peak was ${alert.peakSize})`)
      try {
        await sendCorruptionAlert(alert)
        markAlertDelivered(alert.serverName, alert.peakSize)
        statusRecreatePending = true
      } catch (err) {
        console.error(`Failed to send alert for ${alert.serverName} to Discord (will retry next cycle):`, err)
      }
    }

    const status = applyCurrentEventsToStatus(getStatus(), alerts, recoveries)
    const allOk = status.every(s => s.state === 'ok')
    console.log(
      `${allOk ? 'All OK' : 'Current status'}.`,
      status.map(s => `${s.server}: ${s.latestSize} (${s.historyLength} readings${s.detail ? `, ${s.detail}` : ''})`).join(', ')
    )

    // Routine checks edit the dashboard. Event checks and startup recreate it underneath newer messages.
    try {
      await sendHeartbeat(status, { recreate: statusRecreatePending })
      statusRecreatePending = false
    } catch (err) {
      console.error('Failed to update save file status in Discord:', err)
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
  await sendStartupMessage()

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
