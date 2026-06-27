# Stream Analyser

A browser-based professional video stream analyser and player for **HLS**, **MPEG-DASH**, **CMAF**, **HEVC**, **AV1**, and **Widevine DRM** streams, built on [Shaka Player 4.x](https://github.com/shaka-project/shaka-player).

---

## Features

### Playback
- **HLS** (`.m3u8`) — VOD, Live, Low-Latency HLS
- **MPEG-DASH** (`.mpd`) — VOD, Live, CMAF chunks
- **Container formats** — MPEG-TS, fMP4 / CMAF
- **Video codecs** — HEVC / H.265, AV1, H.264 / AVC
- **Adaptive Bitrate** — automatic quality switching via Shaka ABR
- **Local file playback** — open `.m3u8`, `.mpd`, `.mp4`, `.ts` from disk
- **Quality, audio track, and subtitle selectors** in the player controls

### DRM
- **Widevine** EME (via Chromium / Electron)
- Custom license server URL, request headers, base64 request body override
- Widevine robustness level selector (`SW_SECURE_CRYPTO` → `HW_SECURE_ALL`)
- **⚡ Test License Server** button — sends a live connectivity probe with your configured headers

### Captions & Subtitles
- Load external **WebVTT** caption tracks (URL or local file)
- In-stream embedded subtitle track selector
- Live active-cue display and full cue timeline in the Captions analysis tab

---

## Stream Analysis Panel

Click **⊹ Analyze** in the header to open the resizable analysis panel (drag the top edge to resize). Ten analysis tabs are available:

| Tab | What it shows |
|-----|---------------|
| **Overview** | Codec, resolution, FPS, bitrates, container, buffer ahead, live latency, DRM key status |
| **Buffer** | Visual buffer timeline — buffered ranges, gaps, live-edge needle; **click to seek** |
| **Events** | Timestamped log of all player and video element events (filterable by category) |
| **Markers** | SCTE-35, `EXT-X-CUE-OUT/IN`, `EXT-X-DISCONTINUITY`, `DATERANGE`, timeline regions |
| **Manifest** | Raw master + child manifest viewer, HLS tree parser, tag browser, mismatch detector |
| **Tracks** | Video variant table (resolution, FPS, codec, bitrate, HDR), audio & subtitle tracks |
| **Network** | Full request log — manifest, segment, license, key requests with size and timing |
| **Charts** | Live 120-second graphs: bitrate, buffer depth, dropped frames/s, live latency |
| **Audio** | Real-time L/R VU meter + oscilloscope waveform with dBFS scale |
| **Captions** | Active cue display, full cue timeline table, raw VTT source view |

---

## Audio Analysis

### Player Overlay VU Meter
A compact **L / R level meter** floats at the bottom-right of the video, active as soon as a stream loads (no need to open the Audio tab). It uses the Web Audio API to tap the stream's audio graph non-destructively — audio continues to play normally.

### Audio Tab — VU Meter + Waveform
- **Left pane** — vertical L/R bars with green → yellow → orange → red gradient, 2-second peak-hold notch, and clip flash (≥ 0 dBFS)
- **Right pane** — dual-channel **oscilloscope waveform**: L (purple) on top, R (teal) below, with a 28 px dBFS ruler (0 / −6 / −12 / −18 / −24 dBFS grid lines and labels, −∞ centre line)
- **Stats bar** — live RMS dB, peak-hold dB for L and R, CLIP indicators, Reset Peak button

---

## Manifest Inspector & Mismatch Detection

### Fetch and Browse
1. Open the **Manifest** tab and click **⟳ Fetch / Refresh** to retrieve and parse the master manifest
2. Click **⬇ All Children** to fetch every variant / audio / subtitle child playlist in parallel
3. Use the dropdown to view any individual child, or **⊞ View All** for a side-by-side grid
4. **🏷 Tags** opens a structured browser of every HLS/DASH tag in the selected manifest

### Child Mismatch Report
After fetching all children, the analyser runs **10 automatic checks** and shows an **⚡ Mismatches N** button if issues are found:

| # | Check | Severity |
|---|-------|----------|
| 1 | `EXT-X-TARGETDURATION` differs across variants | ERROR |
| 2 | `EXT-X-TARGETDURATION` missing from any variant | ERROR |
| 3 | `EXT-X-VERSION` differs | WARNING |
| 4 | Total VOD duration spread > 0.5 s | WARNING |
| 5 | Segment count differs across VOD variants | WARNING |
| 6 | Any `EXTINF` duration exceeds `TARGETDURATION` | ERROR |
| 7 | Mixed clear + encrypted variants, or differing encryption methods | ERROR / WARNING |
| 8 | `EXT-X-PLAYLIST-TYPE` inconsistent across variants | WARNING |
| 9 | `EXT-X-ENDLIST` present on some variants but missing on others | WARNING |
| 10 | Mixed codec families (`HEVC`, `AV1`, `H.264`) in master `CODECS=` | WARNING |

Each reported issue shows the severity badge, a plain-English description, and per-variant value pills — differing values are highlighted amber.

---

## Ad / SCTE-35 Marker Detection

The **Markers** tab detects and displays all ad-signalling events in the stream:

- `EXT-X-CUE-OUT` / `EXT-X-CUE-IN` — ad break start and end
- `EXT-X-SCTE35` — full SCTE-35 binary splice_info_section decoded (command type, break duration, avail/expected counts, UPID, tracking URLs)
- `EXT-X-DISCONTINUITY` — encoding discontinuities
- `EXT-X-DATERANGE` — Apple DATERANGE ad markers
- `EXT-X-PROGRAM-DATE-TIME` — wall-clock anchors
- DASH `EventStream` timeline regions (from Shaka events)

A live **Ad Break Monitor** banner appears during an active break showing elapsed / remaining time, a progress bar, slot sequence pills, SCTE-35 metadata, and any tracking URLs from segmentation descriptors.

---

## Multi-Stream Playback (Ladder View)

Click **▶ Play All** in the Manifest tab (after fetching children) to open a grid of every variant playing simultaneously:

- Automatic grid layout (1 → 2 → 3 → 4 columns based on stream count)
- **Per-cell audio controls** — hover any cell to reveal a 🔇/🔊 mute toggle and volume slider; per-cell state is independent of the global Mute All button
- **Per-cell L/R VU meter** — a compact 26 × 64 px level indicator in the top-right corner of each cell, powered by a single shared `AudioContext` for the entire grid (avoids the browser's ~6-context limit)
- **⏸ Pause All / ▶ Play All / ⟳ Sync** global controls in the header bar

---

## Built-in Test Streams

The **Source** panel includes 20+ preset streams across categories:

- HLS VOD & Live (Mux, Shaka, Bitmovin, Unified, Akamai)
- MPEG-DASH VOD & Live (DASHIF, Akamai, Axinom)
- Widevine DRM
- HEVC / H.265
- SCTE-35 / Ad markers (DASHIF EventStream, HLS ID3, Apple DATERANGE, Akamai SSAI)
- `EXT-X-DISCONTINUITY` test streams (Apple BipBop, Akamai ad-stitched VOD)

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Player engine | [Shaka Player 4.x](https://github.com/shaka-project/shaka-player) |
| DRM | Widevine via Chromium EME |
| Audio analysis | Web Audio API (`AudioContext`, `AnalyserNode`, `ChannelSplitterNode`) |
| Visualisation | HTML5 Canvas 2D |
| SCTE-35 decoding | Built-in binary decoder (`admarkers.js`) |
| Runtime | Electron / Browser |

---

## Running

### Development
```bash
npm run dev
# → http://localhost:8080  (live-serve, no build step)
```

Or open `renderer/index.html` directly in Chromium.

### Production server
```bash
npm run build     # copies renderer/ → dist/
npm start         # Node.js static server → http://localhost:8080
PORT=3000 npm start  # custom port
```

`server.js` serves from `dist/` if it exists, otherwise falls back to `renderer/` directly.

---

## Project Structure

```
renderer/
├── index.html       # Application shell and all tab/panel HTML
├── styles.css       # Full UI stylesheet (CSS custom properties, dark theme)
├── player.js        # Shaka Player init, stream loading, UI event bindings
├── analyzer.js      # StreamAnalyzer class — all analysis tabs, audio, mismatch detection
└── admarkers.js     # HLS/DASH marker parser + SCTE-35 binary decoder
```

---

## Author

**Gauraw** — gauraw2004amit@gmail.com  
© 2026 Gauraw. All rights reserved.
