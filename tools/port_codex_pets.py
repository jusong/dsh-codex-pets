#!/usr/bin/env python3
"""
Port the pets that ship with Codex into this project.

Where the atlases come from
---------------------------

Codex ships its pets in two places, and they are not the same set:

* The **terminal CLI** (`codex`) knows eight pets: codex, dewey, fireball,
  rocky, seedy, stacky, bsod and null-signal. Their atlases are published on
  a public CDN as the *v1* shape -- 8 columns x 9 rows, 1536x1872.
* The **desktop app** (ChatGPT.app) ships nine pets: the same eight plus
  *hoots*, an owl. Its atlases are the *v2* shape -- 8 columns x 11 rows,
  1536x2288 -- and they are bundled inside `app.asar` rather than served
  from the CDN.

So the CDN alone can never give you the full Codex pet set: hoots simply
does not exist there. This script reads the desktop bundle by default and
falls back to the CDN.

The atlas layout
----------------

The desktop app states the contract itself, and both shapes agree on rows
0-8:

    v1  1536x1872   rows 0-8
    v2  1536x2288   rows 0-8 plus 9-10

    0 idle           0-5
    1 running-right  0-7
    2 running-left   0-7
    3 waving         0-3
    4 jumping        0-4
    5 failed         0-7
    6 waiting        0-5
    7 running        0-5
    8 review         0-5

Rows 9 and 10 of a v2 atlas hold the 16 look directions, 22.5 degrees
apart: row 9 is 000 to 157.5, row 10 is 180 to 337.5. A v1 atlas has no
look rows, so a v1 pet never turns its head towards the cursor.

Usage:
    python tools/port_codex_pets.py                    # all pets, desktop bundle
    python tools/port_codex_pets.py hoots codex        # only these
    python tools/port_codex_pets.py --source cdn       # the v1 CDN atlases
"""

from __future__ import annotations

import argparse
import json
import os
import struct
import sys
import urllib.request
from urllib.error import URLError

from PIL import Image, ImageDraw

CDN_URL = "https://persistent.oaistatic.com/codex/pets/v1"
CACHE_DIR = os.path.join(os.path.dirname(__file__), ".cache", "codex-pets")
APP_ASAR = "/Applications/ChatGPT.app/Contents/Resources/app.asar"

CELL_W, CELL_H = 192, 208
COLS = 8

# The two atlas shapes the Codex apps use.
SHAPES = {
    1: {"rows": 9, "height": 1872},
    2: {"rows": 11, "height": 2288},
}

# id -> (display name, description), in the order the desktop app lists them.
PETS = {
    "codex": ("Codex", "The original Codex companion."),
    "dewey": ("Dewey", "A calm companion for focused workspace days"),
    "fireball": ("Fireball", "Hot path energy for fast iteration"),
    "hoots": ("Hoots", "A sharp-eyed owl for polished work in a blink."),
    "rocky": ("Rocky", "A steady rock when the diff gets larger"),
    "seedy": ("Seedy", "Small green shoots for new ideas"),
    "stacky": ("Stacky", "A balanced stack for deep work"),
    "bsod": ("BSOD", "A tiny blue-screen gremlin"),
    "null-signal": ("Null Signal", "Quiet signal from the void"),
}

# The official per-frame timings, straight from the Codex animation table.
# Every frame of a row lasts `step`, except the last one, which lingers.
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


# --------------------------------------------------------------------------
# Reading the desktop bundle
# --------------------------------------------------------------------------


class Asar:
    """A read-only view of an Electron `.asar` archive.

    The layout is: an 8-byte pickle header whose second UInt32 is the size
    of the header block, then the header block, then the file data. The
    header block starts with a UInt32 giving the length of a JSON document
    that maps every path to its size and its offset *relative to the start
    of the data segment*, which begins right after the header block.
    """

    def __init__(self, path: str):
        self.handle = open(path, "rb")
        _, header_size = struct.unpack("<II", self.handle.read(8))
        self.handle.seek(8)
        header = self.handle.read(header_size)
        json_size = struct.unpack("<I", header[:4])[0]
        raw = header[8 : 8 + json_size + 64].decode("utf-8", "replace")
        tree, _ = json.JSONDecoder().raw_decode(raw)
        self.data_start = 8 + header_size
        self.files = {}
        for path_name, size, offset in self._walk(tree["files"], ""):
            self.files[path_name] = (size, offset)

    def _walk(self, node, prefix: str):
        for name, value in node.items():
            path = prefix + name
            if "files" in value:
                yield from self._walk(value["files"], path + "/")
            else:
                yield path, value.get("size", 0), value.get("offset", "0")

    def find(self, predicate):
        """Return the first archive path matching `predicate`."""
        for path in sorted(self.files):
            if predicate(path):
                return path
        return None

    def read(self, path: str) -> bytes:
        size, offset = self.files[path]
        self.handle.seek(self.data_start + int(offset))
        return self.handle.read(size)

    def close(self) -> None:
        self.handle.close()


def desktop_atlas(pet_id: str) -> tuple[str, str]:
    """Pull a pet's atlas out of the desktop bundle.

    Returns the cached file path and the archive path it came from.
    """
    os.makedirs(CACHE_DIR, exist_ok=True)
    archive = Asar(APP_ASAR)
    try:
        wanted = f"/{pet_id}-spritesheet-"
        path = archive.find(lambda name: wanted in name and name.endswith(".webp"))
        if path is None:
            raise SystemExit(f"{pet_id}: no atlas in {APP_ASAR}")
        base = os.path.basename(path)
        cached = os.path.join(CACHE_DIR, base)
        if not (os.path.exists(cached) and os.path.getsize(cached) > 0):
            with open(cached, "wb") as handle:
                handle.write(archive.read(path))
        return cached, path
    finally:
        archive.close()


def cdn_atlas(pet_id: str) -> tuple[str, str]:
    """Pull a pet's v1 atlas off the public CDN, with a local cache."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    url = f"{CDN_URL}/{pet_id}-spritesheet-v4.webp"
    cached = os.path.join(CACHE_DIR, f"{pet_id}-spritesheet-v4.webp")
    if os.path.exists(cached) and os.path.getsize(cached) > 0:
        return cached, url
    print(f"  downloading {url}")
    try:
        with urllib.request.urlopen(url, timeout=60) as response:
            data = response.read()
    except URLError as error:
        raise SystemExit(f"could not fetch {url}: {error}")
    with open(cached, "wb") as handle:
        handle.write(data)
    return cached, url


# --------------------------------------------------------------------------
# Manifest
# --------------------------------------------------------------------------


def shape_of(atlas_path: str) -> int:
    """Return the sprite version of an atlas, from its pixel height."""
    with Image.open(atlas_path) as image:
        width, height = image.size
    for version, shape in SHAPES.items():
        if (width, height) == (CELL_W * COLS, shape["height"]):
            return version
    raise SystemExit(f"{atlas_path}: unexpected atlas size {width}x{height}")


def manifest_for(pet_id: str, source_url: str, version: int) -> dict:
    name, description = PETS[pet_id]
    rows = SHAPES[version]["rows"]
    manifest = {
        "id": pet_id,
        "name": name,
        "description": description,
        "size": 200,
        "preview": "preview.png",
        "type": "sprite",
        "spriteVersionNumber": version,
        "spritesheetPath": "spritesheet.webp",
        "cell": {"width": CELL_W, "height": CELL_H},
        "grid": {"columns": COLS, "rows": rows},
        "idle": "idle",
        "animations": ANIMATIONS,
        "drag": {"right": "running-right", "left": "running-left"},
        # What the pet does when it is clicked. The `jumping` row really
        # lifts the pet off the ground (the sprite moves ~16px up inside its
        # cell), so it reads as a jump and not just a changed expression.
        "react": {"click": "jumping"},
        # The official idle row barely moves -- only the face changes -- so a
        # pet that plays nothing but `idle` reads as frozen. The engine takes
        # a short turn at another row every few seconds.
        #
        # The rows picked here are the ones that move the *body*, not just
        # the face: `waiting` shifts the pet's weight, `waving` puts a hand
        # up, `running` puts a laptop in front of it. The `idle`, `jumping`
        # and `review` rows only change the expression, so they are left out
        # of the routine -- they are what made the pet look switched off.
        # `every` is a range so the fidgeting does not land on the same beat
        # every time.
        "idleRoutine": {"every": [3, 6], "animations": ["waiting", "waving", "running"]},
        "perform": {"sequence": ["jumping", "waving"], "splash": "sparkle"},
        "source": source_url,
    }
    # Only a v2 atlas carries the 16 look directions.
    if version >= 2:
        manifest["look"] = {"rows": [9, 10], "count": 16, "startDegrees": 0, "stepDegrees": 22.5}
    return manifest


# --------------------------------------------------------------------------
# Preview
# --------------------------------------------------------------------------


def make_preview(atlas_path: str, out_path: str, size: int = 600) -> None:
    """Crop the idle frame and put it on a soft disc."""
    atlas = Image.open(atlas_path).convert("RGBA")
    frame = atlas.crop((0, 0, CELL_W, CELL_H))

    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    disc = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(disc)
    for i in range(size // 2, 0, -1):
        f = i / (size / 2)
        color = (
            round(214 - 60 * (1 - f)),
            round(238 - 48 * (1 - f)),
            round(255 - 20 * (1 - f)),
        )
        draw.ellipse(
            [size / 2 - i, size / 2 - i, size / 2 + i, size / 2 + i],
            fill=color + (255,),
        )
    canvas.alpha_composite(disc)

    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).ellipse(
        [size / 2 - frame.width * 0.36, size * 0.80, size / 2 + frame.width * 0.36, size * 0.855],
        fill=(11, 31, 58, 40),
    )
    canvas.alpha_composite(shadow)

    x = (size - frame.width) // 2
    y = (size - frame.height) // 2 - size // 22
    canvas.alpha_composite(frame, (x, y))
    canvas.save(out_path)


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("pets", nargs="*", help="pet ids to port (default: all)")
    parser.add_argument(
        "--source",
        choices=("desktop", "cdn"),
        default="desktop",
        help="desktop: the app bundle, which has all nine pets (default); cdn: the v1 atlases",
    )
    parser.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "pets"))
    args = parser.parse_args()

    wanted = args.pets or list(PETS)
    unknown = [pet for pet in wanted if pet not in PETS]
    if unknown:
        raise SystemExit(f"unknown pet id(s): {', '.join(unknown)}")

    out_root = os.path.abspath(args.out)
    for pet_id in wanted:
        print(f"porting {pet_id}")
        if args.source == "desktop":
            source_path, source_url = desktop_atlas(pet_id)
        else:
            source_path, source_url = cdn_atlas(pet_id)
        print(f"  atlas {os.path.basename(source_path)}")

        version = shape_of(source_path)
        pet_dir = os.path.join(out_root, pet_id)
        os.makedirs(pet_dir, exist_ok=True)

        # The atlas is already a WebP; keep it as it is.
        with open(source_path, "rb") as src, open(os.path.join(pet_dir, "spritesheet.webp"), "wb") as dst:
            dst.write(src.read())

        with open(os.path.join(pet_dir, "pet.json"), "w", encoding="utf-8") as handle:
            json.dump(manifest_for(pet_id, source_url, version), handle, ensure_ascii=False, indent=2)
            handle.write("\n")

        make_preview(source_path, os.path.join(pet_dir, "preview.png"))
        print(f"  -> {os.path.relpath(pet_dir, os.path.dirname(out_root))} (v{version})")

    print("\nnow register them in pets/index.json")


if __name__ == "__main__":
    main()
