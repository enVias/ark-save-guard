import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Client, GatewayIntentBits, TextChannel, EmbedBuilder } from 'discord.js'
import { config } from './config'
import { CorruptionAlert, Recovery, ServerStatus, formatBytes } from './detector'

let client: Client
let alertChannel: TextChannel
let statusMessageId: string | null = null

interface StatusMessageState {
  channelId: string
  messageId: string
}

// Keep the status message stable across Railway restarts.
const STATUS_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.cwd()
const STATUS_MESSAGE_FILE = join(STATUS_DIR, 'status-message.json')

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
  statusMessageId = messageId

  try {
    const data: StatusMessageState = {
      channelId: config.discord.channelId,
      messageId,
    }
    writeFileSync(STATUS_MESSAGE_FILE, JSON.stringify(data, null, 2))
  } catch (err) {
    console.error('Failed to save status message state:', err)
  }
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

  await alertChannel.send({ content: ping, embeds: [embed] })
}

// Sends a public-friendly notice when one or more servers can't be reached.
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

  await alertChannel.send({ embeds: [embed] })
}

// Sends a green message when a server's save file is back to normal after a corruption alert.
export async function sendRecoveryNotice(recovery: Recovery): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('\u{2705} Save Size Recovered')
    .setDescription(
      `**${recovery.serverName}** is back within the expected size range \u{2014} \`${formatBytes(recovery.currentSize)}\``
    )
    .setFooter({ text: 'ARK Save Guard' })
    .setTimestamp()

  await alertChannel.send({ embeds: [embed] })
}

// Periodic status update so people know the bot is still running.
// Edits one persistent status message instead of posting a new one each time.
export async function sendHeartbeat(status: ServerStatus[], options: { recreate?: boolean } = {}): Promise<void> {
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
  if (options.recreate && existingMessageId) {
    try {
      await alertChannel.messages.delete(existingMessageId)
    } catch (err) {
      console.warn('Failed to delete old status message before recreating it:', err)
    }
  }

  if (existingMessageId && !options.recreate) {
    try {
      const message = await alertChannel.messages.edit(existingMessageId, { embeds: [embed] })
      saveStatusMessageId(message.id)
      return
    } catch (err) {
      console.warn('Failed to edit status message; creating a new one:', err)
    }
  }

  const message = await alertChannel.send({ embeds: [embed] })
  saveStatusMessageId(message.id)
}

export function destroyDiscord(): void {
  client?.destroy()
}
