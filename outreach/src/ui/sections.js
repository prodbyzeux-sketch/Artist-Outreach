// sections.js — remembers which of the cards are folded away.
//
// A plain script rather than a module on purpose: it runs where the parser
// meets it, before the first paint. A module is deferred, and every folded
// section would flash open on load and then collapse.

(() => {
  const KEY = "ao:folded";

  let folded;
  try {
    folded = new Set(JSON.parse(localStorage.getItem(KEY)) || []);
  } catch {
    folded = new Set();   // someone else's write, or a truncated one
  }

  const cards = [...document.querySelectorAll("details.card")];
  // What is written back is the whole picture, read off the page — not a patch
  // per event. Accumulating one id at a time means anything that closes a card
  // on its own (Chrome restoring state on a reload, say) is remembered as a
  // fold the user asked for, and the list only ever grows.
  const remember = () =>
    localStorage.setItem(KEY, JSON.stringify(cards.filter((c) => !c.open).map((c) => c.id)));

  for (const card of cards) {
    card.open = !folded.has(card.id);
    card.addEventListener("toggle", remember);
  }
})();
