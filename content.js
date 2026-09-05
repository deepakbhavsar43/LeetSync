// Isolated world: has access to chrome.runtime but not window.monaco.
// Just relays the payload inject.js posts onto the shared page window.
console.log("[LeetSync] content.js loaded on", window.location.href);

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (msg && msg.source === "leetsync-inject" && msg.type === "LEETSYNC_ACCEPTED") {
    // If the extension was reloaded since this tab last loaded, chrome.runtime
    // is a dead reference here — sending to it throws "Extension context
    // invalidated." A page refresh fixes it; this just avoids an ugly
    // uncaught error in the meantime.
    if (!chrome.runtime || !chrome.runtime.id) {
      console.warn("[LeetSync] extension context is stale \u2014 refresh this LeetCode tab and try again.");
      return;
    }
    console.log("[LeetSync] content.js relaying payload to background:", msg.payload);
    try {
      chrome.runtime.sendMessage({ type: "LEETSYNC_ACCEPTED", payload: msg.payload }, (res) => {
        if (chrome.runtime.lastError) {
          console.warn("[LeetSync] sendMessage error (likely stale context, refresh the tab):", chrome.runtime.lastError.message);
          return;
        }
        console.log("[LeetSync] background responded:", res);
      });
    } catch (e) {
      console.warn("[LeetSync] sendMessage threw (likely stale context, refresh the tab):", e);
    }
  }
});

// Bridge for the popup's "Sync Now" button: relay the request into the page's
// own context (inject.js), which is the only place that can read Monaco/GraphQL.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "LEETSYNC_TRIGGER_MANUAL_SYNC") {
    console.log("[LeetSync] manual sync trigger received from popup.");
    window.postMessage({ source: "leetsync-content", type: "LEETSYNC_MANUAL_SYNC_REQUEST" }, "*");
    sendResponse({ ok: true, requested: true });
    return true;
  }
});