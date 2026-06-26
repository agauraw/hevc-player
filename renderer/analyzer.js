'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const REQ_LABELS = { 0:'manifest', 1:'segment', 2:'license', 3:'app', 4:'timing', 5:'cert', 6:'key', 7:'ads' };
const REQ_COLORS = {
  manifest:'#6c63ff', segment:'#4ecca3', license:'#e05252',
  key:'#ffa033', timing:'#7a7a9a', cert:'#ff77aa', app:'#88aaff', ads:'#ccaa33',
};
const EVT_COLORS = {
  player:'#6c63ff', video:'#4ecca3', drm:'#e05252', network:'#ffa033', abr:'#88aaff', info:'#7a7a9a',
};
const HISTORY_LEN = 120;

// HLS tag catalogue — name → { cat, desc }
const HLS_TAG_DEFS = {
  'EXTM3U':                     { cat:'Basic',          desc:'Required M3U header — identifies this as an HLS playlist' },
  'EXT-X-VERSION':              { cat:'Basic',          desc:'HLS protocol version (latest is 12)' },
  'EXT-X-INDEPENDENT-SEGMENTS': { cat:'Basic',          desc:'Every segment can be decoded independently of others' },
  'EXT-X-START':                { cat:'Basic',          desc:'Preferred playback start position (TIME-OFFSET attribute)' },
  'EXT-X-DEFINE':               { cat:'Basic',          desc:'Variable definition — value substituted via {$VAR} syntax' },
  'EXT-X-TARGETDURATION':       { cat:'Media Playlist', desc:'Maximum segment duration in seconds (must be integer)' },
  'EXT-X-MEDIA-SEQUENCE':       { cat:'Media Playlist', desc:'Sequence number of the first segment in the playlist' },
  'EXT-X-DISCONTINUITY-SEQUENCE':{ cat:'Media Playlist',desc:'Synchronizes discontinuity counters across renditions' },
  'EXT-X-ENDLIST':              { cat:'Media Playlist', desc:'No more segments will be appended — stream is VOD or event ended' },
  'EXT-X-PLAYLIST-TYPE':        { cat:'Media Playlist', desc:'VOD (immutable list) or EVENT (segments only appended)' },
  'EXT-X-I-FRAMES-ONLY':        { cat:'Media Playlist', desc:'Playlist contains only I-frames for trick-play (fast fwd/rwd)' },
  'EXT-X-ALLOW-CACHE':          { cat:'Media Playlist', desc:'(Removed in v7) Whether clients may cache downloaded segments' },
  'EXTINF':                     { cat:'Segment',        desc:'Duration of the following segment (seconds) and optional title' },
  'EXT-X-BYTERANGE':            { cat:'Segment',        desc:'Partial HTTP byte-range of the following segment URI' },
  'EXT-X-DISCONTINUITY':        { cat:'Segment',        desc:'Encoding discontinuity between preceding and following segment' },
  'EXT-X-KEY':                  { cat:'Segment / DRM',  desc:'Encryption method and key URI (AES-128, SAMPLE-AES, NONE)' },
  'EXT-X-MAP':                  { cat:'Segment',        desc:'Initialization data (fMP4 init segment or TS PAT/PMT)' },
  'EXT-X-PROGRAM-DATE-TIME':    { cat:'Segment',        desc:'Absolute ISO-8601 date/time of the first sample of the next segment' },
  'EXT-X-GAP':                  { cat:'Segment',        desc:'Marks that the following segment is unavailable (gap in stream)' },
  'EXT-X-BITRATE':              { cat:'Segment',        desc:'Approximate bitrate of the following segments (kbps)' },
  'EXT-X-PART':                 { cat:'Low Latency',    desc:'Low-latency partial segment (LHLS)' },
  'EXT-X-PART-INF':             { cat:'Low Latency',    desc:'Maximum partial segment duration (PART-TARGET)' },
  'EXT-X-SERVER-CONTROL':       { cat:'Low Latency',    desc:'Server push and delta update parameters (CAN-SKIP-UNTIL, etc.)' },
  'EXT-X-SKIP':                 { cat:'Low Latency',    desc:'Delta playlist update — segments skipped since last full playlist' },
  'EXT-X-PRELOAD-HINT':         { cat:'Low Latency',    desc:'Preload hint for the next partial segment or map' },
  'EXT-X-RENDITION-REPORT':     { cat:'Low Latency',    desc:'Current state of another rendition\'s playlist' },
  'EXT-X-DATERANGE':            { cat:'Metadata',       desc:'Timed metadata range (ads, chapters, SCTE-35 cues)' },
  'EXT-X-MEDIA':                { cat:'Master Playlist',desc:'Alternate rendition — audio track, subtitle, or closed-caption group' },
  'EXT-X-STREAM-INF':           { cat:'Master Playlist',desc:'Variant stream — BANDWIDTH, CODECS, RESOLUTION, FRAME-RATE' },
  'EXT-X-I-FRAME-STREAM-INF':   { cat:'Master Playlist',desc:'I-frame only variant stream for trick play' },
  'EXT-X-SESSION-DATA':         { cat:'Master Playlist',desc:'Arbitrary session-level key/value metadata' },
  'EXT-X-SESSION-KEY':          { cat:'Master Playlist',desc:'Session-level DRM key (pre-loads decryption for renditions)' },
  'EXT-X-CONTENT-STEERING':     { cat:'Master Playlist',desc:'Content steering manifest URI for CDN/server selection' },
  // Common ad-marker extensions (not in RFC 8216 but widely deployed)
  'EXT-X-CUE-OUT':              { cat:'Ad Markers',     desc:'Splice-out start — duration attribute marks ad pod length' },
  'EXT-X-CUE-IN':               { cat:'Ad Markers',     desc:'Splice-in end — returns to network content' },
  'EXT-X-CUE-OUT-CONT':         { cat:'Ad Markers',     desc:'Out-of-network continuation marker (ElapsedTime / Duration)' },
  'EXT-X-CUE':                  { cat:'Ad Markers',     desc:'Generic cue marker (various formats used by different CDNs)' },
  'EXT-X-SCTE35':               { cat:'Ad Markers',     desc:'Inline SCTE-35 splice info (base64-encoded binary)' },
  'EXT-X-OATCLS-SCTE35':        { cat:'Ad Markers',     desc:'OATCLS variant of SCTE-35 (common Akamai / MediaTailor format)' },
  'EXT-X-ASSET':                { cat:'Ad Markers',     desc:'Ad decision server asset metadata' },
  'EXT-X-AD-RESTRICTIONS':      { cat:'Ad Markers',     desc:'Ad restriction flags (blackout, ratings, etc.)' },
  'EXT-X-MARKER':               { cat:'Ad Markers',     desc:'Generic ad splice marker' },
};

const HLS_CAT_ORDER = [
  'Basic','Master Playlist','Media Playlist','Segment','Segment / DRM','Low Latency','Metadata','Ad Markers','Custom',
];

function esc(s) {
  return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtTime(s) {
  if (!isFinite(s)||s<0) return '∞';
  const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), sec=Math.floor(s%60);
  return h>0?`${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`:`${m}:${String(sec).padStart(2,'0')}`;
}

// ── StreamAnalyzer ────────────────────────────────────────────────────────────
class StreamAnalyzer {
  constructor() {
    this._player = null;
    this._video  = null;
    // Network log
    this._netLog  = [];
    this._reqMap  = new Map();
    this._seqId   = 0;
    this.MAX_LOG  = 500;
    // History charts
    this._brHist  = new Array(HISTORY_LEN).fill(null);
    this._bufHist = new Array(HISTORY_LEN).fill(null);
    this._drHist  = new Array(HISTORY_LEN).fill(0);
    this._latHist = new Array(HISTORY_LEN).fill(null);
    this._tick    = 0;
    this._prevDrop = 0;
    // Event log
    this._eventLog = [];
    this.MAX_EVENTS = 500;
    // Ad markers + timeline regions
    this._adMarkers      = [];   // { type, time, duration, label, scte35, raw }
    this._timelineRegions = [];  // from Shaka player.addEventListener('timelineregionadded')
    // Ad break monitor
    this._adBreakState   = null; // active break (null = no break)
    this._adBreakLog     = [];   // completed + ongoing breaks
    this._adBreakNum     = 0;    // running count for the session
    this._adBreakTimer   = null;
    // Buffer timeline
    this._bufTimerFrame = null;
    // Captions / VTT state
    this._vttTracks    = [];   // { id, label, language, kind, cues[] }
    this._activeVttIdx = 0;
    this._activeCueRow = null;
    // State
    this._visible   = false;
    this._activeTab = 'overview';
    this._statsTimer = null;
    // Child manifest state
    this._masterManifest      = null; // { url, text, isHLS }
    this._childManifests      = [];   // [{ url, label, type, text, error, codecs }]
    this._selectedManifestIdx = -1;   // -1 = master
    this._viewAllActive       = false;
    this._tagsViewActive      = false;
    this._multiPlayers        = [];   // [{ sp, videoEl, cell, analyserL, analyserR, vuCanvas }]
    this._mpMuted             = true;
    this._mpAudioCtx          = null;
    this._mpAudioAnimFrame    = null;
    // Audio dB analyser
    this._audioCtx       = null;
    this._audioSource    = null;
    this._analyserL      = null;
    this._analyserR      = null;
    this._analyserFreq   = null;
    this._audioPeakHoldL = -Infinity;
    this._audioPeakHoldR = -Infinity;
    this._audioPeakTimeL = 0;
    this._audioPeakTimeR = 0;
    this._audioClipL     = false;
    this._audioClipR     = false;
    this._audioClipTimeL = 0;
    this._audioClipTimeR = 0;
    this._audioAnimFrame = null;

    this._bindUI();
  }

  // ── UI binding ────────────────────────────────────────────────────────────
  _bindUI() {
    this._panel     = document.getElementById('analyzerPanel');
    this._toggleBtn = document.getElementById('analyzeBtn');
    this._closeBtn  = document.getElementById('analyzerClose');
    this._tabBtns   = document.querySelectorAll('.az-tab');
    this._views = {
      overview: document.getElementById('azOverview'),
      manifest: document.getElementById('azManifest'),
      tracks:   document.getElementById('azTracks'),
      network:  document.getElementById('azNetwork'),
      buffer:   document.getElementById('azBuffer'),
      events:   document.getElementById('azEvents'),
      markers:  document.getElementById('azMarkers'),
      charts:   document.getElementById('azCharts'),
      audio:    document.getElementById('azAudio'),
      captions: document.getElementById('azCaptions'),
    };
    this._charts = {
      bitrate: document.getElementById('chartBitrate'),
      buffer:  document.getElementById('chartBuffer'),
      dropped: document.getElementById('chartDropped'),
      latency: document.getElementById('chartLatency'),
    };
    this._bufCanvas     = document.getElementById('bufTimeline');
    this._audioCanvas   = document.getElementById('audioMeterCanvas');
    this._specCanvas    = document.getElementById('audioSpecCanvas');
    this._playerVuEl    = document.getElementById('playerVu');
    this._playerVuCanvas = document.getElementById('playerVuCanvas');

    this._tabBtns.forEach(b => b.addEventListener('click', () => this._switchTab(b.dataset.tab)));
    this._toggleBtn.addEventListener('click', () => this.toggle());
    this._closeBtn.addEventListener('click',  () => this.close());

    document.getElementById('azClearLog').addEventListener('click', () => { this._netLog=[]; this._renderNetworkLog(); });
    document.getElementById('azNetFilter').addEventListener('change', () => this._renderNetworkLog());
    document.getElementById('azFetchManifest').addEventListener('click', () => this._fetchManifest());
    document.getElementById('azFetchChildren')?.addEventListener('click', () => this._fetchAllChildren());
    document.getElementById('azManifestSelector')?.addEventListener('change', e => {
      this._showSelectedManifest(parseInt(e.target.value, 10));
    });
    document.getElementById('azViewAll')?.addEventListener('click', () => this._toggleViewAll());
    document.getElementById('azPlayAll')?.addEventListener('click', () => this._openPlayAll());
    document.getElementById('azTagsBtn')?.addEventListener('click', () => this._toggleTagsView());
    document.getElementById('azMismatchBtn')?.addEventListener('click', () => {
      const p = document.getElementById('azMismatchPanel');
      if (p) p.style.display = p.style.display === 'none' ? '' : 'none';
    });
    document.getElementById('azMismatchDismiss')?.addEventListener('click', () => {
      const p = document.getElementById('azMismatchPanel');
      if (p) p.style.display = 'none';
    });
    document.getElementById('azMpPlay')?.addEventListener('click',  () => this._mpPlayAll());
    document.getElementById('azMpPause')?.addEventListener('click', () => this._mpPauseAll());
    document.getElementById('azMpMute')?.addEventListener('click',  () => this._mpToggleMute());
    document.getElementById('azMpSync')?.addEventListener('click',  () => this._mpSyncAll());
    document.getElementById('azMpClose')?.addEventListener('click', () => this._closePlayAll());
    document.getElementById('azClearEvents').addEventListener('click', () => { this._eventLog=[]; this._renderEventLog(); });
    document.getElementById('azEvtFilter').addEventListener('change', () => this._renderEventLog());
    document.getElementById('azMarkerFilter').addEventListener('change', () => this._renderMarkers());
    document.getElementById('ccTrackSelect').addEventListener('change', e => {
      this._activeVttIdx = parseInt(e.target.value, 10) || 0;
      this._renderCaptionsTab();
    });

    // Click-to-seek on buffer timeline
    this._bufCanvas?.addEventListener('click', e => this._seekFromTimeline(e));

    document.getElementById('auResetPeak')?.addEventListener('click', () => {
      this._audioPeakHoldL = -Infinity;
      this._audioPeakHoldR = -Infinity;
      this._audioClipL = false;
      this._audioClipR = false;
    });

    this._initResize();
  }

  _initResize() {
    const handle = document.getElementById('analyzerResizeHandle');
    let startY, startH;
    handle.addEventListener('mousedown', e => {
      startY = e.clientY; startH = this._panel.offsetHeight;
      const onMove = e2 => {
        const newH = Math.max(200, Math.min(window.innerHeight*0.8, startH+(startY-e2.clientY)));
        this._panel.style.height = newH+'px';
        if (this._activeTab==='charts') this._drawCharts();
        if (this._activeTab==='buffer') this._drawBufferTimeline();
      };
      const onUp = () => { document.removeEventListener('mousemove',onMove); document.removeEventListener('mouseup',onUp); };
      document.addEventListener('mousemove',onMove); document.addEventListener('mouseup',onUp);
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  open() {
    this._visible=true; this._panel.style.display='flex';
    this._toggleBtn.classList.add('az-active');
    this._switchTab(this._activeTab);
    this._startBufAnimation();
    this._startAudioAnimation();
  }
  close() {
    this._visible=false; this._panel.style.display='none';
    this._toggleBtn.classList.remove('az-active');
    this._stopBufAnimation();
    this._stopAudioAnimation();
  }
  toggle() { this._visible?this.close():this.open(); }

  // ── Timeline regions (from Shaka events) ────────────────────────────────
  addTimelineRegion(region) {
    // region: { startTime, endTime, id, schemeIdUri, value, eventElement }
    const existing = this._timelineRegions.find(r => r.id === region.id && r.startTime === region.startTime);
    if (existing) return;
    this._timelineRegions.push(region);
    // Also add to adMarkers for the Markers tab
    const isScte35 = /scte35|splice/i.test(region.schemeIdUri || '');
    this._adMarkers.push({
      type:     isScte35 ? 'scte35' : 'event',
      time:     region.startTime,
      duration: (region.endTime || region.startTime) - region.startTime,
      label:    `Timeline Region: ${region.schemeIdUri || ''}${region.id ? ` [${region.id}]` : ''}`,
      raw:      JSON.stringify({ scheme: region.schemeIdUri, id: region.id, value: region.value }),
      source:   'shaka',
    });
    this._adMarkers.sort((a, b) => a.time - b.time);
    if (this._visible && this._activeTab === 'markers') this._renderMarkers();
  }

  // ── Ad Break Monitor ──────────────────────────────────────────────────────
  enterAdBreak(opts = {}) {
    // opts: { region, scte35, descriptors, videoTime }
    this._adBreakNum++;
    const state = {
      breakNum:          this._adBreakNum,
      startVideoTime:    opts.videoTime ?? (this._video?.currentTime ?? 0),
      startWallMs:       Date.now(),
      scheduledDuration: null,
      slots:             [],           // per-slot data from avail_num / avails_expected
      currentSlotNum:    null,
      trackingUrls:      [],
      upid:              null,
      segmentationTypeId: null,
      programId:         null,
      schemeIdUri:       opts.region?.schemeIdUri || null,
      completed:         false,
      actualDurationSecs: null,
    };

    // Extract details from SCTE-35
    const s35 = opts.scte35;
    if (s35 && !s35.error) {
      if (s35.breakDurationSecs) state.scheduledDuration = +s35.breakDurationSecs;
      if (s35.availNum != null)  { state.currentSlotNum = s35.availNum; }
      if (s35.availsExpected)    {
        // Pre-populate slot array
        for (let i = 1; i <= s35.availsExpected; i++) {
          state.slots.push({ num: i, expected: s35.availsExpected, startWallMs: null, durationMs: null, status: 'pending', trackingUrls: [] });
        }
        if (s35.availNum) state.slots[s35.availNum - 1].startWallMs = Date.now();
      }
    }

    // Extract from descriptors
    const descs = opts.descriptors || [];
    for (const d of descs) {
      if (d.name === 'segmentation_descriptor') {
        if (d.durationSecs && !state.scheduledDuration) state.scheduledDuration = +d.durationSecs;
        if (d.trackingUrl)  state.trackingUrls.push({ url: d.trackingUrl, source: 'upid', type: d.upidTypeName });
        if (d.upid && !d.upidIsUrl) state.upid = d.upid;
        if (d.segmentationTypeName) state.segmentationTypeId = d.segmentationTypeName;
        if (d.segmentNum && d.segmentsExpected) {
          state.currentSlotNum = d.segmentNum;
          if (!state.slots.length) {
            for (let i = 1; i <= d.segmentsExpected; i++) {
              state.slots.push({ num: i, expected: d.segmentsExpected, startWallMs: null, durationMs: null, status: 'pending', trackingUrls: [] });
            }
          }
          if (state.slots[d.segmentNum - 1]) state.slots[d.segmentNum - 1].startWallMs = Date.now();
        }
      }
      if (d.name === 'avail_descriptor') state.programId = d.providerAvailId;
    }

    this._adBreakState = state;
    this._adBreakLog.unshift(state);
    if (this._adBreakLog.length > 50) this._adBreakLog.length = 50;

    this._startAdBreakTimer();
    if (this._visible && this._activeTab === 'markers') this._renderAdMonitor();
    this.logEvent('drm', 'ad-break-enter', `Break #${state.breakNum}${state.scheduledDuration ? `, ${state.scheduledDuration}s` : ''}${state.trackingUrls.length ? `, ${state.trackingUrls.length} tracking URL(s)` : ''}`);
  }

  exitAdBreak(opts = {}) {
    if (!this._adBreakState) return;
    const state = this._adBreakState;
    state.completed = true;
    state.actualDurationSecs = ((Date.now() - state.startWallMs) / 1000).toFixed(1);

    // Mark all pending slots as done
    state.slots.forEach(s => { if (s.status === 'pending' || s.status === 'active') s.status = 'done'; });

    this._stopAdBreakTimer();
    this._adBreakState = null;
    if (this._visible && this._activeTab === 'markers') this._renderAdMonitor();
    this.logEvent('drm', 'ad-break-exit', `Break #${state.breakNum} ended, actual=${state.actualDurationSecs}s`);
  }

  _startAdBreakTimer() {
    this._stopAdBreakTimer();
    this._adBreakTimer = setInterval(() => {
      if (this._visible && this._activeTab === 'markers') this._renderAdMonitor();
    }, 500);
  }
  _stopAdBreakTimer() {
    if (this._adBreakTimer) { clearInterval(this._adBreakTimer); this._adBreakTimer = null; }
  }

  reset() {
    this._netLog=[]; this._eventLog=[];
    this._adMarkers=[]; this._timelineRegions=[];
    this._adBreakState=null; this._adBreakLog=[]; this._adBreakNum=0;
    this._stopAdBreakTimer();
    this._brHist.fill(null); this._bufHist.fill(null); this._drHist.fill(0); this._latHist.fill(null);
    this._tick=0; this._prevDrop=0; this._seqId=0; this._reqMap.clear();
    this._masterManifest=null; this._childManifests=[]; this._selectedManifestIdx=-1;
    this._viewAllActive=false;
    this._closePlayAll();
    const _cb=document.getElementById('azFetchChildren');
    const _cs=document.getElementById('azManifestSelector');
    const _ct=document.getElementById('azChildStatus');
    const _va=document.getElementById('azViewAll');
    const _pa=document.getElementById('azPlayAll');
    const _tree=document.getElementById('azManifestTree');
    const _raw=document.getElementById('azManifestContent');
    const _grid=document.getElementById('azManifestGrid');
    if(_cb){_cb.style.display='none';_cb.disabled=false;_cb.textContent='⬇ All Children';}
    if(_cs) _cs.style.display='none';
    if(_ct) _ct.style.display='none';
    if(_va){_va.disabled=true;_va.textContent='⊞ View All';_va.title='Fetch children first';}
    if(_pa){_pa.disabled=true;_pa.title='Fetch children first';}
    const _tb=document.getElementById('azTagsBtn');
    const _tv=document.getElementById('azTagsView');
    if(_tb){_tb.disabled=true;_tb.textContent='🏷 Tags';_tb.title='Fetch a manifest first';}
    if(_tv){_tv.style.display='none';_tv.innerHTML='';}
    this._tagsViewActive=false;
    const _mb=document.getElementById('azMismatchBtn');
    const _mp=document.getElementById('azMismatchPanel');
    if(_mb) _mb.style.display='none';
    if(_mp){ _mp.style.display='none'; const b=document.getElementById('azMismatchBody'); if(b) b.innerHTML=''; }
    if(_tree) _tree.style.display='';
    if(_raw)  _raw.style.display='';
    if(_grid){_grid.style.display='none';_grid.innerHTML='';}
    this._audioPeakHoldL = -Infinity; this._audioPeakHoldR = -Infinity;
    this._audioClipL = false; this._audioClipR = false;
    this._renderNetworkLog(); this._renderEventLog(); this._clearOverview();
    document.getElementById('azManifestContent').textContent='— load a stream to fetch the manifest —';
    document.getElementById('azManifestTree').innerHTML='';
    ['az-vtracks','az-atracks','az-ttracks'].forEach(id => {
      const el=document.getElementById(id);
      if(el) el.innerHTML='<tr><td colspan="6" class="az-empty">No tracks loaded</td></tr>';
    });
    this._renderMarkers();
  }

  // ── Event logging (called from player.js) ────────────────────────────────
  logEvent(category, name, detail='') {
    const ts=Date.now();
    if (name === 'texttrackadded') this._renderTracks(); // Refresh tracks view // This was already present
    const d=new Date(ts);
    const stamp=`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(d.getMilliseconds()).padStart(3,'0')}`;
    this._eventLog.unshift({ ts, stamp, category, name, detail:String(detail||'').substring(0,300) });
    if(this._eventLog.length>this.MAX_EVENTS) this._eventLog.length=this.MAX_EVENTS;
    if(this._visible && this._activeTab==='events') this._renderEventLog();
  }

  // ── Network filters ───────────────────────────────────────────────────────
  registerFilters(netEngine) {
    const self=this;
    netEngine.registerRequestFilter((type,req) => {
      const url=Array.isArray(req.uris)?req.uris[0]:String(req.uris||'');
      const key=`${type}|${url}`;
      self._reqMap.set(key,{ts:Date.now(),type:REQ_LABELS[type]||'unknown',url});
    });
    netEngine.registerResponseFilter((type,resp) => {
      const url=resp.uri||resp.originalUri||'';
      const key=`${type}|${url}`;
      const info=self._reqMap.get(key)||{ts:Date.now()-(resp.timeMs||0),type:REQ_LABELS[type]||'unknown',url};
      self._reqMap.delete(key);
      const size=resp.data?resp.data.byteLength:0;
      const dur=resp.timeMs!=null?Math.round(resp.timeMs):Math.max(0,Date.now()-info.ts);
      self._netLog.unshift({ts:info.ts,type:info.type,url,status:resp.status||200,size,duration:dur});
      if(self._netLog.length>self.MAX_LOG) self._netLog.length=self.MAX_LOG;
      if(self._visible && self._activeTab==='network') self._renderNetworkLog();
    });
  }

  // ── Attach/detach ─────────────────────────────────────────────────────────
  attachToPlayer(player, video) {
    this._player=player; this._video=video;
    this._startPolling();
    if(this._visible) this._startBufAnimation();
    // Auto-setup audio so player VU works without opening the Audio tab
    this._setupAudioContext();
    if (this._playerVuEl) this._playerVuEl.style.display = 'block';
    // Resume context once playback starts
    this._video.addEventListener('play', () => {
      if (this._audioCtx?.state === 'suspended') this._audioCtx.resume().catch(() => {});
    });
  }
  detachFromPlayer() {
    this._stopPolling(); this._stopBufAnimation();
    if (this._playerVuEl) this._playerVuEl.style.display = 'none';
    this._player=null; this._video=null;
  }

  _startPolling() { this._stopPolling(); this._statsTimer=setInterval(()=>this._poll(),1000); }
  _stopPolling()  { if(this._statsTimer){clearInterval(this._statsTimer);this._statsTimer=null;} }

  _startBufAnimation() {
    this._stopBufAnimation();
    const draw=()=>{
      if(this._visible && this._activeTab==='buffer') this._drawBufferTimeline();
      this._bufTimerFrame=requestAnimationFrame(draw);
    };
    this._bufTimerFrame=requestAnimationFrame(draw);
  }
  _stopBufAnimation() {
    if(this._bufTimerFrame){cancelAnimationFrame(this._bufTimerFrame);this._bufTimerFrame=null;}
  }

  // ── Audio dB Analyser ─────────────────────────────────────────────────────
  _startAudioAnimation() {
    this._stopAudioAnimation();
    const draw = () => {
      if (this._analyserL) this._drawPlayerVuMeter();
      if (this._visible && this._activeTab === 'audio') this._drawAudio();
      this._audioAnimFrame = requestAnimationFrame(draw);
    };
    this._audioAnimFrame = requestAnimationFrame(draw);
  }
  _stopAudioAnimation() {
    if (this._audioAnimFrame) { cancelAnimationFrame(this._audioAnimFrame); this._audioAnimFrame = null; }
  }

  _setupAudioContext() {
    if (!this._video) return;
    if (this._audioCtx) {
      if (this._audioCtx.state === 'suspended') this._audioCtx.resume().catch(() => {});
      return;
    }
    try {
      this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      this._audioSource = this._audioCtx.createMediaElementSource(this._video);
      // Re-route to destination so audio keeps playing
      this._audioSource.connect(this._audioCtx.destination);

      // Frequency spectrum analyser (merged stereo)
      this._analyserFreq = this._audioCtx.createAnalyser();
      this._analyserFreq.fftSize = 2048;
      this._analyserFreq.smoothingTimeConstant = 0.8;
      this._analyserFreq.minDecibels = -100;
      this._analyserFreq.maxDecibels = 0;
      this._audioSource.connect(this._analyserFreq);

      // L/R level analysers via channel splitter
      const splitter = this._audioCtx.createChannelSplitter(2);
      this._analyserL = this._audioCtx.createAnalyser();
      this._analyserR = this._audioCtx.createAnalyser();
      this._analyserL.fftSize = 2048;
      this._analyserR.fftSize = 2048;
      this._audioSource.connect(splitter);
      splitter.connect(this._analyserL, 0);
      splitter.connect(this._analyserR, 1);
    } catch {
      this._audioCtx = null;
    }
  }

  _drawAudio() {
    this._drawAudioMeter();
    this._drawAudioWaveform();
  }

  _drawAudioMeter() {
    const canvas = this._audioCanvas;
    if (!canvas) return;
    if (this._audioCtx?.state === 'suspended') this._audioCtx.resume().catch(() => {});

    const dpr  = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    canvas.width  = Math.round(rect.width  * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const W = rect.width, H = rect.height;

    ctx.fillStyle = '#080810';
    ctx.fillRect(0, 0, W, H);

    if (!this._analyserL) {
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Load a stream', W / 2, H / 2 - 6);
      ctx.fillText('to start meter', W / 2, H / 2 + 8);
      return;
    }

    // Layout
    const DB_MIN = -60, DB_MAX = 0;
    const LBL_W  = 26, MT = 12, MB = 4, MR = 3, GAP = 3;
    const barH   = H - MT - MB;
    const barsW  = W - LBL_W - MR;
    const barW   = Math.max(4, (barsW - GAP) / 2);
    const lX     = LBL_W;
    const rX     = lX + barW + GAP;
    const dbFrac = db => (Math.max(DB_MIN, Math.min(DB_MAX, db)) - DB_MIN) / (DB_MAX - DB_MIN);

    // Read audio data
    const bufLen = this._analyserL.frequencyBinCount;
    const dataL  = new Float32Array(bufLen);
    const dataR  = this._analyserR ? new Float32Array(bufLen) : null;
    this._analyserL.getFloatTimeDomainData(dataL);
    if (dataR) this._analyserR.getFloatTimeDomainData(dataR);

    const rmsOf  = d => { let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i]; return Math.sqrt(s / d.length); };
    const peakOf = d => { let m = 0; for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > m) m = v; } return m; };
    const toDb   = v => v > 1e-9 ? 20 * Math.log10(v) : -Infinity;

    const rmsL   = rmsOf(dataL),  peakL = peakOf(dataL);
    const rmsR   = dataR ? rmsOf(dataR)  : rmsL;
    const peakR  = dataR ? peakOf(dataR) : peakL;
    const rmsDbL = toDb(rmsL),  pDbL = toDb(peakL);
    const rmsDbR = toDb(rmsR),  pDbR = toDb(peakR);

    // Peak hold + clip
    const now = performance.now();
    const upHold = (db, hold, t) => {
      if (db > hold || !isFinite(hold)) return { hold: db, t: now };
      if (now - t > 2000) return { hold: hold - 0.4, t };
      return { hold, t };
    };
    const resL = upHold(pDbL, this._audioPeakHoldL, this._audioPeakTimeL);
    this._audioPeakHoldL = resL.hold; this._audioPeakTimeL = resL.t;
    const resR = upHold(pDbR, this._audioPeakHoldR, this._audioPeakTimeR);
    this._audioPeakHoldR = resR.hold; this._audioPeakTimeR = resR.t;

    if (peakL >= 0.999) { this._audioClipL = true; this._audioClipTimeL = now; }
    else if (now - this._audioClipTimeL > 1500) this._audioClipL = false;
    if (peakR >= 0.999) { this._audioClipR = true; this._audioClipTimeR = now; }
    else if (now - this._audioClipTimeR > 1500) this._audioClipR = false;

    // Update readout elements
    const setEl = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    const fmtDb = db => isFinite(db) ? db.toFixed(1) + ' dB' : '—';
    setEl('au-rms-l',  fmtDb(rmsDbL));
    setEl('au-rms-r',  fmtDb(rmsDbR));
    setEl('au-peak-l', fmtDb(this._audioPeakHoldL));
    setEl('au-peak-r', fmtDb(this._audioPeakHoldR));
    document.getElementById('au-clip-l')?.classList.toggle('au-clip--on', this._audioClipL);
    document.getElementById('au-clip-r')?.classList.toggle('au-clip--on', this._audioClipR);

    // dB scale grid lines + labels
    ctx.font = '7.5px Courier New, monospace';
    ctx.textAlign = 'right';
    for (const db of [0, -3, -6, -12, -18, -24, -36, -48, -60]) {
      const f = dbFrac(db);
      const y = MT + barH * (1 - f);
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.fillText(db, LBL_W - 3, y + 3);
      ctx.strokeStyle = db === 0 ? 'rgba(220,38,38,0.4)' : db === -18 ? 'rgba(234,179,8,0.22)' : 'rgba(255,255,255,0.07)';
      ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(LBL_W - 1, y); ctx.lineTo(W - MR, y); ctx.stroke();
    }

    // Draw one bar (L or R)
    const drawBar = (x, rmsDb, holdDb, clip, label) => {
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      ctx.fillRect(x, MT, barW, barH);

      const fillH = barH * dbFrac(rmsDb);
      if (fillH > 0.5) {
        const grad = ctx.createLinearGradient(0, MT + barH, 0, MT);
        grad.addColorStop(0,    '#166534');
        grad.addColorStop(0.5,  '#16a34a');
        grad.addColorStop(0.72, '#ca8a04');
        grad.addColorStop(0.88, '#ea580c');
        grad.addColorStop(1.0,  '#b91c1c');
        ctx.fillStyle = grad;
        ctx.fillRect(x, MT + barH - fillH, barW, fillH);
      }

      // Peak hold notch
      if (isFinite(holdDb) && holdDb > DB_MIN) {
        const hy = MT + barH * (1 - dbFrac(holdDb));
        ctx.fillStyle = holdDb > -3 ? '#ef4444' : holdDb > -18 ? '#fbbf24' : '#4ecca3';
        ctx.fillRect(x, hy - 1, barW, 2);
      }

      // Clip overlay
      if (clip) { ctx.fillStyle = 'rgba(239,68,68,0.2)'; ctx.fillRect(x, MT, barW, barH); }

      // Channel label above bar
      ctx.font = 'bold 9px monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = clip ? '#ef4444' : 'rgba(255,255,255,0.35)';
      ctx.fillText(label, x + barW / 2, MT - 2);
    };

    drawBar(lX, rmsDbL, this._audioPeakHoldL, this._audioClipL, 'L');
    drawBar(rX, rmsDbR, this._audioPeakHoldR, this._audioClipR, 'R');
  }

  _drawAudioWaveform() {
    const canvas = this._specCanvas;
    if (!canvas || !this._analyserL) return;

    const dpr  = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    canvas.width  = Math.round(rect.width  * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const W = rect.width, H = rect.height;

    ctx.fillStyle = '#080810';
    ctx.fillRect(0, 0, W, H);

    const bufLen = this._analyserL.frequencyBinCount;
    const dataL  = new Float32Array(bufLen);
    const dataR  = this._analyserR ? new Float32Array(bufLen) : null;
    this._analyserL.getFloatTimeDomainData(dataL);
    if (dataR) this._analyserR.getFloatTimeDomainData(dataR);

    // dB scale column on the right
    const SCALE_W = 28;
    const plotW   = W - SCALE_W;
    const halfH   = H / 2;
    const PAD     = 6;   // vertical padding within each half

    // Scale background
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.fillRect(plotW, 0, SCALE_W, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth   = 0.5;
    ctx.beginPath(); ctx.moveTo(plotW, 0); ctx.lineTo(plotW, H); ctx.stroke();

    // "dBFS" header in scale column
    ctx.save();
    ctx.font      = '7px monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.textAlign = 'center';
    ctx.translate(W - SCALE_W / 2, H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('dBFS', 0, 0);
    ctx.restore();

    // dB levels to mark (positive amplitude side; negative mirrored)
    const DB_MARKS = [0, -6, -12, -18, -24];

    // Draw one channel's waveform with dB grid
    const drawWave = (data, yBase, rP, gP, bP, label) => {
      const usable = halfH - PAD * 2;
      const cy     = yBase + PAD + usable / 2;  // center line Y

      // dB grid lines + right-side labels
      ctx.font      = '7px monospace';
      ctx.textAlign = 'right';
      for (const db of DB_MARKS) {
        const amp  = db === 0 ? 0.999 : Math.pow(10, db / 20);
        const yPos = cy - amp * usable / 2;   // positive amplitude line
        const yNeg = cy + amp * usable / 2;   // negative amplitude line

        const isClip = db === 0;
        ctx.strokeStyle = isClip ? 'rgba(220,38,38,0.3)' : 'rgba(255,255,255,0.07)';
        ctx.lineWidth   = isClip ? 0.8 : 0.5;

        ctx.beginPath(); ctx.moveTo(0, yPos); ctx.lineTo(plotW, yPos); ctx.stroke();
        if (db !== 0) { ctx.beginPath(); ctx.moveTo(0, yNeg); ctx.lineTo(plotW, yNeg); ctx.stroke(); }

        // Label on positive side only
        const lbl = db === 0 ? '0' : String(db);
        ctx.fillStyle = isClip ? 'rgba(220,38,38,0.65)' : 'rgba(255,255,255,0.3)';
        ctx.fillText(lbl, W - 3, yPos + 3);
      }

      // Zero (0 amplitude) center line
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
      ctx.lineWidth   = 0.5;
      ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(plotW, cy); ctx.stroke();
      ctx.fillStyle   = 'rgba(255,255,255,0.15)';
      ctx.textAlign   = 'right';
      ctx.font        = '7px monospace';
      ctx.fillText('—∞', W - 3, cy + 3);

      if (!data) return;

      const step = plotW / (bufLen - 1);

      // Glow pass
      ctx.strokeStyle = `rgba(${rP},${gP},${bP},0.18)`;
      ctx.lineWidth   = 4;
      ctx.lineJoin    = 'round';
      ctx.beginPath();
      for (let i = 0; i < bufLen; i++) {
        const x = i * step;
        const y = cy - data[i] * usable / 2;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Main waveform line
      ctx.strokeStyle = `rgba(${rP},${gP},${bP},0.92)`;
      ctx.lineWidth   = 1.3;
      ctx.beginPath();
      for (let i = 0; i < bufLen; i++) {
        const x = i * step;
        const y = cy - data[i] * usable / 2;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Channel label (top-left)
      ctx.font      = 'bold 10px monospace';
      ctx.fillStyle = `rgba(${rP},${gP},${bP},0.55)`;
      ctx.textAlign = 'left';
      ctx.fillText(label, 5, yBase + 13);
    };

    drawWave(dataL,          0,     108, 99,  255, 'L');
    drawWave(dataR || dataL, halfH, 78,  204, 163, 'R');

    // Channel divider
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth   = 1;
    ctx.beginPath(); ctx.moveTo(0, halfH); ctx.lineTo(W, halfH); ctx.stroke();
  }

  _drawPlayerVuMeter() {
    const canvas = this._playerVuCanvas;
    if (!canvas || !this._analyserL) return;

    const dpr  = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    canvas.width  = Math.round(rect.width  * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const W = rect.width, H = rect.height;

    // Rounded-rect background
    ctx.clearRect(0, 0, W, H);
    const R = 5;
    ctx.fillStyle = 'rgba(6,6,14,0.78)';
    ctx.beginPath();
    ctx.moveTo(R, 0); ctx.lineTo(W - R, 0); ctx.arcTo(W, 0,  W,   R,   R);
    ctx.lineTo(W, H - R); ctx.arcTo(W, H,  W-R, H,   R);
    ctx.lineTo(R, H); ctx.arcTo(0, H,   0,   H-R, R);
    ctx.lineTo(0, R); ctx.arcTo(0, 0,   R,   0,   R);
    ctx.closePath();
    ctx.fill();

    const DB_MIN = -60, DB_MAX = 0;
    const LBL_H  = 13, PT = 4, PL = 4, PR = 4, GAP = 3;
    const mH     = H - LBL_H - PT;
    const barW   = (W - PL - PR - GAP) / 2;
    const lX     = PL;
    const rX     = PL + barW + GAP;
    const dbFrac = db => (Math.max(DB_MIN, Math.min(DB_MAX, db)) - DB_MIN) / (DB_MAX - DB_MIN);

    // Read RMS
    const bufLen = this._analyserL.frequencyBinCount;
    const dataL  = new Float32Array(bufLen);
    const dataR  = this._analyserR ? new Float32Array(bufLen) : null;
    this._analyserL.getFloatTimeDomainData(dataL);
    if (dataR) this._analyserR.getFloatTimeDomainData(dataR);
    const rmsOf  = d => { let s = 0; for (let i = 0; i < d.length; i++) s += d[i]*d[i]; return Math.sqrt(s/d.length); };
    const toDb   = v => v > 1e-9 ? 20 * Math.log10(v) : -Infinity;
    const rmsDbL = toDb(rmsOf(dataL));
    const rmsDbR = dataR ? toDb(rmsOf(dataR)) : rmsDbL;

    const drawBar = (x, db, label) => {
      // Track
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(x, PT, barW, mH);
      // Fill
      const fillH = mH * dbFrac(db);
      if (fillH > 0.5) {
        const grad = ctx.createLinearGradient(0, PT + mH, 0, PT);
        grad.addColorStop(0,   '#166534');
        grad.addColorStop(0.5, '#16a34a');
        grad.addColorStop(0.72,'#ca8a04');
        grad.addColorStop(0.88,'#ea580c');
        grad.addColorStop(1.0, '#b91c1c');
        ctx.fillStyle = grad;
        ctx.fillRect(x, PT + mH - fillH, barW, fillH);
      }
      // Label
      ctx.font      = 'bold 8px monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.fillText(label, x + barW / 2, H - 3);
    };

    drawBar(lX, rmsDbL, 'L');
    drawBar(rX, rmsDbR, 'R');
  }

  // ── Stats poll ────────────────────────────────────────────────────────────
  _poll() {
    if(!this._player||!this._video) return;
    const stats=this._player.getStats();
    const track=this._player.getVariantTracks().find(t=>t.active);
    const idx=this._tick%HISTORY_LEN;

    this._brHist[idx]=track?Math.round((track.bandwidth||0)/1000):null;

    let bufAhead=0;
    try{ const b=this._video.buffered; if(b.length) bufAhead=Math.max(0,b.end(b.length-1)-this._video.currentTime); }catch{}
    this._bufHist[idx]=Math.round(bufAhead*10)/10;

    const dropped=stats.droppedFrames||0;
    this._drHist[idx]=Math.max(0,dropped-this._prevDrop);
    this._prevDrop=dropped;

    const liveLatency=stats.liveLatency||null;
    this._latHist[idx]=liveLatency?Math.round(liveLatency*10)/10:null;

    this._tick++;

    if(!this._visible) return;
    if(this._activeTab==='overview') this._renderOverview(stats);
    if(this._activeTab==='tracks')   this._renderTracks();
    if(this._activeTab==='charts')   this._drawCharts();
  }

  // ── Tab switch ────────────────────────────────────────────────────────────
  _switchTab(tab) {
    this._activeTab=tab;
    this._tabBtns.forEach(b=>b.classList.toggle('az-tab--active',b.dataset.tab===tab));
    Object.entries(this._views).forEach(([k,el])=>{ if(el) el.style.display=k===tab?'flex':'none'; });

    if(tab==='audio') this._setupAudioContext();

    if(!this._player) return;
    const stats=this._player.getStats();
    if(tab==='overview') this._renderOverview(stats);
    if(tab==='tracks')   this._renderTracks();
    if(tab==='network')  this._renderNetworkLog();
    if(tab==='events')   this._renderEventLog();
    if(tab==='markers')  { this._renderAdMonitor(); this._renderMarkers(); }
    if(tab==='charts')   requestAnimationFrame(()=>this._drawCharts());
    if(tab==='buffer')   this._startBufAnimation();
    if(tab==='captions') this._renderCaptionsTab();
  }

  // ── Overview ──────────────────────────────────────────────────────────────
  _set(id,val) { const el=document.getElementById(id); if(el) el.textContent=val??'—'; }
  _clearOverview() {
    ['az-vcodec','az-acodec','az-res','az-fps','az-vbr','az-abr','az-tbr','az-abrest',
     'az-buf','az-live','az-rate','az-loadtime','az-decoded','az-dropped','az-drm','az-keystat',
     'az-latency','az-protocol','az-container','az-streamurl']
      .forEach(id=>this._set(id,'—'));
  }

  _renderOverview(stats) {
    if(!this._player||!this._video) return;
    const track=this._player.getVariantTracks().find(t=>t.active);
    const s=stats||{};

    if(track) {
      this._set('az-vcodec', track.videoCodec);
      this._set('az-acodec', track.audioCodec);
      this._set('az-res',    track.width&&track.height?`${track.width} × ${track.height}`:null);
      this._set('az-fps',    track.frameRate?`${Math.round(track.frameRate)} fps`:null);
      this._set('az-vbr',    track.videoBandwidth?`${Math.round(track.videoBandwidth/1000)} kbps`:null);
      this._set('az-abr',    track.audioBandwidth?`${Math.round(track.audioBandwidth/1000)} kbps`:null);
      this._set('az-tbr',    track.bandwidth?`${Math.round(track.bandwidth/1000)} kbps`:null);
      this._set('az-container', track.mimeType||null);
    }
    this._set('az-abrest',  s.estimatedBandwidth?`${Math.round(s.estimatedBandwidth/1000)} kbps`:null);

    let bufAhead=0;
    try{ const b=this._video.buffered; if(b.length) bufAhead=Math.max(0,b.end(b.length-1)-this._video.currentTime); }catch{}
    this._set('az-buf',     bufAhead>0?`${bufAhead.toFixed(1)} s`:null);
    this._set('az-live',    this._player.isLive()?'Live':'VOD');
    this._set('az-rate',    `${this._video.playbackRate}×`);
    this._set('az-loadtime',s.loadLatency!=null?`${s.loadLatency.toFixed(2)} s`:null);
    this._set('az-decoded', s.decodedFrames!=null?String(s.decodedFrames):null);
    this._set('az-dropped', s.droppedFrames!=null?String(s.droppedFrames):null);

    // Live latency
    if(s.liveLatency!=null) {
      this._set('az-latency', `${s.liveLatency.toFixed(2)} s behind live`);
    } else {
      this._set('az-latency', this._player.isLive()?'calculating…':'N/A (VOD)');
    }

    // Protocol
    const manifest = this._player.getManifest?.();
    this._set('az-protocol', s.manifestTimeSeconds!=null?(document.getElementById('streamUrl')?.value?.includes('.mpd')?'MPEG-DASH':'HLS'):'—');

    // Stream URL
    const urlEl=document.getElementById('streamUrl');
    if(urlEl) this._set('az-streamurl', urlEl.value||null);

    // DRM
    let drmText='None', keyText='—';
    try{
      const ks=this._player.getKeyStatuses();
      const entries=Object.entries(ks);
      if(entries.length){ drmText='Widevine'; keyText=entries.map(([k,v])=>`${k.substring(0,8)}…: ${v}`).join('  '); }
    }catch{}
    this._set('az-drm',    drmText);
    this._set('az-keystat',keyText);

    const countEl=document.getElementById('azLogCount');
    if(countEl) countEl.textContent=`${this._netLog.length} request${this._netLog.length!==1?'s':''} captured`;
  }

  // ── Tracks ────────────────────────────────────────────────────────────────
  _renderTracks() {
    if(!this._player) return;
    const variants=this._player.getVariantTracks();
    document.getElementById('az-vtracks').innerHTML=variants.length?variants
      .sort((a,b)=>(b.height||0)-(a.height||0))
      .map(t=>`<tr class="${t.active?'az-track-active':''}">
        <td>${t.active?'▶':''}</td>
        <td>${t.height?`${t.height}p`:'—'}</td>
        <td>${t.frameRate?Math.round(t.frameRate):'—'}</td>
        <td><code>${esc(t.videoCodec||'—')}</code></td>
        <td>${t.bandwidth?Math.round(t.bandwidth/1000)+' kbps':'—'}</td>
        <td>${t.hdr||'—'}</td>
      </tr>`).join('')
    :'<tr><td colspan="6" class="az-empty">No video tracks loaded</td></tr>';

    const audioRoles=this._player.getAudioLanguagesAndRoles();
    document.getElementById('az-atracks').innerHTML=audioRoles.length?audioRoles.map(({language,role,label})=>
      `<tr><td>${esc(language||'—')}</td><td>${esc(role||'—')}</td><td>${esc(label||'—')}</td></tr>`
    ).join(''):'<tr><td colspan="3" class="az-empty">No audio tracks</td></tr>';

    const texts=this._player.getTextTracks();
    document.getElementById('az-ttracks').innerHTML=texts.length?texts.map(t=>
      `<tr class="${t.active?'az-track-active':''}">
        <td>${t.active?'▶':''}</td><td>${esc(t.language||'—')}</td>
        <td>${esc(t.label||'—')}</td><td>${esc(t.kind||'—')}</td>
      </tr>`).join('')
    :'<tr><td colspan="4" class="az-empty">No subtitle tracks</td></tr>';
  }

  // ── Network log ───────────────────────────────────────────────────────────
  _renderNetworkLog() {
    const filter=document.getElementById('azNetFilter').value;
    const rows=filter==='all'?this._netLog:this._netLog.filter(r=>r.type===filter);
    const tbody=document.getElementById('az-netlog');
    const countEl=document.getElementById('azLogCount');
    if(countEl) countEl.textContent=`${this._netLog.length} request${this._netLog.length!==1?'s':''} captured`;
    if(!rows.length){ tbody.innerHTML='<tr><td colspan="6" class="az-empty">No requests captured yet — load a stream to see traffic</td></tr>'; return; }
    tbody.innerHTML=rows.slice(0,300).map(r=>{
      const c=REQ_COLORS[r.type]||'#7a7a9a';
      const url=r.url?(r.url.length>70?'…'+r.url.slice(-65):r.url):'—';
      const size=r.size>1_048_576?`${(r.size/1_048_576).toFixed(1)} MB`:r.size>1024?`${(r.size/1024).toFixed(0)} KB`:r.size>0?`${r.size} B`:'—';
      const ts=new Date(r.ts), tsStr=`${String(ts.getHours()).padStart(2,'0')}:${String(ts.getMinutes()).padStart(2,'0')}:${String(ts.getSeconds()).padStart(2,'0')}.${String(ts.getMilliseconds()).padStart(3,'0').slice(0,2)}`;
      const durClass=r.duration>2000?'az-dur-slow':r.duration>500?'az-dur-med':'';
      return `<tr><td class="az-ts">${tsStr}</td><td><span class="az-type-pill" style="background:${c}22;color:${c};border-color:${c}44">${r.type}</span></td><td class="az-url-cell" title="${esc(r.url||'')}">${esc(url)}</td><td>${r.status||'—'}</td><td class="az-size">${size}</td><td class="${durClass}">${r.duration} ms</td></tr>`;
    }).join('');
  }

  // ── Event log ─────────────────────────────────────────────────────────────
  _renderEventLog() {
    const filter=document.getElementById('azEvtFilter').value;
    const rows=filter==='all'?this._eventLog:this._eventLog.filter(e=>e.category===filter);
    const tbody=document.getElementById('az-evtlog');
    if(!rows.length){ tbody.innerHTML='<tr><td colspan="3" class="az-empty">No events yet — load a stream to see events</td></tr>'; return; }
    tbody.innerHTML=rows.slice(0,400).map(e=>{
      const c=EVT_COLORS[e.category]||'#7a7a9a';
      return `<tr>
        <td class="az-ts">${e.stamp}</td>
        <td><span class="az-type-pill" style="background:${c}22;color:${c};border-color:${c}44">${e.category}</span>&#8202;<strong>${esc(e.name)}</strong></td>
        <td class="az-evt-detail">${esc(e.detail)}</td>
      </tr>`;
    }).join('');
  }

  // ── Manifest ──────────────────────────────────────────────────────────────
  async _fetchManifest() {
    const urlEl=document.getElementById('streamUrl');
    const url=urlEl?.value?.trim();
    const raw=document.getElementById('azManifestContent');
    const tree=document.getElementById('azManifestTree');
    if(!url){ raw.textContent='Enter a stream URL in the Source panel first.'; tree.innerHTML=''; return; }
    raw.textContent='Fetching manifest…'; tree.innerHTML='';
    // Reset child state on every fresh master fetch
    this._masterManifest=null; this._childManifests=[]; this._selectedManifestIdx=-1;
    const childBtn=document.getElementById('azFetchChildren');
    const childSel=document.getElementById('azManifestSelector');
    const childStat=document.getElementById('azChildStatus');
    if(childBtn){childBtn.style.display='none';childBtn.disabled=false;childBtn.textContent='⬇ All Children';}
    if(childSel) childSel.style.display='none';
    if(childStat) childStat.style.display='none';

    try{
      const res=await fetch(url,{cache:'no-store'});
      if(!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const text=await res.text();
      const isHLS=url.includes('.m3u8')||text.trimStart().startsWith('#EXTM3U');
      const isDASH=url.includes('.mpd')||text.trimStart().startsWith('<?xml')||text.includes('<MPD');
      if(isHLS){
        raw.innerHTML=this._highlightHLS(text);
        tree.innerHTML=this._parseHLSTree(text);
        // Parse ad markers and discontinuities
        if(window.AdMarkers) {
          const { markers } = window.AdMarkers.parseHLSMarkers(text);
          this._adMarkers = [...markers, ...this._timelineRegions.map(r=>({
            type:'event', time:r.startTime, duration:(r.endTime||r.startTime)-r.startTime,
            label:`Timeline Region [${r.schemeIdUri||''}]`, source:'shaka',
          }))].sort((a,b)=>a.time-b.time);
          this._renderMarkers();
          this._updateMarkerSummary();
        }
        // Store master + show children button if this is a master playlist
        this._masterManifest={url,text,isHLS:true};
        const isMaster=text.includes('#EXT-X-STREAM-INF');
        if(childBtn && isMaster) childBtn.style.display='';
        const tagsBtn=document.getElementById('azTagsBtn');
        if(tagsBtn){tagsBtn.disabled=false;tagsBtn.title='';}
      } else if(isDASH){
        raw.innerHTML=this._highlightMPD(text);
        tree.innerHTML=this._parseMPDTree(text);
        if(window.AdMarkers) {
          const { markers } = window.AdMarkers.parseDASHMarkers(text);
          this._adMarkers = [...markers, ...this._timelineRegions.map(r=>({
            type:'event', time:r.startTime, duration:(r.endTime||r.startTime)-r.startTime,
            label:`Timeline Region [${r.schemeIdUri||''}]`, source:'shaka',
          }))].sort((a,b)=>a.time-b.time);
          this._renderMarkers();
          this._updateMarkerSummary();
        }
        this._masterManifest={url,text,isHLS:false};
      } else raw.textContent=text;
    }catch(err){ raw.textContent=`Error:\n${err.message}`; tree.innerHTML=''; }
  }

  // ── Child manifest helpers ────────────────────────────────────────────────
  _parseHLSChildUrls(text, masterUrl) {
    const baseUrl = masterUrl.includes('?')
      ? masterUrl.substring(0, masterUrl.lastIndexOf('/') + 1)
      : masterUrl.substring(0, masterUrl.lastIndexOf('/') + 1);

    const resolve = u => {
      if (!u) return null;
      if (/^https?:\/\//i.test(u)) return u;
      try {
        const origin = new URL(masterUrl).origin;
        return u.startsWith('/') ? origin + u : baseUrl + u;
      } catch { return baseUrl + u; }
    };

    const lines   = text.split('\n');
    const children = [];
    const seen    = new Set();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('#EXT-X-STREAM-INF')) {
        const bw     = line.match(/BANDWIDTH=(\d+)/)?.[1];
        const res    = line.match(/RESOLUTION=([\dx]+)/)?.[1];
        const codecs = line.match(/CODECS="([^"]+)"/)?.[1];
        const fr     = line.match(/FRAME-RATE=([\d.]+)/)?.[1];
        // skip any comment/tag lines to find the URI
        let j = i + 1;
        while (j < lines.length && (lines[j].trim() === '' || lines[j].trim().startsWith('#'))) j++;
        const next = lines[j]?.trim();
        if (next && !next.startsWith('#')) {
          const url = resolve(next);
          if (url && !seen.has(url)) {
            seen.add(url);
            const label = res
              ? `📺 ${res}${fr ? ` ${parseFloat(fr).toFixed(0)}fps` : ''} ${bw ? `(${Math.round(+bw/1000)} kbps)` : ''}`
              : `📺 Variant ${bw ? Math.round(+bw/1000)+' kbps' : children.length + 1}`;
            children.push({ url, label, type: 'variant', codecs: codecs || null });
          }
          i = j;
        }
      }

      if (line.startsWith('#EXT-X-MEDIA')) {
        const uriM = line.match(/URI="([^"]+)"/);
        if (uriM) {
          const type = line.match(/TYPE=([A-Z-]+)/)?.[1] || 'MEDIA';
          const lang = line.match(/LANGUAGE="([^"]+)"/)?.[1];
          const name = line.match(/NAME="([^"]+)"/)?.[1];
          const url  = resolve(uriM[1]);
          if (url && !seen.has(url)) {
            seen.add(url);
            const icon  = type === 'AUDIO' ? '🔊' : type === 'SUBTITLES' ? '📝' : type === 'CLOSED-CAPTIONS' ? '💬' : '📋';
            const label = `${icon} ${type}${lang ? ` [${lang}]` : ''}${name ? `: ${name}` : ''}`;
            children.push({ url, label, type: type.toLowerCase(), codecs: null });
          }
        }
      }
    }
    return children;
  }

  async _fetchAllChildren() {
    const btn    = document.getElementById('azFetchChildren');
    const statEl = document.getElementById('azChildStatus');
    if (!this._masterManifest?.isHLS) return;

    btn.disabled = true;
    btn.textContent = '⏳ Fetching…';
    if (statEl) { statEl.textContent = 'Fetching child manifests…'; statEl.style.display = ''; }

    const defs = this._parseHLSChildUrls(this._masterManifest.text, this._masterManifest.url);
    if (!defs.length) {
      if (statEl) statEl.textContent = 'No child manifest URLs found';
      btn.disabled = false;
      btn.textContent = '⬇ All Children';
      return;
    }

    const results = await Promise.all(defs.map(async def => {
      try {
        const res = await fetch(def.url, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        const text = await res.text();
        return { ...def, text, error: null };
      } catch (err) {
        return { ...def, text: null, error: err.message };
      }
    }));

    this._childManifests = results;
    this._selectedManifestIdx = -1;
    this._updateManifestSelector();

    const ok = results.filter(r => !r.error).length;
    if (statEl) { statEl.textContent = `${ok}/${results.length} children loaded`; statEl.style.display = ''; }
    btn.disabled = false;
    btn.textContent = '⬇ All Children';

    // Enable View All and Play All buttons
    const viewAllBtn = document.getElementById('azViewAll');
    const playAllBtn = document.getElementById('azPlayAll');
    const variantOk  = results.filter(r => r.type === 'variant' && !r.error).length;
    if (viewAllBtn && results.length > 0) { viewAllBtn.disabled = false; viewAllBtn.title = ''; }
    if (playAllBtn && variantOk > 0)      { playAllBtn.disabled = false; playAllBtn.title = ''; }

    // Discontinuities and ad cues live in media playlists, not the master.
    // Parse markers from the first successfully fetched variant child.
    if (window.AdMarkers) {
      const firstVariant = results.find(r => r.type === 'variant' && !r.error && r.text);
      if (firstVariant) {
        const { markers } = window.AdMarkers.parseHLSMarkers(firstVariant.text);
        this._adMarkers = [
          ...markers,
          ...this._timelineRegions.map(r => ({
            type: 'event', time: r.startTime, duration: (r.endTime || r.startTime) - r.startTime,
            label: `Timeline Region [${r.schemeIdUri || ''}]`, source: 'shaka',
          })),
        ].sort((a, b) => a.time - b.time);
        this._renderMarkers();
        this._updateMarkerSummary();
      }
    }

    // Detect mismatches across all fetched children
    this._renderMismatches(this._detectMismatches());
  }

  _parseMismatchMeta(variant) {
    const lines = (variant.text || '').split('\n');
    let version = null, targetDuration = null, playlistType = null;
    let hasEndList = false, encryption = 'NONE';
    let segCount = 0, totalDur = 0, maxSeg = 0, pendingDur = null;

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line === '#EXT-X-ENDLIST')                { hasEndList = true; }
      else if (line.startsWith('#EXT-X-VERSION:'))   { version = parseInt(line.split(':')[1], 10); }
      else if (line.startsWith('#EXT-X-TARGETDURATION:')) { targetDuration = parseFloat(line.split(':')[1]); }
      else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) { playlistType = line.split(':')[1].trim(); }
      else if (line.startsWith('#EXT-X-KEY:'))       {
        const m = line.match(/METHOD=([^,\s]+)/i);
        if (m) encryption = m[1].toUpperCase();
      }
      else if (line.startsWith('#EXTINF:'))          { pendingDur = parseFloat(line.split(':')[1].split(',')[0]); }
      else if (!line.startsWith('#') && pendingDur != null) {
        segCount++; totalDur += pendingDur;
        if (pendingDur > maxSeg) maxSeg = pendingDur;
        pendingDur = null;
      }
    }
    return {
      label: variant.label, url: variant.url,
      version, targetDuration, playlistType, hasEndList, encryption,
      segCount, totalDur: Math.round(totalDur * 1000) / 1000, maxSeg,
      codecs: variant.codecs || null,
    };
  }

  _detectMismatches() {
    const variants = this._childManifests.filter(c => c.type === 'variant' && !c.error && c.text);
    if (variants.length < 2) return [];

    const parsed = variants.map(v => this._parseMismatchMeta(v));
    const issues = [];

    const mostCommon = arr => {
      const cnt = {};
      for (const v of arr) cnt[String(v)] = (cnt[String(v)] || 0) + 1;
      return Object.entries(cnt).sort((a, b) => b[1] - a[1])[0][0];
    };
    const rows = (field, fmt = v => String(v), expected) =>
      parsed.map(p => ({
        label: p.label,
        value: p[field] != null ? fmt(p[field]) : '—',
        diff:  p[field] != null && String(p[field]) !== expected,
      }));

    // 1 · EXT-X-TARGETDURATION
    const tdVals = parsed.map(p => p.targetDuration).filter(v => v != null);
    const tdSet  = [...new Set(tdVals)];
    if (tdSet.length > 1) {
      const exp = mostCommon(tdVals);
      issues.push({ severity: 'error',
        title: 'EXT-X-TARGETDURATION mismatch',
        detail: `Values: ${tdSet.join('s, ')}s — all variants must declare the same target duration (RFC 8216 §4.4.3.1)`,
        rows: parsed.map(p => ({ label: p.label, value: p.targetDuration != null ? p.targetDuration + 's' : '—', diff: p.targetDuration != null && String(p.targetDuration) !== exp })),
      });
    }

    // 2 · Missing EXT-X-TARGETDURATION
    const noTd = parsed.filter(p => p.targetDuration == null);
    if (noTd.length)
      issues.push({ severity: 'error',
        title: 'Missing EXT-X-TARGETDURATION',
        detail: `${noTd.length} variant(s) omit the mandatory #EXT-X-TARGETDURATION tag`,
        rows: noTd.map(p => ({ label: p.label, value: 'missing', diff: true })),
      });

    // 3 · EXT-X-VERSION
    const verVals = parsed.map(p => p.version).filter(v => v != null);
    const verSet  = [...new Set(verVals)];
    if (verSet.length > 1) {
      const exp = mostCommon(verVals);
      issues.push({ severity: 'warning',
        title: 'EXT-X-VERSION mismatch',
        detail: `HLS versions differ: ${verSet.map(v => 'v' + v).join(', ')}`,
        rows: parsed.map(p => ({ label: p.label, value: p.version != null ? 'v' + p.version : 'not set', diff: p.version != null && String(p.version) !== exp })),
      });
    }

    // 4 · Total duration (VOD only)
    const vod = parsed.filter(p => p.hasEndList && p.totalDur > 0);
    if (vod.length >= 2) {
      const durs  = vod.map(p => p.totalDur);
      const minD  = Math.min(...durs), maxD = Math.max(...durs);
      if (maxD - minD > 0.5)
        issues.push({ severity: 'warning',
          title: 'Total duration mismatch',
          detail: `VOD durations differ by up to ${(maxD - minD).toFixed(3)}s (${((maxD / minD - 1) * 100).toFixed(1)}% spread)`,
          rows: parsed.map(p => ({ label: p.label, value: p.totalDur > 0 ? p.totalDur.toFixed(3) + 's' : '—', diff: p.hasEndList && Math.abs(p.totalDur - maxD) > 0.5 })),
        });
    }

    // 5 · Segment count (VOD only)
    const vodC = parsed.filter(p => p.hasEndList && p.segCount > 0);
    if (vodC.length >= 2) {
      const counts = vodC.map(p => p.segCount);
      const minC = Math.min(...counts), maxC = Math.max(...counts);
      if (maxC !== minC) {
        const exp = mostCommon(counts);
        issues.push({ severity: 'warning',
          title: 'Segment count mismatch',
          detail: `Segment counts range from ${minC} to ${maxC}`,
          rows: parsed.map(p => ({ label: p.label, value: p.hasEndList ? p.segCount + ' segs' : '—', diff: p.hasEndList && String(p.segCount) !== exp })),
        });
      }
    }

    // 6 · Max EXTINF > TARGETDURATION (per variant)
    for (const p of parsed)
      if (p.targetDuration != null && p.maxSeg > p.targetDuration + 0.5)
        issues.push({ severity: 'error',
          title: 'Segment exceeds TARGETDURATION',
          detail: `${p.label}: longest segment ${p.maxSeg.toFixed(3)}s > declared ${p.targetDuration}s (HLS spec violation)`,
          rows: [{ label: p.label, value: p.maxSeg.toFixed(3) + 's', diff: true }],
        });

    // 7 · Encryption inconsistency
    const encSet = [...new Set(parsed.map(p => p.encryption))];
    if (encSet.length > 1) {
      const hasClear = encSet.includes('NONE'), hasEnc = encSet.some(t => t !== 'NONE');
      issues.push({ severity: hasClear && hasEnc ? 'error' : 'warning',
        title: hasClear && hasEnc ? 'Encryption inconsistency — mixed clear and encrypted' : 'Encryption method mismatch',
        detail: `Methods found: ${encSet.join(', ')}`,
        rows: parsed.map(p => ({ label: p.label, value: p.encryption, diff: p.encryption === 'NONE' ? hasEnc : hasClear })),
      });
    }

    // 8 · Playlist type inconsistency
    const ptSet = [...new Set(parsed.map(p => p.playlistType || 'not set'))];
    if (ptSet.length > 1) {
      const exp = mostCommon(parsed.map(p => p.playlistType || 'not set'));
      issues.push({ severity: 'warning',
        title: 'EXT-X-PLAYLIST-TYPE inconsistency',
        detail: `Types found: ${ptSet.join(', ')}`,
        rows: parsed.map(p => ({ label: p.label, value: p.playlistType || 'not set', diff: (p.playlistType || 'not set') !== exp })),
      });
    }

    // 9 · Missing EXT-X-ENDLIST on some (but not all) VOD variants
    const anyEnd = parsed.some(p => p.hasEndList);
    const noEnd  = parsed.filter(p => !p.hasEndList);
    if (anyEnd && noEnd.length)
      issues.push({ severity: 'warning',
        title: 'Missing EXT-X-ENDLIST on some variants',
        detail: `${noEnd.length} variant(s) lack #EXT-X-ENDLIST while others have it`,
        rows: parsed.map(p => ({ label: p.label, value: p.hasEndList ? '✓ present' : '✗ missing', diff: !p.hasEndList })),
      });

    // 10 · Codec family mismatch (from master CODECS= attribute)
    const families = parsed.map(p => {
      if (!p.codecs) return null;
      const c = p.codecs.toLowerCase();
      if (c.includes('hvc1') || c.includes('hev1')) return 'HEVC';
      if (c.includes('av01')) return 'AV1';
      if (c.includes('avc1') || c.includes('avc3')) return 'H.264';
      return p.codecs.split(',')[0].trim();
    });
    const famSet = [...new Set(families.filter(Boolean))];
    if (famSet.length > 1)
      issues.push({ severity: 'warning',
        title: 'Codec family mismatch across variants',
        detail: `Declared codec families: ${famSet.join(', ')} — verify intended multi-codec ladder`,
        rows: parsed.map((p, i) => ({ label: p.label, value: families[i] || (p.codecs || '—'), diff: false })),
      });

    return issues;
  }

  _renderMismatches(issues) {
    const panel  = document.getElementById('azMismatchPanel');
    const body   = document.getElementById('azMismatchBody');
    const badge  = document.getElementById('azMismatchBadge');
    const btn    = document.getElementById('azMismatchBtn');
    const count  = document.getElementById('azMismatchCount');
    if (!panel || !body) return;

    const n = issues.length;
    if (badge) badge.textContent = n;
    if (btn)   btn.style.display = n > 0 ? '' : 'none';
    if (count) count.textContent = `${n} issue${n !== 1 ? 's' : ''}`;

    if (n === 0) { panel.style.display = 'none'; return; }

    body.innerHTML = '';
    for (const mm of issues) {
      const item = document.createElement('div');
      item.className = 'az-mm-item';

      const sev = document.createElement('span');
      sev.className   = `az-mm-sev az-mm-sev--${mm.severity}`;
      sev.textContent = mm.severity.toUpperCase();

      const info = document.createElement('div');
      info.className  = 'az-mm-info';

      const title = document.createElement('div');
      title.className   = 'az-mm-item-title';
      title.textContent = mm.title;

      const detail = document.createElement('div');
      detail.className   = 'az-mm-detail';
      detail.textContent = mm.detail;

      info.append(title, detail);

      if (mm.rows?.length) {
        const vals = document.createElement('div');
        vals.className = 'az-mm-vals';
        for (const r of mm.rows) {
          const pill = document.createElement('span');
          pill.className   = 'az-mm-pill' + (r.diff ? ' az-mm-pill--diff' : '');
          pill.textContent = `${r.label}: ${r.value}`;
          vals.appendChild(pill);
        }
        info.appendChild(vals);
      }

      item.append(sev, info);
      body.appendChild(item);
    }
    panel.style.display = '';
  }

  _updateManifestSelector() {
    const sel = document.getElementById('azManifestSelector');
    if (!sel) return;
    const opts = ['<option value="-1">🗂 Master Manifest</option>'];
    this._childManifests.forEach((c, i) => {
      opts.push(`<option value="${i}">${esc(c.label)}${c.error ? ' ⚠' : ''}</option>`);
    });
    sel.innerHTML  = opts.join('');
    sel.value      = String(this._selectedManifestIdx);
    sel.style.display = '';
  }

  _showSelectedManifest(idx) {
    this._selectedManifestIdx = idx;
    const raw  = document.getElementById('azManifestContent');
    const tree = document.getElementById('azManifestTree');

    // If tags view is open, refresh it for the new selection
    if (this._tagsViewActive) { this._refreshTagsView(); return; }

    if (idx < 0 || !this._childManifests[idx]) {
      if (this._masterManifest) {
        raw.innerHTML  = this._masterManifest.isHLS
          ? this._highlightHLS(this._masterManifest.text)
          : this._highlightMPD(this._masterManifest.text);
        tree.innerHTML = this._masterManifest.isHLS
          ? this._parseHLSTree(this._masterManifest.text)
          : this._parseMPDTree(this._masterManifest.text);
      }
      return;
    }

    const child = this._childManifests[idx];
    if (child.error) {
      raw.textContent = `Failed to fetch:\n${child.url}\n\n${child.error}`;
      tree.innerHTML  = `<div class="az-tree">${this._treeRoot(child.label)}<div class="az-tree-item az-tree-child"><span class="az-tree-icon">⚠</span><span>${esc(child.error)}</span></div></div>`;
      return;
    }
    raw.innerHTML  = this._highlightHLS(child.text);
    tree.innerHTML = this._parseChildTree(child);

    // Update ad markers / discontinuities for this media playlist
    if (window.AdMarkers && child.text) {
      const { markers } = window.AdMarkers.parseHLSMarkers(child.text);
      this._adMarkers = [
        ...markers,
        ...this._timelineRegions.map(r => ({
          type: 'event', time: r.startTime, duration: (r.endTime || r.startTime) - r.startTime,
          label: `Timeline Region [${r.schemeIdUri || ''}]`, source: 'shaka',
        })),
      ].sort((a, b) => a.time - b.time);
      this._renderMarkers();
      this._updateMarkerSummary();
    }
  }

  _parseChildTree(child) {
    const lines     = child.text.split('\n');
    const segments  = lines.filter(l => l.trim() && !l.startsWith('#'));
    const keys      = lines.filter(l => l.startsWith('#EXT-X-KEY'));
    const maps      = lines.filter(l => l.startsWith('#EXT-X-MAP'));
    const isLive    = !lines.some(l => l.startsWith('#EXT-X-ENDLIST'));
    const targetDur = lines.find(l => l.startsWith('#EXT-X-TARGETDURATION'))?.match(/#EXT-X-TARGETDURATION:(\d+)/)?.[1];
    const seqNum    = lines.find(l => l.startsWith('#EXT-X-MEDIA-SEQUENCE'))?.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)?.[1];
    const totalSec  = lines.filter(l => l.startsWith('#EXTINF'))
      .reduce((s, l) => { const m = l.match(/#EXTINF:([\d.]+)/); return s + (m ? parseFloat(m[1]) : 0); }, 0);

    let html = `<div class="az-tree">${this._treeRoot(`${child.label} (${isLive ? 'Live' : 'VOD'})`)}`;
    html += this._treeChild('🎞', `${segments.length} segment${segments.length !== 1 ? 's' : ''}${totalSec > 0 ? ` (~${totalSec.toFixed(1)}s)` : ''}`);
    if (targetDur) html += this._treeChild('⏱', `Target duration: ${targetDur}s`);
    if (seqNum)    html += this._treeChild('#', `Sequence start: ${seqNum}`);
    if (maps.length)  html += this._treeChild('📦', 'Init segment (EXT-X-MAP)');
    if (keys.length) {
      html += this._treeChild('🔑', `DRM — ${keys.length} key block${keys.length > 1 ? 's' : ''}`);
      keys.forEach(k => {
        const method = k.match(/METHOD=([A-Z0-9-]+)/)?.[1] || '?';
        html += `<div class="az-tree-item az-tree-gc"><span class="az-pill az-pill--red">${method}</span></div>`;
      });
    }
    if (child.codecs) html += this._treeChild('🎬', `Codecs: ${child.codecs}`);
    return html + '</div>';
  }

  // ── View-All manifest grid ────────────────────────────────────────────────
  _toggleViewAll() {
    const btn  = document.getElementById('azViewAll');
    const tree = document.getElementById('azManifestTree');
    const raw  = document.getElementById('azManifestContent');
    const grid = document.getElementById('azManifestGrid');
    if (!grid || !tree || !raw) return;
    this._viewAllActive = !this._viewAllActive;
    if (this._viewAllActive) {
      tree.style.display = 'none';
      raw.style.display  = 'none';
      grid.style.display = '';
      grid.innerHTML     = '';
      if (btn) btn.textContent = '⊡ Single View';
      this._buildManifestGrid(grid);
    } else {
      tree.style.display = '';
      raw.style.display  = '';
      grid.style.display = 'none';
      grid.innerHTML     = '';
      if (btn) btn.textContent = '⊞ View All';
      this._showSelectedManifest(this._selectedManifestIdx);
    }
  }

  _buildManifestGrid(grid) {
    const items = [];
    if (this._masterManifest) {
      items.push({ label: '🗂 Master Manifest', text: this._masterManifest.text, isHLS: this._masterManifest.isHLS, error: null });
    }
    this._childManifests.forEach(c => {
      items.push({ label: c.label, text: c.text, isHLS: true, error: c.error });
    });
    if (!items.length) {
      grid.innerHTML = '<div style="padding:16px;color:var(--text-dim);font-size:12px">No manifests loaded — fetch children first.</div>';
      return;
    }
    items.forEach(item => {
      const card = document.createElement('div');
      card.className = 'az-mg-card' + (item.error ? ' az-mg-card--error' : '');
      const hdr = document.createElement('div');
      hdr.className = 'az-mg-header';
      hdr.textContent = item.label;
      card.appendChild(hdr);
      const body = document.createElement('div');
      body.className = 'az-mg-body';
      if (item.error) {
        body.innerHTML = `<div style="padding:10px;color:var(--red);font-size:11px">⚠ ${esc(item.error)}</div>`;
      } else {
        const treeDiv = document.createElement('div');
        treeDiv.className = 'az-mg-tree';
        treeDiv.innerHTML = item.isHLS ? this._parseHLSTree(item.text) : this._parseMPDTree(item.text);
        const rawPre = document.createElement('pre');
        rawPre.className = 'az-mg-raw';
        rawPre.innerHTML = item.isHLS ? this._highlightHLS(item.text) : this._highlightMPD(item.text);
        body.appendChild(treeDiv);
        body.appendChild(rawPre);
      }
      card.appendChild(body);
      grid.appendChild(card);
    });
  }

  // ── HLS Tags view ────────────────────────────────────────────────────────
  _toggleTagsView() {
    const btn  = document.getElementById('azTagsBtn');
    const tree = document.getElementById('azManifestTree');
    const raw  = document.getElementById('azManifestContent');
    const grid = document.getElementById('azManifestGrid');
    const tv   = document.getElementById('azTagsView');
    if (!tv) return;
    this._tagsViewActive = !this._tagsViewActive;
    if (this._tagsViewActive) {
      // Exit view-all if it was open
      if (this._viewAllActive) {
        this._viewAllActive = false;
        const vab = document.getElementById('azViewAll');
        if (vab) vab.textContent = '⊞ View All';
        if (grid) { grid.style.display = 'none'; grid.innerHTML = ''; }
      }
      tree.style.display = 'none';
      raw.style.display  = 'none';
      tv.style.display   = '';
      if (btn) btn.textContent = '✕ Tags';
      this._refreshTagsView();
    } else {
      tree.style.display = '';
      raw.style.display  = '';
      tv.style.display   = 'none';
      tv.innerHTML       = '';
      if (btn) btn.textContent = '🏷 Tags';
      this._showSelectedManifest(this._selectedManifestIdx);
    }
  }

  _refreshTagsView() {
    const tv = document.getElementById('azTagsView');
    if (!tv) return;
    const idx = this._selectedManifestIdx;
    let text = null, label = '';
    if (idx >= 0 && this._childManifests[idx] && !this._childManifests[idx].error) {
      text  = this._childManifests[idx].text;
      label = this._childManifests[idx].label;
    } else if (this._masterManifest) {
      text  = this._masterManifest.text;
      label = '🗂 Master Manifest';
    }
    tv.innerHTML = text ? this._buildTagsTable(text, label) : '<div style="padding:16px;color:var(--text-dim)">No manifest loaded.</div>';
  }

  _buildTagsTable(text, label) {
    const lines = text.split('\n');
    const tagMap = new Map(); // tagName → string[]

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith('#')) continue;
      const colon   = line.indexOf(':');
      const tagName = colon > 0 ? line.slice(1, colon) : line.slice(1);
      const value   = colon > 0 ? line.slice(colon + 1) : '';
      if (!tagMap.has(tagName)) tagMap.set(tagName, []);
      tagMap.get(tagName).push(value);
    }

    // Bucket into categories
    const cats = {};
    for (const [tag, values] of tagMap) {
      const def = HLS_TAG_DEFS[tag] || { cat: 'Custom / Extension', desc: 'Non-standard or proprietary extension tag' };
      if (!cats[def.cat]) cats[def.cat] = [];
      cats[def.cat].push({ tag, values, desc: def.desc });
    }
    // Sort tags within each category alphabetically
    for (const cat of Object.keys(cats)) cats[cat].sort((a, b) => a.tag.localeCompare(b.tag));

    const totalTags = tagMap.size;
    const totalLines = [...tagMap.values()].reduce((s, v) => s + v.length, 0);

    let html = `<div class="az-tags-header">`;
    html += `<span class="az-tags-title">${esc(label || 'Manifest')}</span>`;
    html += `<span class="az-tags-meta">${totalTags} unique tag${totalTags !== 1 ? 's' : ''} · ${totalLines} occurrences</span>`;
    html += `</div>`;

    const catOrder = [...HLS_CAT_ORDER];
    // Append any categories not in the predefined order
    for (const cat of Object.keys(cats)) {
      if (!catOrder.includes(cat)) catOrder.push(cat);
    }

    for (const cat of catOrder) {
      if (!cats[cat]) continue;
      html += `<div class="az-tags-section">`;
      html += `<div class="az-tags-section-hdr">${esc(cat)}</div>`;
      html += `<table class="az-tags-table"><thead><tr><th>Tag</th><th>Value(s)</th><th>Description</th></tr></thead><tbody>`;
      for (const { tag, values, desc } of cats[cat]) {
        const multi = values.length > 1;
        // First row
        html += `<tr class="az-tags-row${multi ? ' az-tags-multi' : ''}">`;
        html += `<td class="az-tags-name" rowspan="${values.length}">#${esc(tag)}`;
        if (multi) html += ` <span class="az-tags-badge">×${values.length}</span>`;
        html += `</td>`;
        html += `<td class="az-tags-val">${values[0] ? `<code>${esc(values[0])}</code>` : '<span class="az-tags-empty">—</span>'}</td>`;
        html += `<td class="az-tags-desc" rowspan="${values.length}">${esc(desc)}</td></tr>`;
        // Extra rows for repeated tags
        for (let i = 1; i < values.length; i++) {
          html += `<tr class="az-tags-row az-tags-extra"><td class="az-tags-val"><code>${esc(values[i])}</code></td></tr>`;
        }
      }
      html += `</tbody></table></div>`;
    }

    return html;
  }

  // ── Multi-player playback ─────────────────────────────────────────────────
  async _openPlayAll() {
    const variants = this._childManifests.filter(c => c.type === 'variant' && !c.error);
    if (!variants.length) return;

    const overlay = document.getElementById('azMultiplayOverlay');
    const gridEl  = document.getElementById('azMultiplayGrid');
    const statEl  = document.getElementById('azMpStatus');
    const muteBtn = document.getElementById('azMpMute');

    overlay.style.display = '';
    gridEl.innerHTML = '';
    this._multiPlayers = [];
    this._mpMuted = true;
    if (muteBtn) muteBtn.textContent = '🔊 Unmute All';

    // Create one shared AudioContext for all ladder instances
    this._stopMpAudioAnimation();
    try { this._mpAudioCtx?.close(); } catch {}
    try { this._mpAudioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { this._mpAudioCtx = null; }

    const n    = variants.length;
    const cols = n === 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 2 : n <= 6 ? 3 : n <= 9 ? 3 : 4;
    const rows = Math.ceil(n / cols);
    gridEl.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    gridEl.style.gridTemplateRows    = `repeat(${rows}, 1fr)`;

    if (statEl) statEl.textContent = `Loading ${n} stream${n > 1 ? 's' : ''}…`;

    const entries = variants.map(variant => {
      const cell    = document.createElement('div');
      cell.className = 'az-mp-cell';
      const videoEl  = document.createElement('video');
      videoEl.setAttribute('playsinline', '');
      videoEl.muted  = true;
      const label    = document.createElement('div');
      label.className = 'az-mp-label';
      label.textContent = variant.label.replace(/^[\u{1F4FA}\u{1F50A}\u{1F4DD}\u{1F4AC}\u{1F4CB}]\s*/u, '').trim();
      const spinner  = document.createElement('div');
      spinner.className = 'az-mp-spin';
      spinner.textContent = '↻';
      cell.appendChild(videoEl);
      cell.appendChild(label);
      cell.appendChild(spinner);
      // Per-cell audio controls (revealed on hover)
      const ctrlBar   = document.createElement('div');
      ctrlBar.className = 'mp-ctrl-bar';
      const muteBtn   = document.createElement('button');
      muteBtn.className = 'mp-ctrl-mute';
      muteBtn.textContent = '🔇';
      muteBtn.title   = 'Mute / Unmute';
      const volSlider = document.createElement('input');
      volSlider.type  = 'range';
      volSlider.className = 'mp-ctrl-vol';
      volSlider.min = '0'; volSlider.max = '100'; volSlider.value = '80';
      ctrlBar.appendChild(muteBtn);
      ctrlBar.appendChild(volSlider);
      cell.appendChild(ctrlBar);
      muteBtn.addEventListener('click', e => {
        e.stopPropagation();
        videoEl.muted = !videoEl.muted;
        muteBtn.textContent = videoEl.muted ? '🔇' : '🔊';
      });
      volSlider.addEventListener('input', e => {
        e.stopPropagation();
        videoEl.volume = parseInt(e.target.value, 10) / 100;
        if (videoEl.muted && videoEl.volume > 0) {
          videoEl.muted = false;
          muteBtn.textContent = '🔊';
        }
      });
      gridEl.appendChild(cell);
      return { variant, cell, videoEl, label, spinner, muteBtn, sp: null };
    });
    this._multiPlayers = entries;

    let loadedCount = 0;
    await Promise.all(entries.map(async entry => {
      const { variant, cell, videoEl, label, spinner } = entry;
      try {
        shaka.polyfill.installAll();
        const sp = new shaka.Player(videoEl);
        entry.sp = sp;
        sp.configure({
          streaming: { bufferingGoal: 15, rebufferingGoal: 3, bufferBehind: 10 },
          abr: { enabled: true },
        });
        sp.addEventListener('error', evt => {
          spinner.style.display = 'none';
          if (!cell.querySelector('.az-mp-err')) {
            const d = document.createElement('div');
            d.className = 'az-mp-err';
            d.textContent = `⚠ ${evt.detail?.message || 'Playback error'}`;
            cell.appendChild(d);
          }
        });
        sp.addEventListener('buffering', evt => { spinner.style.display = evt.buffering ? '' : 'none'; });
        videoEl.addEventListener('canplay', () => { spinner.style.display = 'none'; }, { once: true });
        await sp.load(variant.url);
        videoEl.play().catch(() => {});
        this._setupMpAudioNode(entry);
        loadedCount++;
      } catch (err) {
        spinner.style.display = 'none';
        if (!cell.querySelector('.az-mp-err')) {
          const d = document.createElement('div');
          d.className = 'az-mp-err';
          d.textContent = `⚠ ${err.message || String(err)}`;
          cell.appendChild(d);
          label.style.display = 'none';
        }
      }
      if (statEl) statEl.textContent = `${loadedCount}/${n} loaded`;
    }));

    if (statEl) statEl.textContent = `${loadedCount}/${n} streams ready`;
    this._startMpAudioAnimation();
  }

  _closePlayAll() {
    this._stopMpAudioAnimation();
    const overlay = document.getElementById('azMultiplayOverlay');
    if (overlay) overlay.style.display = 'none';
    for (const { sp, videoEl } of (this._multiPlayers || [])) {
      try { videoEl?.pause(); }  catch {}
      try { sp?.destroy(); }     catch {}
    }
    try { this._mpAudioCtx?.close(); } catch {}
    this._mpAudioCtx = null;
    this._multiPlayers = [];
    const gridEl = document.getElementById('azMultiplayGrid');
    if (gridEl) gridEl.innerHTML = '';
  }

  _mpPlayAll()  { for (const { videoEl } of this._multiPlayers) videoEl?.play().catch(() => {}); }
  _mpPauseAll() { for (const { videoEl } of this._multiPlayers) { try { videoEl?.pause(); } catch {} } }

  _mpToggleMute() {
    this._mpMuted = !this._mpMuted;
    const btn = document.getElementById('azMpMute');
    for (const { videoEl, muteBtn } of this._multiPlayers) {
      if (videoEl) videoEl.muted = this._mpMuted;
      if (muteBtn) muteBtn.textContent = this._mpMuted ? '🔇' : '🔊';
    }
    if (btn) btn.textContent = this._mpMuted ? '🔊 Unmute All' : '🔇 Mute All';
  }

  _mpSyncAll() {
    const ref = this._multiPlayers.find(p => p.videoEl && isFinite(p.videoEl.currentTime) && p.videoEl.currentTime > 0);
    if (!ref) return;
    const t = ref.videoEl.currentTime;
    for (const { videoEl } of this._multiPlayers) {
      if (videoEl && videoEl !== ref.videoEl && isFinite(videoEl.duration)) {
        try { videoEl.currentTime = t; } catch {}
      }
    }
  }

  // ── Multi-play per-instance audio ─────────────────────────────────────────
  _setupMpAudioNode(entry) {
    if (!this._mpAudioCtx || !entry.videoEl) return;
    try {
      const ctx      = this._mpAudioCtx;
      const src      = ctx.createMediaElementSource(entry.videoEl);
      src.connect(ctx.destination);                         // keep audio playing
      const splitter = ctx.createChannelSplitter(2);
      const aL       = ctx.createAnalyser();
      const aR       = ctx.createAnalyser();
      aL.fftSize     = 1024;                               // bufLen = 512
      aR.fftSize     = 1024;
      src.connect(splitter);
      splitter.connect(aL, 0);
      splitter.connect(aR, 1);
      entry.analyserL = aL;
      entry.analyserR = aR;
      // Inject VU canvas into cell
      const vc       = document.createElement('canvas');
      vc.className   = 'mp-vu-canvas';
      entry.cell.appendChild(vc);
      entry.vuCanvas = vc;
    } catch { /* setup failed silently */ }
  }

  _startMpAudioAnimation() {
    this._stopMpAudioAnimation();
    const draw = () => {
      if (this._mpAudioCtx?.state === 'suspended') this._mpAudioCtx.resume().catch(() => {});
      for (const entry of this._multiPlayers) {
        if (entry.vuCanvas && entry.analyserL) {
          this._drawMpVuMeter(entry.vuCanvas, entry.analyserL, entry.analyserR);
        }
      }
      this._mpAudioAnimFrame = requestAnimationFrame(draw);
    };
    this._mpAudioAnimFrame = requestAnimationFrame(draw);
  }

  _stopMpAudioAnimation() {
    if (this._mpAudioAnimFrame) {
      cancelAnimationFrame(this._mpAudioAnimFrame);
      this._mpAudioAnimFrame = null;
    }
  }

  _drawMpVuMeter(canvas, analyserL, analyserR) {
    const dpr  = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    canvas.width  = Math.round(rect.width  * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const W = rect.width, H = rect.height;

    // Rounded background
    const R = 3;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(5,5,12,0.80)';
    ctx.beginPath();
    ctx.moveTo(R, 0); ctx.lineTo(W - R, 0); ctx.arcTo(W, 0,  W,   R,   R);
    ctx.lineTo(W, H - R); ctx.arcTo(W, H,  W-R, H,   R);
    ctx.lineTo(R, H); ctx.arcTo(0, H,  0,   H-R, R);
    ctx.lineTo(0, R); ctx.arcTo(0, 0,  R,   0,   R);
    ctx.closePath(); ctx.fill();

    const DB_MIN = -60, DB_MAX = 0;
    const PT = 3, PB = 3, PL = 3, PR = 3, GAP = 2;
    const mH   = H - PT - PB;
    const barW = (W - PL - PR - GAP) / 2;
    const lX   = PL;
    const rX   = PL + barW + GAP;
    const dbFrac = db => (Math.max(DB_MIN, Math.min(DB_MAX, db)) - DB_MIN) / (DB_MAX - DB_MIN);

    const bufLen = analyserL.frequencyBinCount;
    const dataL  = new Float32Array(bufLen);
    const dataR  = analyserR ? new Float32Array(bufLen) : null;
    analyserL.getFloatTimeDomainData(dataL);
    if (dataR) analyserR.getFloatTimeDomainData(dataR);

    const rmsOf  = d => { let s = 0; for (let i = 0; i < d.length; i++) s += d[i]*d[i]; return Math.sqrt(s/d.length); };
    const toDb   = v => v > 1e-9 ? 20 * Math.log10(v) : -Infinity;
    const rmsDbL = toDb(rmsOf(dataL));
    const rmsDbR = dataR ? toDb(rmsOf(dataR)) : rmsDbL;

    const drawBar = (x, db) => {
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(x, PT, barW, mH);
      const fillH = mH * dbFrac(db);
      if (fillH > 0.5) {
        const grad = ctx.createLinearGradient(0, PT + mH, 0, PT);
        grad.addColorStop(0,    '#166534');
        grad.addColorStop(0.5,  '#16a34a');
        grad.addColorStop(0.72, '#ca8a04');
        grad.addColorStop(0.88, '#ea580c');
        grad.addColorStop(1.0,  '#b91c1c');
        ctx.fillStyle = grad;
        ctx.fillRect(x, PT + mH - fillH, barW, fillH);
      }
    };

    drawBar(lX, rmsDbL);
    drawBar(rX, rmsDbR);

    // "L R" micro-label at bottom
    ctx.font      = '6px monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.textAlign = 'center';
    ctx.fillText('L', lX + barW / 2, H - 1);
    ctx.fillText('R', rX + barW / 2, H - 1);
  }

  // ── Ad Break Monitor ──────────────────────────────────────────────────────
  _renderAdMonitor() {
    const panel = document.getElementById('adMonitorPanel');
    const log   = document.getElementById('adSessionLog');
    if (!panel || !log) return;

    // ── Active break status ────────────────────────────────────────────────
    const state = this._adBreakState;
    if (state) {
      panel.style.display = 'flex';
      const elapsedMs  = Date.now() - state.startWallMs;
      const elapsedS   = elapsedMs / 1000;
      const schedDur   = state.scheduledDuration;
      const pct        = schedDur ? Math.min(100, (elapsedS / schedDur) * 100) : null;
      const remaining  = schedDur ? Math.max(0, schedDur - elapsedS) : null;

      const fmt = s => {
        const m = Math.floor(s / 60), sec = Math.floor(s % 60);
        return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
      };

      document.getElementById('adm-breaknum').textContent = `Break #${state.breakNum}`;
      document.getElementById('adm-elapsed').textContent  = fmt(elapsedS);
      document.getElementById('adm-total').textContent    = schedDur ? fmt(schedDur) : '?';
      document.getElementById('adm-remain').textContent   = remaining != null ? fmt(remaining) : '—';
      document.getElementById('adm-slot').textContent     = state.slots.length
        ? `Ad ${state.currentSlotNum || '?'} of ${state.slots[0]?.expected || '?'}`
        : '—';
      document.getElementById('adm-upid').textContent     = state.upid || '—';
      document.getElementById('adm-progid').textContent   = state.programId != null ? String(state.programId) : '—';
      document.getElementById('adm-segtype').textContent  = state.segmentationTypeId || '—';
      document.getElementById('adm-scheme').textContent   = state.schemeIdUri ? state.schemeIdUri.split(':').pop() : '—';

      // Progress bar
      const bar = document.getElementById('adm-progress');
      if (bar) bar.style.width = (pct != null ? pct.toFixed(1) : 100) + '%';

      // Tracking URLs
      const trackEl = document.getElementById('adm-tracking');
      if (trackEl) {
        if (state.trackingUrls.length) {
          trackEl.innerHTML = state.trackingUrls.map(t =>
            `<div class="adm-url"><span class="adm-url-type">${esc(t.type||'')}</span><span class="adm-url-val" title="${esc(t.url)}">${esc(t.url.length>80?t.url.slice(0,77)+'…':t.url)}</span></div>`
          ).join('');
        } else {
          trackEl.textContent = 'No tracking URLs in SCTE-35 descriptors';
        }
      }

      // Slot sequence
      const slotEl = document.getElementById('adm-slots');
      if (slotEl && state.slots.length) {
        slotEl.innerHTML = state.slots.map(s => {
          const active = s.num === state.currentSlotNum;
          return `<span class="adm-slot-pill ${active ? 'adm-slot-active' : s.status === 'done' ? 'adm-slot-done' : ''}">Ad ${s.num}</span>`;
        }).join('');
        slotEl.style.display = '';
      } else if (slotEl) {
        slotEl.style.display = 'none';
      }

    } else {
      panel.style.display = 'none';
    }

    // ── Session log ────────────────────────────────────────────────────────
    const breaks = this._adBreakLog;
    if (!breaks.length) {
      log.innerHTML = '<div class="adm-log-empty">No ad breaks in this session yet</div>';
      return;
    }

    log.innerHTML = breaks.map(b => {
      const status = b.completed ? `✓ ${b.actualDurationSecs}s` : '⏳ Active';
      const statusCls = b.completed ? 'adm-log-done' : 'adm-log-active';
      const trackCount = b.trackingUrls.length;

      let inner = `<div class="adm-log-header">
        <span class="adm-log-num">Break #${b.breakNum}</span>
        <span class="adm-log-time">@ ${fmtTime(b.startVideoTime)}</span>
        ${b.scheduledDuration ? `<span class="adm-log-dur">${b.scheduledDuration}s scheduled</span>` : ''}
        <span class="adm-log-status ${statusCls}">${status}</span>
        ${trackCount ? `<span class="adm-log-track">🔗 ${trackCount} tracking URL${trackCount>1?'s':''}</span>` : ''}
      </div>`;

      if (b.slots.length) {
        inner += `<div class="adm-log-slots">${b.slots.map(s =>
          `<span class="adm-slot-pill adm-slot-${s.status}">${s.status==='active'?'▶ ':''}Ad ${s.num}/${s.expected}</span>`
        ).join('')}</div>`;
      }

      if (b.upid)      inner += `<div class="adm-log-meta"><span>UPID</span><span>${esc(b.upid)}</span></div>`;
      if (b.programId) inner += `<div class="adm-log-meta"><span>Program ID</span><span>${b.programId}</span></div>`;
      if (b.segmentationTypeId) inner += `<div class="adm-log-meta"><span>Seg Type</span><span>${esc(b.segmentationTypeId)}</span></div>`;
      if (b.trackingUrls.length) {
        inner += b.trackingUrls.map(t =>
          `<div class="adm-log-meta adm-log-url"><span>${esc(t.type||'URL')}</span><span title="${esc(t.url)}">${esc(t.url.length>90?t.url.slice(0,87)+'…':t.url)}</span></div>`
        ).join('');
      }

      return `<div class="adm-log-entry">${inner}</div>`;
    }).join('');
  }

  // ── Markers tab ───────────────────────────────────────────────────────────
  _updateMarkerSummary() {
    const all   = this._adMarkers;
    const ads   = all.filter(m => m.type === 'ad-start' || m.type === 'ad-end');
    const disc  = all.filter(m => m.type === 'discontinuity');
    const scte  = all.filter(m => m.type === 'scte35');
    const evts  = all.filter(m => m.type === 'event' || m.type === 'period' || m.type === 'daterange');
    const gaps  = all.filter(m => m.type === 'schedule-gap');
    const setT  = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    setT('mk-count-ad',    String(Math.floor(ads.length / 2)) + ' break' + (ads.length !== 2 ? 's' : ''));
    setT('mk-count-disc',  String(disc.length));
    setT('mk-count-scte',  String(scte.length));
    setT('mk-count-event', String(evts.length));
    setT('mk-count-gap',   String(gaps.length));
  }

  _renderMarkers() {
    this._updateMarkerSummary();
    const filter = document.getElementById('azMarkerFilter')?.value || 'all';
    const rows   = filter === 'all' ? this._adMarkers : this._adMarkers.filter(m => m.type === filter);
    const tbody  = document.getElementById('az-mktlog');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="az-empty">No markers detected — fetch the manifest from the Manifest tab to parse ad cues</td></tr>`;
      return;
    }

    const TYPE_CFG = {
      'ad-start':      { color: '#ffa033', label: 'AD OUT'   },
      'ad-end':        { color: '#4ecca3', label: 'AD IN'    },
      'discontinuity': { color: '#e05252', label: 'DISC'     },
      'scte35':        { color: '#6c63ff', label: 'SCTE-35'  },
      'daterange':     { color: '#ff77aa', label: 'DATERANGE'},
      'event':         { color: '#88aaff', label: 'EVENT'    },
      'period':        { color: '#ccaa33', label: 'PERIOD'   },
      'pdt':           { color: '#7a7a9a', label: 'PDT'      },
      'schedule-gap':  { color: '#ff4466', label: 'SCHED GAP'},
    };

    tbody.innerHTML = rows.map((m, idx) => {
      const cfg  = TYPE_CFG[m.type] || { color: '#7a7a9a', label: m.type.toUpperCase() };
      const dur  = m.duration > 0 ? `${m.duration.toFixed(1)}s` : (m.adBreakDuration ? `${m.adBreakDuration.toFixed(1)}s` : '—');
      const time = fmtTime(m.time);
      const s35  = m.scte35 && !m.scte35.error ? this._scte35Badge(m.scte35) : (m.scte35?.error ? `<span class="mk-scte-err">Error: ${esc(m.scte35.error)}</span>` : '—');
      return `<tr class="mk-row" data-time="${m.time}">
        <td class="mk-time">${time}</td>
        <td><span class="mk-type-badge" style="background:${cfg.color}22;color:${cfg.color};border-color:${cfg.color}55">${cfg.label}</span></td>
        <td class="mk-dur">${dur}</td>
        <td class="mk-label">${esc(m.label)}</td>
        <td class="mk-scte">${s35}</td>
      </tr>
      ${m.scte35 && !m.scte35.error ? `<tr class="mk-scte-row"><td colspan="5">${this._scte35Card(m.scte35)}</td></tr>` : ''}`;
    }).join('');

    // Click to seek
    tbody.querySelectorAll('.mk-row').forEach(row => {
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => {
        const t = parseFloat(row.dataset.time);
        if (isFinite(t) && this._video) this._video.currentTime = t;
      });
    });
  }

  _scte35Badge(s35) {
    return `<span class="mk-scte-badge" title="${esc(JSON.stringify(s35,null,2))}">⊛ ${esc(s35.spliceCommandTypeName||'')}</span>`;
  }

  _scte35Card(s35) {
    const rows = [];
    if (s35.spliceCommandTypeName) rows.push(['Command', s35.spliceCommandTypeName]);
    if (s35.spliceEventId != null) rows.push(['Event ID', s35.spliceEventId]);
    if (s35.outOfNetwork  != null) rows.push(['Out-Of-Network', s35.outOfNetwork ? 'Yes' : 'No']);
    if (s35.spliceTimeSecs)         rows.push(['Splice Time', `${s35.spliceTimeSecs}s`]);
    if (s35.breakDurationSecs)      rows.push(['Break Duration', `${s35.breakDurationSecs}s`]);
    if (s35.autoReturn != null)     rows.push(['Auto Return', s35.autoReturn ? 'Yes' : 'No']);
    if (s35.timeSignalPts)          rows.push(['Time Signal PTS', `${s35.timeSignalPts}s`]);
    if (s35.uniqueProgramId != null) rows.push(['Program ID', s35.uniqueProgramId]);
    if (s35.encrypted)              rows.push(['Encrypted', 'Yes']);
    return `<div class="mk-scte-card"><span class="mk-scte-card-title">SCTE-35 Decoded</span>${rows.map(([k,v]) => `<span class="mk-scte-field"><span>${esc(k)}</span><span>${esc(String(v))}</span></span>`).join('')}</div>`;
  }

  // ── HLS highlight + tree ──────────────────────────────────────────────────
  _highlightHLS(text) {
    return text.split('\n').map(line=>{
      if(!line.trim()) return '';
      const e=esc(line);
      if(line.startsWith('#EXTM3U'))          return `<span class="m3u8-header">${e}</span>`;
      if(line.startsWith('#EXT-X-KEY'))        return `<span class="m3u8-drm">${e}</span>`;
      if(line.startsWith('#EXT-X-MAP'))        return `<span class="m3u8-map">${e}</span>`;
      if(line.startsWith('#EXT-X-STREAM-INF')) return `<span class="m3u8-stream">${e}</span>`;
      if(line.startsWith('#EXT-X-MEDIA'))      return `<span class="m3u8-media">${e}</span>`;
      if(line.startsWith('#EXTINF'))           return `<span class="m3u8-extinf">${e}</span>`;
      if(line.startsWith('#EXT-X-'))           return `<span class="m3u8-tag">${e}</span>`;
      if(line.startsWith('#'))                 return `<span class="m3u8-comment">${e}</span>`;
      if(/^https?:\/\/|^\//.test(line))        return `<span class="m3u8-url">${e}</span>`;
      return `<span class="m3u8-seg">${e}</span>`;
    }).join('\n');
  }
  _parseHLSTree(text) {
    const lines=text.split('\n');
    const variants=lines.filter(l=>l.startsWith('#EXT-X-STREAM-INF'));
    const segments=lines.filter(l=>l.trim()&&!l.startsWith('#')&&!l.match(/\.m3u8(\?|$)/i));
    const keys=lines.filter(l=>l.startsWith('#EXT-X-KEY'));
    const media=lines.filter(l=>l.startsWith('#EXT-X-MEDIA'));
    const isMaster=variants.length>0;
    const isLive=!lines.some(l=>l.startsWith('#EXT-X-ENDLIST'));
    let html='<div class="az-tree">'+this._treeRoot(isMaster?'Master Playlist':`Media Playlist (${isLive?'Live':'VOD'})`);
    if(isMaster){
      html+=this._treeChild('📺',`${variants.length} video variant${variants.length>1?'s':''}`);
      variants.forEach(v=>{
        const bw=v.match(/BANDWIDTH=(\d+)/)?.[1], res=v.match(/RESOLUTION=([\dx]+)/)?.[1];
        const cod=v.match(/CODECS="([^"]+)"/)?.[1], fr=v.match(/FRAME-RATE=([\d.]+)/)?.[1];
        html+=`<div class="az-tree-item az-tree-gc">${res?`<span class="az-pill">${res}</span>`:''} ${fr?`<span class="az-pill">${parseFloat(fr).toFixed(0)} fps</span>`:''} ${bw?`<span class="az-pill">${Math.round(+bw/1000)} kbps</span>`:''} ${cod?`<span class="az-pill az-pill--dim">${esc(cod)}</span>`:''}</div>`;
      });
    } else {
      const totalSec=lines.filter(l=>l.startsWith('#EXTINF')).reduce((sum,l)=>{const m=l.match(/#EXTINF:([\d.]+)/);return sum+(m?parseFloat(m[1]):0);},0);
      html+=this._treeChild('🎞',`${segments.length} segment${segments.length>1?'s':''}${totalSec>0?` (~${totalSec.toFixed(1)}s)`:''}`);
    }
    if(media.length){
      const at=media.filter(l=>l.includes('TYPE=AUDIO')), st=media.filter(l=>l.includes('TYPE=SUBTITLES'));
      if(at.length) html+=this._treeChild('🔊',`${at.length} audio rendition${at.length>1?'s':''}`);
      if(st.length) html+=this._treeChild('📝',`${st.length} subtitle rendition${st.length>1?'s':''}`);
    }
    if(keys.length){
      html+=this._treeChild('🔑',`DRM — ${keys.length} key block${keys.length>1?'s':''}`);
      keys.forEach(k=>{
        const method=k.match(/METHOD=([A-Z0-9-]+)/)?.[1]||'?', uri=k.match(/URI="([^"]+)"/)?.[1]||'';
        html+=`<div class="az-tree-item az-tree-gc"><span class="az-pill az-pill--red">${method}</span> ${uri?`<span class="az-pill az-pill--dim" title="${esc(uri)}">${esc(uri.length>50?uri.slice(0,47)+'…':uri)}</span>`:''}</div>`;
      });
    }
    return html+'</div>';
  }
  _highlightMPD(text) {
    const e=t=>t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return e(text)
      .replace(/(&lt;\/?)(MPD|Period|AdaptationSet|Representation|ContentProtection|SegmentTemplate|SegmentList|SegmentBase|BaseURL|AudioChannelConfiguration|Role|Label)/g,(_,p,tag)=>`${p}<span class="mpd-tag">${tag}</span>`)
      .replace(/\s([\w:]+)(=)/g,' <span class="mpd-attr">$1</span>=')
      .replace(/&quot;([^&]*)&quot;/g,'&quot;<span class="mpd-val">$1</span>&quot;');
  }
  _parseMPDTree(text) {
    const doc=new DOMParser().parseFromString(text,'text/xml');
    const periods=doc.querySelectorAll('Period'), adaptSets=doc.querySelectorAll('AdaptationSet');
    const cp=doc.querySelectorAll('ContentProtection'), mpdEl=doc.querySelector('MPD');
    const type=mpdEl?.getAttribute('type')||'static', dur=mpdEl?.getAttribute('mediaPresentationDuration')||'';
    let html='<div class="az-tree">'+this._treeRoot(`MPEG-DASH MPD (${type}${dur?', '+dur:''})`);
    if(periods.length) html+=this._treeChild('📅',`${periods.length} Period${periods.length>1?'s':''}`);
    adaptSets.forEach(as=>{
      const ct=as.getAttribute('contentType')||as.getAttribute('mimeType')?.split('/')[0]||'unknown', lang=as.getAttribute('lang')||'';
      const icon=ct.includes('video')?'📺':ct.includes('audio')?'🔊':'📝';
      html+=this._treeChild(icon,`${ct}${lang?` [${lang}]`:''}`);
      as.querySelectorAll('Representation').forEach(r=>{
        const bw=r.getAttribute('bandwidth'), w=r.getAttribute('width'), h=r.getAttribute('height'), cod=r.getAttribute('codecs');
        html+=`<div class="az-tree-item az-tree-gc">${w&&h?`<span class="az-pill">${w}×${h}</span>`:''} ${bw?`<span class="az-pill">${Math.round(+bw/1000)} kbps</span>`:''} ${cod?`<span class="az-pill az-pill--dim">${esc(cod)}</span>`:''}</div>`;
      });
    });
    if(cp.length){
      html+=this._treeChild('🔑',`DRM — ${cp.length} ContentProtection block${cp.length>1?'s':''}`);
      const seen=new Set();
      cp.forEach(p=>{ const s=p.getAttribute('schemeIdUri')||''; if(!seen.has(s)){seen.add(s);html+=`<div class="az-tree-item az-tree-gc"><span class="az-pill az-pill--red">${esc(s)}</span></div>`;} });
    }
    return html+'</div>';
  }
  _treeRoot(label) { return `<div class="az-tree-item az-tree-root"><span class="az-tree-icon">📋</span><strong>${esc(label)}</strong></div>`; }
  _treeChild(icon,label) { return `<div class="az-tree-item az-tree-child"><span class="az-tree-icon">${icon}</span><span>${esc(label)}</span></div>`; }

  // ── Buffer Timeline ───────────────────────────────────────────────────────
  _seekFromTimeline(e) {
    if(!this._video||!this._player) return;
    const canvas=this._bufCanvas;
    const rect=canvas.getBoundingClientRect();
    const x=(e.clientX-rect.left)/rect.width;
    const isLive=this._player.isLive();
    let wStart=0, wEnd=this._video.duration||0;
    if(isLive){ try{ wStart=this._video.seekable.start(0); wEnd=this._video.seekable.end(this._video.seekable.length-1); }catch{} }
    const t=wStart+(wEnd-wStart)*x;
    if(isFinite(t)) this._video.currentTime=t;
  }

  _drawBufferTimeline() {
    const canvas=this._bufCanvas;
    if(!canvas||!this._video) return;
    const dpr=window.devicePixelRatio||1;
    const rect=canvas.getBoundingClientRect();
    if(!rect.width||!rect.height) return;
    canvas.width=rect.width*dpr; canvas.height=rect.height*dpr;
    const ctx=canvas.getContext('2d'); ctx.scale(dpr,dpr);
    const W=rect.width, H=rect.height;

    const video=this._video;
    const isLive=this._player?.isLive()??false;
    const dur=video.duration||0;
    const cur=video.currentTime;

    let wStart=0, wEnd=dur>0?dur:cur+60;
    if(isLive){
      try{ wStart=video.seekable.start(0); wEnd=video.seekable.end(video.seekable.length-1); }catch{}
      // Sliding window: show last 120s of live stream
      const WINDOW=120;
      if(wEnd-wStart>WINDOW){ wStart=wEnd-WINDOW; }
    }
    const wDur=Math.max(wEnd-wStart,1);
    const tX=t=>Math.max(0,Math.min(W,((t-wStart)/wDur)*W));
    const BAR_Y=Math.floor(H*0.35), BAR_H=Math.floor(H*0.3);

    // Background
    ctx.fillStyle='#0d0d0f';
    ctx.fillRect(0,0,W,H);

    // Time axis grid lines
    ctx.strokeStyle='rgba(255,255,255,0.05)';
    ctx.lineWidth=1;
    const step=this._niceStep(wDur,8);
    const firstMark=Math.ceil(wStart/step)*step;
    ctx.font=`9px 'Courier New', monospace`;
    ctx.fillStyle='rgba(255,255,255,0.2)';
    for(let t=firstMark; t<=wEnd+0.001; t+=step){
      const x=Math.round(tX(t))+0.5;
      ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke();
      const label=isLive?`-${Math.round(wEnd-t)}s`:fmtTime(t);
      ctx.textAlign='center';
      ctx.fillText(label,x,H-3);
    }

    // Track bar background
    ctx.fillStyle='rgba(255,255,255,0.04)';
    ctx.fillRect(0,BAR_Y,W,BAR_H);

    // Played region
    ctx.fillStyle='rgba(108,99,255,0.2)';
    ctx.fillRect(tX(wStart),BAR_Y,tX(cur)-tX(wStart),BAR_H);

    // Buffered ranges
    const buffered=video.buffered;
    for(let i=0;i<buffered.length;i++){
      const s=buffered.start(i), e2=buffered.end(i);
      const x1=tX(s), x2=tX(e2);
      ctx.fillStyle='rgba(108,99,255,0.6)';
      ctx.fillRect(x1,BAR_Y,Math.max(2,x2-x1),BAR_H);
      // Gap label if there's a gap before this range
      if(i>0){
        const gapStart=buffered.end(i-1), gapEnd=s;
        if(gapEnd-gapStart>0.3){
          const gx=(tX(gapStart)+tX(gapEnd))/2;
          ctx.fillStyle='rgba(224,82,82,0.5)';
          ctx.fillRect(tX(gapStart),BAR_Y,tX(gapEnd)-tX(gapStart),BAR_H);
          ctx.fillStyle='rgba(224,82,82,0.9)';
          ctx.textAlign='center'; ctx.font='9px monospace';
          ctx.fillText('GAP',gx,BAR_Y+BAR_H/2+4);
        }
      }
    }

    // Buffer ahead label
    if(buffered.length>0){
      const bufEnd=buffered.end(buffered.length-1);
      const ahead=Math.max(0,bufEnd-cur);
      if(ahead>0.1){
        const bx=tX(bufEnd);
        ctx.fillStyle='rgba(78,204,163,0.8)';
        ctx.textAlign=bx>W-60?'right':'left';
        ctx.font='10px monospace';
        ctx.fillText(`+${ahead.toFixed(1)}s`,bx+(bx>W-60?-4:4),BAR_Y-4);
      }
    }

    // Current position needle
    const cx=tX(cur);
    const grad=ctx.createLinearGradient(cx,0,cx,H);
    grad.addColorStop(0,'rgba(108,99,255,0)');
    grad.addColorStop(0.3,'rgba(108,99,255,1)');
    grad.addColorStop(0.7,'rgba(108,99,255,1)');
    grad.addColorStop(1,'rgba(108,99,255,0)');
    ctx.fillStyle=grad;
    ctx.fillRect(cx-1,0,2,H);
    // Playhead circle
    ctx.beginPath(); ctx.arc(cx,BAR_Y+BAR_H/2,5,0,Math.PI*2);
    ctx.fillStyle='#6c63ff'; ctx.fill();
    ctx.strokeStyle='#fff'; ctx.lineWidth=1.5; ctx.stroke();
    // Time label above playhead
    ctx.fillStyle='#fff'; ctx.textAlign='center'; ctx.font='bold 10px monospace';
    ctx.fillText(fmtTime(cur),cx,BAR_Y-8);

    // Live edge marker
    if(isLive){
      const lx=tX(wEnd);
      ctx.fillStyle='rgba(224,82,82,0.9)';
      ctx.fillRect(lx-1.5,BAR_Y,3,BAR_H);
      ctx.fillStyle='#e05252'; ctx.textAlign='right'; ctx.font='bold 9px monospace';
      ctx.fillText('● LIVE',lx-4,BAR_Y-4);
    }

    // Seekable range outline
    if(video.seekable.length>0){
      ctx.strokeStyle='rgba(255,255,255,0.15)';
      ctx.lineWidth=1;
      ctx.strokeRect(tX(video.seekable.start(0)),BAR_Y,tX(video.seekable.end(video.seekable.length-1))-tX(video.seekable.start(0)),BAR_H);
    }

    // ── Ad markers + discontinuities overlay ─────────────────────────────
    const markers = this._adMarkers;
    // Ad break regions (cue-out to cue-in pairs)
    let adStart = null;
    for (const m of markers) {
      if (m.type === 'ad-start') { adStart = m.time; }
      if (m.type === 'ad-end' && adStart !== null) {
        const x1 = tX(adStart), x2 = tX(m.time);
        if (x2 > x1) {
          ctx.fillStyle = 'rgba(255,160,51,0.18)';
          ctx.fillRect(x1, 0, x2 - x1, H);
          ctx.strokeStyle = 'rgba(255,160,51,0.5)';
          ctx.lineWidth = 1;
          ctx.setLineDash([]);
          ctx.strokeRect(x1, 0, x2 - x1, H);
          ctx.fillStyle = 'rgba(255,160,51,0.7)';
          ctx.font = 'bold 9px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('AD', (x1 + x2) / 2, 10);
        }
        adStart = null;
      }
    }

    // Individual marker flags
    for (const m of markers) {
      if (m.time < wStart || m.time > wEnd) continue;
      const mx = tX(m.time);

      if (m.type === 'discontinuity') {
        // Red dashed vertical line
        ctx.save();
        ctx.strokeStyle = '#e05252';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(mx, 0); ctx.lineTo(mx, H); ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
        // Label flag
        ctx.fillStyle = '#e05252';
        ctx.font = 'bold 8px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('DISC', mx, H - 4);
      } else if (m.type === 'ad-start') {
        // Orange downward triangle at top
        ctx.fillStyle = '#ffa033';
        ctx.beginPath();
        ctx.moveTo(mx, BAR_Y - 1);
        ctx.lineTo(mx - 5, BAR_Y - 8);
        ctx.lineTo(mx + 5, BAR_Y - 8);
        ctx.closePath(); ctx.fill();
      } else if (m.type === 'ad-end') {
        // Green upward triangle at bottom of bar
        ctx.fillStyle = '#4ecca3';
        ctx.beginPath();
        ctx.moveTo(mx, BAR_Y + BAR_H + 1);
        ctx.lineTo(mx - 5, BAR_Y + BAR_H + 8);
        ctx.lineTo(mx + 5, BAR_Y + BAR_H + 8);
        ctx.closePath(); ctx.fill();
      } else if (m.type === 'scte35') {
        // Purple diamond
        ctx.fillStyle = '#6c63ff';
        ctx.beginPath();
        ctx.moveTo(mx, BAR_Y - 10);
        ctx.lineTo(mx + 4, BAR_Y - 5);
        ctx.lineTo(mx, BAR_Y);
        ctx.lineTo(mx - 4, BAR_Y - 5);
        ctx.closePath(); ctx.fill();
      } else if (m.type === 'period') {
        // Yellow dash
        ctx.strokeStyle = '#ccaa33';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 2]);
        ctx.beginPath(); ctx.moveTo(mx, 0); ctx.lineTo(mx, H); ctx.stroke();
        ctx.setLineDash([]);
      } else if (m.type === 'schedule-gap') {
        // Red-pink hatched region for the gap span
        const gx2 = m.duration > 0 ? tX(m.time + m.duration) : mx + 2;
        ctx.save();
        ctx.fillStyle = 'rgba(255,68,102,0.18)';
        ctx.fillRect(mx, 0, Math.max(2, gx2 - mx), H);
        ctx.strokeStyle = 'rgba(255,68,102,0.7)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(mx, 0, Math.max(2, gx2 - mx), H);
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255,68,102,0.9)';
        ctx.font = 'bold 8px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('GAP', (mx + Math.max(mx + 2, gx2)) / 2, 10);
        ctx.restore();
      }
    }

    // Duration label
    ctx.fillStyle='rgba(255,255,255,0.35)';
    ctx.textAlign='right'; ctx.font='9px monospace';
    ctx.fillText(isLive?'Live Window':fmtTime(dur),W-2,12);

    // Click-to-seek hint
    ctx.fillStyle='rgba(255,255,255,0.1)';
    ctx.textAlign='center'; ctx.font='9px sans-serif';
    ctx.fillText('Click to seek',W/2,H-3);
  }

  _niceStep(range, targetTicks) {
    const raw=range/targetTicks;
    const magnitude=Math.pow(10,Math.floor(Math.log10(raw)));
    const residual=raw/magnitude;
    const nice=residual<1.5?1:residual<3?2:residual<7?5:10;
    return nice*magnitude;
  }

  // ── Charts ────────────────────────────────────────────────────────────────
  _drawCharts() {
    const rot=arr=>{ const i=this._tick%HISTORY_LEN; return [...arr.slice(i),...arr.slice(0,i)]; };
    this._spark(this._charts.bitrate, rot(this._brHist),  '#6c63ff');
    this._spark(this._charts.buffer,  rot(this._bufHist), '#4ecca3');
    this._spark(this._charts.dropped, rot(this._drHist),  '#e05252');
    this._spark(this._charts.latency, rot(this._latHist), '#ffa033');
    const last=arr=>[...arr].reverse().find(v=>v!=null)??null;
    const lbr=last(rot(this._brHist)), lbuf=last(rot(this._bufHist));
    const ldr=last(rot(this._drHist)), llat=last(rot(this._latHist));
    this._set('chart-br-val',  lbr!=null?`${Math.round(lbr)} kbps`:'—');
    this._set('chart-buf-val', lbuf!=null?`${lbuf.toFixed(1)} s`:'—');
    this._set('chart-dr-val',  ldr!=null?String(Math.round(ldr)):'—');
    this._set('chart-lat-val', llat!=null?`${llat.toFixed(1)} s`:'—');
  }

  _spark(canvas,data,color) {
    if(!canvas) return;
    const dpr=window.devicePixelRatio||1;
    const rect=canvas.getBoundingClientRect();
    if(!rect.width) return;
    canvas.width=rect.width*dpr; canvas.height=rect.height*dpr;
    const ctx=canvas.getContext('2d'); ctx.scale(dpr,dpr);
    const W=rect.width, H=rect.height;
    ctx.clearRect(0,0,W,H);
    const pts=data.map(v=>v==null?null:+v);
    const valid=pts.filter(v=>v!=null);
    if(valid.length<2){ ctx.fillStyle='rgba(255,255,255,0.03)'; ctx.fillRect(0,0,W,H); return; }
    const maxV=Math.max(...valid)||1;
    const step=W/(pts.length-1);
    ctx.fillStyle='rgba(255,255,255,0.03)'; ctx.fillRect(0,0,W,H);
    ctx.strokeStyle='rgba(255,255,255,0.05)'; ctx.lineWidth=1;
    [0.25,0.5,0.75].forEach(f=>{ctx.beginPath();ctx.moveTo(0,H*f);ctx.lineTo(W,H*f);ctx.stroke();});
    ctx.beginPath(); let first=true;
    pts.forEach((v,i)=>{ if(v==null){first=true;return;} const x=i*step,y=H-(v/maxV)*(H-6)-3; first?(ctx.moveTo(x,y),first=false):ctx.lineTo(x,y); });
    ctx.strokeStyle=color; ctx.lineWidth=2; ctx.lineJoin='round'; ctx.stroke();
    const lastIdx=pts.length-1-[...pts].reverse().findIndex(v=>v!=null);
    if(lastIdx>=0&&pts[lastIdx]!=null){
      ctx.lineTo(lastIdx*step,H); ctx.lineTo(0,H); ctx.closePath();
      const g=ctx.createLinearGradient(0,0,0,H);
      g.addColorStop(0,color+'55'); g.addColorStop(1,color+'05');
      ctx.fillStyle=g; ctx.fill();
      const v=pts[lastIdx],x=lastIdx*step,y=H-(v/maxV)*(H-6)-3;
      ctx.beginPath();ctx.arc(x,y,3.5,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();
    }
    ctx.font=`9px 'Courier New'`; ctx.fillStyle='rgba(255,255,255,0.25)';
    ctx.textAlign='right'; ctx.fillText(Math.round(maxV),W-2,11);
    ctx.textAlign='left';  ctx.fillText('0',2,H-2);
  }

  // ── Captions / VTT ────────────────────────────────────────────────────────

  // Called by player.js after fetching and parsing a VTT file.
  // raw  = raw VTT text string
  // cues = [{id, startTime, endTime, startStr, endStr, text}]
  // label = human-readable track name
  addVttTrack(raw, cues, label) {
    const idx = this._vttTracks.length;
    this._vttTracks.push({ label: label || `Track ${idx + 1}`, raw, cues });
    this._activeVttIdx = idx;
    this._updateTrackSelector();
    if (this._visible && this._activeTab === 'captions') this._renderCaptionsTab();
  }

  // Called on reset / stop to clear caption state.
  resetCaptions() {
    this._vttTracks = [];
    this._activeVttIdx = 0;
    this._activeCueRow = null;
    this._updateTrackSelector();
    this._renderCaptionsTab();
  }

  // Called on video timeupdate to highlight the active cue.
  updateActiveCue(currentTime) {
    if (!this._vttTracks.length) return;
    const track = this._vttTracks[this._activeVttIdx];
    if (!track) return;

    const cue = track.cues.find(c => currentTime >= c.startTime && currentTime < c.endTime) || null;

    const textEl = document.getElementById('ccCueText');
    const timeEl = document.getElementById('ccCueTime');
    if (!textEl) return;

    if (cue) {
      textEl.textContent = cue.text;
      textEl.classList.add('cc-active');
      timeEl.textContent = `${cue.startStr} → ${cue.endStr}`;
    } else {
      textEl.textContent = '—';
      textEl.classList.remove('cc-active');
      timeEl.textContent = '';
    }

    // Highlight the matching row in the cue table
    if (this._visible && this._activeTab === 'captions') {
      const tbody = document.getElementById('az-cclog');
      if (!tbody) return;
      tbody.querySelectorAll('tr').forEach(r => r.classList.remove('cc-cue-active'));
      if (cue) {
        const row = tbody.querySelector(`tr[data-cue-id="${CSS.escape(cue.id)}"]`);
        if (row) {
          row.classList.add('cc-cue-active');
          if (row !== this._activeCueRow) {
            row.scrollIntoView({ block: 'nearest' });
            this._activeCueRow = row;
          }
        }
      }
    }
  }

  _updateTrackSelector() {
    const sel = document.getElementById('ccTrackSelect');
    if (!sel) return;
    if (!this._vttTracks.length) {
      sel.innerHTML = '<option value="">— no tracks loaded —</option>';
      return;
    }
    sel.innerHTML = this._vttTracks.map((t, i) =>
      `<option value="${i}"${i === this._activeVttIdx ? ' selected' : ''}>${esc(t.label)}</option>`
    ).join('');
  }

  _renderCaptionsTab() {
    const tbody   = document.getElementById('az-cclog');
    const rawEl   = document.getElementById('ccRawVtt');
    const countEl = document.getElementById('ccCueCount');
    if (!tbody) return;

    const track = this._vttTracks[this._activeVttIdx];
    if (!track || !track.cues.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="az-empty">No cues loaded — use the Captions section in the left panel</td></tr>';
      if (rawEl) rawEl.textContent = track?.raw || '— no VTT loaded —';
      if (countEl) countEl.textContent = 'Load a VTT file or stream with embedded subtitles';
      return;
    }

    if (countEl) countEl.textContent = `${track.cues.length} cue${track.cues.length !== 1 ? 's' : ''} · ${esc(track.label)}`;
    if (rawEl) rawEl.textContent = track.raw;

    tbody.innerHTML = track.cues.map(c =>
      `<tr class="mk-row" data-cue-id="${esc(c.id)}">
        <td class="mk-time">${esc(c.startStr)}</td>
        <td class="mk-time">${esc(c.endStr)}</td>
        <td>${esc(c.text)}</td>
      </tr>`
    ).join('');

    // Re-attach click-to-seek on each row
    tbody.querySelectorAll('.mk-row').forEach(row => {
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => {
        if (this._video) this._video.currentTime = parseFloat(row.dataset.start) || 0;
      });
    });
    // Re-set data-start attributes
    track.cues.forEach((c, i) => {
      const row = tbody.querySelectorAll('tr')[i];
      if (row) row.dataset.start = String(c.startTime);
    });
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────
window.streamAnalyzer = new StreamAnalyzer();
