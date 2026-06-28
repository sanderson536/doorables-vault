(function () {
  "use strict";

  const db = window.DoorablesDB;
  const zip = window.DoorablesZip;
  const APP_VERSION = "1.3.0";
  const IMAGE_FILE_TYPES = ["image/jpeg", "image/png", "image/webp"];
  const IMAGE_FILE_EXTENSIONS = ".jpg,.jpeg,.png,.webp";
  const ZIP_FILE_EXTENSIONS = ".zip,application/zip,application/x-zip-compressed";
  const IMAGE_EXTENSION_TO_MIME = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp"
  };
  const MAX_IMAGE_DIMENSION = 900;
  const MAX_IMAGE_BYTES = 900 * 1024;
  const IMAGE_JPEG_QUALITY = 0.84;

  // App state stays centralized for v1.3.0. Rendering reads from this object only.
  const state = {
    tab: "dashboard",
    search: "",
    collectionFilter: "All",
    inventoryFilter: "All",
    currentCategory: "",
    currentSeries: "",
    bulkSeries: "",
    master: [],
    collection: [],
    collectionMap: new Map(),
    activity: [],
    isOnline: navigator.onLine,
    storage: {
      counts: {},
      estimate: {},
      lastBackupDate: ""
    },
    dbFilters: {
      category: "",
      series: "",
      franchise: "",
      rarity: "",
      sort: "seriesFranchiseCharacter"
    }
  };

  const elements = {};
  const saveTimers = new Map();
  const imageUrlCache = new Map();
  const imagePackBuilder = createEmptyImagePackBuilder();
  let updatePromptShown = false;
  let refreshingForUpdate = false;
  let pendingModalResolve = null;
  let pendingModalCleanup = null;

  document.addEventListener("DOMContentLoaded", init);

  // Startup and service worker wiring.
  async function init() {
    elements.view = document.querySelector("#app-view");
    elements.search = document.querySelector("#global-search");
    elements.nav = document.querySelector(".bottom-nav");
    elements.fabButton = document.querySelector("#fab-button");
    elements.fabMenu = document.querySelector("#fab-menu");
    elements.modal = document.querySelector("#modal");
    elements.modalTitle = document.querySelector("#modal-title");
    elements.modalBody = document.querySelector("#modal-body");
    elements.toast = document.querySelector("#toast");

    bindEvents();

    try {
      await db.init();
      await db.seedIfNeeded();
      await refreshData();
      await registerServiceWorker();
    } catch (error) {
      showToast(error.message || "Doorables Vault could not start.");
      elements.view.innerHTML = renderEmpty("Could not open the vault", "IndexedDB may be blocked in this browser.");
    }
  }

  function bindEvents() {
    elements.search.addEventListener("input", (event) => {
      state.search = event.target.value.trim();
      render();
    });

    elements.nav.addEventListener("click", (event) => {
      const button = event.target.closest("[data-tab]");
      if (!button) {
        return;
      }

      state.tab = button.dataset.tab;
      state.currentCategory = "";
      state.currentSeries = "";
      closeFabMenu();
      render();
      elements.view.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

    elements.fabButton.addEventListener("click", () => {
      const isOpen = elements.fabMenu.hidden;
      elements.fabMenu.hidden = !isOpen;
      elements.fabButton.setAttribute("aria-expanded", String(isOpen));
    });

    elements.fabMenu.addEventListener("click", async (event) => {
      const action = event.target.closest("[data-fab-action]")?.dataset.fabAction;
      if (!action) {
        return;
      }

      closeFabMenu();

      if (action === "bulk") {
        openBulkModal();
      } else if (action === "single") {
        openAddSingleModal();
      } else if (action === "importMaster") {
        await pickAndImport("master");
      } else if (action === "imagePack") {
        showToast("ZIP image pack import is reserved for a future workflow. Individual images can be uploaded from a Doorable detail view.");
      }
    });

    document.addEventListener("click", handleDocumentClick);
    document.addEventListener("change", handleDocumentChange);
    document.addEventListener("input", handleDocumentInput);
    document.addEventListener("submit", handleDocumentSubmit);
    window.addEventListener("online", updateOnlineStatus);
    window.addEventListener("offline", updateOnlineStatus);
    window.addEventListener("beforeunload", revokeAllImageUrls);
  }

  async function refreshData() {
    const [master, collection, activity, counts, lastBackupDate, images] = await Promise.all([
      db.getAllMaster(),
      db.getAllCollection(),
      db.getRecentActivity(12),
      db.getStorageStats(),
      db.getLastBackupDate(),
      db.getAllImages()
    ]);

    state.master = master.sort(compareSeriesFranchiseCharacter);
    state.collection = collection;
    state.collectionMap = new Map(collection.map((record) => [record.id, record]));
    state.activity = activity;
    state.storage.counts = counts;
    state.storage.lastBackupDate = lastBackupDate || "";
    state.isOnline = navigator.onLine;
    syncImageCache(master, images);

    if (navigator.storage && navigator.storage.estimate) {
      state.storage.estimate = await navigator.storage.estimate();
    }

    render();
  }

  function updateOnlineStatus() {
    state.isOnline = navigator.onLine;
    if (state.tab === "settings") {
      render();
    }
  }

  // Image blobs are stored in IndexedDB and rendered through short-lived object
  // URLs. The cache avoids async lookups during list rendering and revokes stale
  // URLs whenever image records are replaced or removed.
  function syncImageCache(masterRecords, imageRecords) {
    const activeImageIds = new Set(masterRecords.map((record) => record.imageId).filter(Boolean));
    const storedImages = new Map(
      imageRecords
        .filter((image) => image && image.imageId && image.blob && activeImageIds.has(image.imageId))
        .map((image) => [image.imageId, image])
    );

    imageUrlCache.forEach((cached, imageId) => {
      if (!storedImages.has(imageId)) {
        URL.revokeObjectURL(cached.url);
        imageUrlCache.delete(imageId);
      }
    });

    storedImages.forEach((image, imageId) => {
      const existing = imageUrlCache.get(imageId);
      const size = image.size || image.blob.size || 0;
      if (existing && existing.lastModified === image.lastModified && existing.size === size) {
        return;
      }

      if (existing) {
        URL.revokeObjectURL(existing.url);
      }

      imageUrlCache.set(imageId, {
        url: URL.createObjectURL(image.blob),
        lastModified: image.lastModified || "",
        size
      });
    });
  }

  function revokeAllImageUrls() {
    imageUrlCache.forEach((cached) => URL.revokeObjectURL(cached.url));
    imageUrlCache.clear();
  }

  function getImageUrl(record) {
    if (!record.imageId) {
      return "";
    }

    return imageUrlCache.get(record.imageId)?.url || "";
  }

  async function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) {
      return;
    }

    const isLocal = ["localhost", "127.0.0.1", ""].includes(window.location.hostname);
    if (window.location.protocol !== "https:" && !isLocal) {
      return;
    }

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshingForUpdate) {
        return;
      }

      refreshingForUpdate = true;
      window.location.reload();
    });

    try {
      const registration = await navigator.serviceWorker.register("service-worker.js");
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (!worker) {
          return;
        }

        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            promptForServiceWorkerUpdate(worker);
          }
        });
      });

      if (registration.waiting && navigator.serviceWorker.controller) {
        promptForServiceWorkerUpdate(registration.waiting);
      }

      registration.update().catch(() => {});
    } catch (error) {
      console.warn("Service worker registration failed", error);
    }
  }

  function promptForServiceWorkerUpdate(worker) {
    if (updatePromptShown) {
      return;
    }

    updatePromptShown = true;
    const shouldRefresh = window.confirm("A new version of Doorables Vault is available. Refresh now?");
    if (shouldRefresh) {
      worker.postMessage({ type: "SKIP_WAITING" });
    }
  }

  // Screen rendering.
  function render() {
    document.querySelectorAll("[data-tab]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.tab === state.tab);
    });

    if (state.tab === "dashboard") {
      elements.view.innerHTML = renderDashboard();
    } else if (state.tab === "collection") {
      elements.view.innerHTML = state.currentSeries ? renderSeriesDetail() : renderCollection();
    } else if (state.tab === "inventory") {
      elements.view.innerHTML = renderInventory();
    } else if (state.tab === "database") {
      elements.view.innerHTML = renderDatabase();
    } else if (state.tab === "analytics") {
      elements.view.innerHTML = renderAnalytics();
    } else if (state.tab === "settings") {
      elements.view.innerHTML = renderSettings();
    }
  }

  function renderDashboard() {
    const records = getMergedRecords();
    const stats = getStats(records);

    return `
      <section class="section-band">
        <div class="screen-head">
          <div>
            <h2 class="screen-title">Dashboard</h2>
            <p class="screen-subtitle">Snapshot of your local vault.</p>
          </div>
          <span class="pill is-strong">${stats.progress}% complete</span>
        </div>
        ${renderProgress("Collection progress", stats.collectionCopies, stats.total, stats.progress)}
      </section>

      <section class="section-band">
        <div class="stat-grid">
          ${renderStat("Collection copies", stats.collectionCopies)}
          ${renderStat("Total owned", stats.totalOwned)}
          ${renderStat("Duplicates", stats.duplicates)}
          ${renderStat("Available inventory", stats.available)}
          ${renderStat("Sold/reserved", stats.soldReserved)}
          ${renderStat("Whatnot listed", stats.whatnotListed)}
          ${renderStat("eBay listed", stats.ebayListed)}
          ${renderStat("Unlisted", stats.unlisted)}
        </div>
      </section>

      <section class="section-band">
        <div class="section-title-row">
          <h3>Recently Added</h3>
        </div>
        ${renderRecentlyAddedList()}
      </section>

      <section class="section-band">
        <div class="section-title-row">
          <h3>Recent Activity</h3>
        </div>
        ${renderActivityList()}
      </section>
    `;
  }

  function renderCollection() {
    const filtered = filterCollectionRecords(applySearch(getMergedRecords()));
    const grouped = groupBy(filtered, "category");

    return `
      <section class="section-band">
        <div class="screen-head">
          <div>
            <h2 class="screen-title">Collection</h2>
            <p class="screen-subtitle">Completion is based on collection copy, not quantity.</p>
          </div>
        </div>
        ${renderFilterRow(["All", "Owned", "Missing", "Duplicates", "For Sale"], state.collectionFilter, "collection-filter")}
      </section>

      ${filtered.length ? sortCategories(Object.keys(grouped)).map((category) => renderCategoryGroup(category, grouped[category])).join("") : renderEmpty("No Doorables found", "Try a different search or filter.")}
    `;
  }

  function renderCategoryGroup(category, records) {
    const seriesGroups = groupBy(records, "series");

    return `
      <section class="section-band">
        <h2 class="category-heading">${escapeHtml(category)}</h2>
        <div class="category-block">
          ${sortSeriesNames(Object.keys(seriesGroups), category).map((series) => {
            const seriesRecords = getMergedRecords().filter((record) => record.category === category && record.series === series);
            const visibleRecords = sortRecordsWithinSeries(seriesGroups[series]);
            const stats = getSeriesStats(seriesRecords);

            return `
              <div class="series-block">
                <button class="series-row" type="button" data-open-category="${escapeAttr(category)}" data-open-series="${escapeAttr(series)}">
                  <span class="series-row-top">
                    <span>
                      <h3>${escapeHtml(series)}</h3>
                      <span class="small muted">${stats.collected} collected, ${stats.missing} missing</span>
                    </span>
                    <span class="pill">${stats.percent}%</span>
                  </span>
                  ${renderProgressBar(stats.percent)}
                </button>
                <div class="card-grid">
                  ${visibleRecords.map((record) => renderDoorableCard(record, { controls: true })).join("")}
                </div>
              </div>
            `;
          }).join("")}
        </div>
      </section>
    `;
  }

  function renderSeriesDetail() {
    const seriesRecords = applySearch(getMergedRecords().filter((record) => {
      return record.series === state.currentSeries && (!state.currentCategory || record.category === state.currentCategory);
    })).sort(compareFranchiseCharacter);
    const stats = getSeriesStats(seriesRecords);
    const missing = seriesRecords.filter((record) => !record.collectionCopy);
    const collected = seriesRecords.filter((record) => record.collectionCopy);
    const inventory = seriesRecords.filter((record) => record.owned > 0 || record.available > 0 || record.soldReserved > 0);

    return `
      <section class="section-band">
        <button class="secondary-button" type="button" data-action="back-to-collection">Back to Collection</button>
        <div class="screen-head">
          <div>
            <h2 class="screen-title">${escapeHtml(state.currentSeries)}</h2>
            <p class="screen-subtitle">${stats.collected} collected, ${stats.missing} missing.</p>
          </div>
          <span class="pill is-strong">${stats.percent}%</span>
        </div>
        ${renderProgress("Series completion", stats.collected, stats.total, stats.percent)}
      </section>

      ${renderSeriesSection("Missing", missing)}
      ${renderSeriesSection("Collected", collected)}
      ${renderSeriesSection("Inventory", inventory)}
    `;
  }

  function renderSeriesSection(title, records) {
    const sortedRecords = sortRecordsWithinSeries(records);
    return `
      <section class="section-band">
        <div class="section-title-row">
          <h3>${title}</h3>
          <span class="muted small">${sortedRecords.length} item${sortedRecords.length === 1 ? "" : "s"}</span>
        </div>
        ${sortedRecords.length ? `<div class="card-grid">${sortedRecords.map((record) => renderDoorableCard(record, { controls: true })).join("")}</div>` : renderEmpty("Nothing here", "This section is clear.")}
      </section>
    `;
  }

  function renderInventory() {
    const filtered = filterInventoryRecords(applySearch(getMergedRecords()))
      .sort(compareSeriesFranchiseCharacter);

    return `
      <section class="section-band">
        <div class="screen-head">
          <div>
            <h2 class="screen-title">Inventory</h2>
            <p class="screen-subtitle">Track extras, reserved copies, and listings.</p>
          </div>
        </div>
        ${renderFilterRow(["All", "Available", "Sold/Reserved", "Whatnot Listed", "eBay Listed", "Unlisted"], state.inventoryFilter, "inventory-filter")}
      </section>

      <section class="section-band">
        ${filtered.length ? `<div class="card-grid">${filtered.map((record) => renderDoorableCard(record, { controls: true, inventory: true })).join("")}</div>` : renderEmpty("No inventory matches", "Adjust the filter or add quantities with the quick action button.")}
      </section>
    `;
  }

  function renderDatabase() {
    const records = sortDatabaseRecords(filterDatabaseRecords(applySearch(getMergedRecords())));

    return `
      <section class="section-band">
        <div class="screen-head">
          <div>
            <h2 class="screen-title">Database</h2>
            <p class="screen-subtitle">Browse and edit the local master database.</p>
          </div>
        </div>
        ${renderDatabaseToolbar()}
      </section>

      <section class="section-band">
        <div class="section-title-row">
          <h3>Master Records</h3>
          <span class="muted small">${records.length} shown</span>
        </div>
        ${records.length ? `<div class="card-grid">${records.map((record) => renderDoorableCard(record, { controls: true, database: true })).join("")}</div>` : renderEmpty("No database records found", "Import a master database JSON or add a single Doorable.")}
      </section>
    `;
  }

  function renderAnalytics() {
    const records = getMergedRecords();
    const stats = getStats(records);
    const categoryGroups = groupBy(records, "category");
    const seriesGroups = groupBy(records, "series");
    const rarityGroups = groupBy(records, "rarity");
    const duplicates = records.filter((record) => record.owned > 1).sort((a, b) => b.owned - a.owned);

    return `
      <section class="section-band">
        <div class="screen-head">
          <div>
            <h2 class="screen-title">Analytics</h2>
            <p class="screen-subtitle">Completion and inventory patterns.</p>
          </div>
        </div>
        ${renderProgress("Collection completion", stats.collectionCopies, stats.total, stats.progress)}
      </section>

      <section class="section-band">
        <div class="section-title-row"><h3>Category Completion</h3></div>
        <div class="list-stack">${renderCompletionRows(categoryGroups, "category")}</div>
      </section>

      <section class="section-band">
        <div class="section-title-row"><h3>Series Completion</h3></div>
        <div class="list-stack">${renderCompletionRows(seriesGroups, "series")}</div>
      </section>

      <section class="section-band">
        <div class="section-title-row"><h3>Rarity Breakdown</h3></div>
        <div class="stat-grid">
          ${sortByReference(Object.keys(rarityGroups), db.rarities).map((rarity) => renderStat(rarity, rarityGroups[rarity].length)).join("")}
        </div>
      </section>

      <section class="section-band">
        <div class="section-title-row"><h3>Inventory Breakdown</h3></div>
        <div class="stat-grid">
          ${renderStat("Available", stats.available)}
          ${renderStat("Sold/reserved", stats.soldReserved)}
          ${renderStat("Whatnot listed", stats.whatnotListed)}
          ${renderStat("eBay listed", stats.ebayListed)}
        </div>
      </section>

      <section class="section-band">
        <div class="section-title-row"><h3>Duplicate Analysis</h3></div>
        ${duplicates.length ? `<div class="card-grid">${duplicates.map((record) => renderDoorableCard(record, { controls: true })).join("")}</div>` : renderEmpty("No duplicates yet", "Duplicates are records with owned quantity above 1.")}
      </section>
    `;
  }

  function renderSettings() {
    const usage = formatBytes(state.storage.estimate.usage || 0);
    const quota = formatBytes(state.storage.estimate.quota || 0);
    const counts = state.storage.counts;

    return `
      <section class="section-band">
        <div class="screen-head">
          <div>
            <h2 class="screen-title">Settings</h2>
            <p class="screen-subtitle">Import, export, and manage local data. Version ${escapeHtml(APP_VERSION)}.</p>
          </div>
        </div>
      </section>

      <section class="section-band">
        <div class="section-title-row"><h3>Backup & Restore</h3></div>
        <div class="form-actions">
          <button class="secondary-button" type="button" data-settings-action="export-collection">Export Collection JSON</button>
          <button class="primary-button" type="button" data-settings-action="import-collection">Import Collection JSON</button>
          <button class="secondary-button" type="button" data-settings-action="export-master">Export Master Database JSON</button>
          <button class="primary-button" type="button" data-settings-action="import-master">Import Master Database JSON</button>
          <button class="primary-button" type="button" data-settings-action="import-master-csv">Import Master Database CSV</button>
          <button class="secondary-button" type="button" data-settings-action="export-full-backup">Export Full Vault Backup</button>
          <button class="primary-button" type="button" data-settings-action="import-full-backup">Import Full Vault Backup</button>
        </div>
      </section>

      <section class="section-band">
        <div class="section-title-row"><h3>Images</h3></div>
        <div class="form-actions">
          <button class="primary-button" type="button" data-settings-action="build-image-pack">Build Image Pack</button>
          <button class="primary-button" type="button" data-settings-action="import-image-pack">Import Image Pack ZIP</button>
          <button class="secondary-button" type="button" data-settings-action="export-image-pack">Export Image Pack ZIP</button>
          <button class="secondary-button" type="button" data-settings-action="cleanup-orphan-images">Remove Orphan Images</button>
        </div>
      </section>

      <section class="section-band">
        <div class="section-title-row"><h3>Maintenance</h3></div>
        <p class="muted small">Export a Full Vault Backup before deleting local data or cleaning up orphan records.</p>
        <div class="form-actions">
          <button class="secondary-button" type="button" data-settings-action="cleanup-orphan-collection">Remove Orphan Collection Records</button>
          <button class="danger-button" type="button" data-settings-action="clear-data">Delete All Local Vault Data</button>
        </div>
      </section>

      <section class="section-band">
        <div class="section-title-row"><h3>Storage Statistics</h3></div>
        <div class="stat-grid">
          ${renderStat("Master records", counts.master || 0)}
          ${renderStat("Collection records", counts.collection || 0)}
          ${renderStat("Activity records", counts.activity || 0)}
          ${renderStat("Image blobs", counts.images || 0)}
          ${renderStat("Settings records", counts.meta || 0)}
          ${renderStat("Used", usage)}
          ${renderStat("Quota", quota)}
        </div>
      </section>

      <section class="section-band">
        <div class="section-title-row"><h3>About / Version</h3></div>
        <div class="stat-grid">
          ${renderStat("App Name", "Doorables Vault")}
          ${renderStat("Version", APP_VERSION)}
          ${renderStat("Storage Type", "IndexedDB")}
          ${renderStat("Offline Status", state.isOnline ? "Online" : "Offline")}
          ${renderStat("Last Backup Date", state.storage.lastBackupDate ? formatDateTime(state.storage.lastBackupDate) : "No backup recorded")}
        </div>
      </section>
    `;
  }

  function renderDatabaseToolbar() {
    const records = getMergedRecords();
    const categories = mergeReferenceOptions(db.categories, uniqueValues(records, "category"));
    const seriesSource = state.dbFilters.category
      ? records.filter((record) => record.category === state.dbFilters.category)
      : records;
    const series = getSeriesOptions(seriesSource, state.dbFilters.category, true);
    const franchises = uniqueValues(records, "franchise");

    return `
      <div class="toolbar-grid">
        ${renderSelectField("Category", "category", categories, state.dbFilters.category)}
        ${renderSelectField("Series", "series", series, state.dbFilters.series)}
        ${renderSelectField("Franchise", "franchise", franchises, state.dbFilters.franchise)}
        ${renderSelectField("Rarity", "rarity", db.rarities, state.dbFilters.rarity)}
        <label class="field full-row">
          <span>Sort</span>
          <select class="filter-select" data-db-filter="sort">
            ${[
              ["seriesFranchiseCharacter", "Series → Franchise → Character"],
              ["character", "Character A-Z"],
              ["series", "Series"],
              ["category", "Category"],
              ["rarity", "Rarity A-Z"],
              ["owned", "Owned quantity"]
            ].map(([value, label]) => `<option value="${value}" ${state.dbFilters.sort === value ? "selected" : ""}>${label}</option>`).join("")}
          </select>
        </label>
      </div>
    `;
  }

  function renderSelectField(label, key, options, selected) {
    return `
      <label class="field">
        <span>${label}</span>
        <select class="filter-select" data-db-filter="${key}">
          <option value="">All</option>
          ${options.map((option) => `<option value="${escapeAttr(option)}" ${selected === option ? "selected" : ""}>${escapeHtml(option)}</option>`).join("")}
        </select>
      </label>
    `;
  }

  function renderSeriesDatalist() {
    const series = mergeReferenceOptions(getAllReferenceSeries(), uniqueValues(getMergedRecords(), "series"));

    return `
      <datalist id="series-reference-options">
        ${series.map((name) => `<option value="${escapeAttr(name)}"></option>`).join("")}
      </datalist>
    `;
  }

  function renderDoorableCard(record, options = {}) {
    const statusChips = [
      record.collectionCopy ? '<span class="chip is-gold">Collection copy</span>' : '<span class="chip">Missing</span>',
      record.owned > 1 ? '<span class="chip is-blue">Duplicate</span>' : "",
      record.available > 0 ? '<span class="chip is-green">For sale</span>' : "",
      record.soldReserved > 0 ? '<span class="chip is-red">Reserved</span>' : ""
    ].filter(Boolean).join("");

    return `
      <article class="doorable-card" data-open-detail="${escapeAttr(record.id)}" tabindex="0">
        ${renderArt(record)}
        <div class="item-main">
          <div class="item-title-row">
            <div class="item-copy">
              <h3 class="item-title">${escapeHtml(record.character)}</h3>
              <p class="item-meta">${escapeHtml(record.series)} | ${escapeHtml(record.franchise)}</p>
            </div>
            ${options.controls ? renderQtyControl(record) : ""}
          </div>
          <div class="chip-row">
            <span class="chip">${escapeHtml(record.rarity)}</span>
            ${options.inventory ? `<span class="chip">Available ${record.available}</span>` : ""}
            ${options.database ? `<span class="chip">${escapeHtml(record.category)}</span>` : ""}
            ${statusChips}
          </div>
        </div>
      </article>
    `;
  }

  function renderQtyControl(record) {
    return `
      <span class="qty-control" aria-label="Owned quantity for ${escapeAttr(record.character)}">
        <button type="button" data-qty-dec="${escapeAttr(record.id)}" aria-label="Decrease owned quantity">-</button>
        <span>${record.owned}</span>
        <button type="button" data-qty-inc="${escapeAttr(record.id)}" aria-label="Increase owned quantity">+</button>
      </span>
    `;
  }

  function renderArt(record) {
    const imageUrl = getImageUrl(record);
    if (imageUrl) {
      return `
        <div class="item-art has-image" title="${escapeAttr(record.character)}">
          <img src="${escapeAttr(imageUrl)}" alt="${escapeAttr(record.character)}" loading="lazy">
        </div>
      `;
    }

    return `<div class="item-art" title="Image placeholder for ${escapeAttr(record.imageId || record.character)}">${escapeHtml(initials(record.character))}</div>`;
  }

  function renderFilterRow(filters, active, type) {
    return `
      <div class="filter-row" role="list">
        ${filters.map((filter) => `
          <button class="filter-button ${active === filter ? "is-active" : ""}" type="button" data-${type}="${escapeAttr(filter)}">
            ${escapeHtml(filter)}
          </button>
        `).join("")}
      </div>
    `;
  }

  function renderProgress(label, current, total, percent) {
    return `
      <div class="progress-wrap">
        <div class="progress-top">
          <strong>${escapeHtml(label)}</strong>
          <span class="muted small">${current} of ${total}</span>
        </div>
        ${renderProgressBar(percent)}
      </div>
    `;
  }

  function renderProgressBar(percent) {
    return `
      <div class="progress-bar" aria-hidden="true">
        <div class="progress-fill" style="width: ${clamp(percent, 0, 100)}%"></div>
      </div>
    `;
  }

  function renderCompletionRows(groups, type) {
    const names = type === "category"
      ? sortCategories(Object.keys(groups))
      : sortSeriesNames(Object.keys(groups));
    const rows = names.map((name) => {
      const stats = getSeriesStats(groups[name]);
      return `
        <div class="plain-row">
          <div class="progress-top">
            <strong>${escapeHtml(name)}</strong>
            <span class="muted small">${stats.percent}%</span>
          </div>
          ${renderProgressBar(stats.percent)}
          <p class="muted small">${stats.collected} collected, ${stats.missing} missing</p>
        </div>
      `;
    }).join("");

    return rows || renderEmpty("No analytics yet", "Add master records to see completion breakdowns.");
  }

  function renderStat(label, value) {
    return `
      <div class="stat-card">
        <p class="stat-label">${escapeHtml(label)}</p>
        <strong class="stat-value">${escapeHtml(String(value))}</strong>
      </div>
    `;
  }

  function renderActivityList() {
    if (!state.activity.length) {
      return renderEmpty("No activity yet", "Changes will appear here as you edit the vault.");
    }

    return `
      <div class="activity-list">
        ${state.activity.map((item) => `
          <div class="activity-item">
            <p>${escapeHtml(item.action)}</p>
            <p class="muted small">${formatDateTime(item.timestamp)}</p>
          </div>
        `).join("")}
      </div>
    `;
  }

  function renderRecentlyAddedList() {
    const recent = getMergedRecords()
      .filter((record) => record.dateAdded)
      .sort((a, b) => String(b.dateAdded).localeCompare(String(a.dateAdded)))
      .slice(0, 8);

    if (!recent.length) {
      return renderEmpty("No recently added items", "Items appear here after a dateAdded value is saved.");
    }

    return `
      <div class="list-stack">
        ${recent.map((record) => `
          <div class="plain-row recent-row">
            ${renderArt(record)}
            <div>
              <p><strong>${escapeHtml(record.character)}</strong></p>
              <p class="muted small">${escapeHtml(record.series)} | Added ${escapeHtml(formatDateOnly(record.dateAdded))} | Owned ${record.owned}</p>
            </div>
          </div>
        `).join("")}
      </div>
    `;
  }

  function renderEmpty(title, message) {
    return `
      <div class="empty-state">
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(message)}</p>
      </div>
    `;
  }

  // Event handlers and user actions.
  function handleDocumentClick(event) {
    const closeButton = event.target.closest("[data-close-modal]");
    if (closeButton) {
      if (resolvePendingModalChoice("")) {
        return;
      }
      closeModal();
      return;
    }

    const collectionFilter = event.target.closest("[data-collection-filter]");
    if (collectionFilter) {
      state.collectionFilter = collectionFilter.dataset.collectionFilter;
      render();
      return;
    }

    const inventoryFilter = event.target.closest("[data-inventory-filter]");
    if (inventoryFilter) {
      state.inventoryFilter = inventoryFilter.dataset.inventoryFilter;
      render();
      return;
    }

    const openSeries = event.target.closest("[data-open-series]");
    if (openSeries) {
      state.currentCategory = openSeries.dataset.openCategory || "";
      state.currentSeries = openSeries.dataset.openSeries;
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    const backToCollection = event.target.closest("[data-action='back-to-collection']");
    if (backToCollection) {
      state.currentCategory = "";
      state.currentSeries = "";
      render();
      return;
    }

    const qtyInc = event.target.closest("[data-qty-inc]");
    if (qtyInc) {
      adjustOwned(qtyInc.dataset.qtyInc, 1);
      return;
    }

    const qtyDec = event.target.closest("[data-qty-dec]");
    if (qtyDec) {
      adjustOwned(qtyDec.dataset.qtyDec, -1);
      return;
    }

    const bulkInc = event.target.closest("[data-bulk-inc]");
    if (bulkInc) {
      adjustOwned(bulkInc.dataset.bulkInc, 1, { rerender: false, afterSave: renderBulkModal });
      return;
    }

    const bulkDec = event.target.closest("[data-bulk-dec]");
    if (bulkDec) {
      adjustOwned(bulkDec.dataset.bulkDec, -1, { rerender: false, afterSave: renderBulkModal });
      return;
    }

    const imageUpload = event.target.closest("[data-image-upload]");
    if (imageUpload) {
      uploadDoorableImage(imageUpload.dataset.imageUpload);
      return;
    }

    const imageReplace = event.target.closest("[data-image-replace]");
    if (imageReplace) {
      uploadDoorableImage(imageReplace.dataset.imageReplace);
      return;
    }

    const imageRemove = event.target.closest("[data-image-remove]");
    if (imageRemove) {
      removeDoorableImage(imageRemove.dataset.imageRemove);
      return;
    }

    const builderUploadImages = event.target.closest("[data-builder-upload-images]");
    if (builderUploadImages) {
      uploadImagePackBuilderImages();
      return;
    }

    const builderUploadCsv = event.target.closest("[data-builder-upload-csv]");
    if (builderUploadCsv) {
      uploadImagePackBuilderCsv();
      return;
    }

    const builderClearAssignment = event.target.closest("[data-builder-clear-assignment]");
    if (builderClearAssignment) {
      clearImagePackBuilderAssignment(builderClearAssignment.dataset.builderClearAssignment);
      return;
    }

    const builderExportZip = event.target.closest("[data-builder-export-zip]");
    if (builderExportZip) {
      exportBuiltImagePackZip();
      return;
    }

    const settingsAction = event.target.closest("[data-settings-action]");
    if (settingsAction) {
      handleSettingsAction(settingsAction.dataset.settingsAction);
      return;
    }

    const openDetail = event.target.closest("[data-open-detail]");
    if (openDetail && !event.target.closest("button, input, select, textarea, label")) {
      openDetailModal(openDetail.dataset.openDetail);
    }
  }

  function handleDocumentChange(event) {
    const dbFilter = event.target.closest("[data-db-filter]");
    if (dbFilter) {
      state.dbFilters[dbFilter.dataset.dbFilter] = dbFilter.value;
      if (dbFilter.dataset.dbFilter === "category") {
        const validSeries = getSeriesOptions(
          getMergedRecords().filter((record) => !dbFilter.value || record.category === dbFilter.value),
          dbFilter.value,
          true
        );
        if (state.dbFilters.series && !validSeries.includes(state.dbFilters.series)) {
          state.dbFilters.series = "";
        }
      }
      render();
      return;
    }

    const bulkSeries = event.target.closest("[data-bulk-series]");
    if (bulkSeries) {
      state.bulkSeries = bulkSeries.value;
      renderBulkModal();
      return;
    }

    const builderCategory = event.target.closest("[data-builder-category]");
    if (builderCategory) {
      imagePackBuilder.category = builderCategory.value;
      imagePackBuilder.series = "";
      renderImagePackBuilder();
      return;
    }

    const builderSeries = event.target.closest("[data-builder-series]");
    if (builderSeries) {
      imagePackBuilder.series = builderSeries.value;
      renderImagePackBuilder();
      return;
    }

    const builderAllSeries = event.target.closest("[data-builder-all-series]");
    if (builderAllSeries) {
      imagePackBuilder.allSeries = builderAllSeries.checked;
      renderImagePackBuilder();
      return;
    }

    const builderUnassigned = event.target.closest("[data-builder-unassigned-only]");
    if (builderUnassigned) {
      imagePackBuilder.showUnassignedOnly = builderUnassigned.checked;
      renderImagePackBuilder();
      return;
    }

    const builderAssign = event.target.closest("[data-builder-assign]");
    if (builderAssign) {
      assignImagePackBuilderImage(builderAssign.dataset.builderAssign, builderAssign.value);
      return;
    }

    const detailField = event.target.closest("[data-detail-field]");
    if (detailField) {
      saveDetailField(detailField);
      return;
    }

    const masterField = event.target.closest("[data-master-field]");
    if (masterField) {
      saveMasterField(masterField);
    }
  }

  function handleDocumentInput(event) {
    const builderSearch = event.target.closest("[data-builder-search]");
    if (builderSearch) {
      imagePackBuilder.search = builderSearch.value;
      renderImagePackBuilder();
      return;
    }

    const autoField = event.target.closest("[data-autosave-input]");
    if (!autoField) {
      return;
    }

    const key = `${autoField.dataset.autosaveInput}:${autoField.dataset.detailField || autoField.dataset.masterField}`;
    window.clearTimeout(saveTimers.get(key));
    saveTimers.set(key, window.setTimeout(() => {
      if (autoField.dataset.detailField) {
        saveDetailField(autoField, { rerender: false, quiet: true });
      } else {
        saveMasterField(autoField, { rerender: false, quiet: true });
      }
    }, 450));
  }

  async function handleDocumentSubmit(event) {
    const form = event.target.closest("#add-single-form");
    if (!form) {
      return;
    }

    event.preventDefault();
    const data = new FormData(form);
    const id = String(data.get("id") || "").trim() || makeId([
      data.get("category"),
      data.get("series"),
      data.get("character")
    ].join("-"));

    const master = {
      id,
      category: String(data.get("category") || "Other"),
      series: String(data.get("series") || "Unsorted"),
      character: String(data.get("character") || "Unknown Character"),
      franchise: String(data.get("franchise") || "Unknown Franchise"),
      rarity: String(data.get("rarity") || "Common"),
      imageId: String(data.get("imageId") || "")
    };

    const collection = db.createEmptyCollection(id);
    collection.owned = toNumber(data.get("owned"));
    collection.collectionCopy = Boolean(data.get("collectionCopy"));
    collection.personalCollection = collection.collectionCopy ? 1 : 0;
    collection.available = toNumber(data.get("available"));
    collection.soldReserved = toNumber(data.get("soldReserved"));
    collection.dateAdded = new Date().toISOString().slice(0, 10);
    collection.lastModified = new Date().toISOString();

    const preparedCollection = applyCollectionRules(collection, { ownedChanged: true });
    const warning = getCollectionQuantityWarning(preparedCollection);
    if (warning) {
      showToast(warning);
      return;
    }

    await db.putMaster(master);
    await db.putCollection(preparedCollection);
    await db.logActivity(`Added ${master.character}`);
    closeModal();
    await refreshData();
    showToast("Doorable added.");
  }

  async function handleSettingsAction(action) {
    if (action === "import-master") {
      await pickAndImport("master");
    } else if (action === "import-master-csv") {
      await pickAndImportMasterCsv();
    } else if (action === "export-master") {
      await exportJson("doorables-master-database.json", await db.exportMaster());
    } else if (action === "import-collection") {
      await pickAndImport("collection");
    } else if (action === "export-collection") {
      await exportCollectionJson();
    } else if (action === "cleanup-orphan-collection") {
      await removeOrphanCollectionRecords();
    } else if (action === "build-image-pack") {
      openImagePackBuilder();
    } else if (action === "import-image-pack") {
      await importImagePackZip();
    } else if (action === "export-image-pack") {
      await exportImagePackZip();
    } else if (action === "cleanup-orphan-images") {
      await removeOrphanImages();
    } else if (action === "export-full-backup") {
      await exportFullVaultBackup();
    } else if (action === "import-full-backup") {
      await importFullVaultBackup();
    } else if (action === "clear-data") {
      const confirmation = window.prompt(
        "Delete All Local Vault Data\n\nThis permanently deletes these IndexedDB records on this device:\n\n- master database\n- collection data\n- activity history\n- images\n- settings/meta data\n\nExport a backup first if you need to keep anything.\n\nType DELETE to continue."
      );
      if (confirmation === "DELETE") {
        await db.clearAllData();
        await refreshData();
        showToast("All local vault data deleted.");
      } else if (confirmation !== null) {
        showToast("Delete canceled. Type DELETE exactly to confirm.");
      }
    }
  }

  // Individual image support stores only blobs in the images object store.
  // Master records keep the stable imageId link, so collection and inventory
  // data remain untouched when an image is uploaded, replaced, or removed.
  async function uploadDoorableImage(id) {
    try {
      const record = getMergedRecords().find((item) => item.id === id);
      if (!record) {
        showToast("Doorable not found.");
        return;
      }

      const file = await pickImageFile();
      if (!file) {
        return;
      }

      if (!isSupportedImageFile(file)) {
        showToast("Unsupported image type. Use JPG, PNG, or WEBP.");
        return;
      }

      const imageId = await ensureImageId(record);
      const blob = await prepareImageBlob(file);
      await db.saveImageBlob(imageId, blob);
      await db.logActivity(`Updated image for ${record.character}`);
      await refreshData();
      openDetailModal(id);
      showToast("Image saved locally.");
    } catch (error) {
      showToast(error.message || "Image upload failed.");
    }
  }

  async function removeDoorableImage(id) {
    try {
      const record = getMergedRecords().find((item) => item.id === id);
      if (!record || !record.imageId) {
        showToast("No image is linked to this Doorable.");
        return;
      }

      const hasStoredImage = Boolean(getImageUrl(record));
      if (!hasStoredImage) {
        showToast("No stored image found for this Doorable.");
        return;
      }

      const shouldRemove = window.confirm(
        `Remove the stored image for ${record.character}?\n\nThis only removes the image blob. It does not delete the Doorable record, quantities, notes, or collection data.`
      );
      if (!shouldRemove) {
        return;
      }

      await db.deleteImageBlob(record.imageId);
      await db.logActivity(`Removed image for ${record.character}`);
      await refreshData();
      openDetailModal(id);
      showToast("Image removed. Doorable data was not changed.");
    } catch (error) {
      showToast(error.message || "Image removal failed.");
    }
  }

  async function ensureImageId(record) {
    if (record.imageId) {
      return record.imageId;
    }

    const master = state.master.find((item) => item.id === record.id);
    if (!master) {
      throw new Error("Master record not found for image upload.");
    }

    const imageId = record.id;
    const updatedMaster = {
      ...master,
      imageId
    };

    await db.putMaster(updatedMaster);
    replaceMaster(updatedMaster);
    return imageId;
  }

  function pickImageFile() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = IMAGE_FILE_EXTENSIONS;
      input.addEventListener("change", () => resolve(input.files[0] || null));
      input.click();
    });
  }

  function pickImageFiles() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.accept = IMAGE_FILE_EXTENSIONS;
      input.addEventListener("change", () => resolve(Array.from(input.files || [])));
      input.click();
    });
  }

  function isSupportedImageFile(file) {
    return IMAGE_FILE_TYPES.includes(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name || "");
  }

  async function prepareImageBlob(file) {
    if (file.size <= MAX_IMAGE_BYTES) {
      return file;
    }

    if (typeof createImageBitmap !== "function") {
      return file;
    }

    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap) {
      return file;
    }

    const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      if (typeof bitmap.close === "function") {
        bitmap.close();
      }
      return file;
    }

    context.drawImage(bitmap, 0, 0, width, height);
    if (typeof bitmap.close === "function") {
      bitmap.close();
    }

    const outputType = file.type === "image/png" || file.type === "image/webp" ? file.type : "image/jpeg";
    const quality = outputType === "image/png" ? undefined : IMAGE_JPEG_QUALITY;
    if (typeof canvas.toBlob !== "function") {
      return file;
    }

    return new Promise((resolve) => {
      canvas.toBlob((blob) => {
        resolve(blob || file);
      }, outputType, quality);
    });
  }

  async function exportCollectionJson() {
    const summary = getCollectionExportSummary();
    showCollectionExportSummary(summary);
    await exportJson("doorables-collection.json", summary.records);
  }

  function getCollectionExportSummary() {
    const orphans = getOrphanCollectionRecords();
    const orphanIds = new Set(orphans.map((record) => record.id));
    const records = state.collection.filter((record) => !orphanIds.has(record.id));

    return {
      totalRecords: state.collection.length,
      exportedRecords: records.length,
      skippedOrphanRecords: orphans.length,
      skippedOrphanIds: orphans.map((record) => record.id).sort(compareText),
      records
    };
  }

  function showCollectionExportSummary(summary) {
    const lines = [
      "Collection Export Summary",
      "",
      `Total collection records: ${summary.totalRecords}`,
      `Exported collection records: ${summary.exportedRecords}`,
      `Skipped orphan records: ${summary.skippedOrphanRecords}`
    ];

    if (summary.skippedOrphanIds.length) {
      lines.push(
        "",
        "Skipped orphan IDs:",
        ...formatIdList(summary.skippedOrphanIds),
        "",
        "These records were not exported because they do not exist in the current master database."
      );
    }

    window.alert(lines.join("\n"));
  }

  async function removeOrphanCollectionRecords() {
    const orphans = getOrphanCollectionRecords();
    const orphanIds = orphans.map((record) => record.id).sort(compareText);

    if (!orphanIds.length) {
      window.alert("No orphan collection records were found.");
      return;
    }

    const confirmation = window.prompt(
      "Remove Orphan Collection Records\n\n" +
      "Orphan collection records are ownership and inventory records that no longer match any item in the current master database.\n\n" +
      "This will delete only collection records whose IDs do not exist in the master database.\n\n" +
      "It will not delete master database records.\n" +
      "It will not delete images.\n\n" +
      `Orphan records found: ${orphanIds.length}\n\n` +
      `IDs:\n${formatIdList(orphanIds).join("\n")}\n\n` +
      "Type REMOVE to delete these orphan collection records."
    );

    if (confirmation !== "REMOVE") {
      if (confirmation !== null) {
        showToast("Cleanup canceled. Type REMOVE exactly to confirm.");
      }
      return;
    }

    const removedCount = await db.deleteCollectionRecords(orphanIds);
    await db.logActivity(`Removed ${removedCount} orphan collection record${removedCount === 1 ? "" : "s"}`);
    await refreshData();
    showToast(`Removed ${removedCount} orphan collection record${removedCount === 1 ? "" : "s"}.`);
  }

  async function importImagePackZip() {
    try {
      assertZipSupport();
      const file = await pickZipFile();
      if (!file) {
        return;
      }

      const entries = (await zip.readZip(file)).filter((entry) => !entry.isDirectory);
      const masterImageIds = getMasterImageIdSet();
      const existingImageIds = new Set((await db.getAllImages()).map((image) => image.imageId));
      const summary = {
        totalFiles: entries.length,
        validImageFiles: 0,
        matchedToMaster: 0,
        imported: 0,
        replaced: 0,
        skipped: 0,
        unsupportedFiles: [],
        orphanImageFiles: []
      };
      const candidates = [];

      entries.forEach((entry) => {
        const info = getZipImageInfo(entry.name);
        if (!info) {
          summary.unsupportedFiles.push(entry.name);
          return;
        }

        summary.validImageFiles += 1;
        if (!masterImageIds.has(info.imageId)) {
          summary.orphanImageFiles.push(`${entry.name} (${info.imageId})`);
          return;
        }

        summary.matchedToMaster += 1;
        candidates.push({ entry, ...info, exists: existingImageIds.has(info.imageId) });
      });

      const existingMatches = candidates.filter((item) => item.exists);
      const replaceExisting = existingMatches.length
        ? window.confirm(`${existingMatches.length} matching image${existingMatches.length === 1 ? "" : "s"} already exist. Replace existing images?`)
        : false;

      for (const item of candidates) {
        if (item.exists && !replaceExisting) {
          summary.skipped += 1;
          continue;
        }

        const blob = await item.entry.blob(item.mimeType);
        const prepared = await prepareImageBlob(blob);
        await db.saveImageRecord({
          imageId: item.imageId,
          blob: prepared,
          mimeType: prepared.type || item.mimeType,
          size: prepared.size,
          lastModified: new Date().toISOString()
        });

        if (item.exists) {
          summary.replaced += 1;
        } else {
          summary.imported += 1;
        }
      }

      await db.logActivity(`Imported ${summary.imported + summary.replaced} images from ZIP`);
      await refreshData();
      showImagePackImportSummary(summary);
    } catch (error) {
      showToast(error.message || "Image pack import failed.");
    }
  }

  async function exportImagePackZip() {
    try {
      assertZipSupport();
      const images = await db.getAllImages();
      const imageFiles = await buildImageZipFiles(images, "");
      imageFiles.files.push({
        name: "image_manifest.json",
        data: JSON.stringify(imageFiles.manifest, null, 2)
      });

      const blob = await zip.createZip(imageFiles.files);
      await downloadBlob(blob, `doorables_images_export_${dateStamp()}.zip`);
      await markBackupExported();
      showToast(`Exported ${images.length} image${images.length === 1 ? "" : "s"}.`);
    } catch (error) {
      showToast(error.message || "Image export failed.");
    }
  }

  async function exportFullVaultBackup() {
    try {
      assertZipSupport();
      const backupDate = new Date().toISOString();
      const [master, collection, activity, meta, images] = await Promise.all([
        db.exportMaster(),
        db.exportCollection(),
        db.exportActivity(),
        db.exportMeta(),
        db.getAllImages()
      ]);
      const imageFiles = await buildImageZipFiles(images, "images/");
      const metadata = {
        appName: "Doorables Vault",
        appVersion: APP_VERSION,
        backupDate,
        totalMasterRecords: master.length,
        totalCollectionRecords: collection.length,
        totalActivityRecords: activity.length,
        totalImages: images.length,
        backupFormatVersion: "1.0"
      };
      const files = [
        { name: "master_database.json", data: JSON.stringify(master, null, 2) },
        { name: "collection.json", data: JSON.stringify(collection, null, 2) },
        { name: "activity.json", data: JSON.stringify(activity, null, 2) },
        { name: "settings.json", data: JSON.stringify(meta, null, 2) },
        { name: "reference_data.json", data: JSON.stringify(getReferenceData(), null, 2) },
        { name: "metadata.json", data: JSON.stringify(metadata, null, 2) },
        { name: "images/", data: "" },
        ...imageFiles.files,
        { name: "images/image_manifest.json", data: JSON.stringify(imageFiles.manifest, null, 2) }
      ];

      const blob = await zip.createZip(files);
      await downloadBlob(blob, `doorables_vault_backup_${dateStamp()}.zip`);
      await markBackupExported(backupDate);
      window.alert(
        "Full Vault Backup Exported\n\n" +
        `Master records: ${master.length}\n` +
        `Collection records: ${collection.length}\n` +
        `Activity records: ${activity.length}\n` +
        `Images: ${images.length}`
      );
    } catch (error) {
      showToast(error.message || "Full vault backup failed.");
    }
  }

  async function importFullVaultBackup() {
    try {
      assertZipSupport();
      const file = await pickZipFile();
      if (!file) {
        return;
      }

      const preview = await parseFullVaultBackup(file);
      showRestorePreview(preview);
      if (preview.blockers.length) {
        showToast("Restore canceled. Fix the backup validation errors first.");
        return;
      }

      const confirmation = window.prompt(
        "Import Full Vault Backup\n\nThis will replace the current local master database, collection data, activity history, images, and settings/meta data in IndexedDB.\n\nType RESTORE to continue."
      );
      if (confirmation !== "RESTORE") {
        if (confirmation !== null) {
          showToast("Restore canceled. Type RESTORE exactly to confirm.");
        }
        return;
      }

      const result = await db.restoreFullBackup(preview.payload);
      await db.recordBackupExport(preview.metadata.backupDate || new Date().toISOString());
      await refreshData();
      window.alert(
        "Full Vault Restore Complete\n\n" +
        `Master records: ${result.master}\n` +
        `Collection records: ${result.collection}\n` +
        `Activity records: ${result.activity}\n` +
        `Images: ${result.images}`
      );
    } catch (error) {
      showToast(error.message || "Full vault restore failed.");
    }
  }

  async function removeOrphanImages() {
    const images = await db.getAllImages();
    const masterImageIds = getMasterImageIdSet();
    const orphanIds = images
      .map((image) => image.imageId)
      .filter((imageId) => imageId && !masterImageIds.has(imageId))
      .sort(compareText);

    if (!orphanIds.length) {
      window.alert("No orphan images were found.");
      return;
    }

    const confirmation = window.prompt(
      "Remove Orphan Images\n\n" +
      "An orphan image is stored in IndexedDB but its imageId does not exist in the current master database.\n\n" +
      "This deletes only orphan image blobs. It does not delete master records, collection records, or activity history.\n\n" +
      "Export a Full Vault Backup first if you want a copy before cleanup.\n\n" +
      `Orphan images found: ${orphanIds.length}\n\n` +
      `Image IDs:\n${formatIdList(orphanIds).join("\n")}\n\n` +
      "Type REMOVE to delete these orphan images."
    );

    if (confirmation !== "REMOVE") {
      if (confirmation !== null) {
        showToast("Image cleanup canceled. Type REMOVE exactly to confirm.");
      }
      return;
    }

    const removedCount = await db.deleteImageRecords(orphanIds);
    await db.logActivity(`Removed ${removedCount} orphan image${removedCount === 1 ? "" : "s"}`);
    await refreshData();
    showToast(`Removed ${removedCount} orphan image${removedCount === 1 ? "" : "s"}.`);
  }

  // Image Pack Builder creates a renamed ZIP from uploaded local image files.
  // It never renames original files and does not write images into IndexedDB.
  function createEmptyImagePackBuilder() {
    return {
      category: "",
      series: "",
      allSeries: false,
      images: [],
      search: "",
      showUnassignedOnly: false,
      csvWarnings: []
    };
  }

  function resetImagePackBuilder() {
    cleanupImagePackBuilder();
    Object.assign(imagePackBuilder, createEmptyImagePackBuilder());
  }

  function cleanupImagePackBuilder() {
    if (!imagePackBuilder || !Array.isArray(imagePackBuilder.images)) {
      return;
    }

    imagePackBuilder.images.forEach((item) => {
      if (item.previewUrl) {
        URL.revokeObjectURL(item.previewUrl);
      }
    });
  }

  function openImagePackBuilder() {
    resetImagePackBuilder();
    elements.modalTitle.textContent = "Image Pack Builder";
    elements.modal.hidden = false;
    renderImagePackBuilder();
  }

  function isImagePackBuilderScopeReady() {
    return imagePackBuilder.allSeries || Boolean(imagePackBuilder.category && imagePackBuilder.series);
  }

  function renderImagePackBuilder() {
    const activeElement = document.activeElement;
    const restoreSearchFocus = activeElement?.matches("[data-builder-search]");
    const searchSelectionStart = restoreSearchFocus ? activeElement.selectionStart : null;
    const searchSelectionEnd = restoreSearchFocus ? activeElement.selectionEnd : null;
    const scopeReady = isImagePackBuilderScopeReady();
    const categories = mergeReferenceOptions(db.categories, uniqueValues(state.master, "category"));
    const series = imagePackBuilder.category
      ? getSeriesOptions(
          state.master.filter((record) => record.category === imagePackBuilder.category),
          imagePackBuilder.category,
          true
        )
      : [];
    const candidateRecords = getImagePackBuilderCandidates();
    const validation = getImagePackBuilderValidation();
    const displayedImages = getDisplayedImagePackBuilderImages();

    elements.modalBody.innerHTML = `
      <div class="builder-flow">
        <section class="builder-step">
          <div class="section-title-row">
            <h3>1. Select Series</h3>
          </div>
          <div class="form-grid">
            <label class="checkbox-row full-row">
              <input type="checkbox" data-builder-all-series ${imagePackBuilder.allSeries ? "checked" : ""}>
              <span>Advanced: All Series</span>
            </label>
            <label class="field">
              <span>Category</span>
              <select data-builder-category ${imagePackBuilder.allSeries ? "disabled" : ""}>
                <option value="">Select category</option>
                ${categories.map((category) => `<option value="${escapeAttr(category)}" ${imagePackBuilder.category === category ? "selected" : ""}>${escapeHtml(category)}</option>`).join("")}
              </select>
            </label>
            <label class="field">
              <span>Series</span>
              <select data-builder-series ${imagePackBuilder.allSeries || !imagePackBuilder.category ? "disabled" : ""}>
                <option value="">Select series</option>
                ${series.map((name) => `<option value="${escapeAttr(name)}" ${imagePackBuilder.series === name ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}
              </select>
            </label>
          </div>
          ${imagePackBuilder.allSeries ? '<p class="muted small builder-warning">All Series mode searches the full master database. Use it only when your image batch spans multiple series.</p>' : ""}
          ${scopeReady ? renderImagePackBuilderMatchList(candidateRecords) : '<p class="muted small">Select a category and series before uploading or assigning images.</p>'}
        </section>

        <section class="builder-step">
          <div class="section-title-row">
            <h3>2. Upload Images</h3>
            <span class="muted small">${imagePackBuilder.images.length} file${imagePackBuilder.images.length === 1 ? "" : "s"}</span>
          </div>
          <p class="muted small">Supported formats: JPG, JPEG, PNG, and WEBP. Original files are not renamed or modified.</p>
          <div class="form-actions">
            <button class="primary-button" type="button" data-builder-upload-images ${scopeReady ? "" : "disabled"}>Select Image Files</button>
          </div>
        </section>

        <section class="builder-step">
          <div class="section-title-row">
            <h3>3. Assign Images</h3>
          </div>
          <div class="form-grid">
            <label class="field full-row">
              <span>Search matching Doorables</span>
              <input type="search" data-builder-search value="${escapeAttr(imagePackBuilder.search)}" placeholder="Character, franchise, rarity, or imageId" ${scopeReady ? "" : "disabled"}>
            </label>
            <label class="checkbox-row">
              <input type="checkbox" data-builder-unassigned-only ${imagePackBuilder.showUnassignedOnly ? "checked" : ""}>
              <span>Only show unassigned images</span>
            </label>
            <div class="form-actions">
              <button class="secondary-button" type="button" data-builder-upload-csv ${scopeReady && imagePackBuilder.images.length ? "" : "disabled"}>Upload Mapping CSV</button>
            </div>
          </div>
          ${renderImagePackBuilderWarnings()}
          <div class="builder-image-list">
            ${displayedImages.length
              ? displayedImages.map((item) => renderImagePackBuilderImageRow(item, candidateRecords, validation)).join("")
              : renderEmpty("No images to assign", imagePackBuilder.images.length ? "All visible images are assigned." : "Upload image files to start assigning them.")}
          </div>
        </section>

        <section class="builder-step">
          <div class="section-title-row">
            <h3>4. Review</h3>
          </div>
          ${renderImagePackBuilderSummary(validation)}
        </section>

        <section class="builder-step">
          <div class="section-title-row">
            <h3>5. Export ZIP</h3>
          </div>
          <p class="muted small">The ZIP will contain renamed copies and an image_manifest.json file. Images are not imported into the vault automatically.</p>
          <div class="form-actions">
            <button class="primary-button" type="button" data-builder-export-zip ${validation.canExport ? "" : "disabled"}>Export Image Pack ZIP</button>
          </div>
        </section>
      </div>
    `;

    if (restoreSearchFocus) {
      const searchInput = elements.modalBody.querySelector("[data-builder-search]");
      if (searchInput) {
        searchInput.focus();
        searchInput.setSelectionRange(searchSelectionStart, searchSelectionEnd);
      }
    }
  }

  function renderImagePackBuilderMatchList(records) {
    return `
      <div class="builder-match-panel">
        <p class="muted small">${records.length} matching Doorable record${records.length === 1 ? "" : "s"} available for assignment.</p>
        <div class="builder-match-list">
          ${records.length ? records.map((record) => `
            <div class="builder-match-row">
              <strong>${escapeHtml(record.character)}</strong>
              <span>${escapeHtml(record.franchise)} | ${escapeHtml(record.rarity)}</span>
              <code>${escapeHtml(record.imageId)}</code>
            </div>
          `).join("") : '<p class="muted small">No master records with imageId values match this scope.</p>'}
        </div>
      </div>
    `;
  }

  function renderImagePackBuilderWarnings() {
    if (!imagePackBuilder.csvWarnings.length) {
      return "";
    }

    return `
      <div class="builder-warning-list">
        <p><strong>Mapping warnings</strong></p>
        <ul>
          ${imagePackBuilder.csvWarnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}
        </ul>
      </div>
    `;
  }

  function renderImagePackBuilderImageRow(item, candidateRecords, validation) {
    const record = item.assignmentId ? getImagePackBuilderRecordByImageId(item.assignmentId) : null;
    const isDuplicate = item.assignmentId && validation.duplicateImageIds.includes(item.assignmentId);
    const isInvalid = item.assignmentId && !record;
    const isOutsideSeries = record && !imagePackBuilder.allSeries && !isRecordInImagePackBuilderScope(record);
    const status = getImagePackBuilderItemStatus(item, record, { isDuplicate, isInvalid, isOutsideSeries });
    const options = getImagePackBuilderAssignmentOptions(item, candidateRecords);

    return `
      <article class="builder-image-row">
        <div class="builder-thumb ${item.supported ? "" : "is-unsupported"}">
          ${item.supported ? `<img src="${escapeAttr(item.previewUrl)}" alt="${escapeAttr(item.originalFileName)}">` : "<span>Unsupported</span>"}
        </div>
        <div class="builder-image-body">
          <div class="builder-image-head">
            <div>
              <h4>${escapeHtml(item.originalFileName)}</h4>
              <p class="muted small">${escapeHtml(item.mimeType || "Unknown type")} | ${formatBytes(item.size)}</p>
            </div>
            <span class="chip ${status.className}">${escapeHtml(status.label)}</span>
          </div>
          ${item.supported ? `
            <label class="field">
              <span>Assigned Doorable</span>
              <select data-builder-assign="${escapeAttr(item.uid)}" ${isImagePackBuilderScopeReady() ? "" : "disabled"}>
                <option value="">Unassigned</option>
                ${options.map((option) => `<option value="${escapeAttr(option.imageId)}" ${item.assignmentId === option.imageId ? "selected" : ""}>${escapeHtml(formatImagePackBuilderOption(option))}</option>`).join("")}
              </select>
            </label>
            ${record ? `
              <p class="muted small">
                Assigned: ${escapeHtml(record.character)} | ${escapeHtml(record.series)} | ${escapeHtml(record.franchise)}<br>
                imageId: <code>${escapeHtml(record.imageId)}</code><br>
                Exported ZIP filename: <code>${escapeHtml(getBuiltImageExportName(item, record.imageId))}</code>
              </p>
            ` : '<p class="muted small">No Doorable assigned yet.</p>'}
            <div class="form-actions">
              <button class="secondary-button" type="button" data-builder-clear-assignment="${escapeAttr(item.uid)}" ${item.assignmentId ? "" : "disabled"}>Clear Assignment</button>
            </div>
          ` : '<p class="muted small">This file will be skipped because it is not JPG, JPEG, PNG, or WEBP.</p>'}
        </div>
      </article>
    `;
  }

  function renderImagePackBuilderSummary(validation) {
    const blockers = [];
    if (validation.duplicateImageIds.length) {
      blockers.push(`Duplicate imageId assignments: ${validation.duplicateImageIds.join(", ")}`);
    }
    if (validation.invalidImageIds.length) {
      blockers.push(`Invalid imageIds: ${validation.invalidImageIds.join(", ")}`);
    }
    if (validation.outsideSelectedSeries.length) {
      blockers.push(`ImageIds outside selected series: ${validation.outsideSelectedSeries.join(", ")}`);
    }
    if (!validation.validImages.length) {
      blockers.push("No valid assigned images are ready for export.");
    }

    return `
      <div class="stat-grid">
        ${renderStat("Total uploaded images", validation.totalUploaded)}
        ${renderStat("Supported images", validation.supportedImages)}
        ${renderStat("Unsupported files", validation.unsupportedFiles.length)}
        ${renderStat("Assigned images", validation.assignedImages)}
        ${renderStat("Unassigned images", validation.unassignedImages)}
        ${renderStat("Duplicate imageIds", validation.duplicateImageIds.length)}
        ${renderStat("Invalid imageIds", validation.invalidImageIds.length)}
        ${renderStat("Outside selected series", validation.outsideSelectedSeries.length)}
        ${renderStat("Ready for export", validation.validImages.length)}
      </div>
      ${blockers.length ? `
        <div class="builder-warning-list">
          <p><strong>Export blockers</strong></p>
          <ul>${blockers.map((blocker) => `<li>${escapeHtml(blocker)}</li>`).join("")}</ul>
        </div>
      ` : '<p class="muted small">Ready to export. Unassigned and unsupported files will be skipped.</p>'}
      ${validation.unsupportedFiles.length ? `<p class="muted small id-list">Unsupported files: ${escapeHtml(validation.unsupportedFiles.join(", "))}</p>` : ""}
    `;
  }

  async function uploadImagePackBuilderImages() {
    if (!isImagePackBuilderScopeReady()) {
      showToast("Select a category and series, or enable All Series, before uploading images.");
      return;
    }

    const files = await pickImageFiles();
    if (!files.length) {
      return;
    }

    const items = files.map((file, index) => {
      const supported = isSupportedImageFile(file);
      return {
        uid: `builder-${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`,
        file,
        originalFileName: file.name,
        mimeType: getImageFileMimeType(file),
        size: file.size,
        supported,
        previewUrl: supported ? URL.createObjectURL(file) : "",
        assignmentId: ""
      };
    });

    imagePackBuilder.images.push(...items);
    imagePackBuilder.csvWarnings = items.some((item) => !item.supported)
      ? ["Unsupported files were skipped. Use JPG, JPEG, PNG, or WEBP."]
      : [];
    renderImagePackBuilder();
  }

  async function uploadImagePackBuilderCsv() {
    if (!isImagePackBuilderScopeReady()) {
      showToast("Select a category and series, or enable All Series, before uploading a mapping CSV.");
      return;
    }

    const file = await pickCsvFile();
    if (!file) {
      return;
    }

    const summary = applyImagePackBuilderCsv(await file.text());
    renderImagePackBuilder();
    window.alert(
      "Mapping CSV Summary\n\n" +
      `Rows processed: ${summary.rowsProcessed}\n` +
      `Assignments applied: ${summary.assignmentsApplied}\n` +
      `Warnings: ${imagePackBuilder.csvWarnings.length}`
    );
  }

  function applyImagePackBuilderCsv(text) {
    const expectedHeader = ["originalFileName", "imageId"];
    const parsed = parseCsvRows(text);
    const warnings = [...parsed.invalidRows.map((row) => `Row ${row.row}: ${row.errors.join(" ")}`)];
    const summary = {
      rowsProcessed: 0,
      assignmentsApplied: 0
    };

    if (!parsed.rows.length) {
      imagePackBuilder.csvWarnings = [`CSV file must include a header row: ${expectedHeader.join(",")}.`];
      return summary;
    }

    const header = parsed.rows[0].map((value, index) => index === 0 ? value.replace(/^\uFEFF/, "").trim() : value.trim());
    const headerMatches = header.length === expectedHeader.length &&
      expectedHeader.every((key, index) => header[index] === key);

    if (!headerMatches) {
      imagePackBuilder.csvWarnings = [`Header must be exactly: ${expectedHeader.join(",")}.`];
      return summary;
    }

    const uploadedByName = new Map();
    const duplicateFileNames = new Set();
    imagePackBuilder.images.forEach((item) => {
      if (uploadedByName.has(item.originalFileName)) {
        duplicateFileNames.add(item.originalFileName);
      } else {
        uploadedByName.set(item.originalFileName, item);
      }
    });
    duplicateFileNames.forEach((name) => warnings.push(`Multiple uploaded files are named "${name}". Mapping by filename may be ambiguous.`));

    const mappedFileNames = new Set();
    const mappedImageIds = [];
    const assignments = [];
    const outsideSeriesAssignments = [];

    parsed.rows.slice(1).forEach((row, index) => {
      const rowNumber = index + 2;
      if (row.length === 1 && !row[0].trim()) {
        return;
      }

      summary.rowsProcessed += 1;
      if (row.length !== expectedHeader.length) {
        warnings.push(`Row ${rowNumber}: Expected 2 columns but found ${row.length}.`);
        return;
      }

      const originalFileName = row[0].trim();
      const imageId = row[1].trim();
      if (!originalFileName || !imageId) {
        warnings.push(`Row ${rowNumber}: originalFileName and imageId are required.`);
        return;
      }

      mappedFileNames.add(originalFileName);
      mappedImageIds.push(imageId);
      const image = uploadedByName.get(originalFileName);
      if (!image) {
        warnings.push(`Row ${rowNumber}: "${originalFileName}" was not found in the uploaded images.`);
        return;
      }
      if (!image.supported) {
        warnings.push(`Row ${rowNumber}: "${originalFileName}" is not a supported image file.`);
        return;
      }

      const record = getImagePackBuilderRecordByImageId(imageId);
      if (!record) {
        warnings.push(`Row ${rowNumber}: imageId "${imageId}" does not exist in the current master database.`);
        assignments.push({ image, imageId });
        return;
      }

      if (!imagePackBuilder.allSeries && !isRecordInImagePackBuilderScope(record)) {
        warnings.push(`Row ${rowNumber}: imageId "${imageId}" belongs to ${record.category} / ${record.series}, not the selected series.`);
        outsideSeriesAssignments.push({ image, imageId });
        return;
      }

      assignments.push({ image, imageId });
    });

    const duplicateImageIds = getDuplicateValues(mappedImageIds);
    duplicateImageIds.forEach((imageId) => warnings.push(`Mapping CSV assigns imageId "${imageId}" more than once.`));

    imagePackBuilder.images
      .filter((item) => item.supported && !mappedFileNames.has(item.originalFileName))
      .forEach((item) => warnings.push(`Uploaded image "${item.originalFileName}" is not listed in the mapping CSV.`));

    let acceptedOutsideAssignments = [];
    if (outsideSeriesAssignments.length) {
      const switchToAllSeries = window.confirm(
        `${outsideSeriesAssignments.length} mapped imageId${outsideSeriesAssignments.length === 1 ? "" : "s"} belong outside the selected series.\n\n` +
        "Switch to All Series mode to accept those rows?\n\nCancel keeps the selected-series scope and rejects those outside-series rows."
      );
      if (switchToAllSeries) {
        imagePackBuilder.allSeries = true;
        acceptedOutsideAssignments = outsideSeriesAssignments;
        warnings.push("All Series mode was enabled to accept outside-series mapping rows.");
      } else {
        warnings.push("Outside-series mapping rows were rejected. Switch to All Series mode if this CSV intentionally spans multiple series.");
      }
    }

    [...assignments, ...acceptedOutsideAssignments].forEach(({ image, imageId }) => {
      image.assignmentId = imageId;
      summary.assignmentsApplied += 1;
    });

    imagePackBuilder.csvWarnings = warnings;
    return summary;
  }

  function clearImagePackBuilderAssignment(uid) {
    const item = imagePackBuilder.images.find((image) => image.uid === uid);
    if (item) {
      item.assignmentId = "";
      renderImagePackBuilder();
    }
  }

  function assignImagePackBuilderImage(uid, imageId) {
    const item = imagePackBuilder.images.find((image) => image.uid === uid);
    if (!item) {
      return;
    }

    item.assignmentId = imageId;
    renderImagePackBuilder();
  }

  async function exportBuiltImagePackZip() {
    try {
      assertZipSupport();
      const validation = getImagePackBuilderValidation();
      if (!validation.canExport) {
        showToast("Fix validation blockers before exporting the image pack.");
        return;
      }

      const files = [];
      const manifest = [];
      validation.validImages.forEach((item) => {
        const record = getImagePackBuilderRecordByImageId(item.assignmentId);
        const exportedFileName = getBuiltImageExportName(item, item.assignmentId);
        files.push({
          name: exportedFileName,
          data: item.file,
          lastModified: item.file.lastModified
        });
        manifest.push({
          originalFileName: item.originalFileName,
          exportedFileName,
          imageId: item.assignmentId,
          mimeType: item.mimeType,
          size: item.size,
          assignedCharacter: record?.character || "",
          assignedSeries: record?.series || "",
          assignedFranchise: record?.franchise || ""
        });
      });

      files.push({
        name: "image_manifest.json",
        data: JSON.stringify(manifest, null, 2)
      });

      const blob = await zip.createZip(files);
      await downloadBlob(blob, `doorables_image_pack_${dateStamp()}.zip`);
      window.alert(
        "Image Pack ZIP Exported\n\n" +
        `Images exported: ${manifest.length}\n` +
        `Unassigned images skipped: ${validation.unassignedImages}\n` +
        `Unsupported files skipped: ${validation.unsupportedFiles.length}\n\n` +
        "Import this ZIP with Settings > Images > Import Image Pack ZIP when you are ready."
      );
    } catch (error) {
      showToast(error.message || "Image pack builder export failed.");
    }
  }

  function getImagePackBuilderCandidates() {
    let records = state.master.filter((record) => record.imageId);
    if (!imagePackBuilder.allSeries) {
      records = records.filter((record) => isRecordInImagePackBuilderScope(record));
    }

    const query = imagePackBuilder.search.trim().toLowerCase();
    if (query) {
      records = records.filter((record) => [
        record.character,
        record.franchise,
        record.rarity,
        record.imageId
      ].some((value) => String(value || "").toLowerCase().includes(query)));
    }

    return [...records].sort(imagePackBuilder.allSeries ? compareSeriesFranchiseCharacter : compareFranchiseCharacter);
  }

  function getImagePackBuilderAssignmentOptions(item, candidateRecords) {
    const byImageId = new Map(candidateRecords.map((record) => [record.imageId, record]));
    if (item.assignmentId && !byImageId.has(item.assignmentId)) {
      const assigned = getImagePackBuilderRecordByImageId(item.assignmentId);
      if (assigned) {
        byImageId.set(assigned.imageId, assigned);
      }
    }

    return [...byImageId.values()].sort(imagePackBuilder.allSeries ? compareSeriesFranchiseCharacter : compareFranchiseCharacter);
  }

  function getDisplayedImagePackBuilderImages() {
    const images = imagePackBuilder.showUnassignedOnly
      ? imagePackBuilder.images.filter((item) => item.supported && !item.assignmentId)
      : imagePackBuilder.images;

    return images;
  }

  function getImagePackBuilderValidation() {
    const supported = imagePackBuilder.images.filter((item) => item.supported);
    const assigned = supported.filter((item) => item.assignmentId);
    const assignedIds = assigned.map((item) => item.assignmentId);
    const duplicateImageIds = getDuplicateValues(assignedIds);
    const duplicateSet = new Set(duplicateImageIds);
    const invalidImageIds = [];
    const outsideSelectedSeries = [];
    const validImages = [];

    assigned.forEach((item) => {
      const record = getImagePackBuilderRecordByImageId(item.assignmentId);
      if (!record) {
        invalidImageIds.push(item.assignmentId);
        return;
      }

      if (!imagePackBuilder.allSeries && !isRecordInImagePackBuilderScope(record)) {
        outsideSelectedSeries.push(item.assignmentId);
        return;
      }

      if (!duplicateSet.has(item.assignmentId)) {
        validImages.push(item);
      }
    });

    const uniqueInvalidImageIds = [...new Set(invalidImageIds)].sort(compareText);
    const uniqueOutsideSelectedSeries = [...new Set(outsideSelectedSeries)].sort(compareText);

    return {
      totalUploaded: imagePackBuilder.images.length,
      supportedImages: supported.length,
      unsupportedFiles: imagePackBuilder.images.filter((item) => !item.supported).map((item) => item.originalFileName),
      assignedImages: assigned.length,
      unassignedImages: supported.filter((item) => !item.assignmentId).length,
      duplicateImageIds,
      invalidImageIds: uniqueInvalidImageIds,
      outsideSelectedSeries: uniqueOutsideSelectedSeries,
      validImages,
      canExport: validImages.length > 0 &&
        !duplicateImageIds.length &&
        !uniqueInvalidImageIds.length &&
        !uniqueOutsideSelectedSeries.length
    };
  }

  function getImagePackBuilderItemStatus(item, record, flags) {
    if (!item.supported) {
      return { label: "Unsupported", className: "is-red" };
    }
    if (!item.assignmentId) {
      return { label: "Unassigned", className: "" };
    }
    if (flags.isInvalid) {
      return { label: "Invalid imageId", className: "is-red" };
    }
    if (flags.isDuplicate) {
      return { label: "Duplicate", className: "is-red" };
    }
    if (flags.isOutsideSeries) {
      return { label: "Outside series", className: "is-red" };
    }
    if (record) {
      return { label: "Assigned", className: "is-green" };
    }
    return { label: "Unassigned", className: "" };
  }

  function isRecordInImagePackBuilderScope(record) {
    return Boolean(
      imagePackBuilder.category &&
      imagePackBuilder.series &&
      record.category === imagePackBuilder.category &&
      record.series === imagePackBuilder.series
    );
  }

  function getImagePackBuilderRecordByImageId(imageId) {
    return state.master.find((record) => record.imageId === imageId) || null;
  }

  function formatImagePackBuilderOption(record) {
    const seriesPrefix = imagePackBuilder.allSeries ? `${record.series} | ` : "";
    return `${seriesPrefix}${record.character} | ${record.franchise} | ${record.rarity} | ${record.imageId}`;
  }

  function getBuiltImageExportName(item, imageId) {
    const extension = getImageFileExtension(item.file) || mimeToExtension(item.mimeType);
    return `${safeZipNamePart(imageId)}.${extension}`;
  }

  function getImageFileMimeType(file) {
    if (IMAGE_FILE_TYPES.includes(file.type)) {
      return file.type;
    }

    const extension = getImageFileExtension(file);
    return IMAGE_EXTENSION_TO_MIME[extension] || file.type || "";
  }

  function getImageFileExtension(file) {
    const match = /\.([^.]+)$/.exec(file.name || "");
    const extension = match ? match[1].toLowerCase() : "";
    if (IMAGE_EXTENSION_TO_MIME[extension]) {
      return extension;
    }
    return "";
  }

  function safeZipNamePart(value) {
    return String(value || "image").trim().replace(/[\\/]/g, "_") || "image";
  }

  function getDuplicateValues(values) {
    const counts = new Map();
    values.filter(Boolean).forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
    return [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([value]) => value)
      .sort(compareText);
  }

  // Import and export actions.
  async function pickAndImport(type) {
    try {
      const file = await pickJsonFile();
      if (!file) {
        return;
      }

      const json = JSON.parse(await file.text());
      const validation = validateImportPayload(type, json);
      if (validation.invalidRows.length) {
        showImportValidationReport(type, validation);
        return;
      }

      let importRecords = validation.records;
      let orphanImportSummary = null;

      if (type === "collection" && validation.orphanRows.length) {
        const choice = await chooseCollectionOrphanImport(validation);
        if (choice !== "valid-only") {
          showToast("Collection import canceled.");
          return;
        }

        const orphanIds = new Set(validation.orphanRows.map((row) => row.id));
        importRecords = validation.records.filter((record) => !orphanIds.has(record.id));
        orphanImportSummary = {
          totalRows: Array.isArray(json) ? json.length : validation.records.length,
          importedRows: importRecords.length,
          skippedOrphanRows: validation.orphanRows.length,
          skippedOrphanIds: validation.orphanRows.map((row) => row.id).sort(compareText)
        };

        if (!importRecords.length) {
          showCollectionImportValidOnlySummary(orphanImportSummary);
          showToast("No valid collection records were available to import.");
          return;
        }
      } else if (!validation.ok) {
        showImportValidationReport(type, validation);
        return;
      }

      if (validation.warningRows.length && !confirmImportWarnings(type, validation)) {
        showToast("Import canceled.");
        return;
      }

      const mode = askImportMode(type, importRecords);
      if (!mode) {
        showToast("Import canceled.");
        return;
      }

      const count = type === "master" ? await db.importMaster(importRecords, mode) : await db.importCollection(importRecords, mode);
      await refreshData();
      if (type === "master" && mode === "replace") {
        alertOrphanCollectionRecordsAfterMasterReplace();
      }

      if (orphanImportSummary) {
        orphanImportSummary.importedRows = count;
        showCollectionImportValidOnlySummary(orphanImportSummary);
      }

      showToast(`${mode === "replace" ? "Replaced" : "Merged"} ${count} ${type} record${count === 1 ? "" : "s"}.`);
    } catch (error) {
      showToast(error.message || "Import failed. Check that the file is valid JSON.");
    }
  }

  async function pickAndImportMasterCsv() {
    try {
      const file = await pickCsvFile();
      if (!file) {
        return;
      }

      const parsed = parseMasterCsv(await file.text());
      const validation = db.validateMasterRecords(parsed.records);
      const totalRows = parsed.totalRows;
      const validRows = validation.records.length;
      const invalidRows = countInvalidCsvRows(parsed, validation);

      if (parsed.invalidRows.length || !validation.ok) {
        showCsvImportReport({ totalRows, validRows, invalidRows, parsed, validation });
        return;
      }

      if (!confirmCsvImportSummary({ totalRows, validRows, invalidRows })) {
        showToast("CSV import canceled.");
        return;
      }

      if (validation.warningRows.length && !confirmImportWarnings("master", validation)) {
        showToast("CSV import canceled.");
        return;
      }

      const mode = askImportMode("master", validation.records);
      if (!mode) {
        showToast("CSV import canceled.");
        return;
      }

      const count = await db.importMaster(validation.records, mode);
      await refreshData();
      if (mode === "replace") {
        alertOrphanCollectionRecordsAfterMasterReplace();
      }
      showToast(`${mode === "replace" ? "Replaced" : "Merged"} ${count} master record${count === 1 ? "" : "s"} from CSV.`);
    } catch (error) {
      showToast(error.message || "CSV import failed. Check that the file is valid CSV.");
    }
  }

  function countInvalidCsvRows(parsed, validation) {
    const invalidDataRows = new Set();
    let fileLevelIssues = 0;

    [...parsed.invalidRows, ...validation.invalidRows].forEach((issue) => {
      if (issue.row > 1) {
        invalidDataRows.add(issue.row);
      } else {
        fileLevelIssues += 1;
      }
    });

    return invalidDataRows.size + fileLevelIssues;
  }

  // Import/export validation is previewed in the UI before db.js writes anything.
  function validateImportPayload(type, json) {
    if (type === "master") {
      return db.validateMasterRecords(json);
    }

    return db.validateCollectionRecords(json, state.master.map((record) => record.id));
  }

  function showImportValidationReport(type, validation) {
    const label = type === "master" ? "Master database" : "Collection";
    const lines = [`${label} import canceled. Fix these issues before importing.`];

    if (validation.invalidRows.length) {
      lines.push("", "Invalid rows:");
      validation.invalidRows.slice(0, 15).forEach((issue) => {
        const rowLabel = issue.row === 0 ? "File" : `Row ${issue.row}${issue.id ? ` (${issue.id})` : ""}`;
        lines.push(`${rowLabel}: ${issue.errors.join(" ")}`);
      });
      if (validation.invalidRows.length > 15) {
        lines.push(`...and ${validation.invalidRows.length - 15} more invalid rows.`);
      }
    }

    if (validation.orphanRows.length) {
      lines.push(
        "",
        "Orphan collection IDs not found in the master database:",
        "Orphan collection IDs are records in your collection file that do not exist in your current master database. Import the matching master database first, or remove these orphan records."
      );
      validation.orphanRows.slice(0, 20).forEach((issue) => {
        lines.push(`Row ${issue.row}: ${issue.id}`);
      });
      if (validation.orphanRows.length > 20) {
        lines.push(`...and ${validation.orphanRows.length - 20} more orphan IDs.`);
      }
    }

    if (validation.warningRows.length) {
      lines.push("", "Reference warnings:");
      validation.warningRows.slice(0, 15).forEach((issue) => {
        const rowLabel = `Row ${issue.row}${issue.id ? ` (${issue.id})` : ""}`;
        lines.push(`${rowLabel}: ${issue.warnings.join(" ")}`);
      });
      if (validation.warningRows.length > 15) {
        lines.push(`...and ${validation.warningRows.length - 15} more warning rows.`);
      }
    }

    window.alert(lines.join("\n"));
  }

  function chooseCollectionOrphanImport(validation) {
    const orphanIds = validation.orphanRows.map((row) => row.id).sort(compareText);
    const validCount = validation.records.length - validation.orphanRows.length;

    return new Promise((resolve) => {
      elements.modalTitle.textContent = "Orphan Collection IDs";
      elements.modalBody.innerHTML = `
        <div class="list-stack">
          <div class="plain-row">
            <p><strong>Collection import contains orphan IDs.</strong></p>
            <p class="muted small">Orphan collection IDs are records in your collection file that do not exist in your current master database. Import the matching master database first, remove these orphan records, or import only the valid matching records.</p>
          </div>
          <div class="stat-grid">
            ${renderStat("Total rows", validation.records.length)}
            ${renderStat("Valid matching rows", validCount)}
            ${renderStat("Skipped orphan rows", validation.orphanRows.length)}
          </div>
          <div class="plain-row">
            <p><strong>Orphan IDs</strong></p>
            <p class="muted small id-list">${formatIdList(orphanIds).map(escapeHtml).join("<br>")}</p>
          </div>
          <div class="form-actions">
            <button class="primary-button" type="button" data-orphan-import-choice="valid-only">Import Valid Records Only</button>
            <button class="secondary-button" type="button" data-orphan-import-choice="cancel">Cancel Import</button>
          </div>
        </div>
      `;
      elements.modal.hidden = false;

      const handler = (event) => {
        const button = event.target.closest("[data-orphan-import-choice]");
        if (!button) {
          return;
        }

        resolvePendingModalChoice(button.dataset.orphanImportChoice);
      };

      pendingModalResolve = resolve;
      pendingModalCleanup = () => elements.modalBody.removeEventListener("click", handler);
      elements.modalBody.addEventListener("click", handler);
    });
  }

  function resolvePendingModalChoice(choice) {
    if (!pendingModalResolve) {
      return false;
    }

    const resolve = pendingModalResolve;
    const cleanup = pendingModalCleanup;
    pendingModalResolve = null;
    pendingModalCleanup = null;

    if (cleanup) {
      cleanup();
    }

    elements.modal.hidden = true;
    elements.modalBody.innerHTML = "";
    resolve(choice);
    return true;
  }

  function showCollectionImportValidOnlySummary(summary) {
    const lines = [
      "Collection Import Summary",
      "",
      `Total rows: ${summary.totalRows}`,
      `Imported rows: ${summary.importedRows}`,
      `Skipped orphan rows: ${summary.skippedOrphanRows}`
    ];

    if (summary.skippedOrphanIds.length) {
      lines.push("", "Skipped orphan IDs:", ...formatIdList(summary.skippedOrphanIds));
    }

    window.alert(lines.join("\n"));
  }

  function alertOrphanCollectionRecordsAfterMasterReplace() {
    const orphanIds = getOrphanCollectionRecords().map((record) => record.id).sort(compareText);
    if (!orphanIds.length) {
      return;
    }

    window.alert(
      "Master Database Replaced\n\n" +
      `${orphanIds.length} collection record${orphanIds.length === 1 ? "" : "s"} no longer match the current master database.\n\n` +
      "They will be skipped from default collection exports. Use Settings > Maintenance > Remove Orphan Collection Records to remove them safely.\n\n" +
      `Orphan IDs:\n${formatIdList(orphanIds).join("\n")}`
    );
  }

  function showCsvImportReport(summary) {
    const lines = [
      "Master database CSV import canceled. Fix invalid rows before importing.",
      "",
      `Total rows: ${summary.totalRows}`,
      `Valid rows: ${summary.validRows}`,
      `Invalid rows: ${summary.invalidRows}`
    ];

    if (summary.parsed.invalidRows.length) {
      lines.push("", "CSV format issues:");
      summary.parsed.invalidRows.slice(0, 15).forEach((issue) => {
        lines.push(`Row ${issue.row}: ${issue.errors.join(" ")}`);
      });
      if (summary.parsed.invalidRows.length > 15) {
        lines.push(`...and ${summary.parsed.invalidRows.length - 15} more CSV format issues.`);
      }
    }

    if (summary.validation.invalidRows.length) {
      lines.push("", "Validation issues:");
      summary.validation.invalidRows.slice(0, 15).forEach((issue) => {
        const rowLabel = `Row ${issue.row}${issue.id ? ` (${issue.id})` : ""}`;
        lines.push(`${rowLabel}: ${issue.errors.join(" ")}`);
      });
      if (summary.validation.invalidRows.length > 15) {
        lines.push(`...and ${summary.validation.invalidRows.length - 15} more validation issues.`);
      }
    }

    window.alert(lines.join("\n"));
  }

  function confirmCsvImportSummary(summary) {
    return window.confirm(
      "Master database CSV ready to import.\n\n" +
      `Total rows: ${summary.totalRows}\n` +
      `Valid rows: ${summary.validRows}\n` +
      `Invalid rows: ${summary.invalidRows}\n\n` +
      "Continue to merge/replace selection?"
    );
  }

  function confirmImportWarnings(type, validation) {
    const label = type === "master" ? "Master database" : "Collection";
    const lines = [
      `${label} import has ${validation.warningRows.length} reference warning${validation.warningRows.length === 1 ? "" : "s"}.`,
      "These rows use categories or series that are not in the official reference list.",
      "You can still import them, and they will appear after official values in filters and groups.",
      "",
      "Warnings:"
    ];

    validation.warningRows.slice(0, 20).forEach((issue) => {
      const rowLabel = `Row ${issue.row}${issue.id ? ` (${issue.id})` : ""}`;
      lines.push(`${rowLabel}: ${issue.warnings.join(" ")}`);
    });

    if (validation.warningRows.length > 20) {
      lines.push(`...and ${validation.warningRows.length - 20} more warning rows.`);
    }

    lines.push("", "Continue to import mode selection?");
    return window.confirm(lines.join("\n"));
  }

  function askImportMode(type, records) {
    const existingIds = type === "master"
      ? new Set(state.master.map((record) => record.id))
      : new Set(state.collection.map((record) => record.id));
    const incomingIds = new Set(records.map((record) => record.id));
    const overlapCount = [...incomingIds].filter((id) => existingIds.has(id)).length;
    const existingCount = existingIds.size;
    const label = type === "master" ? "master database" : "collection";
    const hiddenCollectionCount = type === "master"
      ? state.collection.filter((record) => !incomingIds.has(record.id)).length
      : 0;
    const masterReplaceWarning = type === "master"
      ? `\nReplace master warning: replacing the master database can affect collection visibility and series/category reporting. It may hide ${hiddenCollectionCount} existing collection record${hiddenCollectionCount === 1 ? "" : "s"} whose ids are not in the imported master file.\n`
      : "";
    const collectionReplaceWarning = type === "collection"
      ? "\nReplace collection warning: replacing collection data will overwrite existing ownership, inventory, listing status, notes, dates, and collection copy flags.\n"
      : "";

    const choice = window.prompt(
      `Import ${records.length} ${label} record${records.length === 1 ? "" : "s"}.\n\n` +
      `MERGE: adds new records and updates ${overlapCount} matching id${overlapCount === 1 ? "" : "s"}. It does not delete existing records that are not in the import file.\n` +
      `REPLACE: deletes ${existingCount} existing ${label} record${existingCount === 1 ? "" : "s"} before importing this file.\n` +
      masterReplaceWarning +
      collectionReplaceWarning +
      "Cancel: imports nothing.\n\nType MERGE, REPLACE, or CANCEL."
    );

    if (!choice) {
      return "";
    }

    const normalized = choice.trim().toUpperCase();
    if (normalized === "MERGE") {
      return "merge";
    }

    if (normalized === "REPLACE") {
      return confirmReplaceImport(type, records, { existingCount, hiddenCollectionCount }) ? "replace" : "";
    }

    if (normalized !== "CANCEL") {
      showToast("Import canceled. Type MERGE or REPLACE exactly to import.");
    }

    return "";
  }

  function confirmReplaceImport(type, records, details) {
    const label = type === "master" ? "Master Database" : "Collection Data";
    const warning = type === "master"
      ? [
          `This will delete ${details.existingCount} existing master database record${details.existingCount === 1 ? "" : "s"} before importing ${records.length} replacement record${records.length === 1 ? "" : "s"}.`,
          "Replacing the master database can affect collection visibility because collection rows only appear when their IDs exist in the master database.",
          "It can also change category/series reporting, filters, Smart Bulk Mode series choices, and analytics grouping.",
          `Current collection records that may be hidden after replacement: ${details.hiddenCollectionCount}.`
        ]
      : [
          `This will delete ${details.existingCount} existing collection record${details.existingCount === 1 ? "" : "s"} before importing ${records.length} replacement record${records.length === 1 ? "" : "s"}.`,
          "Existing ownership quantities, inventory counts, listing status, notes, dates, and collection copy flags will be replaced by the import file."
        ];

    const confirmation = window.prompt(
      `Replace ${label}\n\n${warning.join("\n\n")}\n\nThis cannot be undone from inside the app unless you have an exported backup.\n\nType REPLACE to continue.`
    );

    if (confirmation === "REPLACE") {
      return true;
    }

    if (confirmation !== null) {
      showToast("Replace canceled. Type REPLACE exactly to confirm.");
    }

    return false;
  }

  function pickJsonFile() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/json,.json";
      input.addEventListener("change", () => resolve(input.files[0]));
      input.click();
    });
  }

  function pickCsvFile() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "text/csv,.csv";
      input.addEventListener("change", () => resolve(input.files[0]));
      input.click();
    });
  }

  function pickZipFile() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ZIP_FILE_EXTENSIONS;
      input.addEventListener("change", () => resolve(input.files[0] || null));
      input.click();
    });
  }

  function assertZipSupport() {
    if (!zip || typeof zip.readZip !== "function" || typeof zip.createZip !== "function") {
      throw new Error("ZIP support is not available. Make sure zip-utils.js is included with the app.");
    }
  }

  function getMasterImageIdSet(masterRecords = state.master) {
    return new Set(masterRecords.map((record) => record.imageId).filter(Boolean));
  }

  function getZipImageInfo(name) {
    const fileName = String(name || "").split("/").pop();
    const match = /^(.*)\.([^.]+)$/.exec(fileName);
    if (!match) {
      return null;
    }

    const imageId = match[1];
    const extension = match[2].toLowerCase();
    const mimeType = IMAGE_EXTENSION_TO_MIME[extension];
    if (!imageId || !mimeType) {
      return null;
    }

    return { imageId, extension, mimeType, fileName };
  }

  function showImagePackImportSummary(summary) {
    const lines = [
      "Image Pack Import Summary",
      "",
      `Total files found: ${summary.totalFiles}`,
      `Valid image files: ${summary.validImageFiles}`,
      `Images matched to master records: ${summary.matchedToMaster}`,
      `Images imported: ${summary.imported}`,
      `Images replaced: ${summary.replaced}`,
      `Images skipped: ${summary.skipped}`,
      `Unsupported files: ${summary.unsupportedFiles.length}`,
      `Orphan image files: ${summary.orphanImageFiles.length}`
    ];

    if (summary.unsupportedFiles.length) {
      lines.push("", "Unsupported files:", ...formatIdList(summary.unsupportedFiles));
    }

    if (summary.orphanImageFiles.length) {
      lines.push("", "Orphan image files:", ...formatIdList(summary.orphanImageFiles));
    }

    window.alert(lines.join("\n"));
  }

  async function buildImageZipFiles(images, prefix) {
    const manifest = [];
    const files = [];

    for (const image of images.sort((a, b) => compareText(a.imageId, b.imageId))) {
      const mimeType = image.mimeType || image.blob?.type || "application/octet-stream";
      const extension = mimeToExtension(mimeType);
      const safeImageId = String(image.imageId || "image").replace(/[\\/]/g, "_");
      const exportedFileName = `${safeImageId}.${extension}`;
      files.push({
        name: `${prefix}${exportedFileName}`,
        data: image.blob,
        lastModified: image.lastModified
      });
      manifest.push({
        imageId: image.imageId,
        mimeType,
        size: image.size || image.blob?.size || 0,
        lastModified: image.lastModified || "",
        exportedFileName
      });
    }

    return { files, manifest };
  }

  function mimeToExtension(mimeType) {
    if (mimeType === "image/webp") {
      return "webp";
    }
    if (mimeType === "image/png") {
      return "png";
    }
    if (mimeType === "image/jpeg" || mimeType === "image/jpg") {
      return "jpg";
    }
    return "webp";
  }

  function dateStamp(date = new Date()) {
    return date.toISOString().slice(0, 10);
  }

  async function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  async function markBackupExported(timestamp) {
    state.storage.lastBackupDate = await db.recordBackupExport(timestamp);
    state.storage.counts = await db.getStorageStats();
    if (state.tab === "settings") {
      render();
    }
  }

  function getReferenceData() {
    return {
      categories: db.categories,
      rarities: db.rarities,
      seriesByCategory: db.seriesByCategory
    };
  }

  async function parseFullVaultBackup(file) {
    const entries = await zip.readZip(file);
    const entryMap = new Map(entries.filter((entry) => !entry.isDirectory).map((entry) => [entry.name, entry]));
    const invalidFiles = [];
    const blockers = [];
    const master = await readBackupJson(entryMap, "master_database.json", true, invalidFiles);
    const collection = await readBackupJson(entryMap, "collection.json", true, invalidFiles);
    const activity = await readBackupJson(entryMap, "activity.json", false, invalidFiles) || [];
    const meta = await readBackupJson(entryMap, "settings.json", false, invalidFiles) || [];
    const metadata = await readBackupJson(entryMap, "metadata.json", true, invalidFiles) || {};
    const imageManifest = await readBackupJson(entryMap, "images/image_manifest.json", false, invalidFiles) || [];
    const manifestByFile = new Map((Array.isArray(imageManifest) ? imageManifest : []).map((item) => [item.exportedFileName, item]));

    ensureBackupArray(master, "master_database.json", invalidFiles);
    ensureBackupArray(collection, "collection.json", invalidFiles);
    ensureBackupArray(activity, "activity.json", invalidFiles);
    ensureBackupArray(meta, "settings.json", invalidFiles);
    ensureBackupArray(imageManifest, "images/image_manifest.json", invalidFiles);

    if (invalidFiles.length) {
      blockers.push(...invalidFiles);
    }

    const masterValidation = db.validateMasterRecords(master || []);
    if (!masterValidation.ok) {
      blockers.push(...masterValidation.invalidRows.map((row) => `Master row ${row.row}: ${row.errors.join(" ")}`));
    }

    const collectionValidation = db.validateCollectionRecords(
      collection || [],
      masterValidation.records.map((record) => record.id)
    );
    if (collectionValidation.invalidRows.length) {
      blockers.push(...collectionValidation.invalidRows.map((row) => `Collection row ${row.row}: ${row.errors.join(" ")}`));
    }
    if (collectionValidation.orphanRows.length) {
      blockers.push(...collectionValidation.orphanRows.map((row) => `Orphan collection row ${row.row}: ${row.id}`));
    }

    const masterImageIds = getMasterImageIdSet(masterValidation.records);
    const imageEntries = entries.filter((entry) => !entry.isDirectory && entry.name.startsWith("images/") && entry.name !== "images/image_manifest.json");
    const images = [];
    const orphanImages = [];

    for (const entry of imageEntries) {
      const info = getZipImageInfo(entry.name);
      if (!info) {
        blockers.push(`Unsupported image file: ${entry.name}`);
        continue;
      }

      if (!masterImageIds.has(info.imageId)) {
        orphanImages.push(info.imageId);
        continue;
      }

      const blob = await entry.blob(info.mimeType);
      const manifest = manifestByFile.get(info.fileName) || {};
      images.push({
        imageId: info.imageId,
        blob,
        mimeType: manifest.mimeType || info.mimeType,
        size: blob.size,
        lastModified: manifest.lastModified || metadata.backupDate || new Date().toISOString()
      });
    }

    return {
      metadata,
      master,
      collection,
      activity,
      meta,
      masterValidation,
      collectionValidation,
      imageEntries,
      images,
      orphanImages: [...new Set(orphanImages)].sort(compareText),
      invalidFiles,
      blockers,
      payload: {
        master: master || [],
        collection: collection || [],
        activity: Array.isArray(activity) ? activity : [],
        meta: Array.isArray(meta) ? meta : [],
        images
      }
    };
  }

  async function readBackupJson(entryMap, name, required, invalidFiles) {
    const entry = entryMap.get(name);
    if (!entry) {
      if (required) {
        invalidFiles.push(`Missing required file: ${name}`);
      }
      return null;
    }

    try {
      return JSON.parse(await entry.text());
    } catch (error) {
      invalidFiles.push(`Invalid JSON file: ${name}`);
      return null;
    }
  }

  function ensureBackupArray(value, name, invalidFiles) {
    if (value !== null && !Array.isArray(value)) {
      invalidFiles.push(`${name} must contain a JSON array.`);
    }
  }

  function showRestorePreview(preview) {
    const lines = [
      "Full Vault Restore Preview",
      "",
      `App backup version: ${preview.metadata.appVersion || "Unknown"}`,
      `Backup date: ${preview.metadata.backupDate || "Unknown"}`,
      `Master records found: ${Array.isArray(preview.master) ? preview.master.length : 0}`,
      `Collection records found: ${Array.isArray(preview.collection) ? preview.collection.length : 0}`,
      `Activity records found: ${Array.isArray(preview.activity) ? preview.activity.length : 0}`,
      `Images found: ${preview.imageEntries.length}`,
      `Valid images to restore: ${preview.images.length}`,
      `Orphan collection records: ${preview.collectionValidation.orphanRows.length}`,
      `Orphan images: ${preview.orphanImages.length}`,
      `Invalid files/issues: ${preview.blockers.length}`
    ];

    if (preview.orphanImages.length) {
      lines.push("", "Orphan images will be skipped:", ...formatIdList(preview.orphanImages));
    }

    if (preview.blockers.length) {
      lines.push("", "Restore is blocked by:", ...formatIdList(preview.blockers));
    } else {
      lines.push("", "No blocking validation errors found. You will be asked to type RESTORE before anything is replaced.");
    }

    window.alert(lines.join("\n"));
  }

  // CSV import is intentionally narrow: it accepts only the master database
  // columns in the documented order, then reuses the JSON master validator.
  function parseMasterCsv(text) {
    const expectedHeader = ["id", "category", "series", "character", "franchise", "rarity", "imageId"];
    const parsedCsv = parseCsvRows(text);
    const rows = parsedCsv.rows;
    const records = [];
    const invalidRows = [...parsedCsv.invalidRows];
    let totalRows = 0;

    if (!rows.length) {
      return {
        totalRows,
        records,
        invalidRows: [
          {
            row: 1,
            errors: [`CSV file must include a header row: ${expectedHeader.join(",")}.`]
          }
        ]
      };
    }

    const header = rows[0].map((value, index) => index === 0 ? value.replace(/^\uFEFF/, "").trim() : value.trim());
    const headerMatches = header.length === expectedHeader.length &&
      expectedHeader.every((key, index) => header[index] === key);

    if (!headerMatches) {
      invalidRows.push({
        row: 1,
        errors: [`Header must be exactly: ${expectedHeader.join(",")}.`]
      });
      totalRows = rows.slice(1).filter((row) => !(row.length === 1 && row[0].trim() === "")).length;
      return { totalRows, records, invalidRows };
    }

    rows.slice(1).forEach((row, index) => {
      const rowNumber = index + 2;
      if (row.length === 1 && row[0].trim() === "") {
        return;
      }

      totalRows += 1;

      if (row.length !== expectedHeader.length) {
        invalidRows.push({
          row: rowNumber,
          errors: [`Expected ${expectedHeader.length} columns but found ${row.length}.`]
        });
        return;
      }

      records.push(expectedHeader.reduce((record, key, columnIndex) => {
        record[key] = row[columnIndex].trim();
        return record;
      }, {}));
    });

    if (!records.length && !invalidRows.length) {
      invalidRows.push({
        row: 1,
        errors: ["CSV file must include at least one data row."]
      });
    }

    return { totalRows, records, invalidRows };
  }

  function parseCsvRows(text) {
    const rows = [];
    const invalidRows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    let currentRowNumber = 1;

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      const nextChar = text[index + 1];

      if (char === "\"") {
        if (inQuotes && nextChar === "\"") {
          field += "\"";
          index += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === "," && !inQuotes) {
        row.push(field);
        field = "";
      } else if ((char === "\n" || char === "\r") && !inQuotes) {
        if (char === "\r" && nextChar === "\n") {
          index += 1;
        }
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        currentRowNumber += 1;
      } else {
        field += char;
      }
    }

    if (inQuotes) {
      invalidRows.push({
        row: currentRowNumber,
        errors: ["Quoted field is not closed."]
      });
    }

    if (field.length || row.length) {
      row.push(field);
      rows.push(row);
    }

    return { rows, invalidRows };
  }

  async function exportJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    await downloadBlob(blob, filename);
    await markBackupExported();
    showToast(`Exported ${filename}.`);
  }

  // Collection save rules and persistence helpers.
  async function adjustOwned(id, delta, options = {}) {
    const record = getCollectionRecord(id);
    const nextOwned = Math.max(0, record.owned + delta);
    await saveCollectionPatch(id, { owned: nextOwned }, `Updated quantity for ${getMasterName(id)}`, {
      promptFirstCopy: delta > 0 && record.owned === 0 && nextOwned === 1,
      ownedChanged: true,
      rerender: options.rerender !== false
    });

    if (options.afterSave) {
      options.afterSave();
    }
  }

  async function saveDetailField(field, options = {}) {
    const id = field.dataset.recordId;
    const key = field.dataset.detailField;
    const value = readFieldValue(field);
    const saved = await saveCollectionPatch(id, { [key]: value }, `Updated ${getMasterName(id)}`, {
      promptFirstCopy: key === "owned" && toNumber(value) === 1 && getCollectionRecord(id).owned === 0,
      ownedChanged: key === "owned",
      rerender: options.rerender !== false && !options.quiet,
      quiet: options.quiet
    });

    if (!saved && options.rerender !== false && !options.quiet) {
      openDetailModal(id);
    }
  }

  async function saveMasterField(field, options = {}) {
    const id = field.dataset.recordId;
    const key = field.dataset.masterField;
    const master = state.master.find((record) => record.id === id);
    if (!master) {
      return;
    }

    const updated = {
      ...master,
      [key]: readFieldValue(field)
    };

    await db.putMaster(updated);
    replaceMaster(updated);

    if (!options.quiet) {
      await db.logActivity(`Updated database record for ${updated.character}`);
    }

    if (options.rerender !== false) {
      await refreshData();
      openDetailModal(id);
    }
  }

  // Collection completion is intentionally based on collectionCopy, but the
  // quantity buckets still need to be internally consistent before saving.
  function applyCollectionRules(record, options = {}) {
    const next = {
      ...record,
      owned: toNumber(record.owned),
      personalCollection: toNumber(record.personalCollection),
      available: toNumber(record.available),
      soldReserved: toNumber(record.soldReserved),
      collectionCopy: Boolean(record.collectionCopy),
      listedWhatnot: Boolean(record.listedWhatnot),
      listedEbay: Boolean(record.listedEbay)
    };

    if (next.owned === 0) {
      next.collectionCopy = false;
      next.personalCollection = 0;
      next.available = 0;
      next.soldReserved = 0;
      next.listedWhatnot = false;
      next.listedEbay = false;
      return next;
    }

    if (next.collectionCopy && next.personalCollection < 1) {
      next.personalCollection = 1;
    }

    if (!next.collectionCopy) {
      next.personalCollection = 0;
    }

    return next;
  }

  function getCollectionQuantityWarning(record) {
    const allocated = record.personalCollection + record.available + record.soldReserved;
    if (allocated > record.owned) {
      return `Owned quantity must be at least personal collection + available + sold/reserved (${allocated}).`;
    }

    return "";
  }

  async function saveCollectionPatch(id, patch, activityText, options = {}) {
    const previous = getCollectionRecord(id);
    let next = {
      ...previous,
      ...patch,
      lastModified: new Date().toISOString()
    };

    next = applyCollectionRules(next, {
      ownedChanged: Boolean(options.ownedChanged || Object.prototype.hasOwnProperty.call(patch, "owned")),
      collectionCopyChanged: Object.prototype.hasOwnProperty.call(patch, "collectionCopy")
    });

    const warning = getCollectionQuantityWarning(next);
    if (warning) {
      showToast(warning);
      return false;
    }

    if (!next.dateAdded && (next.owned > 0 || next.collectionCopy)) {
      next.dateAdded = new Date().toISOString().slice(0, 10);
    }

    if (options.promptFirstCopy && !next.collectionCopy) {
      const shouldMark = window.confirm("First copy found. Mark as Collection Copy?");
      if (shouldMark) {
        next.collectionCopy = true;
        next.personalCollection = Math.max(1, next.personalCollection);
      }
    }

    await db.putCollection(next);
    replaceCollection(next);

    if (!options.quiet) {
      await db.logActivity(activityText);
    }

    if (options.rerender !== false) {
      await refreshData();
    }

    return true;
  }

  function replaceCollection(record) {
    state.collectionMap.set(record.id, record);
    const index = state.collection.findIndex((item) => item.id === record.id);
    if (index >= 0) {
      state.collection[index] = record;
    } else {
      state.collection.push(record);
    }
  }

  function replaceMaster(record) {
    const index = state.master.findIndex((item) => item.id === record.id);
    if (index >= 0) {
      state.master[index] = record;
    }
  }

  function openDetailModal(id) {
    const record = getMergedRecords().find((item) => item.id === id);
    if (!record) {
      return;
    }

    elements.modalTitle.textContent = record.character;
    elements.modalBody.innerHTML = renderDetailForm(record);
    elements.modal.hidden = false;
  }

  function renderDetailForm(record) {
    return `
      <div class="form-grid">
        <div class="full-row">
          ${renderDoorableCard(record, { controls: false, database: true })}
        </div>
        ${renderImageControls(record)}
        ${renderMasterInput(record, "character", "Character")}
        ${renderMasterInput(record, "series", "Series", { list: "series-reference-options" })}
        ${renderMasterSelect(record, "category", "Category", db.categories)}
        ${renderMasterInput(record, "franchise", "Franchise")}
        ${renderMasterSelect(record, "rarity", "Rarity", db.rarities)}
        ${renderMasterInput(record, "imageId", "Image ID")}

        <label class="checkbox-row">
          <input type="checkbox" data-record-id="${escapeAttr(record.id)}" data-detail-field="collectionCopy" ${record.collectionCopy ? "checked" : ""}>
          <span>Collection copy</span>
        </label>
        <label class="checkbox-row">
          <input type="checkbox" data-record-id="${escapeAttr(record.id)}" data-detail-field="listedWhatnot" ${record.listedWhatnot ? "checked" : ""}>
          <span>Listed on Whatnot</span>
        </label>
        <label class="checkbox-row">
          <input type="checkbox" data-record-id="${escapeAttr(record.id)}" data-detail-field="listedEbay" ${record.listedEbay ? "checked" : ""}>
          <span>Listed on eBay</span>
        </label>

        ${renderDetailNumber(record, "owned", "Owned")}
        ${renderDetailNumber(record, "personalCollection", "Personal collection")}
        ${renderDetailNumber(record, "available", "Available")}
        ${renderDetailNumber(record, "soldReserved", "Sold/reserved")}

        <label class="field is-wide">
          <span>Notes</span>
          <textarea data-record-id="${escapeAttr(record.id)}" data-detail-field="notes" data-autosave-input="${escapeAttr(record.id)}">${escapeHtml(record.notes)}</textarea>
        </label>

        <div class="plain-row full-row">
          <p class="muted small">Date added: ${escapeHtml(record.dateAdded || "Not set")}</p>
          <p class="muted small">Last modified: ${formatDateTime(record.lastModified) || "Not set"}</p>
        </div>
        ${renderSeriesDatalist()}
      </div>
    `;
  }

  function renderImageControls(record) {
    const hasStoredImage = Boolean(getImageUrl(record));
    return `
      <div class="image-control-panel full-row">
        <div>
          <p><strong>Image</strong></p>
          <p class="muted small">Image ID: ${escapeHtml(record.imageId || "Not set yet")}</p>
        </div>
        <div class="form-actions image-actions">
          <button class="primary-button" type="button" data-image-upload="${escapeAttr(record.id)}" ${hasStoredImage ? "disabled" : ""}>Upload Image</button>
          <button class="secondary-button" type="button" data-image-replace="${escapeAttr(record.id)}" ${hasStoredImage ? "" : "disabled"}>Replace Image</button>
          <button class="danger-button" type="button" data-image-remove="${escapeAttr(record.id)}" ${hasStoredImage ? "" : "disabled"}>Remove Image</button>
        </div>
      </div>
    `;
  }

  function renderMasterInput(record, key, label, options = {}) {
    const listAttr = options.list ? ` list="${escapeAttr(options.list)}"` : "";
    return `
      <label class="field">
        <span>${label}</span>
        <input type="text" value="${escapeAttr(record[key])}"${listAttr} data-record-id="${escapeAttr(record.id)}" data-master-field="${key}" data-autosave-input="${escapeAttr(record.id)}">
      </label>
    `;
  }

  function renderMasterSelect(record, key, label, options) {
    const selectOptions = withCurrentOption(options, record[key]);
    return `
      <label class="field">
        <span>${label}</span>
        <select data-record-id="${escapeAttr(record.id)}" data-master-field="${key}">
          ${selectOptions.map((option) => `<option value="${escapeAttr(option)}" ${record[key] === option ? "selected" : ""}>${escapeHtml(option)}</option>`).join("")}
        </select>
      </label>
    `;
  }

  function renderDetailNumber(record, key, label) {
    return `
      <label class="field">
        <span>${label}</span>
        <input type="number" min="0" step="1" value="${record[key]}" data-record-id="${escapeAttr(record.id)}" data-detail-field="${key}">
      </label>
    `;
  }

  // Smart Bulk Mode uses the same adjustOwned path as cards so every plus/minus
  // click auto-saves, triggers first-copy collection prompts, and respects rules.
  function openBulkModal() {
    const series = getSeriesOptions(getMergedRecords());
    if (!series.includes(state.bulkSeries)) {
      state.bulkSeries = series[0] || "";
    }
    elements.modalTitle.textContent = "Smart Bulk Mode";
    elements.modal.hidden = false;
    renderBulkModal();
  }

  function renderBulkModal() {
    const series = getSeriesOptions(getMergedRecords());
    const records = getMergedRecords()
      .filter((record) => record.series === state.bulkSeries)
      .sort(compareFranchiseCharacter);

    elements.modalBody.innerHTML = `
      <div class="form-grid">
        <label class="field full-row">
          <span>Select series first</span>
          <select data-bulk-series>
            ${series.map((name) => `<option value="${escapeAttr(name)}" ${state.bulkSeries === name ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}
          </select>
        </label>
      </div>
      <div class="card-grid bulk-grid">
        ${records.map((record) => `
          <article class="doorable-card bulk-card">
            ${renderArt(record)}
            <div class="item-main bulk-item-body">
                <div class="bulk-copy">
                  <h3 class="item-title">${escapeHtml(record.character)}</h3>
                  <p class="item-meta">${escapeHtml(record.rarity)} | Current quantity ${record.owned}</p>
                </div>
                <span class="qty-control bulk-qty-control">
                  <button type="button" data-bulk-dec="${escapeAttr(record.id)}" aria-label="Decrease ${escapeAttr(record.character)}">-</button>
                  <span>${record.owned}</span>
                  <button type="button" data-bulk-inc="${escapeAttr(record.id)}" aria-label="Increase ${escapeAttr(record.character)}">+</button>
                </span>
            </div>
          </article>
        `).join("") || renderEmpty("No records in this series", "Import or add master database records first.")}
      </div>
    `;
  }

  function openAddSingleModal() {
    elements.modalTitle.textContent = "Add Single Doorable";
    elements.modalBody.innerHTML = `
      <form id="add-single-form" class="form-grid">
        <label class="field">
          <span>ID</span>
          <input name="id" type="text" placeholder="Leave blank to create one">
        </label>
        <label class="field">
          <span>Character</span>
          <input name="character" type="text" required>
        </label>
        <label class="field">
          <span>Category</span>
          <select name="category">${db.categories.map((name) => `<option value="${escapeAttr(name)}">${escapeHtml(name)}</option>`).join("")}</select>
        </label>
        <label class="field">
          <span>Series</span>
          <input name="series" type="text" list="series-reference-options" required>
        </label>
        <label class="field">
          <span>Franchise</span>
          <input name="franchise" type="text" required>
        </label>
        <label class="field">
          <span>Rarity</span>
          <select name="rarity">${db.rarities.map((name) => `<option value="${escapeAttr(name)}">${escapeHtml(name)}</option>`).join("")}</select>
        </label>
        <label class="field">
          <span>Image ID</span>
          <input name="imageId" type="text" placeholder="Optional future image key">
        </label>
        <label class="field">
          <span>Owned</span>
          <input name="owned" type="number" min="0" step="1" value="1">
        </label>
        <label class="field">
          <span>Available</span>
          <input name="available" type="number" min="0" step="1" value="0">
        </label>
        <label class="field">
          <span>Sold/reserved</span>
          <input name="soldReserved" type="number" min="0" step="1" value="0">
        </label>
        <label class="checkbox-row full-row">
          <input name="collectionCopy" type="checkbox" checked>
          <span>Mark as collection copy</span>
        </label>
        <div class="form-actions full-row">
          <button class="primary-button" type="submit">Add Doorable</button>
          <button class="secondary-button" type="button" data-close-modal>Cancel</button>
        </div>
        ${renderSeriesDatalist()}
      </form>
    `;
    elements.modal.hidden = false;
  }

  async function closeModal() {
    cleanupImagePackBuilder();
    elements.modal.hidden = true;
    elements.modalBody.innerHTML = "";
    await refreshData();
  }

  function closeFabMenu() {
    elements.fabMenu.hidden = true;
    elements.fabButton.setAttribute("aria-expanded", "false");
  }

  // Data shaping, filtering, and analytics helpers.
  function getMergedRecords() {
    return state.master.map((master) => ({
      ...db.createEmptyCollection(master.id),
      ...state.collectionMap.get(master.id),
      ...master
    }));
  }

  function getCollectionRecord(id) {
    return {
      ...db.createEmptyCollection(id),
      ...state.collectionMap.get(id)
    };
  }

  function getOrphanCollectionRecords(collectionRecords = state.collection, masterRecords = state.master) {
    const masterIds = new Set(masterRecords.map((record) => record.id));
    return collectionRecords.filter((record) => record.id && !masterIds.has(record.id));
  }

  function getMasterName(id) {
    return state.master.find((record) => record.id === id)?.character || "Doorable";
  }

  function getStats(records) {
    const total = records.length;
    const collectionCopies = records.filter((record) => record.collectionCopy).length;

    return {
      total,
      collectionCopies,
      progress: total ? Math.round((collectionCopies / total) * 100) : 0,
      totalOwned: sum(records, "owned"),
      duplicates: records.filter((record) => record.owned > 1).length,
      available: sum(records, "available"),
      soldReserved: sum(records, "soldReserved"),
      whatnotListed: records.filter((record) => record.listedWhatnot).length,
      ebayListed: records.filter((record) => record.listedEbay).length,
      unlisted: records.filter((record) => record.available > 0 && !record.listedWhatnot && !record.listedEbay).length
    };
  }

  function getSeriesStats(records) {
    const total = records.length;
    const collected = records.filter((record) => record.collectionCopy).length;
    const missing = total - collected;

    return {
      total,
      collected,
      missing,
      percent: total ? Math.round((collected / total) * 100) : 0
    };
  }

  function applySearch(records) {
    const query = state.search.toLowerCase();
    if (!query) {
      return records;
    }

    return records.filter((record) => [
      record.character,
      record.series,
      record.franchise,
      record.rarity
    ].some((value) => String(value || "").toLowerCase().includes(query)));
  }

  function filterCollectionRecords(records) {
    if (state.collectionFilter === "Owned") {
      return records.filter((record) => record.owned > 0);
    }

    if (state.collectionFilter === "Missing") {
      return records.filter((record) => !record.collectionCopy);
    }

    if (state.collectionFilter === "Duplicates") {
      return records.filter((record) => record.owned > 1);
    }

    if (state.collectionFilter === "For Sale") {
      return records.filter((record) => record.available > 0);
    }

    return records;
  }

  function filterInventoryRecords(records) {
    if (state.inventoryFilter === "Available") {
      return records.filter((record) => record.available > 0);
    }

    if (state.inventoryFilter === "Sold/Reserved") {
      return records.filter((record) => record.soldReserved > 0);
    }

    if (state.inventoryFilter === "Whatnot Listed") {
      return records.filter((record) => record.listedWhatnot);
    }

    if (state.inventoryFilter === "eBay Listed") {
      return records.filter((record) => record.listedEbay);
    }

    if (state.inventoryFilter === "Unlisted") {
      return records.filter((record) => record.available > 0 && !record.listedWhatnot && !record.listedEbay);
    }

    return records.filter((record) => record.owned > 0 || record.available > 0 || record.soldReserved > 0);
  }

  function filterDatabaseRecords(records) {
    return records.filter((record) => {
      return (!state.dbFilters.category || record.category === state.dbFilters.category) &&
        (!state.dbFilters.series || record.series === state.dbFilters.series) &&
        (!state.dbFilters.franchise || record.franchise === state.dbFilters.franchise) &&
        (!state.dbFilters.rarity || record.rarity === state.dbFilters.rarity);
    });
  }

  function sortDatabaseRecords(records) {
    if (state.dbFilters.sort === "seriesFranchiseCharacter") {
      return records.sort(compareSeriesFranchiseCharacter);
    }

    if (state.dbFilters.sort === "owned") {
      return records.sort((a, b) => b.owned - a.owned || compareSeriesFranchiseCharacter(a, b));
    }

    if (state.dbFilters.sort === "category") {
      return records.sort((a, b) => compareValuesByReference(a.category, b.category, db.categories) || compareSeriesFranchiseCharacter(a, b));
    }

    if (state.dbFilters.sort === "series") {
      return records.sort((a, b) => compareValuesByReference(a.series, b.series, getAllReferenceSeries()) || compareFranchiseCharacter(a, b));
    }

    if (state.dbFilters.sort === "rarity") {
      return records.sort((a, b) => compareValuesByReference(a.rarity, b.rarity, db.rarities) || compareSeriesFranchiseCharacter(a, b));
    }

    return records.sort(compareBy(state.dbFilters.sort));
  }

  function sortRecordsWithinSeries(records) {
    return [...records].sort(compareFranchiseCharacter);
  }

  function compareSeriesFranchiseCharacter(a, b) {
    return compareValuesByReference(a.series, b.series, getAllReferenceSeries()) ||
      compareFranchiseCharacter(a, b);
  }

  function compareFranchiseCharacter(a, b) {
    return compareText(a.franchise, b.franchise) ||
      compareText(a.character, b.character) ||
      compareText(a.id, b.id);
  }

  // Reference-aware ordering keeps official categories and series in a stable
  // collector-friendly order, while still allowing future imported values.
  function getAllReferenceSeries() {
    return typeof db.getAllSeries === "function"
      ? db.getAllSeries()
      : Object.values(db.seriesByCategory || {}).flat();
  }

  function getSeriesOptions(records, category = "", includeReference = false) {
    const existing = uniqueValues(records, "series");
    const hasKnownCategory = Boolean(category && db.seriesByCategory[category]);
    const reference = hasKnownCategory ? db.seriesByCategory[category] : getAllReferenceSeries();

    if (includeReference && (!category || hasKnownCategory)) {
      return mergeReferenceOptions(reference, existing);
    }

    return sortByReference(existing, reference);
  }

  function sortCategories(values) {
    return sortByReference(values, db.categories);
  }

  function sortSeriesNames(values, category = "") {
    const reference = category && db.seriesByCategory[category]
      ? db.seriesByCategory[category]
      : getAllReferenceSeries();
    return sortByReference(values, reference);
  }

  function sortByReference(values, referenceItems) {
    return [...new Set(values.filter(Boolean))].sort((a, b) => compareValuesByReference(a, b, referenceItems));
  }

  function mergeReferenceOptions(referenceItems, existingItems) {
    const reference = [...new Set(referenceItems.filter(Boolean))];
    const referenceSet = new Set(reference);
    const unknown = [...new Set(existingItems.filter(Boolean))]
      .filter((value) => !referenceSet.has(value))
      .sort();

    return [...reference, ...unknown];
  }

  function withCurrentOption(options, currentValue) {
    return mergeReferenceOptions(options, currentValue ? [currentValue] : []);
  }

  function compareValuesByReference(a, b, referenceItems) {
    const referenceIndex = new Map(referenceItems.map((value, index) => [value, index]));
    const aValue = String(a || "");
    const bValue = String(b || "");
    const aBlank = !aValue.trim();
    const bBlank = !bValue.trim();

    if (aBlank && bBlank) {
      return 0;
    }

    if (aBlank) {
      return 1;
    }

    if (bBlank) {
      return -1;
    }

    const aKnown = referenceIndex.has(aValue);
    const bKnown = referenceIndex.has(bValue);

    if (aKnown && bKnown) {
      return referenceIndex.get(aValue) - referenceIndex.get(bValue);
    }

    if (aKnown) {
      return -1;
    }

    if (bKnown) {
      return 1;
    }

    return compareText(aValue, bValue);
  }

  function groupBy(records, key) {
    return records.reduce((groups, record) => {
      const value = record[key] || "Unsorted";
      groups[value] = groups[value] || [];
      groups[value].push(record);
      return groups;
    }, {});
  }

  function uniqueValues(records, key) {
    return [...new Set(records.map((record) => record[key]).filter(Boolean))].sort();
  }

  function compareBy(key) {
    return (a, b) => compareText(a[key], b[key]);
  }

  function compareText(a, b) {
    const aValue = String(a || "").trim();
    const bValue = String(b || "").trim();
    const aBlank = !aValue;
    const bBlank = !bValue;

    if (aBlank && bBlank) {
      return 0;
    }

    if (aBlank) {
      return 1;
    }

    if (bBlank) {
      return -1;
    }

    return aValue.localeCompare(bValue, undefined, {
      sensitivity: "base",
      numeric: true
    });
  }

  function sum(records, key) {
    return records.reduce((total, record) => total + toNumber(record[key]), 0);
  }

  function readFieldValue(field) {
    if (field.type === "checkbox") {
      return field.checked;
    }

    if (field.type === "number") {
      return toNumber(field.value);
    }

    return field.value;
  }

  // Formatting and DOM utility helpers.
  function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function initials(text) {
    const words = String(text || "DV").split(/\s+/).filter(Boolean);
    return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase();
  }

  function makeId(text) {
    const slug = String(text || "doorable")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);

    return `${slug || "doorable"}-${Date.now().toString(36)}`;
  }

  function formatDateTime(value) {
    if (!value) {
      return "";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }

    return date.toLocaleString([], {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
  }

  function formatDateOnly(value) {
    if (!value) {
      return "";
    }

    const parts = String(value).split("-");
    if (parts.length === 3) {
      const date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
      if (!Number.isNaN(date.getTime())) {
        return date.toLocaleDateString([], {
          year: "numeric",
          month: "short",
          day: "numeric"
        });
      }
    }

    return value;
  }

  function formatIdList(ids, limit = 100) {
    const uniqueIds = [...new Set(ids.filter(Boolean))];
    const lines = uniqueIds.slice(0, limit).map((id) => `- ${id}`);
    if (uniqueIds.length > limit) {
      lines.push(`...and ${uniqueIds.length - limit} more.`);
    }

    return lines;
  }

  function formatBytes(value) {
    if (!value) {
      return "0 B";
    }

    const units = ["B", "KB", "MB", "GB"];
    let size = value;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }

    return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.hidden = false;
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => {
      elements.toast.hidden = true;
    }, 3200);
  }
})();
