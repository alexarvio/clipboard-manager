// Scroll-triggered "fall into place" entrance for section content
// (2026-08-24). Deliberately opt-in and JS-applied rather than baked into
// static CSS: this script adds the .reveal-init class (see refine.css)
// right before observing each element, so a JS failure, a slow/blocked
// script load, or a visitor with JS disabled always sees the page in its
// normal, fully-visible state -- nothing can get stuck hidden behind a
// script that never ran. prefers-reduced-motion gets the same treatment on
// purpose, not just a shorter transition.
(function () {
  var SELECTOR = [
    ".section-head",
    ".tl-item",
    ".feature-row",
    ".vs-card",
    ".price-table-wrap",
    ".faq-item",
    ".privacy-item",
    ".shot-mock-card",
  ].join(", ");

  var targets = Array.prototype.slice.call(document.querySelectorAll(SELECTOR));
  if (!targets.length) return;

  var reduceMotion =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion || !("IntersectionObserver" in window)) return;

  // Siblings revealed together (the three timeline steps, the two vs-cards,
  // every faq-item) stagger off each other instead of off one counter for
  // the whole page, so a lone card near the bottom of the page doesn't
  // inherit a long delay it has no reason to.
  var counts = new Map();
  targets.forEach(function (el) {
    var parent = el.parentElement;
    var index = counts.get(parent) || 0;
    counts.set(parent, index + 1);
    el.style.transitionDelay = Math.min(index, 5) * 80 + "ms";
    el.classList.add("reveal-init");
  });

  var observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15, rootMargin: "0px 0px -8% 0px" }
  );

  targets.forEach(function (el) {
    observer.observe(el);
  });
})();
