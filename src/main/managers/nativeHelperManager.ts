import { app, ipcMain } from 'electron';
import { IpcMainEvent } from 'electron/main';
import { ChildProcess, execFile, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { NativeBridge } from '../nativeCommunication/NativeBridge';

// ─── Shared logging ───────────────────────────────────────────────────────────

export function logOverlayHelper(message: string, meta?: unknown): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}\n`;
  try {
    const logFilePath = path.join(app.getPath('userData'), 'overlay-helper.log');
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    fs.appendFileSync(logFilePath, line, 'utf8');
  } catch {
    // best-effort file logging only
  }
  console.log(line.trim());
}

// ─── Mac overlay ─────────────────────────────────────────────────────────────

type MacOverlayChildSpawnedHook = (child: ChildProcess) => void;
let macOverlayChildSpawnedHook: MacOverlayChildSpawnedHook | null = null;

/**
 * Register a callback invoked once each time the Mac overlay helper is spawned.
 * The hook receives the live ChildProcess so the caller (main process) can wire
 * its stdout/stdin to NativeBridge.attachStdio. Re-fires on every respawn (pill
 * toggle, post-quit relaunch).
 */
export function setMacOverlayChildSpawnedHook(hook: MacOverlayChildSpawnedHook | null): void {
  macOverlayChildSpawnedHook = hook;
}

const MAC_OVERLAY_APP_NAME = 'EkaCareDesktopHelper';
const OWNER_PID_FILE = '/tmp/deskdoc-pill-owner.vaarta.pid';
const HELPER_APP_BUNDLE_NAME = 'EkaCareDesktopHelper.app';
let bottomViewVisible = false;
let macOverlayProcess: ReturnType<typeof spawn> | null = null;
let macOverlayIntentionalQuit = false;
let macOverlayLaunching = false;
let macOverlayRestartCount = 0;
let macOverlayRestartWindowStartedAtMs = 0;
let macOverlayRestartTimer: NodeJS.Timeout | null = null;
const MAC_OVERLAY_RESTART_LIMIT = 3;
const MAC_OVERLAY_RESTART_WINDOW_MS = 60_000;

function cancelMacOverlayRestart(): void {
  if (macOverlayRestartTimer) {
    clearTimeout(macOverlayRestartTimer);
    macOverlayRestartTimer = null;
  }
}

// The helper dying used to leave the overlay gone until the app was relaunched.
function scheduleMacOverlayRestart(reason: Record<string, unknown>): void {
  const now = Date.now();
  if (now - macOverlayRestartWindowStartedAtMs > MAC_OVERLAY_RESTART_WINDOW_MS) {
    macOverlayRestartWindowStartedAtMs = now;
    macOverlayRestartCount = 0;
  }
  if (macOverlayRestartCount >= MAC_OVERLAY_RESTART_LIMIT) {
    logOverlayHelper('mac overlay restart limit reached', reason);
    return;
  }
  macOverlayRestartCount += 1;
  const delayMs = 1000 * macOverlayRestartCount;
  logOverlayHelper('scheduling mac overlay restart', { ...reason, attempt: macOverlayRestartCount, delayMs });
  cancelMacOverlayRestart();
  macOverlayRestartTimer = setTimeout(() => {
    macOverlayRestartTimer = null;
    if (macOverlayIntentionalQuit) return;
    launchNativeBottomView();
  }, delayMs);
}

// killall matches by process name, which is identical in every app bundling this
// helper. Scope to our own executable path so we never kill another app's helper.
function killHelperAtPath(helperExecutablePath: string, done: () => void): void {
  // Anchored at the start only — the helper runs with trailing args (--bridge-stdio).
  const pattern = `^${helperExecutablePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
  execFile('pkill', ['-f', pattern], () => done());
}

function getMacHelperAppCandidates(): string[] {
  const cwd = process.cwd();
  const appPath = app.getAppPath();
  return [
    path.join(process.resourcesPath, 'native', 'mac', HELPER_APP_BUNDLE_NAME),
    path.join(process.resourcesPath, HELPER_APP_BUNDLE_NAME),
    path.join(appPath, 'mac', 'build', 'Release', HELPER_APP_BUNDLE_NAME),
    path.join(cwd, 'mac', 'build', 'Release', HELPER_APP_BUNDLE_NAME),
  ];
}

function toHelperExecutablePath(helperAppPath: string): string {
  return path.join(helperAppPath, 'Contents', 'MacOS', MAC_OVERLAY_APP_NAME);
}

function getMacHelperAppPath(): string | null {
  if (process.platform !== 'darwin') return null;
  const appPath = getMacHelperAppCandidates().find((candidate) => fs.existsSync(candidate)) ?? null;
  if (!appPath) {
    console.error('helper app bundle not found in candidate paths', {
      candidates: getMacHelperAppCandidates(),
      cwd: process.cwd(),
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
    });
  }
  return appPath;
}

function getMacHelperExecutablePath(): string | null {
  if (process.platform !== 'darwin') return null;
  const helperAppPath = getMacHelperAppPath();
  if (!helperAppPath) return null;
  const executablePath = toHelperExecutablePath(helperAppPath);
  if (fs.existsSync(executablePath)) return executablePath;
  console.error('helper executable missing inside helper app', { helperAppPath, executablePath });
  return null;
}

function readMacTeamIdentifier(targetPath: string): string | null {
  const result = spawnSync('codesign', ['-dv', '--verbose=4', targetPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) return null;
  const details = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const match = details.match(/TeamIdentifier=(.+)/);
  return match?.[1]?.trim() ?? null;
}

function hasSamePackagedSigner(helperExecutablePath: string): boolean {
  if (!app.isPackaged || process.platform !== 'darwin') return true;
  const parentExecutablePath = process.execPath;
  const parentTeamIdentifier = readMacTeamIdentifier(parentExecutablePath);
  const helperTeamIdentifier = readMacTeamIdentifier(helperExecutablePath);
  if (!parentTeamIdentifier || !helperTeamIdentifier) {
    console.error('Failed to verify helper signature: missing TeamIdentifier', {
      parentExecutablePath,
      helperExecutablePath,
      parentTeamIdentifier,
      helperTeamIdentifier,
    });
    return false;
  }
  if (parentTeamIdentifier !== helperTeamIdentifier) {
    console.error('Blocked helper launch: signer mismatch', {
      parentTeamIdentifier,
      helperTeamIdentifier,
    });
    return false;
  }
  return true;
}

export function writeOwnerPidFile(): void {
  if (process.platform !== 'darwin') return;
  try {
    fs.writeFileSync(OWNER_PID_FILE, String(process.pid), { mode: 0o600 });
  } catch (error) {
    console.error('Failed to write owner pid file', error);
  }
}

export function removeOwnerPidFile(): void {
  if (process.platform !== 'darwin') return;
  try {
    if (fs.existsSync(OWNER_PID_FILE)) {
      fs.unlinkSync(OWNER_PID_FILE);
    }
  } catch (error) {
    console.error('Failed to remove owner pid file', error);
  }
}

export function launchNativeBottomView(): void {
  if (process.platform !== 'darwin') return;
  // macOverlayProcess is only set in the async spawn callback, so guard the gap too.
  if (macOverlayLaunching) return;
  if (macOverlayProcess && !macOverlayProcess.killed) return;
  macOverlayIntentionalQuit = false;
  cancelMacOverlayRestart();
  writeOwnerPidFile();
  const helperExecutablePath = getMacHelperExecutablePath();
  if (!helperExecutablePath) {
    console.error('Failed to open overlay pill: helper executable not found');
    return;
  }
  if (!hasSamePackagedSigner(helperExecutablePath)) {
    console.error('Failed to open overlay pill: helper signature validation failed');
    return;
  }
  const bridgeArgs = ['--bridge-stdio'];
  const helperExecDir = path.dirname(helperExecutablePath);

  // Stdio bridge requires Electron to own the helper, so kill any stale instance
  // (e.g. from a crashed previous run) before spawning a fresh child.
  macOverlayLaunching = true;
  killHelperAtPath(helperExecutablePath, () => {
    macOverlayLaunching = false;
    const launchedProcess = spawn(helperExecutablePath, bridgeArgs, {
      cwd: helperExecDir,
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    macOverlayProcess = launchedProcess;
    bottomViewVisible = true;

    launchedProcess.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trimEnd();
      if (text) console.log('[MacHelper stderr]', text);
    });

    try {
      macOverlayChildSpawnedHook?.(launchedProcess);
    } catch (error) {
      console.error('Mac overlay child-spawned hook threw', error);
    }

    launchedProcess.on('error', (error) => {
      console.error('[native] mac overlay process error', error);
      if (macOverlayProcess?.pid === launchedProcess.pid) {
        macOverlayProcess = null;
        bottomViewVisible = false;
      }
    });
    launchedProcess.on('exit', (code, signal) => {
      if (macOverlayProcess?.pid !== launchedProcess.pid) return;
      macOverlayProcess = null;
      bottomViewVisible = false;
      if (macOverlayIntentionalQuit) return;
      scheduleMacOverlayRestart({ code, signal });
    });
  });
}

export function ensureNativeHelperLoginItem(): void {
  if (process.platform !== 'darwin') return;
  const helperAppPath = getMacHelperAppPath();
  if (!helperAppPath) {
    console.error('Cannot add helper to Login Items: helper app bundle path not found');
    return;
  }
  // Login item registration is handled by the native helper itself via
  // SMAppService.mainApp.register() in EkaCareDesktopHelperApp.swift.
}

export function quitNativeOverlayHelper(): void {
  if (process.platform !== 'darwin') return;
  bottomViewVisible = false;
  macOverlayIntentionalQuit = true;
  cancelMacOverlayRestart();
  removeOwnerPidFile();
  const runningProcess = macOverlayProcess;
  if (runningProcess && !runningProcess.killed) {
    try {
      runningProcess.kill('SIGTERM');
    } catch {
      // best effort
    } finally {
      macOverlayProcess = null;
    }
  }
  const helperExecutablePath = getMacHelperExecutablePath();
  if (helperExecutablePath) {
    killHelperAtPath(helperExecutablePath, () => {
      // best effort
    });
  }
}

export function toggleBottomView(): void {
  if (bottomViewVisible) {
    quitNativeOverlayHelper();
  } else {
    launchNativeBottomView();
  }
}

export function registerNativeBottomViewIpcHandlers(): void {
  ipcMain.on('scribe:statusUpdate', (_event: IpcMainEvent, _status: string, _sessionId: string | null) => {
    // Status updates are now forwarded over NativeBridge instead of temp files.
  });
}

// ─── Windows overlay ──────────────────────────────────────────────────────────

type ScribeCommand = 'start' | 'pause' | 'resume' | 'stop';

let getNativeBridge: () => NativeBridge | null = () => null;
let sendScribeCommandCallback: (command: ScribeCommand, source: string) => void = () => {};

export function initWindowsOverlayHandlers(opts: {
  getNativeBridge: () => NativeBridge | null;
  sendScribeCommand: (command: ScribeCommand, source: string) => void;
}): void {
  getNativeBridge = opts.getNativeBridge;
  sendScribeCommandCallback = opts.sendScribeCommand;
}

let windowsOverlayProcess: ChildProcess | null = null;
let overlayRestartCount = 0;
let overlayLaunchStartedAtMs = 0;
let helperRestartDeferred = false;
let helperRestartDeferredArgs: string[] = [];
let helperRestartSafetyTimer: NodeJS.Timeout | null = null;
const HELPER_RESTART_SAFETY_TIMEOUT_MS = 10_000;
const NATIVE_EVENT_DEDUP_WINDOW_MS = 500;
const nativeEventLastSeenByKey = new Map<string, number>();

export function getOverlayBridgeArgs(): string[] {
  return ['--bridge-stdio'];
}

export function handleStartRecordingIntent(sourceEvent: string): void {
  const overlayArgs = getOverlayBridgeArgs();
  killWindowsOverlayProcesses();
  armDeferredHelperRestart(overlayArgs);
  sendScribeCommandCallback('start' as ScribeCommand, sourceEvent);
}

export function shouldIgnoreDuplicateNativeEvent(eventName: string, payload: unknown): boolean {
  if (
    eventName !== 'recording.start' &&
    eventName !== 'recording.pause' &&
    eventName !== 'recording.resume' &&
    eventName !== 'recording.stop' &&
    eventName !== 'scribe.result.view'
  ) {
    return false;
  }

  const payloadKey = payload === undefined ? '' : JSON.stringify(payload);
  const dedupKey = `${eventName}:${payloadKey}`;
  const now = Date.now();
  const lastSeenAt = nativeEventLastSeenByKey.get(dedupKey);
  nativeEventLastSeenByKey.set(dedupKey, now);
  return lastSeenAt !== undefined && now - lastSeenAt < NATIVE_EVENT_DEDUP_WINDOW_MS;
}

export function hasPendingStartCommand(
  pendingCommands: string[],
  ackTimers: Map<string, NodeJS.Timeout>
): boolean {
  return helperRestartDeferred
    || pendingCommands.includes('scribe:start')
    || ackTimers.has('scribe:start');
}

export function getPendingStartCommandCount(
  pendingCommands: string[],
  ackTimers: Map<string, NodeJS.Timeout>
): number {
  const deferred = helperRestartDeferred ? 1 : 0;
  const queueCount = pendingCommands.filter((ch) => ch === 'scribe:start').length;
  const inFlight = ackTimers.has('scribe:start') ? 1 : 0;
  return deferred + queueCount + inFlight;
}

function clearDeferredHelperRestartSafetyTimer(): void {
  if (helperRestartSafetyTimer) {
    clearTimeout(helperRestartSafetyTimer);
    helperRestartSafetyTimer = null;
  }
}

export function isDeferredHelperRestartPending(): boolean {
  return helperRestartDeferred;
}

export function cancelDeferredHelperRestart(): void {
  helperRestartDeferred = false;
  clearDeferredHelperRestartSafetyTimer();
}

export function armDeferredHelperRestart(args: string[]): void {
  helperRestartDeferred = true;
  helperRestartDeferredArgs = args;
  clearDeferredHelperRestartSafetyTimer();
  helperRestartSafetyTimer = setTimeout(() => {
    if (helperRestartDeferred) {
      logOverlayHelper('deferred helper restart safety timeout — restarting anyway');
      completeDeferredHelperRestart();
    }
  }, HELPER_RESTART_SAFETY_TIMEOUT_MS);
  logOverlayHelper('armed deferred helper restart', { args });
}

export function completeDeferredHelperRestart(): void {
  if (!helperRestartDeferred) return;
  helperRestartDeferred = false;
  clearDeferredHelperRestartSafetyTimer();
  const args = helperRestartDeferredArgs;
  helperRestartDeferredArgs = [];
  logOverlayHelper('completing deferred helper restart');
  restartWindowsOverlay(args);
}

function getOverlayExePath(): string {
  const exeName = process.platform === 'win32' ? 'EkaDeskDocHelper.exe' : '';
  if (!exeName) {
    console.error('Overlay only supported on Windows in this path');
    throw new Error('Overlay only supported on Windows in this path');
  }
  if (app.isPackaged) {
    const packagedCandidates = [
      path.join(process.resourcesPath, 'native', 'windows', 'EkaDeskDocHelper', exeName),
      path.join(process.resourcesPath, 'net10.0-windows', exeName),
      path.join(process.resourcesPath, 'EkaDeskDocHelper', exeName),
    ];
    const existingPackagedPath = packagedCandidates.find((p) => fs.existsSync(p));
    return existingPackagedPath ?? packagedCandidates[0];
  }
  const devBasePath = path.join(
    app.getAppPath(),
    'windows',
    'EkaDeskDocHelper',
    'EkaDeskDocHelper',
    'bin',
    'Debug',
    'net10.0-windows'
  );
  const ridCandidates = process.arch === 'arm64' ? ['win-arm64', 'win-x64'] : ['win-x64', 'win-arm64'];
  const devCandidates = [
    ...ridCandidates.map((rid) => path.join(devBasePath, rid, exeName)),
    path.join(devBasePath, exeName),
  ];
  const existingDevPath = devCandidates.find((p) => fs.existsSync(p));
  return existingDevPath ?? devCandidates[0];
}

function readWindowsSignerThumbprint(executablePath: string): string | null {
  if (process.platform !== 'win32') return null;
  const escapedPath = executablePath.replace(/'/g, "''");
  const psScript = [
    `$sig = Get-AuthenticodeSignature -FilePath '${escapedPath}'`,
    "if (-not $sig.SignerCertificate) { exit 3 }",
    'Write-Output $sig.SignerCertificate.Thumbprint',
  ].join('; ');
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
    {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 5000,
    },
  );
  if (result.status !== 0 || result.error) return null;
  const thumbprint = (result.stdout ?? '').trim().toUpperCase();
  return thumbprint.length > 0 ? thumbprint : null;
}

function hasSamePackagedWindowsSigner(helperExecutablePath: string): boolean {
  if (!app.isPackaged || process.platform !== 'win32') return true;
  const parentExecutablePath = process.execPath;
  const parentThumbprint = readWindowsSignerThumbprint(parentExecutablePath);
  const helperThumbprint = readWindowsSignerThumbprint(helperExecutablePath);
  if (!parentThumbprint || !helperThumbprint) {
    logOverlayHelper('failed signer verification: missing signer thumbprint', {
      parentExecutablePath,
      helperExecutablePath,
      parentThumbprint,
      helperThumbprint,
    });
    return false;
  }
  if (parentThumbprint !== helperThumbprint) {
    logOverlayHelper('blocked helper launch: signer mismatch', {
      parentThumbprint,
      helperThumbprint,
    });
    return false;
  }
  return true;
}

function scheduleOverlayRestart(args: string[], reason: string): void {
  if (overlayRestartCount >= 3) {
    logOverlayHelper('overlay restart limit reached', { reason, attempts: overlayRestartCount });
    return;
  }
  overlayRestartCount += 1;
  setTimeout(() => {
    launchWindowsOverlay(args);
  }, 1000 * overlayRestartCount);
}

export function listWindowsOverlayProcessIds(): number[] {
  if (process.platform !== 'win32') return [];
  const result = spawnSync('tasklist', ['/FI', 'IMAGENAME eq EkaDeskDocHelper.exe', '/FO', 'CSV', '/NH'], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.error) {
    logOverlayHelper('failed to list overlay processes', { error: result.error.message });
    return [];
  }
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('INFO:'))
    .flatMap((line) => {
      const csvFields = line.match(/"([^"]*)"/g);
      if (!csvFields || csvFields.length < 2) return [];
      const pidRaw = csvFields[1].replace(/"/g, '').replace(/,/g, '').trim();
      const pid = Number(pidRaw);
      return Number.isFinite(pid) && pid > 0 ? [pid] : [];
    });
}

function killWindowsOverlayProcessesByPid(pids: number[]): void {
  if (process.platform !== 'win32' || !pids.length) return;
  for (const pid of pids) {
    const killResult = spawnSync('taskkill', ['/PID', String(pid), '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 5000,
    });
    if (killResult.error) {
      logOverlayHelper('failed to terminate stale overlay process', { pid, error: killResult.error.message });
    }
  }
}

export function killWindowsOverlayProcesses(): void {
  if (process.platform !== 'win32') return;
  const pids = listWindowsOverlayProcessIds();
  killWindowsOverlayProcessesByPid(pids);
  if (windowsOverlayProcess && !windowsOverlayProcess.killed) {
    try { windowsOverlayProcess.kill(); } catch { /* best-effort */ }
  }
  windowsOverlayProcess = null;
  logOverlayHelper('killed all overlay helper processes', { pids });
}

export function restartWindowsOverlay(args: string[]): void {
  logOverlayHelper('restarting overlay helper', { args });
  killWindowsOverlayProcesses();
  overlayRestartCount = 0;
  launchWindowsOverlay(args);
}

export function launchWindowsOverlay(args: string[] = []): void {
  if (process.platform !== 'win32') {
    console.error('Overlay only supported on Windows');
    return;
  }
  logOverlayHelper('launching Windows overlay');
  if (windowsOverlayProcess && !windowsOverlayProcess.killed) return; // already running

  // Stdio bridge requires Electron to own the only live helper instance, so
  // sweep any orphans (e.g. from a crashed previous Electron run) before spawn.
  const orphanPids = listWindowsOverlayProcessIds();
  if (orphanPids.length > 0) {
    logOverlayHelper('killing orphan overlay helpers before spawn', { pids: orphanPids });
    killWindowsOverlayProcessesByPid(orphanPids);
  }

  const exePath = getOverlayExePath();
  const exeDir = path.dirname(exePath);
  if (!fs.existsSync(exePath)) {
    logOverlayHelper('overlay exe missing', { exePath });
    return;
  }
  if (!hasSamePackagedWindowsSigner(exePath)) {
    logOverlayHelper('overlay launch blocked: packaged signer verification failed', { exePath });
    return;
  }
  overlayLaunchStartedAtMs = Date.now();
  windowsOverlayProcess = spawn(exePath, args, {
    cwd: exeDir,
    detached: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  logOverlayHelper('overlay process started', { exePath, pid: windowsOverlayProcess.pid, args });
  const nativeBridge = getNativeBridge();
  if (windowsOverlayProcess.stdout && windowsOverlayProcess.stdin) {
    nativeBridge?.attachStdio(windowsOverlayProcess.stdout, windowsOverlayProcess.stdin);
  } else {
    logOverlayHelper('windows overlay spawn missing stdio pipes; cannot bind native bridge');
  }
  windowsOverlayProcess.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trimEnd();
    if (text) logOverlayHelper('overlay stderr', { text });
  });
  windowsOverlayProcess.on('error', (err) => {
    windowsOverlayProcess = null;
    scheduleOverlayRestart(args, `spawn-error:${err.message}`);
  });
  windowsOverlayProcess.on('exit', (_code, _signal) => {
    const livedForMs = Date.now() - overlayLaunchStartedAtMs;
    logOverlayHelper('overlay process exited', { code: _code, signal: _signal, livedForMs });
    windowsOverlayProcess = null;
    if (livedForMs < 10_000) {
      scheduleOverlayRestart(args, 'early-exit');
    } else {
      overlayRestartCount = 0;
    }
  });
}
