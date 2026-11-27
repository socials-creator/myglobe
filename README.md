# MyGlobe — Interactive 3D Globe (lightweight build)

Touch-friendly 3D globe for phones and desktops. **No libraries, no build step** — plain HTML/CSS/JS.

## Why it's fast
- **One WebGL2 shader** draws the sphere (no three.js / globe.gl, ~2 MB of CDN code removed).
- Land fill is **baked once into a texture**; rotating costs the GPU almost nothing.
- Borders, graticule and labels are a thin **2D vector overlay** with 3 zoom-based levels of detail + culling.
- **Render-on-demand**: when the globe is paused and untouched, nothing runs (no battery drain).
- Country picking is a **point-in-polygon lookup**, not a 3D raycast.
- No `backdrop-filter` blur, no CSS filters, no endless animations over the canvas.
- **Adaptive quality**: if a device can't hold ~40 fps, render resolution drops automatically.
- Data shrank from 1.8 MB GeoJSON → 0.48 MB binary + 48 KB JSON.

## Files
- `index.html`, `style.css`, `app.js` — app
- `data/world.bin`, `data/countries.json` — compact map data (generated)
- `data/features.js` — oceans / seas / mountains / deserts / rivers / lakes label points
- `data/flags.js`, `flags/` — flag lookup + SVGs
- `data/facts.js` — quick facts per country (capital, population, languages, currency, time zones). Approximate ~2024 figures; edit freely
- `sw.js` — offline cache (stale-while-revalidate)
- `tools/build-data.py`, `tools/world.geojson` — regenerate the data: `python3 tools/build-data.py`

## Quick facts & local time
Selecting a country shows capital, population, area, density, currency, languages and live local time (all zones for multi-zone countries). The bar at the bottom shows the local time at the centre of the screen. Time comes from the browser's `Intl` API, so it works offline.
Border corrections live in `tools/build-data.py` (`BORDER_ADD` / `BORDER_REMOVE`).

## Deploy (GitHub Pages)
Upload everything keeping folders → Settings → Pages → branch `main`, `/ (root)`.

## Controls
Drag (inertia) · pinch / scroll / +− to zoom · double-tap zooms toward the tapped spot · tap a country to pin it (up to 7) ·
keyboard: arrows pan, +/− zoom, Esc clears.

## Satellite texture
Loaded on first use from `SATELLITE_TEXTURE_URL` at the top of `app.js` (unpkg blue-marble).
For the fastest/most reliable load, download that JPG into the repo and point the constant at it.
Requires **WebGL 2** (all current iOS/Android/desktop browsers).
