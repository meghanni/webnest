const { app, BrowserWindow, Menu, Tray, ipcMain, dialog, nativeTheme, shell, nativeImage, safeStorage, screen, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const zlib = require('node:zlib');

const APP_ID = 'com.webnest.desktop';
let sharedUserDataPath;
const CONFIG_PATH = () => path.join(sharedUserDataPath || app.getPath('userData'), 'config.json');
const ENCRYPTED_CONFIG_PATH = () => path.join(sharedUserDataPath || app.getPath('userData'), 'config.enc');
const MANAGER_WINDOW_PATH = () => path.join(sharedUserDataPath || app.getPath('userData'), 'manager-window.json');
const APP_LAUNCH_ARG = '--webnest-open-app';
const APP_QUIT_ARG = '--webnest-quit-app';
const APP_REMOVE_ARG = '--webnest-remove-app';
const APP_SYNC_ARG = '--webnest-sync-app';
const WEBNEST_ICON = path.join(__dirname, '..', 'build', 'icon.png');
const DEFAULT_APP_ICON = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect x="2" y="2" width="28" height="28" rx="9" fill="#705ef0"/><path d="M9 11h14M9 16h11M9 21h8" fill="none" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>');
let managerWindow;
let appTray;
let quitting = false;
let skipAppStateSaveOnClose = false;
let configSaveTimer;
let managerBoundsSaveTimer;
let configLoaded = false;
let pendingAppId = '';
const appWindows = new Map();
const tabbedAppWindows = new Map();

app.setName('WebNest');
app.setAppUserModelId(APP_ID);
Menu.setApplicationMenu(null);
sharedUserDataPath = app.getPath('userData');

function requestedApp(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    for (const [flag, action] of [[APP_LAUNCH_ARG, 'open'], [APP_QUIT_ARG, 'quit'], [APP_REMOVE_ARG, 'remove'], [APP_SYNC_ARG, 'sync']]) {
      const value = arg.startsWith(`${flag}=`) ? arg.slice(flag.length + 1) : arg === flag ? args[index + 1] : '';
      if (/^[a-f0-9-]{36}$/i.test(value)) return { id: value, action };
    }
  }
  return { id: '', action: '' };
}

function desktopNameForApp(id) { return `webnest-app-${id}`; }

function configureWhatsAppBrowserIdentity(win) {
  const version = process.versions.chrome || '100.0.0.0';
  const major = version.split('.')[0];
  const userAgent = app.userAgentFallback
    .replace(/\s*Electron\/\S+/gi, '')
    .replace(/\s*WhatsApp\/\S+/gi, '')
    .trim();
  const brands = `"Chromium";v="${major}", "Not_A Brand";v="24", "Google Chrome";v="${major}"`;
  const fullBrands = `"Chromium";v="${version}", "Not_A Brand";v="24.0.0.0", "Google Chrome";v="${version}"`;

  // Some WhatsApp requests (including workers and fetch/XHR) use Electron's
  // global fallback UA instead of the WebContents override.
  app.userAgentFallback = userAgent;
  win.webContents.setUserAgent(userAgent);
  const appSession = win.webContents.session;
  appSession.setUserAgent(userAgent);
  appSession.webRequest.onBeforeSendHeaders({
    urls: [
      'https://whatsapp.com/*', 'https://*.whatsapp.com/*',
      'https://whatsapp.net/*', 'https://*.whatsapp.net/*',
      'wss://whatsapp.com/*', 'wss://*.whatsapp.com/*',
      'wss://whatsapp.net/*', 'wss://*.whatsapp.net/*'
    ]
  }, (details, callback) => {
    const requestHeaders = { ...details.requestHeaders };
    const setHeader = (name, value) => {
      for (const key of Object.keys(requestHeaders)) {
        if (key.toLowerCase() === name.toLowerCase()) delete requestHeaders[key];
      }
      requestHeaders[name] = value;
    };
    setHeader('User-Agent', userAgent);
    setHeader('Sec-CH-UA', brands);
    setHeader('Sec-CH-UA-Full-Version-List', fullBrands);
    setHeader('Sec-CH-UA-Full-Version', `"${version}"`);
    setHeader('Sec-CH-UA-Platform', '"Linux"');
    setHeader('Sec-CH-UA-Platform-Version', '""');
    setHeader('Sec-CH-UA-Arch', '"x86"');
    setHeader('Sec-CH-UA-Bitness', '"64"');
    setHeader('Sec-CH-UA-Mobile', '?0');
    setHeader('Sec-CH-UA-Model', '""');
    setHeader('Sec-CH-UA-WoW64', '?0');
    callback({ requestHeaders });
  });
}

const initialApp = requestedApp(process.argv);
const initialAppId = initialApp.id;
const initialQuitRequest = ['quit', 'remove'].includes(initialApp.action) && Boolean(initialAppId);
const initialSyncRequest = initialApp.action === 'sync' && Boolean(initialAppId);
if (process.platform === 'linux') {
  if (initialAppId) {
    app.setDesktopName(desktopNameForApp(initialAppId));
    const instanceDataPath = path.join(sharedUserDataPath, 'webapps', initialAppId);
    fs.mkdirSync(instanceDataPath, { recursive: true, mode: 0o700 });
    app.setPath('userData', instanceDataPath);
    // Keep existing persistent Chromium partitions in their original location.
    app.setPath('sessionData', sharedUserDataPath);
  } else {
    app.setDesktopName('webnest');
    // Keep the manager's single-instance lock independent from older builds,
    // including versions that may have left a hidden manager process behind.
    // Settings and web-app sessions remain in the shared data root.
    app.setPath('userData', path.join(sharedUserDataPath, 'manager-runtime-v3'));
    app.setPath('sessionData', sharedUserDataPath);
  }
}

function launchAppProcess(id, action = 'open') {
  const executable = process.env.APPIMAGE || process.execPath;
  const args = [];
  if (!app.isPackaged) args.push(app.getAppPath());
  const flag = action === 'remove' ? APP_REMOVE_ARG : action === 'quit' ? APP_QUIT_ARG : action === 'sync' ? APP_SYNC_ARG : APP_LAUNCH_ARG;
  args.push(`${flag}=${id}`);
  try {
    const child = require('node:child_process').spawn(executable, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (error) {
    console.error(`Could not ${action === 'open' ? 'launch' : 'close'} ${config.apps.find((item) => item.id === id)?.name || 'web app'}:`, error);
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock({ appId: initialAppId });
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, args, _workingDirectory, launchData) => {
    if (quitting) return;
    const requested = requestedApp(args);
    const id = launchData?.appId || requested.id;
    if (initialAppId) {
      if (requested.action === 'sync' && id === initialAppId && configLoaded) syncAppRuntime(id);
      else if (requested.action && requested.action !== 'open' && requested.action !== 'sync' && id === initialAppId) {
        skipAppStateSaveOnClose = requested.action === 'remove';
        quitAppFully({ saveState: requested.action !== 'remove' });
      }
      else if (id === initialAppId && requested.action === 'open' && configLoaded) openApp(id);
      return;
    }
    if (id && requested.action === 'open' && !configLoaded) pendingAppId = id;
    else if (id && requested.action === 'open' && config.apps.some((item) => item.id === id)) {
      if (process.platform === 'linux') launchAppProcess(id);
      else openApp(id);
    }
    else if (!id) showManagerWindow();
  });
}

async function loadConfig() {
  try {
    const encrypted = fs.readFileSync(ENCRYPTED_CONFIG_PATH());
    return normalizeConfig(JSON.parse((await safeStorage.decryptStringAsync(encrypted)).result));
  } catch {}
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8')));
  } catch {}
  return { version: 1, theme: 'system', apps: [] };
}

let config = { version: 1, theme: 'system', apps: [] };

function safeApp(item) {
  if (!item || typeof item !== 'object') return null;
  const name = String(item.name || '').trim().slice(0, 64);
  const url = validateUrl(item.url);
  if (!name || !url) return null;
  const icon = normalizeAppIcon(item.icon);
  const windowSize = item.windowSize && Number.isInteger(item.windowSize.width) && Number.isInteger(item.windowSize.height)
    ? { width: Math.min(5000, Math.max(480, item.windowSize.width)), height: Math.min(4000, Math.max(360, item.windowSize.height)) }
    : null;
  return {
    id: /^[a-f0-9-]{36}$/i.test(item.id || '') ? item.id : crypto.randomUUID(),
    name, url, icon, windowSize, keepInTray: item.keepInTray === true,
    openExternalLinksInBrowser: item.openExternalLinksInBrowser === true,
    allowCamera: item.allowCamera === true,
    allowMicrophone: item.allowMicrophone === true,
    allowNotifications: item.allowNotifications === true,
    lastUrl: safeResumeUrl(url, item.lastUrl),
    tabUrls: [],
    activeTabIndex: 0
  };
}

function normalizeAppIcon(value) {
  if (typeof value !== 'string' || value.length > 1_400_000) return '';
  const match = value.match(/^data:image\/(png|jpeg|webp|x-icon|vnd\.microsoft\.icon|ico);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) return '';
  const format = match[1].toLowerCase();
  const body = Buffer.from(match[2], 'base64');
  let image = nativeImage.createFromBuffer(body);
  if (image.isEmpty() && ['x-icon', 'vnd.microsoft.icon', 'ico'].includes(format)) {
    const png = icoToPng(body);
    if (png) image = nativeImage.createFromBuffer(png);
  }
  if (image.isEmpty()) return '';
  const { width, height } = image.getSize();
  if (!width || !height || width > 4096 || height > 4096) return '';
  const scale = Math.min(1, 256 / Math.max(width, height));
  const png = image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }).toPNG();
  return png.length && png.length <= 256_000 ? `data:image/png;base64,${png.toString('base64')}` : '';
}

function safeResumeUrl(baseUrl, candidate) {
  const safe = validateUrl(candidate);
  if (!safe) return '';
  try {
    const base = new URL(baseUrl);
    const current = new URL(safe);
    if (current.origin !== base.origin) return '';
    // Keep the view path and fragment (for example Gmail's #trash), but drop query strings.
    const hash = /(?:^|[&#])(access_token|id_token|refresh_token|auth_token|token|code)=/i.test(current.hash.slice(1)) ? '' : current.hash;
    return `${current.origin}${current.pathname}${hash}`;
  } catch { return ''; }
}

function normalizeConfig(value) {
  if (value?.version !== 1 || !Array.isArray(value.apps) || !['light', 'dark', 'system'].includes(value.theme)) return { version: 1, theme: 'system', apps: [] };
  const ids = new Set();
  const apps = value.apps.map(safeApp).filter(Boolean).map((item) => {
    if (ids.has(item.id)) item.id = crypto.randomUUID();
    ids.add(item.id);
    return item;
  });
  return { version: 1, theme: value.theme, apps };
}

function isLocalHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host === '::1') return true;
  if (host.startsWith('127.')) return true;
  // IPv4 private ranges
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)) return true;
  // Link-local
  if (host.startsWith('169.254.')) return true;
  // IPv6 link-local/unique-local/loopback
  if (host.startsWith('fe80:') || host.startsWith('fc00:') || host.startsWith('fd00:')) return true;
  // .local mDNS
  if (host.endsWith('.local')) return true;
  return false;
}

function validateUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.username || url.password) return null;
    if (!url.hostname) return null;
    const isHttps = url.protocol === 'https:';
    const isHttp = url.protocol === 'http:';
    if (isHttps) return url.toString();
    if (isHttp && isLocalHostname(url.hostname)) return url.toString();
    return null;
  } catch { return null; }
}

async function readLimitedBody(response, maxBytes) {
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('The website response is too large.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The website returned no content.');
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error('The website response is too large.');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

async function fetchHttpsResource(startUrl, accept, maxBytes, isAllowedType) {
  let currentUrl = validateUrl(startUrl);
  for (let redirects = 0; redirects <= 4; redirects += 1) {
    if (!currentUrl) throw new Error('Only HTTPS icon links are supported.');
    const response = await fetch(currentUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: {
        Accept: accept,
        'Accept-Language': 'en-GB,en;q=0.9',
        'User-Agent': `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome || '100.0.0.0'} Safari/537.36`
      }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 4) throw new Error('The website redirected too many times.');
      currentUrl = validateUrl(new URL(location, currentUrl).href);
      continue;
    }
    if (!response.ok) throw new Error(`The website returned HTTP ${response.status}.`);
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!isAllowedType(contentType)) throw new Error('The website did not return a supported icon.');
    return { url: response.url, contentType, body: await readLimitedBody(response, maxBytes) };
  }
  throw new Error('The website redirected too many times.');
}

const pngCrcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function pngCrc(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = pngCrcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(name, body) {
  const type = Buffer.from(name);
  const data = Buffer.concat([type, body]);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(pngCrc(data));
  return Buffer.concat([header, data, checksum]);
}

function icoToPng(buffer) {
  if (buffer.length < 22 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) return null;
  const count = Math.min(buffer.readUInt16LE(4), 64);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    if (entry + 16 > buffer.length) break;
    const width = buffer[entry] || 256;
    const height = buffer[entry + 1] || 256;
    entries.push({ width, height, bits: buffer.readUInt16LE(entry + 6), length: buffer.readUInt32LE(entry + 8), offset: buffer.readUInt32LE(entry + 12) });
  }
  entries.sort((a, b) => b.width * b.height - a.width * a.height || b.bits - a.bits);

  for (const entry of entries) {
    const { width, height, offset, length } = entry;
    if (width > 512 || height > 512 || offset + length > buffer.length || length < 8) continue;
    const imageData = buffer.subarray(offset, offset + length);
    if (imageData.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return imageData;
    if (length < 40 || imageData.readUInt32LE(0) < 40) continue;
    const headerSize = imageData.readUInt32LE(0);
    const dibWidth = imageData.readInt32LE(4);
    const rawHeight = imageData.readInt32LE(8);
    const bitCount = imageData.readUInt16LE(14);
    const compression = imageData.readUInt32LE(16);
    const dibHeight = Math.floor(Math.abs(rawHeight) / 2);
    if (dibWidth !== width || dibHeight !== height || ![24, 32].includes(bitCount) || compression !== 0 || headerSize > length) continue;
    const bytesPerPixel = bitCount / 8;
    const xorStride = Math.ceil(width * bitCount / 32) * 4;
    const pixelsStart = headerSize;
    const pixelsEnd = pixelsStart + xorStride * height;
    if (pixelsEnd > length) continue;
    const maskStride = Math.ceil(width / 32) * 4;
    const maskStart = pixelsEnd;
    const hasMask = maskStart + maskStride * height <= length;
    const rgbaRows = Buffer.alloc(height * (width * 4 + 1));
    let hasAlpha = false;
    if (bitCount === 32) {
      for (let pixel = pixelsStart + 3; pixel < pixelsEnd; pixel += 4) if (imageData[pixel] !== 0) { hasAlpha = true; break; }
    }
    for (let y = 0; y < height; y += 1) {
      const sourceY = rawHeight < 0 ? y : height - 1 - y;
      const targetRow = y * (width * 4 + 1);
      rgbaRows[targetRow] = 0;
      for (let x = 0; x < width; x += 1) {
        const source = pixelsStart + sourceY * xorStride + x * bytesPerPixel;
        const target = targetRow + 1 + x * 4;
        rgbaRows[target] = imageData[source + 2];
        rgbaRows[target + 1] = imageData[source + 1];
        rgbaRows[target + 2] = imageData[source];
        let alpha = bitCount === 32 && hasAlpha ? imageData[source + 3] : 255;
        if (!hasAlpha && hasMask) {
          const maskY = rawHeight < 0 ? y : height - 1 - y;
          const maskByte = imageData[maskStart + maskY * maskStride + Math.floor(x / 8)];
          if (maskByte & (0x80 >> (x % 8))) alpha = 0;
        }
        rgbaRows[target + 3] = alpha;
      }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', zlib.deflateSync(rgbaRows)),
      pngChunk('IEND', Buffer.alloc(0))
    ]);
  }
  return null;
}

async function fetchWebsiteIcon(value) {
  const pageUrl = validateUrl(value);
  if (!pageUrl) throw new Error('Enter a valid HTTPS website address first.');
  const page = await fetchHttpsResource(pageUrl, 'text/html,application/xhtml+xml', 2_000_000, (type) => type === 'text/html' || type === 'application/xhtml+xml');
  const html = page.body.toString('utf8');
  const candidates = [];
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const attributes = {};
    for (const attr of match[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attributes[attr[1].toLowerCase()] = (attr[2] ?? attr[3] ?? attr[4] ?? '').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
    }
    if (!/(?:icon|manifest)/i.test(attributes.rel || '') || !attributes.href || /^data:/i.test(attributes.href)) continue;
    try {
      const candidate = validateUrl(new URL(attributes.href, page.url).href);
      if (candidate) {
        // A site may expose an icon in its web manifest instead of a favicon link.
        if (/manifest/i.test(attributes.rel || '')) {
          try {
            const manifest = await fetchHttpsResource(candidate, 'application/manifest+json,application/json', 200_000,
              (type) => type === 'application/manifest+json' || type === 'application/json');
            const parsed = JSON.parse(manifest.body.toString('utf8'));
            const icons = Array.isArray(parsed.icons) ? parsed.icons : [];
            icons.sort((a, b) => Number.parseInt(b.sizes || '0', 10) - Number.parseInt(a.sizes || '0', 10));
            for (const icon of icons) {
              if (!icon.src || /^data:/i.test(icon.src)) continue;
              const iconUrl = validateUrl(new URL(icon.src, manifest.url).href);
              if (iconUrl) candidates.push(iconUrl);
            }
          } catch {}
        } else candidates.push(candidate);
      }
    } catch {}
  }
  // Social preview art is often the only branded image left on sites that omit
  // a favicon. It is a useful fallback, particularly for login/redirect pages.
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = {};
    for (const attr of match[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attributes[attr[1].toLowerCase()] = (attr[2] ?? attr[3] ?? attr[4] ?? '').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
    }
    if (!/^(?:og:image|twitter:image)$/i.test(attributes.property || attributes.name || '') || !attributes.content || /^data:/i.test(attributes.content)) continue;
    try {
      const candidate = validateUrl(new URL(attributes.content, page.url).href);
      if (candidate) candidates.push(candidate);
    } catch {}
  }
  for (const pathName of ['/favicon.ico', '/favicon.png', '/apple-touch-icon.png']) {
    try { candidates.push(new URL(pathName, page.url).href); } catch {}
  }

  let lastIconError = '';
  for (const candidate of [...new Set(candidates)]) {
    try {
      const imageFile = await fetchHttpsResource(candidate, 'image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,*/*;q=0.5', 400_000, (type) => type.startsWith('image/'));
      let image;
      if (imageFile.contentType === 'image/svg+xml') {
        image = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${imageFile.body.toString('base64')}`);
      } else image = nativeImage.createFromBuffer(imageFile.body);
      if (image.isEmpty()) {
        const png = icoToPng(imageFile.body);
        if (png) image = nativeImage.createFromBuffer(png);
      }
      if (image.isEmpty()) { lastIconError = 'the icon format could not be decoded'; continue; }
      const size = image.getSize();
      if (!size.width || !size.height || size.width > 4096 || size.height > 4096) continue;
      const scale = Math.min(1, 256 / Math.max(size.width, size.height));
      const png = image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) }).toPNG();
      if (!png.length || png.length > 256_000) { lastIconError = 'the converted icon exceeded the size limit'; continue; }
      return `data:image/png;base64,${png.toString('base64')}`;
    } catch (error) { lastIconError = error.message; }
  }
  // Some sites (including branded login/redirect pages) expose no working
  // favicon at all. As a last resort, ask Google's public favicon cache for
  // this hostname; this sends the hostname, but no account or session data.
  try {
    const hostname = new URL(pageUrl).hostname;
    const fallbackUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=128`;
    const fallback = await fetchHttpsResource(fallbackUrl, 'image/png,image/*,*/*;q=0.5', 100_000, (type) => type.startsWith('image/'));
    let image = nativeImage.createFromBuffer(fallback.body);
    if (image.isEmpty()) {
      const png = icoToPng(fallback.body);
      if (png) image = nativeImage.createFromBuffer(png);
    }
    if (!image.isEmpty()) {
      const size = image.getSize();
      if (size.width && size.height && size.width <= 4096 && size.height <= 4096) {
        const scale = Math.min(1, 256 / Math.max(size.width, size.height));
        const png = image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) }).toPNG();
        if (png.length && png.length <= 256_000) return `data:image/png;base64,${png.toString('base64')}`;
      }
    }
    lastIconError = 'the site and the fallback icon service returned no usable image';
  } catch (error) {
    lastIconError = error.message;
  }
  throw new Error(lastIconError
    ? `Could not find a usable website icon (${lastIconError}). You can upload one instead.`
    : 'Could not find a website icon. You can upload one instead.');
}

async function saveConfig() {
  const file = CONFIG_PATH();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lockPath = `${file}.lock`;
  const lockDeadline = Date.now() + 15_000;
  let lockFd;
  while (lockFd === undefined) {
    try {
      lockFd = fs.openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > 30_000) fs.unlinkSync(lockPath);
      } catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
      if (Date.now() >= lockDeadline) throw new Error('Timed out waiting to save WebNest settings.');
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }

  try {
    const latest = await loadConfig();
    let safe;
    if (initialAppId) {
      const localApp = config.apps.find((item) => item.id === initialAppId);
      const savedApp = latest.apps.find((item) => item.id === initialAppId);
      if (!localApp || !savedApp) return;
      savedApp.windowSize = localApp.windowSize;
      savedApp.lastUrl = localApp.lastUrl;
      savedApp.tabUrls = localApp.tabUrls;
      savedApp.activeTabIndex = localApp.activeTabIndex;
      safe = latest;
    } else {
      safe = {
        version: 1,
        theme: config.theme,
        apps: config.apps.map((item) => {
          const current = safeApp(item);
          const saved = latest.apps.find((candidate) => candidate.id === item.id);
          if (saved && current) {
            current.windowSize = saved.windowSize || current.windowSize;
            current.lastUrl = saved.lastUrl || current.lastUrl;
            current.tabUrls = saved.tabUrls || current.tabUrls;
            current.activeTabIndex = saved.activeTabIndex ?? current.activeTabIndex;
          }
          return current;
        }).filter(Boolean)
      };
    }

    if (await safeStorage.isAsyncEncryptionAvailable()) {
      const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(safe));
      const target = ENCRYPTED_CONFIG_PATH();
      const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temporary, encrypted, { mode: 0o600 });
      fs.renameSync(temporary, target);
      try { fs.unlinkSync(file); } catch {}
    } else {
      const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(safe, null, 2), { mode: 0o600 });
      fs.renameSync(temporary, file);
      try { fs.unlinkSync(ENCRYPTED_CONFIG_PATH()); } catch {}
    }
  } finally {
    fs.closeSync(lockFd);
    try { fs.unlinkSync(lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function scheduleConfigSave() {
  clearTimeout(configSaveTimer);
  configSaveTimer = setTimeout(() => {
    saveConfig().catch((error) => console.error('Could not save WebNest app state:', error));
  }, 400);
}

function updateAppState(id, next) {
  const current = config.apps.find((item) => item.id === id);
  if (!current) return false;
  const changed = Object.entries(next).some(([key, value]) => {
    if (key === 'windowSize') return current.windowSize?.width !== value.width || current.windowSize?.height !== value.height;
    if (key === 'tabUrls') return JSON.stringify(current.tabUrls || []) !== JSON.stringify(value || []);
    return current[key] !== value;
  });
  if (!changed) return false;
  Object.assign(current, next);
  scheduleConfigSave();
  return true;
}

function userDesktopDataPath(...parts) {
  const dataHome = process.env.XDG_DATA_HOME || path.join(app.getPath('home'), '.local', 'share');
  return path.join(dataHome, ...parts);
}

function desktopEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\r/g, '').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
}

function desktopExecArg(value) {
  return `"${String(value).replace(/[\\"$`]/g, '\\$&')}"`;
}

function iconForApp(item) {
  let image = item.icon ? nativeImage.createFromDataURL(item.icon) : nativeImage.createFromDataURL(DEFAULT_APP_ICON);
  if (image.isEmpty()) image = nativeImage.createFromDataURL(DEFAULT_APP_ICON);
  return image.resize({ width: 256, height: 256 }).toPNG();
}

function writeAppLauncher(item) {
  if (process.platform !== 'linux') return;
  const applicationsPath = userDesktopDataPath('applications');
  const iconsPath = userDesktopDataPath('icons', 'hicolor', '256x256', 'apps');
  fs.mkdirSync(applicationsPath, { recursive: true, mode: 0o755 });
  fs.mkdirSync(iconsPath, { recursive: true, mode: 0o755 });

  const iconName = `webnest-${item.id}`;
  const iconPath = path.join(iconsPath, `${iconName}.png`);
  fs.writeFileSync(iconPath, iconForApp(item), { mode: 0o644 });

  const applicationPath = path.join(applicationsPath, `webnest-app-${item.id}.desktop`);
  const executable = process.env.APPIMAGE || process.execPath;
  const command = [desktopExecArg(executable)];
  if (!app.isPackaged) command.push(desktopExecArg(app.getAppPath()));
  command.push(`${APP_LAUNCH_ARG}=${item.id}`);
  const displayName = desktopEscape(item.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim());
  const desktopFile = [
    '[Desktop Entry]',
    'Version=1.0',
    'Type=Application',
    `Name=${displayName}`,
    `Comment=${desktopEscape(`Open ${item.name} in WebNest`)}`,
    `Exec=${command.join(' ')}`,
    `Icon=${iconPath}`,
    'Terminal=false',
    'Categories=Network;WebBrowser;',
    'StartupNotify=true',
    `StartupWMClass=${desktopNameForApp(item.id)}`,
    ''
  ].join('\n');
  fs.writeFileSync(applicationPath, desktopFile, { mode: 0o755 });
  return iconPath;
}

function removeAppLauncher(id) {
  if (process.platform !== 'linux') return;
  const applicationPath = userDesktopDataPath('applications', `webnest-app-${id}.desktop`);
  const iconPath = userDesktopDataPath('icons', 'hicolor', '256x256', 'apps', `webnest-${id}.png`);
  for (const file of [applicationPath, iconPath]) {
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function syncAppLaunchers() {
  if (process.platform !== 'linux') return;
  const validIds = new Set(config.apps.map((item) => item.id));
  const applicationsPath = userDesktopDataPath('applications');
  const iconsPath = userDesktopDataPath('icons', 'hicolor', '256x256', 'apps');
  for (const [directory, pattern] of [[applicationsPath, /^webnest-app-([a-f0-9-]{36})\.desktop$/i], [iconsPath, /^webnest-([a-f0-9-]{36})\.png$/i]]) {
    try {
      for (const name of fs.readdirSync(directory)) {
        const match = name.match(pattern);
        if (match && !validIds.has(match[1])) fs.unlinkSync(path.join(directory, name));
      }
    } catch (error) { if (error.code !== 'ENOENT') console.error('Could not clean WebNest launchers:', error); }
  }
  for (const item of config.apps) {
    try { writeAppLauncher(item); }
    catch (error) { console.error(`Could not add ${item.name} to the Linux app menu:`, error); }
  }
}

function sendState() {
  if (managerWindow && BrowserWindow.getAllWindows().includes(managerWindow)) {
    managerWindow.webContents.send('state', { theme: config.theme, apps: config.apps });
  }
}

function showManagerWindow() {
  if (quitting) return;
  if (!managerWindow) {
    if (!initialAppId && configLoaded && app.isReady()) createManager();
    return;
  }
  if (!BrowserWindow.getAllWindows().includes(managerWindow)) {
    managerWindow = null;
    return;
  }
  managerWindow.show();
  managerWindow.focus();
}

function readManagerWindowState() {
  const fallback = { x: undefined, y: undefined, width: 980, height: 720, maximized: false };
  try {
    const stored = JSON.parse(fs.readFileSync(MANAGER_WINDOW_PATH(), 'utf8'));
    if (!Number.isInteger(stored.x) || !Number.isInteger(stored.y) || !Number.isInteger(stored.width) || !Number.isInteger(stored.height)) return fallback;
    const width = Math.min(5000, Math.max(700, stored.width));
    const height = Math.min(4000, Math.max(540, stored.height));
    const bounds = { x: stored.x, y: stored.y, width, height };
    const visibleOnDisplay = screen.getAllDisplays().some(({ workArea }) => {
      const intersectionWidth = Math.max(0, Math.min(bounds.x + width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x));
      const intersectionHeight = Math.max(0, Math.min(bounds.y + height, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y));
      return intersectionWidth >= 120 && intersectionHeight >= 80;
    });
    if (!visibleOnDisplay) return fallback;
    return { ...bounds, maximized: stored.maximized === true };
  } catch { return fallback; }
}

function saveManagerWindowState() {
  if (!managerWindow || managerWindow.isDestroyed()) return;
  const bounds = managerWindow.getNormalBounds();
  const state = { ...bounds, maximized: managerWindow.isMaximized() };
  try {
    const file = MANAGER_WINDOW_PATH();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) { console.error('Could not save WebNest window position:', error); }
}

function scheduleManagerWindowStateSave() {
  clearTimeout(managerBoundsSaveTimer);
  managerBoundsSaveTimer = setTimeout(saveManagerWindowState, 250);
}

async function setTheme(theme) {
  if (!['light', 'dark', 'system'].includes(theme)) return;
  config.theme = theme;
  nativeTheme.themeSource = theme;
  await saveConfig();
  sendState();
}

function appWebContents(id, window = appWindows.get(id)) {
  const tabState = tabbedAppWindows.get(id);
  const active = tabState?.tabs.find((tab) => tab.id === tabState.activeId);
  return active?.view.webContents || tabState?.hostView.webContents || window?.webContents;
}

function isLegacyTabbedAppUrl(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === 'canva.com' || hostname.endsWith('.canva.com');
  } catch { return false; }
}

// Recognize common second-level country-code suffixes so domains such as
// ebay.co.uk and ebay.com share the same registrable brand label.
const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  'ac.uk', 'co.uk', 'gov.uk', 'ltd.uk', 'me.uk', 'net.uk', 'nhs.uk', 'org.uk', 'plc.uk', 'police.uk', 'sch.uk',
  'asn.au', 'com.au', 'edu.au', 'gov.au', 'id.au', 'net.au', 'org.au',
  'ac.jp', 'co.jp', 'go.jp', 'ne.jp', 'or.jp',
  'co.in', 'firm.in', 'gen.in', 'ind.in', 'net.in', 'org.in',
  'com.br', 'net.br', 'org.br', 'com.cn', 'net.cn', 'org.cn', 'gov.cn',
  'com.hk', 'edu.hk', 'gov.hk', 'net.hk', 'org.hk',
  'com.sg', 'edu.sg', 'gov.sg', 'net.sg', 'org.sg',
  'com.mx', 'com.tr', 'com.tw', 'com.ar', 'com.pl', 'com.ua', 'com.vn', 'com.my', 'com.ph', 'com.sa', 'com.eg', 'co.za', 'co.kr', 'co.nz', 'co.id', 'co.il'
]);

const GOOGLE_DOMAIN_FAMILY = new Set([
  'google', 'googleusercontent', 'googleapis', 'gstatic', 'googlevideo',
  'youtube', 'youtube-nocookie', 'youtu', 'gmail', 'drive', 'docs', 'sheets', 'slides',
  'forms', 'calendar', 'photos', 'maps', 'play', 'meet', 'keep', 'contacts',
  'chat', 'groups', 'sites', 'blogger', 'doubleclick', 'googlesyndication',
  'googleadservices', 'recaptcha', 'gvt1', 'gvt2'
]);

const FACEBOOK_DOMAIN_FAMILY = new Set([
  'facebook', 'fb', 'messenger', 'fbcdn'
]);

function registrableDomainLabel(hostname) {
  const labels = hostname.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length < 2) return '';
  const lastTwo = labels.slice(-2).join('.');
  return labels.length >= 3 && MULTI_LABEL_PUBLIC_SUFFIXES.has(lastTwo) ? labels.at(-3) : labels.at(-2);
}

function isInternalAppUrl(url, appUrl) {
  try {
    const targetUrl = new URL(url);
    const appUrlObj = new URL(appUrl);
    const targetHostname = targetUrl.hostname.toLowerCase().replace(/\.$/, '');
    const appHostname = appUrlObj.hostname.toLowerCase().replace(/\.$/, '');
    // Explicitly treat all google family as internal to each other
    const isGoogleAny = (h) => /google\.com$|google\.co\.|\.google\.|googleapis|googleusercontent|gstatic|youtube\.com|youtu\.be|youtube-nocookie|doubleclick|googlesyndication|googleadservices|gmail\.com|drive\.google|docs\.google|sheets\.google|slides\.google|forms\.google|calendar\.google|meet\.google|photos\.google|maps\.google/i.test(h) || h.includes('google');
    if (isGoogleAny(targetHostname) && isGoogleAny(appHostname)) return true;
    const targetLabel = registrableDomainLabel(targetHostname);
    const appLabel = registrableDomainLabel(appHostname);
    if (!targetLabel || !appLabel) return false;
    if (targetLabel === appLabel) return true;
    if (GOOGLE_DOMAIN_FAMILY.has(targetLabel) && GOOGLE_DOMAIN_FAMILY.has(appLabel)) return true;
    if (FACEBOOK_DOMAIN_FAMILY.has(targetLabel) && FACEBOOK_DOMAIN_FAMILY.has(appLabel)) return true;
    if (targetLabel && appLabel && targetLabel === appLabel) return true;
    return false;
  } catch { return false; }
}

function safeTabResumeUrl(baseUrl, candidate) {
  const safe = validateUrl(candidate);
  if (!safe || !isInternalAppUrl(safe, baseUrl)) return '';
  try {
    const current = new URL(safe);
    // Stored tab addresses are local encrypted state. Drop query strings so
    // OAuth codes and other one-time credentials are never persisted.
    const hash = /(?:^|[&#])(access_token|id_token|refresh_token|auth_token|token|code)=/i.test(current.hash.slice(1)) ? '' : current.hash;
    return `${current.origin}${current.pathname}${hash}`;
  } catch { return ''; }
}

function sameOrigin(value, expectedOrigin) {
  try { return new URL(value).origin === expectedOrigin; }
  catch { return false; }
}

function isAppPermissionAllowed(appId, permission, requestingOrigin, mediaType) {
  const item = config.apps.find((candidate) => candidate.id === appId);
  if (!item || !sameOrigin(requestingOrigin, new URL(item.url).origin)) return false;
  if (permission === 'notifications') return item.allowNotifications;
  if (permission !== 'media') return false;
  if (mediaType === 'video') return item.allowCamera;
  if (mediaType === 'audio') return item.allowMicrophone;
  return false;
}

function configureAppPermissions(session, appId) {
  session.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) =>
    isAppPermissionAllowed(appId, permission, details?.securityOrigin || requestingOrigin, details?.mediaType));
  session.setPermissionRequestHandler((requestingContents, permission, callback, details) => {
    const requestingUrl = details?.requestingUrl || details?.securityOrigin || requestingContents?.getURL();
    if (permission === 'media') {
      const types = details?.mediaTypes || [];
      callback(types.length > 0 && types.every((type) =>
        type === 'video'
          ? isAppPermissionAllowed(appId, permission, requestingUrl, 'video')
          : type === 'audio' && isAppPermissionAllowed(appId, permission, requestingUrl, 'audio')
      ));
      return;
    }
    callback(isAppPermissionAllowed(appId, permission, requestingUrl));
  });
}

function openTabbedApp(item, partition, win) {
  const hostView = new WebContentsView({ webPreferences: {
    preload: path.join(__dirname, 'app-tabs-preload.js'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true
  } });
  const tabState = { id: item.id, item, win, hostView, tabs: [], activeId: '' };
  tabbedAppWindows.set(item.id, tabState);
  const stripHeight = 46;
  const setViewBounds = () => {
    if (win.isDestroyed()) return;
    const [width, height] = win.getContentSize();
    // This BaseWindow contains only explicit WebContentsViews, so the strip
    // and site pages have separate, non-overlapping hit-test areas.
    tabState.hostView.setBounds({ x: 0, y: 0, width, height: stripHeight });
    const tab = tabState.tabs.find((candidate) => candidate.id === tabState.activeId);
    if (tab) tab.view.setBounds({ x: 0, y: stripHeight, width, height: Math.max(0, height - stripHeight) });
  };
  const publishTabs = () => {
    if (win.isDestroyed()) return;
    hostView.webContents.send('app-tabs-state', {
      activeId: tabState.activeId,
      tabs: tabState.tabs.map(({ id, title }) => ({ id, title: title || item.name }))
    });
  };
  const activateTab = (tabId) => {
    const tab = tabState.tabs.find((candidate) => candidate.id === tabId);
    if (!tab || win.isDestroyed()) return false;
    const previous = tabState.tabs.find((candidate) => candidate.id === tabState.activeId);
    if (previous && previous !== tab) {
      try { win.contentView.removeChildView(previous.view); } catch {}
    }
    tabState.activeId = tab.id;
    try { win.contentView.removeChildView(tab.view); } catch {}
    win.contentView.addChildView(tab.view);
    try { win.contentView.removeChildView(tabState.hostView); } catch {}
    win.contentView.addChildView(tabState.hostView);
    setViewBounds();
    win.setTitle(tab.title && tab.title !== item.name ? `${tab.title} — ${item.name}` : item.name);
    publishTabs();
    persistTabs();
    tab.view.webContents.focus();
    return true;
  };
  const createTab = (url, { activate = true } = {}) => {
    const safeUrl = validateUrl(url);
    if (!safeUrl || !isInternalAppUrl(safeUrl, item.url)) return false;
    const view = new WebContentsView({ webPreferences: {
      partition,
      preload: path.join(__dirname, 'webapp-preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: true
    } });
    const tab = { id: crypto.randomUUID(), view, title: item.name, url: safeTabResumeUrl(item.url, safeUrl) };
    tabState.tabs.push(tab);
    configureTabbedAppContents(tab, tabState, { item, createTab, activateTab, publishTabs });
    view.webContents.loadURL(safeUrl).catch((error) => console.error(`Could not open ${item.name} tab:`, error));
    if (activate) activateTab(tab.id);
    else {
      try { win.contentView.addChildView(view); setViewBounds(); } catch {}
      publishTabs();
    }
    return tab.id;
  };
  const closeTab = (tabId) => {
    const index = tabState.tabs.findIndex((tab) => tab.id === tabId);
    if (index < 0) return false;
    const [tab] = tabState.tabs.splice(index, 1);
    if (tab.id === tabState.activeId) {
      win.contentView.removeChildView(tab.view);
      tabState.activeId = '';
    }
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    if (!tabState.tabs.length) createTab(item.url);
    else if (!tabState.activeId) activateTab(tabState.tabs[Math.min(index, tabState.tabs.length - 1)].id);
    publishTabs();
    persistTabs();
    return true;
  };
  const persistTabs = () => {
    const tabUrls = tabState.tabs.map((tab) => safeTabResumeUrl(item.url, tab.url || tab.view.webContents.getURL())).filter(Boolean).slice(0, 20);
    const activeIndex = tabState.tabs.findIndex((tab) => tab.id === tabState.activeId);
    const activeUrl = tabState.tabs[activeIndex]?.url;
    updateAppState(item.id, {
      tabUrls,
      activeTabIndex: Math.max(0, activeIndex),
      ...(activeUrl ? { lastUrl: activeUrl } : {})
    });
  };
  tabState.activateTab = activateTab;
  tabState.createTab = createTab;
  tabState.closeTab = closeTab;
  tabState.persistTabs = persistTabs;
  hostView.webContents.on('did-finish-load', publishTabs);
  hostView.webContents.on('dom-ready', () => {
    try { win.contentView.removeChildView(hostView); win.contentView.addChildView(hostView); } catch {}
    for (const tab of tabState.tabs) { try { win.contentView.removeChildView(tab.view); win.contentView.addChildView(tab.view); } catch {} }
    try { win.contentView.removeChildView(hostView); win.contentView.addChildView(hostView); } catch {}
    setViewBounds();
  });
  win.webContents?.on('before-input-event', (event, input) => {
    if (input.type === 'mouseDown') {
      // crude hit test - just ensure host stays on top
    }
  });
  hostView.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta)) return;
    const activeIndex = tabState.tabs.findIndex((tab) => tab.id === tabState.activeId);
    if (input.key?.toLowerCase() === 'q') { event.preventDefault(); quitAppFully(); }
    else if (input.key?.toLowerCase() === 't') { event.preventDefault(); createTab(item.url); }
    else if (input.key?.toLowerCase() === 'w') { event.preventDefault(); closeTab(tabState.activeId); }
    else if (input.key === 'Tab' && tabState.tabs.length > 1) {
      event.preventDefault();
      const direction = input.shift ? -1 : 1;
      const next = (activeIndex + direction + tabState.tabs.length) % tabState.tabs.length;
      activateTab(tabState.tabs[next].id);
    }
  });
  win.on('resize', () => { setViewBounds(); try { win.contentView.removeChildView(hostView); win.contentView.addChildView(hostView); } catch {} });
  const handleClick = (event) => {
    // This won't catch clicks to child views directly, but worth trying
  };
  win.on('closed', () => {
    appWindows.delete(item.id);
    tabbedAppWindows.delete(item.id);
    if (!hostView.webContents.isDestroyed()) hostView.webContents.close();
    for (const tab of tabState.tabs) if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  });
  win.contentView.addChildView(hostView);
  const shouldResume = item.keepInTray;
  const resumeUrls = shouldResume && tabState.item.tabUrls && tabState.item.tabUrls.length ? tabState.item.tabUrls : (shouldResume ? [item.lastUrl || item.url] : [item.url]);
  for (const url of resumeUrls) createTab(url, { activate: false });
  if (shouldResume) {
    const initialTab = tabState.tabs[Math.min(item.activeTabIndex || 0, tabState.tabs.length - 1)];
    if (initialTab) {
      const tab = initialTab;
      try { win.contentView.removeChildView(tab.view); } catch {}
      win.contentView.addChildView(tab.view);
      tabState.activeId = tab.id;
    }
  } else if (tabState.tabs[0]) {
    const tab = tabState.tabs[0];
    try { win.contentView.removeChildView(tab.view); } catch {}
    win.contentView.addChildView(tab.view);
    tabState.activeId = tab.id;
  }
  for (const tab of tabState.tabs) {
    try { win.contentView.removeChildView(tab.view); } catch {}
    win.contentView.addChildView(tab.view);
  }
  try { win.contentView.removeChildView(hostView); win.contentView.addChildView(hostView); } catch {}
  setViewBounds();
  if (shouldResume) persistTabs();
  else {
    try { updateAppState(item.id, { tabUrls: [], activeTabIndex: 0, lastUrl: '' }); } catch {}
  }
  hostView.webContents.loadFile(path.join(__dirname, 'app-tabs.html')).catch((error) => console.error('Could not load app tab bar:', error));
}

function configureTabbedAppContents(tab, tabState, context) {
  const { item, createTab, activateTab, publishTabs } = context;
  const contents = tab.view.webContents;
  const session = contents.session;
  contents.setUserAgent(contents.getUserAgent().replace(/\sElectron\/[^\s]+/i, ''));
  contents.setWindowOpenHandler(({ url }) => {
    if (isInternalAppUrl(url, item.url)) {
      try { contents.loadURL(url); } catch (error) { console.error(`Could not open related ${item.name} link:`, error); }
      return { action: 'deny' };
    }
    // Always treat Google family as internal regardless of setting
    try {
      const u = new URL(url);
      const iu = new URL(item.url);
      const isG = /google|youtube|gstatic|googleapis|googleusercontent/i.test(u.hostname);
      const isIG = /google|youtube|gstatic|googleapis|googleusercontent/i.test(iu.hostname);
      if (isG && isIG) {
        createTab(url);
        return { action: 'deny' };
      }
    } catch {}
    if (item.openExternalLinksInBrowser) {
      const safeUrl = validateUrl(url);
      if (safeUrl) {
        shell.openExternal(safeUrl).catch((error) => console.error('Could not open external link:', error));
      }
      return { action: 'deny' };
    }
    const safeUrl = validateUrl(url);
    if (safeUrl) {
      try { contents.loadURL(safeUrl); } catch (error) { console.error('Could not open external link:', error); }
    }
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (url === 'about:blank') return;
    if (isInternalAppUrl(url, item.url)) return;
    event.preventDefault();
    if (item.openExternalLinksInBrowser) {
      const safeUrl = validateUrl(url);
      if (safeUrl) shell.openExternal(safeUrl).catch((error) => console.error('Could not open external link:', error));
      return;
    }
    const safeUrl = validateUrl(url);
    if (safeUrl) {
      try { contents.loadURL(safeUrl); } catch (error) { console.error('Could not open external link:', error); }
    }
  });
  contents.on('will-redirect', (event, url) => {
    if (isInternalAppUrl(url, item.url)) return;
    try {
      const u = new URL(url);
      const iu = new URL(item.url);
      if (/google|youtube|gstatic|googleapis|googleusercontent/i.test(u.hostname) && /google|youtube|gstatic|googleapis|googleusercontent/i.test(iu.hostname)) {
        return;
      }
    } catch {}
    event.preventDefault();
    if (item.openExternalLinksInBrowser) {
      const safeUrl = validateUrl(url);
      if (safeUrl) shell.openExternal(safeUrl).catch((error) => console.error('Could not open external link:', error));
      return;
    }
    const safeUrl = validateUrl(url);
    if (safeUrl) {
      try { contents.loadURL(safeUrl); } catch (error) { console.error('Could not open external link:', error); }
    }
  });
  contents.on('did-navigate', (_event, url) => {
    const safeUrl = safeTabResumeUrl(item.url, url);
    if (safeUrl) {
      tab.url = safeUrl;
      if (tab.id === tabState.activeId) updateAppState(item.id, { lastUrl: safeUrl });
      tabState.persistTabs?.();
    }
  });
  contents.on('did-navigate-in-page', (_event, url) => {
    const safeUrl = safeTabResumeUrl(item.url, url);
    if (safeUrl) {
      tab.url = safeUrl;
      if (tab.id === tabState.activeId) updateAppState(item.id, { lastUrl: safeUrl });
      tabState.persistTabs?.();
    }
  });
  contents.on('before-input-event', (event, input) => {
    if (input.type === 'mouseDown' && input.y <= 46) {
      try {
        event.preventDefault();
        const x = input.x || 0;
        let acc = 0;
        for (let i = 0; i < tabState.tabs.length; i++) {
          const w = 150;
          if (x >= acc && x < acc + w - 30) {
            tabState.activateTab(tabState.tabs[i].id);
            return;
          }
          if (x >= acc + w - 30 && x < acc + w) {
            tabState.closeTab(tabState.tabs[i].id);
            return;
          }
          acc += w;
        }
        if (x > acc && x < acc + 40) {
          tabState.createTab(tabState.item.url);
        }
      } catch (e) { console.log('err', e); }
    }
  });
  contents.on('page-title-updated', (_event, title) => {
    tab.title = String(title || item.name).slice(0, 100);
    if (tab.id === tabState.activeId && !tabState.win.isDestroyed()) {
      tabState.win.setTitle(`${tab.title} — ${item.name}`);
    }
    publishTabs();
  });
  contents.on('context-menu', (event, params) => {
    const safeLink = validateUrl(params.linkURL);
    if (!safeLink) return;
    event.preventDefault();
    Menu.buildFromTemplate([{ label: 'Copy link', click: () => clipboard.writeText(safeLink) }])
      .popup({ window: tabState.win, frame: params.frame || contents.mainFrame });
  });
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta)) return;
    const activeIndex = tabState.tabs.findIndex((candidate) => candidate.id === tabState.activeId);
    if (input.key?.toLowerCase() === 'q') { event.preventDefault(); quitAppFully(); }
    else if (input.key?.toLowerCase() === 't') { event.preventDefault(); tabState.createTab(item.url); }
    else if (input.key?.toLowerCase() === 'w' && tabState.tabs.length > 1) {
      event.preventDefault(); tabState.closeTab(tab.id);
    } else if (input.key === 'Tab' && tabState.tabs.length > 1) {
      event.preventDefault();
      const direction = input.shift ? -1 : 1;
      tabState.activateTab(tabState.tabs[(activeIndex + direction + tabState.tabs.length) % tabState.tabs.length].id);
    }
  });
  configureAppPermissions(session, item.id);
  contents.on('did-fail-load', (_event, errorCode, errorDescription, failedUrl, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) console.error(`Could not load ${item.name}: ${errorDescription} (${errorCode}) at ${failedUrl}`);
  });
}

function openApp(id) {
  if (process.platform === 'linux' && !initialAppId) {
    launchAppProcess(id);
    return;
  }
  if (process.platform === 'linux' && id !== initialAppId) return;
  const item = config.apps.find((candidate) => candidate.id === id);
  if (!item) return;
  const current = appWindows.get(id);
  if (current && !current.isDestroyed()) { current.show(); current.focus(); refreshAppTray(item, current); return; }

  if (item.keepInTray) refreshAppTray(item, null);

  let iconPath;
  if (process.platform === 'linux') {
    try { iconPath = writeAppLauncher(item); }
    catch (error) { console.error(`Could not prepare the ${item.name} app icon:`, error); }
  }
  const partition = `persist:webnest-${id}`;
  const windowOptions = {
    width: item.windowSize?.width || 1100,
    height: item.windowSize?.height || 760,
    minWidth: 480, minHeight: 360,
    title: item.name,
    icon: iconPath,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111318' : '#f5f6f8'
  };
  const win = new BrowserWindow({
      ...windowOptions,
    webPreferences: {
      partition,
      preload: path.join(__dirname, 'webapp-preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false
    }
    });
  appWindows.set(id, win);
  // WhatsApp compatibility needs matching HTTP headers and page-visible UA
  // data as well as the traditional User-Agent string.
  const isWhatsApp = (() => {
    try { return /(^|\.)whatsapp\.com$/i.test(new URL(item.url).hostname); }
    catch { return false; }
  })();
  if (isWhatsApp) configureWhatsAppBrowserIdentity(win);
  else win.webContents.setUserAgent(win.webContents.getUserAgent().replace(/\sElectron\/[^\s]+/i, ''));
  if (item.keepInTray) refreshAppTray(item, win);
  const appOrigin = new URL(item.url).origin;
  const isAppOrigin = (url) => {
    try { return new URL(url).origin === appOrigin; }
    catch { return false; }
  };
  const isAppDomainFamily = (url) => isInternalAppUrl(url, item.url);
  const configurePopupHandling = (contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      // Many webmail print actions use window.open() with either a same-origin
      // print route or about:blank followed by document.write(). Keep those
      // windows inside this app's persistent, isolated session.
      if (url === 'about:blank' || isAppOrigin(url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            parent: win,
            title: item.name,
            icon: iconPath,
            autoHideMenuBar: true,
            webPreferences: {
              partition,
              preload: path.join(__dirname, 'webapp-preload.js'),
              contextIsolation: true,
              sandbox: true,
              nodeIntegration: false,
              webSecurity: true,
              spellcheck: false
            }
          }
        };
      }
      try {
        const u = new URL(url);
        const iu = new URL(item.url);
        if (/google|youtube|gstatic|googleapis|googleusercontent/i.test(u.hostname) && /google|youtube|gstatic|googleapis|googleusercontent/i.test(iu.hostname)) {
          if (isAppDomainFamily(url) || true) {
            if (item.openLinksInTabs) { /* let normal flow handle */ }
            contents.loadURL(url).catch((error) => console.error(`Could not open related ${item.name} link:`, error));
            return { action: 'deny' };
          }
        }
      } catch {}
      if (isAppDomainFamily(url)) {
        if (item.openExternalLinksInBrowser) {
          const safeUrl = validateUrl(url);
          if (safeUrl) shell.openExternal(safeUrl).catch((error) => console.error('Could not open external link:', error));
          return { action: 'deny' };
        }
        contents.loadURL(url).catch((error) => console.error(`Could not open related ${item.name} link:`, error));
        return { action: 'deny' };
      }
      if (item.openExternalLinksInBrowser) {
        const safeUrl = validateUrl(url);
        if (safeUrl) shell.openExternal(safeUrl).catch((error) => console.error('Could not open external link:', error));
        return { action: 'deny' };
      }
      const safeUrl = validateUrl(url);
      if (safeUrl) {
        try { contents.loadURL(safeUrl); } catch (error) { console.error('Could not open external link:', error); }
      }
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (url === 'about:blank') return;
      try {
        const u = new URL(url);
        const iu = new URL(item.url);
        if (/google|youtube|gstatic|googleapis|googleusercontent/i.test(u.hostname) && /google|youtube|gstatic|googleapis|googleusercontent/i.test(iu.hostname)) {
          return;
        }
      } catch {}
      if (isAppDomainFamily(url)) return;
      if (item.openExternalLinksInBrowser) {
        event.preventDefault();
        const safeUrl = validateUrl(url);
        if (safeUrl) shell.openExternal(safeUrl).catch((error) => console.error('Could not open external link:', error));
        return;
      }
      event.preventDefault();
      const safeUrl = validateUrl(url);
      if (safeUrl) {
        try { contents.loadURL(safeUrl); } catch (error) { console.error('Could not open external link:', error); }
      }
    });
  };
  configurePopupHandling(win.webContents);
  win.webContents.on('did-create-window', (popup) => {
    popup.setMenuBarVisibility(false);
    popup.webContents.setUserAgent(popup.webContents.getUserAgent().replace(/\sElectron\/[^\s]+/i, ''));
    configurePopupHandling(popup.webContents);
  });
  win.webContents.on('context-menu', (event, params) => {
    const safeLink = validateUrl(params.linkURL);
    if (!safeLink) return;
    event.preventDefault();
    Menu.buildFromTemplate([
      { label: 'Copy link', click: () => clipboard.writeText(safeLink) }
    ]).popup({ window: win, frame: params.frame || win.webContents.mainFrame });
  });
  win.webContents.on('will-navigate', (event, url) => {
    try { if (new URL(url).protocol !== 'https:') event.preventDefault(); } catch { event.preventDefault(); }
  });
  const rememberPage = (_event, url) => {
    const lastUrl = safeResumeUrl(item.url, url);
    if (lastUrl) updateAppState(id, { lastUrl });
  };
  win.webContents.on('did-navigate', rememberPage);
  win.webContents.on('did-navigate-in-page', rememberPage);
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, failedUrl, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) {
      console.error(`Could not load ${item.name}: ${errorDescription} (${errorCode}) at ${failedUrl}`);
    }
  });
  const rememberSize = () => {
    const { width, height } = win.getBounds();
    updateAppState(id, { windowSize: { width, height } });
  };
  win.on('resize', rememberSize);
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key?.toLowerCase() === 'q' && (input.control || input.meta)) {
      event.preventDefault();
      quitAppFully();
    }
  });
  win.on('close', (event) => {
    const currentAppSettings = config.apps.find((candidate) => candidate.id === id) || item;
    if (!quitting && currentAppSettings.keepInTray) {
      rememberSize();
      const currentUrl = safeResumeUrl(item.url, win.webContents.getURL());
      if (currentUrl) updateAppState(id, { lastUrl: currentUrl });
      clearTimeout(configSaveTimer);
      saveConfig().catch((error) => console.error('Could not save WebNest app state:', error));
      event.preventDefault();
      win.hide();
      refreshAppTray(currentAppSettings, win);
    } else if (!quitting) {
      event.preventDefault();
      quitAppFully();
    }
  });
  const appSession = win.webContents.session;
  configureAppPermissions(appSession, item.id);
  win.on('closed', () => appWindows.delete(id));
  win.loadURL(item.keepInTray ? (item.lastUrl || item.url) : item.url).catch((error) => console.error(`Could not open ${item.name}:`, error));
}

function showAppWindow(win) {
  if (!win || win.isDestroyed()) return;
  win.show();
  win.focus();
}

function refreshAppTray(item, win = appWindows.get(item.id)) {
  if (!initialAppId || initialAppId !== item.id) return;
  if (!item.keepInTray) {
    if (appTray) { appTray.destroy(); appTray = null; }
    return;
  }
  const image = nativeImage.createFromDataURL(item.icon || DEFAULT_APP_ICON);
  const icon = (image.isEmpty() ? nativeImage.createFromDataURL(DEFAULT_APP_ICON) : image).resize({ width: 22, height: 22 });
  if (!appTray) {
    appTray = new Tray(icon);
    appTray.on('click', () => {
      const current = appWindows.get(item.id);
      if (current?.isVisible()) current.hide();
      else showAppWindow(current);
      refreshAppTray(item, current);
    });
  } else appTray.setImage(icon);
  appTray.setToolTip(item.name);
  appTray.setContextMenu(Menu.buildFromTemplate([
    { label: `Show ${item.name}`, enabled: !win?.isVisible(), click: () => { showAppWindow(win); refreshAppTray(item, win); } },
    { label: `Hide ${item.name}`, enabled: Boolean(win?.isVisible()), click: () => { win?.hide(); refreshAppTray(item, win); } },
    { type: 'separator' },
    { label: `Close ${item.name}`, click: quitAppFully }
  ]));
}

async function quitAppFully({ saveState = true } = {}) {
  if (quitting) return;
  quitting = true;
  if (appTray) { appTray.destroy(); appTray = null; }
  const win = initialAppId ? appWindows.get(initialAppId) : null;
  if (saveState && win && !win.isDestroyed() && !skipAppStateSaveOnClose) {
    const item = config.apps.find((candidate) => candidate.id === initialAppId);
    const { width, height } = win.getBounds();
    updateAppState(initialAppId, { windowSize: { width, height } });
    tabbedAppWindows.get(initialAppId)?.persistTabs();
    const currentUrl = item && safeResumeUrl(item.url, appWebContents(initialAppId, win)?.getURL());
    if (currentUrl) updateAppState(initialAppId, { lastUrl: currentUrl });
    clearTimeout(configSaveTimer);
    try { await saveConfig(); }
    catch (error) { console.error('Could not save WebNest app state before closing:', error); }
  }
  // app.exit bypasses a website's beforeunload prompt so a full quit really exits.
  app.exit(0);
}

async function syncAppRuntime(id) {
  if (quitting) return;
  const latest = await loadConfig();
  if (quitting) return;
  const item = latest.apps.find((candidate) => candidate.id === id);
  if (!item) {
    skipAppStateSaveOnClose = true;
    quitAppFully();
    return;
  }
  const previous = config.apps.find((candidate) => candidate.id === id);
  config = latest;
  const win = appWindows.get(id);
  if (win && !win.isDestroyed() && previous && (previous.name !== item.name || previous.url !== item.url || previous.icon !== item.icon)) {
    win.setTitle(item.name);
    try {
      const iconPath = writeAppLauncher(item);
      if (iconPath) win.setIcon(nativeImage.createFromPath(iconPath));
    } catch (error) { console.error(`Could not update the ${item.name} app icon:`, error); }
    const targetUrl = item.lastUrl || item.url;
    const contents = appWebContents(id, win);
    if (contents?.getURL() !== targetUrl) {
      if (tabbedAppWindows.has(id)) contents?.loadURL(targetUrl).catch((error) => console.error(`Could not update ${item.name}:`, error));
      else win.loadURL(targetUrl).catch((error) => console.error(`Could not update ${item.name}:`, error));
    }
  }
  refreshAppTray(item, win);
  if (!item.keepInTray && win && !win.isVisible()) quitAppFully();
}

function createManager({ showManager = true } = {}) {
  if (managerWindow && !managerWindow.isDestroyed()) {
    if (showManager) showManagerWindow();
    return;
  }
  const managerState = readManagerWindowState();
  managerWindow = new BrowserWindow({
    x: managerState.x, y: managerState.y,
    width: managerState.width, height: managerState.height, minWidth: 700, minHeight: 540,
    title: 'WebNest', show: false,
    icon: WEBNEST_ICON,
    autoHideMenuBar: true,
    backgroundColor: '#f5f6f8',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  managerWindow.on('move', scheduleManagerWindowStateSave);
  managerWindow.on('resize', scheduleManagerWindowStateSave);
  managerWindow.on('close', () => {
    clearTimeout(managerBoundsSaveTimer);
    saveManagerWindowState();
  });
  managerWindow.on('closed', () => {
    managerWindow = null;
    // The manager has no tray entry, so closing its only window must release
    // the single-instance lock and let a later launch start normally.
    if (!initialAppId && !quitting) {
      quitting = true;
      app.quit();
    }
  });
  managerWindow.loadFile(path.join(__dirname, 'index.html'));
  managerWindow.once('ready-to-show', () => {
    if (managerState.maximized) managerWindow.maximize();
    if (showManager) showManagerWindow();
    sendState();
  });
}

function appTabStateFromSender(event) {
  if (!event.sender) return null;
  // Only the local tab-strip WebContents is registered in this map. Avoid
  // comparing file:// URLs here: Electron may normalize their escaping
  // differently across Linux installations, which can silently reject clicks.
  return [...tabbedAppWindows.values()].find((candidate) =>
    !candidate.win.isDestroyed() && candidate.hostView.webContents === event.sender
  ) || null;
}
ipcMain.handle('app-tab-select', (event, tabId) => {
  console.log('app-tab-select called', tabId);
  const state = appTabStateFromSender(event);
  console.log('state found:', !!state);
  const res = Boolean(state && state.tabs.activateTab(tabId));
  console.log('result:', res);
  return res;
});
ipcMain.handle('app-tab-close', (event, tabId) => {
  const state = appTabStateFromSender(event);
  return Boolean(state && state.tabs.closeTab(tabId));
});
ipcMain.handle('app-tab-new', (event) => {
  const state = appTabStateFromSender(event);
  return Boolean(state && state.tabs.createTab(state.item.url));
});
ipcMain.handle('get-state', () => ({ theme: config.theme, apps: config.apps }));
ipcMain.handle('fetch-icon', async (event, url) => {
  const managerPage = pathToFileURL(path.join(__dirname, 'index.html')).href;
  if (!managerWindow || event.sender !== managerWindow.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== managerPage) {
    throw new Error('Only the WebNest dashboard can fetch website icons.');
  }
  return fetchWebsiteIcon(url);
});
ipcMain.handle('add-app', async (_event, data) => {
  const item = safeApp(data);
  if (!item) throw new Error('Use a name and a valid HTTPS website address.');
  config.apps.push(item); await saveConfig(); syncAppLaunchers(); sendState();
  return item;
});
ipcMain.handle('update-app', async (_event, id, data) => {
  if (initialAppId) throw new Error('Apps can only be edited from the WebNest dashboard.');
  const index = config.apps.findIndex((candidate) => candidate.id === id);
  if (index < 0) throw new Error('This app is no longer in your collection.');
  const current = config.apps[index];
  const updated = safeApp({ ...current, ...data, id: current.id, keepInTray: current.keepInTray, windowSize: current.windowSize, lastUrl: current.lastUrl });
  if (!updated) throw new Error('Use an app name and a valid HTTPS website address.');
  config.apps[index] = updated;
  await saveConfig();
  syncAppLaunchers();
  sendState();
  if (process.platform === 'linux') launchAppProcess(id, 'sync');
  else {
    const win = appWindows.get(id);
    if (win && !win.isDestroyed()) {
      win.setTitle(updated.name);
      const image = nativeImage.createFromDataURL(updated.icon || DEFAULT_APP_ICON);
      if (!image.isEmpty()) win.setIcon(image);
      if (updated.url !== current.url) {
        const targetUrl = updated.lastUrl || updated.url;
        const contents = appWebContents(id, win);
        if (tabbedAppWindows.has(id)) contents?.loadURL(targetUrl).catch((error) => console.error(`Could not update ${updated.name}:`, error));
        else win.loadURL(targetUrl).catch((error) => console.error(`Could not update ${updated.name}:`, error));
      }
    }
  }
  return updated;
});
ipcMain.handle('remove-app', async (_event, id) => {
  if (process.platform === 'linux' && !initialAppId) launchAppProcess(id, 'remove');
  const window = appWindows.get(id);
  if (window && !window.isDestroyed()) { window.destroy(); appWindows.delete(id); }
  config.apps = config.apps.filter((item) => item.id !== id);
  await saveConfig();
  removeAppLauncher(id);
  syncAppLaunchers();
  sendState();
  return true;
});
ipcMain.handle('set-app-tray', async (_event, id, enabled) => {
  if (initialAppId || typeof enabled !== 'boolean') throw new Error('That tray setting cannot be changed here.');
  const item = config.apps.find((candidate) => candidate.id === id);
  if (!item) throw new Error('This app is no longer in your collection.');
  item.keepInTray = enabled;
  await saveConfig();
  sendState();
  if (process.platform === 'linux') launchAppProcess(id, 'sync');
  return true;
});
ipcMain.handle('open-app', (_event, id) => openApp(id));
ipcMain.handle('set-theme', (_event, theme) => setTheme(theme));
ipcMain.handle('export-config', async () => {
  const result = await dialog.showSaveDialog(managerWindow, { title: 'Export WebNest setup', defaultPath: 'webnest-config.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (result.canceled || !result.filePath) return false;
  const portable = { version: 1, theme: config.theme, apps: config.apps.map(({ id, name, url, icon, keepInTray, openLinksInTabs, allowCamera, allowMicrophone, allowNotifications }) => ({ id, name, url, icon, keepInTray, openLinksInTabs, allowCamera, allowMicrophone, allowNotifications })) };
  fs.writeFileSync(result.filePath, JSON.stringify(portable, null, 2), { mode: 0o600 });
  return true;
});
ipcMain.handle('import-config', async () => {
  const result = await dialog.showOpenDialog(managerWindow, { title: 'Import WebNest setup', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (result.canceled || !result.filePaths[0]) return false;
  if (fs.statSync(result.filePaths[0]).size > 40_000_000) throw new Error('That setup file is too large.');
  const imported = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
  if (imported.version !== 1 || !Array.isArray(imported.apps) || imported.apps.length > 100) throw new Error('This WebNest backup is invalid or unsupported.');
  const clean = imported.apps.map(safeApp).filter(Boolean);
  if (new Set(clean.map((item) => item.id)).size !== clean.length) throw new Error('This backup contains duplicate app IDs.');
  config = { version: 1, theme: ['light', 'dark', 'system'].includes(imported.theme) ? imported.theme : 'system', apps: clean };
  nativeTheme.themeSource = config.theme;
  await saveConfig(); syncAppLaunchers(); sendState();
  if (process.platform === 'linux') for (const item of config.apps) launchAppProcess(item.id, 'sync');
  return true;
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  config = await loadConfig();
  configLoaded = true;
  nativeTheme.themeSource = config.theme;
  if (initialAppId) {
    if (initialSyncRequest) { quitting = true; app.quit(); return; }
    if (initialQuitRequest || !config.apps.some((item) => item.id === initialAppId)) {
      quitting = true;
      app.quit();
      return;
    }
    openApp(initialAppId);
    return;
  }
  syncAppLaunchers();
  createManager();
  if (pendingAppId && config.apps.some((item) => item.id === pendingAppId)) launchAppProcess(pendingAppId);
  app.on('activate', showManagerWindow);
});
app.on('before-quit', () => {
  if (process.platform === 'linux' && !initialAppId && !quitting) {
    for (const item of config.apps) launchAppProcess(item.id, 'quit');
  }
  quitting = true;
});
app.on('window-all-closed', () => {
  if (initialAppId && !appTray) app.quit();
});
