"""Build the web app's source-image packs from scikit-image's sample data.

Writes web/packs/<file>.png (max side 1024), web/packs/thumbs/<file>.jpg,
web/packs/packs.json, and sample target photos in web/samples/.

Image ids in packs.json are stable: share links refer to images by id, so
never renumber -- only append.

NOTE: credits come from scikit-image's docstrings. Check each image's licence
before publishing the site.

Usage: python tools/make_packs.py
"""
import hashlib, html, io, json, math, re, time, urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
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


def trek(body, layer, ext, max_zoom, **kw):
    """A NASA Trek map (equirectangular: 2 x 1 tiles of 256 at zoom 0). max_zoom: the deepest
    zoom with tiles, found by asking for them (the capabilities files don't say)."""
    return dict(kind="xyz", tileSize=256, maxZoom=max_zoom, width=256 * 2 ** (max_zoom + 1), height=256 * 2 ** max_zoom,
                url=f"https://trek.nasa.gov/tiles/{body}/EQ/{layer}/1.0.0/default/default028mm/{{z}}/{{y}}/{{x}}.{ext}", **kw)


def gibs(layer, date, level, ext, **kw):
    """A NASA GIBS Earth layer (web Mercator, 1 tile of 256 at zoom 0)."""
    return dict(kind="xyz", tileSize=256, maxZoom=level, width=256 * 2 ** level, height=256 * 2 ** level,
                url=f"https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/{layer}/default/{date}/GoogleMapsCompatible_Level{level}/{{z}}/{{y}}/{{x}}.{ext}", **kw)


GIBS_DAY = "2024-08-15"
MAPS += [
    dict(id=207, key="earth_day", name="Earth by day", family="Earth",
         credit="NASA Earth Observatory: Blue Marble Next Generation, via NASA GIBS",
         **gibs("BlueMarble_NextGeneration", "default", 8, "jpeg")),
    dict(id=208, key="earth_night", name="Earth at night", family="Earth",
         credit="NASA Earth Observatory/NOAA (Suomi NPP VIIRS): Black Marble 2016, via NASA GIBS",
         **gibs("VIIRS_Black_Marble", "2016-01-01", 8, "png")),
    dict(id=209, key="ocean_temp", name="Ocean temperatures", family="oceans", noDataBlack=True,  # land is blank
         credit=f"NASA JPL (GHRSST MUR): sea surface temperature on {GIBS_DAY}, via NASA GIBS",
         **gibs("GHRSST_L4_MUR_Sea_Surface_Temperature", GIBS_DAY, 7, "png")),
    dict(id=210, key="clouds", name="Clouds", family="Earth", noDataBlack=True,  # gaps between orbits are black
         credit=f"NASA/NOAA (Suomi NPP VIIRS): the whole Earth on {GIBS_DAY}, via NASA GIBS",
         **gibs("VIIRS_SNPP_CorrectedReflectance_TrueColor", GIBS_DAY, 9, "jpeg")),
    dict(id=211, key="mountains", name="Mountains in colour", family="landscapes", thumb_tile=(4, 11, 6),  # the Himalaya (colour shows at low zooms)
         credit="NASA/METI/AIST/Japan Spacesystems and the U.S./Japan ASTER Science Team: ASTER GDEM colour shaded relief, via NASA GIBS",
         **gibs("ASTER_GDEM_Color_Shaded_Relief", "default", 12, "jpeg")),
    dict(id=212, key="mercury", name="Mercury", family="Mercury",
         credit="NASA/Johns Hopkins APL/Carnegie Institution of Washington: MESSENGER MDIS enhanced-colour mosaic, via NASA Trek",
         **trek("Mercury", "Mercury_MESSENGER_MDIS_Basemap_EnhancedColor_Mosaic_Global_665m", "jpg", 7)),
    dict(id=216, key="moon_heights", name="Moon heights", family="Moon",
         credit="NASA/GSFC (LRO LOLA science team): colour shaded relief of the Moon, via NASA Trek",
         **trek("Moon", "LRO_LOLA_ClrShade_Global_128ppd_v04", "png", 5)),
]

# Live sets: one pack, many huge images (each item overrides the set's fields).
VOYAGER = "NASA/JPL/USGS: Voyager and Galileo SSI global mosaic of {}, via NASA Trek"
DAWN = "NASA/JPL-Caltech/UCLA/MPS/DLR/IDA: Dawn Framing Camera {}, via NASA Trek"
XYZ_SETS = [
    dict(id=213, key="jupiter_moons", name="Jupiter's moons", family="Jupiter's moons", items=[
        dict(name="Europa", family="Europa", noDataBlack=True, credit=VOYAGER.format("Europa"),
             **trek("Europa", "Europa_Voyager_GalileoSSI_global_mosaic_500m", "png", 5)),
        dict(name="Ganymede", family="Ganymede", noDataBlack=True, credit=VOYAGER.format("Ganymede"),
             **trek("Ganymede", "Ganymede_Voyager_GalileoSSI_global_mosaic_1km", "png", 5)),
        dict(name="Callisto", family="Callisto", noDataBlack=True, credit=VOYAGER.format("Callisto"),
             **trek("Callisto", "Callisto_Voyager_GalileoSSI_global_mosaic_1km", "png", 5)),
    ]),
    dict(id=214, key="small_worlds", name="Small worlds", family="small worlds", items=[
        dict(name="Vesta", family="Vesta", credit=DAWN.format("mosaic of Vesta"),
             **trek("Vesta", "Vesta_Dawn_FC_HAMO_Mosaic_Global_74ppd", "jpg", 6)),
        dict(name="Ceres", family="Ceres", credit=DAWN.format("colour shaded relief of Ceres (DLR)"),
             **trek("Ceres", "Ceres_Dawn_FC_HAMO_ClrShade_DLR_Global_60ppd_Oct2016", "jpg", 5)),
        dict(name="Phobos", family="Phobos", credit="NASA/JPL (Viking Orbiters), DLR: Phobos mosaic, via NASA Trek",
             **trek("Phobos", "Phobos_Viking_Mosaic_40ppd_DLRcontrol", "jpg", 5)),
    ]),
    dict(id=215, key="mars_colour", name="Mars in colour", family="Mars", items=[
        dict(name="Mars: Viking colour map", credit="NASA/JPL/USGS: Viking MDIM 2.1 colour mosaic of Mars, via NASA Trek",
             **trek("Mars", "Mars_Viking_MDIM21_ClrMosaic_global_232m", "jpg", 7)),
        dict(name="Mars: heights", credit="NASA/JPL/GSFC (MGS MOLA science team): colour shaded relief of Mars, via NASA Trek",
             **trek("Mars", "Mars_MGS_MOLA_ClrShade_merge_global_463m", "jpg", 7)),
    ]),
]


def tile_url(m, z, x, y):
    return m["url"].replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y))


def busiest_tile(m):
    """The most detailed of a few tiles at a low zoom: a map's thumbnail."""
    best = None
    z = next(z for z in range(m["maxZoom"] + 1) if math.ceil(m["width"] / 2 ** (m["maxZoom"] - z) / 256) >= 4)
    nx, ny = math.ceil(m["width"] / 2 ** (m["maxZoom"] - z) / 256), math.ceil(m["height"] / 2 ** (m["maxZoom"] - z) / 256)
    for y in range(ny // 4, ny - ny // 4):
        for x in range(0, nx, max(1, nx // 6)):
            b = fetch_ok(tile_url(m, z, x, y))
            if not b:
                continue
            a = np.asarray(Image.open(io.BytesIO(b)).convert("RGB"), dtype=float)
            score = a.std() * (a.sum(-1) > 8).mean()  # detail, minus blank space
            if best is None or score > best[0]:
                best = (score, b)
    return Image.open(io.BytesIO(best[1])).convert("RGB")


def em_thumb(it):
    """A slice of an EM volume, as the app cuts them (contrast stretched for the card): the
    most detailed of a few whole chunks near the middle of its coarsest scale."""
    sc = it["scales"][-2] if len(it["scales"]) > 1 else it["scales"][-1]  # organelles show at the next-coarsest
    grid = [math.ceil(a / c) for a, c in zip(sc["size"], sc["chunk"])]
    best = None
    for dx, dz in [(0, 0), (1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1)]:
        k = [min(max((g - 1) // 2 + d, 0), g - 1) for g, d in zip(grid, (dx, 0, dz))]
        lo = [c * kk for c, kk in zip(sc["chunk"], k)]
        hi = [min(a, l + c) for a, l, c in zip(sc["size"], lo, sc["chunk"])]
        if any(h - l < c for l, h, c in zip(lo, hi, sc["chunk"])):
            continue
        b = fetch_ok(f"{it['base']}/{sc['key']}/" + "_".join(f"{l + o}-{h + o}" for l, h, o in zip(lo, hi, sc["offset"])))
        if not b:
            continue
        X, Y, Z = (h - l for l, h in zip(lo, hi))
        v = np.asarray(Image.open(io.BytesIO(b)).convert("L")).reshape(Z, Y, X)
        for plane in (v[Z // 2], v[:, Y // 2, :]):
            p1, p99 = np.percentile(plane, [1, 99])
            g = np.abs(np.diff(plane.astype(float), axis=0)).mean() + np.abs(np.diff(plane.astype(float), axis=1)).mean()
            score = g / (plane.std() + 1)  # fine structure, not one big edge
            if p99 - p1 > 4 and (best is None or score * (p99 - p1) > best[0]):
                best = (score * (p99 - p1), np.clip((plane - p1) / (p99 - p1) * 255, 0, 255).astype(np.uint8))
    if best:
        it["_thumb_score"] = best[0]
    return Image.fromarray(best[1]).convert("RGB") if best else None


def save_thumb(im, name):
    s = min(im.size)
    im = im.crop(((im.size[0] - s) // 2, (im.size[1] - s) // 2, (im.size[0] + s) // 2, (im.size[1] + s) // 2))
    im.resize((160, 160), Image.BOX).save(THUMBS / f"{name}.jpg", quality=85)
    return f"thumbs/{name}.jpg"

# Tabs the packs are shown under.
TABS = [("space", "Space"), ("planets", "Planets"), ("earth", "Earth & nature"), ("life", "Life & medicine"), ("art", "Art")]

# (id, name, blurb, source, family, tab). source: a map id, a list of image ids, or
# "commons:<key>" for the reviewed Wikimedia Commons picks in tools/commons_picks.json.
# family is the short name used in "37% Mars".
PACK_DEFS = [
    ("andromeda", "Andromeda", "Hubble's 1.5-gigapixel galaxy", 202, "Andromeda", "space"),
    ("webb_carina", "Carina nebula", "Webb's 'Cosmic Cliffs'", 203, "Carina nebula", "space"),
    ("hubble", "Hubble's greatest hits", "The 100 favourites, at full size", 204, "Hubble", "space"),
    ("webb", "Webb's greatest hits", "Every big Webb picture so far", 205, "Webb", "space"),
    ("eso", "ESO's greatest hits", "Chile's giant telescopes: nebulae, galaxies, the Milky Way", 217, "ESO", "space"),
    ("nebulae", "Nebulae", "Crab, Helix, Orion, Pillars of Creation", "commons:nebulae", "nebulae", "space"),
    ("space", "Deep space", "Thousands of galaxies from Hubble", [0], "deep space", "space"),
    ("moon_map", "Moon: whole map", "Every crater, at any zoom (NASA LRO)", 200, "Moon", "planets"),
    ("mars_map", "Mars: whole map", "Craters, dunes, channels (CTX mosaic)", 201, "Mars", "planets"),
    ("planets", "Planets", "Jupiter, Saturn, Venus, Pluto, Earthrise", "commons:planets", "planets", "planets"),
    ("moon", "Moon photo", "One close-up of craters", [1], "Moon", "planets"),
    ("mercury", "Mercury", "MESSENGER's colour map", 212, "Mercury", "planets"),
    ("mars_colour", "Mars in colour", "Viking's colour map, and heights", 215, "Mars", "planets"),
    ("moon_heights", "Moon heights", "LRO's colour height map", 216, "Moon", "planets"),
    ("jupiter_moons", "Jupiter's moons", "Europa, Ganymede, Callisto", 213, "Jupiter's moons", "planets"),
    ("small_worlds", "Small worlds", "Vesta, Ceres, Phobos", 214, "small worlds", "planets"),
    ("earth_space", "Earth from orbit", "Auroras, city lights, deserts (NASA)", "commons:earth_space", "Earth", "earth"),
    ("earth_day", "Earth by day", "NASA's Blue Marble, any zoom", 207, "Earth", "earth"),
    ("earth_night", "Earth at night", "City lights from orbit", 208, "Earth", "earth"),
    ("clouds", "Clouds", "One day of the whole planet's weather", 210, "Earth", "earth"),
    ("ocean_temp", "Ocean temperatures", "One day of sea warmth, in colour", 209, "oceans", "earth"),
    ("mountains", "Mountains in colour", "Every peak's height (ASTER)", 211, "landscapes", "earth"),
    ("landscapes", "Landscapes", "Peaks, dunes, canyons", "commons:landscapes", "landscapes", "earth"),
    ("oceans", "Oceans", "Reefs, kelp forests, sea life", "commons:oceans", "oceans", "earth"),
    ("cells_em", "Inside cells", "Electron microscope volumes from Janelia (OpenOrganelle)", 206, "cells (EM)", "life"),
    ("eyes", "Eyes", "Retina and cornea", [2, 3, 4], "eyes", "life"),
    ("tissue", "Cells & tissue", "Stained tissue under the microscope", [5, 6, 7], "tissue", "life"),
    ("glow", "Glowing cells", "Fluorescence microscopy", [8, 9, 10, 11, 12], "glowing cells", "life"),
    ("head", "Head scans", "Slices through a human head", [13, 14], "head scans", "life"),
    ("paintings", "Famous paintings", "Van Gogh, Hokusai, Monet, Klimt...", "commons:paintings", "paintings", "art"),
    ("landscape_paintings", "Landscape paintings", "Moran, Bierstadt, Friedrich, Aivazovsky, Monet", 220, "landscape paintings", "art"),
    ("japanese_prints", "Japanese prints", "Hiroshige, Hasui, Koson", 218, "Japanese prints", "art"),
    ("nature_plates", "Nature plates", "Audubon's birds, Haeckel, Redouté's flowers", 219, "nature plates", "art"),
    ("abstract_art", "Abstract art", "Kandinsky, Hilma af Klint, ornament", 221, "abstract art", "art"),
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


CACHE = Path(__file__).with_name(".cache")  # downloaded metadata and tiles, so re-runs are quick


def fetch(url, cache=True):
    f = CACHE / hashlib.sha1(url.encode()).hexdigest()
    if cache and f.exists():
        return f.read_bytes()
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        b = r.read()
    if cache:
        CACHE.mkdir(exist_ok=True)
        f.write_bytes(b)
    return b


def fetch_ok(url):
    """fetch(), or None if the server says there is no such file."""
    miss = CACHE / (hashlib.sha1(url.encode()).hexdigest() + ".miss")
    if miss.exists():
        return None
    try:
        return fetch(url)
    except urllib.error.HTTPError as e:
        if e.code in (400, 403, 404):
            CACHE.mkdir(exist_ok=True)
            miss.touch()
            return None
        raise


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
    if m["kind"] == "xyz" and "thumb_tile" not in m:
        maps.append(m | {"thumb": save_thumb(busiest_tile(m), m["key"])})
        print(f"{m['id']} {m['key']:18s} thumbnail picked automatically")
        continue
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
        d = json.loads(fetch(f"https://commons.wikimedia.org/w/api.php?{q}", cache=False))  # licences: always fresh
        for page in d["query"]["pages"].values():
            if "imageinfo" in page:
                out[page["title"]] = page["imageinfo"][0]
        time.sleep(0.5)
    return out


strip_html = lambda h: html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", h or ""))).strip()


def object_name(h):
    """A Commons ObjectName as plain text: the English version when there are several, without
    the hidden Wikidata labels ("title QS:P1476,en:...") the page carries."""
    h = h or ""
    en = re.search(r'<div[^>]*lang="en"[^>]*>(.*?)</div>', h, re.S)
    if en:
        h = re.sub(r'<span class="language[^"]*"[^>]*>.*?</span>', "", en.group(1), flags=re.S)
    h = re.sub(r'<span[^>]*display:\s*none[^>]*>.*?</span>', "", h, flags=re.S)
    t = re.split(r"\s*(?:title|label) QS:", strip_html(h))[0]
    return re.sub(r"\s*-{2,}\s*", " \u2014 ", t).strip(" .,;")


def short_title(t, n=60):
    return t if len(t) <= n else t[: t.rfind(" ", 0, n - 1)].rstrip(" ,;:-") + "\u2026"


# names Commons gives no clean version of (by file title)
TITLE_FIXES = {
    "File:Tsunami by hokusai 19th century.jpg": "The Great Wave off Kanagawa",
    "File:Pieter Bruegel the Elder - Hunters in the Snow (Winter) - Google Art Project.jpg": "The Hunters in the Snow",
    "File:Georges Seurat - A Sunday on La Grande Jatte -- 1884 - Google Art Project.jpg": "A Sunday on La Grande Jatte",
    "File:The birds of America. (Livraison) 15, Plate 71, Winter Hawk, Male Adult ; Bull frog - estampe - Drawn from Nature and Published by John J. Audubon ; Engraved by R. Havell Jun.r, Printed & Coloured by R. Havell... - btv1b531440149.jpg": "Winter Hawk (Audubon, The Birds of America)",
    "File:Brooklyn Museum - Wallpaper Sample Book 1 - William Morris and Company - page062.jpg": "Pomegranate & Bird wallpaper (Morris & Co.)",
    "File:Iss072e068304 (Oct 13, 2024) --- The town and commune of In Ghar, with a population of over 11,000 in Algeria's portion of the Sahara Desert, is pictured from the International Space Station as it orbited 259 miles ab.jpg": "In Ghar, a town in the Algerian Sahara, from the ISS",
    "File:Iss072e095217 (Oct 20, 2024) --- The Niger River flows through the African nation of Mali near the Sahara Desert in this photograph from the International Space Station as it orbited 257 miles above.jpg": "The Niger River in Mali, from the ISS",
    "File:JunoCam - Cloud Swirls in North Equatorial Belt (40435258205).png": "Jupiter's cloud swirls (JunoCam)",
    "File:PIA21384 - Juno Captures Jupiter Cloudscape in High Resolution.jpg": "Jupiter's cloudscape (Juno)",
    "File:Hubble Goes High Def to Revisit the Iconic 'Pillars of Creation' (16189387096).jpg": "Pillars of Creation (Hubble)",
}
picks = json.load(open(Path(__file__).with_name("commons_picks.json")))
commons_ids, next_id = {}, COMMONS_FIRST_ID
for key, titles in picks.items():
    infos, commons_ids[key] = commons_info(titles), []
    for j, t in enumerate(titles):
        ii = infos[t]
        md = ii["extmetadata"]
        lic = strip_html(md.get("LicenseShortName", {}).get("value"))
        assert lic in ("Public domain", "CC0"), f"{t}: licence is now {lic!r}"
        stem = f"{key}_{j}"
        if (PACKS / f"{stem}.jpg").exists():  # already shipped: keep it byte for byte (share links crop it)
            im = Image.open(PACKS / f"{stem}.jpg").convert("RGB")
        else:
            im = Image.open(io.BytesIO(fetch(ii["thumburl"], cache=False))).convert("RGB")
            if max(im.size) > COMMONS_MAXSIDE:
                f = COMMONS_MAXSIDE / max(im.size)
                im = im.resize((round(im.size[0] * f), round(im.size[1] * f)), Image.LANCZOS)
            im.save(PACKS / f"{stem}.jpg", quality=85, optimize=True)
        if not (THUMBS / f"{stem}.jpg").exists():
            th = im.copy()
            th.thumbnail((160, 160), Image.BOX)
            th.save(THUMBS / f"{stem}.jpg", quality=85)
        name = TITLE_FIXES.get(t) or object_name(md.get("ObjectName", {}).get("value")) or t[5:].rsplit(".", 1)[0]
        artist = strip_html(md.get("Artist", {}).get("value"))[:100]
        catalog.append(dict(id=next_id, file=f"{stem}.jpg", thumb=f"thumbs/{stem}.jpg", title=short_title(name),
                            width=im.size[0], height=im.size[1], gray=False,
                            credit=f"{artist + ': ' if artist else ''}{name}. {lic}, via Wikimedia Commons: {ii['descriptionurl']}"))
        commons_ids[key].append(next_id)
        next_id += 1
    print(f"commons {key}: ids {commons_ids[key][0]}-{commons_ids[key][-1]}")


# ---- live sets of huge images
def zoomify_count(W, H, ts):
    """Tiles in a Zoomify pyramid, counted as web/maps.js counts them."""
    n, f = 0, 1
    while True:
        n += math.ceil(W / (ts * f)) * math.ceil(H / (ts * f))
        if W / f <= ts and H / f <= ts:
            return n
        f *= 2


def esa_items(site, ids, skip):
    """ESA/Hubble or ESA/Webb images that have zoomable tiles and are observations (not charts,
    collages or artwork), at least 1000 px on the short side."""
    site = ARCHIVES[site]

    def one(iid):
        base = site["base"].format(iid)
        xml = fetch_ok(base + "/ImageProperties.xml")
        if not xml:
            return None
        xml = xml.decode()
        W, H, ts = (int(re.search(rf"""{k}\s*=\s*["'](\d+)["']""", xml, re.I).group(1)) for k in ("WIDTH", "HEIGHT", "TILESIZE"))
        if min(W, H) < 1000 or zoomify_count(W, H, ts) != int(re.search(r"""NUMTILES\s*=\s*["'](\d+)""", xml, re.I).group(1)):
            return None  # too small, or laid out other than the reader expects
        page = site["page"].format(iid)
        h = fetch_ok(page)  # ESA's pages take 5-20 s each, hence the threads
        if not h:
            return None
        h = h.decode("utf-8", "replace")
        kind = re.search(r"Type:\s*(\w+)", re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", h)))
        if not kind or kind.group(1) != "Observation":
            return None
        title = strip_html(re.search(r"<h1[^>]*>(.*?)</h1>", h, re.S).group(1))
        credit = strip_html(re.search(r'class="credit">(.*?)</div>', h, re.S).group(1))
        return dict(name=short_title(title), base=base, width=W, height=H, tileSize=ts, page=page,
                    credit=f"{credit} (CC BY 4.0)", thumb_url=f"{base}/TileGroup0/0-0-0.jpg")

    with ThreadPoolExecutor(8) as pool:
        return [it for it in pool.map(one, [i for i in ids if i not in skip]) if it]


# ESA/Hubble, ESA/Webb and ESO run the same archive software: zoomable images, image pages
# with "Type: Observation" and a credit line, and a top-100 list
ARCHIVES = {
    "hubble": dict(page="https://esahubble.org/images/{}/", base="https://cdn.esahubble.org/archives/images/zoomable/{}",
                   top="https://esahubble.org/images/archive/top100/", ids=r'href="/images/([a-z]+\d+[a-z])/"'),
    "webb": dict(page="https://esawebb.org/images/{}/", base="https://cdn.esawebb.org/archives/images/zoomable/{}",
                 top="https://esawebb.org/images/archive/top100/", ids=r'href="/images/([a-z]+\d+[a-z])/"'),
    "eso": dict(page="https://www.eso.org/public/images/{}/", base="https://cdn.eso.org/images/zoomable/{}",
                top="https://www.eso.org/public/images/archive/top100/", ids=r'href="/public/images/([a-z][a-z0-9-]*\d[a-z0-9-]*)/"'),
}


def esa_top100(site):
    ids, a = [], ARCHIVES[site]
    for n in range(1, 6):
        b = fetch_ok(a["top"] + (f"page/{n}/" if n > 1 else ""))
        new = [i for i in re.findall(a["ids"], (b or b"").decode()) if i not in ids]
        if not new:
            break
        ids += new
    return ids


hubble = esa_items("hubble", esa_top100("hubble"), skip={"heic1502a"})[:100]  # the 100 favourites (Andromeda is a map of its own)
webb_ids = esa_top100("webb") + [f"weic{y}{n:02d}a" for y in (22, 23, 24, 25) for n in range(1, 41)]
webb = esa_items("webb", list(dict.fromkeys(webb_ids)), skip={"weic2205a"})  # so is Carina
eso = esa_items("eso", esa_top100("eso"), skip=set())[:150]
print(f"Hubble: {len(hubble)} images, Webb: {len(webb)} images, ESO: {len(eso)} images")

CELL_NAMES = {  # OpenOrganelle dataset -> what it is (different kinds first: the pack card shows three)
    "jrc_hela-2": "HeLa cell", "jrc_macrophage-2": "Macrophage (immune cell)", "jrc_jurkat-1": "Jurkat T cell",
    "jrc_sum159-1": "Breast cancer cell", "jrc_mus-pancreas-1": "Mouse pancreas", "jrc_choroid-plexus-2": "Choroid plexus (brain)",
    "jrc_cos7-11": "COS-7 cell", "jrc_ctl-id8-1": "Killer T cell meets a cancer cell", "jrc_fly-mb-1a": "Fly brain (mushroom body)",
    "jrc_dauer-larva": "Worm larva (C. elegans)", "jrc_mus-liver": "Mouse liver", "jrc_mus-kidney": "Mouse kidney",
    "jrc_hela-3": "HeLa cell 3", "jrc_hela-1": "HeLa cell 1", "jrc_hela-4": "HeLa cell 4", "jrc_hela-21": "HeLa cell 21",
    "jrc_hela-22": "HeLa cell 22",
}


def openorganelle_items():
    """EM volumes on OpenOrganelle that have a Neuroglancer copy in JPEG chunks (which a browser
    decodes by itself), at 8-64 nm per pixel: organelles up to whole cells."""
    bucket = "https://janelia-cosem-datasets.s3.amazonaws.com"
    listing = fetch(f"{bucket}/?list-type=2&delimiter=/").decode()
    items = []
    for ds in re.findall(r"<Prefix>([^<]+)/</Prefix>", listing):
        base = f"{bucket}/{ds}/neuroglancer/em/fibsem-uint8.precomputed"
        info = fetch_ok(base + "/info")
        if not info:
            continue
        info = json.loads(info)
        if info.get("data_type") != "uint8" or info.get("num_channels") != 1:
            continue
        scales = []
        for sc in info["scales"]:
            size, chunk, res = sc["size"], sc["chunk_sizes"][0], sc["resolution"]
            grid = sorted(math.ceil(a / c) for a, c in zip(size, chunk))
            if sc.get("encoding") == "jpeg" and "sharding" not in sc and 8 <= min(res) <= 64 and grid[1] >= 2:
                scales.append(dict(key=sc["key"], size=size, chunk=chunk, offset=sc.get("voxel_offset", [0, 0, 0]), res=res))
        if not scales:
            continue
        name = CELL_NAMES.get(ds) or re.sub(r"-\d+[a-z]?$", "", ds[4:]).replace("mus-", "mouse ").replace("-", " ")
        items.append(dict(name=name, base=base, scales=scales, res0=info["scales"][0]["resolution"], noDataBlack=True,
                          page=f"https://openorganelle.janelia.org/datasets/{ds}",
                          credit=f"Janelia Research Campus, COSEM Project Team: {ds} FIB-SEM volume, via OpenOrganelle (CC BY 4.0)",
                          **({"coresample": "hela"} if ds == "jrc_hela-2" else {})))
    order = list(CELL_NAMES)
    items.sort(key=lambda it: order.index(it["page"].rsplit("/", 1)[1]) if it["page"].rsplit("/", 1)[1] in order else 99)
    return items


def commons_api(**kw):
    q = urllib.parse.urlencode({"action": "query", "format": "json", **kw})
    return json.loads(fetch(f"https://commons.wikimedia.org/w/api.php?{q}"))


def commons_category_files(cat, depth):
    """File titles in a Commons category and its subcategories down to `depth`, in order."""
    files, seen, queue = [], set(), [(cat, 0)]
    while queue:
        c, d = queue.pop(0)
        if c in seen:
            continue
        seen.add(c)
        cont = {}
        while True:
            r = commons_api(list="categorymembers", cmtitle="Category:" + c, cmtype="file|subcat", cmlimit=500, **cont)
            for m in r["query"]["categorymembers"]:
                if m["ns"] == 6 and m["title"] not in files:
                    files.append(m["title"])
                elif m["ns"] == 14 and d < depth:
                    queue.append((m["title"][9:], d + 1))
            if "continue" not in r:
                break
            cont = {"cmcontinue": r["continue"]["cmcontinue"]}
    return files


# kept out of the art sets whatever their category says (safe for work)
NOT_SFW = re.compile(r"nud|naked|erotic|shunga|breast|bath|undress|venus|odalisque|leda|sex|nymph|bacchant|toilet", re.I)
# not the artwork itself: book-scan pages (Internet Archive / Flickr scans, text and title pages),
# stamps, photos of studios, exhibitions and libraries, magazine pages
NOT_ART = re.compile(r"\(\d{7,}\)\.\w+$|\bpage\b|\btext\b|title.page|stamp|\bCPA \d|MiNr|block of \d|atelier|studio|"
                     r"exposition|exhibition|grand.palais|installation|folios|library|museum, \w+ \d{4}|sign on|обозрени|"
                     r"drukproces|^File:Ohara Koson\.jpg$|^File:Hilma af klint \d+|Hilma af Klint - Eros\.|^(?!.*Tafel).*BHL\d+\.jpg$", re.I)


# individual files found on review that aren't the artwork (a gallery room, a signature, covers...)
SKIP_FILES = {
    "File:Pictorial envelope for Hokusai's 36 views of Mount Fuji series LCCN2008661023.jpg",
    "File:Haeckel Discomedusae 8 text2.JPG",
    "File:UA030-17.jpg",
    "File:Musée marmottant monet.jpg",
    "File:Fragment back sign.jpg",
    "File:USSR 1954-03-17 airmail cover.jpg",
    "File:Haeckel Discomedusae 8 text1.JPG",
    "File:Pictorial envelope for Hokusai's 36 views of Mount Fuji series LCCN2008661026.jpg",
    "File:NDL-DC 2586550-02 Kawase Hasui.jpg",
    "File:Print, illustrated book (BM 1859,0709.1920.1-100 1).jpg",
    "File:The grammar of ornament MET NK1510 J7 1868 Q 002.jpg",
}


def commons_items(cats):
    """Public-domain / CC0 images from Commons categories, as a live set's items: each is
    fetched by the browser as a 960 px thumbnail. cats: (category, depth, how many)."""
    per_cat = []
    for cat, depth, n in cats:
        titles = [t for t in commons_category_files(cat, depth) if not NOT_SFW.search(t) and not NOT_ART.search(t.replace("_", " "))]
        got = []
        batches, cur = [], []
        for t in titles:  # up to 50 titles a request, and short enough for a URL
            if cur and (len(cur) == 50 or len(urllib.parse.quote("|".join(cur + [t]))) > 6000):
                batches.append(cur)
                cur = []
            cur.append(t)
        batches += [cur] if cur else []
        for batch in batches:
            r = commons_api(prop="imageinfo|categories", titles="|".join(batch), iiprop="url|size|mime|extmetadata",
                            iiurlwidth=960, iiextmetadatafilter="LicenseShortName|Artist|ObjectName", clshow="!hidden", cllimit="max")
            for page in sorted(r["query"]["pages"].values(), key=lambda pg: pg["title"]):
                ii = (page.get("imageinfo") or [None])[0]
                if not ii or ii.get("mime") not in ("image/jpeg", "image/png", "image/tiff") or min(ii["width"], ii["height"]) < 800:
                    continue
                if max(ii["width"], ii["height"]) > 2 * min(ii["width"], ii["height"]):  # strips (triptychs, panoramas)
                    continue
                md = ii.get("extmetadata", {})
                lic = strip_html(md.get("LicenseShortName", {}).get("value"))
                if lic not in ("Public domain", "CC0") or any(NOT_SFW.search(c["title"]) for c in page.get("categories", [])):
                    continue
                name = object_name(md.get("ObjectName", {}).get("value")) or page["title"][5:].rsplit(".", 1)[0]
                if NOT_SFW.search(name) or "thumbwidth" not in ii:
                    continue
                artist = strip_html(md.get("Artist", {}).get("value"))[:80]
                got.append(dict(_title=page["title"], name=short_title(name), url=ii["thumburl"], width=ii["thumbwidth"], height=ii["thumbheight"],
                                page=ii["descriptionurl"], thumb_url=ii["thumburl"],
                                credit=f"{artist + ': ' if artist else ''}{short_title(name, 90)}. {lic}, via Wikimedia Commons"))
        step = max(1, len(got) / n)  # an even spread through the category, not just its first files
        # files rejected on review leave a gap (so the rest of the sample, already reviewed, stays put)
        per_cat.append([it for it in (got[int(k * step)] for k in range(min(n, len(got)))) if it.pop("_title") not in SKIP_FILES])
        print(f"  Commons {cat}: {len(got)} usable, {len(per_cat[-1])} taken")
    # interleave, so a set's first images (its pack card) come from different categories
    out = []
    for k in range(max(map(len, per_cat))):
        out += [c[k] for c in per_cat if k < len(c)]
    return out[:256]


COMMONS_SETS = [
    dict(id=218, key="japanese_prints", name="Japanese prints", family="Japanese prints", cats=[
        ("Ohara Koson", 0, 80), ("Kawase Hasui", 1, 70), ("One Hundred Famous Views of Edo", 1, 70), ("36 Views of Mount Fuji", 1, 36)]),
    dict(id=219, key="nature_plates", name="Nature plates", family="nature plates", cats=[
        ("The Birds of America", 0, 90), ("Kunstformen der Natur", 1, 90), ("Les liliacées", 1, 40), ("Les Roses (Redouté)", 0, 36)]),
    dict(id=220, key="landscape_paintings", name="Landscape paintings", family="landscape paintings", cats=[
        ("Paintings by Thomas Moran", 1, 60), ("Paintings by Albert Bierstadt", 1, 50), ("Paintings by Caspar David Friedrich", 1, 40),
        ("Paintings by Ivan Aivazovsky", 1, 50), ("Water Lilies by Claude Monet", 1, 50)]),
    dict(id=221, key="abstract_art", name="Abstract art", family="abstract art", cats=[
        ("Abstract paintings by Wassily Kandinsky", 1, 100), ("Paintings by Hilma af Klint", 1, 60), ("The Grammar of Ornament", 2, 90)]),
]
commons_sets = []
for cs in COMMONS_SETS:
    items = commons_items(cs.pop("cats"))
    print(f"Commons set {cs['key']}: {len(items)} images")
    commons_sets.append(cs | {"kind": "image", "items": items})

cells = openorganelle_items()
print(f"OpenOrganelle: {len(cells)} EM volumes: {', '.join(it['name'] for it in cells)}")

SETS = XYZ_SETS + [
    dict(id=204, key="hubble", name="Hubble's greatest hits", kind="zoomify", family="Hubble", items=hubble),
    dict(id=205, key="webb", name="Webb's greatest hits", kind="zoomify", family="Webb", items=webb),
    dict(id=206, key="cells_em", name="Inside cells", kind="precomputed", family="cells (EM)", items=cells),
    dict(id=217, key="eso", name="ESO's greatest hits", kind="zoomify", family="ESO", items=eso),
] + commons_sets
# Share links name a set's images by position: keep the images already shipped where they
# were (even ones gone from today's listing), and add new ones at the end.
try:
    _before = {m["key"]: m["items"] for m in json.load(open(PACKS / "packs.json"))["maps"] if "items" in m}
except (FileNotFoundError, KeyError, ValueError):
    _before = {}
for st in SETS:
    ident = lambda it: it.get("base") or it.get("url")
    fresh = {ident(it): it for it in st["items"]}
    old = _before.get(st["key"], [])
    ADDRESS = ("base", "url", "width", "height", "tileSize", "maxZoom", "scales", "res0")  # what share links depend on
    kept = [{**fresh.pop(ident(it), it), **{k: it[k] for k in ADDRESS if k in it}} for it in old]
    st["items"] = kept + [it for it in st["items"] if ident(it) in fresh]
for st in SETS:
    assert 0 < len(st["items"]) <= 256, st["key"]
    if "kind" not in st:
        st["kind"] = st["items"][0]["kind"]
    thumbs = []
    if st["kind"] == "precomputed":  # EM: the three clearest of the first six volumes
        cands = [(it, em_thumb(it)) for it in st["items"][:6]]
        cands = sorted((c for c in cands if c[1] is not None), key=lambda c: -c[0]["_thumb_score"])[:3]
        thumbs = [save_thumb(im, f"{st['key']}_{j}") for j, (_, im) in enumerate(cands)]
        for it in st["items"]:
            it.pop("_thumb_score", None)
    if st["kind"] == "image":  # pictures: the three most colourful of the first fifteen (Hasler-Suesstrunk)
        def colourful(im):
            a = np.asarray(im.resize((128, 128)), dtype=float)
            rg, yb = a[..., 0] - a[..., 1], (a[..., 0] + a[..., 1]) / 2 - a[..., 2]
            return math.hypot(rg.std(), yb.std()) + 0.3 * math.hypot(rg.mean(), yb.mean())
        cands = [Image.open(io.BytesIO(fetch(it["thumb_url"]))).convert("RGB") for it in st["items"][:15]]
        thumbs = [save_thumb(im, f"{st['key']}_{j}") for j, im in enumerate(sorted(cands, key=colourful, reverse=True)[:3])]
    for it in st["items"] if not thumbs else []:  # the first three images that have a thumbnail
        b = fetch_ok(it["thumb_url"]) if "thumb_url" in it else None
        im = (Image.open(io.BytesIO(b)).convert("RGB") if b else busiest_tile(it) if "url" in it
              else em_thumb(it) if "scales" in it else None)
        if im is not None:
            thumbs.append(save_thumb(im, f"{st['key']}_{len(thumbs)}"))
        if len(thumbs) == 3:
            break
    for it in st["items"]:
        it.pop("thumb_url", None)
        it.pop("kind", None)
    maps.append(st | {"thumb": thumbs[0], "thumbs": thumbs})
    print(f"{st['id']} {st['key']:18s} {len(st['items'])} items")

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
