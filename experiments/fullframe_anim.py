"""Animated GIF: a face built by adding full-frame science images as light.

Every piece is a crop of a science image stretched to cover the WHOLE frame.
Pieces are chosen greedily with non-negative weights (added as light), then one
global black level is set (subtract the even glow) -- see fullframe_tests.py.

Scenes:
  A. build-up: each new image shown next to the running total
  B. raw sum of light  ->  after one levels adjustment
  C. the strongest images fanned out as stacked transparencies, collapsing into the face
  D. contact sheet of every image used, next to the result

Usage: python experiments/fullframe_anim.py [out_dir]
"""
import sys, time, pickle
from pathlib import Path
import numpy as np
import skimage.data as d
from skimage.color import rgb2gray
from scipy.optimize import nnls
from PIL import Image, ImageDraw, ImageFont
import matplotlib.cm as cm

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "experiments/out")
OUT.mkdir(parents=True, exist_ok=True)
N, K, NDICT = 64, 300, 20000
CACHE = OUT / "fullframe_anim_state.pkl"
NICE = {"hubble": "Hubble Deep Field", "moon": "Moon", "retina": "retina",
        "microaneurysms": "retina close-up", "tissue": "tissue stain"}
T0 = time.time()


def log(*a):
    print(f"[{time.time() - T0:5.0f}s]", *a, flush=True)


# ----------------------------------------------------------------- compute
def build_and_fit():
    g = rgb2gray(d.astronaut()[15:215, 155:355]).astype(np.float32)
    target = np.asarray(Image.fromarray(g, "F").resize((N, N), Image.BOX)).astype(np.float64)
    srcs = {"hubble": rgb2gray(d.hubble_deep_field()), "moon": d.moon() / 255.0,
            "retina": rgb2gray(d.retina()), "microaneurysms": d.microaneurysms() / 255.0,
            "tissue": rgb2gray(d.immunohistochemistry())}
    pil = {k: Image.fromarray(v.astype(np.float32), "F") for k, v in srcs.items()}
    rng = np.random.default_rng(0)
    names = list(srcs)
    share = np.array([8.0 if min(srcs[k].shape) > 200 else 1.0 for k in names])
    counts = np.round(share / share.sum() * NDICT).astype(int)
    atoms, meta = [], []
    for name, cnt in zip(names, counts):
        H, W = srcs[name].shape
        for _ in range(cnt):
            s = int(rng.integers(32, min(H, W)))
            y, x = int(rng.integers(0, H - s + 1)), int(rng.integers(0, W - s + 1))
            a = np.asarray(pil[name].resize((N, N), Image.BOX, box=(x, y, x + s, y + s)))
            r, f = int(rng.integers(4)), bool(rng.random() < 0.5)
            a = np.rot90(a, r)
            if f:
                a = a[:, ::-1]
            atoms.append(a.ravel())
            meta.append((name, y, x, s, r, f))
    A = np.array(atoms, dtype=np.float32).T
    log(f"dictionary: {A.shape[1]} full-frame pieces")
    Ac = A - A.mean(0)
    norms = np.linalg.norm(Ac, axis=0)
    ok = norms > 1e-6
    Dn = np.zeros_like(Ac)
    Dn[:, ok] = Ac[:, ok] / norms[ok]
    t = target.ravel()
    tc = t - t.mean()
    res, S, recs = tc.copy(), [], []
    for k in range(1, K + 1):
        c = (Dn.T @ res.astype(np.float32)).astype(np.float64)
        c[S] = -np.inf
        c[~ok] = -np.inf
        j = int(np.argmax(c))
        if c[j] <= 1e-9:
            log(f"stalled at {k - 1}")
            break
        S.append(j)
        Asub = Ac[:, S].astype(np.float64)
        w, _ = nnls(Asub, tc)
        res = tc - Asub @ w
        recs.append((Asub @ w + t.mean()).reshape(N, N).astype(np.float32))
    log(f"pursuit done: {len(S)} pieces")
    return dict(target=target, P=A[:, S].copy(), meta=[meta[j] for j in S], w=w, recs=recs)


if CACHE.exists():
    st = pickle.load(open(CACHE, "rb"))
    log("loaded cached fit")
else:
    st = build_and_fit()
    pickle.dump(st, open(CACHE, "wb"))

target, P, meta, w, recs = st["target"], st["P"], st["meta"], st["w"], st["recs"]
KN = len(recs)

# ----------------------------------------------------------------- render helpers
W, H = 800, 450
BG = (14, 16, 22)
try:
    font, small = ImageFont.load_default(size=16), ImageFont.load_default(size=12)
except TypeError:
    font = small = ImageFont.load_default()
TLO, THI = float(target.min()), float(target.max())


def lev(a):  # leveled reconstruction -> [0,1] using target's range
    return np.clip((a - TLO) / (THI - TLO), 0, 1)


def autoc(a):  # per-image auto-contrast for display of single pieces/layers
    p1, p99 = np.percentile(a, [1, 99.5])
    return np.clip((a - p1) / (p99 - p1 + 1e-12), 0, 1)


def rgba(g01, size, tint=None, alpha=None, border=False):
    f = size // N
    up = np.kron(g01, np.ones((f, f)))
    col = np.array([255.0, 255, 255]) if tint is None else 0.45 * 255 + 0.55 * tint
    rgb = up[..., None] * col
    a = np.full(up.shape, 255.0) if alpha is None else np.clip(up * alpha, 0, 1) * 255
    if border:
        for sl in (np.s_[:2, :], np.s_[-2:, :], np.s_[:, :2], np.s_[:, -2:]):
            a[sl] = 110
            rgb[sl] = 170
    return Image.fromarray(np.dstack([rgb, a[..., None]]).astype(np.uint8), "RGBA")


def base():
    return Image.new("RGBA", (W, H), BG + (255,))


def txt(im, xy, s, f=None, fill=(220, 220, 230), anchor="mm"):
    ImageDraw.Draw(im).text(xy, s, fill=fill, font=f or font, anchor=anchor)


def place(canvas, img, cx, cy, s, S):  # tilt plane by s in [0,1], center at (cx,cy)
    a, b = 1 - 0.45 * s, -0.22 * s
    data = (1 / a, 0, S / 2 - cx / a, -(b / a), 1, S / 2 - cy + (b / a) * cx)
    canvas.alpha_composite(img.transform((W, H), Image.AFFINE, data, resample=Image.BILINEAR))


frames, durs = [], []


def add(im, ms):
    frames.append(im.convert("RGB"))
    durs.append(ms)


def piece_label(m):
    name, y, x, s, r, f = m
    return f"{NICE[name]}, {s} px crop" + (", rotated" if r else "")


tgt_thumb = rgba(lev(target), 128)

# ----------------------------------------------------------------- A: build-up
steps = [k for k in list(range(1, 13)) + [15, 18, 22, 26, 30, 36, 42, 50, 60, 70, 85, 100,
                                          120, 140, 165, 190, 220, 250, 280, 300] if k <= KN]
for k in steps:
    im = base()
    im.alpha_composite(rgba(autoc(P[:, k - 1].reshape(N, N)), 192), (60, 92))
    txt(im, (156, 76), f"image #{k}")
    txt(im, (156, 302), piece_label(meta[k - 1]), small, (160, 160, 170))
    txt(im, (300, 188), "+", ImageFont.load_default(size=40) if font is not small else font)
    im.alpha_composite(rgba(lev(recs[k - 1]), 256), (340, 60))
    txt(im, (468, 44), f"running total: {k} image{'s' if k > 1 else ''}")
    im.alpha_composite(tgt_thumb, (642, 60))
    txt(im, (706, 204), "target", small, (150, 150, 160))
    txt(im, (W // 2, H - 70), "each image is a crop of a science picture, stretched to cover the whole frame,")
    txt(im, (W // 2, H - 46), "and added as light")
    add(im, 900 if k <= 3 else 450 if k <= 12 else 110)
durs[-1] = 1800

final = recs[-1]
raw = (P @ w).reshape(N, N)

# ----------------------------------------------------------------- B: light sum -> levels
for show_right in (False, True):
    im = base()
    im.alpha_composite(rgba(np.clip(raw / raw.max(), 0, 1), 256), (90, 70))
    txt(im, (218, 52), f"all {KN} images added as light")
    if show_right:
        dr = ImageDraw.Draw(im)
        dr.line([(370, 198), (420, 198)], fill=(220, 220, 230), width=3)
        dr.polygon([(432, 198), (418, 189), (418, 207)], fill=(220, 220, 230))
        im.alpha_composite(rgba(lev(final), 256), (454, 70))
        txt(im, (582, 52), "one levels adjustment")
        txt(im, (W // 2, H - 58), "stacked light only ever brightens, so the sum is a washed-out glow;")
        txt(im, (W // 2, H - 34), "subtracting that even glow (one black-level knob) reveals the face")
    add(im, 1200 if not show_right else 3000)

# ----------------------------------------------------------------- C: stack of transparencies
# The strongest images (by contribution to the picture) fanned out as slides,
# then collapsed back into the final face.
# (A split by crop width does NOT give a clean coarse->fine story for
#  full-frame pieces -- each width band has similar frequency content.)
Pc = P - P.mean(0)
contrib = w * np.linalg.norm(Pc, axis=0)
M = 8
top = np.argsort(-contrib)[:M]
slides = [autoc(P[:, i].reshape(N, N)) for i in top]
tints = [np.array(cm.plasma(0.15 + 0.75 * j / (M - 1))[:3]) * 255 for j in range(M)]


def fanned(s, label=True):
    im = base()
    cx0, cy0, dx, dy = W // 2, H // 2 - 30, 52, -9
    if s < 0.999:
        merged = base()
        place(merged, rgba(lev(final), 256), cx0, cy0, s, 256)
        im = Image.blend(im, merged, 1 - s)
    for j in reversed(range(M)):  # strongest at front-left
        off = j - (M - 1) / 2
        place(im, rgba(slides[j], 256, tint=tints[j], alpha=1.5 * s, border=s > 0.05),
              int(cx0 + s * off * dx), int(cy0 + s * off * dy), s, 256)
    if label and s > 0.5:
        names = sorted({NICE[meta[i][0]] for i in top})
        txt(im, (W // 2, H - 52), f"the {M} strongest of the {KN} images, as stacked transparencies")
        txt(im, (W // 2, H - 28), "(" + ", ".join(names) + ")", small, (160, 160, 170))
    return im


ease = lambda u: 0.5 - 0.5 * np.cos(np.pi * u)
for u in np.linspace(0, 1, 26):
    add(fanned(ease(u)), 60)
add(fanned(1), 3000)
for u in np.linspace(1, 0, 22):
    add(fanned(ease(u), label=False), 60)
im = base()
place(im, rgba(lev(final), 256), W // 2, H // 2 - 30, 0, 256)
txt(im, (W // 2, H - 40), f"stack all {KN}, set the black level: the face")
add(im, 1600)

# ----------------------------------------------------------------- D: contact sheet
order = np.argsort(-w)
cols_n, cell, th = 20, 22, 20
rows_n = int(np.ceil(KN / cols_n))
thumbs = [Image.fromarray((autoc(P[:, i].reshape(N, N)) * 255).astype(np.uint8), "L")
          .resize((th, th), Image.BILINEAR).convert("RGBA") for i in order]
gx, gy = 40, 62
for reveal in list(range(1, rows_n + 1, 2)) + [rows_n]:
    im = base()
    txt(im, (gx + cols_n * cell // 2, 40), f"the {KN} images used, strongest first", small, (200, 200, 210))
    for n, tmb in enumerate(thumbs[: reveal * cols_n]):
        im.alpha_composite(tmb, (gx + (n % cols_n) * cell, gy + (n // cols_n) * cell))
    if reveal == rows_n:
        txt(im, (gx + cols_n * cell + 22, gy + rows_n * cell // 2), "=", font)
        im.alpha_composite(rgba(lev(final), 256), (524, 72))
        txt(im, (652, 52), "all of them added together", small, (200, 200, 210))
        txt(im, (W // 2, H - 30), "Hubble Deep Field, Moon, retina and tissue-stain images")
    add(im, 70 if reveal < rows_n else 4000)

gif = OUT / "face_from_science_images.gif"
frames[0].save(gif, save_all=True, append_images=frames[1:], duration=durs, loop=0, optimize=True)
log(f"{len(frames)} frames, {gif.stat().st_size // 1024} KB -> {gif}")
for name, i in (("chk_ff_build", len(steps) - 1), ("chk_ff_levels", len(steps) + 1),
                ("chk_ff_stack", len(steps) + 2 + 26), ("chk_ff_sheet", len(frames) - 1)):
    frames[i].save(OUT / f"{name}.png")
