const $ = (selector) => document.querySelector(selector);
const controls = {
  bass: $('#bass'),
  mids: $('#mids'),
  treble: $('#treble'),
  volume: $('#volume')
};
const labels = {
  bass: $('#bass-value'),
  mids: $('#mids-value'),
  treble: $('#treble-value'),
  volume: $('#volume-value')
};
const audio = $('#audio');
let selectedTrack = null;
let outputPath = null;
let audioContext = null;
let sourceNode = null;
let lowFilter = null;
let midFilter = null;
let highFilter = null;
let volumeNode = null;
let toastTimer = null;
let pendingServiceUrl = null;

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 5000);
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${remainder}`;
}

function setRangeFill(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const value = Number(input.value);
  const percent = ((value - min) / (max - min)) * 100;
  input.style.setProperty('--range-fill', `${percent}%`);
}

function ensureAudioGraph() {
  if (audioContext) return;
  audioContext = new AudioContext();
  sourceNode = audioContext.createMediaElementSource(audio);
  lowFilter = audioContext.createBiquadFilter();
  lowFilter.type = 'lowshelf';
  lowFilter.frequency.value = 110;
  midFilter = audioContext.createBiquadFilter();
  midFilter.type = 'peaking';
  midFilter.frequency.value = 1000;
  midFilter.Q.value = 1;
  highFilter = audioContext.createBiquadFilter();
  highFilter.type = 'highshelf';
  highFilter.frequency.value = 8500;
  volumeNode = audioContext.createGain();
  sourceNode.connect(lowFilter).connect(midFilter).connect(highFilter).connect(volumeNode).connect(audioContext.destination);
}

function applySettings() {
  const values = {};
  for (const [name, input] of Object.entries(controls)) {
    const value = Number(input.value);
    values[name] = value;
    labels[name].textContent = `${value > 0 ? '+' : ''}${value} dB`;
    setRangeFill(input);
  }

  if (audioContext) {
    lowFilter.gain.setTargetAtTime(values.bass, audioContext.currentTime, .025);
    midFilter.gain.setTargetAtTime(values.mids, audioContext.currentTime, .025);
    highFilter.gain.setTargetAtTime(values.treble, audioContext.currentTime, .025);
    volumeNode.gain.setTargetAtTime(Math.pow(10, values.volume / 20), audioContext.currentTime, .025);
  }

  const curveY = 26;
  const bassOffset = values.bass * .6;
  const midOffset = values.mids * .55;
  const trebleOffset = values.treble * .6;
  $('#curve-path').setAttribute('d', `M0 ${curveY - bassOffset} C55 ${curveY - bassOffset} 68 ${curveY - bassOffset} 110 ${curveY - bassOffset} S175 ${curveY - midOffset} 220 ${curveY - midOffset} S285 ${curveY - trebleOffset} 330 ${curveY - trebleOffset} S390 ${curveY - trebleOffset} 440 ${curveY - trebleOffset}`);
}

function addTrack(track) {
  if (!track) return;
  selectedTrack = track;
  outputPath = null;
  $('#file-name').textContent = track.name;
  $('#file-meta').textContent = `${track.extension} · ${formatBytes(track.bytes)}`;
  $('#selected-file').classList.remove('hidden');
  $('#drop-zone').classList.add('has-file');
  $('#convert').disabled = false;
  $('#play').disabled = false;
  $('#player-status').textContent = 'VOORBEELD · LIVE GELUIDSAANPASSING';
  $('#result').classList.add('hidden');
  $('#progress-wrap').classList.add('hidden');
  updateWorkflow(2);
  audio.pause();
  audio.src = track.url;
  audio.load();
  $('#play .play-glyph').classList.remove('hidden');
  $('#play .pause-glyph').classList.add('hidden');
  applySettings();
}

function updateWorkflow(activeStep) {
  document.querySelectorAll('.workflow-step').forEach((step, index) => {
    step.classList.toggle('active', index + 1 <= activeStep);
  });
}

function setSourceMode(mode) {
  const isLink = mode === 'link';
  $('#file-mode').classList.toggle('active', !isLink);
  $('#file-mode').setAttribute('aria-selected', String(!isLink));
  $('#link-mode').classList.toggle('active', isLink);
  $('#link-mode').setAttribute('aria-selected', String(isLink));
  $('#file-source').classList.toggle('hidden', isLink);
  $('#link-source').classList.toggle('hidden', !isLink);
  if (isLink) $('#source-url').focus();
}

function streamingServiceFor(input) {
  let hostname;
  try { hostname = new URL(input).hostname.toLowerCase(); }
  catch { return null; }
  const services = {
    YouTube: ['youtube.com', 'youtu.be', 'youtube-nocookie.com', 'googlevideo.com'],
    Spotify: ['spotify.com', 'spotify.link', 'spoti.fi', 'scdn.co', 'spotifycdn.com'],
    'Apple Music': ['music.apple.com', 'itunes.apple.com', 'mzstatic.com'],
    SoundCloud: ['soundcloud.com', 'sndcdn.com']
  };
  for (const [name, domains] of Object.entries(services)) {
    if (domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) return name;
  }
  return null;
}

function setLinkStatus(message, kind = '') {
  const status = $('#link-status');
  status.textContent = message;
  status.classList.remove('error', 'service');
  if (kind) status.classList.add(kind);
}

$('#file-mode').addEventListener('click', () => setSourceMode('file'));
$('#link-mode').addEventListener('click', () => setSourceMode('link'));

async function importLink() {
  const input = $('#source-url');
  const url = input.value.trim();
  if (!url) {
    setLinkStatus('Plak een HTTPS-link naar een direct audio- of videobestand.', 'error');
    input.focus();
    return;
  }

  const service = streamingServiceFor(url);
  if (service) {
    pendingServiceUrl = url;
    setLinkStatus(`${service}-link herkend. AudioWerk neemt geen streamingaudio op. Open de dienst en gebruik alleen een officiële downloadoptie voor je eigen bestand.`, 'service');
    $('#open-service').classList.remove('hidden');
    $('#link-download-progress').classList.add('hidden');
    return;
  }

  pendingServiceUrl = null;
  $('#open-service').classList.add('hidden');
  $('#import-link').disabled = true;
  $('#link-download-progress').classList.remove('hidden');
  $('#link-progress-value').textContent = '…';
  $('#link-progress-bar').style.width = '4%';
  setLinkStatus('Directe mediabestandlink wordt gecontroleerd…');
  try {
    const track = await window.audioWerk.downloadUrl(url);
    setLinkStatus('Bestand binnengehaald. Je kunt nu luisteren en de instellingen aanpassen.', 'service');
    addTrack(track);
    setSourceMode('file');
    $('#link-download-progress').classList.add('hidden');
  } catch (error) {
    setLinkStatus(error.message || 'Deze link kan niet als mediabestand worden geïmporteerd.', 'error');
    $('#link-download-progress').classList.add('hidden');
  } finally {
    $('#import-link').disabled = false;
  }
}

$('#import-link').addEventListener('click', importLink);
$('#source-url').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    importLink();
  }
});
$('#open-service').addEventListener('click', async () => {
  if (!pendingServiceUrl) return;
  try {
    const service = await window.audioWerk.openServiceLink(pendingServiceUrl);
    setLinkStatus(`${service} is geopend. Importeer daarna een lokaal bestand dat je officieel kunt downloaden.`, 'service');
  } catch (error) {
    setLinkStatus(error.message || 'De link kon niet worden geopend.', 'error');
  }
});

window.audioWerk.onDownloadProgress(({ loaded, total }) => {
  if (total) {
    const percent = Math.min(99, Math.round(loaded / total * 100));
    $('#link-progress-value').textContent = `${percent}%`;
    $('#link-progress-bar').style.width = `${percent}%`;
  } else {
    $('#link-progress-value').textContent = formatBytes(loaded);
    $('#link-progress-bar').style.width = '42%';
  }
});

$('#drop-zone').addEventListener('click', async () => {
  try { addTrack(await window.audioWerk.chooseTrack()); }
  catch (error) { showToast(error.message); }
});

$('#drop-zone').addEventListener('dragover', (event) => {
  event.preventDefault();
  $('#drop-zone').classList.add('dragover');
});
$('#drop-zone').addEventListener('dragleave', () => $('#drop-zone').classList.remove('dragover'));
$('#drop-zone').addEventListener('drop', async (event) => {
  event.preventDefault();
  $('#drop-zone').classList.remove('dragover');
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  try { addTrack(await window.audioWerk.dropTrack(file)); }
  catch (error) { showToast(error.message); }
});

$('#remove-file').addEventListener('click', () => {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  selectedTrack = null;
  outputPath = null;
  $('#selected-file').classList.add('hidden');
  $('#convert').disabled = true;
  $('#play').disabled = true;
  $('#player-status').textContent = 'VOEG EEN BESTAND TOE OM TE LUISTEREN';
  $('#time-readout').textContent = '0:00 / 0:00';
  $('#seek').value = 0;
  $('#result').classList.add('hidden');
  $('#progress-wrap').classList.add('hidden');
  updateWorkflow(1);
});

$('#play').addEventListener('click', async () => {
  if (!selectedTrack) return;
  ensureAudioGraph();
  await audioContext.resume();
  if (audio.paused) {
    try { await audio.play(); }
    catch { showToast('Dit bestand kan niet als voorbeeld worden afgespeeld.'); }
  } else audio.pause();
});

audio.addEventListener('play', () => {
  $('#play .play-glyph').classList.add('hidden');
  $('#play .pause-glyph').classList.remove('hidden');
});
audio.addEventListener('pause', () => {
  $('#play .play-glyph').classList.remove('hidden');
  $('#play .pause-glyph').classList.add('hidden');
});
audio.addEventListener('loadedmetadata', () => {
  $('#time-readout').textContent = `0:00 / ${formatTime(audio.duration)}`;
  $('#seek').disabled = !Number.isFinite(audio.duration);
});
audio.addEventListener('timeupdate', () => {
  const duration = audio.duration || 0;
  $('#time-readout').textContent = `${formatTime(audio.currentTime)} / ${formatTime(duration)}`;
  $('#seek').value = duration ? Math.round(audio.currentTime / duration * 1000) : 0;
  setRangeFill($('#seek'));
});
$('#seek').addEventListener('input', () => {
  if (audio.duration) audio.currentTime = Number($('#seek').value) / 1000 * audio.duration;
});

for (const input of Object.values(controls)) input.addEventListener('input', applySettings);
$('#reset-eq').addEventListener('click', () => {
  for (const input of Object.values(controls)) input.value = 0;
  applySettings();
});

window.audioWerk.onProgress((value) => {
  $('#progress-value').textContent = `${value}%`;
  $('#progress-bar').style.width = `${value}%`;
});

$('#convert').addEventListener('click', async () => {
  if (!selectedTrack) return;
  $('#convert').disabled = true;
  $('#progress-wrap').classList.remove('hidden');
  $('#progress-label').textContent = 'AUDIO WORDT OMGEZET';
  $('#progress-value').textContent = '0%';
  $('#progress-bar').style.width = '0%';
  $('#result').classList.add('hidden');
  try {
    const result = await window.audioWerk.convert(selectedTrack.id, {
      bass: controls.bass.value,
      mids: controls.mids.value,
      treble: controls.treble.value,
      volume: controls.volume.value
    }, audio.duration);
    if (result.canceled) {
      $('#progress-wrap').classList.add('hidden');
      return;
    }
    outputPath = result.path;
    $('#progress-label').textContent = 'KLAAR';
    $('#result-name').textContent = result.name;
    $('#result').classList.remove('hidden');
    updateWorkflow(3);
  } catch (error) {
    $('#progress-wrap').classList.add('hidden');
    showToast(error.message || 'Er ging iets mis bij het omzetten.');
  } finally {
    $('#convert').disabled = !selectedTrack;
  }
});

$('#show-output').addEventListener('click', async () => {
  if (outputPath) await window.audioWerk.showOutput(outputPath);
});

$('#minimize').addEventListener('click', () => window.audioWerk.minimize());
$('#maximize').addEventListener('click', () => window.audioWerk.toggleMaximize());
$('#close').addEventListener('click', () => window.audioWerk.close());
applySettings();
