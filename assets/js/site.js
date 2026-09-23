// Portfolio behaviour. Follows the Gabe Suite motion contract (gabe-artifact H4):
// a flow diagram moves, every animation can be paused from one control, and under
// prefers-reduced-motion nothing moves and the diagram renders complete.
(function () {
  "use strict";
  var root = document.documentElement;
  var NS = "http://www.w3.org/2000/svg";
  var KEY = "portfolio:motion";
  var mq = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");
  var reduced = !!(mq && mq.matches);

  function stored() { try { return window.localStorage.getItem(KEY); } catch (e) { return null; } }
  function store(v) { try { window.localStorage.setItem(KEY, v); } catch (e) { /* storage blocked */ } }

  var MOTION = { on: !reduced && stored() !== "off" };
  window.FXREPLAY = window.FXREPLAY || {};

  // ---- Demo videos (if any): paused with controls; autoplay only when motion is allowed ----
  if (!reduced) {
    document.querySelectorAll("video[data-autoplay]").forEach(function (v) {
      v.muted = true; v.loop = true;
      var p = v.play(); if (p && p.catch) p.catch(function () {});
    });
  }

  // ---- Flow diagrams: packets travel each edge, in the edge's direction ----
  function buildFlow(fig) {
    var svg = fig.querySelector("svg:not(.i)"); // the diagram, not an icon inside the toggle
    if (!svg) return;
    svg.querySelectorAll(".packet").forEach(function (n) { n.remove(); });
    if (reduced) return; // finished state = the complete static diagram
    var edges = Array.prototype.slice.call(svg.querySelectorAll("path.edge"));
    edges.forEach(function (p, i) {
      var len = p.getTotalLength ? p.getTotalLength() : 60;
      var dur = Math.max(1.4, len / 70);
      var c = document.createElementNS(NS, "circle");
      c.setAttribute("r", "4");
      c.setAttribute("class", "packet" + (p.classList.contains("dashed") ? " alt" : ""));
      var m = document.createElementNS(NS, "animateMotion");
      m.setAttribute("dur", dur.toFixed(2) + "s");
      m.setAttribute("repeatCount", "indefinite");
      m.setAttribute("path", p.getAttribute("d"));
      // A negative begin starts each packet mid-journey, so none waits parked at (0,0).
      m.setAttribute("begin", "-" + ((i * 0.45) % dur).toFixed(2) + "s");
      c.appendChild(m);
      svg.appendChild(c);
    });
    if (!MOTION.on && svg.pauseAnimations) svg.pauseAnimations();
  }

  var figures = Array.prototype.slice.call(document.querySelectorAll("figure.diagram[data-fx]"));
  figures.forEach(function (fig) {
    var slug = fig.getAttribute("data-fx");
    window.FXREPLAY[slug] = function () { buildFlow(fig); };
  });
  window.__rebuildMotion = function () { figures.forEach(buildFlow); };

  function setMotion(on) {
    MOTION.on = !!on && !reduced;
    root.setAttribute("data-motion", MOTION.on ? "on" : "off");
    window.__rebuildMotion(); // rebuild first: a pause aimed at a replaced element does nothing
    document.querySelectorAll("figure.diagram svg:not(.i)").forEach(function (s) {
      if (s.pauseAnimations && s.unpauseAnimations) { MOTION.on ? s.unpauseAnimations() : s.pauseAnimations(); }
    });
    document.querySelectorAll("#af-motion .af-opt").forEach(function (o) {
      o.setAttribute("aria-checked", String((o.getAttribute("data-id") === "on") === MOTION.on));
    });
  }
  window.__setMotion = setMotion;

  document.querySelectorAll("#af-motion .af-opt").forEach(function (o) {
    o.addEventListener("click", function () {
      var on = o.getAttribute("data-id") === "on";
      store(on ? "on" : "off");
      setMotion(on);
    });
  });


  // ---- Carousels: arrows, dots, counter and arrow keys over a scroll-snap track ----
  document.querySelectorAll(".carousel").forEach(function (car) {
    var track = car.querySelector(".car-track");
    var slides = Array.prototype.slice.call(car.querySelectorAll(".car-slide"));
    var dots = Array.prototype.slice.call(car.querySelectorAll(".car-dot"));
    var prev = car.querySelector(".car-prev"), next = car.querySelector(".car-next");
    var count = car.querySelector(".car-count");
    if (!track || slides.length < 2) { if (car.querySelector(".car-nav")) car.querySelector(".car-nav").hidden = true; return; }
    var current = 0;
    function go(i) {
      i = Math.max(0, Math.min(slides.length - 1, i));
      track.scrollTo({ left: slides[i].offsetLeft - track.offsetLeft, behavior: reduced ? "auto" : "smooth" });
    }
    function sync() {
      var i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
      i = Math.max(0, Math.min(slides.length - 1, i));
      current = i;
      dots.forEach(function (d, k) { d.setAttribute("aria-current", String(k === i)); });
      if (prev) prev.disabled = i === 0;
      if (next) next.disabled = i === slides.length - 1;
      if (count) count.textContent = (i + 1) + " / " + slides.length;
    }
    var pending = false;
    track.addEventListener("scroll", function () {
      if (pending) return; pending = true;
      window.requestAnimationFrame(function () { pending = false; sync(); });
    }, { passive: true });
    if (prev) prev.addEventListener("click", function () { go(current - 1); });
    if (next) next.addEventListener("click", function () { go(current + 1); });
    dots.forEach(function (d, k) { d.addEventListener("click", function () { go(k); }); });
    track.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight") { e.preventDefault(); go(current + 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); go(current - 1); }
    });
    window.addEventListener("resize", function () { go(current); });
    sync();
  });

  setMotion(MOTION.on);
})();
