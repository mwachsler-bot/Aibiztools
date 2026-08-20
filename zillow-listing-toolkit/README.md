# Listing Toolkit (v1)

A Manifest V3 Chrome extension that finds every photo on a real-estate
listing page, dedupes and picks the highest-resolution version of each one,
and downloads them in gallery order — with a review screen so you can
uncheck anything before it hits disk.

v1 supports **Zillow** listing pages
(`zillow.com/homedetails/.../<zpid>_zpid/`). The codebase is structured so
additional sites (Redfin, Realtor.com, Homes.com, VRBO, Airbnb, …) can be
added as new files without touching the popup, background script, or
download logic.

---

## Project structure

```
zillow-listing-toolkit/
├── manifest.json          Manifest V3 config: permissions, content script
│                           wiring, popup, service worker
├── background.js           Service worker. Owns chrome.downloads: takes a
│                           list of {url, filename}, downloads them in
│                           order, broadcasts progress, survives the popup
│                           being closed/reopened mid-download
├── content.js              Runs on matched pages. Asks the site registry
│                           for the active adapter and relays
│                           detect/scan requests from the popup to it
├── injected.js              Runs in the PAGE's own JS context (not the
│                           content script's isolated world). Fallback
│                           data source: sweeps `window` for anything
│                           shaped like a Zillow photo array
├── utils.js                 Shared, site-agnostic helpers: filename
│                           building/sanitizing, dedupe-key derivation,
│                           highest-res picking, junk-URL filtering
├── sites/
│   ├── base-site.js         Documents the SiteAdapter contract every site
│   │                       module implements, plus the page-context
│   │                       messaging bridge (requestFromPageContext) and
│   │                       a small waitFor() polling helper
│   ├── registry.js          register()/getActiveSite() — the one place
│   │                       content.js goes to find "which site am I on"
│   └── zillow.js             The Zillow adapter: detect() + extractPhotos()
├── popup/
│   ├── popup.html            Structure for all popup states (unsupported /
│   │                       idle / scanning / preview-with-checkboxes /
│   │                       progress)
│   ├── popup.css             Styling
│   └── popup.js              Popup controller: talks to content.js to scan,
│                           renders the checkbox preview grid, talks to
│                           background.js to download selected/all photos
└── icons/                   16/32/48/128px toolbar + store icons
```

### Why a page-context injector exists

Content scripts run in an **isolated JS world**: they can read the DOM
(including inline `<script>` tag text) but cannot see live JavaScript
objects the page created on `window`. Zillow currently embeds its photo
data as JSON inside `<script>` tags, which `sites/zillow.js` reads
directly — no injection needed for the common case. `injected.js` is the
fallback for if/when that stops being true (e.g. photos only populate a
`window` object after client-side hydration): it's loaded into the page's
own realm, sweeps `window` for anything shaped like a Zillow photo entry,
and reports back over `window.postMessage`.

### Extraction strategy (in order, each a fallback for the last)

1. **Embedded JSON** — parse every `<script type="application/json">` tag
   (covers whatever id Zillow currently uses for its Apollo-preloaded
   state, `__NEXT_DATA__`, etc.) and walk the parsed object for anything
   shaped like `{ mixedSources: { jpeg: [{url, width}], webp: [...] } }` or
   a bare `{ url }` pointing at `zillowstatic.com`.
2. **Page-context sweep** — if nothing embedded in the HTML matched, ask
   `injected.js` to run the same shape-based search against live `window`
   state from inside the page.
3. **DOM scrape** — last resort: click "see all photos" to open the full
   gallery (mounting any lazy-loaded `<img>`s), scroll to force any
   `loading="lazy"` images to resolve, then read every `<img>`/`<source
   srcset>` on the page, keeping the highest-resolution candidate each one
   advertises and filtering out obvious junk (maps, logos, agent headshots,
   icons, anything under 300px wide).

All three strategies converge on the same shape (`{ url, width, caption,
order }`) before a single dedupe/ordering pass
(`utils.dedupePhotos`) runs: photos are deduped by a stable per-photo key
derived from their CDN URL (hostname + path with the size/format suffix
stripped), keeping whichever duplicate has the largest `width`.

Detecting by **data shape** rather than by a specific global variable
name or script-tag id is the resilience mechanism the spec asked for: if
Zillow renames `hdpApolloPreloadedData` or restructures `__NEXT_DATA__`,
the shape-based walk still finds the photo array as long as each entry
still carries a `mixedSources`/`url` field pointing at their photo CDN.

---

## Installation (unpacked, for development/testing)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `zillow-listing-toolkit/`
   folder.
4. The "Listing Toolkit" icon appears in the toolbar (pin it via the
   puzzle-piece icon for easy access).

## Testing instructions

1. Navigate to a real Zillow listing, e.g.
   `https://www.zillow.com/homedetails/1632-Craig-Rd-Toms-River-NJ-08753/39583756_zpid/`.
2. Click the Listing Toolkit toolbar icon. The popup should say "Zillow
   listing detected" and show the **Download Listing Photos** button.
3. Click it. The popup should briefly show "Loading photos…", then a grid
   of thumbnails, each with a checkbox and the filename it will be saved
   as (`01.jpg`, `02-Kitchen.jpg`, etc. — depends on whether the listing
   has agent-added captions), plus the total count found.
4. Uncheck a few photos, click **Download Selected** — only the checked
   ones should download. Reopen the popup and click **Download All**
   (after a fresh scan) to confirm the full-set path also works.
5. Watch the progress bar/count update live; on completion it should read
   "Finished." (or "Finished with N errors." if any individual file
   failed) and a **Close** button appears.
6. Check the Downloads folder: files should land under a
   `<listing address>/` subfolder, named in gallery order, and opening a
   few in an image viewer should show them at full/near-full resolution
   rather than cropped thumbnails.
7. Close the popup mid-download on a large listing, then reopen it — it
   should resume showing live progress instead of resetting.
8. Visit a non-Zillow page (or Zillow's homepage, not a listing) and open
   the popup — it should show the "not a supported listing page" state
   instead of a broken scan button.

There is currently no automated test suite (there's no build step or test
runner in this project); testing is manual against live Zillow listings as
described above, since the thing actually being validated is "does this
still match Zillow's current markup," which only a real page can answer.

## Known Zillow limitations

- **Markup can change without notice.** Zillow is a large, frequently
  redeployed site; the specific script-tag id or global variable name
  holding photo data can move. The three-tier fallback (embedded JSON →
  page-context sweep → DOM scrape) exists specifically to absorb this, but
  a big enough structural change could still require an update to
  `sites/zillow.js`.
- **Per-photo room captions are inconsistent.** Room labels
  (`Kitchen`, `Living Room`, …) only exist when the listing agent added
  them; many listings have none, in which case files fall back to plain
  `01.jpg`, `02.jpg`, … numbering, matching the spec.
- **Rate limiting / anti-bot measures.** Extremely rapid repeated scans
  or downloads (e.g. scripted use across many listings in a tight loop)
  may trigger Zillow's bot detection. This extension only fires the
  requests a normal visitor's browser already makes (it reads data
  Zillow already sent to the page) and downloads images from Zillow's own
  CDN, but heavy automated use is still worth pacing.
- **Chrome's automatic subfolder creation** works for normal Downloads
  folder locations but can silently fail on some custom download-directory
  configurations (e.g. certain enterprise policies or unusual paths); when
  that happens, the extension automatically retries each file as a flat
  filename in the top-level Downloads folder instead of failing outright.
- **Virtual tours / video walkthroughs** are not photos and are
  intentionally not extracted.

## Suggested improvements (not built in v1)

- Batch/queue mode: run the scan+download flow across multiple listing
  URLs (e.g. a saved-search results page) without re-opening the popup
  for each one.
- Persisted user preferences (folder naming pattern, JPEG vs. WEBP
  preference, default select-all vs. select-none) via `chrome.storage`.
- Optional export of a `photos.json` manifest alongside the images
  (URL, caption, width, order) for downstream tooling.
- Concurrency-limited parallel downloads (currently sequential, by
  design, to preserve strict gallery ordering and avoid hammering the CDN
  — could add a small worker pool while still writing files in order).

## Future-proofing: adding another site

`sites/base-site.js` documents the full adapter contract and checklist.
In short:

1. Add `sites/<site>.js` implementing `detect()` and `extractPhotos()`.
2. Register it: `ListingToolkitSites.register({ id, detect, extractPhotos })`.
3. Add the new file to `content_scripts.js` in `manifest.json` (after
   `sites/registry.js`, before `content.js`) and add the site's
   host to `matches`/`host_permissions`.

`content.js`, `popup.js`, and `background.js` never reference a specific
site by name — they only ever go through
`ListingToolkitSites.getActiveSite()` — so none of them need to change.

## Future features (architecture, not built)

The popup's checkbox-preview screen doubles as the seam for these without
changing the extraction/download pipeline: each selected photo is already
a discrete `{url, filename}` record before download, so a future action
like "Enhance Selected" or "Generate Flyer From Selected" is a new button
next to *Download Selected* that hands the same selection array to a new
module, rather than a rework of how photos are found or named. Planned
directions (AI photo enhancement, AI listing descriptions, feature
extraction, social/flyer/video generators, twilight conversion, virtual
decluttering, floor plan detection, MLS export) are intentionally **not**
stubbed out with placeholder code — half-built menu items that do nothing
would be worse than no menu items — but the data flow already supports
bolting them on as new popup actions + new background message types.

## Publishing to the Chrome Web Store

1. Create/sign in to a [Chrome Web Store developer account](https://chrome.google.com/webstore/devconsole)
   (one-time $5 registration fee).
2. Bump `"version"` in `manifest.json` for each release.
3. Zip the **contents** of `zillow-listing-toolkit/` (not the folder
   itself as a nested directory) — e.g. from inside the folder:
   `zip -r ../listing-toolkit.zip .`
4. In the Developer Dashboard, click **New Item**, upload the zip.
5. Fill in the store listing: description, at least one 1280x800 (or
   640x400) promotional screenshot, and a 128×128 icon (already included
   at `icons/icon128.png`).
6. Under **Privacy practices**, disclose what the extension does: it reads
   the content of Zillow listing pages the user is already viewing to find
   photo URLs, and downloads files the user explicitly selects. It does
   not transmit any data off-device.
7. Submit for review. Manifest V3 extensions using only `downloads` and
   `activeTab` (this extension's permission set) are generally low-friction
   reviews since neither permission requires the more sensitive
   "broad host permissions" justification flow — but be ready to justify
   `host_permissions` for `zillow.com` (needed so the content script can
   run there) in the listing's permission-justification field.
8. After approval, future updates are just re-uploading a new zip with a
   bumped version number.
