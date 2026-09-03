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
  showStatus("Testing\u2026", "");
  await chrome.storage.local.set(currentValues());
  chrome.runtime.sendMessage({ type: "TEST_CONNECTION" }, (res) => {
    if (res && res.ok) {
      showStatus("Connected \u2014 repo found and writable.", "ok");
    } else {
      showStatus(res ? res.error : "Unknown error", "err");
    }
  });
});

load();
