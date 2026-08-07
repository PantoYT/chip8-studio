# CHIP-8 Studio

Emulator, asembler, deasembler i debugger CHIP-8 w **jednym pliku HTML**, ktory
dziala offline z `file://` — bez serwera, bez internetu, bez zadnej zaleznosci.

```bash
node tests/run.js     # 49 testow: CPU, quirki, asembler, deasembler, ROM-y
node tools/build.js   # -> dist/studio.html  +  dist/*.ch8
```

Potem po prostu otworz `dist/studio.html` w przegladarce.

---

## Co to jest CHIP-8

CHIP-8 to interpretowany jezyk stworzony okolo 1977 przez **Josepha Weisbeckera**
z RCA dla mikrokomputera **COSMAC VIP** (procesor RCA 1802). Nie byl to procesor
sprzetowy, tylko maszyna wirtualna — dzieki temu gry dalo sie pisac raz i
uruchamiac na kazdej maszynie, ktora miala interpreter. Cala specyfikacja to:

| element        | rozmiar                                        |
|----------------|------------------------------------------------|
| pamiec         | 4 KB, program startuje pod `0x200`             |
| rejestry       | `V0`–`VF` (8-bit), `I` (12-bit adresowy)       |
| stos           | 16 poziomow, tylko na adresy powrotu           |
| ekran          | 64 × 32, monochromatyczny, sprite'y rysowane XOR |
| timery         | dwa, 60 Hz: opoznienia (`DT`) i dzwieku (`ST`) |
| dzwiek         | jeden ton, gra dopoki `ST > 0`                 |
| klawiatura     | 16 klawiszy `0`–`F`                            |
| lista rozkazow | 35 instrukcji, kazda 2 bajty                   |

Tyle. Dlatego calkiem grywalny waz miesci sie w **385 bajtach**.

### Skad biora sie „quirki”

Interpretery pisali rozni ludzie na rozne maszyny i kilka instrukcji rozjechalo
sie miedzy wersjami. Nie ma jednego „poprawnego” CHIP-8 — jest oryginalny COSMAC
VIP, jest SUPER-CHIP z kalkulatorow HP-48, i sa nowsze porty. Studio ma je jako
przelaczniki (`Quirki interpretera`), bo to jedyny sposob, zeby stare ROM-y
z internetu dzialaly poprawnie:

- **`8XY1/2/3` zeruja `VF`** — oryginal tak robil, pozniejsze porty nie.
- **`FX55/FX65` zwiekszaja `I`** — po zapisie rejestrow `I` wskazywalo dalej.
- **`DXYN` czeka na klatke** — na VIP rysowanie synchronizowalo sie z obrazem.
  Stad slynne miganie CHIP-8: praktyczny limit to ~1 sprite na klatke.
- **przycinanie sprite'ow** na brzegu ekranu zamiast zawijania.
- **`8XY6/8XYE`** przesuwaja `VY` (oryginal) albo `VX` w miejscu (SUPER-CHIP).
- **`BNNN`** skacze z `V0` (oryginal) albo z `VX` (SUPER-CHIP).

Profil `COSMAC VIP` ustawia wszystko po staremu, `Nowoczesny` po nowemu.

---

## Zawartosc

```
src/chip8.js      rdzen emulatora: 35 instrukcji, timery, quirki, historia
src/asm.js        asembler dwuprzebiegowy + deasembler
roms/*.c8asm      cztery programy napisane w asemblerze CHIP-8
web/studio.html   interfejs (szablon; build wstrzykuje rdzen i ROM-y)
tools/build.js    sklejacz -> dist/studio.html
tools/c8asm.js    asembler z linii polecen: .c8asm -> .ch8
tools/play.js     odtwarzacz headless: renderuje ekran jako tekst
tests/run.js      testy
```

## Studio

- ekran z poswiata luminoforu (cztery kolory) i liniami CRT,
- **debugger z cofaniem czasu** — `Cofnij` odtwarza pelny stan sprzed instrukcji
  (rejestry, pamiec, ekran); bufor trzyma 4096 krokow,
- pulapki: klikniecie linii w deasemblerze,
- podglad pamieci z podswietlonym `PC` i `I`,
- edytor zrodla — `Ctrl+Enter` asembluje i uruchamia, bledy pokazuja numer linii,
- `Pobierz .ch8` zapisuje plik, ktory chodzi w **dowolnym** emulatorze CHIP-8.

## Jezyk asemblera

```asm
define WIDTH 8              ; stala
    org 0x200               ; adres skladania
start:
    LD  V0, WIDTH * 2       ; wyrazenia: + - * / ( ) na etykietach i stalych
    LD  I, sprite
    DRW V0, V1, 4
    JP  start
sprite:
    gfx .####...             ; grafika wprost, '.' = 0, reszta = 1
    gfx ####....
    db  0xFF, 0b1010, 'A'   ; liczby: 42, 0xFF, $FF, 0b1010, %1010, 'A'
    dw  start               ; slowo big-endian
```

Wszystkie 35 instrukcji w skladni Cowgoda (`LD`, `DRW`, `SKNP`, `SUBN`, …).
`SHR V3` / `SHL V3` z jednym argumentem skladaja sie do `8XX6`/`8XXE`, czyli
znacza to samo niezaleznie od ustawienia quirka przesuniec.

## ROM-y

| plik              | rozmiar | co robi |
|-------------------|---------|---------|
| `bounce.c8asm`    |  78 B   | pilka odbijajaca sie od scian, pisk przy odbiciu |
| `maze.c8asm`      |  44 B   | losowy labirynt z jednego `RND` |
| `snake.c8asm`     | 385 B   | waz: bufor cykliczny, kolizje, wynik, restart |
| `pong.c8asm`      | 261 B   | odbijak na jedna paletke, trzy zycia |

Sterowanie w grach: **2 = gora, 8 = dol, 4 = lewo, 6 = prawo**
(na klawiaturze `W`, `X`, `Q`… wedlug mapy `1234/QWER/ASDF/ZXCV`).

## Granie bez przegladarki

`tools/play.js` uruchamia ROM w Node i rysuje ekran znakami polblokowymi.
Klawisze mozna podac skryptem albo oddac sterowanie botowi:

```bash
node tools/play.js roms/maze.c8asm  --frames 400 --shots 400
node tools/play.js roms/pong.c8asm  --frames 200 --shots 90 --keys 40:8:60
node tools/play.js roms/snake.c8asm --frames 1400 --bot snake --shots 300,800,1400
```

`--keys` przyjmuje `klatka:klawiszHex:iloscKlatek`. Bot do weza czyta stan
emulatora tak, jak robi to skrypt TAS: glowa siedzi w `V2`/`V3`, jedzenie w `V7`,
cialo w buforze pod `0x400`.

### Gra na tury

`--session <plik>` zapisuje caly stan maszyny (pamiec, rejestry, ekran, stan
generatora losowego) i wczytuje go przy nastepnym wywolaniu. Dzieki temu mozna
grac recznie: obejrzec ekran, zdecydowac, wykonac jeden ruch, obejrzec znowu.

```bash
node tools/play.js roms/snake.c8asm --session save.json --frames 30 --shots 30
node tools/play.js roms/snake.c8asm --session save.json --press 2 --ipf 20 --frames 20 --shots 20
```

`--press` trzyma podany klawisz przez cala serie klatek. Kopia pliku sesji dziala
jak save state — mozna wrocic przed nieudany skret.

Uwaga praktyczna: ROM czyta klawiature tylko w swoim oknie oczekiwania na koncu
kroku. Jesli seria klatek skonczy sie w srodku kroku, pierwszy ruch nastepnej
serii pojedzie jeszcze starym kierunkiem — dokladnie tak, jakby nacisnac
strzalke ulamek sekundy za pozno. Przy dluzszych seriach problem znika.

Poniewaz sprite'y rysuje sie XOR-em, ROM ktory najpierw wymazuje, a potem rysuje,
przez czesc kazdej klatki jest pusty. Odtwarzacz nakłada trzy ostatnie klatki na
siebie (jak poswiata luminoforu), zeby zrzut pokazywal to, co widzi czlowiek.

## Uwagi o wiernosci

- `FX0A` czeka na **wcisniecie i puszczenie** klawisza, tak jak na VIP.
- `RND` chodzi z ziarna (xorshift32), wiec testy sa powtarzalne.
- Skok pod wlasny adres (`JP` w to samo miejsce) jest wykrywany jako koniec
  programu — timery dalej tykaja, zeby koncowy pisk sam ucichl.
- Zapis w obszar czcionki jest sygnalizowany w panelu stanu.
