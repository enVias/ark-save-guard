import { Client, GatewayIntentBits, TextChannel, EmbedBuilder } from 'discord.js'
import { config } from './config'
import { CorruptionAlert, Recovery, formatBytes } from './detector'

let client: Client
let alertChannel: TextChannel

// Connects the bot to Discord and finds the alert channel.
export async function initDiscord(): Promise<void> {
  client = new Client({ intents: [GatewayIntentBits.Guilds] })

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
  const embed = new EmbedBuilder()
    .setColor(0xED4245)
    .setTitle('\u{1F6A8} Save Corruption Detected')
    .setDescription(
      `**${alert.serverName}** dropped **${alert.dropPercent}%** \u{2014} ` +
      `\`${formatBytes(alert.peakSize)}\` \u{2192} \`${formatBytes(alert.currentSize)}\``
    )
    .setFooter({ text: 'ARK Save Guard' })
    .setTimestamp()

  await alertChannel.send({ content: '@here', embeds: [embed] })
}

// Sends a green message when a server's save file is back to normal after a corruption alert.
export async function sendRecoveryNotice(recovery: Recovery): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('\u{2705} Save Restored')
    .setDescription(
      `**${recovery.serverName}** is back to normal \u{2014} \`${formatBytes(recovery.currentSize)}\``
    )
    .setFooter({ text: 'ARK Save Guard' })
    .setTimestamp()

  await alertChannel.send({ embeds: [embed] })
}

// Sends a yellow warning when one or more FTP connections failed.
export async function sendErrorNotice(errors: string[]): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor(0xFEE75C)
    .setTitle('\u{26A0}\u{FE0F} FTP Connection Issues')
    .setDescription(
      `Having trouble reaching ${errors.length === 1 ? 'a server' : `${errors.length} servers`}:\n\n` +
      errors.map(e => `\u{1F534} ${e}`).join('\n').slice(0, 4000) +
      `\n\n*Will keep retrying — you'll only see this once per server until it reconnects.*`
    )
    .setFooter({ text: 'ARK Save Guard' })
    .setTimestamp()

  await alertChannel.send({ embeds: [embed] })
}

// Sends a green "I'm online" message when the bot starts up.
export async function sendStartupMessage(): Promise<void> {
  const serverList = config.servers.map(s => s.name).join(', ') || 'none'

  const embed = new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('\u{2705} Save Guard Online')
    .setDescription(
      `\u{1F996} Watching **${config.servers.length}** server${config.servers.length === 1 ? '' : 's'} every **${config.checkIntervalMs / 60000}** min.\n` +
      serverList
    )
    .setFooter({ text: 'ARK Save Guard' })
    .setTimestamp()

  await alertChannel.send({ embeds: [embed] })
}

export function destroyDiscord(): void {
  client?.destroy()
}
