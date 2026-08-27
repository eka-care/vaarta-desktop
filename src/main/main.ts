import {
  app,
  BrowserWindow,
  clipboard,
  crashReporter,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  shell,
  Tray,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import started from 'electron-squirrel-startup';
import { setupAutoUpdates, cleanupAutoUpdates, positionUpdatePopupInsideApp, runAutoUpdateCheck, reflushUpdateStateToWindow } from './updatesHandler';
import { setupMediaPermissionHandler, setupSystemAudioLoopbackHandler } from './permissionsHandler';
import { getAuthToken, getRefreshToken, registerAuthIpcHandlers } from './managers/authManager';
import {
  ensureNativeHelperLoginItem,
  launchNativeBottomView,
  quitNativeOverlayHelper,
  registerNativeBottomViewIpcHandlers,
  setMacOverlayChildSpawnedHook,
  removeOwnerPidFile,
  writeOwnerPidFile,
  logOverlayHelper,
  initWindowsOverlayHandlers,
  completeDeferredHelperRestart,
  handleStartRecordingIntent,
  shouldIgnoreDuplicateNativeEvent,
  hasPendingStartCommand,
  getPendingStartCommandCount,
  killWindowsOverlayProcesses,
  restartWindowsOverlay,
  isDeferredHelperRestartPending,
  cancelDeferredHelperRestart,
  getOverlayBridgeArgs,
} from './managers/nativeHelperManager';
import { registerRecordingIpcHandlers } from './managers/recordingManager';
import {
  registerEkascribeWebIpcHandlers,
  startEkascribeWeb,
  stopEkascribeWeb,
  getEkascribeAppOrigin,
  registerEkascribeAppSchemePrivileges,
  registerEkascribeAppProtocol,
} from './managers/ekascribeWebManager';
import { registerNetworkIpcHandlers } from './managers/networkManager';
import { registerWhatsappIpcHandlers, initWhatsAppAutoConnect } from './managers/whatsappManager';
import { registerPdfIpcHandlers } from './managers/pdfManager';
import { registerNotificationIpcHandlers, showNotification, showPermissionPromptIfNeeded } from './managers/notificationManager';
import { registerProxyProtocolHandler, unregisterProxyProtocolHandler } from './managers/proxyManager';
import { registerStorageIpcHandlers } from './managers/storageManager';
import { ChildProcess, spawnSync } from 'node:child_process';
import { NativeBridge } from './nativeCommunication/NativeBridge';
import { attach as attachFocusTracker, detach as detachFocusTracker } from './focusTracker';
import ElectronStore from 'electron-store';
import { FORCE_AUTHENTICATED, getApiUpstreamBase } from './config';


// Before `ready`, by requirement: Chromium reads the scheme privilege table during startup.
registerEkascribeAppSchemePrivileges();

/**
 * The upstream API currently presents a self-signed certificate, which Chromium rejects with
 * ERR_CERT_AUTHORITY_INVALID before CORS is ever evaluated — and a subresource fetch gets no
 * click-through interstitial, so every API call simply fails.
 *
 * This trusts that one hostname so development can proceed. It is scoped as tightly as the
 * API allows (exact host, unpackaged builds only) but it is still a real downgrade: traffic
 * to that host is no longer MITM-protected, and this app carries PHI. Packaged builds are
 * deliberately excluded, so shipping requires a properly trusted certificate rather than a
 * wider exemption here.
 */
if (!app.isPackaged) {
  const upstreamHostname = (() => {
    try {
      return new URL(getApiUpstreamBase()).hostname;
    } catch {
      return null;
    }
  })();

  app.on('certificate-error', (event, _webContents, url, error, _certificate, callback) => {
    let hostname: string | null = null;
    try {
      hostname = new URL(url).hostname;
    } catch {
      hostname = null;
    }

    if (upstreamHostname && hostname === upstreamHostname) {
      console.warn(`[main] TRUSTING UNVERIFIED CERTIFICATE for ${hostname} (${error}) — dev builds only`);
      event.preventDefault();
      callback(true);
      return;
    }

    callback(false);
  });
}

process.on('uncaughtException', (error) => {
  console.error('[main] uncaught exception', error);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection', reason);
});

if (!app.isPackaged) {
  // Keep dev and installed app instances isolated so single-instance lock
  // in development doesn't collide with the packaged app.
  app.setPath('userData', path.join(app.getPath('appData'), 'EkaScribe-dev'));
}

let nativeBridge: NativeBridge | null = null;
let mainWindowRef: BrowserWindow | null = null;
let tray: Tray | null = null;
let trayTitleTimer: NodeJS.Timeout | null = null;
let pendingDeepLinkUrl: string | null = null;
let pendingNotificationData: Record<string, unknown> | null = null;
let pendingScribeControlCommands: string[] = [];
let isScribeRendererReady = false;
let dotnetRuntimeStatusCache: DotnetRuntimeStatus | null = null;
const scribeCommandAckTimers = new Map<string, NodeJS.Timeout>();
const scribeCommandRetryCount = new Map<string, number>();
const SCRIBE_COMMAND_ACK_TIMEOUT_MS = 1200;
const SCRIBE_COMMAND_MAX_RETRIES = 2;

const DEEP_LINK_PROTOCOL = 'ekadoc';
const MAIN_WINDOW_MIN_WIDTH = 1024;
const MAIN_WINDOW_MIN_HEIGHT = 660;
const DOTNET_REQUIRED_MAJOR_VERSION = 10;
let recordingRunning = false;
const SHORTCUT_STOP_DEBOUNCE_MS = 5000;
let shortcutRecordingStartedAt: number | null = null;

type DotnetRuntimeStatus = {
  isAvailable: boolean;
  installUrl: string;
  requiredMajorVersion: number;
  checkedAtIso: string;
  detectedRuntimeVersion: string | null;
  message: string | null;
};

let cachedScribeStatus: { processingStatus: string; sessionId: string } = {
  processingStatus: 'not-started',
  sessionId: '',
};

type TrayAppointmentItem = {
  appointmentId: string;
  patientOid: string;
  patientName: string;
  age: number | null;
  gender: 'M' | 'F' | 'O' | null;
  mobile?: string;
  time: string;
  status: string;
  fullDate: string; // ISO string
  section: 'Ongoing' | 'Booked';
};
let cachedTrayAppointments: TrayAppointmentItem[] = [];

type OverlayNotificationPreferences = {
  joinVideoConferencingAndStartTranscribing: boolean;
  meetingIsBeingRecorded: boolean;
  meetingIsSummarized: boolean;
};

const DEFAULT_OVERLAY_NOTIFICATION_PREFS: OverlayNotificationPreferences = {
  joinVideoConferencingAndStartTranscribing: true,
  meetingIsBeingRecorded: true,
  meetingIsSummarized: true,
};

let cachedOverlayNotificationPrefs: OverlayNotificationPreferences = {
  ...DEFAULT_OVERLAY_NOTIFICATION_PREFS,
};

function coerceOverlayPrefs(value: unknown): OverlayNotificationPreferences {
  const base = { ...DEFAULT_OVERLAY_NOTIFICATION_PREFS };
  if (!value || typeof value !== 'object') return base;
  const raw = value as Record<string, unknown>;
  const read = (key: keyof OverlayNotificationPreferences) => {
    const v = raw[key];
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      const n = v.trim().toLowerCase();
      if (n === 'true') return true;
      if (n === 'false') return false;
    }
    if (typeof v === 'number') {
      if (v === 1) return true;
      if (v === 0) return false;
    }
    return base[key];
  };
  return {
    joinVideoConferencingAndStartTranscribing: read('joinVideoConferencingAndStartTranscribing'),
    meetingIsBeingRecorded: read('meetingIsBeingRecorded'),
    meetingIsSummarized: read('meetingIsSummarized'),
  };
}

type OverlayShortcutPreferences = {
  enabled: boolean;
  shortcut: string;
};

const DEFAULT_OVERLAY_SHORTCUT_PREFS: OverlayShortcutPreferences = {
  enabled: true,
  shortcut: process.platform === 'win32' ? 'Alt + S' : 'Ctrl + S',
};

let cachedOverlayShortcutPrefs: OverlayShortcutPreferences = {
  ...DEFAULT_OVERLAY_SHORTCUT_PREFS,
};

function coerceOverlayShortcutPrefs(value: unknown): OverlayShortcutPreferences {
  const base = { ...DEFAULT_OVERLAY_SHORTCUT_PREFS };
  if (!value || typeof value !== 'object') return base;
  const raw = value as Record<string, unknown>;
  let enabled = base.enabled;
  const rawEnabled = raw.enabled;
  if (typeof rawEnabled === 'boolean') enabled = rawEnabled;
  else if (typeof rawEnabled === 'string') {
    const n = rawEnabled.trim().toLowerCase();
    if (n === 'true') enabled = true;
    else if (n === 'false') enabled = false;
  } else if (typeof rawEnabled === 'number') {
    if (rawEnabled === 1) enabled = true;
    else if (rawEnabled === 0) enabled = false;
  }
  let shortcut = base.shortcut;
  const rawShortcut = raw.shortcut;
  if (typeof rawShortcut === 'string' && rawShortcut.trim().length > 0) {
    shortcut = rawShortcut.trim();
  }
  return { enabled, shortcut };
}

type WhatsAppAutoSendPreferences = {
  send_via_linked_device: boolean;
  auto_send_rate_limit: number;
  allow_partner_emr_auto_send: boolean;
};

const DEFAULT_WHATSAPP_AUTO_SEND_PREFS: WhatsAppAutoSendPreferences = {
  send_via_linked_device: true,
  auto_send_rate_limit: 1,
  allow_partner_emr_auto_send: true,
};

const whatsAppPrefsStore = new ElectronStore({ name: 'whatsapp-msg-send-prefs' });

const autoLaunchStore = new ElectronStore({ name: 'auto-launch-prefs' });

function getAutoLaunchEnabled(): boolean {
  const stored = autoLaunchStore.get('enabled');
  return typeof stored === 'boolean' ? stored : true;
}

function applyAutoLaunchSetting(enabled: boolean): void {
  autoLaunchStore.set('enabled', enabled);
  if (!app.isPackaged) return;
  if (process.platform === 'win32') {
    // wasOpenedAtLogin is not set by Electron on Windows, so we pass a marker
    // arg that survives into process.argv of the launched instance.
    app.setLoginItemSettings({
      openAtLogin: enabled,
      args: enabled ? ['--launched-at-login'] : [],
    });
  } else {
    app.setLoginItemSettings({ openAtLogin: enabled });
  }
}

function coerceWhatsAppAutoSendPrefs(value: unknown): WhatsAppAutoSendPreferences {
  const base = { ...DEFAULT_WHATSAPP_AUTO_SEND_PREFS };
  if (!value || typeof value !== 'object') return base;
  const raw = value as Record<string, unknown>;
  const sendViaLinkedDevice = typeof raw.send_via_linked_device === 'boolean'
    ? raw.send_via_linked_device
    : base.send_via_linked_device;
  const rawLimit = raw.auto_send_rate_limit;
  const limit = typeof rawLimit === 'number' && !isNaN(rawLimit)
    ? Math.min(5, Math.max(1, Math.round(rawLimit)))
    : base.auto_send_rate_limit;
  const allowPartnerEmr = typeof raw.allow_partner_emr_auto_send === 'boolean'
    ? raw.allow_partner_emr_auto_send
    : base.allow_partner_emr_auto_send;
  return { send_via_linked_device: sendViaLinkedDevice, auto_send_rate_limit: limit, allow_partner_emr_auto_send: allowPartnerEmr };
}

if (started) {
  if (process.platform === 'win32') {
    killWindowsOverlayProcesses();
  }
  quitNativeOverlayHelper();
  app.quit();
}

// Capture local minidumps (no upload) so a recurring renderer crash leaves a
// .dmp under app.getPath('crashDumps')/reports for offline analysis.
crashReporter.start({ uploadToServer: false });

function extractDeepLinkFromArgv(argv: string[]): string | null {
  return argv.find((arg) => arg.startsWith(`${DEEP_LINK_PROTOCOL}://`)) ?? null;
}

function focusMainWindow() {
  const win = mainWindowRef ?? BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (process.platform === 'darwin') app.focus({ steal: true });
}

function dispatchDeepLinkToRenderer(url: string) {
  const win = mainWindowRef ?? BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) {
    pendingDeepLinkUrl = url;
    return;
  }
  win.webContents.send('app:deep-link', { url });
}

let settingsWindowRef: BrowserWindow | null = null;

function openSettingsWindow(): void {
  if (settingsWindowRef && !settingsWindowRef.isDestroyed()) {
    settingsWindowRef.focus();
    return;
  }
  startEkascribeWeb().then(() => {
    const baseUrl = getEkascribeAppOrigin();
    const win = new BrowserWindow({
      width: 680,
      height: 560,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: 'Settings',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    settingsWindowRef = win;
    attachNavigationGuards(win);
    win.on('closed', () => { settingsWindowRef = null; });
    win.loadURL(`${baseUrl}/settings`);
  }).catch((err) => {
    console.error('[settings] failed to open settings window', err);
  });
}

// Node's URL gives origin 'null' for non-standard schemes like app://, so an
// origin string comparison silently never matches — compare protocol+host.
function isEkascribeAppUrl(parsed: URL): boolean {
  const appOrigin = new URL(getEkascribeAppOrigin());
  return parsed.protocol === appOrigin.protocol && parsed.host === appOrigin.host;
}

function openAppPageWindow(url: string): void {
  startEkascribeWeb().then(() => {
    const win = new BrowserWindow({
      width: 1100,
      height: 700,
      minWidth: 640,
      minHeight: 480,
      title: 'Vaarta',
      backgroundColor: '#fcfcfc',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    attachNavigationGuards(win);
    win.loadURL(url);
  }).catch((err) => {
    console.error('[window] failed to open app page window', url, err);
  });
}

function normalizeIsInUse(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  return null;
}

function getDotnetInstallUrl(): string {
  if (process.platform === 'win32') {
    return 'https://dotnet.microsoft.com/en-us/download/dotnet/thank-you/runtime-desktop-10.0.5-windows-x64-installer';
  }
  if (process.platform === 'darwin') {
    return 'https://dotnet.microsoft.com/en-us/download/dotnet/10.0/runtime';
  }
  return 'https://dotnet.microsoft.com/en-us/download/dotnet/10.0/runtime';
}

function parseDotnetRuntimeVersion(runtimeLine: string): string | null {
  const match = runtimeLine.match(/Microsoft\.WindowsDesktop\.App\s+(\d+\.\d+\.\d+)/i);
  return match?.[1] ?? null;
}

function hasRequiredDotnetRuntime(listRuntimesStdout: string): string | null {
  const lines = listRuntimesStdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const version = parseDotnetRuntimeVersion(line);
    if (!version) continue;
    const major = Number(version.split('.')[0]);
    if (Number.isFinite(major) && major >= DOTNET_REQUIRED_MAJOR_VERSION) {
      return version;
    }
  }
  return null;
}

function detectDotnetRuntimeStatus(): DotnetRuntimeStatus {
  const checkedAtIso = new Date().toISOString();
  const installUrl = getDotnetInstallUrl();

  try {
    const result = spawnSync('dotnet', ['--list-runtimes'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 5000,
    });

    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const detectedRuntimeVersion = hasRequiredDotnetRuntime(stdout);

    if (detectedRuntimeVersion) {
      return {
        isAvailable: true,
        installUrl,
        requiredMajorVersion: DOTNET_REQUIRED_MAJOR_VERSION,
        checkedAtIso,
        detectedRuntimeVersion,
        message: null,
      };
    }

    if (result.error) {
      return {
        isAvailable: false,
        installUrl,
        requiredMajorVersion: DOTNET_REQUIRED_MAJOR_VERSION,
        checkedAtIso,
        detectedRuntimeVersion: null,
        message: result.error.message,
      };
    }

    const message = stderr || `Required .NET runtime (major ${DOTNET_REQUIRED_MAJOR_VERSION}+) was not found.`;
    return {
      isAvailable: false,
      installUrl,
      requiredMajorVersion: DOTNET_REQUIRED_MAJOR_VERSION,
      checkedAtIso,
      detectedRuntimeVersion: null,
      message,
    };
  } catch (error) {
    return {
      isAvailable: false,
      installUrl,
      requiredMajorVersion: DOTNET_REQUIRED_MAJOR_VERSION,
      checkedAtIso,
      detectedRuntimeVersion: null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function sendScribeCommandToRenderer(command: 'start' | 'pause' | 'resume' | 'stop', sourceEvent: string): void {
  const channel = `scribe:${command}`;
  const win = mainWindowRef ?? BrowserWindow.getAllWindows()[0];
  const requiresRendererReady = command === 'start';
  if (!win || win.isDestroyed() || win.webContents.isLoading() || (requiresRendererReady && !isScribeRendererReady)) {
    enqueuePendingScribeControlCommand(channel, sourceEvent);
    logOverlayHelper('queued renderer command', {
      channel,
      sourceEvent,
      queueSize: pendingScribeControlCommands.length,
      rendererReady: isScribeRendererReady,
      hasWindow: !!win && !win.isDestroyed(),
      isLoading: !!win?.webContents?.isLoading?.(),
      requiresRendererReady,
    });
    return;
  }
  win.webContents.send(channel);
  logOverlayHelper('dispatching renderer command', { command: channel, sourceEvent });
  scheduleScribeCommandAckTimeout(channel, sourceEvent);
}

function flushPendingScribeCommands(win: BrowserWindow): void {
  if (!pendingScribeControlCommands.length) return;
  const queued = pendingScribeControlCommands;
  const remaining: string[] = [];
  for (const channel of queued) {
    if (channel === 'scribe:start' && !isScribeRendererReady) {
      remaining.push(channel);
      continue;
    }
    win.webContents.send(channel);
    logOverlayHelper('flushed queued renderer command', { command: channel });
    scheduleScribeCommandAckTimeout(channel, 'flush-pending');
  }
  pendingScribeControlCommands = remaining;
}

function flushPendingNotificationData(win: BrowserWindow): void {
  if (!pendingNotificationData) return;
  if (!isScribeRendererReady) return; // Wait until renderer is ready

  win.webContents.send('notification:clicked', pendingNotificationData);
  if (pendingNotificationData.transactionId) {
    win.webContents.send('scribe:view-transaction', pendingNotificationData.transactionId);
  }
  if (pendingNotificationData.sessionId) {
    win.webContents.send('scribe:view-transaction', pendingNotificationData.sessionId);
  }

  logOverlayHelper('flushed pending notification data', pendingNotificationData);
  pendingNotificationData = null;
}

function enqueuePendingScribeControlCommand(channel: string, sourceEvent: string): void {
  const shouldDedupe = channel === 'scribe:start';
  if (shouldDedupe && pendingScribeControlCommands.includes(channel)) {
    logOverlayHelper('skipping duplicate queued renderer command', {
      channel,
      sourceEvent,
      queueSize: pendingScribeControlCommands.length,
    });
    return;
  }
  if (!shouldDedupe && pendingScribeControlCommands[pendingScribeControlCommands.length - 1] === channel) {
    return;
  }
  pendingScribeControlCommands.push(channel);
}

function clearScribeCommandAckTimer(channel: string): void {
  const timer = scribeCommandAckTimers.get(channel);
  if (!timer) return;
  clearTimeout(timer);
  scribeCommandAckTimers.delete(channel);
}

function scheduleScribeCommandAckTimeout(channel: string, sourceEvent: string): void {
  clearScribeCommandAckTimer(channel);
  const timer = setTimeout(() => {
    scribeCommandAckTimers.delete(channel);
    const retries = scribeCommandRetryCount.get(channel) ?? 0;
    if (retries >= SCRIBE_COMMAND_MAX_RETRIES) {
      logOverlayHelper('renderer command ack timeout (max retries reached)', { channel, sourceEvent, retries });
      if (channel === 'scribe:start') {
        logOverlayHelper('completing deferred helper restart after start command max retries');
        completeDeferredHelperRestart();
      }
      return;
    }

    const win = mainWindowRef ?? BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed() || win.webContents.isLoading() || !isScribeRendererReady) {
      enqueuePendingScribeControlCommand(channel, `${sourceEvent}:requeue`);
      logOverlayHelper('renderer command ack timeout (re-queued)', {
        channel,
        sourceEvent,
        retries,
        rendererReady: isScribeRendererReady,
      });
      return;
    }

    scribeCommandRetryCount.set(channel, retries + 1);
    win.webContents.send(channel);
    logOverlayHelper('renderer command ack timeout (retry dispatch)', { channel, sourceEvent, retries: retries + 1 });
    scheduleScribeCommandAckTimeout(channel, `${sourceEvent}:retry`);
  }, SCRIBE_COMMAND_ACK_TIMEOUT_MS);
  scribeCommandAckTimers.set(channel, timer);
}

function handleIncomingDeepLink(url: string) {
  pendingDeepLinkUrl = url;
  focusMainWindow();
  dispatchDeepLinkToRenderer(url);
  handleDeepLinkCommand(url);
}

function handleDeepLinkCommand(url: string): void {
  const command = parseDeepLinkCommand(url);
  if (command === 'start-recording') {
    handleStartRecordingIntent('deep-link:start-recording');
  }
}

function parseDeepLinkCommand(rawUrl: string): 'start-recording' | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== `${DEEP_LINK_PROTOCOL}:`) return null;

    const command = (parsed.searchParams.get('command') ?? parsed.searchParams.get('action') ?? '')
      .trim()
      .toLowerCase();
    if (
      command === 'start' ||
      command === 'start-recording' ||
      command === 'start_recording' ||
      command === 'startrecording' ||
      command === 'recording.start'
    ) {
      return 'start-recording';
    }

    const host = parsed.hostname.trim().toLowerCase();
    const pathName = parsed.pathname.trim().toLowerCase();
    if (
      host === 'recording' &&
      (pathName === '/start' || pathName === '/start-recording' || pathName === '/start_recording')
    ) {
      return 'start-recording';
    }

    return null;
  } catch {
    return null;
  }
}

function registerDeepLinkProtocol() {
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL);
    return;
  }
  // In development, pass the app executable + app entry so Windows can route
  // protocol launches back to this running project.
  if (process.platform === 'win32') {
    app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    return;
  }
  app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL);
}

/**
 * Origins the app's windows are allowed to navigate to from the renderer side. Everything
 * the app legitimately loads (`app://ekascribe`, the login renderer, the Vite dev server)
 * is loaded by the main process via `loadURL`/`loadFile`, which never fires `will-navigate`
 * — so renderer-initiated navigation only ever needs same-app origins.
 */
function isTrustedRendererNavigation(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (isEkascribeAppUrl(parsed)) return true;
    if (
      MAIN_WINDOW_VITE_DEV_SERVER_URL &&
      parsed.origin === new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Keeps a window pinned to app content: renderer navigation to a foreign origin is
 * cancelled (http/https targets open in the OS browser instead), and `window.open` /
 * target=_blank never spawns a new Electron window — without this, a popup inherits a
 * full-privilege renderer pointed at arbitrary content.
 */
function attachNavigationGuards(win: BrowserWindow): void {
  win.webContents.on('will-navigate', (event, url) => {
    if (isTrustedRendererNavigation(url)) return;
    event.preventDefault();
    console.warn('[security] blocked renderer navigation to', url);
    try {
      const { protocol } = new URL(url);
      if (protocol === 'https:' || protocol === 'http:') void shell.openExternal(url);
    } catch {
      // malformed URL — nothing to open
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const { protocol } = new URL(url);
      if (protocol === 'https:' || protocol === 'http:') void shell.openExternal(url);
    } catch {
      // malformed URL — nothing to open
    }
    return { action: 'deny' };
  });
}

const createWindow = async () => {
  // On Windows, wasOpenedAtLogin is always false — detect via the arg we embed
  // in the login item registration. On macOS the OS sets it natively.
  const wasOpenedAtLogin = process.platform === 'win32'
    ? process.argv.includes('--launched-at-login')
    : app.getLoginItemSettings().wasOpenedAtLogin;

  const mainWindow = new BrowserWindow({
    width: MAIN_WINDOW_MIN_WIDTH,
    height: MAIN_WINDOW_MIN_HEIGHT,
    minWidth: MAIN_WINDOW_MIN_WIDTH,
    minHeight: MAIN_WINDOW_MIN_HEIGHT,
    title: 'Vaarta',
    show: false,
    backgroundColor: '#fcfcfc',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindowRef = mainWindow;
  attachNavigationGuards(mainWindow);
  mainWindow.once('ready-to-show', () => {
    if (mainWindow.isDestroyed()) return;
    if (wasOpenedAtLogin) {
      // show() first — a window must be visible to the OS before minimize()
      // works correctly on Windows (taskbar registration happens on show).
      mainWindow.show();
      mainWindow.minimize();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  if (!wasOpenedAtLogin) {
    mainWindow.maximize();
  }
  mainWindow.setTitle('Vaarta');
  isScribeRendererReady = false;
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault();
    mainWindow.setTitle('Vaarta');
  });
  mainWindow.on('move', () => {
    positionUpdatePopupInsideApp(mainWindow);
  });
  mainWindow.on('resize', () => {
    positionUpdatePopupInsideApp(mainWindow);
  });

  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      console.error('[window] did-fail-load', {
        errorCode,
        errorDescription,
        validatedURL,
      });
    }
  );
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[main] render process gone', details);
  });
  mainWindow.webContents.on('did-finish-load', () => {
    logOverlayHelper('main window did-finish-load', { url: mainWindow.webContents.getURL() });
    flushPendingScribeCommands(mainWindow);
    flushPendingNotificationData(mainWindow);
    reflushUpdateStateToWindow(mainWindow);
    if (pendingDeepLinkUrl) {
      dispatchDeepLinkToRenderer(pendingDeepLinkUrl);
    }
  });
  mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return;
    isScribeRendererReady = false;
    logOverlayHelper('main window main-frame navigation started; renderer readiness reset');
  });
  mainWindow.webContents.on('ipc-message', (_event, channel, ...args) => {
    logOverlayHelper('renderer->main ipc-message', { channel, argsCount: args.length });
  });

  const authToken = getAuthToken();
  const refreshToken = getRefreshToken();
  const isAuthenticated = FORCE_AUTHENTICATED || (!!authToken && !!refreshToken);
  if (FORCE_AUTHENTICATED) {
    console.warn('[main] FORCE_AUTH — bypassing token check and loading ekascribe-web');
  }

  let loaded = false;

  if (isAuthenticated) {
    try {
      // Idempotent — a no-op unless the `ready` handler's start failed or was skipped.
      await startEkascribeWeb();
      // Load the `app://` origin, not the loopback server behind it — the page's origin is
      // what the API allowlists, and loading loopback directly would hand it the wrong one.
      const ekascribeWebUrl = getEkascribeAppOrigin();
      await mainWindow.loadURL(ekascribeWebUrl);
      loaded = true;
      setTimeout(() => {
        if (!mainWindow.isDestroyed()) {
          showPermissionPromptIfNeeded(mainWindow);
        }
      }, 1500);
    } catch (error: any) {
      if (error?.code === 'ERR_ABORTED') {
        console.log('[ekascribe-web] loadURL aborted by renderer navigation (likely a redirect), treating as loaded');
        loaded = true;
        setTimeout(() => {
          if (!mainWindow.isDestroyed()) {
            showPermissionPromptIfNeeded(mainWindow);
          }
        }, 1500);
      } else {
        console.error('[main] ekascribe-web failed to start/load', error);
      }
    }
  } else {
    console.log('[main] no auth/refresh token — showing login screen');
  }

  // Under FORCE_AUTH the renderer fallback is the login screen, which defeats the flag.
  // Surface the ekascribe-web failure instead of silently landing on auth.
  if (!loaded && FORCE_AUTHENTICATED) {
    console.error('[main] FORCE_AUTH — ekascribe-web failed to load; not falling back to login');
    await mainWindow.loadURL(
      'data:text/html,' +
      encodeURIComponent(
        '<body style="font:14px system-ui;padding:32px"><h2>FORCE_AUTH debug mode</h2>' +
        '<p>ekascribe-web failed to start. Login fallback is suppressed — check the main-process console.</p></body>'
      )
    );
    loaded = true;
  }

  if (!loaded) {
    const rendererFilePath = path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      try {
        await mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
        loaded = true;
      } catch (error) {
        console.error('[window] failed loading Vite dev server URL, trying file fallback', {
          url: MAIN_WINDOW_VITE_DEV_SERVER_URL,
          error,
        });
      }
    }

    if (!loaded) {
      await mainWindow.loadFile(rendererFilePath);
    }
  }

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }
  mainWindow.on('closed', () => {
    detachFocusTracker();
    if (mainWindowRef === mainWindow) {
      mainWindowRef = null;
    }
    isScribeRendererReady = false;
  });
  setupScribeApp(mainWindow);
};

function setupScribeApp(mainWindow: BrowserWindow): void {
  const accessToken = getAuthToken();

  const dispatchSetup = () => {
    mainWindow.webContents.send('scribe:setup', { accessToken });
  };

  // if (mainWindow.webContents.isLoading()) {
  //   console.log('isLoading', mainWindow.webContents.isLoading());
  //   mainWindow.webContents.once('did-finish-load', dispatchSetup);
  //   return;
  // }

  dispatchSetup();
}

const DEFAULT_SCRIBE_ACCELERATOR = process.platform === 'win32' ? 'Alt+S' : 'Control+S';
const PAUSE_RESUME_SCRIBE_ACCELERATOR = process.platform === 'win32' ? 'Alt+P' : 'Control+P';
let currentScribeAccelerator: string = DEFAULT_SCRIBE_ACCELERATOR;

function isScribeRecordingPaused(): boolean {
  const status = cachedScribeStatus.processingStatus.toLowerCase();
  return status === 'recording_paused' || status === 'paused';
}

function shortcutToAccelerator(shortcut: string): string {
  return shortcut
    .split('+')
    .map((s) => s.trim())
    .map((s) => {
      if (s === 'Ctrl') return 'Control';
      if (s === 'Cmd') return 'Command';
      return s;
    })
    .join('+');
}

// Re-registers the OS-level shortcut so custom keys work even when the app is unfocused.
function registerScribeGlobalShortcut(accelerator: string): void {
  if (currentScribeAccelerator) {
    globalShortcut.unregister(currentScribeAccelerator);
  }
  currentScribeAccelerator = accelerator;
  const registered = globalShortcut.register(currentScribeAccelerator, () => {
    if (recordingRunning) {
      if (
        shortcutRecordingStartedAt !== null
        && Date.now() - shortcutRecordingStartedAt < SHORTCUT_STOP_DEBOUNCE_MS
      ) {
        logOverlayHelper('ignoring shortcut stop within debounce window', {
          elapsedMs: Date.now() - shortcutRecordingStartedAt,
          debounceMs: SHORTCUT_STOP_DEBOUNCE_MS,
        });
        return;
      }
      shortcutRecordingStartedAt = null;
      sendScribeCommandToRenderer('stop', 'keyboard-shortcut');
      return;
    }
    if (shortcutRecordingStartedAt !== null && Date.now() - shortcutRecordingStartedAt < SHORTCUT_STOP_DEBOUNCE_MS) {
      logOverlayHelper('ignoring shortcut double-start within debounce window', {
        elapsedMs: Date.now() - shortcutRecordingStartedAt,
        debounceMs: SHORTCUT_STOP_DEBOUNCE_MS,
      });
      return;
    }
    shortcutRecordingStartedAt = Date.now();
    sendScribeCommandToRenderer('start', 'keyboard-shortcut');
  });
  if (!registered) {
  }
}

function registerPauseResumeScribeGlobalShortcut(): void {
  globalShortcut.register(PAUSE_RESUME_SCRIBE_ACCELERATOR, () => {
    if (!recordingRunning) return;
    sendScribeCommandToRenderer(
      isScribeRecordingPaused() ? 'resume' : 'pause',
      'keyboard-shortcut-pause-resume',
    );
  });
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
const isPrimaryInstance = hasSingleInstanceLock;
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    runAutoUpdateCheck('second-instance');
    const deepLinkUrl = extractDeepLinkFromArgv(argv);
    if (deepLinkUrl) {
      handleIncomingDeepLink(deepLinkUrl);
      return;
    }
    focusMainWindow();
  });
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleIncomingDeepLink(url);
});


function buildAppMenu(): Menu {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const },
        {
          label: 'Check for Updates...',
          click: () => {
            console.log('[menu] Check for Updates clicked');
            runAutoUpdateCheck('menu');
          },
        },
        { type: 'separator' as const },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            const win = mainWindowRef ?? BrowserWindow.getAllWindows()[0];
            if (!win || win.isDestroyed()) return;
            win.webContents.send('app:open-user-defaults');
          },
        },
        { type: 'separator' as const },
        {
          label: 'Launch at Login',
          type: 'checkbox' as const,
          checked: getAutoLaunchEnabled(),
          click(menuItem: Electron.MenuItem) {
            applyAutoLaunchSetting(menuItem.checked);
          },
        },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          id: 'recording-toggle',
          label: recordingRunning ? 'Stop Recording' : 'Start Recording',
          accelerator: process.platform === 'win32' ? 'Alt+S' : 'Ctrl+S',
          click: () => sendScribeCommandToRenderer(recordingRunning ? 'stop' : 'start', 'menu'),
        },
        { type: 'separator' as const },
        ...(!isMac ? [{
          label: 'Launch at Login',
          type: 'checkbox' as const,
          checked: getAutoLaunchEnabled(),
          click(menuItem: Electron.MenuItem) {
            applyAutoLaunchSetting(menuItem.checked);
          },
        }] : []),
        { type: 'separator' as const },
        { role: 'close' as const },
        ...(!isMac ? [{ role: 'quit' as const }] : []),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' as const },
        { type: 'separator' as const },
        { role: 'reload' as const },
        ...(!app.isPackaged
          ? [
              { role: 'forceReload' as const },
              { role: 'toggleDevTools' as const },
            ]
          : []),
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' as const },
        { role: 'zoom' as const },
        ...(isMac
          ? [{ type: 'separator' as const }, { role: 'front' as const }]
          : [{ role: 'close' as const }]),
      ],
    },
    {
      role: 'help' as const,
      submenu: [
        {
          label: 'Learn More',
          click: () => shell.openExternal('https://scribe.eka.care/'),
        },
        {
          label: 'Logout',
          click: () => {
            const win = mainWindowRef ?? BrowserWindow.getAllWindows()[0];
            if (!win || win.isDestroyed()) return;
            win.webContents.send('app:logout');
          },
        },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}


function pickNextAppointment(): TrayAppointmentItem | null {
  const ongoing = cachedTrayAppointments.find(a => a.section === 'Ongoing');
  if (ongoing) return ongoing;
  const now = Date.now();
  const upcoming = cachedTrayAppointments
    .filter(a => a.section === 'Booked' && new Date(a.fullDate).getTime() > now)
    .sort((a, b) => new Date(a.fullDate).getTime() - new Date(b.fullDate).getTime());
  return upcoming[0] ?? null;
}

function updateTrayTitle(): void {
  if (process.platform !== 'darwin' || !tray || tray.isDestroyed()) return;
  const isLoggedIn = !!getAuthToken() && !!getRefreshToken();
  if (!isLoggedIn) { tray.setTitle(''); return; }
  const appt = pickNextAppointment();
  if (!appt) { tray.setTitle(''); return; }
  if (appt.section === 'Ongoing') {
    tray.setTitle(`${appt.patientName} • Now`);
    return;
  }
  const diffMs = new Date(appt.fullDate).getTime() - Date.now();
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin <= 0) { tray.setTitle(`${appt.patientName} • Now`); return; }
  const label = diffMin >= 60
    ? `${Math.floor(diffMin / 60)}h ${diffMin % 60}m`
    : `${diffMin}m`;
  tray.setTitle(`${appt.patientName} • in ${label}`);
}

function buildTrayMenu(): Menu {
  const isLoggedIn = !!getAuthToken() && !!getRefreshToken();

  if (!isLoggedIn) {
    return Menu.buildFromTemplate([
      { label: 'Login', click: focusMainWindow },
      { type: 'separator' as const },
      { label: 'Exit', click: () => app.quit() },
    ]);
  }

  const status = cachedScribeStatus.processingStatus.toLowerCase();
  const isPaused = status === 'recording_paused' || status === 'paused';

  const canClickAppointments = !recordingRunning;

  function formatAgeSex(age: number | null, gender: 'M' | 'F' | 'O' | null): string {
    const sexLabel = gender === 'M' ? 'Male' : gender === 'F' ? 'Female' : '';
    if (age != null && sexLabel) return `${age} yrs, ${sexLabel}`;
    if (age != null) return `${age} yrs`;
    return sexLabel;
  }

  const appointmentItems: Electron.MenuItemConstructorOptions[] = [];
  let lastSection: string | null = null;

  for (let i = 0; i < cachedTrayAppointments.length; i++) {
    const appt = cachedTrayAppointments[i];

    if (appt.section !== lastSection) {
      if (lastSection !== null) {
        appointmentItems.push({ type: 'separator' as const });
      }
      appointmentItems.push({ label: appt.section, enabled: false });
      lastSection = appt.section;
    }

    const ageSex = formatAgeSex(appt.age, appt.gender);
    const sublabelParts = [ageSex, appt.time].filter(Boolean);
    const sublabel = sublabelParts.join('  •  ');

    const clickFn = canClickAppointments
      ? () => {
          focusMainWindow();
          if (!mainWindowRef || mainWindowRef.isDestroyed()) return;
          mainWindowRef.webContents.send('scribe:start-with-appointment', {
            appointmentId: appt.appointmentId,
            oid: appt.patientOid,
            name: appt.patientName,
            age: appt.age,
            gender: appt.gender,
            mobile: appt.mobile,
          });
        }
      : undefined;

    if (process.platform === 'darwin') {
      appointmentItems.push({
        label: appt.patientName,
        sublabel,
        enabled: canClickAppointments,
        click: clickFn,
      });
    } else {
      appointmentItems.push({
        label: `${appt.patientName}  •  ${sublabel}`,
        enabled: canClickAppointments,
        click: clickFn,
      });
    }
  }

  const items: Electron.MenuItemConstructorOptions[] = [
    ...appointmentItems,
    ...(appointmentItems.length > 0 ? [{ type: 'separator' as const }] : []),
    {
      label: recordingRunning ? 'Stop Recording' : 'Start New Session',
      click: () => sendScribeCommandToRenderer(recordingRunning ? 'stop' : 'start', 'tray'),
    },
    ...(recordingRunning
      ? [{
          label: isPaused ? 'Resume' : 'Pause',
          click: () => sendScribeCommandToRenderer(isPaused ? 'resume' : 'pause', 'tray'),
        }]
      : []),
    { type: 'separator' as const },
    { label: 'My Queue', click: focusMainWindow },
    { label: 'Past Sessions', click: focusMainWindow },
    { type: 'separator' as const },
    { label: `Vaarta v${app.getVersion()}`, enabled: false },
    { label: 'Exit', click: () => app.quit() },
  ];

  return Menu.buildFromTemplate(items);
}

function getTrayImage(): Electron.NativeImage {
  const trayDir = path.join(app.getAppPath(), 'build/icons/tray');

  if (process.platform === 'darwin') {
    // createFromPath auto-detects iconTemplate@2x.png for Retina displays.
    // Source files are pre-sized: iconTemplate.png = 16x16 (1x), iconTemplate@2x.png = 32x32 (2x).
    // setTemplateImage lets macOS invert the monochrome icon for light/dark menu bar automatically.
    const image = nativeImage.createFromPath(path.join(trayDir, 'iconTemplate.png'));
    image.setTemplateImage(true);
    return image;
  }

  // Windows: pick light/dark variant based on current system theme.
  const iconFile = nativeTheme.shouldUseDarkColors ? 'tray-dark.png' : 'tray-light.png';
  return nativeImage.createFromPath(path.join(trayDir, iconFile));
}

function createTray(): void {
  tray = new Tray(getTrayImage());
  tray.setToolTip(app.name);
  tray.setContextMenu(buildTrayMenu());
  updateTrayTitle();
  trayTitleTimer = setInterval(updateTrayTitle, 60_000);

  if (process.platform === 'win32') {
    tray.on('click', focusMainWindow);
  }

  // Swap Windows tray icon when the OS switches between light and dark mode.
  nativeTheme.on('updated', () => {
    if (process.platform !== 'win32' || !tray || tray.isDestroyed()) return;
    tray.setImage(getTrayImage());
  });
}

ipcMain.on('scribe:notification-clicked', (_event, data: Record<string, unknown> | null) => {
  logOverlayHelper('notification click handler triggered', { data });

  if (app.focus) {
    app.focus({ steal: true });
  }

  const win = mainWindowRef;
  if (win && !win.isDestroyed()) {
    // Window is already open — bring it to front only.
    // Do NOT set pendingNotificationData or send scribe:view-transaction;
    // the renderer's current view is intact and should not be replaced.
    logOverlayHelper('notification click: window already open — focusing only');
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } else {
    // Window is closed — store data so the new window navigates on load.
    logOverlayHelper('notification click: window not open — creating and queuing navigation');
    pendingNotificationData = data;
    // Using app.emit('activate') cleanly triggers the same lifecycle as a dock click
    app.emit('activate');
  }
});

app.on('ready', async () => {
  if (!isPrimaryInstance) {
    return;
  }
  applyAutoLaunchSetting(getAutoLaunchEnabled());
  Menu.setApplicationMenu(buildAppMenu());
  createTray();
  console.log('[main] app ready — hasAuthToken:', !!getAuthToken());
  console.log('[main] app ready — hasRefreshToken:', !!getRefreshToken());
  logOverlayHelper('main app ready', {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
  // registerProxyProtocolHandler();
  // Must be handled before any window loads — the main window's very first navigation is
  // an `app://ekascribe` URL, and its API paths are forwarded to the upstream from here.
  registerEkascribeAppProtocol();
  setupAutoUpdates(logOverlayHelper, () => mainWindowRef);
  // setTimeout(() => { // mock auto update check function
  //   isUpdateAvailable = true;
  //   showUpdatePopup();
  // }, 1500);
  registerDeepLinkProtocol();
  const initialDeepLink = extractDeepLinkFromArgv(process.argv);
  if (initialDeepLink) {
    pendingDeepLinkUrl = initialDeepLink;
    handleDeepLinkCommand(initialDeepLink);
  }
  setupMediaPermissionHandler();
  setupSystemAudioLoopbackHandler();
  registerAuthIpcHandlers(() => {
    tray?.setContextMenu(buildTrayMenu());
    updateTrayTitle();
  });
  registerNativeBottomViewIpcHandlers();
  registerRecordingIpcHandlers();
  registerEkascribeWebIpcHandlers();
  registerNetworkIpcHandlers();
  registerWhatsappIpcHandlers();
  registerPdfIpcHandlers();
  registerStorageIpcHandlers();
  initWhatsAppAutoConnect();
  registerNotificationIpcHandlers();
  ipcMain.on('app:getVersionSync', (event) => {
    event.returnValue = app.getVersion();
  });

  ipcMain.handle('system:getDotnetRuntimeStatus', (_event, options?: { refresh?: boolean }) => {
    if (process.platform !== 'win32') {
      return {
        isAvailable: true,
        installUrl: getDotnetInstallUrl(),
        requiredMajorVersion: DOTNET_REQUIRED_MAJOR_VERSION,
        checkedAtIso: new Date().toISOString(),
        detectedRuntimeVersion: null,
        message: null,
      };
    }
    if (!dotnetRuntimeStatusCache || options?.refresh) {
      dotnetRuntimeStatusCache = detectDotnetRuntimeStatus();
    }
    return dotnetRuntimeStatusCache;
  });
  ipcMain.handle('system:openExternal', (_event, url: string) => {
    try {
      const parsed = new URL(url);
      // In-app pages (e.g. /tutorial) arrive with the app:// origin, which the
      // OS browser can't open — give them their own window, like a new tab.
      if (isEkascribeAppUrl(parsed)) {
        openAppPageWindow(url);
        return;
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return;
      return shell.openExternal(url);
    } catch {
      // malformed URL — ignore
    }
  });

  ipcMain.handle('dialog:open-file', async (_event, options?: { type?: 'document' | 'audio'; accept?: string; multiple?: boolean }) => {
    if (!mainWindowRef) return null;
    const type = options?.type ?? 'document';
    const filters = type === 'audio'
      ? [{ name: 'Audio Files', extensions: ['mp3', 'mp4', 'm4a', 'wav'] }]
      : [{ name: 'Documents', extensions: ['pdf', 'jpg', 'jpeg', 'png'] }];
    const properties: Electron.OpenDialogOptions['properties'] = options?.multiple
      ? ['openFile', 'multiSelections']
      : ['openFile'];
    const result = await dialog.showOpenDialog(mainWindowRef, { properties, filters });
    if (result.canceled || !result.filePaths.length) return null;
    const mime: Record<string, string> = {
      pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
      mp3: 'audio/mpeg', mp4: 'audio/mp4', m4a: 'audio/m4a', wav: 'audio/wav',
    };
    const files = await Promise.all(result.filePaths.map(async (filePath) => {
      const buffer = await fs.promises.readFile(filePath);
      const name = path.basename(filePath);
      const ext = path.extname(filePath).toLowerCase().slice(1);
      return { name, type: mime[ext] ?? 'application/octet-stream', size: buffer.length, data: buffer };
    }));
    return files;
  });

  ipcMain.handle('clipboard:write', (_event, payload: { html?: string; text: string }) => {
    const data: Electron.Data = { text: payload.text };
    if (payload.html) data.html = payload.html;
    clipboard.write(data);
  });

  ipcMain.handle('desktop:notification-prefs:get', async () => {
    if (nativeBridge?.isConnected()) {
      try {
        const response = await nativeBridge.request('overlay.notificationPrefs.get', undefined, {
          timeoutMs: 2500,
        });
        cachedOverlayNotificationPrefs = coerceOverlayPrefs(response);
        logOverlayHelper('main<-native notification prefs get', cachedOverlayNotificationPrefs);
      } catch (error) {
        logOverlayHelper('main<-native notification prefs get failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return cachedOverlayNotificationPrefs;
  });

  ipcMain.handle(
    'desktop:notification-prefs:update',
    async (_event, partial: Partial<OverlayNotificationPreferences>) => {
      const merged = coerceOverlayPrefs({ ...cachedOverlayNotificationPrefs, ...(partial ?? {}) });
      cachedOverlayNotificationPrefs = merged;
      if (nativeBridge?.isConnected()) {
        try {
          const response = await nativeBridge.request('overlay.notificationPrefs.update', merged, {
            timeoutMs: 2500,
          });
          cachedOverlayNotificationPrefs = coerceOverlayPrefs(response);
          logOverlayHelper('main->native notification prefs update', cachedOverlayNotificationPrefs);
        } catch (error) {
          logOverlayHelper('main->native notification prefs update failed', {
            error: error instanceof Error ? error.message : String(error),
            merged,
          });
        }
      } else {
        logOverlayHelper('main cached notification prefs (native disconnected)', merged);
      }
      return cachedOverlayNotificationPrefs;
    },
  );

  ipcMain.handle('desktop:shortcut-prefs:get', async () => {
    if (nativeBridge?.isConnected()) {
      try {
        const response = await nativeBridge.request('overlay.shortcut.get', undefined, {
          timeoutMs: 2500,
        });
        cachedOverlayShortcutPrefs = coerceOverlayShortcutPrefs(response);
        logOverlayHelper('main<-native shortcut prefs get', cachedOverlayShortcutPrefs);
      } catch (error) {
        logOverlayHelper('main<-native shortcut prefs get failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return cachedOverlayShortcutPrefs;
  });

  ipcMain.handle(
    'desktop:shortcut-prefs:update',
    async (_event, partial: Partial<OverlayShortcutPreferences>) => {
      const merged = coerceOverlayShortcutPrefs({
        ...cachedOverlayShortcutPrefs,
        ...(partial ?? {}),
      });
      cachedOverlayShortcutPrefs = merged;
      if (nativeBridge?.isConnected()) {
        try {
          const response = await nativeBridge.request('overlay.shortcut.update', merged, {
            timeoutMs: 2500,
          });
          cachedOverlayShortcutPrefs = coerceOverlayShortcutPrefs(response);
          logOverlayHelper('main->native shortcut prefs update', cachedOverlayShortcutPrefs);
        } catch (error) {
          logOverlayHelper('main->native shortcut prefs update failed', {
            error: error instanceof Error ? error.message : String(error),
            merged,
          });
        }
      } else {
        logOverlayHelper('main cached shortcut prefs (native disconnected)', merged);
      }
      if (cachedOverlayShortcutPrefs.enabled) {
        registerScribeGlobalShortcut(shortcutToAccelerator(cachedOverlayShortcutPrefs.shortcut));
      } else {
        globalShortcut.unregister(currentScribeAccelerator);
      }
      return cachedOverlayShortcutPrefs;
    },
  );

  ipcMain.handle('desktop:whatsapp-auto-send-prefs:get', (): WhatsAppAutoSendPreferences => {
    return coerceWhatsAppAutoSendPrefs(whatsAppPrefsStore.get('prefs'));
  });

  ipcMain.handle(
    'desktop:whatsapp-auto-send-prefs:update',
    (_event, partial: Partial<WhatsAppAutoSendPreferences>): WhatsAppAutoSendPreferences => {
      const current = coerceWhatsAppAutoSendPrefs(whatsAppPrefsStore.get('prefs'));
      const merged = coerceWhatsAppAutoSendPrefs({ ...current, ...(partial ?? {}) });
      whatsAppPrefsStore.set('prefs', merged);
      BrowserWindow.getAllWindows().forEach((w) => {
        if (!w.isDestroyed()) w.webContents.send('desktop:whatsapp-prefs-updated', merged);
      });
      return merged;
    },
  );

  ipcMain.on('desktop:openSettings', () => openSettingsWindow());

  ipcMain.handle('desktop:auto-launch:get', (): boolean => getAutoLaunchEnabled());
  ipcMain.handle('desktop:auto-launch:update', (_event, enabled: boolean): void => {
    applyAutoLaunchSetting(enabled);
  });

  ipcMain.on('scribe:statusUpdate', (_event, processingStatus: string, sessionId: string | null) => {
    logOverlayHelper('renderer->main ipc scribe:statusUpdate', { processingStatus, sessionId: sessionId ?? '' });
    cachedScribeStatus = { processingStatus, sessionId: sessionId ?? '' };
    const status = processingStatus.toLowerCase();
    recordingRunning = status === 'recording' || status === 'recording_paused' || status === 'paused';
    if (!recordingRunning) {
      shortcutRecordingStartedAt = null;
    }
    console.log('[menu] scribe:statusUpdate', { processingStatus, recordingRunning });
    const currentMenu = Menu.getApplicationMenu();
    const recordingItem = currentMenu?.getMenuItemById('recording-toggle');
    if (recordingItem) {
      recordingItem.label = recordingRunning ? 'Stop Recording' : 'Start Recording';
      Menu.setApplicationMenu(currentMenu);
    }
    tray?.setContextMenu(buildTrayMenu());
    updateTrayTitle();
    // Only forward recording-state statuses to the native overlay.
    // Any other status (idle, output, error, done, etc.) maps to .prompt in the native state machine,
    // which would override the .processed state set by scribe.processing.completed.
    const nativeOverlayStatuses = ['recording', 'recording_paused', 'paused', 'processing', 'ready', 'analyzing_failed'];
    if (nativeBridge?.isConnected() && nativeOverlayStatuses.includes(status)) {
      nativeBridge.sendEvent('scribe.status', { processingStatus, sessionId: sessionId ?? '' });
      logOverlayHelper('main->native event sent', {
        eventName: 'scribe.status',
        processingStatus,
        sessionId: sessionId ?? '',
      });
    }
  });

  ipcMain.on('scribe:processingCompleted', (_event, transactionId: string, status: string) => {
    logOverlayHelper('renderer->main ipc scribe:processingCompleted', { transactionId, status });
    cachedScribeStatus = { processingStatus: 'output', sessionId: cachedScribeStatus.sessionId };
    recordingRunning = false;
    if (nativeBridge?.isConnected()) {
      nativeBridge.sendEvent('scribe.processing.completed', { transactionId, status });
      logOverlayHelper('main->native event sent', {
        eventName: 'scribe.processing.completed',
        transactionId,
        status,
      });
    }
    showNotification({
      title: 'Analysis Complete',
      body: 'Your session notes are ready to review.',
      data: { transactionId, status },
    });
  });
  ipcMain.on('scribe:session-discarded', () => {
    logOverlayHelper('renderer->main ipc scribe:session-discarded');
    cachedScribeStatus = { processingStatus: 'not-started', sessionId: '' };
    recordingRunning = false;
    if (nativeBridge?.isConnected()) {
      nativeBridge.sendEvent('scribe.session.discarded', null);
      logOverlayHelper('main->native event sent', { eventName: 'scribe.session.discarded' });
    }
  });

  ipcMain.on('scribe:error', (_event, errorCode: string, errorMessage: string) => {
    logOverlayHelper('renderer->main ipc scribe:error', { errorCode, errorMessage });
    cachedScribeStatus = { processingStatus: 'error', sessionId: cachedScribeStatus.sessionId };
    recordingRunning = false;
    if (nativeBridge?.isConnected()) {
      nativeBridge.sendEvent('scribe.error', { errorCode, errorMessage });
      logOverlayHelper('main->native event sent', { eventName: 'scribe.error', errorCode, errorMessage });
    }
  });

  ipcMain.on('scribe:command-consumed', (_event, command: string) => {
    const normalizedCommand = command.trim().toLowerCase();
    if (
      normalizedCommand !== 'start' &&
      normalizedCommand !== 'pause' &&
      normalizedCommand !== 'resume' &&
      normalizedCommand !== 'stop'
    ) {
      return;
    }
    const channel = `scribe:${normalizedCommand}`;
    clearScribeCommandAckTimer(channel);
    scribeCommandRetryCount.delete(channel);
    logOverlayHelper('renderer acknowledged scribe command', { channel });
    if (normalizedCommand === 'start') {
      completeDeferredHelperRestart();
    }
  });
  ipcMain.on('scribe:renderer-ready', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    if (mainWindowRef && win !== mainWindowRef) return;
    isScribeRendererReady = true;
    logOverlayHelper('renderer marked scribe controls ready');
    flushPendingScribeCommands(win);
    flushPendingNotificationData(win);
  });

  ipcMain.on('scribe:appointments-update', (_event, data: unknown) => {
    cachedTrayAppointments = Array.isArray(data) ? (data as TrayAppointmentItem[]) : [];
    tray?.setContextMenu(buildTrayMenu());
    updateTrayTitle();
  });

  NativeBridge.onParseError = (err) => {
    console.error('[native] failed parsing bridge message', err);
  };
  nativeBridge = new NativeBridge({ role: 'stdio' });
  initWindowsOverlayHandlers({
    getNativeBridge: () => nativeBridge,
    sendScribeCommand: (command, source) => sendScribeCommandToRenderer(command, source),
  });
  setMacOverlayChildSpawnedHook((child: ChildProcess) => {
    if (!child.stdout || !child.stdin) {
      logOverlayHelper('mac overlay spawn missing stdio pipes; cannot bind native bridge');
      return;
    }
    nativeBridge?.attachStdio(child.stdout, child.stdin);
  });
  nativeBridge.onReceive((eventName, payload) => {
    logOverlayHelper('native->electron event received', { eventName, payload });
    if (shouldIgnoreDuplicateNativeEvent(eventName, payload)) {
      logOverlayHelper('ignored duplicate native->electron event', { eventName, payload });
      return;
    }
    console.log('[NativeBridge] event', eventName, payload);
    switch (eventName) {
      case 'recording.start':
        if (recordingRunning) {
          logOverlayHelper('ignored native recording.start — already recording');
          break;
        }
        sendScribeCommandToRenderer('start', eventName);
        break;
      case 'recording.pause':
        if (!recordingRunning) {
          logOverlayHelper('ignored native recording.pause — not recording');
          break;
        }
        sendScribeCommandToRenderer('pause', eventName);
        break;
      case 'recording.resume':
        if (!recordingRunning) {
          logOverlayHelper('ignored native recording.resume — not recording');
          break;
        }
        sendScribeCommandToRenderer('resume', eventName);
        break;
      case 'recording.stop':
        if (!recordingRunning) {
          logOverlayHelper('ignored native recording.stop — not recording');
          break;
        }
        sendScribeCommandToRenderer('stop', eventName);
        break;
      case 'overlay.open.app':
        // Logo tapped on the floating overlay — bring the main app to the front.
        focusMainWindow();
        break;
      case 'scribe.result.view': {
        const transactionId = (payload as { transactionId?: string } | undefined)?.transactionId;
        // Snapshot BEFORE focusMainWindow() so we know if the window was already
        // open at the time the user clicked View (minimized counts as open —
        // its renderer is intact and should not be navigated away).
        const windowAlreadyOpen = !!mainWindowRef && !mainWindowRef.isDestroyed();
        focusMainWindow();
        if (transactionId && !windowAlreadyOpen) {
          // Window was closed — queue navigation and recreate the window so it
          // deep-links to the session once it finishes loading. focusMainWindow()
          // above is a no-op when there is no window, so mirror the notification
          // handler and trigger the same lifecycle as a dock click.
          logOverlayHelper('scribe.result.view: window not open — recreating and queuing view-transaction', { transactionId });
          pendingNotificationData = { transactionId };
          app.emit('activate');
        } else {
          // Window is already open — focus only; do not navigate the renderer.
          logOverlayHelper('scribe.result.view: window already open — focusing only', { transactionId });
        }
        break;
      }
      case 'microphone.usage.changed': {
        const rawIsInUse = (payload as { isInUse?: unknown } | undefined)?.isInUse;
        const isInUse = normalizeIsInUse(rawIsInUse);
        const currentStatus = cachedScribeStatus.processingStatus.toLowerCase();
        const isRecordingActive = currentStatus === 'recording' || currentStatus === 'recording_paused';
        if (isInUse === false && isRecordingActive) {
          sendScribeCommandToRenderer('stop', eventName);
        } else {
          logOverlayHelper('microphone usage event ignored', { sourceEvent: eventName, rawIsInUse, isInUse, processingStatus: cachedScribeStatus.processingStatus });
        }
        break;
      }
      default:
        logOverlayHelper('unhandled native->electron event', { eventName, payload });
        break;
    }
  });

  nativeBridge.onRequest((name, _payload, respond) => {
    if (name === 'scribe.getStatus') {
      const pendingStart = hasPendingStartCommand(pendingScribeControlCommands, scribeCommandAckTimers);
      const pendingStartCount = getPendingStartCommandCount(pendingScribeControlCommands, scribeCommandAckTimers);
      const statusResponse = {
        ...cachedScribeStatus,
        hasPendingStartCommand: pendingStart,
        pendingStartCommandCount: pendingStartCount,
      };
      logOverlayHelper('native->main request received', { name, status: statusResponse });
      respond.ok(statusResponse);
      logOverlayHelper('main->native response sent', { name, ok: true, status: statusResponse });
      return;
    }
    logOverlayHelper('native->main request received', { name, unknown: true });
    respond.error({ code: 'UNKNOWN_REQUEST', message: `Unknown request: ${name}` });
    logOverlayHelper('main->native response sent', { name, ok: false, code: 'UNKNOWN_REQUEST' });
  });
  nativeBridge.on('error', (err) => {
    logOverlayHelper('native bridge error', {
      message: err.message,
      stack: err.stack ? err.stack.split('\n').slice(0, 3).join('\n') : undefined,
    });
    console.error('[NativeBridge] error', err);
  });
  nativeBridge.on('connected', () => {
    logOverlayHelper('native bridge connected', { status: cachedScribeStatus });
    nativeBridge?.sendEvent('scribe.status', cachedScribeStatus);
    const reconnectStatus = cachedScribeStatus.processingStatus.toLowerCase();
    if (reconnectStatus === 'output') {
      nativeBridge?.sendEvent('scribe.processing.completed', { transactionId: '', status: 'success' });
      logOverlayHelper('main->native event sent on reconnect', { eventName: 'scribe.processing.completed' });
    } else if (reconnectStatus === 'error') {
      nativeBridge?.sendEvent('scribe.error', { errorCode: '', errorMessage: '' });
      logOverlayHelper('main->native event sent on reconnect', { eventName: 'scribe.error' });
    }
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      nativeBridge?.sendEvent('app.focus.changed', { isFocused: mainWindowRef.isFocused() });
    }
  });
  nativeBridge.on('disconnected', (reason) => {
    logOverlayHelper('native bridge disconnected', { reason });
  });
  void nativeBridge.start().catch((err) => {
    logOverlayHelper('native bridge failed to start', { message: err instanceof Error ? err.message : String(err) });
    console.error('[NativeBridge] failed to start', err);
  });
  // Stdio transport binds to whichever helper child we spawn next; nothing
  // is connected until launchNativeBottomView / launchWindowsOverlay runs.

  try {
    await createWindow();
  } catch (error) {
    app.quit();
    return;
  }

  if (nativeBridge && mainWindowRef) {
    attachFocusTracker(mainWindowRef, nativeBridge);
  }

  writeOwnerPidFile();

  // OS-level hotkey so users can start/stop recording even when the app is not focused.
  if (cachedOverlayShortcutPrefs.enabled) {
    registerScribeGlobalShortcut(shortcutToAccelerator(cachedOverlayShortcutPrefs.shortcut));
  }
  registerPauseResumeScribeGlobalShortcut();

  // Event loop lag detector — fires a breadcrumb when the main process is blocked >2s
  let lastLagCheck = Date.now();
  setInterval(() => {
    const now = Date.now();
    const lag = now - lastLagCheck - 2000;
    lastLagCheck = now;
    if (lag > 2000) {
    }
  }, 2000);

  if (process.platform === 'darwin') {
    ensureNativeHelperLoginItem();
    launchNativeBottomView();
  }
  if (isDeferredHelperRestartPending()) {
    logOverlayHelper('overlay helper restart is deferred until renderer start command is consumed');
  } else {
    restartWindowsOverlay(getOverlayBridgeArgs());
  }
});

app.on('will-quit', () => {
  if (!isPrimaryInstance) {
    return;
  }
  if (trayTitleTimer) { clearInterval(trayTitleTimer); trayTitleTimer = null; }
  tray?.destroy();
  tray = null;
  removeOwnerPidFile();
  unregisterProxyProtocolHandler();
  void stopEkascribeWeb();
  cancelDeferredHelperRestart();
  // Stdio bridge ties helper lifecycle to Electron: tear them down explicitly
  // so we never leave a stranded helper with no peer.
  logOverlayHelper('shutting down overlay helpers on app quit');
  if (process.platform === 'win32') {
    killWindowsOverlayProcesses();
  }
  if (process.platform === 'darwin') {
    quitNativeOverlayHelper();
  }
  for (const channel of [...scribeCommandAckTimers.keys()]) {
    clearScribeCommandAckTimer(channel);
  }
  scribeCommandRetryCount.clear();
  nativeBridge?.dispose();
  nativeBridge = null;
  globalShortcut.unregister(currentScribeAccelerator);
  globalShortcut.unregister(PAUSE_RESUME_SCRIBE_ACCELERATOR);
  cleanupAutoUpdates();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  runAutoUpdateCheck('app-activate');
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow().then(() => {
      if (nativeBridge && mainWindowRef) {
        attachFocusTracker(mainWindowRef, nativeBridge);
      }
    }).catch((error) => {
      console.error('[main] startup failed, quitting', error);
      app.quit();
    });
  } else {
    focusMainWindow();
  }
});

