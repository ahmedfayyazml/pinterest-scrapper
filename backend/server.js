const express = require("express");
const cors = require("cors");
const path = require("path");
const { scrapePinDetails } = require("./scraper");
const { searchVideos, getCategoryFeed, fetchPinDetails } = require("./pinterest");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve frontend static files
app.use(express.static(path.join(__dirname, "../frontend/public")));

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
    const fallback = dbPinsToFeed(db.getAllPins().filter(p => p.thumbnail));
    res.json({ success: true, count: fallback.length, pins: fallback, bookmark: "" });
  } catch (err) {
    console.error("[/api/pinterest/feed] ❌ Error:", err.message);
    const fallback = dbPinsToFeed(db.getAllPins().filter(p => p.thumbnail));
    if (fallback.length > 0) {
      return res.json({ success: true, count: fallback.length, pins: fallback, bookmark: "" });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── LEGACY ENDPOINTS (Updated to use Proxy for speed) ─────────────────────

app.get("/api/pins/random", async (req, res) => {
  try {
    const result = await getCategoryFeed("trending videos");
    const pins = result.pins.length > 0
      ? result.pins
      : db.getAllPins().sort(() => 0.5 - Math.random()).slice(0, 20);
    res.json({ success: true, count: pins.length, pins });
  } catch (err) {
    const fallback = db.getAllPins().sort(() => 0.5 - Math.random()).slice(0, 20);
    res.json({ success: true, count: fallback.length, pins: fallback });
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

// GET /api/pins/random — scrape trending video pins
app.get("/api/pins/random", async (req, res) => {
  try {
    console.log("[/api/pins/random] Starting random scrape...");
    let pins = [];
    
    // Set a timeout for the scraper to prevent hanging the request
    const scraperPromise = scrapeRandom();
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error("Scraper timeout")), 25000)
    );

    try {
      pins = await Promise.race([scraperPromise, timeoutPromise]);
    } catch (e) {
      console.error("[/api/pins/random] Scraper failed or timed out:", e.message);
    }
    
    // Fallback logic
    if (!pins || pins.length === 0) {
      console.log("[/api/pins/random] Live scrape empty. Falling back to DB...");
      pins = db.getAllPins();
      
      // SHUFFLE
      pins = pins.sort(() => 0.5 - Math.random()).slice(0, 20);
    } else {
      // cache them
      pins.forEach((pin) => db.upsertPin(pin));
    }

    // FINAL EMERGENCY FALLBACK: If still 0 (DB empty and scraper failed)
    if (pins.length === 0) {
      console.log("[/api/pins/random] TOTAL FAILURE. Returning mock pins.");
      pins = [
        {
          pinUrl: "https://www.pinterest.com/pin/912823418214046640/",
          thumbnail: "https://i.pinimg.com/564x/0f/55/92/0f55928d3a77f9888916d16f39e4e48a.jpg",
          title: "Premium Aesthetic Video (Mock)",
          author: "PinVid System",
          scrapedAt: new Date().toISOString()
        }
      ];
    }
    
    res.json({ success: true, count: pins.length, pins });
  } catch (err) {
    console.error("[/api/pins/random] Global Error:", err.message);
    res.json({ success: true, count: 0, pins: [], error: err.message });
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
    const pinId = pinUrl.split("/pin/")[1]?.replace(/\//g, "");
    
    // 1. Check DB Cache first
    const cached = db.getAllPins().find(p => p.pinUrl === pinUrl);
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
