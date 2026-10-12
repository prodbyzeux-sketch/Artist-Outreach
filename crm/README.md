# Artist Outreach — Inbox (CRM)

A CRM for Instagram Direct, right in the browser. Conversations are gathered in
their own page, where you manage them as leads rather than as chat. It is a port
of the CRM in the macOS app siluet, without the app, without AdsPower and
without a server: everything lives in the browser. In the web app it is the
**Inbox** tab (the extension page is embedded there).

This is **slice 2** of four — capturing conversations and working them as a
funnel. What already works and what doesn't yet is listed below.

## Installing

The CRM is one half of the Artist Outreach extension and isn't installed on its
own. See `../README.md`. Then:

1. Open `instagram.com/direct` in a normal tab (you need to be signed in).
2. Open **Inbox** in the web app (or click the extension icon): the conversation
   list appears.

After that Instagram can be closed: **Refresh** works without an open tab.

## How conversations are captured

The extension doesn't invent its own requests to Instagram. It watches the
request Instagram itself makes to show you your inbox, remembers it in full
(URL, body, headers) and on refresh repeats exactly that — same session, same
cookies, same token. siluet worked the same way, except there CDP played the
interceptor and here it's a script inside the page.

```
instagram.com ──▶ ig-hook (inside the page): sees the response, remembers the request
                        │
                        ▼
                  bridge ──▶ service worker ──▶ chrome.storage.local
                                                      │
                                                      ▼
                                                  Inbox page
```

If there's no Instagram tab, the extension opens one in the background, takes
the conversations and closes it. The tab is always closed, even if the capture
failed.

**Refresh vs Load all.** Instagram serves the inbox in pages of about twenty
conversations. "Refresh" reads the top one — it answers "what's new". "Load
all" goes further, in three passes: it puts the cursor into the next-page
request and repeats it; when there's nothing to repeat, it scrolls the list in
the tab so Instagram requests the pages itself; then it reads the rest of the
history of the conversations where the other person replied (the list only
brings the last message or two).

Why two ways for one list: the request that takes a cursor is only issued by
Instagram's own virtual list, and only when it needs the next chunk; the
request that loads the first page has no cursor field at all. So until that
request has been caught, the only way forward is to make the page scroll, and
the hook saves what it loads (and catches the request itself — next time the
fast pass works). Scrolling requires the tab to render frames: an occluded or
hidden tab has none, and Instagram's infinite scroll runs on
`IntersectionObserver`, so before the pass the worker turns on focus emulation
through `chrome.debugger` (measurements: `outreach/test/occlusion.test.mjs`).

The outreach half scrolls the same list with its own `scanInbox`
(`outreach/src/content/direct.js`), with a real wheel through CDP. The CRM
borrows the wheel, not the pass: `scanInbox` makes a fixed 4–6 moves and goes
back to the top (it warms up reply data before a run, it isn't a full walk), and
its input goes through the extension's single session in `outreach/src/cdp.js`
— taking it, the CRM would steal the next lead's typing into its own tab. So
the loop here is: jump `scrollTop` to the bottom of what's loaded (one action
instead of twenty ticks) plus one real wheel tick in the middle of the list
through its own debugger session — assigning `scrollTop` doesn't fire a `wheel`
event.

Every pass is paced and resumable: it carries on where it stopped next time,
and the reason it stopped is written to `health` and shown as a banner.

## Your data

Everything is in `chrome.storage.local` — in your browser. No servers, accounts
or sync for the CRM itself. Remove the extension and the data goes with it. The
CRM talks to exactly one outside place, and only if you start it yourself: the
optional local bridge on 127.0.0.1, which only answers requests without an
`Origin` or from the extension itself (see below).

## The local bridge (optional, for power users)

Nothing outside the browser can read `chrome.storage` — Chrome doesn't allow
it. So the CRM goes out itself: it posts a snapshot to a local daemon and picks
up commands from it.

```
Inbox page ──POST /sync────▶  daemon  ◀──GET /snapshot──  a script / curl / an AI agent
           ◀─GET /pending──          ◀──POST /commands──
           ──POST /ack─────▶
```

```
node crm/bridge/siluet-bridge.mjs   # port 8788
curl -s localhost:8788/sources
curl -s 'localhost:8788/snapshot?account=youraccount' | jq '.threadCount'
```

The daemon is not part of the download the web app serves; with it not running
the CRM works exactly the same and just knocks on a dead socket less often.

### Several browsers and profiles

There's one daemon and as many Inbox pages as you have profiles, each with its
own `chrome.storage` and its own Instagram account. So both directions are
addressed. On first run every page gives itself a `sourceId` (random, kept in
its own storage — `chrome.runtime.id` won't do, an unpacked extension has the
same one in every profile) and syncs its snapshot under it.

To read, name whose inbox: `?account=youraccount` or `?source=s-…`. The account
name is taken from the first conversation you started yourself (in Instagram's
thread-history response the inviter's login is the only place your account is
named rather than numbered). Until such a conversation has been opened, the
account goes by its fbid and can be addressed by it. With one source connected
the parameter can be omitted. With several and no parameter you get `409` with
the list, not "the most recent": working through one account's inbox thinking
it's another's can't be caught downstream.

To write, a command must name its target (`account` once for the whole batch is
fine). Without an address `/commands` answers `400`: an unaddressed command
would be taken by whichever page polled first and would quietly not find the
thread. If the thread is addressed correctly but its history hasn't been
captured yet, the command stays queued and is retried — `patchThread` reports
`found` and `changed` separately for exactly this.

The snapshot is the conversation index with every message's history and your
columns (`stage`, `note`, `tags`, `folderID`), plus the folder list (without it
a row would carry an id with nothing to name it). The bridge can't set a folder
by command — `intake.js` doesn't know those fields, and the page is enough for
that. The replay template (`tpl`, `tplPage`) NEVER goes into the snapshot: it
holds Instagram's live cookies and tokens and is the only thing in storage that
can act on your behalf. `test/snapshot.test.js` guards this.

Two commands are accepted back:

```bash
# set the stage and a note (stage is a funnel id: new, talking, pitched, offer, won, lost)
curl -s localhost:8788/commands -H 'content-type: application/json' \
  -d '{"account":"youraccount","commands":[{"type":"patch","threadID":"3402…","fields":{"stage":"pitched","note":"asked for a video"}}]}'

# put a draft in the composer (does not send)
curl -s localhost:8788/commands -H 'content-type: application/json' \
  -d '{"account":"youraccount","commands":[{"type":"draft","threadID":"3402…","text":"yes, it is for sale. $150 lifetime"}]}'
```

`patch` only writes `stage`, `note`, `tags` (and `followUpAt`, see below) — the
other fields of a row are what Instagram said and a command can't rewrite them.
`draft` puts the text in the composer and opens the conversation but **does not
send**: sending stays a button a human presses. And it **doesn't overwrite what
you typed**: the draft stays queued if that conversation already holds a reply a
human started, or if a human is typing in another conversation right now — the
command would take the screen away from them. It arrives when things are free.
The bridge does overwrite its own previous draft. The question is asked about
the conversation the command is addressed to, not what's on screen — an
unfinished reply waits in its own conversation even when another is open.

### What the daemon lets in

The socket is on 127.0.0.1, and that's not enough. Loopback closes the network
but not the browser: any open tab can reach localhost, and a POST with a simple
`content-type` goes out without a preflight — "it can't read the answer anyway"
means nothing here. So the door checks `Origin`, the one thing a page can't
fake: empty (curl, a script) or `chrome-extension://` gets in, anything else
gets `403`. `Access-Control-Allow-Origin` echoes the admitted origin, not `*`.

Values in `patch` are validated there too, not "applied somehow". `stage` must
be a funnel id; `tags` a list of strings, cleaned with the same rules as typed
ones; `note` text up to 4000 characters; a patch that touches none of the
columns is refused rather than acked empty. A refusal comes with a reason
(`refused`), because a silently rejected command is one the sender waits for
forever. The strictness has a concrete reason: `tags: 42` reached storage, and
from then on every render of the list crashed — the state survived reloads, and
the CRM stayed broken until storage was fixed by hand.

A command addressed to nowhere (a typo in the account) will never be picked up.
It shows in `/health` as `unroutable` and is removed with the same `/forget` as
a snapshot:

```bash
curl -s localhost:8788/health | jq '{pending, unroutable}'
curl -s localhost:8788/forget -H 'content-type: application/json' -d '{"account":"youracount"}'
```

In the top bar, next to the linked-tab chip, a **bridge** chip appears — but
only when the daemon answers. Not running, no chip at all (not a grey "off"):
the interface doesn't need permanent furniture for something you didn't ask
for. Its `title` says when the last snapshot went out (only one that really
went: `fetch` doesn't throw on 4xx/5xx, so the response is checked explicitly).
A command that arrived but can't apply yet — conversation not captured, or
someone else's text in the reply field — shows as "bridge · N queued": not
lost, it retries on the next round. It isn't red — nothing is broken, and red is
only for errors.

## Campaign or the whole inbox

Above the list there's a two-way switch. **Campaign** keeps only the
conversations whose other person is in the open campaign's lead table; **All**
shows the whole captured inbox. The choice is remembered (key `crmView`), as is
whether the analytics panel is expanded.

The outreach lead table lives **inside the campaign** — key `leads:<campaignId>`,
not `leads`: the outreach half migrates the un-namespaced key away on first run,
and reading a bare `leads` returns emptiness indistinguishable from "the
campaign hasn't been imported yet". With no campaigns at all there's no switch
and the list shows everything.

Handle matching is exact. A substring would say "this one is from the campaign"
about a stranger.

In campaign mode a collapsible panel appears on top. Collapsed it's one line:
`Producers · 42 leads · 7 sent · 2 replied · 29%`. Expanded, five numbers and the
funnel:

| | |
|---|---|
| Leads | rows in the table (deleted ones don't count — deletion there is a tombstone, not a splice) |
| Sent | how many were sent, and what share of the table that is |
| Replied | how many replied and the reply rate |
| Median reply | how long a reply typically takes |
| In this inbox | for how many sent leads the conversation is actually captured here |

`Replied` is computed by the outreach half's own functions
(`outreach/src/stats.js`), not by a second copy of the code: "replied to us" is
a definition with edges (an incoming message BEFORE our send doesn't count as a
reply), and this panel disagreeing with the dashboard would be a bug nobody
sees. Until the inbox has been scanned the cell shows `—`, not zero: "nobody
replied" and "nobody looked" are different statements.

`In this inbox` is almost always much smaller than `Sent`, and that's normal:
Instagram serves recent threads, not all of them. The line tells "the capture is
incomplete" apart from "the campaign did nothing".

During a run the panel and the card update live, the list doesn't: the outreach
half rewrites the table several times a second per lead, but what changes there
is STATUSES, not membership, and redrawing the list would twitch for the whole run.

## Folders

A folder is the PLACE a conversation lives: exactly one or none. That's what
sets it apart from a tag, of which a lead can have five; "warm AND Spanish" is a
tag query, and tags already exist. That's why you can browse by folder and not
by tag.

The chip strip sits above the search, not among the filters: a folder is a
scope, like the Campaign/All switch, not a third filter under it. Chips: `All`,
`Unfiled` and the folders, each with a count. `Unfiled` only appears when some
things are filed and some aren't: with nothing filed it's a second name for
`All`, with everything filed it's a zero nobody asked for. While you're in it,
it stays even when empty.

`+` at the end of the strip opens a name field. Enter creates the folder — **and
puts everything selected into it right away**: the shortest path from "select →
name where → put". A name already taken doesn't create a second folder, it is
understood as that one (the selection still moves). Spaces collapse, length is
cut to 24 characters, case doesn't matter.

`×` on a chip deletes the folder — with a confirmation saying how many
conversations will be left. Conversations are taken out of the folder first and
only then does the folder go: a row must not point at a folder that no longer
exists. In case that happens anyway (a second tab, an interrupted write),
`folderOf` treats an unknown id as "no folder" — a lead can't show as being
somewhere it isn't.

A single open lead is filed right on the card — the **Folder** field under the
stages. With no folders there's no field: a select whose only option is "No
folder" controls nothing.

Folders can't be renamed. The scope isn't remembered between openings — you
open on `All`, and the filters reset too.

## Selecting several conversations

⌘-click (Ctrl on Windows) adds a conversation to the selection, Shift-click takes
the whole run from the last mark to this one. The run is counted over the list
AS SHOWN — what's visible between the two rows, not the whole inbox — and is
added to the selection rather than replacing it: building a selection with two
runs from opposite ends of the list is normal, and there's no reason to lose the
first on the second.

A plain click is a click: it opens the conversation and clears the selection.
Open and selected are different things and look different: the open one has a
bar along its edge, selected ones a check over the avatar and a highlighted row.
The check is a separate button (a button can't live inside a button), sits over
the picture, appears on hover and keyboard focus and stays while the row is
selected. Escape clears the selection.

A row that leaves the list (search, filter, folder change) takes its mark with
it — otherwise a bulk action would hit conversations nobody can see.

The bar above the list only appears when something is selected: how many,
"Select all" / "Clear", and three actions — "Move to…", "Set stage…", "Mark
read". All of it goes as ONE message for the whole set: storage rewrites the
index once, so fifty selected rows redraw the page once, not fifty times.

## The funnel

Who it is sits above the conversation: avatar, name, profile link,
`5 msg · 3h · replied` and what outreach has already done with them. The right
column is controls only, no name: the same name in two columns is one name too
many in a window that's short of room.

There are six fixed stages:

`New` → `Talking` → `Pitched` → `Offer` → `Won` / `Lost`

The first four are drawn as one track in a single row, with what's passed
filled dimly and the current one brightly. As six chips that wrapped 4+2, the
funnel read as if it went New→Talking→Pitched→Offer and then started again with
Won. `Won` and `Lost` are separate buttons below — they're not the next steps on
the track but where it ends; when one of them is set, nothing on the track is marked.

The CRM interface is entirely in English. The only non-English text in the
extension's code is in the Instagram finders (`outreach/src/content/*.js`):
they match Instagram's own interface labels in several languages, so they keep
working when someone's Instagram isn't in English.

A customizable funnel would need a stage editor, rename migrations and a
decision about orphaned conversations — and wouldn't sell a single copy. A stage
nobody set isn't labelled in the interface: otherwise the label would hang on
the whole list and mean nothing.

On the right of the header is what outreach has already done with this lead:
`outreach · sent · yesterday`, `outreach · queued`, `outreach · failed` (in red,
reason in `title`). It's there, not three fields lower, because it changes what
you're about to write — and you're about to write in this very column. Handle
matching is EXACT: a substring would say "you already messaged them" about
someone you didn't. A lead that isn't in any table has no line.

The header looks at ALL campaigns, not only the open one: "I already messaged
them" doesn't stop being true because you switched the list. If the lead is
from another campaign, its name is appended — `outreach · failed · Jul 30 ·
Producers US`. From the open one it isn't — it's already in the panel on top.

The note saves itself — half a second after you stop typing, and when you leave
the field or switch conversation. A capture arriving mid-typing doesn't
overwrite the field.

Tags are your own: the "Add a tag" field under the card, Enter adds, a comma adds
several at once, × on a tag removes it. No duplicates (case-insensitive), spaces
collapse, length is cut to 24 characters — a tag must read in a chip. The bridge
writes to the same field.

Above the list there's a search and a stage filter. Search covers name,
username, last message, note and tags; the counter shows how many conversations
are shown out of how many.

A row also shows whose word was last: yours is marked `You:`. Without it "they
asked a question" and "you answered it" look the same — and that's exactly the
difference between a row waiting for you and a row waiting for them. The unread
dot comes from the same place: it goes out not only on click but also when the
last message becomes ours — you replied from your phone, the conversation was
pulled in, and the mark clears itself. A mark only a click can clear would lie
every morning about everything you answered elsewhere.

## Next step

The stage says where a lead stands. It doesn't say what to do with them on
Thursday — and without that the funnel turns into a set of labels nobody acts
on: a lead with an agreed call and a lead that went quiet look the same, and a
list sorted by last activity buries exactly the ones where nothing is happening.

So the card has a **Next step** — one day to come back on. It is set with three
buttons (tomorrow, in 3 days, in a week) or a date, and removed with "Clear".
The buttons sit ABOVE the date field: almost every due date is one of those
three, and `08/06/2026` in Chrome's own styling was the widest and brightest
element in the column while being the least used. The answer ("in 3 days", "2
days late") reads under the field, larger than the field. The day means the END
of that day: something due today isn't overdue the same second. And it's local —
`new Date('2026-08-12')` is midnight UTC, i.e. still the 11th west of
Greenwich, and a Wednesday reminder would arrive on Tuesday.

A due date that has arrived shows in two places. The column header gets **Due
N** — a toggle that keeps only the conversations you promised to come back to
today or earlier. When nothing is due the button disappears and the filter
clears itself: an empty list under a filter with nothing left to filter is a
dead end. In the list row, `today` / `2d late` replaces the last-activity time.
Replaces, not sits next to: three elements after the name turn the name into
"Drz…", and "you promised to come back" matters more on that day than "last
message 3 hours ago" — the time isn't gone, it's on the card.

A future due date isn't shown in the list at all. The list is about what to do;
a date a week away lives on the card.

## How long a lead has been standing still

When the stage changes, storage sets `stageChangedAt` itself. Itself — because
it's the only number that says "nothing has happened here for three weeks", and
a field an outside command could set would lie about exactly that. A patch can't
rewrite it.

Under the stages the card shows `12 days here`. In the list the age is appended
to the stage badge (`Pitched · 12d`), but only once it's over a week and only if
the conversation has no due date that has arrived: an overdue one already has
something to show, and two labels about the same thing are noise. `New`, `Won`
and `Lost` don't show an age: the first is where everyone starts, the other two
are finished, not abandoned.

The bridge can set a due date like a stage:
`{"type":"patch","fields":{"followUpAt":1786550400000}}`, `null` clears it. The
value is checked on the way in — an integer in milliseconds; seconds instead of
milliseconds are refused with a reason, because 1786550400 is 1970, and a
reminder from 1970 is overdue forever while never looking like an error.

## Avatars

Instagram serves profile picture links SIGNED: the path names the picture, the
query signs it, and the signature dies after a few days. Storing the link means
avatars that work for a week and then the whole list silently turns into grey
initials, with no way back: until Instagram serves that exact conversation again
in an inbox response, there's nowhere to get a new signature.

So the picture itself is stored. The service worker fetches it once, crops a
centred square down to 72 pixels (the list draws 36, screens can be 2×),
re-encodes it as JPEG and stores it as a data URL. From then on the page takes
it from there and no longer depends on the CDN.

The worker downloads it, not the page: it has host permissions, and a
cross-origin request from there goes without CORS. The CDN has no reason to send
us headers, and an `<img>` that can't be read back into a canvas is a picture
that dies with its signature.

The same picture is recognised by the file name in the path, not the whole link.
The signature changes on every re-serve and the host changes with whichever edge
answered — comparing whole links would re-download everything ten times an hour
and still miss a real photo change.

At most twelve are fetched at a time, most recent conversations first: the first
capture brings hundreds of threads, and opening hundreds of requests at once is
exactly what earns a rate limit. What fails — a 403, an expired signature, an
unreadable body — is marked and not retried until the next six-hour window,
otherwise a dead link would be re-requested on every capture, i.e. every few
seconds.

Avatars are the second place Instagram describes a person, and they're taken
from both: the inbox list and the conversation page the linked tab loads. The
second matters because the inbox response doesn't always carry a photo, and an
open conversation does.

Avatars don't go to the bridge: `lib/snapshot.js` only lets `threads`, `viewer`,
`health` and `msg:*` out, so megabytes of base64 don't fly through the socket.

## The linked tab

Next to the Inbox lives one Instagram tab (in the same group; it can't be pinned
— Chrome doesn't allow pinned tabs in groups). It isn't disposable: the
extension reuses it for everything — taking conversations, opening a thread,
sending a reply. If you already have an Instagram tab open, the extension takes
it instead of opening a new one.

The tab follows your selection in the Inbox: pick a conversation and it opens
exactly that one. Instagram then loads the full history itself, and it reaches
the Inbox without a single request of ours. Refreshing the list doesn't move the
tab — the replay is just a request, it works from any page.

**A side effect you should know about:** opening a conversation in the linked tab
marks it as read on Instagram itself — the other person will see "seen". That's
unavoidable when a conversation is really opened.

## Replies

A reply from the Inbox is typed into Instagram's real input field in the linked
tab and sent with Enter, through trusted input (`crm/trusted-input.js`).
Nothing is made up locally: the sent message appears in the conversation when
Instagram serves its own copy. If sending fails, the text comes back and the
specific reason is shown — "no input field found", "Instagram didn't accept the
message" and so on.

There's one input field for the whole inbox, but an unfinished reply belongs to
the conversation it was started in — so when you switch it doesn't stay in the
field, it waits behind its conversation and comes back when you return
(`lib/drafts.js`). Before this, a reply started for one person hung in the field
for the next, and Send takes the currently selected conversation: the text would
go to the wrong person, the only mistake in the CRM that can't be undone. Drafts
live in the page's memory, not in storage: a draft is worth the life of the tab,
not a reload. An empty field isn't a draft — returning to a conversation where
you wrote nothing clears the field rather than restoring emptiness over other text.

A reply that failed to send goes back to the conversation it was written for,
even if the screen has moved on: sending takes time, and you can switch in the
meantime. What you typed in the field meanwhile isn't overwritten — it's newer.

## What's there

- Capturing conversations from Instagram Direct: the other person, avatar, latest messages, time.
- Refresh on demand, including when the linked tab is on another page.
- Full conversation history — pulled in when the linked tab opens a conversation.
- Replying right from the Inbox (Enter sends, Shift+Enter makes a new line); an unfinished reply stays with its conversation when switching.
- Funnel stage, note and tags on every conversation; search and a stage filter with counts.
- Folders: one per conversation, a chip strip with counts above the search, a field on the card for a single lead.
- Selecting several conversations (⌘-click, Shift-click, the check on the avatar) and bulk actions: folder, stage, "read".
- Next step: a day to come back on, the "Due N" toggle and an overdue label in the row.
- Stage age: how long a lead has been standing still, on the card and — after a week — in the list.
- Avatars that don't expire: the picture is fetched once and stored itself, not a link to it.
- The "campaign / whole inbox" switch and a collapsible panel with the campaign's numbers, live during a run.
- Unread is marked with a dot; clicking a conversation clears it, and so does replying from your phone — the dot goes out as soon as the last word in the conversation is ours, wherever it came from. The mark is our own, not Instagram's: it means "I haven't dealt with this yet", not "Instagram considers it unread".
- The list row shows whose message was last: yours is marked `You:`.
- Attachments show as "attachment" / "voice message", not Instagram's "You sent an attachment." — that's an interface caption about a message, not the message.
- Clear errors: login confirmation, held requests, a changed response format, every send refusal. The red banner about a background failure waits six seconds before showing: a woken service worker routinely doesn't answer the first time, and a banner flashing for a second on every opening is noise that also moves the page. What you pressed yourself (send, "Refresh") reports an error immediately.

## Not there yet

- Renaming folders; a notification about a new reply while the page isn't open.
- A loss reason when moving to Lost, and conversion between stages.
- Quick replies (templates) — with slice 3.
- Several accounts at once: conversations are tagged with their account and don't mix, but there's no switcher in the interface.

## Development

No dependencies and no build — Chrome reads the folder as it is.

```bash
node --test 'test/*.test.js'
```

The tests cover all the pure logic: parsing Instagram's responses
(`lib/parser.js`) and the conversation merge rules (`lib/store.js`), among
others. `package.json` only exists so `node` reads the files as ES modules;
Chrome ignores it.

The layout is four folders, by WHERE the code runs, not what it's about:

| Folder | Where it lives |
|---|---|
| `content/` | inside Instagram's page |
| `page/` | the Inbox page |
| `lib/` | pure logic without `chrome.*` or the DOM — runs in both and is tested in node |
| `bridge/` | a separate process on the machine (optional) |

`sw.js` is at the root: there's one and it belongs to nobody — its path is in the manifest.

| File | What for |
|---|---|
| `content/ig-hook.js` | lives inside Instagram's page: remembers its request and repeats it on command |
| `content/bridge.js` | relay between the page and the extension |
| `content/compose.js` | finds the composer, places the caret and confirms the field emptied after sending |
| `content/scroll.js` | scrolls the conversation list to the bottom so Instagram requests the next chunk itself |
| `sw.js` | parses, stores, orchestrates refreshes, fetches avatars |
| `trusted-input.js` | types the reply and presses Enter through `chrome.debugger` |
| `lib/parser.js` | pure parsing of Instagram's responses (tested) |
| `lib/store.js` | storage and merge rules (tested) |
| `lib/backfill.js` | walking the inbox by cursor, by scrolling and one conversation in depth — and why a walk stopped (tested) |
| `lib/stages.js` | the funnel: stages, search, counts (tested) |
| `lib/followup.js` | due date, overdue, stage age (tested) |
| `lib/avatars.js` | which avatars to fetch and what counts as the same one (tested) |
| `lib/tags.js` | tag parsing and dedup (tested) |
| `lib/folders.js` | folders: create, delete, counts, "which one it's in" (tested) |
| `lib/selection.js` | what a click leaves selected — with Shift, with ⌘ and without (tested) |
| `lib/drafts.js` | unfinished replies: which text belongs to which conversation (tested) |
| `lib/outreach.js` | finding a lead in the outreach half's tables (tested) |
| `lib/campaign.js` | which campaign is open and under which key its table is (tested) |
| `lib/analytics.js` | the campaign panel's numbers on top of `outreach/src/stats.js` (tested) |
| `lib/snapshot.js` | what the bridge sees and what never leaves the browser (tested) |
| `lib/intake.js` | whom the daemon lets in and what a command must be (tested) |
| `lib/routing.js` | which command goes to whom and whose snapshot, with several Inbox pages (tested) |
| `page/crm.html` | the page's markup |
| `page/crm.js` | state, events, rendering |
| `page/queue.js` | the whole left column: folders, filters, selection, bulk actions |
| `page/view.js` | how it looks: formatting and building nodes, no state |
| `page/bridge.js` | the bridge's side inside the page: pushing the snapshot, polling commands |
| `page/styles/*.css` | six files by column: `tokens` → `controls` → `shell` → `list` → `thread` → `card`; include order matters |
| `bridge/siluet-bridge.mjs` | the local daemon, started separately |

Controls come in exactly four heights, as a rule, not a coincidence: **32** —
what you type into, and one main button per panel; **28** — every other control;
**24** — a control nested in a container (the `Campaign/All` segment, a track
step); **20** — the cross on a chip. A container adds its border and padding on
top of the nested height, so `.modes` and `.track` come out at the same 28 as
everything around them. Control labels use one size, `--fs-sm`.

`test/tree.test.js` at the extension root reads the whole tree and checks that
every relative path and every `runtime.getURL` points at an existing file.
Chrome reports that kind of breakage one at a time, at runtime and in three
different places; moving folders around is caught here in a single run.
