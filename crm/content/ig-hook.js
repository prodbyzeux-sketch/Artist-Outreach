// Runs in the PAGE's own world at document_start, so it must behave like it is
// not there. Two jobs, both borrowed from siluet (App.swift:15178-15212):
//
//   1. Watch Instagram's own /api/graphql traffic. When a response carries DM
//      threads, keep the REQUEST that produced it as a replay template and hand
//      the raw body over to the extension.
//   2. On demand, re-send that exact request. Same origin, same cookies, same
//      session tokens — the page asking itself the question it already asks.
//
// Hard rules, in order of how badly breaking them hurts the user:
//   · read bodies only via response.clone() — consuming the real one leaves
//     Instagram's own inbox empty;
//   · never let anything in here throw into page code — every path falls back
//     to the untouched native call;
//   · no chrome.* here (unavailable in this world) and no parsing — raw text
//     only, so this file stays as small and dumb as possible.

(() => {
  const TAG = 'ao-crm';
  const nativeFetch = window.fetch;
  const NativeXHR = window.XMLHttpRequest;

  const isGraphQL = (url) => typeof url === 'string' && url.includes('/api/graphql');
  // Opening a thread in the linked tab makes Instagram fetch its history; that
  // response is the full conversation, free of any request of ours.
  const isThreadAPI = (url) => typeof url === 'string' && url.includes('/api/v1/direct_v2/threads/');
  // The mailbox and ONE conversation answer in the same dialect — both carry
  // `slide_messages` — and telling them apart is not cosmetic: a conversation's
  // request kept as the refresh template makes every later refresh re-read that
  // one conversation and report success. The mailbox is the one that says which
  // folder its threads are in.
  const looksLikeMailbox = (body) => typeof body === 'string' && body.includes('threads_by_folder');
  const looksLikeConversation = (body) =>
    typeof body === 'string' && body.includes('slide_messages') && !body.includes('threads_by_folder');
  const looksLikeInbox = (body) => looksLikeMailbox(body) || looksLikeConversation(body);
  // The thread-list pagination request is recognised on the way OUT, by its query name.
  const looksLikePagination = (body) =>
    typeof body === 'string' && body.includes('ThreadListPagination');
  /** The query's own name, which is the only part of a request body worth saying out loud. */
  const friendlyName = (body) => {
    const m = /fb_api_req_friendly_name=([^&]*)/.exec(typeof body === 'string' ? body : '');
    try { return m ? decodeURIComponent(m[1]) : ''; } catch { return m[1]; }
  };

  function post(payload) {
    try { window.postMessage({ [TAG]: true, ...payload }, window.location.origin); } catch { /* page is gone */ }
  }

  function headerObject(init, requestLike) {
    const out = {};
    try {
      const h = init?.headers ?? requestLike?.headers;
      if (!h) return out;
      if (typeof h.forEach === 'function' && !Array.isArray(h)) h.forEach((v, k) => { out[k] = String(v); });
      else if (Array.isArray(h)) for (const [k, v] of h) out[k] = String(v);
      else for (const [k, v] of Object.entries(h)) out[k] = String(v);
    } catch { /* an exotic headers shape is not worth a broken page */ }
    return out;
  }

  /** Report a captured exchange; `template` non-null means it is replayable. */
  function report(kind, { url, body, requestBody, headers }) {
    post({ kind, url, body, template: requestBody === null ? null : { url, body: requestBody, headers } });
  }

  window.fetch = function patchedFetch(input, init) {
    let url = '';
    let headers = {};
    let bodyText = Promise.resolve(null);
    try {
      const requestLike = input && typeof input === 'object' && 'url' in input ? input : null;
      url = requestLike ? requestLike.url : String(input);
      // The thread request's headers are kept for the same reason as the
      // inbox's: they are what lets the extension ask for a conversation it was
      // never sent to, instead of steering the tab into every one of them.
      if (isThreadAPI(url)) headers = headerObject(init, requestLike);
      if (isGraphQL(url)) {
        headers = headerObject(init, requestLike);
        const raw = init?.body;
        if (typeof raw === 'string') bodyText = Promise.resolve(raw);
        else if (raw instanceof URLSearchParams) bodyText = Promise.resolve(raw.toString());
        // fetch(new Request(...)) carries the body on the Request itself, and the
        // call below consumes it — clone now or the template is lost and every
        // refresh has to open a tab instead of replaying.
        else if (requestLike) bodyText = requestLike.clone().text().then((t) => t || null, () => null);
      }
    } catch { /* fall through — the call below still runs untouched */ }

    const response = nativeFetch.apply(this, arguments);
    if (!isGraphQL(url) && !isThreadAPI(url)) return response;

    return response.then((res) => {
      try {
        // clone() — the page must still get its own unread body.
        Promise.all([res.clone().text(), bodyText]).then(([body, requestBody]) => {
          // A GET, so the template is the url and its headers — no body. Point
          // it at another thread id and it fetches that conversation instead.
          if (isThreadAPI(url)) { post({ kind: 'thread', url, body, template: { url, headers } }); return; }
          // Which queries this account's Instagram actually makes. A name, a
          // size and a yes/no — no payload. Diagnostics: the extension keys on
          // query names it cannot otherwise see.
          post({ kind: 'seen', name: friendlyName(requestBody), bytes: body ? body.length : 0, threads: looksLikeInbox(body) });
          // One conversation, asked for in GraphQL rather than the old REST
          // endpoint. Its request is worth keeping — pointed at another thread
          // it fetches that history — but it is NOT the mailbox.
          if (looksLikeConversation(body)) {
            post({ kind: 'thread', url, body, template: { url, body: requestBody, headers } });
            return;
          }
          const paging = looksLikePagination(requestBody);
          if (paging) post({ kind: 'page-template', template: { url, body: requestBody, headers } });
          // A pagination request carries a cursor, so it must never become the
          // refresh template: every later refresh would re-read that one slice
          // of the middle of the list and never see the top again. Its BODY is
          // still worth ingesting — those are conversations.
          if (looksLikeMailbox(body)) report('inbox', { url, body, requestBody: paging ? null : requestBody, headers });
        }, () => {});
      } catch { /* never let bookkeeping break the page's own request */ }
      return res;
    });
  };

  // Instagram uses fetch today; if it moves back to XHR the template would lose
  // its headers and every replay would 400, so both paths are covered. The
  // prototype methods are wrapped rather than the constructor replaced — a
  // stand-in constructor loses XMLHttpRequest.DONE and friends, and page code
  // that reads them would break.
  const state = new WeakMap();
  const proto = NativeXHR.prototype;
  const nativeOpen = proto.open;
  const nativeSetHeader = proto.setRequestHeader;
  const nativeSend = proto.send;

  proto.open = function (method, requestURL, ...rest) {
    try { state.set(this, { url: String(requestURL), headers: {}, requestBody: null }); } catch { /* ignore */ }
    return nativeOpen.call(this, method, requestURL, ...rest);
  };

  proto.setRequestHeader = function (key, value) {
    try {
      const s = state.get(this);
      if (s && isGraphQL(s.url)) s.headers[String(key)] = String(value);
    } catch { /* ignore */ }
    return nativeSetHeader.call(this, key, value);
  };

  proto.send = function (body) {
    try {
      const s = state.get(this);
      if (s && isGraphQL(s.url)) {
        s.requestBody = typeof body === 'string' ? body : body instanceof URLSearchParams ? body.toString() : null;
        this.addEventListener('load', () => {
          try {
            const { url, headers, requestBody } = s;
            const text = this.responseType === '' || this.responseType === 'text' ? this.responseText : '';
            if (looksLikeConversation(text)) {
              post({ kind: 'thread', url, body: text, template: { url, body: requestBody, headers } });
              return;
            }
            const paging = looksLikePagination(requestBody);
            if (paging) post({ kind: 'page-template', template: { url, body: requestBody, headers } });
            if (looksLikeMailbox(text)) report('inbox', { url, body: text, requestBody: paging ? null : requestBody, headers });
          } catch { /* ignore */ }
        });
      }
    } catch { /* ignore */ }
    return nativeSend.call(this, body);
  };

  // Replay, driven by the extension. Uses the NATIVE fetch so the patch above
  // doesn't capture our own replay and loop.
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const msg = event.data;
    if (!msg || msg[TAG] !== true || msg.kind !== 'replay') return;
    const { id, template } = msg;
    const done = (result) => post({ kind: 'replay-result', id, result });

    // No body means the captured request was a GET — the thread history one.
    const hasBody = typeof template.body === 'string';
    try {
      nativeFetch(template.url, {
        method: hasBody ? 'POST' : 'GET',
        headers: template.headers ?? {},
        ...(hasBody ? { body: template.body } : {}),
        credentials: 'include',
      })
        .then((res) => res.text().then((body) => done({ status: res.status, url: res.url, body })))
        .catch((e) => done({ status: 0, url: template.url, body: '', error: String(e && e.message ? e.message : e) }));
    } catch (e) {
      done({ status: 0, url: template.url, body: '', error: String(e && e.message ? e.message : e) });
    }
  });

  post({ kind: 'hook-ready' });
})();
