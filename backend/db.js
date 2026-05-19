const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const sqliteDb = new Database(path.join(DATA_DIR, "pins.db"));

// Initialize SQLite Schema
sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS pins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pinUrl TEXT UNIQUE NOT NULL,
    thumbnail TEXT,
    videoSrc TEXT,
    title TEXT,
    author TEXT,
    scrapedAt TEXT,
    batchId TEXT,
    createdAt TEXT DEFAULT (datetime('now'))
  );
`);

// Gracefully add batchId column if it doesn't exist
try {
  sqliteDb.exec("ALTER TABLE pins ADD COLUMN batchId TEXT;");
} catch (e) {
  // Column already exists
}

// ─── FIREBASE SWITCH ───────────────────────────────────────────────────────
let firestoreDb = null;
const useFirebase = process.env.USE_FIREBASE === "true";

if (useFirebase) {
  try {
    const { db } = require("./firebase");
    firestoreDb = db;
    console.log("Database Layer: Running in Firestore Mode 🌐");
  } catch (e) {
    console.warn("Database Layer: Failed to load Firestore, falling back to SQLite 💾", e.message);
  }
} else {
  console.log("Database Layer: Running in Local SQLite Mode 💾");
}

// ─── UNIFIED DB INTERFACE ──────────────────────────────────────────────────

async function upsertPin(pin) {
  if (useFirebase && firestoreDb) {
    try {
      const pinUrl = pin.pinUrl;
      if (!pinUrl) return;
      const docId = Buffer.from(pinUrl).toString('base64');
      if (!pin.createdAt) pin.createdAt = new Date().toISOString();
      await firestoreDb.collection("pins").doc(docId).set(pin, { merge: true });
      return;
    } catch (error) {
      console.error("Firestore upsert failed, falling back to SQLite:", error.message);
    }
  }

  // SQLite implementation
  const stmt = sqliteDb.prepare(`
    INSERT INTO pins (pinUrl, thumbnail, videoSrc, title, author, scrapedAt, batchId, createdAt)
    VALUES (@pinUrl, @thumbnail, @videoSrc, @title, @author, @scrapedAt, @batchId, @createdAt)
    ON CONFLICT(pinUrl) DO UPDATE SET
      thumbnail = excluded.thumbnail,
      videoSrc = excluded.videoSrc,
      title = excluded.title,
      author = excluded.author,
      scrapedAt = excluded.scrapedAt,
      batchId = COALESCE(excluded.batchId, pins.batchId),
      createdAt = COALESCE(excluded.createdAt, pins.createdAt)
  `);
  stmt.run({
    pinUrl: pin.pinUrl,
    thumbnail: pin.thumbnail,
    videoSrc: pin.videoSrc,
    title: pin.title,
    author: pin.author,
    scrapedAt: pin.scrapedAt || new Date().toISOString(),
    batchId: pin.batchId || null,
    createdAt: pin.createdAt || new Date().toISOString()
  });
}

async function getAllPins() {
  if (useFirebase && firestoreDb) {
    try {
      const snapshot = await firestoreDb.collection("pins").orderBy("createdAt", "desc").limit(200).get();
      const pins = [];
      snapshot.forEach(doc => pins.push(doc.data()));
      return pins;
    } catch (error) {
      console.error("Firestore getAllPins failed, falling back to SQLite:", error.message);
    }
  }

  return sqliteDb.prepare("SELECT * FROM pins ORDER BY createdAt DESC LIMIT 200").all();
}

async function searchPins(query) {
  if (useFirebase && firestoreDb) {
    try {
      const q = query.toLowerCase();
      const snapshot = await firestoreDb.collection("pins").orderBy("createdAt", "desc").get();
      const pins = [];
      snapshot.forEach(doc => {
        const data = doc.data();
        if ((data.title && data.title.toLowerCase().includes(q)) || 
            (data.author && data.author.toLowerCase().includes(q)) || 
            (data.pinUrl && data.pinUrl.toLowerCase().includes(q))) {
          pins.push(data);
        }
      });
      return pins.slice(0, 100);
    } catch (error) {
      console.error("Firestore searchPins failed, falling back to SQLite:", error.message);
    }
  }

  const q = `%${query.toLowerCase()}%`;
  return sqliteDb
    .prepare(
      `SELECT * FROM pins 
       WHERE LOWER(title) LIKE ? OR LOWER(author) LIKE ? OR LOWER(pinUrl) LIKE ?
       ORDER BY createdAt DESC
       LIMIT 100`
    )
    .all(q, q, q);
}

// ─── BATCH SYSTEM WRAPPERS ─────────────────────────────────────────────────

async function getLatestPin() {
  if (useFirebase && firestoreDb) {
    try {
      const batchQuery = await firestoreDb.collection("pins").orderBy("scrapedAt", "desc").limit(1).get();
      if (!batchQuery.empty) {
        return batchQuery.docs[0].data();
      }
      return null;
    } catch (error) {
      console.error("Firestore getLatestPin failed, falling back to SQLite:", error.message);
    }
  }

  return sqliteDb.prepare("SELECT * FROM pins ORDER BY scrapedAt DESC LIMIT 1").get() || null;
}

async function getPinsByBatch(batchId) {
  if (useFirebase && firestoreDb) {
    try {
      const snapshot = await firestoreDb.collection("pins").where("batchId", "==", batchId).get();
      const pins = [];
      snapshot.forEach(doc => pins.push(doc.data()));
      return pins;
    } catch (error) {
      console.error("Firestore getPinsByBatch failed, falling back to SQLite:", error.message);
    }
  }

  return sqliteDb.prepare("SELECT * FROM pins WHERE batchId = ?").all(batchId);
}

async function saveBatchPins(pins, newBatchId, timestamp) {
  if (useFirebase && firestoreDb) {
    try {
      let batch = firestoreDb.batch();
      let opCount = 0;
      
      for (const pin of pins) {
        const docId = Buffer.from(pin.pinUrl).toString("base64");
        const docRef = firestoreDb.collection("pins").doc(docId);
        batch.set(docRef, {
          ...pin,
          batchId: newBatchId,
          scrapedAt: timestamp,
          createdAt: timestamp
        }, { merge: true });
        
        opCount++;
        if (opCount === 500) {
          await batch.commit();
          batch = firestoreDb.batch();
          opCount = 0;
        }
      }
      if (opCount > 0) {
        await batch.commit();
      }
      
      // Delete old
      const oldDocsQuery = await firestoreDb.collection("pins").where("batchId", "!=", newBatchId).get();
      batch = firestoreDb.batch();
      opCount = 0;
      oldDocsQuery.forEach(doc => {
        batch.delete(doc.ref);
        opCount++;
        if (opCount === 500) {
          batch.commit();
          batch = firestoreDb.batch();
          opCount = 0;
        }
      });
      if (opCount > 0) {
        await batch.commit();
      }
      return;
    } catch (error) {
      console.error("Firestore saveBatchPins failed, falling back to SQLite:", error.message);
    }
  }

  // SQLite Batch System
  const deleteStmt = sqliteDb.prepare("DELETE FROM pins WHERE batchId != ? OR batchId IS NULL");
  const insertStmt = sqliteDb.prepare(`
    INSERT INTO pins (pinUrl, thumbnail, videoSrc, title, author, scrapedAt, batchId, createdAt)
    VALUES (@pinUrl, @thumbnail, @videoSrc, @title, @author, @scrapedAt, @batchId, @createdAt)
    ON CONFLICT(pinUrl) DO UPDATE SET
      thumbnail = excluded.thumbnail,
      videoSrc = excluded.videoSrc,
      title = excluded.title,
      author = excluded.author,
      scrapedAt = excluded.scrapedAt,
      batchId = excluded.batchId,
      createdAt = excluded.createdAt
  `);

  const runBatchTransaction = sqliteDb.transaction((pinsList) => {
    for (const pin of pinsList) {
      insertStmt.run({
        pinUrl: pin.pinUrl,
        thumbnail: pin.thumbnail,
        videoSrc: pin.videoSrc || "",
        title: pin.title,
        author: pin.author,
        scrapedAt: timestamp,
        batchId: newBatchId,
        createdAt: timestamp
      });
    }
    deleteStmt.run(newBatchId);
  });

  runBatchTransaction(pins);
}

module.exports = {
  upsertPin,
  getAllPins,
  searchPins,
  getLatestPin,
  getPinsByBatch,
  saveBatchPins
};
