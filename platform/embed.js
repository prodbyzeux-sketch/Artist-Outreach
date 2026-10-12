// embed.js — classic script loaded first by the Outreach and Inbox pages.
// Inside the Artist Outreach web app those pages run in an iframe; the app
// already shows the brand and the navigation, so the pages drop their own
// header (see .ao-embedded in outreach/src/app.css and crm/page/styles/shell.css).
if (window.top !== window) document.documentElement.classList.add("ao-embedded");
