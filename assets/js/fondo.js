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
// On the home pages the name in the header pauses and resumes everything (see below).
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

  // ---- The name in the header: the pause control on the home pages (WCAG 2.2.2) ----
  // A first press pauses every animation (the sky, the scroll reveal, the hero) through site.js's
  // single switch and goes back to the top; the next press resumes. The pause is remembered like the
  // diagrams' own Pause. Only where the name links to the page itself (the home pages): on a
  // project page it still goes home, and the sky there is already still. A modifier or another
  // button keeps the browser's own behaviour (new tab, window, download). Under OS reduced motion
  // nothing moves and the name stays a plain link. A title tells mouse users; a polite live region
  // tells screen-reader users what a press did.
  var LANG = /^es\b/i.test(root.getAttribute("lang") || "") ? "es" : "en";
  var TEXT = {
    en: { pause: "Pause animations and go to the top", play: "Resume animations",
          paused: "Animations paused", resumed: "Animations resumed" },
    es: { pause: "Pausar animaciones e ir al inicio", play: "Reanudar animaciones",
          paused: "Animaciones en pausa", resumed: "Animaciones reanudadas" }
  }[LANG];
  function pagePath(p) { p = p || "/"; return p.charAt(p.length - 1) === "/" ? p + "index.html" : p; }
  var brand = document.querySelector("header .brand");
  var loc = window.location;
  var brandHome = !!brand && typeof brand.pathname === "string" && brand.host === loc.host &&
    pagePath(brand.pathname) === pagePath(loc.pathname);
  function motionOn() {
    var m = root.getAttribute("data-motion");
    return m === "off" ? false : m === "on" ? true : storeGet(MOTION_KEY) !== "off";
  }
  function controls() { return brandHome && !osReduced(); }
  function labelBrand() {
    if (!brandHome) return;
    if (controls()) brand.setAttribute("title", motionOn() ? TEXT.pause : TEXT.play);
    else brand.removeAttribute("title");
  }
  var status = null;
  function announce(text) {
    if (!status) {
      status = document.createElement("span");
      status.className = "sr-only";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      document.body.appendChild(status);
    }
    status.textContent = "";
    window.setTimeout(function () { status.textContent = text; }, 50);   // cleared first, so a repeat is read again
  }
  if (brandHome) {
    brand.addEventListener("click", function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (!controls()) return;
      e.preventDefault();
      var on = !motionOn();
      storeSet(MOTION_KEY, on ? "on" : "off");
      if (typeof window.__setMotion === "function") window.__setMotion(on);
      else root.setAttribute("data-motion", on ? "on" : "off");
      if (!on) {
        try { window.scrollTo({ top: 0, left: 0, behavior: "smooth" }); } catch (err) { window.scrollTo(0, 0); }
      }
      labelBrand();
      announce(on ? TEXT.resumed : TEXT.paused);
    });
  }
  // The diagrams' own Play/Pause (or site.js) can change the switch too.
  if (window.MutationObserver) {
    new window.MutationObserver(labelBrand).observe(root, { attributes: true, attributeFilter: ["data-motion"] });
  }
  listen(reduceMq, labelBrand);

  window.PortfolioFondo = {
    current: function () {
      return { bg: ctl ? "starfield" : "none", density: ctl ? density() : 0, still: isCase };
    }
  };

  labelBrand();
  start();
})();
