#!/usr/bin/env python3
"""
Check every pet in the gallery against the atlas contract.

The engine does not care where a pet's art came from; it only cares that the
atlas is shaped the way it expects. This script is the guard for that:

    * every pet in pets/index.json has a manifest and a preview
    * the manifest names a 192x208 cell in an 8x11 grid
    * the atlas really is 1536x2288
    * no cell paints over its neighbour
    * the resting pet sits inside the safe area of the cell, with room
      above for the jump and below for the feet

Run:
    python3 tools/check_pets.py
"""
from __future__ import annotations

import json
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..')
PETS_DIR = os.path.join(ROOT, 'pets')

CELL_W, CELL_H = 192, 208
COLS, ROWS = 8, 11
ATLAS_W, ATLAS_H = CELL_W * COLS, CELL_H * ROWS

REQUIRED_MANIFEST = ('id', 'name', 'type', 'size', 'preview', 'spriteVersionNumber',
                     'spritesheetPath', 'cell', 'grid', 'idle', 'animations',
                     'drag', 'look', 'idleRoutine', 'react', 'perform')

# The official pets all rest between these lines, so a new pet that wants to
# live next to them should not float above the floor or sink through it.
SAFE_TOP = 2
SAFE_BOTTOM = 204
# The jump lifts the pet by four cells; it must not leave the cell.
SAFE_JUMP_TOP = 0


def fail(problems, message):
    problems.append(message)


def check_pet(entry, problems):
    pet_id = entry.get('id')
    if not isinstance(pet_id, str) or not pet_id:
        fail(problems, 'index entry without an id')
        return
    directory = os.path.join(PETS_DIR, pet_id)
    if not os.path.isdir(directory):
        fail(problems, f'{pet_id}: no directory')
        return

    manifest_path = os.path.join(directory, 'pet.json')
    try:
        with open(manifest_path, encoding='utf-8') as handle:
            manifest = json.load(handle)
    except Exception as error:                       # noqa: BLE001
        fail(problems, f'{pet_id}: manifest unreadable ({error})')
        return

    for key in REQUIRED_MANIFEST:
        if key not in manifest:
            fail(problems, f'{pet_id}: manifest has no "{key}"')
    if manifest.get('id') != pet_id:
        fail(problems, f'{pet_id}: manifest id is {manifest.get("id")!r}')
    if manifest.get('spriteVersionNumber') != 2:
        fail(problems, f'{pet_id}: spriteVersionNumber is not 2')
    if manifest.get('cell') != {'width': CELL_W, 'height': CELL_H}:
        fail(problems, f'{pet_id}: cell is {manifest.get("cell")}')
    if manifest.get('grid') != {'columns': COLS, 'rows': ROWS}:
        fail(problems, f'{pet_id}: grid is {manifest.get("grid")}')
    sheet = manifest.get('spritesheetPath')
    if not isinstance(sheet, str) or not sheet.endswith('.webp'):
        fail(problems, f'{pet_id}: spritesheetPath {sheet!r} is not a .webp')
        return

    animations = manifest.get('animations') or {}
    for row in range(9):
        if not any(spec.get('row') == row for spec in animations.values()):
            fail(problems, f'{pet_id}: no animation on row {row}')
    look = manifest.get('look') or {}
    if look.get('rows') != [9, 10] or look.get('count') != 16:
        fail(problems, f'{pet_id}: look is {look}')
    react = manifest.get('react') or {}
    if react.get('click') not in animations:
        fail(problems, f'{pet_id}: react.click is not an animation')
    for name in (manifest.get('idleRoutine') or {}).get('animations') or []:
        if name not in animations:
            fail(problems, f'{pet_id}: idleRoutine wants unknown animation {name}')

    preview = manifest.get('preview') or 'preview.png'
    preview_path = os.path.join(directory, preview)
    if not os.path.isfile(preview_path):
        fail(problems, f'{pet_id}: preview {preview} is missing')
    else:
        with Image.open(preview_path) as image:
            if image.size != (600, 600):
                fail(problems, f'{pet_id}: preview is {image.size}, expected 600x600')

    sheet_path = os.path.join(directory, sheet)
    if not os.path.isfile(sheet_path):
        fail(problems, f'{pet_id}: atlas {sheet} is missing')
        return
    with Image.open(sheet_path) as atlas:
        atlas = atlas.convert('RGBA')
        if atlas.size != (ATLAS_W, ATLAS_H):
            fail(problems, f'{pet_id}: atlas is {atlas.size}, expected '
                            f'{ATLAS_W}x{ATLAS_H}')
            return
        alpha = atlas.getchannel('A')

        def check_cell(column, row, what):
            cell = alpha.crop((column * CELL_W, row * CELL_H,
                               (column + 1) * CELL_W, (row + 1) * CELL_H))
            box = cell.getbbox()
            if box is None:
                fail(problems, f'{pet_id}: {what} (cell {column},{row}) is empty')
                return
            if box[0] <= 0 or box[1] <= 0 or box[2] >= CELL_W or box[3] >= CELL_H:
                fail(problems, f'{pet_id}: {what} (cell {column},{row}) touches the edge')

        # Only the frames the manifest actually asks for have to be there;
        # the official pets leave the rest of the row empty as well.
        for name, spec in animations.items():
            row = spec.get('row')
            frames = len(spec.get('durations') or [])
            for frame in range(frames):
                check_cell(frame, row, name)
        for index in range(16):
            check_cell(index % 8, 9 + index // 8, 'look')
        rest = alpha.crop((0, 0, ATLAS_W, CELL_H)).getbbox()
        if rest is None:
            fail(problems, f'{pet_id}: the idle row is empty')
        else:
            if rest[1] < SAFE_TOP:
                fail(problems, f'{pet_id}: the pet floats (top {rest[1]} < {SAFE_TOP})')
            if rest[3] > SAFE_BOTTOM:
                fail(problems, f'{pet_id}: the pet sinks (bottom {rest[3]} > '
                                f'{SAFE_BOTTOM})')
        jump = alpha.crop((0, CELL_H * 4, ATLAS_W, CELL_H * 5)).getbbox()
        if jump is not None and jump[1] < SAFE_JUMP_TOP:
            fail(problems, f'{pet_id}: the jump leaves the cell (top {jump[1]})')


def main():
    index_path = os.path.join(PETS_DIR, 'index.json')
    with open(index_path, encoding='utf-8') as handle:
        index = json.load(handle)
    problems = []
    for entry in index:
        check_pet(entry, problems)
    if problems:
        print(f'{len(problems)} problem(s):')
        for problem in problems:
            print(f'  - {problem}')
        return 1
    print(f'{len(index)} pets checked, all good.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
