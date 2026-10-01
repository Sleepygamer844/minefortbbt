const mineflayer = require('mineflayer')
const axios = require('axios')
const express = require('express')

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
  res.json({ status, bot: CONFIG.username, uptime: Math.floor(process.uptime()) + 's' })
})

app.listen(PORT, () => console.log(`[HTTP] Listening on port ${PORT}`))

async function sendDiscordText(message) {
  if (!CONFIG.discordWebhook) return
  try {
    await axios.post(CONFIG.discordWebhook, { content: message.substring(0, 1900) })
  } catch (err) { console.error('[DISCORD]', err.message) }
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

function createBot() {
  status = 'connecting'
  console.log(`[BOT] Connecting...`)

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
      bot.chat(`/register ${CONFIG.password} ${CONFIG.password}`)
    } else if (/\/login/i.test(text)) {
      bot.chat(`/login ${CONFIG.password}`)
    } else if (/captcha|verification|verify/i.test(text)) {
      sendDiscordText(`🔐 CAPTCHA prompt:\n\`\`\`${text}\`\`\`\nDiagnosing...`)
      setTimeout(() => diagnose(bot), 3000)
      pollForAnswer(bot)
    }
  })

  bot.on('login', () => {
    console.log(`[BOT] Logged in as ${bot.username}`)
    status = 'online'
    sendDiscordText(`✅ Bot joined as **${bot.username}**`)

    setInterval(() => {
      if (bot.entity) {
        bot.setControlState('jump', true)
        setTimeout(() => bot.setControlState('jump', false), 400)
      }
    }, 30000)

    // Diagnose 5 seconds after login (in case CAPTCHA appears)
    setTimeout(() => diagnose(bot), 5000)
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
    setTimeout(createBot, 15000)
  })
}

// ─── DIAGNOSTIC: dump inventory + nearby entities ───
async function diagnose(bot) {
  console.log('[DIAG] Running diagnostic...')
  let report = '📋 **DIAGNOSTIC REPORT**\n'

  // Inventory
  try {
    const items = bot.inventory.items()
    if (items.length === 0) {
      report += '\n**Inventory:** empty\n'
    } else {
      report += '\n**Inventory items:**\n'
      for (const item of items) {
        report += `• \`${item.name}\` x${item.count}\n`
      }
    }
  } catch (e) {
    report += '\n**Inventory error:** ' + e.message + '\n'
  }

  // Held item
  try {
    const held = bot.heldItem
    if (held) {
      report += `\n**Held item:** \`${held.name}\` x${held.count}\n`
    } else {
      report += '\n**Held item:** none\n'
    }
  } catch (e) {}

  // Nearby entities (paintings, item frames)
  try {
    const entities = Object.values(bot.entities)
    const nearby = entities.filter(e => {
      if (!e.position || !bot.entity) return false
      const dx = e.position.x - bot.entity.position.x
      const dy = e.position.y - bot.entity.position.y
      const dz = e.position.z - bot.entity.position.z
      return (dx*dx + dy*dy + dz*dz) < 400 // within 20 blocks
    })
    const interesting = nearby.filter(e =>
      ['painting', 'item_frame', 'glow_item_frame', 'armor_stand', 'item'].includes(e.name)
    )
    if (interesting.length > 0) {
      report += '\n**Nearby entities:**\n'
      for (const e of interesting.slice(0, 10)) {
        report += `• \`${e.name}\` at ${Math.floor(e.position.x)}, ${Math.floor(e.position.y)}, ${Math.floor(e.position.z)}\n`
      }
    } else {
      report += '\n**Nearby entities:** none relevant\n'
    }
  } catch (e) {
    report += '\n**Entity error:** ' + e.message + '\n'
  }

  // Position
  if (bot.entity) {
    const p = bot.entity.position
    report += `\n**Position:** ${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}`
  }

  await sendDiscordText(report)
  console.log('[DIAG] Sent report to Discord')
}

async function pollForAnswer(bot) {
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000))
    const answer = await fetchCaptchaAnswer()
    if (answer) {
      console.log(`[CAPTCHA] Sending: ${answer}`)
      bot.chat(answer)
      sendDiscordText(`✅ Sent answer: **${answer}**`)
      return
    }
  }
}

console.log('═══ MINEFORT BOT — DIAGNOSTIC VERSION ═══')
createBot()
