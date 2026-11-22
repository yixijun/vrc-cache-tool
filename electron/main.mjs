import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createConfigStore } from './config.mjs'
import { closestDirectory, diagnose } from './diagnostics.mjs'
import { assetFolder, cacheDirectory } from './settings.mjs'

const base = path.join(homedir(), 'AppData', 'LocalLow', 'VRChat', 'VRChat')
const store = createConfigStore(base)
const page = fileURLToPath(new URL('../dist/index.html', import.meta.url))
const pageUrl = pathToFileURL(page).href
const icon = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.ico')
  : fileURLToPath(new URL('../assets/icon.ico', import.meta.url))
let window
let saving = false

function register(channel, action) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== pageUrl) {
      return { ok: false, error: '无法确认窗口来源。' }
    }
    try {
      return { ok: true, value: await action(...args) }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  })
}

async function openFolder(directory) {
  if (!(await closestDirectory(directory)).exists) throw new Error('文件夹还未创建。')
  const error = await shell.openPath(directory)
  if (error) throw new Error(error)
}

function createWindow() {
  window = new BrowserWindow({
    width: 1056,
    height: 770,
    minWidth: 670,
    minHeight: 575,
    icon,
    backgroundColor: '#101319',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#151a22', symbolColor: '#bcc8d8', height: 43 },
    show: false,
    webPreferences: {
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => { window = undefined })
  window.loadFile(page).catch(error => {
    dialog.showErrorBox('VRChat 缓存工具', `无法加载界面。${error.message}`)
    app.quit()
  })
}

app.setAppUserModelId('io.github.yixijun.VRChatCacheTool')

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore()
    window?.focus()
  })
  app.whenReady().then(() => {
    nativeTheme.themeSource = 'dark'
    Menu.setApplicationMenu(null)
    register('config:load', store.load)
    register('config:save', async (form, revision) => {
      if (saving) throw new Error('正在保存，请稍候。')
      saving = true
      try { return await store.save(form, revision) } finally { saving = false }
    })
    register('cache:diagnose', form => diagnose(form, base))
    register('cache:pick-directory', async current => {
      let defaultPath
      try { defaultPath = (await closestDirectory(cacheDirectory(current, base))).path } catch { /* Let the dialog choose. */ }
      const { canceled, filePaths } = await dialog.showOpenDialog(window, { defaultPath, properties: ['openDirectory'] })
      return canceled ? null : filePaths[0]
    })
    register('cache:open', async current => {
      const directory = cacheDirectory(current, base)
      const assets = path.join(directory, assetFolder)
      await openFolder((await closestDirectory(assets)).exists ? assets : directory)
    })
    register('config:open', () => openFolder(base))
    register('docs:open', () => shell.openExternal('https://docs.vrchat.com/docs/configuration-file#cache-settings'))
    createWindow()
  })
  app.on('window-all-closed', () => app.quit())
}
