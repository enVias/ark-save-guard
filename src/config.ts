import 'dotenv/config'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

export interface ServerEntry {
  name: string
  host: string
  port: number
  user: string
  password: string
  savePath: string
  saveFile: string
}

function requireEnv(key: string): string {
  const val = process.env[key]
  if (!val) throw new Error(
    `Missing required setting: ${key}\n` +
    `  Add it to your .env file (local) or Railway Variables tab (cloud).`
  )
  return val
}

function readIntSetting(key: string, defaultValue: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[key]
  if (!raw) return defaultValue

  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    console.warn(`Invalid ${key}="${raw}" — using ${defaultValue}`)
    return defaultValue
  }

  return value
}

const MAX_CHECK_INTERVAL_MINUTES = 1440
const MAX_HISTORY_DEPTH = 1000

export const config = {
  discord: {
    token: requireEnv('DISCORD_BOT_TOKEN'),
    channelId: requireEnv('DISCORD_CHANNEL_ID'),
    alertRoleId: process.env.ALERT_ROLE_ID || '',
  },
  checkIntervalMs: readIntSetting('CHECK_INTERVAL_MINUTES', 15, 1, MAX_CHECK_INTERVAL_MINUTES) * 60 * 1000,
  dropThreshold: readIntSetting('DROP_THRESHOLD_PERCENT', 30, 1, 99) / 100,
  historyDepth: readIntSetting('HISTORY_DEPTH', 10, 1, MAX_HISTORY_DEPTH),
  servers: parseServers(),
}

function parseServers(): ServerEntry[] {
  let raw: string | undefined

  // Check for SERVERS env var first (used by Railway and other cloud hosts)
  if (process.env.SERVERS) {
    raw = process.env.SERVERS.trim()

    // Strip outer quotes in case the .env file wraps the value in them
    if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
      raw = raw.slice(1, -1)
    }
  } else {
    // Fall back to servers.json file (nicer for local setups)
    const filePath = join(process.cwd(), 'servers.json')
    if (!existsSync(filePath)) {
      throw new Error(
        'No server list found. Either:\n' +
        '  - Create a servers.json file (copy servers.example.json and fill in your details)\n' +
        '  - Or set the SERVERS env var with your server list as JSON'
      )
    }
    try {
      raw = readFileSync(filePath, 'utf-8')
    } catch (err) {
      throw new Error(`Failed to read servers.json: ${(err as Error).message}`)
    }
  }

  try {
    const parsed = JSON.parse(raw) as ServerEntry[]
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('Server list must be a non-empty JSON array')
    }
    const names = new Set<string>()
    for (const s of parsed) {
      const required = ['name', 'host', 'user', 'password', 'savePath', 'saveFile'] as const
      const missing = required.filter(f => !s[f])
      if (missing.length > 0) {
        throw new Error(
          `Server "${s.name || '(unnamed)'}" is missing: ${missing.join(', ')}\n` +
          `  Check your servers.json or SERVERS env var.`
        )
      }
      if (names.has(s.name)) {
        throw new Error(`Duplicate server name "${s.name}" — each server must have a unique name`)
      }
      names.add(s.name)
      s.port = s.port || 21
    }
    return parsed
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Server list is not valid JSON: ${err.message}`)
    }
    throw err
  }
}
