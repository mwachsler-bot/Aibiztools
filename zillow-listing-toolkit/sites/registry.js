/**
 * sites/registry.js
 *
 * Central registry of site adapters (see sites/base-site.js for the
 * contract). content.js never imports a site module directly — it always
 * asks the registry for whichever adapter, if any, claims the current
 * page via detect(). This is the one seam that has to change when a new
 * site adapter is added (plus the manifest.json entries — see
 * base-site.js for the full checklist).
 */
(function (global) {
  "use strict";

  const adapters = [];

  function register(adapter) {
    if (!adapter || typeof adapter.detect !== "function" || typeof adapter.extractPhotos !== "function") {
      throw new Error("Site adapter must implement detect() and extractPhotos()");
    }
    adapters.push(adapter);
  }

  /** Returns the first registered adapter whose detect() matches the current page, or null. */
  function getActiveSite() {
    for (const adapter of adapters) {
      try {
        if (adapter.detect()) return adapter;
      } catch (_) {
        // A misbehaving adapter shouldn't block others from being tried.
      }
    }
    return null;
  }

  global.ListingToolkitSites = { register, getActiveSite };
})(typeof self !== "undefined" ? self : this);
