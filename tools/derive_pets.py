#!/usr/bin/env python3
"""
Derive new pets from an atlas that is already in the repository.

A derived pet is the same character with a new coat of paint and a bit of
dressing up:

  * the feathers are repainted by projecting every pixel onto the line
    between the cream of the face plate and the orange of the feathers,
    and mixing the two new colours in the same proportion. The cream face
    plate and the white of the eyes keep their colour, the shadows and the
    highlights keep their brightness, and nothing in between ever turns
    into a colour that was not asked for
  * accessories are drawn on top, positioned from the head: the crown is
    found by walking up the sprite from the face plate, and the chin by
    looking at where the cream of the face plate ends

The animation rows, the frames and the timings are **not** touched: the
derived atlas is the source atlas, edited in place. So a derived pet moves
exactly like the one it came from.

Run:
    python3 tools/derive_pets.py            # build every variant
    python3 tools/derive_pets.py --debug    # also write an anchor overlay
"""
from __future__ import annotations

import argparse
import colorsys
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..')
PETS_DIR = os.path.join(ROOT, 'pets')

CELL_W, CELL_H = 192, 208
COLS, ROWS = 8, 11

# The cream of the face plate, measured off the real atlas: a lit face sits
# at saturation 0.26, a face in shadow at 0.42, and the feathers are above
# 0.8. The cut therefore clears the feathers by a wide margin while still
# catching the shaded frames.
FACE_MAX_SAT = 0.46
FACE_MIN_VAL = 0.58
FACE_MIN_AREA = 350
FACE_MIN_WIDTH = 28

# The variants that get built. Each one is a different coat of paint on the
# same bird; the accessories are picked to sit well on that colour.
VARIANTS = [
    {
        'id': 'teal-hoot',
        'name': 'Teal Hoot',
        'description': 'The sharp-eyed owl in teal, with an amber beanie and a coral bow tie.',
        'source': 'hoots',
        'shift': 145,
        'tint': 1.0,
        'shade': 0.85,
        'beanie': (238, 168, 38),
        'bow_tie': (214, 72, 58),
        'ink': (38, 26, 22),
    },
    {
        'id': 'violet-hoot',
        'name': 'Violet Hoot',
        'description': 'The sharp-eyed owl in violet, with a coral beanie and a gold bow tie.',
        'source': 'hoots',
        'shift': 250,
        'tint': 1.0,
        'shade': 0.85,
        'beanie': (226, 92, 72),
        'bow_tie': (255, 196, 64),
        'ink': (38, 26, 22),
    },
    {
        'id': 'mint-hoot',
        'name': 'Mint Hoot',
        'description': 'The sharp-eyed owl in mint green, with a navy beanie and a pink bow tie.',
        'source': 'hoots',
        'shift': 110,
        'tint': 1.0,
        'shade': 0.85,
        'beanie': (38, 62, 120),
        'bow_tie': (240, 126, 168),
        'ink': (24, 30, 44),
    },
]


# The palette of the source bird, measured off the real atlas: the cream of
# the face plate and the orange of the feathers. The beak and the little
# wedge of forehead share the feather colour.
CREAM = (253, 225, 181)
FEATHER = (253, 125, 1)


# ---------------------------------------------------------------------------
# Recolouring
# ---------------------------------------------------------------------------

def _lum(rgb):
    """The perceived brightness of a colour."""
    return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]


def _rotate(rgb, degrees, sat_boost=0.0):
    """Rotate the hue of a colour and optionally push its saturation."""
    r, g, b = rgb
    h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    h = (h * 360 + degrees) % 360
    s = min(1.0, s * (1 + sat_boost))
    nr, ng, nb = colorsys.hsv_to_rgb(h / 360, s, v)
    return (nr * 255, ng * 255, nb * 255)


def build_palette(shift, tint, shade=0.85):
    """The new palette for a coat of paint.

    The cream of the face plate stays cream -- only a touch less saturated,
    so it sits a little better against the new colour. The feathers turn by
    the full shift, get a little more saturated and are darkened a touch,
    because a fully bright colour reads as neon on a small sprite.
    """
    axis = tuple(FEATHER[i] - CREAM[i] for i in range(3))
    feather = _rotate(FEATHER, shift, 0.12 * tint)
    return {
        'cream': _rotate(CREAM, 0, -0.15 * tint),
        'feather': tuple(value * shade for value in feather),
        'axis': axis,
        'denom': sum(value * value for value in axis),
        'cream_lum': _lum(CREAM),
        'feather_lum': _lum(FEATHER),
        'shift': shift,
    }


def recolour(pixel, palette):
    """Repaint a pixel in the new palette.

    The colour of the bird lies along the line from the cream of the face
    plate to the orange of the feathers. A pixel is projected onto that
    line to find out how much feather it holds, and then it is painted with
    the same mix of the new colours. The brightness of the original is kept
    as a ratio, which is what preserves the shadows and the highlights of
    the original render.

    Working this way, rather than rotating the hue of every pixel, is what
    keeps the shadowed parts of the face plate from turning green: the
    only two colours that ever appear are the new cream and the new
    feather colour, and everything in between is a mix of the two.
    """
    r, g, b, a = pixel
    if a == 0:
        return pixel
    h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    if s < 0.08 and v > 0.85:
        # the white of the eyes: it is a highlight, not a mix, so it keeps
        # its own colour with a whisper of the new one
        tint_rgb = _rotate((255, 255, 255), palette['shift'], 0.0)
        return (int(r * 0.94 + tint_rgb[0] * 0.06),
                int(g * 0.94 + tint_rgb[1] * 0.06),
                int(b * 0.94 + tint_rgb[2] * 0.06), a)

    axis = palette['axis']
    t = ((r - CREAM[0]) * axis[0] + (g - CREAM[1]) * axis[1]
         + (b - CREAM[2]) * axis[2]) / palette['denom']
    t = min(1.0, max(0.0, t))
    cream, feather = palette['cream'], palette['feather']
    base = [cream[i] + (feather[i] - cream[i]) * t for i in range(3)]
    ramp = palette['cream_lum'] + (palette['feather_lum'] - palette['cream_lum']) * t
    ratio = (_lum((r, g, b)) / ramp) if ramp > 1 else 1.0
    return (int(min(255.0, max(0.0, base[0] * ratio))),
            int(min(255.0, max(0.0, base[1] * ratio))),
            int(min(255.0, max(0.0, base[2] * ratio))), a)


# ---------------------------------------------------------------------------
# Finding the face
# ---------------------------------------------------------------------------

def _pixels(cell):
    """The pixels of an image, in reading order.

    Pillow 13 renamed ``getdata`` to ``get_flattened_data``; both spellings
    are handled so the tool keeps working either way.
    """
    getter = getattr(cell, 'get_flattened_data', None) or cell.getdata
    return list(getter())


def _components(mask, width, height):
    """The connected components of a boolean mask."""
    seen = [[False] * width for _ in range(height)]
    out = []
    for y in range(height):
        for x in range(width):
            if not mask[y][x] or seen[y][x]:
                continue
            stack = [(x, y)]
            seen[y][x] = True
            points = []
            while stack:
                cx, cy = stack.pop()
                points.append((cx, cy))
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = cx + dx, cy + dy
                    if 0 <= nx < width and 0 <= ny < height \
                            and mask[ny][nx] and not seen[ny][nx]:
                        seen[ny][nx] = True
                        stack.append((nx, ny))
            xs = [p[0] for p in points]
            ys = [p[1] for p in points]
            out.append((min(xs), min(ys), max(xs), max(ys), len(points)))
    return out


def find_face(cell):
    """Where the face plate is in this frame.

    The face plate is the big warm cream shape. The highest cream blob is
    the face -- the props the bird holds (a mug, a notepad, a book) sit
    lower, and the belly catches a highlight but that is further down too.

    Returns (x0, y0, x1, y1) or None when there is no cream at all, which
    happens when the bird has turned its back on us.
    """
    width, height = cell.size
    pixels = cell.load()
    mask = [[False] * width for _ in range(height)]
    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if a < 200:
                continue
            h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
            if s <= FACE_MAX_SAT and v >= FACE_MIN_VAL and r >= g >= b:
                mask[y][x] = True
    blobs = [c for c in _components(mask, width, height)
             if c[4] >= FACE_MIN_AREA and (c[2] - c[0]) >= FACE_MIN_WIDTH]
    if not blobs:
        return None
    # the topmost cream blob; a tie is broken by size
    x0, y0, x1, y1, _ = min(blobs, key=lambda c: (c[1], -c[4]))
    return (x0, y0, x1, y1)


def sprite_box(cell):
    """The bounding box of the whole sprite."""
    return cell.getchannel('A').getbbox()


def crown_centre(cell):
    """Where the top of the head is, in the frames where the bird turns.

    In the frames where the bird turns to look at something, the body stays
    put and only the head turns, so the crown of the head does not move on
    screen: the middle of the silhouette a little below the top of the
    sprite is the best sign of where it is. The face, meanwhile, swings
    from one side to the other and is a poor anchor there.
    """
    alpha = cell.getchannel('A')
    box = alpha.getbbox()
    if box is None:
        return None
    row = min(box[1] + 8, cell.size[1] - 1)
    span = alpha.crop((0, row, cell.size[0], row + 1)).getbbox()
    if span is None or span[2] - span[0] < 8:
        return None
    return (span[0] + span[2]) // 2


def head_crown(cell, face):
    """The top of the head, measured above the face.

    The crown is the top of the run of solid pixels that sits above the
    face plate. This is a better measure of the head than the height of
    the face plate itself, which the light on the belly sometimes swells.
    """
    pixels = cell.load()
    x = (face[0] + face[2]) // 2
    y = face[1] - 1
    while y >= 0 and pixels[x, y][3] > 40:
        y -= 1
    return y + 1


def chin(cell, face):
    """The bottom of the face plate.

    Every column through the face plate ends its first run of cream at a
    different height -- the eyes cut into it here and there, the line of
    the glasses cuts it everywhere else. The bottom of the face plate is
    where most of those columns end, so the four fifths mark is used: one
    pair of eyes is not enough to drag it up, and one bald patch is not
    enough to drag it down.
    """
    pixels = cell.load()
    x0, y0, x1, _ = face
    ends = []
    for x in range(x0, x1 + 1):
        y = y0
        while y < cell.size[1] and not _is_cream(pixels[x, y]):
            y += 1
        if y >= cell.size[1]:
            continue
        while y < cell.size[1] and _is_cream(pixels[x, y]):
            y += 1
        ends.append(y)
    if not ends:
        return y0
    ends.sort()
    return ends[int((len(ends) - 1) * 0.8)]


def _is_cream(pixel):
    """Is this pixel the warm cream of the face plate?"""
    r, g, b, a = pixel
    if a < 200:
        return False
    h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    return s <= FACE_MAX_SAT and v >= FACE_MIN_VAL and r >= g >= b


# ---------------------------------------------------------------------------
# Accessories
# ---------------------------------------------------------------------------

def _shadow(cell, body, ink, offset=2, strength=0.35):
    """A soft shadow under an accessory, so it sits on the bird.

    The shape is drawn once, its alpha becomes the silhouette of a plain
    dark blob, and that blob is blurred and dropped a couple of pixels
    down. Doing it this way keeps the shadow the colour of the outline
    rather than the colour of the accessory.
    """
    width, height = cell.size
    layer = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    body(ImageDraw.Draw(layer))
    alpha = layer.getchannel('A').point(lambda value: int(value * strength))
    shadow = Image.new('RGBA', (width, height), tuple(ink[:3]) + (0,))
    shadow.putalpha(alpha)
    shadow = shadow.filter(ImageFilter.GaussianBlur(2))
    cell.alpha_composite(shadow, (0, offset))


def draw_beanie(cell, cx, brim_y, half_width, dome_h, colour, ink):
    """A knitted hat with a turned-up cuff and a pompom.

    The brim sits just above the face plate and the dome rises over the
    head. The cuff is what stops the hat from reading as a plain head
    band, and the fold line inside it says "knitted".
    """
    width, height = cell.size
    cuff_h = dome_h * 0.26

    def body(draw):
        draw.pieslice([cx - half_width, brim_y - dome_h,
                       cx + half_width, brim_y + dome_h],
                      start=180, end=360, fill=colour, outline=ink, width=1)
        draw.rounded_rectangle([cx - half_width * 1.10, brim_y - cuff_h * 0.55,
                                cx + half_width * 1.10, brim_y + cuff_h * 0.55],
                               radius=2, fill=colour, outline=ink, width=1)
        draw.line([(cx - half_width * 1.04, brim_y - cuff_h * 0.16),
                   (cx + half_width * 1.04, brim_y - cuff_h * 0.16)],
                  fill=ink, width=1)
        pom = dome_h * 0.24
        draw.ellipse([cx - pom, brim_y - dome_h - pom * 0.75,
                      cx + pom, brim_y - dome_h + pom * 1.25],
                     fill=colour, outline=ink, width=1)

    _shadow(cell, body, ink)
    layer = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    body(ImageDraw.Draw(layer))
    cell.alpha_composite(layer)


def draw_bow_tie(cell, cx, cy, half_width, colour, ink):
    """A bow tie under the chin."""
    width, height = cell.size
    arm = half_width

    def body(draw):
        draw.polygon([(cx - arm, cy - arm * 0.45), (cx - arm * 0.22, cy - arm * 0.20),
                      (cx - arm * 0.22, cy + arm * 0.34), (cx - arm, cy + arm * 0.62)],
                     fill=colour, outline=ink, width=1)
        draw.polygon([(cx + arm, cy - arm * 0.45), (cx + arm * 0.22, cy - arm * 0.20),
                      (cx + arm * 0.22, cy + arm * 0.34), (cx + arm, cy + arm * 0.62)],
                     fill=colour, outline=ink, width=1)
        draw.ellipse([cx - arm * 0.30, cy - arm * 0.30,
                      cx + arm * 0.30, cy + arm * 0.42],
                     fill=colour, outline=ink, width=1)

    _shadow(cell, body, ink)
    layer = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    body(ImageDraw.Draw(layer))
    cell.alpha_composite(layer)


def place_accessories(cell, variant, face, gaze=False):
    """Dress the frame up, using the head as the landmark."""
    if face is None:
        # The bird has its back to us: a hat would still be on its head, but
        # a bow tie would be hidden behind the neck, so it is left off.
        bounds = sprite_box(cell)
        if bounds is None or 'beanie' not in variant:
            return
        width = bounds[2] - bounds[0]
        cx = (bounds[0] + bounds[2]) // 2
        draw_beanie(cell, cx, bounds[1] + 4, int(width * 0.28),
                    int(width * 0.22), variant['beanie'], variant['ink'])
        return

    x0, y0, x1, y1 = face
    fw = x1 - x0
    cx = (x0 + x1) // 2

    # The crown of the head. When the bird turns its head the crown stays
    # put on screen, so it is read off the silhouette; otherwise it is read
    # off the column of pixels above the face.
    if gaze:
        bounds = sprite_box(cell)
        crown_y = bounds[1] if bounds else y0
        hat_x = crown_centre(cell)
        if hat_x is None:
            hat_x = cx
    else:
        crown_y = head_crown(cell, face)
        hat_x = cx
    head_above = max(4, y0 - crown_y)

    if 'beanie' in variant:
        # the dome covers the head above the face, and the brim sits just
        # above the face plate
        dome_h = max(8, min(int(head_above * 0.85), int(fw * 0.45)))
        brim_y = y0 - int(head_above * 0.08)
        # the pompom on top must stay inside the cell
        dome_h = min(dome_h, max(4, int((brim_y - 2) / 1.18)))
        draw_beanie(cell, hat_x, brim_y, int(fw * 0.36), dome_h,
                    variant['beanie'], variant['ink'])

    if 'bow_tie' in variant:
        # The bow tie hangs under the beak. The beak hangs under the chin,
        # and the beak is about as long as the head is tall, so the bow tie
        # goes a good way further down. It is also kept close to the face
        # plate, so that a bird holding a book does not end up wearing its
        # bow tie on the book.
        bow_y = chin(cell, face) + int(head_above * 0.85)
        bow_y = min(bow_y, y1 + int(fw * 0.25))
        draw_bow_tie(cell, cx, bow_y, int(fw * 0.16),
                     variant['bow_tie'], variant['ink'])


# ---------------------------------------------------------------------------
# The derivation itself
# ---------------------------------------------------------------------------

def derive(variant, debug=False):
    """Build a new pet out of an existing one."""
    source = variant['source']
    target = variant['id']
    source_dir = os.path.join(PETS_DIR, source)
    with open(os.path.join(source_dir, 'pet.json'), encoding='utf-8') as handle:
        manifest = json.load(handle)
    sheet_name = manifest.get('spritesheetPath') or 'spritesheet.webp'
    with Image.open(os.path.join(source_dir, sheet_name)) as opened:
        atlas = opened.convert('RGBA')

    shift = variant['shift']
    tint = variant['tint']
    palette = build_palette(shift, tint, variant.get('shade', 0.85))
    anchors = []
    # the rows where the bird turns its head to look at something
    gaze_rows = set((manifest.get('look') or {}).get('rows') or [])

    for row in range(ROWS):
        for column in range(COLS):
            box = (column * CELL_W, row * CELL_H,
                   (column + 1) * CELL_W, (row + 1) * CELL_H)
            cell = atlas.crop(box)
            # the face plate is found on the original frame: repainting can
            # change how a colour reads, and the original is what the
            # landmark was measured on
            face = find_face(cell)
            anchors.append((row, column, face))
            recoloured = Image.new('RGBA', cell.size, (0, 0, 0, 0))
            recoloured.putdata([recolour(p, palette) for p in _pixels(cell)])
            place_accessories(recoloured, variant, face, gaze=row in gaze_rows)
            atlas.paste(recoloured, box)

    target_dir = os.path.join(PETS_DIR, target)
    os.makedirs(target_dir, exist_ok=True)
    atlas.save(os.path.join(target_dir, 'spritesheet.webp'), 'WEBP',
               lossless=True, quality=100, method=6)
    write_preview(target_dir, atlas)
    manifest['id'] = target
    manifest['name'] = variant['name']
    manifest['description'] = variant['description']
    manifest['source'] = (f'derived from "{source}" by tools/derive_pets.py '
                           f'(hue +{shift} degrees)')
    with open(os.path.join(target_dir, 'pet.json'), 'w', encoding='utf-8') as handle:
        json.dump(manifest, handle, indent=2, ensure_ascii=False)
        handle.write('\n')

    missing = [a for a in anchors if a[2] is None and sprite_box(atlas.crop(
        (a[1] * CELL_W, a[0] * CELL_H, (a[1] + 1) * CELL_W, (a[0] + 1) * CELL_H)))
        is not None]
    print(f'  {source} -> {target}  ({variant["name"]})')
    if missing:
        print(f'      {len(missing)} frame(s) with no face plate: '
              + ', '.join(f'r{r}c{c}' for r, c, _ in missing))
    if debug:
        write_debug(target, anchors)
    return anchors


def write_preview(directory, atlas):
    """The gallery still: the idle frame on a soft blue disc."""
    from make_pets import _disc                     # noqa: PLC0415

    frame = atlas.crop((0, 0, CELL_W, CELL_H))
    disc = _disc(600, 288, (214, 237, 255), (174, 206, 241))
    shadow = Image.new('RGBA', (600, 600), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).ellipse([230, 452, 370, 486], fill=(120, 152, 190, 120))
    shadow = shadow.filter(ImageFilter.GaussianBlur(7))
    canvas = Image.new('RGBA', (600, 600), (0, 0, 0, 0))
    canvas.alpha_composite(disc)
    canvas.alpha_composite(shadow)
    canvas.alpha_composite(frame, ((600 - frame.width) // 2, 424 - frame.height))
    canvas.save(os.path.join(directory, 'preview.png'))


def write_debug(target, anchors):
    """A contact sheet with the face plate of every frame outlined."""
    atlas = Image.open(os.path.join(PETS_DIR, target, 'spritesheet.webp')).convert('RGBA')
    scale = 0.5
    tw, th = int(CELL_W * scale), int(CELL_H * scale)
    pad = 6
    sheet = Image.new('RGBA', (COLS * tw + (COLS + 1) * pad, ROWS * th + (ROWS + 1) * pad),
                      (245, 245, 248, 255))
    for row, column, face in anchors:
        cell = atlas.crop((column * CELL_W, row * CELL_H,
                           (column + 1) * CELL_W, (row + 1) * CELL_H))
        if face is not None:
            draw = ImageDraw.Draw(cell)
            draw.rectangle(face, outline=(0, 210, 90, 255), width=1)
        small = cell.resize((tw, th), Image.LANCZOS)
        sheet.alpha_composite(small, (pad + column * (tw + pad), pad + row * (th + pad)))
    path = os.path.join('/tmp', f'derive-debug-{target}.png')
    sheet.save(path)
    print(f'      debug sheet -> {path}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--debug', action='store_true',
                        help='also write an overlay showing the face plate anchors')
    parser.add_argument('--only', help='build just this variant')
    args = parser.parse_args()

    sys.path.insert(0, HERE)
    print('deriving pets from hoots:')
    for variant in VARIANTS:
        if args.only and variant['id'] != args.only:
            continue
        derive(variant, debug=args.debug)


if __name__ == '__main__':
    main()
