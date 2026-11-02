# Voidz.IO Desktop

A thin Electron wrapper that opens the Voidz.IO dashboard in its own desktop
window (like the Discord/Spotify desktop apps). It does **not** run the bot —
it just connects to your dashboard server (on the VM) the same way a browser
does. First launch asks for the dashboard address and remembers it.

## Run from source

```
npm install
# download the Electron binary if your install blocked postinstall scripts:
node node_modules/electron/install.js
npm start
```

## Build the Windows app

```
npm run build
```

Output: `dist/Voidz.IO-win32-x64/` — run **`Voidz.IO.exe`** inside it. Keep the
whole folder together (the .exe needs the files next to it). To share it, zip
the folder.

Notes:
- The ~180MB size is the bundled Chromium runtime; that's normal for Electron.
- Links that open a new tab in the dashboard (the Bot POV viewer, the Microsoft
  sign-in page) open in your real browser.
- To change the dashboard address later: menu → Voidz.IO → "Change dashboard URL".
