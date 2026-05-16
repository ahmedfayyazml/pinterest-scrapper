const express = require("express");
const cors = require("cors");
const path = require("path");
const { scrapeRandom, scrapeByKeyword, scrapePinDetails } = require("./scraper");
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

// GET /api/pins/details?url=pinUrl
app.get("/api/pins/details", async (req, res) => {
  const pinUrl = req.query.url;
  if (!pinUrl) return res.status(400).json({ success: false, error: "Missing ?url= parameter" });

  try {
    // Check cache first
    const cached = db.getAllPins().find(p => p.pinUrl === pinUrl);
    
    // We scrape live for video source as it might be missing in grid cache
    const details = await scrapePinDetails(pinUrl);
    
    if (details.success) {
      // Update cache with video source if found
      if (details.videoSrc && cached) {
        cached.videoSrc = details.videoSrc;
        db.upsertPin(cached);
      }
      res.json(details);
    } else {
      res.status(500).json(details);
    }
  } catch (err) {
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
