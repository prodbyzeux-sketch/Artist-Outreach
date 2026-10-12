# Artist Outreach — browser extension

The half of Artist Outreach that has to run in the user's browser. Chrome only
lets an extension drive Instagram, so the extension does the sending and the
reading of Instagram, and the web app is where people work: the extension's two
pages are embedded in the app as the **Outreach** and **Inbox** tabs.

It is two extensions merged into one — sending to a lead table (`outreach/`) and
an inbox CRM (`crm/`) — plus `platform/`, which connects it to the web app. One
icon, one storage, one service worker, and one tab group holding all the work:

```
[ Artist Outreach ]  Artist Outreach (web app) · Instagram
```

## Installing

Users get it from the web app: **Outreach** tab → *Download the extension*. The
server builds that zip from this folder, patched with its own domain
(`server/extensionPack.js`). Then:

1. Unzip it.
2. `chrome://extensions` → turn on **Developer mode**.
3. **Load unpacked** → pick the `artist-outreach-extension` folder.
4. Reload the web app: it pairs with the extension on its own.

Once it's published on the Chrome Web Store, set `EXTENSION_STORE_URL` on the
server and the app shows an *Add to Chrome* button instead.

For development, load this folder unpacked and point it at your server:

```bash
node platform/set-origin.mjs https://app.yourdomain.com   # localhost:3456 is kept too
```

## How it fits into the web app

```
web app (platform.js) ── window.postMessage ──▶ platform/bridge.js (content script on the app)
                                                        │ chrome.runtime messages (ao-*)
                                                        ▼
                                                 service worker ──▶ /ext/v1/* (Bearer token)
```

- **Embedding.** `outreach/src/app.html` and `crm/page/crm.html` are
  `web_accessible_resources` that only the platform's origins may load. The app
  shows them in iframes; `platform/embed.js` hides their own logo when embedded.
- **Pairing.** The app asks the extension for a hello (`ao-hello`, which also
  gives the extension id the iframes need) and, if it isn't paired, sends a
  token it got from `POST /api/ext/pair` (`ao-pair`). No copying and pasting.
- **Leads in.** In Outreach, *From Artist Outreach…* (next to *Add file…*)
  imports a folder of saved artists as a lead table (`source: "artist-outreach"`,
  with an `ao_id` column). Columns become message variables: `{name}`,
  `{listeners}`, `{reference}`…
- **Results out.** Every 2 minutes (alarm `ao-sync`) the extension reports what
  happened to each imported artist: *sent* (marks it contacted), *failed* or
  *replied* (`platform/sync.js`; each handle only moves forward).
- **Daily allowance.** Before every automated DM the run claims one from the
  server (`POST /ext/v1/quota/claim`); Starter allows 10 a day, Pro is
  unlimited. A lead that isn't actually sent gives its claim back. Without a
  connection or an active plan, runs don't start (`platform/quota.js`).
- **Instagram follower counts.** When the server can't read them (Instagram
  blocks datacenter IPs), the app asks the extension (`ao-ig-lookup`), which reads
  them with the browser's Instagram session — a few at a time, with pauses, and
  never while a run is sending.

```
platform/
  config.js      origins the extension talks to (set-origin.mjs / the server patch them)
  api.js         /ext/v1/* client with the token kept in aoPlatform
  bridge.js      content script on the app: postMessage ⇄ service worker
  embed.js       marks the Outreach/Inbox pages when they're inside the app
  sw.js          ao-hello, ao-pair, ao-ig-lookup; the 2-minute sync
  quota.js       the daily automated-DM allowance, checked with the server
  instagram.js   follower counts with the browser's session (rate-limited)
  sync.js        imported campaigns' states → events (pure, tested)
  set-origin.mjs points a local checkout at your domain
  test/          sync, imported tables, Instagram, quota
```

New keys in `chrome.storage.local`: `aoPlatform` (the connection) and `aoSync`
(last state reported per handle). They don't overlap with the halves' keys.

## What lives where

| Path | What it is |
|---|---|
| `manifest.json` | the merged manifest: both halves' permissions + `tabGroups` + the platform bridge |
| `sw.js` | the single service worker: imports both halves and `platform/`, and owns the icon |
| `workspace.js` | opens the workspace (the only place with `chrome.tabs`/`chrome.tabGroups`) |
| `lib/workspace-plan.js` | the rules: what to reuse, in which window, in which group (tested) |
| `outreach/` | sending: `src/background.js`, the page `src/app.html`, the content layer, its tests |
| `crm/` | the inbox CRM: `sw.js`, the page `page/crm.html`, the Instagram hook, its tests |
| `platform/` | the connection to the web app (above) |

Clicking the icon opens the web app and Instagram in a named Chrome tab group.
Tabs already open are reused, and tabs scattered across windows are gathered
into the window of the first one.

## Notes on the merge

Inside `outreach/` and `crm/` the original projects' structure is unchanged.
What had to change when merging:

- **One icon.** Both projects listened to `chrome.action.onClicked`; now `sw.js`
  does, and their handlers are gone.
- **Protocols diverged.** `crm/sw.js` answered ANY message (`unknown message`)
  and in a shared worker would have intercepted the others' protocol — now it
  only takes `crm-*` and `ig-capture`. Outreach uses SCREAMING_CASE types and
  the platform `ao-*`; no overlaps.
- **The linked tab is no longer pinned.** Chrome doesn't allow pinned tabs in
  groups, and a group keeps a tab in place as well as a pin does.
- **Runtime resource paths** (`chrome.runtime.getURL`) got an `outreach/`
  prefix; relative links inside HTML and CSS survived the move unchanged.

Storage keys don't overlap: outreach has `table`, `leads`, `messages`,
`settings`, `campaigns`, `runState`, `inbox` (the first ones suffixed with
`:<campaignId>`); the CRM has `threads`, `msg:*`, `tpl`, `viewer`, `health`,
`bridgeSource`, `crmView`. Storage is shared, so the CRM's local bridge only
pushes a snapshot on ITS OWN keys — otherwise during a run it would ship the
whole inbox every second and a half on every `runState` write.

Three more places where the halves could fight, and why they don't:

- **The isolated world is shared now.** Before the merge these were two
  extensions — two isolated worlds on Instagram's page. Now it's one extension,
  so ALL content scripts share one world, and the same name declared at top
  level in both halves is a `SyntaxError` that kills the whole content layer —
  capture and sending at once. Outreach always hid inside an IIFE and talked
  through `globalThis.__igs`; the CRM's scripts are wrapped too now and expose
  nothing. `test/tree.test.js` forbids any top-level declaration in a content script.
- **The run's window is off limits.** While sending, its window is driven by
  `chrome.debugger`, and the tab there is an ordinary Instagram tab the CRM would
  happily adopt and the workspace would drag into its group. Either would break
  a send halfway through a lead, so both read the `work` key and leave that window alone.
- **A reply from the Inbox is typed with trusted input too.** Instagram's
  composer is Lexical: it sends on an editing command the browser derives from a
  real Enter, not on a key handler. A synthetic `KeyboardEvent` from a content
  script is seen by listeners but produces no command — the message was typed
  into the field and stayed there. So the text and the Enter go through
  `chrome.debugger` (`crm/trusted-input.js`), and the page does only what only
  it can: find the composer, place the caret and confirm the field emptied. The
  outreach driver isn't touched — it holds one `attachedTabId` for the whole
  extension, and Chrome counts sessions per tab, and the tabs are always
  different here. Verified on a live Chrome: `crm/test/trusted-input.browser.test.mjs`.

  That page waits by observing the DOM, not by polling. The linked tab is in the
  background, and Chrome throttles a hidden tab's `setTimeout` to about once a
  second, more the longer it's hidden; that's exactly what
  `outreach/test/occlusion.test.mjs` measures (1002 ms on an occluded window).
  Polling therefore reported a send seconds after it happened —
  `MutationObserver` answers the same instant, and the timer is only an upper
  bound. `crm/test/compose.browser.test.mjs` holds this by slowing the page's
  timers 30×.
- **The CRM's hook also works in the run's window** — so the inbox fills up
  during a run, without a separate "Refresh". That's not a side effect, it's why
  the halves belong together.

And the reason the merge makes sense at all — the Inbox sees the outreach lead tables:

- **The card shows what outreach has already done with this person** —
  `outreach · sent · yesterday`, `outreach · queued`, `outreach · failed` (in
  red, reason in `title`). It looks across all campaigns: "I already messaged
  them" doesn't stop being true because the list was switched; another campaign's
  name is appended at the end of the line.
- **The list filters by campaign**, with a panel on top showing its numbers —
  sent, replied, reply rate, median reply time, how many conversations were
  actually captured, and the funnel. Replies are counted by
  `outreach/src/stats.js`, so the Inbox and the dashboard can't disagree on what
  "replied" means.

Handle matching is exact, no substrings: saying "you already messaged them"
about someone you didn't is an error that reads as true and changes the next message.

The lead table's key is `leads:<campaignId>`, not `leads`: outreach migrates the
un-namespaced key away on first run, and reading `leads` returns emptiness
indistinguishable from an empty campaign. Key resolution lives in
`crm/lib/campaign.js` under test, not as a string in the page.

The CRM also has an optional local bridge (`crm/bridge/`, a daemon on
127.0.0.1:8788) for reading the inbox from scripts; see `crm/README.md`. It is
left out of the download, but the manifest still lists the localhost host
permission — drop it before a Chrome Web Store submission if you don't use it.

## Development

```bash
npm run test:fast     # planner, tree integrity, CRM, platform — a few seconds
npm run test:browser  # outreach tests: a live headless Chrome, a few minutes
npm test              # both
```

The outreach browser tests depend on the machine's state: `occlusion` needs the
window to really be covered, `avatar-capture` needs CDP to catch a live request
in time. If they go red, run the same file on a clean checkout before blaming
the code.

`test/tree.test.js` is the safety net for the merge: it checks that every path
in the manifest exists and that no relative link in the shipped files points
at nothing. It catches the one error moving folders can cause — and catches it
at once, instead of in three different places at Chrome's runtime.

More about each half in `outreach/README.md` and `crm/README.md`.
