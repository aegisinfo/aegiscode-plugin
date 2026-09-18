#!/usr/bin/env python3
"""Screenshot the real `aegiscode` CLI.

Why a pty and not a mockup: the marketing page's caption promises a capture
"rendered from the running app rather than a mockup", so this spawns
`cli/bin/aegiscode.js` on a pseudo-terminal at a fixed size, walks onboarding
with real keystrokes (trust check -> theme picker -> welcome), keeps the LAST
full-frame repaint the app wrote, and rasterises those exact bytes. Nothing in
the pipeline invents a line that the CLI did not print.

The frame comes from `src/screen.js::paint()`, which is why the parser is
tolerant rather than clever: `\\x1b[H` starts a frame, every row is prefixed
with `\\x1b[0m` and suffixed with `\\x1b[0K`, and the styles are the truecolor
SGR pairs `src/theme.js` emits (`\\x1b[38;2;r;g;bm`). Full ANSI is decoded
anyway (8/16/256/truecolor, bold, dim, inverse, underline) so a future theme
that drops to 256 colours still renders.

Usage:
  python3 tools/cli-screenshot.py OUT.png [--cols 100] [--rows 24] [--first-run]

`--first-run` keeps the onboarding screens' narrative (the welcome greets a
new user); without it the shot says "Welcome back!". Requires `node` and
Pillow; no terminal emulator, X server or ImageMagick needed.
"""
import argparse
import fcntl
import os
import pty
import re
import select
import shutil
import signal
import struct
import sys
import tempfile
import termios
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(HERE, '..', 'cli', 'bin', 'aegiscode.js')

# The terminal the shot is taken in. Kept as an explicit default rather than
# inherited so the PNG is reproducible on any machine: an 80-column terminal
# stacks the two welcome boxes, which is not the layout the page shows.
DEFAULT_COLS, DEFAULT_ROWS = 100, 24

# The default background is NOT taken from the stream -- the CLI only sets a
# background where it means to, so an unstyled cell is "whatever the terminal
# is". This is the same value the page's terminal chrome uses.
DEFAULT_BG = (30, 30, 46)
DEFAULT_FG = (205, 214, 244)

CELL_W, CELL_H = 9, 20  # px per cell; DejaVu Sans Mono at 16px + leading
FONT_PX = 16
FONT_DIRS = ['/usr/share/fonts/truetype/dejavu', '/usr/share/fonts/truetype/noto',
             '/usr/share/fonts/truetype/liberation']
MONO_FONTS = ['DejaVuSansMono.ttf', 'NotoSansMono-Regular.ttf', 'LiberationMono-Regular.ttf']
MONO_BOLD = ['DejaVuSansMono-Bold.ttf', 'NotoSansMono-Bold.ttf', 'LiberationMono-Bold.ttf']
FALLBACK_FONTS = ['DejaVuSans.ttf', 'NotoSansSymbols2-Regular.ttf', 'NotoSansSymbols-Regular.ttf']

ANSI16 = [
    (0, 0, 0), (205, 49, 49), (13, 188, 121), (229, 229, 16),
    (36, 114, 200), (188, 63, 188), (17, 168, 205), (229, 229, 229),
    (102, 102, 102), (241, 76, 76), (35, 209, 139), (245, 245, 67),
    (59, 142, 234), (214, 112, 214), (41, 184, 219), (255, 255, 255),
]


# ── capture ─────────────────────────────────────────────────────────────────

def capture(cols, rows, first_run, settle=3.0):
    """Run the CLI on a pty and return every byte it wrote before we quit."""
    home = tempfile.mkdtemp(prefix='aegiscode-shot-')
    # A returning user skips the trust check and the theme picker, so the
    # walk-through below is only needed (and only sent) on a first run.
    if not first_run:
        with open(os.path.join(home, 'config.json'), 'w') as fh:
            fh.write('{"themeIndex": 1}\n')
    env = {
        'PATH': os.environ.get('PATH', '/usr/bin:/bin'),
        'HOME': home,
        'AEGISCODE_HOME': home,
        # A key in the environment is what keeps `requestApiKey` out of the
        # sequence -- the welcome screen is the subject, not a credential
        # prompt. Nothing is ever sent to it.
        'AEGIS_API_KEY': 'shot-capture-placeholder',
        'TERM': 'xterm-256color',
        'COLORTERM': 'truecolor',
        'LANG': 'C.UTF-8',
    }
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(os.path.join(HERE, '..'))
        os.execvpe('node', ['node', os.path.abspath(CLI)], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

    buf = bytearray()

    def drain(seconds):
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([fd], [], [], 0.1)
            if not ready:
                continue
            try:
                data = os.read(fd, 1 << 16)
            except OSError:
                return
            if not data:
                return
            buf.extend(data)

    try:
        drain(2.5)
        if first_run:
            os.write(fd, b'\r')   # trust check: accept
            drain(1.5)
            os.write(fd, b'\r')   # theme picker: keep the default row
        drain(settle)
        snapshot = bytes(buf)
        os.write(fd, b'\x03')     # ctrl+c: leave without entering the session
        drain(0.5)
    finally:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.close(fd)
        shutil.rmtree(home, ignore_errors=True)
    return snapshot


# ── ANSI frame decoding ─────────────────────────────────────────────────────

CSI_RE = re.compile(r'\x1b\[([0-9;?]*)([A-Za-z])')


def _xterm256(n):
    if n < 16:
        return ANSI16[n]
    if n < 232:
        n -= 16
        steps = [0, 95, 135, 175, 215, 255]
        return (steps[n // 36], steps[(n // 6) % 6], steps[n % 6])
    v = 8 + (n - 232) * 10
    return (v, v, v)


class Frame:
    """A grid of styled cells, built by replaying the app's byte stream."""

    def __init__(self, cols, rows):
        self.cols, self.rows = cols, rows
        self.cells = {}   # (row, col) -> (char, fg, bg, bold)

    def blank_row(self, row, start):
        for col in range(start, self.cols):
            self.cells.pop((row, col), None)

    def put(self, row, col, ch, style):
        if col >= self.cols:
            return
        self.cells[(row, col)] = (ch,) + style

    def used_rows(self):
        return max((r for (r, _) in self.cells), default=0) + 1

    def last_frame(self, data):
        """Take the last complete `paint()` frame: `\\x1b[H` .. end."""
        if isinstance(data, bytes):
            data = data.decode('utf-8', 'replace')
        marks = [m.start() for m in re.finditer(r'\x1b\[H', data)]
        if not marks:
            raise SystemExit('no full-frame paint found in the capture')
        return self.replay(data[marks[-1] + 3:])

    def replay(self, text):
        row = col = 0
        fg, bg, bold, dim, inverse, underline = DEFAULT_FG, None, False, False, False, False
        i, n = 0, len(text)
        while i < n:
            ch = text[i]
            if ch == '\x1b':
                m = CSI_RE.match(text, i)
                if not m:
                    i += 1
                    continue
                params, final = m.group(1), m.group(2)
                i = m.end()
                if final == 'H':
                    parts = [int(p) for p in params.split(';') if p] or [1, 1]
                    row = (parts[0] if parts else 1) - 1
                    col = (parts[1] - 1) if len(parts) > 1 else 0
                elif final == 'K':           # erase to end of line
                    self.blank_row(row, col)
                elif final == 'J':           # erase display
                    kind = int(params or 0)
                    if kind in (2, 3):
                        self.cells.clear()
                    else:
                        self.blank_row(row, col)
                        for r in range(row + 1, self.rows):
                            self.blank_row(r, 0)
                elif final == 'm':
                    fg, bg, bold, dim, inverse, underline = self.sgr(
                        params, fg, bg, bold, dim, inverse, underline)
                elif final in 'ABCD':
                    d = int(params or 1)
                    col = max(0, col - d) if final == 'D' else col + d if final == 'C' else col
                    row = max(0, row - d) if final == 'A' else row + d if final == 'B' else row
                continue
            if ch == '\r':
                col = 0
            elif ch == '\n':
                row, col = row + 1, col
            elif ch == '\b':
                col = max(0, col - 1)
            elif ch == '\t':
                col += 8 - (col % 8)
            elif ch >= ' ':
                style_fg, style_bg = fg, bg
                if inverse:
                    style_fg, style_bg = (style_bg or DEFAULT_BG), (style_fg or DEFAULT_FG)
                self.put(row, col, ch, (style_fg, style_bg, bold or underline))
                col += 1
            i += 1
        return self

    @staticmethod
    def sgr(params, fg, bg, bold, dim, inverse, underline):
        nums = [int(p) for p in params.split(';') if p != ''] or [0]
        i = 0
        while i < len(nums):
            v = nums[i]
            if v == 0:
                fg, bg, bold, dim, inverse, underline = DEFAULT_FG, None, False, False, False, False
            elif v == 1:
                bold = True
            elif v == 2:
                dim = True
            elif v == 4:
                underline = True
            elif v == 7:
                inverse = True
            elif v in (22, 24):
                bold = dim = underline = False
            elif v == 27:
                inverse = False
            elif v == 39:
                fg = DEFAULT_FG
            elif v == 49:
                bg = None
            elif 30 <= v <= 37:
                fg = ANSI16[v - 30]
            elif 90 <= v <= 97:
                fg = ANSI16[v - 90 + 8]
            elif 40 <= v <= 47:
                bg = ANSI16[v - 40]
            elif 100 <= v <= 107:
                bg = ANSI16[v - 100 + 8]
            elif v in (38, 48):
                target, i = ('fg' if v == 38 else 'bg'), i + 1
                if i < len(nums) and nums[i] == 5:
                    colour = _xterm256(nums[i + 1]); i += 2
                elif i < len(nums) and nums[i] == 2:
                    colour = tuple(nums[i + 1:i + 4]); i += 4
                else:
                    colour = None
                if colour:
                    fg = colour if target == 'fg' else fg
                    bg = colour if target == 'bg' else bg
            i += 1
        return fg, bg, bold, dim, inverse, underline


# ── rasterise ───────────────────────────────────────────────────────────────

def load_font(names, size):
    from PIL import ImageFont
    for name in names:
        for d in FONT_DIRS:
            path = os.path.join(d, name)
            if os.path.exists(path):
                return ImageFont.truetype(path, size), path
    raise SystemExit('no usable font found in ' + ', '.join(FONT_DIRS))


def render(frame, out_path, scale=1.0):
    """Rasterise at `scale`x. The page shows the PNG in an ~818px box, so a
    2x render is ~1:1 on a retina display and smooth (not jaggy) elsewhere."""
    from PIL import Image, ImageDraw
    cell_w, cell_h = round(CELL_W * scale), round(CELL_H * scale)
    font_px = round(FONT_PX * scale)
    font, primary = load_font(MONO_FONTS, font_px)
    bold_font, _ = load_font(MONO_BOLD, font_px)
    fallbacks = [load_font([n], font_px)[0] for n in FALLBACK_FONTS]

    def glyph_font(ch, want_bold):
        """Fonts are per-glyph: the box drawing block is in the mono face, but
        the ❯ prompt glyph is not, and a missing glyph in Pillow draws a
        notdef box that would read as a rendering fault."""
        for f in ((bold_font if want_bold else font), font, *fallbacks):
            if f.getmask('X').size and _has_glyph(f, ch):
                return f
        return font

    rows = frame.used_rows()
    img = Image.new('RGB', (frame.cols * cell_w, rows * cell_h), DEFAULT_BG)
    draw = ImageDraw.Draw(img)
    for (row, col), (ch, fg, bg, bold) in sorted(frame.cells.items()):
        if row >= rows or ch == ' ':
            if bg:
                draw.rectangle([col * cell_w, row * cell_h,
                                (col + 1) * cell_w - 1, (row + 1) * cell_h - 1], fill=bg)
            continue
        x, y = col * cell_w, row * cell_h
        if bg:
            draw.rectangle([x, y, x + cell_w - 1, y + cell_h - 1], fill=bg)
        f = glyph_font(ch, bold)
        draw.text((x, y), ch, font=f, fill=fg or DEFAULT_FG)
    img.save(out_path)
    print(f'{out_path}: {img.width}x{img.height} ({frame.cols}x{rows} cells, '
          f'{scale:g}x, font {os.path.basename(primary)}@{font_px}px)')
    return img.size


_glyph_cache = {}


def _has_glyph(font, ch):
    key = (id(font), ch)
    if key not in _glyph_cache:
        # Pillow's notdef for a TrueType face is a constant empty or box
        # bitmap, so "does it differ from notdef?" is the cheapest probe that
        # needs no fontTools dependency. `getmask` returns an ImagingCore
        # (no .tobytes()), so materialise it with bytes().
        _glyph_cache[key] = bytes(font.getmask(ch)) != bytes(font.getmask('\uffff'))
    return _glyph_cache[key]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('out')
    ap.add_argument('--cols', type=int, default=DEFAULT_COLS)
    ap.add_argument('--rows', type=int, default=DEFAULT_ROWS)
    ap.add_argument('--first-run', action='store_true', default=True,
                    help='walk the onboarding screens so the welcome greets a new user')
    ap.add_argument('--returning', dest='first_run', action='store_false',
                    help='skip onboarding: "Welcome back!"')
    ap.add_argument('--scale', type=float, default=2.0,
                    help='render at Nx for retina/print (default 2)')
    ap.add_argument('--raw-out', help='also write the captured byte stream here')
    args = ap.parse_args()

    data = capture(args.cols, args.rows, args.first_run)
    if args.raw_out:
        with open(args.raw_out, 'wb') as fh:
            fh.write(data)
    frame = Frame(args.cols, args.rows).last_frame(data)
    render(frame, args.out, args.scale)
    return 0


if __name__ == '__main__':
    sys.exit(main())
