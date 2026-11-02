'use strict'

const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron')
const path = require('path')
const fs = require('fs')

// Where the chosen dashboard URL is remembered between launches.
const configFile = () => path.join(app.getPath('userData'), 'config.json')

function loadDashboardUrl() {
    try {
        const parsed = JSON.parse(fs.readFileSync(configFile(), 'utf8'))
        return typeof parsed.url === 'string' && parsed.url ? parsed.url : null
    } catch {
        return null
    }
}

function saveDashboardUrl(url) {
    try {
        fs.writeFileSync(configFile(), JSON.stringify({ url }, null, 2))
    } catch (error) {
        console.error('Could not save config:', error.message)
    }
}

let mainWindow = null

function showDashboardOrSetup() {
    const url = loadDashboardUrl()
    if (url) {
        mainWindow.loadURL(url)
    } else {
        mainWindow.loadFile(path.join(__dirname, 'setup.html'))
    }
}

function createWindow() {

    mainWindow = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 480,
        minHeight: 600,
        backgroundColor: '#0b0c10',
        title: 'Voidz.IO',
        autoHideMenuBar: true,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(__dirname, 'preload.js')
        }
    })

    showDashboardOrSetup()
    buildMenu()
}

function buildMenu() {

    const template = [
        {
            label: 'Voidz.IO',
            submenu: [
                { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => mainWindow.reload() },
                { label: 'Change dashboard URL…', click: () => mainWindow.loadFile(path.join(__dirname, 'setup.html')) },
                { type: 'separator' },
                { role: 'quit' }
            ]
        },
        {
            label: 'View',
            submenu: [
                { role: 'togglefullscreen' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'toggleDevTools' }
            ]
        }
    ]

    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// setup.html calls this to save the URL and jump into the dashboard.
ipcMain.handle('voidz-save-url', (event, rawUrl) => {
    let url = String(rawUrl || '').trim()
    if (!url) return { ok: false, error: 'Enter a URL.' }
    if (!/^https?:\/\//i.test(url)) url = 'http://' + url
    saveDashboardUrl(url)
    mainWindow.loadURL(url)
    return { ok: true }
})

// Links that open a new window/tab in the dashboard (the Bot POV viewer on
// its own port, the Microsoft sign-in page, etc.) open in the real browser
// instead of a bare Electron window.
app.on('web-contents-created', (event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url)
        return { action: 'deny' }
    })
})

app.whenReady().then(createWindow)

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

app.on('window-all-closed', () => {
    app.quit()
})
