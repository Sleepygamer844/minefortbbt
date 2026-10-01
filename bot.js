const mineflayer = require('mineflayer')
const { mineflayer: viewer } = require('prismarine-viewer')
const puppeteer = require('puppeteer')
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
  version: (process.env.MC_VERSION && process.env.MC_VERSION !== 'false') ? process.env.MC_VERSION : undefined,
  discordWebhook: process.env.DISCORD_WEBHOOK || '',
  discordBotToken: process.env.DISCORD_BOT_TOKEN || '',
  discordChannelId: process.env.DISCORD_CHANNEL_ID || ''
}

const app = express()
const PORT = process.env.PORT || 3000
let status = 'starting'

app.get('/', (req, res) => {
  res.json({ status, bot: CONFIG.username, server: CONFIG.host, uptime: Math.floor(process.uptime()) + 's' })
})

app.listen(PORT, () => console.log(`[HTTP] Listening on port ${PORT}`))

const SHOT_DIR = path.join(__dirname, 'screenshots')
if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true })

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
  try { await axios.post(CONFIG.discordWebhook, { content: message }) }
  catch (err) { console.error('[DISCORD] Text failed:', err.message) }
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
  } catch (err) { console.error('[DISCORD] Poll failed:', err.message) }
  return null
}

// Take a screenshot using prismarine-viewer + puppeteer
async function captureBotView(bot, filename) {
  console.log('[SHOT] Rendering bot view...')
  try {
    // Start the viewer on port 3001
    viewer(bot, { port: 3001, firstPerson: true })
    await new Promise(r => setTimeout(r, 3000)) // wait for viewer to start

    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    })
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 720 })
    await page.goto('http://localhost:3001', { waitUntil: 'networkidle2', timeout: 20000 })
    await new Promise(r => setTimeout(r, 4000)) // wait for world to render

    const filePath = path.join(SHOT_DIR, filename)
    await page.screenshot({ path: filePath })
    await browser.close()

    console.log(`[SHOT] Saved: ${filePath}`)
    return filePath
  } catch (err) {
    console.error('[SHOT] Failed:', err.message)
    return null
  }
}

function createBot() {
  status = 'connecting'
  console.log(`[BOT] Connecting to ${CONFIG.host}:${CONFIG.port}`)

  const bot = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username,
    version: CONFIG.version,
    auth: 'offline'
  })

  bot.on('message', (msg) => {
    const text = msg.toString()
    console.log(`[CHAT] ${text}`)

    if (/\/register/i.test(text)) {
      console.log('[AUTH] Registering...')
      bot.chat(`/register ${CONFIG.password} ${CONFIG.password}`)
    } else if (/\/login/i.test(text)) {
      console.log('[AUTH] Logging in...')
      bot.chat(`/login ${CONFIG.password}`)
    }

    // Detect CAPTCHA mention — common keywords
    if (/captcha|verification|verify|paint|picture|enter the code/i.test(text)) {
      console.log('[CAPTCHA] Keyword detected — capturing screenshot')
      setTimeout(() => captureAndSend(bot), 2000)
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
      }
    }, 30000)

    // Auto-screenshot every 60s in the first 3 minutes (in case CAPTCHA appears visually)
    let shots = 0
    const shotTimer = setInterval(async () => {
      shots++
      if (shots > 3) return clearInterval(shotTimer)
      const f = await captureBotView(bot, `auto_${Date.now()}.png`)
      if (f) await sendDiscordImage(f, `👀 Auto-screenshot #${shots}`)
    }, 60000)
  })

  bot.on('kicked', (reason) => {
    const r = typeof reason === 'string' ? reason : JSON.stringify(reason)
    console.log(`[BOT] Kicked: ${r}`)
    status = 'kicked'
    sendDiscordText(`❌ Kicked: ${r}`)
    setTimeout(createBot, 15000)
  })

  bot.on('error', (err) => console.log(`[BOT] Error: ${err.message}`))

  bot.on('end', (reason) => {
    console.log(`[BOT] Disconnected: ${reason}`)
    status = 'disconnected'
    sendDiscordText(`🔌 Disconnected: ${reason}`)
    setTimeout(createBot, 15000)
  })
}

async function captureAndSend(bot) {
  const file = await captureBotView(bot, `captcha_${Date.now()}.png`)
  if (file) {
    await sendDiscordImage(file, `🔐 **Possible CAPTCHA**\nReply with \`!captcha <answer>\` in this channel.\nYou have 5 minutes.`)
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 5000))
      const answer = await fetchCaptchaAnswer()
      if (answer) {
        console.log(`[CAPTCHA] Sending answer: ${answer}`)
        bot.chat(answer)
        sendDiscordText(`✅ Sent: **${answer}**`)
        return
      }
    }
    sendDiscordText(`⏰ CAPTCHA timed out`)
  }
}

console.log('═══════════════════════════════')
console.log('  MINEFORT AFK BOT — tpstoohigh')
console.log('═══════════════════════════════')
console.log(`Host: ${CONFIG.host}`)
console.log(`Version: ${CONFIG.version || 'auto'}`)

createBot()
