// Reading "do we already have a conversation with them?" off Instagram's own
// traffic. Pure function, so this needs no browser and no stubs.
//
//   node test/conversations.test.mjs
//
// The payload shapes below were captured from a logged-in session on 2026-07-29
// and trimmed to the fields the parser reads — the two routes into a chat ask
// Instagram different questions and get differently shaped answers back:
//
//   Direct's search  → the thread's metadata, no messages, or a bare null plus
//                      a lookup of the person by their messaging fbid.
//   a profile's      → the thread WITH `slide_messages`, empty when the chat has
//   Message button     never been used.
import { readConversations } from "../src/inbox.js";

const results = [];
const check = (name, pass, extra = "") =>
  results.push(`${pass ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);

const VIEWER_FBID = "17842731840404478";
const VIEWER_PK = "72039820477";
const viewer = { viewer: { id: VIEWER_PK, interop_messaging_user_fbid: VIEWER_FBID }, viewer_id: VIEWER_PK };

const body = (data) => JSON.stringify({ data, extensions: { is_final: true } });

// Direct's search route: the thread exists, its messages were not asked for.
const threadMetaOnly = (username, fbid) => body({
  get_slide_thread_nullable: {
    as_ig_direct_thread: {
      __typename: "XFBIGDirectViewerThread",
      id: "1103938715912535",
      thread_key: fbid,
      is_group: false,
      users: [{ id: "30987001", username, interop_messaging_user_fbid: fbid }],
      ...viewer,
    },
  },
});

// Direct's search route with nobody to talk to yet: two of these, then a lookup.
const noThread = () => body({ get_slide_thread_nullable: null });
const lookup = (username, fbid) => body({
  xig_user_from_messaging_user_fbid: {
    id: "47787532497", username, full_name: username, interop_messaging_user_fbid: fbid,
  },
});

// The Message button's route: the thread arrives carrying its messages.
const threadWithMessages = (username, fbid, count) => body({
  get_slide_thread_nullable: {
    as_ig_direct_thread: {
      slide_messages: {
        edges: Array.from({ length: count }, (_, i) => ({
          node: { id: `mid.$fake${i}`, sender_fbid: VIEWER_FBID, timestamp_ms: `${1785268709580 + i}` },
        })),
        page_info: { has_next_page: false },
      },
      id: "222",
      thread_key: fbid,
      thread_id: fbid,
      users: [{ id: "30987001", username, interop_messaging_user_fbid: fbid }],
      last_activity_timestamp_ms: "1785268709580",
      ...viewer,
    },
  },
});

// ── the four answers Instagram gives ─────────────────────────────────────────
{
  const said = readConversations([threadMetaOnly("leadone", "116362409753479")]);
  check("a thread with no messages in the payload still proves the conversation",
    said.leadone?.exists === true, JSON.stringify(said));
  check("  and says nothing about how much is in it", said.leadone?.messages === null);
}

{
  const said = readConversations([noThread(), noThread(), lookup("strangerone", "18043746140596498")]);
  check("no thread plus a lookup of the person means no conversation",
    said.strangerone?.exists === false, JSON.stringify(said));
}

{
  const said = readConversations([threadWithMessages("strangertwo", "180437461405", 0)]);
  check("an empty message list is a chat that was never used",
    said.strangertwo?.exists === false, JSON.stringify(said));
}

{
  const said = readConversations([threadWithMessages("leadtwo", "116362409753479", 1)]);
  check("one message is a conversation", said.leadtwo?.exists === true && said.leadtwo?.messages === 1,
    JSON.stringify(said));
}

// ── silence is not a no ───────────────────────────────────────────────────────
// Re-opening a thread the page has already shown fetches nothing at all. An
// empty answer has to read as "unknown", or every second visit skips the lead.
check("nothing captured means nothing known", Object.keys(readConversations([])).length === 0);
check("a lookup on its own is not an answer",
  Object.keys(readConversations([lookup("strangerone", "18043746140596498")])).length === 0);
check("bodies that are not JSON are ignored, not thrown on",
  Object.keys(readConversations(["<!DOCTYPE html>", "", "{oops"])).length === 0);

// ── which answer wins ─────────────────────────────────────────────────────────
{
  const said = readConversations([
    noThread(), lookup("leadone", "116362409753479"), threadMetaOnly("leadone", "116362409753479"),
  ]);
  check("a thread record beats the lookup that said there was none",
    said.leadone?.exists === true, JSON.stringify(said));
}

{
  const said = readConversations([
    threadWithMessages("leadone", "1163", 3), threadMetaOnly("leadone", "1163"),
  ]);
  check("a counted thread is not flattened by a metadata-only one",
    said.leadone?.messages === 3, JSON.stringify(said));
}

{
  // Payloads arrive a page at a time; the fullest one is the truth.
  const said = readConversations([
    threadWithMessages("leadone", "1163", 0), threadWithMessages("leadone", "1163", 4),
  ]);
  check("the fullest page of a thread wins", said.leadone?.messages === 4, JSON.stringify(said));
}

// ── us, and the rest of the inbox ─────────────────────────────────────────────
{
  const withViewer = body({
    get_slide_thread_nullable: {
      as_ig_direct_thread: {
        thread_key: "1163",
        users: [
          { id: VIEWER_PK, username: "ourselves", interop_messaging_user_fbid: VIEWER_FBID },
          { id: "30987001", username: "leadone", interop_messaging_user_fbid: "1163" },
        ],
        ...viewer,
      },
    },
  });
  const said = readConversations([withViewer]);
  check("our own account is never reported as a conversation",
    said.ourselves === undefined && said.leadone?.exists === true, JSON.stringify(said));
}

{
  // The inbox scan's own payload: many threads at once, nested under the mailbox.
  const mailbox = body({
    get_slide_mailbox_for_iris_subscription: {
      __typename: "SlideMailbox",
      threads_by_folder: {
        edges: [
          // Live traffic sends an empty usersWithoutViewer next to a filled
          // users; reading only the first list found lost every thread here.
          { node: { as_ig_direct_thread: {
            thread_id: "1", thread_key: "1",
            usersWithoutViewer: [],
            users: [{ username: "InboxOne", id: "1" }],
            slide_messages: { edges: [{ node: { id: "m1", sender_fbid: VIEWER_FBID, timestamp_ms: "1" } }] },
            ...viewer,
          } } },
          { node: { as_ig_direct_thread: {
            thread_id: "2", thread_key: "2",
            usersWithoutViewer: [{ username: "inboxtwo", id: "2" }],
            slide_messages: { edges: [] },
            ...viewer,
          } } },
        ],
      },
    },
  });
  const said = readConversations([mailbox]);
  check("the inbox payload answers for every thread it carries",
    said.inboxone?.exists === true && said.inboxtwo?.exists === false, JSON.stringify(said));
  check("  and handles are matched in lower case", said.InboxOne === undefined);
}

console.log(results.join("\n"));
const ok = results.every((r) => r.startsWith("PASS"));
console.log(ok ? "ALL PASS" : "SOME FAILED");
process.exit(ok ? 0 : 1);
