// Two-pass CHIP-8 assembler and a matching disassembler.
//
// Syntax:
//   ; comment                  label:            org 0x200
//   define WIDTH 8             db 0xF0, 0b1010   dw label
//   gfx ..####..               align 2
//   LD V0, WIDTH*2             DRW V0, V1, 5
//
// Numbers: 42, 0xFF, $FF, 0b1010, %1010, 'A'
// Expressions: + - * / ( ) over labels and defines.

import { PROG_START, hex } from './chip8.js';

export class AsmError extends Error {
  constructor(message, line) {
    super(line ? `line ${line}: ${message}` : message);
    this.name = 'AsmError';
    this.line = line;
  }
}

const REG = /^[vV]([0-9a-fA-F])$/;

function isReg(tok) { return REG.test(tok); }
function regNum(tok) { return parseInt(tok.match(REG)[1], 16); }

// ---------------------------------------------------------------- expressions

function tokenizeExpr(src, line) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if ('+-*/()'.includes(c)) { out.push({ t: c }); i++; continue; }
    if (c === "'") {
      if (src[i + 2] !== "'") throw new AsmError(`malformed character literal in "${src}"`, line);
      out.push({ t: 'num', v: src.charCodeAt(i + 1) });
      i += 3;
      continue;
    }
    const rest = src.slice(i);
    let m;
    if ((m = rest.match(/^0[xX][0-9a-fA-F]+/)) || (m = rest.match(/^\$[0-9a-fA-F]+/))) {
      out.push({ t: 'num', v: parseInt(m[0].replace(/^\$/, '0x'), 16) });
    } else if ((m = rest.match(/^0[bB][01]+/)) || (m = rest.match(/^%[01]+/))) {
      out.push({ t: 'num', v: parseInt(m[0].replace(/^(0[bB]|%)/, ''), 2) });
    } else if ((m = rest.match(/^\d+/))) {
      out.push({ t: 'num', v: parseInt(m[0], 10) });
    } else if ((m = rest.match(/^[A-Za-z_.][A-Za-z0-9_.]*/))) {
      out.push({ t: 'name', v: m[0] });
    } else {
      throw new AsmError(`cannot parse "${rest}"`, line);
    }
    i += m[0].length;
  }
  return out;
}

function evalExpr(src, symbols, line, allowUnknown) {
  const toks = tokenizeExpr(src, line);
  let p = 0;
  const peek = () => toks[p];
  const eat = (t) => (toks[p] && toks[p].t === t ? toks[p++] : null);

  function primary() {
    if (eat('(')) {
      const v = sum();
      if (!eat(')')) throw new AsmError(`missing ")" in "${src}"`, line);
      return v;
    }
    if (eat('-')) return -primary();
    if (eat('+')) return primary();
    const tok = peek();
    if (!tok) throw new AsmError(`unexpected end of expression "${src}"`, line);
    p++;
    if (tok.t === 'num') return tok.v;
    if (tok.t === 'name') {
      const key = tok.v.toLowerCase();
      if (key in symbols) return symbols[key];
      if (allowUnknown) return 0; // pass 1: any placeholder of the right size
      throw new AsmError(`unknown symbol "${tok.v}"`, line);
    }
    throw new AsmError(`unexpected "${tok.t}" in "${src}"`, line);
  }
  function product() {
    let v = primary();
    for (;;) {
      if (eat('*')) v *= primary();
      else if (eat('/')) v = Math.floor(v / primary());
      else return v;
    }
  }
  function sum() {
    let v = product();
    for (;;) {
      if (eat('+')) v += product();
      else if (eat('-')) v -= product();
      else return v;
    }
  }
  const value = sum();
  if (p !== toks.length) throw new AsmError(`trailing junk in "${src}"`, line);
  return value;
}

// ------------------------------------------------------------------- assembler

function splitOperands(text) {
  return text.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

function parseLines(source) {
  return source.split(/\r?\n/).map((raw, idx) => {
    let text = raw.replace(/;.*$/, '').replace(/\/\/.*$/, '').trim();
    const line = idx + 1;
    let label = null;
    const m = text.match(/^([A-Za-z_.][A-Za-z0-9_.]*)\s*:/);
    if (m) { label = m[1]; text = text.slice(m[0].length).trim(); }
    if (!text) return { line, label, op: null, args: [], raw };
    const sp = text.search(/\s/);
    const op = (sp < 0 ? text : text.slice(0, sp)).toLowerCase();
    const rest = sp < 0 ? '' : text.slice(sp).trim();
    return { line, label, op, args: splitOperands(rest), rest, raw };
  });
}

function gfxByte(spec, line) {
  const bits = spec.replace(/["']/g, '').trim();
  if (bits.length !== 8) throw new AsmError(`gfx needs exactly 8 columns, got ${bits.length}`, line);
  let byte = 0;
  for (const ch of bits) byte = (byte << 1) | (ch === '.' || ch === '0' || ch === ' ' || ch === '_' ? 0 : 1);
  return byte;
}

/**
 * Assemble source text.
 * @returns {{bytes: Uint8Array, start: number, symbols: object, lineMap: Map<number, number>}}
 */
export function assemble(source) {
  const stmts = parseLines(source);
  const symbols = Object.create(null);

  // Pass 1: measure every statement and record label addresses.
  let pc = PROG_START;
  const sizes = [];
  for (const st of stmts) {
    const size = measure(st, symbols, pc);
    // org/align move the cursor before a label on the same line is bound.
    if (size.newPc !== undefined) pc = size.newPc;
    if (st.label) {
      const key = st.label.toLowerCase();
      if (key in symbols) throw new AsmError(`duplicate label "${st.label}"`, st.line);
      symbols[key] = pc;
    }
    pc += size.n;
    sizes.push(size);
  }

  // Pass 2: emit.
  const out = new Map(); // addr -> byte
  const lineMap = new Map(); // addr -> source line
  pc = PROG_START;
  stmts.forEach((st, idx) => {
    const size = sizes[idx];
    if (size.newPc !== undefined) pc = size.newPc;
    if (size.n === 0) return;
    const bytes = emit(st, symbols, pc);
    if (bytes.length !== size.n) {
      throw new AsmError(`internal: "${st.op}" sized ${size.n} B but emitted ${bytes.length} B`, st.line);
    }
    lineMap.set(pc, st.line);
    for (const b of bytes) {
      if (pc > 0xfff) throw new AsmError('program overflows 4 KB of memory', st.line);
      out.set(pc++, b & 0xff);
    }
  });

  if (out.size === 0) throw new AsmError('nothing to assemble');
  const lo = Math.min(...out.keys());
  const hi = Math.max(...out.keys());
  const bytes = new Uint8Array(hi - lo + 1);
  for (const [addr, b] of out) bytes[addr - lo] = b;
  return { bytes, start: lo, symbols, lineMap };
}

function measure(st, symbols, pc) {
  if (!st.op) return { n: 0 };
  switch (st.op) {
    case 'define':
    case 'equ': {
      const [name, ...valParts] = st.rest.split(/[\s,]+/);
      if (!name || valParts.length === 0) throw new AsmError('define needs a name and a value', st.line);
      symbols[name.toLowerCase()] = evalExpr(valParts.join(' '), symbols, st.line, false);
      return { n: 0 };
    }
    case 'org': return { n: 0, newPc: evalExpr(st.rest, symbols, st.line, false) };
    case 'align': {
      const a = st.rest ? evalExpr(st.rest, symbols, st.line, false) : 2;
      return { n: 0, newPc: Math.ceil(pc / a) * a };
    }
    case 'db': return { n: st.args.length };
    case 'dw': return { n: st.args.length * 2 };
    case 'gfx': return { n: st.args.length || 1 };
    default: return { n: 2 };
  }
}

function emit(st, symbols, pc) {
  const line = st.line;
  const E = (s) => evalExpr(s, symbols, line, false);
  const bad = (msg) => { throw new AsmError(msg, line); };
  const a = st.args;

  switch (st.op) {
    case 'db': return a.map((s) => E(s) & 0xff);
    case 'dw': return a.flatMap((s) => { const v = E(s) & 0xffff; return [v >> 8, v & 0xff]; });
    case 'gfx': return (a.length ? a : [st.rest]).map((s) => gfxByte(s, line));
    default: break;
  }

  const w = (v) => [(v >> 8) & 0xff, v & 0xff];
  const addr = (s) => {
    const v = E(s);
    if (v < 0 || v > 0xfff) bad(`address 0x${v.toString(16)} is outside 0x000-0xFFF`);
    return v;
  };
  const byte = (s) => {
    const v = E(s);
    if (v < -128 || v > 255) bad(`byte value ${v} out of range`);
    return v & 0xff;
  };
  const need = (count) => { if (a.length !== count) bad(`${st.op.toUpperCase()} expects ${count} operand(s), got ${a.length}`); };
  const alu = (nib) => { need(2); if (!isReg(a[0]) || !isReg(a[1])) bad(`${st.op.toUpperCase()} needs two registers`); return w(0x8000 | (regNum(a[0]) << 8) | (regNum(a[1]) << 4) | nib); };

  switch (st.op) {
    case 'cls': need(0); return w(0x00e0);
    case 'ret': need(0); return w(0x00ee);
    case 'sys': need(1); return w(0x0000 | addr(a[0]));

    case 'jp':
      if (a.length === 2) {
        if (!isReg(a[0]) || regNum(a[0]) !== 0) bad('JP with two operands must be "JP V0, addr"');
        return w(0xb000 | addr(a[1]));
      }
      need(1); return w(0x1000 | addr(a[0]));

    case 'call': need(1); return w(0x2000 | addr(a[0]));

    case 'se': need(2);
      if (!isReg(a[0])) bad('SE needs a register first');
      return isReg(a[1])
        ? w(0x5000 | (regNum(a[0]) << 8) | (regNum(a[1]) << 4))
        : w(0x3000 | (regNum(a[0]) << 8) | byte(a[1]));

    case 'sne': need(2);
      if (!isReg(a[0])) bad('SNE needs a register first');
      return isReg(a[1])
        ? w(0x9000 | (regNum(a[0]) << 8) | (regNum(a[1]) << 4))
        : w(0x4000 | (regNum(a[0]) << 8) | byte(a[1]));

    case 'ld': {
      need(2);
      const [d, s] = a;
      const dl = d.toLowerCase(), sl = s.toLowerCase();
      if (isReg(d)) {
        const x = regNum(d) << 8;
        if (isReg(s)) return w(0x8000 | x | (regNum(s) << 4));
        if (sl === 'dt') return w(0xf007 | x);
        if (sl === 'k') return w(0xf00a | x);
        if (sl === '[i]') return w(0xf065 | x);
        if (sl === 'i') bad('cannot load I into a register');
        return w(0x6000 | x | byte(s));
      }
      if (dl === 'i') return w(0xa000 | addr(s));
      if (!isReg(s)) bad(`LD ${d}, ${s} — the source must be a register here`);
      const x = regNum(s) << 8;
      if (dl === 'dt') return w(0xf015 | x);
      if (dl === 'st') return w(0xf018 | x);
      if (dl === 'f') return w(0xf029 | x);
      if (dl === 'b') return w(0xf033 | x);
      if (dl === '[i]') return w(0xf055 | x);
      return bad(`unknown LD destination "${d}"`);
    }

    case 'add': {
      need(2);
      const [d, s] = a;
      if (d.toLowerCase() === 'i') {
        if (!isReg(s)) bad('ADD I, Vx needs a register');
        return w(0xf01e | (regNum(s) << 8));
      }
      if (!isReg(d)) bad('ADD needs a register or I first');
      return isReg(s)
        ? w(0x8004 | (regNum(d) << 8) | (regNum(s) << 4))
        : w(0x7000 | (regNum(d) << 8) | byte(s));
    }

    case 'or': return alu(1);
    case 'and': return alu(2);
    case 'xor': return alu(3);
    case 'sub': return alu(5);
    case 'subn': return alu(7);

    case 'shr':
    case 'shl': {
      const nib = st.op === 'shr' ? 6 : 0xe;
      if (a.length === 1) {
        if (!isReg(a[0])) bad(`${st.op.toUpperCase()} needs a register`);
        // Encode as 8XX6 so it means the same under both shift quirks.
        return w(0x8000 | (regNum(a[0]) << 8) | (regNum(a[0]) << 4) | nib);
      }
      return alu(nib);
    }

    case 'rnd': need(2);
      if (!isReg(a[0])) bad('RND needs a register first');
      return w(0xc000 | (regNum(a[0]) << 8) | byte(a[1]));

    case 'drw': need(3);
      if (!isReg(a[0]) || !isReg(a[1])) bad('DRW needs two registers and a height');
      { const h = E(a[2]); if (h < 0 || h > 15) bad(`sprite height ${h} must be 0-15`);
        return w(0xd000 | (regNum(a[0]) << 8) | (regNum(a[1]) << 4) | h); }

    case 'skp': need(1); if (!isReg(a[0])) bad('SKP needs a register'); return w(0xe09e | (regNum(a[0]) << 8));
    case 'sknp': need(1); if (!isReg(a[0])) bad('SKNP needs a register'); return w(0xe0a1 | (regNum(a[0]) << 8));

    default: return bad(`unknown instruction "${st.op}"`);
  }
}

// ----------------------------------------------------------------- disassembler

export function disassemble(opcode) {
  const x = (opcode >> 8) & 0xf;
  const y = (opcode >> 4) & 0xf;
  const n = opcode & 0xf;
  const nn = opcode & 0xff;
  const nnn = opcode & 0xfff;
  const V = (r) => `V${hex(r, 1)}`;
  const A = () => `0x${hex(nnn, 3)}`;
  const B = () => `0x${hex(nn, 2)}`;

  switch (opcode & 0xf000) {
    case 0x0000:
      if (opcode === 0x00e0) return 'CLS';
      if (opcode === 0x00ee) return 'RET';
      return `SYS  ${A()}`;
    case 0x1000: return `JP   ${A()}`;
    case 0x2000: return `CALL ${A()}`;
    case 0x3000: return `SE   ${V(x)}, ${B()}`;
    case 0x4000: return `SNE  ${V(x)}, ${B()}`;
    case 0x5000: return n === 0 ? `SE   ${V(x)}, ${V(y)}` : null;
    case 0x6000: return `LD   ${V(x)}, ${B()}`;
    case 0x7000: return `ADD  ${V(x)}, ${B()}`;
    case 0x8000: switch (n) {
      case 0x0: return `LD   ${V(x)}, ${V(y)}`;
      case 0x1: return `OR   ${V(x)}, ${V(y)}`;
      case 0x2: return `AND  ${V(x)}, ${V(y)}`;
      case 0x3: return `XOR  ${V(x)}, ${V(y)}`;
      case 0x4: return `ADD  ${V(x)}, ${V(y)}`;
      case 0x5: return `SUB  ${V(x)}, ${V(y)}`;
      case 0x6: return x === y ? `SHR  ${V(x)}` : `SHR  ${V(x)}, ${V(y)}`;
      case 0x7: return `SUBN ${V(x)}, ${V(y)}`;
      case 0xe: return x === y ? `SHL  ${V(x)}` : `SHL  ${V(x)}, ${V(y)}`;
      default: return null;
    }
    case 0x9000: return n === 0 ? `SNE  ${V(x)}, ${V(y)}` : null;
    case 0xa000: return `LD   I, ${A()}`;
    case 0xb000: return `JP   V0, ${A()}`;
    case 0xc000: return `RND  ${V(x)}, ${B()}`;
    case 0xd000: return `DRW  ${V(x)}, ${V(y)}, ${n}`;
    case 0xe000:
      if (nn === 0x9e) return `SKP  ${V(x)}`;
      if (nn === 0xa1) return `SKNP ${V(x)}`;
      return null;
    case 0xf000: switch (nn) {
      case 0x07: return `LD   ${V(x)}, DT`;
      case 0x0a: return `LD   ${V(x)}, K`;
      case 0x15: return `LD   DT, ${V(x)}`;
      case 0x18: return `LD   ST, ${V(x)}`;
      case 0x1e: return `ADD  I, ${V(x)}`;
      case 0x29: return `LD   F, ${V(x)}`;
      case 0x33: return `LD   B, ${V(x)}`;
      case 0x55: return `LD   [I], ${V(x)}`;
      case 0x65: return `LD   ${V(x)}, [I]`;
      default: return null;
    }
    default: return null;
  }
}
