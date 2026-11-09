# ePluribus: what are you made of?

**[Play it: davidackerman.github.io/ePluribus](https://davidackerman.github.io/ePluribus/)**

[![What are you made of? A face rebuilt from 300 real science images](web/og.png)](https://davidackerman.github.io/ePluribus/)

Turn a face into **300 real science images** (Martian craters, galaxies, retinas, stained
cells) stacked as light, then dare your friends to guess who it is.

- **Make one:** pick a face, pick your universe (live maps of the Moon and Mars, Hubble's
  Andromeda, Webb's Carina nebula, microscopy...), watch it assemble. You get a breakdown
  like *"37% tissue · 26% Moon · 13% Andromeda · 13% Mars · 11% eyes"*.
- **Dare a friend:** a short link replays the build from the strongest piece; they tap
  *I know who it is!* and get a score to beat. Or play the built-in round (a famous face).
- **Explore:** tap any of the 300 pieces to see what it adds - and, for map pieces, visit the
  exact spot on Mars or the Moon in [coresample](https://davidackerman.github.io/coresample/).
- **Share:** a GIF of the whole thing, a 512 px image, link previews.
- **Private by design:** everything runs in the browser; the photo is never uploaded, and
  share links carry only which public pieces to stack (encrypted, for short links).

How it works: every piece is a square crop of a science image stretched to cover the *whole*
frame. Pieces are chosen greedily (non-negative matching pursuit): each step adds the crop
that best fills in what's still missing, then re-solves every piece's brightness (weights
>= 0, like slide projectors on one screen). One black level per colour channel removes the
resulting glow. Each piece has a single brightness for the whole image - no masks.

## Run the web app

```sh
python3 -m http.server 8765 --directory web
# open http://127.0.0.1:8765/
```

It must be served over HTTP (module scripts and workers don't load from `file://`).
Everything runs in the browser: the photo is never uploaded.

## Live maps

Besides the bundled images, packs can be *live maps*: huge public image pyramids read tile by
tile from their hosts, as in [coresample](https://github.com/davidackerman/coresample)
(Moon LRO WAC mosaic via NASA Trek, Mars CTX mosaic via Esri, Hubble's Andromeda and Webb's
Carina via ESA's Zoomify archives). Each build fetches ~320 random tiles (random zoom, random
place; roughly 10-20 MB), turns each tile into a small source image, and cuts full-frame crops
from them - so every build uses different pieces, at every scale. Map specs live in
`tools/make_packs.py` (`MAPS`), and the readers in `web/maps.js`.

Privacy: tiles are picked at random, independent of the photo, and the final render uses the
tiles already in memory, so the hosts never learn which pieces were chosen. A friend opening
a share link must fetch the exact tiles it uses; their browser also fetches as many random
decoy tiles from each map, so a host's logs don't show only the picture's tiles.

## Sharing and privacy

A share link holds a *recipe*, not the photo: for each piece, which public image,
crop position/size, rotation, and brightness, plus the average colour (see
`encodeRecipe` in `web/core.js`). It lives after the `#`, which browsers don't send
to the server. Anyone with the link can rebuild the (blurry) picture - that's what
sharing means. Pictures made with the user's own source images can't be shared,
because the recipient doesn't have those images.

Share-link format: image ids in `web/packs/packs.json` are part of it, so never
renumber them - only append new images.

## Sharing, the GIF and the games

- **Short links** (`web/share.js`): the recipe is encrypted in the browser (AES-GCM, a fresh
  key per picture) and stored under a random id; the key rides in the link's `#fragment`,
  which browsers never send to servers, so the store can't read or rebuild any picture.
  Links look like `…/#s=k__Xww9g.Dv_IMHhnLLEA-QB2wKqsaA` (~56 characters). Without a store,
  links carry the whole recipe (`#r=…`, ~7,000 characters).
  - Store contract: `POST {store}/s` with the bytes (<= 64 KB) -> `{"id": "..."}`;
    `GET {store}/s/{id}` -> the bytes; CORS open. Set its URL in `web/config.js`.
  - Development store: `python tests/short_link_store.py` (port 8799, in memory); on
    localhost the page finds it by itself.
- **GIF** (360 x 440, ~1.2 MB): every image in a grid (strongest first, weak ones faint),
  then each added in turn - flashing over the picture, with the latest few in a strip - and
  a closing line of what the picture is made of ("32% Moon · 27% Mars · 25% tissue ...", by
  each family's share of brightness x contrast). Phones get the share sheet.
- **Every image, up close:** click any piece in the sheet: the full frame, its share of the
  picture, "show the picture without it", and for map pieces a link to that exact spot in
  [coresample](https://davidackerman.github.io/coresample/). Arrow keys step through them.
- **Guess who:** a shared link plays the build from the strongest image; "I know who it
  is!" records after how many images you could tell, and "Challenge a friend" passes it on.

## Layout

| Path | What |
|---|---|
| `web/core.js` | All the maths (resampling, candidate pool, scoring, weight solver, rendering, recipes). No DOM. |
| `web/worker.js` | Scoring worker: holds a slice of the candidate pool. |
| `web/share.js`, `web/config.js` | Short encrypted share links; deployment settings. |
| `web/maps.js` | Live-map readers (web-map tiles, Zoomify): random tiles, decoys. |
| `web/gif.js` | Small animated-GIF encoder (median-cut palette + LZW) for "Make a GIF". |
| `web/app.js`, `index.html`, `style.css` | The page. |
| `web/packs/` | Source images + `packs.json` (built by `tools/make_packs.py`). |
| `tools/make_packs.py` | Builds the packs from scikit-image sample data. |
| `tests/core_test.mjs` | Node test: fit quality vs the Python prototype, recipe round trip. |
| `tests/e2e.mjs` | Browser test (Playwright + system Chrome): build, share, replay. |
| `experiments/` | Python prototypes, GIF animation, colour and puzzle tests. |
| `superpose.py`, `collage.py`, `anim_*.py` | The original prototype scripts. |

## Tests

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python tests/dump_raw.py /tmp/ep_raw
node tests/core_test.mjs /tmp/ep_raw 3 10000 300

# browser test (needs Google Chrome, the site server and, for short links,
# python tests/short_link_store.py running)
npm install --no-save playwright-core@1.56.1
node tests/e2e.mjs http://127.0.0.1:8765/ /tmp/ep_shots
```

## Publishing (GitHub Pages)

`.github/workflows/pages.yml` pushes `web/` to the `gh-pages` branch on every change to
`web/` (as coresample does). To go live at https://davidackerman.github.io/ePluribus/:

```sh
gh repo edit davidackerman/ePluribus --visibility public --accept-visibility-change-consequences
gh api -X POST repos/davidackerman/ePluribus/pages -f "source[branch]=gh-pages" -f "source[path]=/"
```

Without a short-link store (`web/config.js`), the live site shares full-recipe links.

## Before publishing

- Check the licence of every bundled image and live map. The bundled images' `credit`
  fields come from scikit-image's docstrings. NASA images are generally public domain;
  ESA/Hubble and ESA/Webb images are CC BY 4.0 (credit required); check the Murray Lab/Esri
  terms for the Mars mosaic (the Murray Lab grants free use for all purposes with the credit
  "NASA/JPL/MSSS/The Murray Lab").
- Host it somewhere static (e.g. GitHub Pages). Short links also need a small store (see
  above); everything else is static.
