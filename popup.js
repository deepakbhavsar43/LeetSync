const $ = (id) => document.getElementById(id);

async function load() {
  const s = await chrome.storage.local.get(["pat", "owner", "repo", "branch"]);
  $("pat").value = s.pat || "";
  $("owner").value = s.owner || "";
  $("repo").value = s.repo || "";
  $("branch").value = s.branch || "";
}

function currentValues() {
  return {
    pat: $("pat").value.trim(),
    owner: $("owner").value.trim(),
    repo: $("repo").value.trim(),
    branch: $("branch").value.trim(),
  };
}

function showStatus(text, cls) {
  $("status").textContent = text;
  $("status").className = cls || "";
}

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set(currentValues());
  showStatus("Saved.", "ok");
  setTimeout(() => showStatus(""), 2000);
});

$("test").addEventListener("click", async () => {
  showStatus("Testing…", "");
  await chrome.storage.local.set(currentValues());
  chrome.runtime.sendMessage({ type: "TEST_CONNECTION" }, (res) => {
    if (res && res.ok) {
      showStatus("Connected \u2014 repo found and writable.", "ok");
    } else {
      showStatus(res ? res.error : "Unknown error", "err");
    }
  });
});

$("syncNow").addEventListener("click", async () => {
  showStatus("Looking for an open LeetCode tab\u2026", "");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !/^https:\/\/leetcode\.com\/problems\//.test(tab.url)) {
    showStatus("Open a LeetCode problem page first, then try again.", "err");
    return;
  }
  chrome.tabs.sendMessage(tab.id, { type: "LEETSYNC_TRIGGER_MANUAL_SYNC" }, (res) => {
    if (chrome.runtime.lastError) {
      showStatus("Couldn't reach that tab \u2014 try refreshing the LeetCode page.", "err");
      return;
    }
    if (res && res.ok) {
      showStatus("Sync requested \u2014 check the toolbar icon for the result.", "ok");
    } else {
      showStatus("Something went wrong requesting the sync.", "err");
    }
  });
});

load();