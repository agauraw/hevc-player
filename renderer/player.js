'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let player          = null;
let hideControlsTimer = null;

// ── Element references ────────────────────────────────────────────────────────
const video          = document.getElementById('video');
const streamUrlEl    = document.getElementById('streamUrl');
const licenseUrlEl   = document.getElementById('licenseUrl');
const licenseBodyEl  = document.getElementById('licenseRequestBody');
const wvRobustEl     = document.getElementById('wvRobustness');
const presetEl       = document.getElementById('presetSelect');
const loadBtn        = document.getElementById('loadBtn');
const stopBtn        = document.getElementById('stopBtn');
const browseBtn      = document.getElementById('browseBtn');
const browseVttBtn   = document.getElementById('browseVttBtn');
const loadVttBtn     = document.getElementById('loadVttBtn');
const vttUrlEl       = document.getElementById('vttUrl');
const vttTrackStatus = document.getElementById('vttTrackStatus');
const captionsToggle = document.getElementById('captionsToggle');
const captionsBody   = document.getElementById('captionsBody');
const addHeaderBtn   = document.getElementById('addHeaderBtn');
const headersListEl  = document.getElementById('headersList');
const playPauseBtn   = document.getElementById('playPauseBtn');
const muteBtn        = document.getElementById('muteBtn');
const fullscreenBtn  = document.getElementById('fullscreenBtn');
const seekBar        = document.getElementById('seekBar');
const volumeBar      = document.getElementById('volumeBar');
const currentTimeEl  = document.getElementById('currentTime');
const durationEl     = document.getElementById('duration');
const qualitySelect  = document.getElementById('qualitySelect');
const audioSelect    = document.getElementById('audioSelect');
const textSelect     = document.getElementById('textSelect');
const idleOverlay    = document.getElementById('idleOverlay');
const spinnerOverlay = document.getElementById('spinnerOverlay');
const errorOverlay   = document.getElementById('errorOverlay');
const errorMessageEl = document.getElementById('errorMessage');
const errorDismiss   = document.getElementById('errorDismiss');
const liveBadge      = document.getElementById('liveBadge');
const videoWrapper   = document.getElementById('videoWrapper');
const statusMsgEl    = document.getElementById('statusMsg');
const wvStatusEl     = document.getElementById('wvStatus');
const hevcStatusEl   = document.getElementById('hevcStatus');
const wvBadge        = document.getElementById('wv-badge');
const hevcBadge      = document.getElementById('hevc-badge');
const drmToggle      = document.getElementById('drmToggle');
const drmBody        = document.getElementById('drmBody');
const codecToggle    = document.getElementById('codecToggle');
const codecBody      = document.getElementById('codecBody');
const aboutBtn          = document.getElementById('aboutBtn');
const aboutBackdrop     = document.getElementById('aboutBackdrop');
const aboutClose        = document.getElementById('aboutClose');
const aboutEmail        = document.getElementById('aboutEmail');
const testLicenseBtn    = document.getElementById('testLicenseBtn');
const licenseTestResult = document.getElementById('licenseTestResult');
const licenseTestDetail = document.getElementById('licenseTestDetail');

// streamAnalyzer is instantiated in analyzer.js and placed on window
const analyzer = window.streamAnalyzer;

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatTime(s) {
  if (!isFinite(s) || s < 0) return '∞';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
    : `${m}:${String(sec).padStart(2,'0')}`;
}

function setStatus(msg) { statusMsgEl.textContent = msg; }

// Build a human-readable Shaka error string.
// For 1001 (BAD_HTTP_STATUS): e.data = [uri, httpStatus, responseText, headers, requestType]
// For 1002 (HTTP_ERROR):       e.data = [uri, error, requestType]
// For 6007 (LICENSE_REQUEST_FAILED): e.data = [uri, httpStatus, responseText]
function formatShakaError(e) {
  const code = e.code;
  const data = e.data || [];

  const NAME_MAP = {
    1001: 'BAD_HTTP_STATUS',
    1002: 'HTTP_ERROR',
    1003: 'TIMEOUT',
    1004: 'MALFORMED_DATA_URI',
    1005: 'UNKNOWN_DATA_URI_ENCODING',
    1006: 'REQUEST_FILTER_ERROR',
    1007: 'RESPONSE_FILTER_ERROR',
    1008: 'MALFORMED_TEST_URI',
    2000: 'UNABLE_TO_GUESS_MANIFEST_TYPE',
    2001: 'DASH_INVALID_XML',
    2012: 'HLS_PLAYLIST_HEADER_MISSING',
    6000: 'ERROR_LOADING_KEYID_OR_SESSIONID',
    6001: 'FAILED_TO_ATTACH_TO_VIDEO',
    6007: 'LICENSE_REQUEST_FAILED',
    6008: 'LICENSE_RESPONSE_REJECTED',
    6014: 'ENCRYPTED_CONTENT_WITHOUT_DRM_INFO',
  };

  const name = NAME_MAP[code] || `CODE_${code}`;
  const parts = [`Shaka ${name} (${code})`];

  if (code === 1001) {
    // data[0] = URI,  data[1] = HTTP status
    if (data[1]) parts.push(`HTTP ${data[1]}`);
    if (data[0]) parts.push(`URL: ${String(data[0]).split('?')[0]}`);
    if (data[1] === 403) parts.push('→ Authorization required. Check DRM license headers.');
    if (data[1] === 404) parts.push('→ Not found. Verify the stream URL.');
    if (data[1] === 0)   parts.push('→ Network blocked (CORS, firewall, or offline).');
  } else if (code === 1002) {
    if (data[0]) parts.push(`URL: ${String(data[0]).split('?')[0]}`);
    parts.push('→ Network request failed (timeout, DNS, or SSL error).');
  } else if (code === 6007) {
    if (data[1]) parts.push(`License server returned HTTP ${data[1]}`);
    if (data[0]) parts.push(`License URL: ${String(data[0]).split('?')[0]}`);
    parts.push('→ Check the Widevine license server URL and auth headers.');
  } else if (e.message) {
    parts.push(e.message);
  }

  return parts.join('\n');
}

// ── VTT parsing ───────────────────────────────────────────────────────────────
function parseVttTime(str) {
  const parts = str.trim().split(':').map(parseFloat);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

function parseVtt(text) {
  const cues = [];
  const blocks = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (!lines.length) continue;
    if (lines[0].startsWith('WEBVTT') || lines[0].startsWith('NOTE')) continue;
    const timingIdx = lines.findIndex(l => l.includes('-->'));
    if (timingIdx < 0) continue;
    const timingLine = lines[timingIdx];
    const arrowIdx   = timingLine.indexOf('-->');
    const startStr   = timingLine.slice(0, arrowIdx).trim();
    // End time ends before any position settings (first space after timestamp)
    const afterArrow = timingLine.slice(arrowIdx + 3).trim();
    const endStr     = afterArrow.split(/\s+/)[0];
    const bodyLines  = lines.slice(timingIdx + 1);
    // Strip VTT cue payload tags like <b>, <i>, <c.color>, timestamps
    const rawText = bodyLines.join('\n').trim();
    const text    = rawText.replace(/<[^>]+>/g, '').trim();
    if (!text) continue;
    const id = lines.slice(0, timingIdx).join(' ').trim() || String(cues.length + 1);
    cues.push({ id, startTime: parseVttTime(startStr), endTime: parseVttTime(endStr), startStr, endStr, text, rawText });
  }
  return cues;
}

async function loadAndParseVtt(uri, label) {
  try {
    const res  = await fetch(uri);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw  = await res.text();
    const cues = parseVtt(raw);
    analyzer.addVttTrack(raw, cues, label || uri.split('/').pop().split('?')[0]);
    vttTrackStatus.style.display = 'block';
    vttTrackStatus.style.color   = '';
    vttTrackStatus.textContent   = `✓ ${label || uri.split('/').pop().split('?')[0]}  ·  ${cues.length} cue${cues.length !== 1 ? 's' : ''}`;
    setStatus(`Caption track loaded: ${cues.length} cues`);
    // Wire cue-change events for active cue tracking
    _hookTextTracks();
  } catch (err) {
    vttTrackStatus.style.display = 'block';
    vttTrackStatus.textContent   = `⚠ Failed to load: ${err.message}`;
    vttTrackStatus.style.color   = 'var(--red)';
  }
}

let _vttTimeupdateHooked = false;
function _hookTextTracks() {
  const tl = video.textTracks;
  for (let i = 0; i < tl.length; i++) {
    const track = tl[i];
    if (track._vttHooked) continue;
    track._vttHooked = true;
    track.addEventListener('cuechange', () => analyzer.updateActiveCue(video.currentTime));
  }
  if (!_vttTimeupdateHooked) {
    _vttTimeupdateHooked = true;
    video.addEventListener('timeupdate', () => analyzer.updateActiveCue(video.currentTime), { passive: true });
  }
}

function showError(msg) {
  errorMessageEl.textContent  = msg;
  errorOverlay.style.display  = 'flex';
  idleOverlay.style.display   = 'none';
  spinnerOverlay.style.display = 'none';
  setStatus('Error — ' + msg.substring(0, 80));
}

function showSpinner(on) { spinnerOverlay.style.display = on ? 'flex' : 'none'; }

// ── Container / Codec info strip ──────────────────────────────────────────────
function updateContainerStrip() {
  if (!player) return;
  const track = player.getVariantTracks().find(t => t.active);
  if (!track) return;

  const strip = document.getElementById('containerStrip');
  strip.style.display = 'flex';

  // ── Stream format (HLS vs DASH) ─────────────────────────────────────
  const url = streamUrlEl.value.trim();
  const fmt = url.includes('.mpd') ? 'MPEG-DASH' : url.includes('.m3u8') ? 'HLS' : 'Unknown';

  // ── Container (CMAF fMP4 vs MPEG-TS) ───────────────────────────────
  // CMAF containers use mp4/m4s mime; TS uses video/mp2t
  const mime = track.mimeType || '';
  let container = '—';
  if (/mp4|m4s|fmp4/i.test(mime))   container = 'CMAF (fMP4)';
  else if (/mp2t|mpegts|ts/i.test(mime)) container = 'MPEG-TS';
  else if (mime)                     container = mime.split('/')[1]?.toUpperCase() || mime;

  // ── Video codec friendly name ────────────────────────────────────────
  const vc = (track.videoCodec || '').toLowerCase();
  let vcodec = track.videoCodec || '—';
  if (/^hev1|^hvc1/.test(vc))       vcodec = 'HEVC (H.265)';
  else if (/^avc1|^avc3/.test(vc))  vcodec = 'AVC (H.264)';
  else if (/^av01/.test(vc))        vcodec = 'AV1';
  else if (/^vp09|^vp9/.test(vc))   vcodec = 'VP9';
  else if (/^vp08|^vp8/.test(vc))   vcodec = 'VP8';

  // ── Audio codec friendly name ────────────────────────────────────────
  const ac = (track.audioCodec || '').toLowerCase();
  let acodec = track.audioCodec || '—';
  if (/^mp4a\.40\.2|^mp4a\.40\.5/.test(ac)) acodec = 'AAC-LC';
  else if (/^mp4a\.40/.test(ac))   acodec = 'AAC';
  else if (/^ec-3/.test(ac))       acodec = 'E-AC-3 (Dolby Digital+)';
  else if (/^ac-3/.test(ac))       acodec = 'AC-3 (Dolby Digital)';
  else if (/^opus/.test(ac))       acodec = 'Opus';
  else if (/^flac/.test(ac))       acodec = 'FLAC';
  else if (/^dtsc/.test(ac))       acodec = 'DTS Core';

  // ── Resolution ───────────────────────────────────────────────────────
  const res = track.width && track.height ? `${track.width}×${track.height}` : '—';

  // ── Total bitrate ─────────────────────────────────────────────────────
  const tbr = track.bandwidth ? `${Math.round(track.bandwidth / 1000)} kbps` : '—';

  document.getElementById('cs-format').textContent    = fmt;
  document.getElementById('cs-container').textContent = container;
  document.getElementById('cs-vcodec').textContent    = vcodec;
  document.getElementById('cs-acodec').textContent    = acodec;
  document.getElementById('cs-res').textContent       = res;
  document.getElementById('cs-tbr').textContent       = tbr;
}

function updateBufferStats() {
  try {
    const b = video.buffered;
    let totalBuf = 0;
    const rangeStrs = [];
    for (let i = 0; i < b.length; i++) {
      totalBuf += b.end(i) - b.start(i);
      rangeStrs.push(`[${b.start(i).toFixed(2)} – ${b.end(i).toFixed(2)}]`);
    }
    const setS = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    setS('buf-buffered', totalBuf > 0 ? `${totalBuf.toFixed(1)} s` : '—');
    setS('buf-duration', isFinite(video.duration) ? `${video.duration.toFixed(1)} s` : '—');
    setS('buf-ranges',   b.length ? `${b.length} range${b.length > 1 ? 's' : ''}` : '0');
    const latEl = document.getElementById('buf-latency');
    if (latEl && player) {
      const lat = player.getStats?.()?.liveLatency;
      latEl.textContent = lat != null ? `${lat.toFixed(2)} s` : 'N/A';
    }
    const listEl = document.getElementById('bufRangeList');
    if (listEl) listEl.textContent = rangeStrs.length ? 'Ranges: ' + rangeStrs.join('  ') : '';
  } catch {}
}

function collectDrmHeaders() {
  const headers = {};
  headersListEl.querySelectorAll('.header-entry').forEach(row => {
    const [k, v] = row.querySelectorAll('input');
    if (k.value.trim()) headers[k.value.trim()] = v.value.trim();
  });
  return headers;
}

function buildCodecPreference() {
  const p = [];
  if (document.getElementById('prefHEVC').checked) p.push('hev1','hvc1');
  if (document.getElementById('prefAV1').checked)  p.push('av01');
  if (document.getElementById('prefH264').checked) p.push('avc1');
  return p;
}

// ── Capability checks ─────────────────────────────────────────────────────────
async function checkWidevine() {
  const info = await window.electronAPI.getWidevineInfo();
  if (info.available) {
    wvBadge.textContent = `WV ${info.version}`;
    wvBadge.className   = 'badge badge--on';
    wvStatusEl.textContent = `Widevine: v${info.version}`;
  } else {
    wvBadge.textContent = 'WV –';
    wvBadge.className   = 'badge badge--warn';
    wvStatusEl.textContent = 'Widevine: not found (install Chrome)';
  }
}

async function checkHEVC() {
  try {
    const r = await navigator.mediaCapabilities.decodingInfo({
      type: 'media-source',
      video: { contentType: 'video/mp4; codecs="hev1.1.6.L153.B0"', width:1920, height:1080, bitrate:10_000_000, framerate:30 },
    });
    if (r.supported) {
      const hw = r.powerEfficient ? 'HW' : 'SW';
      hevcBadge.textContent = `HEVC ${hw}`;
      hevcBadge.className   = 'badge badge--on';
      hevcStatusEl.textContent = `HEVC: supported (${hw} decode)`;
    } else throw 0;
  } catch {
    hevcBadge.textContent = 'HEVC –';
    hevcBadge.className   = 'badge badge--warn';
    hevcStatusEl.textContent = 'HEVC: not supported on this device';
  }
}

// ── Shaka Player init ─────────────────────────────────────────────────────────
function initShaka() {
  shaka.polyfill.installAll();
  if (!shaka.Player.isBrowserSupported()) { showError('Shaka Player is not supported in this environment.'); return; }

  player = new shaka.Player(video);

  player.addEventListener('error', evt => {
    const e = evt.detail;
    analyzer.logEvent('player', 'error', formatShakaError(e).split('\n')[0]);
    showError(formatShakaError(e));
    setLoadingState(false);
  });

  player.addEventListener('buffering', evt => {
    showSpinner(evt.buffering);
    if (!evt.buffering) setStatus('Playing');
    analyzer.logEvent('player', evt.buffering ? 'buffering-start' : 'buffering-end');
  });

  player.addEventListener('trackschanged', () => {
    updateTrackSelectors();
    updateContainerStrip();
    analyzer.logEvent('player', 'trackschanged', `${player.getVariantTracks().length} variants`);
  });

  player.addEventListener('adaptation', () => {
    updateTrackSelectors();
    updateContainerStrip();
    const t = player.getVariantTracks().find(t => t.active);
    analyzer.logEvent('abr', 'adaptation', t ? `→ ${t.height||'?'}p ${Math.round((t.bandwidth||0)/1000)} kbps (${t.videoCodec||'?'})` : '');
  });

  player.addEventListener('loaded', () => {
    analyzer.logEvent('player', 'loaded', `Live: ${player.isLive()}`);
  });
  player.addEventListener('texttrackadded', () => {
    analyzer.logEvent('player', 'texttrackadded');
    _hookTextTracks();
  });

  player.addEventListener('loading', () => analyzer.logEvent('player', 'loading'));
  player.addEventListener('unloading', () => analyzer.logEvent('player', 'unloading'));

  // DRM / key status events
  player.addEventListener('drmsessionupdate', () => {
    const ks = player.getKeyStatuses();
    analyzer.logEvent('drm', 'drmsessionupdate', JSON.stringify(ks).substring(0,120));
  });

  // ── Ad Markers / Timeline regions ─────────────────────────────────────
  player.addEventListener('timelineregionadded', evt => {
    const r = evt.detail;
    analyzer.addTimelineRegion(r);
    analyzer.logEvent('info', 'timelineregionadded',
      `[${r.startTime?.toFixed(2)}s – ${r.endTime?.toFixed(2)}s] ${r.schemeIdUri || ''} ${r.id ? `id=${r.id}` : ''}`);
  });

  player.addEventListener('timelineregionenter', evt => {
    const r = evt.detail;
    analyzer.logEvent('info', 'timelineregionenter', `[${r.id || r.schemeIdUri || ''}] @ ${video.currentTime.toFixed(2)}s`);
    // Try to decode SCTE-35 from region eventElement if available
    let scte35 = null, descriptors = [];
    if (r.eventElement && window.AdMarkers) {
      try {
        const raw = r.eventElement.textContent?.trim().replace(/\s/g, '');
        if (raw) {
          scte35 = window.AdMarkers.SCTE35Decoder.decode(raw);
          if (!scte35.error) {
            // Parse descriptors from the raw buffer after the command
            const bin  = atob(raw.replace(/-/g,'+').replace(/_/g,'/'));
            const buf  = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
            descriptors = window.AdMarkers.SCTE35Decoder.parseDescriptors(buf, 14) || [];
          }
        }
      } catch {}
    }
    analyzer.enterAdBreak({ region: r, scte35, descriptors, videoTime: video.currentTime });
  });

  player.addEventListener('timelineregionexit', evt => {
    const r = evt.detail;
    analyzer.logEvent('info', 'timelineregionexit', `[${r.id || r.schemeIdUri || ''}] @ ${video.currentTime.toFixed(2)}s`);
    analyzer.exitAdBreak({ region: r, videoTime: video.currentTime });
  });

  // ID3 timed metadata (HLS) — may contain SCTE-35 SpliceInsert
  player.addEventListener('metadata', evt => {
    const d = evt.detail;
    const type = d.metadataType || d.type || 'unknown';
    let detail = `type=${type}`;
    if (d.payload && window.AdMarkers) {
      try {
        // Some streams embed SCTE-35 as ID3 TXXX or PRIV frames
        const payload = typeof d.payload === 'string' ? d.payload : null;
        if (payload) detail += ` payload=${payload.substring(0, 60)}`;
      } catch {}
    }
    analyzer.logEvent('info', 'metadata', detail);
  });

  // MPEG-DASH emsg boxes (in-band event messages — often SCTE-35 or SCTE-214)
  player.addEventListener('emsg', evt => {
    const d = evt.detail;
    const scheme = d.schemeIdUri || '';
    const isScte = /scte35|splice/i.test(scheme);
    analyzer.logEvent('info', 'emsg', `scheme=${scheme} id=${d.id||''} pts=${d.startTime?.toFixed(2)||'?'}s`);
    if (isScte && d.messageData && window.AdMarkers) {
      try {
        const bytes = new Uint8Array(d.messageData);
        let b64 = '';
        for (let i = 0; i < bytes.length; i++) b64 += String.fromCharCode(bytes[i]);
        const decoded = window.AdMarkers.SCTE35Decoder.decode(btoa(b64));
        const descriptors = !decoded.error
          ? (window.AdMarkers.SCTE35Decoder.parseDescriptors(bytes, 14) || [])
          : [];

        if (!decoded.error) {
          const region = {
            id:          String(d.id || ''),
            startTime:   d.startTime || 0,
            endTime:     (d.startTime || 0) + (decoded.breakDurationSecs ? +decoded.breakDurationSecs : 0),
            schemeIdUri: scheme,
            value:       d.value || '',
          };
          analyzer.addTimelineRegion(region);
          // If this looks like an ad-start cue (splice_insert with out_of_network)
          if (decoded.spliceCommandType === '0x5' && decoded.outOfNetwork) {
            analyzer.enterAdBreak({ region, scte35: decoded, descriptors, videoTime: video.currentTime });
          }
        }
      } catch {}
    }
  });

  // Wire video element events to the event log
  const videoEvents = {
    play:           () => analyzer.logEvent('video', 'play'),
    pause:          () => analyzer.logEvent('video', 'pause'),
    seeking:        () => analyzer.logEvent('video', 'seeking', `→ ${video.currentTime.toFixed(2)}s`),
    seeked:         () => analyzer.logEvent('video', 'seeked',  `@ ${video.currentTime.toFixed(2)}s`),
    waiting:        () => analyzer.logEvent('video', 'waiting'),
    stalled:        () => analyzer.logEvent('video', 'stalled'),
    canplay:        () => analyzer.logEvent('video', 'canplay'),
    canplaythrough: () => analyzer.logEvent('video', 'canplaythrough'),
    ended:          () => analyzer.logEvent('video', 'ended'),
    ratechange:     () => analyzer.logEvent('video', 'ratechange', `${video.playbackRate}×`),
    volumechange:   () => analyzer.logEvent('video', 'volumechange', video.muted?'muted':`${Math.round(video.volume*100)}%`),
    durationchange: () => { if(isFinite(video.duration)) analyzer.logEvent('video','durationchange',`${video.duration.toFixed(2)}s`); },
  };
  for(const [name,fn] of Object.entries(videoEvents)) video.addEventListener(name, fn);

  // Attach analyzer to player
  analyzer.attachToPlayer(player, video);
  analyzer.logEvent('info', 'player-init', 'Shaka Player initialized');

  setStatus('Shaka Player initialized');
}

// ── Load stream ───────────────────────────────────────────────────────────────
async function loadStream() {
  if (!player) initShaka();

  const url        = streamUrlEl.value.trim();
  const licenseUrl = licenseUrlEl.value.trim();
  const drmHeaders = collectDrmHeaders();
  const robustness = wvRobustEl.value;
  const codecPref  = buildCodecPreference();
  const bandwidth  = parseInt(document.getElementById('startBandwidth').value, 10) * 1000;

  if (!url) { showError('Please enter a stream URL.'); return; }

  errorOverlay.style.display   = 'none';
  idleOverlay.style.display    = 'none';
  spinnerOverlay.style.display = 'flex';
  setStatus('Loading…');
  setLoadingState(true);
  analyzer.reset();

  // Push DRM auth headers to the Electron main process BEFORE loading so they
  // are injected at the network-stack level (bypasses Chromium CORS stripping).
  await window.electronAPI.updateDrmConfig({ licenseUrl, headers: drmHeaders });

  try {
    await player.unload();

    const config = {
      streaming: {
        bufferingGoal: 30, rebufferingGoal: 5, bufferBehind: 30,
        retryParameters: { maxAttempts: 4, baseDelay: 1000, backoffFactor: 2, fuzzFactor: 0.5 },
      },
      manifest: {
        retryParameters: { maxAttempts: 3, baseDelay: 1000, backoffFactor: 2, fuzzFactor: 0.5 },
        hls: { ignoreManifestProgramDateTime: false, useFullSegmentsForStartTime: true },
      },
      preferredVideoCodecs: codecPref,
      abr: { enabled: true, defaultBandwidthEstimate: bandwidth },
    };

    if (licenseUrl) {
      config.drm = {
        servers: { 'com.widevine.alpha': licenseUrl },
        advanced: { 'com.widevine.alpha': { videoRobustness: robustness, audioRobustness: robustness } },
        retryParameters: { maxAttempts: 3, baseDelay: 1000, backoffFactor: 2, fuzzFactor: 0.5 },
      };
    }

    player.configure(config);

    // Register network filters:
    // 1. DRM / custom headers
    // 2. Analyzer capture (must come after so it sees the final request)
    const netEngine = player.getNetworkingEngine();
    netEngine.clearAllRequestFilters();
    netEngine.clearAllResponseFilters();

    if (licenseUrl) {
      netEngine.registerRequestFilter((type, request) => {
        if (type === shaka.net.NetworkingEngine.RequestType.LICENSE) {
          for (const [k, v] of Object.entries(drmHeaders)) request.headers[k] = v;
          const body = licenseBodyEl.value.trim();
          if (body) request.body = shaka.util.StringUtils.toUTF8(atob(body));
        }
      });
    }

    // Analyzer filters (capture all traffic)
    analyzer.registerFilters(netEngine);

    // Load
    await player.load(url);

    spinnerOverlay.style.display = 'none';
    setStatus('Loaded: ' + url.split('/').pop());

    video.volume = volumeBar.value / 100;
    video.play().catch(() => {});

    updateDurationDisplay();
    updateTrackSelectors();
    updateContainerStrip();

    const isLive = player.isLive();
    liveBadge.style.display = isLive ? 'flex' : 'none';
    seekBar.style.display   = isLive ? 'none' : 'block';

  } catch (err) {
    spinnerOverlay.style.display = 'none';
    showError(err.code ? formatShakaError(err) : (err.message || String(err)));
    setLoadingState(false);
  }
}

// ── Stop ──────────────────────────────────────────────────────────────────────
async function stopPlayback() {
  if (!player) return;
  await player.unload();
  video.pause();
  idleOverlay.style.display   = 'flex';
  errorOverlay.style.display  = 'none';
  spinnerOverlay.style.display = 'none';
  liveBadge.style.display     = 'none';
  clearTrackSelectors();
  setLoadingState(false);
  analyzer.reset();
  analyzer.resetCaptions();
  vttTrackStatus.style.display = 'none';
  document.getElementById('containerStrip').style.display = 'none';
  setStatus('Stopped');
}

function setLoadingState(loading) {
  loadBtn.disabled = loading;
  stopBtn.disabled = !loading;
}

// ── Track selectors ───────────────────────────────────────────────────────────
function updateTrackSelectors() {
  if (!player) return;

  // Video quality
  const tracks = player.getVariantTracks();
  qualitySelect.innerHTML = '<option value="-1">Auto</option>';
  tracks
    .filter((t, i, a) => a.findIndex(x => x.height === t.height && x.videoCodec === t.videoCodec) === i)
    .sort((a, b) => (b.height || 0) - (a.height || 0))
    .forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.height
        ? `${t.height}p${t.frameRate ? ` ${Math.round(t.frameRate)}fps` : ''} — ${t.videoCodec || ''}`
        : `${Math.round((t.bandwidth||0)/1000)} kbps`;
      opt.selected = t.active;
      qualitySelect.appendChild(opt);
    });

  // Audio
  const audioTracks = player.getAudioLanguagesAndRoles();
  audioSelect.innerHTML = audioTracks.length
    ? audioTracks.map(({language, role}) => `<option value="${language}">${language}${role ? ` [${role}]` : ''}</option>`).join('')
    : '<option>Default</option>';

  // Subtitles
  textSelect.innerHTML = '<option value="">Off</option>';
  player.getTextTracks().forEach(t => {
    const opt = document.createElement('option');
    opt.value    = t.id;
    opt.textContent = t.label || t.language || `Track ${t.id}`;
    opt.selected = t.active;
    textSelect.appendChild(opt);
  });
}

function clearTrackSelectors() {
  qualitySelect.innerHTML = '';
  audioSelect.innerHTML   = '';
  textSelect.innerHTML    = '';
}

// ── Time / seek ───────────────────────────────────────────────────────────────
function updateDurationDisplay() {
  currentTimeEl.textContent = formatTime(video.currentTime);
  const dur = video.duration;
  durationEl.textContent = isFinite(dur) ? formatTime(dur) : '∞';
  if (isFinite(dur) && dur > 0) seekBar.value = Math.floor((video.currentTime / dur) * 1000);
}

video.addEventListener('timeupdate',     () => { updateDurationDisplay(); updateBufferStats(); });
video.addEventListener('durationchange', updateDurationDisplay);
video.addEventListener('play',  () => { playPauseBtn.textContent = '⏸'; setStatus('Playing'); });
video.addEventListener('pause', () => { playPauseBtn.textContent = '▶'; setStatus('Paused'); });
video.addEventListener('ended', () => {
  playPauseBtn.textContent = '▶';
  idleOverlay.style.display = 'flex';
  setLoadingState(false);
  setStatus('Ended');
});
video.addEventListener('waiting', () => showSpinner(true));
video.addEventListener('canplay', () => showSpinner(false));

// ── Playback controls ─────────────────────────────────────────────────────────
playPauseBtn.addEventListener('click', () => video.paused ? video.play() : video.pause());

muteBtn.addEventListener('click', () => {
  video.muted = !video.muted;
  muteBtn.textContent = video.muted ? '🔇' : '🔊';
});

volumeBar.addEventListener('input', () => {
  video.volume = volumeBar.value / 100;
  video.muted  = false;
  muteBtn.textContent = '🔊';
});

seekBar.addEventListener('input', () => {
  if (video.duration) video.currentTime = (seekBar.value / 1000) * video.duration;
});

fullscreenBtn.addEventListener('click', () => {
  document.fullscreenElement ? document.exitFullscreen() : videoWrapper.requestFullscreen().catch(() => {});
});
document.addEventListener('fullscreenchange', () => {
  fullscreenBtn.textContent = document.fullscreenElement ? '⛶' : '⛶';
});

qualitySelect.addEventListener('change', () => {
  if (!player) return;
  const id = parseInt(qualitySelect.value, 10);
  if (id === -1) { player.configure({ abr: { enabled: true } }); return; }
  player.configure({ abr: { enabled: false } });
  const t = player.getVariantTracks().find(t => t.id === id);
  if (t) player.selectVariantTrack(t, true);
});

audioSelect.addEventListener('change', () => { if (player) player.selectAudioLanguage(audioSelect.value); });

textSelect.addEventListener('change', () => {
  if (!player) return;
  if (!textSelect.value) { player.setTextTrackVisibility(false); return; }
  const t = player.getTextTracks().find(t => t.id === parseInt(textSelect.value, 10));
  if (t) { player.selectTextTrack(t); player.setTextTrackVisibility(true); }
});

// Auto-hide controls
videoWrapper.addEventListener('mousemove', () => {
  videoWrapper.classList.add('controls-visible');
  clearTimeout(hideControlsTimer);
  hideControlsTimer = setTimeout(() => {
    if (!video.paused) videoWrapper.classList.remove('controls-visible');
  }, 3000);
});
videoWrapper.addEventListener('mouseleave', () => {
  if (!video.paused) videoWrapper.classList.remove('controls-visible');
});
video.addEventListener('pause', () => videoWrapper.classList.add('controls-visible'));

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName)) return;
  if (aboutBackdrop.style.display !== 'none') return;
  switch (e.code) {
    case 'Space':      e.preventDefault(); video.paused ? video.play() : video.pause(); break;
    case 'ArrowRight': e.preventDefault(); video.currentTime += 10; break;
    case 'ArrowLeft':  e.preventDefault(); video.currentTime -= 10; break;
    case 'ArrowUp':    e.preventDefault(); video.volume = Math.min(1, video.volume + 0.1); volumeBar.value = video.volume * 100; break;
    case 'ArrowDown':  e.preventDefault(); video.volume = Math.max(0, video.volume - 0.1); volumeBar.value = video.volume * 100; break;
    case 'KeyM': video.muted = !video.muted; muteBtn.textContent = video.muted ? '🔇' : '🔊'; break;
    case 'KeyF': fullscreenBtn.click(); break;
    case 'KeyA': analyzer.toggle(); break;
  }
});

// ── Config panel interactions ─────────────────────────────────────────────────
loadBtn.addEventListener('click', loadStream);
stopBtn.addEventListener('click', stopPlayback);

browseBtn.addEventListener('click', async () => {
  const fp = await window.electronAPI.showOpenDialog();
  if (fp) streamUrlEl.value = `file:///${fp.replace(/\\/g, '/')}`;
});

browseVttBtn.addEventListener('click', async () => {
  const fp = await window.electronAPI.showOpenVttDialog();
  if (!fp) return;
  const uri   = `file:///${fp.replace(/\\/g, '/')}`;
  const label = fp.split(/[\\/]/).pop();
  vttUrlEl.value = uri;
  if (player) {
    try { await player.addTextTrackAsync(uri, 'en', 'subtitles', 'text/vtt'); } catch {}
  }
  await loadAndParseVtt(uri, label);
});

loadVttBtn.addEventListener('click', async () => {
  const uri = vttUrlEl.value.trim();
  if (!uri) { showError('Enter a VTT URL or browse for a local file.'); return; }
  if (player) {
    try { await player.addTextTrackAsync(uri, 'en', 'subtitles', 'text/vtt'); } catch {}
  }
  await loadAndParseVtt(uri);
});

addHeaderBtn.addEventListener('click', () => addHeaderRow());

function addHeaderRow(key = '', val = '') {
  const row = document.createElement('div');
  row.className = 'header-entry';
  row.innerHTML = `<input class="input" type="text" placeholder="Header-Name" value="${key}" />
    <input class="input" type="text" placeholder="value" value="${val}" />
    <button class="btn--remove" title="Remove">×</button>`;
  row.querySelector('.btn--remove').addEventListener('click', () => row.remove());
  headersListEl.appendChild(row);
}

// ── Preset stream definitions ────────────────────────────────────────────────
const PRESETS = {
  __shaka_widevine__: {
    url:        'https://storage.googleapis.com/shaka-demo-assets/angel-one/dash.mpd',
    licenseUrl: 'https://cwip-shaka-proxy.appspot.com/no_auth',
    note:       'Shaka Widevine demo — license server pre-filled',
  },

  // ── SCTE-35 / Ad Marker streams ─────────────────────────────────────────
  __scte35_dashif__: {
    url:  'https://livesim.dashif.org/livesim/scte35_2/testpic_2s/Manifest.mpd',
    note: 'DASHIF SCTE-35 live sim — DASH EventStream with splice_insert events',
  },
  __scte35_dashif_3__: {
    url:  'https://livesim.dashif.org/livesim/scte35_3/testpic_2s/Manifest.mpd',
    note: 'DASHIF SCTE-35 v3 — splice_insert + time_signal + duration events',
  },
  __scte35_multiperiod__: {
    url:  'https://livesim.dashif.org/livesim/periods_60/testpic_2s/Manifest.mpd',
    note: 'DASHIF multi-period live — new Period every 60s (ad pod boundaries)',
  },
  __scte35_akamai_ssai__: {
    url:  'https://cph-p2p-msl.akamaized.net/hls/live/2000341/test/master.m3u8',
    note: 'Akamai live HLS — may contain EXT-X-CUE-OUT/CUE-IN splice markers',
  },
  __hls_daterange__: {
    url:  'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8',
    note: 'Apple BipBop TS — EXT-X-DATERANGE ad markers + EXT-X-PROGRAM-DATE-TIME',
  },

  // ── Discontinuity streams ────────────────────────────────────────────────
  __disc_bipbop_ts__: {
    url:  'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8',
    note: 'Apple BipBop Advanced (TS) — EXT-X-DISCONTINUITY between ad splices',
  },
  __disc_bipbop_hevc__: {
    url:  'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_hevc/master.m3u8',
    note: 'Apple BipBop Advanced (HEVC/CMAF) — HEVC + EXT-X-DISCONTINUITY',
  },
  __disc_akamai__: {
    url:  'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd',
    note: 'Akamai BBB — fetch manifest in Analyzer → Markers to inspect period/event boundaries',
  },
};

presetEl.addEventListener('change', () => {
  const val = presetEl.value;
  if (!val) return;

  const preset = PRESETS[val];
  if (preset) {
    streamUrlEl.value  = preset.url;
    licenseUrlEl.value = preset.licenseUrl || '';
    setStatus(preset.note);
  } else {
    streamUrlEl.value  = val;
    licenseUrlEl.value = '';
    setStatus('Preset loaded');
  }
  presetEl.value = '';
});

errorDismiss.addEventListener('click', () => {
  errorOverlay.style.display = 'none';
  idleOverlay.style.display  = 'flex';
});

// ── Test License Server ───────────────────────────────────────────────────────
testLicenseBtn.addEventListener('click', async () => {
  const url     = licenseUrlEl.value.trim();
  const headers = collectDrmHeaders();

  if (!url) {
    showLicenseTestResult('fail', '✗ Enter a License Server URL first');
    return;
  }

  showLicenseTestResult('testing', '⏳ Testing…');
  licenseTestDetail.style.display = 'none';
  testLicenseBtn.disabled = true;

  try {
    const res = await window.electronAPI.testLicenseServer(url, headers);

    if (res.error) {
      showLicenseTestResult('fail', `✗ Connection failed: ${res.error}`);
      licenseTestDetail.style.display = 'block';
      licenseTestDetail.textContent = res.error;
    } else {
      const s = res.status;
      // 400 = bad body but server accepted the connection + auth ✓
      // 200/204 = server accepted with empty body (unusual)
      // 401/403 = auth failure
      // 5xx = server error
      if (s === 200 || s === 204 || s === 400 || s === 415) {
        showLicenseTestResult('ok', `✓ HTTP ${s} — License server reachable, auth headers accepted`);
      } else if (s === 401) {
        showLicenseTestResult('fail', `✗ HTTP 401 — Unauthorized: check your Authorization header`);
      } else if (s === 403) {
        showLicenseTestResult('fail', `✗ HTTP 403 — Forbidden: token may be expired or wrong`);
      } else if (s >= 500) {
        showLicenseTestResult('warn', `⚠ HTTP ${s} — Server error (auth may be OK)`);
      } else {
        showLicenseTestResult('warn', `⚠ HTTP ${s}`);
      }

      // Show response detail
      const detail = [
        `Status : ${s}`,
        `Headers: ${JSON.stringify(res.headers || {}, null, 2)}`,
        res.body ? `Body   : ${res.body.substring(0, 200)}` : '',
      ].filter(Boolean).join('\n');
      licenseTestDetail.style.display = 'block';
      licenseTestDetail.textContent = detail;
    }
  } catch (err) {
    showLicenseTestResult('fail', `✗ ${err.message || err}`);
  } finally {
    testLicenseBtn.disabled = false;
  }
});

function showLicenseTestResult(cls, text) {
  licenseTestResult.className = `license-test-badge ${cls}`;
  licenseTestResult.textContent = text;
}

// ── Collapsible config sections ───────────────────────────────────────────────
function setupCollapsible(toggle, body) {
  toggle.addEventListener('click', () => {
    const collapsed = body.style.display === 'none';
    body.style.display = collapsed ? '' : 'none';
    toggle.classList.toggle('collapsed', !collapsed);
  });
}
setupCollapsible(drmToggle, drmBody);
setupCollapsible(codecToggle, codecBody);
setupCollapsible(captionsToggle, captionsBody);

// ── Custom window controls ────────────────────────────────────────────────────
const wcMin   = document.getElementById('wcMin');
const wcMax   = document.getElementById('wcMax');
const wcClose = document.getElementById('wcClose');

wcMin.addEventListener('click',   () => window.electronAPI.windowMinimize());
wcClose.addEventListener('click', () => window.electronAPI.windowClose());

wcMax.addEventListener('click', async () => {
  window.electronAPI.windowMaximize();
  // Icon toggles after a tick (maximize is async)
  setTimeout(syncMaxIcon, 80);
});

async function syncMaxIcon() {
  const isMax = await window.electronAPI.windowIsMaximized();
  // &#xE923; = restore, &#xE922; = maximize (Segoe MDL2)
  wcMax.innerHTML = isMax ? '&#xE923;' : '&#xE922;';
  wcMax.title     = isMax ? 'Restore' : 'Maximize';
}

// Keep icon in sync when maximized by dragging to screen edge etc.
window.addEventListener('resize', syncMaxIcon);

// ── About modal ───────────────────────────────────────────────────────────────
aboutBtn.addEventListener('click', () => { aboutBackdrop.style.display = 'flex'; });
aboutClose.addEventListener('click', () => { aboutBackdrop.style.display = 'none'; });
aboutBackdrop.addEventListener('click', e => { if (e.target === aboutBackdrop) aboutBackdrop.style.display = 'none'; });
aboutEmail.addEventListener('click', () => window.electronAPI.openUrl('mailto:gauraw2004amit@gmail.com'));
document.addEventListener('keydown', e => {
  if (e.code === 'Escape' && aboutBackdrop.style.display !== 'none') aboutBackdrop.style.display = 'none';
});

// ── Init ──────────────────────────────────────────────────────────────────────
(async function init() {
  await Promise.all([checkWidevine(), checkHEVC()]);
  initShaka();
  setStatus('Ready — enter a stream URL and press Load & Play');
})();
