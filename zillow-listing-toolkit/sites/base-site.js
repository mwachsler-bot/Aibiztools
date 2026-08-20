/**
 * sites/base-site.js
 *
 * Defines the contract every site adapter must implement, and the shared
 * page-context bridge helper adapters use to pull data out of the page's
 * own JS realm (React state, Apollo cache, etc.) when the DOM/JSON alone
 * isn't enough.
 *
 * ---------------------------------------------------------------------
 * ADDING A NEW SITE (e.g. sites/redfin.js)
 * ---------------------------------------------------------------------
 * 1. Create sites/<site>.js as a classic script (no import/export — it
 *    must run as a plain content script alongside the others).
 * 2. Implement an object matching SiteAdapter below and register it:
 *
 *      ListingToolkitSites.register({
 *        id: "redfin",
 *        detect() { ... },
 *        async extractPhotos() { ... },
 *      });
 *
 * 3. Add "sites/redfin.js" to the content_scripts "js" array in
 *    manifest.json, *before* "sites/registry.js" and "content.js".
 * 4. Add the site's host to "matches" in manifest.json's content_scripts
 *    and host_permissions.
 *
 * That's the entire integration surface — content.js, popup.js and
 * background.js never reference a specific site by name; they always go
 * through ListingToolkitSites.getActiveSite().
 *
 * SiteAdapter shape:
 *   id: string                         - unique site identifier
 *   detect(): boolean                  - true if the current page is a
 *                                         supported listing page for this
 *                                         site
 *   extractPhotos(): Promise<Photo[]>  - resolves with every listing photo,
 *                                         deduped, highest-res, in gallery
 *                                         order. Photo = { url, caption,
 *                                         width, order }
 *
 * download() is intentionally NOT part of the adapter: downloading is a
 * generic operation (chrome.downloads API via background.js) that works
 * the same way regardless of source site, so it lives once in
 * background.js instead of being duplicated per adapter.
 */
(function (global) {
  "use strict";

  /**
   * Ask the page's own JS context for data an isolated-world content
   * script cannot see directly (e.g. values only present on `window`,
   * never serialized into a <script> tag). Injects injected.js, sends it
   * a request tagged with a one-time id, and resolves with whatever it
   * posts back (or rejects on timeout).
   */
  function requestFromPageContext(requestType, timeoutMs) {
    return new Promise((resolve, reject) => {
      const requestId = `ltk_${requestType}_${Date.now()}_${Math.random().toString(36).slice(2)}`;

      function onMessage(event) {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.__listingToolkit !== true || data.requestId !== requestId) return;
        window.removeEventListener("message", onMessage);
        clearTimeout(timer);
        if (data.error) reject(new Error(data.error));
        else resolve(data.payload);
      }

      const timer = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(new Error(`Timed out waiting for page-context response to "${requestType}"`));
      }, timeoutMs || 4000);

      window.addEventListener("message", onMessage);

      let script = document.getElementById("listing-toolkit-injected");
      if (!script) {
        script = document.createElement("script");
        script.id = "listing-toolkit-injected";
        script.src = chrome.runtime.getURL("injected.js");
        (document.head || document.documentElement).appendChild(script);
      }

      const send = () => window.postMessage({ __listingToolkit: true, requestId, requestType }, "*");
      if (script.dataset.loaded === "true") {
        send();
      } else {
        script.addEventListener("load", send, { once: true });
      }
      script.dataset.loaded = "true";
    });
  }

  /** Wait for up to `timeoutMs` for `predicate()` to become truthy. */
  function waitFor(predicate, { timeoutMs = 6000, intervalMs = 150 } = {}) {
    return new Promise((resolve) => {
      const start = Date.now();
      (function poll() {
        let result;
        try {
          result = predicate();
        } catch (_) {
          result = false;
        }
        if (result) return resolve(result);
        if (Date.now() - start >= timeoutMs) return resolve(false);
        setTimeout(poll, intervalMs);
      })();
    });
  }

  global.ListingToolkitBaseSite = {
    requestFromPageContext,
    waitFor,
  };
})(typeof self !== "undefined" ? self : this);
