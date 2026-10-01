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
  geminiApiKey: process.env.GEMINI_API_KEY || '',
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
  setTimeout(createBot, 500)
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
    form.append('file', fs.createReadStream(imagePath), { filename: 'captcha.png' })
    await axios.post(CONFIG.discordWebhook, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      timeout: 5000
    })
  } catch (err) { console.error('[DISCORD]', err.message) }
}

async function fetchManualAnswer() {
  if (!CONFIG.discordBotToken || !CONFIG.discordChannelId) return null
  try {
    const res = await axios.get(
      `https://discord.com/api/v10/channels/${CONFIG.discordChannelId}/messages?limit=5`,
      { headers: { Authorization: `Bot ${CONFIG.discordBotToken}` }, timeout: 3000 }
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
  } catch (err) {}
  return null
}

async function askGemini(imagePath) {
  if (!CONFIG.geminiApiKey) return null
  try {
    const imageBuffer = fs.readFileSync(imagePath)
    const base64Image = imageBuffer.toString('base64')

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${CONFIG.geminiApiKey}`

    const body = {
      contents: [{
        parts: [
          { text: 'This is a Minecraft CAPTCHA image with 9 tiles in a 3x3 grid. Each tile shows 1 letter or number. Read them LEFT-TO-RIGHT, TOP-TO-BOTTOM and output ONLY the letters/numbers with no spaces or explanation. If a tile is empty, skip it. Just reply with the characters.' },
          { inline_data: { mime_type: 'image/png', data: base64Image } }
        ]
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 20 }
    }

    const t0 = Date.now()
    const res = await axios.post(url, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    })
    console.log(`[GEMINI] ${Date.now() - t0}ms`)

    const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || ''
    console.log(`[GEMINI] Raw: "${text}"`)

    const cleaned = text.replace(/[^A-Za-z0-9]/g, '')
    if (cleaned.length >= 3 && cleaned.length <= 8) return cleaned
    return null
  } catch (err) {
    console.error('[GEMINI]', err.message)
    if (err.response) console.error('[GEMINI]', JSON.stringify(err.response.data).substring(0, 400))
    return null
  }
}

let currentBot = null
let capturedMaps = {}
let submitted = false
let handling = false
let pollActive = false
let reconnectDelay = 30000

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
      if (mapId !== null && capturedMaps[mapId]) {
        out.push({
          id: mapId,
          y: Math.floor(frame.position.y),
          z: Math.floor(frame.position.z),
          file: capturedMaps[mapId]
        })
      }
    } catch (e) {}
  }
  return out
}

function stitchFiles(files, outName) {
  const TILE = 128
  const SIZE = TILE * 3
  const stitched = new PNG({ width: SIZE, height: SIZE })

  for (let i = 0; i < stitched.data.length; i += 4) {
    stitched.data[i] = 255
    stitched.data[i+1] = 255
    stitched.data[i+2] = 255
    stitched.data[i+3] = 255
  }

  for (let i = 0; i < files.length && i < 9; i++) {
    try {
      const src = PNG.sync.read(fs.readFileSync(files[i]))
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
    } catch (e) { console.error(`[STITCH] Tile ${i}:`, e.message) }
  }

  const out = path.join(MAP_DIR, outName)
  fs.writeFileSync(out, PNG.sync.write(stitched))
  return out
}

// ─── WAIT FOR 9 FRAMES WITH POSITIONS, THEN STITCH ───
async function waitAndStitch(bot, maxWaitMs = 5000) {
  const t0 = Date.now()
  while (Date.now() - t0 < maxWaitMs) {
    const frames = collectFrames(bot)
    const mapCount = Object.keys(capturedMaps).length

    if (mapCount >= 9 && frames.length >= 9) {
      // We have everything — stitch
      frames.sort((a, b) => {
        if (a.y !== b.y) return b.y - a.y   // top row first
        return a.z - b.z                     // left → right
      })
      const file = stitchFiles(frames.map(f => f.file), 'stitched_pos.png')
      return { file, count: frames.length }
    }

    await new Promise(r => setTimeout(r, 200))
  }

  // Timeout — return whatever we have
  const frames = collectFrames(bot)
  const mapCount = Object.keys(capturedMaps).length
  console.log(`[STITCH] Timeout: ${mapCount} maps, ${frames.length} frames`)

  if (frames.length > 0) {
    frames.sort((a, b) => {
      if (a.y !== b.y) return b.y - a.y
      return a.z - b.z
    })
    const file = stitchFiles(frames.map(f => f.file), 'stitched_pos.png')
    return { file, count: frames.length }
  }

  return null
}

async function handleCaptcha(bot) {
  if (submitted || handling) return
  handling = true

  console.log(`[CAPTCHA] Handler started (have ${Object.keys(capturedMaps).length} maps)`)

  const result = await waitAndStitch(bot, 5000)

  if (!result) {
    console.log('[CAPTCHA] ❌ No frames with positions — cannot stitch cleanly')
    sendDiscordText('⚠️ Could not read item frame positions — no image sent')
    handling = false
    return
  }

  console.log(`[CAPTCHA] ✅ Stitched with ${result.count} frames`)

  submitted = true

  await sendDiscordImage(result.file, `🤖 **AI reading (${result.count}/9 frames)** — reply \`!captcha <code>\` as backup`)
  startFastPoll()

  const aiAnswer = await askGemini(result.file)

  if (aiAnswer && !pollActive) {
    console.log(`[CAPTCHA] ✅ AI: ${aiAnswer}`)
    bot.chat(aiAnswer)
    sendDiscordText(`🤖 **AI submitted: \`${aiAnswer}\`**`)
  } else if (!aiAnswer) {
    console.log('[CAPTCHA] ⚠️ AI failed — manual backup')
    sendDiscordText('⚠️ **AI failed — reply `!captcha <code>` FAST!**')
  }

  handling = false
}

function createBot() {
  submitted = false
  handling = false
  pollActive = false
  capturedMaps = {}

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
      console.log(`[MAP] ${Object.keys(capturedMaps).length}/9`)
    } catch (e) { console.error('[MAP]', e.message) }
  }

  try { bot._client.on('map', mapHandler) } catch (e) {}
  try { bot._client.on('map_data', mapHandler) } catch (e) {}

  bot.on('message', (msg) => {
    const text = msg.toString()
    console.log(`[CHAT] ${text}`)

    if (/\/register/i.test(text)) bot.chat(`/register ${CONFIG.password} ${CONFIG.password}`)
    else if (/\/login/i.test(text)) bot.chat(`/login ${CONFIG.password}`)
    else if (/enter the captcha/i.test(text) && !submitted && !handling) {
      console.log('[CAPTCHA] Chat prompt — starting handler')
      handleCaptcha(bot)
    }
  })

  bot.on('login', () => {
    console.log(`[BOT] ✅ Logged in`)
    reconnectDelay = 30000
    sendDiscordText(`✅ Bot connected`)
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
  bot.on('end', () => setTimeout(createBot, reconnectDelay))
}

async function startFastPoll() {
  if (pollActive) return
  pollActive = true
  for (let i = 0; i < 80; i++) {
    const ans = await fetchManualAnswer()
    if (ans) {
      if (currentBot) currentBot.chat(ans)
      sendDiscordText(`👤 **You submitted: \`${ans}\`**`)
      pollActive = false
      return
    }
    await new Promise(r => setTimeout(r, 250))
  }
  pollActive = false
}

console.log('═══ MINEFORT BOT — v12 (position-only stitch) ═══')
console.log(`Gemini: ${CONFIG.geminiApiKey ? '✅' : '❌'}`)
