# Running LeetSync in Firefox

The rest of the codebase (background.js, inject.js, content.js, popup.*) is
identical between Chrome and Firefox \u2014 only the manifest differs, mainly
because Chrome's Manifest V3 requires `background.service_worker` while
Firefox uses the classic `background.scripts` array instead.

## Important limitation

LeetSync's `inject.js` relies on a content script running in the page's own
JS context (`"world": "MAIN"`) so it can see `window.monaco` and hook the
page's own `fetch`. **Firefox only added support for `"world": "MAIN"` in
Firefox 128+.** On older versions, `inject.js` simply won't run, and nothing
will sync. Check `about:support` for your version if syncing silently does
nothing.

## Setup

1. Update `manifest-firefox.json` in this folder: `browser_specific_settings.gecko.id`
   is a placeholder (`leetsync@example.com`) \u2014 change it to any unique string
   in that format (e.g. `leetsync@yourname`), since Firefox requires every
   extension to have a stable ID.
2. Make a copy of this whole folder (so you still have the Chrome version
   untouched), and in the copy, replace `manifest.json`'s contents with
   `manifest-firefox.json`'s contents (Firefox specifically looks for a file
   named `manifest.json`, not `manifest-firefox.json`).
3. Open `about:debugging#/runtime/this-firefox` in Firefox.
4. Click "Load Temporary Add-on\u2026" and select the `manifest.json` inside your
   Firefox copy of the folder.
5. Configure it the same way as the Chrome version (click the toolbar icon,
   paste your GitHub token/owner/repo, Test Connection, Save).

## Caveat

"Load Temporary Add-on" only lasts until Firefox restarts \u2014 for a
permanent install you'd need to package and sign it through Mozilla's
Add-on Developer Hub (a free process, but a separate one from Chrome's
Web Store flow, and outside what's covered here).
