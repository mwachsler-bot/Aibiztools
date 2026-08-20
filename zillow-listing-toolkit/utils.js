/**
 * utils.js
 *
 * Shared, site-agnostic helpers used by content.js and every module under
 * sites/. Loaded as a classic (non-module) content script so it can sit in
 * front of the other content-script files and expose a single global
 * namespace, `ListingToolkitUtils`, that they all read from.
 */
(function (global) {
  "use strict";

  /**
   * Turn arbitrary listing/room text into a filesystem-safe filename
   * fragment: strip anything that isn't alphanumeric, space, or dash,
   * collapse whitespace to single dashes, and trim stray dashes.
   */
  function sanitizeFilenamePart(text) {
    if (!text) return "";
    return String(text)
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "") // strip accents
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);
  }

  /** Zero-pad a 1-based index to at least `width` digits (e.g. 1 -> "01"). */
  function pad(n, width) {
    const w = width || 2;
    return String(n).padStart(w, "0");
  }

  /**
   * Build the final download filename for one photo.
   * "01.jpg" when no room label is known, "01-Living-Room.jpg" otherwise.
   */
  function buildFilename(index, total, label, extension) {
    const width = String(total).length < 2 ? 2 : String(total).length;
    const number = pad(index, width);
    const ext = (extension || "jpg").replace(/^\./, "");
    const cleanLabel = sanitizeFilenamePart(label);
    return cleanLabel ? `${number}-${cleanLabel}.${ext}` : `${number}.${ext}`;
  }

  /** Best-effort file extension from a URL, defaulting to jpg. */
  function extensionFromUrl(url) {
    try {
      const pathname = new URL(url).pathname;
      const match = pathname.match(/\.(jpe?g|png|webp|gif|avif)(?:$|\?)/i);
      if (match) {
        const ext = match[1].toLowerCase();
        return ext === "jpeg" ? "jpg" : ext;
      }
    } catch (_) {
      /* fall through to default */
    }
    return "jpg";
  }

  /**
   * Derive a stable "same photo, different size" dedupe key from a Zillow
   * CDN photo URL. Zillow serves each photo from a per-photo hash path
   * (e.g. /fp/<hash>-<size-suffix>.jpg or /fp/<hash>_<w>_<h>.jpg); stripping
   * the trailing size/format suffix and the extension leaves the stable
   * per-photo identifier.
   */
  function dedupeKeyFromUrl(url) {
    try {
      const u = new URL(url);
      let file = u.pathname.split("/").pop() || u.pathname;
      file = file.replace(/\.(jpe?g|png|webp|gif|avif)$/i, "");
      // Strip known Zillow size/style suffixes: "-p_e", "-p_f", "_768_576", etc.
      file = file.replace(/-(p_[a-z])$/i, "");
      file = file.replace(/_(\d{2,4})(_(\d{2,4}))?$/i, "");
      file = file.replace(/-uncropped_scaled_within_\d+_\d+$/i, "");
      return `${u.hostname}${u.pathname.split("/").slice(0, -1).join("/")}/${file}`;
    } catch (_) {
      return url;
    }
  }

  /**
   * From a Zillow "mixedSources" object ({ jpeg: [{url,width}], webp: [...] })
   * pick the single highest-resolution URL available, preferring jpeg for
   * maximum compatibility with photo viewers/editors.
   */
  function pickHighestResFromMixedSources(mixedSources) {
    if (!mixedSources || typeof mixedSources !== "object") return null;
    const formats = ["jpeg", "webp"];
    for (const format of formats) {
      const list = mixedSources[format];
      if (Array.isArray(list) && list.length) {
        const best = list.reduce((max, cur) =>
          (cur && cur.width || 0) > (max && max.width || 0) ? cur : max
        , list[0]);
        if (best && best.url) return { url: best.url, width: best.width || 0 };
      }
    }
    return null;
  }

  /**
   * Merge/dedupe a list of raw candidate photos into the final ordered set.
   * Each candidate: { url, width, caption, order }.
   * Duplicates (same dedupeKey) collapse to whichever candidate has the
   * largest width. Original relative order (first-seen `order`) is preserved.
   */
  function dedupePhotos(candidates) {
    const byKey = new Map();
    for (const candidate of candidates) {
      if (!candidate || !candidate.url) continue;
      const key = dedupeKeyFromUrl(candidate.url);
      const existing = byKey.get(key);
      if (!existing || (candidate.width || 0) > (existing.width || 0)) {
        byKey.set(key, {
          ...candidate,
          order: existing ? existing.order : candidate.order,
        });
      }
    }
    return Array.from(byKey.values()).sort((a, b) => a.order - b.order);
  }

  /**
   * Heuristic filter for junk images that sometimes leak into DOM-scraped
   * candidate lists (fallback path only — the JSON-based extraction path
   * never sees these because it reads Zillow's own `photos` array).
   */
  const JUNK_URL_PATTERNS = [
    /static-maps/i,
    /maps\.googleapis/i,
    /\/logo/i,
    /brokerage[-_]?logo/i,
    /agent[-_]?photo/i,
    /headshot/i,
    /avatar/i,
    /\/icons?\//i,
    /sprite/i,
    /favicon/i,
  ];

  function looksLikeJunk(url) {
    if (!url) return true;
    return JUNK_URL_PATTERNS.some((re) => re.test(url));
  }

  global.ListingToolkitUtils = {
    sanitizeFilenamePart,
    pad,
    buildFilename,
    extensionFromUrl,
    dedupeKeyFromUrl,
    pickHighestResFromMixedSources,
    dedupePhotos,
    looksLikeJunk,
  };
})(typeof self !== "undefined" ? self : this);
