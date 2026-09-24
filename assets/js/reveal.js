// Scroll reveal: headings, paragraphs, cards, images, carousels, chips, lists and diagrams appear
// with a short animation as they come into view, once, in the order a reader meets them. Two
// strengths:
//   bold (default): a 40px rise and fade over ~800ms, an 8px blur that clears on headings, images
//     and carousels scaling up from 0.94, chips popping in a 30ms cascade, cards 80ms apart; on
//     load the hero h1 rises word by word, then the subhead, lede, chips and buttons; and the hero
//     eases back (opacity >= 0.35, scale >= 0.96) as it scrolls away;
//   soft: a 16px rise and fade over ~450ms, nothing else.
// "off" leaves the page as it is.
//
// Contract (shared contract v2): window.PortfolioReveal = { set(mode), mode() }, modes "off",
// "soft", "bold". The head snippet sets <html data-reveal> and, when a reveal will run,
// <html class="reveal-pending">, which reveal.css uses to hide exactly the targets at first paint.
// This module takes over at DOMContentLoaded (every deferred script has run by then, so site.js
// has settled <html data-motion>), gives each target its own start state and drops
// .reveal-pending in the same task: nothing flashes. The first screen starts playing in that same
// task, so it moves on the next frame. On a slow load the first screen does not wait for this
// script: reveal.css lets the hero through after 1.6 s, the snippet everything after 4 s, and on
// screen only what is still hidden (its computed opacity) is ever armed.
//
// Always visible: without JS; under prefers-reduced-motion (unless <html data-preview-motion=
// "force">); under the site's Pause (<html data-motion="off">); in print (reveal.css hides only on
// screen, and beforeprint lands everything); in "off". Pausing or switching off mid-page finishes
// every reveal at once. Only what the viewer cannot see yet is ever hidden: a unit already on
// screen or scrolled past is never taken away, one jumped over (an anchor link, the End key) is
// shown in place without playing, one that takes keyboard focus lands at once, and units in a
// hidden tab panel or a closed <details> play when shown. A timer never reveals anything below the
// fold, so a page that is not scrolled stays still. Back from the back/forward cache, the mode,
// the hero and what is on screen are all read again.
//
// Mechanics: IntersectionObserver (no scroll timelines, so Chrome, Safari and Firefox behave the
// same), CSS transitions on opacity, translate, scale, rotate and filter only (no layout shift),
// will-change only while a unit travels, and every class and inline property removed once it lands.
(function () {
  "use strict";

  var root = document.documentElement;
  var MODES = { off: true, soft: true, bold: true };
  var DEFAULT_MODE = "bold";
  var MOTION_KEY = "portfolio:motion";      // site.js's saved Pause
  var IDLE = 0, ARMED = 1, PLAYING = 2;     // a unit's state: visible / waiting / travelling
  var SWEEP_DEBOUNCE = 140;                 // ms after the last scroll or resize: catch what the observer skipped
  var LATE_SWEEP = 1500;                    // ms after arming: one more look at what is on screen (never below it)
  var SETTLE_SLACK = 120;                   // ms after a batch's last transition before its classes go
  var HERO_RESIZE = 150;                    // ms: resize debounce for the hero's measurements
  var HERO_FADE = 0.25;                     // hero fully scrolled away: opacity 0.75, so text still on screen keeps muted ≥ 4.5:1
  var HERO_SHRINK = 0.04;                   // ... scale 0.96
  var HERO_SINK = 28;                       // ... 28px below its place: it trails the scroll a little
  var STILL_HIDDEN = 0.05;                  // computed opacity under which a first-screen unit counts as hidden
  var SKIP = ".fondo-toast, #bg-canvas, #bg-ships, svg";   // never a unit, nor inside one of these

  // Per strength. dur/durSm mirror --rv-dur/--rv-dur-sm in reveal.css (the clean-up timer needs
  // them). margin: the observer's bottom rootMargin, so a unit starts just before it enters (a
  // waiting unit sits --rv-rise lower than its place, hence more room in bold). step: what a unit
  // adds to its batch's running delay, so units entering together play in reading order; nest:
  // where the first unit nested in another starts, relative to it; nestCap: the latest a nested
  // unit waits after its host; cap: the latest any top-level unit of a batch waits. kid: the step
  // of a group's cascade (chips, buttons, rows, words); lead: its first kid waits this long after
  // the group; span: the longest cascade (steps shrink to fit).
  var TIMING = {
    bold: {
      dur: 800, durSm: 550, margin: 64, cap: 1100, nest: 90, nestCap: 600, span: 380,
      step: { head: 100, text: 80, card: 80, media: 90, figure: 90, fade: 50, chip: 40, group: 60 },
      kid: { word: 120, chip: 30, btn: 70, item: 70, icon: 0 },
      lead: { word: 0, chip: 0, btn: 0, item: 80, icon: 180 }
    },
    soft: {
      dur: 450, durSm: 350, margin: 40, cap: 600, nest: 60, nestCap: 360, span: 220,
      step: { head: 60, text: 50, card: 60, media: 60, figure: 60, fade: 30, chip: 25, group: 40 },
      kid: { word: 70, chip: 18, btn: 45, item: 45, icon: 0 },
      lead: { word: 0, chip: 0, btn: 0, item: 50, icon: 100 }
    }
  };
  var SHORT = { chip: true, btn: true, icon: true };   // kinds that travel for durSm

  function children(sel) {
    return function (el) {
      var out = [];
      for (var i = 0; i < el.children.length; i++) if (el.children[i].matches(sel)) out.push(el.children[i]);
      return out;
    };
  }
  function bullets(el) { return Array.prototype.slice.call(el.querySelectorAll("ul > li")); }

  // What reveals, first match wins. kind picks the start state in reveal.css ("group" has none of
  // its own: only its kids move). reveal.css repeats every selector in its .reveal-pending list,
  // which hides them at first paint: keep the two in step.
  var RULES = [
    { sel: ".hero h1, .case-head h1", kind: "head", split: true },           // words rise in sequence (bold)
    { sel: "main h2", kind: "head", kids: children("svg.i"), kidKind: "icon" }, // the icon pops after its title
    { sel: ".xpanel-title", kind: "head" },
    { sel: "ul.tags, .case-head .chips", kind: "group", kids: children("li, .chip"), kidKind: "chip" },
    { sel: ".actions, .xtab-list", kind: "group", kids: children(".btn, .xtab"), kidKind: "btn" },
    { sel: ".feature .chip, .card > .chip", kind: "chip" },
    { sel: ".featured > .feature, .cards > .card, .xitems > .xitem, .decisions > li, .contact-card", kind: "card" },
    { sel: ".timeline > li", kind: "card", kids: bullets, kidKind: "item" },
    { sel: "dl.facts", kind: "fade", kids: children("div"), kidKind: "item" },
    { sel: ".feature > .carousel, .card > .carousel, .card > .media, .xitem .carousel, .xitem .ximg, " +
           ".project-screens .carousel, figure.demo, .shots > figure", kind: "media" },  // the carousel, never a slide
    { sel: "figure.diagram", kind: "figure" },                              // the figure as a block; its SVG is not touched
    { sel: ".limits", kind: "fade" },
    { sel: ".hero .eyebrow, .hero .role, .hero .lede, .hero .meta-line, .case-head .lede, main > .wrap > .back, " +
           ".section-head > p, .xpanel > p, .contact-card .lede, ul.points > li, " +
           "main section > .wrap > p, main section > .wrap > h3, .next-case > a, .site-footer .wrap > *", kind: "text" }
  ];

  var supported = !!(window.IntersectionObserver && window.WeakMap && root.classList &&
                     Element.prototype.matches && Element.prototype.closest);
  var reduceMq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

  var mode = readMode();
  var booted = false, broken = false, active = false, armedMode = "";
  var units = [], owner = supported ? new window.WeakMap() : null;   // element -> its unit (units and kids)
  var io = null, rootObserver = null, sweeping = false;
  var sweepTimer = 0, lateTimer = 0, timers = {}, timerSeq = 0;
  var hero = { el: null, top: 0, h: 0, head: 0, y: 0, p: -1, raf: 0, timer: 0 };

  function readMode() {
    var m = root.getAttribute("data-reveal");
    return m && MODES.hasOwnProperty(m) ? m : DEFAULT_MODE;
  }
  function timing() { return TIMING[mode === "soft" ? "soft" : "bold"]; }
  function viewportH() { return window.innerHeight || root.clientHeight || 0; }
  function stored() { try { return window.localStorage.getItem(MOTION_KEY); } catch (e) { return null; } }
  function reducedNow() {
    return !!(reduceMq && reduceMq.matches) && root.getAttribute("data-preview-motion") !== "force";
  }
  // site.js writes data-motion as it loads; before that, its saved Pause decides.
  function motionOn() {
    var m = root.getAttribute("data-motion");
    if (m === "off") return false;
    if (m === "on") return true;
    return stored() !== "off";
  }
  function wanted() { return supported && mode !== "off" && !reducedNow() && motionOn(); }

  function listen(mq, fn) {
    if (!mq) return;
    if (mq.addEventListener) mq.addEventListener("change", fn); else if (mq.addListener) mq.addListener(fn);
  }
  function warn(e) {
    try { if (window.console && window.console.warn) window.console.warn("[reveal]", e); } catch (x) { /* no console */ }
  }

  // Anything that throws leaves the page fully visible and the reveal switched off for good.
  function guard(fn) {
    try { fn(); } catch (e) { fail(e); }
  }
  function fail(e) {
    if (broken) return;
    broken = true;
    warn(e);
    try { deactivate(); } catch (e2) { root.classList.remove("rv-on"); }
    root.classList.remove("reveal-pending");
  }

  function later(fn, ms) {
    var id = ++timerSeq;
    timers[id] = window.setTimeout(function () { delete timers[id]; guard(fn); }, ms);
  }
  function clearTimers() {
    for (var k in timers) if (timers.hasOwnProperty(k)) window.clearTimeout(timers[k]);
    timers = {};
  }

  // ---- Units: one observed element, which may carry kids that cascade after it ----
  function unclaimed(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) if (!owner.has(list[i])) out.push(list[i]);
    return out;
  }
  function collect() {
    for (var r = 0; r < RULES.length; r++) {
      var rule = RULES[r], list = document.querySelectorAll(rule.sel);
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        if (owner.has(el) || el.closest(SKIP)) continue;
        var u = {
          el: el, rule: rule, base: rule.kids ? unclaimed(rule.kids(el)) : [],
          kids: [], kidKind: "", visual: true, state: IDLE, restore: null, d: 0, inner: 0
        };
        owner.set(el, u);
        for (var k = 0; k < u.base.length; k++) owner.set(u.base[k], u);
        units.push(u);
      }
    }
  }

  // The hero h1, one span per word. Screen readers get the heading's text once, from a visually
  // hidden copy; the animated words are aria-hidden. The original text nodes come back as soon as
  // the words have landed (or the reveal stops), so the finished DOM is the page's own.
  function splitWords(u) {
    var h = u.el, nodes = Array.prototype.slice.call(h.childNodes), i;
    for (i = 0; i < nodes.length; i++) if (nodes[i].nodeType !== 3) return null;   // plain text only
    var text = h.textContent.replace(/\s+/g, " ").trim();
    if (!text) return null;
    var sr = document.createElement("span");
    sr.className = "rv-sr";
    sr.textContent = text;
    var box = document.createElement("span");
    box.className = "rv-words";
    box.setAttribute("aria-hidden", "true");
    var words = text.split(" "), spans = [];
    for (i = 0; i < words.length; i++) {
      if (i) box.appendChild(document.createTextNode(" "));
      var s = document.createElement("span");
      s.className = "rv-w";
      s.textContent = words[i];
      box.appendChild(s);
      spans.push(s);
    }
    h.textContent = "";
    h.appendChild(sr);
    h.appendChild(box);
    u.restore = function () {
      h.textContent = "";
      for (var j = 0; j < nodes.length; j++) h.appendChild(nodes[j]);
    };
    return spans;
  }

  function prepare(u) {
    u.kids = u.base.slice();
    u.kidKind = u.rule.kidKind || "";
    u.visual = u.rule.kind !== "group";
    if (u.rule.split && mode === "bold") {
      var words = splitWords(u);
      if (words) { u.kids = words; u.kidKind = "word"; u.visual = false; }
    }
  }
  function mark(el, kind) {
    el.classList.add("rv");
    el.setAttribute("data-rv", kind);
  }
  function clear(el) {
    el.classList.remove("rv", "rv-in");
    el.removeAttribute("data-rv");
    el.style.removeProperty("--rv-d");
    if (el.getAttribute("style") === "") el.removeAttribute("style");
  }
  function go(el, delay) {
    el.style.setProperty("--rv-d", Math.round(delay) + "ms");
    el.classList.add("rv-in");
  }
  // Back to the page's own markup. Natural styles never transition opacity, translate, scale,
  // rotate or filter, so a waiting unit settled here simply appears, with no animation.
  function settle(u) {
    if (u.state === IDLE) return;
    if (io && u.state === ARMED) io.unobserve(u.el);
    clear(u.el);
    for (var i = 0; i < u.kids.length; i++) clear(u.kids[i]);
    if (u.restore) { var r = u.restore; u.restore = null; r(); }
    u.kids = [];
    u.state = IDLE;
  }

  // Not visible now: outside the layout (a hidden tab panel, a closed <details> in older engines)
  // or entirely below the viewport.
  function unseen(el, vh) {
    if (!el.getClientRects().length) return true;
    return el.getBoundingClientRect().top >= vh;
  }
  // Still hidden at first paint. .reveal-pending may already have let it through (reveal.css's cap
  // on a slow load, or the snippet's fail-safe), or never hidden it (an engine without :is()).
  function stillHidden(el) {
    return parseFloat(window.getComputedStyle(el).opacity) < STILL_HIDDEN;
  }
  // Which idle units to arm. pending (first paint, .reveal-pending set): every unit below the
  // viewport or outside the layout, plus each unit on screen that is still hidden, which also goes
  // in "now" to play at once; one above the viewport stays as it is. Otherwise only the unseen.
  // Reads only: the caller writes afterwards, so the pass costs one layout, not one per unit.
  function pick(pending) {
    var vh = viewportH(), below = vh + timing().margin, out = { arm: [], now: [] }, i, u, r;
    for (i = 0; i < units.length; i++) {
      u = units[i];
      if (u.state !== IDLE) continue;
      if (!pending) { if (unseen(u.el, vh)) out.arm.push(u); continue; }
      if (!u.el.getClientRects().length) { out.arm.push(u); continue; }
      r = u.el.getBoundingClientRect();
      if (r.top >= below) out.arm.push(u);
      else if (r.bottom > 0 && stillHidden(u.el)) { out.arm.push(u); out.now.push(u); }
    }
    return out;
  }
  function arm(list) {
    for (var i = 0, k, u; i < list.length; i++) {
      u = list[i];
      prepare(u);
      if (u.visual) mark(u.el, u.rule.kind);
      for (k = 0; k < u.kids.length; k++) mark(u.kids[k], u.kidKind);
      u.state = ARMED;
      io.observe(u.el);
    }
  }

  function docOrder(a, b) {
    if (a === b) return 0;
    return (a.el.compareDocumentPosition(b.el) & 4) ? -1 : 1;   // 4: b follows a
  }
  function durOf(kind, T) { return SHORT[kind] ? T.durSm : T.dur; }

  // One batch: the units that entered together. Top-level units follow each other by their kind's
  // step (a row of cards lands 80ms apart); a unit nested in another (a card's carousel, its chips)
  // follows its host instead, so the next card in the row does not wait for the first one's chips.
  function play(list) {
    var T = timing(), t = 0, end = 0, stack = [], batch = [], i, j, u;
    list.sort(docOrder);
    for (i = 0; i < list.length; i++) {
      u = list[i];
      if (u.state !== ARMED) continue;
      while (stack.length && !stack[stack.length - 1].el.contains(u.el)) stack.pop();
      var host = stack.length ? stack[stack.length - 1] : null;
      var n = u.kids.length, kstep = T.kid[u.kidKind] || 0;
      if (n > 1 && kstep * (n - 1) > T.span) kstep = T.span / (n - 1);
      var adv = (T.step[u.rule.kind] || 0) + (n > 1 ? (n - 1) * kstep * 0.5 : 0);
      var d;
      if (host) { d = host.d + Math.min(host.inner, T.nestCap); host.inner += adv; }
      else { d = Math.min(t, T.cap); t += adv; }
      u.d = d;
      u.inner = T.nest;
      stack.push(u);
      u.state = PLAYING;
      if (io) io.unobserve(u.el);
      if (u.visual) { go(u.el, d); end = Math.max(end, d + durOf(u.rule.kind, T)); }
      if (n) {
        var k0 = d + (T.lead[u.kidKind] || 0);
        for (j = 0; j < n; j++) go(u.kids[j], k0 + j * kstep);
        end = Math.max(end, k0 + (n - 1) * kstep + durOf(u.kidKind, T));
      }
      batch.push(u);
    }
    if (!batch.length) return;
    later(function () {
      for (var b = 0; b < batch.length; b++) if (batch[b].state === PLAYING) settle(batch[b]);
    }, end + SETTLE_SLACK);
  }

  function isPast(r) { return (r.width > 0 || r.height > 0) && r.bottom <= 0; }

  function onIntersect(entries) {
    guard(function () {
      var now = [], past = [], i, en, u;
      for (i = 0; i < entries.length; i++) {
        en = entries[i];
        u = owner.get(en.target);
        if (!u || u.el !== en.target || u.state !== ARMED) continue;
        if (en.isIntersecting) now.push(u);
        else if (isPast(en.boundingClientRect)) past.push(u);   // above the viewport: show it in place
      }
      for (i = 0; i < past.length; i++) settle(past[i]);
      if (now.length) play(now);
      idleCheck();
    });
  }

  // Safety net for what the observer never reported: a unit jumped over in one frame (it went from
  // below the viewport to above it) or one it missed. Units on screen play; units above appear in
  // place. Units below the viewport are left alone. Not in a hidden tab: nothing renders there, and
  // the observer reports every unit on the first frame the tab is shown, so they play then.
  function sweep() {
    sweepTimer = 0;
    guard(function () {
      if (!active || document.visibilityState === "hidden") return;
      var vh = viewportH(), now = [], past = [], i, u, r;
      for (i = 0; i < units.length; i++) {
        u = units[i];
        if (u.state !== ARMED || !u.el.getClientRects().length) continue;
        r = u.el.getBoundingClientRect();
        if (r.bottom <= 0) past.push(u);
        else if (r.top < vh) now.push(u);
      }
      for (i = 0; i < past.length; i++) settle(past[i]);
      if (now.length) play(now);
      idleCheck();
    });
  }
  function queueSweep() {
    if (sweepTimer) window.clearTimeout(sweepTimer);
    sweepTimer = window.setTimeout(sweep, SWEEP_DEBOUNCE);
  }
  function listenSweep() {
    if (sweeping) return;
    sweeping = true;
    window.addEventListener("scroll", queueSweep, { passive: true });
    window.addEventListener("resize", queueSweep, { passive: true });
  }
  function unlistenSweep() {
    if (sweepTimer) { window.clearTimeout(sweepTimer); sweepTimer = 0; }
    if (!sweeping) return;
    sweeping = false;
    window.removeEventListener("scroll", queueSweep, { passive: true });
    window.removeEventListener("resize", queueSweep, { passive: true });
  }
  // Nothing left waiting: the observer and the sweep listeners go.
  function idleCheck() {
    for (var i = 0; i < units.length; i++) if (units[i].state === ARMED) return;
    if (io) { io.disconnect(); io = null; }
    unlistenSweep();
  }

  // ---- The hero easing back as it scrolls away (bold only) ----
  // Reads and writes never share a turn: the scroll position is read in the (passive) scroll event,
  // which a browser dispatches at the start of a frame before any rAF callback has written, and the
  // styles are written in at most one rAF per frame, only when the progress changed. The hero's
  // place comes from layout offsets, which the transform written here does not change.
  function scrollTop() { return window.pageYOffset || root.scrollTop || 0; }
  function heroFind() {
    var el = document.querySelector(".hero > .wrap, .case-head");
    return el && !el.closest(SKIP) ? el : null;
  }
  // Reads only.
  function heroMeasure(el) {
    var top = 0, n = el, header = document.querySelector(".site-header");
    while (n) { top += n.offsetTop; n = n.offsetParent; }
    hero.top = top;
    hero.h = el.offsetHeight;
    hero.head = header ? header.offsetHeight : 0;
    hero.y = scrollTop();
    hero.p = -1;   // repaint even if the scroll did not move
  }
  // Writes only: heroMeasure(el) has run.
  function heroStart(el) {
    hero.el = el;
    el.classList.add("rv-hero");
    window.addEventListener("scroll", heroScroll, { passive: true });
    window.addEventListener("resize", heroResize, { passive: true });
    heroPaint();
  }
  function heroStop() {
    if (!hero.el) return;
    window.removeEventListener("scroll", heroScroll, { passive: true });
    window.removeEventListener("resize", heroResize, { passive: true });
    if (hero.raf) { window.cancelAnimationFrame(hero.raf); hero.raf = 0; }
    if (hero.timer) { window.clearTimeout(hero.timer); hero.timer = 0; }
    var el = hero.el;
    hero.el = null;
    hero.p = -1;
    el.classList.remove("rv-hero");
    el.style.removeProperty("opacity");
    el.style.removeProperty("transform");
    if (el.getAttribute("style") === "") el.removeAttribute("style");
  }
  // Measure again and repaint now (load, fonts, a restore from the back/forward cache).
  function heroRefresh() {
    if (!hero.el) return;
    heroMeasure(hero.el);
    heroPaint();
  }
  function heroProgress() {
    var span = Math.max(1, hero.top + hero.h - hero.head);   // gone once its bottom reaches the header
    return Math.round(Math.max(0, Math.min(1, hero.y / span)) * 1000) / 1000;
  }
  function heroScroll() {
    if (!hero.el) return;
    hero.y = scrollTop();
    if (!hero.raf && heroProgress() !== hero.p) hero.raf = window.requestAnimationFrame(heroFrame);
  }
  function heroFrame() { hero.raf = 0; guard(heroPaint); }
  function heroResize() {
    if (hero.timer) window.clearTimeout(hero.timer);
    hero.timer = window.setTimeout(function () {
      hero.timer = 0;
      guard(heroRefresh);
    }, HERO_RESIZE);
  }
  function heroPaint() {
    if (!hero.el) return;
    var p = heroProgress();
    if (p === hero.p) return;
    hero.p = p;
    var e = p * p * (3 - 2 * p);   // smoothstep: eases into and out of the fade
    var s = hero.el.style;
    if (e <= 0) { s.removeProperty("opacity"); s.removeProperty("transform"); return; }
    s.opacity = (1 - HERO_FADE * e).toFixed(3);
    s.transform = "translate3d(0," + (HERO_SINK * e).toFixed(1) + "px,0) scale(" + (1 - HERO_SHRINK * e).toFixed(4) + ")";
  }

  // ---- Switching on and off ----
  // pending: .reveal-pending still hides the targets (first paint), see pick().
  function activate(pending) {
    var T = timing(), heroEl = null, picked, u;
    active = true;
    armedMode = mode;
    io = new window.IntersectionObserver(onIntersect, { rootMargin: "0px 0px " + T.margin + "px 0px", threshold: 0 });
    // Reads first (the hero's place, where each unit is), then the writes.
    if (mode === "bold") { heroEl = heroFind(); if (heroEl) heroMeasure(heroEl); }
    picked = pick(pending);
    root.classList.add("rv-on");
    arm(picked.arm);
    if (heroEl) heroStart(heroEl);
    // The first screen plays in this task, so it moves on the next frame instead of waiting for
    // the observer's first report (a frame later, more behind a busy main thread). A transition
    // needs its start state computed first: one style read settles every armed element at once.
    // In a tab opened in the background the observer plays them when the tab is shown.
    if (picked.now.length && document.visibilityState !== "hidden") {
      u = picked.now[0];
      void window.getComputedStyle(u.visual || !u.kids.length ? u.el : u.kids[0]).opacity;
      play(picked.now);
    }
    listenSweep();
    lateTimer = window.setTimeout(sweep, LATE_SWEEP);
    idleCheck();
  }
  // Everything waiting or travelling lands at once: rv-on goes first, so no start state or
  // transition applies while the classes come off.
  function deactivate() {
    active = false;
    clearTimers();
    if (lateTimer) { window.clearTimeout(lateTimer); lateTimer = 0; }
    root.classList.remove("rv-on");
    for (var i = 0; i < units.length; i++) settle(units[i]);
    if (io) { io.disconnect(); io = null; }
    unlistenSweep();
    heroStop();
  }
  // A new mode, or motion allowed again: only what is not on screen re-arms, so nothing visible
  // disappears; what the viewer scrolls to next plays in the new mode.
  function apply() {
    if (!booted || broken) return;
    if (!wanted()) { if (active) deactivate(); return; }
    if (active && armedMode === mode) return;
    if (active) deactivate();
    activate(false);
  }

  function onRootChange() {
    guard(function () { mode = readMode(); apply(); });
  }
  function onLoad() {
    guard(function () {
      heroRefresh();
      if (active) queueSweep();
    });
  }
  // Back from the back/forward cache the page is as it was frozen, but the viewport, the scroll and
  // the site's switches may have changed meanwhile: what was travelling lands, the mode is read
  // again, the hero is measured and repainted from the current scroll, and a sweep catches what
  // the observer may not report.
  function onPageShow(e) {
    if (!e || !e.persisted) return;
    guard(function () {
      for (var i = 0; i < units.length; i++) if (units[i].state === PLAYING) settle(units[i]);
      mode = readMode();
      apply();
      heroRefresh();
      if (active) queueSweep();
    });
  }
  // Printing lands everything (reveal.css already hides nothing in print; this also covers a PDF
  // made with screen styles), and what landed stays landed afterwards. The hero's inline fade is
  // overridden by reveal.css's print rule.
  function onPrint() {
    guard(function () {
      if (!active) return;
      for (var i = 0; i < units.length; i++) settle(units[i]);
      idleCheck();
    });
  }
  // Keyboard focus never lands on something hidden or still on its way in: every unit around the
  // focused element lands at once.
  function onFocus(e) {
    guard(function () {
      if (!active) return;
      var hit = false, n, u;
      for (n = e.target; n && n.nodeType === 1; n = n.parentNode) {
        u = owner.get(n);
        if (u && u.state !== IDLE) { settle(u); hit = true; }
      }
      if (hit) idleCheck();
    });
  }

  function boot() {
    if (booted) return;
    booted = true;
    guard(function () {
      mode = readMode();
      if (root.getAttribute("data-reveal") !== mode) root.setAttribute("data-reveal", mode);
      if (supported) {
        collect();
        // While .reveal-pending hides the targets, every unit can start from its own start state,
        // the first screen included (it then plays in reading order). Without it (the 4 s
        // fail-safe fired, or the snippet did not run), only what is off screen may hide.
        if (wanted()) activate(root.classList.contains("reveal-pending"));
      }
      root.classList.remove("reveal-pending");
      if (!supported) return;
      if (window.MutationObserver) {
        rootObserver = new window.MutationObserver(onRootChange);
        rootObserver.observe(root, { attributes: true, attributeFilter: ["data-reveal", "data-motion", "data-preview-motion"] });
      }
      listen(reduceMq, onRootChange);
      window.addEventListener("load", onLoad);
      window.addEventListener("pageshow", onPageShow);
      window.addEventListener("beforeprint", onPrint);
      document.addEventListener("focusin", onFocus, true);
      if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
        document.fonts.ready.then(function () { guard(heroRefresh); });
      }
    });
  }

  window.PortfolioReveal = {
    set: function (m) {
      guard(function () {
        mode = MODES.hasOwnProperty(m) ? m : DEFAULT_MODE;
        if (root.getAttribute("data-reveal") !== mode) root.setAttribute("data-reveal", mode);
        apply();
      });
    },
    mode: function () { return mode; }
  };

  // Deferred scripts run before DOMContentLoaded, so the normal path is the listener. Loaded later
  // than that, the "load" listener (or an already complete document) starts it instead.
  if (document.readyState === "complete") boot();
  else {
    document.addEventListener("DOMContentLoaded", boot);
    window.addEventListener("load", boot);
  }
})();
