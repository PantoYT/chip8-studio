// Test suite: CPU semantics, quirks, assembler, disassembler, and the shipped ROMs.
// Run with: node tests/run.js

import { Chip8, SCREEN_W, PROG_START } from '../src/chip8.js';
import { assemble, disassemble, AsmError } from '../src/asm.js';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let passed = 0;
const failures = [];
let group = '';

function suite(name) { group = name; }
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) { failures.push({ name: `${group} › ${name}`, err }); }
}
function eq(actual, expected, what = '') {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}expected ${b}, got ${a}`);
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'expected truthy'); }
function throws(fn, re) {
  let caught = null;
  try { fn(); } catch (e) { caught = e; }
  if (!caught) throw new Error('expected a throw, got none');
  if (re && !re.test(caught.message)) throw new Error(`error message "${caught.message}" does not match ${re}`);
}

/** Build a machine with a hand-written opcode program at 0x200. */
function machine(opcodes, quirks = {}) {
  const bytes = [];
  for (const op of opcodes) bytes.push((op >> 8) & 0xff, op & 0xff);
  const c = new Chip8({ quirks, seed: 1 });
  c.load(Uint8Array.from(bytes));
  c.vblank = true; // don't stall the first DXYN in unit tests
  return c;
}
function runSteps(c, n) { for (let k = 0; k < n; k++) { c.vblank = true; c.step(); } }

// ------------------------------------------------------------------ CPU basics

suite('cpu');

test('reset state', () => {
  const c = new Chip8();
  eq(c.pc, PROG_START, 'pc: ');
  eq(c.sp, 0, 'sp: ');
  eq(Array.from(c.v), new Array(16).fill(0));
  eq(c.mem[0x50], 0xf0, 'font byte 0: ');
  eq(c.mem[0x50 + 79], 0x80, 'last font byte: ');
});

test('6XNN / 7XNN load and add-immediate wrap at 8 bits', () => {
  const c = machine([0x60ff, 0x7002]);
  runSteps(c, 2);
  eq(c.v[0], 1, 'V0: ');
  eq(c.v[0xf], 0, 'VF must not change: ');
});

test('8XY4 sets carry, 8XY5 sets NOT borrow', () => {
  let c = machine([0x60f0, 0x6120, 0x8014]);
  runSteps(c, 3);
  eq(c.v[0], 0x10); eq(c.v[0xf], 1, 'carry: ');

  c = machine([0x6005, 0x6103, 0x8015]);
  runSteps(c, 3);
  eq(c.v[0], 2); eq(c.v[0xf], 1, 'no borrow: ');

  c = machine([0x6003, 0x6105, 0x8015]);
  runSteps(c, 3);
  eq(c.v[0], 0xfe); eq(c.v[0xf], 0, 'borrow: ');
});

test('8XY7 subtracts the other way round', () => {
  const c = machine([0x6003, 0x6105, 0x8017]);
  runSteps(c, 3);
  eq(c.v[0], 2); eq(c.v[0xf], 1);
});

test('VF is the destination: 8XY4 writes the flag last', () => {
  const c = machine([0x6fff, 0x6101, 0x8f14]);
  runSteps(c, 3);
  eq(c.v[0xf], 1, 'flag wins over the sum: ');
});

test('BCD splits into three digits', () => {
  const c = machine([0x60ff, 0xa300, 0xf033]);
  runSteps(c, 3);
  eq([c.mem[0x300], c.mem[0x301], c.mem[0x302]], [2, 5, 5]);
});

test('FX29 points I at the right font glyph', () => {
  const c = machine([0x600a, 0xf029]);
  runSteps(c, 2);
  eq(c.i, 0x50 + 10 * 5);
  eq(c.mem[c.i], 0xf0, 'glyph A row 0: ');
});

test('CALL/RET use the stack', () => {
  const c = machine([0x2206, 0x1208, 0x0000, 0x00ee]); // CALL 206; JP 208; ...; RET
  c.step(); eq(c.pc, 0x206); eq(c.sp, 1);
  c.step(); eq(c.pc, 0x202, 'returned to the instruction after CALL: '); eq(c.sp, 0);
});

test('stack overflow and empty RET are reported', () => {
  const c = machine([0x2200]); // CALL to itself
  throws(() => { for (let k = 0; k < 40; k++) c.step(); }, /Stack overflow/);
  const d = machine([0x00ee]);
  throws(() => d.step(), /empty stack/);
});

test('JP to self halts instead of spinning forever', () => {
  const c = machine([0x1200]);
  c.step();
  ok(c.halted, 'should be halted');
  eq(c.step(), false, 'further steps are no-ops: ');
});

test('unknown opcode throws with its address', () => {
  const c = machine([0x5121]);
  try { c.step(); throw new Error('no throw'); }
  catch (e) { ok(/Unknown opcode 0x5121/.test(e.message), e.message); eq(e.pc, 0x200); }
});

test('skip instructions move PC by four', () => {
  const c = machine([0x6042, 0x3042]);
  runSteps(c, 2);
  eq(c.pc, 0x206);
});

test('timers count down once per frame and stop at zero', () => {
  const c = machine([0x6003, 0xf015, 0xf018]);
  runSteps(c, 3);
  eq([c.dt, c.st], [3, 3]);
  for (let k = 0; k < 5; k++) c.tick60();
  eq([c.dt, c.st], [0, 0]);
});

test('FX0A waits for press AND release', () => {
  const c = machine([0xf00a, 0x6100]);
  eq(c.step(), false, 'no key yet: ');
  eq(c.pc, 0x200);
  c.keyDown(7);
  eq(c.step(), false, 'still held: ');
  eq(c.pc, 0x200);
  c.keyUp(7);
  eq(c.step(), true, 'released: ');
  eq(c.v[0], 7);
  eq(c.pc, 0x202);
});

test('EX9E / EXA1 read the keypad', () => {
  const c = machine([0x6005, 0xe09e, 0x0000, 0xe0a1]);
  c.keyDown(5);
  runSteps(c, 2);
  eq(c.pc, 0x206, 'SKP taken: ');
  c.step();
  eq(c.pc, 0x208, 'SKNP not taken: ');
});

// ---------------------------------------------------------------------- display

suite('display');

const px = (c, x, y) => c.display[y * SCREEN_W + x];

test('DXYN draws a sprite and reports no collision', () => {
  const c = machine([0xa300, 0x6002, 0x6101, 0xd011]);
  c.mem[0x300] = 0b10000001;
  runSteps(c, 4);
  eq(px(c, 2, 1), 1, 'left pixel: ');
  eq(px(c, 9, 1), 1, 'right pixel: ');
  eq(px(c, 3, 1), 0, 'gap: ');
  eq(c.v[0xf], 0, 'VF: ');
});

test('drawing the same sprite twice erases it and sets VF', () => {
  const c = machine([0xa300, 0x6002, 0x6101, 0xd011, 0xd011]);
  c.mem[0x300] = 0xff;
  runSteps(c, 5);
  eq(c.v[0xf], 1, 'collision: ');
  eq(c.display.reduce((a, b) => a + b, 0), 0, 'screen cleared: ');
});

test('sprites clip at the right edge by default and wrap when the quirk is off', () => {
  let c = machine([0xa300, 0x603c, 0x6100, 0xd011]); // x = 60, 8 px wide
  c.mem[0x300] = 0xff;
  runSteps(c, 4);
  eq(c.display.slice(0, SCREEN_W).reduce((a, b) => a + b, 0), 4, 'clipped to 4 px: ');

  c = machine([0xa300, 0x603c, 0x6100, 0xd011], { clipping: false });
  c.mem[0x300] = 0xff;
  runSteps(c, 4);
  eq(c.display.slice(0, SCREEN_W).reduce((a, b) => a + b, 0), 8, 'wrapped to 8 px: ');
  eq(px(c, 0, 0), 1, 'wrapped pixel at x=0: ');
});

test('start coordinates always wrap into the screen', () => {
  const c = machine([0xa300, 0x6042, 0x6122, 0xd011]); // 0x42 = 66 -> 2, 0x22 = 34 -> 2
  c.mem[0x300] = 0x80;
  runSteps(c, 4);
  eq(px(c, 2, 2), 1);
});

test('00E0 clears the screen', () => {
  const c = machine([0xa300, 0x6000, 0x6100, 0xd011, 0x00e0]);
  c.mem[0x300] = 0xff;
  runSteps(c, 5);
  eq(c.display.reduce((a, b) => a + b, 0), 0);
});

test('displayWait parks DXYN until the next frame', () => {
  const c = machine([0xa300, 0x6000, 0x6100, 0xd011]);
  c.mem[0x300] = 0xff;
  c.vblank = false;
  for (let k = 0; k < 3; k++) c.step();
  eq(c.step(), false, 'DXYN stalls: ');
  eq(c.pc, 0x206, 'PC stays on the draw: ');
  c.tick60();
  eq(c.step(), true, 'runs after vblank: ');
  eq(px(c, 0, 0), 1);
});

// ----------------------------------------------------------------------- quirks

suite('quirks');

test('vfReset clears VF on the bitwise ops', () => {
  const on = machine([0x6fff, 0x6001, 0x6103, 0x8011]);
  runSteps(on, 4);
  eq(on.v[0xf], 0, 'VF reset: ');
  const off = machine([0x6fff, 0x6001, 0x6103, 0x8011], { vfReset: false });
  runSteps(off, 4);
  eq(off.v[0xf], 0xff, 'VF preserved: ');
});

test('memoryI leaves I advanced after FX55/FX65', () => {
  const on = machine([0xa300, 0xf255]);
  runSteps(on, 2);
  eq(on.i, 0x303, 'I advanced: ');
  const off = machine([0xa300, 0xf255], { memoryI: false });
  runSteps(off, 2);
  eq(off.i, 0x300, 'I unchanged: ');
});

test('FX55 then FX65 round-trips the registers', () => {
  const c = machine([0x6011, 0x6122, 0x6233, 0xa400, 0xf255, 0xa400, 0xf365]);
  runSteps(c, 7);
  eq([c.v[0], c.v[1], c.v[2], c.v[3]], [0x11, 0x22, 0x33, 0]);
  eq([c.mem[0x400], c.mem[0x401], c.mem[0x402]], [0x11, 0x22, 0x33]);
});

test('shift quirk chooses between VY and VX as the source', () => {
  const vy = machine([0x6000, 0x6103, 0x8016]);            // SHR V0, V1
  runSteps(vy, 3);
  eq(vy.v[0], 1, 'shifted VY: '); eq(vy.v[0xf], 1);
  const vx = machine([0x6008, 0x6103, 0x8016], { shiftVy: false });
  runSteps(vx, 3);
  eq(vx.v[0], 4, 'shifted VX: '); eq(vx.v[0xf], 0);
});

test('BNNN uses V0, BXNN uses VX', () => {
  const v0 = machine([0x6004, 0xb300]);
  runSteps(v0, 2);
  eq(v0.pc, 0x304);
  const vx = machine([0x6304, 0xb300], { jumpVx: true });
  runSteps(vx, 2);
  eq(vx.pc, 0x304);
});

test('RND is masked and deterministic for a given seed', () => {
  const a = machine([0xc00f, 0xc00f, 0xc00f]);
  const b = machine([0xc00f, 0xc00f, 0xc00f]);
  const seqA = [], seqB = [];
  for (let k = 0; k < 3; k++) { a.step(); seqA.push(a.v[0]); b.step(); seqB.push(b.v[0]); }
  eq(seqA, seqB, 'same seed, same sequence: ');
  ok(seqA.every((n) => n <= 0xf), `masked to 0x0F, got ${seqA}`);
});

// ------------------------------------------------------------- time travel

suite('history');

test('stepBack restores registers, memory and the screen', () => {
  const c = new Chip8({ historyLimit: 64, seed: 7 });
  c.load(Uint8Array.from([0x60, 0x05, 0xa3, 0x00, 0x61, 0x00, 0xd0, 0x11]));
  c.mem[0x300] = 0xff;
  runSteps(c, 4);
  const drawn = c.display.reduce((a, b) => a + b, 0);
  ok(drawn > 0, 'something was drawn');
  ok(c.stepBack(), 'rewind the draw');
  eq(c.display.reduce((a, b) => a + b, 0), 0, 'screen restored: ');
  eq(c.pc, 0x206);
  ok(c.stepBack() && c.stepBack() && c.stepBack(), 'rewind to the start');
  eq(c.pc, 0x200);
  eq(c.v[0], 0, 'V0 restored: ');
  eq(c.stepBack(), false, 'history is empty: ');
});

test('history stays bounded', () => {
  const c = new Chip8({ historyLimit: 8 });
  c.load(Uint8Array.from([0x70, 0x01, 0x12, 0x00])); // ADD V0,1 ; JP 0x200
  for (let k = 0; k < 50; k++) c.step();
  eq(c.history.length, 8, 'ring length: ');
  ok(c.v[0] > 8, 'the program really ran');
});

// -------------------------------------------------------------------- assembler

suite('assembler');

const asmBytes = (src) => Array.from(assemble(src).bytes);

test('every mnemonic encodes to the documented opcode', () => {
  const cases = [
    ['CLS', [0x00, 0xe0]],
    ['RET', [0x00, 0xee]],
    ['JP 0x2A8', [0x12, 0xa8]],
    ['JP V0, 0x300', [0xb3, 0x00]],
    ['CALL 0x210', [0x22, 0x10]],
    ['SE V3, 0x2A', [0x33, 0x2a]],
    ['SNE V3, 42', [0x43, 0x2a]],
    ['SE V1, V2', [0x51, 0x20]],
    ['LD VA, 255', [0x6a, 0xff]],
    ['ADD VA, 1', [0x7a, 0x01]],
    ['LD V1, V2', [0x81, 0x20]],
    ['OR V1, V2', [0x81, 0x21]],
    ['AND V1, V2', [0x81, 0x22]],
    ['XOR V1, V2', [0x81, 0x23]],
    ['ADD V1, V2', [0x81, 0x24]],
    ['SUB V1, V2', [0x81, 0x25]],
    ['SHR V1, V2', [0x81, 0x26]],
    ['SUBN V1, V2', [0x81, 0x27]],
    ['SHL V1, V2', [0x81, 0x2e]],
    ['SNE V1, V2', [0x91, 0x20]],
    ['LD I, 0x300', [0xa3, 0x00]],
    ['RND V4, 0x0F', [0xc4, 0x0f]],
    ['DRW V1, V2, 5', [0xd1, 0x25]],
    ['SKP V9', [0xe9, 0x9e]],
    ['SKNP V9', [0xe9, 0xa1]],
    ['LD V5, DT', [0xf5, 0x07]],
    ['LD V5, K', [0xf5, 0x0a]],
    ['LD DT, V5', [0xf5, 0x15]],
    ['LD ST, V5', [0xf5, 0x18]],
    ['ADD I, V5', [0xf5, 0x1e]],
    ['LD F, V5', [0xf5, 0x29]],
    ['LD B, V5', [0xf5, 0x33]],
    ['LD [I], V5', [0xf5, 0x55]],
    ['LD V5, [I]', [0xf5, 0x65]],
  ];
  for (const [src, expected] of cases) eq(asmBytes(src), expected, `${src}: `);
});

test('one-operand SHR/SHL encode as 8XX6 so both quirks agree', () => {
  eq(asmBytes('SHR V3'), [0x83, 0x36]);
  eq(asmBytes('SHL V3'), [0x83, 0x3e]);
  const a = machine([0x6306, 0x8336]);
  const b = machine([0x6306, 0x8336], { shiftVy: false });
  runSteps(a, 2); runSteps(b, 2);
  eq(a.v[3], b.v[3], 'same result under both quirks: ');
  eq(a.v[3], 3);
});

test('labels resolve forwards and backwards', () => {
  const { bytes, symbols } = assemble(`
    start:
      JP  later
      db  0xAA
    later:
      JP  start
  `);
  eq(symbols.start, 0x200);
  eq(symbols.later, 0x203);
  eq(Array.from(bytes), [0x12, 0x03, 0xaa, 0x12, 0x00]);
});

test('numbers accept dec, 0x, $, 0b, % and chars', () => {
  eq(asmBytes('db 42, 0xFF, $10, 0b1010, %0011, \'A\''), [42, 0xff, 0x10, 10, 3, 65]);
});

test('expressions do arithmetic on labels and defines', () => {
  const src = `
    define BASE 0x300
    define ROW  8
      LD I, BASE + ROW*2
      LD V0, (ROW+2)/2
  `;
  eq(asmBytes(src), [0xa3, 0x10, 0x60, 0x05]);
});

test('gfx turns ASCII art into sprite bytes', () => {
  eq(asmBytes('gfx ..####..'), [0b00111100]);
  eq(asmBytes(`
    gfx #......#
    gfx .#....#.
  `), [0b10000001, 0b01000010]);
});

test('org and align move the assembly cursor', () => {
  const { bytes, start, symbols } = assemble(`
    org 0x300
    here:
      db 1
    align 4
    there:
      db 2
  `);
  eq(start, 0x300);
  eq(symbols.here, 0x300);
  eq(symbols.there, 0x304);
  eq(Array.from(bytes), [1, 0, 0, 0, 2]);
});

test('dw emits big-endian words', () => {
  eq(asmBytes('dw 0x1234, 0xABCD'), [0x12, 0x34, 0xab, 0xcd]);
});

test('comments and blank lines are ignored', () => {
  eq(asmBytes(`
    ; a comment
      CLS       ; trailing comment
      // another style
      RET
  `), [0x00, 0xe0, 0x00, 0xee]);
});

test('errors point at the offending line', () => {
  const bad = (src, re) => {
    try { assemble(src); throw new Error(`expected a failure for: ${src}`); }
    catch (e) {
      if (!(e instanceof AsmError)) throw e;
      ok(re.test(e.message), `"${e.message}" should match ${re}`);
    }
  };
  bad('\n\n  FOO V0, 1', /line 3: unknown instruction "foo"/);
  bad('  JP nowhere', /unknown symbol "nowhere"/);
  bad('a:\nb:\n  db 0\na:', /duplicate label "a"/);
  bad('  LD V0, V1, V2', /LD expects 2 operand/);
  bad('  DRW V0, V1, 16', /height 16 must be 0-15/);
  bad('  JP 0x1000', /outside 0x000-0xFFF/);
  bad('  gfx ..##', /exactly 8 columns/);
  bad('  ADD 5, V0', /needs a register or I first/);
});

test('lineMap ties every emitted address back to its source line', () => {
  const { lineMap } = assemble('CLS\nRET\ndb 1');
  eq(lineMap.get(0x200), 1);
  eq(lineMap.get(0x202), 2);
  eq(lineMap.get(0x204), 3);
});

// ----------------------------------------------------------------- disassembler

suite('disassembler');

test('assemble → disassemble → assemble is stable', () => {
  const sources = [
    'CLS', 'RET', 'JP   0x2A8', 'CALL 0x210', 'SE   V3, 0x2A', 'SNE  V3, 0x2A',
    'SE   V1, V2', 'LD   VA, 0xFF', 'ADD  VA, 0x01', 'LD   V1, V2', 'OR   V1, V2',
    'AND  V1, V2', 'XOR  V1, V2', 'ADD  V1, V2', 'SUB  V1, V2', 'SUBN V1, V2',
    'SHR  V1', 'SHL  V1', 'SNE  V1, V2', 'LD   I, 0x300', 'JP   V0, 0x300',
    'RND  V4, 0x0F', 'DRW  V1, V2, 5', 'SKP  V9', 'SKNP V9', 'LD   V5, DT',
    'LD   V5, K', 'LD   DT, V5', 'LD   ST, V5', 'ADD  I, V5', 'LD   F, V5',
    'LD   B, V5', 'LD   [I], V5', 'LD   V5, [I]',
  ];
  for (const src of sources) {
    const [hi, lo] = asmBytes(src);
    const text = disassemble((hi << 8) | lo);
    eq(text, src, `round trip of ${src}: `);
    eq(asmBytes(text), [hi, lo], `re-assembly of ${text}: `);
  }
});

test('data bytes disassemble to null rather than a fake instruction', () => {
  eq(disassemble(0x5121), null);
  eq(disassemble(0xf099), null);
  eq(disassemble(0x800a), null);
});

// ---------------------------------------------------------------------- the ROMs

suite('roms');

const romDir = join(ROOT, 'roms');
const romFiles = readdirSync(romDir).filter((f) => f.endsWith('.c8asm')).sort();

test('there are ROMs to test', () => ok(romFiles.length >= 4, `found ${romFiles.length}`));

for (const file of romFiles) {
  test(`${file} assembles and boots`, () => {
    const src = readFileSync(join(romDir, file), 'utf8');
    const { bytes, start } = assemble(src);
    ok(bytes.length > 0, 'produced bytes');
    eq(start, PROG_START, 'starts at 0x200: ');
    ok(bytes.length < 0xfff - PROG_START, `fits in memory (${bytes.length} B)`);

    const c = new Chip8({ seed: 0xc0ffee });
    c.load(bytes);
    // 30 emulated seconds at 500 cycles/s. Must never fault or wedge.
    let drew = 0;
    for (let frame = 0; frame < 1800; frame++) {
      c.tick60();
      for (let k = 0; k < 9; k++) {
        if (c.halted) break;
        c.step();
      }
      if (c.display.some((p) => p)) drew++;
      if (c.halted) break;
    }
    ok(drew > 0, 'drew something to the screen');
    ok(!c.fontClobbered, 'did not scribble over the font');
  });
}

test('bounce.c8asm actually animates and beeps', () => {
  const { bytes } = assemble(readFileSync(join(romDir, 'bounce.c8asm'), 'utf8'));
  const c = new Chip8({ seed: 5 });
  c.load(bytes);
  const seen = new Set();
  let beeped = false;
  for (let frame = 0; frame < 900; frame++) {
    c.tick60();
    for (let k = 0; k < 12; k++) c.step();
    if (c.st > 0) beeped = true;
    const lit = [];
    c.display.forEach((p, idx) => { if (p) lit.push(idx); });
    if (lit.length) seen.add(lit[0]);
  }
  ok(seen.size > 8, `ball moved through ${seen.size} positions`);
  ok(beeped, 'sound timer fired on a wall hit');
});

test('snake.c8asm responds to the keypad', () => {
  const { bytes } = assemble(readFileSync(join(romDir, 'snake.c8asm'), 'utf8'));
  const c = new Chip8({ seed: 42 });
  c.load(bytes);
  const run = (frames) => {
    for (let f = 0; f < frames; f++) {
      c.tick60();
      for (let k = 0; k < 15; k++) { if (c.halted) return; c.step(); }
    }
  };
  run(60);
  const before = c.display.slice();
  c.keyDown(6); run(2); c.keyUp(6); // '6' = right in the QWERTY mapping
  run(120);
  ok(!before.every((p, idx) => p === c.display[idx]), 'the screen changed while playing');
  ok(!c.halted, 'still running after two seconds');
});

// -------------------------------------------------------------------- reporting

const total = passed + failures.length;
for (const f of failures) {
  console.log(`FAIL  ${f.name}\n      ${f.err.message}`);
  if (process.env.VERBOSE) console.log(f.err.stack);
}
console.log(`\n${passed}/${total} tests passed`);
if (failures.length) process.exit(1);
