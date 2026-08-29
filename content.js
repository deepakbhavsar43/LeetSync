// Isolated world: has access to chrome.runtime but not window.monaco.
// Just relays the payload inject.js posts onto the shared page window.
console.log("[LeetSync] content.js loaded on", window.location.href);

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (msg && msg.source === "leetsync-inject" && msg.type === "LEETSYNC_ACCEPTED") {
    console.log("[LeetSync] content.js relaying payload to background:", msg.payload);
    chrome.runtime.sendMessage({ type: "LEETSYNC_ACCEPTED", payload: msg.payload }, (res) => {
      console.log("[LeetSync] background responded:", res, chrome.runtime.lastError);
    });
  }
});