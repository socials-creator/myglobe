/* MyGlobe — lightweight globe renderer
   ------------------------------------------------------------------
   • No libraries. One WebGL2 fragment shader draws the whole sphere
     (ray-sphere intersection + a few textures), so rotation costs the GPU
     almost nothing and the CPU nothing.
   • Land fill is baked once into a texture. Borders, graticule and labels are
     a thin 2D vector overlay with zoom-based level of detail + culling.
   • Render-on-demand: when the globe isn't moving, nothing runs at all.
   • Country picking is a point-in-polygon test, not a scene raycast.            */
(() => {
  'use strict';

  /* ---------------- Config ---------------- */
  const SATELLITE_TEXTURE_URL = 'https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg';
  const DEG = Math.PI / 180;
  const TAN_HALF = Math.tan(25 * DEG);          // vertical FOV 50°, measured on the SHORT screen side
  const MIN_ALT = 0.012, MAX_ALT = 4.0;         // altitude = camera distance − 1 (globe radii)
  const TIER_FAR = 3.0, TIER_MID = 1.5;         // camera distance tiers for labels
  const ROTATE_SPEEDS = { '0.5': 2.1, '1': 4.2, '2': 8.4 };   // degrees / second
  const TURBO_SPEED = 210, TURBO_ALT = 2.4;
  const DEFAULT_CENTER = { lat: 23.48, lng: 80.12 };
  const MAX_SELECTED = 7;
  const MOBILE = matchMedia('(pointer: coarse)').matches;
  const FONT = 'Arial, Helvetica, sans-serif';

  const COLORS = {
    land: [48, 46, 51], highlight: '#F7F4EC', highlightSat: 'rgba(247,244,236,0.55)',
    edgeMap: 'rgba(244,241,234,0.34)', edgeSat: 'rgba(244,241,234,0.80)', select: '#E08363',
    grid: 'rgba(168,201,228,0.16)', gridStrong: 'rgba(212,228,242,0.24)',
    continent: '#E08363', ocean: '#9FDBFF', sea: '#82C4F2', country: '#F4F1EA',
    mountain: '#D4B27E', desert: '#E2BC80', river: '#8FDCF0', lake: '#8FDCF0',
  };

  const state = {
    mode: 'map', satLoaded: false, satLoading: false,
    layers: { countries: true, water: true, terrain: false, hydro: false },
    selected: [], countries: [], rings: [], lods: [],
    cam: { lat: DEFAULT_CENTER.lat, lng: DEFAULT_CENTER.lng, alt: 1.55 },
    targetAlt: 1.55, defaultAlt: 1.55,
    paused: false, rotateSpeed: '0.5', prevRotateSpeed: '0.5', baseRotate: ROTATE_SPEEDS['0.5'],
    turbo: false, userInteracted: false,
    satMix: 0, satMixTarget: 0, toyMix: 0, toyTarget: 0, hiA: 1, hiTarget: 1,
    W: 1, H: 1, dpr: 1, quality: 1, focal: 1, offY: 0, offYTarget: 0,
  };

  /* ---------------- DOM ---------------- */
  const $ = id => document.getElementById(id);
  const glCanvas = $('gl'), fx = $('fx'), ctx = fx.getContext('2d'), viz = $('globeViz');
  const starCanvas = $('stars'), centerMarker = $('globe-center-marker');

  function vw() { return window.visualViewport ? window.visualViewport.width : window.innerWidth; }
  function vh() { return window.visualViewport ? window.visualViewport.height : window.innerHeight; }

  /* ---------------- Small math helpers ---------------- */
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
  const easeInOutCubic = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const easeOutBack = t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
  function toVec(latDeg, lngDeg) {
    const la = latDeg * DEG, lo = lngDeg * DEG, cl = Math.cos(la);
    return [cl * Math.sin(lo), Math.sin(la), cl * Math.cos(lo)];
  }
  function normLng(l) { return ((l + 540) % 360) - 180; }

  /* ---------------- Camera basis (cached per frame) ---------------- */
  const basis = { e: [1, 0, 0], n: [0, 1, 0], c: [0, 0, 1], D: 2.5 };
  function updateBasis() {
    const la = state.cam.lat * DEG, lo = state.cam.lng * DEG;
    const sl = Math.sin(la), cl = Math.cos(la), so = Math.sin(lo), co = Math.cos(lo);
    basis.e = [co, 0, -so];
    basis.n = [-sl * so, cl, -sl * co];
    basis.c = [cl * so, sl, cl * co];
    basis.D = 1 + state.cam.alt;
  }
  // distance from the screen to the surface point under pixel (x,y) → unit vector or null
  function pickSphere(x, y) {
    const { e, n, c, D } = basis;
    const px = (x - state.W / 2) / state.focal, py = (y - state.H / 2 - state.offY) / state.focal;
    let dx = e[0] * px - n[0] * py - c[0], dy = e[1] * px - n[1] * py - c[1], dz = e[2] * px - n[2] * py - c[2];
    const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
    const ox = c[0] * D, oy = c[1] * D, oz = c[2] * D;
    const b = ox * dx + oy * dy + oz * dz, disc = b * b - (D * D - 1);
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    return [ox + dx * t, oy + dy * t, oz + dz * t];
  }
  const vecToLat = v => Math.asin(clamp(v[1], -1, 1)) / DEG;
  const vecToLng = v => Math.atan2(v[0], v[2]) / DEG;
  function pixelsPerDegree() { return (state.focal / Math.max(basis.D - 1, 1e-4)) * DEG; }

  /* ================================================================
     DATA: countries.json + world.bin  →  LOD vertex buffers
     ================================================================ */
  async function loadData() {
    const [meta, buf] = await Promise.all([
      fetch('data/countries.json').then(r => r.json()),
      fetch('data/world.bin').then(r => r.arrayBuffer()),
    ]);
    const n = new DataView(buf).getUint32(0, true);
    const raw = new Int16Array(buf, 4, 2 * n);              // lng*100, lat*100 pairs
    const lvl = new Uint8Array(buf, 4 + 4 * n, n);
    state.raw = raw;

    // Count vertices per LOD
    const counts = [0, 0, 0];
    for (let i = 0; i < n; i++) for (let l = lvl[i]; l < 3; l++) counts[l]++;
    state.lods = counts.map(c => ({ pos: new Float32Array(c * 3), seam: new Uint8Array(c), used: 0 }));

    const rings = [];
    meta.forEach((cty, ci) => {
      cty.i = ci;
      let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
      cty.rings = [];
      for (const [start, count] of cty.r) {
        const ring = { ci, start, count, off: [0, 0, 0], cnt: [0, 0, 0] };
        let sx = 0, sy = 0, sz = 0, bx0 = 1e9, by0 = 1e9, bx1 = -1e9, by1 = -1e9;
        for (let j = 0; j < count; j++) {
          const x = raw[2 * (start + j)], y = raw[2 * (start + j) + 1];
          if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
          const v = toVec(y / 100, x / 100); sx += v[0]; sy += v[1]; sz += v[2];
        }
        ring.bb = [bx0, by0, bx1, by1];
        const m = Math.hypot(sx, sy, sz) || 1; ring.cx = sx / m; ring.cy = sy / m; ring.cz = sz / m;
        let rad = 0;
        for (let j = 0; j < count; j++) {
          const v = toVec(raw[2 * (start + j) + 1] / 100, raw[2 * (start + j)] / 100);
          rad = Math.max(rad, Math.acos(clamp(v[0] * ring.cx + v[1] * ring.cy + v[2] * ring.cz, -1, 1)));
        }
        ring.rad = rad;
        // fill LOD buffers
        for (let l = 0; l < 3; l++) {
          const L = state.lods[l]; ring.off[l] = L.used; let k = 0, prevX = null;
          for (let j = 0; j < count; j++) {
            if (lvl[start + j] > l) continue;
            const x = raw[2 * (start + j)], y = raw[2 * (start + j) + 1];
            const v = toVec(y / 100, x / 100), o = (L.used + k) * 3;
            L.pos[o] = v[0]; L.pos[o + 1] = v[1]; L.pos[o + 2] = v[2];
            // an edge lying exactly on the ±180° cut line is an artefact, not a border
            if (k > 0 && prevX !== null && Math.abs(prevX) >= 17999 && Math.abs(x) >= 17999 && (prevX > 0) === (x > 0)) L.seam[L.used + k - 1] = 1;
            prevX = x; k++;
          }
          ring.cnt[l] = k >= 3 ? k : 0;
          L.used += k;
        }
        rings.push(ring); cty.rings.push(ring);
        minX = Math.min(minX, bx0); minY = Math.min(minY, by0); maxX = Math.max(maxX, bx1); maxY = Math.max(maxY, by1);
      }
      cty.fullbb = [minX, minY, maxX, maxY];
      cty.color = COLORS.land.map(v => v + (((ci * 2654435761) >>> 0) % 11) - 5);   // gentle per-country tone
    });
    state.countries = meta; state.rings = rings;

    // Labels: countries (anchors precomputed) + curated geographic features
    const list = [];
    meta.forEach(c => list.push({ name: c.n, lat: c.lat, lng: c.lng, cat: 'country', area: c.a, ci: c.i }));
    (typeof EARTH_FEATURES !== 'undefined' ? EARTH_FEATURES : []).forEach(f => list.push({ name: f.name, lat: f.lat, lng: f.lng, cat: f.category, area: 0 }));
    const prio = { continent: 9, ocean: 8, sea: 6, country: 5, mountain: 3, desert: 3, river: 2, lake: 2 };
    list.forEach((l, i) => { l.v = toVec(l.lat, l.lng); l.p = (prio[l.cat] || 1) * 1e12 + l.area - i * 1e-3; });
    list.sort((a, b) => b.p - a.p);
    state.labels = list;
    buildGraticule();
  }

  /* graticule polylines (vector, so it stays crisp at any zoom) */
  const grat = { lines: [] };
  function buildGraticule() {
    for (let lng = -180; lng < 180; lng += 30) {
      const pts = []; for (let lat = -90; lat <= 90; lat += 5) pts.push(...toVec(lat, lng));
      grat.lines.push({ pos: new Float32Array(pts), cnt: pts.length / 3, strong: lng === 0 });
    }
    for (let lat = -75; lat <= 75; lat += 15) {
      const pts = []; for (let lng = -180; lng <= 180; lng += 5) pts.push(...toVec(lat, lng));
      grat.lines.push({ pos: new Float32Array(pts), cnt: pts.length / 3, strong: lat === 0 });
    }
  }

  /* ================================================================
     PICKING (point in polygon, equirectangular, even-odd across rings)
     ================================================================ */
  function countryAt(lat, lng) {
    const x = lng * 100, y = lat * 100, raw = state.raw;
    for (const c of state.countries) {
      const f = c.fullbb;
      if (x < f[0] || x > f[2] || y < f[1] || y > f[3]) continue;
      let inside = false;
      for (const r of c.rings) {
        const b = r.bb;
        if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
        for (let i = r.start, j = r.start + r.count - 1, end = r.start + r.count; i < end; j = i++) {
          const xi = raw[2 * i], yi = raw[2 * i + 1], xj = raw[2 * j], yj = raw[2 * j + 1];
          if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
        }
      }
      if (inside) return c;
    }
    return null;
  }
  // forgiving pick: exact hit, else the nearest tiny territory within ~14px
  function pickCountry(px, py) {
    const P = pickSphere(px, py);
    if (!P) return null;
    const lat = vecToLat(P), lng = vecToLng(P);
    const hit = countryAt(lat, lng);
    if (hit) return hit;
    const tol = (14 / Math.max(pixelsPerDegree(), 1e-3)) * DEG;
    let best = null, bd = tol;
    for (const c of state.countries) {
      if (c.a > 20000) continue;
      const v = toVec(c.lat, c.lng), d = Math.acos(clamp(v[0] * P[0] + v[1] * P[1] + v[2] * P[2], -1, 1));
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  /* ================================================================
     WEBGL
     ================================================================ */
  let gl = null, prog = null, U = {}, tex = {}, maxTex = 4096, anisoExt = null, glReady = false;

  const VS = `#version 300 es
  void main(){ vec2 p = vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); gl_Position = vec4(p*2.0-1.0, 0.0, 1.0); }`;

  const FS = `#version 300 es
  precision highp float; precision highp sampler2D;
  uniform vec2 uRes; uniform float uOffY, uFocal, uD, uSatMix, uLandA, uHiA, uToyMix;
  uniform vec3 uE, uN, uC;
  uniform sampler2D uSat, uLand, uHi, uToy;
  out vec4 outColor;
  const vec3 ATM = vec3(0.851, 0.467, 0.341);
  const vec3 DEEP = vec3(0.047, 0.149, 0.282), MID = vec3(0.239, 0.482, 0.639);
  void main(){
    vec2 p = (vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) - 0.5*uRes - vec2(0.0, uOffY)) / uFocal;
    vec3 dir = normalize(uE*p.x - uN*p.y - uC);
    vec3 O = uC*uD;
    float b = dot(O, dir);
    float disc = b*b - (uD*uD - 1.0);
    float k = sqrt(max(disc, 0.0));
    vec3 P = normalize(O + dir*(-b - k));
    float h = sqrt(max(uD*uD - b*b, 0.0)) - 1.0;
    float cov = clamp(k / max(fwidth(k), 1e-6), 0.0, 1.0);

    float lat = asin(clamp(P.y, -1.0, 1.0));
    float u = atan(P.x, P.z) * 0.15915494 + 0.5;
    float v = 0.5 - lat * 0.31830989;
    // seam-safe texture gradients (atan jumps at the antimeridian)
    float u2 = fract(u + 0.5) - 0.5;
    vec2 gx1 = vec2(dFdx(u), dFdx(v)), gx2 = vec2(dFdx(u2), dFdx(v));
    vec2 gy1 = vec2(dFdy(u), dFdy(v)), gy2 = vec2(dFdy(u2), dFdy(v));
    vec2 gx = abs(gx1.x) < abs(gx2.x) ? gx1 : gx2;
    vec2 gy = abs(gy1.x) < abs(gy2.x) ? gy1 : gy2;
    vec2 uv = vec2(u, v);

    vec3 ocean = mix(DEEP, MID, 1.0 - abs(lat) * 0.6366198);
    vec3 col = ocean;
    if (uSatMix > 0.001) col = mix(col, textureGrad(uSat, uv, gx, gy).rgb, uSatMix);
    if (uLandA > 0.001) { vec4 l = textureGrad(uLand, uv, gx, gy); col = col*(1.0 - l.a*uLandA) + l.rgb*uLandA; }
    if (uHiA > 0.001)   { vec4 hh = textureGrad(uHi, uv, gx, gy);   col = col*(1.0 - hh.a*uHiA) + hh.rgb*uHiA; }
    if (uToyMix > 0.001) col = mix(col, textureGrad(uToy, uv, gx, gy).rgb, uToyMix);

    vec3 V = normalize(O - P);
    float ndv = clamp(dot(P, V), 0.0, 1.0);
    vec3 Nc = vec3(dot(P, uE), dot(P, uN), dot(P, uC));
    float lit = dot(Nc, normalize(vec3(-0.35, 0.5, 0.8)));
    col *= mix(0.80, 1.06, smoothstep(-0.3, 0.9, lit));
    col = mix(col, ATM, pow(1.0 - ndv, 3.0) * 0.30);

    float g = pow(clamp(1.0 - h / 0.2, 0.0, 1.0), 2.2) * 0.55;
    vec4 globe = vec4(col*cov, cov), glow = vec4(ATM*g, g);
    outColor = globe + glow*(1.0 - cov);
  }`;

  function compile(type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function uploadTexture(t, source, { premult = false } = {}) {
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premult);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (anisoExt) gl.texParameterf(gl.TEXTURE_2D, anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(4, gl.getParameter(anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  }
  function blankCanvas(w, h, fill) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    if (fill) { const g = c.getContext('2d'); g.fillStyle = fill; g.fillRect(0, 0, w, h); }
    return c;
  }

  function initGL() {
    gl = glCanvas.getContext('webgl2', { alpha: true, antialias: false, premultipliedAlpha: true, powerPreference: 'high-performance' });
    if (!gl) return false;
    maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    anisoExt = gl.getExtension('EXT_texture_filter_anisotropic');
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    U = {};
    ['uRes', 'uOffY', 'uFocal', 'uD', 'uSatMix', 'uLandA', 'uHiA', 'uToyMix', 'uE', 'uN', 'uC', 'uSat', 'uLand', 'uHi', 'uToy']
      .forEach(n => U[n] = gl.getUniformLocation(prog, n));
    ['uSat', 'uLand', 'uHi', 'uToy'].forEach((n, i) => gl.uniform1i(U[n], i));
    tex = { sat: gl.createTexture(), land: gl.createTexture(), hi: gl.createTexture(), toy: gl.createTexture() };
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    glReady = true;
    return true;
  }
  function bindTextures() {
    ['sat', 'land', 'hi', 'toy'].forEach((k, i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, tex[k]); });
  }

  /* ---- baked textures ---- */
  function tracePolys(g, list, W, H) {
    const raw = state.raw;
    g.beginPath();
    for (const c of list) for (const r of c.rings) {
      for (let j = 0; j < r.count; j++) {
        const x = (raw[2 * (r.start + j)] / 100 + 180) / 360 * W, y = (90 - raw[2 * (r.start + j) + 1] / 100) / 180 * H;
        j === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.closePath();
    }
  }
  function buildLandTexture() {
    const W = Math.min(4096, maxTex), H = W / 2, cv = blankCanvas(W, H), g = cv.getContext('2d');
    g.lineJoin = 'round'; g.lineWidth = 0.9 * W / 4096;
    for (const c of state.countries) {
      const col = `rgb(${c.color[0]},${c.color[1]},${c.color[2]})`;
      g.fillStyle = col; g.strokeStyle = col;
      tracePolys(g, [c], W, H); g.fill('evenodd'); g.stroke();   // stroke closes hairline gaps between neighbours
    }
    uploadTexture(tex.land, cv, { premult: true });
  }
  function buildHighlightTexture() {
    const W = 2048, H = 1024, cv = blankCanvas(W, H), g = cv.getContext('2d');
    if (state.selected.length) {
      g.fillStyle = state.mode === 'satellite' ? COLORS.highlightSat : COLORS.highlight;
      tracePolys(g, state.selected, W, H); g.fill('evenodd');
    }
    uploadTexture(tex.hi, cv, { premult: true });
  }
  function buildToyTexture() {
    const w = 128, h = 64, cv = blankCanvas(w, h), g = cv.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, '#1D66D6'); gr.addColorStop(0.5, '#2F8CF0'); gr.addColorStop(1, '#1D66D6');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    const blobs = [[.16, .40, .085], [.22, .27, .055], [.19, .60, .06], [.47, .26, .07], [.50, .40, .065], [.60, .58, .075], [.74, .30, .095], [.85, .42, .055], [.86, .66, .05]];
    g.fillStyle = '#57B653';
    blobs.forEach(([x, y, r]) => { g.beginPath(); g.ellipse(x * w, y * h, r * w, r * h * 0.85, 0, 0, Math.PI * 2); g.fill(); });
    uploadTexture(tex.toy, cv);
  }
  function loadSatellite() {
    if (state.satLoaded) return Promise.resolve();
    if (state.satPromise) return state.satPromise;
    state.satPromise = new Promise((resolve, reject) => {
      const img = new Image(); img.crossOrigin = 'anonymous';
      img.onload = () => {
        let src = img; const lim = Math.min(4096, maxTex);
        if (img.width > lim) { src = blankCanvas(lim, Math.round(img.height * lim / img.width)); src.getContext('2d').drawImage(img, 0, 0, src.width, src.height); }
        uploadTexture(tex.sat, src); state.satLoaded = true; resolve();
      };
      img.onerror = () => { state.satPromise = null; reject(new Error('satellite texture failed')); };
      img.src = SATELLITE_TEXTURE_URL;
    });
    return state.satPromise;
  }

  /* ================================================================
     SIZING
     ================================================================ */
  function resize() {
    const W = vw(), H = vh();
    state.W = W; state.H = H;
    state.dpr = Math.min(window.devicePixelRatio || 1, 2);
    state.focal = Math.min(W, H) / 2 / TAN_HALF;
    // distance at which the globe fills ~92% of the short side
    const ang = Math.atan(0.92 * TAN_HALF);
    state.defaultAlt = clamp(1 / Math.sin(ang) - 1, 1.2, 3.5);
    applyCanvasSize();
    drawStars();
    wake();
  }
  function applyCanvasSize() {
    const { W, H, dpr, quality } = state;
    fx.width = Math.round(W * dpr); fx.height = Math.round(H * dpr);
    glCanvas.width = Math.round(W * dpr * quality); glCanvas.height = Math.round(H * dpr * quality);
    if (gl) gl.viewport(0, 0, glCanvas.width, glCanvas.height);
  }
  function drawStars() {          // static — drawn once per resize, zero per-frame cost
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5), W = vw(), H = vh();
    starCanvas.width = W * dpr; starCanvas.height = H * dpr;
    const g = starCanvas.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#F4F1EA';
    const count = Math.min(120, Math.round(W * H / (MOBILE ? 6500 : 4800)));
    let seed = 1234567;                                  // deterministic: stars don't jump on resize
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < count; i++) {
      g.globalAlpha = rnd() * 0.5 + 0.15;
      g.beginPath(); g.arc(rnd() * W, rnd() * H, rnd() * 1.1 + 0.15, 0, 6.2832); g.fill();
    }
  }

  /* ================================================================
     RENDER
     ================================================================ */
  function renderGL() {
    updateBasis();
    gl.clear(gl.COLOR_BUFFER_BIT);
    bindTextures();
    gl.uniform2f(U.uRes, glCanvas.width, glCanvas.height);
    gl.uniform1f(U.uOffY, state.offY * glCanvas.width / state.W);
    gl.uniform1f(U.uFocal, state.focal * glCanvas.width / state.W);
    gl.uniform1f(U.uD, basis.D);
    gl.uniform3fv(U.uE, basis.e); gl.uniform3fv(U.uN, basis.n); gl.uniform3fv(U.uC, basis.c);
    gl.uniform1f(U.uSatMix, state.satMix);
    gl.uniform1f(U.uLandA, (1 - state.satMix) * (1 - state.toyMix));
    gl.uniform1f(U.uHiA, state.hiA * (1 - state.toyMix));
    gl.uniform1f(U.uToyMix, state.toyMix);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // Appends one polyline / ring to the current 2D path. Hidden (far-side) vertices break the line.
  function addPath(pos, base, cnt, seam, ov) {
    const { c0, c1, c2, e0, e1, e2, n0, n1, n2, thr, D, focal, hx, hy, lim } = ov;
    let pen = false;
    for (let j = 0; j < cnt; j++) {
      const i = (base + j) * 3, x = pos[i], y = pos[i + 1], z = pos[i + 2];
      const dc = x * c0 + y * c1 + z * c2;
      if (dc > thr) {
        const dep = D - dc;
        const sx = hx + focal * (x * e0 + y * e1 + z * e2) / dep, sy = hy - focal * (x * n0 + y * n1 + z * n2) / dep;
        if (sx > -lim && sx < ov.W + lim && sy > -lim && sy < ov.H + lim) {
          pen ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); pen = true;
        } else pen = false;
      } else pen = false;
      if (seam && seam[base + j]) pen = false;
    }
  }

  const textW = new Map();
  function measure(font, text) {
    const k = font + text; let w = textW.get(k);
    if (w === undefined) { ctx.font = font; w = ctx.measureText(text).width; textW.set(k, w); }
    return w;
  }
  const LABEL_STYLE = {
    continent: { size: 16, font: '600', color: COLORS.continent, upper: true, ls: 3 },
    ocean: { size: 13, font: 'italic 500', color: COLORS.ocean, ls: 1.5 },
    sea: { size: 11.5, font: 'italic 400', color: COLORS.sea },
    country: { size: 11.5, font: '500', color: COLORS.country },
    mountain: { size: 11, font: '400', color: COLORS.mountain }, desert: { size: 11, font: 'italic 400', color: COLORS.desert },
    river: { size: 10.5, font: 'italic 400', color: COLORS.river }, lake: { size: 10.5, font: 'italic 400', color: COLORS.lake },
  };
  function labelVisible(l, tier) {
    switch (l.cat) {
      case 'continent': return state.layers.countries;
      case 'ocean': return state.layers.water;
      case 'sea': return state.layers.water && tier !== 'far';
      case 'country': return state.layers.countries && (tier === 'near' || (tier === 'mid' && l.area > 60000));
      case 'mountain': case 'desert': return state.layers.terrain && tier === 'near';
      case 'river': case 'lake': return state.layers.hydro && tier === 'near';
    }
    return false;
  }

  function renderOverlay() {
    const { W, H, dpr, focal } = state;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!state.world || state.toyMix > 0.5) return;
    const { e, n, c, D } = basis, thr = 1 / D;
    const ov = { c0: c[0], c1: c[1], c2: c[2], e0: e[0], e1: e[1], e2: e[2], n0: n[0], n1: n[1], n2: n[2], thr, D, focal, hx: W / 2, hy: H / 2 + state.offY, W, H, lim: 3 * Math.max(W, H) };

    // visible cap: smaller of horizon and what the screen can actually see
    const phi = Math.atan(0.5 * Math.hypot(W, H) / focal), horizon = Math.acos(thr);
    let lo = 0, hi = horizon;
    if (Math.atan(Math.sin(hi) / (D - Math.cos(hi))) > phi) { for (let i = 0; i < 14; i++) { const m = (lo + hi) / 2; (Math.atan(Math.sin(m) / (D - Math.cos(m))) > phi) ? hi = m : lo = m; } }
    const cull = hi + 0.02;

    const ppd = pixelsPerDegree(), lod = ppd < 5 ? 0 : ppd < 18 ? 1 : 2;
    const sat = state.satMix > 0.5;

    // graticule (map style only)
    if (state.satMix < 0.99) {
      ctx.globalAlpha = 1 - state.satMix; ctx.lineWidth = 1;
      for (const strong of [false, true]) {
        ctx.beginPath(); ctx.strokeStyle = strong ? COLORS.gridStrong : COLORS.grid;
        for (const l of grat.lines) if (l.strong === strong) addPath(l.pos, 0, l.cnt, null, ov);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // borders
    const L = state.lods[lod];
    const selIdx = new Set(state.selected.map(s => s.i));
    ctx.lineJoin = 'round'; ctx.lineWidth = sat ? 0.9 : 0.8; ctx.strokeStyle = sat ? COLORS.edgeSat : COLORS.edgeMap;
    ctx.beginPath();
    for (const r of state.rings) {
      const cnt = r.cnt[lod]; if (!cnt) continue;
      const ang = Math.acos(Math.min(1, r.cx * c[0] + r.cy * c[1] + r.cz * c[2]));
      if (ang - r.rad > cull) continue;
      addPath(L.pos, r.off[lod], cnt, L.seam, ov);
    }
    ctx.stroke();
    if (selIdx.size) {
      ctx.lineWidth = 2; ctx.strokeStyle = COLORS.select; ctx.beginPath();
      for (const r of state.rings) {
        if (!selIdx.has(r.ci)) continue;
        const cnt = r.cnt[lod]; if (!cnt) continue;
        addPath(L.pos, r.off[lod], cnt, L.seam, ov);
      }
      ctx.stroke();
    }

    drawLabels(ov, selIdx);
  }

  function drawLabels(ov, selIdx) {
    const { W, H, focal } = state, D = basis.D, tier = D > TIER_FAR ? 'far' : D > TIER_MID ? 'mid' : 'near';
    const placed = [];
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    const hasLS = 'letterSpacing' in ctx;
    let drawn = 0;
    const tryLabel = (l, force) => {
      const dc = l.v[0] * ov.c0 + l.v[1] * ov.c1 + l.v[2] * ov.c2;
      if (dc < ov.thr + 0.03) return;
      const dep = D - dc, sx = W / 2 + focal * (l.v[0] * ov.e0 + l.v[1] * ov.e1 + l.v[2] * ov.e2) / dep, sy = H / 2 + state.offY - focal * (l.v[0] * ov.n0 + l.v[1] * ov.n1 + l.v[2] * ov.n2) / dep;
      if (sx < -40 || sx > W + 40 || sy < -20 || sy > H + 20) return;
      const st = LABEL_STYLE[l.cat];
      let size = st.size; if (l.cat === 'country') size = l.area > 3e6 ? 13 : l.area > 3e5 ? 11.5 : 10.5;
      const text = st.upper ? l.name.toUpperCase() : l.name;
      const font = `${st.font} ${size}px ${FONT}`;
      const w = measure(font, text) + (st.ls ? st.ls * text.length : 0), h = size + 2;
      const x0 = sx - w / 2 - 3, y0 = sy - h / 2 - 1, x1 = sx + w / 2 + 3, y1 = sy + h / 2 + 1;
      if (!force) for (const p of placed) if (x0 < p[2] && x1 > p[0] && y0 < p[3] && y1 > p[1]) return;
      placed.push([x0, y0, x1, y1]);
      const facing = clamp((dc - ov.thr) / 0.22, 0, 1);
      ctx.globalAlpha = 0.25 + 0.75 * facing;
      ctx.font = font; if (hasLS) ctx.letterSpacing = (st.ls || 0) + 'px';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(14,12,10,0.72)'; ctx.strokeText(text, sx, sy);
      ctx.fillStyle = force ? '#FFFFFF' : st.color; ctx.fillText(text, sx, sy);
      drawn++;
    };
    for (const l of state.labels) if (l.cat === 'country' && selIdx.has(l.ci)) tryLabel(l, true);
    for (const l of state.labels) {
      if (drawn > 90) break;
      if (l.cat === 'country' && selIdx.has(l.ci)) continue;
      if (labelVisible(l, tier)) tryLabel(l, false);
    }
    ctx.globalAlpha = 1; if (hasLS) ctx.letterSpacing = '0px';
  }

  /* ================================================================
     FRAME LOOP — runs only while something is changing
     ================================================================ */
  let running = false, lastT = 0, dragging = false, anim = null, inertia = null, rotAnim = null;
  let slowFrames = 0, slowAcc = 0, lastCoordT = 0, coordDirty = true;

  function wake() { if (!running && glReady && state.world) { running = true; lastT = 0; requestAnimationFrame(frame); } }

  function frame(t) {
    const dt = lastT ? Math.min((t - lastT) / 1000, 0.1) : 1 / 60; lastT = t;
    let active = false;
    const cam = state.cam;

    if (anim) {
      const p = clamp((t - anim.t0) / anim.ms, 0, 1), k = anim.ease(p);
      cam.lat = anim.lat0 + (anim.lat1 - anim.lat0) * k;
      cam.lng = normLng(anim.lng0 + anim.dl * k);
      cam.alt = anim.alt0 * Math.pow(anim.alt1 / anim.alt0, k);
      state.targetAlt = cam.alt;
      if (p >= 1) { anim = null; saveViewSoon(); } else active = true;
      coordDirty = true;
    } else {
      if (inertia) {
        cam.lat = clamp(cam.lat + inertia.vlat * dt, -88, 88);
        cam.lng = normLng(cam.lng + inertia.vlng * dt);
        const f = Math.exp(-dt * 4.5); inertia.vlat *= f; inertia.vlng *= f;
        if (Math.hypot(inertia.vlat, inertia.vlng) < 0.4) { inertia = null; saveViewSoon(); } else active = true;
        coordDirty = true;
      }
      const dz = Math.log(state.targetAlt / cam.alt);
      if (Math.abs(dz) > 5e-4) { cam.alt *= Math.exp(dz * (1 - Math.exp(-dt * 13))); active = true; coordDirty = true; }
      else if (dz !== 0) { cam.alt = state.targetAlt; }
      if (!dragging && !state.paused && state.baseRotate > 0.001) {
        cam.lng = normLng(cam.lng - state.baseRotate * dt); active = true; coordDirty = true;
      }
    }
    if (rotAnim) {
      const p = clamp((t - rotAnim.t0) / rotAnim.ms, 0, 1);
      state.baseRotate = rotAnim.from + (rotAnim.to - rotAnim.from) * rotAnim.ease(p);
      if (p >= 1) { const cb = rotAnim.done; rotAnim = null; cb && cb(); } else active = true;
    }
    const approach = (key, target, rate) => {
      const d = target - state[key];
      if (Math.abs(d) > 0.002) { state[key] += d * (1 - Math.exp(-dt * rate)); active = true; } else state[key] = target;
    };
    approach('satMix', state.satMixTarget, 11);
    approach('toyMix', state.toyTarget, 9);
    approach('hiA', state.hiTarget, 12);
    { const d = state.offYTarget - state.offY;
      if (Math.abs(d) > 0.3) { state.offY += d * (1 - Math.exp(-dt * 9)); active = true; } else state.offY = state.offYTarget;
      if (centerMarker.dataset.y !== String(Math.round(state.offY))) { centerMarker.dataset.y = String(Math.round(state.offY)); centerMarker.style.transform = `translate(-50%,calc(-50% + ${state.offY.toFixed(1)}px))`; } }
    if (dragging) active = true;

    cam.alt = clamp(cam.alt, MIN_ALT, MAX_ALT);
    renderGL();
    renderOverlay();

    if (t - lastCoordT > 140 && coordDirty) { lastCoordT = t; coordDirty = false; updateCoords(); }

    // adaptive quality: if a phone can't hold ~40fps, quietly lower the GL resolution
    if (active && dt < 0.09) {
      slowAcc += dt; slowFrames++;
      if (slowFrames >= 45) {
        const avg = slowAcc / slowFrames, minQ = Math.min(1, 1 / state.dpr) + 0.001;
        if (avg > 0.026 && state.quality > minQ) { state.quality = Math.max(minQ, state.quality - 0.15); applyCanvasSize(); }
        slowFrames = 0; slowAcc = 0;
      }
    } else if (!active) { slowFrames = 0; slowAcc = 0; }

    if (active) requestAnimationFrame(frame);
    else { running = false; updateCoords(); }
  }

  /* ---------------- Camera animation ---------------- */
  function flyTo(lat, lng, alt, ms = 900, ease = easeInOutCubic) {
    inertia = null;
    alt = clamp(alt, MIN_ALT, MAX_ALT);
    const cam = state.cam;
    anim = { t0: performance.now(), ms, ease, lat0: cam.lat, lng0: cam.lng, lat1: clamp(lat, -88, 88),
             dl: normLng(lng - cam.lng), alt0: cam.alt, alt1: alt };
    state.targetAlt = alt;
    lastT = 0; wake();
    // t0 uses performance.now(); rAF timestamps share the same origin
  }
  function zoomBy(f) { anim = null; state.targetAlt = clamp(state.targetAlt * f, MIN_ALT, MAX_ALT); wake(); }

  /* ================================================================
     INTERACTION
     ================================================================ */
  const pointers = new Map();
  let grab = null, pinch = null, gestureStart = null, lastTap = { t: 0, x: 0, y: 0 }, samples = [];

  function onDown(e) {
    viz.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    anim = null; inertia = null;
    if (!state.userInteracted) firstInteraction();
    if (pointers.size === 1) {
      updateBasis();
      dragging = true; viz.classList.add('dragging');
      grab = pickSphere(e.clientX, e.clientY);
      gestureStart = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false, multi: false };
      samples = [{ t: performance.now(), lat: state.cam.lat, lng: state.cam.lng }];
      wake();
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), alt: state.cam.alt };
      if (gestureStart) gestureStart.multi = true;
      grab = null;
    }
  }
  function onMove(e) {
    const p = pointers.get(e.pointerId);
    if (!p) {
      if (e.pointerType === 'mouse') hoverCursor(e.clientX, e.clientY);
      return;
    }
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pointers.size >= 2 && pinch) {
      const [a, b] = [...pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      state.cam.alt = state.targetAlt = clamp(pinch.alt * pinch.d / d, MIN_ALT, MAX_ALT);
      coordDirty = true; wake(); return;
    }
    if (!gestureStart) return;
    if (!gestureStart.moved && Math.hypot(e.clientX - gestureStart.x, e.clientY - gestureStart.y) > 8) gestureStart.moved = true;
    if (!gestureStart.moved) return;
    updateBasis();
    const P1 = pickSphere(e.clientX, e.clientY);
    const cam = state.cam;
    if (grab && P1) {
      // rotate the camera so the surface point that was grabbed stays under the finger
      let ax = P1[1] * grab[2] - P1[2] * grab[1], ay = P1[2] * grab[0] - P1[0] * grab[2], az = P1[0] * grab[1] - P1[1] * grab[0];
      const s = Math.hypot(ax, ay, az), cd = P1[0] * grab[0] + P1[1] * grab[1] + P1[2] * grab[2];
      if (s > 1e-9) {
        ax /= s; ay /= s; az /= s;
        const ang = Math.atan2(s, cd), ca = Math.cos(ang), sa = Math.sin(ang), c = basis.c;
        const dot = ax * c[0] + ay * c[1] + az * c[2];
        const cr = [ay * c[2] - az * c[1], az * c[0] - ax * c[2], ax * c[1] - ay * c[0]];
        const v = [c[0] * ca + cr[0] * sa + ax * dot * (1 - ca), c[1] * ca + cr[1] * sa + ay * dot * (1 - ca), c[2] * ca + cr[2] * sa + az * dot * (1 - ca)];
        cam.lat = clamp(vecToLat(v), -88, 88); cam.lng = vecToLng(v);
      }
    } else {
      const k = 1 / Math.max(pixelsPerDegree(), 0.3);        // off-globe fallback
      cam.lng = normLng(cam.lng - dx * k); cam.lat = clamp(cam.lat + dy * k, -88, 88);
    }
    const now = performance.now();
    samples.push({ t: now, lat: cam.lat, lng: cam.lng });
    while (samples.length > 2 && now - samples[0].t > 100) samples.shift();
    coordDirty = true; wake();
  }
  function onUp(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size >= 1) { pinch = null; const [r] = [...pointers.values()]; grab = null; return; }
    pinch = null; dragging = false; viz.classList.remove('dragging');
    const gs = gestureStart; gestureStart = null; grab = null;
    if (!gs) return;
    const dtMs = performance.now() - gs.t;
    if (!gs.moved && !gs.multi && dtMs < 400 && e.type === 'pointerup') { handleTap(e.clientX, e.clientY); return; }
    if (gs.moved && !gs.multi && samples.length >= 2) {      // fling
      const a = samples[0], b = samples[samples.length - 1], sec = (b.t - a.t) / 1000;
      if (sec > 0.01 && performance.now() - b.t < 80) {
        const vlng = normLng(b.lng - a.lng) / sec, vlat = (b.lat - a.lat) / sec, sp = Math.hypot(vlng, vlat);
        if (sp > 8) { const m = Math.min(1, Math.min(260, 2800 / Math.max(pixelsPerDegree(), 0.5)) / sp); inertia = { vlat: vlat * m, vlng: vlng * m }; }
      }
    }
    saveViewSoon(); wake();
  }
  function handleTap(x, y) {
    const now = performance.now();
    const dbl = now - lastTap.t < 320 && Math.hypot(x - lastTap.x, y - lastTap.y) < 30;
    lastTap = dbl ? { t: 0, x: 0, y: 0 } : { t: now, x, y };
    if (state.turbo) { exitTurbo(); return; }
    updateBasis();
    if (dbl) {                                    // zoom in toward the tapped spot
      const P = pickSphere(x, y);
      if (P) flyTo(vecToLat(P), vecToLng(P), Math.max(state.cam.alt * 0.42, 0.03), 450, easeOutCubic);
      return;
    }
    const c = pickCountry(x, y);
    if (c) selectCountry(c);
  }
  let hoverPending = false, hoverXY = null;
  function hoverCursor(x, y) {
    hoverXY = [x, y];
    if (hoverPending) return; hoverPending = true;
    requestAnimationFrame(() => {
      hoverPending = false; if (dragging || !hoverXY) return;
      updateBasis(); viz.classList.toggle('pick', !!pickCountry(hoverXY[0], hoverXY[1]));
    });
  }
  function onWheel(e) {
    e.preventDefault();
    if (state.turbo) exitTurbo();
    const unit = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 1 : 0.0016;
    anim = null;
    state.targetAlt = clamp(state.targetAlt * Math.exp(clamp(e.deltaY * unit, -0.6, 0.6)), MIN_ALT, MAX_ALT);
    if (!state.userInteracted) firstInteraction();
    wake();
  }
  function onKey(e) {
    if (e.target && /input|textarea/i.test(e.target.tagName)) return;
    const step = Math.max(2, state.cam.alt * 14);
    const k = e.key; let used = true;
    if (k === 'ArrowLeft') state.cam.lng = normLng(state.cam.lng - step);
    else if (k === 'ArrowRight') state.cam.lng = normLng(state.cam.lng + step);
    else if (k === 'ArrowUp') state.cam.lat = clamp(state.cam.lat + step, -88, 88);
    else if (k === 'ArrowDown') state.cam.lat = clamp(state.cam.lat - step, -88, 88);
    else if (k === '+' || k === '=') zoomBy(0.6);
    else if (k === '-' || k === '_') zoomBy(1.7);
    else if (k === 'Escape') clearSelection();
    else used = false;
    if (used) { if (!state.userInteracted) firstInteraction(); anim = null; coordDirty = true; wake(); }
  }
  function firstInteraction() {
    state.userInteracted = true; fadeHint();
    if (!state.paused) rotateTo(0, 700, easeOutCubic, () => setPaused(true));
  }
  function rotateTo(to, ms, ease, done) { rotAnim = { t0: performance.now(), ms, ease, from: state.baseRotate, to, done }; wake(); }

  /* ================================================================
     SELECTION / PANEL
     ================================================================ */
  function selectCountry(c) {
    if (!c) return;
    const i = state.selected.indexOf(c);
    if (i !== -1) state.selected.splice(i, 1);
    else { state.selected.push(c); if (state.selected.length > MAX_SELECTED) state.selected.shift(); }
    selectionChanged();
    if (!state.selected.length) { closePanel(); return; }
    flyToSelection();
  }
  function clearSelection() { state.selected = []; selectionChanged(); closePanel(); }
  function selectionChanged() {
    buildHighlightTexture();
    state.hiA = 0.3; state.hiTarget = 1;
    renderPanel(); wake();
  }
  function flyToSelection() {
    const sel = state.selected;
    const mid = c => [(c.bb[0] + c.bb[2]) / 2, (c.bb[1] + c.bb[3]) / 2];   // [lng, lat] in degrees
    const size = c => Math.max(c.bb[3] - c.bb[1], (c.bb[2] - c.bb[0]) * Math.cos(mid(c)[1] * DEG));
    if (sel.length === 1) {
      const [lng, lat] = mid(sel[0]);
      flyTo(lat, lng, clamp(size(sel[0]) / 29.4, 0.12, 3.2), 1300);
      return;
    }
    let sx = 0, sy = 0, sz = 0;
    sel.forEach(c => { const m = mid(c), v = toVec(m[1], m[0]); sx += v[0]; sy += v[1]; sz += v[2]; });
    const l = Math.hypot(sx, sy, sz) || 1, ctr = [sx / l, sy / l, sz / l];
    let spread = 0;
    sel.forEach(c => {
      for (const [x, y] of [[c.bb[0], c.bb[1]], [c.bb[2], c.bb[3]], [c.bb[0], c.bb[3]], [c.bb[2], c.bb[1]]]) {
        const v = toVec(y, x);
        spread = Math.max(spread, Math.acos(clamp(v[0] * ctr[0] + v[1] * ctr[1] + v[2] * ctr[2], -1, 1)) / DEG);
      }
    });
    flyTo(vecToLat(ctr), vecToLng(ctr), clamp(spread * 2 / 37, 0.2, 3.4), 1300);
  }

  function renderPanel() {
    const cardsEl = $('panel-cards');
    $('panel-kind').textContent = state.selected.length > 1 ? `${state.selected.length} countries` : 'Country';
    cardsEl.textContent = '';
    state.selected.forEach(c => {
      const name = c.n, neighbors = c.nb;
      const card = document.createElement('div'); card.className = 'panel-card';
      const closeBtn = document.createElement('button');
      closeBtn.className = 'panel-card-close'; closeBtn.setAttribute('aria-label', `Deselect ${name}`); closeBtn.textContent = '×';
      closeBtn.addEventListener('click', ev => { ev.stopPropagation(); selectCountry(c); });
      const head = document.createElement('div'); head.className = 'panel-card-head';
      const code = FLAG_CODES[name];
      if (code) {
        const wrap = document.createElement('div'); wrap.className = 'panel-card-flag';
        const img = document.createElement('img');
        img.src = `flags/${code}.svg`; img.alt = `${name} flag`; img.loading = 'lazy'; img.width = 46; img.height = 32;
        img.addEventListener('error', () => wrap.remove());
        wrap.appendChild(img); head.appendChild(wrap);
      }
      const h3 = document.createElement('h3'); h3.textContent = name; head.appendChild(h3);
      const p = document.createElement('p'); p.className = 'panel-card-borders';
      p.textContent = neighbors && neighbors.length ? `Borders ${neighbors.join(', ')}` : 'An island nation with no land borders.';
      card.append(closeBtn, head, buildFacts(c), p); cardsEl.appendChild(card);
      requestAnimationFrame(() => {
        if (p.scrollHeight > p.clientHeight + 1) {
          const more = document.createElement('button');
          more.className = 'panel-card-more'; more.type = 'button'; more.textContent = 'More';
          more.addEventListener('click', ev => { ev.stopPropagation(); more.textContent = p.classList.toggle('expanded') ? 'Less' : 'More'; });
          card.appendChild(more);
        }
      });
    });
    $('panel').classList.add('open'); document.body.classList.add('panel-open'); setPanelOffset();
    // simple area comparison (precomputed spherical areas, no network)
    const cmp = $('compare'); cmp.replaceChildren();
    if (state.selected.length < 2) { cmp.hidden = true; return; }
    cmp.hidden = false;
    const hd = document.createElement('strong'); hd.textContent = 'Selected country comparison'; cmp.append(hd);
    const list = document.createElement('div'); list.className = 'compare-list';
    state.selected.forEach(c => { const d = document.createElement('div'); d.textContent = `${c.n}: ${c.a.toLocaleString()} km² (approx.)`; list.append(d); });
    cmp.append(list);
  }
  function closePanel() { $('panel').classList.remove('open'); document.body.classList.remove('panel-open'); $('compare').hidden = true; state.offYTarget = 0; wake(); }
  function setPanelOffset() {       // nudge the globe up so the selected country isn't hidden behind the sheet
    requestAnimationFrame(() => {
      if (!$('panel').classList.contains('open')) return;
      state.offYTarget = -Math.min($('panel').offsetHeight * 0.5, state.H * 0.3); wake();
    });
  }
  function fadeHint() { $('hint').classList.add('faded'); }

  let lastCoordText = '', lastCoordKey = '', lastCoordCountry = null;
  function updateCoords() {
    const { lat } = state.cam, lng = normLng(state.cam.lng);
    const key = Math.round(lat * 6) + ',' + Math.round(lng * 6);
    if (key !== lastCoordKey) { lastCoordKey = key; lastCoordCountry = countryAt(lat, lng); }
    const name = lastCoordCountry ? lastCoordCountry.n : 'Ocean / international waters';
    const txt = `${name} · ${centerClock(lastCoordCountry, lng)}\n${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(2)}°${lng >= 0 ? 'E' : 'W'}`;
    if (txt !== lastCoordText) { lastCoordText = txt; $('coordinates').textContent = txt; }
  }

  /* ================================================================
     QUICK FACTS + LOCAL TIME  (no network: Intl + bundled facts.js)
     ================================================================ */
  const TZ_ALIAS = { 'Europe/Kyiv': 'Europe/Kiev', 'America/Nuuk': 'America/Godthab', 'Asia/Yangon': 'Asia/Rangoon' };
  const clockFmt = new Map(), partsFmt = new Map(), offCache = new Map();
  function zoneOk(z) {
    if (clockFmt.has(z)) return clockFmt.get(z) ? clockFmt.get(z).zone : null;
    for (const cand of [z, TZ_ALIAS[z]]) {
      if (!cand) continue;
      try {
        clockFmt.set(z, { zone: cand, f: new Intl.DateTimeFormat(undefined, { timeZone: cand, hour: '2-digit', minute: '2-digit' }) });
        partsFmt.set(cand, new Intl.DateTimeFormat('en-US', { timeZone: cand, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }));
        return cand;
      } catch (_) {}
    }
    clockFmt.set(z, null); return null;
  }
  function tzOffsetMin(z) {                       // minutes east of UTC, cached per minute
    const zone = zoneOk(z); if (!zone) return null;
    const now = Date.now(), minute = Math.floor(now / 60000), hit = offCache.get(zone);
    if (hit && hit.m === minute) return hit.v;
    const p = {}; partsFmt.get(zone).formatToParts(now).forEach(x => p[x.type] = +x.value);
    const v = Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(now / 1000) * 1000) / 60000);
    offCache.set(zone, { m: minute, v }); return v;
  }
  const fmtOffset = min => { const a = Math.abs(min), h = Math.floor(a / 60), m = a % 60; return 'UTC' + (min < 0 ? '−' : '+') + h + (m ? ':' + String(m).padStart(2, '0') : ''); };
  function clockAt(z) {                           // → { time, off } for an IANA zone
    const zone = zoneOk(z); if (!zone) return null;
    return { time: clockFmt.get(z).f.format(Date.now()), off: fmtOffset(tzOffsetMin(z)) };
  }
  const zoneCity = z => z.split('/').pop().replace(/_/g, ' ');
  function factsFor(c) {
    const f = typeof COUNTRY_FACTS !== 'undefined' ? COUNTRY_FACTS[c.n] : null; if (!f) return null;
    return { capital: f[0], pop: f[1], langs: f[2], cur: f[3], zones: f[4].split(',') };
  }
  function fmtPop(m) {
    if (!m) return 'No permanent residents';
    if (m * 1e6 < 1000) return '~' + Math.round(m * 1e6) + ' people';
    if (m < 1) return Math.round(m * 1000).toLocaleString() + ' thousand';
    if (m >= 1000) return (m / 1000).toFixed(2) + ' billion';
    return (m >= 10 ? Math.round(m) : m.toFixed(1)) + ' million';
  }
  function fmtArea(a) { return a >= 1e6 ? (a / 1e6).toFixed(2) + ' M km²' : Math.round(a).toLocaleString() + ' km²'; }
  function fmtDensity(c, f) { return f.pop && c.a > 0 ? Math.round(f.pop * 1e6 / c.a).toLocaleString() + ' / km²' : '—'; }

  // time at the centre of the screen: nearest of the country's zones to this longitude, or the nautical zone at sea
  function centerClock(country, lng) {
    const f = country && factsFor(country);
    if (f) {
      let best = null, bd = 1e9;
      for (const z of f.zones) {
        const o = tzOffsetMin(z); if (o === null) continue;
        let d = Math.abs(o / 4 - lng); d = Math.min(d, 360 - d);
        if (d < bd) { bd = d; best = z; }
      }
      const c = best && clockAt(best); if (c) return `${c.time} ${c.off}`;
    }
    const off = Math.round(lng / 15) * 60, d = new Date(Date.now() + off * 60000);
    const hh = String(d.getUTCHours()).padStart(2, '0'), mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mm} ${fmtOffset(off)}`;
  }

  function buildFacts(c) {
    const f = factsFor(c), box = document.createElement('div'); box.className = 'facts';
    if (!f) return box;
    const grid = document.createElement('dl'); grid.className = 'facts-grid';
    const add = (label, value, wide) => {
      const d = document.createElement('div'); if (wide) d.className = 'wide';
      const dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = label; dd.textContent = value; d.append(dt, dd); grid.append(d);
    };
    add('Capital', f.capital);
    add('Population', fmtPop(f.pop));
    add('Area', fmtArea(c.a));
    add('Density', fmtDensity(c, f));
    add('Currency', f.cur);

    const main = clockAt(f.zones[0]);
    if (main) {
      const cell = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = 'Local time'; dd.className = 'ft-cell';
      const t = document.createElement('span'); t.className = 'ft-time'; t.dataset.tz = f.zones[0]; t.textContent = main.time;
      const o = document.createElement('span'); o.className = 'ft-off'; o.textContent = f.zones.length > 1 ? `${main.off} · ${zoneCity(f.zones[0])}` : main.off;
      dd.append(t, o); cell.append(dt, dd); grid.append(cell);
    }
    add('Languages', f.langs, true);
    box.append(grid);

    if (main && f.zones.length > 1) {
      const list = document.createElement('div'); list.className = 'zone-list'; list.hidden = true;
      f.zones.forEach(z => {
        const cl = clockAt(z); if (!cl) return;
        const r = document.createElement('div'); r.className = 'zone-row';
        const n = document.createElement('span'); n.textContent = zoneCity(z);
        const tm = document.createElement('span'); tm.dataset.tz = z; tm.dataset.withoff = '1'; tm.textContent = `${cl.time} ${cl.off}`;
        r.append(n, tm); list.append(r);
      });
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'panel-card-more';
      btn.textContent = `All ${f.zones.length} time zones`;
      btn.addEventListener('click', ev => { ev.stopPropagation(); list.hidden = !list.hidden; btn.textContent = list.hidden ? `All ${f.zones.length} time zones` : 'Hide time zones'; setPanelOffset(); });
      box.append(btn, list);
    }
    return box;
  }
  function tickClocks() {                          // refresh any visible clocks
    document.querySelectorAll('[data-tz]').forEach(el => {
      const c = clockAt(el.dataset.tz); if (!c) return;
      const txt = el.dataset.withoff ? `${c.time} ${c.off}` : c.time;
      if (el.textContent !== txt) el.textContent = txt;
    });
  }
  setInterval(() => { if (!document.hidden) { tickClocks(); lastCoordText = ''; updateCoords(); } }, 5000);

  /* ---------------- persistence ---------------- */
  let saveTimer = 0;
  function saveView() { if (state.turbo) return; try { localStorage.setItem('myglobe-view', JSON.stringify({ lat: state.cam.lat, lng: state.cam.lng, altitude: state.cam.alt })); } catch (_) {} }
  function saveViewSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveView, 400); }

  /* ================================================================
     UI WIRING
     ================================================================ */
  const FADE_SELECTOR = '#layers, .control-dock, .search-wrap';
  let uiHideTimer = null;
  function scheduleHideUI(delay = 4000) {
    clearTimeout(uiHideTimer);
    uiHideTimer = setTimeout(() => {
      if (document.activeElement && document.activeElement.id === 'search') { scheduleHideUI(); return; }
      document.querySelectorAll(FADE_SELECTOR).forEach(el => el.classList.add('is-hidden'));
    }, delay);
  }
  function showUI() { document.querySelectorAll(FADE_SELECTOR).forEach(el => el.classList.remove('is-hidden')); scheduleHideUI(); }

  function setPaused(paused) {
    state.paused = paused;
    if (!paused && state.baseRotate < 0.001) state.baseRotate = ROTATE_SPEEDS[state.prevRotateSpeed] || ROTATE_SPEEDS['0.5'];
    const btn = $('spin-pause');
    btn.textContent = paused ? '▶' : '⏸';
    btn.setAttribute('aria-label', paused ? 'Resume rotation' : 'Pause rotation');
    btn.setAttribute('aria-pressed', String(paused));
    btn.classList.toggle('is-active', paused);
    wake();
  }
  function markSpeedButtons(val) {
    document.querySelectorAll('.speed-btn').forEach(b => {
      const a = b.dataset.speed === val; b.classList.toggle('is-active', a); b.setAttribute('aria-selected', String(a));
    });
  }
  function setRotateSpeed(val) {
    if (val === 'turbo') { enterTurbo(); return; }
    if (state.turbo) exitTurbo(true);
    state.rotateSpeed = state.prevRotateSpeed = val;
    markSpeedButtons(val);
    rotAnim = null; state.baseRotate = ROTATE_SPEEDS[val];
    setPaused(false);
  }

  function setMode(mode) {
    if (state.turbo) exitTurbo();
    if (mode === state.mode) return;
    const apply = () => {
      state.mode = mode;
      document.querySelectorAll('.mode-btn').forEach(b => {
        const a = b.dataset.mode === mode; b.classList.toggle('is-active', a); b.setAttribute('aria-selected', String(a)); b.classList.remove('is-loading');
      });
      state.satMixTarget = mode === 'satellite' ? 1 : 0;
      buildHighlightTexture(); wake();
    };
    if (mode === 'satellite' && !state.satLoaded) {
      const btn = document.querySelector('.mode-btn[data-mode="satellite"]'); btn.classList.add('is-loading');
      loadSatellite().then(apply).catch(() => { btn.classList.remove('is-loading'); btn.textContent = 'Offline'; setTimeout(() => btn.textContent = 'Satellite', 1800); });
    } else apply();
  }

  /* Turbo: the playful 100× "toy globe" — cartoon texture, no vector overlay, fast spin */
  function enterTurbo() {
    if (state.turbo) return;
    state.turbo = true; state.prevRotateSpeed = state.rotateSpeed; state.rotateSpeed = 'turbo';
    state.prevView = { lat: state.cam.lat, lng: state.cam.lng, alt: state.cam.alt };
    markSpeedButtons('turbo');
    clearTimeout(uiHideTimer); $('layers').classList.add('is-hidden');
    state.selected = []; buildHighlightTexture(); closePanel();
    document.body.classList.add('turbo');
    state.toyTarget = 1;
    flyTo(state.cam.lat, state.cam.lng, TURBO_ALT, 900, easeOutCubic);
    state.paused = false; setPaused(false);
    rotateTo(TURBO_SPEED, 900, easeOutBack);
  }
  function exitTurbo() {
    if (!state.turbo) return;
    state.turbo = false; state.rotateSpeed = state.prevRotateSpeed;
    markSpeedButtons(state.rotateSpeed);
    document.body.classList.remove('turbo');
    state.toyTarget = 0;
    const v = state.prevView; if (v) flyTo(v.lat, v.lng, v.alt, 900);
    setPaused(false);
    rotateTo(ROTATE_SPEEDS[state.rotateSpeed] || ROTATE_SPEEDS['0.5'], 700, easeOutCubic);
    scheduleHideUI();
  }

  function setupUI() {
    document.querySelectorAll('.chip').forEach(btn => btn.addEventListener('click', () => {
      const l = btn.dataset.layer; state.layers[l] = !state.layers[l]; btn.classList.toggle('is-active', state.layers[l]); wake();
    }));
    document.addEventListener('click', e => { if (e.target.closest(FADE_SELECTOR)) scheduleHideUI(); else showUI(); });
    scheduleHideUI();
    document.querySelectorAll('.mode-btn').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
    document.querySelectorAll('.speed-btn').forEach(b => b.addEventListener('click', () => setRotateSpeed(b.dataset.speed)));
    $('spin-pause').addEventListener('click', () => { rotAnim = null; setPaused(!state.paused); });
    $('zoom-in').addEventListener('click', () => { if (state.turbo) exitTurbo(); zoomBy(0.55); });
    $('zoom-out').addEventListener('click', () => { if (state.turbo) exitTurbo(); zoomBy(1.8); });
    $('zoom-labels').addEventListener('click', () => { if (state.turbo) exitTurbo(); flyTo(state.cam.lat, state.cam.lng, state.defaultAlt, 650, easeOutCubic); });
    $('recenter').addEventListener('click', () => {
      if (state.turbo) exitTurbo();
      state.selected = []; selectionChanged(); closePanel();
      flyTo(DEFAULT_CENTER.lat, DEFAULT_CENTER.lng, state.defaultAlt, 1200);
    });
    $('panel-clear').addEventListener('click', clearSelection);

    const input = $('search'), results = $('search-results');
    const norm = t => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const aliases = { usa: 'United States of America', us: 'United States of America', uk: 'United Kingdom', uae: 'United Arab Emirates', 'dr congo': 'Dem. Rep. Congo', 'ivory coast': "Côte d'Ivoire", 'czech republic': 'Czechia', burma: 'Myanmar', swaziland: 'eSwatini' };
    input.addEventListener('focus', () => { showUI(); if (results.children.length) results.classList.add('open'); });
    input.addEventListener('input', () => {
      scheduleHideUI();
      const q = input.value.trim().toLowerCase();
      results.textContent = '';
      if (!q) { results.classList.remove('open'); return; }
      const term = norm(aliases[q] || q);
      const matches = state.countries.filter(c => norm(c.n).includes(term) || (FLAG_CODES[c.n] || '') === q)
        .sort((a, b) => Number(norm(b.n).startsWith(term)) - Number(norm(a.n).startsWith(term))).slice(0, 7);
      if (!matches.length) { results.classList.remove('open'); return; }
      matches.forEach(c => {
        const item = document.createElement('div'); item.className = 'search-item'; item.textContent = c.n;
        item.addEventListener('click', () => { if (state.turbo) exitTurbo(); selectCountry(c); results.classList.remove('open'); input.value = ''; input.blur(); });
        results.appendChild(item);
      });
      results.classList.add('open');
    });
    document.addEventListener('click', e => { if (!e.target.closest('.search-wrap')) results.classList.remove('open'); });

    viz.addEventListener('pointerdown', onDown);
    viz.addEventListener('pointermove', onMove);
    viz.addEventListener('pointerup', onUp);
    viz.addEventListener('pointercancel', onUp);
    viz.addEventListener('wheel', onWheel, { passive: false });
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', resize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);
    window.addEventListener('orientationchange', () => setTimeout(resize, 250));
    window.addEventListener('pagehide', saveView);
    glCanvas.addEventListener('webglcontextlost', e => { e.preventDefault(); glReady = false; running = false; });
    glCanvas.addEventListener('webglcontextrestored', () => { initGL(); buildLandTexture(); buildHighlightTexture(); buildToyTexture(); if (state.satLoaded) { state.satLoaded = false; state.satPromise = null; loadSatellite().then(wake); } applyCanvasSize(); wake(); });
  }

  /* ================================================================
     BOOT
     ================================================================ */
  async function init() {
    const loaderText = $('loader-text');
    try {
      if (!initGL()) throw new Error('webgl2');
    } catch (err) {
      loaderText.textContent = 'This browser can’t draw the 3D globe (WebGL 2 is required).';
      document.querySelector('.loader-globe').style.display = 'none';
      return;
    }
    resize();
    await loadData();
    state.world = true;
    buildLandTexture(); buildHighlightTexture(); buildToyTexture();

    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('myglobe-view')); } catch (_) {}
    if (saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lng) && Number.isFinite(saved.altitude)) {
      state.cam = { lat: clamp(saved.lat, -88, 88), lng: normLng(saved.lng), alt: clamp(saved.altitude, MIN_ALT, MAX_ALT) };
    } else state.cam = { lat: DEFAULT_CENTER.lat, lng: DEFAULT_CENTER.lng, alt: state.defaultAlt };
    state.targetAlt = state.cam.alt;
    state.baseRotate = ROTATE_SPEEDS[state.rotateSpeed];

    setupUI();
    updateBasis(); renderGL(); renderOverlay(); updateCoords();
    wake();
    setTimeout(() => {
      $('loader').classList.add('hidden');
      const app = $('app'); app.classList.add('visible'); app.removeAttribute('aria-hidden');
      setTimeout(fadeHint, 6000);
    }, 200);
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  init();
})();
