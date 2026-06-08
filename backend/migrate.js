const path = require("path");
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const Database = require("better-sqlite3");
const fs = require("fs");
const { admin, db } = require("./firebase");

async function migrate() {
  const DATA_DIR = path.join(__dirname, "data");
  if (!fs.existsSync(path.join(DATA_DIR, "pins.db"))) {
    console.log("No SQLite DB found to migrate.");
    process.exit(0);
  }

  const sqliteDb = new Database(path.join(DATA_DIR, "pins.db"));
  const pins = sqliteDb.prepare("SELECT * FROM pins").all();

  console.log(`Found ${pins.length} pins in SQLite. Migrating to Firestore...`);

  let count = 0;
  for (const pin of pins) {
    if (!pin.pinUrl) continue;
    const docId = Buffer.from(pin.pinUrl).toString('base64');
    
    const docData = {
      pinUrl: pin.pinUrl,
      thumbnail: pin.thumbnail,
      videoSrc: pin.videoSrc,
      title: pin.title,
      author: pin.author,
      scrapedAt: pin.scrapedAt,
      batchId: "batch_migration",
      addedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: pin.createdAt
    };
    
    await db.collection("pins").doc(docId).set(docData, { merge: true });
    count++;
  }

  console.log(`✅ Migrated ${count} pins to Firestore`);
  process.exit(0);
}

migrate();
