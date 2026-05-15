{
  "name": "pinterest-video-scraper-backend",
  "version": "1.0.0",
  "description": "Pinterest video pin scraper backend",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "axios": "^1.6.0",
    "cheerio": "^1.0.0-rc.12",
    "cors": "^2.8.5",
    "express": "^4.18.2",
    "playwright": "^1.40.0",
    "playwright-extra": "^4.3.6",
    "puppeteer-extra-plugin-stealth": "^2.11.2",
    "better-sqlite3": "^9.4.3"
  },
  "devDependencies": {
    "nodemon": "^3.0.2"
  }
}
server js
const express = require("express");
const cors = require("cors");
const path = require("path");
const { scrapeRandom, scrapeByKeyword } = require("./scraper");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve frontend static files
app.use(express.static(path.join(__dirname, "../frontend/public")));

// ─── ROUTES ────────────────────────────────────────────────────────────────

// GET /api/pins/random — scrape trending video pins
app.get("/api/pins/random", async (req, res) => {
  try {
    console.log("[/api/pins/random] Starting random scrape...");
    const pins = await scrapeRandom();
    // cache them
    pins.forEach((pin) => db.upsertPin(pin));
    res.json({ success: true, count: pins.length, pins });
  } catch (err) {
    console.error("[/api/pins/random] Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/pins/search?q=keyword — live scrape + local cache
app.get("/api/pins/search", async (req, res) => {
  const query = req.query.q?.trim();
  if (!query) return res.status(400).json({ success: false, error: "Missing ?q= parameter" });

  try {
    console.log(`[/api/pins/search] Searching: "${query}"`);

    // Run both simultaneously
    const [livePins, cachedPins] = await Promise.allSettled([
      scrapeByKeyword(query),
      Promise.resolve(db.searchPins(query)),
    ]);

    const live = livePins.status === "fulfilled" ? livePins.value : [];
    const cached = cachedPins.status === "fulfilled" ? cachedPins.value : [];

    // Cache live results
    live.forEach((pin) => db.upsertPin(pin));

    // Merge + deduplicate by pinUrl
    const seen = new Set();
    const merged = [...live, ...cached].filter((pin) => {
      if (seen.has(pin.pinUrl)) return false;
      seen.add(pin.pinUrl);
      return true;
    });

    res.json({ success: true, count: merged.length, query, pins: merged });
  } catch (err) {
    console.error("[/api/pins/search] Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/pins/cached — return all cached pins
app.get("/api/pins/cached", (req, res) => {
  try {
    const pins = db.getAllPins();
    res.json({ success: true, count: pins.length, pins });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Fallback → serve frontend
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/public/index.html"));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Pinterest Video Scraper running at http://localhost:${PORT}\n`);
});

playwright scrapper 
const { chromium } = require("playwright");

// ─── HELPERS ───────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomDelay = () => sleep(1500 + Math.random() * 1500);

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
];

const randomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// ─── BROWSER FACTORY ───────────────────────────────────────────────────────

async function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--window-size=1280,900",
    ],
  });
}

async function newStealthPage(browser) {
  const context = await browser.newContext({
    userAgent: randomUA(),
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    timezoneId: "America/New_York",
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    },
  });

  const page = await context.newPage();

  // Remove webdriver traces
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
    window.chrome = { runtime: {} };
  });

  return { page, context };
}

// ─── PIN EXTRACTOR ─────────────────────────────────────────────────────────

async function extractVideoPins(page) {
  await page.waitForTimeout(2000);

  // Scroll to load more pins
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    await sleep(1200 + Math.random() * 800);
  }

  const pins = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    // Pinterest renders pins as <div data-test-id="pin"> or with role="listitem"
    const pinElements = document.querySelectorAll(
      '[data-test-id="pin"], [data-grid-item], .GrowthUnauthPinImage, div[role="listitem"]'
    );

    pinElements.forEach((el) => {
      try {
        // Check for video indicators
        const hasVideo =
          el.querySelector("video") ||
          el.querySelector('[data-test-id="video-pin-with-controls"]') ||
          el.querySelector(".videoContainer") ||
          el.querySelector('[aria-label*="video" i]') ||
          el.querySelector('[aria-label*="Video" i]') ||
          el.querySelector(".PinCard--video") ||
          el.getAttribute("data-is-video") === "true";

        if (!hasVideo) return;

        // Get pin link
        const anchor = el.querySelector("a[href*='/pin/']");
        if (!anchor) return;

        const pinUrl = anchor.href;
        if (seen.has(pinUrl)) return;
        seen.add(pinUrl);

        // Get thumbnail
        const img = el.querySelector("img");
        const thumbnail = img?.src || img?.getAttribute("data-src") || "";

        // Get video src if available
        const videoEl = el.querySelector("video");
        const videoSrc = videoEl?.src || videoEl?.querySelector("source")?.src || "";

        // Get title/description
        const title =
          img?.alt ||
          el.querySelector('[data-test-id="pin-title"]')?.innerText ||
          el.querySelector(".tBJ")?.innerText ||
          "";

        // Get author
        const authorEl = el.querySelector('[data-test-id="pinner-name"], .lH2, .zI7');
        const author = authorEl?.innerText || "";

        if (pinUrl && thumbnail) {
          results.push({
            pinUrl,
            thumbnail,
            videoSrc,
            title: title.trim(),
            author: author.trim(),
            scrapedAt: new Date().toISOString(),
          });
        }
      } catch (e) {
        // skip broken pins
      }
    });

    return results;
  });

  return pins;
}

// ─── SCRAPE RANDOM ─────────────────────────────────────────────────────────

async function scrapeRandom() {
  const browser = await launchBrowser();
  const { page, context } = await newStealthPage(browser);

  try {
    console.log("[scraper] Loading Pinterest video feed...");

    // Try the video category page first (no login required usually)
    await page.goto("https://www.pinterest.com/search/pins/?q=trending+videos&rs=typed", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    await randomDelay();

    // If redirected to login, try alternate URL
    const url = page.url();
    if (url.includes("login") || url.includes("_auth")) {
      console.log("[scraper] Login wall hit, trying alternate URL...");
      await page.goto("https://www.pinterest.com/ideas/videos/910496889176/", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await randomDelay();
    }

    const pins = await extractVideoPins(page);
    console.log(`[scraper] Found ${pins.length} video pins`);
    return pins;
  } finally {
    await context.close();
    await browser.close();
  }
}

// ─── SCRAPE BY KEYWORD ─────────────────────────────────────────────────────

async function scrapeByKeyword(keyword) {
  const browser = await launchBrowser();
  const { page, context } = await newStealthPage(browser);

  try {
    const encodedQuery = encodeURIComponent(keyword);
    const url = `https://www.pinterest.com/search/pins/?q=${encodedQuery}+video&rs=typed`;

    console.log(`[scraper] Scraping keyword: "${keyword}" → ${url}`);

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    await randomDelay();

    // Handle login wall
    if (page.url().includes("login")) {
      console.log("[scraper] Login wall on keyword search, returning empty");
      return [];
    }

    const pins = await extractVideoPins(page);
    console.log(`[scraper] Found ${pins.length} video pins for "${keyword}"`);
    return pins;
  } finally {
    await context.close();
    await browser.close();
  }
}

module.exports = { scrapeRandom, scrapeByKeyword };

sqlite database for caching pins
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

full front end electric theme 
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>PinVid — Pinterest Video Scraper</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg: #07090F;
      --surface: #0e1117;
      --surface2: #161b27;
      --border: #1e2535;
      --mint: #00F5A0;
      --cyan: #00D4FF;
      --red: #E8445A;
      --text: #e8ecf4;
      --muted: #5a6480;
      --card-bg: #0d1119;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'DM Sans', sans-serif;
      min-height: 100vh;
      overflow-x: hidden;
    }

    /* ── GRAIN OVERLAY ── */
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.04'/%3E%3C/svg%3E");
      pointer-events: none;
      z-index: 999;
      opacity: 0.4;
    }

    /* ── HEADER ── */
    header {
      padding: 28px 40px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      background: rgba(7,9,15,0.92);
      backdrop-filter: blur(20px);
      z-index: 100;
    }

    .logo {
      font-family: 'Syne', sans-serif;
      font-weight: 800;
      font-size: 1.5rem;
      letter-spacing: -0.03em;
      background: linear-gradient(135deg, var(--mint), var(--cyan));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .logo span {
      color: var(--muted);
      -webkit-text-fill-color: var(--muted);
      font-weight: 400;
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .cache-count {
      font-size: 0.75rem;
      color: var(--muted);
      background: var(--surface2);
      padding: 6px 12px;
      border-radius: 20px;
      border: 1px solid var(--border);
    }

    /* ── SEARCH BAR ── */
    .search-wrap {
      padding: 32px 40px 0;
      max-width: 700px;
    }

    .search-label {
      font-family: 'Syne', sans-serif;
      font-size: 0.7rem;
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 10px;
    }

    .search-row {
      display: flex;
      gap: 10px;
    }

    .search-input {
      flex: 1;
      background: var(--surface);
      border: 1.5px solid var(--border);
      border-radius: 12px;
      padding: 14px 20px;
      font-family: 'DM Sans', sans-serif;
      font-size: 0.95rem;
      color: var(--text);
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
    }

    .search-input::placeholder { color: var(--muted); }

    .search-input:focus {
      border-color: var(--mint);
      box-shadow: 0 0 0 3px rgba(0,245,160,0.08);
    }

    .btn {
      font-family: 'Syne', sans-serif;
      font-weight: 600;
      font-size: 0.85rem;
      letter-spacing: 0.02em;
      padding: 14px 24px;
      border-radius: 12px;
      border: none;
      cursor: pointer;
      transition: all 0.2s;
      white-space: nowrap;
    }

    .btn-primary {
      background: linear-gradient(135deg, var(--mint), var(--cyan));
      color: #07090F;
    }

    .btn-primary:hover {
      transform: translateY(-1px);
      box-shadow: 0 8px 24px rgba(0,245,160,0.25);
    }

    .btn-primary:active { transform: translateY(0); }

    .btn-ghost {
      background: var(--surface2);
      color: var(--text);
      border: 1px solid var(--border);
    }

    .btn-ghost:hover { border-color: var(--cyan); color: var(--cyan); }

    /* ── TABS / STATUS ── */
    .status-bar {
      padding: 20px 40px 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;
    }

    .status-text {
      font-size: 0.82rem;
      color: var(--muted);
    }

    .status-text strong { color: var(--mint); }

    .pill-tabs {
      display: flex;
      gap: 6px;
    }

    .pill {
      font-family: 'Syne', sans-serif;
      font-size: 0.72rem;
      font-weight: 600;
      letter-spacing: 0.05em;
      padding: 6px 14px;
      border-radius: 20px;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      transition: all 0.2s;
    }

    .pill.active, .pill:hover {
      border-color: var(--mint);
      color: var(--mint);
      background: rgba(0,245,160,0.06);
    }

    /* ── LOADING ── */
    .loading-wrap {
      padding: 80px 40px;
      text-align: center;
      display: none;
    }

    .loading-wrap.show { display: block; }

    .spinner {
      width: 44px;
      height: 44px;
      border: 2.5px solid var(--border);
      border-top-color: var(--mint);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 0 auto 20px;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    .loading-text {
      font-family: 'Syne', sans-serif;
      font-size: 0.85rem;
      color: var(--muted);
      letter-spacing: 0.05em;
    }

    /* ── EMPTY STATE ── */
    .empty {
      padding: 80px 40px;
      text-align: center;
      display: none;
    }

    .empty.show { display: block; }

    .empty-icon { font-size: 3rem; margin-bottom: 16px; opacity: 0.4; }

    .empty-title {
      font-family: 'Syne', sans-serif;
      font-size: 1.1rem;
      font-weight: 700;
      margin-bottom: 8px;
      color: var(--muted);
    }

    .empty-sub { font-size: 0.85rem; color: var(--muted); opacity: 0.7; }

    /* ── GRID ── */
    .grid-wrap {
      padding: 28px 40px 60px;
    }

    .grid {
      columns: 5 220px;
      column-gap: 14px;
    }

    /* ── CARD ── */
    .card {
      break-inside: avoid;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 16px;
      overflow: hidden;
      margin-bottom: 14px;
      cursor: pointer;
      transition: transform 0.2s, border-color 0.2s, box-shadow 0.2s;
      animation: fadeUp 0.4s ease both;
    }

    .card:hover {
      transform: translateY(-4px);
      border-color: rgba(0,245,160,0.3);
      box-shadow: 0 16px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,245,160,0.1);
    }

    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(16px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    .card-thumb {
      position: relative;
      width: 100%;
      aspect-ratio: 3/4;
      overflow: hidden;
      background: var(--surface2);
    }

    .card-thumb img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      transition: transform 0.4s ease;
    }

    .card:hover .card-thumb img { transform: scale(1.04); }

    .play-badge {
      position: absolute;
      top: 10px;
      left: 10px;
      background: rgba(0,0,0,0.7);
      backdrop-filter: blur(8px);
      border-radius: 8px;
      padding: 5px 10px;
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 0.68rem;
      font-family: 'Syne', sans-serif;
      font-weight: 600;
      color: var(--mint);
      letter-spacing: 0.05em;
    }

    .play-icon {
      width: 14px;
      height: 14px;
      background: var(--mint);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .play-icon::after {
      content: '';
      border-left: 5px solid #07090F;
      border-top: 3px solid transparent;
      border-bottom: 3px solid transparent;
      margin-left: 1.5px;
    }

    .card-body {
      padding: 12px 14px 14px;
    }

    .card-title {
      font-size: 0.8rem;
      font-weight: 500;
      color: var(--text);
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      margin-bottom: 8px;
    }

    .card-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .card-author {
      font-size: 0.72rem;
      color: var(--muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .card-link {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 0.7rem;
      font-family: 'Syne', sans-serif;
      font-weight: 600;
      color: var(--cyan);
      text-decoration: none;
      flex-shrink: 0;
      transition: color 0.2s;
    }

    .card-link:hover { color: var(--mint); }

    /* ── SKELETON ── */
    .skeleton-grid {
      columns: 5 220px;
      column-gap: 14px;
      padding: 28px 40px;
      display: none;
    }

    .skeleton-grid.show { display: block; }

    .skeleton-card {
      break-inside: avoid;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 16px;
      overflow: hidden;
      margin-bottom: 14px;
    }

    .skeleton-thumb {
      width: 100%;
      background: var(--surface2);
      animation: pulse 1.5s ease-in-out infinite;
    }

    .skeleton-line {
      height: 10px;
      background: var(--surface2);
      border-radius: 6px;
      animation: pulse 1.5s ease-in-out infinite;
      margin: 10px 14px;
    }

    .skeleton-line.short { width: 55%; margin-bottom: 14px; }

    @keyframes pulse {
      0%, 100% { opacity: 0.4; }
      50% { opacity: 0.8; }
    }

    /* ── TOAST ── */
    .toast {
      position: fixed;
      bottom: 28px;
      right: 28px;
      background: var(--surface2);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px 20px;
      font-size: 0.83rem;
      color: var(--text);
      z-index: 1000;
      transform: translateY(80px);
      opacity: 0;
      transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
      max-width: 320px;
    }

    .toast.show {
      transform: translateY(0);
      opacity: 1;
    }

    .toast.success { border-color: var(--mint); }
    .toast.error { border-color: var(--red); }

    /* ── RESPONSIVE ── */
    @media (max-width: 768px) {
      header, .search-wrap, .status-bar, .grid-wrap { padding-left: 20px; padding-right: 20px; }
      .logo { font-size: 1.2rem; }
      .grid, .skeleton-grid { columns: 2 160px; }
    }
  </style>
</head>
<body>

<!-- HEADER -->
<header>
  <div class="logo">Pin<span>Vid</span></div>
  <div class="header-right">
    <span class="cache-count" id="cacheCount">0 cached</span>
    <button class="btn btn-ghost" onclick="loadRandom()">↻ Refresh</button>
  </div>
</header>

<!-- SEARCH -->
<div class="search-wrap">
  <div class="search-label">Search Pinterest Video Pins</div>
  <div class="search-row">
    <input
      class="search-input"
      id="searchInput"
      type="text"
      placeholder="e.g. aesthetic room, cooking, travel vlog..."
      autocomplete="off"
    />
    <button class="btn btn-primary" onclick="doSearch()">Search</button>
  </div>
</div>

<!-- STATUS BAR -->
<div class="status-bar">
  <div class="status-text" id="statusText">Loading trending video pins...</div>
  <div class="pill-tabs">
    <button class="pill active" id="tab-live" onclick="setTab('live')">Live</button>
    <button class="pill" id="tab-cached" onclick="setTab('cached')">Cached</button>
  </div>
</div>

<!-- SKELETON -->
<div class="skeleton-grid show" id="skeleton">
  ${Array.from({length:15}, (_, i) => {
    const h = [260, 320, 200, 280, 310, 240, 290, 350, 220, 270, 300, 230, 260, 340, 210][i];
    return `
    <div class="skeleton-card">
      <div class="skeleton-thumb" style="height:${h}px"></div>
      <div class="skeleton-line"></div>
      <div class="skeleton-line short"></div>
    </div>`;
  }).join('')}
</div>

<!-- LOADING -->
<div class="loading-wrap" id="loadingWrap">
  <div class="spinner"></div>
  <div class="loading-text" id="loadingText">SCRAPING PINTEREST...</div>
</div>

<!-- EMPTY -->
<div class="empty" id="emptyState">
  <div class="empty-icon">📌</div>
  <div class="empty-title">No video pins found</div>
  <div class="empty-sub">Try a different search term or refresh</div>
</div>

<!-- GRID -->
<div class="grid-wrap" id="gridWrap" style="display:none">
  <div class="grid" id="pinsGrid"></div>
</div>

<!-- TOAST -->
<div class="toast" id="toast"></div>

<script>
  const API = 'http://localhost:3001/api';
  let currentTab = 'live';

  // ── UTILS ──────────────────────────────────────────────────────────────

  function toast(msg, type = 'success') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = `toast show ${type}`;
    setTimeout(() => el.classList.remove('show'), 3500);
  }

  function setStatus(msg) {
    document.getElementById('statusText').innerHTML = msg;
  }

  function setTab(tab) {
    currentTab = tab;
    document.getElementById('tab-live').classList.toggle('active', tab === 'live');
    document.getElementById('tab-cached').classList.toggle('active', tab === 'cached');
    if (tab === 'cached') loadCached();
    else loadRandom();
  }

  function showSkeleton() {
    document.getElementById('skeleton').classList.add('show');
    document.getElementById('loadingWrap').classList.remove('show');
    document.getElementById('gridWrap').style.display = 'none';
    document.getElementById('emptyState').classList.remove('show');
  }

  function showLoading(text = 'SCRAPING PINTEREST...') {
    document.getElementById('skeleton').classList.remove('show');
    document.getElementById('loadingWrap').classList.add('show');
    document.getElementById('loadingText').textContent = text;
    document.getElementById('gridWrap').style.display = 'none';
    document.getElementById('emptyState').classList.remove('show');
  }

  function showEmpty() {
    document.getElementById('skeleton').classList.remove('show');
    document.getElementById('loadingWrap').classList.remove('show');
    document.getElementById('gridWrap').style.display = 'none';
    document.getElementById('emptyState').classList.add('show');
  }

  function showGrid() {
    document.getElementById('skeleton').classList.remove('show');
    document.getElementById('loadingWrap').classList.remove('show');
    document.getElementById('emptyState').classList.remove('show');
    document.getElementById('gridWrap').style.display = 'block';
  }

  // ── CARD BUILDER ────────────────────────────────────────────────────────

  function buildCard(pin, delay = 0) {
    const div = document.createElement('div');
    div.className = 'card';
    div.style.animationDelay = `${delay}ms`;

    const title = pin.title || 'Pinterest Video Pin';
    const author = pin.author ? `@${pin.author}` : 'Pinterest';
    const thumb = pin.thumbnail || 'https://via.placeholder.com/220x300/0d1119/5a6480?text=No+Image';

    div.innerHTML = `
      <div class="card-thumb">
        <img src="${thumb}" alt="${title}" loading="lazy" onerror="this.src='https://via.placeholder.com/220x300/0d1119/5a6480?text=📌'"/>
        <div class="play-badge"><div class="play-icon"></div>VIDEO</div>
      </div>
      <div class="card-body">
        <div class="card-title">${title || 'Untitled Pin'}</div>
        <div class="card-meta">
          <span class="card-author">${author}</span>
          <a class="card-link" href="${pin.pinUrl}" target="_blank" rel="noopener">
            View ↗
          </a>
        </div>
      </div>
    `;
    return div;
  }

  function renderPins(pins) {
    const grid = document.getElementById('pinsGrid');
    grid.innerHTML = '';
    if (!pins || pins.length === 0) { showEmpty(); return; }

    pins.forEach((pin, i) => {
      grid.appendChild(buildCard(pin, i * 30));
    });

    showGrid();
  }

  // ── API CALLS ───────────────────────────────────────────────────────────

  async function loadRandom() {
    showSkeleton();
    setStatus('Scraping trending video pins...');
    try {
      const res = await fetch(`${API}/pins/random`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      renderPins(data.pins);
      setStatus(`Found <strong>${data.count}</strong> video pins — trending`);
      updateCacheCount();
      toast(`✓ Loaded ${data.count} video pins`);
    } catch (err) {
      showEmpty();
      setStatus('Failed to scrape Pinterest');
      toast(`Error: ${err.message}`, 'error');
      console.error(err);
    }
  }

  async function doSearch() {
    const q = document.getElementById('searchInput').value.trim();
    if (!q) { toast('Enter a search term first', 'error'); return; }

    showLoading(`SEARCHING "${q.toUpperCase()}"...`);
    setStatus(`Searching for "<strong>${q}</strong>"...`);

    try {
      const res = await fetch(`${API}/pins/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      renderPins(data.pins);
      setStatus(`<strong>${data.count}</strong> video pins for "<strong>${q}</strong>" — live + cached`);
      updateCacheCount();
      toast(`✓ ${data.count} results for "${q}"`);
    } catch (err) {
      showEmpty();
      setStatus('Search failed');
      toast(`Error: ${err.message}`, 'error');
    }
  }

  async function loadCached() {
    showLoading('LOADING CACHE...');
    try {
      const res = await fetch(`${API}/pins/cached`);
      const data = await res.json();
      renderPins(data.pins);
      setStatus(`<strong>${data.count}</strong> cached video pins`);
      toast(`Showing ${data.count} cached pins`);
    } catch (err) {
      showEmpty();
      toast('Failed to load cache', 'error');
    }
  }

  async function updateCacheCount() {
    try {
      const res = await fetch(`${API}/pins/cached`);
      const data = await res.json();
      document.getElementById('cacheCount').textContent = `${data.count} cached`;
    } catch {}
  }

  // ── KEYBOARD SHORTCUT ───────────────────────────────────────────────────

  document.getElementById('searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
  });

  // ── INIT ────────────────────────────────────────────────────────────────
  loadRandom();
  updateCacheCount();
</script>
</body>
</html>

root package.json with conviniet scripts 

{
  "name": "pinterest-video-scraper",
  "version": "1.0.0",
  "description": "Pinterest video pin scraper — Node.js + Playwright + SQLite",
  "scripts": {
    "install:backend": "cd backend && npm install",
    "setup:playwright": "cd backend && npx playwright install chromium",
    "start": "cd backend && node server.js",
    "dev": "cd backend && npx nodemon server.js"
  }
}

readme with full setup instructiosn
# PinVid — Pinterest Video Scraper

Scrapes Pinterest for **video-only pins**, caches them locally in SQLite, and serves a slick dark UI with live + cached search.

---

## Stack
- **Backend**: Node.js + Express
- **Scraping**: Playwright (headless Chromium, stealth mode)
- **Cache**: SQLite via `better-sqlite3`
- **Frontend**: Plain HTML/CSS/JS (served by Express)

---

## Setup

### 1. Install dependencies
```bash
cd backend
npm install
```

### 2. Install Playwright browser (one-time)
```bash
npx playwright install chromium
```

### 3. Run the server
```bash
# Production
node server.js

# Dev (auto-reload)
npx nodemon server.js
```

### 4. Open the app
Visit: **http://localhost:3001**

---

## How It Works

| Feature | What happens |
|---|---|
| Page load | Auto-scrapes Pinterest trending video feed |
| Search bar | Hits Pinterest live + queries local SQLite cache simultaneously |
| Cached tab | Shows all previously scraped pins from SQLite |
| Refresh button | Re-scrapes fresh pins |

---

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/pins/random` | Scrape trending video pins |
| `GET /api/pins/search?q=keyword` | Live scrape + cache search merged |
| `GET /api/pins/cached` | Return all cached pins from SQLite |

---

## Notes

- Pinterest may redirect to a login wall — the scraper handles this gracefully and returns an empty result
- All scraped pins are cached in `backend/data/pins.db` (SQLite)
- The scraper uses random delays + stealth headers to avoid blocks
- For best results, run from a residential IP (not a datacenter/VPS)

---

## File Structure

```
pinterest-scraper/
├── backend/
│   ├── server.js       ← Express app + API routes
│   ├── scraper.js      ← Playwright scraping logic
│   ├── db.js           ← SQLite cache layer
│   ├── data/           ← Auto-created, holds pins.db
│   └── package.json
├── frontend/
│   └── public/
│       └── index.html  ← Full UI (served by Express)
└── README.md
```

Build a Pinterest video scraper application with the following specs:

## Project: Pinterest Video Scraper

### Stack
- **Backend**: Node.js + Express
- **Scraping**: Playwright (headless Chromium)
- **Frontend**: React (Vite) or plain HTML/JS — your call, make it clean

---

### Core Features

#### 1. Auto-Scrape on Load
- When the app starts/page loads, automatically scrape Pinterest for random trending video pins
- Target: `https://www.pinterest.com/search/pins/?q=videos&rs=typed` or the Pinterest home feed
- Filter ONLY pins that contain videos (look for `<video>` tags or Pinterest's video pin markers in the DOM)
- Extract per pin:
  - Video URL (direct .mp4 or Pinterest video src)
  - Thumbnail image
  - Pin title / description
  - Pin URL (original Pinterest link)
  - Pin author/username

#### 2. Keyword Search
- Search bar on frontend
- On search submit → backend hits: `https://www.pinterest.com/search/pins/?q={keyword}&rs=typed`
- Scrape that page, filter video-only pins, return results
- Also search within already-scraped/cached local results simultaneously
- Merge and deduplicate both results

#### 3. Local Cache
- Store scraped pins in a local JSON file or SQLite DB
- On search, query local cache first, then live scrape
- Avoid duplicate pins by checking pin URL

---

### Scraping Logic (Important)
- Use **Playwright** with a real user-agent string to avoid blocks
- Add random delays (1500–3000ms) between actions to mimic human behavior
- Wait for the Pinterest feed to fully load (wait for `[data-test-id="pin"]` or video elements)
- Scroll the page 3–5 times to load more pins before extracting
- Handle login walls gracefully — if Pinterest redirects to login, use the guest/anonymous search URL instead
- Video pin detection: check if the pin element contains a `video` tag OR has a class/attribute Pinterest uses for video pins (inspect and hardcode the selector)

---

### API Endpoints (Express)
- `GET /api/pins/random` → returns auto-scraped random video pins (20–30 pins)
- `GET /api/pins/search?q={keyword}` → live scrape + local cache search, returns merged results
- `GET /api/pins/cached` → returns all locally cached pins

---

### Frontend UI
- Clean dark-themed UI
- Masonry/grid layout for video pin cards
- Each card shows: thumbnail (with play icon overlay), title, author, link to original pin
- Search bar at top — debounced input, triggers search on Enter or button click
- Loading skeleton while scraping
- "Load More" button for pagination

---

### Notes
- Pinterest blocks aggressive scrapers — use Playwright's `stealth` plugin (`playwright-extra` + `puppeteer-extra-plugin-stealth` ported to Playwright) to bypass bot detection
- Respect rate limits — don't hammer Pinterest, add delays
- This is for personal/educational use only
