(function () {
  "use strict";

  const db = window.DoorablesDB;
  const APP_VERSION = "1.1.0";
  const IMAGE_FILE_TYPES = ["image/jpeg", "image/png", "image/webp"];
  const IMAGE_FILE_EXTENSIONS = ".jpg,.jpeg,.png,.webp";
  const MAX_IMAGE_DIMENSION = 900;
  const MAX_IMAGE_BYTES = 900 * 1024;
  const IMAGE_JPEG_QUALITY = 0.84;

  // App state stays centralized for v1.1.0. Rendering reads from this object only.
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
  let updatePromptShown = false;
  let refreshingForUpdate = false;

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
        <div class="section-title-row"><h3>About / Version</h3></div>
        <div class="stat-grid">
          ${renderStat("App Name", "Doorables Vault")}
          ${renderStat("Version", APP_VERSION)}
          ${renderStat("Storage Type", "IndexedDB")}
          ${renderStat("Offline Status", state.isOnline ? "Online" : "Offline")}
          ${renderStat("Last Backup Date", state.storage.lastBackupDate ? formatDateTime(state.storage.lastBackupDate) : "No backup recorded")}
        </div>
      </section>

      <section class="section-band">
        <div class="section-title-row"><h3>Master Database Import / Export</h3></div>
        <div class="form-actions">
          <button class="primary-button" type="button" data-settings-action="import-master">Import Master Database JSON</button>
          <button class="primary-button" type="button" data-settings-action="import-master-csv">Import Master Database CSV</button>
          <button class="secondary-button" type="button" data-settings-action="export-master">Export Master Database JSON</button>
        </div>
      </section>

      <section class="section-band">
        <div class="section-title-row"><h3>Collection JSON</h3></div>
        <div class="form-actions">
          <button class="primary-button" type="button" data-settings-action="import-collection">Import Collection JSON</button>
          <button class="secondary-button" type="button" data-settings-action="export-collection">Export Collection JSON</button>
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
        <div class="section-title-row"><h3>Delete All Local Vault Data</h3></div>
        <p class="muted small">This permanently deletes the master database, collection data, activity history, images, and settings/meta data stored in IndexedDB on this device.</p>
        <div class="form-actions">
          <button class="danger-button" type="button" data-settings-action="clear-data">Delete All Local Vault Data</button>
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
      await exportJson("doorables-collection.json", await db.exportCollection());
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

  // Import and export actions.
  async function pickAndImport(type) {
    try {
      const file = await pickJsonFile();
      if (!file) {
        return;
      }

      const json = JSON.parse(await file.text());
      const validation = validateImportPayload(type, json);
      if (!validation.ok) {
        showImportValidationReport(type, validation);
        return;
      }

      if (validation.warningRows.length && !confirmImportWarnings(type, validation)) {
        showToast("Import canceled.");
        return;
      }

      const mode = askImportMode(type, validation.records);
      if (!mode) {
        showToast("Import canceled.");
        return;
      }

      const count = type === "master" ? await db.importMaster(json, mode) : await db.importCollection(json, mode);
      await refreshData();
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
      lines.push("", "Orphan collection IDs not found in the master database:");
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
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    state.storage.lastBackupDate = await db.recordBackupExport();
    state.storage.counts = await db.getStorageStats();
    if (state.tab === "settings") {
      render();
    }
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
