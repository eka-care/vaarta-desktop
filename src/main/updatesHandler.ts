import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import fs from 'node:fs';
import path from 'node:path';

const AUTO_UPDATE_FEED_URL = 'https://vaarta-app.ekacare.co/prod/latest/';
const AUTO_UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 60 * 1000;

export function logUpdater(message: string, meta?: unknown): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}\n`;
  try {
    const logFilePath = path.join(app.getPath('userData'), 'updater.log');
    fs.appendFileSync(logFilePath, line, 'utf8');
  } catch {
    // best-effort file logging only
  }
}

let log: (message: string, meta?: unknown) => void = () => {};
let getMainWindowRef: () => BrowserWindow | null = () => null;

let autoUpdateInterval: NodeJS.Timeout | null = null;
let updatePopupWindow: BrowserWindow | null = null;
let hasRegisteredAutoUpdaterListeners = false;
let isUpdateAvailable = false;
let isUpdateDownloaded = false;
let isUpdateDownloadInProgress = false;
let updatePopupAwaitingDownloadResult = false;
let latestUpdateVersion: string | null = null;

export function reflushUpdateStateToWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  if (isUpdateDownloaded) {
    logUpdater('reflush: sending update-ready to window', { url: win.webContents.getURL() });
    win.webContents.send('desktop:update-ready');
  } else if (isUpdateAvailable && latestUpdateVersion) {
    logUpdater('reflush: sending update-available to window', { version: latestUpdateVersion, url: win.webContents.getURL() });
    win.webContents.send('desktop:update-available', { version: latestUpdateVersion });
  }
}

export function runAutoUpdateCheck(reason: string): void {
  // if (!app.isPackaged) return;
  if (reason === 'menu' && isUpdateAvailable) {
    startUpdateInstallFlow();
    return;
  }
  void autoUpdater
    .checkForUpdates()
    .then((result) => {
      if (!result?.isUpdateAvailable && reason == 'menu') {
        void dialog.showMessageBox({
          type: 'info',
          title: 'No Updates Available',
          message: `You're using the latest version of ${app.name}.`,
          detail: `Current version: ${app.getVersion()}`,
          buttons: ['OK'],
        });
      }
      log('auto update check completed', {
        reason,
        updateInfo: result?.updateInfo?.version ?? null,
      });
      logUpdater('auto update check completed', {
        reason,
        updateInfo: result?.updateInfo?.version ?? null,
      });
    })
    .catch((error: unknown) => {
      log('auto update check failed', {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      logUpdater('auto update check failed', {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

function getUpdatePopupHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>Update is available</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: #0b1220;
        color: #e5e7eb;
        font-family: "Segoe UI", sans-serif;
      }
      .wrap {
        height: 100vh;
        padding: 10px 12px;
        border: 1px solid #1f2937;
        border-radius: 10px;
        background: linear-gradient(135deg, #0b1220 0%, #111827 100%);
        display: flex;
        flex-direction: column;
        justify-content: space-between;
      }
      .title {
        font-size: 13px;
        font-weight: 600;
        line-height: 1.3;
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
      button {
        border: none;
        border-radius: 8px;
        padding: 6px 10px;
        font-size: 12px;
        cursor: pointer;
      }
      #later { background: #374151; color: #f3f4f6; }
      #update { background: #2563eb; color: #ffffff; }
      #update:disabled { opacity: 0.65; cursor: default; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="title">Update is available</div>
      <div class="actions">
        <button id="later" type="button">Later</button>
        <button id="update" type="button">Update</button>
      </div>
    </div>
    <script>
      const updateBtn = document.getElementById('update');
      document.getElementById('later').addEventListener('click', () => {
        window.popupApi.sendUpdaterAction('later');
        window.close();
      });
      updateBtn.addEventListener('click', () => {
        updateBtn.disabled = true;
        updateBtn.textContent = 'Updating...';
        window.popupApi.sendUpdaterAction('update');
      });
    </script>
  </body>
</html>`;
}

function closeUpdatePopup(): void {
  if (!updatePopupWindow || updatePopupWindow.isDestroyed()) {
    updatePopupWindow = null;
    return;
  }
  updatePopupAwaitingDownloadResult = false;
  updatePopupWindow.close();
  updatePopupWindow = null;
}

function resetUpdatePopupAfterDownloadFailure(error: unknown): void {
  if (!updatePopupWindow || updatePopupWindow.isDestroyed()) return;
  const message = error instanceof Error ? error.message : String(error);
  const short =
    message.includes('ZIP file not provided') || message.toLowerCase().includes('.zip')
      ? 'Update package on the server is incomplete (macOS needs a .zip in the feed).'
      : message;
  const script = `(() => {
    const updateBtn = document.getElementById('update');
    if (updateBtn) {
      updateBtn.disabled = false;
      updateBtn.textContent = 'Update';
    }
    const title = document.querySelector('.title');
    if (title) title.textContent = ${JSON.stringify(short)};
  })()`;
  void updatePopupWindow.webContents.executeJavaScript(script).catch(() => {
    // Popup may already be closing.
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function positionUpdatePopupInsideApp(_hostWindow: BrowserWindow): void {
  // Update is now shown as an in-app banner in the renderer; no popup to position.
}

function showUpdatePopup(): void {
  if (!isUpdateAvailable) return;
  const hostWindow = getMainWindowRef() ?? BrowserWindow.getAllWindows()[0];
  if (!hostWindow || hostWindow.isDestroyed()) return;
  if (updatePopupWindow && !updatePopupWindow.isDestroyed()) {
    positionUpdatePopupInsideApp(hostWindow);
    updatePopupWindow.show();
    updatePopupWindow.focus();
    return;
  }

  const width = 280;
  const height = 92;
  const hostBounds = hostWindow.getBounds();
  updatePopupWindow = new BrowserWindow({
    width,
    height,
    x: hostBounds.x + 12,
    y: hostBounds.y + hostBounds.height - height - 12,
    parent: hostWindow,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: false,
    title: 'Update is available',
    show: false,
    transparent: false,
    webPreferences: {
      preload: path.join(__dirname, 'popupPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  updatePopupWindow.setMenuBarVisibility(false);
  updatePopupWindow.on('closed', () => {
    updatePopupWindow = null;
  });
  const popupHtml = getUpdatePopupHtml();
  void updatePopupWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(popupHtml)}`);
  updatePopupWindow.once('ready-to-show', () => {
    positionUpdatePopupInsideApp(hostWindow);
    updatePopupWindow?.show();
  });
}

function startUpdateInstallFlow(): void {
  if (!isUpdateAvailable) return;
  if (isUpdateDownloaded) {
    logUpdater('quit and install triggered');
    closeUpdatePopup();
    autoUpdater.quitAndInstall();
    return;
  }
  if (isUpdateDownloadInProgress) return;
  logUpdater('download triggered by user');
  isUpdateDownloadInProgress = true;
  updatePopupAwaitingDownloadResult = true;
  void autoUpdater.downloadUpdate().catch((error: unknown) => {
    isUpdateDownloadInProgress = false;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('desktop:update-available', { version: latestUpdateVersion });
    }
    if (updatePopupAwaitingDownloadResult) {
      updatePopupAwaitingDownloadResult = false;
      resetUpdatePopupAfterDownloadFailure(error);
    }
    log('auto update download failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    logUpdater('auto update download failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export function cleanupAutoUpdates(): void {
  if (autoUpdateInterval) {
    clearInterval(autoUpdateInterval);
    autoUpdateInterval = null;
  }
  closeUpdatePopup();
}

export function setupAutoUpdates(
  logger: (message: string, meta?: unknown) => void,
  mainWindowRefGetter: () => BrowserWindow | null
): void {
  log = logger;
  getMainWindowRef = mainWindowRefGetter;
  logUpdater('setupAutoUpdates called', { isPackaged: app.isPackaged, version: app.getVersion() });
  if (!app.isPackaged) return;
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: AUTO_UPDATE_FEED_URL,
  });
  autoUpdater.autoDownload = false;
  if (!hasRegisteredAutoUpdaterListeners) {
    hasRegisteredAutoUpdaterListeners = true;
    autoUpdater.on('update-available', (info) => {
      isUpdateAvailable = true;
      isUpdateDownloaded = false;
      isUpdateDownloadInProgress = false;
      latestUpdateVersion = info.version;
      log('update available', { version: info.version });
      logUpdater('update available', { version: info.version });
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('desktop:update-available', { version: info.version });
      }
    });
    autoUpdater.on('update-not-available', (info) => {
      log('update not available', { version: info.version });
      logUpdater('update not available', { version: info.version });
    });
    autoUpdater.on('download-progress', (info) => {
      const percent = Math.round(info.percent);
      logUpdater('download progress', { percent });
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('desktop:update-progress', { percent });
      }
    });
    autoUpdater.on('update-downloaded', (info) => {
      isUpdateDownloaded = true;
      isUpdateDownloadInProgress = false;
      updatePopupAwaitingDownloadResult = false;
      log('update downloaded', { version: info.version });
      logUpdater('update downloaded', { version: info.version });
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('desktop:update-ready');
      }
    });
    autoUpdater.on('error', (error) => {
      isUpdateDownloadInProgress = false;
      if (updatePopupAwaitingDownloadResult) {
        updatePopupAwaitingDownloadResult = false;
        resetUpdatePopupAfterDownloadFailure(error);
      }
      log('auto updater error', { message: error.message });
      logUpdater('auto updater error', { message: error.message });
    });
    ipcMain.on('updater:popup-action', (_event, action: 'update' | 'later') => {
      if (action === 'later') {
        closeUpdatePopup();
        return;
      }
      if (action === 'update') {
        startUpdateInstallFlow();
      }
    });

    ipcMain.handle('desktop:relaunch-and-install', () => {
      startUpdateInstallFlow();
    });

    ipcMain.on('updater:log', (_event, message: string, meta?: unknown) => {
      logUpdater(message, meta);
    });
  }
  runAutoUpdateCheck('app-ready');
  if (autoUpdateInterval) {
    clearInterval(autoUpdateInterval);
  }
  autoUpdateInterval = setInterval(() => {
    runAutoUpdateCheck('interval-5h');
  }, AUTO_UPDATE_CHECK_INTERVAL_MS);
}
