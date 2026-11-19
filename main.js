const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const dns = require('node:dns').promises;
const https = require('node:https');
const net = require('node:net');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const tracks = new Map();
const acceptedExtensions = new Set([
  '.aac', '.aif', '.aiff', '.flac', '.m4a', '.m4v', '.mkv', '.mov', '.mp3',
  '.mp4', '.oga', '.ogg', '.wav', '.webm', '.wma'
]);
const MAX_DIRECT_MEDIA_BYTES = 500 * 1024 * 1024;
const streamingDomains = {
  'YouTube': ['youtube.com', 'youtu.be', 'youtube-nocookie.com', 'googlevideo.com'],
  'Spotify': ['spotify.com', 'spotify.link', 'spoti.fi', 'scdn.co', 'spotifycdn.com'],
  'Apple Music': ['music.apple.com', 'itunes.apple.com', 'mzstatic.com'],
  'SoundCloud': ['soundcloud.com', 'sndcdn.com']
};

function matchingDomain(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function streamingServiceFor(hostname) {
  for (const [service, domains] of Object.entries(streamingDomains)) {
    if (domains.some((domain) => matchingDomain(hostname, domain))) return service;
  }
  return null;
}

function assertDirectMediaUrl(input) {
  let url;
  try { url = new URL(input); }
  catch { throw new Error('Plak een geldige HTTPS-link naar een mediabestand.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new Error('Gebruik een openbare HTTPS-link zonder inloggegevens of aangepaste poort.');
  }
  if (streamingServiceFor(url.hostname)) {
    throw new Error('Deze link hoort bij een streamingdienst. Open de officiële dienst of importeer een lokaal bestand.');
  }
  if (/\.(m3u8|m3u|mpd)$/i.test(url.pathname)) {
    throw new Error('Streaming-afspeellijsten worden niet geïmporteerd. Gebruik een directe link naar één mediabestand.');
  }
  if (net.isIP(url.hostname)) throw new Error('Gebruik een domeinnaam voor de downloadlink.');
  return url;
}

function isPublicIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 2 || b === 168)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0 && c === 113)
  );
}

async function resolvePublicIpv4(hostname) {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  const ipv4 = records.filter((record) => record.family === 4);
  if (ipv4.length === 0 || ipv4.some((record) => !isPublicIpv4(record.address))) {
    throw new Error('De link moet verwijzen naar een openbare server.');
  }
  return ipv4[0].address;
}

async function openDirectResponse(inputUrl, redirectCount = 0) {
  if (redirectCount > 5) throw new Error('De downloadlink stuurt te vaak door.');
  const url = assertDirectMediaUrl(inputUrl);
  const address = await resolvePublicIpv4(url.hostname);

  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: url.hostname,
      servername: url.hostname,
      port: 443,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { 'User-Agent': 'AudioWerk/1.0', Accept: 'audio/*, video/*, application/octet-stream' },
      lookup: (_hostname, _options, callback) => callback(null, address, 4)
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const location = response.headers.location;
        response.resume();
        if (!location) return reject(new Error('De downloadlink heeft geen geldig doorstuuradres.'));
        let nextUrl;
        try { nextUrl = new URL(location, url).href; }
        catch { return reject(new Error('De downloadlink heeft geen geldig doorstuuradres.')); }
        openDirectResponse(nextUrl, redirectCount + 1).then(resolve, reject);
        return;
      }
      resolve({ response, url });
    });
    request.setTimeout(30000, () => request.destroy(new Error('De downloadsserver reageert niet.')));
    request.on('error', reject);
    request.end();
  });
}

function directMediaExtension(url, response, contentType) {
  const disposition = String(response.headers['content-disposition'] || '');
  const filenameMatch = disposition.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i);
  const dispositionName = filenameMatch ? (filenameMatch[1] || filenameMatch[2]) : '';
  const dispositionExtension = path.extname(decodeURIComponent(dispositionName)).toLowerCase();
  if (acceptedExtensions.has(dispositionExtension)) return dispositionExtension;
  const fromUrl = path.extname(url.pathname).toLowerCase();
  if (acceptedExtensions.has(fromUrl)) return fromUrl;
  const byMime = {
    'audio/aac': '.aac', 'audio/flac': '.flac', 'audio/x-flac': '.flac',
    'audio/mp4': '.m4a', 'audio/m4a': '.m4a', 'audio/x-m4a': '.m4a',
    'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav',
    'audio/x-wav': '.wav', 'audio/vnd.wave': '.wav', 'audio/x-aiff': '.aiff',
    'audio/aiff': '.aiff', 'audio/x-ms-wma': '.wma', 'video/mp4': '.mp4',
    'application/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm',
    'video/x-matroska': '.mkv'
  };
  return byMime[contentType] || '';
}

async function downloadDirectMedia(inputUrl, event) {
  const { response, url } = await openDirectResponse(inputUrl);
  if (response.statusCode !== 200) {
    response.resume();
    throw new Error(`De downloadsserver gaf status ${response.statusCode || 'onbekend'}.`);
  }

  const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!(contentType.startsWith('audio/') || contentType.startsWith('video/') || [
    'application/octet-stream', 'binary/octet-stream', 'application/force-download', 'application/download'
  ].includes(contentType))) {
    response.resume();
    throw new Error('De link bevat geen direct audio- of videobestand.');
  }

  let extension;
  try { extension = directMediaExtension(url, response, contentType); }
  catch { response.resume(); throw new Error('De bestandsnaam in de link is ongeldig.'); }
  if (!acceptedExtensions.has(extension)) {
    response.resume();
    throw new Error('Het bestandstype van deze link wordt niet ondersteund.');
  }

  const contentLength = Number(response.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > MAX_DIRECT_MEDIA_BYTES) {
    response.resume();
    throw new Error('Het bestand is groter dan 500 MB.');
  }

  const downloadDirectory = path.join(app.getPath('temp'), 'AudioWerk', 'downloads');
  await fs.promises.mkdir(downloadDirectory, { recursive: true });
  const filePath = path.join(downloadDirectory, `${randomUUID()}${extension}`);
  let bytesReceived = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      bytesReceived += chunk.length;
      if (bytesReceived > MAX_DIRECT_MEDIA_BYTES) return callback(new Error('Het bestand is groter dan 500 MB.'));
      if (!event.sender.isDestroyed()) {
        event.sender.send('track:download-progress', {
          loaded: bytesReceived,
          total: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null
        });
      }
      callback(null, chunk);
    }
  });

  try {
    await pipeline(response, meter, fs.createWriteStream(filePath, { flags: 'wx' }));
  } catch (error) {
    await fs.promises.rm(filePath, { force: true });
    throw error;
  }

  return describeTrack(filePath);
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1260,
    height: 850,
    minWidth: 940,
    minHeight: 700,
    backgroundColor: '#f4f7f4',
    title: 'AudioWerk',
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.loadFile('index.html');
  return window;
}

function describeTrack(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (!acceptedExtensions.has(extension)) {
    throw new Error('Dit bestandstype wordt niet ondersteund. Kies een audio- of videobestand.');
  }

  const info = fs.statSync(filePath);
  if (!info.isFile()) throw new Error('Kies een bestand.');

  return {
    id: randomUUID(),
    name: path.basename(filePath),
    extension: extension.slice(1).toUpperCase(),
    bytes: info.size,
    url: require('node:url').pathToFileURL(filePath).href,
    path: filePath
  };
}

function ffmpegExecutable() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'ffmpeg.exe');
  if (process.platform === 'win32') return require('@ffmpeg-installer/win32-x64').path;
  return 'ffmpeg';
}

function normalizeSettings(settings = {}) {
  const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
  return {
    bass: clamp(settings.bass, -12, 12),
    mids: clamp(settings.mids, -12, 12),
    treble: clamp(settings.treble, -12, 12),
    volume: clamp(settings.volume, -18, 12)
  };
}

function formatGain(value) {
  return Number(value).toFixed(1);
}

function makeFilters(settings) {
  const { bass, mids, treble, volume } = normalizeSettings(settings);
  const gain = Math.pow(10, volume / 20).toFixed(5);
  return [
    `bass=g=${formatGain(bass)}:f=110:w=0.7`,
    `equalizer=f=1000:t=q:w=1.0:g=${formatGain(mids)}`,
    `treble=g=${formatGain(treble)}:f=8500:w=0.7`,
    `volume=${gain}`
  ].join(',');
}

function wireWindowControls(window) {
  ipcMain.on('window:minimize', () => window.minimize());
  ipcMain.on('window:toggle-maximize', () => {
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  ipcMain.on('window:close', () => window.close());
}

app.whenReady().then(() => {
  const window = createWindow();
  wireWindowControls(window);

  ipcMain.handle('track:choose', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Kies een audio- of videobestand',
      properties: ['openFile'],
      filters: [
        { name: 'Audio en video', extensions: [...acceptedExtensions].map((ext) => ext.slice(1)) },
        { name: 'Alle bestanden', extensions: ['*'] }
      ]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const track = describeTrack(result.filePaths[0]);
    tracks.set(track.id, track.path);
    return { id: track.id, name: track.name, extension: track.extension, bytes: track.bytes, url: track.url };
  });

  ipcMain.handle('track:drop', (_event, filePath) => {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      throw new Error('Dit bestand kan niet worden geopend.');
    }
    const track = describeTrack(filePath);
    tracks.set(track.id, track.path);
    return { id: track.id, name: track.name, extension: track.extension, bytes: track.bytes, url: track.url };
  });

  ipcMain.handle('track:download-url', async (event, inputUrl) => {
    if (typeof inputUrl !== 'string') throw new Error('Plak eerst een downloadlink.');
    const track = await downloadDirectMedia(inputUrl, event);
    tracks.set(track.id, track.path);
    return { id: track.id, name: track.name, extension: track.extension, bytes: track.bytes, url: track.url };
  });

  ipcMain.handle('link:open-service', async (_event, inputUrl) => {
    let url;
    try { url = new URL(inputUrl); }
    catch { throw new Error('Dit is geen geldige link.'); }
    const service = streamingServiceFor(url.hostname);
    if (!service || url.protocol !== 'https:' || url.username || url.password) {
      throw new Error('Alleen links naar de officiële streamingdiensten kunnen worden geopend.');
    }
    await shell.openExternal(url.href);
    return service;
  });

  ipcMain.handle('track:convert', async (event, id, settings, durationSeconds) => {
    const input = tracks.get(id);
    if (!input) throw new Error('Kies eerst een bestand om te converteren.');

    const suggested = `${path.basename(input, path.extname(input))}-omgezet.m4a`;
    const result = await dialog.showSaveDialog(window, {
      title: 'Bewaar je M4A-bestand',
      defaultPath: path.join(path.dirname(input), suggested),
      buttonLabel: 'Bewaar M4A',
      filters: [{ name: 'M4A-audio', extensions: ['m4a'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };

    const output = result.filePath.toLowerCase().endsWith('.m4a') ? result.filePath : `${result.filePath}.m4a`;
    const args = [
      '-hide_banner', '-y', '-i', input,
      '-map', '0:a:0', '-vn',
      '-af', makeFilters(settings),
      '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart',
      '-progress', 'pipe:1', '-nostats', output
    ];

    await new Promise((resolve, reject) => {
      const child = spawn(ffmpegExecutable(), args, { windowsHide: true });
      let errorOutput = '';
      let progressBuffer = '';
      let lastProgress = 0;

      child.stderr.on('data', (chunk) => { errorOutput += chunk.toString(); });
      child.stdout.on('data', (chunk) => {
        progressBuffer += chunk.toString();
        const lines = progressBuffer.split(/\r?\n/);
        progressBuffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('out_time_ms=')) continue;
          const elapsed = Number(line.slice(12)) / 1000000;
          const duration = Number(durationSeconds) || 0;
          const progress = Math.max(lastProgress, Math.min(94, Math.round(elapsed / Math.max(duration, 1) * 100)));
          if (progress > lastProgress) {
            lastProgress = progress;
            event.sender.send('track:progress', progress);
          }
        }
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          event.sender.send('track:progress', 100);
          resolve();
        } else {
          fs.rm(output, { force: true }, () => {});
          reject(new Error(errorOutput.trim().split('\n').slice(-2).join(' ').replace(/\s+/g, ' ') || 'De conversie is mislukt. Controleer of het bestand audio bevat.'));
        }
      });
    });

    return { canceled: false, path: output, name: path.basename(output) };
  });

  ipcMain.handle('output:show', async (_event, outputPath) => {
    if (typeof outputPath !== 'string' || !path.isAbsolute(outputPath) || !fs.existsSync(outputPath)) return false;
    shell.showItemInFolder(outputPath);
    return true;
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  fs.rm(path.join(app.getPath('temp'), 'AudioWerk', 'downloads'), { recursive: true, force: true }, () => {});
});
