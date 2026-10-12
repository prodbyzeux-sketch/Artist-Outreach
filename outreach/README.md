# Artist Outreach — Outreach

The sending half of the Artist Outreach Chrome (Manifest V3) extension (it started as
the standalone "siluet" extension). It sends **Instagram direct messages** to a
**lead table** — with spintax and per-lead variables — by driving the UI with a **real
mouse and keyboard**, inside a **dedicated window opened for each run**.

It runs on its **own full page** (the **Outreach** tab of the web app, or the toolbar icon) — not a popup, not a
node graph. The logo sits at the top; while a run is going it breathes, which is the
only status indicator there is. Four sections top to bottom: **Leads · Messages · Settings · Dashboard**.
The queue lives inside Leads, right under the sources that fill it.

## How sending works

Instagram has no public DM API, so the extension drives the web UI. For each run it
opens a **new window** (isolated, pinned to a desktop width, and kept rendering even
when it is off screen), attaches `chrome.debugger` to it and lands in **Direct**.

Leads are reached the way a person reaches them: back to Direct via the **paper-plane**,
the lead's handle typed into **Direct's own search**, and the matching account opened
from the results. Nothing navigates between leads — the page (and the content script)
stay alive for the whole run. That one route also does two other jobs: it proves the
lead is reachable, and because the conversation is open for **every** send path it is
where *Skip existing conversation* is decided.

Getting to a lead is also the only part of a lead that is **retried**, because nothing
has been said to anyone yet: the search is typed and read back, and the whole approach —
Direct, search, open — is taken up to three times before the lead is given up on. If the
search still finds nothing, the run makes its **one** navigation and opens the profile at
`instagram.com/<handle>`, taking the other way in: the profile's own **Message** button.
What the profile says is what decides the lead — a 404 means the account is really gone,
a private account with no Message button means there is no way to write to them. A lead
that fails on the way in is then started over once more **in the same visit**, rather
than being put back in the queue; a lead that fails *after* the message was submitted is
never repeated, since it may well have gone out.

Instagram's search ranking is not about your query — searching one handle put an
unrelated account in the first row — so the lead is matched on the **exact @handle**,
never on position. The handle alone isn't enough either: Direct answers with a
**Messages section before the accounts**, and those rows match the handle just as well,
because the query is highlighted inside the message text. Since the messages this tool
sends contain the lead's handle, every send breeds another false row — so message rows
are rejected by shape (a `·`-and-timestamp preview, or an "N matched messages" count)
before anything is matched. Clicking one never opens a conversation anyway: it drills
into a message-search sub-view and takes the search box with it. And "a conversation is open" is never accepted on its own: the
previous lead's thread is still standing when the next one starts, so the header's
profile link has to name the right person before anything is typed.

From there each path branches: **Just DM** is already in the right place, while the
reply paths open the lead's profile from the conversation header.

The work is split in two. The **content script decides what to touch**: it finds the
element, picks a point inside it a person would plausibly aim for, and checks nothing
is covering that point. The **service worker does the touching**, over CDP:

- **mouse** — the cursor actually travels. Each move is a quadratic Bézier whose bend
  is set by the profile's *straightness*, walked with a smoothstep ease; the duration
  follows Fitts's law, long moves overshoot and pull back, and the hand settles with a
  micro-correction before pressing.
- **keyboard** — one real `keyDown`/`keyUp` per character, with per-profile cadence,
  word and sentence pauses, occasional think-pauses and QWERTY-neighbour typos that get
  backspaced. Line breaks are a genuine Shift+Enter.
- **scrolling** — real wheel ticks, never `window.scrollBy`.

Because these come from the browser itself, the page sees `isTrusted === true` events.
The **cost is Chrome's "extension is debugging this browser" bar** on the work window —
unavoidable with `chrome.debugger`, and silenceable only by launching Chrome with
`--silent-debugger-extension-api` (a global flag, needs a full restart).

### The human profile

Timing and aim come from a **`HumanProfile`** ported from the Tabels desktop engine
(`src/human.js`): typing WPM, typo rate, word/sentence pause lengths, click dwell,
aim jitter, mouse straightness and a preferred hour of the day. It is rolled **once**
from a seed stored on first run, so the same "person" drives every run on this browser
profile. On top of that sit two multipliers: a **session arc** (the first few sends are
slower, then steady, then a slow drift into fatigue) and a **time-of-day** curve
(slowest in the small hours).

The selectors and click-chains are ported from the Tabels desktop engine; Instagram can
still change its markup — see **Calibration**.

## The three send paths (Settings → Send paths)

Enable **one or more** — when several are on, one is chosen **at random per lead**:

1. **Just DM** — types into the conversation the route already opened and sends on
   **Enter** (this surface has no Send button). The most reliable path.
2. **Reply to a post** — opens the lead's latest post, taps **Share (paper-plane)**,
   searches and selects the lead, types a message, and clicks **Send** (this surface does
   not submit on Enter). Falls back to Just-DM when the profile has no posts. Instagram's
   recipient search is fuzzy, so the lead is matched on the **exact @handle** — no exact
   row, no send: the lead is skipped rather than shared to a look-alike account.
3. **Reply to a story** — opens the lead's active story or a highlight and replies to it.
   Falls back to reply-to-post (then Just-DM) when there's nothing to reply to.

Unreachable leads are **skipped** with a reason (profile not found · private · DMs closed).

### When a run stops itself

A lead failing is one lead's problem. Three things instead mean the rest of the queue
would only repeat it, so the run **stops and leaves the untouched leads `pending`**:

- **Instagram refuses** — an action block or a rate limit ("Action Blocked", "Try Again
  Later"). The lead being worked on rolls back to `pending` too, since nothing went out.
  Wait it out before starting again — an hour at least, longer if it repeats. Block
  wording is read only out of dialogs, never the page text, so a lead writing *"try again
  later"* in their own chat can't stop your run.
- **Three leads fail in a row** — that is not the leads, it's Instagram's markup moving
  or the session being logged out. Those three keep their `failed` status and their error
  text; read the log to see what broke.
- **The input driver is lost** — see *Notes & limits*.

## The audience filter (Settings → bounds)

Switch it on and a lead is only written to when their **follower count** falls inside the
range you set and their **post count** is at or above the floor you set. Posts have no
ceiling: the question is whether an account posts at all, and posting a lot was never a
reason to skip someone. Every bound is `0` for *no bound*, and a switch turned on with no
bound behind it is treated as no filter at all — it would send the run walking to a
profile for nothing.

**The numbers are read off the lead's profile, never asked for.** That is the whole
design of this feature, and it was measured rather than assumed:

- Direct's own account search — the one request every lead already triggers, on every
  path — carries `username`, `full_name`, `is_private`, `is_verified` and the friendship
  flags, and **no counts at all**. Read straight off the wire from
  `/api/v1/direct_v2/ranked_recipients/`.
- The public endpoint that *does* carry them is one the web app **never calls while a
  person browses**. An extension calling it per lead is traffic no ordinary browsing
  produces, which is the one thing this project spends all its effort not doing.
- The profile page has both numbers written on it, exactly, and looking someone up
  before writing to them is the most human step in this entire flow.

So a filtered lead is reached the ordinary way — Direct, search, their conversation —
and then their profile is opened **from the conversation header**, the way you would
open it: a click, no typed address. The numbers are read there and the lead is decided.
A plain DM that passes goes back into the chat through the profile's own **Message**
button; the post and story paths were going to the profile anyway, so for them the
filter costs nothing at all.

Reading them is deliberately dumb and therefore hard to break: the smallest element
whose whole text is a number and its word (*"4,864 posts"*), with the exact value taken
from `title`, which Instagram fills in **only** when it shortened what it drew
(`104M` → `title="104,256,058"`). No suffix parsing, no class names, no geometry. The
header fills in after the page arrives — measured on the live site, a profile opened from
a conversation is blank for its first ~350ms and has its numbers by ~730ms — so the read
**waits** for both numbers (up to six seconds) instead of taking whatever the first frame
had. And because Instagram's *"Something went wrong"* screen lands a second or two after
the navigation, a profile that shows no numbers is asked whether it is that screen: if it
is, its own **Reload** is pressed and the numbers are looked for again. A number that
still cannot be read exactly is **not** a pass — the lead fails, the log says what the
page actually had on it (*"the numbers wouldn't read on /someone/ — 95 chars of text, none
of the count words on the page"*), and three of those in a row stop the run, because a
filter that waves through everyone it could not measure would go on claiming in Settings
to be doing something.

Both numbers are kept on the lead, and the skip note names the one that broke its
bound — *"18.4k followers — over the 10k maximum"* — rather than "outside the filter",
which is the wrong kind of unarguable. A filtered lead is `skipped`, so **Reset
statuses** (or *Return to queue* on the rows) is what brings them back if you widen the
bounds later. Bounds nobody could satisfy — a minimum above a maximum — are refused by
**Start**, not discovered one skipped lead at a time.

The honest cost: a lead who fails the filter has had their conversation opened and their
profile looked at. Nothing was written to them, and nothing happened that a person
doesn't do.

Follow-ups are never filtered: that conversation is already open.

## Campaigns

The name at the top of the page, with an arrow either side, is the campaign everything
below belongs to. A campaign owns **its leads and the files they came from, its message
variants, its follow-up steps and its settings** — so a second campaign is a second
audience with a second opener and its own pace, not a second copy of the same one.

What is NOT per campaign: the inbox scan, your own profile card, and the run itself.
Those describe the Instagram account, and there is one of those.

- **Switching** reloads the page. Every section rebuilds itself from the campaign you
  moved to, and anything you had half-typed is saved to the campaign you left first.
- **+ New campaign** starts with an empty queue and no messages, but **inherits the
  settings** of the campaign you were on: send paths, pauses, typing speed, the audience
  bounds. How the bot behaves is something you set once.
- **Delete** takes the campaign's leads with it, and everything sent to them leaves the
  dashboard along with them. It asks first, and there is no way back.
- **While a run is going the whole switcher is dead.** The run works whichever campaign
  is active, one lead at a time, and moving it mid-run would send that campaign's opener
  to another campaign's list.

The dashboard, the follow-up monitor and every count on the page are about the active
campaign only.

Upgrading from a version before campaigns costs nothing: whatever was in the queue
becomes *Campaign 1*, with its messages, steps and settings intact.

## Leads — sources and the queue, in one place

Two ways to fill the queue (they merge):

- **Upload a CSV / TSV / XLSX** — the extension auto-detects the **Instagram-handle column**
  (override it in the dropdown). That column becomes your recipients; **every other column
  becomes a `{variable}`** you can drop into messages. **Add as many files as you like:**
  each keeps its own headers and its own handle column, and together they are one queue and
  one set of variables. A handle listed in two files belongs to the first one that listed
  it, and picking a file that is already loaded reloads it in place instead of stacking a
  stale copy beside it.
- **Paste usernames** — one per line, straight into the queue (no variables beyond
  `{username}`). Good for a quick list without a spreadsheet.

Handles are matched by normalized IG handle, so a full `instagram.com/@user/` URL, `@user`,
or bare `user` all work; duplicates across the table and the paste box are de-duped.

The queue sits directly below, with a search box and status chips that are both the
counts and the filter. A row can be **returned to the queue**, **skipped**, or
**removed**; the same three work on a multi-row selection. There is deliberately no way
to mark something `sent` by hand — that would be a record of something that did not
happen, and every reply rate built on it later would inherit the lie.

**Removing is a tombstone, not a deletion.** The queue is derived from the loaded tables'
handle columns, so a spliced-out lead would return on the next re-import; instead the lead
is flagged and the rebuild keeps the flag. The `removed` chip lists them with **Restore**,
and typing that handle into the paste box restores it too — asking for a lead by hand is
explicit, so it outranks a flag that only exists to survive re-imports.
Removing a file takes its leads and their tombstones with it, unless another file lists
the same handle.

Anything added by hand lands at the **top** of the queue, and adding clears the search box
and the status filter, because a lead appended to row 601 of a list that renders 200 at a
time is indistinguishable from one that was never added. The line beside the button says
what happened either way — added, restored, already in the queue, or no handle in that text.

While a run is in progress the queue is **read-only** — the worker and the page would
otherwise write the same list at once. Search and filtering stay live, and the row being
worked updates in place.

## Messages

One or more variants, one picked at random per lead. Which one actually went out is
recorded on the lead, so opener performance is measured rather than arranged. Supports:

- **Spintax** — `{Hey|Hi|Yo}` picks one option at random per send.
- **Variables** — `{username}` (builtin) plus any table column, e.g. `{name}`, `{top_track}`.
  Unknown tokens collapse to empty (a half-filled list never ships a literal `{token}`).
- **`{name?}`** — optional name: drops itself (and a neighbouring space) when blank, so
  `Hey {name?}!` reads as `Hey!`.

The **Preview** line renders your first lead so you can see exactly what goes out.

## Dashboard — did any of it land

A card at the top says **who is sending**: avatar, name, @handle, bio and follower
count, refreshed at the start of every run. This is the one place the extension asks
Instagram for something rather than watching what the page already fetched — a single
call about your own account, to the same endpoint the settings page uses, chosen over
navigating away from the run. Nothing about a **lead** is ever asked for this way. Instagram's avatar URLs are signed and expire within days,
so the picture itself is kept as bytes — and taken, not fetched: the page is asked to
load it and the debugger reads the response. That is not the same trick as the inbox
below. The CDN is a different origin from instagram.com, so the page's response is
**opaque** — the renderer is never given those bytes and `Network.getResponseBody`
answers *"No data found for resource"*. Intercepting the response instead
(`Fetch.requestPaused`) catches it before opacity is applied, and returns it byte for
byte; `node test/avatar-capture.test.mjs` holds both halves of that to a real Chrome and
two real origins. It also means the extension asks for **no host but instagram.com** —
the two CDN domains it used to need for a `fetch()` of its own are gone from the
manifest. Every way this can fail now says so in the log; a picture that never arrives
falls back to the handle's initials.

Reply rates need to know who answered, so at the start of every run — while the work
window is already sitting in Direct — the extension scrolls the conversation list and
**records the `/api/graphql` responses Instagram fetches on its own**. It never calls
Instagram's API itself; same rule as the input layer, only what the page did anyway.
The capture keeps refreshing as the run opens each lead's conversation.

Only derived facts are stored — first outbound, first qualifying reply, counts — never
message text. A lead counts as **replied** when an inbound message exists *after* our
first outbound, so a thread where they wrote first and ignored the opener isn't a reply.
Leads are tied to conversations by the `threadId` recorded at send time, with the handle
as a fallback.

**Reread the inbox** on the dashboard does the same read on its own, without sending
anything: it opens the work window **unfocused**, scrolls further than a run does, folds
in whatever Instagram fetched, and closes. A run and a refresh own the same window and
the same debugger session, so they refuse to overlap in either direction.

- **Reply rate per opener** — which variant earns answers, with the sample it rests on.
  Rates off fewer than 8 sends are drawn faint: a 100% off two is noise, not a finding.
- **Reply rate per send path** — the same question for Just DM vs post vs story.
- **Activity** — a GitHub-style year of squares, one per day, shaded by sends.
- **When sends land** — sends per hour of day with the reply rate as the fill, and the
  best hour named only once some hour has enough sends to mean anything.

## Install (development)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select the extension folder (the parent of this one). Reload it after edits.
3. Be **logged in to Instagram** in Chrome.
4. Open **Outreach** in the web app, or **click the toolbar icon** — it opens this page (no popup).

No build step — plain JS/HTML/CSS, no dependencies.

## Use

1. **Leads** — upload your table and/or paste usernames, confirm the handle column, and
   work the queue right below it: search, filter by status, return leads to the queue,
   skip them, or remove them.
2. **Messages** — write one or more variants; watch the preview.
3. **Settings** — enable one or more send paths; set the pauses, the **typing-speed**
   slider (×N of normal), an optional per-run cap, and — if you want one — the
   **audience filter**'s follower and post bounds.
4. **Start** opens the work window (focused so you see it) and begins. **Stop** is
   immediate — it closes the window and aborts the current send (that lead stays `pending`).

The **cap is remembered**. A run of 20 that stopped at 5 — you pressed Stop, Instagram
refused, the queue ran dry — leaves 15 of it unspent, and the next Start asks which of
the two things it should be: *finish it* carries the tally over so the cap sends the
remaining 15, or *start over* zeroes it and spends a whole new cap, whose size you can
type into the bar there and then. Nothing is asked when there is nothing to decide (no
cap, nothing sent yet, or a cap spent in full). Follow-ups are not carried: their cap is
per run by design, and what is owed is a clock rather than a counter.

The run is **one lead per step**, and the pause between leads is a `chrome.alarms` timer
rather than a wait held open in the service worker. The position lives in the queue
itself, so Chrome suspending an idle worker during a 90-second pause costs nothing: the
alarm wakes a fresh one, it finds its window, re-attaches the input driver and carries
on with the next pending lead.

The run loop lives in the background service worker, so you can close the Outreach page
and reopen it any time from the toolbar icon to watch progress and the live log.
`sent` leads are skipped next run; **Reset statuses** re-queues everyone.

## Calibration

Selectors key on resilient signals (RU/EN/EU aria-labels, placeholders, the `@handle`
text, geometry) — not Instagram's obfuscated class names. If a step fails, the log names
it (e.g. *"share button not found on post"*, *"no result matched @…"*, *"DM composer not
found"*). Tune the matching strings / regexes to the live UI: the shared ones live in
`src/content/finders.js`, the rest sit beside the flow that uses them
(`direct.js` · `post.js` · `story.js`).

## Notes & limits

- **The debugging bar** appears on the work window for the length of the run and goes
  away when the window closes. Pressing *Cancel* on it takes the driver away, and so do
  opening DevTools on that window or closing it mid-run. Any of those **stops the run**
  with the reason in the log; the lead in flight and everyone after it stay `pending`, so
  starting again picks up where it left off.
- **Only the work tab can drive input.** The content script also loads in your own
  Instagram tabs; input requests from anywhere but the work tab are refused.
- **A notification Chrome accepts is not a notification you see.** macOS can be refusing
  Chrome's notifications outright (System Settings → Notifications → Google Chrome) or
  sitting in a Focus mode, and `chrome.notifications.create` reports neither — it
  resolves with an id and nothing appears. So the switch in Settings fires **one test
  notification the moment you turn it on**: if that one doesn't show up, none of them
  will, and it is the system rather than the extension. The three failures that *are*
  ours — permission never granted, permission revoked later, the call itself throwing —
  each say so in the run log instead of returning quietly, which is what "notifications don't
  work" looked like from the inside.
- **A click is a coordinate**, so the target must really be on screen and uncovered. The
  content script scrolls it into view with wheel events and hit-tests the aim point
  before handing it over; if a modal is in the way it dismisses it and retries once,
  then fails loudly rather than clicking whatever is underneath.
- **Out of sight is fine.** A window on another macOS Space, or one fully covered by
  another window, is occluded as far as Chrome is concerned, and Chrome stops producing
  frames for an occluded window. The renderer's whole rendering step goes with them —
  `requestAnimationFrame`, `IntersectionObserver`, `ResizeObserver`, CSS transitions —
  and the page's timers drop to a wake a second on top of that. Instagram builds its
  lists and threads on exactly those, so the run stands still until somebody looks at
  the window again. Measured on a window covered by another: **0 frames** in 6s and
  1000ms timers. The run therefore sends `Emulation.setFocusEmulationEnabled` over the
  debugger session it already holds, which makes the renderer treat the page as focused
  and active: the same window then measured **356 frames** in 6s and 252ms timers, and
  reported `visibilityState: "visible"`. It survives a navigation, and turning it off
  puts the window straight back to 0 frames. It also makes the page think it has
  keyboard focus, which is what an automation typing into a composer wants anyway.
  `node test/occlusion.test.mjs` holds it to all of that on real, genuinely occluded
  Chrome windows. Audio does **not** solve this: a tab playing audio is exempt from
  timer throttling and nothing else — measured with an oscillator running on an occluded
  window, rAF was still 0 — which is why the earlier oscillator is gone, and with it the
  audio indicator that used to sit on the tab for the length of a run.
- **Skip existing conversation** applies to **every** send path, since every lead is
  reached through their conversation. Instagram answers it itself: opening a chat makes
  the page fetch that thread, and the payload says whether it exists and how many
  messages are in it — the run log calls that `Instagram's own thread data`. When
  nothing was captured (re-opening a thread the page has already shown fetches nothing)
  it falls back to reading the message bubbles on screen, logged as `from the screen`,
  and that one is a heuristic.
- **Window size matters.** Below roughly 900px wide Instagram collapses Direct to one
  column and hides the conversation list — search box included — while a thread is open.
  The work window is created at 1280×900 for that reason; don't shrink it mid-run.
- **The Share dialog comes in two shapes.** Its recipient list is `[role="option"]` rows
  only while a search is active; before typing, some accounts get a grid of tiles showing
  display names instead, and the moment a recipient is picked Instagram clears the search
  and drops the list. So the dialog is found by its **search field**, the one part present
  throughout, and selection is confirmed either by a selected row matching the handle or —
  once the list is gone — by the "Write a message…" field appearing while **nothing else**
  reads as selected. The dialog's Send button is present from the moment it opens and
  proves nothing.
- **`screenX`/`screenY`:** CDP only takes viewport coordinates, which would leave every
  event with `screenX === clientX`. `src/screen-fix.js` restores the real relationship in
  the page's own world. It does not try to hide itself any further.

## Files

```
manifest.json          MV3 config, host_permissions + debugger + alarms + optional notifications
assets/                the wordmark, the backdrop photo, the hand skins
src/app.html/.css      the full-page UI's markup and styling
src/app.js             composition root: loads state, wires the sections
src/ui/campaigns.js     the switcher at the top: which campaign the page is about
src/ui/tables.js        the loaded files: one card each, handle column, preview
src/ui/leads.js         the queue: paste box, search, filters, row and bulk actions
src/ui/messages.js      message variants and the preview line
src/ui/followups.js     the follow-up steps, numbered because they are a sequence
src/ui/settings.js      the settings form
src/ui/run.js           Start/Stop, progress, live log
src/ui/dashboard.js     the stats, the squares, the hour chart
src/inbox.js            parses IG's captured payloads → who replied, who we already
                        have a conversation with (pure)
src/stats.js            every dashboard number, derived from leads + inbox (pure)
src/followups.js        who is owed a follow-up and what the run does next (pure)
src/leads.js            what the loaded tables and the pasted names add up to (pure)
src/audience.js         the follower/post bounds and their verdict (pure); the
                        numbers themselves are read by readProfileCounts in
                        src/content/finders.js
src/storage.js          chrome.storage.local wrappers, and the campaign each key
                        belongs to (table, messages, leads, follow-ups, settings)
src/spintax.js          spintax + personalize + table-variable helpers
src/table.js            CSV / TSV / XLSX parsing, no dependencies
src/background.js       orchestrator: work window, CDP attach, per-lead SEND, instant stop
src/cdp.js              the hands: trusted mouse / keyboard / wheel over chrome.debugger
src/human.js            the person: seeded HumanProfile + mouse-path maths (pure functions)
src/screen-fix.js       page-world patch for CDP's screenX/screenY artifact
src/content/            what to touch, and where  ← calibrate here. One isolated
                        world, injected in this order (see dom.js's header):
  dom.js                  waiting, visibility, aim geometry — no IG knowledge
  hands.js                the pair of hands over the work window — inert decoration
  input.js                aim + hit-test, the bridge to the worker's hands
  finders.js              finders and probes more than one surface needs
  direct.js               Direct search, the route to a lead + the plain DM
  post.js                 post grid, Share, the recipient sheet
  story.js                story / highlight viewer and its reply box
  main.js                 the entry point: one route, then the chosen path
```

## Responsible use

Send only to people who expect to hear from you, respect Instagram's Terms of Service and
rate limits, and keep volumes human. You are responsible for how you use this tool.
