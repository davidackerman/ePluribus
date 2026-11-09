"""Puzzle feasibility: how simple must a target be for 4-12 full-frame slides?

For each simple target (heart, letter, star, smiley) pick K slides with the
same add-only + black-level pursuit, then check the rotation-puzzle mechanic:
for each slide, does its correct orientation clearly beat the other 7
(rotations x flips) while the other slides stay solved?

Usage: python experiments/puzzle_tests.py [out_dir]
"""
import sys
from pathlib import Path
import numpy as np
import skimage.data as d
from skimage.color import rgb2gray
from scipy.optimize import nnls
from PIL import Image, ImageDraw, ImageFont
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "experiments/out")
OUT.mkdir(parents=True, exist_ok=True)
N, NDICT, KS, KCHECK = 64, 20000, (4, 6, 8, 12), 8


# ---------------------------------------------------------------- targets
def draw(fn):
    im = Image.new("L", (256, 256), 0)
    fn(ImageDraw.Draw(im))
    return np.asarray(im.resize((N, N), Image.BOX), dtype=np.float64) / 255.0


def heart(dr):
    t = np.linspace(0, 2 * np.pi, 200)
    x, y = 16 * np.sin(t) ** 3, 13 * np.cos(t) - 5 * np.cos(2 * t) - 2 * np.cos(3 * t) - np.cos(4 * t)
    dr.polygon(list(zip(128 + 6.5 * x, 120 - 6.5 * y)), fill=255)


def letter(dr):
    dr.text((128, 132), "A", fill=255, font=ImageFont.load_default(size=230), anchor="mm")


def star(dr):
    ang = np.pi / 2 + np.arange(10) * np.pi / 5
    r = np.where(np.arange(10) % 2 == 0, 115, 46)
    dr.polygon(list(zip(128 + r * np.cos(ang), 135 - r * np.sin(ang))), fill=255)


def smiley(dr):
    dr.ellipse([20, 20, 236, 236], outline=255, width=22)
    dr.ellipse([80, 75, 112, 120], fill=255)
    dr.ellipse([144, 75, 176, 120], fill=255)
    dr.arc([65, 85, 191, 195], start=20, end=160, fill=255, width=20)


TARGETS = {"heart": draw(heart), "letter A": draw(letter), "star": draw(star), "smiley": draw(smiley)}

# ---------------------------------------------------------------- dictionary (same recipe)
SRCS = {"hubble": rgb2gray(d.hubble_deep_field()), "moon": d.moon() / 255.0, "retina": rgb2gray(d.retina()),
        "microaneurysms": d.microaneurysms() / 255.0, "tissue": rgb2gray(d.immunohistochemistry())}
PIL = {k: Image.fromarray(v.astype(np.float32), "F") for k, v in SRCS.items()}
rng = np.random.default_rng(0)
names = list(SRCS)
share = np.array([8.0 if min(SRCS[k].shape) > 200 else 1.0 for k in names])
counts = np.round(share / share.sum() * NDICT).astype(int)
atoms, meta = [], []
for name, cnt in zip(names, counts):
    H, W = SRCS[name].shape
    for _ in range(cnt):
        s = int(rng.integers(32, min(H, W)))
        y, x = int(rng.integers(0, H - s + 1)), int(rng.integers(0, W - s + 1))
        a = np.asarray(PIL[name].resize((N, N), Image.BOX, box=(x, y, x + s, y + s)))
        a = np.rot90(a, int(rng.integers(4)))
        if rng.random() < 0.5:
            a = a[:, ::-1]
        atoms.append(a.ravel())
        meta.append(name)
A = np.array(atoms, dtype=np.float32).T
Ac = A - A.mean(0)
nrm = np.linalg.norm(Ac, axis=0)
ok = nrm > 1e-6
Dn = np.zeros_like(Ac)
Dn[:, ok] = Ac[:, ok] / nrm[ok]


def pursuit(t, k):
    tc = t.ravel() - t.mean()
    res, S, w = tc.copy(), [], None
    for _ in range(k):
        c = (Dn.T @ res.astype(np.float32)).astype(np.float64)
        c[S] = -np.inf
        c[~ok] = -np.inf
        j = int(np.argmax(c))
        if c[j] <= 1e-9:
            break
        S.append(j)
        Asub = Ac[:, S].astype(np.float64)
        w, _ = nnls(Asub, tc)
        res = tc - Asub @ w
    return S, w


def corr(img, t):
    return np.corrcoef(img.ravel(), t.ravel())[0, 1]


def variants(a):  # the 8 orientations: 4 rotations x optional flip; index 0 = as solved
    a = a.reshape(N, N)
    out = []
    for f in (False, True):
        b = a[:, ::-1] if f else a
        out += [np.rot90(b, r) for r in range(4)]
    return out


fig, ax = plt.subplots(len(TARGETS), 1 + len(KS), figsize=(2.6 * (1 + len(KS)), 2.8 * len(TARGETS)))
print(f"{'target':9s} " + " ".join(f"K={k:<3d}" for k in KS) + "   | rotation check at K=8: median margin, weakest margin, scrambled->solved")
for r_i, (tname, t) in enumerate(TARGETS.items()):
    ax[r_i, 0].imshow(t, cmap="gray")
    ax[r_i, 0].set_title(tname, fontsize=10)
    cs = []
    for c_i, k in enumerate(KS, start=1):
        S, w = pursuit(t, k)
        rec = (A[:, S].astype(np.float64) @ w).reshape(N, N)  # raw light sum; corr ignores black level
        cs.append(corr(rec, t))
        disp = (rec - rec.mean()) / rec.std() * t.std() + t.mean()
        ax[r_i, c_i].imshow(np.clip(disp, 0, 1), cmap="gray")
        ax[r_i, c_i].set_title(f"{k} slides, corr {cs[-1]:.2f}", fontsize=9)
        if k == KCHECK:
            slides = [A[:, j].astype(np.float64) for j in S]
            full = sum(wi * s for wi, s in zip(w, slides))
            margins = []
            for i, (wi, s) in enumerate(zip(w, slides)):
                others = full - wi * s
                sc = [corr(others + wi * v.ravel(), t) for v in variants(s)]
                margins.append(sc[0] - max(sc[1:]))
            pr = np.random.default_rng(1)
            scr = [corr(sum(wi * variants(s)[pr.integers(1, 8)].ravel() for wi, s in zip(w, slides)), t)
                   for _ in range(200)]
            mstats = f"{np.median(margins):+.3f}  {min(margins):+.3f}   {np.mean(scr):.2f} -> {corr(full, t):.2f}"
            srcs = ", ".join(sorted({meta[j] for j in S}))
    print(f"{tname:9s} " + " ".join(f"{c:5.2f}" for c in cs) + f"   | {mstats}   ({srcs})")
for a_ in ax.flat:
    a_.axis("off")
plt.tight_layout()
plt.savefig(OUT / "puzzle_targets.png", dpi=80)
