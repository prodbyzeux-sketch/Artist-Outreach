// screen-fix.js — runs at document_start in the PAGE's own JS world.
//
// CDP's Input.dispatchMouseEvent only takes viewport coordinates, so every
// event it produces ends up with screenX === clientX and screenY === clientY.
// A real event carries the pointer's position on the desktop: the viewport
// coordinate plus the window's origin plus the browser chrome above the page.
// That equality is one of the cheapest ways to spot CDP-driven input, so these
// getters restore the relationship a real event has.
//
// Deliberately not hidden any further: the getter's source is still readable
// via Function.prototype.toString. Faking that needs a second patch which is
// itself detectable, and this file is aimed at the artifact people actually
// test for, not at winning an arms race.

(() => {
  const proto = MouseEvent.prototype;
  const clientX = Object.getOwnPropertyDescriptor(proto, "clientX").get;
  const clientY = Object.getOwnPropertyDescriptor(proto, "clientY").get;
  const define = (name, get) =>
    Object.defineProperty(proto, name, { get, enumerable: true, configurable: true });

  // window.screenX/Y move with the window; outerHeight - innerHeight is the
  // toolbar band above the viewport. Read live so both stay right if the user
  // drags or resizes the window mid-run.
  define("screenX", function () { return clientX.call(this) + window.screenX; });
  define("screenY", function () {
    return clientY.call(this) + window.screenY + (window.outerHeight - window.innerHeight);
  });
})();
