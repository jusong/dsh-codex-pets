#!/usr/bin/env python3
"""
Port a custom Codex pet into this project.

The official pets come off the Codex CDN or out of the desktop bundle, but
Codex also lets you install pets of your own. Those live in a directory
under ``~/.codex/pets/`` with a ``pet.json`` and a ``spritesheet.webp``, and
they are already the v2 shape -- 8 columns x 11 rows of 192x208 cells -- so
they only need a manifest in this project's dialect and a gallery preview.

    python3 tools/port_custom_pet.py ~/.codex/pets/deepseek-2 \\
        --id deepseek --name "蓝色大肥鱼"

What this script works out on its own
-------------------------------------

* **How many frames each row has.** The official rows are all different
  lengths (idle has six, running has eight, waving has four), and a custom
  pet need not follow them: the one this was written for has *seven* idle
  frames. The frames are counted off the alpha channel -- a row is as long
  as the last cell that still has something in it -- and the timings are
  stretched to fit, keeping the rule the official table follows: every
  frame lasts a fixed step except the last one, which lingers.
* **That the atlas really is 8x11.** A custom pet that came out of a
  generator can be the wrong size, and the engine would quietly draw the
  wrong cells rather than complain.

Usage:
    python3 tools/port_custom_pet.py <source-dir> --id <id> --name <name>
                                      [--description <text>]
                                      [--source <text>]
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..')
PETS_DIR = os.path.join(ROOT, 'pets')

sys.path.insert(0, HERE)

CELL_W, CELL_H = 192, 208
COLS, ROWS = 8, 11
ATLAS_W, ATLAS_H = CELL_W * COLS, CELL_H * ROWS

# The nine standard rows, in the order the Codex atlases use them, with the
# official per-frame timings. Every frame of a row lasts `step`, except the
# last one, which lingers.
ANIMATIONS = {
    "idle": {"row": 0, "durations": [280, 110, 110, 140, 140, 320]},
    "running-right": {"row": 1, "durations": [120, 120, 120, 120, 120, 120, 120, 220]},
    "running-left": {"row": 2, "durations": [120, 120, 120, 120, 120, 120, 120, 220]},
    "waving": {"row": 3, "durations": [140, 140, 140, 280]},
    "jumping": {"row": 4, "durations": [140, 140, 140, 140, 280]},
    "failed": {"row": 5, "durations": [140, 140, 140, 140, 140, 140, 140, 240]},
    "waiting": {"row": 6, "durations": [150, 150, 150, 150, 150, 260]},
    "running": {"row": 7, "durations": [120, 120, 120, 120, 120, 220]},
    "review": {"row": 8, "durations": [150, 150, 150, 150, 150, 280]},
}

# The rows that actually move the body, and so are worth fidgeting through
# when the pet is otherwise sitting still.
IDLE_ROUTINE = ["waiting", "waving", "running"]


def frames_in_row(atlas, row: int) -> int:
    """How many frames this row really has.

    A row ends where the cells stop having anything in them. The official
    atlases leave the tail of a short row empty, and a generated one does
    the same.
    """
    alpha = atlas.getchannel('A')
    count = 0
    for column in range(COLS):
        cell = alpha.crop((column * CELL_W, row * CELL_H,
                           (column + 1) * CELL_W, (row + 1) * CELL_H))
        if cell.getbbox() is None:
            break
        count += 1
    # A hole in the middle of a row would mean the pet is broken, not that
    # the row is short.
    for column in range(count, COLS):
        cell = alpha.crop((column * CELL_W, row * CELL_H,
                           (column + 1) * CELL_W, (row + 1) * CELL_H))
        if cell.getbbox() is not None:
            raise SystemExit(f'row {row} is empty at cell {column} but has '
                             'frames after it')
    return count


def timings_for(row: int, count: int) -> list[int]:
    """The per-frame timings for a row of this length.

    The official table is the starting point. A longer row repeats the
    ordinary step and keeps the lingering last frame; a shorter row keeps
    the lingering last frame and drops frames from the middle.
    """
    base = list(next(spec['durations'] for spec in ANIMATIONS.values()
                     if spec['row'] == row))
    if count == len(base):
        return base
    if count < len(base):
        return base[:count - 1] + [base[-1]]
    step = base[-2]
    return base[:-1] + [step] * (count - len(base)) + [base[-1]]


def manifest_for(pet_id, name, description, source, counts) -> dict:
    """The manifest in this project's dialect."""
    animations = {}
    for animation, spec in ANIMATIONS.items():
        row = spec['row']
        count = counts[row]
        if count == 0:
            continue
        animations[animation] = {"row": row, "durations": timings_for(row, count)}
    return {
        "id": pet_id,
        "name": name,
        "description": description,
        "size": 200,
        "preview": "preview.png",
        "type": "sprite",
        "spriteVersionNumber": 2,
        "spritesheetPath": "spritesheet.webp",
        "cell": {"width": CELL_W, "height": CELL_H},
        "grid": {"columns": COLS, "rows": ROWS},
        "idle": "idle",
        "animations": animations,
        "drag": {"right": "running-right", "left": "running-left"},
        "react": {"click": "jumping"},
        "idleRoutine": {"every": [3, 6], "animations": IDLE_ROUTINE},
        "perform": {"sequence": ["jumping", "waving"], "splash": "sparkle"},
        "source": source,
        "look": {"rows": [9, 10], "count": 16, "startDegrees": 0, "stepDegrees": 22.5},
    }


def make_preview(sheet_path: str, out_path: str, size: int = 600) -> None:
    """The gallery still: the idle frame on a soft blue disc.

    The official pets and the derived ones both use the same disc, so the
    gallery looks like one set rather than a pile of thumbnails.
    """
    from port_codex_pets import make_preview as official_preview   # noqa: PLC0415

    official_preview(sheet_path, out_path, size)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source_dir', help='the directory Codex keeps the pet in')
    parser.add_argument('--id', required=True, help='the id in this project')
    parser.add_argument('--name', required=True, help='the name shown in the gallery')
    parser.add_argument('--description', default='', help='one line about the pet')
    parser.add_argument('--source', default='', help='where this pet came from')
    args = parser.parse_args()

    source_dir = os.path.expanduser(args.source_dir)
    manifest_path = os.path.join(source_dir, 'pet.json')
    description = args.description
    # The path is written with a leading tilde: an absolute path would put
    # the name of the person who made the pet into a public repository.
    source = args.source or f'custom Codex pet (~/{os.path.relpath(source_dir, os.path.expanduser("~"))})'

    if os.path.isfile(manifest_path):
        with open(manifest_path, encoding='utf-8') as handle:
            original = json.load(handle)
        description = description or original.get('description', '')

    sheet_name = 'spritesheet.webp'
    if os.path.isfile(manifest_path):
        with open(manifest_path, encoding='utf-8') as handle:
            sheet_name = json.load(handle).get('spritesheetPath') or sheet_name
    sheet_path = os.path.join(source_dir, sheet_name)
    if not os.path.isfile(sheet_path):
        raise SystemExit(f'{sheet_path} does not exist')

    with Image.open(sheet_path) as opened:
        atlas = opened.convert('RGBA')
    if atlas.size != (ATLAS_W, ATLAS_H):
        raise SystemExit(f'{sheet_path} is {atlas.size}, expected '
                         f'{ATLAS_W}x{ATLAS_H} (8 columns x 11 rows of '
                         f'{CELL_W}x{CELL_H})')

    counts = {row: frames_in_row(atlas, row) for row in range(ROWS)}
    for row, count in counts.items():
        print(f'  row {row}: {count} frame(s)')

    target_dir = os.path.join(PETS_DIR, args.id)
    os.makedirs(target_dir, exist_ok=True)
    sheet_out = os.path.join(target_dir, 'spritesheet.webp')
    atlas.save(sheet_out, 'WEBP', lossless=True, quality=100, method=6)

    manifest = manifest_for(args.id, args.name, description, source, counts)
    with open(os.path.join(target_dir, 'pet.json'), 'w', encoding='utf-8') as handle:
        json.dump(manifest, handle, indent=2, ensure_ascii=False)
        handle.write('\n')

    make_preview(sheet_out, os.path.join(target_dir, 'preview.png'))
    print(f'  -> {target_dir}')


if __name__ == '__main__':
    main()
