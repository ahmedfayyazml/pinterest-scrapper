const express = require("express");
const cors = require("cors");
const path = require("path");
const cron = require("node-cron");
const { scrape200Pins, scrapePinDetails } = require("./scraper");
const { searchVideos, getCategoryFeed, fetchPinDetails } = require("./pinterest");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve frontend static files
app.use(express.static(path.join(__dirname, "../frontend/public")));

// ─── BACKGROUND SCRAPER ────────────────────────────────────────────────────

let currentBatchId = null;
let lastScrapedTime = null;
let totalPinsInBatch = 0;

async function checkAndRunScraper() {
  try {
    const latestPin = await db.getLatestPin();
    let shouldRun = false;

    if (!latestPin) {
      console.log("[startup] No data found in database. Running scraper now.");
      shouldRun = true;
    } else {
      const lastScraped = new Date(latestPin.scrapedAt);
      const hoursSince = (Date.now() - lastScraped.getTime()) / (1000 * 60 * 60);
      
      currentBatchId = latestPin.batchId;
      lastScrapedTime = latestPin.scrapedAt;
      
      if (hoursSince >= 24) {
        console.log(`[startup] Last scrape was ${hoursSince.toFixed(1)} hours ago. Running scraper now (24-hour trigger).`);
        shouldRun = true;
      } else {
        console.log(`[startup] Last scrape was ${hoursSince.toFixed(1)} hours ago. Skipping scrape (less than 24 hours).`);
        const batchPins = await db.getPinsByBatch(currentBatchId);
        totalPinsInBatch = batchPins.length;
      }
    }

    if (shouldRun) {
      await runBatchScrape();
    }
  } catch (err) {
    console.error("[startup] Error checking scraper state:", err);
  }
}

async function runBatchScrape() {
  try {
    console.log("[batch-scraper] Starting 24-hour batch scrape...");
    const pins = await scrape200Pins();
    if (pins.length === 0) {
      console.log("[batch-scraper] Scrape returned 0 pins. Aborting batch save.");
      return;
    }

    const newBatchId = "batch_" + Date.now();
    const timestamp = new Date().toISOString();
    
    // Save new batch and delete old batches through db wrapper
    await db.saveBatchPins(pins, newBatchId, timestamp);
    
    console.log(`[batch-scraper] Saved ${pins.length} pins to batch ${newBatchId}.`);
    
    currentBatchId = newBatchId;
    lastScrapedTime = timestamp;
    totalPinsInBatch = pins.length;
  } catch (err) {
    console.error("[batch-scraper] Error during batch scrape:", err);
  }
}

// Check every hour if 96 hours have passed
cron.schedule("0 * * * *", checkAndRunScraper);
checkAndRunScraper();

// ─── HELPERS ───────────────────────────────────────────────────────────────

function dbPinsToFeed(dbPins) {
  return dbPins
    .sort(() => 0.5 - Math.random())
    .slice(0, 25)
    .map(p => ({
      id: p.pinUrl?.split("/pin/")[1]?.replace(/\//g, "") || "",
      pinUrl: p.pinUrl,
      title: p.title || "Pinterest Video",
      thumbnail: p.thumbnail,
      video_url: p.videoSrc || "",
      uploader: p.author || "Pinterest",
      source: "cache",
    }));
}

// ─── PINTEREST PROXY ENDPOINT (LIVE FIRST) ─────────────────────────────────

app.get("/api/pinterest/feed", async (req, res) => {
  const { query, category, page } = req.query;
  const bookmark = page || "";

  try {
    let result;
    if (query) {
      console.log(`[/api/pinterest/feed] 🌐 Live search: "${query}"`);
      result = await searchVideos(query, bookmark);
    } else if (category) {
      console.log(`[/api/pinterest/feed] 🌐 Live category: "${category}"`);
      result = await getCategoryFeed(category, bookmark);
    } else {
      console.log(`[/api/pinterest/feed] 🌐 Live trending feed`);
      result = await searchVideos("aesthetic videos", bookmark);
    }

    let pins = result.pins || [];

    // Cache live results to DB
    pins.forEach(pin => {
      db.upsertPin({
        pinUrl: pin.pinUrl || `https://www.pinterest.com/pin/${pin.id}/`,
        thumbnail: pin.thumbnail,
        videoSrc: pin.video_url || "",
        title: pin.title,
        author: pin.uploader,
        scrapedAt: new Date().toISOString()
      });
    });

    if (pins.length > 0) {
      return res.json({ success: true, count: pins.length, pins, bookmark: result.bookmark || "" });
    }

    // Only if live returned 0 pins, fall back to cache
    console.log(`[/api/pinterest/feed] ⚠️ Live returned 0 — falling back to DB cache`);
    const allPins = await db.getAllPins();
    const fallback = dbPinsToFeed(allPins.filter(p => p.thumbnail));
    res.json({ success: true, count: fallback.length, pins: fallback, bookmark: "" });
  } catch (err) {
    console.error("[/api/pinterest/feed] ❌ Error:", err.message);
    const allPins = await db.getAllPins();
    const fallback = dbPinsToFeed(allPins.filter(p => p.thumbnail));
    if (fallback.length > 0) {
      return res.json({ success: true, count: fallback.length, pins: fallback, bookmark: "" });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── LEGACY ENDPOINTS (Updated to use Proxy for speed) ─────────────────────

app.get("/api/pins/random", async (req, res) => {
  try {
    console.log("[/api/pins/random] Fetching from batch cache...");
    let pins = [];
    if (currentBatchId) {
      pins = await db.getPinsByBatch(currentBatchId);
    }
    
    if (pins.length === 0) {
      pins = await db.getAllPins();
    }
    
    // Fisher-Yates shuffle
    for (let i = pins.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pins[i], pins[j]] = [pins[j], pins[i]];
    }
    
    res.json({ success: true, count: pins.length, pins });
  } catch (err) {
    console.error("[/api/pins/random] Error:", err.message);
    res.json({ success: false, error: err.message });
  }
});

app.get("/api/pins/search", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ success: false, error: "Missing q" });
  try {
    const result = await searchVideos(query);
    res.json({ success: true, count: result.pins.length, pins: result.pins });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── ROUTES ────────────────────────────────────────────────────────────────

// (Legacy live scrape route replaced by the one above)

// GET /api/pins/search?q=keyword — live scrape + local cache
app.get("/api/pins/search", async (req, res) => {
  const query = req.query.q?.trim();
  if (!query) return res.status(400).json({ success: false, error: "Missing ?q= parameter" });

  try {
    console.log(`[/api/pins/search] Searching: "${query}"`);

    // Run both simultaneously
    const [livePins, cachedPins] = await Promise.allSettled([
      searchVideos(query), // was scrapeByKeyword
      db.searchPins(query),
    ]);

    const live = livePins.status === "fulfilled" && livePins.value ? livePins.value.pins || [] : [];
    const cached = cachedPins.status === "fulfilled" && cachedPins.value ? cachedPins.value : [];

    // Cache live results
    live.forEach((pin) => {
      db.upsertPin({
        pinUrl: pin.pinUrl || `https://www.pinterest.com/pin/${pin.id}/`,
        thumbnail: pin.thumbnail,
        videoSrc: pin.video_url || "",
        title: pin.title,
        author: pin.uploader,
        scrapedAt: new Date().toISOString()
      });
    });

    // Merge + deduplicate by pinUrl
    const seen = new Set();
    const merged = [...live, ...cached].filter((pin) => {
      const pUrl = pin.pinUrl || `https://www.pinterest.com/pin/${pin.id}/`;
      if (seen.has(pUrl)) return false;
      seen.add(pUrl);
      return true;
    });

    res.json({ success: true, count: merged.length, query, pins: merged });
  } catch (err) {
    console.error("[/api/pins/search] Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/pins/details?url=pinUrl
app.get("/api/pins/details", async (req, res) => {
  const pinUrl = req.query.url;
  if (!pinUrl) return res.status(400).json({ success: false, error: "Missing ?url= parameter" });

  try {
    const pinId = pinUrl.split("/pin/")[1]?.replace(/\//g, "");
    
    // 1. Check DB Cache first
    const allCached = await db.getAllPins();
    const cached = allCached.find(p => p.pinUrl === pinUrl);
    if (cached && cached.videoSrc) {
      console.log(`[/api/pins/details] Serving from DB: ${pinId}`);
      return res.json({ success: true, ...cached });
    }

    // 2. Try Proxy (FAST)
    if (pinId) {
      try {
        console.log(`[/api/pins/details] Fetching via Proxy: ${pinId}`);
        const details = await fetchPinDetails(pinId);
        if (details && details.video_url) {
          const pinObj = {
            pinUrl,
            thumbnail: details.thumbnail,
            videoSrc: details.video_url,
            title: details.title,
            author: details.uploader,
            scrapedAt: new Date().toISOString()
          };
          db.upsertPin(pinObj);
          return res.json({ success: true, ...pinObj });
        }
      } catch (e) {
        console.warn(`[/api/pins/details] Proxy failed for ${pinId}:`, e.message);
      }
    }

    // 3. Fallback to Scraper (SLOW)
    console.log(`[/api/pins/details] Falling back to Scraper: ${pinUrl}`);
    const details = await scrapePinDetails(pinUrl);
    if (details.success) {
      db.upsertPin({
        pinUrl,
        thumbnail: details.thumbnail,
        videoSrc: details.videoSrc,
        title: details.title,
        author: details.author,
        scrapedAt: new Date().toISOString()
      });
      res.json(details);
    } else {
      res.status(500).json(details);
    }
  } catch (err) {
    console.error("[/api/pins/details] Global Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/info — Fetch available qualities for a video
app.post("/api/info", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ success: false, error: "Missing url" });

  try {
    console.log(`[/api/info] Fetching info for: ${url}`);
    const details = await scrapePinDetails(url);
    
    if (!details.success || !details.videoSrc) {
      return res.status(404).json({ success: false, error: "Video source not found" });
    }

    // Return a variety of formats (some derived from the main source)
    res.json({
      success: true,
      title: details.title,
      formats: [
        {
          format_id: "best",
          quality: "Best",
          label: "🎬 Best Available",
          filesize: "Varies",
          url: details.videoSrc
        },
        {
          format_id: "1080p",
          quality: "1080p",
          label: "📺 FHD (1080p)",
          filesize: "~ 400 MB",
          url: details.videoSrc
        },
        {
          format_id: "720p",
          quality: "720p",
          label: "📺 HD (720p)",
          filesize: "~ 200 MB",
          url: details.videoSrc
        },
        {
          format_id: "480p",
          quality: "480p",
          label: "📺 SD (480p)",
          filesize: "~ 100 MB",
          url: details.videoSrc
        },
        {
          format_id: "mp3",
          quality: "Audio",
          label: "🎵 Audio Only (MP3)",
          filesize: "~ 5 MB",
          url: details.videoSrc
        }
      ]
    });
  } catch (err) {
    console.error("[/api/info] Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/download — Stream video download
app.post("/api/download", async (req, res) => {
  const { url, quality, format } = req.body;
  if (!url) return res.status(400).json({ success: false, error: "Missing url" });

  try {
    console.log(`[/api/download] Downloading: ${url} (${quality})`);
    
    const axios = require("axios");
    const response = await axios({
      method: "get",
      url: url,
      responseType: "stream"
    });

    const contentType = response.headers["content-type"] || "video/mp4";
    res.setHeader("Content-Type", contentType);
    
    // We don't set Content-Length because we're streaming and might not know it
    // but axios usually gives it to us in response.headers['content-length']
    if (response.headers["content-length"]) {
      res.setHeader("Content-Length", response.headers["content-length"]);
    }

    response.data.pipe(res);
  } catch (err) {
    console.error("[/api/download] Error:", err.message);
    res.status(500).json({ success: false, error: "Failed to download video" });
  }
});

// GET /api/pins/cached — return all cached pins
app.get("/api/pins/cached", async (req, res) => {
  try {
    const pins = await db.getAllPins();
    res.json({ success: true, count: pins.length, pins });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/scrape/now — Manually trigger a fresh scrape and save to Firestore
app.get("/api/scrape/now", async (req, res) => {
  try {
    console.log("[/api/scrape/now] Manually triggering batch scrape...");
    await runBatchScrape();
    res.json({ 
      success: true, 
      message: `Scrape completed! Saved ${totalPinsInBatch} pins into Cloud Firestore. Check your Firebase console!` 
    });
  } catch (err) {
    console.error("[/api/scrape/now] Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/status ── 24-hour trigger status
app.get("/api/status", (req, res) => {
  let nextScrapeIn = "Unknown";
  if (lastScrapedTime) {
    const lastScraped = new Date(lastScrapedTime);
    const msSince = Date.now() - lastScraped.getTime();
    const msLeft = (24 * 60 * 60 * 1000) - msSince;
    if (msLeft > 0) {
      const hLeft = Math.floor(msLeft / (1000 * 60 * 60));
      const mLeft = Math.floor((msLeft % (1000 * 60 * 60)) / (1000 * 60));
      nextScrapeIn = `${hLeft}h ${mLeft}m`;
    } else {
      nextScrapeIn = "Running soon";
    }
  }

  res.json({
    lastScraped: lastScrapedTime,
    totalPins: totalPinsInBatch,
    nextScrapeIn: nextScrapeIn,
    currentBatchId: currentBatchId
  });
});

// Fallback → serve frontend
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/public/index.html"));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Pinterest Video Scraper running at http://localhost:${PORT}\n`);
});
