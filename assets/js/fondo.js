// Animated background ("fondo"): one starry sky behind every page, with shooting stars in the dark
// theme. The owner's settings (2026-09-24): density 2.5, drift speed 2.65, twinkle 1.2, 8 shooting
// stars a minute, parallax 2. Phones (≤ 640px) draw fewer stars (density 1.5): density is what
// costs the most there, and a small screen needs fewer for the same sky.
//
// The module registers on window.PortfolioBG.starfield (background contract v2): start(canvas,
// values) returns { pause, resume, stop, set }. It follows the theme on its own (faint ink dots in
// the light theme, no shooting stars there), <html data-motion> and the OS reduced-motion setting
// (one complete still frame). This script owns the canvas (#bg-canvas, first child of <body>, so the
// scrim paints above it) and the flags on <html> that size the scrim in the stylesheet: .has-bg,
// data-bg="starfield", data-ships="off". The flags go up BEFORE the module starts: it reads the page
// tokens as it starts, and .has-bg changes --muted and --accent.
//
// Case pages keep the sky as a still frame (started, then paused), so the architecture diagrams
// carry the motion. Under forced colours nothing starts: the system does not recolour a canvas.
// The header's pause/play button (.motion-toggle) drives site.js's single motion switch.
(function () {
  "use strict";

  var root = document.documentElement;
  var MOTION_KEY = "portfolio:motion";         // site.js's remembered pause
  var SKY = { density: 2.5, speed: 2.65, twinkle: 1.2, shooting: 8, parallax: 2 };
  var PHONE_DENSITY = 1.5;

  var reduceMq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  var forcedMq = window.matchMedia ? window.matchMedia("(forced-colors: active)") : null;
  var phoneMq = window.matchMedia ? window.matchMedia("(max-width: 640px)") : null;

  function storeGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function storeSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }
  function listen(mq, fn) {
    if (!mq) return;
    if (mq.addEventListener) mq.addEventListener("change", fn); else if (mq.addListener) mq.addListener(fn);
  }
  function warn(msg, err) { if (window.console && window.console.error) window.console.error("[fondo] " + msg, err); }
  function osReduced() { return !!(reduceMq && reduceMq.matches); }
  function forced() { return !!(forcedMq && forcedMq.matches); }
  function density() { return phoneMq && phoneMq.matches ? PHONE_DENSITY : SKY.density; }

  // ---- The sky ----
  var ctl = null, canvas = null;
  var isCase = !!document.querySelector("figure.diagram[data-fx]");

  function flags(on) {
    root.classList.toggle("has-bg", on);
    root.setAttribute("data-bg", on ? "starfield" : "none");
    root.setAttribute("data-ships", "off");
  }
  function halt() {
    if (ctl) { try { ctl.stop(); } catch (e) { warn("stop() failed", e); } }
    ctl = null;
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    canvas = null;
  }
  function start() {
    halt();
    var reg = window.PortfolioBG, mod = reg && reg.starfield;
    if (forced() || !mod || typeof mod.start !== "function") { flags(false); return; }
    flags(true);                                   // before start (see the header)
    canvas = document.createElement("canvas");
    canvas.id = "bg-canvas";
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.cssText = "position:fixed;top:0;right:0;bottom:0;left:0;width:100%;height:100%;" +
      "z-index:-1;pointer-events:none;display:block";
    document.body.insertBefore(canvas, document.body.firstChild);
    var values = {};
    for (var k in SKY) if (Object.prototype.hasOwnProperty.call(SKY, k)) values[k] = SKY[k];
    values.density = density();
    try { ctl = mod.start(canvas, values); } catch (e) { warn("the sky failed to start", e); ctl = null; }
    if (!ctl || typeof ctl !== "object") { halt(); flags(false); return; }
    if (isCase && typeof ctl.pause === "function") ctl.pause();
  }

  // A phone rotated to landscape (or a window resized across 640px) keeps its sky: only the
  // number of stars changes, live, through the module's set().
  listen(phoneMq, function () {
    if (ctl && typeof ctl.set === "function") { try { ctl.set("density", density()); } catch (e) { warn("set() failed", e); } }
  });
  listen(forcedMq, start);

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
  // The diagrams' own Play/Pause (or site.js) can change the switch too.
  if (window.MutationObserver) {
    new window.MutationObserver(labelMotion).observe(root, { attributes: true, attributeFilter: ["data-motion"] });
  }
  listen(reduceMq, labelMotion);

  window.PortfolioFondo = {
    current: function () {
      return { bg: ctl ? "starfield" : "none", density: ctl ? density() : 0, still: isCase };
    }
  };

  labelMotion();
  start();
})();
