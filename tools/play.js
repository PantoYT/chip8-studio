#!/usr/bin/env node
// Headless player: runs a ROM without a browser, renders the 64x32 framebuffer
// as text, and can drive the keypad from a script or from a built-in bot.
//
//   node tools/play.js roms/maze.c8asm --frames 200 --shots 40,120,200
//   node tools/play.js roms/pong.c8asm --frames 600 --keys 0:2:30,90:8:60
//   node tools/play.js roms/snake.c8asm --frames 1800 --bot snake --shots 600,1200
//
// --keys is a comma-separated list of frame:hexKey:durationInFrames.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Chip8, SCREEN_W, SCREEN_H } from '../src/chip8.js';
import { assemble } from '../src/asm.js';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const file = argv[0];
if (!file) { console.error('usage: play.js <rom.c8asm|rom.ch8> [--frames N] [--ipf N] [--keys ...] [--bot snake] [--shots f1,f2]'); process.exit(2); }

const frames = Number(flag('frames', 300));
const ipf = Number(flag('ipf', 12));            // instructions per 60 Hz frame
const shots = String(flag('shots', String(frames))).split(',').map(Number).filter((n) => n > 0);
const bot = flag('bot', null);
const seed = Number(flag('seed', 0xbeef));

const bytes = file.endsWith('.ch8')
  ? new Uint8Array(readFileSync(file))
  : assemble(readFileSync(file, 'utf8')).bytes;

const cpu = new Chip8({ seed });
cpu.load(bytes);

// --- turn-based play -------------------------------------------------------
// --session <file> keeps the machine alive between invocations, so a human (or
// a model) can look at one screen, decide, and play the next move by hand.
// --press <hexKey> holds that key for the whole burst.
const session = flag('session', null);
const press = flag('press', null);

const B64 = {
  pack: (s) => ({ ...s, mem: Buffer.from(s.mem).toString('base64'),
    v: Buffer.from(s.v).toString('base64'),
    stack: Buffer.from(new Uint8Array(s.stack.buffer.slice(0))).toString('base64'),
    display: Buffer.from(s.display).toString('base64') }),
  unpack: (s) => ({ ...s, mem: new Uint8Array(Buffer.from(s.mem, 'base64')),
    v: new Uint8Array(Buffer.from(s.v, 'base64')),
    stack: new Uint16Array(new Uint8Array(Buffer.from(s.stack, 'base64')).buffer),
    display: new Uint8Array(Buffer.from(s.display, 'base64')) }),
};

if (session && existsSync(session)) {
  cpu.restore(B64.unpack(JSON.parse(readFileSync(session, 'utf8'))));
}
if (press !== null) {
  const k = parseInt(press, 16);
  if (k >= 0 && k <= 15) cpu.keyDown(k);
}

// frame -> [{key, until}]
const schedule = [];
for (const spec of String(flag('keys', '')).split(',').filter(Boolean)) {
  const [at, key, dur] = spec.split(':');
  const start = parseInt(at, 10);
  schedule.push({ at: start, key: parseInt(key, 16), until: start + (parseInt(dur, 10) || 4) });
}

// CHIP-8 sprites are XOR-drawn, so a ROM that erases then redraws is blank for
// part of every frame. Real hardware smears that away; we keep a short phosphor
// trail so a screenshot shows what a human actually sees.
const PERSIST = 3;
const recent = [];
function persisted(display) {
  recent.push(display.slice());
  if (recent.length > PERSIST) recent.shift();
  const out = new Uint8Array(display.length);
  for (const frame of recent) for (let i = 0; i < out.length; i++) out[i] |= frame[i];
  return out;
}

function render(display) {
  // Two screen rows per text row using half-block glyphs.
  const rows = [];
  for (let y = 0; y < SCREEN_H; y += 2) {
    let line = '';
    for (let x = 0; x < SCREEN_W; x++) {
      const top = display[y * SCREEN_W + x];
      const bot = display[(y + 1) * SCREEN_W + x];
      line += top && bot ? '█' : top ? '▀' : bot ? '▄' : ' ';
    }
    rows.push('│' + line + '│');
  }
  const edge = '─'.repeat(SCREEN_W);
  return ['┌' + edge + '┐', ...rows, '└' + edge + '┘'].join('\n');
}

// --------------------------------------------------------------- snake bot
// Reads the emulator's own state the way a TAS script would: head column/row
// live in V2/V3, the food cell in V7, and the body is the ring at 0x400.
const SNAKE_KEYS = { up: 0x2, right: 0x6, down: 0x8, left: 0x4 };

function snakeDecide(c) {
  const col = c.v[2], row = c.v[3], dir = c.v[4];
  const food = c.v[7];
  const fCol = food >> 4, fRow = food & 0x0f;
  const body = new Set();
  for (let i = c.v[6]; ; i = (i + 1) & 63) {
    body.add(c.mem[0x400 + i]);
    if (i === c.v[5]) break;
  }
  const moves = [
    { name: 'up', dir: 0, col, row: row - 1 },
    { name: 'right', dir: 1, col: col + 1, row },
    { name: 'down', dir: 2, col, row: row + 1 },
    { name: 'left', dir: 3, col: col - 1, row },
  ];
  const legal = moves.filter((m) => {
    if ((m.dir + 2) % 4 === dir) return false;                       // no 180
    if (m.col < 0 || m.col > 15 || m.row < 0 || m.row > 7) return false;
    return !body.has(((m.col << 4) | m.row) & 0xff);
  });
  if (!legal.length) return null;
  // Prefer getting closer to the food; break ties by keeping more room ahead.
  const dist = (m) => Math.abs(m.col - fCol) + Math.abs(m.row - fRow);
  const room = (m) => {
    let n = 0, cc = m.col, rr = m.row;
    const step = [[0, -1], [1, 0], [0, 1], [-1, 0]][m.dir];
    while (n < 16) {
      cc += step[0]; rr += step[1];
      if (cc < 0 || cc > 15 || rr < 0 || rr > 7 || body.has(((cc << 4) | rr) & 0xff)) break;
      n++;
    }
    return n;
  };
  legal.sort((a, b) => dist(a) - dist(b) || room(b) - room(a));
  return SNAKE_KEYS[legal[0].name];
}

// ------------------------------------------------------------------- run it
let held = -1;
const output = [];
let deaths = 0;
let wasWaiting = false;

for (let frame = 0; frame <= frames; frame++) {
  if (bot === 'snake') {
    const want = snakeDecide(cpu);
    if (want !== held) { if (held >= 0) cpu.keyUp(held); held = want ?? -1; if (held >= 0) cpu.keyDown(held); }
    if (cpu.waitingKey) { // the game-over screen is asking for a key
      if (!wasWaiting) deaths++;  // count the transition, not every frame spent there
      wasWaiting = true;
      cpu.keyDown(0); cpu.tick60(); for (let k = 0; k < ipf; k++) cpu.step();
      cpu.keyUp(0);
    } else wasWaiting = false;
  } else {
    for (const s of schedule) {
      if (frame === s.at) cpu.keyDown(s.key);
      if (frame === s.until) cpu.keyUp(s.key);
    }
  }

  cpu.tick60();
  for (let k = 0; k < ipf; k++) {
    if (cpu.halted) break;
    try { cpu.step(); } catch (err) {
      console.error(`crash at frame ${frame}: ${err.message}`);
      process.exit(1);
    }
  }

  const glow = persisted(cpu.display);
  if (shots.includes(frame)) {
    output.push(`--- frame ${frame}  (cycles ${cpu.cycles}${bot === 'snake' ? `, score ${cpu.v[10]}` : ''}) ---`);
    output.push(render(glow));
  }
  if (cpu.halted) {
    output.push(`--- halted at frame ${frame}: ${cpu.haltReason ?? 'stopped'} ---`);
    output.push(render(glow));
    break;
  }
}

console.log(output.join('\n'));
const lit = cpu.display.reduce((a, b) => a + b, 0);
console.log(`\n${cpu.cycles} instructions, ${lit}/${SCREEN_W * SCREEN_H} pixels lit` +
  (bot === 'snake' ? `, score ${cpu.v[10]}, deaths ${deaths}` : ''));

if (session) {
  if (press !== null) cpu.keyUp(parseInt(press, 16));
  writeFileSync(session, JSON.stringify(B64.pack(cpu.snapshot())));
  console.log(`stan zapisany -> ${session}`);
}
