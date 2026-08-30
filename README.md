# LeetSync — Direct-to-GitHub LeetCode Sync

A minimal Chrome extension that auto-pushes your accepted LeetCode solutions to
your own GitHub repo, the same way LeetHub does — except **the extension's
author never gets access to your GitHub account**.

## Why this exists

LeetHub (and similar extensions) ask you to "Authorize with GitHub." That
button flow means you grant an OAuth **app** access to your repos, and the
token exchange for that app typically runs through a server the extension's
developer controls. You're trusting a stranger's backend with a token that
can usually touch more than just one repo.

LeetSync skips all of that:

- **No OAuth app, no backend.** You generate your own GitHub **fine-grained
  personal access token**, scoped to exactly one repo with only
  "Contents: Read and write" permission.
- The token is stored in `chrome.storage.local` — on your machine only.
- Every network call this extension makes goes **directly from your browser
  to `api.github.com`**. You can verify this yourself: `background.js` is the
  only file that calls `fetch()`, and every URL in it starts with
  `https://api.github.com`.
- If GitHub's servers ever get subpoenaed, breached, or misused, that's the
  same exposure you'd have anyway from using GitHub at all — no *extra* party
  is added to the chain of trust.

## How it works

1. `inject.js` runs in LeetCode's own page context (not a sandboxed content
   script) so it can hook `fetch` and watch for the `.../submissions/detail/
   <id>/check/` response LeetCode's frontend polls after you submit.
2. When that response says `"status_msg": "Accepted"`, it reads your solution
   straight out of the Monaco editor instance already living on the page
   (`window.monaco.editor.getModels()`), and calls LeetCode's own GraphQL
   endpoint (same-origin, using your existing session — no extra permission
   needed) to fetch the problem statement, examples/constraints, difficulty,
   and topic tags, converting the HTML description to Markdown.
3. It hands that whole payload to `content.js` via `window.postMessage`
   (same-page — nothing leaves the tab at this point).
4. `content.js` forwards it to `background.js`, which builds **one atomic
   commit** containing all 4 file changes via GitHub's Git Data API
   (blobs → tree → commit → ref update):
   - `<problem-slug>/solution.<ext>` — your accepted code
   - `<problem-slug>/README.md` — problem statement, examples, topics,
     difficulty, and the solution code embedded in a fenced block
   - `leetsync-manifest.json` — a small JSON index of every problem synced
     (slug, title, difficulty, topics, folder) that acts as the source of
     truth for the next file
   - `README.md` at the repo root — regenerated from the manifest every time,
     grouping all solved problems under headings by topic (Array, Linked
     List, Dynamic Programming, Pandas, etc.), plus an easy/medium/hard count
     and a most-recent-first list

   Before building that commit, it also compares your new code against
   whatever's already saved for that problem — if they're identical (e.g.
   you resubmitted to double-check something), it skips the push entirely
   rather than creating a no-op commit.

## Setup

1. **Generate a scoped GitHub token**
   - GitHub → Settings → Developer settings → Personal access tokens →
     Fine-grained tokens → *Generate new token*.
   - Repository access: "Only select repositories" → pick (or create) the one
     repo you want your solutions pushed to.
   - Permissions → Repository permissions → **Contents: Read and write**.
     Leave everything else at "No access". (This single permission also
     covers the Git Data API calls \u2014 blobs, trees, commits, refs \u2014 that
     LeetSync uses to make one atomic commit per submission.)
   - Generate, copy the token (`github_pat_...`).

2. **Load the extension**
   - Open `chrome://extensions`
   - Enable "Developer mode" (top right)
   - Click "Load unpacked" and select this folder

3. **Configure it**
   - Click the LeetSync icon in your toolbar
   - Paste your token, and enter your GitHub username and repo name
   - Click "Test Connection" to confirm, then "Save"

4. **Use it**
   - Solve a problem on `leetcode.com`, get it Accepted, and LeetSync commits
     it automatically. A green ✓ badge briefly appears on the toolbar icon on
     success; a red ✗ means check the popup for the error text.

## Limitations / notes

- Only tested against the current LeetCode UI's submission-check endpoint and
  Monaco-based editor; LeetCode does change its frontend from time to time,
  and selectors/endpoints may need small updates if it breaks.
- Doesn't currently mirror LeetHub's GeeksforGeeks support, README-of-topics
  generation, or stats tracking — it does exactly one thing (commit accepted
  code) so there's as little surface area as possible to audit.
- Fine-grained tokens can be set to auto-expire — GitHub will keep working
  with LeetSync right up until expiry, then "Test Connection" will fail and
  you generate a fresh one.