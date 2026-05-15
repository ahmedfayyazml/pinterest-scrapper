const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const db = new Database(path.join(DATA_DIR, "pins.db"));

// ─── INIT SCHEMA ───────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS pins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pinUrl TEXT UNIQUE NOT NULL,
    thumbnail TEXT,
    videoSrc TEXT,
    title TEXT,
    author TEXT,
    scrapedAt TEXT,
    createdAt TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_title ON pins(title);
  CREATE INDEX IF NOT EXISTS idx_author ON pins(author);
`);

// ─── METHODS ───────────────────────────────────────────────────────────────

function upsertPin(pin) {
  const stmt = db.prepare(`
    INSERT INTO pins (pinUrl, thumbnail, videoSrc, title, author, scrapedAt)
    VALUES (@pinUrl, @thumbnail, @videoSrc, @title, @author, @scrapedAt)
    ON CONFLICT(pinUrl) DO UPDATE SET
      thumbnail = excluded.thumbnail,
      videoSrc = excluded.videoSrc,
      title = excluded.title,
      author = excluded.author,
      scrapedAt = excluded.scrapedAt
  `);
  stmt.run(pin);
}

function getAllPins() {
  return db.prepare("SELECT * FROM pins ORDER BY createdAt DESC LIMIT 200").all();
}

function searchPins(query) {
  const q = `%${query.toLowerCase()}%`;
  return db
    .prepare(
      `SELECT * FROM pins 
       WHERE LOWER(title) LIKE ? OR LOWER(author) LIKE ? OR LOWER(pinUrl) LIKE ?
       ORDER BY createdAt DESC
       LIMIT 100`
    )
    .all(q, q, q);
}

module.exports = { upsertPin, getAllPins, searchPins };
