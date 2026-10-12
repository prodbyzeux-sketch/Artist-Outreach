// An unfinished reply belongs to the conversation it was typed in. There is one
// composer for the whole inbox, so leaving a conversation means putting the text
// somewhere — here, by thread, until that conversation is on screen again. A
// reply left in the box otherwise follows the operator to the next person and
// goes out to them, which is the one mistake in a CRM that cannot be taken back.
//
// Nothing is written to storage: a draft is worth a tab's lifetime, not a
// reload's. An empty box is not a draft — coming back to a conversation you
// never typed in must clear the composer, not restore an empty string over
// something else.
//
// It also answers the bridge's question — may a queued draft be written here?
// Text the bridge placed itself is its own to replace; anything else is somebody
// mid-sentence, and the command waits.

const blank = (text) => !String(text ?? '').trim();

export function createDrafts() {
  /** threadID → { text, placed } — `placed` is what the bridge last wrote there. */
  const book = new Map();

  const write = (threadID, text, placed) => {
    if (blank(text)) book.delete(threadID);
    else book.set(threadID, { text, placed });
  };

  return {
    /** The composer, as it stands, going back to the conversation being left. */
    keep(threadID, text) {
      write(threadID, text, book.get(threadID)?.placed ?? '');
    },

    /** What the composer shows on arriving at a conversation. */
    textFor(threadID) {
      return book.get(threadID)?.text ?? '';
    },

    /** A draft from the bridge: kept like any other, and remembered as its own. */
    place(threadID, text) {
      write(threadID, text, text);
    },

    /** May the bridge write to this conversation without taking words out of a mouth? */
    isFree(threadID) {
      const draft = book.get(threadID);
      return !draft || draft.text === draft.placed;
    },
  };
}
