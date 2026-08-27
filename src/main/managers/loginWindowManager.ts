import { BrowserWindow, screen } from 'electron';

type PipState =
  | { type: 'waiting' }
  | { type: 'code'; userCode: string; verificationUrl: string; expiresAt: number }
  | { type: 'error'; message: string };

const PIP_WIDTH = 340;
const PIP_HEIGHT = 440;
const PIP_MARGIN = 16;
// Covers the macOS unmaximize/zoom-out animation (~300ms) plus a safety buffer.
const UNMAXIMIZE_SETTLE_MS = 500;

let pipModeWindow: BrowserWindow | null = null;
let savedBounds: Electron.Rectangle | null = null;
let savedResizable = true;
let savedMinimizable = true;
let savedMaximizable = true;
let savedMinWidth = 1024;
let savedMinHeight = 660;
let savedWasMaximized = false;
let savedWasFullScreen = false;

function isEffectivelyMaximized(win: BrowserWindow): boolean {
  if (win.isMaximized()) return true;
  // Fallback: macOS pre-show maximize() doesn't always set isZoomed in time.
  // Compare actual bounds against the display work area.
  const b = win.getBounds();
  const { workArea } = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
  return b.width >= workArea.width * 0.95 && b.height >= workArea.height * 0.95;
}

function applyPipBounds(win: BrowserWindow): void {
  // Guard against a stale deferred call (e.g. a late 'leave-full-screen' event)
  // firing after PiP mode was already exited — don't shrink a restored window.
  if (win.isDestroyed() || pipModeWindow !== win) return;

  const display = screen.getDisplayNearestPoint(win.getBounds());
  const { x: dX, y: dY, width: dW } = display.workArea;
  const targetX = dX + dW - PIP_WIDTH - PIP_MARGIN;
  const targetY = dY + PIP_MARGIN;

  // 1. Remove ALL size constraints so macOS cannot clamp the resize.
  win.setMinimumSize(1, 1);

  // 2. Resize using separate setSize + setPosition instead of setBounds —
  //    more reliable on macOS for programmatic resizing.
  win.setSize(PIP_WIDTH, PIP_HEIGHT, false);
  win.setPosition(targetX, targetY, false);

  // 3. Lock the size AFTER resizing — on macOS, setting resizable:false
  //    before setSize can cause the OS to reject the resize.
  win.setMinimumSize(PIP_WIDTH, PIP_HEIGHT);
  win.setResizable(false);
  win.setMinimizable(false);
  win.setMaximizable(false);

  // 4. Tell the renderer to switch to the PiP view.
  win.webContents.send('login-pip:enter');
}

export function enterPipMode(win: BrowserWindow): void {
  if (pipModeWindow && !pipModeWindow.isDestroyed()) return;

  pipModeWindow = win;
  savedBounds = win.getBounds();
  savedResizable = win.isResizable();
  savedMinimizable = win.isMinimizable();
  savedMaximizable = win.isMaximizable();
  savedWasMaximized = win.isMaximized();
  savedWasFullScreen = win.isFullScreen();
  [savedMinWidth, savedMinHeight] = win.getMinimumSize();

  // Start alwaysOnTop now so the window floats immediately.
  win.setAlwaysOnTop(true, 'floating');

  if (win.isFullScreen()) {
    // macOS native fullscreen lives in its own Space — setSize/setBounds are
    // ignored until the window leaves fullscreen. The exit is slow (~1s) and
    // animated, so wait for the 'leave-full-screen' event (not a timeout).
    win.once('leave-full-screen', () => applyPipBounds(win));
    win.setFullScreen(false);
  } else if (isEffectivelyMaximized(win)) {
    // Maximize/zoom exit is short; the 'unmaximize' event fires at animation
    // START, so a flat delay is more reliable than the event here.
    win.unmaximize();
    setTimeout(() => applyPipBounds(win), UNMAXIMIZE_SETTLE_MS);
  } else {
    // Already windowed — resize immediately.
    applyPipBounds(win);
  }
}

function exitPipMode(): void {
  const win = pipModeWindow;
  if (!win || win.isDestroyed() || !savedBounds) return;

  if (win.isMinimized()) {
    win.once('restore', () => exitPipMode());
    win.restore();
    return;
  }

  // Unlock controls and size constraints before restoring.
  win.setAlwaysOnTop(false);
  win.setResizable(savedResizable);
  win.setMinimizable(savedMinimizable);
  win.setMaximizable(savedMaximizable);
  win.setMinimumSize(savedMinWidth, savedMinHeight);

  if (savedWasFullScreen) {
    win.setFullScreen(true);
  } else if (savedWasMaximized) {
    // Restore to maximized directly — no setBounds needed, the OS knows the
    // previous maximized geometry. Calling setBounds then maximize looks janky.
    win.maximize();
  } else {
    win.setBounds(savedBounds, true);
  }

  pipModeWindow = null;
  savedBounds = null;
}

export function exitPipModeToRoute(route: string): void {
  const win = pipModeWindow;
  if (win && !win.isDestroyed()) {
    win.webContents.send('login-pip:exit', route);
  }
  exitPipMode();
}

/**
 * Retained so a view that mounts mid-login (the PIP panel, after the window
 * shrinks) can ask for the current state instead of waiting for the next push
 * that may never come.
 */
let lastLoginState: PipState | null = null;

export function getLoginPipState(): PipState | null {
  return lastLoginState;
}

/**
 * Broadcast rather than targeted: the code is shown full-size first and only
 * moves into the PIP panel once the user opens the verification link, so the
 * receiving window changes mid-flow.
 */
export function sendLoginPipState(state: PipState): void {
  lastLoginState = state;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    win.webContents.send('login-pip:state', state);
  }
}
