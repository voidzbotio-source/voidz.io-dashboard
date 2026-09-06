'use strict'

// ============================================================
// VOIDZ.IO - MULTI-BOT MINECRAFT DASHBOARD SERVER
// ============================================================
// Each dashboard account connects its OWN Microsoft account to
// its OWN target server. Every account gets its own BotSession
// instance (see below), running concurrently in this process.
// ============================================================

const mineflayer = require('mineflayer')
const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const fs = require('fs')
const readline = require('readline')
const path = require('path')
const session = require('express-session')
const crypto = require('crypto')

// ============================================================
// .ENV LOADER
// ============================================================
// Zero-dependency .env support, so DASHBOARD_USERNAME/PASSWORD/
// SESSION_SECRET persist across restarts instead of needing to be
// re-exported in whatever terminal happens to start the process.
// A real environment variable (if one is already set) always wins
// over the .env file.
// ============================================================

function loadDotEnv() {

    const envPath = path.join(__dirname, '.env')

    let raw

    try {
        raw = fs.readFileSync(envPath, 'utf8')
    } catch {
        return
    }

    for (const line of raw.split('\n')) {

        const trimmed = line.trim()

        if (!trimmed || trimmed.startsWith('#')) continue

        const equalsIndex = trimmed.indexOf('=')

        if (equalsIndex === -1) continue

        const key = trimmed.slice(0, equalsIndex).trim()
        let value = trimmed.slice(equalsIndex + 1).trim()

        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1)
        }

        if (key && !(key in process.env)) {
            process.env[key] = value
        }

    }

}

loadDotEnv()

// ============================================================
// DASHBOARD LOGIN
// ============================================================
// Change these, or (better) set them in a local .env file (see
// .env.example) before hosting this anywhere public.
// ============================================================

const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME || 'admin'
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'changeme'
const SESSION_SECRET = process.env.SESSION_SECRET || 'please-change-this-session-secret'
const SESSION_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes of inactivity

// ============================================================
// LEGACY DEFAULT BOT
// ============================================================
// Used only once, to seed the admin account's own bot config on
// first boot after this multi-bot refactor - so the owner's bot
// keeps working exactly like it did before, with zero setup.
// ============================================================

const DEFAULT_HOST = 'java.flaremc.org'
const DEFAULT_PORT = 25565
const DEFAULT_VERSION = '1.21.11'
const DEFAULT_MICROSOFT_EMAIL = process.env.MICROSOFT_EMAIL || ''

// ============================================================
// AUTOMATION TIMERS
// ============================================================

const RECONNECT_DELAY = 15000
const MAX_RECONNECT_DELAY = 120000

const FIRST_JQ_DELAY = 15000
const JQ_RETRY_DELAY = 3000

const HOME_DELAY = 10000

const HUB_RECOVERY_DELAY = 90000

const KEYALL_TIMEZONE = 'Europe/Brussels'
const KEYALL_HOUR = 23
const KEYALL_MINUTE = 5

// Safety net in case the bot never made it onto LifeSteal (e.g.
// it got stuck in the Hub past its normal retry/recovery loop).
// Every day at this Eastern Time, if it's still not on LifeSteal,
// send /jq LifeSteal again and restart the retry/recovery loop.
const JQ_SAFETY_TIMEZONE = 'Europe/Brussels'
const JQ_SAFETY_HOUR = 13
const JQ_SAFETY_MINUTE = 8

const TEAM_INFO_TIMEOUT_MS = 4000
const TEAM_HISTORY_MAX_ENTRIES = 120

const ONLINE_NAME_COLORS = ['#77ffad', 'green', 'dark_green']
const OFFLINE_NAME_COLORS = ['#dc3545', 'red', 'dark_red']

// ============================================================
// FILES
// ============================================================

const APP_LOG_FILE = path.join(__dirname, 'app.log')
const USERS_FILE = path.join(__dirname, 'users.json')
const BOT_CONFIGS_FILE = path.join(__dirname, 'bot-configs.json')
const LOGS_DIR = path.join(__dirname, 'logs')
const AUTH_CACHE_DIR = path.join(__dirname, 'auth_cache')
const PUBLIC_DIR = path.join(__dirname, 'public')

fs.mkdirSync(LOGS_DIR, { recursive: true })
fs.mkdirSync(AUTH_CACHE_DIR, { recursive: true })

// ============================================================
// EXPRESS / SESSION / SOCKET.IO
// ============================================================

const app = express()
const server = http.createServer(app)
const io = new Server(server, { cors: { origin: '*' } })
const WEB_PORT = 3000

const sessionMiddleware = session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    // "rolling" means every authenticated request resets the 30
    // minute clock, so an active user never gets logged out mid-
    // session - only after 30 minutes of no requests at all.
    rolling: true,
    cookie: {
        maxAge: SESSION_TIMEOUT_MS,
        httpOnly: true,
        sameSite: 'lax'
    }
})

app.use(express.json())
app.use(sessionMiddleware)

// This is a private dashboard, not a public site - keep it out of
// search engines. The header covers every response (defense in
// depth for crawlers that ignore robots.txt); robots.txt below is
// the first thing well-behaved ones check.
app.use((req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow')
    next()
})

app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send('User-agent: *\nDisallow: /\n')
})

// Share the same session with Socket.IO connections, so a
// dashboard socket is only allowed to connect while logged in.
io.engine.use(sessionMiddleware)

function requireAuth(req, res, next) {

    if (req.session && req.session.loggedIn) {
        return next()
    }

    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Unauthorized' })
    }

    return res.redirect('/login')

}

// ============================================================
// PROTOCOL SPAM FILTER + CONSOLE OVERRIDES
// ============================================================

function isProtocolSpam(args) {

    const message = args.map(String).join(' ')

    return (
        message.includes('Chunk size is') ||
        message.includes('partial packet') ||
        message.includes('entity_teleport')
    )

}

const originalLog = console.log
const originalWarn = console.warn
const originalError = console.error

console.log = (...args) => { if (!isProtocolSpam(args)) originalLog(...args) }
console.warn = (...args) => { if (!isProtocolSpam(args)) originalWarn(...args) }
console.error = (...args) => { if (!isProtocolSpam(args)) originalError(...args) }

// ============================================================
// APP-LEVEL LOG (accounts, config changes, server lifecycle -
// anything that isn't a specific user's bot activity, which
// goes to that user's own file in logs/ instead)
// ============================================================

// A persistent, non-blocking write stream instead of appendFileSync
// per line - appendFileSync opens/writes/closes the file on every
// single call, which blocks Node's event loop. That stall was long
// enough to delay mineflayer's physics tick timer, which then fired
// a burst of queued ticks to catch up once the loop freed up -
// exactly the pattern FlareMC's anti-cheat TickTimer check flags as
// a timer hack.
const appLogStream = fs.createWriteStream(APP_LOG_FILE, { flags: 'a' })
appLogStream.on('error', error => originalError('[LOG ERROR]', error.message))

function appLog(message) {
    appLogStream.write(`[${new Date().toISOString()}] ${message}\n`)
}

// ============================================================
// USER ACCOUNTS
// ============================================================
// Real signups, on top of the single DASHBOARD_USERNAME/PASSWORD
// admin login above. Stored as salted scrypt hashes in a local
// JSON file - fine for a small team, not meant to scale past
// that.
// ============================================================

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/
const MIN_PASSWORD_LENGTH = 8

function loadUsers() {

    try {
        const raw = fs.readFileSync(USERS_FILE, 'utf8')
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed) ? parsed : []
    } catch {
        return []
    }

}

function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2))
}

function findUser(users, username) {
    const normalized = String(username || '').toLowerCase()
    return users.find(user => user.username.toLowerCase() === normalized)
}

function hashPassword(password) {

    const salt = crypto.randomBytes(16).toString('hex')
    const hash = crypto.scryptSync(password, salt, 64).toString('hex')

    return { salt, hash }

}

function verifyPassword(password, salt, hash) {

    const candidate = crypto.scryptSync(password, salt, 64)
    const expected = Buffer.from(hash, 'hex')

    if (candidate.length !== expected.length) {
        return false
    }

    return crypto.timingSafeEqual(candidate, expected)

}

// Saves a partial update onto one user's record (by username) and
// persists the whole store. Returns the updated record, or null if
// the account doesn't exist (e.g. it's the env-based admin login,
// which isn't in this file at all).
function updateUser(username, patch) {

    const users = loadUsers()
    const user = findUser(users, username)

    if (!user) {
        return null
    }

    Object.assign(user, patch)

    saveUsers(users)

    return user

}

// ============================================================
// BOT CONFIG (per account - which Microsoft account, which
// server, and whether the FlareMC-LifeSteal automation applies)
// ============================================================

function loadBotConfigs() {

    try {
        const raw = fs.readFileSync(BOT_CONFIGS_FILE, 'utf8')
        const parsed = JSON.parse(raw)
        return (parsed && typeof parsed === 'object') ? parsed : {}
    } catch {
        return {}
    }

}

function saveBotConfigs(configs) {
    fs.writeFileSync(BOT_CONFIGS_FILE, JSON.stringify(configs, null, 2))
}

function getBotConfig(username) {
    const configs = loadBotConfigs()
    return configs[username] || null
}

function saveBotConfig(username, config) {
    const configs = loadBotConfigs()
    configs[username] = { ...configs[username], ...config }
    saveBotConfigs(configs)
}

function getAutoReinviteList(username) {
    const configs = loadBotConfigs()
    const list = configs[username]?.autoReinvite
    return Array.isArray(list) ? list : []
}

function saveAutoReinviteList(username, list) {
    const configs = loadBotConfigs()
    configs[username] = { ...configs[username], autoReinvite: list }
    saveBotConfigs(configs)
}

function getTeamHistory(username) {
    const configs = loadBotConfigs()
    const history = configs[username]?.teamHistory
    return Array.isArray(history) ? history : []
}

function saveTeamHistory(username, history) {
    const configs = loadBotConfigs()
    configs[username] = { ...configs[username], teamHistory: history }
    saveBotConfigs(configs)
}

function getKothHistory(username) {
    const configs = loadBotConfigs()
    const history = configs[username]?.kothHistory
    return Array.isArray(history) ? history : []
}

function saveKothHistory(username, history) {
    const configs = loadBotConfigs()
    configs[username] = { ...configs[username], kothHistory: history }
    saveBotConfigs(configs)
}

function getDeathHistory(username) {
    const configs = loadBotConfigs()
    const history = configs[username]?.deathHistory
    return Array.isArray(history) ? history : []
}

function saveDeathHistory(username, history) {
    const configs = loadBotConfigs()
    configs[username] = { ...configs[username], deathHistory: history }
    saveBotConfigs(configs)
}

// Everything the dashboard used to keep in localStorage only
// (Threats, Allies, and the Appearance tab) - now synced through
// here too, so it follows the account across devices/browsers.
const PREFERENCE_KEYS = ['threats', 'allies', 'theme', 'customAccent', 'reduceMotion', 'compactMode', 'alertVolume']

function getPreferences(username) {

    const configs = loadBotConfigs()
    const config = configs[username] || {}

    return {
        threats: Array.isArray(config.threats) ? config.threats : [],
        allies: Array.isArray(config.allies) ? config.allies : [],
        theme: config.theme || null,
        customAccent: config.customAccent || null,
        reduceMotion: !!config.reduceMotion,
        compactMode: !!config.compactMode,
        alertVolume: Number.isFinite(config.alertVolume) ? config.alertVolume : 70,
        // False the very first time this account is seen after this
        // feature shipped - tells the client "nothing saved here yet,
        // push your localStorage state up instead of overwriting it."
        synced: PREFERENCE_KEYS.some(key => key in config)
    }

}

function savePreferences(username, partial) {

    const configs = loadBotConfigs()
    configs[username] = { ...configs[username], ...partial }
    saveBotConfigs(configs)

}

function normalizeBotConfig(input) {

    const microsoftEmail = String(input?.microsoftEmail || '').trim()
    const host = String(input?.host || '').trim()

    const portRaw = Number(input?.port)
    const port = (Number.isFinite(portRaw) && portRaw > 0 && portRaw <= 65535) ? portRaw : 25565

    // Blank version means "let mineflayer auto-detect it" - lets
    // users connect without knowing their server's exact version.
    const version = String(input?.version || '').trim()

    const lifestealAutopilot = !!input?.lifestealAutopilot
    const discordWebhookUrl = String(input?.discordWebhookUrl || '').trim()
    const discordRoleId = String(input?.discordRoleId || '').trim().replace(/\D/g, '')

    return { microsoftEmail, host, port, version, lifestealAutopilot, discordWebhookUrl, discordRoleId }

}

function validateBotConfig(config) {

    if (!config.microsoftEmail || !config.microsoftEmail.includes('@')) {
        return 'Enter a valid Microsoft account email.'
    }

    if (!config.host) {
        return 'Enter a server address.'
    }

    return null

}

function ensureAdminBotConfigSeeded() {

    const configs = loadBotConfigs()

    if (!configs[DASHBOARD_USERNAME]) {

        configs[DASHBOARD_USERNAME] = {
            microsoftEmail: DEFAULT_MICROSOFT_EMAIL,
            host: DEFAULT_HOST,
            port: DEFAULT_PORT,
            version: DEFAULT_VERSION,
            lifestealAutopilot: true
        }

        saveBotConfigs(configs)

        appLog(`Seeded admin (${DASHBOARD_USERNAME}) bot config from legacy defaults.`)

    }

}

// ============================================================
// STATELESS HELPERS (shared by every BotSession)
// ============================================================

function cleanMessage(text) {

    if (!text) {
        return ''
    }

    return text
        .toString()
        .replace(/§[0-9a-fk-or]/gi, '')
        .replace(/\s+/g, ' ')
        .trim()

}

function sendDiscordWebhook(webhookUrl, content, roleId) {

    if (!webhookUrl) return

    const body = {
        content: roleId ? `<@&${roleId}> ${content}` : content
    }

    // Discord only actually pings a role mention in a webhook message
    // if it's explicitly allowed here - otherwise it renders as text
    // but stays silent.
    if (roleId) {
        body.allowed_mentions = { roles: [roleId] }
    }

    fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    }).catch(error => originalError('[DISCORD WEBHOOK]', error.message))

}

function containsLifeSteal(text) {

    const normalized = cleanMessage(text).toLowerCase()

    return (
        normalized.includes('sending you to lifesteal') ||
        normalized.includes('sending you to life steal') ||
        normalized.includes('sent to lifesteal') ||
        normalized.includes('joined lifesteal') ||
        normalized.includes('teleporting to lifesteal')
    )

}

function isProxySessionProblem(text) {

    const normalized = cleanMessage(text).toLowerCase()

    return (
        normalized.includes('you are already connected to this proxy') ||
        normalized.includes('already connected to this proxy')
    )

}

// "Sending you to LifeSteal" only means the transfer STARTED, not that
// it succeeded - right after a server-wide restart the LifeSteal
// sub-server can still reject the transfer a moment later with this
// message. If that happens after we already marked ourselves as having
// arrived, we need to undo that and retry, or the bot gets stuck
// thinking it's on LifeSteal while it's actually still in the Hub.
function isLifeStealConnectFailure(text) {

    const normalized = cleanMessage(text).toLowerCase()

    return (
        normalized.includes('unable to connect you to lifesteal') ||
        normalized.includes('unable to connect you to life steal')
    )

}

function classifyInventorySlot(slot) {

    if (slot === 45) return 'offhand'
    if (slot >= 36 && slot <= 44) return 'hotbar'
    if (slot >= 9 && slot <= 35) return 'main'
    if (slot >= 5 && slot <= 8) return 'armor'
    if (slot >= 1 && slot <= 4) return 'crafting'
    if (slot === 0) return 'crafting-output'

    return 'other'

}

function classifyMemberColor(color) {

    const normalized = String(color || '').toLowerCase()

    if (ONLINE_NAME_COLORS.includes(normalized)) return true
    if (OFFLINE_NAME_COLORS.includes(normalized)) return false

    return null

}

// Flattens a prismarine-chat JSON tree into an ordered list of
// { text, color } leaves, in reading order.
function flattenChatComponents(node, out = []) {

    if (!node) {
        return out
    }

    if (node.text) {
        out.push({ text: node.text, color: node.color || null })
    }

    if (Array.isArray(node.extra)) {
        for (const child of node.extra) {
            flattenChatComponents(child, out)
        }
    }

    return out

}

function getEasternTimeFormatter(timezone) {

    return new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    })

}

function formatDateParts(formatter, date) {

    const parts = formatter.formatToParts(date)
    const result = {}

    for (const part of parts) {
        if (part.type !== 'literal') {
            result[part.type] = Number(part.value)
        }
    }

    return result

}

function getEasternDateString() {

    const parts = formatDateParts(getEasternTimeFormatter(KEYALL_TIMEZONE), new Date())

    return [
        parts.year,
        String(parts.month).padStart(2, '0'),
        String(parts.day).padStart(2, '0')
    ].join('-')

}

// Milliseconds until the next occurrence of hour:minute in the
// given time zone. Shared by the keyall and JQ-safety schedulers.
function getMillisecondsUntilNextEasternTime(timezone, hour, minute) {

    const now = new Date()
    const formatter = getEasternTimeFormatter(timezone)
    const searchLimit = 48 * 60

    for (let i = 0; i <= searchLimit; i++) {

        const candidate = new Date(now.getTime() + i * 60 * 1000)
        const values = formatDateParts(formatter, candidate)

        if (values.hour === hour && values.minute === minute) {

            const rawDelay = candidate.getTime() - now.getTime()

            // If we're rescheduling from inside the target minute
            // itself (e.g. right after firing), this would otherwise
            // match "now" again and refire a second later in a loop
            // until the minute ticks over - skip ahead to tomorrow.
            if (rawDelay < 60000) {
                continue
            }

            return rawDelay

        }

    }

    return 24 * 60 * 60 * 1000

}

// ============================================================
// BOT SESSION
// ============================================================
// One instance per account. Owns its own mineflayer bot, its
// own timers, its own log file, and its own live dashboard
// state. Nothing here is shared between accounts.
// ============================================================

class BotSession {

    constructor(username, config) {

        this.username = username
        this.config = config

        this.logFile = path.join(LOGS_DIR, `${username}.log`)
        this.logStream = fs.createWriteStream(this.logFile, { flags: 'a' })
        this.logStream.on('error', error => originalError('[LOG ERROR]', error.message))

        this.bot = null

        this.reconnectTimer = null
        this.jqTimer = null
        this.homeTimer = null
        this.recoveryTimer = null
        this.keyallTimer = null
        this.nextKeyallAt = null
        this.jqSafetyTimer = null

        this.shuttingDown = false

        this.lifeStealReached = false
        this.recoveryRunning = false

        this.reconnectCount = 0
        this.connectedAt = null

        this.lastDisconnectReason = 'None'
        this.lastChatMessage = 'None'
        this.lastChatTime = null
        this.lastServerMessageKey = null

        // Parsed roster from the last completed /t info, plus the
        // in-progress capture while still reading its response.
        this.teamRoster = null
        this.teamInfoCapture = null
        this.teamInfoCaptureTimer = null

        // Points from each /t info, oldest first, capped - powers the
        // trend sparkline on the Team card. Persisted to disk (see
        // getTeamHistory/saveTeamHistory) so it survives a restart
        // instead of resetting every time the process comes back up.
        this.teamHistory = getTeamHistory(username)
        this.lastTeamRefreshRequestAt = 0

        // Who captured each KOTH, how many team points it was worth,
        // and when - shown as a log alongside the Points detail chart.
        // Persisted the same way as teamHistory.
        this.kothHistory = getKothHistory(username)

        // Team deaths that cost points ("Your team has lost 5 points
        // due to <player>'s death."), same shape/persistence as
        // kothHistory - shown merged with it in the Points detail
        // modal so it reads as one "why did our points change" log.
        this.deathHistory = getDeathHistory(username)

        // Last known-settled inventory read (see getInventorySnapshot/
        // getKeyAmounts) - served back out during a mid-update burst
        // instead of a possibly-inconsistent live read.
        this.lastInventoryTouchedAt = 0
        this.cachedInventorySnapshot = []
        this.cachedKeyAmounts = { vote: 0, exclusive: 0, insane: 0 }

        this.botState = 'OFFLINE'
        this.currentWorld = 'Unknown'
        this.reconnectDelay = RECONNECT_DELAY
        this.proxySessionProblem = false
        this.lastKeyClaimDate = null

        // Whether the bot SHOULD be connected right now. Turned
        // off by the dashboard's Stop button, on by Start. This is
        // separate from shuttingDown (a full process shutdown).
        this.botEnabled = true

        // Auto-reinvited players who have already been kicked for
        // low HP this "episode" - keyed by lowercase name, cleared
        // once their tab-list HP is seen back at/above the threshold
        // (or they drop off the tab list) so they aren't kicked
        // every single tick while they stay critical.
        this.lowHpHandled = new Set()

    }

    // --------------------------------------------------------
    // LOGGING
    // --------------------------------------------------------

    log(message) {
        this.logStream.write(`[${new Date().toISOString()}] ${message}\n`)
    }

    // --------------------------------------------------------
    // READ-ONLY SNAPSHOTS
    // --------------------------------------------------------

    getMaxHealth() {

        const attributes = this.bot?.entity?.attributes
        const attribute = attributes?.['minecraft:generic.max_health'] || attributes?.['generic.max_health']
        const value = Number(attribute?.value)

        return (Number.isFinite(value) && value > 0) ? value : 20

    }

    getVisiblePlayers() {

        if (!this.bot || !this.bot.players) {
            return []
        }

        return Object.keys(this.bot.players)
            .filter(name => name)
            .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))

    }

    getInventorySnapshot() {

        if (!this.bot || !this.bot.inventory) {
            return []
        }

        // A burst of per-slot update packets can still be landing
        // (e.g. right after claiming several items at once) - serve
        // the last settled read instead of a possibly-inconsistent
        // one, rather than showing the dashboard a half-updated list.
        if (Date.now() - this.lastInventoryTouchedAt < 150) {
            return this.cachedInventorySnapshot
        }

        const slots = this.bot.inventory.slots || []
        const result = []

        for (let slot = 0; slot < slots.length; slot++) {

            const item = slots[slot]

            if (!item) {
                continue
            }

            const enchants = Array.isArray(item.enchants)
                ? item.enchants.map(enchant => ({
                    name: enchant.name || enchant.id || 'unknown',
                    level: enchant.lvl ?? enchant.level ?? null
                }))
                : []

            result.push({
                slot,
                region: classifyInventorySlot(slot),
                name: item.name,
                displayName: item.displayName || item.name,
                count: item.count,
                enchants
            })

        }

        this.cachedInventorySnapshot = result

        return result

    }

    getKeyAmounts() {

        if (!this.bot || !this.bot.inventory) {
            return { vote: 0, exclusive: 0, insane: 0 }
        }

        // Same settle-guard as getInventorySnapshot() - avoid counting
        // keys mid-way through a burst of slot updates.
        if (Date.now() - this.lastInventoryTouchedAt < 150) {
            return this.cachedKeyAmounts
        }

        const result = { vote: 0, exclusive: 0, insane: 0 }

        for (const item of this.bot.inventory.items()) {

            if (!item) {
                continue
            }

            const itemName = String(item.name || '').toLowerCase()

            let keyType = null

            if (itemName === 'yellow_dye') keyType = 'vote'
            else if (itemName === 'orange_dye') keyType = 'exclusive'
            else if (itemName === 'red_dye') keyType = 'insane'

            if (!keyType) {
                continue
            }

            let hasMending = true

            if (Array.isArray(item.enchants)) {

                hasMending = item.enchants.some(enchant => {
                    const enchantName = String(enchant.name || enchant.id || '').toLowerCase()
                    return enchantName === 'mending' || enchantName.includes('mending')
                })

            }

            if (!hasMending) {
                continue
            }

            result[keyType] += Number(item.count) || 0

        }

        this.cachedKeyAmounts = result

        return result

    }

    formatUptime() {

        if (!this.connectedAt) {
            return 'Not connected'
        }

        const totalSeconds = Math.floor((Date.now() - this.connectedAt) / 1000)

        const days = Math.floor(totalSeconds / 86400)
        const hours = Math.floor((totalSeconds % 86400) / 3600)
        const minutes = Math.floor((totalSeconds % 3600) / 60)
        const seconds = totalSeconds % 60

        let result = ''

        if (days > 0) result += `${days}d `
        if (hours > 0 || days > 0) result += `${hours}h `
        if (minutes > 0 || hours > 0 || days > 0) result += `${minutes}m `

        result += `${seconds}s`

        return result

    }

    getDashboardData() {

        const online = !!(this.bot && this.bot.entity)
        const keys = online ? this.getKeyAmounts() : { vote: 0, exclusive: 0, insane: 0 }
        const players = this.getVisiblePlayers()

        return {

            configured: true,
            online,
            botEnabled: this.botEnabled,

            state: this.botState,
            world: this.currentWorld,
            server: this.config.host ? `${this.config.host}:${this.config.port}` : '-',
            version: this.config.version || 'auto',

            uptime: this.formatUptime(),
            reconnects: this.reconnectCount,
            reconnectDelay: Math.round(this.reconnectDelay / 1000),

            lifeSteal: this.lifeStealReached,
            lifestealAutopilot: !!this.config.lifestealAutopilot,
            jqRetrying: !!this.jqTimer,
            recoveryTimer: !!this.recoveryTimer,
            proxyProblem: this.proxySessionProblem,

            health: online ? this.bot.health : null,
            maxHealth: online ? this.getMaxHealth() : null,
            food: online ? this.bot.food : null,
            ping: (online && typeof this.bot.player?.ping === 'number') ? this.bot.player.ping : null,

            players,
            playerCount: players.length,

            keys,
            totalKeys: keys.vote + keys.exclusive + keys.insane,
            nextKeyallAt: this.nextKeyallAt,

            lastChat: this.lastChatMessage,
            lastChatTime: this.lastChatTime,
            lastDisconnect: this.lastDisconnectReason,
            connectedAt: this.connectedAt,

            inventory: online ? this.getInventorySnapshot() : [],

            team: this.teamRoster
                ? {
                    name: this.teamRoster.header?.name ?? null,
                    size: this.teamRoster.header ? `${this.teamRoster.header.current}/${this.teamRoster.header.max}` : null,
                    points: this.teamRoster.header?.points ?? null,
                    balance: this.teamRoster.balance,
                    onlineCount: this.teamRoster.onlineCount,
                    totalCount: this.teamRoster.totalCount,
                    roles: this.teamRoster.roles,
                    updatedAt: this.teamRoster.updatedAt,
                    history: this.teamHistory,
                    kothHistory: this.kothHistory,
                    deathHistory: this.deathHistory
                }
                : null,

            timestamp: Date.now()

        }

    }

    updateDashboard() {
        io.to(this.username).emit('status', this.getDashboardData())
    }

    // --------------------------------------------------------
    // CHAT
    // --------------------------------------------------------

    broadcastChat(username, message) {

        const time = new Date().toLocaleTimeString()

        this.lastChatMessage = `<${username}> ${message}`
        this.lastChatTime = time

        io.to(this.username).emit('chat', { username, message, time })

        this.updateDashboard()

    }

    sendMinecraftChat(message) {

        if (!this.bot || !this.bot.entity) {
            originalLog(`[CHAT:${this.username}] Bot is not connected.`)
            return
        }

        if (!message) {
            return
        }

        this.bot.chat(message)

        this.log(`Dashboard/terminal sent: ${message}`)

    }

    // --------------------------------------------------------
    // MOVEMENT
    // --------------------------------------------------------
    // Real-time directional control from the dashboard's D-pad -
    // press-and-hold sends {direction, active:true}, release sends
    // {direction, active:false}, mapped straight onto mineflayer's
    // own control state (the same interface used for actual
    // keyboard input), not a scripted walk-to-coordinates path.

    static MOVEMENT_CONTROLS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']

    setMovement(direction, active) {

        if (!this.bot || !this.bot.entity) return
        if (!BotSession.MOVEMENT_CONTROLS.includes(direction)) return

        this.bot.setControlState(direction, !!active)

    }

    // Safety net for a dropped dashboard connection while a direction
    // was held down - without this the bot would just keep walking
    // forever in that direction.
    stopAllMovement() {

        if (!this.bot || !this.bot.entity) return

        for (const control of BotSession.MOVEMENT_CONTROLS) {
            this.bot.setControlState(control, false)
        }

    }

    // --------------------------------------------------------
    // TIMER HELPERS
    // --------------------------------------------------------

    stopJqRetry() { if (this.jqTimer) { clearInterval(this.jqTimer); this.jqTimer = null } }
    stopRecoveryTimer() { if (this.recoveryTimer) { clearTimeout(this.recoveryTimer); this.recoveryTimer = null } }
    stopHomeTimer() { if (this.homeTimer) { clearTimeout(this.homeTimer); this.homeTimer = null } }
    stopKeyallTimer() { if (this.keyallTimer) { clearTimeout(this.keyallTimer); this.keyallTimer = null } }
    stopJqSafetyTimer() { if (this.jqSafetyTimer) { clearTimeout(this.jqSafetyTimer); this.jqSafetyTimer = null } }

    // --------------------------------------------------------
    // STATE
    // --------------------------------------------------------

    setState(newState) {

        if (this.botState === newState) {
            this.updateDashboard()
            return
        }

        const oldState = this.botState
        this.botState = newState

        this.log(`State changed: ${oldState} -> ${newState}`)

        this.updateDashboard()

    }

    // --------------------------------------------------------
    // LIFESTEAL AUTOPILOT (gated behind config.lifestealAutopilot -
    // this whole block is FlareMC-LifeSteal specific and stays
    // fully intact, just opt-in per account)
    // --------------------------------------------------------

    sendJq() {

        if (!this.bot || !this.bot.entity || this.shuttingDown) return
        if (this.lifeStealReached) return

        this.bot.chat('/jq LifeSteal')

        this.log('Sent /jq LifeSteal.')

    }

    startJqRetry() {

        if (!this.config.lifestealAutopilot) return
        if (!this.bot || !this.bot.entity || this.shuttingDown) return
        if (this.lifeStealReached) return

        this.stopJqRetry()
        this.stopRecoveryTimer()

        this.setState('JOINING LIFESTEAL')

        this.sendJq()

        this.jqTimer = setInterval(() => {

            if (!this.bot || !this.bot.entity || this.shuttingDown) { this.stopJqRetry(); return }
            if (this.lifeStealReached) { this.stopJqRetry(); return }

            this.sendJq()

        }, JQ_RETRY_DELAY)

    }

    reachedLifeSteal(reason = 'detected') {

        if (this.lifeStealReached) return

        this.lifeStealReached = true
        this.recoveryRunning = false

        this.stopJqRetry()
        this.stopRecoveryTimer()
        this.stopHomeTimer()

        this.currentWorld = 'LifeSteal'
        this.setState('LIFESTEAL')

        this.log(`LifeSteal detected (${reason}).`)

        this.homeTimer = setTimeout(() => {

            if (!this.bot || !this.bot.entity || this.shuttingDown) return

            this.bot.chat('/home AFK')

            this.setState('AFK')

            this.log('Sent /home AFK.')

        }, HOME_DELAY)

    }

    handleSpawnState() {

        if (!this.bot || !this.bot.entity) return

        if (this.lifeStealReached) {
            this.currentWorld = 'LifeSteal'
            this.setState('LIFESTEAL')
            return
        }

        this.currentWorld = 'Hub'
        this.setState('HUB')

    }

    startHubRecovery() {

        if (!this.config.lifestealAutopilot) return

        this.stopRecoveryTimer()

        this.recoveryTimer = setTimeout(() => {

            this.recoveryTimer = null

            if (!this.bot || !this.bot.entity || this.shuttingDown) return
            if (this.lifeStealReached) return
            if (this.recoveryRunning) return

            this.recoveryRunning = true

            this.setState('RECOVERING')

            originalLog(`[RECOVERY:${this.username}] Still in Hub. Retrying LifeSteal...`)

            this.log('Automatic Hub recovery started.')

            this.startJqRetry()

            this.recoveryRunning = false

        }, HUB_RECOVERY_DELAY)

    }

    manualRecovery() {

        if (!this.bot || !this.bot.entity) {
            originalLog(`[RECOVER:${this.username}] Bot is not connected.`)
            return
        }

        originalLog(`[RECOVER:${this.username}] Starting recovery...`)

        this.lifeStealReached = false
        this.currentWorld = 'Hub / Recovery'

        this.startJqRetry()
        this.startHubRecovery()

        this.log('Manual recovery requested.')

    }

    manualLifeSteal() {

        if (!this.bot || !this.bot.entity) {
            originalLog(`[LS:${this.username}] Bot is not connected.`)
            return
        }

        this.lifeStealReached = false
        this.currentWorld = 'Hub'

        this.startJqRetry()
        this.startHubRecovery()

        this.log('Manual LifeSteal routine requested.')

    }

    goAfk() {

        if (!this.bot || !this.bot.entity) {
            originalLog(`[AFK:${this.username}] Bot is not connected.`)
            return
        }

        this.stopHomeTimer()

        this.bot.chat('/home AFK')

        this.setState('AFK')

        this.log('Sent /home AFK.')

    }

    goHub() {

        if (!this.bot || !this.bot.entity) {
            originalLog(`[HUB:${this.username}] Bot is not connected.`)
            return
        }

        this.bot.chat('/hub')

        this.lifeStealReached = false
        this.currentWorld = 'Hub'
        this.setState('HUB')

        this.stopJqRetry()
        this.startHubRecovery()

        this.log('Sent /hub.')

    }

    // --------------------------------------------------------
    // CONNECTION CONTROL
    // --------------------------------------------------------

    manualRejoin() {

        if (this.shuttingDown) return

        if (!this.bot || !this.bot.entity) {
            originalLog(`[REJOIN:${this.username}] Bot is not connected.`)
            return
        }

        originalLog(`[REJOIN:${this.username}] Reconnecting manually...`)

        this.log('Manual rejoin requested.')

        this.stopJqRetry()
        this.stopHomeTimer()
        this.stopRecoveryTimer()

        this.lifeStealReached = false
        this.currentWorld = 'Reconnecting'
        this.setState('REJOINING')

        this.bot.quit('Manual rejoin')

    }

    startBotRemote() {

        if (this.shuttingDown) return

        if (this.bot && this.bot.entity) {
            originalLog(`[REMOTE:${this.username}] Start requested, but the bot is already running.`)
            return
        }

        originalLog(`[REMOTE:${this.username}] Starting bot from dashboard...`)

        this.log('Bot start requested from dashboard.')

        this.botEnabled = true
        this.reconnectDelay = RECONNECT_DELAY

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }

        this.connect()

    }

    stopBotRemote() {

        if (!this.botEnabled && (!this.bot || !this.bot.entity)) {
            originalLog(`[REMOTE:${this.username}] Stop requested, but the bot is already stopped.`)
            return
        }

        originalLog(`[REMOTE:${this.username}] Stopping bot from dashboard...`)

        this.log('Bot stop requested from dashboard.')

        this.botEnabled = false

        this.stopJqRetry()
        this.stopHomeTimer()
        this.stopRecoveryTimer()

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }

        this.currentWorld = 'Stopped'
        this.setState('STOPPED')

        if (this.bot) {
            try { this.bot.quit('Stopped via dashboard') } catch {}
        }

    }

    // --------------------------------------------------------
    // TERMINAL / DASHBOARD "show" HELPERS
    // --------------------------------------------------------

    showPing() {

        if (!this.bot || !this.bot.entity) { originalLog('Bot is not currently connected.'); return }

        const ping = typeof this.bot.player?.ping === 'number' ? this.bot.player.ping : null

        if (ping === null) { originalLog('Ping unavailable.'); return }

        originalLog(`Ping: ${ping}ms`)

    }

    showHealth() {

        if (!this.bot || !this.bot.entity) { originalLog('Bot is not currently connected.'); return }

        originalLog('')
        originalLog('========== VOIDZ.IO HEALTH ==========')
        originalLog(`Health: ${Math.floor(this.bot.health)}/${Math.floor(this.getMaxHealth())}`)
        originalLog(`Food:   ${this.bot.food}/20`)
        originalLog('======================================')
        originalLog('')

    }

    showPlayers() {
        originalLog(`Visible players: ${this.getVisiblePlayers().length}`)
    }

    showPlayersList() {

        const players = this.getVisiblePlayers()

        originalLog('')
        originalLog(`========== PLAYERS (${players.length}) ==========`)

        if (players.length === 0) {
            originalLog('No players currently visible.')
        } else {
            for (const player of players) originalLog(`- ${player}`)
        }

        originalLog('====================================')
        originalLog('')

    }

    // One-off diagnostic for the low-HP auto-kick feature: dumps each
    // online player's raw tab-list text (JSON-escaped, so any custom
    // font / private-use-area characters show up as \uXXXX) into the
    // dashboard's chat panel, since there's no server console access
    // from there. Trigger from the browser console with:
    //   sendCommand('tablist-debug')
    debugTabList() {

        if (!this.bot || !this.bot.players) {
            io.to(this.username).emit('notice', { type: 'error', text: 'Bot is not connected.' })
            return
        }

        const names = Object.keys(this.bot.players)

        if (names.length === 0) {
            io.to(this.username).emit('notice', { type: 'error', text: 'No players in the tab list right now.' })
            return
        }

        for (const name of names.slice(0, 10)) {

            const player = this.bot.players[name]
            const raw = player?.displayName?.toString?.() ?? String(player?.displayName ?? '(no display name)')

            io.to(this.username).emit('chat', {
                username: 'DEBUG',
                message: `${name}: ${JSON.stringify(raw)}`,
                time: new Date().toLocaleTimeString()
            })

        }

    }

    // One-off diagnostic for the Black Market auto-buy feature. Sends
    // /bm itself (must run through the BOT's own connection - a
    // human manually opening /bm on a separate client/session never
    // reaches this bot's windowOpen event), dumps the shop's slots,
    // then clicks whichever slot's name/lore mentions "insane" to
    // reveal the confirm dialog and dumps that too. Clicking a shop
    // item only opens its confirm dialog - it does NOT spend
    // anything, and nothing in the confirm dialog itself is ever
    // clicked. If the Insane Key is at 0 stock right now, the server
    // may not open a confirm dialog at all, in which case only the
    // SHOP dump will show up. Trigger from the browser console with:
    //   sendCommand('bm-debug')
    debugNextWindow() {

        if (!this.bot) {
            io.to(this.username).emit('notice', { type: 'error', text: 'Bot is not connected.' })
            return
        }

        const dumpWindow = (window, label) => {

            io.to(this.username).emit('chat', {
                username: 'DEBUG',
                message: `${label} - Window: "${window.title || window.type}" (${window.slots.length} slots)`,
                time: new Date().toLocaleTimeString()
            })

            const entries = window.slots
                .map((item, index) => ({ item, index }))
                .filter(entry => entry.item)

            for (const { item, index } of entries.slice(0, 20)) {

                const lore = item.nbt
                    ? JSON.stringify(item.nbt).slice(0, 300)
                    : '(no nbt)'

                io.to(this.username).emit('chat', {
                    username: 'DEBUG',
                    message: `${label} #${index}: ${item.name} x${item.count} - "${item.displayName}" - ${lore}`,
                    time: new Date().toLocaleTimeString()
                })

            }

            return entries

        }

        io.to(this.username).emit('notice', { type: 'info', text: 'Opening /bm to inspect it...' })

        this.bot.once('windowOpen', shopWindow => {

            const entries = dumpWindow(shopWindow, 'SHOP')

            const target = entries.find(({ item }) =>
                /insane/i.test(item.displayName || '') ||
                (item.nbt && /insane/i.test(JSON.stringify(item.nbt)))
            )

            if (!target) {
                io.to(this.username).emit('notice', { type: 'error', text: 'No "Insane"-named item found in the shop to click.' })
                return
            }

            this.bot.once('windowOpen', confirmWindow => {
                dumpWindow(confirmWindow, 'CONFIRM')
            })

            this.bot.clickWindow(target.index, 0, 0).catch(() => {})

        })

        this.sendMinecraftChat('/bm')

    }

    showWhere() {

        if (!this.bot || !this.bot.entity) { originalLog('Bot is not currently connected.'); return }

        originalLog(`World: ${this.currentWorld}`)
        originalLog(`State: ${this.botState}`)

    }

    showLastChat() {

        originalLog('')
        originalLog(`Last chat: ${this.lastChatMessage}`)
        originalLog(`Time: ${this.lastChatTime || 'None'}`)
        originalLog('')

    }

    showUptime() {

        originalLog('')
        originalLog(`Uptime: ${this.formatUptime()}`)
        originalLog(`Reconnects: ${this.reconnectCount}`)
        originalLog('')

    }

    showKeysAmount() {

        if (!this.bot || !this.bot.inventory) { originalLog('[KEYS] Bot is not currently connected.'); return }

        const keys = this.getKeyAmounts()
        const total = keys.vote + keys.exclusive + keys.insane

        originalLog('')
        originalLog('╔══════════════════════════════════════╗')
        originalLog('║            KEY AMOUNTS               ║')
        originalLog('╠══════════════════════════════════════╣')
        originalLog(`║ Vote Keys:      ${String(keys.vote).padEnd(17)}║`)
        originalLog(`║ Exclusive Keys: ${String(keys.exclusive).padEnd(17)}║`)
        originalLog(`║ Insane Keys:    ${String(keys.insane).padEnd(17)}║`)
        originalLog('╠══════════════════════════════════════╣')
        originalLog(`║ Total Keys:     ${String(total).padEnd(17)}║`)
        originalLog('╚══════════════════════════════════════╝')
        originalLog('')

        this.log(`Keys: Vote=${keys.vote}, Exclusive=${keys.exclusive}, Insane=${keys.insane}, Total=${total}`)

    }

    showStatus() {

        const data = this.getDashboardData()

        originalLog('')
        originalLog('========================================')
        originalLog(`   VOIDZ.IO STATUS - ${this.username}`)
        originalLog('========================================')
        originalLog(`Status:          ${data.online ? 'ONLINE' : 'OFFLINE'}`)
        originalLog(`Server:          ${data.server}`)
        originalLog(`World:           ${data.world}`)
        originalLog(`State:           ${data.state}`)
        originalLog(`LifeSteal:       ${data.lifeSteal ? 'YES' : 'NO'}`)
        originalLog(`JQ retrying:     ${data.jqRetrying ? 'YES' : 'NO'}`)
        originalLog(`Recovery timer:  ${data.recoveryTimer ? 'YES' : 'NO'}`)
        originalLog(`Vote keys:       ${data.keys.vote}`)
        originalLog(`Exclusive keys:  ${data.keys.exclusive}`)
        originalLog(`Insane keys:     ${data.keys.insane}`)
        originalLog(`Total keys:      ${data.totalKeys}`)
        originalLog(`Uptime:          ${data.uptime}`)
        originalLog(`Reconnects:      ${data.reconnects}`)
        originalLog(`Reconnect delay: ${data.reconnectDelay}s`)
        originalLog(`Proxy problem:   ${data.proxyProblem ? 'YES' : 'NO'}`)
        originalLog(`Last disconnect: ${data.lastDisconnect}`)
        originalLog(`Last chat:       ${data.lastChat}`)
        originalLog('========================================')
        originalLog('')

    }

    // --------------------------------------------------------
    // TEAM INFO (/t info)
    // --------------------------------------------------------
    // The server colors each member's name green when online and
    // red when offline. Read that color straight off the chat
    // component JSON (not the stripped text, which loses it).
    // --------------------------------------------------------

    requestTeamInfo() {

        if (!this.bot || !this.bot.entity) {
            originalLog(`[TEAM:${this.username}] Bot is not connected.`)
            return
        }

        if (this.teamInfoCaptureTimer) {
            clearTimeout(this.teamInfoCaptureTimer)
        }

        this.teamInfoCapture = { header: null, balance: null, roles: {} }

        this.teamInfoCaptureTimer = setTimeout(
            () => this.finalizeTeamInfoCapture(),
            TEAM_INFO_TIMEOUT_MS
        )

        this.bot.chat('/t info')

        this.log('Requested /t info.')

    }

    tryParseTeamInfoLine(text, json) {

        if (!this.teamInfoCapture) return

        const headerMatch = text.match(/^(\S+)\s*\[(\d+)\/(\d+)\]\s*\|\s*Points:\s*(\d+)/)

        if (headerMatch) {

            this.teamInfoCapture.header = {
                name: headerMatch[1],
                current: Number(headerMatch[2]),
                max: Number(headerMatch[3]),
                points: Number(headerMatch[4])
            }

            return

        }

        const balanceMatch = text.match(/^Balance:\s*(.*)$/i)

        if (balanceMatch) {
            this.teamInfoCapture.balance = balanceMatch[1].trim()
            this.finalizeTeamInfoCapture()
            return
        }

        const labelMatch = text.match(/^([A-Za-z ]+):\s*(.*)$/)

        if (labelMatch && json) {

            const label = labelMatch[1].trim()
            const flat = flattenChatComponents(json)
            const members = []

            for (const leaf of flat) {

                const value = (leaf.text || '').trim()

                if (!value) continue
                if (value === `${label}:`) continue
                if (/^[[\],]+$/.test(value)) continue
                if (/^\d+$/.test(value)) continue

                members.push({ name: value, online: classifyMemberColor(leaf.color) })

            }

            this.teamInfoCapture.roles[label] = members

        }

    }

    // Watches for the server's "X has left the team." broadcast and
    // sends /t invite for anyone on the auto-reinvite list, so a
    // tracked teammate who gets kicked/leaves gets pulled back in
    // without anyone needing to be online to do it manually.
    checkAutoReinvite(text) {

        const match = text.match(/^TEAMS ➟ (.+?) has left the team\.?$/)

        if (!match) return

        const username = match[1].trim()
        const list = Array.isArray(this.config.autoReinvite) ? this.config.autoReinvite : []

        const tracked = list.some(entry => {
            const entryName = typeof entry === 'string' ? entry : (entry?.name || '')
            return entryName.toLowerCase() === username.toLowerCase()
        })

        if (!tracked) return

        this.log(`Auto-reinviting ${username} (left the team).`)

        this.sendMinecraftChat(`/t invite ${username}`)

        io.to(this.username).emit('notice', { type: 'success', text: `Auto-reinvited ${username}` })

    }

    // Keeps the Team card current without waiting for the next manual
    // refresh: any "X has joined/left the team" or "X has been
    // kicked" broadcast triggers a fresh /t info. The "kicked" wording
    // isn't confirmed against a live example, so this matches loosely
    // (with or without a trailing "from the team") rather than a
    // single exact phrase. Also covers KOTH captures ("<Name> KOTH
    // has been captured!" / "<player> has received 3x PvP Keys and
    // 25 Team Points!") - not anchored to a specific KOTH name since
    // there are several (Greek, Colosseum, Temple, CPvP, Agora, ...) -
    // and team deaths ("Your team has lost 5 points due to <player>'s
    // death.").
    checkTeamRosterChange(text) {

        const isRosterChange =
            /^TEAMS ➟ .+ has (joined|left) the team\.?$/i.test(text) ||
            /^TEAMS ➟ .+ has been kicked\b/i.test(text) ||
            /\bKOTH has been captured!?$/i.test(text) ||
            /\bhas received\b.*\bteam points\b/i.test(text) ||
            /\byour team has lost \d+ points? due to\b/i.test(text)

        if (!isRosterChange) return

        // A burst of these (e.g. several people leaving/getting
        // kicked at once) shouldn't each fire their own /t info -
        // one refresh a couple seconds later covers all of them.
        if (Date.now() - this.lastTeamRefreshRequestAt < 2000) return

        this.lastTeamRefreshRequestAt = Date.now()

        this.requestTeamInfo()

    }

    // True if `name` is a member of the team as of the last completed
    // /t info - used to keep the KOTH/death log and leaderboard scoped
    // to our own team, since the capture broadcast is server-wide and
    // would otherwise log players from every other team too.
    isTeamMember(name) {

        if (!this.teamRoster || !Array.isArray(this.teamRoster.members)) return false

        const lower = name.toLowerCase()

        return this.teamRoster.members.some(
            member => (member.name || '').toLowerCase() === lower
        )

    }

    // Clears one player's entries out of the KOTH/death history (and
    // therefore the leaderboard) - a manual cleanup tool for data
    // logged before isTeamMember filtering existed, or anything else
    // that shouldn't be there.
    removePlayerFromHistory(name) {

        const lower = name.trim().toLowerCase()

        if (!lower) return

        const beforeKoth = this.kothHistory.length
        const beforeDeath = this.deathHistory.length

        this.kothHistory = this.kothHistory.filter(entry => entry.player.toLowerCase() !== lower)
        this.deathHistory = this.deathHistory.filter(entry => entry.player.toLowerCase() !== lower)

        const removed = (beforeKoth - this.kothHistory.length) + (beforeDeath - this.deathHistory.length)

        saveKothHistory(this.username, this.kothHistory)
        saveDeathHistory(this.username, this.deathHistory)

        this.log(`Removed ${removed} history entr${removed === 1 ? 'y' : 'ies'} for ${name}`)

        io.to(this.username).emit('notice', {
            type: 'success',
            text: `Removed ${removed} history entr${removed === 1 ? 'y' : 'ies'} for ${name}`
        })

        this.updateDashboard()

    }

    // Wipes Points history, KOTH captures, and deaths entirely -
    // triggered from the Reset button on the Team card. The live
    // roster itself (teamRoster) is untouched since that's just the
    // current /t info snapshot, not accumulated history.
    resetTeamHistory() {

        this.teamHistory = []
        this.kothHistory = []
        this.deathHistory = []

        saveTeamHistory(this.username, this.teamHistory)
        saveKothHistory(this.username, this.kothHistory)
        saveDeathHistory(this.username, this.deathHistory)

        this.log('Team history reset (points, KOTH captures, deaths).')

        io.to(this.username).emit('notice', { type: 'success', text: 'Team history reset.' })

        this.updateDashboard()

    }

    // Logs who captured a KOTH and how many team points it was worth,
    // parsed from "<player> has received Nx PvP Keys and N Team
    // Points!" - shown as a history list alongside the Points detail
    // chart on the dashboard. Not anchored to a specific prefix since
    // the exact glyph/icon in front of the player name isn't known.
    // This broadcast is server-wide (any team's capture), so it's
    // filtered to our own roster before logging.
    checkKothCapture(text) {

        const match = cleanMessage(text).match(
            /([A-Za-z0-9_]{1,16}) has received \d+x PvP Keys and (\d+) Team Points!?/i
        )

        if (!match) return
        if (!this.isTeamMember(match[1])) return

        this.kothHistory.push({
            timestamp: Date.now(),
            player: match[1],
            points: Number(match[2])
        })

        this.kothHistory = this.kothHistory.slice(-50)

        saveKothHistory(this.username, this.kothHistory)

        this.log(`KOTH captured by ${match[1]} (+${match[2]} team points)`)

    }

    // Logs who died and how many points it cost the team, parsed from
    // "Your team has lost N points due to <player>'s death." - shown
    // merged with kothHistory in the Points detail modal. The "Your
    // team" wording implies this is already scoped server-side to the
    // affected team, but it's checked against the roster anyway for
    // consistency with checkKothCapture (and in case that assumption
    // is ever wrong).
    checkTeamDeath(text) {

        const match = cleanMessage(text).match(
            /your team has lost (\d+) points? due to ([A-Za-z0-9_]{1,16})'s death/i
        )

        if (!match) return
        if (!this.isTeamMember(match[2])) return

        this.deathHistory.push({
            timestamp: Date.now(),
            player: match[2],
            points: -Number(match[1])
        })

        this.deathHistory = this.deathHistory.slice(-50)

        saveDeathHistory(this.username, this.deathHistory)

        this.log(`${match[2]} died (-${match[1]} team points)`)

    }

    // Runs every dashboard tick (~1s) while connected. Any Auto-Invite
    // tracked player whose tab-list HP drops below 2.5 hearts (5 HP)
    // gets kicked off the team and immediately reinvited - kicking
    // drops them from `/t info` shared-location tracking before an
    // enemy can use it against them at low HP, and the reinvite
    // brings them straight back in once they're safe. `lowHpHandled`
    // stops this firing every tick while someone stays critical.
    //
    // HP comes from the tab-list scoreboard (display slot 0, exposed
    // by mineflayer as bot.scoreboard.list) - a real integer score
    // per player, not text. A displayName-parsing version of this
    // shipped first and never matched anything: a tablist-debug dump
    // showed the tab list's HP number isn't in the display name text
    // at all (just a colored bar + the name), confirming it's driven
    // by this separate scoreboard objective instead.
    checkAutoInviteLowHealth() {

        if (!this.bot || !this.bot.players) return

        const list = Array.isArray(this.config.autoReinvite) ? this.config.autoReinvite : []

        if (list.length === 0) return

        const trackedNames = list
            .map(entry => (typeof entry === 'string' ? entry : entry?.name) || '')
            .filter(Boolean)

        if (trackedNames.length === 0) return

        const listBoard = this.bot.scoreboard?.list

        if (!listBoard) return

        const onlineNames = Object.keys(this.bot.players)

        for (const trackedName of trackedNames) {

            const key = trackedName.toLowerCase()

            const actualName = onlineNames.find(name => name.toLowerCase() === key)

            if (!actualName) {
                this.lowHpHandled.delete(key)
                continue
            }

            const scoreEntry = listBoard.itemsMap?.[actualName]
            const hp = Number.isFinite(scoreEntry?.value) ? scoreEntry.value : null

            if (hp === null) continue

            if (hp >= 5) {
                this.lowHpHandled.delete(key)
                continue
            }

            if (this.lowHpHandled.has(key)) continue

            this.lowHpHandled.add(key)

            this.log(`${actualName} is at ${hp} HP - kicking and reinviting.`)

            this.sendMinecraftChat(`/t kick ${actualName}`)

            setTimeout(() => this.sendMinecraftChat(`/t invite ${actualName}`), 350)

            io.to(this.username).emit('notice', { type: 'info', text: `${actualName} dropped below 2.5 hearts - kicked and reinvited` })

        }

    }

    // The Black Market restock is a short-lived limited-quantity
    // event (server-side, roughly every 3 hours) - worth a Discord
    // ping since nobody's watching the dashboard 24/7.
    checkBlackMarket(text) {

        if (!/black market has now opened/i.test(text)) return

        this.log('Black Market opened - pinging Discord.')

        sendDiscordWebhook(
            this.config.discordWebhookUrl,
            'The Black Market has reset',
            this.config.discordRoleId
        )

        io.to(this.username).emit('notice', { type: 'info', text: '🛒 Black Market has opened - limited stock!' })

    }

    finalizeTeamInfoCapture() {

        if (!this.teamInfoCapture) return

        if (this.teamInfoCaptureTimer) {
            clearTimeout(this.teamInfoCaptureTimer)
            this.teamInfoCaptureTimer = null
        }

        const roles = this.teamInfoCapture.roles

        const members = Object.entries(roles).flatMap(
            ([role, roleMembers]) => roleMembers.map(member => ({ ...member, role }))
        )

        this.teamRoster = {
            header: this.teamInfoCapture.header,
            balance: this.teamInfoCapture.balance,
            roles,
            members,
            onlineCount: members.filter(member => member.online === true).length,
            totalCount: members.length,
            updatedAt: Date.now()
        }

        const points = this.teamRoster.header?.points

        if (Number.isFinite(points)) {

            const last = this.teamHistory[this.teamHistory.length - 1]
            const secondLast = this.teamHistory[this.teamHistory.length - 2]

            // Spamming refresh with nothing actually changing shouldn't
            // pile up a flat line of identical readings - once the two
            // most recent readings already match this one, drop the
            // last before adding this one so at most 2 in a row of the
            // same value ever sit in the history. A real change still
            // always gets its own entry.
            if (last && secondLast && last.points === points && secondLast.points === points) {
                this.teamHistory.pop()
            }

            this.teamHistory.push({
                timestamp: Date.now(),
                points
            })

            this.teamHistory = this.teamHistory.slice(-TEAM_HISTORY_MAX_ENTRIES)

            saveTeamHistory(this.username, this.teamHistory)

        }

        this.teamInfoCapture = null

        this.log(`Team info updated: ${this.teamRoster.onlineCount}/${this.teamRoster.totalCount} online.`)

        this.showTeamInfo()

        this.updateDashboard()

    }

    showTeamInfo() {

        if (!this.teamRoster) {
            originalLog('No team info yet. Run /team to request it.')
            return
        }

        originalLog('')
        originalLog('========== TEAM INFO ==========')

        if (this.teamRoster.header) {
            originalLog(`${this.teamRoster.header.name} [${this.teamRoster.header.current}/${this.teamRoster.header.max}] | Points: ${this.teamRoster.header.points}`)
        }

        for (const [role, members] of Object.entries(this.teamRoster.roles)) {

            originalLog(`${role}:`)

            for (const member of members) {

                const status = member.online === true ? 'ONLINE' : member.online === false ? 'offline' : 'unknown'

                originalLog(`  - ${member.name} (${status})`)

            }

        }

        originalLog(`Online: ${this.teamRoster.onlineCount}/${this.teamRoster.totalCount}`)
        originalLog('================================')
        originalLog('')

    }

    // --------------------------------------------------------
    // KEYALL (23:05 Brussels Time, gated behind lifestealAutopilot)
    // --------------------------------------------------------

    claimDiamondKey() {

        if (this.shuttingDown) return

        const today = getEasternDateString()

        if (this.lastKeyClaimDate === today) {
            this.log(`Diamond key already claimed for ${today}.`)
            return
        }

        if (!this.bot || !this.bot.entity) {
            originalLog(`[KEYALL:${this.username}] Bot is offline.`)
            this.log('Keyall skipped because bot was offline.')
            return
        }

        this.bot.chat('/keys use diamond')

        this.lastKeyClaimDate = today

        originalLog(`[KEYALL:${this.username}] Sent /keys use diamond at 23:05 Brussels Time (${today}).`)

        this.log(`Sent /keys use diamond for ${today}.`)

    }

    scheduleNextKeyall() {

        this.stopKeyallTimer()

        this.nextKeyallAt = null

        if (this.shuttingDown) return
        if (!this.config.lifestealAutopilot) return

        const delay = getMillisecondsUntilNextEasternTime(KEYALL_TIMEZONE, KEYALL_HOUR, KEYALL_MINUTE)
        const nextMinutes = Math.max(1, Math.round(delay / 60000))

        originalLog(`[KEYALL:${this.username}] Next claim in approximately ${nextMinutes} minutes.`)

        this.nextKeyallAt = Date.now() + delay

        this.keyallTimer = setTimeout(() => {
            this.keyallTimer = null
            this.nextKeyallAt = null
            this.claimDiamondKey()
            this.scheduleNextKeyall()
        }, delay)

    }

    // --------------------------------------------------------
    // JQ SAFETY CHECK (07:04 ET, gated behind lifestealAutopilot)
    // --------------------------------------------------------

    runJqSafetyCheck() {

        if (this.shuttingDown) return

        if (!this.bot || !this.bot.entity) {
            originalLog(`[JQ SAFETY:${this.username}] Bot is offline, skipping safety check.`)
            this.log('JQ safety check skipped: bot offline.')
            return
        }

        if (this.lifeStealReached) {
            this.log('JQ safety check: already on LifeSteal, nothing to do.')
            return
        }

        originalLog(`[JQ SAFETY:${this.username}] Not on LifeSteal at ${JQ_SAFETY_HOUR}:${String(JQ_SAFETY_MINUTE).padStart(2, '0')} Brussels Time. Resending /jq LifeSteal.`)

        this.log('JQ safety check triggered: bot not on LifeSteal, restarting retry/recovery loop.')

        this.startJqRetry()
        this.startHubRecovery()

    }

    scheduleNextJqSafety() {

        this.stopJqSafetyTimer()

        if (this.shuttingDown) return
        if (!this.config.lifestealAutopilot) return

        const delay = getMillisecondsUntilNextEasternTime(JQ_SAFETY_TIMEZONE, JQ_SAFETY_HOUR, JQ_SAFETY_MINUTE)
        const nextMinutes = Math.max(1, Math.round(delay / 60000))

        originalLog(`[JQ SAFETY:${this.username}] Next safety check in approximately ${nextMinutes} minutes.`)

        this.jqSafetyTimer = setTimeout(() => {
            this.jqSafetyTimer = null
            this.runJqSafetyCheck()
            this.scheduleNextJqSafety()
        }, delay)

    }

    // --------------------------------------------------------
    // CONNECT
    // --------------------------------------------------------

    connect() {

        if (this.shuttingDown) return
        if (!this.botEnabled) return

        this.lifeStealReached = false
        this.recoveryRunning = false

        this.stopJqRetry()
        this.stopHomeTimer()
        this.stopRecoveryTimer()

        this.currentWorld = 'Unknown'
        this.setState('CONNECTING')

        this.log(`Connecting to ${this.config.host}:${this.config.port}...`)

        originalLog(`[${new Date().toLocaleString()}] [${this.username}] Connecting to ${this.config.host}:${this.config.port}...`)

        const profilesFolder = path.join(AUTH_CACHE_DIR, this.username)
        fs.mkdirSync(profilesFolder, { recursive: true })

        this.bot = mineflayer.createBot({

            host: this.config.host,
            port: this.config.port,
            username: this.config.microsoftEmail,
            auth: 'microsoft',
            version: this.config.version || false,
            profilesFolder,

            // Fires the first time this Microsoft account needs to
            // sign in. Relay the code to that account's own browser
            // instead of printing it to the shared server console.
            onMsaCode: data => {

                io.to(this.username).emit('msaCode', {
                    verificationUri: data.verification_uri,
                    userCode: data.user_code,
                    message: data.message
                })

                originalLog(`[MSA:${this.username}] ${data.message}`)

                this.log(`Microsoft sign-in required: ${data.message}`)

            }

        })

        this.lastInventoryTouchedAt = 0

        // ----------------------------------------------------
        // LOGIN
        // ----------------------------------------------------

        this.bot.once('login', () => {
            this.setState('LOGGED IN')
            this.log('Minecraft login successful.')
        })

        // ----------------------------------------------------
        // CHAT
        // ----------------------------------------------------

        this.bot.on('chat', (username, message) => {

            originalLog(`[CHAT:${this.username}] <${username}> ${message}`)

            this.log(`[CHAT] <${username}> ${message}`)

            // mineflayer's 'chat' event is a legacy regex match on
            // message text and can fire for non-player text that
            // happens to look like "Name: message". Only broadcast
            // it as player chat if it's actually a known player -
            // real system/alert text is handled separately below
            // and would otherwise get broadcast twice.
            if (this.bot.players && this.bot.players[username]) {
                this.broadcastChat(username, message)
            }

            if (this.config.lifestealAutopilot && containsLifeSteal(message)) {
                this.reachedLifeSteal('chat')
            }

        })

        // ----------------------------------------------------
        // ALL MESSAGES
        // ----------------------------------------------------

        this.bot.on('message', (message, position) => {

            const text = message.toString()

            if (!text.trim()) return

            this.tryParseTeamInfoLine(text, message.json)
            this.checkAutoReinvite(text)
            this.checkTeamRosterChange(text)
            this.checkKothCapture(text)
            this.checkTeamDeath(text)
            this.checkBlackMarket(text)

            // Player chat (position 'chat') is already broadcast by
            // the 'chat' event above, which knows the real username -
            // broadcasting it again here would duplicate it. This
            // covers system messages and join/leave/announcements.
            // Action bar text ('game_info') is intentionally skipped -
            // it's HUD text, not chat, and refreshes far too often to
            // show in a chat feed.
            if (position !== 'chat' && position !== 'game_info') {

                const dedupeKey = `${position}:${text}`

                if (dedupeKey !== this.lastServerMessageKey) {

                    this.lastServerMessageKey = dedupeKey

                    const username = 'SERVER'

                    this.lastChatMessage = text
                    this.lastChatTime = new Date().toLocaleTimeString()

                    io.to(this.username).emit('chat', { username, message: text, time: this.lastChatTime })

                    this.log(`[${username}] ${text}`)

                }

            }

            if (this.config.lifestealAutopilot && containsLifeSteal(text)) {
                this.reachedLifeSteal(`message:${position}`)
            }

            if (this.config.lifestealAutopilot && isLifeStealConnectFailure(text)) {

                this.log('LifeSteal transfer failed ("unable to connect"), retrying.')

                originalLog(`[LS:${this.username}] Transfer to LifeSteal failed, retrying.`)

                this.lifeStealReached = false
                this.recoveryRunning = false

                this.stopHomeTimer()

                this.currentWorld = 'Hub'
                this.setState('HUB')

                this.startJqRetry()
                this.startHubRecovery()

            }

            if (isProxySessionProblem(text)) {
                this.proxySessionProblem = true
                this.log('Proxy session problem detected.')
                this.updateDashboard()
            }

        })

        // ----------------------------------------------------
        // SPAWN
        // ----------------------------------------------------

        this.bot.once('spawn', () => {

            this.connectedAt = Date.now()
            this.proxySessionProblem = false
            this.reconnectDelay = RECONNECT_DELAY

            // Minecraft sends inventory changes as individual per-slot
            // packets, not one atomic update - after claiming a lot of
            // items at once, a burst of these can still be arriving
            // when the dashboard's 1s tick reads bot.inventory,
            // catching it mid-update (some slots changed, others not
            // yet). Track the last time anything changed so
            // getInventorySnapshot/getKeyAmounts can tell a settled
            // inventory from a still-changing one. bot.inventory isn't
            // ready synchronously right after createBot() with
            // version auto-detect, so this waits for spawn.
            if (this.bot.inventory) {
                this.bot.inventory.on('updateSlot', () => {
                    this.lastInventoryTouchedAt = Date.now()
                })
            }

            this.handleSpawnState()

            this.log(`Spawned. State: ${this.botState}`)

            this.updateDashboard()

            if (this.config.lifestealAutopilot && this.botState === 'HUB') {

                setTimeout(() => {

                    if (!this.bot || !this.bot.entity || this.shuttingDown) return
                    if (this.lifeStealReached) return

                    this.startJqRetry()
                    this.startHubRecovery()

                }, FIRST_JQ_DELAY)

            }

        })

        // ----------------------------------------------------
        // RESOURCE PACK
        // ----------------------------------------------------

        this.bot.on('resourcePack', () => {

            try {
                this.bot.acceptResourcePack()
                this.log('Accepted resource pack.')
            } catch (error) {
                this.log(`Resource pack error: ${error.message}`)
            }

        })

        // ----------------------------------------------------
        // KICK
        // ----------------------------------------------------

        this.bot.on('kicked', reason => {

            const reasonText = cleanMessage(JSON.stringify(reason))

            this.lastDisconnectReason = reasonText

            if (isProxySessionProblem(reasonText)) {
                this.proxySessionProblem = true
                originalLog(`[KICKED:${this.username}] Proxy still thinks the account is connected.`)
            } else {
                originalLog(`[KICKED:${this.username}] ${reasonText}`)
            }

            this.log(`Kicked: ${reasonText}`)

            this.updateDashboard()

        })

        // ----------------------------------------------------
        // ERROR
        // ----------------------------------------------------

        this.bot.on('error', error => {

            this.log(`Error: ${error.message}`)

            originalError(`[ERROR:${this.username}] ${error.message}`)

            this.updateDashboard()

        })

        // ----------------------------------------------------
        // END / RECONNECT
        // ----------------------------------------------------

        this.bot.on('end', reason => {

            this.lastDisconnectReason = reason || 'Unknown reason'

            this.stopJqRetry()
            this.stopHomeTimer()
            this.stopRecoveryTimer()

            this.bot = null
            this.connectedAt = null
            this.currentWorld = 'Disconnected'

            this.setState('OFFLINE')

            this.recoveryRunning = false

            this.updateDashboard()

            if (this.shuttingDown) return
            if (!this.botEnabled) return
            if (this.reconnectTimer) return

            this.reconnectCount++

            if (this.proxySessionProblem) {

                originalLog('')
                originalLog(`[RECONNECT:${this.username}] Proxy still has old session.`)

                const delay = this.reconnectDelay

                originalLog(`[RECONNECT:${this.username}] Waiting ${Math.round(delay / 1000)} seconds...`)

                this.log(`Proxy session problem. Waiting ${delay}ms.`)

                this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY)

                this.reconnectTimer = setTimeout(() => {
                    this.reconnectTimer = null
                    this.connect()
                }, delay)

            } else {

                this.reconnectDelay = RECONNECT_DELAY

                originalLog(`[${this.username}] Disconnected. Reconnecting in ${RECONNECT_DELAY / 1000} seconds...`)

                this.reconnectTimer = setTimeout(() => {
                    this.reconnectTimer = null
                    this.connect()
                }, RECONNECT_DELAY)

            }

        })

    }

    // --------------------------------------------------------
    // STOP (full stop, used on server shutdown)
    // --------------------------------------------------------

    stop() {

        if (this.shuttingDown) return

        this.shuttingDown = true

        this.setState('STOPPING')

        this.stopJqRetry()
        this.stopHomeTimer()
        this.stopRecoveryTimer()
        this.stopKeyallTimer()
        this.stopJqSafetyTimer()

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }

        if (this.bot) {
            try { this.bot.quit('Bot manually stopped') } catch {}
        }

    }

}

// ============================================================
// SESSION REGISTRY
// ============================================================

const sessions = new Map()

function getOrCreateSession(username) {

    let botSession = sessions.get(username)

    if (botSession) {
        return botSession
    }

    const config = getBotConfig(username)

    if (!config) {
        return null
    }

    botSession = new BotSession(username, config)

    sessions.set(username, botSession)

    return botSession

}

function getAdminSession() {
    return getOrCreateSession(DASHBOARD_USERNAME)
}

// Finds another account's bot that's already using the same
// Microsoft email and currently trying to be connected. Starting
// a second bot on the same Microsoft account would just make the
// server's proxy reject the newer one as "already connected" -
// catch it here with a clear message instead of that confusing
// reconnect-loop failure.
function findConflictingSession(username, microsoftEmail) {

    const normalized = String(microsoftEmail || '').toLowerCase()

    if (!normalized) {
        return null
    }

    for (const [otherUsername, otherSession] of sessions.entries()) {

        if (otherUsername === username) continue
        if (String(otherSession.config.microsoftEmail || '').toLowerCase() !== normalized) continue

        const isActive = otherSession.botState !== 'OFFLINE' && otherSession.botState !== 'STOPPED'

        if (isActive) {
            return otherSession
        }

    }

    return null

}

function getPlaceholderDashboardData() {

    return {
        configured: false,
        online: false,
        botEnabled: false,
        state: 'NOT CONFIGURED',
        world: 'Unknown',
        server: '-',
        version: '-',
        uptime: 'Not connected',
        reconnects: 0,
        reconnectDelay: 0,
        lifeSteal: false,
        lifestealAutopilot: false,
        jqRetrying: false,
        recoveryTimer: false,
        proxyProblem: false,
        health: null,
        maxHealth: null,
        food: null,
        ping: null,
        players: [],
        playerCount: 0,
        keys: { vote: 0, exclusive: 0, insane: 0 },
        totalKeys: 0,
        lastChat: 'None',
        lastChatTime: null,
        lastDisconnect: 'None',
        connectedAt: null,
        inventory: [],
        team: null,
        timestamp: Date.now()
    }

}

// ============================================================
// WEB COMMAND HANDLER (one user's socket -> that user's own bot)
// ============================================================

function handleWebCommand(username, command) {

    if (!command) return

    const lower = command.toLowerCase()

    if (lower === 'start-bot') {

        const config = getBotConfig(username)

        if (!config) {
            io.to(username).emit('notice', { type: 'error', text: 'Set up your Microsoft account and server in Settings first.' })
            return
        }

        const conflict = findConflictingSession(username, config.microsoftEmail)

        if (conflict) {
            io.to(username).emit('notice', {
                type: 'error',
                text: `That Microsoft account is already connected under another Voidz.IO account (${conflict.username}). Stop it there first, or use a different Microsoft account.`
            })
            return
        }

        getOrCreateSession(username).startBotRemote()

        return

    }

    const botSession = sessions.get(username)

    if (!botSession) {
        io.to(username).emit('notice', { type: 'error', text: 'Start your bot first.' })
        return
    }

    switch (lower) {

        case 'status': botSession.showStatus(); break
        case 'uptime': botSession.showUptime(); break
        case 'ping': botSession.showPing(); break
        case 'health': botSession.showHealth(); break
        case 'players': botSession.showPlayers(); break
        case 'playerslist': botSession.showPlayersList(); break
        case 'tablist-debug': botSession.debugTabList(); break
        case 'bm-debug': botSession.debugNextWindow(); break
        case 'where': botSession.showWhere(); break
        case 'lastchat': botSession.showLastChat(); break
        case 'keysamount': botSession.showKeysAmount(); break
        case 'team': botSession.requestTeamInfo(); break
        case 'ls': botSession.manualLifeSteal(); break
        case 'hub': botSession.goHub(); break
        case 'afk': botSession.goAfk(); break
        case 'recover': botSession.manualRecovery(); break
        case 'rejoin': botSession.manualRejoin(); break
        case 'reset-team-history': botSession.resetTeamHistory(); break
        case 'stop-bot': botSession.stopBotRemote(); break

        default:

            if (lower.startsWith('say ')) {
                botSession.sendMinecraftChat(command.substring(4))
            } else if (lower.startsWith('reset-player ')) {
                botSession.removePlayerFromHistory(command.substring('reset-player '.length))
            }

            break

    }

}

// ============================================================
// LOGIN / SIGNUP / LOGOUT ROUTES (not protected)
// ============================================================

app.get('/login', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'login.html'))
})

app.get('/signup', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'signup.html'))
})

// Served before the auth gate below so it loads on /login and
// /signup too, not just once you're already signed in.
app.get('/favicon.svg', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'favicon.svg'))
})

app.post('/login', (req, res) => {

    const { username, password } = req.body || {}

    if (username === DASHBOARD_USERNAME && password === DASHBOARD_PASSWORD) {

        req.session.loggedIn = true
        req.session.username = username

        appLog(`Dashboard login: ${username}`)

        return res.json({ ok: true })

    }

    const users = loadUsers()
    const user = findUser(users, username)

    if (user && verifyPassword(password || '', user.salt, user.hash)) {

        req.session.loggedIn = true
        req.session.username = user.username

        appLog(`Dashboard login: ${user.username}`)

        return res.json({ ok: true })

    }

    appLog(`Failed dashboard login attempt: ${username || '(empty)'}`)

    return res.status(401).json({ error: 'Invalid username or password' })

})

app.post('/signup', (req, res) => {

    const { username, password } = req.body || {}

    if (!username || !USERNAME_PATTERN.test(username)) {
        return res.status(400).json({ error: 'Username must be 3-20 characters: letters, numbers, underscores only.' })
    }

    if (!password || password.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` })
    }

    if (username.toLowerCase() === DASHBOARD_USERNAME.toLowerCase()) {
        return res.status(409).json({ error: 'That username is reserved.' })
    }

    const users = loadUsers()

    if (findUser(users, username)) {
        return res.status(409).json({ error: 'That username is already taken.' })
    }

    const { salt, hash } = hashPassword(password)

    users.push({
        username,
        salt,
        hash,
        createdAt: new Date().toISOString()
    })

    saveUsers(users)

    req.session.loggedIn = true
    req.session.username = username

    appLog(`New account created: ${username}`)

    return res.json({ ok: true })

})

app.post('/logout', (req, res) => {

    const username = req.session?.username || '(unknown)'

    req.session.destroy(() => {
        res.clearCookie('connect.sid')
        appLog(`Dashboard logout: ${username}`)
        res.json({ ok: true })
    })

})

// ============================================================
// EVERYTHING BELOW THIS LINE REQUIRES LOGIN
// ============================================================

app.use(requireAuth)
app.use(express.static(PUBLIC_DIR))

app.get('/', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'))
})

// ============================================================
// API
// ============================================================

app.get('/api/status', (req, res) => {
    const botSession = sessions.get(req.session.username)
    res.json(botSession ? botSession.getDashboardData() : getPlaceholderDashboardData())
})

app.get('/api/session', (req, res) => {
    res.json({ username: req.session?.username || null })
})

app.get('/api/bot-config', (req, res) => {
    const config = getBotConfig(req.session.username)
    res.json(config || { microsoftEmail: '', host: '', port: 25565, version: '', lifestealAutopilot: false })
})

app.post('/api/bot-config', (req, res) => {

    const config = normalizeBotConfig(req.body)
    const error = validateBotConfig(config)

    if (error) {
        return res.status(400).json({ error })
    }

    saveBotConfig(req.session.username, config)

    const existing = sessions.get(req.session.username)

    if (existing) {
        existing.config = { ...existing.config, ...config }
    }

    appLog(`Bot config saved: ${req.session.username}`)

    res.json({ ok: true })

})

app.get('/api/auto-reinvite', (req, res) => {
    res.json({ list: getAutoReinviteList(req.session.username) })
})

app.post('/api/auto-reinvite', (req, res) => {

    const raw = Array.isArray(req.body?.list) ? req.body.list : []

    const seenNames = new Set()
    const list = []

    for (const entry of raw) {

        const name = String((typeof entry === 'string' ? entry : entry?.name) || '').trim()

        if (!name) continue

        const key = name.toLowerCase()

        if (seenNames.has(key)) continue

        seenNames.add(key)

        const lastSeen = (typeof entry === 'object' && Number.isFinite(entry?.lastSeen)) ? entry.lastSeen : null

        list.push({ name, lastSeen })

    }

    saveAutoReinviteList(req.session.username, list)

    const existing = sessions.get(req.session.username)

    if (existing) {
        existing.config.autoReinvite = list
    }

    res.json({ ok: true, list })

})

app.get('/api/preferences', (req, res) => {
    res.json(getPreferences(req.session.username))
})

app.post('/api/preferences', (req, res) => {

    const body = req.body || {}
    const partial = {}

    for (const key of PREFERENCE_KEYS) {

        if (!(key in body)) continue

        if (key === 'threats' || key === 'allies') {

            partial[key] = Array.isArray(body[key])
                ? body[key].filter(entry => entry && typeof entry.name === 'string')
                : []

        } else if (key === 'reduceMotion' || key === 'compactMode') {

            partial[key] = !!body[key]

        } else if (key === 'alertVolume') {

            const volume = Number(body[key])
            partial[key] = Number.isFinite(volume) ? Math.max(0, Math.min(100, volume)) : 70

        } else {

            partial[key] = body[key] ? String(body[key]) : null

        }

    }

    savePreferences(req.session.username, partial)

    const existing = sessions.get(req.session.username)

    if (existing) {
        existing.config = { ...existing.config, ...partial }
    }

    res.json({ ok: true })

})

// ============================================================
// ACCOUNT (password reset)
// ============================================================
// Not available for the env-based admin login - its credentials
// live in .env, not in users.json.
// ============================================================

app.get('/api/account', (req, res) => {
    res.json({ isAdmin: req.session.username === DASHBOARD_USERNAME })
})

app.post('/api/account/password', (req, res) => {

    if (req.session.username === DASHBOARD_USERNAME) {
        return res.status(400).json({ error: 'The admin password is set via DASHBOARD_PASSWORD in .env, not here.' })
    }

    const { currentPassword, newPassword } = req.body || {}

    if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.` })
    }

    const users = loadUsers()
    const user = findUser(users, req.session.username)

    if (!user || !verifyPassword(currentPassword || '', user.salt, user.hash)) {
        return res.status(401).json({ error: 'Current password is incorrect.' })
    }

    const { salt, hash } = hashPassword(newPassword)

    updateUser(req.session.username, { salt, hash })

    appLog(`Password changed: ${req.session.username}`)

    res.json({ ok: true })

})

// Hitting this (the dashboard does, every few minutes) keeps a
// logged-in session alive by resetting the 30 minute timer.
app.get('/api/keepalive', (req, res) => {
    res.json({ ok: true })
})

// ============================================================
// REAL-TIME DASHBOARD UPDATE (every connected user's own bot)
// ============================================================

setInterval(() => {
    for (const botSession of sessions.values()) {
        botSession.updateDashboard()
        botSession.checkAutoInviteLowHealth()
    }
}, 1000)

// ============================================================
// SOCKET.IO
// ============================================================

io.on('connection', socket => {

    const webSession = socket.request.session

    if (!webSession || !webSession.loggedIn) {
        originalLog('[WEB] Rejected unauthenticated socket connection.')
        socket.disconnect(true)
        return
    }

    const username = webSession.username

    // Every account only ever receives its own bot's events.
    socket.join(username)

    originalLog(`[WEB] Dashboard connected: ${username}`)

    const botSession = sessions.get(username)

    socket.emit('status', botSession ? botSession.getDashboardData() : getPlaceholderDashboardData())

    socket.on('command', command => {

        if (typeof command !== 'string') return

        handleWebCommand(username, command.trim())

    })

    socket.on('chat', message => {

        if (typeof message !== 'string') return

        const activeSession = sessions.get(username)

        if (!activeSession) {
            socket.emit('notice', { type: 'error', text: 'Start your bot first.' })
            return
        }

        activeSession.sendMinecraftChat(message.trim())

    })

    socket.on('move', payload => {

        if (!payload || typeof payload.direction !== 'string') return

        const activeSession = sessions.get(username)

        if (!activeSession) return

        activeSession.setMovement(payload.direction, !!payload.active)

    })

    socket.on('disconnect', () => {

        originalLog(`[WEB] Dashboard disconnected: ${username}`)

        // If this was the tab holding a direction down, don't leave
        // the bot walking forever with nobody there to release it.
        sessions.get(username)?.stopAllMovement()

    })

})

// ============================================================
// TERMINAL
// ============================================================
// The local server console controls the admin account's bot -
// it's a convenience console for whoever is running the process,
// not a picker across every hosted bot.
// ============================================================

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> '
})

function showHelp() {

    originalLog('')
    originalLog('========== VOIDZ.IO COMMANDS ==========')
    originalLog('/status')
    originalLog('/uptime')
    originalLog('/ping')
    originalLog('/health')
    originalLog('/players')
    originalLog('/playerslist')
    originalLog('/where')
    originalLog('/lastchat')
    originalLog('/keysamount')
    originalLog('/team')
    originalLog('/ls')
    originalLog('/hub')
    originalLog('/afk')
    originalLog('/recover')
    originalLog('/rejoin')
    originalLog('/say <text>')
    originalLog('/help')
    originalLog('/stopbot')
    originalLog('========================================')
    originalLog('')

}

rl.on('line', input => {

    const message = input.trim()

    if (!message) {
        rl.prompt()
        return
    }

    const adminSession = getAdminSession()

    switch (message.toLowerCase()) {

        case '/status': adminSession.showStatus(); break
        case '/uptime': adminSession.showUptime(); break
        case '/ping': adminSession.showPing(); break
        case '/health': adminSession.showHealth(); break
        case '/players': adminSession.showPlayers(); break
        case '/playerslist': adminSession.showPlayersList(); break
        case '/where': adminSession.showWhere(); break
        case '/lastchat': adminSession.showLastChat(); break
        case '/keysamount': adminSession.showKeysAmount(); break
        case '/team': adminSession.requestTeamInfo(); break
        case '/ls': adminSession.manualLifeSteal(); break
        case '/hub': adminSession.goHub(); break
        case '/afk': adminSession.goAfk(); break
        case '/recover': adminSession.manualRecovery(); break
        case '/rejoin': adminSession.manualRejoin(); break
        case '/help': showHelp(); break

        case '/stopbot':
            shutdownServer()
            return

        default:

            if (message.toLowerCase().startsWith('/say ')) {
                adminSession.sendMinecraftChat(message.substring(5))
            } else {
                adminSession.sendMinecraftChat(message)
            }

            break

    }

    rl.prompt()

})

// ============================================================
// SHUTDOWN
// ============================================================

function shutdownServer() {

    originalLog('')
    originalLog('Shutting down Voidz.IO server...')

    for (const botSession of sessions.values()) {
        botSession.stop()
    }

    rl.close()

    setTimeout(() => { process.exit(0) }, 1000)

}

process.on('SIGINT', () => { shutdownServer() })

// ============================================================
// CRASH PROTECTION
// ============================================================

process.on('uncaughtException', error => {

    appLog(`UNCAUGHT EXCEPTION: ${error.stack || error.message}`)

    originalError('[CRASH PROTECTION]', error.message)

})

process.on('unhandledRejection', reason => {

    appLog(`UNHANDLED REJECTION: ${reason instanceof Error ? reason.stack : String(reason)}`)

    originalError('[WARNING] Unhandled promise rejection:', reason)

})

// ============================================================
// STARTUP BANNER
// ============================================================

function showBanner() {

    originalLog('')
    originalLog('╔══════════════════════════════════════════╗')
    originalLog('║                VOIDZ.IO                  ║')
    originalLog('║        Multi-Bot Dashboard Server        ║')
    originalLog('╚══════════════════════════════════════════╝')
    originalLog('')
    originalLog(`Dashboard: http://localhost:${WEB_PORT}`)
    originalLog('')
    originalLog("Terminal commands control the admin account's bot:")
    originalLog('  /status  /uptime  /ping  /health')
    originalLog('  /players  /playerslist  /where  /lastchat')
    originalLog('  /keysamount  /team  /ls  /hub  /afk')
    originalLog('  /recover  /rejoin  /say <message>')
    originalLog('  /help  /stopbot')
    originalLog('')

    appLog('Voidz.IO server started.')

}

// ============================================================
// START
// ============================================================

ensureAdminBotConfigSeeded()

showBanner()

const adminSession = getAdminSession()

adminSession.scheduleNextKeyall()
adminSession.scheduleNextJqSafety()
adminSession.connect()

server.listen(WEB_PORT, () => {

    originalLog('')
    originalLog('========================================')
    originalLog('       VOIDZ.IO WEB DASHBOARD')
    originalLog('========================================')
    originalLog(`Dashboard: http://localhost:${WEB_PORT}`)
    originalLog('Realtime Socket.IO: ENABLED')
    originalLog('========================================')
    originalLog('')

    appLog(`Web dashboard started on port ${WEB_PORT}.`)

})

rl.prompt()
