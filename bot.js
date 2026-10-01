
const mineflayer = require('mineflayer')
const { mapDownloader } = require('mineflayer-item-map-downloader')
const axios = require('axios')
const express = require('express')
const FormData = require('form-data')
const fs = require('fs')
const path = require('path')

const CONFIG = {
  host: process.env.MC_HOST || 'sleepyempiregen.minefort.com',
  port: parseInt(process.env.MC_PORT) || 25565,
  username: process.env.MC_USERNAME || 'tpstoohigh',
  password: process.env.MC_PASSWORD,
  version: process.env.MC_VERSION || false,
  discordWebhook: process.env.DISCORD_WEBHOOK || '',
  discordBotToken: process.env.DISCORD_BOT_TOKEN || '',
  discordChannelId: process.env.DISCORD_CHANNEL_ID || ''
}

const app = express()
const PORT = process.env.PORT || 3000
let status = 'starting'

app.get('/', (req, res) => {
  res.json({
    status,
    bot: CONFIG.username,
    server: CONFIG.host,
    uptime: Math.floor(process.uptime()) + 's'
  })
})

app.listen(PORT, () => {
  console.log(`[HTTP] Listening on port ${PORT}`)
})

const MAP_DIR = path.join(__dirname, 'maps')
if (!fs.existsSync(MAP_DIR)) fs.mkdirSync(MAP_DIR, { recursive: true })

async function sendDiscordImage(imagePath, message) {
  if (!CONFIG.discordWebhook) return
  try {
    const form = new FormData()
    form.append('content', message)
    form.append('file', fs.createReadStream(imagePath))
    await axios.post(CONFIG.discordWebhook, form, { headers: form.getHeaders() })
    console.log('[DISCORD] Image sent')
  } catch (err) {
    console.error('[DISCORD] Image failed:', err.message)
  }
}

async function sendDiscordText(message) {
  if (!CONFIG.discordWebhook) return
  try {
    await axios.post(CONFIG.discordWebhook, { content: message })
  } catch (err) {
    console.error('[DISCORD] Text failed:', err.message)
  }
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
  } catch (err) {
    console.error('[DISCORD] Poll failed:', err.message)
  }
  return null
}

function createBot() {
  status = 'connecting'
  console.log(`[BOT] Connecting to ${CONFIG.host}:${CONFIG.port}`)

  const bot = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username,
    version: CONFIG.version,
    auth: 'offline',
    'mapDownloader-outputDir': MAP_DIR,
    'mapDownloader-saveToFile': true
  })

  bot.loadPlugin(mapDownloader)

  bot.on('message', (msg) => {
    const text = msg.toString()
    if (/\/register/i.test(text)) {
      console.log('[AUTH] Registering...')
      bot.chat(`/register ${CONFIG.password} ${CONFIG.password}`)
    } else if (/\/login/i.test(text)) {
      console.log('[AUTH] Logging in...')
      bot.chat(`/login ${CONFIG.password}`)
    }
  })

  bot.on('login', () => {
    console.log(`[BOT] Logged in as ${bot.username}`)
    status = 'online'
    sendDiscordText(`✅ **${CONFIG.username}** joined **${CONFIG.host}**`)

    setInterval(() => {
      if (bot.entity) {
        bot.setControlState('jump', true)
        setTimeout(() => bot.setControlState('jump', false), 400)
        bot.look(bot.entity.yaw + 0.5, 0, false)
      }
    }, 30000)

    setInterval(() => {
      sendDiscordText(`🟢 **${CONFIG.username}** still online (${Math.floor(bot.time.age / 1200)} min)`)
    }, 3600000)
  })

  bot.on('new_map', async (data) => {
    console.log(`[CAPTCHA] Map detected: ${data.name}`)
    await new Promise(r => setTimeout(r, 1500))

    const imgPath = path.join(MAP_DIR, `${data.name}.png`)
    if (!fs.existsSync(imgPath)) return

    await sendDiscordImage(
      imgPath,
      `🔐 **CAPTCHA DETECTED**\nReply in this channel with:\n\`!captcha <answer>\`\n(You have 5 minutes)`
    )

    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 5000))
      const answer = await fetchCaptchaAnswer()
      if (answer) {
        console.log(`[CAPTCHA] Sending answer: ${answer}`)
        bot.chat(answer)
        sendDiscordText(`✅ CAPTCHA answer sent: **${answer}**`)
        return
      }
    }
    sendDiscordText(`⏰ CAPTCHA answer timed out`)
  })

  bot.on('chat', (username, message) => {
    if (username === bot.username) return
    const lower = message.toLowerCase()
    if (lower.includes('hello') || lower.includes('hi ')) {
      bot.chat(`Hi ${username}!`)
    } else if (lower.includes('afk')) {
      bot.chat(`Yes, I'm an AFK bot keeping the server online!`)
    }
  })

  bot.on('kicked', (reason) => {
    console.log(`[BOT] Kicked: ${reason}`)
    status = 'kicked'
    sendDiscordText(`❌ Kicked: ${reason}`)
    setTimeout(createBot, 15000)
  })

  bot.on('error', (err) => {
    console.log(`[BOT] Error: ${err.message}`)
  })

  bot.on('end', (reason) => {
    console.log(`[BOT] Disconnected: ${reason}`)
    status = 'disconnected'
    sendDiscordText(`🔌 Disconnected: ${reason}`)
    setTimeout(createBot, 15000)
  })
}

console.log('═══════════════════════════════')
console.log('  MINEFORT AFK BOT — tpstoohigh')
console.log('═══════════════════════════════')
console.log(`Host: ${CONFIG.host}`)
console.log(`Version: ${CONFIG.version || 'auto'}`)

createBot()
