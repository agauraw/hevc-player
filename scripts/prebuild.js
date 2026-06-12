'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT     = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'renderer');

function copy(src, dst, label) {
  if (!fs.existsSync(src)) { console.warn(`  skip (not found): ${label}`); return; }
  fs.copyFileSync(src, dst);
  const kb = Math.round(fs.statSync(dst).size / 1024);
  console.log(`✓ ${label}  (${kb} KB)  →  renderer/`);
}

// shaka-player compiled bundle — keeps node_modules/ out of resources.neu
copy(
  path.join(ROOT, 'node_modules', 'shaka-player', 'dist', 'shaka-player.compiled.js'),
  path.join(RENDERER, 'shaka-player.compiled.js'),
  'shaka-player.compiled.js'
);

// App icon — renderer/ is the Neutralino resourcesPath, so icons go here
copy(
  path.join(ROOT, 'assets', 'icon.png'),
  path.join(RENDERER, 'icon.png'),
  'icon.png'
);
