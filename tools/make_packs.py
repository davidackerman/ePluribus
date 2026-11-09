"""Build the web app's source-image packs from scikit-image's sample data.

Writes web/packs/<file>.png (max side 1024), web/packs/thumbs/<file>.jpg,
web/packs/packs.json, and sample target photos in web/samples/.

Image ids in packs.json are stable: share links refer to images by id, so
never renumber -- only append.

NOTE: credits come from scikit-image's docstrings. Check each image's licence
before publishing the site.

Usage: python tools/make_packs.py
"""
import io, json, math, re, time, urllib.parse, urllib.request
from pathlib import Path
import numpy as np
import skimage.data as d
from PIL import Image

ROOT = Path(__file__).resolve().parents[1] / "web"
PACKS = ROOT / "packs"
THUMBS = PACKS / "thumbs"
SAMPLES = ROOT / "samples"
for p in (PACKS, THUMBS, SAMPLES):
    p.mkdir(parents=True, exist_ok=True)
MAXSIDE = 1024


def norm(a, lo=0.5, hi=99.8):
    a = a.astype(np.float64)
    p0, p1 = np.percentile(a, [lo, hi])
    return np.clip((a - p0) / (p1 - p0 + 1e-12), 0, 1)


def compose(channels, colors):
    out = sum(norm(c)[..., None] * np.array(col, dtype=float) for c, col in zip(channels, colors))
    return np.clip(out, 0, 1)


def to_u8(a):
    return (np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8) if a.dtype != np.uint8 else a


GREEN, MAGENTA = (0.15, 1.0, 0.3), (1.0, 0.2, 0.9)

# (stable id, file stem, title, loader, skimage function for the credit text)
IMAGES = [
    (0, "hubble_xdf", "Hubble eXtreme Deep Field", lambda: d.hubble_deep_field(), "hubble_deep_field"),
    (1, "moon", "Surface of the Moon", lambda: d.moon(), "moon"),
    (2, "retina", "Human retina", lambda: d.retina(), "retina"),
    (3, "retina_closeup", "Retina close-up (microaneurysms)", lambda: d.microaneurysms(), "microaneurysms"),
    (4, "cornea", "Living cornea (palisades of Vogt)", lambda: to_u8(norm(d.palisades_of_vogt()[30])), "palisades_of_vogt"),
    (5, "ihc_stain", "Immunohistochemistry stain", lambda: d.immunohistochemistry(), "immunohistochemistry"),
    (6, "skin", "Skin layers (microscope)", lambda: d.skin(), "skin"),
    (7, "cell", "Cell floating in saline", lambda: d.cell(), "cell"),
    (8, "cells3d", "Fluorescent cells (membranes and nuclei)",
     lambda: to_u8(compose(d.cells3d()[30], (GREEN, MAGENTA))), "cells3d"),
    (9, "kidney", "Mouse kidney tissue (fluorescence)",
     lambda: to_u8(np.stack([norm(c) for c in np.moveaxis(d.kidney().max(0), -1, 0)], -1)), "kidney"),
    (10, "lily", "Lily-of-the-valley stem (fluorescence)",
     lambda: to_u8(compose(np.moveaxis(d.lily(), -1, 0),
                           ((1, 0.25, 0.25), (0.25, 1, 0.35), (0.3, 0.5, 1), (1, 0.85, 0.2)))), "lily"),
    (11, "mitosis", "Human cells dividing (nuclei)", lambda: d.human_mitosis(), "human_mitosis"),
    (12, "protein_transport", "Proteins moving into a nucleus",
     lambda: to_u8(compose(d.protein_transport()[7], (GREEN, MAGENTA))), "protein_transport"),
    (13, "head_a", "Head scan (upper slice)", lambda: to_u8(norm(d.brain()[2])), "brain"),
    (14, "head_b", "Head scan (lower slice)", lambda: to_u8(norm(d.brain()[8])), "brain"),
]

# Live maps: huge public image pyramids read tile by tile from their hosts (all send CORS
# headers). Tile layouts as in coresample (github.com/davidackerman/coresample). Ids share
# the share-link id space with IMAGES, so keep them >= 200 and never renumber.
MAPS = [
    dict(id=200, key="moon_map", name="Moon map", kind="xyz", tileSize=256, maxZoom=8, width=131072, height=65536,
         url="https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/{z}/{y}/{x}.jpg",
         credit="NASA/GSFC/Arizona State University: LRO Wide Angle Camera global mosaic, via NASA Trek",
         family="Moon", coresample="moon-wac", thumb_tile=(5, 29, 23)),  # around Tycho
    dict(id=201, key="mars_map", name="Mars map", kind="xyz", tileSize=512, maxZoom=12, width=4194304, height=2097152,
         url="https://astro.arcgis.com/arcgis/rest/services/OnMars/CTX/MapServer/tile/{z}/{y}/{x}",
         skipZooms=[5, 11],  # broken in Esri's cache (see coresample)
         noDataBlack=True,   # gaps between CTX strips are pure black
         credit="NASA/JPL/MSSS/The Murray Lab: CTX global mosaic of Mars (free for all uses with this credit; tiles served by Esri)",
         family="Mars", coresample="mars-ctx", thumb_tile=(8, 366, 101)),  # Jezero crater
    dict(id=202, key="andromeda", name="Andromeda (Hubble)", kind="zoomify",
         base="https://cdn.esahubble.org/archives/images/zoomable/heic1502a",
         noDataBlack=True,  # outside the PHAT footprint is pure black
         credit="NASA, ESA, J. Dalcanton, B.F. Williams, L.C. Johnson (University of Washington), the PHAT team, R. Gendler (CC BY 4.0)",
         family="Andromeda", coresample="andromeda", thumb_back=3, thumb_center=(34768, 11115)),
    dict(id=203, key="webb_carina", name="Carina nebula (Webb)", kind="zoomify",
         base="https://cdn.esawebb.org/archives/images/zoomable/weic2205a",
         credit="NASA, ESA, CSA, STScI (CC BY 4.0)",
         family="Carina nebula", coresample="webb", thumb_back=2, thumb_center=(7287, 4220)),
]

# Tabs the packs are shown under.
TABS = [("space", "Space"), ("planets", "Planets"), ("earth", "Earth & nature"), ("life", "Life & medicine"), ("art", "Art")]

# (id, name, blurb, source, family, tab). source: a map id, a list of image ids, or
# "commons:<key>" for the reviewed Wikimedia Commons picks in tools/commons_picks.json.
# family is the short name used in "37% Mars".
PACK_DEFS = [
    ("andromeda", "Andromeda", "Hubble's 1.5-gigapixel galaxy", 202, "Andromeda", "space"),
    ("webb_carina", "Carina nebula", "Webb's 'Cosmic Cliffs'", 203, "Carina nebula", "space"),
    ("nebulae", "Nebulae", "Crab, Helix, Orion, Pillars of Creation", "commons:nebulae", "nebulae", "space"),
    ("space", "Deep space", "Thousands of galaxies from Hubble", [0], "deep space", "space"),
    ("moon_map", "Moon: whole map", "Every crater, at any zoom (NASA LRO)", 200, "Moon", "planets"),
    ("mars_map", "Mars: whole map", "Craters, dunes, channels (CTX mosaic)", 201, "Mars", "planets"),
    ("planets", "Planets", "Jupiter, Saturn, Venus, Pluto, Earthrise", "commons:planets", "planets", "planets"),
    ("moon", "Moon photo", "One close-up of craters", [1], "Moon", "planets"),
    ("earth_space", "Earth from orbit", "Auroras, city lights, deserts (NASA)", "commons:earth_space", "Earth", "earth"),
    ("landscapes", "Landscapes", "Peaks, dunes, canyons", "commons:landscapes", "landscapes", "earth"),
    ("oceans", "Oceans", "Reefs, kelp forests, sea life", "commons:oceans", "oceans", "earth"),
    ("eyes", "Eyes", "Retina and cornea", [2, 3, 4], "eyes", "life"),
    ("tissue", "Cells & tissue", "Stained tissue under the microscope", [5, 6, 7], "tissue", "life"),
    ("glow", "Glowing cells", "Fluorescence microscopy", [8, 9, 10, 11, 12], "glowing cells", "life"),
    ("head", "Head scans", "Slices through a human head", [13, 14], "head scans", "life"),
    ("paintings", "Famous paintings", "Van Gogh, Hokusai, Monet, Klimt...", "commons:paintings", "paintings", "art"),
    ("science_illustration", "Science illustration", "Haeckel's sea creatures, Audubon", "commons:science_illustration", "science art", "art"),
    ("patterns", "Patterns", "William Morris and ornament", "commons:patterns", "patterns", "art"),
]

# Wikimedia Commons images get ids from here on, in the order of commons_picks.json
# (append only: share links refer to images by id).
COMMONS_FIRST_ID = 20
COMMONS_MAXSIDE = 640


def credit_text(fn_name):
    doc = getattr(d, fn_name).__doc__ or ""
    doc = doc.split("Returns")[0]
    doc = re.sub(r"\s+", " ", doc).strip()
    return doc[:600]


catalog = []
for img_id, stem, title, loader, fn_name in IMAGES:
    a = loader()
    a = to_u8(a) if a.dtype != np.uint8 else a
    im = Image.fromarray(a)
    if im.mode not in ("L", "RGB"):
        im = im.convert("RGB")
    if max(im.size) > MAXSIDE:
        f = MAXSIDE / max(im.size)
        im = im.resize((round(im.size[0] * f), round(im.size[1] * f)), Image.BOX)
    # big images ship as high-quality JPEG (same size, so share links stay valid), small ones as PNG
    fname = f"{stem}.jpg" if max(im.size) > 300 else f"{stem}.png"
    if fname.endswith(".jpg"):
        im.save(PACKS / fname, quality=90, optimize=True)
    else:
        im.save(PACKS / fname, optimize=True)
    th = im.convert("RGB")
    th.thumbnail((160, 160), Image.BOX)
    th.save(THUMBS / f"{stem}.jpg", quality=85)
    catalog.append(dict(id=img_id, file=fname, thumb=f"thumbs/{stem}.jpg", title=title,
                        width=im.size[0], height=im.size[1], gray=im.mode == "L", credit=credit_text(fn_name)))
    print(f"{img_id:2d} {stem:18s} {im.size} {im.mode}")

UA = {"User-Agent": "ePluribus-pack-builder/1.0 (https://github.com/davidackerman/ePluribus)"}


def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return r.read()


def zoomify_tile(base, back, center):
    """URL of the tile under `center` (full-res pixels), `back` tiers below the finest."""
    xml = fetch(base + "/ImageProperties.xml").decode()
    W, H, ts = (int(re.search(rf"""{k}\s*=\s*["'](\d+)["']""", xml, re.I).group(1)) for k in ("WIDTH", "HEIGHT", "TILESIZE"))
    tiers, f = [], 1
    while True:
        tiers.insert(0, (math.ceil(W / (ts * f)), math.ceil(H / (ts * f))))
        if W / f <= ts and H / f <= ts:
            break
        f *= 2
    cum = [0]
    for nx, ny in tiers:
        cum.append(cum[-1] + nx * ny)
    z = len(tiers) - 1 - back
    x, y = int(center[0] / 2 ** back // ts), int(center[1] / 2 ** back // ts)
    return f"{base}/TileGroup{(cum[z] + y * tiers[z][0] + x) // 256}/{z}-{x}-{y}.jpg"


maps = []
for m in MAPS:
    if m["kind"] == "xyz":
        z, x, y = m["thumb_tile"]
        url = m["url"].replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y))
    else:
        url = zoomify_tile(m["base"], m["thumb_back"], m["thumb_center"])
    th = Image.open(io.BytesIO(fetch(url))).convert("RGB")
    s = min(th.size)
    th = th.crop(((th.size[0] - s) // 2, (th.size[1] - s) // 2, (th.size[0] + s) // 2, (th.size[1] + s) // 2))
    th.resize((160, 160), Image.BOX).save(THUMBS / f"{m['key']}.jpg", quality=85)
    maps.append({k: v for k, v in m.items() if not k.startswith("thumb_")} | {"thumb": f"thumbs/{m['key']}.jpg"})
    print(f"{m['id']} {m['key']:18s} thumbnail from {url}")

# ---- reviewed Wikimedia Commons picks: public domain / CC0 only (checked again here)
def commons_info(titles):
    out = {}
    for i in range(0, len(titles), 40):
        q = urllib.parse.urlencode({"action": "query", "format": "json", "prop": "imageinfo", "iiprop": "url|extmetadata",
                                    "iiurlwidth": 1024, "titles": "|".join(titles[i:i + 40])})
        d = json.loads(fetch(f"https://commons.wikimedia.org/w/api.php?{q}"))
        for page in d["query"]["pages"].values():
            if "imageinfo" in page:
                out[page["title"]] = page["imageinfo"][0]
        time.sleep(0.5)
    return out


strip_html = lambda h: re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", h or "")).strip()
picks = json.load(open(Path(__file__).with_name("commons_picks.json")))
commons_ids, next_id = {}, COMMONS_FIRST_ID
for key, titles in picks.items():
    infos, commons_ids[key] = commons_info(titles), []
    for j, t in enumerate(titles):
        ii = infos[t]
        md = ii["extmetadata"]
        lic = strip_html(md.get("LicenseShortName", {}).get("value"))
        assert lic in ("Public domain", "CC0"), f"{t}: licence is now {lic!r}"
        im = Image.open(io.BytesIO(fetch(ii["thumburl"]))).convert("RGB")
        if max(im.size) > COMMONS_MAXSIDE:
            f = COMMONS_MAXSIDE / max(im.size)
            im = im.resize((round(im.size[0] * f), round(im.size[1] * f)), Image.LANCZOS)
        stem = f"{key}_{j}"
        im.save(PACKS / f"{stem}.jpg", quality=85, optimize=True)
        th = im.copy()
        th.thumbnail((160, 160), Image.BOX)
        th.save(THUMBS / f"{stem}.jpg", quality=85)
        name = strip_html(md.get("ObjectName", {}).get("value")) or t[5:].rsplit(".", 1)[0]
        artist = strip_html(md.get("Artist", {}).get("value"))[:100]
        catalog.append(dict(id=next_id, file=f"{stem}.jpg", thumb=f"thumbs/{stem}.jpg", title=name[:70],
                            width=im.size[0], height=im.size[1], gray=False,
                            credit=f"{artist + ': ' if artist else ''}{name}. {lic}, via Wikimedia Commons: {ii['descriptionurl']}"))
        commons_ids[key].append(next_id)
        next_id += 1
        time.sleep(0.25)
    print(f"commons {key}: ids {commons_ids[key][0]}-{commons_ids[key][-1]}")

ids = [c["id"] for c in catalog] + [m["id"] for m in maps]
assert len(ids) == len(set(ids)) and max(ids) < 256 and next_id <= 200, "image/map ids must be unique and fit in a byte"


def source(src):
    if isinstance(src, int):
        return {"map": src}
    if isinstance(src, str) and src.startswith("commons:"):
        return {"images": commons_ids[src[8:]]}
    return {"images": src}


packs = [dict(id=pid, name=name, blurb=blurb, family=fam, tab=tab, **source(src)) for pid, name, blurb, src, fam, tab in PACK_DEFS]
assert all(p["tab"] in dict(TABS) for p in packs)
json.dump(dict(images=catalog, maps=maps, packs=packs, tabs=[{"id": t, "name": n} for t, n in TABS]),
          open(PACKS / "packs.json", "w"), indent=1)

# sample target photos (both public domain / CC0 per scikit-image docs)
Image.fromarray(d.astronaut()).save(SAMPLES / "astronaut.jpg", quality=92)
Image.fromarray(d.chelsea()).save(SAMPLES / "cat.jpg", quality=92)
print("wrote", PACKS / "packs.json")
