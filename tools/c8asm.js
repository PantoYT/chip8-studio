#!/usr/bin/env node
// Command-line assembler: .c8asm -> .ch8
//   node tools/c8asm.js roms/snake.c8asm [-o dist/snake.ch8] [--listing]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { assemble, disassemble, AsmError } from '../src/asm.js';
import { hex } from '../src/chip8.js';

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error('usage: c8asm.js <source.c8asm> [-o out.ch8] [--listing]');
  process.exit(2);
}

const input = argv[0];
const outIdx = argv.indexOf('-o');
const output = outIdx >= 0 ? argv[outIdx + 1] : join('dist', basename(input).replace(/\.c8asm$/, '') + '.ch8');
const wantListing = argv.includes('--listing');

let result;
try {
  result = assemble(readFileSync(input, 'utf8'));
} catch (err) {
  if (err instanceof AsmError) { console.error(`${input}:${err.line ?? '?'}: ${err.message}`); process.exit(1); }
  throw err;
}

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, result.bytes);
console.log(`${input} -> ${output}  (${result.bytes.length} B, start 0x${hex(result.start, 3)})`);

if (wantListing) {
  const { bytes, start } = result;
  console.log('');
  for (let off = 0; off + 1 < bytes.length; off += 2) {
    const addr = start + off;
    const opcode = (bytes[off] << 8) | bytes[off + 1];
    const text = disassemble(opcode);
    const label = Object.entries(result.symbols).find(([, v]) => v === addr)?.[0];
    console.log(
      `${hex(addr, 3)}  ${hex(opcode, 4)}  ${(text ?? '.data').padEnd(16)}${label ? '; ' + label + ':' : ''}`
    );
  }
}
