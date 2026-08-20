/**
 * background.js (Manifest V3 service worker, ES module)
 *
 * Owns all interaction with chrome.downloads. Popup UI and content
 * scripts never call chrome.downloads directly — they send a
 * LTK_DOWNLOAD message here and listen for LTK_DOWNLOAD_PROGRESS
 * broadcasts.
 *
 * Message protocol:
 *   Popup connects a port named "ltk-download" and posts
 *   { type: "LTK_DOWNLOAD", photos: [{url, filename}], folderName } to
 *   start a run. Progress is broadcast on that port AND via
 *   chrome.runtime.sendMessage (so a popup that (re)opens mid-download
 *   still gets updates) as:
 *   { type: "LTK_DOWNLOAD_PROGRESS", downloaded, total, errors: [{filename, message}], done }
 *   A popup can also ask { type: "LTK_GET_DOWNLOAD_STATE" } at any time to
 *   fetch the last known state (e.g. right after opening) without waiting
 *   for the next broadcast.
 */

/** Slugify a listing label into something safe for a folder name. */
function sanitizeFolderName(label) {
  if (!label) return "Listing Photos";
  return (
    label
      .normalize("NFKD")
      .replace(/[^\w\s,-]/g, "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 80) || "Listing Photos"
  );
}

/** Wait for a chrome.downloads item to leave the "in_progress" state. */
function waitForDownloadSettled(downloadId) {
  return new Promise((resolve) => {
    function check() {
      chrome.downloads.search({ id: downloadId }, (results) => {
        const item = results && results[0];
        if (!item || item.state !== "in_progress") {
          resolve(item || null);
          return;
        }
        setTimeout(check, 200);
      });
    }
    check();
  });
}

/** Download a single file, trying a nested-folder path first and falling
 * back to a flat filename if Chrome refuses to create the subfolder. */
async function downloadOne(url, folder, filename) {
  const attempts = [`${folder}/${filename}`, filename];
  let lastError = null;

  for (const relativePath of attempts) {
    try {
      const downloadId = await new Promise((resolve, reject) => {
        chrome.downloads.download(
          { url, filename: relativePath, conflictAction: "uniquify", saveAs: false },
          (id) => {
            if (chrome.runtime.lastError || id === undefined) {
              reject(new Error(chrome.runtime.lastError && chrome.runtime.lastError.message));
            } else {
              resolve(id);
            }
          }
        );
      });

      const settled = await waitForDownloadSettled(downloadId);
      if (settled && settled.state === "complete") return { ok: true };
      lastError = new Error((settled && settled.error) || "download did not complete");
    } catch (err) {
      lastError = err;
    }
  }

  return { ok: false, error: String((lastError && lastError.message) || lastError) };
}

// Last known state of the most recent download job, so a popup that gets
// closed and reopened mid-run can immediately redraw where things stand
// instead of losing progress. Cleared implicitly by being overwritten when
// the next job starts; chrome.downloads itself is the source of truth and
// keeps running regardless of whether anything is listening.
let lastJobState = null;

async function runDownloadJob(photos, folderName, port) {
  const folder = sanitizeFolderName(folderName);
  const total = photos.length;
  let downloaded = 0;
  const errors = [];

  function broadcastProgress(done) {
    const message = { type: "LTK_DOWNLOAD_PROGRESS", downloaded, total, errors, done };
    lastJobState = message;
    if (port) {
      try {
        port.postMessage(message);
      } catch (_) {
        /* popup closed; downloads continue regardless */
      }
    }
    chrome.runtime.sendMessage(message).catch(() => {});
  }

  // Sequential, deliberately: keeps gallery order == download order and
  // avoids hammering Zillow's CDN / Chrome's downloads queue at once.
  for (const photo of photos) {
    const result = await downloadOne(photo.url, folder, photo.filename);
    if (result.ok) {
      downloaded += 1;
    } else {
      errors.push({ filename: photo.filename, message: result.error });
    }
    broadcastProgress(false);
  }

  broadcastProgress(true);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ltk-download") return;
  port.onMessage.addListener((message) => {
    if (message && message.type === "LTK_DOWNLOAD") {
      runDownloadJob(message.photos, message.folderName, port);
    }
  });
});

// Lets a freshly (re)opened popup catch up on an in-flight or just-finished
// download instead of showing a blank state.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === "LTK_GET_DOWNLOAD_STATE") {
    sendResponse(lastJobState);
    return false;
  }
  return false;
});
