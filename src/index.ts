import { config } from './config'
import { checkForCorruption, getStatus, loadHistory, markAlertDelivered } from './detector'
import { initDiscord, sendCorruptionAlert, sendRecoveryNotice, sendErrorNotice, sendHeartbeat, sendStartupMessage, destroyDiscord } from './discord'

// Makes sure we don't start a new check while the previous one is still going
// (e.g. if FTP servers are being really slow).
let checking = false
let checkCount = 0

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
      await sendRecoveryNotice(recovery).catch(err =>
        console.error('Failed to send recovery notice to Discord:', err)
      )
    }

    // Let Discord know about any FTP connection problems
    if (errors.length > 0) {
      console.warn('FTP errors:', errors)
      await sendErrorNotice(errors).catch(err =>
        console.error('Failed to send error notice to Discord:', err)
      )
    }

    // Send each corruption alert to Discord. We only mark it as "delivered"
    // after Discord actually receives it — if sending fails, we'll try again
    // next cycle instead of silently dropping the alert.
    for (const alert of alerts) {
      console.warn(`ALERT: ${alert.serverName} dropped ${alert.dropPercent}% (${alert.currentSize} -> peak was ${alert.peakSize})`)
      try {
        await sendCorruptionAlert(alert)
        markAlertDelivered(alert.serverName)
      } catch (err) {
        console.error(`Failed to send alert for ${alert.serverName} to Discord (will retry next cycle):`, err)
      }
    }

    if (alerts.length === 0 && errors.length === 0) {
      const status = getStatus()
      console.log('All OK.', status.map(s => `${s.server}: ${s.latestSize} (${s.historyLength} readings)`).join(', '))

      // Every 4th check, post a heartbeat to Discord so people know it's alive
      checkCount++
      if (checkCount % 4 === 0) {
        await sendHeartbeat(status).catch(err =>
          console.error('Failed to send heartbeat to Discord:', err)
        )
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
