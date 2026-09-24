// Star chart background ("Carta estelar"): a celestial chart printed on paper, the light theme's
// answer to the starry backgrounds. A north-polar stereographic projection whose pole sits just
// beyond the top-right corner, so declination circles and hour meridians sweep across the page as
// fine ink arcs, closed by a ticked rim that cuts across the bottom-left corner. A faint dashed
// ecliptic, star dots sized by magnitude and a few stick figures joining nearby bright stars
// complete it. No labels. The whole chart turns very slowly about the pole (1° every 10 s at 1×).
// The stars and figures are invented, not a real catalogue: they are seeded (mulberry32, fixed
// seeds) and normalised to the rim, so every reload of the same viewport draws the same sky.
//
// Background module contract v2: registers window.PortfolioBG.starchart = { label, layer, themes,
// params, start(canvas, values) } and start() returns { pause(), resume(), stop(), set(key, value),
// lightFriendly }. Every param applies live through set(): no restart and no blank frame, and a
// paused or reduced-motion chart repaints one complete still frame that shows the new value. It
// follows the site's single motion switch (<html data-motion="off|on">), pauses in hidden tabs, and
// under prefers-reduced-motion (unless <html data-preview-motion="force">) it draws one complete
// static frame and never starts the loop.
//
// Rendering: the static chart (graticule, stars, figures) is drawn once into an offscreen bitmap
// that covers the viewport for the next few degrees of rotation. Each frame only composites that
// bitmap, rotated about the pole; it is re-drawn when the rotation leaves its span (every 40 s at
// 1×) and on resize, theme or param changes. Frames are paced by the turn itself: one is drawn
// only once the rim (the fastest visible ink) has moved a third of a device pixel, so 1× runs at
// ~9 fps on a 1440×900 laptop (12 at DPR 1.5, ~7 on a phone); big screens and fast turns reach
// the 20 fps cap.
//
// Light-theme ceiling: no final canvas pixel carries more than 22% ink, overlaps included. The
// bitmap holds relative ink (alpha ≤ 1 per pixel however lines and dots overlap) and lands on the
// canvas once just under the ceiling. Tints are clamped per channel to be no darker than --ink.
(function () {
  "use strict";

  var TAU = Math.PI * 2, DEG = Math.PI / 180;
  var DPR_CAP = 1.5;
  var RESIZE_DEBOUNCE = 150;            // ms
  var THEME_DEBOUNCE = 60;              // ms: a class change on <html> may carry new tokens (has-bg)
  var HEIGHT_SLACK = 0.2;               // a height-only change under 20% is a phone toolbar sliding
  var FRAME_MS = 1000 / 20;             // pace cap: at 1× the rim moves ~3 px/s on a laptop, ~5 on a 2560 px screen
  var STEP_PX = 1 / 3;                  // device px the rim turns between frames: sub-pixel steps read as a smooth turn
  var MAX_FRAME_MS = 1000;              // a crawling chart still ticks once a second
  var MAX_DT = 0.1;                     // s (or two frame gaps): a long frame (tab switch, jank) never makes the chart jump
  var OMEGA = 0.1 * DEG;                // rad/s at 1×: one degree every ten seconds
  var DIR = -1;                         // counter-clockwise on screen, as the sky turns about the north pole
  var SPAN = 4 * DEG;                   // rotation one baked bitmap covers before it is re-drawn
  var BAKE_BUDGET = 14e6, BAKE_SIDE = 8192; // device px: past these (huge screens) the bitmap is drawn coarser
  var LIGHT_CEILING = 0.22;             // light theme: max ink alpha on any final canvas pixel
  var LIGHT_ALPHA = LIGHT_CEILING - 0.002; // ... the bitmap lands a hair under it, so 8-bit rounding stays at 56/255

  // Geometry. The pole sits beyond the top-right corner by these shares of the viewport diagonal;
  // the rim is RIM of the pole's distance to the far (bottom-left) corner, at declination −30°.
  var POLE_X = 0.06, POLE_Y = 0.10;
  var RIM = 0.9;
  var RIM_P = 120 * DEG;                // polar distance at the rim
  var BAND = 10, BAND_SMALL = 8;        // CSS px: the rim's tick band
  var OBLIQUITY = 23.44 * DEG;          // tilt of the ecliptic

  // Catalogue, in coordinates normalised to the rim (0..1 from the pole). Bright stars (the ones
  // figures join) are a fixed set; faint field stars fill in at one per AREA px² of chart times the
  // "stars" param, as a prefix of one seeded sequence, so more stars never move the others.
  var SEED_BRIGHT = 0x5ca1ab1e, SEED_FIELD = 0x0b5e55ed, SEED_FIG = 0x57a2c4a7;
  var BRIGHT_MAX = 480;
  var SMALL_SHARE = 0.6;                // phones (< 640px wide) use this share of the bright stars and figures
  var FIELD_CAP = 30000, AREA = 3600, AREA_SMALL = 3000;
  var MAG_MIN = -0.5, MAG_BRIGHT = 3.5, MAG_MAX = 5.6;
  var RHO_MAX = 0.985;                  // no star sits on the rim line

  // Stick figures: grown from a bright anchor to its nearest free bright neighbours (a spanning
  // tree, so strokes never cross), sometimes closed into a loop. Distances are rim-normalised.
  var LINK = 0.11;                      // longest stroke
  var EXCL = 0.045;                     // a figure keeps this clear of other figures' stars
  var ANCHOR_MAG = 2.6;                 // figures start from the brighter stars
  var LOOP_P = 0.4;                     // chance a figure of 4+ stars closes one loop
  var MIN_TURN = 0.45;                  // rad: a closing stroke leaves a star clear of its other strokes
  var FIG_GAP = 2.5;                    // CSS px between a stroke's end and its star's edge

  // Star dots: radius grows with brightness; brighter stars clear the lines around them, as on a
  // printed chart. Five magnitude classes set the dot's ink.
  var STAR_R0 = 0.55, STAR_RK = 0.36;   // CSS px at MAG_MAX, and per magnitude brighter
  var KNOCK_MAG = 4, KNOCK_GAP = 1.3;
  var CLASS_MAG = [1.5, 2.5, 3.5, 4.5];

  // Per-theme strength, as relative ink inside the bitmap (every value ≤ 1). The graticule family
  // (rim, grid lines, ticks, ecliptic) is further scaled by the "grid" param. Light: the bitmap lands
  // at LIGHT_ALPHA, so the strongest graticule stroke carries grid × the ceiling. Dark: chalk and
  // blueprint lines straight onto the canvas.
  var LOOK = {
    light: { layer: LIGHT_ALPHA, rim: 1, major: 0.9, ticks: 0.85, minor: 0.55, ecl: 0.8, fig: 0.7,
             star: [1, 0.92, 0.8, 0.66, 0.52] },
    dark: { layer: 1, rim: 0.5, major: 0.4, ticks: 0.4, minor: 0.24, ecl: 0.45, fig: 0.45,
            star: [0.95, 0.82, 0.68, 0.52, 0.4] }
  };

  // Params shown by the preview panel. "value" is the default; start() and set() clamp to [min, max].
  var PARAMS = [
    { key: "stars", label: "Cantidad de estrellas", min: 0.3, max: 2.5, step: 0.05, value: 1, unit: "×" },
    { key: "speed", label: "Rotación", min: 0, max: 3, step: 0.05, value: 1, unit: "×" },
    { key: "grid", label: "Retícula", min: 0, max: 1, step: 0.05, value: 0.6, unit: "" },
    { key: "figures", label: "Constelaciones dibujadas", min: 0, max: 12, step: 1, value: 6, unit: "" }
  ];
  // Private copy of the bounds, so a panel that writes into PARAMS cannot move the defaults.
  var SPEC = {};
  PARAMS.forEach(function (p) { SPEC[p.key] = { min: p.min, max: p.max, value: p.value, whole: p.step >= 1 }; });
  var FIG_MAX = SPEC.figures.max;

  var WHITE = [255, 255, 255];
  var BLUEPRINT = [146, 184, 226];
  var LIGHT_DEFAULTS = { bg: [247, 246, 243], ink: [28, 28, 26], accent: [14, 107, 97] };

  function noop() {}
  function lerp(a, b, k) { return a + (b - a) * k; }
  function mix(a, b, k) { return [Math.round(lerp(a[0], b[0], k)), Math.round(lerp(a[1], b[1], k)), Math.round(lerp(a[2], b[2], k))]; }
  function rgba(c, alpha) { return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + alpha + ")"; }
  function luminance(c) { return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255; }
  // No channel darker than ink's: then no pixel of this tint, alone or mixed with ink, is darker
  // than the same alpha of pure ink, which is what the ceiling (and the scrim) was computed for.
  function noDarker(c, ink) { return [Math.max(c[0], ink[0]), Math.max(c[1], ink[1]), Math.max(c[2], ink[2])]; }
  function wrap(a) { a %= TAU; return a < 0 ? a + TAU : a; }

  // A param value from the panel or the URL: numbers and numeric strings count, anything else
  // (missing, empty, NaN) falls back to the default; the result is clamped to the param's range.
  function resolve(key, v) {
    var s = SPEC[key];
    var n = typeof v === "number" ? v : (typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
    if (!isFinite(n)) return s.value;
    n = Math.max(s.min, Math.min(s.max, n));
    return s.whole ? Math.round(n) : n;
  }

  // Resolve any CSS colour the page uses (hex, rgb(), color-mix()...) to [r, g, b] by painting one pixel.
  var probe = null;
  function toRgb(value, fallback) {
    try {
      if (!probe) {
        var c = document.createElement("canvas");
        c.width = c.height = 1;
        probe = c.getContext("2d", { willReadFrequently: true });
      }
      probe.clearRect(0, 0, 1, 1);
      probe.fillStyle = rgba(fallback, 1);
      if (value) probe.fillStyle = value; // an unparsable value is ignored, so the fallback stays
      probe.fillRect(0, 0, 1, 1);
      var d = probe.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2]];
    } catch (e) { return fallback; }
  }

  function listen(mq, fn) {
    if (!mq) return;
    if (mq.addEventListener) mq.addEventListener("change", fn); else if (mq.addListener) mq.addListener(fn);
  }
  function unlisten(mq, fn) {
    if (!mq) return;
    if (mq.removeEventListener) mq.removeEventListener("change", fn); else if (mq.removeListener) mq.removeListener(fn);
  }

  // ---- Seeded sky: mulberry32, so the same seed always gives the same stars ----
  var imul = Math.imul || function (a, b) {
    var lo = b & 0xffff, hi = b >>> 16;
    return ((a * lo) + (((a * hi) << 16) >>> 0)) | 0;
  };
  function mulberry32(seed) {
    var a = seed | 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = imul(a ^ (a >>> 15), 1 | a);
      t = (t + imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // Magnitudes follow the classic count law (three times as many stars per magnitude fainter),
  // truncated to [lo, hi].
  function magnitude(u, lo, hi) {
    var f = Math.pow(3, lo - hi);
    return hi + Math.log(f + (1 - f) * u) / Math.log(3);
  }
  // Uniform over the chart's area (not the sphere's), so the page reads evenly from pole to rim.
  function place(rng, xs, ys, i) {
    var rho = RHO_MAX * Math.sqrt(rng()), a = TAU * rng();
    xs[i] = rho * Math.cos(a);
    ys[i] = rho * Math.sin(a);
  }

  // Built once per page and shared by every start(): the stars never depend on the viewport.
  // Field stars are made on demand, in sequence order, so the first n are always the same n.
  var CAT = null;
  function ensureField(n) {
    var c = CAT;
    for (var i = c.fieldMade; i < n; i++) { place(c.rf, c.fx, c.fy, i); c.fm[i] = magnitude(c.rf(), MAG_BRIGHT, MAG_MAX); }
    if (n > c.fieldMade) c.fieldMade = n;
  }
  function catalogue() {
    if (CAT) return CAT;
    var i, j;
    var rb = mulberry32(SEED_BRIGHT);
    var bx = new Float32Array(BRIGHT_MAX), by = new Float32Array(BRIGHT_MAX), bm = new Float32Array(BRIGHT_MAX);
    for (i = 0; i < BRIGHT_MAX; i++) { place(rb, bx, by, i); bm[i] = magnitude(rb(), MAG_MIN, MAG_BRIGHT); }
    // Bright neighbours within LINK, nearest first: what the figures grow along.
    var pairs = [];
    for (i = 0; i < BRIGHT_MAX; i++) pairs.push([]);
    for (i = 0; i < BRIGHT_MAX; i++) {
      for (j = i + 1; j < BRIGHT_MAX; j++) {
        var dx = bx[j] - bx[i], dy = by[j] - by[i], d = Math.sqrt(dx * dx + dy * dy);
        if (d < LINK) { pairs[i].push([d, j]); pairs[j].push([d, i]); }
      }
    }
    var nb = [], nd = [];
    for (i = 0; i < BRIGHT_MAX; i++) {
      pairs[i].sort(function (p, q) { return p[0] - q[0] || p[1] - q[1]; });
      nb.push(pairs[i].map(function (p) { return p[1]; }));
      nd.push(pairs[i].map(function (p) { return p[0]; }));
    }
    CAT = { bx: bx, by: by, bm: bm, nb: nb, nd: nd, rf: mulberry32(SEED_FIELD), fieldMade: 0,
            fx: new Float32Array(FIELD_CAP), fy: new Float32Array(FIELD_CAP), fm: new Float32Array(FIELD_CAP) };
    return CAT;
  }

  function orient(ax, ay, bx, by, px, py) { return (bx - ax) * (py - ay) - (by - ay) * (px - ax); }
  // Proper crossing of segments ab and cd (touching at an end does not count).
  function segmentsCross(ax, ay, bx, by, cx, cy, dx, dy) {
    var d1 = orient(cx, cy, dx, dy, ax, ay), d2 = orient(cx, cy, dx, dy, bx, by);
    var d3 = orient(ax, ay, bx, by, cx, cy), d4 = orient(ax, ay, bx, by, dx, dy);
    return d1 * d2 < 0 && d3 * d4 < 0;
  }
  function segmentDistance(px, py, ax, ay, bx, by) {
    var vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
    var k = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l2)) : 0;
    var ex = ax + vx * k - px, ey = ay + vy * k - py;
    return Math.sqrt(ex * ex + ey * ey);
  }

  // Figures, in anchor order, until nMax are built. The process is sequential, so the first n
  // figures are the same whatever nMax is: the "figures" param only shows a longer or shorter
  // prefix. Returns flat edge lists (bright-star indices) and each figure's end in them.
  function buildFigures(cat, nBright, nMax) {
    var bx = cat.bx, by = cat.by, bm = cat.bm, nb = cat.nb, nd = cat.nd;
    var rng = mulberry32(SEED_FIG);
    var owner = new Int16Array(nBright);
    var ea = [], eb = [], ends = [];
    var a, i, m, t;
    for (i = 0; i < nBright; i++) owner[i] = -1;

    function crosses(p, q) {
      for (var e = 0; e < ea.length; e++) {
        var u = ea[e], v = eb[e];
        if (u === p || u === q || v === p || v === q) continue;
        if (segmentsCross(bx[p], by[p], bx[q], by[q], bx[u], by[u], bx[v], by[v])) return true;
      }
      return false;
    }
    // A star this close to another figure's stars would read as part of it.
    function crowded(j, f) {
      var list = nb[j], dist = nd[j];
      for (var k = 0; k < list.length && dist[k] < EXCL; k++) {
        var o = list[k];
        if (o < nBright && owner[o] >= 0 && owner[o] !== f) return true;
      }
      return false;
    }
    function linked(u, v, e0) {
      for (var e = e0; e < ea.length; e++) {
        if ((ea[e] === u && eb[e] === v) || (ea[e] === v && eb[e] === u)) return true;
      }
      return false;
    }
    // The stroke u→v leaves u at a clear angle from u's other strokes (no near-overlapping lines).
    function opens(u, v, e0) {
      var ux = bx[v] - bx[u], uy = by[v] - by[u], ul = Math.sqrt(ux * ux + uy * uy), lim = Math.cos(MIN_TURN);
      for (var e = e0; e < ea.length; e++) {
        var w = ea[e] === u ? eb[e] : (eb[e] === u ? ea[e] : -1);
        if (w < 0) continue;
        var wx = bx[w] - bx[u], wy = by[w] - by[u], wl = Math.sqrt(wx * wx + wy * wy);
        if ((ux * wx + uy * wy) / (ul * wl) > lim) return false;
      }
      return true;
    }
    // One closing stroke between two members, the shortest that crosses nothing, turns clear of
    // the strokes at both ends and does not graze another member.
    function closeLoop(members, e0) {
      var bestU = -1, bestV = -1, bestD = LINK * 0.95;
      for (var p = 0; p < members.length; p++) {
        for (var q = p + 1; q < members.length; q++) {
          var u = members[p], v = members[q];
          var dx = bx[v] - bx[u], dy = by[v] - by[u], d = Math.sqrt(dx * dx + dy * dy);
          if (d >= bestD || linked(u, v, e0) || crosses(u, v) || !opens(u, v, e0) || !opens(v, u, e0)) continue;
          var clear = true;
          for (var r = 0; r < members.length && clear; r++) {
            var w = members[r];
            if (w !== u && w !== v && segmentDistance(bx[w], by[w], bx[u], by[u], bx[v], by[v]) < EXCL * 0.5) clear = false;
          }
          if (!clear) continue;
          bestU = u; bestV = v; bestD = d;
        }
      }
      if (bestU >= 0) { ea.push(bestU); eb.push(bestV); }
    }

    for (a = 0; a < nBright && ends.length < nMax; a++) {
      var size = 4 + Math.floor(rng() * 4); // 4-7 stars; both draws happen for every anchor, used or not
      var loop = rng() < LOOP_P;
      if (bm[a] > ANCHOR_MAG || owner[a] >= 0) continue;
      var f = ends.length;
      if (crowded(a, f)) continue;
      var e0 = ea.length, members = [a];
      owner[a] = f;
      while (members.length < size) {
        var best = -1, bestD = Infinity, from = -1;
        for (m = 0; m < members.length; m++) {
          var u = members[m], list = nb[u], dist = nd[u];
          for (t = 0; t < list.length && dist[t] < bestD; t++) {
            var j = list[t];
            if (j >= nBright || owner[j] >= 0 || crowded(j, f) || crosses(u, j)) continue;
            best = j; bestD = dist[t]; from = u;
            break; // lists are sorted: the first free neighbour is this member's nearest
          }
        }
        if (best < 0) break;
        owner[best] = f;
        members.push(best);
        ea.push(from); eb.push(best);
      }
      if (members.length < 3) { // too isolated for a figure: give its stars back
        for (m = 0; m < members.length; m++) owner[members[m]] = -1;
        ea.length = e0; eb.length = e0;
        continue;
      }
      if (loop && members.length >= 4) closeLoop(members, e0);
      ends.push(ea.length);
    }
    return { ea: ea, eb: eb, ends: ends };
  }

  function start(canvas, values) {
    var ctx = canvas && canvas.getContext ? canvas.getContext("2d") : null;
    if (!ctx) return { pause: noop, resume: noop, stop: noop, set: noop, lightFriendly: true };

    var root = document.documentElement;
    var reduceMq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    var darkMq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    var cat = catalogue();

    // Live param values, resolved once here and then only through set().
    var vals = {};
    PARAMS.forEach(function (p) {
      var has = values && typeof values === "object" && Object.prototype.hasOwnProperty.call(values, p.key);
      vals[p.key] = resolve(p.key, has ? values[p.key] : undefined);
    });

    function isReduced() {
      return !!(reduceMq && reduceMq.matches) && root.getAttribute("data-preview-motion") !== "force";
    }

    var reduced = isReduced();
    var userPaused = false, stopped = false, running = false;
    var rafId = 0, lastTs = 0, resizeTimer = 0, themeTimer = 0;
    var W = 0, H = 0, Hfit = 0, dpr = 1, small = false;       // viewport (CSS px); Hfit = height the chart was fitted to
    var cx = 0, cy = 0, R = 1, kProj = 1, band = BAND;        // pole (CSS px), rim radius, projection scale
    var reach = 1;                                            // CSS px from the pole to the farthest visible ink
    var nBright = 0, nField = 0, ratio = 1;                   // stars in use; chart disc area / viewport area
    var figs = { ea: [], eb: [], ends: [] };
    var dark = false, look = LOOK.light, tint = null, themeSig = "";
    // The chart's angle, taken from the clock so it keeps turning across page loads rather than
    // restarting; thetaB is the angle the bitmap was drawn at.
    var theta = wrap(DIR * OMEGA * vals.speed * (Date.now() / 1000)), thetaB = theta;
    var chart = null, g = null;                               // offscreen bitmap (relative ink) and its context
    var ox = 0, oy = 0, bs = 1, coveredH = 0;                 // bitmap origin (CSS px, at thetaB), px per CSS px, height it covers
    var vx = new Float32Array(BRIGHT_MAX + FIELD_CAP);        // scratch: the stars inside the bitmap
    var vy = new Float32Array(BRIGHT_MAX + FIELD_CAP);
    var vm = new Float32Array(BRIGHT_MAX + FIELD_CAP);
    var vc = new Uint8Array(BRIGHT_MAX + FIELD_CAP);

    // ---- Theme: colours come from the page tokens; the brightness of --bg decides dark vs light ----
    // Returns a signature, so a token change that does not alter the chart costs no re-draw.
    function readTheme() {
      var cs = window.getComputedStyle(root);
      var bg = toRgb(cs.getPropertyValue("--bg").trim(), LIGHT_DEFAULTS.bg);
      var ink = toRgb(cs.getPropertyValue("--ink").trim(), LIGHT_DEFAULTS.ink);
      var accent = toRgb(cs.getPropertyValue("--accent").trim(), LIGHT_DEFAULTS.accent);
      dark = luminance(bg) < 0.45;
      look = dark ? LOOK.dark : LOOK.light;
      if (dark) {
        // Chalk stars and pale blueprint lines, with a whisper of the accent.
        var chalk = mix(ink, WHITE, 0.35);
        tint = { grid: mix(BLUEPRINT, accent, 0.2), ecl: mix(accent, chalk, 0.3), fig: mix(chalk, accent, 0.35), star: chalk };
      } else {
        // Printed ink: black dots, lines in an ink tinted toward the accent, never darker than ink.
        tint = { grid: noDarker(mix(ink, accent, 0.55), ink), ecl: noDarker(mix(ink, accent, 0.8), ink),
                 fig: noDarker(mix(ink, accent, 0.25), ink), star: ink };
      }
      return (dark ? "d" : "l") + [tint.grid, tint.ecl, tint.fig, tint.star].join("|");
    }

    // ---- Geometry: pole, rim and scale from the viewport; stars and figures follow the rim ----
    function rOf(p) { return kProj * Math.tan(p / 2); }       // stereographic radius of polar distance p
    function starRadius(m) { return (STAR_R0 + (MAG_MAX - m) * STAR_RK) * (small ? 0.9 : 1); }
    function magClass(m) {
      for (var k = 0; k < CLASS_MAG.length; k++) if (m < CLASS_MAG[k]) return k;
      return CLASS_MAG.length;
    }
    function figureCount(n) { return Math.round(n * ratio * (small ? SMALL_SHARE : 1)); }
    function countField() {
      nField = Math.min(FIELD_CAP, Math.round(Math.PI * R * R / (small ? AREA_SMALL : AREA) * vals.stars));
      ensureField(nField);
    }

    function fit() {
      small = W < 640;
      band = small ? BAND_SMALL : BAND;
      var diag = Math.sqrt(W * W + Hfit * Hfit);
      cx = W + POLE_X * diag;
      cy = -POLE_Y * diag;
      R = Math.max(1, RIM * Math.sqrt(cx * cx + (Hfit - cy) * (Hfit - cy)));
      kProj = R / Math.tan(RIM_P / 2);
      // Figures are counted per viewport: the chart disc holds ratio viewports' worth of them.
      ratio = Math.PI * R * R / Math.max(1, W * Hfit);
      nBright = small ? Math.round(BRIGHT_MAX * SMALL_SHARE) : BRIGHT_MAX;
      countField();
      figs = buildFigures(cat, nBright, figureCount(FIG_MAX));
    }

    // ---- The baked chart ----
    function drawGraticule() {
      var gA = vals.grid, d, h, i, a, r, len;
      // Minor lines: every 10° of declination and every hour of right ascension.
      g.lineWidth = 0.75;
      g.strokeStyle = rgba(tint.grid, look.minor * gA);
      g.beginPath();
      for (d = 10; d <= 110; d += 10) {
        if (d % 30 === 0) continue;
        r = rOf(d * DEG);
        g.moveTo(r, 0); g.arc(0, 0, r, 0, TAU);
      }
      var rIn = rOf(10 * DEG);
      for (h = 0; h < 24; h++) {
        if (h % 6 === 0) continue;
        a = h * 15 * DEG;
        g.moveTo(Math.cos(a) * rIn, Math.sin(a) * rIn);
        g.lineTo(Math.cos(a) * R, Math.sin(a) * R);
      }
      g.stroke();
      // Major lines: declinations +60°, +30° and the equator, and the four quarter meridians.
      g.lineWidth = 1.05;
      g.strokeStyle = rgba(tint.grid, look.major * gA);
      g.beginPath();
      for (d = 30; d <= 90; d += 30) {
        r = rOf(d * DEG);
        g.moveTo(r, 0); g.arc(0, 0, r, 0, TAU);
      }
      for (h = 0; h < 24; h += 6) {
        a = h * 15 * DEG;
        g.moveTo(0, 0);
        g.lineTo(Math.cos(a) * R, Math.sin(a) * R);
      }
      g.stroke();
      // Tick scales: degrees of declination across the quarter meridians, degrees round the rim.
      g.lineWidth = 0.75;
      g.strokeStyle = rgba(tint.grid, look.ticks * gA);
      g.beginPath();
      for (h = 0; h < 4; h++) {
        a = h * 90 * DEG;
        var ca = Math.cos(a), sa = Math.sin(a);
        for (d = 11; d < 120; d++) {
          r = rOf(d * DEG);
          len = d % 10 === 0 ? 4 : (d % 5 === 0 ? 2.8 : 1.6);
          g.moveTo(ca * r - sa * len, sa * r + ca * len);
          g.lineTo(ca * r + sa * len, sa * r - ca * len);
        }
      }
      for (i = 0; i < 360; i++) {
        a = i * DEG;
        len = i % 15 === 0 ? band : (i % 5 === 0 ? band * 0.6 : band * 0.35);
        g.moveTo(Math.cos(a) * R, Math.sin(a) * R);
        g.lineTo(Math.cos(a) * (R + len), Math.sin(a) * (R + len));
      }
      g.stroke();
      // Rim: a firm inner ring and a lighter outer ring close the tick band.
      g.strokeStyle = rgba(tint.grid, look.rim * gA);
      g.lineWidth = 1.3;
      g.beginPath(); g.moveTo(R, 0); g.arc(0, 0, R, 0, TAU); g.stroke();
      g.lineWidth = 0.8;
      g.beginPath(); g.moveTo(R + band, 0); g.arc(0, 0, R + band, 0, TAU); g.stroke();
      // Ecliptic: the great circle 23.44° off the equator, dashed.
      if (g.setLineDash) g.setLineDash([6, 5]);
      g.lineWidth = 0.9;
      g.strokeStyle = rgba(tint.ecl, look.ecl * gA);
      g.beginPath();
      for (i = 0; i <= 120; i++) {
        var lam = i * 3 * DEG;
        var dec = Math.asin(Math.sin(OBLIQUITY) * Math.sin(lam));
        var ra = Math.atan2(Math.cos(OBLIQUITY) * Math.sin(lam), Math.cos(lam));
        r = rOf(Math.PI / 2 - dec);
        if (i === 0) g.moveTo(Math.cos(ra) * r, Math.sin(ra) * r); else g.lineTo(Math.cos(ra) * r, Math.sin(ra) * r);
      }
      g.closePath();
      g.stroke();
      if (g.setLineDash) g.setLineDash([]);
    }

    function drawFigures() {
      var n = Math.min(figs.ends.length, figureCount(vals.figures));
      if (n <= 0) return;
      var end = figs.ends[n - 1], ea = figs.ea, eb = figs.eb, bx = cat.bx, by = cat.by, bm = cat.bm;
      g.lineWidth = 1;
      g.lineCap = "round";
      g.strokeStyle = rgba(tint.fig, look.fig);
      g.beginPath();
      for (var e = 0; e < end; e++) {
        var a = ea[e], b = eb[e];
        var ax = R * bx[a], ay = R * by[a], qx = R * bx[b], qy = R * by[b];
        var dx = qx - ax, dy = qy - ay, len = Math.sqrt(dx * dx + dy * dy);
        var ra = starRadius(bm[a]) + FIG_GAP, rb = starRadius(bm[b]) + FIG_GAP;
        if (len < ra + rb + 3) continue;
        dx /= len; dy /= len;
        // Strokes stop short of both stars, as on a printed chart.
        g.moveTo(ax + dx * ra, ay + dy * ra);
        g.lineTo(qx - dx * rb, qy - dy * rb);
      }
      g.stroke();
      g.lineCap = "butt";
    }

    // Stars inside the bitmap's rectangle (CSS px, at thetaB): knock-outs first, then one filled
    // path per magnitude class (a path is a union, so dots in one class never stack).
    function drawStars(x0, y0, x1, y1) {
      var c = Math.cos(thetaB), s = Math.sin(thetaB), n = 0, i, k, r, X, Y, sx, sy;
      var fx = cat.fx, fy = cat.fy, fm = cat.fm, bx = cat.bx, by = cat.by, bm = cat.bm;
      for (i = 0; i < nField; i++) {
        X = R * fx[i]; Y = R * fy[i];
        sx = cx + c * X - s * Y; if (sx < x0 || sx > x1) continue;
        sy = cy + s * X + c * Y; if (sy < y0 || sy > y1) continue;
        vx[n] = X; vy[n] = Y; vm[n] = fm[i]; vc[n] = magClass(fm[i]); n++;
      }
      for (i = 0; i < nBright; i++) {
        X = R * bx[i]; Y = R * by[i];
        sx = cx + c * X - s * Y; if (sx < x0 || sx > x1) continue;
        sy = cy + s * X + c * Y; if (sy < y0 || sy > y1) continue;
        vx[n] = X; vy[n] = Y; vm[n] = bm[i]; vc[n] = magClass(bm[i]); n++;
      }
      if (!n) return;
      g.globalCompositeOperation = "destination-out";
      g.fillStyle = "#000";
      g.beginPath();
      for (i = 0; i < n; i++) {
        if (vm[i] >= KNOCK_MAG) continue;
        r = starRadius(vm[i]) + KNOCK_GAP;
        g.moveTo(vx[i] + r, vy[i]); g.arc(vx[i], vy[i], r, 0, TAU);
      }
      g.fill();
      g.globalCompositeOperation = "source-over";
      for (k = 0; k <= CLASS_MAG.length; k++) {
        var any = false;
        g.fillStyle = rgba(tint.star, look.star[k]);
        g.beginPath();
        for (i = 0; i < n; i++) {
          if (vc[i] !== k) continue;
          r = starRadius(vm[i]);
          g.moveTo(vx[i] + r, vy[i]); g.arc(vx[i], vy[i], r, 0, TAU);
          any = true;
        }
        if (any) g.fill();
      }
    }

    // Draw the chart at the current angle into a bitmap that covers the viewport for the next SPAN
    // of rotation: the union of the viewport turned back by every angle in that span, clipped to the
    // chart's disc (paper beyond the rim is blank anyway).
    function bake() {
      theta = wrap(theta);
      thetaB = theta;
      var hC = Math.max(H, Hfit), m = 2, s, q;
      var xs = [-m, W + m, -m, W + m], ys = [-m, -m, hC + m, hC + m];
      var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (s = 0; s <= 12; s++) {
        var d = -DIR * SPAN * s / 12, c = Math.cos(d), sn = Math.sin(d);
        for (q = 0; q < 4; q++) {
          var dx = xs[q] - cx, dy = ys[q] - cy;
          var px = cx + c * dx - sn * dy, py = cy + sn * dx + c * dy;
          if (px < x0) x0 = px; if (px > x1) x1 = px;
          if (py < y0) y0 = py; if (py > y1) y1 = py;
        }
      }
      var reach = R + band + 3;
      x0 = Math.max(x0, cx - reach); x1 = Math.min(x1, cx + reach);
      y0 = Math.max(y0, cy - reach); y1 = Math.min(y1, cy + reach);
      if (!(x1 > x0 + 1)) x1 = x0 + 1;
      if (!(y1 > y0 + 1)) y1 = y0 + 1;
      var wC = x1 - x0, hCss = y1 - y0;
      bs = Math.min(dpr, Math.sqrt(BAKE_BUDGET / (wC * hCss)), BAKE_SIDE / wC, BAKE_SIDE / hCss);
      var ix0 = Math.floor(x0 * bs), iy0 = Math.floor(y0 * bs);
      var bw = Math.max(1, Math.ceil(x1 * bs) - ix0), bh = Math.max(1, Math.ceil(y1 * bs) - iy0);
      ox = ix0 / bs; oy = iy0 / bs;
      coveredH = hC;

      if (!chart) {
        chart = document.createElement("canvas");
        g = chart.getContext("2d");
        if (!g) { chart = null; return; }
      }
      if (chart.width !== bw || chart.height !== bh) { chart.width = bw; chart.height = bh; }
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = "source-over";
      g.globalAlpha = 1;
      g.clearRect(0, 0, chart.width, chart.height);
      // Chart coordinates: origin at the pole, turned by thetaB, in CSS px.
      g.setTransform(bs, 0, 0, bs, -ix0, -iy0);
      g.translate(cx, cy);
      g.rotate(thetaB);
      g.lineCap = "butt";
      g.lineJoin = "round";
      if (vals.grid > 0) drawGraticule();
      drawFigures();
      drawStars(x0 - 4, y0 - 4, x1 + 4, y1 + 4);
      g.setTransform(1, 0, 0, 1, 0, 0);
    }

    // ---- Frame: composite the bitmap once, turned by the rotation since it was drawn ----
    function render() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!chart) return;
      var d = theta - thetaB, c = Math.cos(d), s = Math.sin(d), k = dpr / bs;
      var ex = ox - cx, ey = oy - cy;
      // Screen = pole + R(d)·(bitmap point − pole), in device px. Light: the one composite that
      // caps every pixel at LIGHT_ALPHA × (relative ink ≤ 1).
      ctx.setTransform(k * c, k * s, -k * s, k * c, dpr * (cx + c * ex - s * ey), dpr * (cy + s * ex + c * ey));
      ctx.globalAlpha = look.layer;
      ctx.drawImage(chart, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
    }

    // Time between frames: long enough for the rim to turn STEP_PX device px, so a slower chart
    // draws less often; never under FRAME_MS, never over MAX_FRAME_MS.
    function frameGap() {
      var v = OMEGA * vals.speed * reach * dpr;               // device px per second at the rim
      return v > 0 ? Math.max(FRAME_MS, Math.min(MAX_FRAME_MS, 1000 * STEP_PX / v)) : MAX_FRAME_MS;
    }

    function frame(ts) {
      rafId = 0;
      if (!running) return;
      rafId = window.requestAnimationFrame(frame);
      var gap = frameGap();
      if (lastTs && ts - lastTs < gap - 2) return; // the 2 ms slack absorbs vsync jitter
      var dt = lastTs ? (ts - lastTs) / 1000 : 0;
      lastTs = ts;
      var maxDt = Math.max(MAX_DT, 2 * gap / 1000); // a regular gap is never clipped, or the turn would lag
      if (dt > maxDt) dt = maxDt; else if (dt < 0) dt = 0;
      theta += DIR * OMEGA * vals.speed * dt;
      if (Math.abs(theta - thetaB) > SPAN) bake(); // left the bitmap's span: re-draw it at this angle
      render();
    }

    // ---- Run state: one place decides whether the loop runs (a chart at 0× does not turn) ----
    function shouldRun() {
      return !stopped && !reduced && !userPaused && !document.hidden && vals.speed > 0 &&
        root.getAttribute("data-motion") !== "off";
    }

    function sync() {
      var run = shouldRun();
      if (run && !running) {
        running = true;
        lastTs = 0;
        rafId = window.requestAnimationFrame(frame);
      } else if (!run && running) {
        running = false;
        if (rafId) window.cancelAnimationFrame(rafId);
        rafId = 0;
        if (!stopped) render(); // leave a complete still frame
      }
    }

    // ---- Live params: no restart, no blank frame; a still chart repaints once with the new value ----
    function set(key, value) {
      if (stopped || !Object.prototype.hasOwnProperty.call(SPEC, key)) return;
      var v = resolve(key, value);
      if (v === vals[key]) return;
      vals[key] = v;
      if (key === "speed") { sync(); render(); return; } // only the turning changes: nothing to re-draw
      if (key === "stars") countField();                   // a longer or shorter prefix: the rest stay put
      bake();                                              // off-screen first, so the canvas never shows a gap
      render();
    }

    // ---- Listeners ----
    function applySize(force) {
      var w = canvas.clientWidth || window.innerWidth || 0;
      var h = canvas.clientHeight || window.innerHeight || 0;
      var d = Math.min(window.devicePixelRatio || 1, DPR_CAP);
      if (!force && w === W && h === H && d === dpr) return;
      var dprChanged = d !== dpr;
      // A phone's toolbar sliding only changes the height a little: keep the chart where it is
      // (same pole, rim, stars and figures) and re-draw the bitmap only if it no longer reaches.
      var toolbarOnly = !force && !dprChanged && w === W && Hfit > 0 && Math.abs(h - Hfit) < Hfit * HEIGHT_SLACK;
      W = w; H = h; dpr = d;
      canvas.width = Math.max(1, Math.round(W * dpr));
      canvas.height = Math.max(1, Math.round(H * dpr));
      if (!toolbarOnly) { Hfit = H; fit(); bake(); }
      else if (H > coveredH || !chart) bake();
      // The pole is beyond the top-right corner, so bottom-left is the farthest viewport point;
      // the rim's outer ring is the last ink before it.
      reach = Math.max(1, Math.min(R + band, Math.sqrt(cx * cx + (H - cy) * (H - cy))));
      render(); // resizing clears the bitmap: repaint now, even when paused
    }

    function resizeNow() { resizeTimer = 0; applySize(false); }
    function onResize() {
      if (resizeTimer) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(resizeNow, RESIZE_DEBOUNCE);
    }

    function onTheme() {
      if (themeTimer) { window.clearTimeout(themeTimer); themeTimer = 0; }
      var sig = readTheme();
      if (sig === themeSig) return;
      themeSig = sig;
      bake();
      render(); // repaint now: a still chart (paused, reduced, or at 0×) has no next frame
    }
    function onThemeSoon() {
      if (themeTimer) window.clearTimeout(themeTimer);
      themeTimer = window.setTimeout(onTheme, THEME_DEBOUNCE);
    }

    function onReduce() {
      reduced = isReduced();
      sync();
      if (reduced) render();
    }

    // The site's motion switch (data-motion), theme button (data-theme) and the panel's
    // preview-motion override (data-preview-motion) all live on <html>; a class change there (the
    // panel's has-bg) can retint the tokens, so it is checked too, debounced.
    var mo = window.MutationObserver ? new window.MutationObserver(function (records) {
      var theme = false, preview = false, cls = false;
      for (var i = 0; i < records.length; i++) {
        var name = records[i].attributeName;
        if (name === "data-theme") theme = true;
        else if (name === "data-preview-motion") preview = true;
        else if (name === "class") cls = true;
      }
      if (theme) onTheme(); else if (cls) onThemeSoon();
      if (preview) onReduce(); else sync();
    }) : null;

    // ---- Boot ----
    // The integrator sizes the canvas with CSS. If it is still at the 300x150 default, its layout
    // size would follow the bitmap we set and grow on every resize: pin it to the viewport instead.
    if (canvas.clientWidth === 300 && canvas.clientHeight === 150 && !canvas.style.width) {
      canvas.style.width = "100%";
      canvas.style.height = "100%";
    }
    themeSig = readTheme();
    applySize(true);   // sizes the canvas, fits the chart, draws the bitmap, paints the first frame
    window.addEventListener("resize", onResize, { passive: true });
    document.addEventListener("visibilitychange", sync);
    listen(reduceMq, onReduce);
    listen(darkMq, onTheme);
    if (mo) mo.observe(root, { attributes: true, attributeFilter: ["data-theme", "data-motion", "data-preview-motion", "class"] });
    sync();            // reduced motion never gets past here: the first frame is the finished state

    return {
      lightFriendly: true, // the light theme is the home ground: ink under the 22% ceiling, one composite
      pause: function () { if (stopped) return; userPaused = true; sync(); },
      resume: function () { if (stopped) return; userPaused = false; sync(); },
      set: set,
      stop: function () {
        if (stopped) return;
        stopped = true;
        running = false;
        if (rafId) window.cancelAnimationFrame(rafId);
        rafId = 0;
        if (resizeTimer) window.clearTimeout(resizeTimer);
        resizeTimer = 0;
        if (themeTimer) window.clearTimeout(themeTimer);
        themeTimer = 0;
        window.removeEventListener("resize", onResize, { passive: true });
        document.removeEventListener("visibilitychange", sync);
        unlisten(reduceMq, onReduce);
        unlisten(darkMq, onTheme);
        if (mo) mo.disconnect();
        if (chart) chart.width = chart.height = 0;
        chart = g = null;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    };
  }

  window.PortfolioBG = window.PortfolioBG || {};
  window.PortfolioBG["starchart"] = {
    label: "Carta estelar",
    layer: "bg",
    themes: ["light"],
    params: PARAMS,
    start: start
  };
})();
