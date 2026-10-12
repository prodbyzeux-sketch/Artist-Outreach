// dom.js — the two helpers every UI module wants and nothing else.

export const $ = (id) => document.getElementById(id);

export const debounce = (fn, ms) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};
