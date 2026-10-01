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
app.get('/', (req, res) => res.json({ status: 'ok' }))
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
let capturedMaps = {}       // id → file path
let frameInfo = []          // {id, x, y, z, file}
let captchaSubmitted = false
let ocrRunning = false
let ocrAnswer = null
let ocrDone = false
let manualPolling = false
let reconnectDelay = 30000

// ─── EXTRACT MAP ID FROM FRAME METADATA ───
function extractMapId(nbtData) {
  if (!nbtData) return null
  let val = nbtData.value !== undefined ? nbtData.value : nbtData
  if (!val || typeof val !== 'object') return null
  for (const key of ['map', 'mapId', 'Map', 'MapId']) {
    const entry = val[key]
    if (entry === undefined || entry === null) continue
    const inner = (entry && entry.value !== undefined) ? entry.value : entry
    if (typeof inner === 'number') return inner
  }
  return null
}

// ─── COLLECT FRAMES WITH POSITION + MAP ID ───
function collectFrames(bot) {
  const frames = Object.values(bot.entities).filter(e => e && e.name && e.name.includes('item_frame'))
  const out = []
  for (const frame of frames) {
    try {
      const meta = frame.metadata || []
      let mapId = null
      for (let i = 0; i < meta.length && i < 20; i++) {
        const v = meta[i]
        if (v && typeof v === 'object' && v.nbtData) {
          const id = extractMapId(v.nbtData)
          if (id !== null) { mapId = id; break }
        }
      }
      if (mapId !== null) {
        out.push({
          id: mapId,
          x: Math.floor(frame.position.x),
          y: Math.floor(frame.position.y),
          z: Math.floor(frame.position.z),
          file: capturedMaps[mapId]
        })
      }
    } catch (e) {}
  }
  return out
}

// ─── STITCH USING FRAME POSITIONS ───
function stitchByPosition(bot, outputName) {
  const frames = collectFrames(bot)
  if (frames.length !== 9) {
    console.log(`[STITCH] Got ${frames.length} frames, need 9`)
    return null
  }

  // Player at ~ (0, 116, 0), wall at x=-3, facing -X direction
  // So: sort by Y DESC (top first), then by Z ASC (left→right from player's POV facing -X)
  // Wait: if player faces -X, then right = +Z, left = -Z. So sort Z DESC = left→right.

  // Frames are at Y=117,118,119 (bottom→top) and Z=-1,0,1 (left→right from player view)
  // For grid [row][col]: row 0 = TOP (Y=119), col 0 = LEFT (Z=1 from player view is which side?)
  // Let's try: sort by Y DESC, Z DESC → top-left first
  frames.sort((a, b) => {
    if (a.y !== b.y) return b.y - a.y  // higher Y first (top row first)
    return b.z - a.z                    // higher Z first (leftmost from player view)
  })

  const TILE = 128
  const SIZE = TILE * 3
  const stitched = new PNG({ width: SIZE, height: SIZE })

  for (let i = 0; i < 9; i++) {
    const src = PNG.sync.read(fs.readFileSync(frames[i].file))
    const col = i % 3
    const row = Math.floor(i / 3)
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const sp = (y * TILE + x) * 4
        const dp = ((row * TILE + y) * SIZE + (col * TILE + x)) * 4
        stitched.data[dp] = src.data[sp]
        stitched.data[dp+1] = src.data[sp+1]
        stitched.data[dp+2] = src.data[sp+2]
        stitched.data[dp+3] = src.data[sp+3]
      }
    }
  }

  const out = path.join(MAP_DIR, outputName)
  fs.writeFileSync(out, PNG.sync.write(stitched))
  return out
}

// ─── FLIP VERTICALLY (some CAPTCHA plugins flip) ───
function flipVertical(inputPath, outputPath) {
  const src = PNG.sync.read(fs.readFileSync(inputPath))
  const out = new PNG({ width: src.width, height: src.height })
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const sy = src.height - 1 - y
      const sp = (sy * src.width + x) * 4
      const dp = (y * src.width + x) * 4
      out.data[dp] = src.data[sp]
      out.data[dp+1] = src.data[sp+1]
      out.data[dp+2] = src.data[sp+2]
      out.data[dp+3] = src.data[sp+3]
    }
  }
  fs.writeFileSync(outputPath, PNG.sync.write(out))
  return outputPath
}

// ─── PREPROCESS: upscale + grayscale + mild contrast ───
function preprocess(inputPath, outputPath, scale = 3, threshold = 128) {
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
      const r = src.data[sp], g = src.data[sp+1], b = src.data[sp+2], a = src.data[sp+3]
      const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
      const v = gray < threshold ? 0 : 255
      out.data[dp] = v; out.data[dp+1] = v; out.data[dp+2] = v; out.data[dp+3] = a
    }
  }

  fs.writeFileSync(outputPath, PNG.sync.write(out))
  return outputPath
}

// ─── OCR: multiple images, multiple PSM ───
async function tryOCR(imgPath, psm = '7') {
  try {
    const { data } = await Tesseract.recognize(imgPath, 'eng', {
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
      tessedit_pageseg_mode: psm
    })
    const cleaned = data.text.replace(/[^A-Za-z]/g, '')
    return { text: cleaned, conf: data.confidence }
  } catch (e) {
    return null
  }
}

async function runOCR(bot) {
  if (ocrRunning || ocrDone) return
  ocrRunning = true
  const results = []

  try {
    // Build 3 candidate images
    const s1 = stitchByPosition(bot, 's1_normal.png')
    if (s1) {
      const s2 = flipVertical(s1, path.join(MAP_DIR, 's2_flipped.png'))
      const p1 = preprocess(s1, path.join(MAP_DIR, 'p1_normal.png'), 3, 128)
      const p2 = preprocess(s2, path.join(MAP_DIR, 'p2_flipped.png'), 3, 128)

      // Send all candidates to Discord for you to see
      await sendDiscordImage(s1, '🧩 Stitched (normal order)')
      await sendDiscordImage(s2, '🔄 Stitched (flipped vertically)')
      await sendDiscordImage(p1, '🔎 Preprocessed (normal)')
      await sendDiscordImage(p2, '🔎 Preprocessed (flipped)')

      // OCR every combo
      const combos = [
        { name: 'normal-7', img: s1, psm: '7' },
        { name: 'normal-8', img: s1, psm: '8' },
        { name: 'flipped-7', img: s2, psm: '7' },
        { name: 'flipped-8', img: s2, psm: '8' },
        { name: 'pre-norm-7', img: p1, psm: '7' },
        { name: 'pre-norm-8', img: p1, psm: '8' },
        { name: 'pre-flip-7', img: p2, psm: '7' },
        { name: 'pre-flip-8', img: p2, psm: '8' }
      ]

      for (const c of combos) {
        const r = await tryOCR(c.img, c.psm)
        if (r && r.text.length >= 3 && r.text.length <= 8) {
          console.log(`[OCR] ${c.name} → "${r.text}" (${Math.round(r.conf)}%)`)
          results.push({ name: c.name, text: r.text, conf: r.conf })
        }
      }
    }

    if (results.length === 0) {
      await sendDiscordText('⚠️ No OCR results')
    } else {
      results.sort((a, b) => b.conf - a.conf)
      ocrAnswer = results[0].text
      const summary = results.map(r => `\`${r.text}\` — ${r.name} (${Math.round(r.conf)}%)`).join('\n')
      await sendDiscordText(`🤖 OCR results:\n${summary}\n\n**Best:** \`${ocrAnswer}\``)
    }
  } catch (e) {
    console.error('[OCR]', e.message)
  }

  ocrDone = true
  ocrRunning = false
}

function createBot() {
  captchaSubmitted = false
  capturedMaps = {}
  ocrAnswer = null
  ocrDone = false
  ocrRunning = false
  frameInfo = []

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
      console.log(`[MAP] Captured ${Object.keys(capturedMaps).length}/9 (id=${id})`)

      if (Object.keys(capturedMaps).length === 9 && !ocrRunning && !ocrDone) {
        console.log('[MAP] All 9 — starting OCR')
        runOCR(bot)
      }
    } catch (e) { console.error('[MAP]', e.message) }
  }

  try { bot._client.on('map', mapHandler) } catch (e) {}
  try { bot._client.on('map_data', mapHandler) } catch (e) {}

  bot.on('message', async (msg) => {
    const text = msg.toString()
    console.log(`[CHAT] ${text}`)

    if (/\/register/i.test(text)) bot.chat(`/register ${CONFIG.password} ${CONFIG.password}`)
    else if (/\/login/i.test(text)) bot.chat(`/login ${CONFIG.password}`)
    else if (/enter the captcha/i.test(text) && !captchaSubmitted) {
      captchaSubmitted = true
      console.log('[CAPTCHA] Prompt — waiting for OCR')

      for (let i = 0; i < 20; i++) {
        if (ocrDone) break
        await new Promise(r => setTimeout(r, 250))
      }

      if (ocrAnswer) {
        console.log(`[CAPTCHA] Submitting: ${ocrAnswer}`)
        bot.chat(ocrAnswer)
        await sendDiscordText(`✅ Auto-submitted: **${ocrAnswer}**`)
      } else {
        const s = stitchByPosition(bot, 'manual.png')
        if (s) await sendDiscordImage(s, '⚠️ Manual — reply `!captcha <answer>` FAST (15s)')
        startManualPoll()
      }
    }
  })

  bot.on('login', () => {
    console.log(`[BOT] ✅ Logged in`)
    reconnectDelay = 30000
    sendDiscordText(`✅ Bot joined`)

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
    if (/already connected|too fast/i.test(r)) {
      reconnectDelay = Math.min(reconnectDelay * 2, 300000)
    } else {
      reconnectDelay = 30000
    }
    sendDiscordText(`❌ Kicked. Retry in ${reconnectDelay/1000}s`)
    setTimeout(createBot, reconnectDelay)
  })

  bot.on('error', (err) => console.log(`[BOT] Error: ${err.message}`))
  bot.on('end', () => {
    console.log(`[BOT] Disconnected`)
    setTimeout(createBot, reconnectDelay)
  })
}

async function startManualPoll() {
  if (manualPolling) return
  manualPolling = true
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500))
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

console.log('═══ MINEFORT BOT — OCR v3 (position order) ═══')
