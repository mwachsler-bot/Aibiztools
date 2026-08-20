/**
 * content.js
 *
 * Thin orchestrator that runs on every matched listing page. It never
 * knows about Zillow (or any other site) directly — it just asks the
 * site registry for whichever adapter claims the current page, and
 * relays scan requests from the popup to that adapter.
 *
 * Message protocol (popup.js -> content.js, via chrome.tabs.sendMessage):
 *   { type: "LTK_DETECT" }
 *     -> { supported: boolean, siteId?: string }
 *   { type: "LTK_SCAN" }
 *     -> { photos: [{ url, width, caption, order, filename }], source, error? }
 */
(function () {
  "use strict";

  const Utils = self.ListingToolkitUtils;

  /** Best-effort human-readable listing label, used as the download subfolder name. */
  function getListingLabel() {
    const h1 = document.querySelector("h1");
    if (h1 && h1.textContent.trim()) return h1.textContent.trim();
    return document.title.split("|")[0].trim();
  }

  function buildScanResponse(site) {
    return site
      .extractPhotos()
      .then(({ photos, source }) => {
        const total = photos.length;
        const named = photos.map((photo, index) => ({
          ...photo,
          filename: Utils.buildFilename(
            index + 1,
            total,
            photo.caption,
            Utils.extensionFromUrl(photo.url)
          ),
        }));
        return { photos: named, source, listingLabel: getListingLabel() };
      })
      .catch((error) => ({ photos: [], source: null, error: String((error && error.message) || error) }));
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return false;

    if (message.type === "LTK_DETECT") {
      const site = self.ListingToolkitSites.getActiveSite();
      sendResponse({ supported: !!site, siteId: site ? site.id : null });
      return false; // synchronous response
    }

    if (message.type === "LTK_SCAN") {
      const site = self.ListingToolkitSites.getActiveSite();
      if (!site) {
        sendResponse({ photos: [], source: null, error: "This page is not a supported listing page." });
        return false;
      }
      buildScanResponse(site).then(sendResponse);
      return true; // keep the message channel open for the async response
    }

    return false;
  });
})();
