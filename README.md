# Doorables Vault

Doorables Vault is a standalone offline-first Progressive Web App for tracking a personal Disney Doorables collection and inventory.

There is no backend, account system, cloud database, Firebase, Supabase, Base44 service, external API, CDN dependency, paid service, or subscription.

## What Doorables Vault Is

- A personal Disney Doorables collection and inventory tracker
- Offline-first and designed to run locally in your browser
- Stored locally with IndexedDB inside the browser profile
- Built with HTML, CSS, vanilla JavaScript, IndexedDB, a service worker, and a web app manifest
- Self-contained: no backend, account, cloud database, or subscription required

## Project Files

- `index.html` - app shell and PWA metadata
- `styles.css` - mobile-first dark UI
- `app.js` - screens, filters, search, editing, import/export, and bulk mode
- `db.js` - IndexedDB setup, seed data, validation, reference data, and image blob stubs
- `service-worker.js` - offline cache for app files
- `manifest.json` - installable PWA manifest
- `icons/icon-192.png` and `icons/icon-512.png` - local PWA icons
- `README.md` - this guide

## How to Run Locally

1. Open a terminal, PowerShell, or command prompt.
2. Change into the Doorables Vault project folder, or open the terminal directly in that folder.
3. Start a local web server:

```bash
python -m http.server 8000
```

4. Open this address in your browser:

```text
http://localhost:8000
```

A local server is recommended because service workers do not run correctly from a normal `file://` browser tab.

## How to Host Temporarily on GitHub Pages

1. Create a GitHub repository.
2. Upload all Doorables Vault app files.
3. Keep `index.html` in the repository root.
4. In GitHub, go to the repository Settings.
5. Open Pages.
6. Choose Deploy from a branch.
7. Select the `main` branch and the root folder.
8. Save, then open the GitHub Pages URL after it finishes deploying.

GitHub Pages only hosts the static app files. Your collection data still lives in each browser's IndexedDB unless you export and import it.

## How to Install on Android Chrome

1. Open the hosted app URL in Chrome on Android.
2. Tap the three-dot menu.
3. Tap Install App or Add to Home Screen.
4. Confirm installation.
5. Open Doorables Vault from the installed icon.

Install App is preferred when Chrome offers it because it behaves more like a standalone app than a simple home-screen shortcut.

## Local Data Storage

Doorables Vault stores data locally in IndexedDB on the current device and browser profile.

IndexedDB stores:

- `master` - master Doorables database records
- `collection` - personal collection and inventory records
- `activity` - local activity history
- `images` - placeholder store for future image blobs
- `meta` - settings flags such as sample-data seeding and last backup/export date

Clearing browser site data for this app will remove the local vault data.

## How to Back Up Data

Use the Settings tab export options:

- Export Master Database JSON
- Export Collection JSON

Export collection data before deleting local vault data or replacing collection data. Export master database data before replacing the master database.

Store backups somewhere safe, such as Google Drive, OneDrive, Dropbox, or an external drive.

IndexedDB data lives inside the browser. It does not automatically travel with the project folder, GitHub repository, or ZIP file. Copying the app folder moves the app files, not your browser's saved collection data.

To move collection data to another device, export data from Settings on the old device, then import it from Settings on the new device.

## What Not To Delete

Do not delete or lose these app files:

- `index.html`
- `app.js`
- `db.js`
- `styles.css`
- `manifest.json`
- `service-worker.js`
- `icons/icon-192.png`
- `icons/icon-512.png`

Do not delete or lose these personal backup files:

- Exported collection backups
- Exported master database backups

Copying the app folder is useful for moving or hosting the app, but it does not copy IndexedDB data from the browser. Use Settings export/import to move collection data between devices.

## Import and Export

Use the Settings tab to import or export JSON.

Master database imports support JSON and CSV. CSV files must use this exact header row and column order:

```csv
id,category,series,character,franchise,rarity,imageId
```

Each CSV row is converted into a master database record and validated before import. The app shows total rows, valid rows, and invalid rows before allowing merge or replace. Invalid CSV rows must be fixed before importing.

Official rarity values are:

- Common
- Rare
- Ultra Rare
- Special Edition
- Limited Edition
- Exclusive
- Bonus
- Not Applicable

Master database record shape:

```json
{
  "id": "",
  "category": "",
  "series": "",
  "character": "",
  "franchise": "",
  "rarity": "",
  "imageId": ""
}
```

Collection record shape:

```json
{
  "id": "",
  "collectionCopy": false,
  "owned": 0,
  "personalCollection": 0,
  "available": 0,
  "soldReserved": 0,
  "listedWhatnot": false,
  "listedEbay": false,
  "notes": "",
  "dateAdded": "",
  "lastModified": ""
}
```

The `id` in a collection record must match a master database record ID.

Merge imports add new records and update matching IDs without deleting unrelated existing records. Replace imports delete the existing data of that type before importing the file, so export a backup first.

## Category and Series Reference Data

Official category order, rarity order, and series-by-category order are defined in `db.js` near the top of the file. The `categories`, `rarities`, and `seriesByCategory` constants drive app navigation, dropdown suggestions, filters, import validation warnings, Collection grouping, Smart Bulk Mode ordering, and Analytics grouping.

To add a future series, add its name to the correct category array in `seriesByCategory`. New imported categories or series that are not in this reference list are allowed only after a warning confirmation, then they appear after official values in filters and groups.

## Included Sample Data

The app seeds 17 sample records across Main Series, Mini Peeks, Star Wars, Marvel, and Holidays so the dashboard, filters, inventory, analytics, and bulk mode can be tested immediately.

Use Settings > Delete All Local Vault Data to remove all local data from the browser after typing the required confirmation.

## Image Support

Version 1 uses image placeholders and stores the `imageId` field on master records. `db.js` includes safe placeholder functions for future IndexedDB image blob storage:

- `saveImageBlob(imageId, blob)`
- `getImageBlob(imageId)`
- `deleteImageBlob(imageId)`

ZIP image pack import is intentionally left as a placeholder action for a later version.
