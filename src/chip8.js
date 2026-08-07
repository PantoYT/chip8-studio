// CHIP-8 CPU core.
// Runs unchanged in Node (tests, ROM build) and in the browser (studio.html).

export const SCREEN_W = 64;
export const SCREEN_H = 32;
export const MEM_SIZE = 4096;
export const PROG_START = 0x200;
export const FONT_START = 0x50;

export const FONT = [
  0xf0, 0x90, 0x90, 0x90, 0xf0, // 0
  0x20, 0x60, 0x20, 0x20, 0x70, // 1
  0xf0, 0x10, 0xf0, 0x80, 0xf0, // 2
  0xf0, 0x10, 0xf0, 0x10, 0xf0, // 3
  0x90, 0x90, 0xf0, 0x10, 0x10, // 4
  0xf0, 0x80, 0xf0, 0x10, 0xf0, // 5
  0xf0, 0x80, 0xf0, 0x90, 0xf0, // 6
  0xf0, 0x10, 0x20, 0x40, 0x40, // 7
  0xf0, 0x90, 0xf0, 0x90, 0xf0, // 8
  0xf0, 0x90, 0xf0, 0x10, 0xf0, // 9
  0xf0, 0x90, 0xf0, 0x90, 0x90, // A
  0xe0, 0x90, 0xe0, 0x90, 0xe0, // B
  0xf0, 0x80, 0x80, 0x80, 0xf0, // C
  0xe0, 0x90, 0x90, 0x90, 0xe0, // D
  0xf0, 0x80, 0xf0, 0x80, 0xf0, // E
  0xf0, 0x80, 0xf0, 0x80, 0x80, // F
];

// Interpreter behaviours that real hardware and later ports disagreed on.
// Defaults reproduce the 1977 COSMAC VIP interpreter.
export const DEFAULT_QUIRKS = {
  vfReset: true,     // 8XY1/2/3 clear VF
  memoryI: true,     // FX55/FX65 leave I incremented past the last register
  displayWait: true, // DXYN stalls until the next 60 Hz frame
  clipping: true,    // sprites clip at the screen edge instead of wrapping
  shiftVy: true,     // 8XY6/8XYE shift VY into VX (false = shift VX in place)
  jumpVx: false,     // BNNN uses V0 (true = SUPER-CHIP's BXNN, uses VX)
};

export class Chip8Error extends Error {
  constructor(message, pc, opcode) {
    super(message);
    this.name = 'Chip8Error';
    this.pc = pc;
    this.opcode = opcode;
  }
}

export class Chip8 {
  constructor(options = {}) {
    this.quirks = { ...DEFAULT_QUIRKS, ...(options.quirks || {}) };
    this.mem = new Uint8Array(MEM_SIZE);
    this.v = new Uint8Array(16);
    this.stack = new Uint16Array(16);
    this.display = new Uint8Array(SCREEN_W * SCREEN_H);
    this.keys = new Uint8Array(16);
    this.history = [];
    this.historyLimit = options.historyLimit ?? 0;
    this.reset(options.seed ?? 0x1234abcd);
  }

  // xorshift32. Kept on the instance rather than in a closure so that a
  // snapshot captures it — otherwise rewinding or reloading a saved game
  // would replay a different sequence of RND results.
  random() {
    let s = this.rngState;
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    this.rngState = s;
    return s & 0xff;
  }

  reset(seed = this.seed) {
    this.seed = seed >>> 0;
    this.rngState = this.seed || 0x9e3779b9;
    this.mem.fill(0);
    this.mem.set(FONT, FONT_START);
    this.v.fill(0);
    this.stack.fill(0);
    this.display.fill(0);
    this.i = 0;
    this.pc = PROG_START;
    this.sp = 0;
    this.dt = 0;
    this.st = 0;
    this.cycles = 0;
    this.frames = 0;
    this.halted = false;
    this.waitingKey = false;     // parked inside FX0A
    this.waitRelease = -1;       // key seen down, waiting for the release
    this.vblank = false;         // consumed by DXYN when displayWait is on
    this.drawFlag = true;
    this.history.length = 0;
    if (this.rom) this.mem.set(this.rom, this.romAddr);
  }

  load(bytes, addr = PROG_START) {
    if (addr + bytes.length > MEM_SIZE) {
      throw new Chip8Error(`ROM of ${bytes.length} B does not fit at 0x${addr.toString(16)}`, addr, 0);
    }
    this.rom = Uint8Array.from(bytes);
    this.romAddr = addr;
    this.reset(this.seed);
  }

  snapshot() {
    return {
      mem: this.mem.slice(), v: this.v.slice(), stack: this.stack.slice(),
      display: this.display.slice(), i: this.i, pc: this.pc, sp: this.sp,
      dt: this.dt, st: this.st, cycles: this.cycles, halted: this.halted,
      waitingKey: this.waitingKey, waitRelease: this.waitRelease, vblank: this.vblank,
      rngState: this.rngState,
    };
  }

  restore(s) {
    this.mem.set(s.mem); this.v.set(s.v); this.stack.set(s.stack);
    this.display.set(s.display);
    this.i = s.i; this.pc = s.pc; this.sp = s.sp; this.dt = s.dt; this.st = s.st;
    this.cycles = s.cycles; this.halted = s.halted;
    this.waitingKey = s.waitingKey; this.waitRelease = s.waitRelease; this.vblank = s.vblank;
    this.rngState = s.rngState;
    this.drawFlag = true;
  }

  // Rewind one instruction. Returns false when the history ring is empty.
  stepBack() {
    const s = this.history.pop();
    if (!s) return false;
    this.restore(s);
    return true;
  }

  // 60 Hz housekeeping: timers and the vblank token DXYN waits on.
  tick60() {
    if (this.dt > 0) this.dt--;
    if (this.st > 0) this.st--;
    this.vblank = true;
    this.frames++;
  }

  keyDown(k) { this.keys[k & 0xf] = 1; }
  keyUp(k) { this.keys[k & 0xf] = 0; }

  // Executes one instruction. Returns false if the CPU is parked (FX0A / display wait).
  step() {
    if (this.halted) return false;
    if (this.historyLimit > 0) {
      this.history.push(this.snapshot());
      if (this.history.length > this.historyLimit) this.history.shift();
    }
    const pc = this.pc;
    if (pc + 1 >= MEM_SIZE) throw new Chip8Error('PC ran past the end of memory', pc, 0);

    const opcode = (this.mem[pc] << 8) | this.mem[pc + 1];
    this.pc = (pc + 2) & 0xfff;

    const x = (opcode >> 8) & 0xf;
    const y = (opcode >> 4) & 0xf;
    const n = opcode & 0xf;
    const nn = opcode & 0xff;
    const nnn = opcode & 0xfff;
    const v = this.v;
    let executed = true;

    switch (opcode & 0xf000) {
      case 0x0000:
        if (opcode === 0x00e0) { this.display.fill(0); this.drawFlag = true; }
        else if (opcode === 0x00ee) {
          if (this.sp === 0) throw new Chip8Error('RET with an empty stack', pc, opcode);
          this.pc = this.stack[--this.sp];
        } else throw new Chip8Error(`Unsupported machine-code call 0x${hex(opcode, 4)}`, pc, opcode);
        break;

      case 0x1000:
        if (nnn === pc) { this.halted = true; this.haltReason = 'infinite loop (JP to self)'; }
        this.pc = nnn;
        break;

      case 0x2000:
        if (this.sp >= this.stack.length) throw new Chip8Error('Stack overflow (16 levels)', pc, opcode);
        this.stack[this.sp++] = this.pc;
        this.pc = nnn;
        break;

      case 0x3000: if (v[x] === nn) this.skip(); break;
      case 0x4000: if (v[x] !== nn) this.skip(); break;
      case 0x5000:
        if (n !== 0) throw new Chip8Error(`Unknown opcode 0x${hex(opcode, 4)}`, pc, opcode);
        if (v[x] === v[y]) this.skip();
        break;
      case 0x6000: v[x] = nn; break;
      case 0x7000: v[x] = (v[x] + nn) & 0xff; break;

      case 0x8000: {
        switch (n) {
          case 0x0: v[x] = v[y]; break;
          case 0x1: v[x] |= v[y]; if (this.quirks.vfReset) v[0xf] = 0; break;
          case 0x2: v[x] &= v[y]; if (this.quirks.vfReset) v[0xf] = 0; break;
          case 0x3: v[x] ^= v[y]; if (this.quirks.vfReset) v[0xf] = 0; break;
          case 0x4: { const r = v[x] + v[y]; v[x] = r & 0xff; v[0xf] = r > 0xff ? 1 : 0; break; }
          case 0x5: { const r = v[x] - v[y]; v[x] = r & 0xff; v[0xf] = r >= 0 ? 1 : 0; break; }
          case 0x6: { const src = this.quirks.shiftVy ? v[y] : v[x]; const f = src & 1; v[x] = src >> 1; v[0xf] = f; break; }
          case 0x7: { const r = v[y] - v[x]; v[x] = r & 0xff; v[0xf] = r >= 0 ? 1 : 0; break; }
          case 0xe: { const src = this.quirks.shiftVy ? v[y] : v[x]; const f = (src >> 7) & 1; v[x] = (src << 1) & 0xff; v[0xf] = f; break; }
          default: throw new Chip8Error(`Unknown opcode 0x${hex(opcode, 4)}`, pc, opcode);
        }
        break;
      }

      case 0x9000:
        if (n !== 0) throw new Chip8Error(`Unknown opcode 0x${hex(opcode, 4)}`, pc, opcode);
        if (v[x] !== v[y]) this.skip();
        break;

      case 0xa000: this.i = nnn; break;
      case 0xb000: this.pc = (nnn + (this.quirks.jumpVx ? v[x] : v[0])) & 0xfff; break;
      case 0xc000: v[x] = this.random() & nn; break;

      case 0xd000:
        if (this.quirks.displayWait && !this.vblank) {
          this.pc = pc; // park on this instruction until tick60() releases us
          executed = false;
        } else {
          this.vblank = false;
          this.draw(v[x], v[y], n);
        }
        break;

      case 0xe000:
        if (nn === 0x9e) { if (this.keys[v[x] & 0xf]) this.skip(); }
        else if (nn === 0xa1) { if (!this.keys[v[x] & 0xf]) this.skip(); }
        else throw new Chip8Error(`Unknown opcode 0x${hex(opcode, 4)}`, pc, opcode);
        break;

      case 0xf000:
        switch (nn) {
          case 0x07: v[x] = this.dt; break;
          case 0x0a: executed = this.waitForKey(x, pc); break;
          case 0x15: this.dt = v[x]; break;
          case 0x18: this.st = v[x]; break;
          case 0x1e: this.i = (this.i + v[x]) & 0xfff; break;
          case 0x29: this.i = FONT_START + (v[x] & 0xf) * 5; break;
          case 0x33:
            this.write(this.i, Math.floor(v[x] / 100));
            this.write(this.i + 1, Math.floor(v[x] / 10) % 10);
            this.write(this.i + 2, v[x] % 10);
            break;
          case 0x55:
            for (let r = 0; r <= x; r++) this.write(this.i + r, v[r]);
            if (this.quirks.memoryI) this.i = (this.i + x + 1) & 0xfff;
            break;
          case 0x65:
            for (let r = 0; r <= x; r++) v[r] = this.mem[(this.i + r) & 0xfff];
            if (this.quirks.memoryI) this.i = (this.i + x + 1) & 0xfff;
            break;
          default: throw new Chip8Error(`Unknown opcode 0x${hex(opcode, 4)}`, pc, opcode);
        }
        break;

      default: throw new Chip8Error(`Unknown opcode 0x${hex(opcode, 4)}`, pc, opcode);
    }

    if (executed) this.cycles++;
    else if (this.historyLimit > 0) this.history.pop(); // nothing happened, drop the snapshot
    return executed;
  }

  skip() { this.pc = (this.pc + 2) & 0xfff; }

  write(addr, value) {
    addr &= 0xfff;
    if (addr < PROG_START && addr >= FONT_START && addr < FONT_START + FONT.length) {
      // Writing over the font is legal on real hardware but almost always a bug.
      this.fontClobbered = true;
    }
    this.mem[addr] = value & 0xff;
  }

  // COSMAC VIP semantics: the key must be pressed *and* released before FX0A returns.
  waitForKey(x, pc) {
    if (this.waitRelease >= 0) {
      if (!this.keys[this.waitRelease]) {
        this.v[x] = this.waitRelease;
        this.waitRelease = -1;
        this.waitingKey = false;
        return true;
      }
    } else {
      for (let k = 0; k < 16; k++) if (this.keys[k]) { this.waitRelease = k; break; }
    }
    this.waitingKey = true;
    this.pc = pc;
    return false;
  }

  draw(vx, vy, rows) {
    const { clipping } = this.quirks;
    const x0 = vx % SCREEN_W;
    const y0 = vy % SCREEN_H;
    this.v[0xf] = 0;
    for (let row = 0; row < rows; row++) {
      let py = y0 + row;
      if (py >= SCREEN_H) { if (clipping) break; py %= SCREEN_H; }
      const bits = this.mem[(this.i + row) & 0xfff];
      for (let bit = 0; bit < 8; bit++) {
        if (!(bits & (0x80 >> bit))) continue;
        let px = x0 + bit;
        if (px >= SCREEN_W) { if (clipping) continue; px %= SCREEN_W; }
        const idx = py * SCREEN_W + px;
        if (this.display[idx]) this.v[0xf] = 1;
        this.display[idx] ^= 1;
      }
    }
    this.drawFlag = true;
  }
}

export function hex(n, width = 2) {
  return n.toString(16).toUpperCase().padStart(width, '0');
}
