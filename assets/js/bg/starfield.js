// Starfield background: three depth layers of stars (far / mid / near) that drift very slowly,
// twinkle gently and shift a little with scroll (the near layer the most), plus an occasional
// shooting star across the top band on the dark theme. On the light theme the stars become faint
// ink dots.
//
// Background module contract v2: registers window.PortfolioBG.starfield = { label, layer, themes,
// params, start(canvas, values) } and start() returns { pause(), resume(), stop(), set(key, value),
// lightFriendly }. Every param applies live through set(): no restart and no blank frame, and a
// paused or reduced-motion sky repaints one complete still frame that shows the new value. It
// follows the site's single motion switch (<html data-motion="off|on">), pauses in hidden tabs, and
// under prefers-reduced-motion (unless <html data-preview-motion="force">) it draws one complete
// static frame and never starts the loop.
//
// Light-theme ceiling: no final canvas pixel carries more than 22% ink, overlaps included. The
// stars are drawn at relative alpha into an offscreen ink layer, which is composited once just
// under the ceiling, so two overlapping dots can never stack past it. The dark theme draws
// straight onto the canvas: no ink layer exists there.
//
// Cost: a frame is one drawImage per visible star, so the loop keeps each call cheap. Stars are
// drawn grouped by layer, sprite and alpha bucket (a counting sort, no allocation): globalAlpha
// changes once per bucket, not once per star, and runs of one sprite let the GPU batch them. The
// sprites become ImageBitmaps once ready (the cheapest drawImage source; same pixels). The sky
// repaints on the 30 fps ticks it shares with the ships; between ticks a shooting star repaints
// only its own box, and only a scroll catch-up repaints the whole sky at full rate.
(function () {
  "use strict";

  var DPR_CAP = 1.5;
  var RESIZE_DEBOUNCE = 150;            // ms
  var HEIGHT_SLACK = 0.2;               // a height-only change under 20% is a phone toolbar sliding
  var DRIFT_X = -0.96, DRIFT_Y = 0.28;  // shared drift heading (unit vector): leftward, a touch down
  var SCROLL_EASE = 4;                  // 1/s: how fast the parallax catches up with scrollY
  var MAX_DT = 0.05;                    // s: a long frame (tab switch, jank) never makes the sky jump
  var MARGIN = 6;                       // CSS px: stars wrap outside the viewport, so none pops in
  var LIGHT_CEILING = 0.22;             // light theme: max ink alpha on any final canvas pixel
  var LIGHT_ALPHA = LIGHT_CEILING - 0.002; // ... the ink layer lands a hair under it, so 8-bit rounding stays at 56/255
  var LIGHT_SHARE = 0.6;                // ... and only this share of each layer is drawn
  var SHOOT_MIN = 40, SHOOT_MAX = 80;   // s between shooting stars at 1 per minute (dark theme only)
  var FRAME_MS = 1000 / 30;             // the sky runs at ~30 fps; a shooting star's streak or a scroll catch-up gets full rate
  var LAG_PX = 4;                       // CSS px: the near layer this close to its scroll target glides on at 30 fps (≤ 0.5 px a frame)
  var STREAK_H = 3;                     // CSS px: thickness of a shooting star's trail
  var TWINKLE_DEPTH_MAX = 0.92;         // a boosted twinkle dims a star deeply but never blinks it out
  var BUCKETS = 64;                     // alpha buckets per sprite: a drawn alpha is within 1/128 of the exact twinkle

  // Density: one star per AREA px² of viewport, clamped. Phones (< 640px wide) get fewer.
  // The "density" param multiplies the count and its bounds.
  var AREA = 4200, AREA_SMALL = 3400;
  var CAP = 520, CAP_SMALL = 160, MIN_STARS = 60;

  // far / mid / near. share = part of the total; r = core radius and glow = sprite radius (CSS px);
  // a = base alpha range; amp = twinkle depth; freq = twinkle speed in rad/s (periods of 3-16 s);
  // speed = drift in px/s; par = share of scrollY the layer moves by (parallax).
  var LAYERS = [
    { share: 0.58, r: 0.55, glow: 1.8, a: [0.28, 0.55], amp: [0.25, 0.55], freq: [0.8, 2.0], speed: 1.6, par: 0.015 },
    { share: 0.30, r: 0.85, glow: 2.8, a: [0.45, 0.75], amp: [0.20, 0.45], freq: [0.6, 1.6], speed: 3.2, par: 0.04 },
    { share: 0.12, r: 1.25, glow: 4.2, a: [0.65, 0.95], amp: [0.15, 0.35], freq: [0.4, 1.2], speed: 5.5, par: 0.09 }
  ];
  var NEAR_PAR = LAYERS[LAYERS.length - 1].par;    // the layer that moves most with scroll

  // Params shown by the preview panel. "value" is the default; start() and set() clamp to [min, max].
  var PARAMS = [
    { key: "density", label: "Cantidad de estrellas", min: 0.25, max: 2.5, step: 0.05, value: 1, unit: "×" },
    { key: "speed", label: "Velocidad de deriva", min: 0, max: 3, step: 0.05, value: 1, unit: "×" },
    { key: "twinkle", label: "Titileo", min: 0, max: 2, step: 0.05, value: 1, unit: "×" },
    { key: "shooting", label: "Estrellas fugaces por minuto", min: 0, max: 10, step: 0.5, value: 1, unit: "" },
    { key: "parallax", label: "Paralaje al hacer scroll", min: 0, max: 2, step: 0.05, value: 1, unit: "×" }
  ];
  // Private copy of the bounds, so a panel that writes into PARAMS cannot move the defaults.
  var SPEC = {};
  PARAMS.forEach(function (p) { SPEC[p.key] = { min: p.min, max: p.max, value: p.value }; });
  var DENSITY_MAX = SPEC.density.max;

  var WHITE = [255, 255, 255];
  var BLUE_WHITE = [202, 220, 255];
  var LIGHT_DEFAULTS = { bg: [247, 246, 243], ink: [28, 28, 26], muted: [91, 89, 83], accent: [14, 107, 97] };

  function noop() {}
  function lerp(a, b, k) { return a + (b - a) * k; }
  function rand(range) { return lerp(range[0], range[1], Math.random()); }
  function mix(a, b, k) { return [Math.round(lerp(a[0], b[0], k)), Math.round(lerp(a[1], b[1], k)), Math.round(lerp(a[2], b[2], k))]; }
  function rgba(c, alpha) { return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + alpha + ")"; }
  function luminance(c) { return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255; }
  function scrollTop() { return window.scrollY || window.pageYOffset || 0; }

  // One 30 fps decision per display frame, shared on window with every layer that paces itself
  // this way (the ships do): the canvases then repaint on the same display frames, so the
  // compositor makes one frame per tick instead of two interleaved ones. Same rule as a private
  // clock (at least FRAME_MS - 2 since the last tick), decided once per rAF timestamp.
  function due(ts) {
    var c = window.PortfolioBGPace || (window.PortfolioBGPace = { ts: -1, last: -Infinity, go: false });
    if (ts !== c.ts) {
      c.ts = ts;
      c.go = ts - c.last >= FRAME_MS - 2 || ts < c.last;
      if (c.go) c.last = ts;
    }
    return c.go;
  }

  // A param value from the panel or the URL: numbers and numeric strings count, anything else
  // (missing, empty, NaN) falls back to the default; the result is clamped to the param's range.
  function resolve(key, v) {
    var s = SPEC[key];
    var n = typeof v === "number" ? v : (typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
    if (!isFinite(n)) return s.value;
    return Math.max(s.min, Math.min(s.max, n));
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

  // A round star sprite: bright core, soft glow (dark theme) or a tight dot (light theme).
  function makeSprite(rCss, glowCss, rgb, soft, dpr) {
    var R = Math.max(1, glowCss * dpr);
    var size = Math.ceil(R * 2) + 2;
    var c = document.createElement("canvas");
    c.width = c.height = size;
    var g = c.getContext("2d");
    var mid = size / 2;
    var core = Math.min(0.9, rCss / glowCss);
    var grad = g.createRadialGradient(mid, mid, 0, mid, mid, R);
    grad.addColorStop(0, rgba(rgb, 1));
    grad.addColorStop(core, rgba(rgb, soft ? 0.8 : 0.9));
    if (soft) grad.addColorStop(Math.min(0.95, core * 2), rgba(rgb, 0.22));
    grad.addColorStop(1, rgba(rgb, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return c;
  }

  // A shooting star's trail, drawn once: transparent tail on the left, white head on the right,
  // soft top and bottom edges. It is scaled and rotated at draw time.
  function makeStreak(tail) {
    var c = document.createElement("canvas");
    c.width = 256; c.height = 8;
    var g = c.getContext("2d");
    var grad = g.createLinearGradient(0, 0, 256, 0);
    grad.addColorStop(0, rgba(tail, 0));
    grad.addColorStop(0.6, rgba(tail, 0.25));
    grad.addColorStop(0.92, rgba(WHITE, 0.8));
    grad.addColorStop(1, rgba(WHITE, 1));
    g.fillStyle = grad;
    g.globalAlpha = 0.25; g.fillRect(0, 1, 256, 6);
    g.globalAlpha = 0.55; g.fillRect(0, 2, 256, 4);
    g.globalAlpha = 1;    g.fillRect(0, 3, 256, 2);
    return c;
  }

  function listen(mq, fn) {
    if (!mq) return;
    if (mq.addEventListener) mq.addEventListener("change", fn); else if (mq.addListener) mq.addListener(fn);
  }
  function unlisten(mq, fn) {
    if (!mq) return;
    if (mq.removeEventListener) mq.removeEventListener("change", fn); else if (mq.removeListener) mq.removeListener(fn);
  }

  function start(canvas, values) {
    var ctx = canvas && canvas.getContext ? canvas.getContext("2d") : null;
    if (!ctx) return { pause: noop, resume: noop, stop: noop, set: noop, lightFriendly: true };

    var root = document.documentElement;
    var reduceMq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    var darkMq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

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
    var rafId = 0, lastTs = 0, resizeTimer = 0;
    var t = 0;                                   // animation clock (s): advances only while running
    var shift = scrollTop() * vals.parallax;     // eased scrollY × parallax: what the layers move by
    var W = 0, H = 0, Wf = 1, Hf = 1, dpr = 1, small = false;
    var dark = true, share = 1;
    var tints = [WHITE, BLUE_WHITE];
    var streak = null;
    var ink = null, inkCtx = null;               // light theme: offscreen ink layer, composited once

    // Star data lives in typed arrays sized once for the densest setting: the frame loop allocates
    // nothing. x and y are normalised (0..1) over the star field (the viewport plus MARGIN), so a
    // resize maps every star proportionally onto the new size. seeded counts the initialised
    // stars: lowering the density keeps them, so raising it again brings the same stars back.
    var layers = LAYERS.map(function (p) {
      var cap = Math.ceil(CAP * DENSITY_MAX * p.share) + 1;
      return {
        p: p, n: 0, seeded: 0, cap: cap, ox: 0, oy: 0, spr: [null, null], half: 0,
        x: new Float32Array(cap), y: new Float32Array(cap), base: new Float32Array(cap),
        amp: new Float32Array(cap), freq: new Float32Array(cap), phase: new Float32Array(cap),
        tint: new Uint8Array(cap)
      };
    });

    // Per-frame draw list, sized once: device position and sort key (layer, tint, alpha bucket) of
    // each star to draw, the drawing order, and the counting sort's bucket starts.
    var KEYS = LAYERS.length * 2 * BUCKETS;
    var listCap = 0;
    layers.forEach(function (L) { listCap += L.cap; });
    var dX = new Float32Array(listCap), dY = new Float32Array(listCap);
    var dK = new Uint16Array(listCap), order = new Uint16Array(listCap);
    var starts = new Uint16Array(KEYS + 1);
    var spriteGen = 0, bitmaps = null;           // ImageBitmap copies of the current sprites, once ready

    var shoot = { active: false, x: 0, y: 0, cos: 1, sin: 0, v: 0, age: 0, life: 1, len: 100, next: 0 };
    // Between sky ticks only a flying shooting star moves (see renderStreak): the box it left on
    // the canvas, the box streakBox() computed and its look, the stars of the last full frame, and
    // the sky time those streak-only frames still owe.
    var sbOn = false, sbx0 = 0, sby0 = 0, sbx1 = 0, sby1 = 0;
    var NBX0 = 0, NBY0 = 0, NBX1 = 0, NBY1 = 0, SENV = 0, SLEN = 0;
    var listN = 0, skyDt = 0;

    // ---- Theme: colours come from the page tokens; the brightness of --bg decides dark vs light ----
    function readTheme() {
      var cs = window.getComputedStyle(root);
      var bg = toRgb(cs.getPropertyValue("--bg").trim(), LIGHT_DEFAULTS.bg);
      var inkRgb = toRgb(cs.getPropertyValue("--ink").trim(), LIGHT_DEFAULTS.ink);
      var muted = toRgb(cs.getPropertyValue("--muted").trim(), LIGHT_DEFAULTS.muted);
      var accent = toRgb(cs.getPropertyValue("--accent").trim(), LIGHT_DEFAULTS.accent);
      dark = luminance(bg) < 0.45;
      share = dark ? 1 : LIGHT_SHARE;
      // Dark: white and a soft blue-white with a whisper of the accent. Light: ink and muted dots.
      tints = dark ? [WHITE, mix(BLUE_WHITE, accent, 0.12)] : [inkRgb, muted];
    }

    function buildSprites() {
      layers.forEach(function (L) {
        var p = L.p;
        for (var k = 0; k < 2; k++) {
          L.spr[k] = dark ? makeSprite(p.r, p.glow, tints[k], true, dpr)
                          : makeSprite(p.r * 1.3, p.r * 2.2, tints[k], false, dpr);
        }
        L.half = L.spr[0].width / 2;
      });
      streak = dark ? makeStreak(tints[1]) : null;
      releaseBitmaps();   // the old copies are no longer drawn: the canvases above replace them
      upgradeSprites();
    }

    // The canvases draw at once; ImageBitmap copies (a cheaper drawImage source, same pixels) take
    // over when they resolve, unless the sprites were rebuilt or the sky stopped meanwhile.
    function releaseBitmaps() {
      if (!bitmaps) return;
      for (var i = 0; i < bitmaps.length; i++) if (bitmaps[i] && bitmaps[i].close) bitmaps[i].close();
      bitmaps = null;
    }
    function upgradeSprites() {
      var gen = ++spriteGen;
      if (typeof window.createImageBitmap !== "function" || typeof Promise === "undefined") return;
      var jobs = [];
      try {
        layers.forEach(function (L) { jobs.push(window.createImageBitmap(L.spr[0]), window.createImageBitmap(L.spr[1])); });
      } catch (e) { return; }
      Promise.all(jobs).then(function (bmps) {
        if (gen !== spriteGen || stopped) {
          for (var i = 0; i < bmps.length; i++) if (bmps[i] && bmps[i].close) bmps[i].close();
          return;
        }
        bitmaps = bmps;
        layers.forEach(function (L, l) { L.spr[0] = bmps[2 * l]; L.spr[1] = bmps[2 * l + 1]; });
      }, noop);
    }

    // The ink layer exists only on the light theme and always matches the main bitmap.
    function inkLayer() {
      if (!ink) {
        ink = document.createElement("canvas");
        inkCtx = ink.getContext("2d");
        if (!inkCtx) { ink = null; return null; }
      }
      if (ink.width !== canvas.width || ink.height !== canvas.height) {
        ink.width = canvas.width;
        ink.height = canvas.height;
      }
      return inkCtx;
    }
    function dropInk() { if (ink) { ink.width = ink.height = 0; } }

    // ---- Stars: seeded per layer; a bigger field or a higher density adds stars ----
    function seedStar(L, i) {
      var p = L.p;
      L.x[i] = Math.random();
      L.y[i] = Math.random();
      L.base[i] = rand(p.a);
      L.amp[i] = rand(p.amp);
      L.freq[i] = rand(p.freq);
      L.phase[i] = Math.random() * Math.PI * 2;
      L.tint[i] = Math.random() < 0.32 ? 1 : 0;
    }

    function reseed() {
      var k = vals.density;
      var total = Math.round(Wf * Hf / (small ? AREA_SMALL : AREA) * k);
      total = Math.max(Math.round(MIN_STARS * k), Math.min(Math.round((small ? CAP_SMALL : CAP) * k), total));
      layers.forEach(function (L) {
        var n = Math.min(L.cap, Math.round(total * L.p.share));
        for (var i = L.seeded; i < n; i++) seedStar(L, i);
        if (n > L.seeded) L.seeded = n;
        L.n = n;
      });
    }

    function applySize(force) {
      var w = canvas.clientWidth || window.innerWidth || 0;
      var h = canvas.clientHeight || window.innerHeight || 0;
      var d = Math.min(window.devicePixelRatio || 1, DPR_CAP);
      if (!force && w === W && h === H && d === dpr) return;
      var dprChanged = d !== dpr;
      // A phone's toolbar sliding only changes the height a little: keep the field (and every star
      // where it is), growing it only if the viewport now reaches past it. Anything else re-fits.
      var toolbarOnly = !force && !dprChanged && w === W && H > 0 && Math.abs(h - H) < H * HEIGHT_SLACK;
      W = w; H = h; dpr = d; small = W < 640;
      if (!toolbarOnly) {
        Wf = W + 2 * MARGIN; Hf = H + 2 * MARGIN;
        reseed();
      } else if (H + 2 * MARGIN > Hf) {
        Hf = H + 2 * MARGIN;
        reseed();
      }
      canvas.width = Math.max(1, Math.round(W * dpr));
      canvas.height = Math.max(1, Math.round(H * dpr));
      if (force || dprChanged) buildSprites();
      render(); // resizing clears the bitmap: repaint now, even when paused
    }

    // ---- Shooting star: one at a time, "shooting" per minute of running time on average ----
    // At 1 per minute the gap is 40-80 s, as before; 0 means none.
    function scheduleShoot() {
      shoot.next = vals.shooting > 0 ? t + lerp(SHOOT_MIN, SHOOT_MAX, Math.random()) / vals.shooting : Infinity;
    }

    function spawnShoot() {
      var dir = Math.random() < 0.5 ? -1 : 1;           // heading left or right
      var ang = lerp(0.12, 0.3, Math.random());         // radians below the horizon: shallow, stays up high
      shoot.cos = Math.cos(ang) * dir;
      shoot.sin = Math.sin(ang);
      shoot.x = W * (dir < 0 ? lerp(0.35, 0.95, Math.random()) : lerp(0.05, 0.65, Math.random()));
      shoot.y = H * lerp(0.02, 0.14, Math.random());    // the top band only, away from the reading
      shoot.v = lerp(380, 560, Math.random()) * (small ? 0.75 : 1);
      shoot.life = lerp(0.8, 1.2, Math.random());
      shoot.len = lerp(90, 150, Math.random()) * (small ? 0.7 : 1);
      shoot.age = 0;
      shoot.active = true;
    }

    function stepShoot(dt) {
      if (shoot.active) {
        shoot.age += dt;
        shoot.x += shoot.cos * shoot.v * dt;
        shoot.y += shoot.sin * shoot.v * dt;
        if (shoot.age >= shoot.life) { shoot.active = false; scheduleShoot(); }
      } else if (t >= shoot.next) {
        if (dark) spawnShoot(); else scheduleShoot();
      }
    }

    function cancelShoot() {
      if (shoot.active) { shoot.active = false; scheduleShoot(); }
    }

    // What the shooting star looks like right now, and the whole-pixel box (device px) it covers.
    // False when there is nothing to draw.
    function streakBox() {
      if (!shoot.active || !dark || reduced || !streak) return false;
      var k = shoot.age / shoot.life;
      SENV = Math.sin(Math.PI * k);                     // fades in and out: never a flash
      SLEN = shoot.len * Math.min(1, k / 0.35) * dpr;   // the trail grows as the star moves
      if (SENV <= 0 || SLEN < 1) return false;
      var hx = shoot.x * dpr, hy = shoot.y * dpr, tx = hx - shoot.cos * SLEN, ty = hy - shoot.sin * SLEN;
      var pad = Math.max(STREAK_H * dpr / 2, layers[2].half) + 2; // head sprite or trail edge, plus filtering
      NBX0 = Math.floor(Math.min(hx, tx) - pad); NBX1 = Math.ceil(Math.max(hx, tx) + pad);
      NBY0 = Math.floor(Math.min(hy, ty) - pad); NBY1 = Math.ceil(Math.max(hy, ty) + pad);
      return true;
    }

    function drawShoot() {
      if (!streakBox()) return;
      var env = SENV, len = SLEN;
      var hx = shoot.x * dpr, hy = shoot.y * dpr, th = STREAK_H * dpr;
      // Rotate so local +x is the direction of travel: the head sits at the origin, the trail behind it.
      ctx.setTransform(shoot.cos, shoot.sin, -shoot.sin, shoot.cos, hx, hy);
      ctx.globalAlpha = env * 0.7;
      ctx.drawImage(streak, -len, -th / 2, len, th);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      var N = layers[2];
      ctx.globalAlpha = env * 0.85;
      ctx.drawImage(N.spr[0], hx - N.half, hy - N.half);
      sbOn = true; sbx0 = NBX0; sby0 = NBY0; sbx1 = NBX1; sby1 = NBY1;
    }

    // ---- Frame: advance the clock, then paint every layer back to front ----
    // How far the eased parallax still is from scroll, in scrollY × parallax units. The glide gets
    // full rate only while it is big enough to judder at 30 fps: once the near layer is within
    // LAG_PX of where scroll puts it, the eased remainder moves it ≤ 0.5 px a frame at 30 fps.
    function glideGap() {
      return Math.abs(scrollTop() * vals.parallax - shift);
    }

    // The sky: clock, drift and parallax. The shooting star steps on its own (it may run between ticks).
    function stepSky(dt) {
      t += dt;
      var drift = vals.speed * dt;
      for (var l = 0; l < layers.length; l++) {
        var L = layers[l];
        L.ox += DRIFT_X * L.p.speed * drift;
        L.oy += DRIFT_Y * L.p.speed * drift;
      }
      // Eased, so an anchor jump (or a new parallax strength) glides instead of snapping.
      shift += (scrollTop() * vals.parallax - shift) * (1 - Math.exp(-SCROLL_EASE * dt));
    }

    function render() {
      var l, i, k, p, L, n, ox, oy, half, px, py, a, depth, key0, m = 0;
      var tw = vals.twinkle, yMax = H + 2 * MARGIN, cw = canvas.width, ch = canvas.height;
      var aMin = dark ? 0.008 : 0.008 / LIGHT_ALPHA; // below this a star's final alpha is invisible
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      sbOn = false; listN = 0;
      // Dark: stars go straight onto the canvas. Light: onto the ink layer at relative alpha (≤ 1
      // per pixel however they overlap), then that layer lands once at LIGHT_ALPHA.
      var g = dark ? ctx : inkLayer();
      if (!g) return;
      if (g !== ctx) {
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalAlpha = 1;
        g.clearRect(0, 0, ink.width, ink.height);
      }
      // 1) Where each visible star lands and its key: layer, then tint, then alpha bucket.
      starts.fill(0);
      for (l = 0; l < layers.length; l++) {
        L = layers[l];
        n = share === 1 ? L.n : Math.ceil(L.n * share);
        ox = L.ox;
        oy = L.oy - shift * L.p.par;
        half = L.half; key0 = l * 2 * BUCKETS;
        for (i = 0; i < n; i++) {
          py = (L.y[i] * Hf + oy) % Hf; if (py < 0) py += Hf;
          if (py > yMax) continue; // the part of a toolbar-grown field below the viewport
          px = (L.x[i] * Wf + ox) % Wf; if (px < 0) px += Wf;
          // Twinkle: a slow sine on alpha with its own speed and phase per star.
          depth = L.amp[i] * tw; if (depth > TWINKLE_DEPTH_MAX) depth = TWINKLE_DEPTH_MAX;
          a = L.base[i] * (1 - depth * (0.5 + 0.5 * Math.sin(t * L.freq[i] + L.phase[i])));
          if (a < aMin) continue;
          px = (px - MARGIN) * dpr - half;
          py = (py - MARGIN) * dpr - half;
          if (px < -2 * half || py < -2 * half || px > cw || py > ch) continue; // wrapped into the margin, fully off the bitmap
          k = (a * BUCKETS) | 0; if (k >= BUCKETS) k = BUCKETS - 1;
          k += key0 + (L.tint[i] ? BUCKETS : 0);
          dX[m] = px;
          dY[m] = py;
          dK[m] = k;
          starts[k + 1]++;
          m++;
        }
      }
      // 2) Counting sort (stable, so the layers keep their back-to-front order).
      for (k = 1; k <= KEYS; k++) starts[k] += starts[k - 1];
      for (i = 0; i < m; i++) order[starts[dK[i]]++] = i;
      // 3) Draw: sprite and alpha change only where the key does.
      var cur = -1, spr = null;
      for (p = 0; p < m; p++) {
        i = order[p]; k = dK[i];
        if (k !== cur) {
          cur = k;
          spr = layers[(k / (2 * BUCKETS)) | 0].spr[((k / BUCKETS) | 0) & 1];
          g.globalAlpha = ((k % BUCKETS) + 0.5) / BUCKETS;
        }
        g.drawImage(spr, dX[i], dY[i]);
      }
      listN = m;
      g.globalAlpha = 1;
      if (g !== ctx) {
        ctx.globalAlpha = LIGHT_ALPHA;
        ctx.drawImage(ink, 0, 0);
      }
      drawShoot();
      ctx.globalAlpha = 1;
    }

    // A frame between two sky ticks while a shooting star flies (dark theme): the stars have not
    // moved, so only the streak's old and new boxes are repainted: cleared, the stars that touch
    // them redrawn from the last full frame's list in the same order and alpha, then the streak.
    // Those pixels match a full frame of the same state; the rest of the canvas is untouched.
    function renderStreak() {
      var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      if (sbOn) { x0 = sbx0; y0 = sby0; x1 = sbx1; y1 = sby1; }
      if (streakBox()) {
        if (NBX0 < x0) x0 = NBX0;
        if (NBY0 < y0) y0 = NBY0;
        if (NBX1 > x1) x1 = NBX1;
        if (NBY1 > y1) y1 = NBY1;
      }
      sbOn = false;
      if (x0 < 0) x0 = 0;
      if (y0 < 0) y0 = 0;
      if (x1 > canvas.width) x1 = canvas.width;
      if (y1 > canvas.height) y1 = canvas.height;
      if (!(x1 > x0 && y1 > y0)) return;       // nothing of it was or is on the canvas
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.beginPath();
      ctx.rect(x0, y0, x1 - x0, y1 - y0);      // whole pixels: no half-cleared seam at the edge
      ctx.clip();
      ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
      var cur = -1, p, i, k, L, x, y, w;
      for (p = 0; p < listN; p++) {
        i = order[p]; k = dK[i]; x = dX[i]; y = dY[i];
        L = layers[(k / (2 * BUCKETS)) | 0]; w = 2 * L.half;
        if (x + w <= x0 || y + w <= y0 || x >= x1 || y >= y1) continue;
        if (k !== cur) { cur = k; ctx.globalAlpha = ((k % BUCKETS) + 0.5) / BUCKETS; }
        ctx.drawImage(L.spr[((k / BUCKETS) | 0) & 1], x, y);
      }
      drawShoot();
      ctx.restore();
    }

    function frame(ts) {
      rafId = 0;
      if (!running) return;
      rafId = window.requestAnimationFrame(frame);
      var flying = shoot.active, gap = glideGap(), lag = gap * NEAR_PAR > LAG_PX;
      var tick = due(ts);                        // asked every frame, so the shared clock stays current
      if (!tick && !lag && !flying) return;      // ~30 fps while only drifting, on the shared ticks
      var dt = lastTs ? (ts - lastTs) / 1000 : 0;
      lastTs = ts;
      if (dt > MAX_DT) dt = MAX_DT; else if (dt < 0) dt = 0;
      if (tick || lag || !dark) {
        // The sky moves (a tick, or the parallax catching up at full rate): a whole frame.
        var sky = skyDt + dt;
        skyDt = 0;
        stepSky(sky > MAX_DT ? MAX_DT : sky);
        stepShoot(dt);
        // With drift and twinkle both at 0 the sky is still: the clock keeps ticking (the next
        // shooting star is due on time) but only a moving frame (a glide included) is repainted.
        if (gap > 0.5 || flying || shoot.active || vals.speed > 0 || vals.twinkle > 0) render();
      } else {
        // Between ticks only the shooting star moves: it keeps full rate, the stars keep 30 fps.
        skyDt += dt;
        stepShoot(dt);
        renderStreak();
      }
    }

    // ---- Run state: one place decides whether the loop runs ----
    function shouldRun() {
      return !stopped && !reduced && !userPaused && !document.hidden &&
        root.getAttribute("data-motion") !== "off";
    }

    function sync() {
      var run = shouldRun();
      if (run && !running) {
        running = true;
        lastTs = 0;
        skyDt = 0;
        rafId = window.requestAnimationFrame(frame);
      } else if (!run && running) {
        running = false;
        if (rafId) window.cancelAnimationFrame(rafId);
        rafId = 0;
        cancelShoot();
        if (!stopped) render(); // leave a clean, complete still frame (no frozen streak)
      }
    }

    // ---- Live params: no restart, no blank frame; a still sky repaints once with the new value ----
    function set(key, value) {
      if (stopped || !Object.prototype.hasOwnProperty.call(SPEC, key)) return;
      var v = resolve(key, value);
      if (v === vals[key]) return;
      vals[key] = v;
      if (key === "density") reseed();                        // adds (or hides) stars; the rest stay put
      else if (key === "shooting" && !shoot.active) scheduleShoot();
      else if (key === "parallax" && !running) shift = scrollTop() * v; // a running loop glides there
      render();
    }

    // ---- Listeners ----
    function resizeNow() { resizeTimer = 0; applySize(false); }
    function onResize() {
      if (resizeTimer) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(resizeNow, RESIZE_DEBOUNCE);
    }

    function onTheme() {
      readTheme();
      buildSprites();
      if (dark) dropInk();
      else cancelShoot();
      render(); // repaint now: a still sky (paused, reduced, or drift and twinkle at 0) has no next frame
    }

    function onReduce() {
      reduced = isReduced();
      if (reduced) cancelShoot();
      sync();
      if (reduced) render();
    }

    // The site's motion switch (data-motion), theme button (data-theme) and the panel's
    // preview-motion override (data-preview-motion) all live on <html>.
    var mo = window.MutationObserver ? new window.MutationObserver(function (records) {
      var theme = false, preview = false;
      for (var i = 0; i < records.length; i++) {
        if (records[i].attributeName === "data-theme") theme = true;
        else if (records[i].attributeName === "data-preview-motion") preview = true;
      }
      if (theme) onTheme();
      if (preview) onReduce(); else sync();
    }) : null;

    // ---- Boot ----
    // The integrator sizes the canvas with CSS. If it is still at the 300x150 default, its layout
    // size would follow the bitmap we set and grow on every resize: pin it to the viewport instead.
    if (canvas.clientWidth === 300 && canvas.clientHeight === 150 && !canvas.style.width) {
      canvas.style.width = "100%";
      canvas.style.height = "100%";
    }
    readTheme();
    applySize(true);   // sizes the bitmap, seeds the stars, builds sprites, paints the first frame
    scheduleShoot();
    window.addEventListener("resize", onResize, { passive: true });
    document.addEventListener("visibilitychange", sync);
    listen(reduceMq, onReduce);
    listen(darkMq, onTheme);
    if (mo) mo.observe(root, { attributes: true, attributeFilter: ["data-theme", "data-motion", "data-preview-motion"] });
    sync();            // reduced motion never gets past here: the first frame is the finished state

    return {
      lightFriendly: true, // the light theme is handled: faint ink dots under the 22% ceiling, no shooting stars
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
        window.removeEventListener("resize", onResize, { passive: true });
        document.removeEventListener("visibilitychange", sync);
        unlisten(reduceMq, onReduce);
        unlisten(darkMq, onTheme);
        if (mo) mo.disconnect();
        spriteGen++;       // a pending ImageBitmap upgrade is discarded when it lands
        releaseBitmaps();
        dropInk();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    };
  }

  window.PortfolioBG = window.PortfolioBG || {};
  window.PortfolioBG["starfield"] = {
    label: "Estrellas",
    layer: "bg",
    themes: ["dark"],
    params: PARAMS,
    start: start
  };
})();
