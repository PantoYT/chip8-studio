# CHIP-8 Studio

A CHIP-8 emulator, assembler, disassembler and debugger in **one HTML file** that works
offline from `file://` — no server, no internet, no dependencies.

```bash
node tests/run.js     # 49 tests: CPU, quirks, assembler, disassembler, ROMs
node tools/build.js   # -> dist/studio.html  +  dist/*.ch8
```

Then just open `dist/studio.html` in a browser.

---

## What CHIP-8 is

CHIP-8 is an interpreted language created around 1977 by **Joseph Weisbecker** at RCA
for the **COSMAC VIP** microcomputer (RCA 1802 CPU). It wasn't a hardware processor but a
virtual machine — so games could be written once and run on any machine with an
interpreter. The whole specification is:

| Element        | Size                                           |
|----------------|------------------------------------------------|
| memory         | 4 KB, programs start at `0x200`                |
| registers      | `V0`–`VF` (8-bit), `I` (12-bit address)        |
| stack          | 16 levels, return addresses only               |
| screen         | 64 × 32, monochrome, sprites drawn with XOR    |
| timers         | two, 60 Hz: delay (`DT`) and sound (`ST`)      |
| sound          | a single tone, plays while `ST > 0`            |
| keypad         | 16 keys `0`–`F`                                |
| instruction set| 35 instructions, 2 bytes each                  |

That's it. Which is why a quite playable snake fits in **385 bytes**.

### Where the "quirks" come from

Interpreters were written by different people for different machines, and a few
instructions drifted apart between versions. There's no single "correct" CHIP-8 — there
is the original COSMAC VIP, SUPER-CHIP from the HP-48 calculators, and newer ports. The
Studio has them as toggles (`Interpreter quirks`), because that's
the only way to make old ROMs from the internet run correctly:

- **`8XY1/2/3` reset `VF`** — the original did, later ports don't.
- **`FX55/FX65` increment `I`** — after storing registers, `I` pointed further on.
- **`DXYN` waits for the frame** — on the VIP drawing was synchronized with the display.
  Hence the famous CHIP-8 flicker: the practical limit is ~1 sprite per frame.
- **Sprite clipping** at the screen edge instead of wrapping.
- **`8XY6/8XYE`** shift `VY` (original) or `VX` in place (SUPER-CHIP).
- **`BNNN`** jumps from `V0` (original) or from `VX` (SUPER-CHIP).

The `COSMAC VIP` profile sets everything the old way, `Modern` the new way.

---

## Contents

```
src/chip8.js      emulator core: 35 instructions, timers, quirks, history
src/asm.js        two-pass assembler + disassembler
roms/*.c8asm      four programs written in CHIP-8 assembly
web/studio.html   the interface (template; the build injects the core and ROMs)
tools/build.js    bundler -> dist/studio.html
tools/c8asm.js    command-line assembler: .c8asm -> .ch8
tools/play.js     headless player: renders the screen as text
tests/run.js      tests
```

## Studio

- a screen with phosphor glow (four colors, green by default; `?phos=amber`, `ice` or
  `paper` in the address picks another) and CRT lines,
- **a time-travel debugger** — `Back` restores the full state from before an
  instruction (registers, memory, screen); the buffer holds 4096 steps,
- breakpoints: click a line in the disassembler,
- a memory view with `PC` and `I` highlighted,
- a source editor — `Ctrl+Enter` assembles and runs, errors show the line number,
- `Download .ch8` saves a file that runs in **any** CHIP-8 emulator.


## Assembly language

```asm
define WIDTH 8              ; constant
    org 0x200               ; assembly address
start:
    LD  V0, WIDTH * 2       ; expressions: + - * / ( ) on labels and constants
    LD  I, sprite
    DRW V0, V1, 4
    JP  start
sprite:
    gfx .####...             ; graphics inline, '.' = 0, anything else = 1
    gfx ####....
    db  0xFF, 0b1010, 'A'   ; numbers: 42, 0xFF, $FF, 0b1010, %1010, 'A'
    dw  start               ; big-endian word
```

All 35 instructions in Cowgod's syntax (`LD`, `DRW`, `SKNP`, `SUBN`, …).
`SHR V3` / `SHL V3` with a single argument assemble to `8XX6`/`8XXE`, so they mean the
same thing regardless of the shift quirk setting.

## ROMs

| File              | Size    | What it does |
|-------------------|---------|---------|
| `bounce.c8asm`    |  78 B   | a ball bouncing off the walls, beeps on bounce |
| `maze.c8asm`      |  44 B   | a random maze from a single `RND` |
| `snake.c8asm`     | 385 B   | snake: ring buffer, collisions, score, restart |
| `pong.c8asm`      | 261 B   | single-paddle bouncer, three lives |

Game controls: **2 = up, 8 = down, 4 = left, 6 = right**
(on a keyboard `W`, `X`, `Q`… following the `1234/QWER/ASDF/ZXCV` map).

## Playing without a browser

`tools/play.js` runs a ROM in Node and draws the screen with half-block characters. Keys
can be scripted or control can be handed to a bot:

```bash
node tools/play.js roms/maze.c8asm  --frames 400 --shots 400
node tools/play.js roms/pong.c8asm  --frames 200 --shots 90 --keys 40:8:60
node tools/play.js roms/snake.c8asm --frames 1400 --bot snake --shots 300,800,1400
```

`--keys` takes `frame:hexKey:frameCount`. The snake bot reads the emulator state the way
a TAS script does: the head lives in `V2`/`V3`, the food in `V7`, the body in the buffer
at `0x400`.

### Turn-based play

`--session <file>` saves the whole machine state (memory, registers, screen, RNG state)
and loads it on the next call. That makes manual play possible: look at the screen,
decide, make one move, look again.

```bash
node tools/play.js roms/snake.c8asm --session save.json --frames 30 --shots 30
node tools/play.js roms/snake.c8asm --session save.json --press 2 --ipf 20 --frames 20 --shots 20
```

`--press` holds the given key for the whole series of frames. A copy of the session file
works like a save state — you can go back before a bad turn.

A practical note: the ROM reads the keypad only in its wait window at the end of a step.
If a series of frames ends mid-step, the first move of the next series still goes in the
old direction — exactly as if you pressed the arrow a split second too late. With longer
series the problem disappears.

Because sprites are drawn with XOR, a ROM that first erases and then draws is blank for
part of every frame. The player overlays the last three frames (like phosphor
persistence) so the screenshot shows what a human sees.

## Notes on accuracy

- `FX0A` waits for a key **press and release**, as on the VIP.
- `RND` runs from a seed (xorshift32), so the tests are reproducible.
- A jump to its own address (`JP` to the same place) is detected as the end of the
  program — the timers keep ticking so the final beep fades out by itself.
- Writes into the font area are flagged in the status panel.
