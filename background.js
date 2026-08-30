// This is the ONLY file that ever makes a network call, and it only ever
// calls https://api.github.com directly with the token the user pasted into
// the popup. There is no third-party backend anywhere in this extension.

const EXT_MAP = {
  python: "py",
  python3: "py",
  java: "java",
  "c++": "cpp",
  cpp: "cpp",
  c: "c",
  "c#": "cs",
  csharp: "cs",
  javascript: "js",
  typescript: "ts",
  ruby: "rb",
  swift: "swift",
  go: "go",
  golang: "go",
  scala: "scala",
  kotlin: "kt",
  rust: "rs",
  php: "php",
  mysql: "sql",
  plsql: "sql",
  oraclesql: "sql",
  mssql: "sql",
  racket: "rkt",
  erlang: "erl",
  elixir: "ex",
  dart: "dart",
};

const MANIFEST_PATH = "leetsync-manifest.json";

function slugify(s) {
  return String(s || "solution")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function primaryCategorySlug(topics) {
  const primary = topics && topics.length ? topics[0] : "Uncategorized";
  return slugify(primary);
}

function paddedProblemId(id) {
  const n = parseInt(id, 10);
  if (isNaN(n)) return null;
  return String(n).padStart(4, "0");
}

async function getSettings() {
  return chrome.storage.local.get(["pat", "owner", "repo", "branch", "lastSubmissionId"]);
}

function ghHeaders(pat) {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function b64DecodeUnicode(str) {
  const clean = str.replace(/\n/g, "");
  return decodeURIComponent(
    Array.prototype.map
      .call(atob(clean), (c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
      .join("")
  );
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
  if (text) setTimeout(() => chrome.action.setBadgeText({ text: "" }), 5000);
}

// --- Read-only GitHub helpers (Contents API \u2014 fine for GETs) --------------

async function ghGetFile(owner, repo, pat, path, branch) {
  const ref = branch ? `?ref=${encodeURIComponent(branch)}` : "";
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}${ref}`,
    { headers: ghHeaders(pat) }
  );
  if (res.status === 200) return res.json();
  if (res.status === 404) return null;
  throw new Error(`GET ${path} failed (${res.status}): ${await res.text()}`);
}

// --- Git Data API helpers (for one atomic multi-file commit) --------------

async function resolveBranch(owner, repo, pat, branchSetting) {
  if (branchSetting) return branchSetting;
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: ghHeaders(pat) });
  if (!res.ok) throw new Error(`GET repo failed (${res.status}): ${await res.text()}`);
  const j = await res.json();
  return j.default_branch || "main";
}

async function getRefShaOrNull(owner, repo, pat, branch) {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    { headers: ghHeaders(pat) }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ref failed (${res.status}): ${await res.text()}`);
  const j = await res.json();
  return j.object.sha;
}

async function getCommitTreeSha(owner, repo, pat, commitSha) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/commits/${commitSha}`, {
    headers: ghHeaders(pat),
  });
  if (!res.ok) throw new Error(`GET commit failed (${res.status}): ${await res.text()}`);
  const j = await res.json();
  return j.tree.sha;
}

async function createTree(owner, repo, pat, baseTreeSha, entries) {
  const body = { tree: entries };
  if (baseTreeSha) body.base_tree = baseTreeSha;
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    headers: ghHeaders(pat),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST tree failed (${res.status}): ${await res.text()}`);
  return (await res.json()).sha;
}

async function createCommit(owner, repo, pat, message, treeSha, parentSha) {
  const body = { message, tree: treeSha };
  if (parentSha) body.parents = [parentSha];
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    headers: ghHeaders(pat),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST commit failed (${res.status}): ${await res.text()}`);
  return (await res.json()).sha;
}

async function upsertRef(owner, repo, pat, branch, commitSha, isNewBranch) {
  if (isNewBranch) {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs`, {
      method: "POST",
      headers: ghHeaders(pat),
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commitSha }),
    });
    if (!res.ok) throw new Error(`POST ref failed (${res.status}): ${await res.text()}`);
    return res.json();
  }
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
    { method: "PATCH", headers: ghHeaders(pat), body: JSON.stringify({ sha: commitSha }) }
  );
  if (!res.ok) throw new Error(`PATCH ref failed (${res.status}): ${await res.text()}`);
  return res.json();
}

// --- Markdown builders -------------------------------------------------

function buildProblemReadme(payload, ext) {
  const langLabel = payload.lang || "code";
  let md = `# ${payload.questionId ? payload.questionId + ". " : ""}${payload.title}\n\n`;
  if (payload.isManual) {
    md += `> \u26a0\ufe0f Synced manually via "Sync Now" \u2014 not necessarily an accepted submission.\n\n`;
  }
  if (payload.difficulty) md += `**Difficulty:** ${payload.difficulty}\n\n`;
  md += `**Link:** https://leetcode.com/problems/${payload.slug}/\n\n`;
  if (payload.topics && payload.topics.length) {
    md += `**Topics:** ${payload.topics.join(", ")}\n\n`;
  }
  md += `## Problem\n\n${payload.descriptionMarkdown || "_Description unavailable \u2014 see the link above._"}\n\n`;
  md += `## Solution (${langLabel})\n\n\`\`\`${ext}\n${payload.code}\n\`\`\`\n`;
  if (payload.runtime || payload.memory) {
    md += `\n*Runtime: ${payload.runtime || "n/a"} \u00b7 Memory: ${payload.memory || "n/a"}*\n`;
  }
  return md;
}

function buildRootReadme(entries) {
  const byTopic = {};
  for (const e of entries) {
    const topics = e.topics && e.topics.length ? e.topics : ["Uncategorized"];
    for (const t of topics) {
      (byTopic[t] = byTopic[t] || []).push(e);
    }
  }

  const counts = { Easy: 0, Medium: 0, Hard: 0 };
  entries.forEach((e) => {
    if (counts[e.difficulty] !== undefined) counts[e.difficulty]++;
  });

  let md = `# LeetCode Solutions\n\n`;
  md += `Auto-synced by LeetSync \u2014 ${entries.length} problem(s) solved.\n\n`;
  md += `| Easy | Medium | Hard |\n|---|---|---|\n| ${counts.Easy} | ${counts.Medium} | ${counts.Hard} |\n\n`;
  md += `## By Category\n\n`;

  const topicNames = Object.keys(byTopic).sort();
  for (const topic of topicNames) {
    md += `### ${topic}\n\n`;
    const list = [...byTopic[topic]].sort(
      (a, b) => (parseInt(a.questionId) || 0) - (parseInt(b.questionId) || 0)
    );
    for (const e of list) {
      md += `- [${e.questionId ? e.questionId + ". " : ""}${e.title}](./${e.folder}/) \`${e.difficulty || "?"}\`\n`;
    }
    md += `\n`;
  }

  md += `## All Problems (most recent first)\n\n`;
  const recent = [...entries].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  for (const e of recent) {
    md += `- [${e.questionId ? e.questionId + ". " : ""}${e.title}](./${e.folder}/) \`${e.difficulty || "?"}\` \u2013 ${e.lang || ""}\n`;
  }

  return md;
}

// --- Main push flow: one atomic commit, skipped entirely if unchanged ----

async function pushToGitHub(payload) {
  console.log("[LeetSync] pushToGitHub called with:", payload);
  const { pat, owner, repo, branch: branchSetting } = await getSettings();
  console.log("[LeetSync] settings loaded:", { hasPat: !!pat, owner, repo, branch: branchSetting });
  if (!pat || !owner || !repo) {
    setBadge("!", "#e67e22");
    return { ok: false, error: "Set your token, owner, and repo in the extension popup first." };
  }

  const ext = EXT_MAP[String(payload.lang || "").toLowerCase()] || "txt";
  const problemSlug = slugify(payload.slug || payload.title);
  const idPrefix = paddedProblemId(payload.questionId);
  const problemFolderName = idPrefix ? `${idPrefix}-${problemSlug}` : problemSlug;
  const categorySlug = primaryCategorySlug(payload.topics);
  const folder = `${categorySlug}/${problemFolderName}`;
  const solutionPath = `${folder}/solution.${ext}`;
  const readmePath = `${folder}/README.md`;

  try {
    // --- Skip-if-unchanged: don't commit anything if the code is identical
    // to what's already there AND it's still in the same category folder.
    const existingSolution = await ghGetFile(owner, repo, pat, solutionPath, branchSetting);
    if (existingSolution) {
      const existingCode = b64DecodeUnicode(existingSolution.content);
      if (existingCode === payload.code) {
        console.log("[LeetSync] code unchanged since last sync \u2014 skipping push for", folder);
        setBadge("=", "#95a5a6");
        return { ok: true, skipped: true, reason: "unchanged" };
      }
    }

    // --- Read the current manifest (read-only) to compute the new state ---
    let entries = [];
    const manifestFile = await ghGetFile(owner, repo, pat, MANIFEST_PATH, branchSetting);
    if (manifestFile) {
      try {
        entries = JSON.parse(b64DecodeUnicode(manifestFile.content)).entries || [];
      } catch (e) {
        entries = [];
      }
    }
    const idx = entries.findIndex((e) => e.slug === payload.slug);
    const previousFolder = idx >= 0 ? entries[idx].folder : null;
    const previousLang = idx >= 0 ? entries[idx].lang : null;

    const entry = {
      slug: payload.slug,
      title: payload.title,
      questionId: payload.questionId,
      difficulty: payload.difficulty,
      topics: payload.topics || [],
      folder,
      lang: payload.lang,
      updatedAt: new Date().toISOString(),
    };
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);

    const problemReadmeMd = buildProblemReadme(payload, ext);
    const manifestJson = JSON.stringify({ entries }, null, 2);
    const rootReadmeMd = buildRootReadme(entries);

    // --- Build ONE commit containing all file changes ---
    const branch = await resolveBranch(owner, repo, pat, branchSetting);
    const latestCommitSha = await getRefShaOrNull(owner, repo, pat, branch);
    const baseTreeSha = latestCommitSha ? await getCommitTreeSha(owner, repo, pat, latestCommitSha) : null;

    const treeEntries = [
      { path: solutionPath, mode: "100644", type: "blob", content: payload.code },
      { path: readmePath, mode: "100644", type: "blob", content: problemReadmeMd },
      { path: MANIFEST_PATH, mode: "100644", type: "blob", content: manifestJson },
      { path: "README.md", mode: "100644", type: "blob", content: rootReadmeMd },
    ];

    // If this problem's category folder changed since the last sync (e.g.
    // topic tags were empty before and now resolve to a real category),
    // remove the old files so it doesn't end up duplicated in two folders.
    if (previousFolder && previousFolder !== folder && baseTreeSha) {
      const oldExt = EXT_MAP[String(previousLang || "").toLowerCase()] || "txt";
      treeEntries.push({ path: `${previousFolder}/solution.${oldExt}`, mode: "100644", type: "blob", sha: null });
      treeEntries.push({ path: `${previousFolder}/README.md`, mode: "100644", type: "blob", sha: null });
      console.log("[LeetSync] category changed, moving folder:", previousFolder, "\u2192", folder);
    }

    const newTreeSha = await createTree(owner, repo, pat, baseTreeSha, treeEntries);
    const commitMessage = payload.isManual
      ? `LeetCode: ${payload.title} (${payload.lang || "unknown"}) \u2013 manual sync`
      : `LeetCode: ${payload.title} (${payload.lang || "unknown"}) \u2013 Accepted`;
    const newCommitSha = await createCommit(owner, repo, pat, commitMessage, newTreeSha, latestCommitSha);
    await upsertRef(owner, repo, pat, branch, newCommitSha, !latestCommitSha);

    console.log("[LeetSync] pushed single atomic commit:", newCommitSha);
    setBadge("\u2713", "#2ecc71");
    return { ok: true, path: solutionPath, commit: newCommitSha };
  } catch (e) {
    console.log("[LeetSync] pushToGitHub error:", e);
    setBadge("\u2717", "#e74c3c");
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

console.log("[LeetSync] background.js service worker started.");

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "LEETSYNC_ACCEPTED") {
    console.log("[LeetSync] background received LEETSYNC_ACCEPTED message.");
    (async () => {
      const { lastSubmissionId } = await getSettings();
      if (msg.payload.submissionId && String(msg.payload.submissionId) === String(lastSubmissionId)) {
        console.log("[LeetSync] submissionId already handled previously, skipping:", msg.payload.submissionId);
        sendResponse({ ok: true, skipped: true });
        return;
      }
      const result = await pushToGitHub(msg.payload);
      if (result.ok && msg.payload.submissionId) {
        await chrome.storage.local.set({ lastSubmissionId: msg.payload.submissionId });
      }
      sendResponse(result);
    })();
    return true; // keep the message channel open for the async response
  }

  if (msg.type === "TEST_CONNECTION") {
    (async () => {
      const { pat, owner, repo } = await getSettings();
      if (!pat || !owner || !repo) {
        sendResponse({ ok: false, error: "Fill in token, owner, and repo first." });
        return;
      }
      try {
        const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
          headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json" },
        });
        if (res.ok) sendResponse({ ok: true });
        else sendResponse({ ok: false, error: `${res.status} ${res.statusText} \u2013 check owner/repo/token scope.` });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
});