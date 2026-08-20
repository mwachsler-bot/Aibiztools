/**
 * sites/zillow.js
 *
 * Zillow adapter: implements the SiteAdapter contract from base-site.js.
 *
 * Extraction strategy, in order (each one only runs if the previous one
 * came back empty, so a Zillow markup change degrades gracefully instead
 * of breaking outright):
 *
 *   1. DOM-embedded JSON: every <script type="application/json"> tag on
 *      the page (this covers Zillow's Apollo-preloaded-state script and
 *      Next.js' __NEXT_DATA__, whatever id they currently use) is parsed
 *      and walked for anything shaped like a Zillow photo entry.
 *   2. Page-context sweep: if nothing usable was embedded in the HTML
 *      (e.g. the gallery only hydrates client-side), injected.js runs the
 *      same shape-based search against `window` from inside the page's
 *      own JS realm.
 *   3. DOM image scrape: last resort — open the full-screen gallery so
 *      lazy images mount, then read every <img>/<source srcset> in it and
 *      keep the highest-resolution candidate each one advertises.
 *
 * All three strategies converge on the same intermediate shape before
 * dedupe/ordering: { url, width, caption, order }.
 */
(function (global) {
  "use strict";

  const Utils = global.ListingToolkitUtils;
  const BaseSite = global.ListingToolkitBaseSite;

  function detect() {
    return (
      /(^|\.)zillow\.com$/i.test(location.hostname) &&
      /\/homedetails\//i.test(location.pathname)
    );
  }

  /** True if `value` looks like one entry of Zillow's photo/gallery array. */
  function looksLikePhotoNode(value) {
    if (!value || typeof value !== "object") return false;
    if (value.mixedSources && typeof value.mixedSources === "object") return true;
    if (typeof value.url === "string" && /zillowstatic\.com/i.test(value.url)) return true;
    return false;
  }

  /**
   * Bounded, cycle-safe walk of a parsed-JSON object graph collecting
   * every array whose entries satisfy looksLikePhotoNode. Mirrors
   * injected.js's findPhotoArrays — duplicated rather than shared because
   * this runs in the content-script world and injected.js runs in the
   * page world; the two cannot share a JS heap or a <script> include.
   */
  function findPhotoArraysInObject(root, maxDepth, maxNodes) {
    const seen = new Set();
    const found = [];
    let nodeCount = 0;

    function visit(node, depth) {
      if (!node || typeof node !== "object") return;
      if (nodeCount++ > maxNodes) return;
      if (depth > maxDepth) return;
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
        visit(node[key], depth + 1);
      }
    }

    visit(root, 0);
    found.sort((a, b) => b.length - a.length);
    return found;
  }

  /** Strategy 1: scan every embedded JSON <script> tag on the page. */
  function extractFromEmbeddedJson() {
    const scripts = document.querySelectorAll(
      'script[type="application/json"], script#__NEXT_DATA__'
    );
    let best = [];
    for (const script of scripts) {
      let parsed;
      try {
        parsed = JSON.parse(script.textContent);
      } catch (_) {
        continue;
      }
      const arrays = findPhotoArraysInObject(parsed, 10, 60000);
      if (arrays.length && arrays[0].length > best.length) {
        best = arrays[0];
      }
    }
    return best;
  }

  /** Strategy 2: ask injected.js to sweep `window` in the page context. */
  async function extractFromPageContext() {
    try {
      const arrays = await BaseSite.requestFromPageContext("findPhotoArrays", 5000);
      return Array.isArray(arrays) && arrays.length ? arrays[0] : [];
    } catch (_) {
      return [];
    }
  }

  /** Opens Zillow's full gallery view so lazy-loaded photos mount in the DOM. */
  async function openGalleryIfPresent() {
    const candidates = Array.from(
      document.querySelectorAll(
        'button, a[role="button"], a'
      )
    ).filter((el) => /see all\s*\d*\s*photos|view all photos|photos\s*\(\d+\)/i.test(el.textContent || ""));
    if (candidates.length) {
      candidates[0].click();
      await BaseSite.waitFor(
        () => document.querySelectorAll('img[src*="zillowstatic.com"]').length > 5,
        { timeoutMs: 4000 }
      );
    }
    // Give any lazy `<img loading="lazy">` a moment to resolve real `src`.
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((resolve) => setTimeout(resolve, 400));
    window.scrollTo(0, 0);
  }

  /** Strategy 3: scrape rendered <img>/<source srcset> as an absolute last resort. */
  async function extractFromDom() {
    await openGalleryIfPresent();

    const results = [];
    const seenElements = new Set();
    const nodes = document.querySelectorAll("img, source");
    let order = 0;

    for (const node of nodes) {
      if (seenElements.has(node)) continue;
      seenElements.add(node);

      const srcset = node.getAttribute("srcset");
      let bestUrl = null;
      let bestWidth = 0;

      if (srcset) {
        for (const entry of srcset.split(",")) {
          const [url, size] = entry.trim().split(/\s+/);
          const width = size && size.endsWith("w") ? parseInt(size, 10) : 0;
          if (url && width >= bestWidth) {
            bestWidth = width;
            bestUrl = url;
          }
        }
      }
      if (!bestUrl) {
        bestUrl = node.getAttribute("src");
        bestWidth = node.naturalWidth || 0;
      }

      if (!bestUrl || !/zillowstatic\.com/i.test(bestUrl)) continue;
      if (Utils.looksLikeJunk(bestUrl)) continue;
      if (bestWidth && bestWidth < 300) continue; // thumbnail-sized, skip

      results.push({
        url: bestUrl,
        width: bestWidth,
        caption: node.getAttribute("alt") || "",
        order: order++,
      });
    }

    return results;
  }

  /** Normalize a raw JSON photo node (from strategies 1/2) into { url, width, caption }. */
  function normalizeJsonPhotoNode(node) {
    const best = Utils.pickHighestResFromMixedSources(node.mixedSources);
    const url = (best && best.url) || node.url || null;
    const width = (best && best.width) || node.width || 0;
    const caption = node.caption || node.photoCaption || node.description || "";
    return url ? { url, width, caption } : null;
  }

  async function extractPhotos() {
    let rawNodes = extractFromEmbeddedJson();
    let source = "embedded-json";

    if (!rawNodes.length) {
      rawNodes = await extractFromPageContext();
      source = "page-context";
    }

    let candidates;
    if (rawNodes.length) {
      candidates = rawNodes
        .map(normalizeJsonPhotoNode)
        .filter(Boolean)
        .map((photo, index) => ({ ...photo, order: index }));
    } else {
      candidates = await extractFromDom();
      source = "dom-scrape";
    }

    const deduped = Utils.dedupePhotos(candidates);
    return { photos: deduped, source };
  }

  global.ListingToolkitSites.register({
    id: "zillow",
    detect,
    extractPhotos,
  });
})(typeof self !== "undefined" ? self : this);
