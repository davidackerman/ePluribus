# ePluribus: what are you made of?

**[Play it free in your browser: davidackerman.github.io/ePluribus](https://davidackerman.github.io/ePluribus/)**

[![What are you made of? A picture rebuilt from 300 real images](web/og.png)](https://davidackerman.github.io/ePluribus/)

ePluribus is a free online toy that rebuilds any picture (a face, a pet, a landmark) from
**300 real images** - craters on Mars and the Moon, galaxies and nebulae, retinas and stained
cells, Earth from orbit, and paintings like Van Gogh's *Starry Night*. It's **not a mosaic**:
instead of tiling small photos side by side, every image covers the *whole* picture, layered
like a 300-image multiple exposure (or 300 slide projectors on one screen). Then share it and
see if your friends can guess what it is.

- **Make one:** pick a picture (upload it, drag it onto the page or paste it), then pick your universe - 18 packs in five tabs (space,
  planets, Earth & nature, life & medicine, art), all on by default. Watch it assemble and get
  a breakdown like *"37% tissue · 26% Moon · 13% Andromeda · 13% Mars · 11% eyes"*.
- **Share it:** a share link replays the build image by image; your friend taps *I got it!*
  the moment they recognize it, and can share their score back. There's also a built-in round
  to try (a famous face).
- **Settings:** images to stack and color up front; under *Advanced settings*, how many
  candidates to search and two ways to make it harder: each piece must show at least a
  quarter / half / all of its image (no zooming into tiny details), and no turning or
  flipping. The defaults allow any crop, turned any way.
- **Explore:** drag the slider to add the pieces one by one - in the order the build picked
  them, or strongest first - and the pieces grid lights up to match; fade all the pieces by how
  much each one adds, or tap any piece to see it full
  size, the picture without it, and - for map pieces - the exact spot on Mars or the Moon in
  [coresample](https://davidackerman.github.io/coresample/).
- **Save and post:** an animated GIF (Share GIF / Download GIF), the picture exactly as shown
  (at however many images you've scrubbed to) as a 512 px image, and link previews for chats
  and social media.
- **Private by design:** everything runs in your browser. Your photo is never uploaded; share
  links carry only which public pieces to stack.

## How it works

Every piece is a square crop of a real image, stretched to cover the whole frame. Pieces are
chosen greedily (non-negative matching pursuit) from thousands of random candidates: each step
adds the crop whose pattern of light and dark best fills in what's still missing, then
re-solves every piece's brightness (weights >= 0, like slide projectors on one screen). A
black level - the same gray subtracted from every pixel - removes the resulting glow, so the
colors come only from the images. (Switch off *Color only from the images* to use one black
level per color channel instead, which also matches your photo's overall color, like a white
balance.) Each piece has a single brightness for the whole image - no masks, no per-pixel
tricks. "37% Moon" is each source's share of brightness x contrast.

The fit runs at 64 x 64 in parallel web workers (about 15 seconds for 300 images, including
downloads); the chosen crops are then re-cut at 256 px for display and 512 px for saving.

## Run it locally

```sh
python3 -m http.server 8765 --directory web
# open http://127.0.0.1:8765/
```

It must be served over HTTP (module scripts and workers don't load from `file://`).

## Image packs

`tools/make_packs.py` builds `web/packs/` (36 packs; about 8.0 MB bundled, the rest streamed) from three kinds of source:

- **scikit-image's science samples:** Hubble deep field, Moon, retina, cornea, tissue stains,
  fluorescent cells, head scans.
- **64 images from Wikimedia Commons**, listed in `tools/commons_picks.json`: famous
  paintings, science illustration (Haeckel, Audubon), patterns (William Morris, ornament),
  Earth from orbit, landscapes, oceans, planets, nebulae. They were reviewed by eye (safe for
  work; no duplicates, charts or photos of people), and the builder re-checks at build time
  that every one is still public domain or CC0.
- **Live sources** (below): 22 of them, 1304 images and maps in all.

Each build uses up to 4 random images per pack, so no two builds are alike and downloads stay
small. Image and map ids in `packs.json`, and the order of a live set's images, are part of the
share-link format: never renumber or reorder them, only append. `make_packs.py` keeps every
image it has already shipped byte for byte, and caches what it downloads in `tools/.cache/`.

### Live sources

Most of the images are never downloaded in advance: they're huge public image pyramids,
read tile by tile from their hosts (all of which allow it from a web page), as in
[coresample](https://github.com/davidackerman/coresample):

| Pack | Source |
| --- | --- |
| Moon, Mars, Mercury, Moon heights, Mars in color, Jupiter's moons (Europa, Ganymede, Callisto), small worlds (Vesta, Ceres, Phobos) | global mosaics via [NASA Trek](https://trek.nasa.gov) (Mars CTX via Esri) |
| Earth by day, Earth at night, Clouds, Ocean temperatures, Mountains in color | NASA [GIBS](https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api) Earth layers |
| Andromeda, Carina nebula, Hubble's greatest hits (100 images), Webb's greatest hits (206 images), ESO's greatest hits (56 images) | ESA/Hubble, ESA/Webb and ESO zoomable archives (CC BY 4.0) |
| Landscape paintings, Japanese prints, Nature plates, Abstract art (914 pictures) | Wikimedia Commons, streamed as 960 px thumbnails: public-domain files from hand-picked categories (Moran, Bierstadt, Friedrich, Aivazovsky, Monet's water lilies; Hiroshige, Hasui, Koson; Audubon, Haeckel, Redouté; Kandinsky, Hilma af Klint, Owen Jones), with keyword screens (safe for work; no book pages, stamps or photos of studios) and every picture checked by eye |
| Inside cells (9 electron-microscope volumes: HeLa, macrophage, Jurkat T cell, breast cancer cell, mouse pancreas, choroid plexus, more HeLa) | Janelia's [OpenOrganelle](https://openorganelle.janelia.org) (CC BY 4.0), the JPEG Neuroglancer copies |

Each build shares about 320 random tiles among the selected sources (random image of a set,
random zoom, random place), skips blank and no-data tiles, and cuts full-frame crops from
them, so every build uses different pieces at every scale. An electron-microscope tile is a
slice through the middle of one 96-voxel chunk, across x-y, x-z or y-z (one chunk gives
three). The specs are made by `tools/make_packs.py` (`MAPS`, `XYZ_SETS` and the ESA and
OpenOrganelle readers there, which keep only real observations and enough resolution); the
browser readers are in `web/maps.js`.

## Sharing and privacy

- **What a link holds:** a *recipe*, not the photo - for each piece, which public image (or
  map tile), crop position, size, rotation and brightness, plus the average color (see
  `encodeRecipe` in `web/core.js`), and whether the black level was shared or per channel.
  It lives after the `#`, which browsers don't send to the
  server. Anyone with the link can rebuild the (blurry) picture; that's what sharing means.
  Pictures made with your own source images can't be shared as links.
- **Link length:** a full link (`#r=...`) is about 7,000 characters. **Short links**
  (`#s=...`, about 56 characters) need a small store: the recipe is encrypted in the browser
  (AES-GCM, a fresh key per picture) and the key stays in the `#fragment`, so the store can't
  read any picture. The live site has no store yet, so it shares full links.
  - Store contract: `POST {store}/s` with the bytes (<= 64 KB) -> `{"id": "..."}`;
    `GET {store}/s/{id}` -> the bytes; CORS open. Set its URL in `web/config.js`.
  - Development store: `python tests/short_link_store.py` (port 8799, in memory); on
    localhost the page finds it by itself.
- **Counting:** `GOATCOUNTER` in `web/config.js` (currently `davidackerman`, shared with other
  projects; this one's events are named `epluribus/...`) counts visits and events
  (picture made, link shared/opened, GIF made, image saved, demo played, guessed) with
  [GoatCounter](https://www.goatcounter.com/): no cookies, no personal data. It sends only the
  page path, never the `#` part where recipes live (`web/stats.js`).
- **Map hosts:** tiles are picked at random, independent of the photo, and the final render
  uses tiles already in memory, so the hosts never learn which pieces were chosen. A friend
  opening a link must fetch its exact tiles; their browser also fetches as many random decoy
  tiles, so a host's logs don't show only the picture's tiles.

## The GIF

360 x 440, about 1.2 MB: every image in a grid (strongest first, weak ones faint), then each
added in turn - flashing over the picture, with the latest few in a strip - ending on the
picture and its mix ("32% Moon · 27% Mars · ..."). Every frame carries the site's address.
Share GIF appears where the device can share files; Download GIF works everywhere.

## Layout

| Path | What |
|---|---|
| `web/index.html`, `app.js`, `style.css` | The page. |
| `web/core.js` | The math: resampling, candidate pool, scoring, weight solver, rendering, recipes. No DOM. |
| `web/worker.js` | Scoring worker: holds a slice of the candidate pool. |
| `web/maps.js` | Live-map readers (web-map tiles, Zoomify): random tiles, decoys. |
| `web/share.js`, `web/stats.js`, `web/config.js` | Short encrypted share links; optional anonymous counts; deployment settings. |
| `web/gif.js` | Small animated-GIF encoder (median-cut palette + LZW). |
| `web/packs/` | Pack images, thumbnails and `packs.json` (built by `tools/make_packs.py`). |
| `web/samples/` | Sample pictures (Mona Lisa, astronaut, cat), the demo round's recipe and hero images. |
| `web/og.png` | Link-preview image. |
| `tools/make_packs.py` | Builds the packs: scikit-image samples, Wikimedia Commons picks, map thumbnails. |
| `tools/commons_picks.json` | The reviewed Wikimedia Commons images (append only). |
| `tools/make_demo.mjs` | Rebuilds the "Play a round" demo in the real app (needs Playwright). |
| `tests/core_test.mjs`, `tests/dump_raw.py` | Node test: fit quality vs the Python prototype, recipe round trip. |
| `tests/e2e.mjs` | Browser test (Playwright + system Chrome): build, share, replay, GIF, demo, phone layout. |
| `tests/short_link_store.py` | Development short-link store. |
| `.github/workflows/pages.yml` | Publishes `web/` to GitHub Pages. |
| `experiments/` | Python prototypes: full-frame fits, color, animation and puzzle tests. |
| `superpose.py`, `collage.py`, `anim_*.py` | The original prototype scripts. |

## Tests

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python tests/dump_raw.py /tmp/ep_raw
node tests/core_test.mjs /tmp/ep_raw 3 10000 300

# browser test (needs Google Chrome and the site server; for short links,
# python tests/short_link_store.py too). Uses the network for the live maps.
npm install --no-save playwright-core@1.56.1
node tests/e2e.mjs http://127.0.0.1:8765/ /tmp/ep_shots
```

## Publishing

The site is live at https://davidackerman.github.io/ePluribus/. `.github/workflows/pages.yml`
pushes `web/` to the `gh-pages` branch whenever `web/` changes (as coresample does), and
GitHub Pages serves that branch. On the way it stamps the commit on every module, the worker
and `packs.json` (`app.js?v=...`), because Pages' CDN keeps files for 10 minutes and a page
mixing two deploys' scripts would break.

## Credits and licenses

- **scikit-image sample data:** each image's credit is in `web/packs/packs.json`, from
  scikit-image's documentation.
- **NASA** images (Trek maps of the Moon, Mercury, Mars, Jupiter's moons, Vesta, Ceres and
  Phobos; GIBS Earth layers; astronaut photo, Earth from orbit, planets): public domain,
  credited in the app with the mission and team.
- **ESA/Hubble and ESA/Webb** (Andromeda, Carina nebula, both greatest-hits sets): CC BY 4.0,
  each image's own credit line shown in the app.
- **OpenOrganelle** (Janelia Research Campus, COSEM Project Team): CC BY 4.0, credited per
  volume.
- **ESO:** CC BY 4.0, each image's credit shown in the app.
- **Streamed Commons art:** public domain (checked per file when the packs are built), each
  credited with its artist and Commons page.
- **Mars CTX mosaic:** free for all uses with the credit "NASA/JPL/MSSS/The Murray Lab".
- **Wikimedia Commons picks:** public domain or CC0; each credit (artist, title, source page)
  is in `packs.json` and shown under every picture made with it.
- **Samples:** Mona Lisa (public domain), the astronaut (NASA, public domain), the cat
  (scikit-image, CC0).
