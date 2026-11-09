"""Full-frame superposition tests.

Every piece is a crop of a science image stretched to cover the whole target.
Compares:
  - targets: wide astronaut crop (original) vs tight face crop
  - methods: signed weights vs add-only weights with a free black level
  - dictionary size: 6,600 vs 20,000 pieces
and snapshots each greedy pursuit at 30 / 100 / 300 pieces.

"Add-only + black level" = stack the pieces as light (all weights >= 0), then
apply one global levels adjustment (subtract a constant glow, rescale).
Mathematically: non-negative pursuit on mean-removed pieces and target.
"""
import sys, time
from pathlib import Path
import numpy as np
import skimage.data as d
from skimage.color import rgb2gray
from skimage.metrics import structural_similarity as ssim
from scipy.optimize import nnls
from PIL import Image
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "experiments/out")
OUT.mkdir(parents=True, exist_ok=True)
N = 64
KS = (30, 100, 300)
T0 = time.time()


def log(*a):
    print(f"[{time.time() - T0:5.0f}s]", *a, flush=True)


def to_target(rgb, box):
    y0, y1, x0, x1 = box
    g = rgb2gray(rgb[y0:y1, x0:x1]).astype(np.float32)
    return np.asarray(Image.fromarray(g, "F").resize((N, N), Image.BOX))


astro = d.astronaut()
TARGETS = {
    "wide": to_target(astro, (30, 430, 60, 460)),
    "face": to_target(astro, (15, 215, 155, 355)),
}

SRCS = {
    "hubble": rgb2gray(d.hubble_deep_field()),
    "moon": d.moon() / 255.0,
    "retina": rgb2gray(d.retina()),
    "microaneurysms": d.microaneurysms() / 255.0,
    "tissue": rgb2gray(d.immunohistochemistry()),
}
SRC_PIL = {k: Image.fromarray(v.astype(np.float32), "F") for k, v in SRCS.items()}


def build_dictionary(n_total, seed=0):
    """Random crops (any size >= 32 px, any position), each resized to fill N x N."""
    rng = np.random.default_rng(seed)
    names = list(SRCS)
    big = [k for k in names if min(SRCS[k].shape) > 200]
    # same mix as superpose.py: small images get 1/8 the share of big ones
    share = np.array([8.0 if k in big else 1.0 for k in names])
    counts = np.round(share / share.sum() * n_total).astype(int)
    atoms, meta = [], []
    for name, cnt in zip(names, counts):
        H, W = SRCS[name].shape
        for _ in range(cnt):
            s = int(rng.integers(32, min(H, W)))
            y, x = int(rng.integers(0, H - s + 1)), int(rng.integers(0, W - s + 1))
            a = np.asarray(SRC_PIL[name].resize((N, N), Image.BOX, box=(x, y, x + s, y + s)))
            r = int(rng.integers(4))
            f = bool(rng.random() < 0.5)
            a = np.rot90(a, r)
            if f:
                a = a[:, ::-1]
            atoms.append(a.ravel())
            meta.append((name, y, x, s, r, f))
    A = np.array(atoms, dtype=np.float64).T  # pixels x atoms
    return A, meta


def pursuit(A, t, kmax, nonneg):
    """Greedy pursuit on mean-removed atoms/target. Returns {k: recon} at KS."""
    Ac = A - A.mean(0)
    keep = Ac.std(0) > 1e-6
    Ac = Ac[:, keep]
    idx_map = np.flatnonzero(keep)
    Dn = Ac / np.linalg.norm(Ac, axis=0)
    tc = t - t.mean()
    res, S, snaps, w = tc.copy(), [], {}, None
    for k in range(1, kmax + 1):
        c = Dn.T @ res
        if nonneg:
            c[S] = -np.inf
            j = int(np.argmax(c))
            if c[j] <= 1e-9:  # nothing left that adds light in the right places
                log(f"    add-only stalled at {k - 1} pieces")
                break
            S.append(j)
            w, _ = nnls(Ac[:, S], tc)
        else:
            S.append(int(np.argmax(np.abs(c))))
            w, *_ = np.linalg.lstsq(Ac[:, S], tc, rcond=None)
        res = tc - Ac[:, S] @ w
        if k in KS:
            snaps[k] = (Ac[:, S] @ w, int((w > 1e-12).sum()) if nonneg else len(S))
    # stalled runs: carry the last result forward so every K has a panel
    last = (Ac[:, S] @ w, int((w > 1e-12).sum()) if nonneg else len(S))
    for k in KS:
        snaps.setdefault(k, last)
    return snaps, [idx_map[s] for s in S], w


def score(rec, target):
    t = target.ravel()
    rr = (rec - rec.mean()) / (rec.std() + 1e-12) * t.std() + t.mean()
    r = np.corrcoef(rec, t)[0, 1]
    s = ssim(rr.reshape(N, N), target, data_range=float(t.max() - t.min()))
    return r, s, rr.reshape(N, N)


DICT_SIZES = (6600, 20000)
dicts = {}
for n in DICT_SIZES:
    dicts[n] = build_dictionary(n)
    log(f"dictionary {n}: built {dicts[n][0].shape[1]} pieces")

rows = []
for tname, target in TARGETS.items():
    t = target.ravel().astype(np.float64)
    fig, ax = plt.subplots(4, 1 + len(KS), figsize=(3.0 * (1 + len(KS)), 3.2 * 4))
    r_i = 0
    for nonneg in (False, True):
        for n in DICT_SIZES:
            A, meta = dicts[n]
            label = f"{'add-only+black' if nonneg else 'signed'} / {n // 1000}k dict"
            log(f"{tname}: {label}")
            snaps, S, w = pursuit(A, t, max(KS), nonneg)
            ax[r_i, 0].imshow(target, cmap="gray")
            ax[r_i, 0].set_title(f"target ({tname})\n{label}", fontsize=9)
            for c_i, k in enumerate(KS, start=1):
                rec, used = snaps[k]
                r, s, img = score(rec, target)
                rows.append((tname, label, k, used, r, s))
                ax[r_i, c_i].imshow(np.clip(img, target.min(), target.max()), cmap="gray")
                ax[r_i, c_i].set_title(f"{k} steps ({used} used)\ncorr {r:.2f}  SSIM {s:.2f}", fontsize=9)
                log(f"    k={k:3d} used={used:3d} corr={r:.3f} ssim={s:.3f}")
            r_i += 1
    for a_ in ax.flat:
        a_.axis("off")
    plt.tight_layout()
    plt.savefig(OUT / f"fullframe_{tname}.png", dpi=80)
    plt.close(fig)

print("\nSUMMARY")
print(f"{'target':6s} {'method/dict':26s} {'k':>4s} {'used':>5s} {'corr':>6s} {'ssim':>6s}")
for tname, label, k, used, r, s in rows:
    print(f"{tname:6s} {label:26s} {k:4d} {used:5d} {r:6.3f} {s:6.3f}")
log("done")
