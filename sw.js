// The suite's single service worker. Manifest V3 allows exactly one, so it
// imports both halves and owns the one thing they used to fight over — the
// toolbar icon.
//
//   outreach/src/background.js — the send run: debugger-driven input, follow-ups
//   crm/sw.js                  — the inbox: capture, storage, the local bridge
//   platform/sw.js             — the Artist Outreach web platform (ao-* messages)
//
// They stay independent: separate storage keys, separate message protocols
// (SCREAMING_CASE against `crm-*` / `ig-capture`), and each listener answers
// only its own.

import './outreach/src/background.js';
import './crm/sw.js';
// The Artist Outreach web app: pairing, Instagram lookups for the app, and
// reporting back what happened to imported campaigns.
import './platform/sw.js';
import { openWorkspace } from './workspace.js';

chrome.action.onClicked.addListener(() => {
  openWorkspace().catch((e) => console.error('[artist-outreach] workspace:', e?.message ?? e));
});
