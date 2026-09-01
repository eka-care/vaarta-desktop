import fs from 'node:fs';
import path from 'node:path';
import { app, net } from 'electron';
import {
  getAuthToken,
  getRefreshToken,
  notifyScribeTokensUpdated,
  persistConnectAuthTokens,
  isLogoutInProgress,
} from './authManager';
import { getApiUpstreamBase, ELECTRON_API_ORIGIN } from '../config';

type ConnectAuthRefreshResponse = {
  access_token?: string;
  refresh_token?: string;
};

// Result of a token refresh attempt.
// - ok: tokens were refreshed and persisted.
// - isNetworkError: the attempt failed because the request never reached the
//   server (offline / DNS failure / timeout). Callers must NOT log the user out
//   in this case. Any other failure (401/403, missing tokens, 5xx) has
//   isNetworkError=false and is treated as a real auth failure → logout.
export type RefreshResult = {
  ok: boolean;
  isNetworkError: boolean;
};

const REFRESH_TIMEOUT_MS = 15000;

// Connection-level error codes that mean the request never reached the server.
const NETWORK_ERROR_PATTERNS = [
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_NETWORK_CHANGED',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_ADDRESS_UNREACHABLE',
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
];

function isNetworkLevelError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true;
  const text = String(error);
  return NETWORK_ERROR_PATTERNS.some((pattern) => text.includes(pattern));
}

function logRefresh(message: string, meta?: unknown): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}\n`;
  try {
    const logFilePath = path.join(app.getPath('userData'), 'login.log');
    fs.appendFileSync(logFilePath, line, 'utf8');
  } catch { /* best-effort */ }
  console.log(line.trim());
}

async function refreshTokenOnMain(ekaHost: string, clientId: string): Promise<RefreshResult> {
  logRefresh('[connectAuthRefresh] HTTP POST start', {
    ekaHost,
    clientId,
    hasAuthToken: !!getAuthToken(),
    hasRefreshToken: !!getRefreshToken(),
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
  try {
    // ekaHost is '' for same-origin ekascribe-web builds. Resolve against the real upstream
    // rather than the Express proxy: the proxy retries 401s by calling this refresher, so
    // routing the refresh back through it would recurse.
    const refreshUrl = new URL(
      `${ekaHost}/connect-auth/v1/refresh`,
      getApiUpstreamBase(),
    ).toString();
    const response = await (net.fetch as Function)(
      refreshUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'client-id': clientId,
          auth: getAuthToken(),
          Origin: ELECTRON_API_ORIGIN,
        },
        body: JSON.stringify({
          refresh_token: getRefreshToken() ?? '',
          access_token: getAuthToken() ?? '',
        }),
        credentials: 'include',
        signal: controller.signal,
        bypassCustomProtocolHandlers: true,
      },
    );

    logRefresh('[connectAuthRefresh] HTTP response', { status: response.status, ok: response.ok });

    // A response (any status) means we reached the server — never a network error.
    if (!response.ok) {
      logRefresh('[connectAuthRefresh] HTTP POST failed — refresh rejected', { status: response.status });
      return { ok: false, isNetworkError: false };
    }

    const data = (await response.json()) as ConnectAuthRefreshResponse;
    const accessToken = typeof data.access_token === 'string' ? data.access_token : '';
    const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : '';
    if (!accessToken || !refreshToken) {
      logRefresh('[connectAuthRefresh] HTTP POST missing tokens in response');
      return { ok: false, isNetworkError: false };
    }

    persistConnectAuthTokens(accessToken, refreshToken);
    notifyScribeTokensUpdated();
    logRefresh('[connectAuthRefresh] success — tokens persisted');
    return { ok: true, isNetworkError: false };
  } catch (error) {
    const networkError = isNetworkLevelError(error);
    return { ok: false, isNetworkError: networkError };
  } finally {
    clearTimeout(timer);
  }
}

// Per-host in-flight refresh so renderer-side IPC and networkManager's 401 retry
// never race for the single-use refresh_token (which causes 403 → forced logout).
const refreshInFlight = new Map<string, Promise<RefreshResult>>();

export async function refreshConnectAuthTokensDeduped(
  ekaHost: string,
  clientId: string,
): Promise<RefreshResult> {
  if (isLogoutInProgress()) {
    logRefresh('[connectAuthRefresh] skipped — logout in progress');
    return { ok: false, isNetworkError: false };
  }

  const existing = refreshInFlight.get(ekaHost);
  if (existing) {
    logRefresh('[connectAuthRefresh] joining in-flight refresh', { ekaHost });
    return existing;
  }
  logRefresh('[connectAuthRefresh] starting fresh refresh', { ekaHost, clientId });
  const promise = (async () => {
    try {
      return await refreshTokenOnMain(ekaHost, clientId);
    } finally {
      refreshInFlight.delete(ekaHost);
    }
  })();
  refreshInFlight.set(ekaHost, promise);
  return promise;
}
