const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const tracks = new Map();
const acceptedExtensions = new Set([
  '.aac', '.aif', '.aiff', '.flac', '.m4a', '.m4v', '.mkv', '.mov', '.mp3',
  '.mp4', '.oga', '.ogg', '.wav', '.webm', '.wma'
]);

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
