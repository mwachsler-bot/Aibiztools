/**
 * popup.js (ES module — runs in the extension's popup document, not a
 * content script, so it's free to use chrome.tabs / chrome.runtime and
 * import/export if this ever grows past one file).
 */

const panels = {
  unsupported: document.getElementById("unsupported"),
  idle: document.getElementById("idle"),
  scanning: document.getElementById("scanning"),
  preview: document.getElementById("preview"),
  progress: document.getElementById("progress"),
};

const subtitleEl = document.getElementById("subtitle");
const globalErrorEl = document.getElementById("globalError");

let currentTabId = null;
let currentPhotos = []; // [{ url, filename, caption, width, order }]
let listingLabel = "Listing Photos";

function showPanel(name) {
  for (const key of Object.keys(panels)) {
    panels[key].classList.toggle("hidden", key !== name);
  }
}

function showGlobalError(message) {
  globalErrorEl.textContent = message;
  globalErrorEl.classList.remove("hidden");
}

function clearGlobalError() {
  globalErrorEl.classList.add("hidden");
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function sendToContentScript(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

async function init() {
  const resumed = await resumeInProgressDownload();
  if (resumed) return;

  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    subtitleEl.textContent = "No active tab";
    showPanel("unsupported");
    return;
  }
  currentTabId = tab.id;

  try {
    const detection = await sendToContentScript(tab.id, { type: "LTK_DETECT" });
    if (detection && detection.supported) {
      subtitleEl.textContent = "Zillow listing detected";
      showPanel("idle");
    } else {
      subtitleEl.textContent = "Not a supported page";
      showPanel("unsupported");
    }
  } catch (_) {
    // No content script injected on this tab (wrong site, chrome:// page, etc.)
    subtitleEl.textContent = "Not a supported page";
    showPanel("unsupported");
  }
}

function renderPhotoGrid(photos) {
  const grid = document.getElementById("photoGrid");
  grid.innerHTML = "";
  for (const photo of photos) {
    const item = document.createElement("label");
    item.className = "photo-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.order = String(photo.order);

    const img = document.createElement("img");
    img.src = photo.url;
    img.loading = "lazy";
    img.alt = photo.filename;

    const filename = document.createElement("div");
    filename.className = "filename";
    filename.textContent = photo.filename;

    item.appendChild(checkbox);
    item.appendChild(img);
    item.appendChild(filename);
    grid.appendChild(item);
  }
}

function getSelectedPhotos() {
  const checkboxes = document.querySelectorAll('#photoGrid input[type="checkbox"]');
  const selectedOrders = new Set(
    Array.from(checkboxes)
      .filter((cb) => cb.checked)
      .map((cb) => Number(cb.dataset.order))
  );
  return currentPhotos.filter((p) => selectedOrders.has(p.order));
}

async function runScan() {
  clearGlobalError();
  showPanel("scanning");
  try {
    const result = await sendToContentScript(currentTabId, { type: "LTK_SCAN" });
    if (result.error) {
      showGlobalError(result.error);
      showPanel("idle");
      return;
    }
    currentPhotos = result.photos;
    listingLabel = result.listingLabel || "Listing Photos";

    if (!currentPhotos.length) {
      showGlobalError("No photos were found on this listing. Try reopening the page and scanning again.");
      showPanel("idle");
      return;
    }

    document.getElementById("foundCount").textContent = `${currentPhotos.length} photo${currentPhotos.length === 1 ? "" : "s"} found`;
    renderPhotoGrid(currentPhotos);
    showPanel("preview");
  } catch (err) {
    showGlobalError("Could not scan this page: " + (err.message || err));
    showPanel("idle");
  }
}

/** Paints the progress panel from a { downloaded, total, errors, done } state. */
function renderProgress({ downloaded, total, errors, done }) {
  const progressLabel = document.getElementById("progressLabel");
  const progressFill = document.getElementById("progressFill");
  const progressStatus = document.getElementById("progressStatus");
  const errorList = document.getElementById("errorList");
  const doneBtn = document.getElementById("doneBtn");

  progressLabel.textContent = `Downloaded ${downloaded} / ${total}`;
  progressFill.style.width = `${total ? Math.round((downloaded / total) * 100) : 0}%`;

  if (errors && errors.length) {
    errorList.classList.remove("hidden");
    errorList.innerHTML = "";
    for (const e of errors) {
      const li = document.createElement("li");
      li.textContent = `${e.filename}: ${e.message}`;
      errorList.appendChild(li);
    }
  } else {
    errorList.classList.add("hidden");
    errorList.innerHTML = "";
  }

  if (done) {
    progressStatus.textContent =
      errors && errors.length ? `Finished with ${errors.length} error${errors.length === 1 ? "" : "s"}.` : "Finished.";
    doneBtn.classList.remove("hidden");
  } else {
    progressStatus.textContent = "Downloading…";
    doneBtn.classList.add("hidden");
  }
}

function startDownload(photos) {
  if (!photos.length) {
    showGlobalError("Select at least one photo to download.");
    return;
  }
  clearGlobalError();
  showPanel("progress");
  renderProgress({ downloaded: 0, total: photos.length, errors: [], done: false });

  const port = chrome.runtime.connect({ name: "ltk-download" });
  port.postMessage({
    type: "LTK_DOWNLOAD",
    photos: photos.map(({ url, filename }) => ({ url, filename })),
    folderName: listingLabel,
  });

  port.onMessage.addListener((message) => {
    if (message.type === "LTK_DOWNLOAD_PROGRESS") renderProgress(message);
  });
}

// Registered once, unconditionally: lets a download started before this
// popup instance existed (or before the port connected) keep updating the
// UI here too, e.g. if the popup was closed and reopened mid-download.
chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === "LTK_DOWNLOAD_PROGRESS" && !panels.progress.classList.contains("hidden")) {
    renderProgress(message);
  }
});

async function resumeInProgressDownload() {
  const state = await chrome.runtime.sendMessage({ type: "LTK_GET_DOWNLOAD_STATE" }).catch(() => null);
  if (state && !state.done) {
    showPanel("progress");
    renderProgress(state);
    return true;
  }
  return false;
}

document.getElementById("scanBtn").addEventListener("click", runScan);
document.getElementById("selectAllBtn").addEventListener("click", () => {
  document.querySelectorAll('#photoGrid input[type="checkbox"]').forEach((cb) => (cb.checked = true));
});
document.getElementById("selectNoneBtn").addEventListener("click", () => {
  document.querySelectorAll('#photoGrid input[type="checkbox"]').forEach((cb) => (cb.checked = false));
});
document.getElementById("downloadSelectedBtn").addEventListener("click", () => startDownload(getSelectedPhotos()));
document.getElementById("downloadAllBtn").addEventListener("click", () => startDownload(currentPhotos));
document.getElementById("doneBtn").addEventListener("click", () => window.close());

init();
