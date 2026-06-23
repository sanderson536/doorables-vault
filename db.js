(function () {
  "use strict";

  const DB_NAME = "doorables-vault-db";
  const DB_VERSION = 1;

  // IndexedDB schema: one store for each durable local data category.
  // Master and collection share the same id so inventory can be joined locally.
  // Meta holds small settings flags such as seeding state and last backup time.
  const STORES = {
    master: "master",
    collection: "collection",
    activity: "activity",
    images: "images",
    meta: "meta"
  };

  const rarities = [
    "Common",
    "Rare",
    "Ultra Rare",
    "Special Edition",
    "Limited Edition",
    "Exclusive",
    "Bonus",
    "Not Applicable"
  ];

  // Official reference data controls navigation, dropdowns, filters,
  // import validation warnings, and category/series ordering throughout the app.
  const categories = [
    "Main Series",
    "Mini Peeks",
    "Collection Peeks",
    "Other",
    "Sets",
    "Holidays",
    "Marvel",
    "Star Wars"
  ];

  const seriesByCategory = {
    "Main Series": [
      "Series 1",
      "Series 2",
      "Series 3",
      "Series 4",
      "Series 5",
      "Series 6",
      "Series 7",
      "Series 8",
      "Series 9",
      "Series 10",
      "Series 11 (Technicolor)",
      "Series 12 (Pixel Perfect)",
      "Series 13 (Remember When)",
      "Series 14 (Let's Party)",
      "Series 15 (In Full Bloom)",
      "Series 16 (Ticket to Fun)"
    ],
    "Mini Peeks": [
      "Fuzzified",
      "Gravity Falls",
      "The Muppets Black Light",
      "Neon Pop",
      "Nightmare Before Christmas Black Light",
      "Lilo and Stitch Black Light",
      "Lilo and Stitch Flocked",
      "Villains Black Light",
      "Winnie the Pooh Flocked"
    ],
    "Collection Peeks": [
      "WDW 50th",
      "A Goofy Movie",
      "Disney Parks",
      "Encanto",
      "Gold Peek",
      "The Haunted Mansion",
      "Hercules",
      "The Incredibles",
      "Inside Out 2",
      "The Little Mermaid",
      "Mickey's Christmas Carol",
      "Mickey's Years of Ears",
      "Moana 2",
      "The Muppets",
      "Nightmare Before Christmas Glow",
      "Nightmare Before Christmas",
      "Nightmare Before Christmas 30th Anniversary",
      "Nightmare Before Christmas Tim Burton",
      "Olaf Presents",
      "Pixar Fest",
      "Princess Glitter and Gold",
      "Toy Story Sid's Toy Box",
      "Snow White",
      "Lilo and Stitch",
      "Lilo and Stitch Experiments",
      "Treasures From The Vault",
      "Up",
      "Villains",
      "Villains 2",
      "Villains Rivaling Royals",
      "Wish"
    ],
    "Other": [
      "Academy",
      "Academy Lockers",
      "Adoorbs",
      "Costume Cuties Series 1",
      "Disney Parks Vehicles",
      "Doorway to Magic",
      "Let's Go Series 1",
      "Let's Go Series 2",
      "Let's Go Exclusive",
      "Let's Go Vehicles Series 1",
      "Let's Go Vehicles Series 2",
      "Let's Go Vehicles Series 3",
      "Micro Motion",
      "Movie Moments Series 1",
      "Movie Moments Series 2",
      "Movie Moments Series 3",
      "Neon Glow"
    ],
    "Sets": [
      "Celebration of Wonder",
      "Playsets"
    ],
    "Holidays": [
      "Advent Calendar 2024",
      "Advent Calendar 2025",
      "Nightmare Before Christmas Advent Calendar 2025",
      "Easter 2022",
      "Easter 2023",
      "Easter 2024",
      "Easter 2025",
      "Easter 2026",
      "Halloween 2025",
      "Valentine's Day 2025",
      "Valentine's Day 2026"
    ],
    "Marvel": [
      "Marvel Series 1",
      "Marvel Series 2",
      "Fantastic 4"
    ],
    "Star Wars": [
      "Star Wars Galaxy Peek Series 1",
      "Star Wars Galaxy Peek Series 2",
      "Star Wars Galaxy Peek Series 3",
      "Star Wars Galaxy Peek Series 4",
      "Star Wars Galaxy Peek Series 5",
      "Star Wars Hyper Peek",
      "Star Wars Galactic Cruisers Series 1",
      "Star Wars Galactic Cruisers Series 2",
      "Star Wars Galactic Cruisers Series 3",
      "Grogu Moments",
      "Ewok Village",
      "Star Wars Episode I",
      "Star Wars Episode III",
      "Star Wars Dark Side",
      "Star Wars Wide Screen Movie Moments",
      "Star Wars Holograms",
      "Star Wars Jedi vs. Sith",
      "Starfighter Showdown"
    ]
  };

  const masterKeys = ["id", "category", "series", "character", "franchise", "rarity", "imageId"];
  const collectionKeys = [
    "id",
    "collectionCopy",
    "owned",
    "personalCollection",
    "available",
    "soldReserved",
    "listedWhatnot",
    "listedEbay",
    "notes",
    "dateAdded",
    "lastModified"
  ];

  let dbPromise;

  const sampleMaster = [
    {
      id: "sample-main-s1-mickey-mouse",
      category: "Main Series",
      series: "Series 1",
      character: "Mickey Mouse",
      franchise: "Mickey and Friends",
      rarity: "Common",
      imageId: "sample-mickey"
    },
    {
      id: "sample-main-s1-minnie-mouse",
      category: "Main Series",
      series: "Series 1",
      character: "Minnie Mouse",
      franchise: "Mickey and Friends",
      rarity: "Rare",
      imageId: "sample-minnie"
    },
    {
      id: "sample-main-s1-stitch",
      category: "Main Series",
      series: "Series 1",
      character: "Stitch",
      franchise: "Lilo and Stitch",
      rarity: "Ultra Rare",
      imageId: "sample-stitch"
    },
    {
      id: "sample-main-s1-elsa",
      category: "Main Series",
      series: "Series 1",
      character: "Elsa",
      franchise: "Frozen",
      rarity: "Special Edition",
      imageId: "sample-elsa"
    },
    {
      id: "sample-main-s1-moana",
      category: "Main Series",
      series: "Series 1",
      character: "Moana",
      franchise: "Moana",
      rarity: "Common",
      imageId: "sample-moana"
    },
    {
      id: "sample-main-s2-simba",
      category: "Main Series",
      series: "Series 2",
      character: "Simba",
      franchise: "The Lion King",
      rarity: "Common",
      imageId: "sample-simba"
    },
    {
      id: "sample-main-s2-ariel",
      category: "Main Series",
      series: "Series 2",
      character: "Ariel",
      franchise: "The Little Mermaid",
      rarity: "Rare",
      imageId: "sample-ariel"
    },
    {
      id: "sample-main-s2-olaf",
      category: "Main Series",
      series: "Series 2",
      character: "Olaf",
      franchise: "Frozen",
      rarity: "Common",
      imageId: "sample-olaf"
    },
    {
      id: "sample-main-s2-mirabel",
      category: "Main Series",
      series: "Series 2",
      character: "Mirabel",
      franchise: "Encanto",
      rarity: "Ultra Rare",
      imageId: "sample-mirabel"
    },
    {
      id: "sample-minipeeks-villains-maleficent",
      category: "Mini Peeks",
      series: "Villains Black Light",
      character: "Maleficent",
      franchise: "Sleeping Beauty",
      rarity: "Limited Edition",
      imageId: "sample-maleficent"
    },
    {
      id: "sample-minipeeks-villains-ursula",
      category: "Mini Peeks",
      series: "Villains Black Light",
      character: "Ursula",
      franchise: "The Little Mermaid",
      rarity: "Rare",
      imageId: "sample-ursula"
    },
    {
      id: "sample-minipeeks-villains-scar",
      category: "Mini Peeks",
      series: "Villains Black Light",
      character: "Scar",
      franchise: "The Lion King",
      rarity: "Common",
      imageId: "sample-scar"
    },
    {
      id: "sample-starwars-galaxy-grogu",
      category: "Star Wars",
      series: "Star Wars Galaxy Peek Series 1",
      character: "Grogu",
      franchise: "The Mandalorian",
      rarity: "Special Edition",
      imageId: "sample-grogu"
    },
    {
      id: "sample-starwars-galaxy-vader",
      category: "Star Wars",
      series: "Star Wars Galaxy Peek Series 1",
      character: "Darth Vader",
      franchise: "Star Wars",
      rarity: "Ultra Rare",
      imageId: "sample-vader"
    },
    {
      id: "sample-marvel-avengers-spiderman",
      category: "Marvel",
      series: "Marvel Series 1",
      character: "Spider-Man",
      franchise: "Marvel",
      rarity: "Rare",
      imageId: "sample-spiderman"
    },
    {
      id: "sample-marvel-avengers-ironman",
      category: "Marvel",
      series: "Marvel Series 1",
      character: "Iron Man",
      franchise: "Marvel",
      rarity: "Common",
      imageId: "sample-ironman"
    },
    {
      id: "sample-holiday-jack-skellington",
      category: "Holidays",
      series: "Halloween 2025",
      character: "Jack Skellington",
      franchise: "The Nightmare Before Christmas",
      rarity: "Special Edition",
      imageId: "sample-jack"
    }
  ];

  const sampleCollection = [
    {
      id: "sample-main-s1-mickey-mouse",
      collectionCopy: true,
      owned: 2,
      personalCollection: 1,
      available: 1,
      soldReserved: 0,
      listedWhatnot: true,
      listedEbay: false,
      notes: "Extra copy ready for a live sale.",
      dateAdded: "2026-01-03",
      lastModified: "2026-01-03T14:30:00.000Z"
    },
    {
      id: "sample-main-s1-minnie-mouse",
      collectionCopy: true,
      owned: 1,
      personalCollection: 1,
      available: 0,
      soldReserved: 0,
      listedWhatnot: false,
      listedEbay: false,
      notes: "",
      dateAdded: "2026-01-04",
      lastModified: "2026-01-04T15:10:00.000Z"
    },
    {
      id: "sample-main-s1-elsa",
      collectionCopy: true,
      owned: 1,
      personalCollection: 1,
      available: 0,
      soldReserved: 0,
      listedWhatnot: false,
      listedEbay: false,
      notes: "Favorite shelf display.",
      dateAdded: "2026-01-05",
      lastModified: "2026-01-05T15:10:00.000Z"
    },
    {
      id: "sample-main-s1-moana",
      collectionCopy: false,
      owned: 1,
      personalCollection: 0,
      available: 1,
      soldReserved: 0,
      listedWhatnot: false,
      listedEbay: false,
      notes: "Inventory copy only.",
      dateAdded: "2026-01-09",
      lastModified: "2026-01-09T15:10:00.000Z"
    },
    {
      id: "sample-main-s2-simba",
      collectionCopy: true,
      owned: 3,
      personalCollection: 1,
      available: 2,
      soldReserved: 0,
      listedWhatnot: false,
      listedEbay: true,
      notes: "",
      dateAdded: "2026-02-02",
      lastModified: "2026-02-02T11:20:00.000Z"
    },
    {
      id: "sample-main-s2-ariel",
      collectionCopy: true,
      owned: 1,
      personalCollection: 1,
      available: 0,
      soldReserved: 0,
      listedWhatnot: false,
      listedEbay: false,
      notes: "",
      dateAdded: "2026-02-03",
      lastModified: "2026-02-03T12:20:00.000Z"
    },
    {
      id: "sample-main-s2-olaf",
      collectionCopy: false,
      owned: 2,
      personalCollection: 0,
      available: 1,
      soldReserved: 1,
      listedWhatnot: false,
      listedEbay: false,
      notes: "One reserved for trade.",
      dateAdded: "2026-02-08",
      lastModified: "2026-02-08T12:20:00.000Z"
    },
    {
      id: "sample-minipeeks-villains-ursula",
      collectionCopy: true,
      owned: 1,
      personalCollection: 1,
      available: 0,
      soldReserved: 0,
      listedWhatnot: false,
      listedEbay: false,
      notes: "",
      dateAdded: "2026-03-11",
      lastModified: "2026-03-11T18:20:00.000Z"
    },
    {
      id: "sample-minipeeks-villains-scar",
      collectionCopy: false,
      owned: 2,
      personalCollection: 0,
      available: 2,
      soldReserved: 0,
      listedWhatnot: false,
      listedEbay: false,
      notes: "Needs listing.",
      dateAdded: "2026-03-13",
      lastModified: "2026-03-13T18:20:00.000Z"
    },
    {
      id: "sample-starwars-galaxy-grogu",
      collectionCopy: true,
      owned: 1,
      personalCollection: 1,
      available: 0,
      soldReserved: 0,
      listedWhatnot: false,
      listedEbay: false,
      notes: "",
      dateAdded: "2026-04-01",
      lastModified: "2026-04-01T10:00:00.000Z"
    },
    {
      id: "sample-marvel-avengers-spiderman",
      collectionCopy: true,
      owned: 2,
      personalCollection: 1,
      available: 1,
      soldReserved: 0,
      listedWhatnot: true,
      listedEbay: true,
      notes: "Cross-listed.",
      dateAdded: "2026-04-12",
      lastModified: "2026-04-12T10:00:00.000Z"
    },
    {
      id: "sample-holiday-jack-skellington",
      collectionCopy: false,
      owned: 1,
      personalCollection: 0,
      available: 0,
      soldReserved: 1,
      listedWhatnot: false,
      listedEbay: false,
      notes: "Reserved for bundle.",
      dateAdded: "2026-05-02",
      lastModified: "2026-05-02T10:00:00.000Z"
    }
  ];

  function openDb() {
    if (dbPromise) {
      return dbPromise;
    }

    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;

        // The first version creates all object stores used by v1.0.
        // Future migrations should only change this block inside version upgrades.
        if (!db.objectStoreNames.contains(STORES.master)) {
          const master = db.createObjectStore(STORES.master, { keyPath: "id" });
          master.createIndex("category", "category", { unique: false });
          master.createIndex("series", "series", { unique: false });
          master.createIndex("franchise", "franchise", { unique: false });
          master.createIndex("rarity", "rarity", { unique: false });
        }

        if (!db.objectStoreNames.contains(STORES.collection)) {
          db.createObjectStore(STORES.collection, { keyPath: "id" });
        }

        if (!db.objectStoreNames.contains(STORES.activity)) {
          const activity = db.createObjectStore(STORES.activity, { keyPath: "id" });
          activity.createIndex("timestamp", "timestamp", { unique: false });
        }

        if (!db.objectStoreNames.contains(STORES.images)) {
          db.createObjectStore(STORES.images, { keyPath: "imageId" });
        }

        if (!db.objectStoreNames.contains(STORES.meta)) {
          db.createObjectStore(STORES.meta, { keyPath: "key" });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    return dbPromise;
  }

  function requestAsPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function readAll(storeName) {
    const db = await openDb();
    return requestAsPromise(db.transaction(storeName, "readonly").objectStore(storeName).getAll());
  }

  async function readOne(storeName, key) {
    const db = await openDb();
    return requestAsPromise(db.transaction(storeName, "readonly").objectStore(storeName).get(key));
  }

  async function writeOne(storeName, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function writeMany(storeName, values) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      values.forEach((value) => store.put(value));
      tx.oncomplete = () => resolve(values.length);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function replaceAll(storeName, values) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      store.clear();
      values.forEach((value) => store.put(value));
      tx.oncomplete = () => resolve(values.length);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function clearStore(storeName) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function countStore(storeName) {
    const db = await openDb();
    return requestAsPromise(db.transaction(storeName, "readonly").objectStore(storeName).count());
  }

  function cleanString(value, fallback) {
    const text = String(value || "").trim();
    return text || fallback;
  }

  function cleanNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) {
      return 0;
    }

    return Math.floor(number);
  }

  function makeLocalId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }

    return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function createEmptyCollection(id) {
    return {
      id,
      collectionCopy: false,
      owned: 0,
      personalCollection: 0,
      available: 0,
      soldReserved: 0,
      listedWhatnot: false,
      listedEbay: false,
      notes: "",
      dateAdded: "",
      lastModified: ""
    };
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function hasExactKeys(record, expectedKeys) {
    const keys = Object.keys(record).sort();
    const expected = [...expectedKeys].sort();
    return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
  }

  function isNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
  }

  function isString(value) {
    return typeof value === "string";
  }

  function isNonNegativeInteger(value) {
    return Number.isInteger(value) && value >= 0;
  }

  function getAllSeries() {
    return categories.flatMap((category) => seriesByCategory[category] || []);
  }

  function isKnownCategory(category) {
    return categories.includes(category);
  }

  function isKnownSeriesForCategory(category, series) {
    return Boolean(seriesByCategory[category] && seriesByCategory[category].includes(series));
  }

  function isKnownSeries(series) {
    return getAllSeries().includes(series);
  }

  function emptyValidationResult(records) {
    return {
      ok: false,
      records: [],
      invalidRows: [
        {
          row: 0,
          id: "",
          errors: [`Import file must be a JSON array. Received ${Array.isArray(records) ? "array" : typeof records}.`]
        }
      ],
      orphanRows: [],
      warningRows: []
    };
  }

  // Import validation is intentionally strict so bad rows are rejected before
  // any IndexedDB writes happen. Exported app JSON should round-trip cleanly.
  function validateMasterRecords(records) {
    if (!Array.isArray(records)) {
      return emptyValidationResult(records);
    }

    const seenIds = new Set();
    const invalidRows = [];
    const warningRows = [];
    const normalized = [];

    records.forEach((record, index) => {
      const row = index + 1;
      const errors = [];
      const warnings = [];

      if (!isPlainObject(record)) {
        invalidRows.push({ row, id: "", errors: ["Row must be an object."] });
        return;
      }

      if (!hasExactKeys(record, masterKeys)) {
        errors.push(`Row must contain exactly these keys: ${masterKeys.join(", ")}.`);
      }

      if (!isNonEmptyString(record.id)) {
        errors.push("id must be a non-empty string.");
      } else if (seenIds.has(record.id)) {
        errors.push(`Duplicate id in import file: ${record.id}.`);
      }

      if (!isNonEmptyString(record.category)) {
        errors.push("category must be a non-empty string.");
      } else if (!isKnownCategory(record.category)) {
        warnings.push(`category "${record.category}" is not in the official reference list.`);
      }

      if (!isNonEmptyString(record.series)) {
        errors.push("series must be a non-empty string.");
      } else if (isKnownCategory(record.category) && !isKnownSeriesForCategory(record.category, record.series)) {
        warnings.push(`series "${record.series}" is not recognized under category "${record.category}".`);
      } else if (!isKnownCategory(record.category) && !isKnownSeries(record.series)) {
        warnings.push(`series "${record.series}" is not in the official reference list.`);
      }

      if (!isNonEmptyString(record.character)) {
        errors.push("character must be a non-empty string.");
      }

      if (!isNonEmptyString(record.franchise)) {
        errors.push("franchise must be a non-empty string.");
      }

      if (!rarities.includes(record.rarity)) {
        errors.push(`rarity must be one of: ${rarities.join(", ")}.`);
      }

      if (!isString(record.imageId)) {
        errors.push("imageId must be a string. Use an empty string when no image is available.");
      }

      if (isNonEmptyString(record.id)) {
        seenIds.add(record.id);
      }

      if (errors.length) {
        invalidRows.push({ row, id: String(record.id || ""), errors });
      } else {
        if (warnings.length) {
          warningRows.push({ row, id: String(record.id || ""), warnings });
        }
        normalized.push(normalizeMaster(record));
      }
    });

    return {
      ok: invalidRows.length === 0,
      records: normalized,
      invalidRows,
      orphanRows: [],
      warningRows
    };
  }

  function validateCollectionRecords(records, masterIds) {
    if (!Array.isArray(records)) {
      return emptyValidationResult(records);
    }

    const masterIdSet = new Set(masterIds || []);
    const seenIds = new Set();
    const invalidRows = [];
    const orphanRows = [];
    const warningRows = [];
    const normalized = [];

    records.forEach((record, index) => {
      const row = index + 1;
      const errors = [];

      if (!isPlainObject(record)) {
        invalidRows.push({ row, id: "", errors: ["Row must be an object."] });
        return;
      }

      if (!hasExactKeys(record, collectionKeys)) {
        errors.push(`Row must contain exactly these keys: ${collectionKeys.join(", ")}.`);
      }

      if (!isNonEmptyString(record.id)) {
        errors.push("id must be a non-empty string.");
      } else if (seenIds.has(record.id)) {
        errors.push(`Duplicate id in import file: ${record.id}.`);
      } else if (!masterIdSet.has(record.id)) {
        orphanRows.push({ row, id: record.id });
      }

      if (typeof record.collectionCopy !== "boolean") {
        errors.push("collectionCopy must be true or false.");
      }

      ["owned", "personalCollection", "available", "soldReserved"].forEach((key) => {
        if (!isNonNegativeInteger(record[key])) {
          errors.push(`${key} must be a non-negative integer.`);
        }
      });

      if (typeof record.listedWhatnot !== "boolean") {
        errors.push("listedWhatnot must be true or false.");
      }

      if (typeof record.listedEbay !== "boolean") {
        errors.push("listedEbay must be true or false.");
      }

      if (!isString(record.notes)) {
        errors.push("notes must be a string.");
      }

      if (!isString(record.dateAdded)) {
        errors.push("dateAdded must be a string.");
      }

      if (!isString(record.lastModified)) {
        errors.push("lastModified must be a string.");
      }

      if (record.owned === 0 && record.collectionCopy) {
        errors.push("collectionCopy cannot be true when owned is 0.");
      }

      if (record.collectionCopy && isNonNegativeInteger(record.personalCollection) && record.personalCollection < 1) {
        errors.push("personalCollection must be at least 1 when collectionCopy is true.");
      }

      if (!record.collectionCopy && record.personalCollection > 0) {
        errors.push("personalCollection must be 0 when collectionCopy is false.");
      }

      if (isNonNegativeInteger(record.owned) &&
        isNonNegativeInteger(record.personalCollection) &&
        isNonNegativeInteger(record.available) &&
        isNonNegativeInteger(record.soldReserved)) {
        const allocated = record.personalCollection + record.available + record.soldReserved;
        if (allocated > record.owned) {
          errors.push("owned must be at least personalCollection + available + soldReserved.");
        }
      }

      if (isNonEmptyString(record.id)) {
        seenIds.add(record.id);
      }

      if (errors.length) {
        invalidRows.push({ row, id: String(record.id || ""), errors });
      } else {
        normalized.push(normalizeCollection(record));
      }
    });

    return {
      ok: invalidRows.length === 0 && orphanRows.length === 0,
      records: normalized,
      invalidRows,
      orphanRows,
      warningRows
    };
  }

  function normalizeMaster(record) {
    const id = cleanString(record.id, "");

    return {
      id: id || makeLocalId(),
      category: cleanString(record.category, "Other"),
      series: cleanString(record.series, "Unsorted"),
      character: cleanString(record.character, "Unknown Character"),
      franchise: cleanString(record.franchise, "Unknown Franchise"),
      rarity: rarities.includes(record.rarity) ? record.rarity : "Common",
      imageId: cleanString(record.imageId, "")
    };
  }

  function normalizeCollection(record) {
    const id = cleanString(record.id, "") || makeLocalId();
    const collectionCopy = Boolean(record.collectionCopy);
    const personalCollection = cleanNumber(
      record.personalCollection === undefined ? (collectionCopy ? 1 : 0) : record.personalCollection
    );

    return {
      id,
      collectionCopy,
      owned: cleanNumber(record.owned),
      personalCollection,
      available: cleanNumber(record.available),
      soldReserved: cleanNumber(record.soldReserved),
      listedWhatnot: Boolean(record.listedWhatnot),
      listedEbay: Boolean(record.listedEbay),
      notes: String(record.notes || ""),
      dateAdded: String(record.dateAdded || ""),
      lastModified: String(record.lastModified || "")
    };
  }

  async function getMeta(key) {
    const entry = await readOne(STORES.meta, key);
    return entry ? entry.value : undefined;
  }

  async function setMeta(key, value) {
    return writeOne(STORES.meta, { key, value });
  }

  async function getLastBackupDate() {
    return (await getMeta("lastBackupDate")) || "";
  }

  async function recordBackupExport(timestamp) {
    const backupTimestamp = timestamp || new Date().toISOString();
    await setMeta("lastBackupDate", backupTimestamp);
    return backupTimestamp;
  }

  async function seedIfNeeded() {
    const seeded = await getMeta("seeded");
    const masterCount = await countStore(STORES.master);

    if (seeded || masterCount > 0) {
      return;
    }

    await writeMany(STORES.master, sampleMaster.map(normalizeMaster));
    await writeMany(STORES.collection, sampleCollection.map(normalizeCollection));
    await writeMany(STORES.activity, [
      {
        id: makeLocalId(),
        action: "Sample data loaded",
        timestamp: new Date().toISOString()
      },
      {
        id: makeLocalId(),
        action: "Doorables Vault is ready offline",
        timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString()
      }
    ]);
    await setMeta("seeded", true);
  }

  async function logActivity(action) {
    return writeOne(STORES.activity, {
      id: makeLocalId(),
      action,
      timestamp: new Date().toISOString()
    });
  }

  async function getRecentActivity(limit) {
    const rows = await readAll(STORES.activity);
    return rows
      .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
      .slice(0, limit);
  }

  function assertValidation(validation, label) {
    if (validation.ok) {
      return;
    }

    const firstIssue = validation.invalidRows[0] || validation.orphanRows[0];
    const issueText = firstIssue
      ? ` First issue is row ${firstIssue.row}${firstIssue.id ? ` (${firstIssue.id})` : ""}.`
      : "";
    throw new Error(`${label} import failed validation.${issueText}`);
  }

  async function importMaster(records, mode) {
    const validation = validateMasterRecords(records);
    assertValidation(validation, "Master database");

    if (mode === "replace") {
      await replaceAll(STORES.master, validation.records);
    } else {
      await writeMany(STORES.master, validation.records);
    }

    await logActivity(`${mode === "replace" ? "Replaced" : "Merged"} ${validation.records.length} master database records`);
    return validation.records.length;
  }

  async function importCollection(records, mode) {
    const master = await readAll(STORES.master);
    const validation = validateCollectionRecords(records, master.map((record) => record.id));
    assertValidation(validation, "Collection");

    if (mode === "replace") {
      await replaceAll(STORES.collection, validation.records);
    } else {
      await writeMany(STORES.collection, validation.records);
    }

    await logActivity(`${mode === "replace" ? "Replaced" : "Merged"} ${validation.records.length} collection records`);
    return validation.records.length;
  }

  async function clearAllData() {
    await clearStore(STORES.master);
    await clearStore(STORES.collection);
    await clearStore(STORES.activity);
    await clearStore(STORES.images);
    await clearStore(STORES.meta);
    // Preserve only the reseed guard so a deliberate delete does not reload samples on next launch.
    await setMeta("seeded", true);
  }

  async function getStorageStats() {
    return {
      master: await countStore(STORES.master),
      collection: await countStore(STORES.collection),
      activity: await countStore(STORES.activity),
      images: await countStore(STORES.images),
      meta: await countStore(STORES.meta)
    };
  }

  async function saveImageBlob(imageId, blob) {
    return writeOne(STORES.images, {
      imageId,
      blob,
      lastModified: new Date().toISOString()
    });
  }

  async function getImageBlob(imageId) {
    return readOne(STORES.images, imageId);
  }

  async function deleteImageBlob(imageId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.images, "readwrite");
      tx.objectStore(STORES.images).delete(imageId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  window.DoorablesDB = {
    categories,
    rarities,
    seriesByCategory,
    getAllSeries,
    isKnownCategory,
    isKnownSeriesForCategory,
    init: openDb,
    seedIfNeeded,
    createEmptyCollection,
    normalizeMaster,
    normalizeCollection,
    validateMasterRecords,
    validateCollectionRecords,
    getAllMaster: () => readAll(STORES.master),
    getAllCollection: () => readAll(STORES.collection),
    getRecentActivity,
    putMaster: (record) => writeOne(STORES.master, normalizeMaster(record)),
    putCollection: (record) => writeOne(STORES.collection, normalizeCollection(record)),
    importMaster,
    importCollection,
    exportMaster: () => readAll(STORES.master),
    exportCollection: () => readAll(STORES.collection),
    getLastBackupDate,
    recordBackupExport,
    clearAllData,
    getStorageStats,
    logActivity,
    saveImageBlob,
    getImageBlob,
    deleteImageBlob
  };
})();
