const mineflayer = require('mineflayer')
const axios = require('axios')
const express = require('express')
const fs = require('fs')
const path = require('path')
const FormData = require('form-data')
const { PNG } = require('pngjs')
const Tesseract = require('tesseract.js')

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
  return [Math.min(255, Math.floor(base[0]*mult)), Math.min(255, Math.floor(base[1]*mult)), Math.min(255, Math.floor(base[2]*mult)), 255]
}

const app = express()
const PORT = process.env.PORT || 3000
let botStatus = 'starting'

app.get('/', (req, res) => res.json({ status: botStatus, uptime: Math.floor(process.uptime()) + 's' }))
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[HTTP] Listening on ${PORT}`)
  setTimeout(createBot, 1000)
})

async function sendDiscordText(message) {
  if (!CONFIG.discordWebhook) return
  try { await axios.post(CONFIG.discordWebhook, { content: String(message).substring(0, 1900) }) }
  catch (err) { console.error('[DISCORD]', err.message) }
}

async function sendDiscordImage(imagePath, caption) {
  if (!CONFIG.discordWebhook) return
  try {
    const form = new FormData()
    form.append('content', caption || '')
    form.append('file', fs.createReadStream(imagePath), { filename: path.basename(imagePath) })
    await axios.post(CONFIG.discordWebhook, form, { headers: form.getHeaders() })
    console.log('[DISCORD] Sent image:', path.basename(imagePath))
  } catch (err) { console.error('[DISCORD]', err.message) }
}

async function fetchManualAnswer() {
  if (!CONFIG.discordBotToken || !CONFIG.discordChannelId) return null
  try {
    const res = await axios.get(
      `https://discord.com/api/v10/channels/${CONFIG.discordChannelId}/messages?limit=5`,
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

// ─── STATE ───
let currentBot = null
let capturedMaps = {}
let captchaSubmitted = false
let ocrRunning = false
let ocrAnswer = null
let ocrDone = false
let manualPolling = false
let reconnectDelay = 30000
const MAX_RECONNECT = 300000

// ─── STITCH 9 MAPS ───
function stitchMaps() {
  const ids = Object.keys(capturedMaps).map(Number).sort((a, b) => a - b)
  if (ids.length < 9) return null

  const TILE = 128
  const SIZE = TILE * 3
  const stitched = new PNG({ width: SIZE, height: SIZE })

  for (let i = 0; i < 9; i++) {
    const src = PNG.sync.read(fs.readFileSync(capturedMaps[ids[i]]))
    const col = i % 3
    const row = Math.floor(i / 3)
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const sp = (y * TILE + x) * 4
        const dp = ((row * TILE + y) * SIZE + (col * TILE + x)) * 4
        stitched.data[dp] = src.data[sp]
        stitched.data[dp + 1] = src.data[sp + 1]
        stitched.data[dp + 2] = src.data[sp + 2]
        stitched.data[dp + 3] = src.data[sp + 3]
      }
    }
  }

  const out = path.join(MAP_DIR, 'stitched.png')
  fs.writeFileSync(out, PNG.sync.write(stitched))
  return out
}

// ─── UPSCALE + THRESHOLD (makes OCR way better) ───
function preprocessImage(inputPath, outputPath, scale = 3, threshold = 128) {
  const src = PNG.sync.read(fs.readFileSync(inputPath))
  const W = src.width * scale
  const H = src.height * scale
  const out = new PNG({ width: W, height: H })

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = Math.floor(x / scale)
      const sy = Math.floor(y / scale)
      const sp = (sy * src.width + sx) * 4
      const dp = (y * W + x) * 4

      const r = src.data[sp]
      const g = src.data[sp + 1]
      const b = src.data[sp + 2]
      const a = src.data[sp + 3]

      // Grayscale
      const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b)

      // Threshold to pure black/white
      const v = gray < threshold ? 0 : 255

      out.data[dp] = v
      out.data[dp + 1] = v
      out.data[dp + 2] = v
      out.data[dp + 3] = a
    }
  }

  fs.writeFileSync(outputPath, PNG.sync.write(out))
  return outputPath
}

// ─── RUN OCR (multi-pass, picks best) ───
async function runOCR() {
  if (ocrRunning || ocrDone) return
  ocrRunning = true

  const stitched = stitchMaps()
  if (!stitched) { ocrRunning = false; return }

  // Send original to Discord
  await sendDiscordImage(stitched, '🧩 Stitched CAPTCHA (bot view)')

  const results = []

  try {
    // Preprocess: 3x upscale + threshold
    const pre1 = preprocessImage(stitched, path.join(MAP_DIR, 'pre1.png'), 3, 100)
    const pre2 = preprocessImage(stitched, path.join(MAP_DIR, 'pre2.png'), 4, 150)

    // Also send the preprocessed version so you can see what OCR sees
    await sendDiscordImage(pre1, '🔎 Preprocessed (what OCR sees)')

    // Multiple OCR passes
    const passes = [
      { img: pre1, psm: '7' },
      { img: pre1, psm: '8' },
      { img: pre1, psm: '13' },
      { img: pre2, psm: '7' },
      { img: pre2, psm: '8' },
      { img: stitched, psm: '7' }
    ]

    for (const pass of passes) {
      try {
        const { data } = await Tesseract.recognize(pass.img, 'eng', {
          tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
          tessedit_pageseg_mode: pass.psm
        })
        const cleaned = data.text.replace(/[^A-Za-z]/g, '')
        console.log(`[OCR] psm=${pass.psm} → "${cleaned}" (${Math.round(data.confidence)}%)`)
        if (cleaned.length >= 3 && cleaned.length <= 8) {
          results.push({ text: cleaned, conf: data.confidence })
        }
      } catch (e) {
        console.error('[OCR pass]', e.message)
      }
    }

    if (results.length === 0) {
      await sendDiscordText('⚠️ All OCR passes failed to find readable text')
    } else {
      // Highest confidence wins
      results.sort((a, b) => b.conf - a.conf)
      ocrAnswer = results[0].text
      const summary = results.map(r => `\`${r.text}\` (${Math.round(r.conf)}%)`).join('\n')
      await sendDiscordText(`🤖 OCR results:\n${summary}\n\n**Best:** \`${ocrAnswer}\``)
    }
  } catch (e) {
    console.error('[OCR]', e.message)
    await sendDiscordText(`⚠️ OCR failed: ${e.message}`)
  }

  ocrDone = true
  ocrRunning = false
}

// ─── CREATE BOT ───
function createBot() {
  botStatus = 'connecting'
  captchaSubmitted = false
  capturedMaps = {}
  ocrAnswer = null
  ocrDone = false
  ocrRunning = false

  console.log(`[BOT] Connecting... (delay ${reconnectDelay/1000}s)`)
  const bot = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username,
    version: CONFIG.version,
    auth: 'offline'
  })
  currentBot = bot

  const mapHandler = (packet) => {
    try {
      const id = packet.itemDamage !== undefined ? packet.itemDamage : packet.mapId
      const width = packet.columns || 128
      const height = packet.rows || 128
      const data = packet.data
      if (!data || data.length < width * height) return

      const png = new PNG({ width, height })
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const [r, g, b, a] = paletteColor(data[x + y * width])
          const p = (y * width + x) * 4
          png.data[p] = r; png.data[p+1] = g; png.data[p+2] = b; png.data[p+3] = a
        }
      }
      const file = path.join(MAP_DIR, `map_${id}.png`)
      fs.writeFileSync(file, PNG.sync.write(png))
      capturedMaps[id] = file
      console.log(`[MAP] Captured ${Object.keys(capturedMaps).length}/9`)

      if (Object.keys(capturedMaps).length === 9 && !ocrRunning && !ocrDone) {
        console.log('[MAP] All 9 — running OCR')
        runOCR()
      }
    } catch (e) { console.error('[MAP]', e.message) }
  }

  try { bot._client.on('map', mapHandler) } catch (e) {}
  try { bot._client.on('map_data', mapHandler) } catch (e) {}

  bot.on('message', async (msg) => {
    const text = msg.toString()
    console.log(`[CHAT] ${text}`)

    if (/\/register/i.test(text)) {
      bot.chat(`/register ${CONFIG.password} ${CONFIG.password}`)
    } else if (/\/login/i.test(text)) {
      bot.chat(`/login ${CONFIG.password}`)
    } else if (/enter the captcha/i.test(text) && !captchaSubmitted) {
      captchaSubmitted = true
      console.log('[CAPTCHA] Prompt — waiting for OCR')

      for (let i = 0; i < 30; i++) {
        if (ocrDone) break
        await new Promise(r => setTimeout(r, 500))
      }

      if (ocrAnswer) {
        console.log(`[CAPTCHA] Submitting: ${ocrAnswer}`)
        bot.chat(ocrAnswer)
        await sendDiscordText(`✅ Auto-submitted: **${ocrAnswer}**`)
      } else {
        console.log('[CAPTCHA] No OCR — manual fallback')
        const s = stitchMaps()
        if (s) await sendDiscordImage(s, '⚠️ Manual — reply `!captcha <answer>`')
        startManualPoll()
      }
    }
  })

  bot.on('login', () => {
    console.log(`[BOT] ✅ Logged in as ${bot.username}`)
    botStatus = 'online'
    reconnectDelay = 30000
    sendDiscordText(`✅ Bot **${bot.username}** connected`)

    setInterval(() => {
      if (bot.entity) {
        bot.setControlState('jump', true)
        setTimeout(() => bot.setControlState('jump', false), 400)
      }
    }, 30000)
  })

  bot.on('kicked', (reason) => {
    const r = typeof reason === 'string' ? reason : JSON.stringify(reason)
    console.log(`[BOT] ❌ Kicked: ${r}`)
    botStatus = 'kicked'

    if (/already connected|too fast/i.test(r)) {
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT)
    } else {
      reconnectDelay = 30000
    }

    sendDiscordText(`❌ Kicked: ${r}\nRetry in ${reconnectDelay/1000}s`)
    setTimeout(createBot, reconnectDelay)
  })

  bot.on('error', (err) => console.log(`[BOT] Error: ${err.message}`))
  bot.on('end', () => {
    console.log(`[BOT] Disconnected`)
    botStatus = 'disconnected'
    setTimeout(createBot, reconnectDelay)
  })
}

async function startManualPoll() {
  if (manualPolling) return
  manualPolling = true
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 1000))
    const ans = await fetchManualAnswer()
    if (ans) {
      if (currentBot) currentBot.chat(ans)
      sendDiscordText(`✅ Manual sent: **${ans}**`)
      manualPolling = false
      return
    }
  }
  manualPolling = false
}

console.log('═══ MINEFORT BOT — OCR v2 (multi-pass) ═══')
