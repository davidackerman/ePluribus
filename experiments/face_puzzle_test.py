"""Face puzzle viability: scramble the orientation of only the M strongest of
the 300 slides (the rest stay correct). Is the face hidden when scrambled, and
does each correct turn clearly help?

Uses the grayscale 300-piece face fit saved by fullframe_anim.py.
Usage: python experiments/face_puzzle_test.py [out_dir]
"""
import sys, pickle
from pathlib import Path
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "experiments/out")
st = pickle.load(open(OUT / "fullframe_anim_state.pkl", "rb"))
P, w, t = st["P"].astype(float), st["w"], st["target"]
N = 64


def variants(a):  # 8 orientations of an (already oriented) slide; index 0 = as solved
    a = a.reshape(N, N)
    out = []
    for f in (False, True):
        b = a[:, ::-1] if f else a
        out += [np.rot90(b, r).ravel() for r in range(4)]
    return out


def corr(x):
    return np.corrcoef(x, t.ravel())[0, 1]


def show(x):
    x = (x - x.mean()) / x.std() * t.std() + t.mean()
    return np.clip(x.reshape(N, N), 0, 1)


Pc = P - P.mean(0)
contrib = w * np.linalg.norm(Pc, axis=0)
full = P @ w
rng = np.random.default_rng(3)
fig, ax = plt.subplots(3, 5, figsize=(15, 9.6))
print(f"solved corr {corr(full):.3f}")
for row, M in enumerate((6, 8, 12)):
    top = np.argsort(-contrib)[:M]
    share = contrib[top].sum() / contrib.sum()
    # per-slide margin with everything else solved
    margins = []
    for i in top:
        others = full - w[i] * P[:, i]
        sc = [corr(others + w[i] * v) for v in variants(P[:, i])]
        margins.append(sc[0] - max(sc[1:]))
    # scramble all M (each to a random wrong orientation), then fix strongest-first
    wrong = {i: variants(P[:, i])[rng.integers(1, 8)] for i in top}
    cur = full.copy()
    for i in top:
        cur += w[i] * (wrong[i] - P[:, i])
    steps = [corr(cur)]
    ax[row, 0].imshow(show(cur), cmap="gray")
    ax[row, 0].set_title(f"{M} slides scrambled\ncorr {steps[0]:.2f}", fontsize=9)
    snap_at = {M // 3: 1, 2 * M // 3: 2, M: 3}
    for n_fixed, i in enumerate(top, start=1):
        cur += w[i] * (P[:, i] - wrong[i])
        steps.append(corr(cur))
        if n_fixed in snap_at:
            a_ = ax[row, snap_at[n_fixed]]
            a_.imshow(show(cur), cmap="gray")
            a_.set_title(f"{n_fixed} of {M} fixed\ncorr {steps[-1]:.2f}", fontsize=9)
    ax[row, 4].plot(range(M + 1), steps, "o-")
    ax[row, 4].set_title(f"corr as slides are fixed (M={M})", fontsize=9)
    ax[row, 4].set_ylim(0, 1)
    print(f"M={M:2d}: top slides carry {share:.0%} of contrast | scrambled corr {steps[0]:.2f} -> solved {steps[-1]:.2f} | "
          f"per-slide margin median {np.median(margins):+.3f}, weakest {min(margins):+.3f}")
for a_ in ax[:, :4].flat:
    a_.axis("off")
plt.tight_layout()
plt.savefig(OUT / "face_puzzle.png", dpi=80)
