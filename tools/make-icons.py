"""Rasterise the Wavefy mark into the PNG sizes installers actually need.

iOS ignores an SVG `apple-touch-icon`, so the app icon has to exist as a PNG or
"Add to Home Screen" falls back to a screenshot of the page. This script keeps
the PNGs in sync with `icons/icon.svg` — the same geometry, same light palette.

Run from the project root:

    python tools/make-icons.py

Writes: icons/icon-512.png, icons/icon-192.png, icons/apple-touch-icon.png,
        icons/maskable-512.png
"""

from PIL import Image, ImageChops, ImageDraw, ImageFilter

S = 512                 # logical canvas, matches the SVG viewBox
SS = 4                  # supersample factor for clean antialiased edges
W = S * SS

# ---- palette (light only, straight from icons/icon.svg) ----------------------
TILE_STOPS = [(0.0, (255, 255, 255)), (0.55, (255, 246, 248)), (1.0, (255, 231, 237))]
WAVE_STOPS = [(0.0, (255, 125, 146)), (0.35, (255, 42, 60)),
              (0.72, (255, 84, 104)), (1.0, (255, 147, 166))]
BACK_STOPS = [(0.0, (255, 210, 218)), (1.0, (255, 174, 188))]
RIM = (255, 219, 226)
GLOW = (255, 42, 60)

# ---- the ribbon, in 512-unit space ------------------------------------------
SEGMENTS = [
    ((104, 256), (129, 112), (155, 112), (180, 256)),
    ((180, 256), (205, 400), (231, 400), (256, 256)),
    ((256, 256), (281, 112), (307, 112), (332, 256)),
    ((332, 256), (357, 400), (383, 400), (408, 256)),
]
STROKE = 74


def stops_color(stops, t):
    t = max(0.0, min(1.0, t))
    for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
        if t <= t1:
            k = 0.0 if t1 == t0 else (t - t0) / (t1 - t0)
            return tuple(round(c0[i] + (c1[i] - c0[i]) * k) for i in range(3))
    return stops[-1][1]


def gradient(size, p0, p1, stops):
    """Linear gradient across `size`, with p0/p1 in normalised coordinates."""
    img = Image.new("RGB", (size, size))
    vx, vy = p1[0] - p0[0], p1[1] - p0[1]
    denom = vx * vx + vy * vy
    rows = []
    for y in range(size):
        for x in range(size):
            t = ((x / size - p0[0]) * vx + (y / size - p0[1]) * vy) / denom
            rows.append(stops_color(stops, t))
    img.putdata(rows)
    return img


def cubic(p0, c1, c2, p1, steps=72):
    out = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        x = u**3 * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t**3 * p1[0]
        y = u**3 * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t**3 * p1[1]
        out.append((x * SS, y * SS))
    return out


def stroke_mask(segment_indexes, width=STROKE):
    """Round-capped, round-jointed stroke of the given segments, downsampled."""
    m = Image.new("L", (W, W), 0)
    d = ImageDraw.Draw(m)
    r = width * SS / 2
    for i in segment_indexes:
        line = cubic(*SEGMENTS[i])
        d.line(line, fill=255, width=int(width * SS), joint="curve")
        for p in (line[0], line[-1]):
            d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=255)
    return m.resize((S, S), Image.Resampling.LANCZOS)


def rounded_mask(radius):
    m = Image.new("L", (W, W), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, W - 1, W - 1], radius=radius * SS, fill=255)
    return m.resize((S, S), Image.Resampling.LANCZOS)


def scaled(mask, factor):
    """Scale a stroke mask about the canvas centre."""
    if factor == 1.0:
        return mask
    small = mask.resize((max(1, round(S * factor)),) * 2, Image.Resampling.LANCZOS)
    out = Image.new("L", (S, S), 0)
    out.paste(small, ((S - small.width) // 2, (S - small.height) // 2))
    return out


def build(full_bleed=False, wave_scale=1.0):
    """One 512x512 RGBA icon. full_bleed = square with no transparency (iOS /
    Android mask it themselves); otherwise the rounded tile from the SVG."""
    tile = gradient(S, (0.15, 0.0), (0.85, 1.0), TILE_STOPS)

    # a soft light sheen, top-left to bottom-right
    sheen = Image.new("L", (S, S))
    sheen.putdata([round(255 * max(0.0, 1 - ((x / S) ** 2 + (y / S) ** 2) / 0.55))
                   for y in range(S) for x in range(S)])
    sheen = sheen.filter(ImageFilter.GaussianBlur(60))
    tile = Image.composite(Image.new("RGB", (S, S), (255, 255, 255)), tile, sheen)

    if not full_bleed:
        rim = Image.new("L", (W, W), 0)
        ImageDraw.Draw(rim).rounded_rectangle([SS, SS, W - SS - 1, W - SS - 1],
                                             radius=117 * SS, outline=255, width=2 * SS)
        tile = Image.composite(Image.new("RGB", (S, S), RIM), tile,
                               rim.resize((S, S), Image.Resampling.LANCZOS))

    canvas = tile.convert("RGBA").copy()

    back = scaled(stroke_mask([0, 1, 2, 3]), wave_scale)
    front = scaled(stroke_mask([1, 2, 3]), wave_scale)
    hump = scaled(stroke_mask([0]), wave_scale)

    # rose glow: the union of the strands, blurred and dropped a little lower
    glow = ImageChops.lighter(ImageChops.lighter(back, front), hump)
    glow = glow.filter(ImageFilter.GaussianBlur(18)).point(lambda v: int(v * 0.2))
    canvas.paste(Image.new("RGB", (S, S), GLOW), (0, 9), glow)

    canvas.paste(gradient(S, (0.0, 0.0), (1.0, 1.0), BACK_STOPS), (0, 0), back)
    canvas.paste(gradient(S, (0.05, 0.1), (0.95, 0.95), WAVE_STOPS), (0, 0), front)
    # the left hump crosses back over the trough at half strength
    hump_tint = gradient(S, (0.05, 0.1), (0.95, 0.95), [(0.0, (255, 125, 146))] * 2)
    canvas.paste(hump_tint, (0, 0), hump.point(lambda v: int(v * 0.5)))

    if not full_bleed:
        canvas.putalpha(rounded_mask(118))

    return canvas


def main():
    import os
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.join(here, "icons")

    tile = build()
    tile.resize((512, 512), Image.Resampling.LANCZOS).save(os.path.join(out, "icon-512.png"))
    tile.resize((192, 192), Image.Resampling.LANCZOS).save(os.path.join(out, "icon-192.png"))

    # iOS masks the icon itself, so this one is a full square: no corner radius,
    # no transparency, wave nudged in so nothing important sits under the mask.
    build(full_bleed=True, wave_scale=0.86).resize(
        (180, 180), Image.Resampling.LANCZOS).convert("RGB").save(
        os.path.join(out, "apple-touch-icon.png"))

    # maskable = full bleed, art inside the central 80% safe zone
    build(full_bleed=True, wave_scale=0.7).resize(
        (512, 512), Image.Resampling.LANCZOS).convert("RGB").save(
        os.path.join(out, "maskable-512.png"))

    for name in ("icon-512.png", "icon-192.png", "apple-touch-icon.png", "maskable-512.png"):
        p = os.path.join(out, name)
        print(f"{name:24} {os.path.getsize(p):>7} bytes")


if __name__ == "__main__":
    main()
