/**
 * Pre-build setup: creates the winCodeSign-2.6.0 cache using the system's
 * Windows SDK signtool.exe and a downloaded rcedit-x64.exe, so electron-builder
 * skips the .7z extraction that fails without symlink privileges on Windows.
 *
 * Run with:  node scripts/setup-build.js
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const WINCOSIGN_VERSION = 'winCodeSign-2.6.0';
const CACHE_BASE = path.join(
  process.env.LOCALAPPDATA || '',
  'electron-builder', 'Cache', 'winCodeSign',
);
const DEST = path.join(CACHE_BASE, WINCOSIGN_VERSION);

// rcedit v2.0.0 — PE resource editor used by electron-builder to stamp version
// info into the Electron binary. Matches what winCodeSign-2.6.0 bundles.
const RCEDIT_URL = 'https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe';

// ── Locate signtool.exe from the highest Windows SDK version ─────────────────
function findSigntool() {
  const kitsBase = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  if (!fs.existsSync(kitsBase)) return null;

  const versions = fs.readdirSync(kitsBase)
    .filter(v => /^\d+\./.test(v))
    .sort((a, b) => {
      const ap = a.split('.').map(Number);
      const bp = b.split('.').map(Number);
      for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
        if ((bp[i] || 0) !== (ap[i] || 0)) return (bp[i] || 0) - (ap[i] || 0);
      }
      return 0;
    });

  for (const v of versions) {
    const p = path.join(kitsBase, v, 'x64', 'signtool.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ── HTTPS download following redirects ───────────────────────────────────────
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    function get(u) {
      https.get(u, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          file.destroy();
          fs.unlinkSync(dest);
          const redir = fs.createWriteStream(dest);
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', err => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    }
    get(url);
  });
}

// ── Properly redirect-following download ─────────────────────────────────────
function downloadFollowRedirects(url, dest) {
  return new Promise((resolve, reject) => {
    function get(u) {
      https.get(u, res => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          res.resume();
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} downloading ${u}`));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      }).on('error', reject);
    }
    get(url);
  });
}

// ── Ensure directory exists ───────────────────────────────────────────────────
function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// ── Write an empty stub file ──────────────────────────────────────────────────
function stub(filePath) {
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '');
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Setting up winCodeSign cache at:', DEST);

  const rceditDest = path.join(DEST, 'rcedit-x64.exe');
  const signtoolDest = path.join(DEST, 'windows', 'x64', 'signtool.exe');

  const alreadyDone = fs.existsSync(rceditDest) &&
                      fs.statSync(rceditDest).size > 1000 &&
                      fs.existsSync(signtoolDest);

  if (alreadyDone) {
    console.log('✓ winCodeSign cache already populated, nothing to do.');
    return;
  }

  mkdirp(DEST);

  // ── 1. rcedit-x64.exe (download from GitHub) ─────────────────────────────
  if (!fs.existsSync(rceditDest) || fs.statSync(rceditDest).size < 1000) {
    process.stdout.write('  Downloading rcedit-x64.exe … ');
    try {
      await downloadFollowRedirects(RCEDIT_URL, rceditDest);
      const size = fs.statSync(rceditDest).size;
      console.log(`done (${(size / 1024).toFixed(0)} KB)`);
    } catch (err) {
      console.log('FAILED:', err.message);
      console.warn('  ⚠ rcedit download failed. Build may fail if version stamping is required.');
      stub(rceditDest);
    }
  } else {
    console.log('✓ rcedit-x64.exe already present');
  }

  // ── 2. signtool.exe (from Windows SDK) ───────────────────────────────────
  const winDir = path.join(DEST, 'windows', 'x64');
  mkdirp(winDir);

  const signtoolSrc = findSigntool();
  if (signtoolSrc) {
    fs.copyFileSync(signtoolSrc, signtoolDest);
    console.log('✓ Copied signtool.exe from', signtoolSrc);
  } else {
    stub(signtoolDest);
    console.warn('⚠ signtool.exe not found — install Windows 10 SDK for code signing');
  }

  // ── 3. macOS stubs (normally symlinks — just need to exist) ───────────────
  const darwinLib = path.join(DEST, 'darwin', '10.12', 'lib');
  mkdirp(darwinLib);
  for (const f of ['libcrypto.0.9.8.dylib', 'libcrypto.dylib', 'libssl.0.9.8.dylib', 'libssl.dylib']) {
    stub(path.join(darwinLib, f));
  }
  console.log('✓ Created macOS stub dylibs');

  // ── 4. Linux stubs ────────────────────────────────────────────────────────
  mkdirp(path.join(DEST, 'linux'));
  stub(path.join(DEST, 'linux', '.keep'));
  console.log('✓ Created Linux stub');

  console.log('\n✅ winCodeSign cache ready.');
}

main().catch(err => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
