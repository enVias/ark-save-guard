import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  Client,
  GatewayIntentBits,
  TextChannel,
  EmbedBuilder,
  type MessageCreateOptions,
  type MessageEditOptions,
} from 'discord.js'
import { config } from './config'
import { CorruptionAlert, ServerStatus, formatBytes } from './detector'

let client: Client
let alertChannel: TextChannel
let statusMessageId: string | null = null
let eventMessageIds: Record<string, string[]> | null = null

interface StatusMessageState {
  channelId: string
  messageId: string
}

interface EventMessageState {
  channelId: string
  messages: Record<string, string[]>
}

// Keep the status message stable across Railway restarts.
const STATUS_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.cwd()
const STATUS_MESSAGE_FILE = join(STATUS_DIR, 'status-message.json')
const EVENT_MESSAGE_FILE = join(STATUS_DIR, 'event-messages.json')
const FTP_EVENT_KEY = 'ftp'

function corruptionEventKey(serverName: string): string {
  return `corruption:${serverName}`
}

function normalizeEventMessages(value: unknown): Record<string, string[]> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const messages: Record<string, string[]> = {}
  for (const [key, ids] of Object.entries(value)) {
    if (typeof ids === 'string') {
      messages[key] = [ids]
      continue
    }
    if (Array.isArray(ids) && ids.every(id => typeof id === 'string')) {
      messages[key] = [...new Set(ids)]
      continue
    }
    return null
  }
  return messages
}

function loadStatusMessageId(): string | null {
  if (statusMessageId) return statusMessageId

  try {
    const data = JSON.parse(readFileSync(STATUS_MESSAGE_FILE, 'utf-8')) as Partial<StatusMessageState>
    if (data.channelId === config.discord.channelId && typeof data.messageId === 'string') {
      statusMessageId = data.messageId
      return statusMessageId
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('Failed to load status message state:', err)
    }
  }

  return null
}

function saveStatusMessageId(messageId: string): void {
  const data: StatusMessageState = {
    channelId: config.discord.channelId,
    messageId,
  }
  writeFileSync(STATUS_MESSAGE_FILE, JSON.stringify(data, null, 2))
  statusMessageId = messageId
}

function loadEventMessageIds(): Record<string, string[]> {
  if (eventMessageIds) return eventMessageIds

  try {
    const data = JSON.parse(readFileSync(EVENT_MESSAGE_FILE, 'utf-8')) as Partial<EventMessageState>
    const messages = normalizeEventMessages(data.messages)
    if (data.channelId === config.discord.channelId && messages) {
      eventMessageIds = messages
      return eventMessageIds
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('Failed to load event message state:', err)
    }
  }

  eventMessageIds = {}
  return eventMessageIds
}

function saveEventMessageIds(): void {
  const messages = loadEventMessageIds()
  const data: EventMessageState = {
    channelId: config.discord.channelId,
    messages,
  }
  writeFileSync(EVENT_MESSAGE_FILE, JSON.stringify(data, null, 2))
}

function saveEventMessageId(key: string, messageId: string): void {
  const messages = loadEventMessageIds()
  const existingIds = messages[key] || []
  messages[key] = [...existingIds.filter(id => id !== messageId), messageId]
  saveEventMessageIds()
}

function removeEventMessageId(key: string, messageId: string): void {
  const messages = loadEventMessageIds()
  const remainingIds = (messages[key] || []).filter(id => id !== messageId)
  if (remainingIds.length > 0) {
    messages[key] = remainingIds
  } else {
    delete messages[key]
  }
  saveEventMessageIds()
}

function isUnknownMessageError(err: unknown): boolean {
  return (err as { code?: number }).code === 10008
}

function formatStatusLine(status: ServerStatus): string {
  if (status.state === 'alert') {
    return `\u{1F6A8} ${status.server}: \`${status.latestSize}\` (${status.detail || 'possible corruption'})`
  }
  if (status.state === 'ftpError') {
    return `\u{26A0}\u{FE0F} ${status.server}: \`${status.latestSize}\` (${status.detail || 'connection issue'})`
  }
  return `\u{2705} ${status.server}: \`${status.latestSize}\``
}

interface EventMessagePayload {
  content?: string
  embeds: EmbedBuilder[]
}

async function upsertEventMessage(key: string, payload: EventMessagePayload): Promise<void> {
  let existingMessageIds = loadEventMessageIds()[key] || []
  while (existingMessageIds.length > 0) {
    const existingMessageId = existingMessageIds[existingMessageIds.length - 1]
    try {
      const message = await alertChannel.messages.edit(existingMessageId, payload as MessageEditOptions)
      saveEventMessageId(key, message.id)
      return
    } catch (err) {
      if (!isUnknownMessageError(err)) throw err
      removeEventMessageId(key, existingMessageId)
      existingMessageIds = loadEventMessageIds()[key] || []
    }
  }

  await sendNewEventMessage(key, payload)
}

async function sendNewEventMessage(key: string, payload: EventMessagePayload): Promise<void> {
  const message = await alertChannel.send(payload as MessageCreateOptions)
  try {
    saveEventMessageId(key, message.id)
  } catch (err) {
    try {
      await message.delete()
    } catch (deleteErr) {
      console.warn('Failed to delete event message after state save failed:', deleteErr)
    }
    throw err
  }
}

async function deleteEventMessage(key: string, messageId: string): Promise<void> {
  try {
    await alertChannel.messages.delete(messageId)
  } catch (err) {
    if (!isUnknownMessageError(err)) throw err
  }

  removeEventMessageId(key, messageId)
}

function activeEventKeys(status: ServerStatus[]): Set<string> {
  const keys = new Set<string>()
  for (const serverStatus of status) {
    if (serverStatus.state === 'alert') {
      keys.add(corruptionEventKey(serverStatus.server))
    }
    if (serverStatus.hasFtpError) {
      keys.add(FTP_EVENT_KEY)
    }
  }
  return keys
}

// Connects the bot to Discord and finds the alert channel.
export async function initDiscord(): Promise<void> {
  client = new Client({
    intents: [GatewayIntentBits.Guilds],
    presence: { status: 'online' },
  })

  // Set up the "ready" listener before logging in so we don't miss it
  const ready = new Promise<void>((resolve, reject) => {
    client.once('clientReady', () => {
      console.log(`Discord bot logged in as ${client.user?.tag}`)
      resolve()
    })
    client.once('error', reject)
  })

  await client.login(config.discord.token)
  await ready

  // Try to find the alert channel — give a clear error if the bot can't access it
  let channel
  try {
    channel = await client.channels.fetch(config.discord.channelId)
  } catch (err: any) {
    if (err?.code === 50001) {
      throw new Error(
        `The bot doesn't have access to channel ${config.discord.channelId}.\n` +
        `  - Make sure the bot has been invited to your Discord server\n` +
        `  - Make sure the bot can see the channel (check channel permissions)\n` +
        `  - Double-check that DISCORD_CHANNEL_ID is correct`
      )
    }
    throw err
  }
  if (!channel || !(channel instanceof TextChannel)) {
    throw new Error(`Channel ${config.discord.channelId} is not a text channel or doesn't exist`)
  }
  alertChannel = channel
}

// Sends a big red warning to Discord when a save file looks corrupted.
export async function sendCorruptionAlert(alert: CorruptionAlert): Promise<void> {
  const ping = config.discord.alertRoleId ? `<@&${config.discord.alertRoleId}>` : '@here'

  const embed = new EmbedBuilder()
    .setColor(0xED4245)
    .setTitle('\u{1F6A8} Possible Save Corruption')
    .setDescription(
      `**${alert.serverName}** dropped **${alert.dropPercent}%** \u{2014} ` +
      `\`${formatBytes(alert.peakSize)}\` \u{2192} \`${formatBytes(alert.currentSize)}\``
    )
    .setFooter({ text: 'ARK Save Guard' })
    .setTimestamp()

  await sendNewEventMessage(corruptionEventKey(alert.serverName), { content: ping, embeds: [embed] })
}

// Recreates or refreshes an already-active corruption incident without pinging.
export async function sendActiveCorruptionNotice(status: ServerStatus): Promise<void> {
  if (status.state !== 'alert') return

  const embed = new EmbedBuilder()
    .setColor(0xED4245)
    .setTitle('\u{1F6A8} Possible Save Corruption')
    .setDescription(
      `**${status.server}** is still below the expected save size \u{2014} ` +
      `\`${status.latestSize}\`${status.detail ? ` (${status.detail})` : ''}`
    )
    .setFooter({ text: 'ARK Save Guard' })
    .setTimestamp()

  await upsertEventMessage(corruptionEventKey(status.server), { embeds: [embed] })
}

// Keeps one public-friendly FTP issue notice current while any server can't be reached.
export async function sendErrorNotice(serverNames: string[]): Promise<void> {
  const list = serverNames.map(n => `\u{2022} **${n}**`).join('\n')

  const embed = new EmbedBuilder()
    .setColor(0xFEE75C)
    .setTitle('\u{26A0}\u{FE0F} Connection Issues')
    .setDescription(
      `Having trouble checking ${serverNames.length === 1 ? 'a server' : 'some servers'}:\n\n` +
      list +
      `\n\nThis is usually temporary. Will keep trying.`
    )
    .setFooter({ text: 'ARK Save Guard' })
    .setTimestamp()

  await upsertEventMessage(FTP_EVENT_KEY, { embeds: [embed] })
}

// Periodic status update so people know the bot is still running.
// Edits one persistent status message instead of posting a new one each time.
export async function sendHeartbeat(status: ServerStatus[]): Promise<void> {
  const summary = status.map(formatStatusLine).join('\n')
  const hasIssues = status.some(s => s.state !== 'ok')
  const updatedAt = Math.floor(Date.now() / 1000)

  const embed = new EmbedBuilder()
    .setColor(hasIssues ? 0xFEE75C : 0x2B2D31)
    .setTitle('\u{1F996} Save File Status')
    .setDescription(`${summary}\n\n\u{1F551} Updated: <t:${updatedAt}:R>`)
    .setFooter({ text: 'ARK Save Guard' })
    .setTimestamp()

  const existingMessageId = loadStatusMessageId()
  if (existingMessageId) {
    try {
      const message = await alertChannel.messages.edit(existingMessageId, { embeds: [embed] })
      saveStatusMessageId(message.id)
      return
    } catch (err) {
      if (!isUnknownMessageError(err)) throw err
      console.warn('Status message no longer exists; creating a new one:', err)
    }
  }

  const message = await alertChannel.send({ embeds: [embed] })
  try {
    saveStatusMessageId(message.id)
  } catch (err) {
    try {
      await message.delete()
    } catch (deleteErr) {
      statusMessageId = message.id
      console.warn('Failed to delete status message after state save failed:', deleteErr)
    }
    throw err
  }
}

export async function deleteResolvedEventMessages(status: ServerStatus[]): Promise<void> {
  const activeKeys = activeEventKeys(status)
  const messages = loadEventMessageIds()
  const staleMessages = Object.entries(messages).flatMap(([key, ids]) => {
    const idsToDelete = activeKeys.has(key) ? ids.slice(0, -1) : ids
    return idsToDelete.map(id => ({ key, id }))
  })

  for (const { key, id } of staleMessages) {
    await deleteEventMessage(key, id)
  }
}

export function destroyDiscord(): void {
  client?.destroy()
}
