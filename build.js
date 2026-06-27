#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');

const SRC  = path.join(__dirname, 'renderer');
const DIST = path.join(__dirname, 'dist');

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

// Clean dist
if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true, force: true });

console.log('Building Stream Analyser...');
copyDir(SRC, DIST);

const files = fs.readdirSync(DIST);
console.log(`Done — ${files.length} files copied to dist/`);
console.log('Run: node server.js   (or: npm start)');
