# Doorables Vault

Doorables Vault is a standalone offline-first Progressive Web App for tracking a personal Disney Doorables collection and inventory.

Current release: Version 1.3.0.

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
- `db.js` - IndexedDB setup, seed data, validation, reference data, and local image blob storage
- `zip-utils.js` - local offline ZIP reader/writer used for image packs and full vault backups
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
- `images` - individual uploaded image blobs linked by master record `imageId`
- `meta` - settings flags such as sample-data seeding and last backup/export date

Clearing browser site data for this app will remove the local vault data.

## How to Back Up Data

Use the Settings tab export options:

- Export Master Database JSON
- Export Collection JSON
- Export Image Pack ZIP
- Export Full Vault Backup

Export collection data before deleting local vault data or replacing collection data. Export master database data before replacing the master database.

Store backups somewhere safe, such as Google Drive, OneDrive, Dropbox, or an external drive.

IndexedDB data lives inside the browser. It does not automatically travel with the project folder, GitHub repository, or ZIP file. Copying the app folder moves the app files, not your browser's saved collection data.

Individual images are also stored locally in IndexedDB. Master and collection JSON exports do not include image blobs. Use Export Full Vault Backup when you need to move everything, including images, to another browser or device.

To move the complete vault to another device, use Settings > Export Full Vault Backup on the old device, then Settings > Import Full Vault Backup on the new device.

## What Not To Delete

Do not delete or lose these app files:

- `index.html`
- `app.js`
- `db.js`
- `styles.css`
- `manifest.json`
- `service-worker.js`
- `zip-utils.js`
- `icons/icon-192.png`
- `icons/icon-512.png`

Do not delete or lose these personal backup files:

- Exported collection backups
- Exported master database backups
- Full Vault Backup ZIP files
- Image Pack ZIP exports

Copying the app folder is useful for moving or hosting the app, but it does not copy IndexedDB data from the browser. Use Full Vault Backup to move collection data and images between devices.

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

Collection exports skip orphan collection records by default. Orphan collection records are ownership or inventory rows whose IDs no longer exist in the current master database, usually after replacing the master database. The export summary lists any skipped IDs. Use Settings > Maintenance > Remove Orphan Collection Records to delete only those orphan collection rows after confirmation.

Collection imports still block orphan IDs by default. If a collection file contains both valid records and orphan records, the app can optionally import only the valid records and show a summary of skipped orphan IDs.

## Full Vault Backup and Restore

Use Settings > Export Full Vault Backup to create one ZIP file containing:

- `master_database.json`
- `collection.json`
- `activity.json`
- `settings.json`
- `reference_data.json`
- `metadata.json`
- `images/`
- `images/image_manifest.json`

Use Settings > Import Full Vault Backup to restore that ZIP on the same browser or another device. Restore validates the backup first, shows a preview, warns that current local data will be replaced, and requires typing `RESTORE`.

Export a Full Vault Backup before destructive actions such as deleting all local data, replacing data, or cleaning up orphan records.

## Category and Series Reference Data

Official category order, rarity order, and series-by-category order are defined in `db.js` near the top of the file. The `categories`, `rarities`, and `seriesByCategory` constants drive app navigation, dropdown suggestions, filters, import validation warnings, Collection grouping, Smart Bulk Mode ordering, and Analytics grouping.

To add a future series, add its name to the correct category array in `seriesByCategory`. New imported categories or series that are not in this reference list are allowed only after a warning confirmation, then they appear after official values in filters and groups.

## Included Sample Data

The app seeds 17 sample records across Main Series, Mini Peeks, Star Wars, Marvel, and Holidays so the dashboard, filters, inventory, analytics, and bulk mode can be tested immediately.

Use Settings > Delete All Local Vault Data to remove all local data from the browser after typing the required confirmation.

## Image Support

Version 1.3.0 supports individual image upload from each Doorable detail page. Images are stored as blobs in the local IndexedDB `images` store and linked to Doorables by the master record `imageId`.

Supported image file types are JPG, JPEG, PNG, and WEBP. Large images may be resized before storage to keep the app responsive on mobile devices.

Removing an image deletes only the stored image blob. It does not delete the Doorable, collection quantities, notes, listing status, or master database record.

### Importing an Image Pack ZIP

Use Settings > Images > Import Image Pack ZIP.

Image files should be named by `imageId`, for example:

```text
MS-S04-001.webp
CP-DP-001.png
SW-GP1-001.jpg
```

The app strips the file extension, matches the remaining name to master database `imageId` values, imports matching images, reports unsupported files, and reports orphan image files that do not match the current master database.

### Exporting an Image Pack ZIP

Use Settings > Images > Export Image Pack ZIP to export stored images as:

```text
doorables_images_export_YYYY-MM-DD.zip
```

The ZIP includes image files plus `image_manifest.json`.

### Building an Image Pack ZIP

Use Settings > Images > Build Image Pack when you have image files that need to be renamed to Doorables Vault `imageId` values.

Doorables Vault image pack imports expect image files to be named by `imageId`, for example:

```text
MS-S04-001.webp
CP-DP-001.jpg
OT-DPV-004.png
SW-GP1-001.webp
```

The Image Pack Builder creates a new ZIP with correctly renamed copies. It does not rename, move, overwrite, or modify the original files on your computer.

Recommended workflow:

1. Select the category and series for the image batch.
2. Upload JPG, JPEG, PNG, or WEBP image files.
3. Assign each uploaded image to a Doorable manually, or upload a mapping CSV.
4. Review the validation summary.
5. Export `doorables_image_pack_YYYY-MM-DD.zip`.

Manual assignment searches only within the selected series by default. Matches show character, franchise, rarity, and `imageId`.

For large batches, upload a mapping CSV with this header:

```csv
originalFileName,imageId
IMG_4938.jpg,OT-DPV-004
IMG_4939.jpg,OT-DPV-001
```

The CSV maps each uploaded original filename to the Doorables Vault `imageId`. The builder warns about duplicate `imageId` assignments, invalid `imageId` values, uploaded images missing from the CSV, and CSV rows where the image file was not uploaded.

Use All Series mode only when one image batch intentionally spans more than one series. All Series mode searches the full master database and is easier to mismatch.

After exporting the generated ZIP, import it with Settings > Images > Import Image Pack ZIP.

### Orphan Image Cleanup

Use Settings > Images > Remove Orphan Images to find image blobs whose `imageId` no longer exists in the current master database. Cleanup requires confirmation and deletes only orphan images. Export a Full Vault Backup first if you want a copy before cleanup.
