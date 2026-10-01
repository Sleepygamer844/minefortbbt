// ============================================================
//  MINEFORT BOT — tpstoohigh
//  Handles register/login, CAPTCHA capture, Discord relay
// ============================================================

const mineflayer = require('mineflayer')
const AutoAuth = require('mineflayer-auto-auth')
const { mapDownloader } = require('mineflayer-item-map-downloader')
const axios = require('axios')
const express = require('express')
const fs = require('fs')
const path = require('path')

// ─── CONFIG ───
const CONFIG = {
  host: process.env.MC_HOST || 'sleepyempiregen.minefort.com',
  port: parseInt(process.env.MC_PORT) || 25565,
  username: process.env.MC_USERNAME || 'tpstoohigh',
  password: process.env.MC_PASSWORD || 'CHANGE_ME',
  version: process.env.MC_VERSION || '26.1',
  discordWebhook: process.env.DISCORD_WEBHOOK || '',
  discordBotToken: process.env.DISCORD_BOT_TOKEN || '',
  discordChannelId: process.env.DISCORD_CHANNEL_ID || ''
}

// ─── SIMPLE HTTP SERVER (for Render.com keep-alive) ───
const app = express()
const PORT = process.env.PORT || 3000
let botStatus = 'starting'

app.get('/', (req, res) => {
  res.json({
    status: botStatus,
    bot: CONFIG.username,
    server: CONFIG.host,
    uptime: process.uptime()
  })
})

app.listen(PORT, () => {
  console.log(`[HTTP] Server running on port ${PORT}`)
})

// ─── MAP IMAGE STORAGE ───
const MAP_DIR = path.join(__dirname, 'maps')
if (!fs.existsSync(MAP_DIR)) {
  fs.mkdirSync(MAP_DIR, { recursive: true })
}

// ─── PENDING CAPTCHA ANSWER ───
let pendingCaptcha = null

// ─── SEND IMAGE TO DISCORD ───
async function sendDiscordImage(imagePath, message) {
  if (!CONFIG.discordWebhook) {
    console.log('[DISCORD] No webhook configured, skipping')
    return
  }

  try {
    const FormData = require('form-data')
    const form = new FormData()
    form.append('content', message)
    form.append('file', fs.createReadStream(imagePath))

    await axios.post(CONFIG.discordWebhook, form, {
      headers: form.getHeaders()
    })
    console.log('[DISCORD] CAPTCHA image sent')
  } catch (err) {
    console.error('[DISCORD] Failed to send:', err.message)
  }
}

// ─── SEND TEXT TO DISCORD ───
async function sendDiscordText(message) {
  if (!CONFIG.discordWebhook) return
  try {
    await axios.post(CONFIG.discordWebhook, { content: message })
  } catch (err) {
    console.error('[DISCORD] Text send failed:', err.message)
  }
}

// ─── CHECK DISCORD FOR CAPTCHA ANSWER ───
async function checkDiscordForAnswer() {
  if (!CONFIG.discordBotToken || !CONFIG.discordChannelId) {
    console.log('[DISCORD] Bot token/channel not set — manual answer needed')
    return null
  }

  try {
    const res = await axios.get(
      `https://discord.com/api/v10/channels/${CONFIG.discordChannelId}/messages?limit=5`,
      { headers: { Authorization: `Bot ${CONFIG.discordBotToken}` } }
    )

    for (const msg of res.data) {
      if (msg.content && msg.content.startsWith('!captcha ')) {
        const answer = msg.content.replace('!captcha ', '').trim()
        console.log(`[DISCORD] Found captcha answer: ${answer}`)
        // Delete the message so we don't reuse it
        await axios.delete(
          `https://discord.com/api/v10/channels/${CONFIG.discordChannelId}/messages/${msg.id}`,
          { headers: { Authorization: `Bot ${CONFIG.discordBotToken}` } }
        ).catch(() => {})
        return answer
      }
    }
  } catch (err) {
    console.error('[DISCORD] Failed to check messages:', err.message)
  }
  return null
}

// ─── CREATE BOT ───
function createBot() {
  botStatus = 'connecting'
  console.log(`[BOT] Connecting to ${CONFIG.host}:${CONFIG.port} as ${CONFIG.username}`)

  const bot = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username,
    version: CONFIG.version,
    auth: 'offline',
    plugins: [AutoAuth],
    AutoAuth: {
      password: CONFIG.password,
      logging: true,
      ignoreRepeat: true
    },
    // Map downloader options
    'mapDownloader-outputDir': MAP_DIR,
    'mapDownloader-saveToFile': true
  })

  // Load map downloader plugin
  bot.loadPlugin(mapDownloader)

  // ─── LOGIN SUCCESS ───
  bot.on('serverAuth', () => {
    console.log('[BOT] ✅ Successfully authenticated!')
    botStatus = 'online'
    sendDiscordText(`✅ **${CONFIG.username}** logged in to **${CONFIG.host}**`)

    // Anti-AFK: jump every 30 seconds
    setInterval(() => {
      if (bot.entity) {
        bot.setControlState('jump', true)
        setTimeout(() => bot.setControlState('jump', false), 500)
      }
    }, 30000)
  })

  // ─── MAP DETECTED (CAPTCHA) ───
  bot.on('new_map', async (data) => {
    console.log(`[CAPTCHA] New map detected: ${data.name}`)

    // Wait a moment for the image to be written
    await new Promise(r => setTimeout(r, 1000))

    const imagePath = path.join(MAP_DIR, `${data.name}.png`)

    if (fs.existsSync(imagePath)) {
      console.log(`[CAPTCHA] Image saved: ${imagePath}`)
      pendingCaptcha = data.id

      await sendDiscordImage(
        imagePath,
        `🔐 **CAPTCHA DETECTED** — Please solve it!\n` +
        `Reply with \`!captcha <answer>\` in this channel.\n` +
        `Map ID: ${data.id}`
      )

      // Start polling Discord for an answer
      pollForAnswer(bot)
    } else {
      console.log(`[CAPTCHA] Image not found: ${imagePath}`)
    }
  })

  // ─── CHAT HANDLER (respond to messages) ───
  bot.on('chat', (username, message) => {
    if (username === bot.username) return

    console.log(`[CHAT] <${username}> ${message}`)

    // Respond to simple greetings
    const lower = message.toLowerCase()
    if (lower.includes('hi') || lower.includes('hello')) {
      bot.chat(`Hello ${username}!`)
    } else if (lower.includes('bot')) {
      bot.chat(`I'm ${CONFIG.username}, an AFK bot.`)
    }
  })

  // ─── KICKED ───
  bot.on('kicked', (reason) => {
    console.log(`[BOT] ❌ Kicked: ${reason}`)
    botStatus = 'kicked'
    sendDiscordText(`❌ **${CONFIG.username}** was kicked: ${reason}`)
    setTimeout(createBot, 15000)
  })

  // ─── ERROR ───
  bot.on('error', (err) => {
    console.log(`[BOT] ⚠️ Error: ${err.message}`)
    botStatus = 'error'
  })

  // ─── DISCONNECT ───
  bot.on('end', (reason) => {
    console.log(`[BOT] 🔌 Disconnected: ${reason}`)
    botStatus = 'disconnected'
    sendDiscordText(`🔌 **${CONFIG.username}** disconnected: ${reason}`)
    setTimeout(createBot, 15000)
  })
}

// ─── POLL DISCORD FOR CAPTCHA ANSWER ───
async function pollForAnswer(bot) {
  console.log('[CAPTCHA] Polling Discord for answer...')

  for (let i = 0; i < 60; i++) { // 5 minutes max (60 × 5s)
    await new Promise(r => setTimeout(r, 5000))

    const answer = await checkDiscordForAnswer()
    if (answer) {
      console.log(`[CAPTCHA] Sending answer: ${answer}`)
      bot.chat(answer)
      pendingCaptcha = null
      sendDiscordText(`✅ CAPTCHA answer sent: **${answer}**`)
      return
    }
  }

  console.log('[CAPTCHA] No answer received in 5 minutes')
  sendDiscordText(`⏰ No CAPTCHA answer received in 5 minutes. Bot may be stuck.`)
  pendingCaptcha = null
}

// ─── START ───
console.log('═══════════════════════════════════════')
console.log('  MINEFORT BOT — tpstoohigh')
console.log('═══════════════════════════════════════')
console.log(`Host: ${CONFIG.host}:${CONFIG.port}`)
console.log(`Version: ${CONFIG.version}`)
console.log(`Discord webhook: ${CONFIG.discordWebhook ? '✅ set' : '❌ missing'}`)
console.log(`Discord bot token: ${CONFIG.discordBotToken ? '✅ set' : '❌ missing'}`)
console.log('═══════════════════════════════════════')

createBot()
