import { Client, GatewayIntentBits, TextChannel, EmbedBuilder } from 'discord.js'
import { config } from './config'
import { CorruptionAlert, Recovery, formatBytes } from './detector'

let client: Client
let alertChannel: TextChannel

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

// Sends a green "I'm online" message when the bot starts up.
export async function sendStartupMessage(): Promise<void> {
  const serverList = config.servers.map(s => s.name).join(', ') || 'none'

  const embed = new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('\u{2705} Save Guard Online')
    .setDescription(
      `\u{1F996} Watching **${config.servers.length}** server${config.servers.length === 1 ? '' : 's'}.\n` +
      serverList
    )
    .setFooter({ text: 'ARK Save Guard' })
    .setTimestamp()

  await alertChannel.send({ embeds: [embed] })
}

// Periodic status update so people know the bot is still running.
export async function sendHeartbeat(status: { server: string; latestSize: string }[]): Promise<void> {
  const summary = status.map(s => `\u{2705} ${s.server}: \`${s.latestSize}\``).join('\n')

  const embed = new EmbedBuilder()
    .setColor(0x2B2D31)
    .setTitle('\u{1F996} Routine Check \u{2014} No Size Issues Detected')
    .setDescription(summary)
    .setFooter({ text: 'ARK Save Guard' })
    .setTimestamp()

  await alertChannel.send({ embeds: [embed] })
}

export function destroyDiscord(): void {
  client?.destroy()
}
