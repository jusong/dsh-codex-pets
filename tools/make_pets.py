#!/usr/bin/env python3
"""
Draw the original pets for dsh-pet.

A pet here is a *rig*, not a picture: a handful of shapes plus the rules for
how they move. The rig renders into the very same atlas contract the
official pets use, so the engine cannot tell where the art came from:

    8 columns x 11 rows, 192x208 cells, transparent background
    row 0-8   nine standard animation rows
    row 9-10  sixteen look directions, 000 degrees (straight up) first

Everything is drawn on a 48x52 grid and scaled up to fill the cell, which
keeps every pixel on an exact grid. The shapes are shaded the way the
official pets are shaded -- a soft vertical gradient plus a highlight -- but
the language is plainly ours: hard pixels, no texture, no rendering.

Run:
    python3 tools/make_pets.py
"""
from __future__ import annotations

import json
import math
import os

from PIL import Image, ImageChops, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..')
PETS_DIR = os.path.join(ROOT, 'pets')

GW, GH = 48, 52          # the drawing grid
S = 4                    # grid pixel -> cell pixel
CELL_W, CELL_H = GW * S, GH * S      # 192 x 208
COLS, ROWS = 8, 11

# A resting pet should be about as tall as the official ones, so the gallery
# does not look like it mixes two different sizes. This is measured in cell
# pixels, from the pet's own idle frame.
TARGET_H = 172
# The line the feet rest on, in cell pixels.
FLOOR = 196

# The frame timings are the official ones, so a new pet feels exactly like
# an old one: the idle row lingers on its last frame, and every one-shot
# action holds its last frame too.
DURATIONS = {
    'idle': [280, 110, 110, 140, 140, 320],
    'running-right': [120, 120, 120, 120, 120, 120, 120, 220],
    'running-left': [120, 120, 120, 120, 120, 120, 120, 220],
    'waving': [140, 140, 140, 280],
    'jumping': [140, 140, 140, 140, 280],
    'failed': [140, 140, 140, 140, 140, 140, 140, 240],
    'waiting': [150, 150, 150, 150, 150, 260],
    'running': [120, 120, 120, 120, 120, 220],
    'review': [150, 150, 150, 150, 150, 280],
}

ROW_OF = {
    'idle': 0,
    'running-right': 1,
    'running-left': 2,
    'waving': 3,
    'jumping': 4,
    'failed': 5,
    'waiting': 6,
    'running': 7,
    'review': 8,
}


def rgb(value, alpha=255):
    """'#rrggbb' -> (r, g, b, a)."""
    value = value.lstrip('#')
    return (int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16), alpha)


class Canvas:
    """A 48x52 pixel buffer. Nothing here is anti-aliased on purpose."""

    def __init__(self):
        self.im = Image.new('RGBA', (GW, GH), (0, 0, 0, 0))
        self.d = ImageDraw.Draw(self.im)

    def ellipse(self, cx, cy, rx, ry, color):
        self.d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=color)

    def rect(self, x0, y0, x1, y1, color):
        self.d.rectangle([x0, y0, x1, y1], fill=color)

    def rrect(self, x0, y0, x1, y1, radius, color):
        self.d.rounded_rectangle([x0, y0, x1, y1], radius=radius, fill=color)

    def poly(self, points, color):
        self.d.polygon(points, fill=color)

    def line(self, x0, y0, x1, y1, color, width=1):
        self.d.line([x0, y0, x1, y1], fill=color, width=width)

    def arc(self, x0, y0, x1, y1, start, end, color, width=1):
        self.d.arc([x0, y0, x1, y1], start, end, fill=color, width=width)

    def pixel(self, x, y, color):
        self.d.point((x, y), fill=color)

    def outline(self, color):
        """Put a 1px border around everything that was drawn."""
        alpha = self.im.getchannel('A')
        grown = alpha.filter(ImageFilter.MaxFilter(3))
        border = ImageChops.subtract(grown, alpha)
        self.im.paste(Image.new('RGBA', (GW, GH), color), (0, 0), border)


class Rig:
    """Base rig. Subclasses draw their own body; the rows are shared."""

    id = ''
    name = ''
    description = ''
    palette = {}

    # Filled in by prepare(): the pet's footprint on the grid, how much it
    # has to grow to reach the shared size, and where it lands in the cell.
    region = (0, 0, GW, GH)
    scale = 1.0
    ox = 0
    oy = 0

    # -- helpers ---------------------------------------------------------

    def c(self, key, alpha=255):
        return rgb(self.palette[key], alpha)

    @staticmethod
    def mask_of(fn):
        """Build a 1-bit mask by letting `fn` draw into it."""
        mask = Image.new('L', (GW, GH), 0)
        fn(ImageDraw.Draw(mask))
        return mask

    def paint(self, canvas, mask, base, shade=None, light=None,
              shade_start=0.5, steps=5, light_alpha=120):
        """Fill a masked shape, then shade it and catch a light on top."""
        canvas.im.paste(Image.new('RGBA', (GW, GH), base), (0, 0), mask)
        bbox = mask.getbbox()
        if bbox is None:
            return
        if shade is not None:
            self._shade(canvas, mask, bbox, shade, shade_start, steps)
        if light is not None:
            self._highlight(canvas, mask, bbox, light, light_alpha)

    def _shade(self, canvas, mask, bbox, color, start, steps):
        """Darken the bottom of a shape, band by band."""
        _, y0, _, y1 = bbox
        height = max(1, y1 - y0)
        for i in range(steps):
            ta = start + (1 - start) * i / steps
            tb = start + (1 - start) * (i + 1) / steps
            ya = y0 + int(height * ta)
            yb = y0 + int(height * tb)
            if yb <= ya:
                continue
            band = Image.new('L', (GW, GH), 0)
            ImageDraw.Draw(band).rectangle([0, ya, GW, yb], fill=int(255 * (i + 1) / steps))
            band = ImageChops.multiply(band, mask)
            canvas.im.paste(Image.new('RGBA', (GW, GH), color), (0, 0), band)

    def _highlight(self, canvas, mask, bbox, color, alpha):
        """Catch the light on the upper left of a shape."""
        x0, y0, x1, y1 = bbox
        width = max(2, x1 - x0)
        height = max(2, y1 - y0)
        cx = x0 + width * 0.34
        cy = y0 + height * 0.30
        rx = max(2, int(width * 0.24))
        ry = max(2, int(height * 0.22))
        spot = Image.new('L', (GW, GH), 0)
        ImageDraw.Draw(spot).ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=alpha)
        spot = ImageChops.multiply(spot, mask)
        canvas.im.paste(Image.new('RGBA', (GW, GH), color), (0, 0), spot)

    def stroke(self, canvas, points, radius, color):
        """A limb: overlapping dots along a path."""
        for x, y in points:
            canvas.ellipse(x, y, radius, radius, color)

    def draw_eyes(self, canvas, x, y, r, look=(0, 0), style='open', sclera=False):
        if style == 'blink':
            canvas.line(x - r, y, x + r, y, self.c('outline'))
            return
        if style == 'happy':
            canvas.arc(x - r, y - r + 1, x + r, y + r + 1, 200, 340, self.c('outline'))
            return
        if style == 'x':
            canvas.line(x - r, y - r, x + r, y + r, self.c('outline'))
            canvas.line(x - r, y + r, x + r, y - r, self.c('outline'))
            return
        if style == 'sad':
            canvas.ellipse(x, y, r, r, self.c('eye'))
            canvas.pixel(x + 1, y - 1, self.c('white'))
            return
        if sclera:
            # white of the eye, then the iris and pupil on top of it
            canvas.ellipse(x, y, r, r, self.c('white'))
            px = x + look[0]
            py = y + look[1]
            canvas.ellipse(px, py, max(1, r - 2), max(1, r - 2), self.c('eye'))
            canvas.ellipse(px, py, max(1, r - 3), max(1, r - 3), self.c('pupil'))
        else:
            canvas.ellipse(x, y, r, r, self.c('eye'))
            px = x + look[0]
            py = y + look[1]
            canvas.ellipse(px, py, max(1, r - 2), max(1, r - 2), self.c('pupil'))
        canvas.pixel(px - 1, py - 1, self.c('white'))

    def draw_mouth(self, canvas, x, y, style='smile', width=4):
        if style == 'smile':
            canvas.arc(x - width // 2, y - width // 2, x + width // 2, y + width // 2,
                       0, 180, self.c('outline'))
        elif style == 'o':
            canvas.ellipse(x, y, 1, 2, self.c('outline'))
        elif style == 'flat':
            canvas.line(x - width // 2, y, x + width // 2, y, self.c('outline'))

    def magnifier(self, canvas, x, y):
        """The 'review' prop: a lens with a handle, held inside the body so
        it never changes the pet's footprint."""
        canvas.ellipse(x, y, 5, 5, self.c('glass'))
        canvas.d.ellipse([x - 5, y - 5, x + 5, y + 5], outline=self.c('outline'), width=1)
        canvas.ellipse(x, y, 4, 4, self.c('white'))
        canvas.pixel(x - 2, y - 2, self.c('white'))
        canvas.line(x + 4, y + 4, x + 6, y + 6, self.c('outline'))

    # -- the pose --------------------------------------------------------

    def pose(self, row, frame, total):
        """Turn (row, frame) into the numbers the drawing code reads."""
        phase = 2 * math.pi * (frame / max(1, total))
        pose = {
            'dx': 0, 'dy': 0, 'lean': 0, 'squash': 1.0, 'arm': 0.0,
            'stride': 0.0, 'wave': 0.0, 'face': 'open', 'look': (0, 0),
            'prop': None, 'blink': False,
        }
        if row == 'idle':
            pose['squash'] = 1 + 0.04 * math.sin(phase)
            pose['dy'] = -round(0.8 * math.sin(phase))
            pose['blink'] = frame == 4
        elif row in ('running-right', 'running-left'):
            side = 1 if row.endswith('right') else -1
            pose['stride'] = math.sin(phase)
            pose['dx'] = side * round(1.0 * math.sin(phase))
            pose['dy'] = -1 if frame % 2 else 0
            pose['lean'] = side
            pose['face'] = 'happy'
        elif row == 'waving':
            pose['arm'] = 1.0
            pose['wave'] = math.sin(phase)
            pose['face'] = 'happy'
        elif row == 'jumping':
            # crouch, launch, apex, fall, land
            dy, squash = [(1, 0.86), (-2, 1.06), (-4, 0.98), (-1, 1.04), (1, 0.88)][
                min(frame, 4)]
            pose['dy'], pose['squash'] = dy, squash
            pose['face'] = 'happy' if frame in (1, 2) else 'open'
        elif row == 'failed':
            pose['dy'] = 1
            pose['squash'] = 0.93
            pose['dx'] = 1 if frame % 2 else -1
            pose['face'] = 'x' if frame % 2 == 0 else 'sad'
        elif row == 'waiting':
            pose['lean'] = round(3 * math.sin(phase))
            pose['dx'] = pose['lean'] // 2
            pose['look'] = (round(2 * math.sin(phase)), 0)
        elif row == 'running':
            pose['stride'] = math.sin(phase)
            pose['dy'] = -1 if frame % 2 else 0
            pose['arm'] = abs(math.sin(phase))
        elif row == 'review':
            pose['look'] = (0, 1)
            pose['prop'] = 'magnifier'
            pose['dy'] = -round(0.8 * math.sin(phase))
        return pose

    # -- drawing ---------------------------------------------------------

    def draw_body(self, canvas, pose):
        raise NotImplementedError

    def draw_face(self, canvas, pose):
        raise NotImplementedError

    def draw_extra(self, canvas, pose):
        pass

    def draw(self, canvas, row, frame, total):
        pose = self.pose(row, frame, total)
        self.draw_body(canvas, pose)
        self.draw_face(canvas, pose)
        self.draw_extra(canvas, pose)
        canvas.outline(self.c('outline'))

    def draw_look(self, canvas, index):
        """One of the sixteen directions: 000 degrees (up) first, clockwise."""
        angle = 2 * math.pi * index / 16
        look = (round(math.sin(angle) * 2), round(-math.cos(angle) * 2))
        pose = {'dx': 0, 'dy': 0, 'lean': 0, 'squash': 1.0, 'arm': 0.0,
                'stride': 0.0, 'wave': 0.0, 'face': 'open', 'look': look,
                'prop': None, 'blink': False}
        self.draw_body(canvas, pose)
        self.draw_face(canvas, pose)
        canvas.outline(self.c('outline'))


# ---------------------------------------------------------------------------
# Blob -- a jelly that wobbles when it breathes and bounces when it lands.
# ---------------------------------------------------------------------------

class Blob(Rig):
    id = 'blob'
    name = 'Blob'
    description = 'A soft teal jelly that wobbles when it breathes.'
    palette = {
        'outline': '#143b39',
        'body': '#6fe3c8',
        'shade': '#2ba894',
        'light': '#cbfff1',
        'eye': '#143b39',
        'pupil': '#0b2422',
        'white': '#ffffff',
        'glass': '#bff3e6',
    }

    def geometry(self, pose):
        squash = pose['squash']
        rx = int(round(17 / max(0.7, squash)))
        ry = int(round(20 * squash))
        cx = 24 + pose['dx']
        ground = 48 + pose['dy']
        return cx, ground - ry, rx, ry

    def draw_body(self, canvas, pose):
        cx, cy, rx, ry = self.geometry(pose)
        # little arms
        for side in (-1, 1):
            lift = pose['arm'] if side > 0 else max(0.0, pose['stride'])
            ax = cx + side * min(rx + 1, 17)
            ay = cy + 4 - round(5 * lift)
            mask = self.mask_of(
                lambda d, ax=ax, ay=ay: d.ellipse([ax - 3, ay - 4, ax + 3, ay + 4], fill=255))
            self.paint(canvas, mask, self.c('body'), self.c('shade'), shade_start=0.55)
        # the jelly itself
        mask = self.mask_of(
            lambda d: d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=255))
        self.paint(canvas, mask, self.c('body'), self.c('shade'), self.c('light'),
                   shade_start=0.45)

    def draw_face(self, canvas, pose):
        cx, cy, rx, ry = self.geometry(pose)
        eye_y = cy - 3
        style = 'blink' if pose['blink'] else pose['face']
        self.draw_eyes(canvas, cx - 8, eye_y, 4, pose['look'], style)
        self.draw_eyes(canvas, cx + 8, eye_y, 4, pose['look'], style)
        self.draw_mouth(canvas, cx, eye_y + 10, 'smile', 7)

    def draw_extra(self, canvas, pose):
        if pose['prop'] == 'magnifier':
            cx, cy, rx, ry = self.geometry(pose)
            self.magnifier(canvas, cx + 9, cy - 4)


# ---------------------------------------------------------------------------
# Cat -- sits, flicks its tail, and leans while it waits.
# ---------------------------------------------------------------------------

class Cat(Rig):
    id = 'cat'
    name = 'Cat'
    description = 'A round ginger cat that swishes its tail and stretches when it hops.'
    palette = {
        'outline': '#4a2c15',
        'body': '#f2a65a',
        'shade': '#c9762a',
        'light': '#ffe3b8',
        'eye': '#4a2c15',
        'pupil': '#2a1608',
        'white': '#fffaf0',
        'glass': '#cfe8ff',
        'collar': '#3f9f8a',
    }

    def geometry(self, pose):
        x = 24 + pose['dx']
        y = pose['dy']
        head_x = x + pose['lean']
        return x, y, head_x

    def draw_body(self, canvas, pose):
        x, y, head_x = self.geometry(pose)
        # tail, curling up behind the body
        tail = [(x + 12, 42 + y), (x + 15, 41 + y), (x + 17, 37 + y),
                (x + 17, 31 + y - round(pose['wave'] * 2)),
                (x + 14, 26 + y - round(pose['wave'] * 2))]
        self.stroke(canvas, tail, 3, self.c('outline'))
        self.stroke(canvas, tail, 2, self.c('body'))
        # haunches
        mask = self.mask_of(
            lambda d: d.ellipse([x - 14, 31 + y, x + 14, 47 + y], fill=255))
        self.paint(canvas, mask, self.c('body'), self.c('shade'), self.c('light'))
        # paws
        for side in (-1, 1):
            step = round(pose['stride']) * side
            px = x + side * 7 + step
            mask = self.mask_of(
                lambda d, px=px: d.ellipse([px - 5, 43 + y, px + 5, 48 + y], fill=255))
            self.paint(canvas, mask, self.c('light'), self.c('shade'))
        # a waving paw
        if pose['arm'] > 0:
            lift = 11 * pose['arm']
            path = [(x + 11, 38 + y), (x + 16, 31 + y - lift // 2),
                    (x + 15, 23 + y - lift)]
            self.stroke(canvas, path, 2, self.c('outline'))
            self.stroke(canvas, path, 1, self.c('body'))
            canvas.ellipse(x + 15, 22 + y - lift, 4, 4, self.c('light'))
        # head
        head_y = 22 + y
        # ears
        for side in (-1, 1):
            ex = head_x + side * 8
            canvas.poly([(ex - 5, head_y - 8), (ex + 2, head_y - 15),
                         (ex + 6, head_y - 7)], self.c('outline'))
            canvas.poly([(ex - 4, head_y - 8), (ex + 1, head_y - 14),
                         (ex + 5, head_y - 8)], self.c('body'))
        mask = self.mask_of(
            lambda d: d.ellipse([head_x - 13, head_y - 13, head_x + 13, head_y + 13],
                                fill=255))
        self.paint(canvas, mask, self.c('body'), self.c('shade'), self.c('light'))
        # stripes
        for offset in (-5, 0, 5):
            canvas.line(head_x + offset, head_y - 12, head_x + offset + 2,
                        head_y - 9, self.c('shade'))
        # a collar, so the head does not melt into the body
        canvas.rrect(head_x - 8, head_y + 11, head_x + 8, head_y + 14, 1, self.c('collar'))
        # muzzle
        canvas.ellipse(head_x, head_y + 7, 9, 6, self.c('light'))

    def draw_face(self, canvas, pose):
        x, y, head_x = self.geometry(pose)
        head_y = 22 + y
        style = 'blink' if pose['blink'] else pose['face']
        self.draw_eyes(canvas, head_x - 6, head_y - 2, 4, pose['look'], style, sclera=True)
        self.draw_eyes(canvas, head_x + 6, head_y - 2, 4, pose['look'], style, sclera=True)
        canvas.poly([(head_x - 3, head_y + 5), (head_x + 3, head_y + 5),
                     (head_x, head_y + 8)], self.c('outline'))
        for side in (-1, 1):
            canvas.line(head_x + side * 10, head_y + 6, head_x + side * 16,
                        head_y + 5, self.c('outline'))

    def draw_extra(self, canvas, pose):
        if pose['prop'] == 'magnifier':
            x, y, head_x = self.geometry(pose)
            self.magnifier(canvas, head_x + 9, 18 + y)


# ---------------------------------------------------------------------------
# Ghost -- floats, and its hem never stops waving.
# ---------------------------------------------------------------------------

class Ghost(Rig):
    id = 'ghost'
    name = 'Ghost'
    description = 'A little lavender ghost that floats and tugs at its hem.'
    palette = {
        'outline': '#4b4474',
        'body': '#eae6ff',
        'shade': '#b3abe4',
        'light': '#ffffff',
        'eye': '#4b4474',
        'pupil': '#2c2748',
        'white': '#ffffff',
        'glass': '#dcd8ff',
    }

    def geometry(self, pose):
        x = 24 + pose['dx']
        y = 26 + pose['dy']
        return x, y

    def draw_body(self, canvas, pose):
        x, y = self.geometry(pose)
        # the sheet: a wide dome over a straight skirt
        mask = ImageChops.lighter(
            self.mask_of(lambda d: d.ellipse([x - 19, y - 19, x + 19, y + 11], fill=255)),
            self.mask_of(lambda d: d.rectangle([x - 19, y + 4, x + 19, y + 15], fill=255)))
        self.paint(canvas, mask, self.c('body'), self.c('shade'), self.c('light'),
                   shade_start=0.6)
        # the hem: four little scallops
        wave = pose['wave']
        for i, dx in enumerate((-14, -4.7, 4.7, 14)):
            lift = round(math.sin(wave * 2 + i * 1.1) * 1.5)
            sx = x + dx
            sy = y + 15 + lift
            scallop = self.mask_of(
                lambda d, sx=sx, sy=sy: d.ellipse([sx - 4.7, sy - 5, sx + 4.7, sy + 5],
                                                   fill=255))
            canvas.im.paste(Image.new('RGBA', (GW, GH), self.c('body')), (0, 0), scallop)
        # mittens
        for side in (-1, 1):
            lift = pose['arm'] if side > 0 else max(0.0, pose['stride'])
            mx = x + side * 16
            my = y + 2 - round(7 * lift)
            canvas.ellipse(mx, my, 4, 4, self.c('outline'))
            canvas.ellipse(mx, my, 3, 3, self.c('body'))

    def draw_face(self, canvas, pose):
        x, y = self.geometry(pose)
        style = 'blink' if pose['blink'] else pose['face']
        self.draw_eyes(canvas, x - 6, y - 3, 4, pose['look'], style)
        self.draw_eyes(canvas, x + 6, y - 3, 4, pose['look'], style)
        self.draw_mouth(canvas, x, y + 7, 'o')

    def draw_extra(self, canvas, pose):
        if pose['prop'] == 'magnifier':
            x, y = self.geometry(pose)
            self.magnifier(canvas, x + 9, y - 4)


# ---------------------------------------------------------------------------
# Bot -- a boxy robot with a screen face and a bobbing antenna.
# ---------------------------------------------------------------------------

class Bot(Rig):
    id = 'bot'
    name = 'Bot'
    description = 'A little bot whose screen makes faces and whose antenna wobbles.'
    palette = {
        'outline': '#1e2b39',
        'body': '#9db6d2',
        'shade': '#6a85a6',
        'light': '#dceaf7',
        'eye': '#6ff0d0',
        'pupil': '#0d3a33',
        'white': '#ffffff',
        'glass': '#cfe8ff',
    }

    def geometry(self, pose):
        x = 24 + pose['dx']
        y = pose['dy']
        return x, y

    def draw_body(self, canvas, pose):
        x, y = self.geometry(pose)
        # antenna
        tip = round(pose['wave'] * 3)
        self.stroke(canvas, [(x, 15 + y), (x + tip, 11 + y)], 1, self.c('outline'))
        canvas.ellipse(x + tip, 10 + y, 2, 2, self.c('outline'))
        canvas.ellipse(x + tip, 10 + y, 1, 1, self.c('eye'))
        # arms, drawn behind the torso so the body sits in front
        for side in (-1, 1):
            pump = pose['arm'] if side > 0 else pose['stride']
            ax = x + side * 17
            ay = 36 + y - round(4 * abs(pump))
            canvas.rrect(ax - 3, ay, ax + 3, ay + 12, 3, self.c('outline'))
            canvas.rrect(ax - 2, ay + 1, ax + 2, ay + 11, 2, self.c('body'))
        # head
        head_x = x + pose['lean']
        mask = self.mask_of(
            lambda d: d.rounded_rectangle([head_x - 14, 12 + y, head_x + 14, 32 + y],
                                          radius=7, fill=255))
        self.paint(canvas, mask, self.c('body'), self.c('shade'), self.c('light'))
        # screen
        screen = self.mask_of(
            lambda d: d.rounded_rectangle([head_x - 9, 16 + y, head_x + 9, 28 + y],
                                          radius=5, fill=255))
        canvas.im.paste(Image.new('RGBA', (GW, GH), self.c('shade')), (0, 0), screen)
        # torso
        mask = self.mask_of(
            lambda d: d.rounded_rectangle([x - 11, 34 + y, x + 11, 46 + y],
                                          radius=6, fill=255))
        self.paint(canvas, mask, self.c('body'), self.c('shade'), self.c('light'))
        # a little dial on the chest
        canvas.ellipse(x, 40 + y, 4, 4, self.c('shade'))
        canvas.ellipse(x, 40 + y, 2, 2, self.c('eye'))
        # feet
        for side in (-1, 1):
            step = round(pose['stride']) * side
            fx = x + side * 8 + step
            canvas.rrect(fx - 5, 44 + y, fx + 5, 48 + y, 2, self.c('outline'))
            canvas.rrect(fx - 4, 45 + y, fx + 4, 47 + y, 1, self.c('light'))

    def draw_face(self, canvas, pose):
        x, y = self.geometry(pose)
        head_x = x + pose['lean']
        style = 'blink' if pose['blink'] else pose['face']
        eye_y = 21 + y
        if style == 'x':
            for side in (-1, 1):
                ex = head_x + side * 5
                canvas.line(ex - 3, eye_y - 3, ex + 3, eye_y + 3, self.c('eye'))
                canvas.line(ex - 3, eye_y + 3, ex + 3, eye_y - 3, self.c('eye'))
            return
        if style == 'blink':
            for side in (-1, 1):
                ex = head_x + side * 5
                canvas.line(ex - 3, eye_y, ex + 3, eye_y, self.c('eye'))
            return
        if style == 'happy':
            for side in (-1, 1):
                ex = head_x + side * 5
                canvas.arc(ex - 3, eye_y - 3, ex + 3, eye_y + 3, 200, 340, self.c('eye'))
            return
        for side in (-1, 1):
            ex = head_x + side * 5 + pose['look'][0]
            ey = eye_y + pose['look'][1]
            canvas.rect(ex - 3, ey - 3, ex + 3, ey + 3, self.c('eye'))
            canvas.pixel(ex - 1, ey - 1, self.c('white'))

    def draw_extra(self, canvas, pose):
        if pose['prop'] == 'magnifier':
            x, y = self.geometry(pose)
            self.magnifier(canvas, x + 8, 38 + y)


# ---------------------------------------------------------------------------
# Sprout -- a bean with a leaf, standing in a little mound of soil.
# ---------------------------------------------------------------------------

class Sprout(Rig):
    id = 'sprout'
    name = 'Sprout'
    description = 'A green bean sprout that sways its leaves and pops out of the soil.'
    palette = {
        'outline': '#2c4a29',
        'body': '#93d76d',
        'shade': '#5ba242',
        'light': '#ddf8c6',
        'eye': '#2c4a29',
        'pupil': '#182a16',
        'white': '#ffffff',
        'glass': '#e6ffd6',
        'soil': '#8a5a3b',
    }

    def geometry(self, pose):
        x = 24 + pose['dx']
        y = pose['dy']
        return x, y

    def draw_body(self, canvas, pose):
        x, y = self.geometry(pose)
        squash = pose['squash']
        # soil
        mask = self.mask_of(lambda d: d.ellipse([x - 16, 36 + y, x + 16, 48 + y], fill=255))
        self.paint(canvas, mask, self.c('soil'), self.c('outline'), shade_start=0.7)
        # stem
        sway = round(pose['wave'] * 2)
        stem = [(x, 30 + y), (x, 22 + y), (x + sway, 16 + y)]
        self.stroke(canvas, stem, 2, self.c('outline'))
        self.stroke(canvas, stem, 1, self.c('shade'))
        # leaves
        for side in (-1, 1):
            lx = x + sway + side * 8
            ly = 12 + y + side
            canvas.ellipse(lx, ly, 8, 4, self.c('outline'))
            canvas.ellipse(lx, ly, 7, 3, self.c('body'))
            canvas.ellipse(lx - side * 3, ly - 1, 3, 1, self.c('light'))
        # the bean
        rx = int(round(14 / max(0.7, squash)))
        ry = int(round(14 * squash))
        mask = self.mask_of(
            lambda d: d.ellipse([x - rx, 33 + y - ry, x + rx, 33 + y + ry], fill=255))
        self.paint(canvas, mask, self.c('body'), self.c('shade'), self.c('light'),
                   shade_start=0.45)

    def draw_face(self, canvas, pose):
        x, y = self.geometry(pose)
        style = 'blink' if pose['blink'] else pose['face']
        eye_y = 32 + y
        self.draw_eyes(canvas, x - 6, eye_y, 4, pose['look'], style)
        self.draw_eyes(canvas, x + 6, eye_y, 4, pose['look'], style)
        self.draw_mouth(canvas, x, eye_y + 10, 'smile', 7)

    def draw_extra(self, canvas, pose):
        if pose['prop'] == 'magnifier':
            x, y = self.geometry(pose)
            self.magnifier(canvas, x + 9, 24 + y)


PETS = [Blob(), Cat(), Ghost(), Bot(), Sprout()]


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def content_bbox(image):
    """The bounding box of the opaque pixels.

    Image.getbbox() on an RGBA image also counts transparent-but-coloured
    pixels, which is not what we want here.
    """
    return image.getchannel('A').getbbox()


def draw_grid(pet, row, frame, total):
    canvas = Canvas()
    pet.draw(canvas, row, frame, total)
    return canvas.im


def draw_grid_look(pet, index):
    canvas = Canvas()
    pet.draw_look(canvas, index)
    return canvas.im


def prepare(pet):
    """Learn the pet's footprint, then size it like the official pets.

    Every pet is drawn on the same 48x52 grid, but they do not fill it the
    same way. Measuring the real footprint and scaling that -- instead of
    scaling the grid -- keeps the pets centred and makes the jump fit.
    """
    idle = content_bbox(draw_grid(pet, 'idle', 0, len(DURATIONS['idle'])))
    region = list(idle)
    for name in DURATIONS:
        total = len(DURATIONS[name])
        for frame in range(total):
            box = content_bbox(draw_grid(pet, name, frame, total))
            if box is None:
                continue
            region[0] = min(region[0], box[0])
            region[1] = min(region[1], box[1])
            region[2] = max(region[2], box[2])
            region[3] = max(region[3], box[3])
    pet.region = tuple(region)

    idle_h = (idle[3] - idle[1]) * S
    if abs(idle_h - TARGET_H) > TARGET_H * 0.12:
        print(f'  ! {pet.id}: resting height {idle_h}px, target {TARGET_H}px')
    pet.scale = 1.0
    width = int(round((region[2] - region[0]) * S * pet.scale))
    height = int(round((region[3] - region[1]) * S * pet.scale))
    # The pets are drawn around the middle of the grid, so the crop goes in
    # the middle of the cell as well -- and their feet on the floor.
    pet.ox = (CELL_W - width) // 2
    pet.oy = FLOOR - int(round((idle[3] - region[1]) * S * pet.scale))


def render_cell(pet, row, frame, total):
    grid = draw_grid(pet, row, frame, total)
    return place(pet, grid)


def render_look(pet, index):
    grid = draw_grid_look(pet, index)
    return place(pet, grid)


def place(pet, grid):
    """Crop to the pet's footprint, scale it, and drop it into the cell."""
    cropped = grid.crop(pet.region)
    width = max(1, int(round(cropped.width * S * pet.scale)))
    height = max(1, int(round(cropped.height * S * pet.scale)))
    cropped = cropped.resize((width, height), Image.NEAREST)
    cell = Image.new('RGBA', (CELL_W, CELL_H), (0, 0, 0, 0))
    cell.paste(cropped, (pet.ox, pet.oy), cropped)
    return cell


def manifest_for(pet):
    return {
        'id': pet.id,
        'name': pet.name,
        'description': pet.description,
        'size': 200,
        'type': 'sprite',
        'preview': 'preview.png',
        'spriteVersionNumber': 2,
        'spritesheetPath': 'spritesheet.webp',
        'cell': {'width': CELL_W, 'height': CELL_H},
        'grid': {'columns': COLS, 'rows': ROWS},
        'idle': 'idle',
        'animations': {name: {'row': ROW_OF[name], 'durations': DURATIONS[name]}
                       for name in DURATIONS},
        'drag': {'right': 'running-right', 'left': 'running-left'},
        'look': {'rows': [9, 10], 'count': 16, 'startDegrees': 0, 'stepDegrees': 22.5},
        'idleRoutine': {'every': [3, 6], 'animations': ['waiting', 'waving', 'running']},
        'react': {'click': 'jumping'},
        'perform': {'sequence': ['jumping', 'waving'], 'splash': 'sparkle'},
        'source': 'original art, drawn by tools/make_pets.py',
    }


def render_atlas(pet):
    atlas = Image.new('RGBA', (COLS * CELL_W, ROWS * CELL_H), (0, 0, 0, 0))
    for name in DURATIONS:
        row = ROW_OF[name]
        total = len(DURATIONS[name])
        for frame in range(total):
            atlas.paste(render_cell(pet, name, frame, total),
                        (frame * CELL_W, row * CELL_H))
    for index in range(16):
        row = 9 + index // 8
        atlas.paste(render_look(pet, index), ((index % 8) * CELL_W, row * CELL_H))
    return atlas


def render_preview(pet):
    """A big still for the settings gallery.

    Same framing as the official pets' previews: a soft blue disc, a
    shadow on the ground and the pet standing above it.
    """
    frame = render_cell(pet, 'idle', 0, len(DURATIONS['idle']))

    disc = _disc(600, 288, (214, 237, 255), (174, 206, 241))
    shadow = Image.new('RGBA', (600, 600), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).ellipse([230, 452, 370, 486], fill=(120, 152, 190, 120))
    shadow = shadow.filter(ImageFilter.GaussianBlur(7))

    canvas = Image.new('RGBA', (600, 600), (0, 0, 0, 0))
    canvas.alpha_composite(disc)
    canvas.alpha_composite(shadow)
    canvas.alpha_composite(frame, ((600 - frame.width) // 2, 424 - frame.height))
    return canvas


def _disc(size, radius, top, bottom):
    """A soft vertical gradient in a circle, drawn twice as big so the edge
    is not jagged."""
    scale = 2
    big = size * scale
    gradient = Image.new('RGB', (1, big))
    for y in range(big):
        t = y / (big - 1)
        gradient.putpixel((0, y), tuple(
            int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    gradient = gradient.resize((big, big))
    mask = Image.new('L', (big, big), 0)
    ImageDraw.Draw(mask).ellipse(
        [big // 2 - radius * scale, big // 2 - radius * scale,
         big // 2 + radius * scale, big // 2 + radius * scale], fill=255)
    disc = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    disc.paste(gradient.convert('RGBA'), (0, 0), mask)
    return disc.resize((size, size), Image.LANCZOS)


def write_pet(pet):
    prepare(pet)
    directory = os.path.join(PETS_DIR, pet.id)
    os.makedirs(directory, exist_ok=True)
    atlas = render_atlas(pet)
    atlas.save(os.path.join(directory, 'spritesheet.webp'), 'WEBP',
               lossless=True, quality=100, method=6)
    render_preview(pet).save(os.path.join(directory, 'preview.png'))
    with open(os.path.join(directory, 'pet.json'), 'w', encoding='utf-8') as handle:
        json.dump(manifest_for(pet), handle, indent=2, ensure_ascii=False)
        handle.write('\n')
    return os.path.join(directory, 'spritesheet.webp')


def main():
    for pet in PETS:
        path = write_pet(pet)
        size = os.path.getsize(path)
        print(f'  {pet.id:<8} {pet.name:<8} {size / 1024:7.1f} KB  scale {pet.scale:.2f}'
              f'  {path}')
    print(f'\n{len(PETS)} pets drawn. Add them to pets/index.json to show them in Settings.')


if __name__ == '__main__':
    main()
