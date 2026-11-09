"""Dump pack images as raw RGB bytes so the Node tests can read them without a
PNG decoder.  Usage: python tests/dump_raw.py OUT_DIR"""
import json, sys
from pathlib import Path
import numpy as np
from PIL import Image

web = Path(__file__).resolve().parents[1] / "web"
out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
cat = json.load(open(web / "packs" / "packs.json"))
meta = {}
for im in cat["images"]:
    a = np.asarray(Image.open(web / "packs" / im["file"]).convert("RGB"))
    (out / f"{im['id']}.rgb").write_bytes(a.tobytes())
    meta[im["id"]] = dict(w=a.shape[1], h=a.shape[0])
a = np.asarray(Image.open(web / "samples" / "astronaut.jpg").convert("RGB"))
(out / "astronaut.rgb").write_bytes(a.tobytes())
meta["astronaut"] = dict(w=a.shape[1], h=a.shape[0])
json.dump(meta, open(out / "meta.json", "w"))
print("wrote", len(meta), "images to", out)
