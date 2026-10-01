const mineflayer = require('mineflayer')
const axios = require('axios')
const express = require('express')
const fs = require('fs')
const path = require('path')
const FormData = require('form-data')
const { PNG } = require('pngjs')

const CONFIG = {
  host: process.env.MC_HOST || 'sleepyempiregen.minefort.com',
  port: parseInt(process.env.MC_PORT) || 25565,
  username: process.env.MC_USERNAME || 'tpstoohigh',
  password: process.env.MC_PASSWORD,
  version: (process.env.MC_VERSION && process.env.MC_VERSION !== 'false') ? process.env.MC_VERSION : undefined,
  discordWebhook: process.env.DISCORD_WEBHOOK || '',
  discordBotToken: process.env.DISCORD_BOT_TOKEN || '',
  discordChannelId: process.env.DISCORD_CHANNEL_ID || ''
}

const MAP_DIR = path.join(__dirname, 'maps')
if (!fs.existsSync(MAP_DIR)) fs.mkdirSync(MAP_DIR, { recursive: true })

const BASE = [
  [0,0,0],[127,178,56],[247,233,163],[199,199,199],[255,0,0],[160,160,255],
  [167,167,167],[0,124,0],[255,255,255],[164,168,184],[151,109,77],[112,112,112],
  [64,64,255],[143,119,72],[255,252,245],[216,127,51],[178,76,216],[102,153,216],
  [229,229,51],[127,204,25],[242,127,165],[76,76,76],[153,153,153],[76,127,153],
  [127,63,178],[51,76,178],[102,76,127],[102,127,51],[153,51,51],[25,25,25],
  [250,238,77],[92,219,213],[74,128,255],[0,217,58],[129,86,49],[112,2,0],
  [209,177,161],[159,82,36],[149,87,108],[112,108,138],[186,133,36],[103,117,53],
  [160,77,78],[57,41,35],[135,107,98],[87,92,92],[122,73,88],[76,62,92],
  [76,50,35],[76,82,42],[142,60,46],[37,22,16],[189,48,49],[148,63,97],
  [92,25,29],[22,126,134],[58,142,140],[86,44,62],[20,180,133],[100,100,100],
  [216,175,147],[127,167,150],[0,0,0]
]
const SHADES = [180, 220, 255, 135]

function paletteColor(id) {
  if (id === 0) return [0, 0, 0, 0]
  const baseIdx = (id - 1) >> 2
  const shadeIdx = (id - 1) & 3
  const base = BASE[baseIdx] || [0, 0, 0]
  const mult = SHADES[shadeIdx] / 255
  return [
    Math.min(255, Math.floor(base[0] * mult)),
    Math.min(255, Math.floor(base[1] * mult)),
    Math.min(255, Math.floor(base[2] * mult)),
    255
  ]
}

const app = express()
const PORT = process.env.PORT || 3000
app.get('/', (req, res) => res.json({ status: 'ok' }))
app.listen(PORT, () => console.log(`[HTTP] Listening on ${PORT}`))

async function sendDiscordText(message) {
  if (!CONFIG.discordWebhook) return
  try {
    await axios.post(CONFIG.discordWebhook, { content: String(message).substring(0, 1900) })
  } catch (err) { console.error('[DISCORD]', err.message) }
}

async function sendDiscordImage(imagePath, caption) {
  if (!CONFIG.discordWebhook) return
  try {
    const form = new FormData()
    form.append('content', caption || '')
    form.append('file', fs.createReadStream(imagePath), { filename: path.basename(imagePath) })
    await axios.post(CONFIG.discordWebhook, form, { headers: form.getHeaders() })
    console.log('[DISCORD] Sent:', imagePath)
  } catch (err) { console.error('[DISCORD] Image failed:', err.message) }
}

async function fetchCaptchaAnswer() {
  if (!CONFIG.discordBotToken || !CONFIG.discordChannelId) return null
  try {
    const res = await axios.get(
      `https://discord.com/api/v10/channels/${CONFIG.discordChannelId}/messages?limit=10`,
      { headers: { Authorization: `Bot ${CONFIG.discordBotToken}` } }
    )
    for (const msg of res.data) {
      if (msg.content && msg.content.startsWith('!captcha ')) {
        const ans = msg.content.replace('!captcha ', '').trim()
        await axios.delete(
          `https://discord.com/api/v10/channels/${CONFIG.discordChannelId}/messages/${msg.id}`,
          { headers: { Authorization: `Bot ${CONFIG.discordBotToken}` } }
        ).catch(() => {})
        return ans
      }
    }
  } catch (err) { console.error('[DISCORD]', err.message) }
  return null
}

// Global map storage — persists across scans
const capturedMaps = new Map()
let captchaSent = false
let pollingActive = false

function createBot() {
  console.log('[BOT] Connecting...')
  captchaSent = false
  pollingActive = false
  capturedMaps.clear()

  const bot = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username,
    version: CONFIG.version,
    auth: 'offline'
  })

  // ─── MAP PACKET LISTENER ───
  const mapHandler = (packet) => {
    try {
      const id = packet.itemDamage !== undefined ? packet.itemDamage : packet.mapId
      const width = packet.columns || 128
      const height = packet.rows || 128
      const data = packet.data
      console.log(`[MAP] Received map ${id} (${width}x${height})`)
      if (!data || data.length < width * height) return

      const png = new PNG({ width, height })
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const [r, g, b, a] = paletteColor(data[x + y * width])
          const p = (y * width + x) * 4
          png.data[p] = r
          png.data[p + 1] = g
          png.data[p + 2] = b
          png.data[p + 3] = a
        }
      }
      const file = path.join(MAP_DIR, `map_${id}.png`)
      fs.writeFileSync(file, PNG.sync.write(png))
      capturedMaps.set(id, file)
      console.log(`[MAP] Saved map_${id}.png (total: ${capturedMaps.size})`)
    } catch (e) { console.error('[MAP] Render fail:', e.message) }
  }

  ;['map', 'map_data'].forEach(name => {
    try { bot._client.on(name, mapHandler) } catch (e) {}
  })

  bot.on('message', (msg) => {
    const text = msg.toString()
    console.log(`[CHAT] ${text}`)

    if (/\/register/i.test(text)) {
      bot.chat(`/register ${CONFIG.password} ${CONFIG.password}`)
    } else if (/\/login/i.test(text)) {
      bot.chat(`/login ${CONFIG.password}`)
    } else if (/captcha/i.test(text)) {
      sendDiscordText(`🔐 CAPTCHA prompt detected — waiting for map data...`)
      // Give the server 3 seconds to send maps, then flush whatever we have
      setTimeout(() => flushMaps(), 3000)
    }
  })

  bot.on('login', () => {
    console.log(`[BOT] Logged in as ${bot.username}`)
    sendDiscordText(`✅ Bot **${bot.username}** joined`)
    setInterval(() => {
      if (bot.entity) {
        bot.setControlState('jump', true)
        setTimeout(() => bot.setControlState('jump', false), 400)
      }
    }, 30000)
  })

  bot.on('kicked', (reason) => {
    const r = typeof reason === 'string' ? reason : JSON.stringify(reason)
    console.log(`[BOT] Kicked: ${r}`)
    sendDiscordText(`❌ Kicked: ${r}`)
    setTimeout(createBot, 15000)
  })

  bot.on('error', (err) => console.log(`[BOT] Error: ${err.message}`))
  bot.on('end', () => { setTimeout(createBot, 15000) })
}

// ─── SEND ALL CAPTURED MAPS TO DISCORD ───
async function flushMaps() {
  if (captchaSent) {
    console.log('[CAPTCHA] Already sent, skipping')
    return
  }

  if (capturedMaps.size === 0) {
    console.log('[CAPTCHA] No maps captured yet, waiting more...')
    // Wait a bit longer
    await new Promise(r => setTimeout(r, 3000))
  }

  if (capturedMaps.size === 0) {
    await sendDiscordText('⚠️ No map data received from server')
    return
  }

  captchaSent = true
  console.log(`[CAPTCHA] Sending ${capturedMaps.size} maps to Discord`)

  // Sort by map ID descending (highest first) so they appear in a sensible order
  const sorted = [...capturedMaps.entries()].sort((a, b) => b[0] - a[0])

  for (const [id, file] of sorted) {
    await sendDiscordImage(file, `Map ID ${id}`)
  }

  await sendDiscordText(`🔐 **${capturedMaps.size} CAPTCHA maps sent above.**\nRead them and reply in this channel with:\n\`!captcha <answer>\`\n(Example: \`!captcha UqUt\`)\nYou have 5 minutes.`)

  startPolling()
}

// ─── POLL DISCORD FOR ANSWER ───
async function startPolling() {
  if (pollingActive) return
  pollingActive = true

  console.log('[CAPTCHA] Polling Discord for answer...')
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000))
    const ans = await fetchCaptchaAnswer()
    if (ans) {
      console.log(`[CAPTCHA] Got answer: ${ans}`)
      // Find the current bot — we can't reference it here, so use global
      if (global._currentBot) {
        global._currentBot.chat(ans)
        sendDiscordText(`✅ Sent answer to Minecraft: **${ans}**`)
      }
      pollingActive = false
      return
    }
  }
  sendDiscordText('⏰ CAPTCHA timed out (5 min)')
  pollingActive = false
}

// Store the bot globally so polling can access it
const originalCreateBot = createBot
createBot = function() {
  console.log('[BOT] Connecting...')
  captchaSent = false
  pollingActive = false
  capturedMaps.clear()

  const bot = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username,
    version: CONFIG.version,
    auth: 'offline'
  })

  global._currentBot = bot

  const mapHandler = (packet) => {
    try {
      const id = packet.itemDamage !== undefined ? packet.itemDamage : packet.mapId
      const width = packet.columns || 128
      const height = packet.rows || 128
      const data = packet.data
      console.log(`[MAP] Received map ${id} (${width}x${height})`)
      if (!data || data.length < width * height) return

      const png = new PNG({ width, height })
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const [r, g, b, a] = paletteColor(data[x + y * width])
          const p = (y * width + x) * 4
          png.data[p] = r
          png.data[p + 1] = g
          png.data[p + 2] = b
          png.data[p + 3] = a
        }
      }
      const file = path.join(MAP_DIR, `map_${id}.png`)
      fs.writeFileSync(file, PNG.sync.write(png))
      capturedMaps.set(id, file)
      console.log(`[MAP] Saved map_${id}.png (total: ${capturedMaps.size})`)
    } catch (e) { console.error('[MAP] Render fail:', e.message) }
  }

  ;['map', 'map_data'].forEach(name => {
    try { bot._client.on(name, mapHandler) } catch (e) {}
  })

  bot.on('message', (msg) => {
    const text = msg.toString()
    console.log(`[CHAT] ${text}`)

    if (/\/register/i.test(text)) {
      bot.chat(`/register ${CONFIG.password} ${CONFIG.password}`)
    } else if (/\/login/i.test(text)) {
      bot.chat(`/login ${CONFIG.password}`)
    } else if (/captcha/i.test(text)) {
      sendDiscordText(`🔐 CAPTCHA prompt detected — waiting for map data...`)
      setTimeout(() => flushMaps(), 3000)
    }
  })

  bot.on('login', () => {
    console.log(`[BOT] Logged in as ${bot.username}`)
    sendDiscordText(`✅ Bot **${bot.username}** joined`)
    setInterval(() => {
      if (bot.entity) {
        bot.setControlState('jump', true)
        setTimeout(() => bot.setControlState('jump', false), 400)
      }
    }, 30000)
  })

  bot.on('kicked', (reason) => {
    const r = typeof reason === 'string' ? reason : JSON.stringify(reason)
    console.log(`[BOT] Kicked: ${r}`)
    sendDiscordText(`❌ Kicked: ${r}`)
    setTimeout(createBot, 15000)
  })

  bot.on('error', (err) => console.log(`[BOT] Error: ${err.message}`))
  bot.on('end', () => { setTimeout(createBot, 15000) })
}

console.log('═══ MINEFORT BOT — MAP CAPTURE v3 ═══')
createBot()
