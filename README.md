# ARK Save Guard

A Discord bot that watches your ARK server save files for corruption and alerts you if something goes wrong.

## What it does

Every 15 minutes, the bot connects to your Nitrado server(s) via FTP and checks the size of each `.ark` save file. ARK saves generally grow over time, so if one suddenly gets much smaller (more than 30% by default), that usually means corruption. The bot sends a Discord alert when this happens, and resets once the file goes back to normal.

Size history is saved to disk, so the bot picks up where it left off if it restarts.

## Before you start

No matter how you run the bot, you'll need a **Discord bot token** and your **Nitrado FTP details**. Follow these two sections first, then pick Option A or Option B below.

### 1. Create a Discord bot

1. Go to https://discord.com/developers/applications
2. Click **New Application**, give it a name, then go to the **Bot** tab on the left
3. Click **Reset Token** and copy the token somewhere safe — you'll need it soon
4. Go to **OAuth2 > URL Generator** on the left
5. Under **Scopes**, check `bot`
6. Under **Bot Permissions** (appears after checking bot), check `Send Messages` and `Embed Links`
7. Copy the generated URL at the bottom and open it in your browser to invite the bot to your server
8. Decide which channel you want alerts in, then right-click that channel and click **Copy Channel ID**
   - If you don't see "Copy Channel ID", go to Discord Settings > App Settings > Advanced and turn on **Developer Mode**

### 2. Get your Nitrado FTP details

For each map you want to monitor, you'll need these from your Nitrado dashboard:

| What | Where to find it | Example |
|------|-------------------|---------|
| FTP host | Nitrado dashboard, FTP section | `ausy073.gamedata.io` |
| FTP port | Usually 21 | `21` |
| FTP username | Nitrado dashboard, FTP section | `ni123456_1` |
| FTP password | Nitrado dashboard, FTP section | `myPassword` |
| Save folder path | Browse FTP to find it | `/arksa/ShooterGame/Saved/SavedArks/Ragnarok_WP` |
| Save filename | The `.ark` file in that folder | `Ragnarok_WP.ark` |

You'll also pick a **name** for each server — this is just a label that shows up in alerts (e.g. "Ragnarok", "The Island"). It doesn't need to match anything.

**Tip:** If you're not sure about the save path or filename, connect to the FTP with [FileZilla](https://filezilla-project.org/) (free) and browse to the save folder to check.

---

## Option A: Run it yourself (Windows, Mac, or Linux)

You'll need **Node.js 18 or newer** — download the **prebuilt installer** from https://nodejs.org (pick LTS, then grab the `.msi` for Windows or `.pkg` for Mac).

### A1. Get the code

- **With git:** Open a terminal (Command Prompt, PowerShell, or Terminal) and run `git clone https://github.com/enVias/ark-save-guard`
- **Without git:** Click the green **Code** button above, then **Download ZIP** and extract it

### A2. Configure

1. Copy `.env.example` to `.env` and fill in your Discord bot token and channel ID
   - **Windows:** If you can't see the file, open File Explorer > **View** > check **Hidden items**. If Windows won't let you rename it, open a Command Prompt in the folder and run `copy .env.example .env`
2. Copy `servers.example.json` to `servers.json` and fill in your server details
   - This is where you add your Nitrado FTP info for each map — the example file shows the format
   - Add more servers by copying a `{ }` block with a comma between each one (no comma after the last one)
   - Only have one server? Just delete the second `{ }` block and the comma before it

### A3. Install and run

Open a terminal in the bot's folder and run:

```
npm install
npm run build
npm start
```

> **Windows tip:** Open the folder in File Explorer, click the address bar, type `cmd`, and press Enter to open a terminal there.

You should see the bot come online in your Discord channel with a green "Save Guard Online" message.

### Keeping it running in the background

By default the bot stops when you close the terminal. To keep it running, install **pm2**:

```
npm install -g pm2
npm run build
pm2 start dist/index.js --name ark-save-guard
pm2 save
```

> **Linux/Mac:** If `npm install -g pm2` gives a permissions error, try `sudo npm install -g pm2`.

Useful pm2 commands:
- `pm2 status` — check if it's running
- `pm2 logs ark-save-guard` — see the output
- `pm2 restart ark-save-guard` — restart it
- `pm2 stop ark-save-guard` — stop it

---

## Option B: Railway (cloud hosting)

[Railway](https://railway.app) runs the bot in the cloud so you don't need to keep your computer on. There's a free trial, then a few dollars a month. You don't need Node.js installed.

### B1. Deploy

1. Go to https://railway.app and sign up or log in
2. Create a **New Project > Deploy from GitHub Repo** and paste `https://github.com/enVias/ark-save-guard`
3. Railway will build and try to start the bot — **it will crash because there are no settings yet.** That's normal, keep going.

### B2. Add your settings

Go to the **Variables** tab in your Railway service and add these one by one:

- `DISCORD_BOT_TOKEN` — your bot token
- `DISCORD_CHANNEL_ID` — your channel ID
- `SERVERS` — your server list as JSON (see below)

For `SERVERS`, paste something like this into the value field:

```json
[
  {
    "name": "Ragnarok",
    "host": "ausy073.gamedata.io",
    "port": 21,
    "user": "ni123456_1",
    "password": "yourPassword",
    "savePath": "/arksa/ShooterGame/Saved/SavedArks/Ragnarok_WP",
    "saveFile": "Ragnarok_WP.ark"
  },
  {
    "name": "The Island",
    "host": "ausy073.gamedata.io",
    "port": 21,
    "user": "ni123456_1",
    "password": "yourPassword",
    "savePath": "/arksa/ShooterGame/Saved/SavedArks/TheIsland_WP",
    "saveFile": "TheIsland_WP.ark"
  }
]
```

Each server is a `{ }` block separated by commas. Add as many as you need — just make sure there's a comma between each block, but **not** after the last one.

Railway restarts the bot each time you add a variable, so you may see errors until all three are in. That's fine.

### B3. Add storage

The bot needs persistent storage so its history survives redeploys:

1. Press **Ctrl+K** (Windows/Linux) or **Cmd+K** (Mac) to open the command palette
2. Type **Volume** and select **Create Volume**
3. Select your bot's service when asked
4. Set the mount path to `/data`

Once everything is set up, click **Deploy** on your service. The bot should come online in your Discord channel.

---

## Settings

| Setting | Required? | Default | What it does |
|---------|-----------|---------|--------------|
| `DISCORD_BOT_TOKEN` | Yes | — | Your Discord bot's token |
| `DISCORD_CHANNEL_ID` | Yes | — | The channel where alerts get posted |
| `SERVERS` | Railway only | — | Your server list as JSON (local users use `servers.json` instead) |
| `CHECK_INTERVAL_MINUTES` | No | `15` | How often to check (in minutes) |
| `DROP_THRESHOLD_PERCENT` | No | `30` | How big of a drop triggers an alert (30 = 30%) |
| `HISTORY_DEPTH` | No | `10` | How many past save sizes to remember |
