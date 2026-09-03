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

function extFor(lang) {
  return EXT_MAP[String(lang || "").toLowerCase()] || "txt";
}

function fileNameFor(lang, ext) {
  return `solution.${slugify(lang || "code")}.${ext}`;
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

// --- Read-only GitHub helpers (Contents API — fine for GETs) --------------

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

// languageSolutions: [{ lang, ext, code, runtime, memory }], most-recently-synced first
function buildProblemReadme(payload, languageSolutions) {
  let md = `# ${payload.questionId ? payload.questionId + ". " : ""}${payload.title}\n\n`;
  if (payload.isManual) {
    md += `> \u26a0\ufe0f Last synced manually via "Sync Now" \u2014 not necessarily an accepted submission.\n\n`;
  }
  if (payload.difficulty) md += `**Difficulty:** ${payload.difficulty}\n\n`;
  md += `**Link:** https://leetcode.com/problems/${payload.slug}/\n\n`;
  if (payload.topics && payload.topics.length) {
    md += `**Topics:** ${payload.topics.join(", ")}\n\n`;
  }
  md += `## Problem\n\n${payload.descriptionMarkdown || "_Description unavailable \u2014 see the link above._"}\n\n`;

  for (const sol of languageSolutions) {
    md += `## Solution (${sol.lang || "code"})\n\n\`\`\`${sol.ext}\n${sol.code}\n\`\`\`\n`;
    if (sol.runtime || sol.memory) {
      md += `\n*Runtime: ${sol.runtime || "n/a"} \u00b7 Memory: ${sol.memory || "n/a"}*\n`;
    }
    md += `\n`;
  }
  return md;
}

function buildBadgesSection(badges) {
  if (!badges || !badges.length) return "";
  let md = `## \ud83c\udfc6 Achievements & Badges\n\n`;
  md += `<table><tr>\n`;
  badges.forEach((b, i) => {
    const rawIcon = b.icon ? String(b.icon) : "";
    const icon = rawIcon ? (rawIcon.startsWith("http") ? rawIcon : `https://leetcode.com${rawIcon}`) : "";
    const name = b.displayName || b.name || "Badge";
    md += `<td align="center">${icon ? `<img src="${icon}" width="70"/><br/>` : ""}${name}</td>\n`;
    if ((i + 1) % 5 === 0 && i !== badges.length - 1) md += `</tr><tr>\n`;
  });
  md += `</tr></table>\n\n`;
  return md;
}

function buildRootReadme(entries, badges) {
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

  const langsFor = (e) =>
    (e.languages && e.languages.length ? e.languages.map((l) => l.lang) : [e.lang]).filter(Boolean).join(", ");

  let md = `# LeetCode Solutions\n\n`;
  md += `Auto-synced by LeetSync \u2014 ${entries.length} problem(s) solved.\n\n`;
  md += `| Easy | Medium | Hard |\n|---|---|---|\n| ${counts.Easy} | ${counts.Medium} | ${counts.Hard} |\n\n`;
  md += buildBadgesSection(badges);
  md += `## By Category\n\n`;

  const topicNames = Object.keys(byTopic).sort();
  for (const topic of topicNames) {
    md += `### ${topic}\n\n`;
    const list = [...byTopic[topic]].sort(
      (a, b) => (parseInt(a.questionId) || 0) - (parseInt(b.questionId) || 0)
    );
    for (const e of list) {
      md += `- [${e.questionId ? e.questionId + ". " : ""}${e.title}](./${e.folder}/) \`${e.difficulty || "?"}\` \u2013 ${langsFor(e)}\n`;
    }
    md += `\n`;
  }

  md += `## All Problems (most recent first)\n\n`;
  const recent = [...entries].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  for (const e of recent) {
    md += `- [${e.questionId ? e.questionId + ". " : ""}${e.title}](./${e.folder}/) \`${e.difficulty || "?"}\` \u2013 ${langsFor(e)}\n`;
  }

  return md;
}

// --- Main push flow: one atomic commit, multi-language aware -------------

async function pushToGitHub(payload) {
  console.log("[LeetSync] pushToGitHub called with:", payload);
  const { pat, owner, repo, branch: branchSetting } = await getSettings();
  if (!pat || !owner || !repo) {
    setBadge("!", "#e67e22");
    return { ok: false, error: "Set your token, owner, and repo in the extension popup first." };
  }

  const ext = extFor(payload.lang);
  const problemSlug = slugify(payload.slug || payload.title);
  const idPrefix = paddedProblemId(payload.questionId);
  const problemFolderName = idPrefix ? `${idPrefix}-${problemSlug}` : problemSlug;
  const categorySlug = primaryCategorySlug(payload.topics);
  const folder = `${categorySlug}/${problemFolderName}`;
  const fileName = fileNameFor(payload.lang, ext);
  const solutionPath = `${folder}/${fileName}`;
  const readmePath = `${folder}/README.md`;

  try {
    // --- Read manifest & find this problem's existing entry ---
    let entries = [];
    let storedBadges = null;
    const manifestFile = await ghGetFile(owner, repo, pat, MANIFEST_PATH, branchSetting);
    if (manifestFile) {
      try {
        const parsed = JSON.parse(b64DecodeUnicode(manifestFile.content));
        entries = parsed.entries || [];
        storedBadges = parsed.badges || null;
      } catch (e) {
        entries = [];
      }
    }
    // Only overwrite stored badges if this sync actually fetched fresh ones —
    // a failed/uncached badges fetch shouldn't wipe out what we already have.
    const badges = payload.badges && payload.badges.length ? payload.badges : storedBadges;
    const idx = entries.findIndex((e) => e.slug === payload.slug);
    const existingEntry = idx >= 0 ? entries[idx] : null;
    const previousFolder = existingEntry ? existingEntry.folder : null;

    // Normalize legacy single-language entries (from before multi-language
    // support) into the new `languages: [...]` shape. Their file was named
    // "solution.<ext>" with no language slug in it.
    let languages = [];
    let legacyPath = null;
    if (existingEntry) {
      if (Array.isArray(existingEntry.languages)) {
        languages = existingEntry.languages.map((l) => ({ ...l }));
      } else if (existingEntry.lang) {
        const legacyExt = extFor(existingEntry.lang);
        legacyPath = `${previousFolder}/solution.${legacyExt}`;
        languages = [{ lang: existingEntry.lang, ext: legacyExt, fileName: fileNameFor(existingEntry.lang, legacyExt) }];
      }
    }

    // --- Skip-if-unchanged: compare against whatever's already stored for
    // THIS language (new-style path, or the legacy path if it's that language).
    const currentLangEntry = languages.find((l) => l.lang === payload.lang);
    const pathForThisLangToday =
      legacyPath && currentLangEntry && currentLangEntry.lang === payload.lang && previousFolder === folder
        ? legacyPath
        : `${folder}/${fileName}`;
    const existingSolution = await ghGetFile(owner, repo, pat, pathForThisLangToday, branchSetting);
    if (existingSolution) {
      const existingCode = b64DecodeUnicode(existingSolution.content);
      if (existingCode === payload.code && previousFolder === folder) {
        console.log("[LeetSync] code unchanged since last sync \u2014 skipping push for", folder, payload.lang);
        setBadge("=", "#95a5a6");
        return { ok: true, skipped: true, reason: "unchanged" };
      }
    }

    // --- Gather code for every OTHER language already synced for this
    // problem, so the combined README/tree includes all of them. ---
    const treeDeletes = [];
    const otherLanguageSolutions = [];
    for (const l of languages) {
      if (l.lang === payload.lang) continue; // that one is the fresh submission, handled separately
      const readFrom = legacyPath && l.lang === (existingEntry && existingEntry.lang) ? legacyPath : `${previousFolder}/${l.fileName}`;
      const f = await ghGetFile(owner, repo, pat, readFrom, branchSetting);
      if (f) {
        otherLanguageSolutions.push({ lang: l.lang, ext: l.ext, code: b64DecodeUnicode(f.content) });
      }
      if (readFrom !== `${folder}/${l.fileName}`) {
        treeDeletes.push(readFrom);
      }
    }
    if (legacyPath && (existingEntry && existingEntry.lang) === payload.lang) {
      // the legacy file IS this language — it'll be replaced by the fresh
      // submission below, so just make sure the old-named path is removed.
      if (!treeDeletes.includes(legacyPath)) treeDeletes.push(legacyPath);
    }

    // --- Upsert this language's entry ---
    const freshLangEntry = { lang: payload.lang, ext, fileName, updatedAt: new Date().toISOString() };
    const langIdx = languages.findIndex((l) => l.lang === payload.lang);
    if (langIdx >= 0) languages[langIdx] = freshLangEntry;
    else languages.push(freshLangEntry);

    const languageSolutions = [
      { lang: payload.lang, ext, code: payload.code, runtime: payload.runtime, memory: payload.memory },
      ...otherLanguageSolutions,
    ];

    const entry = {
      slug: payload.slug,
      title: payload.title,
      questionId: payload.questionId,
      difficulty: payload.difficulty,
      topics: payload.topics || [],
      folder,
      languages,
      updatedAt: new Date().toISOString(),
    };
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);

    const problemReadmeMd = buildProblemReadme(payload, languageSolutions);
    const manifestJson = JSON.stringify({ entries, badges }, null, 2);
    const rootReadmeMd = buildRootReadme(entries, badges);

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

    for (const otherSol of otherLanguageSolutions) {
      const l = languages.find((x) => x.lang === otherSol.lang);
      treeEntries.push({ path: `${folder}/${l.fileName}`, mode: "100644", type: "blob", content: otherSol.code });
    }

    for (const delPath of treeDeletes) {
      if (delPath === solutionPath) continue; // being overwritten with fresh content above, don't also delete it
      treeEntries.push({ path: delPath, mode: "100644", type: "blob", sha: null });
      console.log("[LeetSync] removing stale path:", delPath);
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