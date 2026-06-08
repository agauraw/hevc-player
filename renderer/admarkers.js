'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// SCTE-35 binary decoder
// Handles base64-encoded splice_info_section from HLS tags and DASH EventStreams.
// ─────────────────────────────────────────────────────────────────────────────
class SCTE35Decoder {
  static decode(base64OrHex) {
    try {
      let buf;
      if (/^[0-9A-Fa-f]+$/.test(base64OrHex.replace(/^0x/i, ''))) {
        // Hex string (e.g. from EXT-X-DATERANGE:SCTE35-OUT=0xFC...)
        const hex = base64OrHex.replace(/^0x/i, '');
        buf = new Uint8Array(hex.match(/../g).map(h => parseInt(h, 16)));
      } else {
        // Base64
        const bin = atob(base64OrHex.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, ''));
        buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      }
      return this._parseSpliceInfo(buf);
    } catch (e) {
      return { error: e.message };
    }
  }

  static _parseSpliceInfo(buf) {
    if (!buf || buf.length < 11) return { error: 'Too short' };
    if (buf[0] !== 0xFC) return { error: `Bad table_id: 0x${buf[0].toString(16)}` };

    let off = 4; // skip table_id(1) + flags(1) + section_length(2) ... adjusting:
    // Actual layout: table_id(1), section_syntax_indicator+private+reserved+section_length(3),
    // protocol_version(1), encrypted_packet+encryption_algorithm+pts_adjustment(6 bytes total)
    off = 4;
    // protocol_version
    const protocol = buf[off++];
    // encrypted_packet(1) + encryption_algorithm(6) + pts_adjustment(33bits = next 5 bytes overlapping)
    const encByte = buf[off];
    const encrypted = !!(encByte >> 7);
    const ptsAdj = this._read33(buf, off + 1);
    off += 6; // encrypted+algo byte + 5 bytes pts_adjustment (overlap: first bit already consumed)

    // Actually let's redo this more carefully
    // splice_info_section structure after table_id (0xFC):
    off = 1; // after table_id
    // section_syntax_indicator(1b) + private_indicator(1b) + reserved(2b) + section_length(12b) = 2 bytes
    const sectionLength = ((buf[off] & 0x0F) << 8) | buf[off+1];
    off += 2;
    // protocol_version(8b)
    off++; // skip
    // encrypted_packet(1b) + encryption_algorithm(6b) + pts_adjustment high bit(1b)... = 1 byte
    const encAlgo = buf[off++];
    const encFlag = !!(encAlgo >> 7);
    // pts_adjustment: remaining 32 bits after the 1-bit already consumed above
    // Actually pts_adjustment is 33 bits. The layout is:
    // [encrypted_packet(1)][encryption_algorithm(6)][pts_adjustment(33)] = overlapping across bytes
    // Simpler: treat the 5 bytes starting at current offset as pts_adjustment (33 bits)
    const ptsAdjustment = this._read33bits(buf, off - 1) & 0x1FFFFFFFF;
    off += 4; // consumed 4 more (1 already consumed above = 5 total for 33 bits)

    // cw_index(8), tier(12), splice_command_length(12), splice_command_type(8)
    if (off >= buf.length) return { error: 'Truncated', encrypted: encFlag };
    off++; // cw_index
    if (off + 1 >= buf.length) return { error: 'Truncated', encrypted: encFlag };
    // tier(12) + splice_command_length(12) = 3 bytes
    const spliceCommandLength = ((buf[off + 1] & 0x0F) << 8) | buf[off + 2];
    off += 3;
    const spliceCommandType = buf[off++];

    const result = {
      encrypted: encFlag,
      ptsAdjustmentSecs: (ptsAdjustment / 90000).toFixed(3),
      spliceCommandType: `0x${spliceCommandType.toString(16).toUpperCase()}`,
      spliceCommandTypeName: this._cmdName(spliceCommandType),
    };

    if (!encFlag) {
      if (spliceCommandType === 0x05) Object.assign(result, this._spliceInsert(buf, off));
      else if (spliceCommandType === 0x06) Object.assign(result, this._timeSignal(buf, off));
    }

    return result;
  }

  static _spliceInsert(buf, off) {
    if (off + 4 >= buf.length) return {};
    const eventId = this._read32(buf, off); off += 4;
    if (off >= buf.length) return { spliceEventId: eventId };
    const cancel = !!(buf[off] >> 7);
    const res = { spliceEventId: eventId, spliceEventCancelled: cancel };
    if (!cancel) {
      const flags = buf[off + 1] || 0;
      res.outOfNetwork  = !!(flags >> 7);
      const progSplice  = !!(flags & 0x40);
      const durFlag     = !!(flags & 0x20);
      const immediate   = !!(flags & 0x10);
      off += 2;
      if (progSplice && !immediate && off + 5 <= buf.length) {
        const { time, specified } = this._spliceTime(buf, off);
        if (specified) res.spliceTimeSecs = (time / 90000).toFixed(3);
        off += 5;
      }
      if (durFlag && off + 5 <= buf.length) {
        const autoReturn = !!(buf[off] >> 7);
        const dur = this._read33bits(buf, off) & 0x1FFFFFFFF;
        res.breakDurationSecs = (dur / 90000).toFixed(1);
        res.autoReturn = autoReturn;
        off += 5;
      }
      if (off + 2 <= buf.length) res.uniqueProgramId = this._read16(buf, off);
      off += 4; // unique_program_id(2) + avail_num(1) + avails_expected(1)
      if (off - 2 + 2 <= buf.length) {
        res.availNum       = buf[off - 2];
        res.availsExpected = buf[off - 1];
      }
    }
    return res;
  }

  static _timeSignal(buf, off) {
    const { time, specified } = this._spliceTime(buf, off);
    return specified ? { timeSignalPts: (time / 90000).toFixed(3) } : {};
  }

  static _spliceTime(buf, off) {
    if (off >= buf.length) return { specified: false };
    const timeSpec = !!(buf[off] >> 7);
    if (timeSpec && off + 5 <= buf.length) {
      const pts = this._read33bits(buf, off) & 0x1FFFFFFFF;
      return { time: pts, specified: true };
    }
    return { time: 0, specified: false };
  }

  // ── Splice Descriptor loop ────────────────────────────────────────────────
  // Called after the splice command with remaining buffer bytes.
  // Returns an array of decoded descriptors.
  static parseDescriptors(buf, off) {
    const descriptors = [];
    if (off + 2 > buf.length) return descriptors;
    const loopLen = this._read16(buf, off); off += 2;
    const end = Math.min(off + loopLen, buf.length);

    while (off + 2 <= end) {
      const tag = buf[off++];
      const len = buf[off++];
      const dEnd = Math.min(off + len, end);

      if (off + 4 <= dEnd) {
        const id = this._read32(buf, off); // should be 0x43554549 = "CUEI"
        const isStandard = id === 0x43554549;
        const dOff = off + 4;

        if (tag === 0x02 && isStandard) {
          // segmentation_descriptor
          const seg = this._segmentationDescriptor(buf, dOff, dEnd);
          if (seg) descriptors.push({ tag: 0x02, name: 'segmentation_descriptor', ...seg });
        } else if (tag === 0x00 && isStandard) {
          // avail_descriptor — provider_avail_id (32 bits)
          if (dOff + 4 <= dEnd) {
            descriptors.push({ tag: 0x00, name: 'avail_descriptor', providerAvailId: this._read32(buf, dOff) });
          }
        } else if (tag === 0x03 && isStandard) {
          // time_descriptor — TAI seconds (48 bits) + nanoseconds (32 bits) + UTC offset (16 bits)
          descriptors.push({ tag: 0x03, name: 'time_descriptor' });
        }
      }
      off = dEnd;
    }
    return descriptors;
  }

  static _segmentationDescriptor(buf, off, end) {
    if (off + 5 > end) return null;
    const eventId = this._read32(buf, off); off += 4;
    const cancel  = !!(buf[off] >> 7); off++;
    if (cancel) return { segmentationEventId: eventId, cancelled: true };

    const flags0 = buf[off++];
    const programSeg       = !!(flags0 & 0x80);
    const hasDuration      = !!(flags0 & 0x40);
    const deliveryUnrestr  = !!(flags0 & 0x20);
    let webDeliveryAllowed = true;

    if (!deliveryUnrestr) {
      webDeliveryAllowed = !!(flags0 & 0x10);
      off++; // skip delivery restriction byte
    }

    // Component loop (skip if program_segmentation_flag)
    if (!programSeg && off < end) {
      const compCount = buf[off++];
      off += compCount * 6;
    }

    let durationSecs = null;
    if (hasDuration && off + 5 <= end) {
      const durTicks = this._read33bits(buf, off) & 0x1FFFFFFFF; off += 5;
      durationSecs = (durTicks / 90000).toFixed(1);
    }

    // UPID
    if (off + 2 > end) return { segmentationEventId: eventId, hasDuration, durationSecs };
    const upidType   = buf[off++];
    const upidLength = buf[off++];
    const upidBytes  = buf.slice(off, Math.min(off + upidLength, end));
    off += upidLength;

    const upid = this._decodeUpid(upidType, upidBytes);

    // Segmentation type, segment num
    let segTypeId = null, segNum = null, segsExpected = null;
    if (off + 3 <= end) {
      segTypeId    = buf[off++];
      segNum       = buf[off++];
      segsExpected = buf[off++];
    }

    return {
      segmentationEventId: eventId,
      durationSecs,
      webDeliveryAllowed,
      upidType: `0x${upidType.toString(16).padStart(2,'0')}`,
      upidTypeName: UPID_NAMES[upidType] || 'unknown',
      upid: upid.value,
      upidIsUrl: upid.isUrl,
      trackingUrl: upid.isUrl ? upid.value : null,
      segmentationTypeId:   segTypeId   != null ? `0x${segTypeId.toString(16).padStart(2,'0')}`   : null,
      segmentationTypeName: segTypeId   != null ? (SEG_TYPE_NAMES[segTypeId] || 'unknown') : null,
      segmentNum:           segNum,
      segmentsExpected:     segsExpected,
    };
  }

  static _decodeUpid(type, bytes) {
    const textDecoder = new TextDecoder('utf-8');
    // URI (0x0F) and ADI (0x09) and ADS (0x0E) carry text/URLs
    if ([0x09, 0x0E, 0x0F].includes(type)) {
      try {
        const str = textDecoder.decode(bytes).replace(/\0/g, '');
        const isUrl = /^https?:\/\//i.test(str) || str.startsWith('urn:');
        return { value: str, isUrl };
      } catch { return { value: '(decode error)', isUrl: false }; }
    }
    // Ad-ID / ISCI (0x03, 0x02) — ASCII
    if ([0x02, 0x03, 0x07].includes(type)) {
      try { return { value: textDecoder.decode(bytes).replace(/\0/g,''), isUrl: false }; } catch {}
    }
    // UUID (0x10) — 16 bytes → hex with dashes
    if (type === 0x10 && bytes.length === 16) {
      const h = Array.from(bytes).map(b => b.toString(16).padStart(2,'0')).join('');
      return { value: `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`, isUrl: false };
    }
    // Fallback: hex
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2,'0')).join('');
    return { value: `0x${hex}`, isUrl: false };
  }

  static _read33bits(buf, off) {
    return ((buf[off] & 0x01) * 0x100000000) + (buf[off+1] << 24 >>> 0) + (buf[off+2] << 16) + (buf[off+3] << 8) + buf[off+4];
  }
  static _read32(buf, off) { return ((buf[off] << 24) >>> 0) + (buf[off+1] << 16) + (buf[off+2] << 8) + buf[off+3]; }
  static _read16(buf, off) { return (buf[off] << 8) + buf[off+1]; }
  static _cmdName(t) {
    return { 0x00:'splice_null', 0x04:'splice_schedule', 0x05:'splice_insert', 0x06:'time_signal', 0xFF:'bandwidth_reservation' }[t] || `unknown`;
  }
}

// ── Lookup tables ─────────────────────────────────────────────────────────────
const UPID_NAMES = {
  0x00:'Not Used', 0x01:'User Defined', 0x02:'ISCI', 0x03:'Ad-ID', 0x04:'UMID',
  0x05:'ISAN (deprecated)', 0x06:'ISAN', 0x07:'TID', 0x08:'AiringID',
  0x09:'ADI', 0x0A:'EIDR', 0x0B:'ATSC Content ID', 0x0C:'MPU', 0x0D:'MID',
  0x0E:'ADS Info', 0x0F:'URI', 0x10:'UUID', 0x11:'SCR',
};
const SEG_TYPE_NAMES = {
  0x10:'Program Start', 0x11:'Program End', 0x12:'Program Early Termination',
  0x13:'Program Breakaway', 0x14:'Program Resumption',
  0x20:'Chapter Start', 0x21:'Chapter End',
  0x22:'Break Start', 0x23:'Break End',
  0x30:'Provider Ad Start', 0x31:'Provider Ad End',
  0x32:'Distributor Ad Start', 0x33:'Distributor Ad End',
  0x34:'Provider POI Start', 0x35:'Provider POI End',
  0x36:'Distributor POI Start', 0x37:'Distributor POI End',
  0x40:'Unscheduled Event Start', 0x41:'Unscheduled Event End',
  0x50:'Network Start', 0x51:'Network End',
};

// ─────────────────────────────────────────────────────────────────────────────
// HLS media playlist parser — extracts ad cues, discontinuities, SCTE-35
// ─────────────────────────────────────────────────────────────────────────────
function parseHLSMarkers(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const markers = [];
  let currentTime = 0;
  let inAdBreak = false;
  let adBreakStart = 0;
  let discCount = 0;
  let pendingSegDur = 0;

  const tryScte35 = (line) => {
    const b64 = line.match(/(?:CUE-OUT=|CUE-IN=|DATA=|:)([A-Za-z0-9+/=]{20,})/)?.[1];
    if (!b64) return null;
    try { return SCTE35Decoder.decode(b64); } catch { return null; }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Segment duration — advances the clock
    if (line.startsWith('#EXTINF:')) {
      const m = line.match(/#EXTINF:([\d.]+)/);
      pendingSegDur = m ? parseFloat(m[1]) : 0;
      currentTime += pendingSegDur;
      continue;
    }

    if (line.startsWith('#EXT-X-DISCONTINUITY') && !line.includes('-SEQUENCE')) {
      discCount++;
      markers.push({ type: 'discontinuity', time: currentTime, duration: 0,
        label: `Discontinuity #${discCount}`, raw: line, discIndex: discCount });
      continue;
    }

    if (line.startsWith('#EXT-X-CUE-OUT')) {
      const dm = line.match(/(?::|DURATION=)([\d.]+)/i);
      const dur = dm ? parseFloat(dm[1]) : 0;
      inAdBreak = true; adBreakStart = currentTime;
      const scte35 = tryScte35(lines[i + 1] || '');
      markers.push({ type: 'ad-start', time: currentTime, duration: dur,
        label: `Ad Break${dur ? ` (${dur}s)` : ''}`, raw: line, scte35 });
      continue;
    }

    if (line.startsWith('#EXT-X-CUE-IN')) {
      inAdBreak = false;
      const dur = +(currentTime - adBreakStart).toFixed(3);
      const scte35 = tryScte35(lines[i + 1] || '');
      markers.push({ type: 'ad-end', time: currentTime, duration: 0,
        adBreakDuration: dur, label: `Ad Break End (after ${dur}s)`, raw: line, scte35 });
      continue;
    }

    if (line.startsWith('#EXT-X-SCTE35:') || line.startsWith('#EXT-X-OATCLS-SCTE35:')) {
      const scte35 = tryScte35(line);
      markers.push({ type: 'scte35', time: currentTime, duration: scte35?.breakDurationSecs ? +scte35.breakDurationSecs : 0,
        label: `SCTE-35 ${scte35?.spliceCommandTypeName || ''}`.trim(), raw: line, scte35 });
      continue;
    }

    if (line.startsWith('#EXT-X-DATERANGE:')) {
      const id    = line.match(/ID="([^"]+)"/)?.[1] || '';
      const cls   = line.match(/CLASS="([^"]+)"/)?.[1] || '';
      const dur   = line.match(/DURATION=([\d.]+)/)?.[1];
      const sd    = line.match(/START-DATE="([^"]+)"/)?.[1];
      const hexOut = line.match(/SCTE35-OUT=(?:0x)?([0-9A-Fa-f]{6,})/)?.[1];
      let scte35 = null;
      if (hexOut) { try { scte35 = SCTE35Decoder.decode(hexOut); } catch {} }
      markers.push({ type: 'daterange', time: currentTime,
        duration: dur ? parseFloat(dur) : 0,
        label: `DATERANGE${id ? ` [${id}]` : ''}${cls ? ` · ${cls}` : ''}`,
        raw: line, scte35, startDate: sd });
      continue;
    }

    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      markers.push({ type: 'pdt', time: currentTime, duration: 0,
        label: 'Program Date-Time', raw: line, dateTime: line.split(':').slice(1).join(':') });
    }
  }

  return { markers };
}

// ─────────────────────────────────────────────────────────────────────────────
// DASH MPD parser — extracts EventStream ad events and Period boundaries
// ─────────────────────────────────────────────────────────────────────────────
function parseDASHMarkers(text) {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  const markers = [];

  doc.querySelectorAll('EventStream').forEach(es => {
    const scheme    = es.getAttribute('schemeIdUri') || '';
    const timescale = parseInt(es.getAttribute('timescale') || '1', 10);
    const isScte35  = /scte35|splice/i.test(scheme);

    es.querySelectorAll('Event').forEach(evt => {
      const id  = evt.getAttribute('id') || '';
      const pt  = parseInt(evt.getAttribute('presentationTime') || '0', 10);
      const dur = parseInt(evt.getAttribute('duration') || '0', 10);
      const raw = evt.textContent?.trim().replace(/\s+/g, '');
      let scte35 = null;
      if (isScte35 && raw) { try { scte35 = SCTE35Decoder.decode(raw); } catch {} }
      markers.push({
        type: isScte35 ? 'scte35' : 'event',
        time:     pt / timescale,
        duration: dur / timescale,
        label: `${isScte35 ? 'SCTE-35' : 'Event'} [${scheme.split(':').pop()}]${id ? ` id=${id}` : ''}`,
        raw: `<Event pt="${(pt/timescale).toFixed(2)}s" dur="${(dur/timescale).toFixed(2)}s" scheme="${scheme}">`,
        scte35, scheme,
      });
    });
  });

  // Period boundaries (ad pod insertion points)
  const periods = doc.querySelectorAll('Period');
  periods.forEach((p, idx) => {
    if (idx === 0) return;
    const start = p.getAttribute('start') || '';
    const startS = parseDuration(start);
    markers.push({ type: 'period', time: startS, duration: 0,
      label: `Period ${idx + 1}${start ? ` @ ${start}` : ''}`,
      raw: `<Period id="${p.getAttribute('id') || ''}" start="${start}">` });
  });

  markers.sort((a, b) => a.time - b.time);
  return { markers };
}

function parseDuration(iso) {
  if (!iso || !iso.startsWith('P')) return parseFloat(iso) || 0;
  const m = iso.match(/(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
  return !m ? 0 : (+(m[1]||0)*3600) + (+(m[2]||0)*60) + +(m[3]||0);
}

// ── Exports ───────────────────────────────────────────────────────────────────
window.AdMarkers = { SCTE35Decoder, parseHLSMarkers, parseDASHMarkers };
