#!/usr/bin/env node
// Bundles the emulator, the assembler, the ROM sources and the UI into one
// self-contained HTML file that runs from file:// with no server and no network.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { assemble } from '../src/asm.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

// The modules share one <script> scope once bundled, so the ESM plumbing goes away.
const inline = (src) => src
  .replace(/^import\s[^;]*;\s*$/gm, '')
  .replace(/^export\s+(?=(class|function|const|let)\b)/gm, '')
  .trimEnd();

const TITLES = {
  bounce: ['Bouncing ball', 'The simplest example - start here.'],
  maze:   ['Maze', 'A random pattern from one RND. Turn on "DXYN waits for the frame" and watch it draw.'],
  snake:  ['Snake', 'Steer with 2 4 6 8 (W A D X).'],
  pong:   ['Pong', 'Paddle: 2 up, 8 down (W / X).'],
};
const ORDER = ['bounce', 'maze', 'snake', 'pong'];

const roms = {};
for (const file of readdirSync(join(ROOT, 'roms')).filter((f) => f.endsWith('.c8asm'))) {
  const id = basename(file, '.c8asm');
  const source = read('roms', file);
  const { bytes } = assemble(source); // fail the build rather than ship a broken ROM
  const [title, hint] = TITLES[id] ?? [id, ''];
  roms[id] = { title, hint, source, size: bytes.length };
}
const rank = (id) => (ORDER.indexOf(id) < 0 ? ORDER.length : ORDER.indexOf(id));
const ordered = Object.fromEntries(
  Object.keys(roms).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((id) => [id, { title: roms[id].title, hint: roms[id].hint, source: roms[id].source }])
);

const html = read('web', 'studio.html')
  .replace('/*__CORE__*/', () => inline(read('src', 'chip8.js')) + '\n\n' + inline(read('src', 'asm.js')))
  .replace('/*__ROMS__*/', () => 'const ROMS = ' + JSON.stringify(ordered, null, 1) + ';');

mkdirSync(join(ROOT, 'dist'), { recursive: true });
writeFileSync(join(ROOT, 'dist', 'studio.html'), html);

for (const [id, rom] of Object.entries(roms)) {
  writeFileSync(join(ROOT, 'dist', id + '.ch8'), assemble(rom.source).bytes);
}

const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
console.log(`dist/studio.html  ${kb} kB  (${Object.keys(roms).length} ROMs built in)`);
for (const [id, rom] of Object.entries(roms)) console.log(`dist/${id}.ch8`.padEnd(22) + `${rom.size} B`);
