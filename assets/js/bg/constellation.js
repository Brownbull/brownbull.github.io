// Constellation background: a slow drifting graph behind the page. Nodes are services,
// links are dependencies, a few accent "hubs" glow softly: an echo of the architecture
// diagrams in the case studies. Follows the portfolio motion contract (site.js):
// one static, complete frame under prefers-reduced-motion; pauses with the site's single
// motion switch (<html data-motion="off">) and while the tab is hidden.
//
// Registers window.PortfolioBG.constellation = { label, layer, themes, params, start(canvas, values) }
// (background contract v2); start() returns { pause, resume, stop, set(key, value), lightFriendly }.
// The panel owns the <canvas id="bg-canvas" aria-hidden="true"> (fixed, z-index:-1,
// pointer-events:none); this module only draws into it.
//
// Light theme ceiling: every shape is drawn at its alpha relative to LIGHT_CEIL (source-over keeps
// any stack <= 1), and the canvas element carries `opacity: LIGHT_CEIL`, so the compositor scales
// the finished frame once at no per-frame cost. Crossings, hubs over lines and any param value can
// therefore never darken a final pixel past it (the proposal.css scrim is computed from it). A
// canvas without a style object falls back to the same scaling as a full-canvas "destination-in".
// A pixel check that reads the bitmap must multiply its alpha by the canvas's computed opacity.
//
// Small screens (< 640px) bound the link work: at most CFG.smallMaxLinks links per node, and lines
// fainter than CFG.smallAlphaFloor (about one 8-bit level on screen) are not stroked.
(function () {
  "use strict";

  var TAU = Math.PI * 2;
  var root = document.documentElement;
  function noop() {}

  // ---- Params: the panel builds its sliders from these; start() receives {key: number} ----
  var PARAMS = [
    { key: "nodes", label: "Cantidad de nodos", min: 0.3, max: 2.5, step: 0.05, value: 1, unit: "×" },
    { key: "links", label: "Distancia de conexión", min: 0.5, max: 1.8, step: 0.05, value: 1, unit: "×" },
    { key: "maxLinks", label: "Conexiones por nodo", min: 1, max: 12, step: 1, value: 12, unit: "" },
    { key: "speed", label: "Velocidad", min: 0, max: 3, step: 0.05, value: 1, unit: "×" },
    { key: "pull", label: "Atracción del cursor", min: 0, max: 2, step: 0.05, value: 1, unit: "×" }
  ];
  var BY_KEY = {};
  PARAMS.forEach(function (p) { BY_KEY[p.key] = p; });

  // ---- Tuning (CSS px and seconds); counts and distances are the 1× values ----
  var CFG = {
    dprCap: 1.5,
    capacity: 600,           // absolute node ceiling: typed arrays are sized to this once
    hardCap: 160,            // node ceiling at 1× nodes (scaled by the nodes param and the pad)
    smallCap: 48,            // the same under 640px wide
    minNodes: 14,
    areaPerNode: 17000,      // one node per this many px² of the padded world
    areaPerNodeSmall: 16000,
    linkDist: 150,           // nodes closer than this get a link
    linkDistSmall: 110,
    speedMin: 5,             // px/s drift: crossing a laptop screen takes minutes
    speedMax: 12,
    wobble: 6,               // px/s sideways meander (about ±30px of path)
    hubSlow: 0.6,            // hubs drift slower than ordinary nodes
    pullRadius: 170,         // cursor influence, fine pointers only
    pullMax: 20,             // most a node leans toward the cursor at 1× pull, px
    pullBusy: 1200,          // ms after the last pointer move at ~60 fps (the lean settles by then)
    linkBoost: 1.4,          // extra link alpha right under the cursor
    rankSoft: 0.2,           // link cap: a kept link fades over the last 20% of strength above the first dropped one
    segPerNode: 24,          // candidate link slots per node (2.5× nodes at 1.8× distance averages ~17)
    buckets: 32,             // alpha buckets: one stroke per bucket, not one per line
    smallMaxLinks: 8,        // under 640px: links per node at most (the phone's worst case stays bounded)
    smallAlphaFloor: 0.005,  // under 640px: fainter lines (final alpha) are skipped, ~40% of their line work
    fadeIn: 1.6,             // s: calm first appearance, never a flash
    resizeDebounce: 150
  };
  var KMAX = BY_KEY.maxLinks.max + 1;   // rank slots per node: the cap plus the first link it drops
  var A_MAX = 1 + CFG.linkBoost;        // highest link strength before theme scaling
  var TIER_R = [0.9, 1.3, 1.8];         // dot radius per depth tier (far, mid, near)
  var TIER_SPEED = [0.55, 0.8, 1];      // far tiers drift slower: a hint of depth
  var HUB_R = 2.6, HUB_RING = 6, GLOW_R = 28;
  // Light theme: highest final alpha of any pixel. The contract ceiling is 0.64; 0.63 leaves room
  // for 8-bit rounding in the compositor (or in the destination-in fallback).
  var LIGHT_CEIL = 0.63;
  var CEIL_FILL = "rgba(0,0,0," + LIGHT_CEIL + ")";

  // Per-theme strength (final alpha of a lone shape). Dark: bright on dark. Light: barely there.
  var LOOK = {
    dark:  { line: 0.16,  nodes: [0.30, 0.48, 0.70], hubCore: 0.85, glow: 0.34, hubLine: 1.25 },
    light: { line: 0.085, nodes: [0.10, 0.15, 0.22], hubCore: 0.45, glow: 0.14, hubLine: 1.15 }
  };

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  // A param value: missing or invalid falls back to the default, then clamps to the range.
  function norm(p, v) {
    var n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    if (!isFinite(n)) return p.value;
    n = clamp(n, p.min, p.max);
    return p.step >= 1 ? Math.round(n) : n;
  }

  // ---- Colour helpers: resolve any CSS colour the tokens use (hex, rgb(), color-mix()...) ----
  var probe = null;
  function toRgb(value, fallback) {
    try {
      if (!probe) {
        var c = document.createElement("canvas");
        c.width = c.height = 1;
        probe = c.getContext("2d", { willReadFrequently: true });
      }
      probe.clearRect(0, 0, 1, 1);
      probe.fillStyle = rgb(fallback);
      if (value) probe.fillStyle = value;   // an unparsable value is ignored, so the fallback stays
      probe.fillRect(0, 0, 1, 1);
      var d = probe.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2]];
    } catch (e) { return fallback; }
  }
  function luminance(c) { return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255; }
  function rgb(c) { return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")"; }

  // matchMedia "change" with the old addListener fallback; returns the remover.
  function listenMq(mq, fn) {
    if (!mq) return noop;
    if (mq.addEventListener) { mq.addEventListener("change", fn); return function () { mq.removeEventListener("change", fn); }; }
    if (mq.addListener) { mq.addListener(fn); return function () { mq.removeListener(fn); }; }
    return noop;
  }
  function media(q) { return window.matchMedia ? window.matchMedia(q) : null; }

  function start(canvas, values) {
    var ctx = canvas && canvas.getContext && canvas.getContext("2d");
    if (!ctx) return { pause: noop, resume: noop, stop: noop, set: noop, lightFriendly: true };

    // Live param values, always normalised
    var P = {};
    PARAMS.forEach(function (p) { P[p.key] = norm(p, values && values[p.key]); });

    var mqReduce = media("(prefers-reduced-motion: reduce)");
    var mqDark = media("(prefers-color-scheme: dark)");
    var mqFine = media("(pointer: fine)");
    var mqForced = media("(forced-colors: active)");   // proposal.css hides the canvas there
    var perf = window.performance && window.performance.now ? window.performance : null;

    // Light ceiling on the element (see the header). The canvas's own opacity, if any, is kept.
    var cssCeil = !!(canvas.style && typeof canvas.style.opacity === "string");
    var baseOpacity = cssCeil ? canvas.style.opacity : "";
    var baseAlpha = parseFloat(baseOpacity);
    if (!(baseAlpha >= 0 && baseAlpha <= 1)) baseAlpha = 1;
    // The panel's preview switch (pm=force) shows motion even when the OS asks to reduce it.
    function reducedNow() {
      return !!(mqReduce && mqReduce.matches) && root.getAttribute("data-preview-motion") !== "force";
    }
    var reduced = reducedNow();
    var fine = !!(mqFine && mqFine.matches);

    // ---- Node state: struct-of-arrays sized once at capacity (no per-frame allocation) ----
    var N = CFG.capacity;
    var x = new Float32Array(N), y = new Float32Array(N);     // drift position (world coords)
    var vx = new Float32Array(N), vy = new Float32Array(N);   // base velocity, px/s
    var ph = new Float32Array(N), wf = new Float32Array(N);   // wobble phase and frequency
    var ox = new Float32Array(N), oy = new Float32Array(N);   // cursor lean, eased
    var px = new Float32Array(N), py = new Float32Array(N);   // drawn position = drift + lean
    var tier = new Uint8Array(N), hub = new Uint8Array(N);
    var next = new Int32Array(N);                             // spatial grid: list through each cell
    var cellHead = new Int32Array(64), cols = 1, rows = 1, cell = CFG.linkDist;

    // Link cap: each node keeps its strongest candidate strengths, sorted, to find the first one
    // its cap drops. A link fades out as it nears that cut-off instead of popping.
    var topS = new Float32Array(N * KMAX), topN = new Uint8Array(N), thr = new Float32Array(N);
    var rankK = P.maxLinks + 1;

    // Candidate links collected per frame, then counting-sorted by (colour, alpha) bucket
    var B = CFG.buckets, MAXSEG = N * CFG.segPerNode;
    var segI = new Uint16Array(MAXSEG), segJ = new Uint16Array(MAXSEG), segA = new Float32Array(MAXSEG);
    var segH = new Uint8Array(MAXSEG), segK = new Uint8Array(MAXSEG), order = new Uint16Array(MAXSEG);
    var bucketN = new Uint16Array(B * 2), bucketAt = new Uint16Array(B * 2 + 1), bucketFill = new Uint16Array(B * 2);
    var segCount = 0, boost = 0, minB = 1;   // minB: faintest bucket worth a stroke (updateFloor)

    var count = 0, W = 0, H = 0, pad = 0, worldW = 0, worldH = 0, dpr = 1;
    var linkDist = CFG.linkDist, linkDist2 = linkDist * linkDist, small = false;
    var dark = true, look = LOOK.dark, inkScale = 1;
    var inkCss = "#fff", accentCss = "#5cc0b2", accentRgb = [92, 192, 178];
    var tierCss = [inkCss, inkCss, inkCss], glow = null;
    var mx = 0, my = 0, mOn = false, pullOn = false, moveAt = -Infinity;
    // clock: real seconds (hub breathing); drift: seconds scaled by the speed param (the paths)
    var raf = 0, last = 0, clock = 0, drift = 0, fade = 1, resizeTimer = 0;

    // Why the loop is not running. Motion runs only when every reason is false.
    function motionOffNow() {
      var a = root.getAttribute("data-motion");
      if (a) return a === "off";
      try { return window.localStorage.getItem("portfolio:motion") === "off"; } catch (e) { return false; }
    }
    var st = { user: false, hidden: !!document.hidden, motionOff: motionOffNow(), stopped: false,
      forced: !!(mqForced && mqForced.matches) };
    function running() { return !st.stopped && !reduced && !st.hidden && !st.motionOff && !st.user && !st.forced; }
    function pulling() { return mOn && fine && P.pull > 0; }
    // A faster frame rate only while the cursor is actually moving the graph; a resting one gets 30 fps.
    function busy(now) { return pulling() && !!perf && now - moveAt < CFG.pullBusy; }

    // ---- Seeding: best-of-4 candidates keeps the graph evenly spread (seed, resize, params only) ----
    function place(i) {
      var best = 0, bx = 0, by = 0;
      for (var k = 0; k < 4; k++) {
        var cx = Math.random() * worldW - pad, cy = Math.random() * worldH - pad, near = Infinity;
        for (var j = 0; j < i; j++) {
          var dx = x[j] - cx, dy = y[j] - cy, d2 = dx * dx + dy * dy;
          if (d2 < near) near = d2;
        }
        if (near > best) { best = near; bx = cx; by = cy; }
      }
      x[i] = bx; y[i] = by;
      var r = Math.random();
      tier[i] = r < 0.4 ? 0 : r < 0.75 ? 1 : 2;
      var sp = CFG.speedMin + Math.random() * (CFG.speedMax - CFG.speedMin), a = Math.random() * TAU;
      vx[i] = Math.cos(a) * sp; vy[i] = Math.sin(a) * sp;
      ph[i] = Math.random() * TAU;
      wf[i] = 0.12 + Math.random() * 0.22;   // rad/s: one wobble every 20-50 s
      ox[i] = 0; oy[i] = 0; px[i] = x[i]; py[i] = y[i];
    }

    // A fixed stride keeps the same nodes as hubs across resizes (at most 8 hubs).
    function assignHubs() {
      var stride = small ? 7 : 16;
      for (var i = 0; i < count; i++) {
        hub[i] = i % stride === 0 && i < stride * 8 ? 1 : 0;
        if (hub[i]) tier[i] = 2;
      }
    }

    // How many nodes the world holds. A longer link length widens the off-screen pad, so the
    // ceiling grows with the padded area and the on-screen density stays what `nodes` asks for.
    function targetCount() {
      var base = small ? CFG.linkDistSmall : CFG.linkDist;
      var padGrow = worldW * worldH / ((W + 2 * base) * (H + 2 * base));
      var cap = Math.min(N, Math.round((small ? CFG.smallCap : CFG.hardCap) * P.nodes * padGrow));
      var floor = Math.min(cap, Math.max(4, Math.round(CFG.minNodes * P.nodes)));
      return clamp(Math.round(worldW * worldH / (small ? CFG.areaPerNodeSmall : CFG.areaPerNode) * P.nodes), floor, cap);
    }

    // ---- World: the viewport plus one link length on every side, so nodes wrap off-screen and
    // links fade in and out instead of popping at the edges ----
    var SEED = 0, STRETCH = 1, KEEP = 2;
    function layout(mode, recount) {
      var oldPad = pad, oldWorldW = worldW, oldWorldH = worldH, i, u;
      linkDist = (small ? CFG.linkDistSmall : CFG.linkDist) * P.links;
      linkDist2 = linkDist * linkDist;
      pad = linkDist; worldW = W + 2 * pad; worldH = H + 2 * pad;
      cell = linkDist; cols = Math.ceil(worldW / cell); rows = Math.ceil(worldH / cell);
      if (cellHead.length < cols * rows) cellHead = new Int32Array(cols * rows);

      if (mode === SEED) {
        count = 0;
      } else if (mode === STRETCH && oldWorldW) {
        // Keep the constellation and stretch it to the new size.
        var sx = worldW / oldWorldW, sy = worldH / oldWorldH;
        for (i = 0; i < count; i++) {
          x[i] = (x[i] + oldPad) * sx - pad; y[i] = (y[i] + oldPad) * sy - pad;
        }
      } else {
        // Nodes stay put; only those outside a smaller world wrap back into it.
        for (i = 0; i < count; i++) {
          u = (x[i] + pad) % worldW; x[i] = (u < 0 ? u + worldW : u) - pad;
          u = (y[i] + pad) % worldH; y[i] = (u < 0 ? u + worldH : u) - pad;
        }
      }
      var target = mode === SEED || recount ? targetCount() : count;
      for (i = count; i < target; i++) place(i);   // grow: new nodes fill the gaps
      count = target;                              // shrink: the tail simply drops
      assignHubs();
    }

    // ---- Size: backing store from the CSS box × capped DPR ----
    function resize(initial) {
      var w = Math.max(1, canvas.clientWidth || window.innerWidth || 1);
      var h = Math.max(1, canvas.clientHeight || window.innerHeight || 1);
      var d = Math.min(CFG.dprCap, window.devicePixelRatio || 1);
      if (!initial && w === W && h === H && d === dpr) return false;
      var oldW = W, oldH = H;
      W = w; H = h; dpr = d; small = W < 640;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // setting width resets context state
      ctx.lineCap = "round";
      // A height-only change under 20% is a mobile toolbar sliding: keep every node and the count.
      var toolbarOnly = !initial && W === oldW && Math.abs(H - oldH) < oldH * 0.2;
      layout(initial ? SEED : toolbarOnly ? KEEP : STRETCH, !toolbarOnly);
      updateFloor();                                 // depends on small
      if (glow) buildGlow();                         // the sprite depends on dpr
      return true;
    }

    // ---- Theme: tokens from :root, re-read on data-theme and on the OS scheme ----
    function readTheme() {
      var cs = getComputedStyle(root);
      var bg = toRgb(cs.getPropertyValue("--bg").trim(), [18, 20, 19]);
      var ink = toRgb(cs.getPropertyValue("--ink").trim(), [235, 234, 230]);
      var muted = toRgb(cs.getPropertyValue("--muted").trim(), [165, 163, 156]);
      accentRgb = toRgb(cs.getPropertyValue("--accent").trim(), [92, 192, 178]);
      dark = luminance(bg) < 0.45;
      look = dark ? LOOK.dark : LOOK.light;
      // Light: shapes are drawn relative to the ceiling, then the frame is scaled down to it.
      inkScale = dark ? 1 : 1 / LIGHT_CEIL;
      if (cssCeil) canvas.style.opacity = dark ? baseOpacity : String(+(baseAlpha * LIGHT_CEIL).toFixed(4));
      inkCss = rgb(ink); accentCss = rgb(accentRgb);
      // Dark: far nodes in muted for depth. Light: everything ink, just at low alpha.
      tierCss = [dark ? rgb(muted) : inkCss, inkCss, inkCss];
      updateFloor();
      buildGlow();
    }

    // Faintest alpha bucket worth a stroke. Below the first test the stroke rounds to nothing in an
    // 8-bit canvas, so skipping it changes no pixel; small screens also skip lines whose final alpha
    // is under smallAlphaFloor (at most about one 8-bit level on screen).
    function updateFloor() {
      var floor = small ? CFG.smallAlphaFloor : 0;
      for (minB = 1; minB < B - 1; minB++) {
        var q = (minB + 0.5) / B, a = q * q * A_MAX * look.line;   // final alpha at full strength
        if (a * inkScale * 255 >= 0.5 && a >= floor) break;        // a * inkScale: the bitmap's alpha
      }
    }

    // Hub glow is a pre-rendered radial sprite: no gradient is created per frame.
    function buildGlow() {
      var size = Math.max(2, Math.ceil(GLOW_R * 2 * dpr));
      glow = glow || document.createElement("canvas");
      glow.width = size; glow.height = size;
      var g = glow.getContext("2d"), a = accentRgb.join(",");
      var grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      grad.addColorStop(0, "rgba(" + a + ",1)");
      grad.addColorStop(0.3, "rgba(" + a + ",0.35)");
      grad.addColorStop(1, "rgba(" + a + ",0)");
      g.clearRect(0, 0, size, size);
      g.fillStyle = grad;
      g.fillRect(0, 0, size, size);
    }

    // ---- Step: drift + wobble, wrap in the padded world, lean toward the cursor ----
    function step(dt) {
      var amp = CFG.wobble, R = CFG.pullRadius, R2 = R * R, k = Math.min(1, dt * 2.5);
      var md = dt * P.speed, lean = CFG.pullMax * P.pull;   // speed scales the path, not the easing
      var right = W + pad, bottom = H + pad;
      drift += md;
      for (var i = 0; i < count; i++) {
        var s = TIER_SPEED[tier[i]] * (hub[i] ? CFG.hubSlow : 1), w = drift * wf[i] + ph[i];
        x[i] += s * (vx[i] + Math.cos(w) * amp) * md;
        y[i] += s * (vy[i] + Math.sin(w * 0.8) * amp) * md;
        if (x[i] < -pad) x[i] += worldW; else if (x[i] >= right) x[i] -= worldW;
        if (y[i] < -pad) y[i] += worldH; else if (y[i] >= bottom) y[i] -= worldH;

        var tx = 0, ty = 0;
        if (pullOn) {
          var dx = mx - x[i], dy = my - y[i], d2 = dx * dx + dy * dy;
          if (d2 < R2 && d2 > 1) {
            // Bell profile: zero at the cursor and at the edge. Its peak (lean at R/2) stays
            // under the distance even at 2× pull, so nodes never overshoot the cursor.
            var d = Math.sqrt(d2), f = 1 - d / R, m = lean * 4 * f * (1 - f) / d;
            tx = dx * m; ty = dy * m;
          }
        }
        ox[i] += (tx - ox[i]) * k; oy[i] += (ty - oy[i]) * k;   // eases in, springs back
        px[i] = x[i] + ox[i]; py[i] = y[i] + oy[i];
      }
    }

    // ---- Links: spatial grid (cell = link length), so each node checks 5 cells, not all nodes ----
    // Insert strength s into node i's sorted top list (length rankK at most).
    function rankIn(i, s) {
      var o = i * KMAX, n = topN[i], k;
      if (n < rankK) { k = n; topN[i] = n + 1; }
      else if (s > topS[o + rankK - 1]) k = rankK - 1;
      else return;
      for (; k > 0 && topS[o + k - 1] < s; k--) topS[o + k] = topS[o + k - 1];
      topS[o + k] = s;
    }

    function pair(i, j) {
      var xi = px[i], yi = py[i], xj = px[j], yj = py[j];
      var dx = xi - xj, dy = yi - yj, d2 = dx * dx + dy * dy;
      if (d2 >= linkDist2) return;
      var f = 1 - Math.sqrt(d2) / linkDist, a = f * f;   // fades out toward the threshold
      if (boost) {
        var mdx = (xi + xj) * 0.5 - mx, mdy = (yi + yj) * 0.5 - my, m2 = mdx * mdx + mdy * mdy;
        var R = CFG.pullRadius;
        if (m2 < R * R) a *= 1 + boost * (1 - Math.sqrt(m2) / R);
      }
      var isHub = hub[i] | hub[j];
      if (isHub) a *= look.hubLine;
      // Every candidate counts toward both caps, seen or not, so a node's rank never jumps
      // when a neighbour crosses the screen edge.
      rankIn(i, a); rankIn(j, a);
      // Both ends past the same edge: the line cannot be seen.
      if ((xi < 0 && xj < 0) || (xi > W && xj > W) || (yi < 0 && yj < 0) || (yi > H && yj > H)) return;
      if (segCount >= MAXSEG) return;
      segI[segCount] = i; segJ[segCount] = j; segA[segCount] = a; segH[segCount] = isHub;
      segCount++;
    }
    function scan(i, j) { for (; j !== -1; j = next[j]) pair(i, j); }

    // Cap weight for a link of strength a at a node whose first dropped candidate is t:
    // 1 well above the cut-off, 0 at or below it, a short linear fade in between.
    function capWeight(t, a) { return t <= 0 ? 1 : clamp((1 - t / a) / CFG.rankSoft, 0, 1); }

    function link() {
      var i, j, s, k, cx, cy, a, w, b;
      segCount = 0;
      rankK = (small ? Math.min(P.maxLinks, CFG.smallMaxLinks) : P.maxLinks) + 1;
      boost = pullOn ? CFG.linkBoost * Math.min(1, P.pull) : 0;
      topN.fill(0, 0, count);
      cellHead.fill(-1, 0, cols * rows);
      for (i = 0; i < count; i++) {
        cx = clamp(((px[i] + pad) / cell) | 0, 0, cols - 1);
        cy = clamp(((py[i] + pad) / cell) | 0, 0, rows - 1);
        var c = cy * cols + cx;
        next[i] = cellHead[c]; cellHead[c] = i;
      }
      // Half neighbourhood (own cell, E, SW, S, SE) visits every pair exactly once.
      for (cy = 0; cy < rows; cy++) {
        for (cx = 0; cx < cols; cx++) {
          var here = cy * cols + cx, below = here + cols, hasE = cx + 1 < cols, hasS = cy + 1 < rows;
          for (i = cellHead[here]; i !== -1; i = next[i]) {
            scan(i, next[i]);
            if (hasE) scan(i, cellHead[here + 1]);
            if (hasS) {
              if (cx > 0) scan(i, cellHead[below - 1]);
              scan(i, cellHead[below]);
              if (hasE) scan(i, cellHead[below + 1]);
            }
          }
        }
      }
      // Cut-off per node: the strength of the first candidate past its cap (0 = under the cap).
      for (i = 0; i < count; i++) thr[i] = topN[i] === rankK ? topS[i * KMAX + rankK - 1] : 0;

      // Weigh every visible candidate by both ends' caps, then bucket it.
      bucketN.fill(0);
      for (s = 0; s < segCount; s++) {
        a = segA[s]; i = segI[s]; j = segJ[s];
        w = Math.min(capWeight(thr[i], a), capWeight(thr[j], a));
        // sqrt mapping: finer alpha steps near zero, where a line is fading in or out.
        b = (Math.sqrt(Math.min(a * w, A_MAX) / A_MAX) * B) | 0;
        if (b < minB) { segK[s] = 255; continue; }         // too faint to leave a trace
        if (b >= B) b = B - 1;
        k = segH[s] ? B + b : b;
        segK[s] = k;
        bucketN[k]++;
      }
      // Counting sort: each bucket's stroke walks only its own segments.
      for (k = 0, s = 0; k < 2 * B; k++) { bucketAt[k] = s; bucketFill[k] = s; s += bucketN[k]; }
      bucketAt[2 * B] = s;
      for (s = 0; s < segCount; s++) if (segK[s] !== 255) order[bucketFill[segK[s]]++] = s;
    }

    // ---- Draw: one stroke per (colour, alpha) bucket, one fill per depth tier ----
    function draw() {
      var L = look, S = inkScale * fade, i, j, t, o, b, k, e, X, Y;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, canvas.width, canvas.height);   // transparent: the page shows through
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineWidth = 1;
      for (var g = 0; g < 2; g++) {
        ctx.strokeStyle = g ? accentCss : inkCss;
        for (b = 1; b < B; b++) {
          k = g * B + b;
          if (!bucketN[k]) continue;
          var q = (b + 0.5) / B;
          ctx.globalAlpha = Math.min(1, q * q * A_MAX * L.line * S);
          ctx.beginPath();
          for (o = bucketAt[k], e = bucketAt[k + 1]; o < e; o++) {
            i = segI[order[o]]; j = segJ[order[o]];
            ctx.moveTo(px[i], py[i]);
            ctx.lineTo(px[j], py[j]);
          }
          ctx.stroke();
        }
      }

      for (t = 0; t < 3; t++) {
        var r = TIER_R[t];
        ctx.fillStyle = tierCss[t];
        ctx.globalAlpha = Math.min(1, L.nodes[t] * S);
        ctx.beginPath();
        for (i = 0; i < count; i++) {
          if (tier[i] !== t || hub[i]) continue;
          X = px[i]; Y = py[i];
          if (X < -r || X > W + r || Y < -r || Y > H + r) continue;
          ctx.moveTo(X + r, Y);
          ctx.arc(X, Y, r, 0, TAU);
        }
        ctx.fill();
      }

      // Hubs: a soft glow that breathes over ~14 s, a thin ring, then a solid core.
      for (i = 0; i < count; i++) {
        if (!hub[i]) continue;
        X = px[i]; Y = py[i];
        if (X < -GLOW_R || X > W + GLOW_R || Y < -GLOW_R || Y > H + GLOW_R) continue;
        ctx.globalAlpha = Math.min(1, L.glow * (0.8 + 0.2 * Math.sin(clock * 0.45 + ph[i])) * S);
        ctx.drawImage(glow, X - GLOW_R, Y - GLOW_R, GLOW_R * 2, GLOW_R * 2);
      }
      ctx.strokeStyle = accentCss;
      ctx.fillStyle = accentCss;
      ctx.globalAlpha = Math.min(1, L.hubCore * 0.4 * S);
      ctx.beginPath();
      for (i = 0; i < count; i++) {
        if (!hub[i]) continue;
        ctx.moveTo(px[i] + HUB_RING, py[i]);
        ctx.arc(px[i], py[i], HUB_RING, 0, TAU);
      }
      ctx.stroke();
      ctx.globalAlpha = Math.min(1, L.hubCore * S);
      ctx.beginPath();
      for (i = 0; i < count; i++) {
        if (!hub[i]) continue;
        ctx.moveTo(px[i] + HUB_R, py[i]);
        ctx.arc(px[i], py[i], HUB_R, 0, TAU);
      }
      ctx.fill();

      if (!dark && !cssCeil) {
        // Fallback light ceiling (the element's opacity does this for free): one pass multiplies every
        // pixel's alpha by LIGHT_CEIL. Whatever stacked inside the frame (crossings, core over glow
        // over line) had alpha ≤ 1, so it ends ≤ the ceiling.
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = "destination-in";
        ctx.globalAlpha = 1;
        ctx.fillStyle = CEIL_FILL;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.globalCompositeOperation = "source-over";
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      ctx.globalAlpha = 1;
    }

    function render(dt) {
      pullOn = pulling() && !reduced;
      step(dt);
      link();
      draw();
    }

    // ---- Loop ----
    function frame(now) {
      raf = 0;
      if (!running()) return;
      // ~30 fps, ~60 while the cursor is moving nodes (never the full 120/144 Hz of a fast display);
      // `last` stays put, so dt accumulates.
      if (last && now - last < (busy(now) ? 14.5 : 31)) { raf = window.requestAnimationFrame(frame); return; }
      var dt = last ? clamp((now - last) / 1000, 0, 0.05) : 0;   // clamp: no jump after a stall
      last = now;
      clock += dt;
      if (fade < 1) fade = Math.min(1, fade + dt / CFG.fadeIn);
      render(dt);
      raf = window.requestAnimationFrame(frame);
    }

    function sync() {
      if (st.stopped) return;
      if (running()) {
        if (!raf) { last = 0; raf = window.requestAnimationFrame(frame); }
        return;
      }
      if (raf) { window.cancelAnimationFrame(raf); raf = 0; }
      if (fade < 1) { fade = 1; render(0); }   // a paused scene is a finished one
    }

    // ---- Listeners ----
    function onVisibility() { st.hidden = !!document.hidden; sync(); }
    function onResize() {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(function () {
        resizeTimer = 0;
        // Resizing clears the canvas: redraw at once, never show a blank frame.
        if (!st.stopped && resize(false)) render(0);
      }, CFG.resizeDebounce);
    }
    // Redraw at once even while running: the opacity flips now, the old frame must not wait for it.
    function onTheme() { if (st.stopped) return; readTheme(); render(0); }
    function onReduce() {
      if (st.stopped) return;
      reduced = reducedNow();
      if (reduced) { mOn = false; ox.fill(0); oy.fill(0); fade = 1; }
      sync();
      if (!raf) render(0);
    }
    function onFine() { fine = !!(mqFine && mqFine.matches); if (!fine) mOn = false; }
    function onForced() { if (st.stopped) return; st.forced = !!(mqForced && mqForced.matches); sync(); }
    function onMove(e) {
      if (!fine || reduced || e.pointerType === "touch") return;
      mx = e.clientX; my = e.clientY; mOn = true;
      if (perf) moveAt = perf.now();
    }
    function onOut(e) { if (!e.relatedTarget) mOn = false; }   // pointer left the window
    function onBlur() { mOn = false; }

    var mo = window.MutationObserver ? new MutationObserver(function (list) {
      if (st.stopped) return;
      for (var k = 0; k < list.length; k++) {
        var name = list[k].attributeName;
        if (name === "data-theme") onTheme();
        else if (name === "data-motion") { st.motionOff = motionOffNow(); sync(); }
        else if (name === "data-preview-motion") onReduce();
      }
    }) : null;
    if (mo) mo.observe(root, { attributes: true, attributeFilter: ["data-motion", "data-theme", "data-preview-motion"] });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("resize", onResize);
    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("mouseout", onOut);
    window.addEventListener("blur", onBlur);
    var offReduce = listenMq(mqReduce, onReduce);
    var offDark = listenMq(mqDark, onTheme);
    var offFine = listenMq(mqFine, onFine);
    var offForced = listenMq(mqForced, onForced);

    // ---- First frame: complete and static when nothing may move; else fade in ----
    // If the canvas is still at the 300×150 default, its layout size would follow the bitmap we
    // set and grow on every resize: pin it to the viewport instead.
    if (canvas.clientWidth === 300 && canvas.clientHeight === 150 && !canvas.style.width) {
      canvas.style.width = "100%";
      canvas.style.height = "100%";
    }
    resize(true);
    readTheme();
    fade = running() ? 0 : 1;
    render(0);
    sync();

    return {
      lightFriendly: true,   // light theme: ink at low alpha under a hard per-pixel ceiling (element opacity)
      pause: function () { if (st.stopped) return; st.user = true; sync(); },
      resume: function () { if (st.stopped) return; st.user = false; sync(); },
      // Live: no restart, no intro replay. Counts and link length re-lay the world in place;
      // a paused or reduced scene gets one complete frame with the new value.
      set: function (key, value) {
        var p = BY_KEY[key];
        if (!p || st.stopped) return;
        var v = norm(p, value), old = P[key];
        P[key] = v;
        if ((key === "nodes" || key === "links") && v !== old) layout(KEEP, true);
        if (!raf) render(0);   // running: the next frame picks it up (pull 0 lets the lean spring back)
      },
      stop: function () {
        if (st.stopped) return;
        st.stopped = true;
        if (raf) window.cancelAnimationFrame(raf);
        raf = 0;
        window.clearTimeout(resizeTimer);
        resizeTimer = 0;
        if (mo) mo.disconnect();
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("resize", onResize);
        window.removeEventListener("pointermove", onMove, { passive: true });
        document.removeEventListener("mouseout", onOut);
        window.removeEventListener("blur", onBlur);
        offReduce(); offDark(); offFine(); offForced();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (cssCeil) canvas.style.opacity = baseOpacity;
      }
    };
  }

  window.PortfolioBG = window.PortfolioBG || {};
  window.PortfolioBG["constellation"] = {
    label: "Constelación",
    layer: "bg",
    themes: ["dark"],
    // Copies: the panel may keep state on these objects without moving this module's defaults.
    params: PARAMS.map(function (p) {
      return { key: p.key, label: p.label, min: p.min, max: p.max, step: p.step, value: p.value, unit: p.unit };
    }),
    start: start
  };
})();
