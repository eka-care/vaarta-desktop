import { ipcMain, net, session } from 'electron';
import { getAuthToken } from './authManager';
import { ELECTRON_API_ORIGIN, getApiUpstreamBase } from '../config';

export interface NetworkRequestPayload {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  retry: boolean;
  ekaHost: string;
}

export interface NetworkResponsePayload {
  status: number;
  statusText: string;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
}

const DEFAULT_CLIENT_ID = 'doc-web';
const REQUEST_TIMEOUT_MS = 15000;

// Sentinel returned when the request never reached the server (offline / timeout).
// status 0 is the conventional "no HTTP response" marker — callers treat it as a
// network error rather than an auth failure.
const NETWORK_ERROR_RESPONSE: NetworkResponsePayload = {
  status: 0,
  statusText: 'Network Error',
  ok: false,
  headers: {},
  body: '',
};

/**
 * Renderer callers may pass a relative URL ('/connect-auth/...'). The renderer would resolve
 * it against its page origin, but by the time it arrives here over IPC there is no origin
 * left and `net.fetch` rejects with "Failed to parse URL". Resolve against the upstream API,
 * which is where a same-origin relative path would have landed anyway (the `app://` protocol
 * handler forwards API paths there).
 */
function toAbsoluteUrl(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  try {
    return new URL(url, getApiUpstreamBase()).toString();
  } catch {
    return url;
  }
}

const SECRET_HEADERS = new Set(['auth', 'authorization', 'cookie']);

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    sanitized[key] = SECRET_HEADERS.has(key.toLowerCase()) ? '<redacted>' : value;
  }
  return sanitized;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Replayable curl for debugging — secrets redacted in header values. */
function toCurl(method: string, url: string, headers: Record<string, string>, body: string | null): string {
  const parts = ['curl', '-i', '-X', method, shellQuote(url)];
  for (const [key, value] of Object.entries(redactHeaders(headers))) {
    parts.push('-H', shellQuote(`${key}: ${value}`));
  }
  if (body !== null && method !== 'GET' && method !== 'HEAD') {
    const truncated = body.length > 2000 ? `${body.slice(0, 2000)}…` : body;
    parts.push('--data-raw', shellQuote(truncated));
  }
  return parts.join(' ');
}

/** True only for the configured upstream — not the other eka.care hosts. */
function isVaartaUpstream(url: string): boolean {
  try {
    return new URL(url).origin === new URL(getApiUpstreamBase()).origin;
  } catch {
    return false;
  }
}

/** True when this URL is the real upstream API (not the loopback proxy / page). */
function isUpstreamApiTarget(url: string): boolean {
  try {
    const target = new URL(url).origin;
    const upstream = new URL(getApiUpstreamBase()).origin;
    if (target === upstream) return true;
    return target === 'https://api.eka.care' || target.endsWith('.eka.care');
  } catch {
    return false;
  }
}

async function executeRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | null,
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers,
    credentials: 'include',
  };

  if (body !== null && method !== 'GET' && method !== 'HEAD') {
    init.body = body;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await (net.fetch as Function)(url, {
      ...init,
      signal: controller.signal,
      bypassCustomProtocolHandlers: true,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function serializeResponse(response: Response): Promise<NetworkResponsePayload> {
  const body = await response.text();
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: response.status, statusText: response.statusText, ok: response.ok, headers, body };
}

async function handleNetworkRequest(
  _event: Electron.IpcMainInvokeEvent,
  payload: NetworkRequestPayload,
): Promise<NetworkResponsePayload> {
  const { method, headers, body, retry } = payload;
  const url = toAbsoluteUrl(payload.url);

  // Direct-to-upstream — stamp the desktop Origin the API allowlists; this hop has no
  // browser origin of its own.
  if (isUpstreamApiTarget(url)) {
    headers.origin = ELECTRON_API_ORIGIN;
    delete headers.Origin;
    delete headers.Referer;
    delete headers.referer;
  }

  // This transport bypasses the `onBeforeSendHeaders` hook below (that only sees
  // renderer-initiated requests), so the vaarta upstream's `Authorization: Bearer`
  // has to be attached here too — the web app sends the legacy `auth` header only.
  if (isVaartaUpstream(url) && !headers['Authorization'] && !headers['authorization']) {
    const authToken = getAuthToken();
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }
  }

  // Only backend calls get the client id. Requests to third-party hosts (presigned upload
  // URLs and the like) are forwarded untouched — attaching session identifiers to them
  // would leak them.
  if (isVaartaUpstream(url) && !headers['client-id']) {
    headers['client-id'] = DEFAULT_CLIENT_ID;
  }

  console.log('[networkManager] curl\n' + toCurl(method, url, headers, body));

  let response: Response;
  try {
    response = await executeRequest(url, method, headers, body);
  } catch (error) {
    // Offline / DNS failure / timeout — the request never reached the server.
    // Surface a sentinel instead of rejecting so the web layer can treat it as
    // an offline error (not an auth failure → no logout).
    console.warn('[networkManager] request failed (network/timeout)', {
      method,
      url,
      error: String(error),
      curl: toCurl(method, url, headers, body),
    });
    return NETWORK_ERROR_RESPONSE;
  }

  const serialized = await serializeResponse(response);
  const bodyPreview =
    serialized.body.length > 4000
      ? `${serialized.body.slice(0, 4000)}… (${serialized.body.length} bytes)`
      : serialized.body;

  console.log('[networkManager] response', {
    method,
    url,
    status_code: serialized.status,
    statusText: serialized.statusText,
    ok: serialized.ok,
    retry,
    headers: redactHeaders(serialized.headers),
    body: bodyPreview,
  });

  return serialized;
}

export function registerNetworkIpcHandlers(): void {
  ipcMain.handle('network:request', handleNetworkRequest);

  // Inject auth for renderer fetch() that bypasses the IPC transport (vendored SDK raw
  // fetch). With the API proxy disabled this is the only thing attaching credentials to
  // those calls.
  //
  // Origin is deliberately NOT touched here. The window is served from `app://ekascribe`,
  // so Chromium already sends exactly the origin the API allowlists — and rewriting it
  // would be worse than redundant: `webRequest` alters the header on the wire but not the
  // origin CORS validates the response against, so an upstream echoing the rewritten value
  // fails the check.
  const upstream = getApiUpstreamBase().replace(/\/+$/, '');
  session.defaultSession.webRequest.onBeforeSendHeaders(
    {
      urls: [
        `${upstream}/*`,
        'https://api.eka.care/*',
        'https://*.eka.care/*',
      ],
    },
    (details, callback) => {
      const requestHeaders = { ...details.requestHeaders };
      const authToken = getAuthToken();
      if (authToken) {
        if (details.url.startsWith(upstream)) {
          // The vaarta upstream authenticates on `Authorization: Bearer`.
          if (!requestHeaders['Authorization'] && !requestHeaders['authorization']) {
            requestHeaders['Authorization'] = `Bearer ${authToken}`;
          }
        } else if (!requestHeaders['auth'] && !requestHeaders['Auth']) {
          // Other eka.care hosts keep the legacy `auth` header contract.
          requestHeaders['auth'] = authToken;
        }
      }
      delete requestHeaders['Referer'];
      callback({ requestHeaders });
    }
  );
}
