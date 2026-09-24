// Ships overlay: a few small fleets wander across the page. Each fleet has a leader that follows
// smooth, noise-driven headings and banks gently into turns; followers hold V or echelon slots on
// spring-dampers, so the formation flexes through a turn (formation 0 loosens it into a swarm).
// Fleets fly in and out through the edges, and now and then one warps out in a brief streak while
// another warps in later. On wide screens they steer gently away from the reading column and keep
// to the margins; on phones they may cross it.
//
// Background module contract v2: registers window.PortfolioBG.ships = { label, layer: "overlay",
// themes, params, start(canvas, values) }; start() returns { pause(), resume(), stop(),
// set(key, value), lightFriendly }. It follows the site's single motion switch
// (<html data-motion="off|on">), pauses in hidden tabs, and under reduced motion (the OS setting,
// unless <html data-preview-motion="force">) it draws one complete static frame (fleets in
// formation, no trails) and never starts the loop. set() applies live: no restart, no intro
// replay, no blank frame; while the loop is stopped it repaints one finished frame at once.
//
// Light ceiling (ink alpha <= 0.22 per final pixel, overlaps included): every light-theme shape is
// ink, drawn into an offscreen layer at relative alpha <= 1 (source-over keeps any stack <= 1), and
// the layer is composited ONCE onto the cleared canvas at LIGHT_CEIL. Nothing else is drawn there,
// so hulls, trails and warp streaks can overlap freely and no pixel passes the ceiling.
(function () {
  "use strict";

  var TAU = Math.PI * 2;
  var DPR_CAP = 1.5;
  var RESIZE_DEBOUNCE = 150;          // ms
  var HEIGHT_SLACK = 0.2;             // a phone's toolbar sliding (height change < 20%) moves nothing
  var FRAME_MS = 1000 / 30;           // ~30 fps
  var MAX_DT = 0.05;                  // s: a long frame (tab switch, jank) never makes a fleet jump
  var SUB_DT = 0.034;                 // s of simulated time per integration step (fast speeds substep)
  var FADE_IN = 0.7;                  // s: calm first appearance when the loop starts; never on set()
  var SHIP_FADE = 2.5;                // 1/s: ships added or removed by "Naves por flota" fade in or out

  var MAX_FLEETS = 6, MAX_PER = 12, MAX_SHIPS = MAX_FLEETS * MAX_PER;   // 72 ships at most
  var BASE_LEN = 13;                  // CSS px: a follower's length at size 1 (leaders: x LEAD_SCALE)
  var LEAD_SCALE = 1.25;
  var REAR = 0.34;                    // the engine sits this share of a length behind the pivot
  var GLOW_R = 0.5;                   // engine glow radius, in ship lengths (dark theme only)
  var BANK_SQUASH = 0.28;             // a full bank narrows the silhouette by this share
  var BANK_RATE = 0.55;               // rad/s of turn that counts as a full bank

  // Leader flight (CSS px, simulated seconds; the speed param scales simulated time)
  var SPEED_MIN = 34, SPEED_MAX = 58; // px/s: a laptop screen (1440 px) takes 25-42 s straight across
  var SMALL_SPEED = 0.75;             // phones: a little slower, the screen is short
  var WANDER = 0.32;                  // rad/s: peak noise turn rate (turn radius >= ~110 px)
  var STEER = 0.9;                    // 1/s: how hard a push (walls, column, exit) turns the heading
  var MAX_TURN = 0.75;                // rad/s
  var TURN_EASE = 2.5;                // 1/s: commanded turn rate -> actual, so banking is smooth
  var LOOKAHEAD = 1.6;                // s: steering reacts to where the leader will be
  var EDGE_INSET = 70, EDGE_INSET_SMALL = 40; // px: the soft wall that keeps a roaming fleet in view
  var COLUMN = 1080;                  // px: the reading column
  var COL_HALF = 570;                 // px: half of it plus a small buffer
  var COL_RAMP = 160;                 // px: the push grows over this depth inside the column
  var STAY_MIN = 16, STAY_MAX = 40;   // s in view before a fleet heads for an edge
  var OFF_MIN = 3, OFF_MAX = 10;      // s off screen before it comes back
  var WARP_OUT_CHANCE = 0.2;          // share of visits that end in a warp instead of an edge
  var WARP_IN_CHANCE = 0.2;           // share of returns that warp in (3 fleets: about one warp a minute)

  // Followers
  var GAP_BACK = 1.0, GAP_LAT = 0.9;  // tight V slot spacing, in follower lengths
  var LOOSE_GAP = 0.7;                // extra spacing at formation 0
  var K_TIGHT = 2.2, K_LOOSE = 0.8;   // rad/s: spring natural frequency at formation 1 and 0
  var ZETA = 0.72;                    // damping ratio: a touch of overshoot, so a turn flexes the V
  var SEP = 0.95;                     // follower lengths: closer than this, ships ease apart
  var SEP_K = 70;                     // px/s² at full overlap

  // Trails: distance-sampled ring buffers, drawn as NB buckets of falling alpha and width
  // (one stroke per bucket for all ships together, not one per segment).
  var TRAIL_PTS = 24, TRAIL_GAP = 4.5, NB = 5;   // at size 1 and trails 1: ~108 px behind each ship

  // Warp: a short charge (the engine brightens), then the ship leaps along its heading as a streak.
  var CHARGE = 0.35, WARP_T = 0.7, WARP_IN_T = 0.8;  // s
  var WARP_DIST = 280, WARP_DIST_SMALL = 180;        // px
  var ROW_DELAY = 0.045;                             // s per row: the V goes from the tip back
  var STREAK_H = 3;                                  // CSS px at size 1

  // Per-theme strength. Light values are RELATIVE (<= 1) inside the ink layer.
  var LIGHT_CEIL = 0.22;
  var DARK = { trail: 0.34, trailW: 1.1, glow: 0.62, streak: 0.8 };
  var LIGHT = { hull: 0.9, trail: 0.55, trailW: 0.9, streak: 0.85 };

  // Fleet states and ways to (re)appear
  var OFF = 0, FLY = 1, WARP_OUT = 2, WARP_IN = 3;
  var HOW_EDGE = 0, HOW_WARP = 1, HOW_PLACE = 2;

  // Params shown by the preview panel. "value" is the default; start() and set() clamp to [min, max].
  var PARAMS = [
    { key: "fleets", label: "Flotas", min: 1, max: 6, step: 1, value: 3, unit: "" },
    { key: "perFleet", label: "Naves por flota", min: 1, max: 12, step: 1, value: 5, unit: "" },
    { key: "speed", label: "Velocidad", min: 0.2, max: 3, step: 0.05, value: 1, unit: "×" },
    { key: "size", label: "Tamaño", min: 0.6, max: 2, step: 0.05, value: 1, unit: "×" },
    { key: "trails", label: "Estela", min: 0, max: 1, step: 0.05, value: 0.6, unit: "" },
    { key: "formation", label: "Formación", min: 0, max: 1, step: 0.05, value: 0.7, unit: "" }
  ];
  // Private copy of the bounds, so a panel that writes into PARAMS cannot move the defaults.
  var SPEC = {};
  PARAMS.forEach(function (p) { SPEC[p.key] = { min: p.min, max: p.max, value: p.value, whole: p.step === 1 }; });

  var WHITE = [255, 255, 255];
  var LIGHT_DEFAULTS = { bg: [247, 246, 243], ink: [28, 28, 26], accent: [14, 107, 97] };

  // The hull, nose along +x, in ship lengths: a slim wedge with swept-back fins and a notched tail.
  // Listed for the +y side from the nose to the tail notch; the -y side is its mirror.
  var HULL = [0.52, 0, 0.1, 0.085, -0.1, 0.12, -0.46, 0.33, -0.36, 0.15, -0.34, 0.075, -0.28, 0];

  function noop() {}
  function lerp(a, b, k) { return a + (b - a) * k; }
  function rand(a, b) { return a + (b - a) * Math.random(); }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function smooth(e0, e1, x) { var k = clamp((x - e0) / (e1 - e0), 0, 1); return k * k * (3 - 2 * k); }
  function wrap(a) { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; }
  function mix(a, b, k) { return [Math.round(lerp(a[0], b[0], k)), Math.round(lerp(a[1], b[1], k)), Math.round(lerp(a[2], b[2], k))]; }
  function rgba(c, alpha) { return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + alpha + ")"; }
  function luminance(c) { return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255; }
  function media(q) { return window.matchMedia ? window.matchMedia(q) : null; }

  // One 30 fps decision per display frame, shared on window with every layer that paces itself
  // this way (the starfield does): the canvases then repaint on the same display frames, so the
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
  function resolve(key, value) {
    var s = SPEC[key];
    var n = typeof value === "number" ? value :
      (typeof value === "string" && value.trim() !== "" ? Number(value) : NaN);
    if (!isFinite(n)) n = s.value;
    n = clamp(n, s.min, s.max);
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

  // ---- Sprites: drawn once per theme, size and DPR; the frame loop only rotates them ----
  function hullPath(g, L) {
    g.beginPath();
    g.moveTo(HULL[0] * L, 0);
    for (var i = 2; i < HULL.length; i += 2) g.lineTo(HULL[i] * L, HULL[i + 1] * L);
    for (i = HULL.length - 4; i >= 2; i -= 2) g.lineTo(HULL[i] * L, -HULL[i + 1] * L);
    g.closePath();
  }

  // Dark: a pale hull lit from one side with a dim accent canopy. Light: a flat ink silhouette with
  // the canopy cut out as a lighter window (still pure ink, only less of it).
  function makeHull(lenCss, dpr, dark, col) {
    var L = lenCss * dpr;
    var w = Math.ceil(L * 1.08) + 4, h = Math.ceil(L * 0.7) + 4;
    var c = document.createElement("canvas");
    c.width = w; c.height = h;
    var g = c.getContext("2d");
    g.translate(w / 2, h / 2);
    hullPath(g, L);
    if (dark) {
      var grad = g.createLinearGradient(0, -0.33 * L, 0, 0.33 * L);
      grad.addColorStop(0, rgba(col.hi, 1));
      grad.addColorStop(1, rgba(col.lo, 1));
      g.fillStyle = grad;
      g.fill();
      g.fillStyle = rgba(col.canopy, 1);
    } else {
      g.fillStyle = rgba(col.ink, LIGHT.hull);
      g.fill();
      g.globalCompositeOperation = "destination-out";
      g.fillStyle = "rgba(0,0,0,0.5)";
    }
    g.save();
    g.translate(0.14 * L, 0);
    g.scale(1, 0.42);
    g.beginPath();
    g.arc(0, 0, 0.1 * L, 0, TAU);
    g.restore();
    g.fill();
    return c;
  }

  // Engine glow (dark theme): an accent halo with a paler core, added with "lighter".
  function makeGlow(rCss, dpr, core, edge) {
    var R = Math.max(2, rCss * dpr);
    var size = Math.ceil(R * 2) + 2, m = size / 2;
    var c = document.createElement("canvas");
    c.width = c.height = size;
    var g = c.getContext("2d");
    var grad = g.createRadialGradient(m, m, 0, m, m, R);
    grad.addColorStop(0, rgba(core, 1));
    grad.addColorStop(0.3, rgba(edge, 0.55));
    grad.addColorStop(1, rgba(edge, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return c;
  }

  // A warp streak, drawn once: transparent tail on the left, solid head on the right, soft top and
  // bottom edges (every pixel alpha <= 1). It is scaled and rotated at draw time.
  function makeStreak(tail, head) {
    var c = document.createElement("canvas");
    c.width = 256; c.height = 8;
    var g = c.getContext("2d");
    var grad = g.createLinearGradient(0, 0, 256, 0);
    grad.addColorStop(0, rgba(tail, 0));
    grad.addColorStop(0.55, rgba(tail, 0.28));
    grad.addColorStop(0.9, rgba(head, 0.8));
    grad.addColorStop(1, rgba(head, 1));
    g.fillStyle = grad;
    g.globalAlpha = 0.25; g.fillRect(0, 1, 256, 6);
    g.globalAlpha = 0.55; g.fillRect(0, 2, 256, 4);
    g.globalAlpha = 1;    g.fillRect(0, 3, 256, 2);
    return c;
  }

  function start(canvas, values) {
    var ctx = canvas && canvas.getContext ? canvas.getContext("2d") : null;
    if (!ctx) return { pause: noop, resume: noop, stop: noop, set: noop, lightFriendly: true };

    var root = document.documentElement;
    var reduceMq = media("(prefers-reduced-motion: reduce)");
    var darkMq = media("(prefers-color-scheme: dark)");
    function isReduced() {
      return !!(reduceMq && reduceMq.matches) && root.getAttribute("data-preview-motion") !== "force";
    }

    // Live param values, resolved once here and then only through set().
    var P = {};
    PARAMS.forEach(function (p) {
      P[p.key] = resolve(p.key, values && typeof values === "object" ? values[p.key] : undefined);
    });

    var reduced = isReduced();
    var userPaused = false, stopped = false, running = false;
    var rafId = 0, lastTs = 0, resizeTimer = 0;
    var clock = 0, fade = 1;                        // real seconds; global fade-in (motion start only)
    var W = 0, H = 0, dpr = 1, small = false, marginW = 0, wideW = 0;
    var dark = true, trailCss = "#fff";
    var col = { ink: LIGHT_DEFAULTS.ink, hi: WHITE, lo: WHITE, canopy: WHITE, glowCore: WHITE, glow: WHITE, sTail: WHITE, sHead: WHITE };
    var hullF = null, hullL = null, glowF = null, glowL = null, streak = null;
    var layer = null, lctx = null;                  // light theme: the ink layer
    var track = false, bx0 = 0, by0 = 0, bx1 = 0, by1 = 0; // CSS px box of this frame's ink

    // ---- Ship state: struct-of-arrays sized once for 72 ships (index = fleet * 12 + slot) ----
    var N = MAX_SHIPS;
    var px = new Float32Array(N), py = new Float32Array(N);      // position (CSS px)
    var vx = new Float32Array(N), vy = new Float32Array(N);      // velocity (px per simulated s)
    var hx = new Float32Array(N), hy = new Float32Array(N);      // displayed heading (unit)
    var bank = new Float32Array(N), alpha = new Float32Array(N); // -1..1; own fade (perFleet changes)
    var kmul = new Float32Array(N);                              // spring stiffness variation
    var swx = new Float32Array(N), swy = new Float32Array(N);    // swarm home offset (in swarm radii)
    var sw1 = new Float32Array(N), sw2 = new Float32Array(N);    // swarm wander frequencies
    var sp1 = new Float32Array(N), sp2 = new Float32Array(N);    // ... and phases
    var wux = new Float32Array(N), wuy = new Float32Array(N);    // heading frozen for a warp
    var live = new Uint8Array(N);
    var tx = new Float32Array(N * TRAIL_PTS), ty = new Float32Array(N * TRAIL_PTS);
    var tHead = new Uint8Array(N), tCount = new Uint8Array(N);
    // Per-frame draw scratch, filled by prepare()
    var dX = new Float32Array(N), dY = new Float32Array(N), dC = new Float32Array(N), dSn = new Float32Array(N);
    var dA = new Float32Array(N), dS = new Float32Array(N), gA = new Float32Array(N);
    var stA = new Float32Array(N), stL = new Float32Array(N), dT = new Uint8Array(N);

    var fleets = [];
    for (var fi = 0; fi < MAX_FLEETS; fi++) {
      fleets.push({
        i: fi, state: OFF, retire: true, quick: false, offT: 0,
        t: 0, age: 0, th: 0, om: 0, speed: 40, n1: 0.1, n2: 0.25, p1: 0, p2: 0,
        type: 0, side: 1, pref: 1, entered: false, leaving: false, inT: 0, stay: 20, warpAt: -1,
        ex: 0, ey: 0, wt: 0
      });
    }

    // Scratch outputs (no per-frame allocation): a slot offset, a trail point, a picked spot.
    var SLX = 0, SLY = 0, TPX = 0, TPY = 0, SPX = 0, SPY = 0, SPT = 0;

    function shipLen(j) { return BASE_LEN * P.size * (j ? 1 : LEAD_SCALE); }
    function rowOf(F, j) { return F.type === 0 ? (j + 1) >> 1 : j; }
    function maxDelay(F) { return rowOf(F, Math.max(0, P.perFleet - 1)) * ROW_DELAY; }

    // ---- Formation: slot j in the leader's frame (x forward, y to the side) ----
    // A blend of the swarm offset (formation 0) and the V or echelon slot (formation 1).
    function slot(F, j) {
      var f = P.formation, L = BASE_LEN * P.size, loose = 1 + LOOSE_GAP * (1 - f);
      var gb = GAP_BACK * L * loose, gl = GAP_LAT * L * loose, ax, ay;
      if (F.type === 0) { var r = (j + 1) >> 1; ax = -r * gb; ay = (j & 1 ? 1 : -1) * r * gl; }
      else { ax = -j * gb * 0.85; ay = F.side * j * gl; }
      var i = F.i * MAX_PER + j, Rs = L * (1.6 + 0.55 * Math.sqrt(P.perFleet));
      var wx = (swx[i] + 0.35 * Math.sin(sw1[i] * F.t + sp1[i])) * Rs;
      var wy = (swy[i] + 0.35 * Math.sin(sw2[i] * F.t + sp2[i])) * Rs;
      SLX = wx + (ax - wx) * f;
      SLY = wy + (ay - wy) * f;
    }

    // ---- Trails: point 0 is the engine right now; 1..n are samples, newest first ----
    function trailPoint(i, k) {
      if (k === 0) {
        var len = REAR * shipLen(i % MAX_PER);
        TPX = px[i] - hx[i] * len; TPY = py[i] - hy[i] * len;
        return;
      }
      var o = i * TRAIL_PTS + (tHead[i] - (k - 1) + TRAIL_PTS) % TRAIL_PTS;
      TPX = tx[o]; TPY = ty[o];
    }

    function sampleTrails() {
      var gap = TRAIL_GAP * P.size, gap2 = gap * gap;
      for (var f = 0; f < MAX_FLEETS; f++) {
        if (fleets[f].state === OFF) continue;
        for (var j = 0; j < MAX_PER; j++) {
          var i = f * MAX_PER + j;
          if (!live[i]) continue;
          trailPoint(i, 0);
          var o = i * TRAIL_PTS;
          if (tCount[i]) {
            var ddx = TPX - tx[o + tHead[i]], ddy = TPY - ty[o + tHead[i]];
            if (ddx * ddx + ddy * ddy < gap2) continue;
            tHead[i] = (tHead[i] + 1) % TRAIL_PTS;
          } else tHead[i] = 0;
          tx[o + tHead[i]] = TPX; ty[o + tHead[i]] = TPY;
          if (tCount[i] < TRAIL_PTS) tCount[i]++;
        }
      }
    }

    // ---- Fleets: seed, place, spawn ----
    function seedFleet(F) {
      F.type = Math.random() < 0.65 ? 0 : 1;          // V, or echelon
      F.side = Math.random() < 0.5 ? -1 : 1;          // echelon side
      F.pref = Math.random() < 0.5 ? -1 : 1;          // margin to take when dead centre
      F.speed = rand(SPEED_MIN, SPEED_MAX) * (small ? SMALL_SPEED : 1);
      F.n1 = rand(0.07, 0.16); F.n2 = rand(0.19, 0.37); F.p1 = rand(0, TAU); F.p2 = rand(0, TAU);
      F.t = rand(0, 60); F.age = 0; F.om = 0; F.wt = 0;
      F.entered = false; F.leaving = false; F.inT = 0;
      F.stay = rand(STAY_MIN, STAY_MAX);
      F.warpAt = Math.random() < WARP_OUT_CHANCE ? F.stay * rand(0.4, 0.85) : -1;
      for (var j = 1; j < MAX_PER; j++) {
        var i = F.i * MAX_PER + j;
        kmul[i] = rand(0.85, 1.15);
        swx[i] = rand(-1.3, 0.3); swy[i] = rand(-1, 1);
        sw1[i] = rand(0.15, 0.35); sw2[i] = rand(0.15, 0.35);
        sp1[i] = rand(0, TAU); sp2[i] = rand(0, TAU);
      }
    }

    // Leader at (x, y) with heading th; followers exactly on their slots, trails empty.
    function placeFleet(F, x, y, th) {
      var c = Math.cos(th), s = Math.sin(th), b = F.i * MAX_PER;
      F.th = th; F.om = 0;
      for (var j = 0; j < MAX_PER; j++) {
        var i = b + j;
        tCount[i] = 0; tHead[i] = 0; bank[i] = 0;
        if (j >= P.perFleet) { live[i] = 0; alpha[i] = 0; continue; }
        live[i] = 1; alpha[i] = 1;
        if (j === 0) { px[i] = x; py[i] = y; }
        else { slot(F, j); px[i] = x + c * SLX - s * SLY; py[i] = y + s * SLX + c * SLY; }
        vx[i] = c * F.speed; vy[i] = s * F.speed; hx[i] = c; hy[i] = s;
        wux[i] = c; wuy[i] = s;
      }
    }

    function outside(x, y) { return x < 8 || x > W - 8 || y < 8 || y > H - 8; }

    // An in-view spot for a placed or warping fleet: the margins on wide screens, anywhere on
    // narrow ones; best of 10 by distance from the other fleets, with the formation fully on screen.
    function pickSpot(F) {
      var best = -Infinity, jA = P.perFleet - 1, jB = Math.max(1, P.perFleet - 2);
      SPX = W / 2; SPY = H / 2; SPT = 0;
      for (var k = 0; k < 10; k++) {
        var x, y, th;
        if (wideW > 0.3) {
          var m = marginW * rand(0.3, 0.7);
          x = Math.random() < 0.5 ? m : W - m;
          th = (Math.random() < 0.5 ? -1 : 1) * Math.PI / 2 + rand(-0.45, 0.45);
        } else {
          x = W * rand(0.18, 0.82);
          th = rand(0, TAU);
        }
        y = H * rand(0.22, 0.78);
        var score = 400;
        for (var o = 0; o < MAX_FLEETS; o++) {
          if (o === F.i || fleets[o].state === OFF) continue;
          var dx = px[o * MAX_PER] - x, dy = py[o * MAX_PER] - y, d = Math.sqrt(dx * dx + dy * dy);
          if (d < score) score = d;
        }
        if (outside(x, y)) score -= 300;
        if (jA > 0) {
          var c = Math.cos(th), s = Math.sin(th);
          slot(F, jA); if (outside(x + c * SLX - s * SLY, y + s * SLX + c * SLY)) score -= 300;
          slot(F, jB); if (outside(x + c * SLX - s * SLY, y + s * SLX + c * SLY)) score -= 300;
        }
        if (score > best) { best = score; SPX = x; SPY = y; SPT = th; }
      }
    }

    // Just outside an edge, heading in. Wide screens: through a side edge angled toward the
    // margin, or through the top or bottom inside a margin. Narrow: any edge, by its length.
    function spawnEdge(F) {
      var x, y, th, out = 24 + shipLen(0);
      if (wideW > 0.3) {
        var left = Math.random() < 0.5;
        if (Math.random() < 0.5) {
          x = left ? -out : W + out;
          y = H * rand(0.15, 0.85);
          var tilt = rand(0.6, 1.2), down = y < 0.3 * H ? 1 : y > 0.7 * H ? -1 : (Math.random() < 0.5 ? -1 : 1);
          th = left ? down * tilt : Math.PI - down * tilt;
        } else {
          var m = marginW * rand(0.25, 0.75), top = Math.random() < 0.5;
          x = left ? m : W - m;
          y = top ? -out : H + out;
          th = (top ? 1 : -1) * Math.PI / 2 + rand(-0.35, 0.35);
        }
      } else {
        var e = Math.random() * 2 * (W + H), a = rand(0.1, 0.9);
        if (e < W) { x = W * a; y = -out; th = Math.PI / 2; }
        else if (e < 2 * W) { x = W * a; y = H + out; th = -Math.PI / 2; }
        else if (e < 2 * W + H) { x = -out; y = H * a; th = 0; }
        else { x = W + out; y = H * a; th = Math.PI; }
        th += rand(-0.7, 0.7);
      }
      placeFleet(F, x, y, th);
      F.state = FLY;
    }

    function spawn(F, how) {
      seedFleet(F);
      F.quick = false;
      if (how === HOW_EDGE) { spawnEdge(F); return; }
      pickSpot(F);
      placeFleet(F, SPX, SPY, SPT);
      F.entered = true;
      if (how === HOW_WARP) { F.state = WARP_IN; F.wt = 0; return; }
      F.state = FLY;
      // A placed fleet has been around a while already, so the first ones do not all leave together.
      F.inT = F.stay * rand(0, 0.6);
      if (F.warpAt >= 0) F.warpAt = F.inT + rand(4, 14);
    }

    function goOff(F) {
      F.state = OFF;
      F.offT = F.quick ? 0.25 : rand(OFF_MIN, OFF_MAX);
      for (var j = 0; j < MAX_PER; j++) tCount[F.i * MAX_PER + j] = 0;
    }

    function startWarpOut(F) {
      F.state = WARP_OUT; F.wt = 0;
      for (var j = 0; j < MAX_PER; j++) { var i = F.i * MAX_PER + j; wux[i] = hx[i]; wuy[i] = hy[i]; }
    }

    // Leave through the edge that is near AND ahead: distance weighted by how much the fleet
    // would have to turn to face it.
    function chooseExit(F) {
      var L = F.i * MAX_PER, x = px[L], y = py[L], c = hx[L], s = hy[L], sc;
      var best = Math.max(0, x) * (1.6 + c); F.ex = -1; F.ey = 0;
      sc = Math.max(0, W - x) * (1.6 - c); if (sc < best) { best = sc; F.ex = 1; F.ey = 0; }
      sc = Math.max(0, y) * (1.6 + s); if (sc < best) { best = sc; F.ex = 0; F.ey = -1; }
      sc = Math.max(0, H - y) * (1.6 - s); if (sc < best) { F.ex = 0; F.ey = 1; }
      F.leaving = true;
    }

    // Every ship, and the far end of its trail, is out of sight.
    function allOut(F) {
      var nTrail = Math.round(P.trails * TRAIL_PTS);
      for (var j = 0; j < MAX_PER; j++) {
        var i = F.i * MAX_PER + j;
        if (!live[i]) continue;
        var pad = shipLen(j);
        if (px[i] > -pad && px[i] < W + pad && py[i] > -pad && py[i] < H + pad) return false;
        var n = Math.min(tCount[i], nTrail);
        if (n) {
          trailPoint(i, n);
          if (TPX > -2 && TPX < W + 2 && TPY > -2 && TPY < H + 2) return false;
        }
      }
      return true;
    }

    // ---- Flight ----
    // The leader turns by smooth noise (two slow sines) plus a steer toward a desired direction:
    // its heading, pushed by the soft walls (or the exit edge) and, on wide screens, away from the
    // reading column. The push acts on a look-ahead point, so turns start early and stay gentle.
    function stepLeader(F, h) {
      var i = F.i * MAX_PER, c = Math.cos(F.th), s = Math.sin(F.th);
      var la = F.speed * LOOKAHEAD, lx = px[i] + c * la, ly = py[i] + s * la, dx = 0, dy = 0;
      if (!F.leaving) {
        var m = small ? EDGE_INSET_SMALL : EDGE_INSET;
        if (lx < m) dx = (m - lx) / m; else if (lx > W - m) dx = (W - m - lx) / m;
        if (ly < m) dy = (m - ly) / m; else if (ly > H - m) dy = (H - m - ly) / m;
        dx = clamp(dx, -1.5, 1.5); dy = clamp(dy, -1.5, 1.5);
      } else { dx = F.ex * 1.2; dy = F.ey * 1.2; }
      if (wideW > 0) {
        var off = lx - W / 2, depth = COL_HALF - Math.abs(off);
        if (depth > 0) {
          var side = off > 2 ? 1 : off < -2 ? -1 : F.pref;
          dx += side * Math.min(1, depth / COL_RAMP) * wideW * 1.1;
        }
      }
      var turn = WANDER * (0.62 * Math.sin(F.n1 * F.t + F.p1) + 0.38 * Math.sin(F.n2 * F.t + F.p2));
      if (dx !== 0 || dy !== 0) {
        var ddx = c + dx, ddy = s + dy;
        if (ddx * ddx + ddy * ddy > 1e-4) turn += STEER * wrap(Math.atan2(ddy, ddx) - F.th);
      }
      turn = clamp(turn, -MAX_TURN, MAX_TURN);
      F.om += (turn - F.om) * Math.min(1, h * TURN_EASE);
      F.th = wrap(F.th + F.om * h);
      c = Math.cos(F.th); s = Math.sin(F.th);
      vx[i] = c * F.speed; vy[i] = s * F.speed;
      px[i] += vx[i] * h; py[i] += vy[i] * h;
      hx[i] = c; hy[i] = s;
      bank[i] += (clamp(F.om / BANK_RATE, -1, 1) - bank[i]) * Math.min(1, h * 3);
    }

    // Followers: a spring-damper toward the slot, with the slot's own velocity fed forward (so a
    // straight flight has no lag and only turns flex the formation), plus a little separation.
    function stepFollowers(F, h) {
      var L = F.i * MAX_PER, c = hx[L], s = hy[L], lx = px[L], ly = py[L], om = F.om;
      var wn = K_LOOSE + (K_TIGHT - K_LOOSE) * P.formation;
      var dmin = SEP * BASE_LEN * P.size, dmin2 = dmin * dmin, ease = Math.min(1, h * 8);
      for (var j = 1; j < MAX_PER; j++) {
        var i = L + j;
        if (!live[i]) continue;
        slot(F, j);
        var rx = c * SLX - s * SLY, ry = s * SLX + c * SLY;
        var w = wn * kmul[i], k = w * w, d = 2 * ZETA * w;
        var ax = k * (lx + rx - px[i]) + d * (vx[L] - om * ry - vx[i]);
        var ay = k * (ly + ry - py[i]) + d * (vy[L] + om * rx - vy[i]);
        for (var q = 0; q < MAX_PER; q++) {
          var o = L + q;
          if (q === j || !live[o]) continue;
          var ex = px[i] - px[o], ey = py[i] - py[o], d2 = ex * ex + ey * ey;
          if (d2 < dmin2 && d2 > 1e-6) {
            var dd = Math.sqrt(d2), push = SEP_K * (1 - dd / dmin) / dd;
            ax += ex * push; ay += ey * push;
          }
        }
        vx[i] += ax * h; vy[i] += ay * h;
        px[i] += vx[i] * h; py[i] += vy[i] * h;
        // The nose eases toward the direction of travel; how fast it swings is the bank.
        var sp = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
        if (sp > 1e-3) {
          var ohx = hx[i], ohy = hy[i];
          var nx = ohx + (vx[i] / sp - ohx) * ease, ny = ohy + (vy[i] / sp - ohy) * ease;
          var nl = Math.sqrt(nx * nx + ny * ny);
          if (nl > 1e-6) {
            nx /= nl; ny /= nl;
            hx[i] = nx; hy[i] = ny;
            bank[i] += (clamp((ohx * ny - ohy * nx) / h / BANK_RATE, -1, 1) - bank[i]) * Math.min(1, h * 3);
          }
        }
      }
    }

    function stepFleet(F, h) {
      if (F.state === OFF) {
        if (F.retire) return;
        F.offT -= h;
        if (F.offT <= 0) spawn(F, F.quick || Math.random() < WARP_IN_CHANCE ? HOW_WARP : HOW_EDGE);
        return;
      }
      F.t += h; F.age += h;
      stepLeader(F, h);
      stepFollowers(F, h);
      if (F.state === WARP_IN) {
        F.wt += h;
        if (F.wt >= WARP_IN_T + maxDelay(F)) F.state = FLY;
        return;
      }
      if (F.state === WARP_OUT) {
        F.wt += h;
        if (F.wt >= CHARGE + WARP_T + maxDelay(F)) goOff(F);
        return;
      }
      var L = F.i * MAX_PER, x = px[L], y = py[L];
      if (F.retire) { if (allOut(F)) goOff(F); else startWarpOut(F); return; }   // "Flotas" went down
      if (!F.entered) {
        if (x >= 0 && x <= W && y >= 0 && y <= H) F.entered = true;
        else if (F.age > 30) goOff(F);              // fail-safe: it never found its way in
        return;
      }
      F.inT += h;
      if (F.warpAt >= 0 && !F.leaving && F.inT >= F.warpAt) {
        // Only well inside the view, and never with the streak aimed across the reading column.
        var fx = x + hx[L] * (small ? WARP_DIST_SMALL : WARP_DIST);
        if (x < 40 || x > W - 40 || y < 40 || y > H - 40 || (wideW > 0.5 && Math.abs(fx - W / 2) < COLUMN / 2)) F.warpAt = F.inT + 1.5;
        else { startWarpOut(F); return; }
      }
      if (!F.leaving) { if (F.inT >= F.stay) chooseExit(F); }
      else if (allOut(F)) goOff(F);
      else if (F.inT > F.stay + 40) startWarpOut(F);   // fail-safe: it keeps missing the edge
    }

    // Ships added by "Naves por flota" fade in; removed ones fade out, then free their slot.
    function stepAlpha(dt) {
      var k = dt * SHIP_FADE;
      for (var i = 0; i < N; i++) {
        if (!live[i]) continue;
        if (i % MAX_PER < P.perFleet) { if (alpha[i] < 1) alpha[i] = Math.min(1, alpha[i] + k); }
        else { alpha[i] -= k; if (alpha[i] <= 0) { alpha[i] = 0; live[i] = 0; tCount[i] = 0; } }
      }
    }

    function step(dt) {
      clock += dt;
      if (fade < 1) fade = Math.min(1, fade + dt / FADE_IN);
      var sim = dt * P.speed;
      if (sim > 0) {
        var n = Math.ceil(sim / SUB_DT), h = sim / n;
        for (var s = 0; s < n; s++) {
          for (var f = 0; f < MAX_FLEETS; f++) stepFleet(fleets[f], h);
        }
        sampleTrails();
      }
      stepAlpha(dt);
    }

    // ---- Still-frame helpers ----
    // Finish anything half-done, so a stopped loop leaves a clean, complete frame.
    function settle() {
      fade = 1;
      for (var f = 0; f < MAX_FLEETS; f++) {
        var F = fleets[f];
        if (F.state === WARP_OUT) goOff(F);
        else if (F.state === WARP_IN) F.state = FLY;
      }
      for (var i = 0; i < N; i++) {
        if (!live[i]) continue;
        if (i % MAX_PER < P.perFleet) alpha[i] = 1;
        else { alpha[i] = 0; live[i] = 0; tCount[i] = 0; }
      }
    }

    // Shift a whole fleet (ships and trails) so every ship is on screen: a big swarm placed near an
    // edge would otherwise hang out of a still frame.
    function keepInView(F) {
      var b = F.i * MAX_PER, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, j, i;
      for (j = 0; j < MAX_PER; j++) {
        i = b + j;
        if (!live[i]) continue;
        var r = 0.6 * shipLen(j) + 4;
        if (px[i] - r < x0) x0 = px[i] - r;
        if (px[i] + r > x1) x1 = px[i] + r;
        if (py[i] - r < y0) y0 = py[i] - r;
        if (py[i] + r > y1) y1 = py[i] + r;
      }
      if (x1 < x0) return;
      var sx = x1 - x0 > W ? (W - x0 - x1) / 2 : x0 < 0 ? -x0 : x1 > W ? W - x1 : 0;
      var sy = y1 - y0 > H ? (H - y0 - y1) / 2 : y0 < 0 ? -y0 : y1 > H ? H - y1 : 0;
      if (!sx && !sy) return;
      for (j = 0; j < MAX_PER; j++) {
        i = b + j;
        px[i] += sx; py[i] += sy;
        for (var k = i * TRAIL_PTS, e = k + TRAIL_PTS; k < e; k++) { tx[k] += sx; ty[k] += sy; }
      }
    }

    // Every fleet in view, in formation, trails empty (the reduced-motion frame and the first frame).
    function layoutStatic() {
      var f;
      for (f = 0; f < MAX_FLEETS; f++) {
        fleets[f].state = OFF;
        fleets[f].retire = f >= P.fleets;
        fleets[f].quick = false;
      }
      for (f = 0; f < P.fleets; f++) { spawn(fleets[f], HOW_PLACE); keepInView(fleets[f]); }
    }

    // A still frame after a formation, size or count change: each follower moves onto its new slot
    // and its trail moves with it, so the picture stays whole.
    function snapAll() {
      for (var f = 0; f < MAX_FLEETS; f++) {
        var F = fleets[f];
        if (F.state === OFF) continue;
        var L = f * MAX_PER, c = hx[L], s = hy[L];
        for (var j = 1; j < MAX_PER; j++) {
          var i = L + j;
          if (!live[i]) continue;
          slot(F, j);
          var nx = px[L] + c * SLX - s * SLY, ny = py[L] + s * SLX + c * SLY;
          var ddx = nx - px[i], ddy = ny - py[i], o = i * TRAIL_PTS;
          for (var k = 0; k < TRAIL_PTS; k++) { tx[o + k] += ddx; ty[o + k] += ddy; }
          px[i] = nx; py[i] = ny; vx[i] = vx[L]; vy[i] = vy[L];
          hx[i] = c; hy[i] = s; bank[i] = bank[L];
        }
        if (reduced) keepInView(F);   // the reduced frame is the only view: keep it whole
      }
    }

    function setFleets(v, still) {
      var k = 0;
      for (var f = 0; f < MAX_FLEETS; f++) {
        var F = fleets[f];
        if (f < v) {
          if (!F.retire) continue;
          F.retire = false;
          if (F.state === OFF) {
            if (still) { spawn(F, HOW_PLACE); keepInView(F); }
            else { F.quick = true; F.offT = 0.1 + 0.35 * k++; }  // warps in right away, staggered
          } else if (F.state === WARP_OUT) F.quick = true;       // still leaving: it comes straight back
        } else if (!F.retire) {
          F.retire = true;                                       // running: the next step warps it out
          if (still) goOff(F);
        }
      }
    }

    function setPerFleet(v, still) {
      for (var f = 0; f < MAX_FLEETS; f++) {
        var F = fleets[f];
        if (F.state === OFF) continue;                           // a spawn places the right number
        var L = f * MAX_PER, c = hx[L], s = hy[L];
        for (var j = 1; j < MAX_PER; j++) {
          var i = L + j;
          if (j < v) {
            if (!live[i]) {
              slot(F, j);
              px[i] = px[L] + c * SLX - s * SLY; py[i] = py[L] + s * SLX + c * SLY;
              vx[i] = vx[L]; vy[i] = vy[L]; hx[i] = c; hy[i] = s; bank[i] = bank[L];
              wux[i] = wux[L]; wuy[i] = wuy[L];
              tCount[i] = 0; tHead[i] = 0; live[i] = 1; alpha[i] = still ? 1 : 0;
            } else if (still) alpha[i] = 1;
          } else if (still && live[i]) { live[i] = 0; alpha[i] = 0; tCount[i] = 0; }
        }
      }
      if (still) snapAll();
    }

    function rescale(kx, ky) {
      var i;
      for (i = 0; i < N; i++) { px[i] *= kx; py[i] *= ky; }
      for (i = 0; i < tx.length; i++) { tx[i] *= kx; ty[i] *= ky; }
    }

    // ---- Theme: colours come from the page tokens; the brightness of --bg decides dark vs light ----
    function readTheme() {
      var cs = window.getComputedStyle(root);
      var bg = toRgb(cs.getPropertyValue("--bg").trim(), LIGHT_DEFAULTS.bg);
      var ink = toRgb(cs.getPropertyValue("--ink").trim(), LIGHT_DEFAULTS.ink);
      var accent = toRgb(cs.getPropertyValue("--accent").trim(), LIGHT_DEFAULTS.accent);
      dark = luminance(bg) < 0.45;
      col.ink = ink;                                  // light theme: the only colour drawn
      col.hi = mix(ink, WHITE, 0.55);                 // dark theme: pale hull, lit side ...
      col.lo = mix(ink, bg, 0.4);                     // ... and shaded side
      col.canopy = mix(accent, bg, 0.5);
      col.glowCore = mix(accent, WHITE, 0.55);
      col.glow = accent;
      col.sTail = mix(accent, WHITE, 0.2);
      col.sHead = mix(WHITE, accent, 0.12);
      trailCss = rgba(dark ? mix(accent, WHITE, 0.3) : ink, 1);
    }

    function buildSprites() {
      var len = BASE_LEN * P.size;
      hullF = makeHull(len, dpr, dark, col);
      hullL = makeHull(len * LEAD_SCALE, dpr, dark, col);
      if (dark) {
        glowF = makeGlow(len * GLOW_R, dpr, col.glowCore, col.glow);
        glowL = makeGlow(len * LEAD_SCALE * GLOW_R, dpr, col.glowCore, col.glow);
      } else glowF = glowL = null;
      streak = dark ? makeStreak(col.sTail, col.sHead) : makeStreak(col.ink, col.ink);
    }

    // The light theme's ink layer matches the canvas bitmap; the dark theme releases it.
    function sizeLayer() {
      if (dark) {
        if (layer && layer.width > 1) { layer.width = 1; layer.height = 1; }
        return;
      }
      if (!layer) { layer = document.createElement("canvas"); lctx = layer.getContext("2d"); }
      if (layer.width !== canvas.width || layer.height !== canvas.height) {
        layer.width = canvas.width; layer.height = canvas.height;
      } else if (lctx) {
        lctx.setTransform(1, 0, 0, 1, 0, 0);
        lctx.clearRect(0, 0, layer.width, layer.height);
      }
    }

    function applySize(force) {
      var w = Math.max(1, canvas.clientWidth || window.innerWidth || 0);
      var h = Math.max(1, canvas.clientHeight || window.innerHeight || 0);
      var d = Math.min(window.devicePixelRatio || 1, DPR_CAP);
      if (!force && w === W && h === H && d === dpr) return;
      var oldW = W, oldH = H, dprChanged = d !== dpr;
      W = w; H = h; dpr = d; small = W < 640;
      marginW = Math.max(0, (W - COLUMN) / 2);
      wideW = clamp((marginW - 60) / 220, 0, 1);   // 0 below ~1200 px wide, 1 from ~1640 px
      canvas.width = Math.max(1, Math.round(W * dpr));
      canvas.height = Math.max(1, Math.round(H * dpr));
      if (oldW && !(W === oldW && Math.abs(H - oldH) < oldH * HEIGHT_SLACK)) {
        if (reduced) layoutStatic();                // a still frame is re-composed for the new shape
        else rescale(W / oldW, H / oldH);           // a live one keeps its fleets where they were
      }
      if (force || dprChanged) buildSprites();
      sizeLayer();
      render(); // resizing clears the bitmap: repaint now, even when paused
    }

    // ---- Frame ----
    function ext(x, y, r) {
      if (x - r < bx0) bx0 = x - r;
      if (x + r > bx1) bx1 = x + r;
      if (y - r < by0) by0 = y - r;
      if (y + r > by1) by1 = y + r;
    }

    // Where and how each ship is drawn this frame (warps offset it along the frozen heading).
    function prepare() {
      var nTrail = reduced ? 0 : Math.round(P.trails * TRAIL_PTS);
      var wd = small ? WARP_DIST_SMALL : WARP_DIST;
      for (var f = 0; f < MAX_FLEETS; f++) {
        var F = fleets[f], warping = F.state === WARP_OUT || F.state === WARP_IN;
        for (var j = 0; j < MAX_PER; j++) {
          var i = f * MAX_PER + j;
          dA[i] = 0; gA[i] = 0; stA[i] = 0; stL[i] = 0; dT[i] = 0; dS[i] = 1;
          if (F.state === OFF || !live[i]) continue;
          var a = alpha[i], glow = a, off = 0, tm = 1;
          if (F.state === WARP_OUT) {
            var t0 = F.wt - rowOf(F, j) * ROW_DELAY, tau = clamp((t0 - CHARGE) / WARP_T, 0, 1);
            glow = a * (1 + 1.2 * clamp(t0 / CHARGE, 0, 1)) * Math.pow(1 - tau, 0.7);
            if (tau > 0) {
              off = wd * Math.pow(tau, 2.4);                     // accelerates away
              stL[i] = off * (1 - smooth(0.45, 1, tau));         // the tail lags, then catches up
              stA[i] = a * Math.sqrt(1 - tau) * Math.min(1, tau / 0.12);
              dS[i] = 1 + 1.8 * tau;
              a *= clamp(1 - tau / 0.35, 0, 1);
              tm = 1 - tau;
            }
          } else if (F.state === WARP_IN) {
            var u = clamp((F.wt - rowOf(F, j) * ROW_DELAY) / WARP_IN_T, 0, 1), v = 1 - u;
            off = -wd * Math.pow(v, 2.4);                        // arrives from behind, braking
            stL[i] = wd * 0.45 * Math.pow(v, 1.2) * Math.min(1, u / 0.1);
            stA[i] = u > 0 ? a * Math.pow(v, 0.6) * Math.min(1, u / 0.08) : 0;
            dS[i] = 1 + 1.6 * v * v;
            glow = a * smooth(0.1, 0.6, u) * (1 + 1.2 * v);
            a *= smooth(0.25, 0.8, u);
            tm = u * u;
          }
          var c = warping ? wux[i] : hx[i], s = warping ? wuy[i] : hy[i];
          dC[i] = c; dSn[i] = s;
          dX[i] = px[i] + c * off; dY[i] = py[i] + s * off;
          dA[i] = a; gA[i] = glow;
          var n = tCount[i] < nTrail ? tCount[i] : nTrail;
          dT[i] = (n * tm * alpha[i]) | 0;
        }
      }
    }

    // All trails at once: bucket b holds every ship's b-th fifth of its trail, so there are five
    // strokes a frame, each a little fainter and thinner than the one before.
    function drawTrails(g, fadeMul) {
      var look = dark ? DARK : LIGHT;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.strokeStyle = trailCss;
      g.lineCap = "butt";
      g.lineJoin = "round";
      for (var b = 0; b < NB; b++) {
        var any = false;
        g.beginPath();
        for (var i = 0; i < N; i++) {
          var n = dT[i];
          if (n < 1) continue;
          var s0 = (b * n / NB) | 0, s1 = ((b + 1) * n / NB) | 0;
          if (s1 <= s0) continue;
          trailPoint(i, s0);
          g.moveTo(TPX, TPY);
          if (track) ext(TPX, TPY, 3);
          for (var k = s0 + 1; k <= s1; k++) {
            trailPoint(i, k);
            g.lineTo(TPX, TPY);
            if (track) ext(TPX, TPY, 3);
          }
          any = true;
        }
        if (!any) continue;
        var q = 1 - (b + 0.5) / NB;
        g.globalAlpha = look.trail * Math.pow(q, 1.3) * fadeMul;
        g.lineWidth = look.trailW * P.size * (0.45 + 0.55 * q);
        g.stroke();
      }
    }

    function drawStreaks(g, fadeMul) {
      var look = dark ? DARK : LIGHT, th = STREAK_H * Math.sqrt(P.size);
      for (var i = 0; i < N; i++) {
        var L = stL[i];
        if (stA[i] < 0.004 || L < 1) continue;
        var c = dC[i], s = dSn[i], X = dX[i], Y = dY[i];
        // Rotate so local +x is the heading: the head sits at the origin, the tail behind it.
        g.setTransform(c * dpr, s * dpr, -s * dpr, c * dpr, X * dpr, Y * dpr);
        g.globalAlpha = Math.min(1, stA[i] * look.streak * fadeMul);
        g.drawImage(streak, -L, -th / 2, L, th);
        if (track) { ext(X, Y, th + 2); ext(X - c * L, Y - s * L, th + 2); }
      }
    }

    function drawGlows(g) {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = "lighter";
      for (var i = 0; i < N; i++) {
        var ga = gA[i];
        if (ga < 0.004) continue;
        var X = dX[i], Y = dY[i];
        if (X < -40 || X > W + 40 || Y < -40 || Y > H + 40) continue;
        var j = i % MAX_PER, spr = j ? glowF : glowL, back = REAR * shipLen(j) * dS[i];
        var flick = reduced ? 1 : 1 + 0.1 * Math.sin(clock * 9 + i * 1.7);
        g.globalAlpha = Math.min(1, DARK.glow * flick * ga * fade);
        g.drawImage(spr, (X - dC[i] * back) * dpr - spr.width / 2, (Y - dSn[i] * back) * dpr - spr.height / 2);
      }
      g.globalCompositeOperation = "source-over";
    }

    function drawHulls(g, fadeMul) {
      for (var f = 0; f < MAX_FLEETS; f++) {
        if (fleets[f].state === OFF) continue;
        for (var j = MAX_PER - 1; j >= 0; j--) {   // the leader last, on top of its wingmen
          var i = f * MAX_PER + j, a = dA[i];
          if (a < 0.004) continue;
          var X = dX[i], Y = dY[i];
          if (X < -40 || X > W + 40 || Y < -40 || Y > H + 40) continue;
          var spr = j ? hullF : hullL, c = dC[i], s = dSn[i], st = dS[i];
          var sq = 1 - BANK_SQUASH * Math.abs(bank[i]);   // banking narrows the silhouette
          g.setTransform(c * st, s * st, -s * sq, c * sq, X * dpr, Y * dpr);
          g.globalAlpha = a * fadeMul;
          g.drawImage(spr, -spr.width / 2, -spr.height / 2);
          if (track) ext(X, Y, shipLen(j) * st + 2);
        }
      }
    }

    // Light theme: the ink layer goes onto the (cleared) canvas once, at the ceiling, over the box
    // that holds this frame's ink; then that box is wiped for the next frame.
    function composite() {
      if (!(bx1 > bx0 && by1 > by0)) return;
      var x0 = Math.max(0, Math.floor(bx0 * dpr)), y0 = Math.max(0, Math.floor(by0 * dpr));
      var x1 = Math.min(canvas.width, Math.ceil(bx1 * dpr)), y1 = Math.min(canvas.height, Math.ceil(by1 * dpr));
      if (x1 <= x0 || y1 <= y0) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = LIGHT_CEIL * fade;
      ctx.drawImage(layer, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
      ctx.globalAlpha = 1;
      lctx.setTransform(1, 0, 0, 1, 0, 0);
      lctx.clearRect(x0, y0, x1 - x0, y1 - y0);
    }

    function render() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!hullF || (!dark && !lctx)) return;
      prepare();
      // Dark draws straight onto the canvas; light draws relative ink into the layer.
      var g = dark ? ctx : lctx, fadeMul = dark ? fade : 1;
      track = !dark;
      bx0 = by0 = Infinity; bx1 = by1 = -Infinity;
      if (!reduced && P.trails > 0) drawTrails(g, fadeMul);
      drawStreaks(g, fadeMul);
      if (dark) drawGlows(g);
      drawHulls(g, fadeMul);
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1;
      if (!dark) composite();
    }

    function frame(ts) {
      rafId = 0;
      if (!running) return;
      rafId = window.requestAnimationFrame(frame);
      if (!due(ts)) return;                       // ~30 fps, on the ticks shared with the background
      var dt = lastTs ? (ts - lastTs) / 1000 : 0;
      lastTs = ts;
      if (dt > MAX_DT) dt = MAX_DT; else if (dt < 0) dt = 0;
      step(dt);
      render();
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
        rafId = window.requestAnimationFrame(frame);
      } else if (!run && running) {
        running = false;
        if (rafId) window.cancelAnimationFrame(rafId);
        rafId = 0;
        settle();               // no frozen streak, no half-faded ship
        if (!stopped) render();
      }
    }

    // ---- Live params: no restart, no blank frame; a still scene repaints once with the new value ----
    function set(key, value) {
      if (stopped || !Object.prototype.hasOwnProperty.call(SPEC, key)) return;
      var v = resolve(key, value);
      if (v === P[key]) return;
      P[key] = v;
      var still = !running;
      if (key === "fleets") setFleets(v, still);
      else if (key === "perFleet") setPerFleet(v, still);
      else if (key === "size") { buildSprites(); if (still) snapAll(); }   // running: springs glide to the new slots
      else if (key === "formation" && still) snapAll();
      // speed and trails are read every frame
      if (still) render();
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
      sizeLayer();
      if (!running) render(); // a running loop repaints on its next frame
    }

    function onReduce() {
      var was = reduced;
      reduced = isReduced();
      sync();
      if (reduced && !was) { layoutStatic(); render(); }
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
    // The panel sizes the canvas with CSS. If it is still at the 300x150 default, its layout size
    // would follow the bitmap we set and grow on every resize: pin it to the viewport instead.
    if (canvas.clientWidth === 300 && canvas.clientHeight === 150 && !canvas.style.width) {
      canvas.style.width = "100%";
      canvas.style.height = "100%";
    }
    readTheme();
    applySize(true);     // bitmap, sprites and ink layer
    layoutStatic();      // every fleet starts in view and in formation: the first frame is complete
    fade = shouldRun() ? 0 : 1;
    render();
    window.addEventListener("resize", onResize, { passive: true });
    document.addEventListener("visibilitychange", sync);
    listen(reduceMq, onReduce);
    listen(darkMq, onTheme);
    if (mo) mo.observe(root, { attributes: true, attributeFilter: ["data-theme", "data-motion", "data-preview-motion"] });
    sync();              // reduced motion never gets past here: the first frame is the finished state

    return {
      lightFriendly: true, // light theme: ink only, composited once under the 0.22 ceiling
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
        if (layer) { layer.width = 1; layer.height = 1; }
        layer = null; lctx = null;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    };
  }

  window.PortfolioBG = window.PortfolioBG || {};
  window.PortfolioBG["ships"] = {
    label: "Naves",
    layer: "overlay",
    themes: ["dark", "light"],
    params: PARAMS,
    start: start
  };
})();
