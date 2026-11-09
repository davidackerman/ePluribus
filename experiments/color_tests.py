"""Colour tests for full-frame superposition (face target, add-only light).

(a) one dimmer per image: each image keeps its own colours, one weight >= 0.
(b) colour filter per image: three weights >= 0 (R, G, B gains) per image,
    like a projector with a coloured gel. Still uniform across the image.
Both use a per-channel black level (subtract an even glow in R, G and B).

Usage: python experiments/color_tests.py [out_dir]
"""
import sys, time
from pathlib import Path
import numpy as np
import skimage.data as d
from scipy.optimize import nnls
from PIL import Image
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "experiments/out")
OUT.mkdir(parents=True, exist_ok=True)
N, NN, NDICT = 64, 64 * 64, 10000
KS = (30, 100, 300)
K = max(KS)
T0 = time.time()


def log(*a):
    print(f"[{time.time() - T0:5.0f}s]", *a, flush=True)


def rgbify(a):
    a = a.astype(np.float32)
    return np.stack([a] * 3, -1) if a.ndim == 2 else a


def chans(rgb):
    return [Image.fromarray(np.ascontiguousarray(rgb[..., c]), "F") for c in range(3)]


def vec(img):  # N x N x 3 -> channel-major vector (R block, G block, B block)
    return img.transpose(2, 0, 1).ravel()


def unvec(v):
    return v.reshape(3, N, N).transpose(1, 2, 0)


face = rgbify(d.astronaut()[15:215, 155:355] / 255.0)
target = np.stack([np.asarray(c.resize((N, N), Image.BOX)) for c in chans(face)], -1).astype(np.float64)
SRCS = {"hubble": d.hubble_deep_field() / 255.0, "moon": d.moon() / 255.0, "retina": d.retina() / 255.0,
        "microaneurysms": d.microaneurysms() / 255.0, "tissue": d.immunohistochemistry() / 255.0}
SRCS = {k: rgbify(v) for k, v in SRCS.items()}
PILS = {k: chans(v) for k, v in SRCS.items()}

# ---- dictionary: colour crops stretched to the full frame (same recipe as grayscale)
rng = np.random.default_rng(0)
names = list(SRCS)
share = np.array([8.0 if min(SRCS[k].shape[:2]) > 200 else 1.0 for k in names])
counts = np.round(share / share.sum() * NDICT).astype(int)
A = np.empty((3 * NN, counts.sum()), dtype=np.float32)
meta, col = [], 0
for name, cnt in zip(names, counts):
    H, W = SRCS[name].shape[:2]
    for _ in range(cnt):
        s = int(rng.integers(32, min(H, W)))
        y, x = int(rng.integers(0, H - s + 1)), int(rng.integers(0, W - s + 1))
        a = np.stack([np.asarray(c.resize((N, N), Image.BOX, box=(x, y, x + s, y + s))) for c in PILS[name]], -1)
        r, f = int(rng.integers(4)), bool(rng.random() < 0.5)
        a = np.rot90(a, r, axes=(0, 1))
        if f:
            a = a[:, ::-1]
        A[:, col] = vec(a)
        meta.append(name)
        col += 1
RAW = A.copy()  # keep originals for showing the pieces
# per-channel mean removal = free per-channel black level
for c in range(3):
    A[c * NN:(c + 1) * NN] -= A[c * NN:(c + 1) * NN].mean(0)
norm = np.maximum(np.linalg.norm(A, axis=0), 1e-6)
norm_ch = np.maximum(np.stack([np.linalg.norm(A[c * NN:(c + 1) * NN], axis=0) for c in range(3)]), 1e-6)
log(f"dictionary: {A.shape[1]} colour pieces")

tv = vec(target)
tmean = np.array([tv[c * NN:(c + 1) * NN].mean() for c in range(3)])
tc = tv - np.repeat(tmean, NN)


def recon(rc):
    return np.clip(unvec(rc + np.repeat(tmean, NN)), 0, 1)


def run_one_dimmer():
    res, S, snaps = tc.copy(), [], {}
    for k in range(1, K + 1):
        c = (A.T @ res.astype(np.float32)) / norm
        c[S] = -np.inf
        j = int(np.argmax(c))
        if c[j] <= 1e-9:
            log(f"  stalled at {k - 1}")
            break
        S.append(j)
        Asub = A[:, S].astype(np.float64)
        w, _ = nnls(Asub, tc)
        rc = Asub @ w
        res = tc - rc
        if k in KS:
            snaps[k] = recon(rc)
    return snaps, S, w


def run_colour_filter():
    res, S, snaps = tc.copy(), [], {}
    blocks = [slice(c * NN, (c + 1) * NN) for c in range(3)]
    for k in range(1, K + 1):
        cc = np.stack([(A[b].T @ res[b].astype(np.float32)) / norm_ch[c] for c, b in enumerate(blocks)])
        score = np.sqrt((np.clip(cc, 0, None) ** 2).sum(0))
        score[S] = -np.inf
        j = int(np.argmax(score))
        if score[j] <= 1e-9:
            log(f"  stalled at {k - 1}")
            break
        S.append(j)
        rc = np.empty_like(tc)
        W3 = []
        for b in blocks:  # channels are independent: three small NNLS problems
            Asub = A[b][:, S].astype(np.float64)
            wb, _ = nnls(Asub, tc[b])
            rc[b] = Asub @ wb
            W3.append(wb)
        res = tc - rc
        if k in KS:
            snaps[k] = recon(rc)
    return snaps, S, np.array(W3)


def corr(img):
    return np.corrcoef(vec(img) - np.repeat([vec(img)[c * NN:(c + 1) * NN].mean() for c in range(3)], NN), tc)[0, 1]


log("(a) one dimmer per image")
sa, Sa, wa = run_one_dimmer()
log("(b) colour filter per image")
sb, Sb, wb = run_colour_filter()

fig, ax = plt.subplots(3, 4, figsize=(12, 9.6))
for r_i, (label, snaps) in enumerate((("(a) one dimmer per image", sa), ("(b) colour filter per image", sb))):
    ax[r_i, 0].imshow(target)
    ax[r_i, 0].set_title(f"target\n{label}", fontsize=9)
    for c_i, k in enumerate(KS, start=1):
        img = snaps.get(k, snaps[max(snaps)])
        ax[r_i, c_i].imshow(img)
        ax[r_i, c_i].set_title(f"{k} images, corr {corr(img):.2f}", fontsize=9)
        log(f"{label:30s} k={k:3d} corr={corr(img):.3f}")
contrib = wa * norm[Sa]
for c_i, i in enumerate(np.argsort(-contrib)[:4]):
    ax[2, c_i].imshow(np.clip(unvec(RAW[:, Sa[i]]), 0, 1))
    ax[2, c_i].set_title(f"(a) strongest #{c_i + 1}: {meta[Sa[i]]}", fontsize=9)
for a_ in ax.flat:
    a_.axis("off")
plt.tight_layout()
plt.savefig(OUT / "color_face.png", dpi=80)
log("sources used (a):", {n: sum(meta[i] == n for i in Sa) for n in names})
log("sources used (b):", {n: sum(meta[i] == n for i in Sb) for n in names})
log("done")
