# Doorables Vault

Doorables Vault is a standalone offline-first Progressive Web App for tracking a personal Disney Doorables collection and inventory. It uses only HTML, CSS, vanilla JavaScript, IndexedDB, a service worker, and a web app manifest.

There is no backend, account system, cloud database, Firebase, Supabase, Base44 service, external API, or paid service.

## Files

- `index.html` - app shell and PWA metadata
- `styles.css` - mobile-first dark UI
- `app.js` - screen rendering, filters, search, editing, import/export, bulk mode
- `db.js` - IndexedDB setup, seed data, import/export helpers, image blob stubs
- `service-worker.js` - offline cache for app files
- `manifest.json` - installable PWA manifest
- `README.md` - setup and usage notes

## Run Locally

From this folder, start a local web server:

```bash
python -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

A local server is recommended because service workers do not run from a normal `file://` browser tab.

## Install as a PWA

1. Open `http://localhost:8000` in Chrome, Edge, or another PWA-capable browser.
2. Look for the install icon in the address bar or open the browser menu.
3. Choose Install or Add to Home Screen.
4. Launch Doorables Vault from the installed app icon.

After the first successful load, the service worker caches the app shell for offline use.

## Local Data Storage

Doorables Vault stores data locally in IndexedDB on the current device and browser profile.

IndexedDB stores:

- `master` - master Doorables database records
- `collection` - personal collection and inventory records
- `activity` - local activity history
- `images` - placeholder store for future image blobs
- `meta` - setup flags such as sample data seeding

Clearing browser site data for this app will remove the local vault data. Use Settings export buttons before clearing browser data or moving to another device.

## Import and Export

Use the Settings tab to import or export JSON.

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

The `id` in a collection record should match a master database record ID.

## Included Sample Data

The app seeds 17 sample records across Main Series, Mini Peeks, Star Wars, Marvel, and Holidays so the dashboard, filters, inventory, analytics, and bulk mode can be tested immediately.

Use Settings > Delete All Local Vault Data to remove all local data from the browser after typing the required confirmation.

## Image Support

Version 1 uses image placeholders and stores the `imageId` field on master records. `db.js` includes safe placeholder functions for future IndexedDB image blob storage:

- `saveImageBlob(imageId, blob)`
- `getImageBlob(imageId)`
- `deleteImageBlob(imageId)`

ZIP image pack import is intentionally left as a placeholder action for a later version.
