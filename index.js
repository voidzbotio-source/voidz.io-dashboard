'use strict'

// ============================================================
// VOIDZ.IO - MULTI-BOT MINECRAFT DASHBOARD SERVER
// ============================================================
// Each dashboard account connects its OWN Microsoft account to
// its OWN target server. Every account gets its own BotSession
// instance (see below), running concurrently in this process.
// ============================================================

const mineflayer = require('mineflayer')

// prismarine-viewer pulls in `canvas`, a native module - if its
// prebuilt binary doesn't match whatever machine this runs on, this
// require throws. That's a real risk on a different OS/arch than
// this was developed on, and since this is a top-level require, an
// uncaught failure here would take the ENTIRE dashboard down with
// it, not just the POV feature. Caught and logged instead - see
// startPovViewer(), which just no-ops if this came back null.
let prismarineViewer = null
try {
    prismarineViewer = require('prismarine-viewer').mineflayer
} catch (error) {
    console.error(`[STARTUP] POV viewer (prismarine-viewer) failed to load - the "Bot POV" feature will be unavailable, everything else is unaffected: ${error.message}`)
}

const bedrock = require('bedrock-protocol')
const { SocksClient } = require('socks')
const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const fs = require('fs')
const readline = require('readline')
const path = require('path')
const net = require('net')
const session = require('express-session')
const crypto = require('crypto')
const QRCode = require('qrcode')
const nodemailer = require('nodemailer')

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

// Refuse to start with the shipped placeholder credentials/secret. Left
// at their defaults, anyone could log in as admin (changeme) and - with
// the publicly-known SESSION_SECRET - forge their own valid session
// cookies without logging in at all. A misdeployed-without-.env instance
// must fail loudly, not silently run wide open. Set ALLOW_INSECURE_DEFAULTS=true
// only for throwaway local testing.
if (process.env.ALLOW_INSECURE_DEFAULTS !== 'true') {

    const insecure = []

    if (DASHBOARD_PASSWORD === 'changeme') insecure.push('DASHBOARD_PASSWORD is still "changeme"')
    if (SESSION_SECRET === 'please-change-this-session-secret') insecure.push('SESSION_SECRET is still the shipped placeholder')

    if (insecure.length > 0) {
        console.error('\n[FATAL] Refusing to start with insecure default credentials:')
        for (const problem of insecure) console.error(`  - ${problem}`)
        console.error('\nSet real values in your .env file (see .env.example), or set')
        console.error('ALLOW_INSECURE_DEFAULTS=true for throwaway local testing only.\n')
        process.exit(1)
    }

}

// ============================================================
// OUTGOING EMAIL (for 2FA recovery codes)
// ============================================================
// Optional - only needed for the "email me a login code" recovery path.
// Defaults target Gmail; the user supplies a Gmail address + an app
// password (NOT their normal password) in .env. With nothing configured,
// email recovery is simply unavailable and the UI says so.
const SMTP_USER = process.env.SMTP_USER || ''
const SMTP_PASS = process.env.SMTP_PASS || ''
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com'
const SMTP_PORT = Number(process.env.SMTP_PORT) || 465
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER
const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME || 'Voidz.IO'

let mailTransport = null

function mailConfigured() {
    return !!(SMTP_USER && SMTP_PASS)
}

function getMailTransport() {
    if (!mailConfigured()) return null
    if (!mailTransport) {
        mailTransport = nodemailer.createTransport({
            host: SMTP_HOST,
            port: SMTP_PORT,
            secure: SMTP_PORT === 465,
            auth: { user: SMTP_USER, pass: SMTP_PASS }
        })
    }
    return mailTransport
}

async function sendMail(to, subject, text, html) {
    const transport = getMailTransport()
    if (!transport) throw new Error('Email is not configured on this server.')
    // A display-name "From", a real subject, and a text + HTML pair all
    // help these land in the inbox rather than spam (a bare code-only
    // plain-text message from an unnamed sender is a classic spam signal).
    const message = { from: `"${SMTP_FROM_NAME}" <${SMTP_FROM}>`, to, subject, text }
    if (html) message.html = html
    await transport.sendMail(message)
}

// Clean, email-client-safe HTML for the one-code messages (verification
// and login recovery). Table layout + inline styles for compatibility;
// light theme so it reads fine everywhere. `code` is always server-made
// digits and the rest is static copy, so no untrusted interpolation.
function buildCodeEmailHtml({ heading, intro, code, note }) {
    return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f4f4f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e5e6eb;">
        <tr><td style="background:#6366f1;padding:20px 28px;">
          <span style="color:#ffffff;font-size:20px;font-weight:bold;letter-spacing:-0.3px;">Voidz.IO</span>
        </td></tr>
        <tr><td style="padding:28px;">
          <h1 style="margin:0 0 10px;font-size:18px;color:#14151a;">${heading}</h1>
          <p style="margin:0 0 20px;font-size:14px;line-height:1.5;color:#55566a;">${intro}</p>
          <div style="text-align:center;background:#f4f4f7;border:1px solid #e5e6eb;border-radius:12px;padding:18px;margin:0 0 18px;">
            <span style="font-family:'Courier New',monospace;font-size:30px;font-weight:bold;letter-spacing:8px;color:#14151a;">${code}</span>
          </div>
          <p style="margin:0;font-size:13px;line-height:1.5;color:#8b8d98;">${note}</p>
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid #eeeef2;">
          <p style="margin:0;font-size:12px;line-height:1.5;color:#9a9ca8;">If you didn't try to sign in, you can safely ignore this email &mdash; nothing happens without this code.</p>
        </td></tr>
      </table>
      <p style="max-width:460px;margin:16px auto 0;font-size:11px;color:#b0b2bd;text-align:center;">Voidz.IO Dashboard &middot; automated security email</p>
    </td></tr>
  </table>
</body>
</html>`
}

// Security-alert email (new login from an untrusted device). `when` and
// `ip` are server-generated; no untrusted interpolation.
function buildAlertEmailHtml(when, ip) {
    return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f4f4f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e5e6eb;">
        <tr><td style="background:#6366f1;padding:20px 28px;">
          <span style="color:#ffffff;font-size:20px;font-weight:bold;letter-spacing:-0.3px;">Voidz.IO</span>
        </td></tr>
        <tr><td style="padding:28px;">
          <h1 style="margin:0 0 10px;font-size:18px;color:#14151a;">New login detected</h1>
          <p style="margin:0 0 18px;font-size:14px;line-height:1.5;color:#55566a;">A login to your Voidz.IO dashboard just completed from a device that wasn't already trusted.</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;border:1px solid #e5e6eb;border-radius:12px;padding:4px 14px;margin:0 0 18px;">
            <tr><td style="padding:8px 0;font-size:13px;color:#8b8d98;">Time</td><td style="padding:8px 0;font-size:13px;color:#14151a;text-align:right;font-weight:bold;">${when}</td></tr>
            <tr><td style="padding:8px 0;font-size:13px;color:#8b8d98;border-top:1px solid #e5e6eb;">IP address</td><td style="padding:8px 0;font-size:13px;color:#14151a;text-align:right;font-weight:bold;border-top:1px solid #e5e6eb;">${ip}</td></tr>
          </table>
          <p style="margin:0;font-size:13px;line-height:1.5;color:#8b8d98;">If this was you, no action is needed. If not, open the dashboard, hit the <strong style="color:#e11d48;">Panic</strong> button in Settings &rarr; Account, and change your password.</p>
        </td></tr>
      </table>
      <p style="max-width:460px;margin:16px auto 0;font-size:11px;color:#b0b2bd;text-align:center;">Voidz.IO Dashboard &middot; automated security email</p>
    </td></tr>
  </table>
</body>
</html>`
}

// Generic security-change alert (2FA off, recovery email changed, password
// changed, failed-login burst). `heading`/`detail` are server-generated.
function buildSecurityAlertHtml(heading, detail, when) {
    return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f4f4f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e5e6eb;">
        <tr><td style="background:#e11d48;padding:20px 28px;">
          <span style="color:#ffffff;font-size:20px;font-weight:bold;letter-spacing:-0.3px;">Voidz.IO security</span>
        </td></tr>
        <tr><td style="padding:28px;">
          <h1 style="margin:0 0 10px;font-size:18px;color:#14151a;">${heading}</h1>
          <p style="margin:0 0 14px;font-size:13px;color:#8b8d98;">${when}</p>
          <p style="margin:0 0 18px;font-size:14px;line-height:1.5;color:#55566a;">${detail}</p>
          <p style="margin:0;font-size:13px;line-height:1.5;color:#8b8d98;">If this was you, no action is needed. If <strong>not</strong>, your account may be compromised &mdash; change your password and hit the <strong style="color:#e11d48;">Panic</strong> button in Settings &rarr; Account right away.</p>
        </td></tr>
      </table>
      <p style="max-width:460px;margin:16px auto 0;font-size:11px;color:#b0b2bd;text-align:center;">Voidz.IO Dashboard &middot; automated security email</p>
    </td></tr>
  </table>
</body>
</html>`
}

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

// Bot's-eye-view 3D viewer (prismarine-viewer) - only ever started for
// a primary BotSession's own bot (never FleetAccount), one dedicated
// port per instance so multiple logged-in users' main bots don't
// collide. Each needs its own firewall/security-list rule opened to
// be reachable from outside this machine.
const POV_VIEWER_BASE_PORT = 3100
let nextPovViewerPort = POV_VIEWER_BASE_PORT

const FIRST_JQ_DELAY = 15000
const JQ_RETRY_DELAY = 3000

// Extra settle time, AFTER the bot has reached LifeSteal and done its
// AFK /home teleport, before checking whether the Black Market is
// already open on a fresh connection (see the resync check in
// reachedLifeSteal). checkBlackMarket() only reacts to the server's
// "has now opened" broadcast - if a reboot/reconnect happens while the
// market is already open, that broadcast already fired in the past and
// the bot would otherwise silently miss the whole window. Crucially this
// can't run until the bot is actually on LifeSteal, where /bm exists.
const BLACK_MARKET_RESYNC_DELAY = 8000

// The 3 items auto-buy has always tracked, kept as the default list for
// any account that hasn't customized it via the Auto-Buy card yet - raw
// Minecraft item IDs, same format the card's add input takes.
const DEFAULT_BLACK_MARKET_ITEMS = ['minecraft:red_dye', 'minecraft:orange_dye', 'minecraft:lantern']

// Nicer display labels for the known defaults (what the Black Market's
// own shop lore actually calls them) - anything else typed into the
// Auto-Buy card falls back to a title-cased version of its item ID.
const BLACK_MARKET_ITEM_LABELS = {
    red_dye: 'Insane Key',
    orange_dye: 'Exclusive Key',
    lantern: 'KOTH Starters'
}

// Confirmed-working lore-text fallback patterns for the defaults (the
// shop's displayName for these doesn't match their item ID - "Insane
// Key" for red_dye, etc.). A custom item typed into the Auto-Buy card
// gets a best-effort pattern built from its own ID's words instead,
// since there's no way to know its shop lore in advance.
const BLACK_MARKET_ITEM_PATTERNS = {
    red_dye: /insane/i,
    orange_dye: /exclusive/i,
    lantern: /lantern/i
}

function blackMarketItemLabel(itemName) {
    if (BLACK_MARKET_ITEM_LABELS[itemName]) return BLACK_MARKET_ITEM_LABELS[itemName]
    const words = itemName.split('_').filter(Boolean)
    return words.length ? words.map(w => w[0].toUpperCase() + w.slice(1)).join(' ') : itemName
}

function blackMarketItemPattern(itemName) {
    if (BLACK_MARKET_ITEM_PATTERNS[itemName]) return BLACK_MARKET_ITEM_PATTERNS[itemName]
    const words = itemName.split('_').filter(Boolean)
    return words.length ? new RegExp(words.join('.*'), 'i') : /(?!)/
}

const HOME_DELAY = 10000

// Balance auto-manage (opt-in): every BALANCE_CHECK_INTERVAL the bot
// runs /bal, and deposits everything ABOVE BALANCE_KEEP into the team
// bank, so it always sits at ~7m on hand. BALANCE_RESPONSE_WINDOW is
// how long we treat the next "has $X" line as the answer to our /bal
// before giving up (so a stray balance line later doesn't trigger a
// deposit). Deposit-only for now - withdraw side intentionally left out.
const BALANCE_CHECK_INTERVAL = 5 * 60 * 1000
const BALANCE_KEEP = 7000000
const BALANCE_RESPONSE_WINDOW = 15000

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
const TWO_FACTOR_FILE = path.join(__dirname, 'two-factor.json')
const LOGIN_LOG_FILE = path.join(__dirname, 'login-log.json')
const ADMIN_CRED_FILE = path.join(__dirname, 'admin-cred.json')
const LOGS_DIR = path.join(__dirname, 'logs')
const AUTH_CACHE_DIR = path.join(__dirname, 'auth_cache')
const PUBLIC_DIR = path.join(__dirname, 'public')
const DOWNLOADS_DIR = path.join(__dirname, 'downloads')
const DESKTOP_APP_FILE = 'Voidz.IO.zip'

fs.mkdirSync(LOGS_DIR, { recursive: true })
fs.mkdirSync(AUTH_CACHE_DIR, { recursive: true })

// ============================================================
// EXPRESS / SESSION / SOCKET.IO
// ============================================================

const app = express()
const server = http.createServer(app)

// The dashboard page and its Socket.IO connection are served from this
// same origin, so Socket.IO's default same-origin policy is exactly
// what we want. The previous `cors: { origin: '*' }` let any website
// open a cross-origin socket to this server - pointless for a single-
// origin app and a needlessly wide surface, so it's removed.
const io = new Server(server)
const WEB_PORT = 3000

// Set COOKIE_SECURE=true when serving this behind HTTPS (directly or via
// a TLS-terminating reverse proxy) so the session cookie is never sent
// over plaintext HTTP. Off by default so a plain-HTTP local/dev instance
// still works; with a proxy, trust it so secure-cookie detection works.
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true'

if (COOKIE_SECURE) {
    app.set('trust proxy', 1)
}

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
        secure: COOKIE_SECURE,
        sameSite: 'lax'
    }
})

app.use(express.json())
app.use(sessionMiddleware)

// This is a private dashboard, not a public site - keep it out of
// search engines. The header covers every response (defense in
// depth for crawlers that ignore robots.txt); robots.txt below is
// the first thing well-behaved ones check.
// Security headers on every response (defense in depth).
// - CSP: the app's own markup uses inline <script>/<style> and onclick
//   handlers, so script/style need 'unsafe-inline'; but everything else
//   is locked to same-origin (plus Google Fonts), there's no 'unsafe-eval',
//   framing is blocked, and object/embed is off - so an injected external
//   script, an <iframe> clickjack, or a data: script still can't run.
// - Socket.IO's websocket is same-origin, covered by connect-src 'self'.
const CSP = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'"
].join('; ')

app.use((req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow')
    res.setHeader('Content-Security-Policy', CSP)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
    // Only meaningful over HTTPS; sent when the deployment is behind TLS
    // (COOKIE_SECURE) so browsers refuse to ever downgrade to plain HTTP.
    if (COOKIE_SECURE) {
        res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains')
    }
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
// LOGIN RATE LIMITING (brute-force protection)
// ============================================================
// In-memory, per-IP - this is a single-process dashboard, not a
// cluster, so there's no need for a shared/distributed store.
// Tracks FAILED attempts only; a correct login always clears an
// IP's record. Once an IP hits the max within the window, every
// further attempt is blocked (even a correct password) until the
// lockout expires - this is what actually stops a brute-force or
// credential-guessing run, not just slowing it down.

const LOGIN_ATTEMPT_WINDOW_MS = 10 * 60 * 1000  // 10 minutes
const LOGIN_MAX_ATTEMPTS = 5
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000         // 15 minutes

const loginAttempts = new Map() // ip -> { count, firstAttemptAt, lockedUntil }

function getLoginAttemptState(ip) {

    let state = loginAttempts.get(ip)
    const now = Date.now()

    if (!state) {
        state = { count: 0, firstAttemptAt: now, lockedUntil: 0 }
        loginAttempts.set(ip, state)
    }

    // Stale window with no active lockout - start counting fresh
    // instead of letting attempts from days ago still count.
    if (now > state.lockedUntil && now - state.firstAttemptAt > LOGIN_ATTEMPT_WINDOW_MS) {
        state.count = 0
        state.firstAttemptAt = now
        state.lockedUntil = 0
    }

    return state

}

function recordFailedLogin(ip) {

    const state = getLoginAttemptState(ip)

    state.count++

    if (state.count >= LOGIN_MAX_ATTEMPTS) {
        state.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS
    }

}

function clearLoginAttempts(ip) {
    loginAttempts.delete(ip)
}

// Housekeeping so this Map doesn't grow forever from one-off
// scanners/bots that never come back to retry.
setInterval(() => {

    const now = Date.now()

    for (const [ip, state] of loginAttempts) {
        if (now > state.lockedUntil && now - state.firstAttemptAt > LOGIN_ATTEMPT_WINDOW_MS) {
            loginAttempts.delete(ip)
        }
    }

}, 5 * 60 * 1000)

// General per-IP request throttle on every pre-auth route (login,
// signup, and anything else not behind requireAuth) - independent
// of the attempt-counting lockout above, this just caps raw request
// volume so a script can't hammer the endpoint fast enough to make
// the 5-in-10-minutes lockout irrelevant.
const REQUEST_RATE_WINDOW_MS = 60 * 1000
const REQUEST_RATE_MAX = 30

const requestRateTracker = new Map() // ip -> { count, windowStart }

function rateLimitPreAuth(req, res, next) {

    const ip = req.ip
    const now = Date.now()

    let entry = requestRateTracker.get(ip)

    if (!entry || now - entry.windowStart > REQUEST_RATE_WINDOW_MS) {
        entry = { count: 0, windowStart: now }
        requestRateTracker.set(ip, entry)
    }

    entry.count++

    if (entry.count > REQUEST_RATE_MAX) {
        return res.status(429).json({ error: 'Too many requests. Slow down and try again shortly.' })
    }

    next()

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

// --- Admin password override ---
// The admin password normally lives in DASHBOARD_PASSWORD (.env). Once the
// admin changes it in-app (which requires password + email code + an
// authenticator code), it's stored here instead. It's ENCRYPTED (not just
// hashed) so the email-gated "view password" feature can show it; the key
// is derived from SESSION_SECRET (in .env), so leaking admin-cred.json
// alone doesn't expose the password. Kept in its own file so toggling 2FA
// can't wipe it.
const ADMIN_ENC_KEY = crypto.scryptSync(SESSION_SECRET, 'voidz-admin-cred-v1', 32)

function encryptSecret(plain) {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', ADMIN_ENC_KEY, iv)
    const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
    return { iv: iv.toString('hex'), enc: enc.toString('hex'), tag: cipher.getAuthTag().toString('hex') }
}

function decryptSecret(obj) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', ADMIN_ENC_KEY, Buffer.from(obj.iv, 'hex'))
    decipher.setAuthTag(Buffer.from(obj.tag, 'hex'))
    return Buffer.concat([decipher.update(Buffer.from(obj.enc, 'hex')), decipher.final()]).toString('utf8')
}

// Length-safe constant-time string compare (timingSafeEqual needs equal
// lengths; comparing fixed-size hashes sidesteps that and any length leak).
function constantTimeEqualStr(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest()
    const hb = crypto.createHash('sha256').update(String(b)).digest()
    return crypto.timingSafeEqual(ha, hb)
}

function getAdminPasswordOverride() {
    try {
        const parsed = JSON.parse(fs.readFileSync(ADMIN_CRED_FILE, 'utf8'))
        return (parsed && parsed.enc && parsed.iv && parsed.tag) ? parsed : null
    } catch {
        return null
    }
}

// Stores an already-encrypted blob (built at change-request time so the
// plaintext never sits in a session).
function writeAdminPasswordOverride(encObj) {
    fs.writeFileSync(ADMIN_CRED_FILE, JSON.stringify({ ...encObj, updatedAt: new Date().toISOString() }, null, 2))
}

// The current admin password in plaintext (decrypted override, else the
// .env value), or null if an override exists but can't be decrypted.
function getAdminPasswordPlaintext() {
    const override = getAdminPasswordOverride()
    if (override) {
        try { return decryptSecret(override) } catch { return null }
    }
    return DASHBOARD_PASSWORD
}

// True if the given password is the admin's current one.
function verifyAdminPassword(password) {
    const current = getAdminPasswordPlaintext()
    if (current === null) return false
    return constantTimeEqualStr(String(password || ''), current)
}

// ============================================================
// TWO-FACTOR AUTH (TOTP, authenticator app)
// ============================================================
// Opt-in per account (currently only offered to the admin in the UI).
// Standard RFC 6238 TOTP so any authenticator app works, implemented
// on Node's own crypto - no third-party TOTP library. A per-account
// record lives in two-factor.json (gitignored - it holds the shared
// secret). Set DISABLE_2FA=true to bypass the whole second factor from
// the server side, the escape hatch against ever being locked out.
// ============================================================

const TWO_FACTOR_DISABLED = process.env.DISABLE_2FA === 'true'
const TRUSTED_DEVICE_MS = 72 * 60 * 60 * 1000 // 72 hours
const TRUSTED_DEVICE_COOKIE = 'voidz_2fa_trust'
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function base32Encode(buf) {
    let bits = 0, value = 0, out = ''
    for (const byte of buf) {
        value = (value << 8) | byte
        bits += 8
        while (bits >= 5) {
            out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
            bits -= 5
        }
    }
    if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
    return out
}

function base32Decode(str) {
    const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/\s/g, '')
    let bits = 0, value = 0
    const out = []
    for (const ch of clean) {
        const idx = BASE32_ALPHABET.indexOf(ch)
        if (idx === -1) continue
        value = (value << 5) | idx
        bits += 5
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 0xff)
            bits -= 8
        }
    }
    return Buffer.from(out)
}

function hotp(secretBuf, counter) {
    const buf = Buffer.alloc(8)
    buf.writeBigUInt64BE(BigInt(counter))
    const hmac = crypto.createHmac('sha1', secretBuf).update(buf).digest()
    const offset = hmac[hmac.length - 1] & 0x0f
    const code = ((hmac[offset] & 0x7f) << 24) |
        ((hmac[offset + 1] & 0xff) << 16) |
        ((hmac[offset + 2] & 0xff) << 8) |
        (hmac[offset + 3] & 0xff)
    return (code % 1000000).toString().padStart(6, '0')
}

// Accepts the current 30s step plus one on either side, to tolerate a
// little clock drift between the server and the phone.
function verifyTotp(secretBase32, token) {
    const clean = String(token || '').replace(/\s/g, '')
    if (!/^\d{6}$/.test(clean)) return false
    const secretBuf = base32Decode(secretBase32)
    if (secretBuf.length === 0) return false
    const counter = Math.floor(Date.now() / 30000)
    const candidate = Buffer.from(clean)
    for (let w = -1; w <= 1; w++) {
        const expected = Buffer.from(hotp(secretBuf, counter + w))
        if (expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate)) {
            return true
        }
    }
    return false
}

function loadTwoFactor() {
    try {
        const parsed = JSON.parse(fs.readFileSync(TWO_FACTOR_FILE, 'utf8'))
        return (parsed && typeof parsed === 'object') ? parsed : {}
    } catch {
        return {}
    }
}

function saveTwoFactor(store) {
    fs.writeFileSync(TWO_FACTOR_FILE, JSON.stringify(store, null, 2))
}

function getTwoFactorRecord(username) {
    const store = loadTwoFactor()
    return store[username] || null
}

function isTwoFactorEnabled(username) {
    if (TWO_FACTOR_DISABLED) return false
    const record = getTwoFactorRecord(username)
    return !!(record && record.enabled && record.secret)
}

// 10 single-use recovery codes (shown once at setup). Stored only as
// scrypt hashes, same as passwords, so the file never holds a usable
// code. Format xxxx-xxxx using unambiguous characters.
function generateBackupCodes() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    const plain = []
    const stored = []
    for (let i = 0; i < 10; i++) {
        let code = ''
        for (let c = 0; c < 8; c++) {
            if (c === 4) code += '-'
            code += alphabet[crypto.randomInt(alphabet.length)]
        }
        plain.push(code)
        const { salt, hash } = hashPassword(code)
        stored.push({ salt, hash, used: false })
    }
    return { plain, stored }
}

// Verifies a backup code against an account's stored hashes and, on a
// match, marks that one used so it can't be replayed. Returns true if
// a fresh code matched.
function consumeBackupCode(username, code) {
    const normalized = String(code || '').trim().toUpperCase()
    if (!normalized) return false
    const store = loadTwoFactor()
    const record = store[username]
    if (!record || !Array.isArray(record.backupCodes)) return false
    for (const entry of record.backupCodes) {
        if (entry.used) continue
        if (verifyPassword(normalized, entry.salt, entry.hash)) {
            entry.used = true
            saveTwoFactor(store)
            return true
        }
    }
    return false
}

function readCookies(req) {
    const header = req.headers?.cookie
    const out = {}
    if (!header) return out
    for (const part of header.split(';')) {
        const idx = part.indexOf('=')
        if (idx === -1) continue
        const key = part.slice(0, idx).trim()
        const value = part.slice(idx + 1).trim()
        if (key) out[key] = decodeURIComponent(value)
    }
    return out
}

// A "trust this device for 72h" token: a random value handed to the
// browser as a cookie, stored server-side only as its SHA-256 hash with
// an expiry. While valid, that browser skips the TOTP code at login
// (password is still required). Expired/used-up entries are pruned on
// every read so the list can't grow without bound.
function hashTrustToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex')
}

function issueTrustedDevice(username) {
    const token = crypto.randomBytes(32).toString('hex')
    const store = loadTwoFactor()
    const record = store[username]
    if (!record) return null
    if (!Array.isArray(record.trustedDevices)) record.trustedDevices = []
    const now = Date.now()
    record.trustedDevices = record.trustedDevices.filter(d => d.expiresAt > now)
    record.trustedDevices.push({ tokenHash: hashTrustToken(token), expiresAt: now + TRUSTED_DEVICE_MS })
    saveTwoFactor(store)
    return token
}

function hasValidTrustedDevice(username, token) {
    if (!token) return false
    const store = loadTwoFactor()
    const record = store[username]
    if (!record || !Array.isArray(record.trustedDevices)) return false
    const now = Date.now()
    const wanted = hashTrustToken(token)
    const before = record.trustedDevices.length
    record.trustedDevices = record.trustedDevices.filter(d => d.expiresAt > now)
    if (record.trustedDevices.length !== before) saveTwoFactor(store)
    return record.trustedDevices.some(d => d.tokenHash === wanted)
}

// Revokes every trusted device at once (the panic button) - after this,
// no browser can skip the authenticator code, even one still inside its
// 72h window.
function clearTrustedDevices(username) {
    const store = loadTwoFactor()
    const record = store[username]
    if (!record) return
    record.trustedDevices = []
    saveTwoFactor(store)
}

// --- Login activity log + new-device email alerts ---

const LOGIN_LOG_MAX = 50 // keep the last N events per account

function loadLoginLog() {
    try {
        const parsed = JSON.parse(fs.readFileSync(LOGIN_LOG_FILE, 'utf8'))
        return (parsed && typeof parsed === 'object') ? parsed : {}
    } catch {
        return {}
    }
}

function saveLoginLog(log) {
    try {
        fs.writeFileSync(LOGIN_LOG_FILE, JSON.stringify(log, null, 2))
    } catch (error) {
        appLog(`[LOGIN-LOG] Failed to save: ${error.message}`)
    }
}

// event: { outcome, method?, ip, newDevice? }. Newest kept first, capped.
function recordLoginEvent(username, event) {
    if (!username) return
    const log = loadLoginLog()
    if (!Array.isArray(log[username])) log[username] = []
    log[username].unshift({ at: new Date().toISOString(), ...event })
    log[username] = log[username].slice(0, LOGIN_LOG_MAX)
    saveLoginLog(log)
}

function getLoginActivity(username) {
    const log = loadLoginLog()
    return Array.isArray(log[username]) ? log[username] : []
}

// Fire-and-forget email when a login completes from a device that wasn't
// already trusted. Never throws (a mail hiccup must not break login).
function maybeSendLoginAlert(username, ip) {
    if (!mailConfigured()) return
    const record = getTwoFactorRecord(username)
    if (!record || !record.recoveryEmail || record.loginAlerts === false) return
    const when = new Date().toUTCString()
    sendMail(
        record.recoveryEmail,
        'New login to your Voidz.IO dashboard',
        `A login to your Voidz.IO dashboard just completed from a device that wasn't already trusted.\n\nTime: ${when}\nIP: ${ip}\n\nIf this was you, nothing to do. If not, open the dashboard, hit the Panic button in Settings, and change your password.`,
        buildAlertEmailHtml(when, ip)
    ).catch(error => appLog(`Login alert email failed for ${username}: ${error.message}`))
}

// Fire-and-forget email about a sensitive account change (2FA turned off,
// recovery email changed/removed, password changed) - the moves an
// attacker makes after getting in. `to` is passed explicitly because some
// of these (disable 2FA, change recovery email) alter or remove the very
// record the address would otherwise be read from.
function sendSecurityAlert(to, heading, detail) {
    if (!mailConfigured() || !to) return
    const when = new Date().toUTCString()
    sendMail(
        to,
        `Voidz.IO security alert: ${heading}`,
        `${heading}\n\nTime: ${when}\n${detail}\n\nIf this was you, no action is needed. If NOT, your account may be compromised - change your password and use the Panic button in Settings immediately.`,
        buildSecurityAlertHtml(heading, detail, when)
    ).catch(error => appLog(`Security alert email failed: ${error.message}`))
}

// --- Failed-login burst alerting (per account) ---
// Someone actively guessing a real account's password. Emails once per
// burst (then a cooldown) so it warns without spamming.
const FAILED_BURST_WINDOW_MS = 10 * 60 * 1000
const FAILED_BURST_THRESHOLD = 5
const FAILED_BURST_COOLDOWN_MS = 15 * 60 * 1000
const failedLoginBursts = new Map() // username -> { count, windowStart, lastAlertAt }

function noteFailedLoginBurst(username, ip) {
    const record = getTwoFactorRecord(username)
    if (!mailConfigured() || !record || !record.recoveryEmail) return

    const now = Date.now()
    let state = failedLoginBursts.get(username)
    if (!state || now - state.windowStart > FAILED_BURST_WINDOW_MS) {
        state = { count: 0, windowStart: now, lastAlertAt: 0 }
        failedLoginBursts.set(username, state)
    }
    state.count++

    if (state.count >= FAILED_BURST_THRESHOLD && now - state.lastAlertAt > FAILED_BURST_COOLDOWN_MS) {
        state.lastAlertAt = now
        sendSecurityAlert(
            record.recoveryEmail,
            'Repeated failed login attempts',
            `There have been ${state.count} failed password attempts on your account in the last few minutes (most recent from ${ip}). Your password has NOT been given out - but someone may be trying to guess it.`
        )
    }
}

// --- Email recovery (optional second recovery path for 2FA) ---

const RECOVERY_CODE_TTL_MS = 10 * 60 * 1000       // codes valid 10 minutes
const RECOVERY_SEND_INTERVAL_MS = 60 * 1000       // at most one email per minute
const RECOVERY_MAX_ATTEMPTS = 5

// Partially hides an address for display: john@gmail.com -> j••@gmail.com
function maskEmail(email) {
    const at = String(email || '').indexOf('@')
    if (at <= 0) return ''
    const name = email.slice(0, at)
    const domain = email.slice(at)
    const shown = name.length <= 2 ? name[0] : name.slice(0, 2)
    return `${shown}${'•'.repeat(Math.max(2, name.length - shown.length))}${domain}`
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim())
}

function getRecoveryEmail(username) {
    const record = getTwoFactorRecord(username)
    return record && record.recoveryEmail ? record.recoveryEmail : null
}

// Starts recovery-email setup: stores the address as pending with a
// 6-digit verification code (hashed). Returns the plain code to email.
function startRecoveryEmailVerification(username, email) {
    const store = loadTwoFactor()
    const record = store[username]
    if (!record) return null
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0')
    const { salt, hash } = hashPassword(code)
    record.pendingEmail = { email, salt, hash, expiresAt: Date.now() + RECOVERY_CODE_TTL_MS }
    saveTwoFactor(store)
    return code
}

function verifyRecoveryEmail(username, code) {
    const store = loadTwoFactor()
    const record = store[username]
    if (!record || !record.pendingEmail) return false
    if (record.pendingEmail.expiresAt < Date.now()) {
        delete record.pendingEmail
        saveTwoFactor(store)
        return false
    }
    if (!verifyPassword(String(code || '').trim(), record.pendingEmail.salt, record.pendingEmail.hash)) {
        return false
    }
    record.recoveryEmail = record.pendingEmail.email
    // New-device login alerts default ON once there's an address to send
    // them to; the admin can turn them off from Settings.
    if (record.loginAlerts === undefined) record.loginAlerts = true
    delete record.pendingEmail
    saveTwoFactor(store)
    return true
}

function removeRecoveryEmail(username) {
    const store = loadTwoFactor()
    const record = store[username]
    if (!record) return
    delete record.recoveryEmail
    delete record.pendingEmail
    delete record.recoveryLoginCode
    saveTwoFactor(store)
}

// Issues a short-lived login recovery code to be emailed. Enforces a
// minimum interval between sends so the inbox (and our outbound mail)
// can't be spammed. Returns { code } on success, or { error } otherwise.
function createRecoveryLoginCode(username) {
    const store = loadTwoFactor()
    const record = store[username]
    if (!record || !record.recoveryEmail) return { error: 'no-email' }
    const now = Date.now()
    if (record.recoveryLoginCode && now - (record.recoveryLoginCode.sentAt || 0) < RECOVERY_SEND_INTERVAL_MS) {
        return { error: 'too-soon' }
    }
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0')
    const { salt, hash } = hashPassword(code)
    record.recoveryLoginCode = { salt, hash, expiresAt: now + RECOVERY_CODE_TTL_MS, sentAt: now, attempts: 0 }
    saveTwoFactor(store)
    return { code, email: record.recoveryEmail }
}

function verifyRecoveryLoginCode(username, code) {
    const store = loadTwoFactor()
    const record = store[username]
    if (!record || !record.recoveryLoginCode) return false
    const entry = record.recoveryLoginCode
    if (entry.expiresAt < Date.now() || entry.attempts >= RECOVERY_MAX_ATTEMPTS) {
        delete record.recoveryLoginCode
        saveTwoFactor(store)
        return false
    }
    if (!verifyPassword(String(code || '').trim(), entry.salt, entry.hash)) {
        entry.attempts++
        saveTwoFactor(store)
        return false
    }
    // Consumed on success so it can't be replayed.
    delete record.recoveryLoginCode
    saveTwoFactor(store)
    return true
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

// In-memory cache of the whole shared bot-configs.json, backed by a
// debounced ASYNC write-behind instead of a read+write on every call.
// getTeamHistory/saveTeamHistory, getKothHistory/saveKothHistory,
// saveServerActivity (fired on every KOTH capture server-wide, not
// just our own team's), saveBadgeProgress, savePreferences, etc. all
// go through loadBotConfigs()/saveBotConfigs() - with the old
// fs.readFileSync + fs.writeFileSync of the ENTIRE multi-account file
// on every single one of those events, a busy server's worth of KOTH
// captures was blocking the event loop synchronously often enough to
// stall mineflayer's physics tick timer and trip FlareMC's anti-cheat
// TickTimer check (same class of bug as the appLogStream fix above,
// just in the config persistence path instead of logging).
let botConfigsCache = null
let botConfigsWriteTimer = null
let botConfigsWriteInFlight = false
let botConfigsWritePending = false

function loadBotConfigs() {

    if (!botConfigsCache) {

        try {
            const raw = fs.readFileSync(BOT_CONFIGS_FILE, 'utf8')
            const parsed = JSON.parse(raw)
            botConfigsCache = (parsed && typeof parsed === 'object') ? parsed : {}
        } catch {
            botConfigsCache = {}
        }

    }

    return botConfigsCache

}

function flushBotConfigs() {

    if (botConfigsWriteInFlight) {
        botConfigsWritePending = true
        return
    }

    botConfigsWriteInFlight = true

    const snapshot = JSON.stringify(botConfigsCache, null, 2)

    fs.writeFile(BOT_CONFIGS_FILE, snapshot, error => {

        botConfigsWriteInFlight = false

        if (error) {
            originalError('[BOT-CONFIGS] Failed to save:', error.message)
        }

        if (botConfigsWritePending) {
            botConfigsWritePending = false
            flushBotConfigs()
        }

    })

}

// Only ever called with the same object loadBotConfigs() already
// returned (mutated in place by callers), so this just needs to
// schedule it to disk - never block on the write itself.
function saveBotConfigs(configs) {

    botConfigsCache = configs

    if (botConfigsWriteTimer) {
        clearTimeout(botConfigsWriteTimer)
    }

    botConfigsWriteTimer = setTimeout(() => {
        botConfigsWriteTimer = null
        flushBotConfigs()
    }, 500)

}

// Last-resort synchronous flush for process shutdown only, where
// blocking briefly is harmless (nothing left to stall) and losing
// the last few seconds of history on every restart would not be.
function flushBotConfigsSync() {

    if (botConfigsWriteTimer) {
        clearTimeout(botConfigsWriteTimer)
        botConfigsWriteTimer = null
    }

    if (!botConfigsCache) return

    try {
        fs.writeFileSync(BOT_CONFIGS_FILE, JSON.stringify(botConfigsCache, null, 2))
    } catch (error) {
        originalError('[BOT-CONFIGS] Failed to save on shutdown:', error.message)
    }

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

// Raw "minecraft:item_id" strings the Auto-Buy card is tracking - see
// autoBuyBlackMarket() in BotSession, which falls back to
// DEFAULT_BLACK_MARKET_ITEMS when this is empty/unset.
function getBlackMarketAutoBuyItems(username) {
    const configs = loadBotConfigs()
    const list = configs[username]?.blackMarketAutoBuyItems
    return Array.isArray(list) ? list : []
}

function saveBlackMarketAutoBuyItems(username, list) {
    const configs = loadBotConfigs()
    configs[username] = { ...configs[username], blackMarketAutoBuyItems: list }
    saveBotConfigs(configs)
}

// Last 25 successful Auto-Buy purchases, newest last - shown in the
// Auto-Buy card's Purchase History.
function getBlackMarketPurchaseHistory(username) {
    const configs = loadBotConfigs()
    const history = configs[username]?.blackMarketPurchaseHistory
    return Array.isArray(history) ? history : []
}

function saveBlackMarketPurchaseHistory(username, history) {
    const configs = loadBotConfigs()
    configs[username] = { ...configs[username], blackMarketPurchaseHistory: history }
    saveBotConfigs(configs)
}

// History of chat games the bot successfully answered (newest last).
function getTriviaHistory(username) {
    const configs = loadBotConfigs()
    const history = configs[username]?.triviaHistory
    return Array.isArray(history) ? history : []
}

function saveTriviaHistory(username, history) {
    const configs = loadBotConfigs()
    configs[username] = { ...configs[username], triviaHistory: history }
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

// Permanent team rank assignments - see checkAutoPromote() below.
// {name, rank: 'officer' | 'captain'} per entry.
function getPermRanks(username) {
    const configs = loadBotConfigs()
    const list = configs[username]?.permRanks
    return Array.isArray(list) ? list : []
}

function savePermRanks(username, list) {
    const configs = loadBotConfigs()
    configs[username] = { ...configs[username], permRanks: list }
    saveBotConfigs(configs)
}

// Lightweight extra accounts (see FleetAccount) - separate from the
// user's own primary bot config above.
function getFleetAccounts(username) {
    const configs = loadBotConfigs()
    const list = configs[username]?.fleet
    return Array.isArray(list) ? list : []
}

function saveFleetAccounts(username, list) {
    const configs = loadBotConfigs()
    configs[username] = { ...configs[username], fleet: list }
    saveBotConfigs(configs)
}

function normalizeFleetAccount(input, existing) {

    const microsoftEmail = String(input?.microsoftEmail ?? existing?.microsoftEmail ?? '').trim()
    const host = String(input?.host ?? existing?.host ?? '').trim()
    const platform = (input?.platform ?? existing?.platform) === 'bedrock' ? 'bedrock' : 'java'

    const portRaw = Number(input?.port ?? existing?.port)
    const defaultPort = platform === 'bedrock' ? 19132 : 25565
    const port = (Number.isFinite(portRaw) && portRaw > 0 && portRaw <= 65535) ? portRaw : defaultPort

    const label = String(input?.label ?? existing?.label ?? '').trim()
    const version = String(input?.version ?? existing?.version ?? '').trim()
    const afkCommand = String(input?.afkCommand ?? existing?.afkCommand ?? '').trim()

    const proxyHost = String(input?.proxyHost ?? existing?.proxyHost ?? '').trim()
    const proxyPortRaw = Number(input?.proxyPort ?? existing?.proxyPort)
    const proxyPort = (Number.isFinite(proxyPortRaw) && proxyPortRaw > 0 && proxyPortRaw <= 65535) ? proxyPortRaw : null
    const proxyUsername = String(input?.proxyUsername ?? existing?.proxyUsername ?? '').trim()
    const proxyPassword = String(input?.proxyPassword ?? existing?.proxyPassword ?? '')
    const localAddress = String(input?.localAddress ?? existing?.localAddress ?? '').trim()

    return {
        id: existing?.id || crypto.randomUUID(),
        label, microsoftEmail, platform, host, port, version, afkCommand,
        proxyHost, proxyPort, proxyUsername, proxyPassword, localAddress
    }

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

// Lowercased player name -> last time the bot actually saw them in its
// own tab list (ms epoch), updated every second by the global dashboard
// tick in checkAutoInviteLowHealth()'s sibling loop below - REGARDLESS
// of whether any browser has the dashboard open. Threats/Allies/Auto-
// Invite previously computed "last seen" purely in browser JS off the
// online/offline transition it happened to witness live, so a name that
// went offline while nobody had the dashboard open just stayed frozen
// at whatever the last-open tab last recorded (reported as "still shows
// 67 days ago" even though they were online 5 minutes ago). This is the
// single server-side source of truth those lists now read from instead.
function getPlayerLastSeen(username) {
    const configs = loadBotConfigs()
    const map = configs[username]?.playerLastSeen
    return (map && typeof map === 'object') ? map : {}
}

function savePlayerLastSeen(username, map) {
    const configs = loadBotConfigs()
    configs[username] = { ...configs[username], playerLastSeen: map }
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

// Who got promoted/demoted and when - see checkRoleChanges() below.
function getRoleChangeHistory(username) {
    const configs = loadBotConfigs()
    const history = configs[username]?.roleChangeHistory
    return Array.isArray(history) ? history : []
}

function saveRoleChangeHistory(username, history) {
    const configs = loadBotConfigs()
    configs[username] = { ...configs[username], roleChangeHistory: history }
    saveBotConfigs(configs)
}

// Who joined/left/got kicked and when - see logTeamEvent() below.
function getTeamEventHistory(username) {
    const configs = loadBotConfigs()
    const history = configs[username]?.teamEventHistory
    return Array.isArray(history) ? history : []
}

function saveTeamEventHistory(username, history) {
    const configs = loadBotConfigs()
    configs[username] = { ...configs[username], teamEventHistory: history }
    saveBotConfigs(configs)
}

// Every death the bot itself suffers, with the killer's name if the
// server's death message named one - see checkNemesisDeath() below.
function getNemesisHistory(username) {
    const configs = loadBotConfigs()
    const history = configs[username]?.nemesisHistory
    return Array.isArray(history) ? history : []
}

function saveNemesisHistory(username, history) {
    const configs = loadBotConfigs()
    configs[username] = { ...configs[username], nemesisHistory: history }
    saveBotConfigs(configs)
}

// Manual fix for the Leaderboard showing a renamed player as two
// separate rows - checkKothCapture/checkTeamDeath only tag NEW
// entries with a UUID, so the old ones under a previous name stay
// split until they age out of the 50-entry cap (see renderLeaderboard
// on the client). This closes that gap immediately instead of
// waiting: retags every koth/death entry for EITHER given name with
// the same UUID, so the Leaderboard's uuid-based grouping merges
// their captures/deaths/net into one row right away.
function combineLeaderboardPlayers(username, nameA, nameB) {

    const normalizedA = String(nameA || '').trim()
    const normalizedB = String(nameB || '').trim()

    if (!normalizedA || !normalizedB) {
        return { ok: false, error: 'Both names are required.' }
    }

    if (normalizedA.toLowerCase() === normalizedB.toLowerCase()) {
        return { ok: false, error: 'Pick two different names.' }
    }

    const matches = name => {
        const lower = String(name || '').toLowerCase()
        return lower === normalizedA.toLowerCase() || lower === normalizedB.toLowerCase()
    }

    const kothHistory = getKothHistory(username)
    const deathHistory = getDeathHistory(username)

    const session = sessions.get(username)

    // Prefer a real UUID: either name currently online (if the bot's
    // connected), or whichever existing entry for either name is
    // already tagged from a previous capture/death. Only synthesizes
    // one as a last resort - it just needs to be a stable shared key
    // for aggregation, not a verified Mojang UUID.
    let uuid = session
        ? (session.findUuidForPlayerName(normalizedA) || session.findUuidForPlayerName(normalizedB))
        : null

    if (!uuid) {

        const tagged = [...kothHistory, ...deathHistory].find(entry => entry.uuid && matches(entry.player))

        uuid = tagged?.uuid || crypto.randomUUID()

    }

    let touched = 0

    for (const entry of kothHistory) {
        if (matches(entry.player)) { entry.uuid = uuid; touched++ }
    }

    for (const entry of deathHistory) {
        if (matches(entry.player)) { entry.uuid = uuid; touched++ }
    }

    saveKothHistory(username, kothHistory)
    saveDeathHistory(username, deathHistory)

    if (session) {

        session.kothHistory = kothHistory
        session.deathHistory = deathHistory

        session.log(`Combined leaderboard entries for "${normalizedA}" and "${normalizedB}" (${touched} entries, uuid ${uuid}).`)

        session.updateDashboard()

    }

    return { ok: true, uuid, touched }

}

// Every KOTH capture seen server-wide, not just our own team's -
// separate from kothHistory so a Team card Reset doesn't wipe out the
// wider activity feed, and vice versa.
function getServerActivity(username) {
    const configs = loadBotConfigs()
    const history = configs[username]?.serverActivity
    return Array.isArray(history) ? history : []
}

function saveServerActivity(username, history) {
    const configs = loadBotConfigs()
    configs[username] = { ...configs[username], serverActivity: history }
    saveBotConfigs(configs)
}

// Lifetime counters + unlocked-badge state, kept separate from the
// history arrays those counters derive from so a Team card Reset (or
// reset-player) never takes an already-earned badge away.
function getBadgeProgress(username) {

    const configs = loadBotConfigs()
    const progress = configs[username]?.badgeProgress

    return {
        totalKothCaptures: Number(progress?.totalKothCaptures) || 0,
        maxPointsSeen: Number(progress?.maxPointsSeen) || 0,
        unlockedBadges: (progress && typeof progress.unlockedBadges === 'object' && progress.unlockedBadges) || {}
    }

}

function saveBadgeProgress(username, progress) {
    const configs = loadBotConfigs()
    configs[username] = { ...configs[username], badgeProgress: progress }
    saveBotConfigs(configs)
}

// Every badge's unlock condition reads from the lifetime counters
// above, never from the prunable history arrays - a badge earned
// once stays earned even after a history reset.
const BADGE_DEFINITIONS = [
    { id: 'first-blood', name: 'First Blood', icon: '🏆', description: 'Capture your first KOTH', check: p => p.totalKothCaptures >= 1 },
    { id: 'hat-trick', name: 'Hat Trick', icon: '🎩', description: 'Capture 3 KOTHs', check: p => p.totalKothCaptures >= 3 },
    { id: 'dominator', name: 'Dominator', icon: '👑', description: 'Capture 10 KOTHs', check: p => p.totalKothCaptures >= 10 },
    { id: 'century-club', name: 'Century Club', icon: '💯', description: 'Capture 100 KOTHs', check: p => p.totalKothCaptures >= 100 },
    { id: 'point-leader', name: 'Point Leader', icon: '💰', description: 'Reach 500 team points', check: p => p.maxPointsSeen >= 500 },
    { id: 'high-roller', name: 'High Roller', icon: '💎', description: 'Reach 1000 team points', check: p => p.maxPointsSeen >= 1000 }
]

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

    const platform = input?.platform === 'bedrock' ? 'bedrock' : 'java'

    const portRaw = Number(input?.port)
    const defaultPort = platform === 'bedrock' ? 19132 : 25565
    const port = (Number.isFinite(portRaw) && portRaw > 0 && portRaw <= 65535) ? portRaw : defaultPort

    // Blank version means "let mineflayer auto-detect it" - lets
    // users connect without knowing their server's exact version.
    // Not used at all for Bedrock - bedrock-protocol pings the
    // server itself to discover the right protocol version.
    const version = String(input?.version || '').trim()

    // No automation on Bedrock accounts by design (no trivia, no
    // Black Market auto-buy/ping, no LifeSteal auto-transfer/keyall/
    // JQ retry) - forced off here regardless of what's submitted,
    // rather than trusting every call site to check platform too.
    const lifestealAutopilot = platform === 'bedrock' ? false : !!input?.lifestealAutopilot

    // What to send to go AFK, both from the LifeSteal Autopilot flow
    // and the manual AFK button. Different servers use different
    // commands for this (/home AFK, /warp afk, etc.), so it's
    // per-account rather than hardcoded.
    const afkCommand = String(input?.afkCommand || '').trim() || '/home AFK'

    const discordWebhookUrl = String(input?.discordWebhookUrl || '').trim()
    const discordRoleId = String(input?.discordRoleId || '').trim().replace(/\D/g, '')

    // Off by default - this spends real in-game currency/keys the
    // instant a restock is seen, not just pings about one. See
    // checkBlackMarket()/autoBuyBlackMarket().
    const blackMarketAutoBuy = platform === 'bedrock' ? false : !!input?.blackMarketAutoBuy

    // Optional SOCKS5 proxy for the outbound Minecraft connection only
    // (unrelated to proxySessionProblem elsewhere, which is about
    // FlareMC's own server-side proxy/anti-bot layer) - lets multiple
    // accounts hosted on the same machine each appear to connect from
    // a different IP, instead of sharing this server's raw IP and
    // potentially tripping the game server's own multi-account/reward
    // abuse detection.
    const proxyHost = String(input?.proxyHost || '').trim()

    const proxyPortRaw = Number(input?.proxyPort)
    const proxyPort = (Number.isFinite(proxyPortRaw) && proxyPortRaw > 0 && proxyPortRaw <= 65535) ? proxyPortRaw : null

    const proxyUsername = String(input?.proxyUsername || '').trim()
    const proxyPassword = String(input?.proxyPassword || '')

    // Alternative to the SOCKS5 proxy above: if this machine has a
    // second public IP attached to it (a second VNIC on Oracle Cloud,
    // for instance), the outbound connection can bind directly to it
    // instead of going through any proxy. Takes priority over the
    // SOCKS5 fields if both are somehow set.
    const localAddress = String(input?.localAddress || '').trim()

    return {
        microsoftEmail, host, port, platform, version, lifestealAutopilot, afkCommand, discordWebhookUrl, discordRoleId,
        blackMarketAutoBuy, proxyHost, proxyPort, proxyUsername, proxyPassword, localAddress
    }

}

function validateBotConfig(config) {

    if (!config.microsoftEmail || !config.microsoftEmail.includes('@')) {
        return 'Enter a valid Microsoft account email.'
    }

    if (!config.host) {
        return 'Enter a server address.'
    }

    if (config.proxyHost && !config.proxyPort) {
        return 'Enter a proxy port along with the proxy host.'
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

// Backup kick: if a teammate privately messages the bot something that
// contains this code word, the bot kicks them from the team - a manual
// fallback for the low-HP auto-kick. Substring match (not exact), case-
// insensitive. (Short code words like "ee" also match inside normal words
// such as "see" - keep that in mind when choosing one.)
const BACKUP_KICK_CODEWORD = 'ee'

// Fixed passcode for the `sudo` whisper command. A sender whispers this to
// unlock 3 sudo commands for 5 minutes. Override with SUDO_PASSCODE in .env.
const SUDO_PASSCODE = String(process.env.SUDO_PASSCODE || '291226')

// Detects an incoming private message TO the bot and returns
// { sender, message }, or null. Covers the common /msg display formats;
// the exact one varies per server, so several patterns are tried.
function parseIncomingWhisper(rawText) {

    const text = cleanMessage(rawText)

    const patterns = [
        /^([A-Za-z0-9_]{1,16}) whispers(?: to you)?:\s?(.*)$/i,
        /^([A-Za-z0-9_]{1,16}) -> ?(?:me|you):?\s?(.*)$/i,
        /^\[([A-Za-z0-9_]{1,16}) ?-> ?(?:me|you)\]\s?(.*)$/i,
        /^([A-Za-z0-9_]{1,16}) [→»>] ?[Yy]ou:?\s?(.*)$/,
        /^\(?from\)? ([A-Za-z0-9_]{1,16}\)?:?\s?)(.*)$/i,
        /^from ([A-Za-z0-9_]{1,16}):\s?(.*)$/i
    ]

    for (const pattern of patterns) {
        const match = text.match(pattern)
        if (match) {
            // the "(from X)" pattern captures group 1 with trailing junk - normalize
            const sender = String(match[1]).replace(/[^A-Za-z0-9_].*$/, '').trim()
            const message = String(match[2] || '').trim()
            if (sender) return { sender, message }
        }
    }

    return null

}

// Join/left/kicked broadcasts (reinvite and the Kick button both
// trigger these) are already reflected in the Team card's roster and
// the new Team Activity Log, so they're just noise in the live Chat
// panel now - still processed normally (checkTeamRosterChange,
// logTeamEvent, etc. all run unconditionally elsewhere), just not
// broadcast to the dashboard's chat feed.
function isTeamRosterNoiseMessage(text) {
    return (
        /^TEAMS ➟ .+ has (joined|left) the team\.?$/i.test(text) ||
        /^TEAMS ➟ .+ has been kicked\b/i.test(text)
    )
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

// Item/block display names for the "Blanks" trivia game (a hangman-style
// mask, e.g. "P_tt_d Cl_s_d E_el_ss_m" -> "Potted Closed Eyeblossom"),
// generated from Minecraft's en_us.json lang file (see
// minecraft-item-names.json). Regenerate that file for a newer version if
// trivia uses items it predates.
let MINECRAFT_ITEM_NAMES = []
try {
    MINECRAFT_ITEM_NAMES = JSON.parse(fs.readFileSync(path.join(__dirname, 'minecraft-item-names.json'), 'utf8'))
} catch (error) {
    console.error('[STARTUP] Could not load minecraft-item-names.json - Blanks trivia will have no wordlist.', error.message)
}

// Returns every item name whose shape matches the masked line (same word
// count, same length per word, and every revealed letter matching).
function findBlanksCandidates(maskedLine) {

    const maskWords = maskedLine.split(' ').filter(Boolean)

    return MINECRAFT_ITEM_NAMES.filter(name => {

        const nameWords = name.split(' ')

        if (nameWords.length !== maskWords.length) return false

        return maskWords.every((mask, i) => {

            const word = nameWords[i]

            if (mask.length !== word.length) return false

            for (let c = 0; c < mask.length; c++) {
                if (mask[c] !== '_' && mask[c].toLowerCase() !== word[c].toLowerCase()) return false
            }

            return true

        })

    })

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

// Bedrock has no JSON chat component tree like Java's - just plain
// text with legacy "§<code>" formatting codes embedded directly.
// Splits text on those codes into the same { text, color } leaf shape
// flattenChatComponents produces, so tryParseTeamInfoLine's member-
// list parsing can work from either source via classifyMemberColor.
// Only the codes that actually matter for online/offline classification
// are mapped - everything else just carries no color (null).
const LEGACY_COLOR_CODES = { a: 'green', 2: 'dark_green', c: 'red', 4: 'dark_red' }

function parseLegacyColorLeaves(text) {

    const leaves = []
    const pattern = /§([0-9a-fk-or])|([^§]+)/gi

    let currentColor = null
    let match

    while ((match = pattern.exec(text)) !== null) {

        if (match[1]) {
            currentColor = LEGACY_COLOR_CODES[match[1].toLowerCase()] || null
        } else if (match[2]) {
            leaves.push({ text: match[2], color: currentColor })
        }

    }

    return leaves

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
// RAW SCOREBOARD TRACKER
// ============================================================
// Replaces mineflayer's bundled ScoreBoard plugin, which is dead on
// this server's protocol version: modern (1.20.3+) scoreboard_score
// packets no longer carry an `action` field at all (removal moved to
// its own reset_score packet), but mineflayer's plugin still gates
// every add on `packet.action === 0` - which is never true anymore,
// since `packet.action` is just undefined. The result is itemsMap
// never gets populated for ANY objective, on this protocol version,
// confirmed via a raw packet capture (sidebar-debug/sidebar-debug-raw)
// that showed real scoreboard_score packets arriving with real
// values while bot.scoreboard.sidebar.items stayed empty. This is
// what silently broke both the KOTH Capture card and the low-HP
// auto-kick feature.
//
// Listens to the raw protocol packets directly instead. Text (title,
// and the newer optional per-score display_name NBT field) is
// resolved through prismarine-chat's fromNotch(), same as mineflayer
// itself does correctly elsewhere (team.js) but its scoreboard.js
// does NOT (it wrongly does JSON.parse(title).text, which only ever
// worked when displayText was a JSON string pre-1.20.3).
class RawScoreboardTracker {

    constructor(bot) {

        this.bot = bot
        this.objectives = new Map() // name -> { titleNbt, entries: Map<itemName, {value, displayNbt}> }
        this.positions = {}         // position (0=list, 1=sidebar, 2=belowName) -> objective name

        const client = bot._client

        client.on('scoreboard_objective', packet => this.onObjective(packet))
        client.on('scoreboard_display_objective', packet => this.onDisplay(packet))
        client.on('scoreboard_score', packet => this.onScore(packet))
        client.on('reset_score', packet => this.onResetScore(packet))

    }

    onObjective(packet) {

        if (packet.action === 0) {
            this.objectives.set(packet.name, { titleNbt: packet.displayText, entries: new Map() })
        } else if (packet.action === 1) {

            this.objectives.delete(packet.name)

            for (const position in this.positions) {
                if (this.positions[position] === packet.name) delete this.positions[position]
            }

        } else if (packet.action === 2) {

            const objective = this.objectives.get(packet.name)

            if (objective) objective.titleNbt = packet.displayText

        }

    }

    onDisplay(packet) {
        this.positions[packet.position] = packet.name
    }

    onScore(packet) {

        const objective = this.objectives.get(packet.scoreName)

        if (!objective) return

        objective.entries.set(packet.itemName, { value: packet.value, displayNbt: packet.display_name || null })

    }

    onResetScore(packet) {

        if (packet.objective_name) {

            const objective = this.objectives.get(packet.objective_name)

            if (objective) objective.entries.delete(packet.entity_name)

        } else {

            for (const objective of this.objectives.values()) {
                objective.entries.delete(packet.entity_name)
            }

        }

    }

    resolveText(nbt) {

        if (nbt === null || nbt === undefined) return ''

        try {
            const ChatMessage = require('prismarine-chat')(this.bot.registry)
            return ChatMessage.fromNotch(nbt).toString()
        } catch {
            return typeof nbt === 'string' ? nbt : ''
        }

    }

    resolveDisplayName(itemName, displayNbt) {

        if (displayNbt) {

            const text = this.resolveText(displayNbt)

            if (text) return text

        }

        // Fall back to the classic "invisible fake name + colored team
        // prefix/suffix" trick, same as mineflayer's own (working)
        // team.displayName().
        const team = this.bot.teamMap?.[itemName]

        if (team) {

            try {
                return team.displayName(itemName).toString()
            } catch {}

        }

        return itemName

    }

    // Same shape as mineflayer's bot.scoreboard.list/.sidebar used to
    // provide: { title, items: [{name, value, displayName}] }, sorted
    // by value descending like the original ScoreBoard.items getter.
    getPosition(position) {

        const name = this.positions[position]

        if (!name) return null

        const objective = this.objectives.get(name)

        if (!objective) return null

        const items = [...objective.entries.entries()]
            .map(([itemName, entry]) => ({
                name: itemName,
                value: entry.value,
                displayName: this.resolveDisplayName(itemName, entry.displayNbt)
            }))
            .sort((a, b) => b.value - a.value)

        return { title: this.resolveText(objective.titleNbt), items }

    }

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
        this.balanceTimer = null
        this.balanceWaitTimer = null
        this.awaitingBalance = false
        this.lastKnownBalance = null

        this.shuttingDown = false

        this.lifeStealReached = false
        this.recoveryRunning = false

        this.reconnectCount = 0
        this.connectedAt = null

        this.lastDisconnectReason = 'None'
        this.lastChatMessage = 'None'
        this.lastChatTime = null
        this.lastServerMessageKey = null

        // Latest action bar (HUD text above the hotbar) - shown in its
        // own read-only card. Treated as stale/cleared after a few
        // seconds with no update, matching how it actually fades out
        // in-game rather than showing old text forever.
        this.lastActionBar = null
        this.lastActionBarAt = 0

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

        // See getPlayerLastSeen() above - lowercased name -> ms epoch,
        // kept fresh every second regardless of dashboard/browser state.
        this.playerLastSeen = getPlayerLastSeen(username)

        // Last 25 successful Auto-Buy purchases - see
        // getBlackMarketPurchaseHistory() and autoBuyBlackMarket().
        this.blackMarketPurchaseHistory = getBlackMarketPurchaseHistory(username)

        // Chat games the bot answered - see recordChatGame().
        this.triviaHistory = getTriviaHistory(username)

        // Who captured each KOTH, how many team points it was worth,
        // and when - shown as a log alongside the Points detail chart.
        // Persisted the same way as teamHistory.
        this.kothHistory = getKothHistory(username)

        // Team deaths that cost points ("Your team has lost 5 points
        // due to <player>'s death."), same shape/persistence as
        // kothHistory - shown merged with it in the Points detail
        // modal so it reads as one "why did our points change" log.
        this.deathHistory = getDeathHistory(username)

        // Every KOTH capture seen server-wide (any team), for the
        // Server Activity feed - kept separate from kothHistory since
        // that one's scoped to our own team only.
        this.serverActivity = getServerActivity(username)

        // Promotions/demotions seen across consecutive /t info
        // captures - see checkRoleChanges().
        this.roleChangeHistory = getRoleChangeHistory(username)

        // Who joined/left/got kicked and when - see logTeamEvent().
        this.teamEventHistory = getTeamEventHistory(username)

        // Every death the bot itself suffers, with the killer's name
        // when the death message named one - see checkNemesisDeath().
        this.nemesisHistory = getNemesisHistory(username)

        // Lifetime badge-unlock counters, independent of the prunable
        // history arrays above.
        this.badgeProgress = getBadgeProgress(username)

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

        // Set to the game's name (e.g. 'math') right after its "X has
        // been chosen!" broadcast, so the very next matching question
        // line is known to belong to that round. 'math' and
        // 'replication' are answered right now - see checkTrivia().
        this.triviaActiveType = null
        // The pending (delayed) answer timer, so it can be cancelled if
        // the round ends (someone wins) before it fires.
        this.triviaTimer = null

        // Auto-reinvited players who have already been kicked for
        // low HP this "episode" - keyed by lowercase name, cleared
        // once their tab-list HP is seen back at/above the threshold
        // (or they drop off the tab list) so they aren't kicked
        // every single tick while they stay critical.
        this.lowHpHandled = new Set()

        // POV viewer (see startPovViewer()) - the port is assigned
        // once and kept for the life of this session so the dashboard
        // link doesn't change across reconnects; povViewerCloseFn
        // tears down the PREVIOUS bot's viewer server before a new one
        // starts on the same port after a reconnect.
        this.povViewerPort = null
        this.povViewerCloseFn = null

        // Bedrock-platform accounts (config.platform === 'bedrock')
        // connect via bedrock-protocol instead of mineflayer - a
        // different client object with none of mineflayer's bot.players/
        // bot.entity/bot.health/bot.inventory abstractions. bedrockPlayers
        // (uuid -> username, from the player_list packet) stands in for
        // bot.players, and bedrockSpawned stands in for bot.entity when
        // computing online status.
        this.bedrockPlayers = new Map()
        this.bedrockSpawned = false

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

        if (this.config.platform === 'bedrock') {

            return [...this.bedrockPlayers.values()]
                .filter(name => name)
                .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))

        }

        if (!this.bot || !this.bot.players) {
            return []
        }

        return Object.keys(this.bot.players)
            .filter(name => name)
            .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))

    }

    // uuid -> current username for everyone currently visible. A real
    // Minecraft username change only takes effect for other clients
    // once that player reconnects, but the UUID never changes - this
    // lets Threats/Allies/Auto-Invite follow someone across a rename
    // instead of silently losing track of them under the old name.
    getUuidToUsername() {

        if (this.config.platform === 'bedrock') {
            return Object.fromEntries(this.bedrockPlayers)
        }

        if (!this.bot || !this.bot.uuidToUsername) {
            return {}
        }

        return { ...this.bot.uuidToUsername }

    }

    // UUID for a currently-visible player, used to tag KOTH/death
    // history entries at the moment they're logged - the player just
    // triggered the event, so they're online right now and findable.
    // Lets the Leaderboard aggregate by UUID instead of name later,
    // so a rename doesn't split one player's totals into two rows
    // (see renderLeaderboard() on the client).
    findUuidForPlayerName(name) {

        const lower = String(name || '').toLowerCase()

        if (!lower) return null

        const uuidToUsername = this.getUuidToUsername()

        for (const uuid in uuidToUsername) {
            if (String(uuidToUsername[uuid] || '').toLowerCase() === lower) {
                return uuid
            }
        }

        return null

    }

    // Reads the live sidebar scoreboard (the "LIFESTEAL / Season.. /
    // KOTH: .. / Capping: .. / Time Left: .." panel in the top-right
    // of the game) via the raw scoreboard tracker (see
    // RawScoreboardTracker - mineflayer's own bot.scoreboard never
    // populates on this server's protocol version).
    getSidebarLines() {

        const sidebar = this.rawScoreboard?.getPosition(1)

        if (!sidebar) {
            return []
        }

        return sidebar.items
            .map(item => item.displayName)
            .filter(line => line && line.trim())

    }

    findSidebarValue(lines, label) {

        const line = lines.find(line => line.includes(`${label}:`))

        if (!line) return null

        const value = line.slice(line.indexOf(`${label}:`) + label.length + 1).trim()

        return value || null

    }

    getKothCaptureStatus() {

        const lines = this.getSidebarLines()

        if (lines.length === 0) {
            return null
        }

        const koth = this.findSidebarValue(lines, 'KOTH')
        const capping = this.findSidebarValue(lines, 'Capping')

        if (!koth || !capping) {
            return null
        }

        return {
            koth,
            capping,
            location: this.findSidebarValue(lines, 'Location'),
            timeLeft: this.findSidebarValue(lines, 'Time Left')
        }

    }

    getTokens() {

        const lines = this.getSidebarLines()
        const raw = this.findSidebarValue(lines, 'Tokens')

        if (!raw) {
            return null
        }

        const numeric = Number(raw.replace(/,/g, ''))

        return Number.isFinite(numeric) ? numeric : raw

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
            return { vote: 0, exclusive: 0, insane: 0, lantern: 0 }
        }

        // Same settle-guard as getInventorySnapshot() - avoid counting
        // keys mid-way through a burst of slot updates.
        if (Date.now() - this.lastInventoryTouchedAt < 150) {
            return this.cachedKeyAmounts
        }

        const result = { vote: 0, exclusive: 0, insane: 0, lantern: 0 }

        for (const item of this.bot.inventory.items()) {

            if (!item) {
                continue
            }

            const itemName = String(item.name || '').toLowerCase()

            // Not a key - a separate Black Market item tallied under
            // its own "Others" category on the Keys card, no mending
            // check needed since it's not disambiguating from a
            // decorative dye the way the key types below are.
            if (itemName === 'lantern') {
                result.lantern += Number(item.count) || 0
                continue
            }

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

    // --------------------------------------------------------
    // DROP ITEMS (Java only - bedrock-protocol has no equivalent
    // inventory-toss API, and the inventory card is empty there anyway)
    // --------------------------------------------------------

    dropReady() {
        if (this.config.platform === 'bedrock') {
            io.to(this.username).emit('notice', { type: 'error', text: 'Dropping items is Java-only.' })
            return false
        }
        if (!this.bot || !this.bot.inventory) {
            io.to(this.username).emit('notice', { type: 'error', text: 'Bot is not connected.' })
            return false
        }
        return true
    }

    // Drops the whole stack in a single inventory slot (the Drop button
    // on each item in the Inventory card sends 'drop <slot>').
    async dropInventorySlot(slotArg) {

        if (!this.dropReady()) return

        const slot = parseInt(slotArg, 10)

        if (!Number.isInteger(slot)) return

        const item = this.bot.inventory.slots[slot]

        if (!item) {
            io.to(this.username).emit('notice', { type: 'error', text: 'That slot is already empty.' })
            return
        }

        const label = item.displayName || item.name
        const count = item.count

        try {
            await this.bot.tossStack(item)
            this.log(`Dropped ${count}x ${label} (slot ${slot}).`)
            io.to(this.username).emit('notice', { type: 'info', text: `Dropped ${count}× ${label}` })
        } catch (err) {
            this.log(`Drop failed (slot ${slot}): ${err.message}`)
            io.to(this.username).emit('notice', { type: 'error', text: `Couldn't drop that: ${err.message}` })
        }

        this.updateDashboard()

    }

    // Drops every stack in the main inventory + hotbar. inventory.items()
    // deliberately excludes the armor and off-hand slots, so this won't
    // throw away equipped gear.
    async dropAllInventory() {

        if (!this.dropReady()) return

        const items = this.bot.inventory.items()

        if (items.length === 0) {
            io.to(this.username).emit('notice', { type: 'info', text: 'Inventory is already empty.' })
            return
        }

        let dropped = 0

        for (const item of items) {
            try {
                await this.bot.tossStack(item)
                dropped++
            } catch (err) {
                this.log(`Drop-all: failed to drop ${item?.name}: ${err.message}`)
            }
        }

        this.log(`Dropped all - ${dropped} stack(s).`)
        io.to(this.username).emit('notice', { type: 'info', text: `Dropped ${dropped} stack(s) (armor & off-hand kept)` })

        this.updateDashboard()

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

        const online = this.config.platform === 'bedrock'
            ? !!(this.bot && this.bedrockSpawned)
            : !!(this.bot && this.bot.entity)
        const keys = online ? this.getKeyAmounts() : { vote: 0, exclusive: 0, insane: 0, lantern: 0 }
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

            povViewerPort: online ? this.povViewerPort : null,

            health: online ? this.bot.health : null,
            maxHealth: online ? this.getMaxHealth() : null,
            food: online ? this.bot.food : null,
            ping: (online && typeof this.bot.player?.ping === 'number') ? this.bot.player.ping : null,

            players,
            playerCount: players.length,
            uuidToUsername: online ? this.getUuidToUsername() : {},
            playerLastSeen: this.playerLastSeen,

            blackMarketAutoBuy: !!this.config.blackMarketAutoBuy,
            blackMarketAutoBuyItems: (Array.isArray(this.config.blackMarketAutoBuyItems) && this.config.blackMarketAutoBuyItems.length > 0)
                ? this.config.blackMarketAutoBuyItems
                : DEFAULT_BLACK_MARKET_ITEMS,
            blackMarketPurchaseHistory: this.blackMarketPurchaseHistory,

            automation: {
                triviaAutoAnswer: this.config.triviaAutoAnswer !== false,
                backupKickEnabled: this.config.backupKickEnabled !== false,
                blackMarketAutoBuy: !!this.config.blackMarketAutoBuy,
                balanceAutoManage: this.config.balanceAutoManage === true
            },
            triviaHistory: this.triviaHistory,

            keys,
            totalKeys: keys.vote + keys.exclusive + keys.insane,
            nextKeyallAt: this.nextKeyallAt,

            lastChat: this.lastChatMessage,
            lastChatTime: this.lastChatTime,
            lastDisconnect: this.lastDisconnectReason,
            connectedAt: this.connectedAt,

            actionBar: (Date.now() - this.lastActionBarAt < 5000) ? this.lastActionBar : null,

            kothCapture: online ? this.getKothCaptureStatus() : null,
            tokens: online ? this.getTokens() : null,

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
                    deathHistory: this.deathHistory,
                    roleChangeHistory: this.roleChangeHistory,
                    teamEventHistory: this.teamEventHistory
                }
                : null,

            serverActivity: this.serverActivity,
            badgeProgress: this.badgeProgress,
            nemesisHistory: this.nemesisHistory,

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

        const time = new Date().toISOString()

        this.lastChatMessage = `<${username}> ${message}`
        this.lastChatTime = time

        io.to(this.username).emit('chat', { username, message, time })

        this.updateDashboard()

    }

    sendMinecraftChat(message) {

        if (!message) {
            return
        }

        if (this.config.platform === 'bedrock') {

            if (!this.bot || !this.bedrockSpawned) {
                originalLog(`[CHAT:${this.username}] Bot is not connected.`)
                return
            }

            this.bot.queue('text', {
                type: 'chat',
                needs_translation: false,
                source_name: this.bot.username,
                xuid: this.bot.profile?.xuid || '',
                platform_chat_id: '',
                filtered_message: '',
                message
            })

            this.log(`Dashboard/terminal sent: ${message}`)

            return

        }

        if (!this.bot || !this.bot.entity) {
            originalLog(`[CHAT:${this.username}] Bot is not connected.`)
            return
        }

        this.bot.chat(message)

        this.log(`Dashboard/terminal sent: ${message}`)

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
    // BALANCE AUTO-MANAGE (opt-in, deposit-only)
    // --------------------------------------------------------

    stopBalanceManager() {
        if (this.balanceTimer) { clearInterval(this.balanceTimer); this.balanceTimer = null }
        if (this.balanceWaitTimer) { clearTimeout(this.balanceWaitTimer); this.balanceWaitTimer = null }
        this.awaitingBalance = false
    }

    startBalanceManager() {

        if (this.config.balanceAutoManage !== true) return
        if (!this.bot || this.shuttingDown) return

        this.stopBalanceManager()

        // First pass once the AFK /home teleport has settled, then on
        // the regular interval. (balanceWaitTimer is reused here only
        // for the one-shot initial delay; requestBalance resets it.)
        this.balanceWaitTimer = setTimeout(() => { this.balanceWaitTimer = null; this.requestBalance() }, HOME_DELAY + BALANCE_RESPONSE_WINDOW)

        this.balanceTimer = setInterval(() => this.requestBalance(), BALANCE_CHECK_INTERVAL)

        this.log('Balance auto-manage: enabled (deposit everything over $7,000,000 every 5 min).')

    }

    // Fires /bal and arms a short window during which the next
    // "has $X" line is read as our balance (see checkBalance).
    requestBalance() {

        if (this.config.balanceAutoManage !== true) { this.stopBalanceManager(); return }
        if (!this.bot || !this.bot.entity || this.shuttingDown || !this.lifeStealReached) return

        this.awaitingBalance = true

        if (this.balanceWaitTimer) clearTimeout(this.balanceWaitTimer)
        this.balanceWaitTimer = setTimeout(() => {
            this.balanceWaitTimer = null
            this.awaitingBalance = false
        }, BALANCE_RESPONSE_WINDOW)

        this.sendMinecraftChat('/bal')

    }

    // Reads the "ECONOMY » <name> has $X" reply to our own /bal and,
    // if we're sitting above the 7m keep line, deposits the excess
    // into the team bank. Only acts inside the window armed by
    // requestBalance(), so other balance lines are ignored.
    checkBalance(text) {

        if (!this.awaitingBalance) return

        const match = text.match(/has \$([\d,]+)/)
        if (!match) return

        this.awaitingBalance = false
        if (this.balanceWaitTimer) { clearTimeout(this.balanceWaitTimer); this.balanceWaitTimer = null }

        const balance = parseInt(match[1].replace(/,/g, ''), 10)
        if (!Number.isFinite(balance)) return

        this.lastKnownBalance = balance

        if (balance > BALANCE_KEEP) {
            const amount = balance - BALANCE_KEEP
            this.sendMinecraftChat(`/t deposit ${amount}`)
            this.log(`Balance auto-manage: $${balance.toLocaleString()} on hand - depositing $${amount.toLocaleString()} to team bank.`)
        } else {
            this.log(`Balance auto-manage: $${balance.toLocaleString()} on hand (<= $7,000,000) - nothing to deposit.`)
        }

    }

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

            const afkCommand = this.config.afkCommand || '/home AFK'

            this.bot.chat(afkCommand)

            this.setState('AFK')

            this.log(`Sent ${afkCommand}.`)

        }, HOME_DELAY)

        // Catch a Black Market that's ALREADY open the moment the bot
        // (re)connects - e.g. a reboot that lands mid-restock, where the
        // "has now opened" broadcast already fired before this process
        // existed, so checkBlackMarket() never sees it. This has to wait
        // until the bot is actually ON LifeSteal (where /bm exists) -
        // the earlier version fired a fixed few seconds after spawn,
        // while the bot was still in the Hub, so /bm did nothing. Runs
        // after the AFK /home teleport above has settled so the two
        // don't collide.
        if (this.config.blackMarketAutoBuy) {

            setTimeout(() => {

                if (!this.bot || !this.bot.entity || this.shuttingDown) return
                if (!this.lifeStealReached) return

                this.log('On LifeSteal - checking Black Market in case it was already open on connect.')
                this.autoBuyBlackMarket()

            }, HOME_DELAY + BLACK_MARKET_RESYNC_DELAY)

        }

        // Start the 5-minute balance auto-manage loop (no-op unless the
        // toggle is on).
        this.startBalanceManager()

        // Rebind the POV viewer to the LifeSteal world. It was first
        // started back on spawn in the Hub; after the server transfer to
        // LifeSteal that WorldView is looking at stale/empty chunks,
        // which is why the POV came up black. Restart it once the AFK
        // /home teleport has settled so it binds to a fully-loaded world.
        setTimeout(() => {
            if (!this.bot || !this.bot.entity || this.shuttingDown) return
            if (!this.lifeStealReached) return
            this.log('On LifeSteal - restarting POV viewer against the loaded world.')
            this.startPovViewer()
        }, HOME_DELAY + BLACK_MARKET_RESYNC_DELAY)

    }

    // Starts (or restarts) prismarine-viewer's live 3D view of what
    // this bot sees, bound to this specific mineflayer bot instance.
    // A reconnect replaces this.bot with a brand new object, so the
    // old viewer (still listening on the old, now-dead bot) has to be
    // torn down and a fresh one started against the new bot - on the
    // SAME port each time, so the dashboard's link to it never
    // changes across reconnects. The short delay on a restart gives
    // the previous http server's close() (async) time to actually
    // release the port before rebinding it.
    startPovViewer() {

        if (!this.bot || !prismarineViewer) return

        const hadPrevious = !!this.povViewerCloseFn

        if (this.povViewerCloseFn) {
            try { this.povViewerCloseFn() } catch {}
            this.povViewerCloseFn = null
        }

        if (!this.povViewerPort) {
            this.povViewerPort = nextPovViewerPort++
        }

        setTimeout(() => {

            if (!this.bot) return

            try {

                prismarineViewer(this.bot, { port: this.povViewerPort, firstPerson: true, viewDistance: 6 })

                this.povViewerCloseFn = () => { try { this.bot?.viewer?.close?.() } catch {} }

                this.log(`POV viewer running on port ${this.povViewerPort}.`)

            } catch (error) {

                this.log(`POV viewer failed to start: ${error.message}`)

            }

        }, hadPrevious ? 500 : 0)

    }

    stopPovViewer() {

        if (this.povViewerCloseFn) {
            try { this.povViewerCloseFn() } catch {}
            this.povViewerCloseFn = null
        }

    }

    // --------------------------------------------------------
    // MANUAL MOVEMENT (Java only - driven live from the POV card's
    // on-screen pad / keyboard; bedrock-protocol has no setControlState)
    // --------------------------------------------------------

    static MOVE_CONTROLS = ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']

    // Press/release one movement control. keydown -> state true,
    // keyup -> state false, so held keys keep the bot walking.
    setMovement(action, state) {

        if (this.config.platform === 'bedrock') return
        if (!this.bot || !this.bot.entity) return
        if (!BotSession.MOVE_CONTROLS.includes(action)) return

        try {
            this.bot.setControlState(action, !!state)
        } catch (err) {
            this.log(`Move (${action}) failed: ${err.message}`)
        }

    }

    // Safety net: release everything (card unmounted, tab blurred, bot
    // disconnecting) so it doesn't keep walking into a wall forever.
    stopAllMovement() {

        if (!this.bot) return

        for (const action of BotSession.MOVE_CONTROLS) {
            try { this.bot.setControlState(action, false) } catch {}
        }

    }

    // Nudge the look direction by a yaw/pitch delta (radians). Pitch is
    // clamped to straight-up / straight-down.
    turnBot(dYaw, dPitch) {

        if (this.config.platform === 'bedrock') return
        if (!this.bot || !this.bot.entity) return

        const yaw = this.bot.entity.yaw + (Number(dYaw) || 0)
        let pitch = this.bot.entity.pitch + (Number(dPitch) || 0)

        const limit = Math.PI / 2
        if (pitch > limit) pitch = limit
        if (pitch < -limit) pitch = -limit

        try {
            this.bot.look(yaw, pitch, false)
        } catch (err) {
            this.log(`Look failed: ${err.message}`)
        }

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

        const afkCommand = this.config.afkCommand || '/home AFK'

        this.bot.chat(afkCommand)

        this.setState('AFK')

        this.log(`Sent ${afkCommand}.`)

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

        const connected = this.config.platform === 'bedrock'
            ? !!(this.bot && this.bedrockSpawned)
            : !!(this.bot && this.bot.entity)

        if (connected) {
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

        const connected = this.config.platform === 'bedrock'
            ? !!(this.bot && this.bedrockSpawned)
            : !!(this.bot && this.bot.entity)

        if (!this.botEnabled && !connected) {
            originalLog(`[REMOTE:${this.username}] Stop requested, but the bot is already stopped.`)
            return
        }

        originalLog(`[REMOTE:${this.username}] Stopping bot from dashboard...`)

        this.log('Bot stop requested from dashboard.')

        this.botEnabled = false

        this.stopJqRetry()
        this.stopHomeTimer()
        this.stopRecoveryTimer()
        this.stopPovViewer()

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }

        this.currentWorld = 'Stopped'
        this.setState('STOPPED')

        if (this.bot) {

            try {

                if (this.config.platform === 'bedrock') {
                    this.bot.disconnect('Stopped via dashboard')
                } else {
                    this.bot.quit('Stopped via dashboard')
                }

            } catch {}

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

        // Tracked teammates first - those are the ones whose HP we're
        // trying to recover from the tab list - then a few others.
        const tracked = new Set((Array.isArray(this.config.autoReinvite) ? this.config.autoReinvite : [])
            .map(entry => ((typeof entry === 'string' ? entry : entry?.name) || '').toLowerCase())
            .filter(Boolean))

        const ordered = names.slice().sort((a, b) => {
            const ta = tracked.has(a.toLowerCase()) ? 0 : 1
            const tb = tracked.has(b.toLowerCase()) ? 0 : 1
            return ta - tb
        })

        const belowObj = this.rawScoreboard?.getPosition(2)

        for (const name of ordered.slice(0, 12)) {

            const player = this.bot.players[name]
            const dn = player?.displayName

            // toMotd() keeps the §-colour codes (toString() strips them);
            // JSON.stringify escapes any custom-font glyphs to \uXXXX so
            // they're readable. The colour is where HP is most likely
            // encoded if it's in the tab list at all.
            let motd = '(no display name)'
            try { motd = dn?.toMotd?.() ?? dn?.toString?.() ?? String(dn) } catch { motd = String(dn) }

            const hp = belowObj?.items.find(item => item.name === name)?.value ?? '-'
            const flag = tracked.has(name.toLowerCase()) ? '*' : ' '

            io.to(this.username).emit('chat', {
                username: 'DEBUG',
                message: `${flag}${name} hp=${hp}: ${JSON.stringify(motd)}`,
                time: new Date().toISOString()
            })

        }

    }

    // One-off diagnostic for the KOTH Capture card: dumps every raw
    // line currently on the sidebar scoreboard (JSON-escaped, so any
    // custom font / private-use-area icon characters show up as
    // \uXXXX instead of invisible squares), since getKothCaptureStatus()
    // depends on exact label text ("KOTH:", "Capping:", etc.) that was
    // guessed from a screenshot and never confirmed against the real
    // packets. Trigger from the browser console with:
    //   sendCommand('sidebar-debug')
    debugSidebar() {

        const sidebar = this.rawScoreboard?.getPosition(1)

        if (!sidebar) {
            io.to(this.username).emit('notice', { type: 'error', text: 'No sidebar scoreboard is active right now.' })
            originalLog(`[SIDEBAR-DEBUG:${this.username}] No sidebar scoreboard is active right now.`)
            return
        }

        const lines = [`sidebar title: ${JSON.stringify(sidebar.title)}`]

        for (const item of sidebar.items) {
            lines.push(`[${item.value}] ${JSON.stringify(item.displayName)}`)
        }

        // Printed via originalLog too (not just the socket) so this is
        // readable straight from the server console/SSH, without needing
        // a logged-in browser session.
        originalLog(`[SIDEBAR-DEBUG:${this.username}]`)
        for (const line of lines) originalLog(`  ${line}`)

        for (const line of lines) {

            io.to(this.username).emit('chat', {
                username: 'DEBUG',
                message: line,
                time: new Date().toISOString()
            })

        }

    }

    // Deeper follow-up to sidebar-debug: that one came back with an
    // empty item list even though the sidebar clearly has content in
    // game, and its title arrived as raw NBT instead of the older
    // JSON-string format mineflayer's bundled ScoreBoard class expects -
    // a sign this server's protocol version may have moved past what
    // that wrapper understands. This bypasses the wrapper and listens
    // to the raw scoreboard_objective/_display_objective/_score packets
    // directly for a few seconds, dumping exactly what's on the wire
    // (including the newer per-score "display_name" NBT field the
    // wrapper doesn't read at all) so the real fix can be worked out
    // from actual data instead of guessing further. Trigger from the
    // browser console with:
    //   sendCommand('sidebar-debug-raw')
    debugSidebarRaw() {

        if (!this.bot || !this.bot._client) {
            io.to(this.username).emit('notice', { type: 'error', text: 'Bot is not connected.' })
            return
        }

        const emitLine = (line) => {
            originalLog(`[SIDEBAR-RAW:${this.username}] ${line}`)
            io.to(this.username).emit('chat', { username: 'DEBUG', message: line, time: new Date().toISOString() })
        }

        emitLine('Capturing raw scoreboard packets for 8 seconds - keep the KOTH capture going...')

        const onObjective = (packet) => {
            emitLine(`objective action=${packet.action} name=${JSON.stringify(packet.name)} displayText=${JSON.stringify(packet.displayText)}`)
        }

        const onDisplay = (packet) => {
            emitLine(`display position=${packet.position} name=${JSON.stringify(packet.name)}`)
        }

        const onScore = (packet) => {
            emitLine(`score itemName=${JSON.stringify(packet.itemName)} scoreName=${JSON.stringify(packet.scoreName)} value=${packet.value} display_name=${JSON.stringify(packet.display_name)}`)
        }

        this.bot._client.on('scoreboard_objective', onObjective)
        this.bot._client.on('scoreboard_display_objective', onDisplay)
        this.bot._client.on('scoreboard_score', onScore)

        setTimeout(() => {

            this.bot._client.removeListener('scoreboard_objective', onObjective)
            this.bot._client.removeListener('scoreboard_display_objective', onDisplay)
            this.bot._client.removeListener('scoreboard_score', onScore)

            emitLine('Done capturing.')

        }, 8000)

    }

    // Definitive check for which scoreboard objective (and what
    // units) actually carry HP, for the low-HP auto-kick feature.
    // checkAutoInviteLowHealth() currently reads position 2
    // (belowName) as its best guess - a raw packet capture showed
    // that objective's values vary per player (30/10/10) while
    // position 0 (the tab-list objective the OLD, since-removed
    // version of this feature used) sat flat at 0 for every player
    // sampled - but that's circumstantial, not proven. This
    // correlates the bot's OWN live health (bot.health, from the
    // always-reliable update_health packet, entirely independent of
    // the scoreboard) against both objectives' values for the bot's
    // own name, live, for 30 seconds. Take damage or heal during the
    // window to see which one (if either) actually tracks, and in
    // what units. Trigger from the browser console with:
    //   sendCommand('sidebar-debug-hp')
    debugHpSource() {

        if (!this.bot) {
            io.to(this.username).emit('notice', { type: 'error', text: 'Bot is not connected.' })
            return
        }

        const emitLine = (line) => {
            originalLog(`[HP-DEBUG:${this.username}] ${line}`)
            io.to(this.username).emit('chat', { username: 'DEBUG', message: line, time: new Date().toISOString() })
        }

        emitLine(`Watching for 30 seconds - take damage or heal the bot's account now if you can. bot.health right now: ${this.bot.health}`)

        const report = () => {

            const list = this.rawScoreboard?.getPosition(0)
            const belowName = this.rawScoreboard?.getPosition(2)

            const listEntry = list?.items.find(item => item.name === this.bot.username)
            const belowNameEntry = belowName?.items.find(item => item.name === this.bot.username)

            emitLine(`bot.health=${this.bot.health}  list(0)=${listEntry?.value ?? '-'}  belowName(2)=${belowNameEntry?.value ?? '-'}`)

            // Also dump every Auto-Invite tracked teammate's HP from both
            // slots - this is what the low-HP auto-kick actually reads,
            // and the bot being AFK means slot 2 is usually empty for
            // anyone off fighting while slot 0 (tab list) still has them.
            const tracked = (Array.isArray(this.config.autoReinvite) ? this.config.autoReinvite : [])
                .map(entry => (typeof entry === 'string' ? entry : entry?.name) || '')
                .filter(Boolean)

            for (const name of tracked) {
                const l = list?.items.find(item => item.name === name)
                const b = belowName?.items.find(item => item.name === name)
                const online = this.bot.players && this.bot.players[name] ? 'online' : 'offline'
                const inTeam = this.isTeamMember(name) ? 'in-team' : 'NOT-in-team'
                emitLine(`  ${name}: list(0)=${l?.value ?? '-'}  belowName(2)=${b?.value ?? '-'}  (${online}, ${inTeam})`)
            }

        }

        report()

        const onHealth = () => report()

        this.bot.on('health', onHealth)

        setTimeout(() => {

            this.bot.removeListener('health', onHealth)

            emitLine('Done watching.')

        }, 30000)

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
                time: new Date().toISOString()
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
                    time: new Date().toISOString()
                })

            }

            return entries

        }

        io.to(this.username).emit('notice', { type: 'info', text: 'Opening /bm to inspect it...' })

        this.bot.once('windowOpen', shopWindow => {

            const entries = dumpWindow(shopWindow, 'SHOP')

            // Confirmed: the Insane Key's underlying item is
            // minecraft:red_dye (item.name === 'red_dye' in mineflayer,
            // no namespace prefix) - checked first since it's the most
            // reliable signal, with the lore-text match kept as a
            // fallback/corroboration.
            const target = entries.find(({ item }) =>
                item.name === 'red_dye' ||
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
        originalLog(`Time: ${this.lastChatTime ? new Date(this.lastChatTime).toLocaleString() : 'None'}`)
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
        originalLog('╠══════════════════════════════════════╣')
        originalLog(`║ KOTH Starters:  ${String(keys.lantern).padEnd(17)}║`)
        originalLog('╚══════════════════════════════════════╝')
        originalLog('')

        this.log(`Keys: Vote=${keys.vote}, Exclusive=${keys.exclusive}, Insane=${keys.insane}, Total=${total}, KOTH Starters=${keys.lantern}`)

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

        // A capture already in flight means an earlier /t info was
        // just sent and its response hasn't arrived yet. Starting a
        // fresh capture here doesn't stop that response from showing
        // up - it lands in this new, empty capture instead, and can
        // finalize it early with a missing header (points show as
        // blank on the card). Let the in-flight one finish on its own
        // rather than resetting it; join/leave/kick/KOTH triggers can
        // fire in quick succession, especially during a mass leave.
        if (this.teamInfoCapture) {
            return
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

        if (labelMatch && (json || this.config.platform === 'bedrock')) {

            const label = labelMatch[1].trim()

            // Java sends a rich JSON chat component tree, one child per
            // member, so each leaf is already exactly one name. Bedrock
            // has no such tree - only the raw text with legacy "§<code>"
            // formatting codes - and a single colored run can contain
            // several comma-separated names together, so those need
            // splitting on top of the usual leaf extraction.
            const flat = json ? flattenChatComponents(json) : parseLegacyColorLeaves(text)
            const members = []

            for (const leaf of flat) {

                const pieces = json ? [leaf.text] : String(leaf.text || '').split(',')

                for (const piece of pieces) {

                    const value = (piece || '').trim()

                    if (!value) continue
                    if (value === `${label}:`) continue
                    if (/^[[\],]+$/.test(value)) continue
                    if (/^\d+$/.test(value)) continue

                    members.push({ name: value, online: classifyMemberColor(leaf.color) })

                }

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

    // Watches for the same "X has joined the team." broadcast and,
    // if that player has a permanent rank assigned (set from the Team
    // card - see /api/perm-ranks/set), promotes them back up to it.
    // Rejoining a team resets a player to plain Member rank, so
    // someone who was Officer/Captain before leaving/getting kicked
    // would otherwise need re-promoting by hand every single time.
    // FlareMC's rank ladder only has a single /t promote step between
    // each rank, so Officer needs one, Captain needs two run back to
    // back - staggered slightly so the second isn't sent before the
    // server's finished applying the first.
    checkAutoPromote(text) {

        const match = text.match(/^TEAMS ➟ (.+?) has joined the team\.?$/i)

        if (!match) return

        const username = match[1].trim()

        // The captured name goes into a /t promote command below, so
        // only ever act on something that's actually a valid Minecraft
        // username - never pass arbitrary parsed chat text into a
        // command the bot runs.
        if (!/^[a-zA-Z0-9_]{1,16}$/.test(username)) return

        const list = Array.isArray(this.config.permRanks) ? this.config.permRanks : []

        const entry = list.find(item => (item?.name || '').toLowerCase() === username.toLowerCase())

        if (!entry) return

        const promotions = entry.rank === 'captain' ? 2 : entry.rank === 'officer' ? 1 : 0

        if (promotions === 0) return

        this.log(`${username} rejoined with a permanent ${entry.rank} rank - promoting ${promotions}x.`)

        for (let i = 0; i < promotions; i++) {
            setTimeout(() => this.sendMinecraftChat(`/t promote ${username}`), 500 + i * 700)
        }

        io.to(this.username).emit('notice', { type: 'success', text: `Promoting ${username} back to ${entry.rank}` })

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
    // team deaths ("Your team has lost 5 points due to <player>'s
    // death.") - and a teammate's own online/offline status flipping
    // ("TEAMS ➟ <player> is now offline!"), which is separate from
    // joining/leaving/kicked and wasn't updating the member dots
    // promptly before.
    checkTeamRosterChange(text) {

        const joinLeftMatch = text.match(/^TEAMS ➟ (.+?) has (joined|left) the team\.?$/i)
        const kickedMatch = !joinLeftMatch && text.match(/^TEAMS ➟ (.+?) has been kicked\b/i)

        const isRosterChange =
            !!joinLeftMatch ||
            !!kickedMatch ||
            /^TEAMS ➟ .+ is now (online|offline)!?$/i.test(text) ||
            /\bKOTH has been captured!?$/i.test(text) ||
            /\bhas received\b.*\bteam points\b/i.test(text) ||
            /\byour team has lost \d+ points? due to\b/i.test(text)

        if (!isRosterChange) return

        if (joinLeftMatch) {
            this.logTeamEvent(joinLeftMatch[1].trim(), joinLeftMatch[2].toLowerCase())
        } else if (kickedMatch) {
            this.logTeamEvent(kickedMatch[1].trim(), 'kicked')
        }

        // A burst of these (e.g. several people leaving/getting
        // kicked at once) shouldn't each fire their own /t info -
        // one refresh a couple seconds later covers all of them.
        if (Date.now() - this.lastTeamRefreshRequestAt < 2000) return

        this.lastTeamRefreshRequestAt = Date.now()

        this.requestTeamInfo()

    }

    // Persists a joined/left/kicked event for the Team Detail modal's
    // Activity Log - these used to only ever trigger a silent /t info
    // refresh, with no lasting record of who actually joined/left/got
    // kicked or when.
    logTeamEvent(player, type) {

        this.teamEventHistory.push({ timestamp: Date.now(), player, type })
        this.teamEventHistory = this.teamEventHistory.slice(-50)

        saveTeamEventHistory(this.username, this.teamEventHistory)

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

    isOnAutoReinvite(name) {
        const list = Array.isArray(this.config.autoReinvite) ? this.config.autoReinvite : []
        const lower = name.toLowerCase()
        return list.some(entry => String((typeof entry === 'string' ? entry : entry?.name) || '').toLowerCase() === lower)
    }

    // True if this name is a teammate we trust for whisper commands - on
    // the team roster OR on the Auto-Invite list. Gating to trusted names
    // stops a random enemy from spamming the bot into a mute.
    isTrustedTeammate(name) {
        return this.isTeamMember(name) || this.isOnAutoReinvite(name)
    }

    // Core of the backup kick: given a sender + their private message, kick
    // them if it carries the code word and they're a trusted teammate.
    applyBackupKick(sender, message) {

        if (this.config.backupKickEnabled === false) return

        sender = String(sender || '').trim()
        message = String(message || '')

        if (!/^[A-Za-z0-9_]{1,16}$/.test(sender)) return
        if (!message.toLowerCase().includes(BACKUP_KICK_CODEWORD)) return
        if (sender.toLowerCase() === (this.bot?.username || '').toLowerCase()) return
        if (!this.isTrustedTeammate(sender)) return

        // Reinvite only if they're on the Auto-Invite list. A teammate who
        // is on the team but NOT on that list gets kicked and stays out
        // (they asked to leave); someone on the list gets kicked and
        // brought straight back (temporary low-HP protection).
        const reinvite = this.isOnAutoReinvite(sender)

        this.log(`Backup kick: ${sender} sent the code word via /msg - kicking${reinvite ? ' and reinviting' : ' (no reinvite - not on Auto-Invite list)'}.`)
        io.to(this.username).emit('notice', { type: 'info', text: `🔒 Backup kick: ${sender} used the code word — kicking${reinvite ? ' and reinviting' : ' (no reinvite)'}.` })

        this.sendMinecraftChat(`/t kick ${sender}`)
        if (reinvite) {
            setTimeout(() => { if (this.bot) this.sendMinecraftChat(`/t invite ${sender}`) }, 350)
        }

    }

    // Java: whispers arrive as a chat line like "X whispers to you: ...",
    // so parse the sender/message out first, then dispatch.
    checkWhisperCommand(text) {
        const parsed = parseIncomingWhisper(text)
        if (parsed) this.handleWhisperCommand(parsed.sender, parsed.message)
    }

    // Replies to a whisper via /msg, one line per message, staggered so the
    // server's chat anti-spam doesn't mute the bot. Capped and truncated.
    whisperReply(sender, lines) {
        if (!this.bot) return
        lines.slice(0, 6).forEach((line, i) => {
            setTimeout(() => {
                if (this.bot) this.sendMinecraftChat(`/msg ${sender} ${String(line).slice(0, 230)}`)
            }, i * 450)
        })
    }

    whisperStatusLines() {
        const online = !!(this.bot && this.bot.entity)
        const hp = online && this.bot.health != null ? `${Math.round(this.bot.health)}/${Math.round(this.getMaxHealth() || 20)}` : '-'
        const food = online && this.bot.food != null ? this.bot.food : '-'
        const ping = online && typeof this.bot.player?.ping === 'number' ? `${this.bot.player.ping}ms` : '-'
        return [
            `Voidz.IO — ${this.botState} | ${this.currentWorld}`,
            `HP ${hp} | Food ${food} | Ping ${ping} | Up ${this.formatUptime()}`
        ]
    }

    whisperTeamLines() {
        const h = this.teamRoster && this.teamRoster.header
        if (!h) return ['No team info captured yet — try again shortly.']
        return [`Team ${h.name || '?'} | Size ${h.current ?? '?'}/${h.max ?? '?'} | ${h.points ?? '?'} pts`]
    }

    // sudo (make the bot type/run arbitrary text) is extra-gated behind a
    // passcode. On a locked sudo the bot generates a 6-digit code shown ONLY
    // on the owner's dashboard (so a teammate can't self-authorize) and asks
    // for it; once answered, that sender gets 3 sudo uses for 5 minutes. The
    // triggering command is queued and runs the moment it's unlocked.
    handleSudo(sender, message) {

        const payload = message.replace(/^sudo\s+/i, '').trim()

        if (!payload) {
            this.whisperReply(sender, ['Usage: sudo <text or /command> — makes the bot type/run it.'])
            return
        }

        const key = sender.toLowerCase()
        const now = Date.now()

        if (!this.sudoAuth) this.sudoAuth = new Map()
        const auth = this.sudoAuth.get(key)

        if (auth && auth.until > now && auth.usesLeft > 0) {
            this.runSudo(sender, payload, auth)
            return
        }

        // Locked - the sender needs the passcode. Queue the command so it
        // runs the moment they send it. Nothing is shown anywhere: the
        // passcode is a fixed secret they're expected to already know.
        if (!this.sudoPending) this.sudoPending = new Map()
        this.sudoPending.set(key, { payload, expiresAt: now + 5 * 60 * 1000 })

        io.to(this.username).emit('notice', { type: 'info', text: `🔑 ${sender} is trying to sudo — awaiting passcode.` })
        this.whisperReply(sender, ['Sudo is locked. Whisper the passcode to unlock it (3 commands / 5 min).'])
        this.log(`Sudo challenge issued for ${sender} (awaiting passcode).`)

    }

    // Runs one sudo command and decrements that sender's remaining uses.
    runSudo(sender, payload, auth) {
        auth.usesLeft--
        if (auth.usesLeft <= 0) this.sudoAuth.delete(sender.toLowerCase())
        this.log(`Whisper sudo from ${sender}: ${payload}`)
        io.to(this.username).emit('notice', { type: 'info', text: `💬 ${sender} via sudo: ${payload}` })
        this.sendMinecraftChat(payload)
    }

    // Whispering the passcode unlocks 3 sudo uses for 5 minutes and runs any
    // command that was queued by a locked sudo. A wrong passcode only gets a
    // reply if a sudo was actually pending (so stray number whispers are
    // ignored).
    trySudoUnlock(sender, code) {

        const key = sender.toLowerCase()
        const pending = this.sudoPending && this.sudoPending.get(key)

        if (String(code) !== SUDO_PASSCODE) {
            if (pending) this.whisperReply(sender, ['Wrong passcode.'])
            return
        }

        if (pending) this.sudoPending.delete(key)

        if (!this.sudoAuth) this.sudoAuth = new Map()
        const auth = { until: Date.now() + 5 * 60 * 1000, usesLeft: 3 }
        this.sudoAuth.set(key, auth)

        this.log(`Sudo unlocked for ${sender}.`)
        this.whisperReply(sender, ['Sudo unlocked — 3 commands for 5 minutes.'])

        // Run the command that triggered the challenge, if one was queued and
        // hasn't expired (uses one of the 3).
        if (pending && pending.payload && pending.expiresAt >= Date.now()) {
            this.runSudo(sender, pending.payload, auth)
        }

    }

    // Remote control by /msg. A trusted teammate whispers the bot a command
    // and the bot replies (info commands) or acts (hub/afk/ls) - and still
    // handles the backup-kick code word. Gated to trusted teammates + a
    // short per-sender cooldown so it can't be spammed into a mute.
    handleWhisperCommand(sender, message) {

        sender = String(sender || '').trim()
        message = String(message || '').trim()

        if (!/^[A-Za-z0-9_]{1,16}$/.test(sender)) return
        if (sender.toLowerCase() === (this.bot?.username || '').toLowerCase()) return
        if (!this.isTrustedTeammate(sender)) return

        const now = Date.now()
        if (!this.whisperCmdCooldown) this.whisperCmdCooldown = new Map()
        if (now - (this.whisperCmdCooldown.get(sender.toLowerCase()) || 0) < 1500) return
        this.whisperCmdCooldown.set(sender.toLowerCase(), now)

        const cmd = message.toLowerCase()
        const word = cmd.split(/\s+/)[0]

        // Whispering just the passcode (optionally "code <passcode>") is
        // treated as unlocking sudo.
        const codeEntry = message.trim().match(/^(?:code\s+)?(\d{4,12})$/i)
        if (codeEntry) {
            this.trySudoUnlock(sender, codeEntry[1])
            return
        }

        switch (word) {

            case 'cmdhelp':
            case 'commands':
            case 'help':
                this.whisperReply(sender, ['Commands (whisper me): cmdhelp, status, players, where, keys, team, hub, afk, ls, sudo <text>'])
                return

            case 'sudo':
                this.handleSudo(sender, message)
                return

            case 'status':
                this.whisperReply(sender, this.whisperStatusLines())
                return

            case 'players':
                this.whisperReply(sender, [`Players visible: ${this.getVisiblePlayers().length}`])
                return

            case 'where':
                this.whisperReply(sender, [`World: ${this.currentWorld} | State: ${this.botState}`])
                return

            case 'keys': {
                const k = this.getKeyAmounts ? this.getKeyAmounts() : null
                this.whisperReply(sender, k
                    ? [`Keys — Vote ${k.vote}, Exclusive ${k.exclusive}, Insane ${k.insane} | KOTH Starters ${k.lantern}`]
                    : ['Keys unavailable right now.'])
                return
            }

            case 'team':
                this.whisperReply(sender, this.whisperTeamLines())
                return

            case 'hub':
                this.whisperReply(sender, ['On it — going to hub.'])
                this.goHub()
                return

            case 'afk':
                this.whisperReply(sender, ['On it — going AFK.'])
                this.goAfk()
                return

            case 'ls':
            case 'lifesteal':
                this.whisperReply(sender, ['On it — heading to LifeSteal.'])
                this.manualLifeSteal()
                return

        }

        // Not a named command - fall through to the backup-kick code word.
        if (cmd.includes(BACKUP_KICK_CODEWORD)) {
            this.applyBackupKick(sender, message)
        }

    }

    // Checks every badge definition against the current lifetime
    // counters and unlocks any that just became true. Called after
    // whatever counter it might affect changes (a KOTH capture, a new
    // points high). Cheap to call unconditionally - it's a handful of
    // number comparisons against an object already in memory.
    checkBadges() {

        let unlockedSomething = false

        for (const badge of BADGE_DEFINITIONS) {

            if (this.badgeProgress.unlockedBadges[badge.id]) continue
            if (!badge.check(this.badgeProgress)) continue

            this.badgeProgress.unlockedBadges[badge.id] = Date.now()
            unlockedSomething = true

            this.log(`Badge unlocked: ${badge.name}`)

            io.to(this.username).emit('notice', {
                type: 'success',
                text: `${badge.icon} Badge unlocked: ${badge.name}`
            })

        }

        if (unlockedSomething) {
            saveBadgeProgress(this.username, this.badgeProgress)
        }

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

    // Kicks a team member via /t kick - triggered from the Kick
    // button next to a name in the Team card. The name comes from
    // the client, so it's validated against real Minecraft username
    // rules before ever reaching sendMinecraftChat - otherwise a
    // crafted name with a space/slash in it could inject an arbitrary
    // chat command.
    kickTeamMember(name) {

        const trimmed = String(name || '').trim()

        if (!/^[a-zA-Z0-9_]{1,16}$/.test(trimmed)) {
            io.to(this.username).emit('notice', { type: 'error', text: 'Invalid username.' })
            return
        }

        this.log(`Kicking ${trimmed} from the team (manual).`)

        this.sendMinecraftChat(`/t kick ${trimmed}`)

        io.to(this.username).emit('notice', { type: 'info', text: `Kicked ${trimmed} from the team.` })

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

    // Removes a single Points reading from the chart - right-click a
    // point on the detail chart on the dashboard. Matched by exact
    // timestamp (unique per reading, assigned in requestTeamInfo).
    removeTeamHistoryReading(timestampRaw) {

        const timestamp = Number(timestampRaw)

        if (!Number.isFinite(timestamp)) return

        const before = this.teamHistory.length

        this.teamHistory = this.teamHistory.filter(entry => entry.timestamp !== timestamp)

        if (this.teamHistory.length === before) {
            io.to(this.username).emit('notice', { type: 'error', text: 'Reading not found (already removed?).' })
            return
        }

        saveTeamHistory(this.username, this.teamHistory)

        io.to(this.username).emit('notice', { type: 'success', text: 'Reading removed.' })

        this.updateDashboard()

    }

    // Logs who captured a KOTH and how many team points it was worth,
    // parsed from "<player> has received Nx PvP Keys and N Team
    // Points!" - shown as a history list alongside the Points detail
    // chart on the dashboard. Not anchored to a specific prefix since
    // the exact glyph/icon in front of the player name isn't known.
    // This broadcast is server-wide (every team's captures show up in
    // it), so it's logged to serverActivity regardless of team, but
    // only counted toward our own kothHistory/leaderboard/badges when
    // it's actually one of ours.
    checkKothCapture(text) {

        const match = cleanMessage(text).match(
            /([A-Za-z0-9_]{1,16}) has received \d+x PvP Keys and (\d+) Team Points!?/i
        )

        if (!match) return

        const isOwnTeam = this.isTeamMember(match[1])

        this.serverActivity.push({
            timestamp: Date.now(),
            player: match[1],
            points: Number(match[2]),
            isOwnTeam
        })

        this.serverActivity = this.serverActivity.slice(-100)

        saveServerActivity(this.username, this.serverActivity)

        if (!isOwnTeam) return

        this.kothHistory.push({
            timestamp: Date.now(),
            player: match[1],
            uuid: this.findUuidForPlayerName(match[1]),
            points: Number(match[2])
        })

        this.kothHistory = this.kothHistory.slice(-50)

        saveKothHistory(this.username, this.kothHistory)

        this.log(`KOTH captured by ${match[1]} (+${match[2]} team points)`)

        this.badgeProgress.totalKothCaptures++

        saveBadgeProgress(this.username, this.badgeProgress)

        this.checkBadges()

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
            uuid: this.findUuidForPlayerName(match[2]),
            points: -Number(match[1])
        })

        this.deathHistory = this.deathHistory.slice(-50)

        saveDeathHistory(this.username, this.deathHistory)

        this.log(`${match[2]} died (-${match[1]} team points)`)

    }

    // Compares the roster just finished against the one from the
    // previous /t info capture and logs anyone whose role changed -
    // promoted or demoted, by anyone, not just through the perm-rank
    // feature. Skipped on the very first capture (nothing to diff
    // against yet - previousMembers is empty then).
    checkRoleChanges(previousMembers, newMembers) {

        if (previousMembers.length === 0) return

        const previousRoleByName = new Map(
            previousMembers.map(member => [member.name.toLowerCase(), member.role])
        )

        for (const member of newMembers) {

            const previousRole = previousRoleByName.get(member.name.toLowerCase())

            if (!previousRole || previousRole === member.role) continue

            this.roleChangeHistory.push({
                timestamp: Date.now(),
                player: member.name,
                fromRole: previousRole,
                toRole: member.role
            })

            this.roleChangeHistory = this.roleChangeHistory.slice(-50)

            saveRoleChangeHistory(this.username, this.roleChangeHistory)

            this.log(`${member.name} role changed: ${previousRole} -> ${member.role}`)

            io.to(this.username).emit('notice', {
                type: 'info',
                text: `${member.name}: ${previousRole} → ${member.role}`,
                logActivity: true
            })

        }

    }

    // Tallies who's actually killed the bot, from its own death
    // message ("<BotName> was slain by <Killer>" and the many other
    // vanilla death-message verbs - "was ... by <Name>" covers them
    // generically). Not every death names a killer (fell, drowned,
    // etc. have no "by <Name>" at all), which is fine - those just
    // don't match and nothing gets logged for them.
    checkNemesisDeath(text) {

        const botName = this.bot?.username

        if (!botName) return

        const match = cleanMessage(text).match(
            new RegExp(`^${botName} was .*? by ([A-Za-z0-9_]{1,16})\\b`, 'i')
        )

        if (!match) return

        const killer = match[1]

        this.nemesisHistory.push({
            timestamp: Date.now(),
            killer
        })

        this.nemesisHistory = this.nemesisHistory.slice(-200)

        saveNemesisHistory(this.username, this.nemesisHistory)

        this.log(`Died to ${killer}.`)

    }

    // Runs every dashboard tick (~1s) while connected - see
    // getPlayerLastSeen() for why this exists. Refreshes at most once
    // per 30s per name (not every single tick) to keep the debounced
    // disk write cheap while still being vastly more current than the
    // old "only while a browser tab happens to be open" behavior.
    touchOnlinePlayers() {

        const now = Date.now()
        let changed = false

        const names = this.config.platform === 'bedrock'
            ? Array.from(this.bedrockPlayers.values())
            : (this.bot && this.bot.players ? Object.keys(this.bot.players) : [])

        for (const name of names) {

            const key = name.toLowerCase()
            const last = this.playerLastSeen[key] || 0

            if (now - last > 30000) {
                this.playerLastSeen[key] = now
                changed = true
            }

        }

        if (changed) {
            savePlayerLastSeen(this.username, this.playerLastSeen)
        }

    }

    // Runs every dashboard tick (~1s) while connected. Any Auto-Invite
    // tracked player whose tab-list HP drops to 5 hearts (10 HP) or
    // below gets kicked off the team and immediately reinvited - kicking
    // drops them from `/t info` shared-location tracking before an
    // enemy can use it against them at low HP, and the reinvite
    // brings them straight back in once they're safe. `lowHpHandled`
    // stops this firing every tick while someone stays critical.
    //
    // Requires BOTH: on the Auto-Invite list AND currently a member of
    // the team per the last /t info capture (isTeamMember(), the same
    // roster checkTeamDeath()/checkKothCapture() trust) - being merely
    // online on the server isn't enough. A player who's online but not
    // actually in the team yet (mid-invite, just got kicked, never
    // accepted) would previously still pass the old online-only check
    // and get a pointless /t kick sent for someone who isn't on the
    // team to begin with - which does nothing, silently, and reads as
    // "doesn't always work" from the dashboard with no error to show
    // for it.
    //
    // Another player's HP on FlareMC comes from the tab-list scoreboard
    // objective (display slot 0, "list") - it's server-wide, so it's
    // there even when the player is nowhere near the AFK bot. The "below
    // name" objective (slot 2) only populates for players in render
    // range of the bot, which is why reading slot 2 alone silently
    // missed any teammate fighting elsewhere (the bot sits AFK at
    // /home). Prefer slot 0; fall back to slot 2 only when slot 0 has no
    // entry for this exact (case-sensitive) name. Exposed via
    // RawScoreboardTracker since mineflayer's own bot.scoreboard never
    // populates on this server's protocol version.
    getPlayerHp(name) {

        // NOTE: slot 0 (tab list) and slot 2 (below-name) do NOT share a
        // scale on this server - slot 0 read healthy players as "low" and
        // caused the bot to kick everyone. Until the real slot-0 scale is
        // confirmed from a live `sidebar-debug-hp` dump, read ONLY slot 2
        // (the known-correct 0-20 HP objective, threshold 10 = 5 hearts).
        // Trade-off: slot 2 only populates for players in render range of
        // the (AFK) bot, so distant teammates still aren't covered - but
        // that is strictly safer than wrongly kicking full-HP players.
        const belowObj = this.rawScoreboard?.getPosition(2)
        const belowEntry = belowObj?.items.find(item => item.name === name)
        if (Number.isFinite(belowEntry?.value)) return { hp: belowEntry.value, source: 'belowName' }

        return null

    }

    // 5 HP was the threshold confirmed working in production; raised to
    // 10 HP (5 hearts) per request.
    checkAutoInviteLowHealth() {

        if (!this.bot || !this.bot.players) return

        const list = Array.isArray(this.config.autoReinvite) ? this.config.autoReinvite : []

        if (list.length === 0) return

        const trackedNames = list
            .map(entry => (typeof entry === 'string' ? entry : entry?.name) || '')
            .filter(Boolean)

        if (trackedNames.length === 0) return

        const onlineNames = Object.keys(this.bot.players)

        for (const trackedName of trackedNames) {

            const key = trackedName.toLowerCase()

            const actualName = onlineNames.find(name => name.toLowerCase() === key)

            if (!actualName || !this.isTeamMember(actualName)) {
                this.lowHpHandled.delete(key)
                continue
            }

            const hpInfo = this.getPlayerHp(actualName)

            if (!hpInfo) continue

            const hp = hpInfo.hp

            if (hp > 10) {
                this.lowHpHandled.delete(key)
                continue
            }

            if (this.lowHpHandled.has(key)) continue

            this.lowHpHandled.add(key)

            this.log(`${actualName} is at ${hp} HP (via ${hpInfo.source}) and in the team - kicking ASAP and reinviting.`)

            this.sendMinecraftChat(`/t kick ${actualName}`)

            setTimeout(() => this.sendMinecraftChat(`/t invite ${actualName}`), 350)

            io.to(this.username).emit('notice', { type: 'info', text: `${actualName} dropped to ${hp} HP - kicked and reinvited` })

        }

    }

    // The Black Market restock is a short-lived limited-quantity
    // event (server-side, roughly every 3 hours) - worth a Discord
    // ping since nobody's watching the dashboard 24/7.
    checkBlackMarket(text) {

        if (!/black market has now opened/i.test(text)) return

        this.log('Black Market opened - reading stock & pinging Discord.')

        io.to(this.username).emit('notice', { type: 'info', text: '🛒 Black Market has opened - limited stock!' })

        // One /bm open: read the stock for the ping AND (if auto-buy is on)
        // buy from that same window - no second /bm, no 1.5s delay, so it's
        // quicker off the restock.
        this.pingBlackMarketStock(this.config.blackMarketAutoBuy)

    }

    // Reads every item in /bm (container slots only, not the bot's own
    // inventory), skipping GUI filler. Returns [{ name, count }].
    readBlackMarketStock(shopWindow) {

        const end = typeof shopWindow.inventoryStart === 'number' ? shopWindow.inventoryStart : shopWindow.slots.length
        // GUI filler + decorative/non-purchasable slots (amethyst shard is
        // just decoration in this shop - it isn't an item you can buy).
        const FILLER = /glass_pane|^barrier$|^air$|^amethyst_shard$/

        const seen = new Set()
        const out = []

        for (let i = 0; i < end; i++) {
            const item = shopWindow.slots[i]
            if (!item) continue
            if (FILLER.test(item.name)) continue
            const name = String(item.displayName || item.name || '').replace(/§./g, '').trim()
            if (!name) continue
            const key = `${name.toLowerCase()}`
            if (seen.has(key)) continue
            seen.add(key)
            out.push({ name, count: item.count || 1 })
            if (out.length >= 40) break
        }

        return out

    }

    // Opens /bm, reads the stock, and sends the Discord ping with the item
    // list. If buyToo is set (and auto-buy is on), it buys from the SAME
    // open window so /bm is only opened once. Falls back to a plain ping if
    // the shop can't be opened/read.
    pingBlackMarketStock(buyToo = false) {

        if (!this.bot) return

        const webhook = this.config.discordWebhookUrl
        const role = this.config.discordRoleId

        const timeout = setTimeout(() => {
            this.bot?.removeListener('windowOpen', shopListener)
            this.log('Black Market: could not open /bm to read stock - pinging without the item list.')
            sendDiscordWebhook(webhook, 'The Black Market has reset!', role)
        }, 5000)

        const shopListener = shopWindow => {

            clearTimeout(timeout)

            const stock = this.readBlackMarketStock(shopWindow)

            const body = stock.length
                ? `The Black Market has reset! In stock:\n${stock.map(i => `• ${i.name}${i.count > 1 ? ` x${i.count}` : ''}`).join('\n')}`
                : 'The Black Market has reset!'

            sendDiscordWebhook(webhook, body, role)

            this.log(`Black Market stock: ${stock.map(i => i.name).join(', ') || '(none read)'}`)

            if (buyToo && this.config.blackMarketAutoBuy) {
                this.buyFromBlackMarketWindow(shopWindow, false)
            }

        }

        this.bot.once('windowOpen', shopListener)
        this.sendMinecraftChat('/bm')

    }

    // --- Interactive Black Market viewer (the BM card) ---
    // Opens /bm, streams its contents to the dashboard as a clickable grid,
    // keeps it open ~30s, then closes. Clicking a tile buys that slot.
    openBlackMarketView() {

        if (this.config.platform === 'bedrock') {
            io.to(this.username).emit('notice', { type: 'error', text: 'The Black Market is Java-only.' })
            return
        }
        if (!this.bot || !this.bot.entity) {
            io.to(this.username).emit('notice', { type: 'error', text: 'Start the bot and get it online first.' })
            return
        }

        this.closeBlackMarketView(true)

        this.bmViewClosesAt = Date.now() + 30000
        this.bmViewCloseTimer = setTimeout(() => this.closeBlackMarketView(), 30000)

        this.fetchBlackMarketWindow(true)

    }

    // Sends /bm and, on the shop window, stores + streams it. firstOpen
    // reports "market closed" if nothing opens; a refresh (after a buy)
    // stays quiet.
    fetchBlackMarketWindow(firstOpen) {

        if (!this.bot) return

        const shopTimeout = setTimeout(() => {
            this.bot?.removeListener('windowOpen', onOpen)
            if (firstOpen) {
                this.closeBlackMarketView()
                io.to(this.username).emit('notice', { type: 'info', text: "🛒 The Black Market isn't open right now." })
            }
        }, 5000)

        const onOpen = shopWindow => {
            clearTimeout(shopTimeout)
            this.bmViewWindow = shopWindow
            this.streamBlackMarketView()
        }

        this.bot.once('windowOpen', onOpen)
        this.sendMinecraftChat('/bm')

    }

    streamBlackMarketView() {
        const w = this.bmViewWindow
        if (!w) return
        const end = typeof w.inventoryStart === 'number' ? w.inventoryStart : w.slots.length
        const FILLER = /glass_pane|^barrier$|^air$|^amethyst_shard$/
        const slots = []
        for (let i = 0; i < end; i++) {
            const item = w.slots[i]
            if (!item || FILLER.test(item.name)) continue
            const name = String(item.displayName || item.name || '').replace(/§./g, '').trim()
            slots.push({ slot: i, name, item: item.name, count: item.count || 1 })
        }
        io.to(this.username).emit('bmView', { open: true, slots, closesAt: this.bmViewClosesAt })
    }

    // Clicks a slot to buy it, auto-confirming the lime-wool "yes" if a
    // confirm dialog appears, then refreshes the grid.
    buyBlackMarketSlot(slot) {
        const n = Number(slot)
        if (!this.bot || !this.bmViewWindow || !Number.isInteger(n)) return
        const item = this.bmViewWindow.slots[n]
        if (!item) return

        this.log(`BM view: buying slot ${n} (${item.displayName || item.name}).`)
        io.to(this.username).emit('notice', { type: 'info', text: `🛒 Buying ${item.displayName || item.name}…` })

        let confirmClicked = false
        const onConfirm = confirmWindow => {
            let tries = 0
            const tryConfirm = () => {
                if (confirmClicked || !this.bot) return
                const entry = confirmWindow.slots
                    .map((it, idx) => ({ it, idx }))
                    .filter(e => e.it)
                    .find(({ it }) => it.name === 'lime_wool' || /confirm|purchase|buy|yes/i.test(it.displayName || ''))
                if (entry) { confirmClicked = true; this.bot.clickWindow(entry.idx, 0, 0).catch(() => {}); return }
                if (tries++ < 8) setTimeout(tryConfirm, 150)
            }
            tryConfirm()
        }
        this.bot.once('windowOpen', onConfirm)
        this.bot.clickWindow(n, 0, 0).catch(() => {})

        // Refresh the grid after the purchase settles (if still viewing).
        setTimeout(() => {
            this.bot?.removeListener('windowOpen', onConfirm)
            if (this.bot && this.bmViewCloseTimer) this.fetchBlackMarketWindow(false)
        }, 1500)
    }

    closeBlackMarketView(silent = false) {
        if (this.bmViewCloseTimer) { clearTimeout(this.bmViewCloseTimer); this.bmViewCloseTimer = null }
        if (this.bot && this.bmViewWindow) { try { this.bot.closeWindow(this.bmViewWindow) } catch {} }
        this.bmViewWindow = null
        this.bmViewClosesAt = null
        if (!silent) io.to(this.username).emit('bmView', { open: false })
    }

    // Manual "Check BM" (Quick Actions): opens /bm right now and buys a
    // tracked item if one's in stock, regardless of the auto-buy toggle
    // (that toggle only controls buying automatically on a restock). Uses
    // the configured item list, or the defaults if none set.
    checkBlackMarketNow() {

        if (this.config.platform === 'bedrock') {
            io.to(this.username).emit('notice', { type: 'error', text: 'Black Market auto-buy is Java-only.' })
            return
        }

        if (!this.bot || !this.bot.entity) {
            io.to(this.username).emit('notice', { type: 'error', text: 'Start the bot and get it online first.' })
            return
        }

        io.to(this.username).emit('notice', { type: 'info', text: '🛒 Checking the Black Market…' })
        this.log('Manual Black Market check triggered from Quick Actions.')
        this.autoBuyBlackMarket(true)

    }

    // Auto-clicks through the Black Market's buy flow for each
    // tracked item the instant a restock is announced, instead of
    // just pinging and hoping a human reacts fast enough - limited
    // stock usually doesn't survive a human reaction time. Off by
    // default (this spends real in-game currency/keys), toggled per-
    // account in Settings.
    //
    // Matches items by NAME/LORE TEXT on both screens (the shop, then
    // the confirm dialog /bm opens after clicking an item) rather than
    // a hardcoded slot index - same technique debugNextWindow() uses,
    // which is the one that's actually been exercised against this
    // shop before. A fixed slot number is exactly how an auto-buyer
    // clicks the wrong thing the moment a GUI layout shifts; if no
    // confirm-looking item is found, this aborts that item without
    // clicking anything rather than guessing which slot to hit on a
    // screen that spends real resources.
    //
    // The Black Market only lets you buy ONE item per restock window, so
    // this opens /bm once, sees which of the tracked items are actually
    // in stock, and - if more than one is - picks a single one at random
    // (an even gamble between them) to buy. It does NOT try to buy every
    // tracked item; a second purchase in the same window isn't possible
    // anyway, and attempting it just wastes the one pick.
    autoBuyBlackMarket(manual = false) {

        if (!this.bot) return

        this.log('Black Market auto-buy: opening /bm...')

        // /bm not opening any window at all (market currently closed -
        // e.g. this is a post-reboot resync check that caught it between
        // restocks) would otherwise leave this listener dangling forever.
        const shopTimeout = setTimeout(() => {
            this.bot?.removeListener('windowOpen', shopListener)
            this.log('Black Market auto-buy: no shop window opened within 5s (market likely closed) - skipping.')
            if (manual) {
                io.to(this.username).emit('notice', { type: 'info', text: '🛒 The Black Market isn\'t open right now — nothing to buy.' })
            }
        }, 5000)

        const shopListener = shopWindow => {
            clearTimeout(shopTimeout)
            this.buyFromBlackMarketWindow(shopWindow, manual)
        }

        this.bot.once('windowOpen', shopListener)

        this.sendMinecraftChat('/bm')

    }

    // Buys from an ALREADY-OPEN /bm shop window. Shared by the restock path
    // (which opens /bm once to read stock + buy) and autoBuyBlackMarket
    // (manual check / reboot resync). One purchase per restock: gambles
    // evenly if several tracked items are in stock.
    buyFromBlackMarketWindow(shopWindow, manual) {

        if (!this.bot) return

        const configuredItems = Array.isArray(this.config.blackMarketAutoBuyItems) && this.config.blackMarketAutoBuyItems.length > 0
            ? this.config.blackMarketAutoBuyItems
            : DEFAULT_BLACK_MARKET_ITEMS

        const targets = configuredItems
            .map(raw => String(raw || '').replace(/^minecraft:/i, '').trim().toLowerCase())
            .filter(Boolean)
            .map(itemName => ({
                itemName,
                pattern: blackMarketItemPattern(itemName),
                label: blackMarketItemLabel(itemName)
            }))

        if (targets.length === 0) return

        const findMatch = (window, pattern, itemName) => {

            const entries = window.slots
                .map((item, index) => ({ item, index }))
                .filter(entry => entry.item)

            return entries.find(({ item }) =>
                (itemName && item.name === itemName) ||
                pattern.test(item.displayName || '') ||
                (item.nbt && pattern.test(JSON.stringify(item.nbt)))
            )

        }

        const countItem = name =>
            (this.bot?.inventory?.items() || [])
                .filter(i => i.name === name)
                .reduce((sum, i) => sum + (i.count || 0), 0)

        // Which of the tracked items are actually in stock right now.
        const inStock = targets
            .map(target => ({ ...target, match: findMatch(shopWindow, target.pattern, target.itemName) }))
            .filter(entry => entry.match)

        if (inStock.length === 0) {
            this.log('Black Market auto-buy: none of the tracked items are in stock - nothing to buy.')
            if (manual) {
                io.to(this.username).emit('notice', { type: 'info', text: '🛒 Black Market is open, but none of your tracked items are in stock.' })
            }
            return
        }

        // Only one purchase is allowed per restock, so if several tracked
        // items are up, gamble evenly between them.
        const chosen = inStock[Math.floor(Math.random() * inStock.length)]
        const { itemName, label, match: target } = chosen

        if (inStock.length > 1) {
            this.log(`Black Market auto-buy: ${inStock.length} tracked items in stock (${inStock.map(e => e.label).join(', ')}) - gambled and picked ${label}.`)
        } else {
            this.log(`Black Market auto-buy: ${label} in stock - buying it.`)
        }

        // How many of this item we hold BEFORE buying - the purchase is
        // confirmed (and logged) by this going up, which is the only
        // reliable signal here: this Black Market sends no "you bought X"
        // chat, and the GUI confirm layout can't be assumed.
        const beforeCount = countItem(itemName)

        // If a confirm dialog opens after clicking the item, click its
        // confirm button the instant it's there. The dialog's slots can
        // arrive a tick after it opens, so retry briefly rather than giving
        // up on the first empty read.
        let confirmClicked = false
        const confirmListener = confirmWindow => {

            let tries = 0
            const tryConfirm = () => {
                if (confirmClicked || !this.bot) return
                const confirmTarget = findMatch(confirmWindow, /confirm|purchase|buy|yes/i, 'lime_wool')
                if (confirmTarget) {
                    confirmClicked = true
                    this.bot.clickWindow(confirmTarget.index, 0, 0).catch(() => {})
                    this.log(`Black Market auto-buy: clicked confirm for ${label}.`)
                    return
                }
                if (tries++ < 8) setTimeout(tryConfirm, 150)
                else this.log(`Black Market auto-buy: confirm dialog for ${label} had no recognizable confirm button.`)
            }
            tryConfirm()

        }

        this.bot.once('windowOpen', confirmListener)
        const confirmListenerCleanup = setTimeout(() => this.bot?.removeListener('windowOpen', confirmListener), 5000)

        // Click the item. Some shops buy on this single click, others pop a
        // confirm dialog (handled above) - either way, whether the purchase
        // actually happened is decided by the inventory check below, not by
        // which path the GUI took.
        this.bot.clickWindow(target.index, 0, 0).catch(() => {})

        // Poll for the item to actually arrive (inventory packets come a
        // beat after the purchase). Logs only on a real increase, so every
        // genuine purchase is recorded and failed clicks aren't.
        let checks = 0
        const verify = () => {
            if (!this.bot) return
            const now = countItem(itemName)
            if (now > beforeCount) {
                clearTimeout(confirmListenerCleanup)
                this.log(`Black Market auto-buy: ${label} purchased (inventory +${now - beforeCount}).`)
                io.to(this.username).emit('notice', { type: 'success', text: `🛒 Black Market: ${label} auto-purchased!` })
                this.blackMarketPurchaseHistory.push({ itemId: `minecraft:${itemName}`, label, timestamp: Date.now() })
                this.blackMarketPurchaseHistory = this.blackMarketPurchaseHistory.slice(-25)
                saveBlackMarketPurchaseHistory(this.username, this.blackMarketPurchaseHistory)
                return
            }
            if (checks++ < 12) setTimeout(verify, 400)
            else this.log(`Black Market auto-buy: clicked ${label} but it never arrived in inventory - likely didn't go through.`)
        }
        setTimeout(verify, 300)

    }

    // The trivia plugin broadcasts "<Type> has been chosen!" and then
    // the question itself as a separate "CHAT GAME" line shortly after.
    // Math and Replication are handled. The answer is sent after a 25s
    // delay so it doesn't look like an instant bot reaction.
    checkTrivia(text) {

        if (this.config.triviaAutoAnswer === false) {
            this.cancelPendingTrivia()
            return
        }

        const cleaned = cleanMessage(text)

        const chosenMatch = cleaned.match(/(\w+)\s+has been chosen!?$/i)

        if (chosenMatch) {
            this.cancelPendingTrivia()
            this.triviaActiveType = chosenMatch[1].toLowerCase()
            return
        }

        // Round over (someone won, or nobody did) - cancel any answer we
        // had queued so we don't type into a finished round.
        if (/\bhas won\b/i.test(cleaned) || /\bnobody won\b/i.test(cleaned)) {
            this.cancelPendingTrivia()
            this.triviaActiveType = null
            return
        }

        if (this.triviaActiveType === 'math') {

            const mathMatch = cleaned.match(/(\d+)\s*([+\-x×*÷/])\s*(\d+)\s*$/i)

            if (!mathMatch) return

            const a = Number(mathMatch[1])
            const b = Number(mathMatch[3])

            let answer

            switch (mathMatch[2].toLowerCase()) {
                case '+': answer = a + b; break
                case '-': answer = a - b; break
                case 'x': case '×': case '*': answer = a * b; break
                case '÷': case '/': answer = b !== 0 ? a / b : null; break
            }

            if (!Number.isFinite(answer)) return

            // Consume immediately so this round can't be answered twice
            // (e.g. if the question line coincidentally matches again).
            this.triviaActiveType = null

            this.log(`Trivia (Math): ${a} ${mathMatch[2]} ${b} = ${answer}`)

            this.cancelPendingTrivia()
            this.triviaTimer = setTimeout(() => {
                this.triviaTimer = null
                if (!this.bot) return
                this.sendMinecraftChat(answer)
                this.recordChatGame('Math', answer)
            }, 20000)

            return

        }

        if (this.triviaActiveType === 'replication') {

            // The question line shares the same "CHAT GAME" prefix as the
            // "has been chosen!" line - strip it (plus whatever icon/arrow
            // glyph sits between it and the text) and whatever's left is
            // exactly what to repeat back. If the line didn't start with
            // that prefix at all, it's some unrelated chat message (a
            // player talking, etc.) and must not be echoed.
            const stripped = cleaned.replace(/^CHAT GAME\W*/i, '')

            if (stripped === cleaned || !stripped) return

            this.triviaActiveType = null

            this.log(`Trivia (Replication): "${stripped}"`)

            this.cancelPendingTrivia()
            this.triviaTimer = setTimeout(() => {
                this.triviaTimer = null
                if (!this.bot) return
                this.sendMinecraftChat(stripped)
                this.recordChatGame('Replication', stripped)
            }, 20000)

            return

        }

        if (this.triviaActiveType === 'blanks') {

            // The masked question (e.g. "D__m_nd _re") shares the CHAT GAME
            // prefix; strip it and keep only lines that look like a mask
            // (letters + underscores, with at least one blank).
            const stripped = cleaned.replace(/^CHAT GAME\W*/i, '')

            if (stripped === cleaned || !stripped) return
            if (!/^_*[A-Za-z][A-Za-z_]*(?: _*[A-Za-z][A-Za-z_]*)*$/.test(stripped)) return
            if (!stripped.includes('_')) return

            const candidates = findBlanksCandidates(stripped)

            if (candidates.length === 0) return

            // One match -> that answer; a few -> list up to 3 so the team
            // can pick. Posted to normal chat after the same delay.
            const answer = candidates.length === 1 ? candidates[0] : candidates.slice(0, 3).join(', ')

            this.triviaActiveType = null

            this.log(`Trivia (Blanks): mask "${stripped}" -> ${candidates.length} candidate(s): ${answer}`)

            this.cancelPendingTrivia()
            this.triviaTimer = setTimeout(() => {
                this.triviaTimer = null
                if (!this.bot) return
                this.sendMinecraftChat(answer)
                this.recordChatGame('Blanks', answer)
            }, 20000)

            return

        }

    }

    // Logs a chat game the bot answered (shown in the Automation card's
    // history) and pushes a fresh dashboard update so it appears live.
    recordChatGame(type, answer) {
        this.triviaHistory.push({ type, answer: String(answer).slice(0, 60), timestamp: Date.now() })
        this.triviaHistory = this.triviaHistory.slice(-50)
        saveTriviaHistory(this.username, this.triviaHistory)
        this.updateDashboard()
    }

    // Cancels a queued (delayed) trivia answer - called when the round ends
    // or a new one starts, so the bot never answers a finished round.
    cancelPendingTrivia() {
        if (this.triviaTimer) {
            clearTimeout(this.triviaTimer)
            this.triviaTimer = null
        }
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

        const previousMembers = this.teamRoster?.members || []

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

            if (points > this.badgeProgress.maxPointsSeen) {
                this.badgeProgress.maxPointsSeen = points
                saveBadgeProgress(this.username, this.badgeProgress)
                this.checkBadges()
            }

        }

        this.checkRoleChanges(previousMembers, members)

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

    // Shared failure path for the local-address-bind and SOCKS5 setup
    // steps in connect() - neither ever got as far as actually
    // reaching mineflayer, so there's no bot/socket to clean up here,
    // just log it, tell the dashboard, and try again on the normal
    // reconnect delay rather than leaving the bot stuck offline.
    abortConnectAttempt(message) {

        this.log(message)
        originalError(`[${this.username}]`, message)

        io.to(this.username).emit('notice', { type: 'error', text: message })

        this.setState('OFFLINE')

        if (this.botEnabled && !this.shuttingDown) {
            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null
                this.connect()
            }, RECONNECT_DELAY)
        }

    }

    async connect() {

        if (this.shuttingDown) return
        if (!this.botEnabled) return

        if (this.config.platform === 'bedrock') {
            return this.connectBedrock()
        }

        this.lifeStealReached = false
        this.recoveryRunning = false

        this.stopJqRetry()
        this.stopHomeTimer()
        this.stopRecoveryTimer()

        this.currentWorld = 'Unknown'
        this.setState('CONNECTING')

        this.log(`Connecting to ${this.config.host}:${this.config.port}...`)

        originalLog(`[${new Date().toLocaleString()}] [${this.username}] Connecting to ${this.config.host}:${this.config.port}...`)

        // Two alternative ways to give this account its own outbound
        // IP instead of sharing this machine's one address with every
        // other account hosted here - a specific local IP to bind to
        // (a second VNIC on this machine, e.g.), or a SOCKS5 proxy.
        // localAddress takes priority if both are somehow set. Either
        // way, mineflayer gets the already-connected socket via its
        // documented `stream` option (see tcp_dns.js in
        // minecraft-protocol) instead of opening its own connection.
        let proxyStream = null

        if (this.config.localAddress) {

            try {

                proxyStream = await new Promise((resolve, reject) => {

                    const socket = net.connect({
                        host: this.config.host,
                        port: this.config.port,
                        localAddress: this.config.localAddress
                    })

                    socket.once('connect', () => resolve(socket))
                    socket.once('error', reject)

                })

                this.log(`Connected via local address ${this.config.localAddress}.`)

            } catch (error) {
                this.abortConnectAttempt(`Local address bind failed: ${error.message}`)
                return
            }

        } else if (this.config.proxyHost && this.config.proxyPort) {

            try {

                const { socket } = await SocksClient.createConnection({
                    command: 'connect',
                    proxy: {
                        host: this.config.proxyHost,
                        port: this.config.proxyPort,
                        type: 5,
                        userId: this.config.proxyUsername || undefined,
                        password: this.config.proxyPassword || undefined
                    },
                    destination: {
                        host: this.config.host,
                        port: this.config.port
                    }
                })

                proxyStream = socket

                this.log(`Connected via SOCKS5 proxy ${this.config.proxyHost}:${this.config.proxyPort}.`)

            } catch (error) {
                this.abortConnectAttempt(`SOCKS5 proxy connection failed: ${error.message}`)
                return
            }

        }

        const profilesFolder = path.join(AUTH_CACHE_DIR, this.username)
        fs.mkdirSync(profilesFolder, { recursive: true })

        this.bot = mineflayer.createBot({

            host: this.config.host,
            port: this.config.port,
            username: this.config.microsoftEmail,
            auth: 'microsoft',
            version: this.config.version || false,
            profilesFolder,
            ...(proxyStream ? { stream: proxyStream } : {}),

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

        this.rawScoreboard = new RawScoreboardTracker(this.bot)

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
            this.checkAutoPromote(text)
            this.checkTeamRosterChange(text)
            this.checkKothCapture(text)
            this.checkTeamDeath(text)
            this.checkNemesisDeath(text)
            this.checkBlackMarket(text)
            this.checkTrivia(text)
            this.checkBalance(text)
            this.checkWhisperCommand(text)

            // Action bar text ('game_info') refreshes far too often to
            // show in the chat feed, but is worth its own read-only
            // card - just keep the latest one and let the once-a-
            // second dashboard tick pick it up naturally, rather than
            // broadcasting an event for every single update.
            if (position === 'game_info') {
                this.lastActionBar = text
                this.lastActionBarAt = Date.now()
            }

            // Player chat (position 'chat') is already broadcast by
            // the 'chat' event above, which knows the real username -
            // broadcasting it again here would duplicate it. This
            // covers system messages and join/leave/announcements.
            if (position !== 'chat' && position !== 'game_info' && !isTeamRosterNoiseMessage(text)) {

                const dedupeKey = `${position}:${text}`

                if (dedupeKey !== this.lastServerMessageKey) {

                    this.lastServerMessageKey = dedupeKey

                    const username = 'SERVER'

                    this.lastChatMessage = text
                    this.lastChatTime = new Date().toISOString()

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
            this.startPovViewer()

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
    // CONNECT (Bedrock)
    // --------------------------------------------------------
    // No automation here by design (no trivia, no Black Market ping,
    // no LifeSteal autopilot - normalizeBotConfig() forces
    // lifestealAutopilot off for platform: 'bedrock'). Team tracking,
    // KOTH/death logging, chat relay, and manual actions (Kick, AFK,
    // Quick Actions) all still work since those are either passive
    // text parsing or user-triggered, not autonomous behavior. HP,
    // inventory/Keys, the KOTH Capture card, Action Bar, and low-HP
    // auto-kick are NOT supported yet - those need Bedrock-specific
    // packet handling (different formats than Java's) that hasn't
    // been built.
    //
    // No proxy/localAddress support yet either - bedrock-protocol's
    // connection options weren't verified against those, so this
    // always connects directly.
    async connectBedrock() {

        if (this.shuttingDown) return
        if (!this.botEnabled) return

        this.stopJqRetry()
        this.stopHomeTimer()
        this.stopRecoveryTimer()

        this.currentWorld = 'Unknown'
        this.setState('CONNECTING')
        this.bedrockSpawned = false
        this.bedrockPlayers.clear()

        const host = this.config.host
        const port = this.config.port || 19132

        this.log(`Connecting (Bedrock) to ${host}:${port}...`)

        originalLog(`[${new Date().toLocaleString()}] [${this.username}] Connecting (Bedrock) to ${host}:${port}...`)

        // Ping first. A wrong host/port is by far the most common reason
        // a Bedrock connect just silently hangs on "connecting" - the
        // RakNet layer keeps re-sending open-connection requests forever
        // with no error. A ping either confirms there's a real Bedrock
        // server there (and tells us its version, for the matching
        // protocol) or fails fast with a clear message.
        try {
            const info = await Promise.race([
                bedrock.ping({ host, port }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 8000))
            ])
            this.log(`Bedrock server found: "${info.motd}" (v${info.version}, ${info.playersOnline}/${info.playersMax} online).`)
        } catch (pingError) {
            this.log(`Could not reach a Bedrock server at ${host}:${port} (${pingError.message}). For FlareMC LifeSteal, use host bedrock.flaremc.org and port 19132 - java.flaremc.org:25565 is Java-only.`)
            io.to(this.username).emit('notice', { type: 'error', text: `Bedrock: can't reach ${host}:${port}. FlareMC LifeSteal Bedrock = bedrock.flaremc.org : 19132 (not the Java address).` })
            this.setState('OFFLINE')
            this.currentWorld = 'Disconnected'
            this.updateDashboard()
            if (!this.shuttingDown && this.botEnabled && !this.reconnectTimer) {
                this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect() }, RECONNECT_DELAY)
            }
            return
        }

        if (this.shuttingDown || !this.botEnabled) return

        const profilesFolder = path.join(AUTH_CACHE_DIR, `${this.username}-bedrock`)
        fs.mkdirSync(profilesFolder, { recursive: true })

        // No explicit `version` - bedrock-protocol negotiates it from its
        // own ping during connect, picking the server's protocol as long
        // as the installed library supports it (FlareMC LifeSteal runs a
        // recent one, which is why bedrock-protocol/minecraft-data are
        // kept up to date).
        this.bot = bedrock.createClient({

            host,
            port,
            username: this.config.microsoftEmail,
            profilesFolder,
            raknetBackend: 'jsp-raknet',

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

        // Watchdog: if we pinged fine and started a client but never reach
        // 'spawn' within 45s (silent kick, version mismatch, auth stall),
        // don't sit in CONNECTING forever - tear it down and let the
        // normal reconnect loop retry.
        if (this.bedrockSpawnWatchdog) clearTimeout(this.bedrockSpawnWatchdog)
        this.bedrockSpawnWatchdog = setTimeout(() => {
            if (this.bedrockSpawned || !this.bot) return
            this.log('Bedrock: reached the server but never finished joining within 45s (possible version mismatch or sign-in not completed). Retrying.')
            io.to(this.username).emit('notice', { type: 'error', text: 'Bedrock: reached the server but could not finish joining. Retrying.' })
            try { this.bot.disconnect('join timeout') } catch {}
        }, 45000)

        this.bot.on('join', () => {
            this.setState('LOGGED IN')
            this.log('Minecraft (Bedrock) login successful.')
        })

        this.bot.on('spawn', () => {

            if (this.bedrockSpawnWatchdog) { clearTimeout(this.bedrockSpawnWatchdog); this.bedrockSpawnWatchdog = null }

            this.connectedAt = Date.now()
            this.reconnectDelay = RECONNECT_DELAY
            this.bedrockSpawned = true
            this.currentWorld = 'Online'

            this.setState('ONLINE')
            this.log('Spawned (Bedrock).')

            this.updateDashboard()

        })

        // Server-wide tab-list add/remove, same role bot.players plays
        // on the Java side - uuid is stable across a rename, username
        // isn't (see getUuidToUsername()/renames in Threats/Allies/
        // Auto-Invite).
        this.bot.on('player_list', packet => {

            const records = packet.records?.records || []

            if (packet.records?.type === 'add') {

                for (const record of records) {
                    if (record.uuid && record.username) {
                        this.bedrockPlayers.set(record.uuid, record.username)
                    }
                }

            } else if (packet.records?.type === 'remove') {

                for (const record of records) {
                    if (record.uuid) {
                        this.bedrockPlayers.delete(record.uuid)
                    }
                }

            }

        })

        this.bot.on('text', packet => {

            const text = packet.message || ''

            if (!text.trim()) return

            if (packet.type === 'chat' || packet.type === 'whisper' || packet.type === 'announcement') {

                // On Bedrock a whisper arrives already split into sender +
                // message, so the command handler can take it directly.
                if (packet.type === 'whisper') {
                    this.handleWhisperCommand(packet.source_name, text)
                }

                this.broadcastChat(packet.source_name || 'Unknown', text)
                return

            }

            // Everything else (system/raw/announcements/etc.) is
            // server-originated text - same text-parsing pipeline the
            // Java path uses, minus checkBlackMarket (no automation on
            // Bedrock by design) and anything lifestealAutopilot-gated
            // (already forced off for this platform).
            this.tryParseTeamInfoLine(text)
            this.checkAutoReinvite(text)
            this.checkAutoPromote(text)
            this.checkTeamRosterChange(text)
            this.checkKothCapture(text)
            this.checkTeamDeath(text)
            this.checkNemesisDeath(text)

            if (!isTeamRosterNoiseMessage(text)) {

                const dedupeKey = `${packet.type}:${text}`

                if (dedupeKey !== this.lastServerMessageKey) {

                    this.lastServerMessageKey = dedupeKey

                    this.lastChatMessage = text
                    this.lastChatTime = new Date().toISOString()

                    io.to(this.username).emit('chat', { username: 'SERVER', message: text, time: this.lastChatTime })

                    this.log(`[SERVER] ${text}`)

                }

            }

        })

        this.bot.on('kick', packet => {

            this.lastDisconnectReason = packet?.message || 'Unknown reason'

            originalLog(`[KICKED:${this.username}] ${this.lastDisconnectReason}`)

            this.log(`Kicked: ${this.lastDisconnectReason}`)

        })

        this.bot.on('error', error => {

            this.log(`Error: ${error.message}`)

            originalError(`[ERROR:${this.username}] ${error.message}`)

            this.updateDashboard()

        })

        this.bot.on('close', () => {

            if (this.bedrockSpawnWatchdog) { clearTimeout(this.bedrockSpawnWatchdog); this.bedrockSpawnWatchdog = null }

            this.stopJqRetry()
            this.stopHomeTimer()
            this.stopRecoveryTimer()

            this.bot = null
            this.bedrockSpawned = false
            this.bedrockPlayers.clear()
            this.connectedAt = null
            this.currentWorld = 'Disconnected'

            this.setState('OFFLINE')

            this.updateDashboard()

            if (this.shuttingDown) return
            if (!this.botEnabled) return
            if (this.reconnectTimer) return

            this.reconnectCount++
            this.reconnectDelay = RECONNECT_DELAY

            originalLog(`[${this.username}] Disconnected (Bedrock). Reconnecting in ${RECONNECT_DELAY / 1000} seconds...`)

            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null
                this.connect()
            }, RECONNECT_DELAY)

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
        this.stopBalanceManager()
        this.stopAllMovement()
        this.stopPovViewer()

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }

        if (this.bot) {

            try {

                if (this.config.platform === 'bedrock') {
                    this.bot.disconnect('Bot manually stopped')
                } else {
                    this.bot.quit('Bot manually stopped')
                }

            } catch {}

        }

    }

}

// ============================================================
// FLEET ACCOUNTS (lightweight alt connections)
// ============================================================
// A separate, much simpler sibling to BotSession. Each dashboard
// user's PRIMARY bot (the BotSession tied to their login) keeps the
// full rich dashboard - Team/Threats/Allies/KOTH tracking, history,
// badges, everything. A user can ALSO add extra "fleet" accounts
// (Java or Bedrock) that just connect, send one AFK command, and
// report connection status - no chat/team parsing, no history, no
// automation. Mirrors the plain account-list pattern (connect/
// disconnect per row, bulk connect/stop all, proxy per account) from
// other AFK bot panels, instead of giving every alt the full
// LifeSteal-specific dashboard it doesn't need.
class FleetAccount {

    constructor(ownerUsername, config) {

        this.ownerUsername = ownerUsername
        this.id = config.id
        this.config = config

        this.bot = null
        this.state = 'OFFLINE'
        this.lastError = null
        this.connectedAt = null
        this.bedrockSpawned = false
        this.botEnabled = true
        this.shuttingDown = false
        this.reconnectTimer = null

        // Lightweight uptime tracking for the Account Fleet row - not
        // trying to be exact, just enough to tell a flaky alt from a
        // stable one at a glance.
        this.createdAt = Date.now()
        this.totalConnectedMs = 0
        this.reconnectCount = 0

    }

    recordDisconnect() {

        if (this.connectedAt) {
            this.totalConnectedMs += Date.now() - this.connectedAt
        }

    }

    setState(state) {
        this.state = state
        this.broadcastUpdate()
    }

    broadcastUpdate() {
        io.to(this.ownerUsername).emit('fleetUpdate', this.getStatus())
    }

    getStatus() {

        const online = this.config.platform === 'bedrock'
            ? !!(this.bot && this.bedrockSpawned)
            : !!(this.bot && this.bot.entity)

        const connectedMs = this.totalConnectedMs + (this.connectedAt ? Date.now() - this.connectedAt : 0)
        const elapsedMs = Date.now() - this.createdAt
        const uptimePercent = elapsedMs > 0 ? Math.round((connectedMs / elapsedMs) * 100) : 0

        return {
            id: this.id,
            label: this.config.label || this.config.microsoftEmail,
            microsoftEmail: this.config.microsoftEmail,
            platform: this.config.platform,
            host: this.config.host,
            port: this.config.port,
            state: this.state,
            online,
            botEnabled: this.botEnabled,
            lastError: this.lastError,
            reconnectCount: this.reconnectCount,
            uptimePercent
        }

    }

    abortConnect(message) {

        this.lastError = message
        this.recordDisconnect()
        this.connectedAt = null
        this.setState('OFFLINE')

        if (this.shuttingDown) return
        if (!this.botEnabled) return
        if (this.reconnectTimer) return

        this.reconnectCount++

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null
            this.connect()
        }, RECONNECT_DELAY)

    }

    async connect() {

        if (this.shuttingDown) return
        if (!this.botEnabled) return

        if (this.config.platform === 'bedrock') {
            return this.connectBedrock()
        }

        this.setState('CONNECTING')
        this.lastError = null

        let proxyStream = null

        if (this.config.localAddress) {

            try {

                proxyStream = await new Promise((resolve, reject) => {

                    const socket = net.connect({
                        host: this.config.host,
                        port: this.config.port,
                        localAddress: this.config.localAddress
                    })

                    socket.once('connect', () => resolve(socket))
                    socket.once('error', reject)

                })

            } catch (error) {
                this.abortConnect(`Local address bind failed: ${error.message}`)
                return
            }

        } else if (this.config.proxyHost && this.config.proxyPort) {

            try {

                const { socket } = await SocksClient.createConnection({
                    command: 'connect',
                    proxy: {
                        host: this.config.proxyHost,
                        port: this.config.proxyPort,
                        type: 5,
                        userId: this.config.proxyUsername || undefined,
                        password: this.config.proxyPassword || undefined
                    },
                    destination: { host: this.config.host, port: this.config.port }
                })

                proxyStream = socket

            } catch (error) {
                this.abortConnect(`SOCKS5 proxy connection failed: ${error.message}`)
                return
            }

        }

        const profilesFolder = path.join(AUTH_CACHE_DIR, `${this.ownerUsername}-fleet-${this.id}`)
        fs.mkdirSync(profilesFolder, { recursive: true })

        this.bot = mineflayer.createBot({

            host: this.config.host,
            port: this.config.port,
            username: this.config.microsoftEmail,
            auth: 'microsoft',
            version: this.config.version || false,
            profilesFolder,
            ...(proxyStream ? { stream: proxyStream } : {}),

            onMsaCode: data => {

                io.to(this.ownerUsername).emit('msaCode', {
                    accountId: this.id,
                    accountLabel: this.config.label || this.config.microsoftEmail,
                    verificationUri: data.verification_uri,
                    userCode: data.user_code,
                    message: data.message
                })

            }

        })

        this.bot.once('spawn', () => {

            this.connectedAt = Date.now()
            this.setState('ONLINE')

            if (this.config.afkCommand) {

                setTimeout(() => {
                    try { this.bot?.chat(this.config.afkCommand) } catch {}
                }, 2000)

            }

        })

        this.bot.on('kicked', reason => {
            this.lastError = cleanMessage(JSON.stringify(reason))
        })

        this.bot.on('error', error => {
            this.lastError = error.message
        })

        this.bot.on('end', reason => {

            if (reason) this.lastError = this.lastError || String(reason)

            this.recordDisconnect()

            this.bot = null
            this.connectedAt = null

            this.setState('OFFLINE')

            if (this.shuttingDown) return
            if (!this.botEnabled) return
            if (this.reconnectTimer) return

            this.reconnectCount++

            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null
                this.connect()
            }, RECONNECT_DELAY)

        })

    }

    async connectBedrock() {

        if (this.shuttingDown) return
        if (!this.botEnabled) return

        // A missing host is the single most common reason a Bedrock
        // fleet account used to just sit on "CONNECTING" forever with
        // no visible feedback - bedrock-protocol would still attempt a
        // connection, time out after several seconds, and silently
        // retry forever. Fail it immediately and visibly instead.
        if (!this.config.host) {
            this.abortConnect('No server host set for this account.')
            return
        }

        this.setState('CONNECTING')
        this.lastError = null
        this.bedrockSpawned = false

        const profilesFolder = path.join(AUTH_CACHE_DIR, `${this.ownerUsername}-fleet-${this.id}-bedrock`)
        fs.mkdirSync(profilesFolder, { recursive: true })

        this.bot = bedrock.createClient({

            host: this.config.host,
            port: this.config.port || 19132,
            username: this.config.microsoftEmail,
            profilesFolder,
            raknetBackend: 'jsp-raknet',

            onMsaCode: data => {

                io.to(this.ownerUsername).emit('msaCode', {
                    accountId: this.id,
                    accountLabel: this.config.label || this.config.microsoftEmail,
                    verificationUri: data.verification_uri,
                    userCode: data.user_code,
                    message: data.message
                })

            }

        })

        this.bot.on('spawn', () => {

            this.connectedAt = Date.now()
            this.bedrockSpawned = true
            this.setState('ONLINE')

            if (this.config.afkCommand) {

                setTimeout(() => {

                    try {

                        this.bot?.queue('text', {
                            type: 'chat',
                            needs_translation: false,
                            source_name: this.bot.username,
                            xuid: this.bot.profile?.xuid || '',
                            platform_chat_id: '',
                            filtered_message: '',
                            message: this.config.afkCommand
                        })

                    } catch {}

                }, 2000)

            }

        })

        this.bot.on('kick', packet => {
            this.lastError = packet?.message || 'Kicked'
            this.broadcastUpdate()
        })

        // broadcastUpdate() here, not just setting lastError, so the
        // Fleet row shows the real failure (wrong host, timed out,
        // unsupported protocol version, etc.) right away instead of
        // waiting on the 'close' event a moment later to push it -
        // and in case 'close' never follows for some reason, the
        // error at least isn't silently swallowed either way.
        this.bot.on('error', error => {
            this.lastError = error.message
            this.broadcastUpdate()
        })

        this.bot.on('close', () => {

            this.recordDisconnect()

            this.bot = null
            this.bedrockSpawned = false
            this.connectedAt = null

            this.setState('OFFLINE')

            if (this.shuttingDown) return
            if (!this.botEnabled) return
            if (this.reconnectTimer) return

            this.reconnectCount++

            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null
                this.connect()
            }, RECONNECT_DELAY)

        })

    }

    start() {

        this.shuttingDown = false
        this.botEnabled = true

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }

        this.connect()

    }

    stop() {

        this.botEnabled = false

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }

        this.setState('STOPPED')

        if (this.bot) {

            try {

                if (this.config.platform === 'bedrock') {
                    this.bot.disconnect('Stopped')
                } else {
                    this.bot.quit('Stopped')
                }

            } catch {}

        }

    }

    shutdown() {
        this.shuttingDown = true
        this.stop()
    }

}

// ============================================================
// SESSION REGISTRY
// ============================================================

const sessions = new Map()
const fleetSessions = new Map()

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
        playerLastSeen: {},
        blackMarketAutoBuy: false,
        blackMarketAutoBuyItems: DEFAULT_BLACK_MARKET_ITEMS,
        blackMarketPurchaseHistory: [],
        automation: { triviaAutoAnswer: true, backupKickEnabled: true, blackMarketAutoBuy: false, balanceAutoManage: false },
        triviaHistory: [],
        keys: { vote: 0, exclusive: 0, insane: 0, lantern: 0 },
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
        case 'sidebar-debug': botSession.debugSidebar(); break
        case 'sidebar-debug-raw': botSession.debugSidebarRaw(); break
        case 'sidebar-debug-hp': botSession.debugHpSource(); break
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
        case 'check-bm': botSession.checkBlackMarketNow(); break
        case 'bm-view': botSession.openBlackMarketView(); break
        case 'bm-close': botSession.closeBlackMarketView(); break
        case 'drop-all': botSession.dropAllInventory(); break
        case 'stop-bot': botSession.stopBotRemote(); break

        default:

            if (lower.startsWith('say ')) {
                botSession.sendMinecraftChat(command.substring(4))
            } else if (lower.startsWith('reset-player ')) {
                botSession.removePlayerFromHistory(command.substring('reset-player '.length))
            } else if (lower.startsWith('kick-player ')) {
                botSession.kickTeamMember(command.substring('kick-player '.length))
            } else if (lower.startsWith('remove-team-reading ')) {
                botSession.removeTeamHistoryReading(command.substring('remove-team-reading '.length))
            } else if (lower.startsWith('bm-buy ')) {
                botSession.buyBlackMarketSlot(command.substring('bm-buy '.length))
            } else if (lower.startsWith('drop ')) {
                botSession.dropInventorySlot(command.substring('drop '.length))
            }

            break

    }

}

// ============================================================
// LOGIN / SIGNUP / LOGOUT ROUTES (not protected)
// ============================================================

app.get('/login', rateLimitPreAuth, (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'login.html'))
})

// Self-signup is closed - accounts are created by the admin only
// (see POST /api/admin/create-account, requireAuth-protected below).
app.get('/signup', rateLimitPreAuth, (req, res) => {
    res.redirect('/login')
})

// Served before the auth gate below so it loads on /login and
// /signup too, not just once you're already signed in.
app.get('/favicon.svg', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'favicon.svg'))
})

// PWA files, served before the auth gate so the browser can fetch them
// (and show the install prompt / home-screen icon) on the login page too.
app.get('/manifest.json', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'manifest.json'))
})

app.get('/sw.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript')
    res.sendFile(path.join(PUBLIC_DIR, 'sw.js'))
})

app.use('/icons', express.static(path.join(PUBLIC_DIR, 'icons')))

app.post('/login', rateLimitPreAuth, (req, res) => {

    const ip = req.ip
    const attemptState = getLoginAttemptState(ip)

    if (Date.now() < attemptState.lockedUntil) {

        const waitMin = Math.ceil((attemptState.lockedUntil - Date.now()) / 60000)

        appLog(`Blocked login attempt from locked-out IP ${ip}`)

        return res.status(429).json({ error: `Too many failed attempts. Try again in ${waitMin} minute${waitMin === 1 ? '' : 's'}.` })

    }

    const { username, password } = req.body || {}

    // Regenerate the session on every successful login so the
    // post-auth session ID is never one an attacker could have planted
    // beforehand (session-fixation protection). Only after the fresh
    // session exists do we mark it authenticated and persist it.
    const establishLogin = (resolvedUsername, meta = {}) => {

        req.session.regenerate(regenError => {

            if (regenError) {
                appLog(`Session regenerate failed for ${resolvedUsername}: ${regenError.message}`)
                return res.status(500).json({ error: 'Login failed, please try again.' })
            }

            clearLoginAttempts(ip)

            req.session.loggedIn = true
            req.session.username = resolvedUsername

            req.session.save(saveError => {

                if (saveError) {
                    appLog(`Session save failed for ${resolvedUsername}: ${saveError.message}`)
                    return res.status(500).json({ error: 'Login failed, please try again.' })
                }

                recordLoginEvent(resolvedUsername, { outcome: 'success', method: meta.method || 'password', ip, newDevice: !!meta.newDevice })
                appLog(`Dashboard login: ${resolvedUsername}`)
                res.json({ ok: true })

            })

        })

    }

    // Password checked out. If this account has 2FA on and this browser
    // isn't a still-valid trusted device, hold in a pending stage (fresh
    // session, marked half-authenticated but NOT logged in) until the
    // TOTP code is verified by POST /login/2fa. Otherwise log straight in.
    const afterPassword = resolvedUsername => {

        const trustToken = readCookies(req)[TRUSTED_DEVICE_COOKIE]
        const has2fa = isTwoFactorEnabled(resolvedUsername)

        if (has2fa && !hasValidTrustedDevice(resolvedUsername, trustToken)) {

            req.session.regenerate(regenError => {

                if (regenError) {
                    appLog(`Session regenerate failed (pre-2FA) for ${resolvedUsername}: ${regenError.message}`)
                    return res.status(500).json({ error: 'Login failed, please try again.' })
                }

                req.session.twoFactorPendingUser = resolvedUsername
                req.session.twoFactorPendingAt = Date.now()
                req.session.twoFactorFails = 0

                req.session.save(saveError => {
                    if (saveError) {
                        return res.status(500).json({ error: 'Login failed, please try again.' })
                    }
                    res.json({ twoFactorRequired: true })
                })

            })

            return

        }

        // Logging straight in: either no 2FA, or a trusted device skipped
        // the code. A trusted-device skip is still a known device, so no
        // new-login alert.
        establishLogin(resolvedUsername, { method: has2fa ? 'trusted-device' : 'password', newDevice: false })

    }

    if (username === DASHBOARD_USERNAME && verifyAdminPassword(password)) {
        return afterPassword(username)
    }

    const users = loadUsers()
    const user = findUser(users, username)

    if (user && verifyPassword(password || '', user.salt, user.hash)) {
        return afterPassword(user.username)
    }

    // Wrong password on an account that actually exists is worth logging
    // (someone guessing a real account's password); unknown usernames are
    // skipped so a scanner can't flood the log with junk.
    const knownName = (String(username || '').toLowerCase() === DASHBOARD_USERNAME.toLowerCase())
        ? DASHBOARD_USERNAME
        : (user ? user.username : null)

    if (knownName) {
        recordLoginEvent(knownName, { outcome: 'bad-password', ip })
        noteFailedLoginBurst(knownName, ip)
    }

    recordFailedLogin(ip)

    appLog(`Failed dashboard login attempt: ${username || '(empty)'} from ${ip}`)

    return res.status(401).json({ error: 'Invalid username or password' })

})

// Second step of a 2FA login: verify the authenticator code (or a backup
// code) against the account held in the pending stage from POST /login.
// On success the session is regenerated again and marked logged in.
app.post('/login/2fa', rateLimitPreAuth, (req, res) => {

    const ip = req.ip
    const pendingUser = req.session?.twoFactorPendingUser

    if (!pendingUser) {
        return res.status(400).json({ error: 'No login in progress. Please start over.' })
    }

    // A half-finished login shouldn't linger - 5 minutes to enter a code.
    if (!req.session.twoFactorPendingAt || Date.now() - req.session.twoFactorPendingAt > 5 * 60 * 1000) {
        delete req.session.twoFactorPendingUser
        delete req.session.twoFactorPendingAt
        delete req.session.twoFactorFails
        return res.status(400).json({ error: 'Login timed out. Please start over.' })
    }

    const record = getTwoFactorRecord(pendingUser)
    const stillNeeds2fa = !TWO_FACTOR_DISABLED && record && record.enabled && record.secret

    const finishLogin = (meta = {}) => {

        req.session.regenerate(regenError => {

            if (regenError) {
                appLog(`Session regenerate failed (2FA) for ${pendingUser}: ${regenError.message}`)
                return res.status(500).json({ error: 'Login failed, please try again.' })
            }

            clearLoginAttempts(ip)

            req.session.loggedIn = true
            req.session.username = pendingUser

            req.session.save(saveError => {
                if (saveError) {
                    return res.status(500).json({ error: 'Login failed, please try again.' })
                }
                recordLoginEvent(pendingUser, { outcome: 'success', method: meta.method || 'authenticator', ip, newDevice: !!meta.newDevice })
                // This login came through the 2FA step, i.e. NOT a trusted
                // device - exactly the "new device signed in" case to alert on.
                if (meta.alert) maybeSendLoginAlert(pendingUser, ip)
                appLog(`Dashboard login (2FA): ${pendingUser}`)
                res.json({ ok: true })
            })

        })

    }

    // 2FA was turned off (or DISABLE_2FA set) between password and code -
    // nothing to verify, just finish.
    if (!stillNeeds2fa) {
        return finishLogin({ method: 'password', newDevice: false, alert: false })
    }

    const code = String(req.body?.code || '').trim()

    let method = null
    if (verifyTotp(record.secret, code)) method = 'authenticator'
    else if (verifyRecoveryLoginCode(pendingUser, code)) method = 'recovery-email'
    else if (consumeBackupCode(pendingUser, code)) method = 'backup-code'

    if (!method) {

        recordLoginEvent(pendingUser, { outcome: 'bad-2fa', ip })

        req.session.twoFactorFails = (req.session.twoFactorFails || 0) + 1

        if (req.session.twoFactorFails >= 5) {
            delete req.session.twoFactorPendingUser
            delete req.session.twoFactorPendingAt
            delete req.session.twoFactorFails
            appLog(`2FA locked out (too many codes) for ${pendingUser} from ${ip}`)
            return res.status(429).json({ error: 'Too many incorrect codes. Please start over.' })
        }

        appLog(`Failed 2FA code for ${pendingUser} from ${ip}`)
        return res.status(401).json({ error: 'Invalid code.' })

    }

    finishLogin({ method, newDevice: true, alert: true })

})

// "I don't have my phone - email me a login code." Only works during the
// pending-2FA stage, and only if a verified recovery email is on file.
// Always answers the same way whether or not mail actually went out, so
// it never reveals whether recovery is set up to someone guessing.
app.post('/login/2fa/email-code', rateLimitPreAuth, async (req, res) => {

    const pendingUser = req.session?.twoFactorPendingUser

    if (!pendingUser || !req.session.twoFactorPendingAt || Date.now() - req.session.twoFactorPendingAt > 5 * 60 * 1000) {
        return res.status(400).json({ error: 'No login in progress. Please start over.' })
    }

    const generic = { ok: true, message: 'If a recovery email is set up, a code has been sent to it.' }

    if (!mailConfigured() || !getRecoveryEmail(pendingUser)) {
        return res.json(generic)
    }

    const result = createRecoveryLoginCode(pendingUser)

    if (result.error === 'too-soon') {
        return res.status(429).json({ error: 'A code was just sent. Wait a minute before requesting another.' })
    }

    if (result.error || !result.code) {
        return res.json(generic)
    }

    try {
        await sendMail(
            result.email,
            'Your Voidz.IO login code',
            `Your Voidz.IO login recovery code is: ${result.code}\n\nIt expires in 10 minutes. If you didn't try to log in, you can ignore this email.`,
            buildCodeEmailHtml({
                heading: 'Your login code',
                intro: "Use this code to finish signing in to your Voidz.IO dashboard. It's valid for 10 minutes.",
                code: result.code,
                note: 'Enter it on the login screen where you requested it.'
            })
        )
    } catch (error) {
        appLog(`Recovery email send failed for ${pendingUser}: ${error.message}`)
        return res.status(500).json({ error: 'Could not send the email. Try again shortly.' })
    }

    appLog(`Recovery login code emailed for ${pendingUser}`)
    res.json(generic)

})

// The "stay logged in? (re-authenticate in 72 hours)" answer shown after
// a successful code. Yes -> trust this browser for 72h so future logins
// skip the code (password is still required). Requires the just-completed
// login session.
app.post('/login/trust', (req, res) => {

    if (!req.session?.loggedIn || !req.session.username) {
        return res.status(401).json({ error: 'Not logged in.' })
    }

    const username = req.session.username

    if (req.body?.trust && isTwoFactorEnabled(username)) {

        const token = issueTrustedDevice(username)

        if (token) {
            res.cookie(TRUSTED_DEVICE_COOKIE, token, {
                httpOnly: true,
                sameSite: 'lax',
                secure: COOKIE_SECURE,
                maxAge: TRUSTED_DEVICE_MS
            })
        }

    }

    res.json({ ok: true })

})

app.post('/signup', rateLimitPreAuth, (req, res) => {
    res.status(403).json({ error: 'Signups are closed. Ask the site owner to create your account.' })
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

// Desktop app download (served from downloads/ if the built zip is there).
app.get('/api/download/desktop/status', (req, res) => {
    try {
        const stat = fs.statSync(path.join(DOWNLOADS_DIR, DESKTOP_APP_FILE))
        res.json({ available: true, sizeMb: Math.round(stat.size / (1024 * 1024)) })
    } catch {
        res.json({ available: false })
    }
})

app.get('/download/desktop', (req, res) => {
    const file = path.join(DOWNLOADS_DIR, DESKTOP_APP_FILE)
    if (!fs.existsSync(file)) {
        return res.status(404).send('The desktop app has not been uploaded to this server yet.')
    }
    res.download(file, DESKTOP_APP_FILE)
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
    res.json(config || {
        microsoftEmail: '', host: '', port: 25565, version: '', lifestealAutopilot: false, afkCommand: '/home AFK',
        blackMarketAutoBuy: false,
        proxyHost: '', proxyPort: null, proxyUsername: '', proxyPassword: '', localAddress: ''
    })
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

        // Tracked so a later username change (real Minecraft account
        // renames only take effect for other clients once the player
        // reconnects) can be followed automatically instead of silently
        // falling out of tracking under the old name.
        const uuid = (typeof entry === 'object' && typeof entry?.uuid === 'string' && entry.uuid) ? entry.uuid : null

        list.push({ name, lastSeen, uuid })

    }

    saveAutoReinviteList(req.session.username, list)

    const existing = sessions.get(req.session.username)

    if (existing) {
        existing.config.autoReinvite = list
    }

    res.json({ ok: true, list })

})

// ============================================================
// BLACK MARKET AUTO-BUY ITEMS (see autoBuyBlackMarket above)
// ============================================================

app.get('/api/black-market-items', (req, res) => {

    const list = getBlackMarketAutoBuyItems(req.session.username)

    res.json({
        list: list.length > 0 ? list : DEFAULT_BLACK_MARKET_ITEMS,
        isDefault: list.length === 0
    })

})

app.post('/api/black-market-items', (req, res) => {

    const raw = Array.isArray(req.body?.list) ? req.body.list : []

    const seen = new Set()
    const list = []

    for (const entry of raw) {

        let id = String(entry || '').trim().toLowerCase()

        if (!id) continue

        if (!id.includes(':')) id = `minecraft:${id}`

        if (!/^[a-z0-9_.]+:[a-z0-9_.]+$/.test(id)) continue
        if (seen.has(id)) continue

        seen.add(id)
        list.push(id)

        if (list.length >= 12) break

    }

    saveBlackMarketAutoBuyItems(req.session.username, list)

    const existing = sessions.get(req.session.username)

    if (existing) {
        existing.config.blackMarketAutoBuyItems = list
    }

    res.json({ ok: true, list: list.length > 0 ? list : DEFAULT_BLACK_MARKET_ITEMS })

})

// ============================================================
// AUTOMATION TOGGLES (the Automation card)
// ============================================================

app.post('/api/automation', (req, res) => {

    const body = req.body || {}
    const patch = {}

    // Only the keys actually sent are changed; each is a plain boolean.
    if ('triviaAutoAnswer' in body) patch.triviaAutoAnswer = !!body.triviaAutoAnswer
    if ('backupKickEnabled' in body) patch.backupKickEnabled = !!body.backupKickEnabled
    if ('blackMarketAutoBuy' in body) patch.blackMarketAutoBuy = !!body.blackMarketAutoBuy
    if ('balanceAutoManage' in body) patch.balanceAutoManage = !!body.balanceAutoManage

    if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: 'Nothing to update.' })
    }

    saveBotConfig(req.session.username, patch)

    const existing = sessions.get(req.session.username)
    if (existing) {
        existing.config = { ...existing.config, ...patch }

        // Start/stop the live balance loop immediately on toggle, rather
        // than waiting for the next LifeSteal (re)join.
        if ('balanceAutoManage' in patch) {
            if (patch.balanceAutoManage) existing.startBalanceManager()
            else existing.stopBalanceManager()
        }
    }

    appLog(`Automation toggles updated by ${req.session.username}: ${JSON.stringify(patch)}`)

    res.json({
        ok: true,
        automation: {
            triviaAutoAnswer: patch.triviaAutoAnswer ?? (getBotConfig(req.session.username)?.triviaAutoAnswer !== false),
            backupKickEnabled: patch.backupKickEnabled ?? (getBotConfig(req.session.username)?.backupKickEnabled !== false),
            blackMarketAutoBuy: patch.blackMarketAutoBuy ?? !!getBotConfig(req.session.username)?.blackMarketAutoBuy,
            balanceAutoManage: patch.balanceAutoManage ?? (getBotConfig(req.session.username)?.balanceAutoManage === true)
        }
    })

})

// ============================================================
// PERMANENT TEAM RANKS (see checkAutoPromote above)
// ============================================================

app.get('/api/perm-ranks', (req, res) => {
    res.json({ list: getPermRanks(req.session.username) })
})

app.post('/api/perm-ranks/set', (req, res) => {

    const name = String(req.body?.name || '').trim()
    const rank = String(req.body?.rank || '').trim().toLowerCase()

    if (!name) {
        return res.status(400).json({ error: 'Name is required.' })
    }

    if (rank && rank !== 'officer' && rank !== 'captain') {
        return res.status(400).json({ error: 'Rank must be "officer", "captain", or empty to clear.' })
    }

    const list = getPermRanks(req.session.username).filter(entry => {
        const entryName = typeof entry === 'string' ? entry : entry?.name || ''
        return entryName.toLowerCase() !== name.toLowerCase()
    })

    if (rank) {
        list.push({ name, rank })
    }

    savePermRanks(req.session.username, list)

    const existing = sessions.get(req.session.username)

    if (existing) {
        existing.config.permRanks = list
    }

    res.json({ ok: true, list })

})

// ============================================================
// FLEET ACCOUNTS (lightweight extra Java/Bedrock connections)
// ============================================================

function fleetKey(username, accountId) {
    return `${username}:${accountId}`
}

app.get('/api/fleet', (req, res) => {

    const accounts = getFleetAccounts(req.session.username)

    const list = accounts.map(account => {

        const session = fleetSessions.get(fleetKey(req.session.username, account.id))

        return session ? session.getStatus() : {
            id: account.id,
            label: account.label || account.microsoftEmail,
            microsoftEmail: account.microsoftEmail,
            platform: account.platform,
            host: account.host,
            port: account.port,
            state: 'OFFLINE',
            online: false,
            botEnabled: false,
            lastError: null
        }

    })

    res.json({ accounts: list })

})

app.post('/api/fleet', (req, res) => {

    const account = normalizeFleetAccount(req.body)

    if (!account.microsoftEmail || !account.microsoftEmail.includes('@')) {
        return res.status(400).json({ error: 'Enter a valid Microsoft account email.' })
    }

    if (!account.host) {
        return res.status(400).json({ error: 'Enter a server address.' })
    }

    const accounts = getFleetAccounts(req.session.username)

    accounts.push(account)
    saveFleetAccounts(req.session.username, accounts)

    res.json({ ok: true, account })

})

app.put('/api/fleet/:id', (req, res) => {

    const accounts = getFleetAccounts(req.session.username)
    const index = accounts.findIndex(entry => entry.id === req.params.id)

    if (index === -1) {
        return res.status(404).json({ error: 'Account not found.' })
    }

    const account = normalizeFleetAccount(req.body, accounts[index])

    accounts[index] = account
    saveFleetAccounts(req.session.username, accounts)

    const session = fleetSessions.get(fleetKey(req.session.username, account.id))

    if (session) {
        session.config = account
    }

    res.json({ ok: true, account })

})

app.delete('/api/fleet/:id', (req, res) => {

    const accounts = getFleetAccounts(req.session.username)
    const filtered = accounts.filter(entry => entry.id !== req.params.id)

    saveFleetAccounts(req.session.username, filtered)

    const key = fleetKey(req.session.username, req.params.id)
    const session = fleetSessions.get(key)

    if (session) {
        session.shutdown()
        fleetSessions.delete(key)
    }

    res.json({ ok: true })

})

function startFleetAccount(username, accountId) {

    const accounts = getFleetAccounts(username)
    const config = accounts.find(entry => entry.id === accountId)

    if (!config) {
        return { ok: false, error: 'Account not found.' }
    }

    const key = fleetKey(username, accountId)
    let session = fleetSessions.get(key)

    if (!session) {
        session = new FleetAccount(username, config)
        fleetSessions.set(key, session)
    } else {
        session.config = config
    }

    session.start()

    return { ok: true }

}

function stopFleetAccount(username, accountId) {

    const session = fleetSessions.get(fleetKey(username, accountId))

    if (!session) {
        return { ok: false, error: 'Not running.' }
    }

    session.stop()

    return { ok: true }

}

app.post('/api/fleet/:id/connect', (req, res) => {
    res.json(startFleetAccount(req.session.username, req.params.id))
})

app.post('/api/fleet/:id/stop', (req, res) => {
    res.json(stopFleetAccount(req.session.username, req.params.id))
})

app.post('/api/fleet/connect-all', (req, res) => {

    const accounts = getFleetAccounts(req.session.username)
    const results = accounts.map(account => ({ id: account.id, ...startFleetAccount(req.session.username, account.id) }))

    res.json({ results })

})

app.post('/api/fleet/stop-all', (req, res) => {

    const accounts = getFleetAccounts(req.session.username)
    const results = accounts.map(account => ({ id: account.id, ...stopFleetAccount(req.session.username, account.id) }))

    res.json({ results })

})

// Manual merge for two Leaderboard rows that should be the same
// player (a rename - see combineLeaderboardPlayers above).
app.post('/api/combine-leaderboard', (req, res) => {

    const result = combineLeaderboardPlayers(req.session.username, req.body?.nameA, req.body?.nameB)

    if (!result.ok) {
        return res.status(400).json({ error: result.error })
    }

    res.json(result)

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
    res.json({
        isAdmin: req.session.username === DASHBOARD_USERNAME,
        username: req.session.username,
        impersonating: !!req.session.adminUsername
    })
})

// Self-signup is closed - only the admin account can create new
// accounts, from Settings -> Account. Doesn't touch req.session, so
// the admin stays logged in as themselves after creating one for
// someone else.
app.post('/api/admin/create-account', (req, res) => {

    if (req.session.username !== DASHBOARD_USERNAME) {
        return res.status(403).json({ error: 'Only the admin account can create new accounts.' })
    }

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
        createdAt: new Date().toISOString(),
        createdByAdmin: true
    })

    saveUsers(users)

    appLog(`Account created by admin: ${username}`)

    return res.json({ ok: true })

})

// Everyone the admin has created, for the "Manage Accounts" list in
// Settings -> Account. Excludes the admin account itself.
app.get('/api/admin/accounts', (req, res) => {

    if (req.session.username !== DASHBOARD_USERNAME) {
        return res.status(403).json({ error: 'Only the admin account can view this.' })
    }

    const users = loadUsers()
        .filter(user => user.username !== DASHBOARD_USERNAME)
        .map(user => {

            const botSession = sessions.get(user.username)
            const config = getBotConfig(user.username)

            return {
                username: user.username,
                createdAt: user.createdAt || null,
                platform: config?.platform === 'bedrock' ? 'bedrock' : 'java',
                configured: !!config,
                state: botSession?.botState || 'OFFLINE'
            }

        })

    res.json({ users })

})

// Bulk start/stop for the admin's "select several accounts" UI -
// same per-account checks (configured, no Microsoft-account conflict)
// as the normal single-account start/stop path, just looped, with a
// per-account result reported back rather than one all-or-nothing
// response.
app.post('/api/admin/bulk-start', (req, res) => {

    if (req.session.username !== DASHBOARD_USERNAME) {
        return res.status(403).json({ error: 'Only the admin account can do this.' })
    }

    const usernames = Array.isArray(req.body?.usernames) ? req.body.usernames : []

    const results = usernames.map(username => {

        const config = getBotConfig(username)

        if (!config) {
            return { username, ok: false, error: 'Not configured yet.' }
        }

        const conflict = findConflictingSession(username, config.microsoftEmail)

        if (conflict) {
            return { username, ok: false, error: `Already connected under ${conflict.username}.` }
        }

        getOrCreateSession(username).startBotRemote()

        return { username, ok: true }

    })

    res.json({ results })

})

app.post('/api/admin/bulk-stop', (req, res) => {

    if (req.session.username !== DASHBOARD_USERNAME) {
        return res.status(403).json({ error: 'Only the admin account can do this.' })
    }

    const usernames = Array.isArray(req.body?.usernames) ? req.body.usernames : []

    const results = usernames.map(username => {

        const botSession = sessions.get(username)

        if (!botSession) {
            return { username, ok: false, error: 'Not running.' }
        }

        botSession.stopBotRemote()

        return { username, ok: true }

    })

    res.json({ results })

})

// Resets any account's password without needing their current one -
// for when someone forgets it. Doesn't touch req.session.
app.post('/api/admin/reset-password', (req, res) => {

    if (req.session.username !== DASHBOARD_USERNAME) {
        return res.status(403).json({ error: 'Only the admin account can do this.' })
    }

    const { username, newPassword } = req.body || {}

    if (!username) {
        return res.status(400).json({ error: 'Username required.' })
    }

    if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` })
    }

    const users = loadUsers()
    const user = findUser(users, username)

    if (!user) {
        return res.status(404).json({ error: 'No such account.' })
    }

    const { salt, hash } = hashPassword(newPassword)

    user.salt = salt
    user.hash = hash

    saveUsers(users)

    appLog(`Admin reset the password for: ${username}`)

    res.json({ ok: true })

})

// Switches the admin's own session to view as another account,
// without needing that account's password - for checking on/fixing
// something from their side. Only the real admin can start this (an
// impersonated session's req.session.username is the target account,
// not the admin, so this naturally can't be chained). The admin's own
// username is stashed in req.session.adminUsername so
// stop-impersonating can restore it.
app.post('/api/admin/impersonate', (req, res) => {

    if (req.session.username !== DASHBOARD_USERNAME) {
        return res.status(403).json({ error: 'Only the admin account can do this.' })
    }

    const { username } = req.body || {}

    if (!username) {
        return res.status(400).json({ error: 'Username required.' })
    }

    if (username === DASHBOARD_USERNAME) {
        return res.status(400).json({ error: "You're already the admin account." })
    }

    const users = loadUsers()

    if (!findUser(users, username)) {
        return res.status(404).json({ error: 'No such account.' })
    }

    req.session.adminUsername = DASHBOARD_USERNAME
    req.session.username = username

    appLog(`Admin started viewing as: ${username}`)

    res.json({ ok: true })

})

app.post('/api/admin/stop-impersonating', (req, res) => {

    if (!req.session.adminUsername) {
        return res.status(400).json({ error: "You're not currently viewing as another account." })
    }

    appLog(`Admin returned from viewing as: ${req.session.username}`)

    req.session.username = req.session.adminUsername
    delete req.session.adminUsername

    res.json({ ok: true })

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

// ============================================================
// ADMIN PASSWORD CHANGE (triple-verified: password + email + authenticator)
// ============================================================
// The admin password can be changed in-app, but only with all three
// factors, since it's the most powerful credential: the CURRENT password,
// a code emailed to the recovery address, AND a live authenticator code.
// That requires 2FA to be on and a recovery email set up first.

app.post('/api/admin/password/start', async (req, res) => {

    if (req.session.username !== DASHBOARD_USERNAME) {
        return res.status(403).json({ error: 'Only the admin account can do this.' })
    }

    if (!isTwoFactorEnabled(req.session.username) || !getRecoveryEmail(req.session.username) || !mailConfigured()) {
        return res.status(400).json({ error: 'To change the admin password you first need 2FA enabled AND a recovery email set up (those are the email + authenticator factors).' })
    }

    const { currentPassword, newPassword } = req.body || {}

    if (!verifyAdminPassword(currentPassword)) {
        return res.status(401).json({ error: 'Current password is incorrect.' })
    }

    if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.` })
    }

    if (verifyAdminPassword(newPassword)) {
        return res.status(400).json({ error: 'That is already your current password.' })
    }

    // Stash the pending change in the session: the new password already
    // ENCRYPTED (so the plaintext never sits in the session) plus a hashed
    // email code, both short-lived.
    const emailCode = String(crypto.randomInt(0, 1000000)).padStart(6, '0')
    const codeCred = hashPassword(emailCode)

    req.session.pendingAdminPwChange = {
        newEnc: encryptSecret(newPassword),
        codeSalt: codeCred.salt,
        codeHash: codeCred.hash,
        expiresAt: Date.now() + RECOVERY_CODE_TTL_MS,
        attempts: 0
    }

    const recoveryEmail = getRecoveryEmail(req.session.username)

    try {
        await sendMail(
            recoveryEmail,
            'Voidz.IO password change code',
            `Your Voidz.IO admin password-change code is: ${emailCode}\n\nEnter it along with your authenticator code to finish changing your password. It expires in 10 minutes. If you didn't request this, ignore this email and your password stays the same.`,
            buildCodeEmailHtml({
                heading: 'Confirm your password change',
                intro: 'Enter this code, plus a code from your authenticator app, to finish changing your Voidz.IO admin password.',
                code: emailCode,
                note: "If you didn't request this, ignore this email - nothing changes."
            })
        )
    } catch (error) {
        delete req.session.pendingAdminPwChange
        appLog(`Admin password change email failed: ${error.message}`)
        return res.status(500).json({ error: 'Could not send the email code. Try again shortly.' })
    }

    res.json({ ok: true })

})

app.post('/api/admin/password/confirm', (req, res) => {

    if (req.session.username !== DASHBOARD_USERNAME) {
        return res.status(403).json({ error: 'Only the admin account can do this.' })
    }

    const pending = req.session.pendingAdminPwChange

    if (!pending || pending.expiresAt < Date.now()) {
        delete req.session.pendingAdminPwChange
        return res.status(400).json({ error: 'No password change in progress (or it expired). Start over.' })
    }

    const emailCode = String(req.body?.emailCode || '').trim()
    const authenticatorCode = String(req.body?.authenticatorCode || '').trim()

    const record = getTwoFactorRecord(req.session.username)

    const emailOk = verifyPassword(emailCode, pending.codeSalt, pending.codeHash)
    const authOk = record && record.secret && verifyTotp(record.secret, authenticatorCode)

    if (!emailOk || !authOk) {
        pending.attempts = (pending.attempts || 0) + 1
        if (pending.attempts >= 5) {
            delete req.session.pendingAdminPwChange
            return res.status(429).json({ error: 'Too many incorrect codes. Start over.' })
        }
        return res.status(401).json({ error: `Check both codes and try again (${emailOk ? 'authenticator' : authOk ? 'email' : 'both'} code wrong).` })
    }

    writeAdminPasswordOverride(pending.newEnc)
    delete req.session.pendingAdminPwChange

    appLog(`Admin password changed by ${req.session.username}`)

    sendSecurityAlert(getRecoveryEmail(req.session.username), 'Admin password was changed', 'The password for your Voidz.IO admin account was just changed.')

    res.json({ ok: true })

})

// View the current admin password - gated behind an emailed code (so just
// having an admin session open isn't enough to reveal it). Requires a
// recovery email + mail set up.
app.post('/api/admin/password/view/start', async (req, res) => {

    if (req.session.username !== DASHBOARD_USERNAME) {
        return res.status(403).json({ error: 'Only the admin account can do this.' })
    }

    const recoveryEmail = getRecoveryEmail(req.session.username)

    if (!recoveryEmail || !mailConfigured()) {
        return res.status(400).json({ error: 'Set up a recovery email first (that is where the code is sent).' })
    }

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0')
    const codeCred = hashPassword(code)

    req.session.pendingAdminPwView = {
        codeSalt: codeCred.salt,
        codeHash: codeCred.hash,
        expiresAt: Date.now() + RECOVERY_CODE_TTL_MS,
        attempts: 0
    }

    try {
        await sendMail(
            recoveryEmail,
            'Voidz.IO password view code',
            `Someone asked to view your Voidz.IO admin password. Your code is: ${code}\n\nIt expires in 10 minutes. If this wasn't you, do NOT share it - and change your password.`,
            buildCodeEmailHtml({
                heading: 'Code to view your password',
                intro: 'Enter this code in the dashboard to reveal your current admin password.',
                code,
                note: "If you didn't ask to view your password, do not share this code."
            })
        )
    } catch (error) {
        delete req.session.pendingAdminPwView
        appLog(`Admin password view email failed: ${error.message}`)
        return res.status(500).json({ error: 'Could not send the email code. Try again shortly.' })
    }

    res.json({ ok: true })

})

app.post('/api/admin/password/view/confirm', (req, res) => {

    if (req.session.username !== DASHBOARD_USERNAME) {
        return res.status(403).json({ error: 'Only the admin account can do this.' })
    }

    const pending = req.session.pendingAdminPwView

    if (!pending || pending.expiresAt < Date.now()) {
        delete req.session.pendingAdminPwView
        return res.status(400).json({ error: 'No request in progress (or it expired). Start over.' })
    }

    const code = String(req.body?.code || '').trim()

    if (!verifyPassword(code, pending.codeSalt, pending.codeHash)) {
        pending.attempts = (pending.attempts || 0) + 1
        if (pending.attempts >= 5) {
            delete req.session.pendingAdminPwView
            return res.status(429).json({ error: 'Too many incorrect codes. Start over.' })
        }
        return res.status(401).json({ error: 'That code is incorrect.' })
    }

    delete req.session.pendingAdminPwView

    const password = getAdminPasswordPlaintext()

    if (password === null) {
        return res.status(500).json({ error: "Your password was changed in-app but can't be decrypted (SESSION_SECRET may have changed). Reset it instead." })
    }

    appLog(`Admin password viewed by ${req.session.username}`)

    res.json({ ok: true, password })

})

// ============================================================
// TWO-FACTOR AUTH MANAGEMENT (admin-only, from Settings -> Account)
// ============================================================

app.get('/api/2fa/status', (req, res) => {
    const email = getRecoveryEmail(req.session.username)
    const record = getTwoFactorRecord(req.session.username)
    res.json({
        isAdmin: req.session.username === DASHBOARD_USERNAME,
        enabled: isTwoFactorEnabled(req.session.username),
        disabledByEnv: TWO_FACTOR_DISABLED,
        emailConfigured: mailConfigured(),
        recoveryEmail: email ? maskEmail(email) : null,
        loginAlerts: record ? record.loginAlerts !== false : true
    })
})

// Toggle new-device login-alert emails.
app.post('/api/2fa/login-alerts', (req, res) => {

    if (req.session.username !== DASHBOARD_USERNAME) {
        return res.status(403).json({ error: 'Only the admin account can manage 2FA.' })
    }

    const store = loadTwoFactor()
    const record = store[req.session.username]

    if (!record) {
        return res.status(400).json({ error: 'Enable 2FA first.' })
    }

    record.loginAlerts = !!req.body?.enabled
    saveTwoFactor(store)

    res.json({ ok: true, loginAlerts: record.loginAlerts })

})

// The signed-in account's own recent login activity (any user).
app.get('/api/login-activity', (req, res) => {
    res.json({ events: getLoginActivity(req.session.username) })
})

// Recovery email: start verification by emailing a 6-digit code to the
// address. Only once 2FA is on (there's nothing to recover otherwise).
app.post('/api/2fa/recovery-email/start', async (req, res) => {

    if (req.session.username !== DASHBOARD_USERNAME) {
        return res.status(403).json({ error: 'Only the admin account can manage 2FA.' })
    }

    if (!isTwoFactorEnabled(req.session.username)) {
        return res.status(400).json({ error: 'Enable 2FA first.' })
    }

    if (!mailConfigured()) {
        return res.status(400).json({ error: 'Email sending is not set up on this server (SMTP_USER / SMTP_PASS).' })
    }

    const email = String(req.body?.email || '').trim()

    if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'Enter a valid email address.' })
    }

    const code = startRecoveryEmailVerification(req.session.username, email)

    if (!code) {
        return res.status(400).json({ error: 'Could not start verification.' })
    }

    try {
        await sendMail(
            email,
            'Confirm your Voidz.IO recovery email',
            `Your Voidz.IO recovery-email verification code is: ${code}\n\nIt expires in 10 minutes.`,
            buildCodeEmailHtml({
                heading: 'Confirm your recovery email',
                intro: 'Enter this code in your Voidz.IO dashboard to set this address as your 2FA recovery email.',
                code,
                note: 'This code expires in 10 minutes.'
            })
        )
    } catch (error) {
        appLog(`Recovery email verification send failed: ${error.message}`)
        return res.status(500).json({ error: 'Could not send the verification email. Check the address and try again.' })
    }

    res.json({ ok: true })

})

// Recovery email: confirm the code, which saves the address.
app.post('/api/2fa/recovery-email/verify', (req, res) => {

    if (req.session.username !== DASHBOARD_USERNAME) {
        return res.status(403).json({ error: 'Only the admin account can manage 2FA.' })
    }

    const code = String(req.body?.code || '').trim()

    // Remember the old address so, if this is a CHANGE, we can warn the
    // previous one that recovery was pointed somewhere else.
    const previousEmail = getRecoveryEmail(req.session.username)

    if (!verifyRecoveryEmail(req.session.username, code)) {
        return res.status(401).json({ error: 'That code is incorrect or expired.' })
    }

    const newEmail = getRecoveryEmail(req.session.username)

    if (previousEmail && previousEmail !== newEmail) {
        sendSecurityAlert(previousEmail, 'Recovery email was changed', `Your Voidz.IO recovery email was changed to ${maskEmail(newEmail)}. Recovery codes will now go there instead of here.`)
    }

    appLog(`Recovery email verified for ${req.session.username}`)
    res.json({ ok: true, recoveryEmail: maskEmail(newEmail) })

})

// Recovery email: remove it.
app.post('/api/2fa/recovery-email/remove', (req, res) => {

    if (req.session.username !== DASHBOARD_USERNAME) {
        return res.status(403).json({ error: 'Only the admin account can manage 2FA.' })
    }

    const removedEmail = getRecoveryEmail(req.session.username)

    removeRecoveryEmail(req.session.username)
    appLog(`Recovery email removed for ${req.session.username}`)

    sendSecurityAlert(removedEmail, 'Recovery email was removed', 'Your Voidz.IO recovery email was removed. Email-based account recovery is now off.')

    res.json({ ok: true })

})

// Sends a sample recovery email to the saved address, so the admin can
// confirm it arrives (and check it's not in spam) without being locked
// out. Not a real code - just shows what one looks like.
app.post('/api/2fa/recovery-email/test', async (req, res) => {

    if (req.session.username !== DASHBOARD_USERNAME) {
        return res.status(403).json({ error: 'Only the admin account can manage 2FA.' })
    }

    if (!mailConfigured()) {
        return res.status(400).json({ error: 'Email sending is not set up on this server.' })
    }

    const email = getRecoveryEmail(req.session.username)

    if (!email) {
        return res.status(400).json({ error: 'Set and verify a recovery email first.' })
    }

    try {
        await sendMail(
            email,
            'Voidz.IO test email',
            'This is a test email from your Voidz.IO dashboard. If you can read this, email recovery is working.',
            buildCodeEmailHtml({
                heading: 'Test email',
                intro: "This is a test from your Voidz.IO dashboard - email recovery is working. No action needed; the code below is just a sample.",
                code: '123456',
                note: 'Real login codes will look exactly like this.'
            })
        )
    } catch (error) {
        appLog(`Recovery test email failed for ${req.session.username}: ${error.message}`)
        return res.status(500).json({ error: 'Could not send the test email. Try again shortly.' })
    }

    res.json({ ok: true, recoveryEmail: maskEmail(email) })

})

// Panic button: immediately end this session AND revoke every trusted
// device, so the next login requires the full authenticator code even on
// a browser that was inside its 72h trust window.
app.post('/api/2fa/panic', (req, res) => {

    if (!req.session?.loggedIn || !req.session.username) {
        return res.status(401).json({ error: 'Not logged in.' })
    }

    const username = req.session.username

    clearTrustedDevices(username)

    appLog(`Panic triggered by ${username}: trusted devices revoked, session ended.`)

    req.session.destroy(() => {
        res.clearCookie('connect.sid')
        res.clearCookie(TRUSTED_DEVICE_COOKIE)
        res.json({ ok: true })
    })

})

// Begins setup: generates a fresh (pending, not-yet-enabled) secret and
// returns the QR + manual key to add to an authenticator app. Pending
// until a code is verified via /enable.
app.post('/api/2fa/setup', async (req, res) => {

    if (req.session.username !== DASHBOARD_USERNAME) {
        return res.status(403).json({ error: 'Only the admin account can set up 2FA.' })
    }

    if (TWO_FACTOR_DISABLED) {
        return res.status(400).json({ error: '2FA is disabled on this server (DISABLE_2FA).' })
    }

    if (isTwoFactorEnabled(req.session.username)) {
        return res.status(409).json({ error: '2FA is already enabled. Disable it first to re-set up.' })
    }

    const secret = base32Encode(crypto.randomBytes(20))
    const label = encodeURIComponent(`Voidz.IO:${req.session.username}`)
    const otpauthUri = `otpauth://totp/${label}?secret=${secret}&issuer=Voidz.IO&digits=6&period=30`

    const store = loadTwoFactor()
    store[req.session.username] = {
        enabled: false,
        secret,
        backupCodes: [],
        trustedDevices: []
    }
    saveTwoFactor(store)

    let qrSvg = ''
    try {
        qrSvg = await QRCode.toString(otpauthUri, { type: 'svg', margin: 1, width: 200 })
    } catch (error) {
        appLog(`2FA QR generation failed: ${error.message}`)
    }

    res.json({ secret, otpauthUri, qrSvg })

})

// Confirms setup: a valid code proves the authenticator is configured.
// Flips the record to enabled and returns 10 one-time backup codes
// (shown to the user exactly once).
app.post('/api/2fa/enable', (req, res) => {

    if (req.session.username !== DASHBOARD_USERNAME) {
        return res.status(403).json({ error: 'Only the admin account can set up 2FA.' })
    }

    const store = loadTwoFactor()
    const record = store[req.session.username]

    if (!record || !record.secret || record.enabled) {
        return res.status(400).json({ error: 'Start setup first.' })
    }

    const code = String(req.body?.code || '').trim()

    if (!verifyTotp(record.secret, code)) {
        return res.status(401).json({ error: 'That code is incorrect. Check your authenticator app and try again.' })
    }

    const { plain, stored } = generateBackupCodes()

    record.enabled = true
    record.backupCodes = stored
    record.trustedDevices = []
    saveTwoFactor(store)

    appLog(`2FA enabled for ${req.session.username}`)

    res.json({ ok: true, backupCodes: plain })

})

// Turns 2FA off. Requires a current code (or a backup code) so a merely
// logged-in session (e.g. left open) can't silently strip the account's
// second factor. Clears the secret and all trusted devices.
app.post('/api/2fa/disable', (req, res) => {

    if (req.session.username !== DASHBOARD_USERNAME) {
        return res.status(403).json({ error: 'Only the admin account can manage 2FA.' })
    }

    if (!isTwoFactorEnabled(req.session.username)) {
        return res.status(400).json({ error: '2FA is not enabled.' })
    }

    const record = getTwoFactorRecord(req.session.username)
    const code = String(req.body?.code || '').trim()

    if (!verifyTotp(record.secret, code) && !consumeBackupCode(req.session.username, code)) {
        return res.status(401).json({ error: 'Enter a current code (or a backup code) to turn 2FA off.' })
    }

    // Capture the recovery email before the record (and it) are deleted,
    // so we can still warn that address that 2FA was just turned off.
    const alertEmail = record.recoveryEmail || null

    const store = loadTwoFactor()
    delete store[req.session.username]
    saveTwoFactor(store)

    res.clearCookie(TRUSTED_DEVICE_COOKIE)

    appLog(`2FA disabled for ${req.session.username}`)

    sendSecurityAlert(alertEmail, 'Two-factor authentication was turned OFF', 'Someone disabled 2FA on your Voidz.IO admin account. Logins no longer require an authenticator code.')

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
        botSession.touchOnlinePlayers()
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

    // Live movement from the POV card. Kept off the 'command' path so
    // it doesn't fire a toast per keystroke and stays low-latency.
    socket.on('botMove', payload => {

        const activeSession = sessions.get(username)
        if (!activeSession) return

        const action = String(payload?.action || '')

        if (action === 'stop-all') {
            activeSession.stopAllMovement()
            return
        }

        activeSession.setMovement(action, !!payload?.state)

    })

    socket.on('botLook', payload => {

        const activeSession = sessions.get(username)
        if (!activeSession) return

        activeSession.turnBot(payload?.dYaw, payload?.dPitch)

    })

    socket.on('disconnect', () => {
        // Don't leave the bot walking when the only dashboard driving it
        // goes away. (Harmless if another tab is still connected - it can
        // just press the key again.)
        const activeSession = sessions.get(username)
        if (activeSession) activeSession.stopAllMovement()
        originalLog(`[WEB] Dashboard disconnected: ${username}`)
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
    originalLog('/sidebar-debug')
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
        case '/sidebar-debug': adminSession.debugSidebar(); break
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

    for (const fleetAccount of fleetSessions.values()) {
        fleetAccount.shutdown()
    }

    flushBotConfigsSync()

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
