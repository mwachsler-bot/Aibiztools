/**
 * injected.js
 *
 * Runs in the PAGE's own JS context (not the content script's isolated
 * world). This is the fallback data source used only when the DOM-visible
 * <script type="application/json"> tags don't yield a usable photo list
 * (see sites/zillow.js). It looks for the Zillow "photo" object shape
 * anywhere reachable from `window`, which keeps it working even if Zillow
 * renames the specific global variable or script-tag id it currently
 * uses, since we match by data shape rather than by name.
 *
 * Communicates with content.js purely via window.postMessage — this file
 * never touches chrome.* APIs (it can't; the page context has no
 * extension permissions).
 */
(function () {
  "use strict";

  const MAX_NODES = 40000;
  const MAX_DEPTH = 6;

  /** True if `value` looks like one entry of Zillow's photo/gallery array. */
  function looksLikePhotoNode(value) {
    if (!value || typeof value !== "object") return false;
    if (value.mixedSources && typeof value.mixedSources === "object") return true;
    if (typeof value.url === "string" && /zillowstatic\.com/i.test(value.url)) return true;
    return false;
  }

  /**
   * Bounded, cycle-safe walk of an object graph starting at `root`,
   * collecting every array whose entries satisfy looksLikePhotoNode.
   */
  function findPhotoArrays(root) {
    const seen = new Set();
    const found = [];
    let nodeCount = 0;

    function visit(node, depth) {
      if (!node || typeof node !== "object") return;
      if (nodeCount++ > MAX_NODES) return;
      if (depth > MAX_DEPTH) return;
      if (seen.has(node)) return;
      seen.add(node);

      if (Array.isArray(node)) {
        if (node.length && node.some(looksLikePhotoNode)) {
          found.push(node.filter(looksLikePhotoNode));
        }
        for (const item of node) visit(item, depth + 1);
        return;
      }

      for (const key of Object.keys(node)) {
        // Skip obvious non-data / noisy branches to keep the walk bounded.
        if (key.startsWith("_react") || key.startsWith("__react")) continue;
        let value;
        try {
          value = node[key];
        } catch (_) {
          continue;
        }
        if (typeof value === "function") continue;
        if (value instanceof Node) continue;
        if (value instanceof Window) continue;
        visit(value, depth + 1);
      }
    }

    visit(root, 0);
    return found;
  }

  function collectCandidatePhotoArrays() {
    const roots = [];
    if (window.__NEXT_DATA__) roots.push(window.__NEXT_DATA__);
    if (window.__APOLLO_STATE__) roots.push(window.__APOLLO_STATE__);
    if (window.__INITIAL_STATE__) roots.push(window.__INITIAL_STATE__);

    // Generic sweep of top-level own properties as a last resort, so a
    // renamed global is still found by shape.
    for (const key of Object.getOwnPropertyNames(window)) {
      if (roots.length > 12) break; // keep the sweep cheap
      if (!/state|data|apollo|initial|cache|zillow/i.test(key)) continue;
      let value;
      try {
        value = window[key];
      } catch (_) {
        continue;
      }
      if (value && typeof value === "object") roots.push(value);
    }

    const allArrays = [];
    for (const root of roots) {
      allArrays.push(...findPhotoArrays(root));
    }
    // Prefer the longest match (most complete gallery listing).
    allArrays.sort((a, b) => b.length - a.length);
    return allArrays;
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__listingToolkit !== true || !data.requestId) return;
    if (data.requestType !== "findPhotoArrays") return;

    let payload = null;
    let error = null;
    try {
      payload = collectCandidatePhotoArrays();
    } catch (err) {
      error = String((err && err.message) || err);
    }

    window.postMessage(
      {
        __listingToolkit: true,
        requestId: data.requestId,
        payload,
        error,
      },
      "*"
    );
  });
})();
