// Runs in the PAGE's own JS context (world: MAIN), so it can see window.monaco
// and the page's fetch calls. It never talks to any network endpoint itself —
// it only reads data (including LeetCode's own GraphQL, same-origin, using the
// page's existing session) and hands it to content.js via window.postMessage.
(function () {
  const CHECK_URL_RE = /\/submissions\/detail\/\d+\/(v\d+\/)?check\//;
  const SUBMIT_URL_RE = /\/problems\/[^/]+\/submit\/?$/;
  const GRAPHQL_URL_RE = /\/graphql\/?($|\?)/;
  const originalFetch = window.fetch;

  // Fallback category names for languages LeetCode doesn't tag with topicTags
  // (database/Pandas problems). Only used if the live submissionDetails call
  // (which reports the real display name for ANY language) doesn't arrive in time.
  const LANG_FALLBACK_CATEGORY = {
    pythondata: "Pandas",
    mysql: "MySQL",
    mssql: "MS SQL Server",
    oraclesql: "Oracle SQL",
    postgresql: "PostgreSQL",
  };

  let lastSubmittedCode = null;
  let lastSubmittedLang = null;

  // LeetCode calls a "submissionDetails" GraphQL query right after Accepted
  // (to render the runtime/memory percentile charts). It includes lang.verboseName
  // and the exact submitted code for ANY language/track, so we capture it generically
  // instead of hardcoding every possible language LeetCode might add.
  let submissionDetailsResolver = null;
  let pendingSubmissionDetailsPromise = null;
  function waitForSubmissionDetails(timeoutMs) {
    if (pendingSubmissionDetailsPromise) return pendingSubmissionDetailsPromise;
    pendingSubmissionDetailsPromise = new Promise((resolve) => {
      submissionDetailsResolver = resolve;
      setTimeout(() => resolve(null), timeoutMs);
    });
    return pendingSubmissionDetailsPromise;
  }

  window.fetch = async function (...args) {
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0] && args[0].url;
      if (url && SUBMIT_URL_RE.test(url)) {
        const init = args[1] || {};
        let bodyStr = init.body;
        if (bodyStr && typeof bodyStr !== "string") {
          try {
            bodyStr = null; // FormData/Blob bodies aren't expected here; skip rather than guess
          } catch (e) {}
        }
        if (bodyStr) {
          try {
            const parsed = JSON.parse(bodyStr);
            if (parsed && parsed.typed_code) {
              lastSubmittedCode = parsed.typed_code;
              lastSubmittedLang = parsed.lang || parsed.language || null;
              console.log("[LeetSync] captured submitted code, length:", lastSubmittedCode.length, "lang:", lastSubmittedLang);
            }
          } catch (e) {
            console.log("[LeetSync] failed to parse submit body:", e);
          }
        }
      }
    } catch (e) {
      console.log("[LeetSync] submit-capture hook error:", e);
    }

    const response = await originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0] && args[0].url;
      if (url && /submissions|graphql/i.test(url)) {
        console.log("[LeetSync] fetch seen:", url);
      }
      if (url && GRAPHQL_URL_RE.test(url)) {
        let opName = null;
        try {
          const initBody = args[1] && args[1].body;
          if (initBody && typeof initBody === "string") {
            opName = JSON.parse(initBody).operationName;
          }
        } catch (e) {}
        if (opName === "submissionDetails") {
          response
            .clone()
            .json()
            .then((json) => {
              const sd = json && json.data && json.data.submissionDetails;
              if (sd) {
                console.log("[LeetSync] submissionDetails captured:", sd);
                if (submissionDetailsResolver) {
                  submissionDetailsResolver(sd);
                  submissionDetailsResolver = null;
                }
              }
            })
            .catch((e) => console.log("[LeetSync] failed to parse submissionDetails:", e));
        }
      }
      if (url && CHECK_URL_RE.test(url)) {
        console.log("[LeetSync] check endpoint matched:", url);
        response
          .clone()
          .json()
          .then((data) => {
            console.log("[LeetSync] check response:", data);
            if (data && data.state === "SUCCESS" && data.status_msg === "Accepted") {
              console.log("[LeetSync] Accepted detected \u2014 handling...");
              handleAccepted(data);
            }
          })
          .catch((e) => console.log("[LeetSync] failed to parse check response:", e));
      }
    } catch (e) {
      console.log("[LeetSync] fetch hook error:", e);
    }
    return response;
  };

  function getCode() {
    try {
      if (window.monaco && window.monaco.editor) {
        const models = window.monaco.editor.getModels();
        if (models && models.length) {
          return models[models.length - 1].getValue();
        }
      }
    } catch (e) {}
    return null;
  }

  function getSlug() {
    const m = window.location.pathname.match(/\/problems\/([^/]+)/);
    return m ? m[1] : null;
  }

  function getTitle() {
    const t = document.title.replace(/\s*-\s*LeetCode\s*$/i, "").trim();
    return t || getSlug();
  }

  // Minimal HTML -> Markdown converter, good enough for LeetCode's problem
  // descriptions (paragraphs, lists, code, bold/italic, sup/sub, examples).
  function htmlToMarkdown(html) {
    if (!html) return "";
    let doc;
    try {
      doc = new DOMParser().parseFromString(html, "text/html");
    } catch (e) {
      return html.replace(/<[^>]+>/g, "");
    }

    function walk(node) {
      let out = "";
      node.childNodes.forEach((child) => {
        out += nodeToMd(child);
      });
      return out;
    }

    function nodeToMd(node) {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent;
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      const tag = node.tagName.toLowerCase();
      const inner = () => walk(node);
      switch (tag) {
        case "p":
          return inner().trim() + "\n\n";
        case "strong":
        case "b":
          return `**${inner()}**`;
        case "em":
        case "i":
          return `*${inner()}*`;
        case "code":
          return `\`${inner()}\``;
        case "pre":
          return "```\n" + inner().trim() + "\n```\n\n";
        case "ul":
          return (
            Array.from(node.children)
              .map((li) => `- ${walk(li).trim()}`)
              .join("\n") + "\n\n"
          );
        case "ol":
          return (
            Array.from(node.children)
              .map((li, i) => `${i + 1}. ${walk(li).trim()}`)
              .join("\n") + "\n\n"
          );
        case "li":
          return inner();
        case "sup":
          return `^${inner()}`;
        case "sub":
          return `_${inner()}`;
        case "br":
          return "\n";
        case "img":
          return `![](${node.getAttribute("src") || ""})`;
        case "a":
          return `[${inner()}](${node.getAttribute("href") || ""})`;
        default:
          return inner();
      }
    }

    return walk(doc.body).replace(/\n{3,}/g, "\n\n").trim();
  }

  async function fetchQuestionData(slug) {
    if (!slug) return null;
    try {
      const res = await originalFetch("https://leetcode.com/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationName: "questionData",
          variables: { titleSlug: slug },
          query: `query questionData($titleSlug: String!) {
            question(titleSlug: $titleSlug) {
              questionId
              questionFrontendId
              title
              titleSlug
              difficulty
              content
              topicTags { name slug }
            }
          }`,
        }),
      });
      const json = await res.json();
      return json && json.data ? json.data.question : null;
    } catch (e) {
      return null;
    }
  }

  let lastHandledSubmissionId = null;

  async function handleAccepted(data) {
    const submissionId = data.submission_id || data.task_id || null;
    if (submissionId && submissionId === lastHandledSubmissionId) {
      console.log("[LeetSync] duplicate submissionId, skipping:", submissionId);
      return;
    }

    const code = getCode() || lastSubmittedCode;
    console.log("[LeetSync] code from Monaco/captured-submit, length:", code ? code.length : null);

    const slug = getSlug();
    console.log("[LeetSync] slug:", slug);
    const q = await fetchQuestionData(slug);
    console.log("[LeetSync] questionData:", q);

    const sd = await waitForSubmissionDetails(1500);
    console.log("[LeetSync] submissionDetails (awaited):", sd);

    const rawLang = (data.lang || lastSubmittedLang || "").toLowerCase();
    const liveVerboseName = sd && sd.lang && sd.lang.verboseName;
    let topics = q && q.topicTags ? q.topicTags.map((t) => t.name) : [];
    if (!topics.length) {
      const fallbackCategory = liveVerboseName || LANG_FALLBACK_CATEGORY[rawLang];
      if (fallbackCategory) {
        topics = [fallbackCategory];
        console.log("[LeetSync] no topicTags \u2014 using language category:", fallbackCategory);
      }
    }

    // Prefer the code LeetCode itself stored for this submission if our
    // earlier sources came up empty.
    const finalCode = code || (sd && sd.code) || null;
    if (!finalCode) {
      console.log("[LeetSync] no code available from any source \u2014 aborting.");
      return;
    }
    lastHandledSubmissionId = submissionId;

    const payload = {
      slug,
      title: getTitle(),
      lang: data.lang || data.pretty_lang || lastSubmittedLang || null,
      runtime: data.status_runtime || null,
      memory: data.status_memory || null,
      code: finalCode,
      submissionId,
      timestamp: Date.now(),
      questionId: (q && (q.questionFrontendId || q.questionId)) || null,
      difficulty: (q && q.difficulty) || null,
      topics,
      descriptionMarkdown: q && q.content ? htmlToMarkdown(q.content) : null,
    };

    console.log("[LeetSync] posting payload to content script:", payload);
    window.postMessage({ source: "leetsync-inject", type: "LEETSYNC_ACCEPTED", payload }, "*");
  }
})();