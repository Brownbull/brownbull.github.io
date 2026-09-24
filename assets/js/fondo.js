// Animated background ("fondo"): a sky behind the page and, in some configurations, small fleets
// of ships crossing it. Four configurations, in this order: constellation with ships,
// constellation, stars with ships, stars. The light theme swaps each sky for the star chart and
// keeps that configuration's ships. Clicking the name in the header cycles them on the home pages
// (where the name links to the page itself); elsewhere it still goes home. The choice is kept in
// localStorage "portfolio:fondo" (0-3, default 0) and applies on every page.
//
// Modules register on window.PortfolioBG (background contract v2): { label, layer, themes, params,
// start(canvas, values) }, and start() returns { pause, resume, stop, set }. This script owns the
// canvases (#bg-canvas, then #bg-ships: first children of <body>, so the scrim paints above them)
// and the flags on <html> that size the scrim in the stylesheet: .has-bg while anything draws,
// data-bg (module name or "none"), data-ships ("on" / "off") and data-fondo (the configuration).
// The flags go up BEFORE a module starts: modules read the page tokens as they start, and .has-bg
// changes --muted and --accent. A missing or failing module is skipped; the page reads as without JS.
//
// Motion contract (site.js): the modules follow <html data-motion> and the OS reduced-motion
// setting on their own (under it they draw one complete still frame). Case pages keep the sky and
// the ships as a still frame (started, then paused), so the architecture diagrams carry the motion.
// Under forced colours nothing starts: the system does not recolour a canvas. The header's
// pause/play button (.motion-toggle) drives site.js's single switch.
(function () {
  "use strict";

  var root = document.documentElement;
  var KEY = "portfolio:fondo";                 // this configuration, 0-3
  var MOTION_KEY = "portfolio:motion";         // site.js's remembered pause
  var TOAST_MS = 1600;                         // ms the toast stays up
  var TOAST_GAP = 50;                          // ms between clearing the live region and the new text
  var TOAST_FADE = 400;                        // ms after hiding, the old text leaves the live region

  // The owner's choice (2026-09-24). Params left out are the module's defaults.
  var CONSTELLATION = { nodes: 2.15, links: 1.55, maxLinks: 12, speed: 1.7, pull: 0.9 };
  var STARFIELD = { density: 2.5, speed: 2.65, twinkle: 1.2, shooting: 8, parallax: 2 };
  var CONFIGS = [
    { bg: "constellation", bp: CONSTELLATION,
      sp: { fleets: 4, perFleet: 1, speed: 1.55, size: 1.25, trails: 1, formation: 0.65 },
      en: "Constellation with ships", es: "Constelación con naves" },
    { bg: "constellation", bp: CONSTELLATION, sp: null, en: "Constellation", es: "Constelación" },
    { bg: "starfield", bp: STARFIELD,
      sp: { fleets: 4, perFleet: 1, speed: 0.95, size: 1.5, trails: 1, formation: 0.65 },
      en: "Stars with ships", es: "Estrellas con naves" },
    { bg: "starfield", bp: STARFIELD, sp: null, en: "Stars", es: "Estrellas" }
  ];
  var N = CONFIGS.length;
  // Light theme: every sky becomes the star chart (module defaults); the ships stay as configured.
  var LIGHT_BG = "starchart";
  var LIGHT_LABEL = {
    en: ["Star chart with ships", "Star chart"],
    es: ["Carta estelar con naves", "Carta estelar"]
  };
  var LANG = /^es\b/i.test(root.getAttribute("lang") || "") ? "es" : "en";
  var HINT = LANG === "es" ? "Haz clic para cambiar el fondo" : "Click to change the background";

  var reduceMq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  var darkMq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  var forcedMq = window.matchMedia ? window.matchMedia("(forced-colors: active)") : null;

  // ---- Small helpers ----
  function own(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function storeGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function storeSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }
  function listen(mq, fn) {
    if (!mq) return;
    if (mq.addEventListener) mq.addEventListener("change", fn); else if (mq.addListener) mq.addListener(fn);
  }
  function warn(msg, err) { if (window.console && window.console.error) window.console.error("[fondo] " + msg, err); }
  function copy(o) { var out = {}; for (var k in o) if (own(o, k)) out[k] = o[k]; return out; }

  function osReduced() { return !!(reduceMq && reduceMq.matches); }
  function forced() { return !!(forcedMq && forcedMq.matches); }
  // Exactly as site.js: the remembered choice on <html data-theme>, otherwise the OS.
  function effectiveTheme() {
    var t = root.getAttribute("data-theme");
    return t === "dark" || t === "light" ? t : (darkMq && darkMq.matches ? "dark" : "light");
  }
  function readIndex() {
    var v = storeGet(KEY);
    return v !== null && /^\d$/.test(v) && +v < N ? +v : 0;
  }

  // ---- Module registry ----
  function registry() { var r = window.PortfolioBG; return r && typeof r === "object" ? r : null; }
  function usable(m) { return !!m && typeof m.start === "function"; }
  function bgModule(name) {
    var reg = registry();
    return own(reg, name) && usable(reg[name]) && reg[name].layer !== "overlay" ? reg[name] : null;
  }
  function shipsModule() { var reg = registry(); return own(reg, "ships") && usable(reg.ships) ? reg.ships : null; }

  // ---- Canvases and controllers ----
  // A fresh canvas per start: a module never inherits another's context, transform or bitmap.
  // Tree order is the paint order: #bg-canvas, then #bg-ships, then the scrim (body::after).
  var bgCtl = null, shipsCtl = null, bgCanvas = null, shipsCanvas = null;
  function freshCanvas(id) {
    var stray = document.getElementById(id);   // one canvas per id, whoever left the old one
    if (stray && stray.parentNode) stray.parentNode.removeChild(stray);
    var c = document.createElement("canvas");
    c.id = id;
    c.setAttribute("aria-hidden", "true");
    c.style.cssText = "position:fixed;top:0;right:0;bottom:0;left:0;width:100%;height:100%;" +
      "z-index:-1;pointer-events:none;display:block";
    var body = document.body;
    if (id === "bg-ships" && bgCanvas && bgCanvas.parentNode === body) body.insertBefore(c, bgCanvas.nextSibling);
    else body.insertBefore(c, body.firstChild);
    return c;
  }
  function dropCanvas(c) { if (c && c.parentNode) c.parentNode.removeChild(c); return null; }
  function call(ctl, fn) {
    if (!ctl || typeof ctl[fn] !== "function") return;
    try { ctl[fn](); } catch (e) { warn(fn + "() failed", e); }
  }
  function launch(mod, canvas, values) {
    try {
      var ctl = mod.start(canvas, values);
      return ctl && typeof ctl === "object" ? ctl : null;
    } catch (e) { warn("module failed to start", e); return null; }
  }
  function flags(on, bg, ships) {
    root.classList.toggle("has-bg", on);
    root.setAttribute("data-bg", bg);
    root.setAttribute("data-ships", ships ? "on" : "off");
  }

  // ---- Apply: stop whatever runs, then start what the configuration and the theme ask for ----
  var index = readIndex();
  var isCase = !!document.querySelector("figure.diagram[data-fx]");
  var run = { bg: "none", ships: false, theme: effectiveTheme() };

  // Stop before restart: the old controllers drop their loops and listeners before a new one starts.
  function halt() {
    call(bgCtl, "stop"); bgCtl = null;
    call(shipsCtl, "stop"); shipsCtl = null;
    bgCanvas = dropCanvas(bgCanvas);
    shipsCanvas = dropCanvas(shipsCanvas);
  }

  function apply() {
    var theme = effectiveTheme(), cfg = CONFIGS[index];
    halt();
    run = { bg: "none", ships: false, theme: theme };
    root.setAttribute("data-fondo", String(index));
    if (forced() || !registry()) { flags(false, "none", false); return; }

    var name = theme === "light" ? LIGHT_BG : cfg.bg;
    var bm = bgModule(name), sm = cfg.sp ? shipsModule() : null;
    flags(!!(bm || sm), bm ? name : "none", !!sm);   // before start (see the header)
    if (bm) {
      bgCanvas = freshCanvas("bg-canvas");
      bgCtl = launch(bm, bgCanvas, theme === "light" ? {} : copy(cfg.bp));
      if (!bgCtl) { bgCanvas = dropCanvas(bgCanvas); flags(!!sm, "none", !!sm); }
      else { run.bg = name; if (isCase) call(bgCtl, "pause"); }
    }
    if (sm) {
      shipsCanvas = freshCanvas("bg-ships");
      shipsCtl = launch(sm, shipsCanvas, copy(cfg.sp));
      if (!shipsCtl) shipsCanvas = dropCanvas(shipsCanvas);
      else { run.ships = true; if (isCase) call(shipsCtl, "pause"); }
    }
    flags(!!(bgCtl || shipsCtl), run.bg, run.ships);   // what actually runs
  }

  function label() {
    var cfg = CONFIGS[index];
    return run.theme === "light" ? LIGHT_LABEL[LANG][cfg.sp ? 0 : 1] : cfg[LANG];
  }
  function current() {
    return { index: index, bg: run.bg, ships: run.ships, theme: run.theme, label: label() };
  }
  // Any integer picks a configuration (wrapping); anything else leaves the page as it is.
  function choose(i, announce) {
    var n = Math.floor(Number(i));
    if (!isFinite(n)) return current();
    index = ((n % N) + N) % N;
    storeSet(KEY, String(index));
    apply();
    if (announce) toast(label() + " · " + (index + 1) + "/" + N);
    return current();
  }

  // ---- Toast: one line under the header that names the new background ----
  // A polite live region, created once. The text is cleared, then set, so every change is
  // announced; once the toast has faded its text goes, so a reader never lands on a stale one.
  var toastEl = null, toastSet = 0, toastHide = 0, toastClear = 0;
  function ensureToast() {
    if (toastEl && toastEl.parentNode) return toastEl;
    toastEl = document.createElement("div");
    toastEl.className = "fondo-toast";
    toastEl.setAttribute("role", "status");
    toastEl.setAttribute("aria-live", "polite");
    document.body.appendChild(toastEl);
    return toastEl;
  }
  function toast(text) {
    var el = ensureToast();
    window.clearTimeout(toastSet); window.clearTimeout(toastHide); window.clearTimeout(toastClear);
    el.textContent = "";
    toastSet = window.setTimeout(function () {
      el.textContent = text;
      el.classList.add("is-on");
      toastHide = window.setTimeout(function () {
        el.classList.remove("is-on");
        toastClear = window.setTimeout(function () { el.textContent = ""; }, TOAST_FADE);
      }, TOAST_MS);
    }, TOAST_GAP);
  }

  // ---- The name in the header: cycles on the home pages, still a link everywhere else ----
  function pagePath(p) { p = p || "/"; return p.charAt(p.length - 1) === "/" ? p + "index.html" : p; }
  function isHere(a) {
    var loc = window.location;
    return a.protocol === loc.protocol && a.host === loc.host && pagePath(a.pathname) === pagePath(loc.pathname);
  }
  var brand = document.querySelector("header .brand");
  var brandHome = !!brand && typeof brand.pathname === "string" && isHere(brand);
  var brandTitle = brand ? brand.getAttribute("title") : null;
  function cycles() { return brandHome && !!registry() && !forced(); }
  function brandHint() {
    if (!brandHome) return;
    if (cycles()) brand.setAttribute("title", HINT);
    else if (brandTitle === null) brand.removeAttribute("title");
    else brand.setAttribute("title", brandTitle);
  }
  // "click" covers the mouse, touch and Enter on the link; a modifier or another button keeps the
  // browser's own behaviour (new tab, new window, download).
  if (brandHome) {
    brand.addEventListener("click", function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (!cycles()) return;
      e.preventDefault();
      choose(index + 1, true);
    });
  }

  // ---- Pause / play in the header (WCAG 2.2.2): site.js's single motion switch ----
  // The label names what a press does, as the theme button does (no aria-pressed: see stamp_chrome.py).
  // Hidden when the OS asks to reduce motion: nothing moves then (site.js decides that at load).
  var toggles = Array.prototype.slice.call(document.querySelectorAll(".motion-toggle"));
  var reducedAtLoad = osReduced();
  function motionOn() {
    var m = root.getAttribute("data-motion");
    return m === "off" ? false : m === "on" ? true : storeGet(MOTION_KEY) !== "off";
  }
  function labelMotion() {
    var paused = !motionOn(), hide = reducedAtLoad || osReduced();
    toggles.forEach(function (b) {
      var text = b.getAttribute(paused ? "data-to-play" : "data-to-pause");
      if (text) { b.setAttribute("aria-label", text); b.setAttribute("title", text); }
      b.removeAttribute("aria-pressed");
      b.hidden = hide;
      b.style.display = hide ? "none" : "";   // an author `display` on the button would override [hidden]
    });
  }
  toggles.forEach(function (b) {
    b.addEventListener("click", function () {
      var on = !motionOn();
      storeSet(MOTION_KEY, on ? "on" : "off");
      if (typeof window.__setMotion === "function") window.__setMotion(on);
      else root.setAttribute("data-motion", on ? "on" : "off");
      labelMotion();
    });
  });

  // ---- Changes made elsewhere ----
  // The theme picks the module, so a theme change restarts both. These listeners exist before any
  // module starts, so they run before the modules' own (which stop() then removes).
  function themeChanged() { if (effectiveTheme() !== run.theme) apply(); }
  if (window.MutationObserver) {
    new window.MutationObserver(function (records) {
      var theme = false, motion = false;
      for (var i = 0; i < records.length; i++) {
        if (records[i].attributeName === "data-theme") theme = true; else motion = true;
      }
      if (theme) themeChanged();
      if (motion) labelMotion();   // the diagrams' own Play/Pause, or site.js
    }).observe(root, { attributes: true, attributeFilter: ["data-theme", "data-motion"] });
  }
  listen(darkMq, themeChanged);
  listen(reduceMq, labelMotion);
  listen(forcedMq, function () { apply(); brandHint(); });
  // Back from the back/forward cache: another page may have changed the configuration since.
  window.addEventListener("pageshow", function (e) {
    if (!e || !e.persisted) return;
    var i = readIndex();
    if (i !== index) { index = i; apply(); } else themeChanged();
  });

  window.PortfolioFondo = {
    next: function () { return choose(index + 1, true); },   // as a click on the name: with the toast
    set: function (i) { return choose(i, false); },          // silent
    current: current
  };

  // ---- Boot ----
  labelMotion();
  brandHint();
  if (cycles()) ensureToast();   // the live region exists before its first message
  apply();
})();
