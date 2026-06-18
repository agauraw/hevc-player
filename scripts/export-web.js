'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT  = path.join(ROOT, 'web-dist');

// ── Clean output directory ────────────────────────────────────────────────────
if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true });
fs.mkdirSync(OUT);

function cp(src, dst, label) {
  fs.copyFileSync(src, dst);
  const kb = Math.round(fs.statSync(dst).size / 1024);
  console.log(`  ✓ ${label.padEnd(35)} ${kb} KB`);
}

console.log('\nExporting web version → web-dist/\n');

// ── App source files ──────────────────────────────────────────────────────────
for (const f of ['styles.css', 'admarkers.js', 'analyzer.js', 'player.js']) {
  cp(path.join(ROOT, 'renderer', f), path.join(OUT, f), f);
}

// ── Shaka Player ──────────────────────────────────────────────────────────────
cp(
  path.join(ROOT, 'node_modules', 'shaka-player', 'dist', 'shaka-player.compiled.js'),
  path.join(OUT, 'shaka-player.compiled.js'),
  'shaka-player.compiled.js'
);

// ── Web bridge (replaces Neutralino bridge.js) ────────────────────────────────
cp(
  path.join(ROOT, 'renderer', 'web-bridge.js'),
  path.join(OUT, 'web-bridge.js'),
  'web-bridge.js'
);

// ── index.html — patch for browser environment ────────────────────────────────
let html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');

// Remove Neutralino globals script (not available in browser)
html = html.replace(/<script src="\/__neutralino_globals\.js"><\/script>\r?\n?/g, '');

// Swap Neutralino bridge for web bridge
html = html.replace('<script src="bridge.js"></script>', '<script src="web-bridge.js"></script>');

// Hide native window controls (minimize/maximize/close don't apply in browser)
html = html.replace(
  '</head>',
  '  <style>.wc-btn{display:none!important}</style>\n</head>'
);

fs.writeFileSync(path.join(OUT, 'index.html'), html);
console.log(`  ✓ ${'index.html (patched)'.padEnd(35)} ${Math.round(Buffer.byteLength(html)/1024)} KB`);

// ── player.js — patch blob URL handling for browser file picker ───────────────
let player = fs.readFileSync(path.join(OUT, 'player.js'), 'utf8');
player = player.replace(
  "if (fp) streamUrlEl.value = `file:///${fp.replace(/\\\\/g, '/')}`;",
  "if (fp) streamUrlEl.value = (fp.startsWith('blob:') || fp.startsWith('http')) ? fp : `file:///${fp.replace(/\\\\/g, '/')}`;",
);
fs.writeFileSync(path.join(OUT, 'player.js'), player);

// ── Size summary ──────────────────────────────────────────────────────────────
const totalKB = fs.readdirSync(OUT).reduce((sum, f) => {
  return sum + fs.statSync(path.join(OUT, f)).size;
}, 0) / 1024;

console.log(`\n  Total: ${totalKB.toFixed(0)} KB  (${(totalKB/1024).toFixed(2)} MB)`);
console.log('\n  Serve with any static file server, e.g.:');
console.log('    npx serve web-dist');
console.log('    python -m http.server --directory web-dist\n');
