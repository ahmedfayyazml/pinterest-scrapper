require('dotenv').config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const cron = require("node-cron");
const axios = require("axios");
const { scrape200Pins, scrapePinDetails } = require("./scraper");
const { searchVideos, getCategoryFeed, fetchPinDetails } = require("./pinterest");
const db = require("./db");
const proxyManager = require("./proxyManager");

// Lazy-load socks-proxy-agent only when actually needed (Tier 3)
let SocksProxyAgent;
try { SocksProxyAgent = require("socks-proxy-agent").SocksProxyAgent; } catch(e) { /* installed later */ }

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve frontend static files
app.use(express.static(path.join(__dirname, "../frontend/public")));

// ─── HELPERS: Sanitize data before Firestore writes ────────────────────────

function sanitizeForFirestore(obj) {
  const clean = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      clean[key] = value;
    }
  }
  return clean;
}

// ─── MEDIA PROXY — Hybrid Tier 2 / Tier 3 ──────────────────────────────────
// Tier 2 (default): VPS direct pipe — streams through our server with
//   injected Referer/Origin headers, NO SOCKS5 proxy bandwidth used.
// Tier 3 (forceProxy=true): Last resort — routes via the residential
//   SOCKS5 proxy, counts against the 8/day limit.

const PINTEREST_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Referer": "https://www.pinterest.com/",
  "Origin": "https://www.pinterest.com",
  "Accept": "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "video",
  "Sec-Fetch-Mode": "no-cors",
  "Sec-Fetch-Site": "cross-site",
};

function buildAxiosOpts(forceProxy, isStream = true) {
  const opts = {
    timeout: 30000,
    headers: { ...PINTEREST_HEADERS },
  };
  if (isStream) opts.responseType = "stream";

  if (forceProxy) {
    // Use HTTP proxy mode for axios (Proxy Cheap supports HTTP on :8080)
    // Parse credentials from the SOCKS5 URL and build an HTTP proxy config
    const proxyUrl = proxyManager.getProxyUrl();
    if (proxyUrl) {
      try {
        // proxyUrl is like socks5://user:pass@host:port — extract parts
        const parsed = new URL(proxyUrl.replace(/^socks5:\/\//, "http://"));
        opts.proxy = {
          host: parsed.hostname,
          port: parseInt(parsed.port),
          auth: parsed.username ? {
            username: decodeURIComponent(parsed.username),
            password: decodeURIComponent(parsed.password),
          } : undefined,
        };
      } catch (e) {
        console.warn("[buildAxiosOpts] Failed to parse proxy URL:", e.message);
      }
    }
  }
  return opts;
}

app.get("/api/proxy/media", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("Missing ?url=");

  const forceProxy = req.query.forceProxy === "true";

  // Only allow proxying Pinterest CDN domains
  const allowed = ["pinimg.com", "pinterest.com"];
  try {
    const hostname = new URL(targetUrl).hostname;
    if (!allowed.some(d => hostname.endsWith(d))) {
      return res.status(403).send("Forbidden domain");
    }
  } catch (e) {
    return res.status(400).send("Invalid URL");
  }

  // Tier 3 gate: check quota before using the expensive proxy
  if (forceProxy) {
    if (!proxyManager.canUseProxy()) {
      return res.status(429).json({
        error: "Proxy limit reached for today",
        ...proxyManager.getStatus(),
      });
    }
    proxyManager.useProxy();
    console.log(`[/api/proxy/media] Tier 3 (SOCKS5 proxy) for: ${targetUrl}`);
  } else {
    console.log(`[/api/proxy/media] Tier 2 (VPS direct pipe) for: ${targetUrl}`);
  }

  try {
    const response = await axios.get(targetUrl, buildAxiosOpts(forceProxy, true));

    // Forward content headers
    const ct = response.headers["content-type"];
    if (ct) res.setHeader("Content-Type", ct);
    const cl = response.headers["content-length"];
    if (cl) res.setHeader("Content-Length", cl);
    const cr = response.headers["content-range"];
    if (cr) res.setHeader("Content-Range", cr);
    const ar = response.headers["accept-ranges"];
    if (ar) res.setHeader("Accept-Ranges", ar);

    // Cache for 1 hour to reduce repeat fetches
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Access-Control-Allow-Origin", "*");

    response.data.pipe(res);
  } catch (err) {
    console.error(`[/api/proxy/media] Error proxying ${targetUrl}:`, err.message);
    if (!res.headersSent) {
      res.status(502).send("Failed to fetch media");
    }
  }
});

// HLS .m3u8 proxy — rewrites segment URLs inside the playlist
// Supports forceProxy param for Tier 3 fallback
app.get("/api/proxy/hls", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("Missing ?url=");

  const forceProxy = req.query.forceProxy === "true";

  // Tier 3 gate
  if (forceProxy) {
    if (!proxyManager.canUseProxy()) {
      return res.status(429).json({
        error: "Proxy limit reached for today",
        ...proxyManager.getStatus(),
      });
    }
    proxyManager.useProxy();
    console.log(`[/api/proxy/hls] Tier 3 (SOCKS5 proxy) for: ${targetUrl}`);
  } else {
    console.log(`[/api/proxy/hls] Tier 2 (VPS direct) for: ${targetUrl}`);
  }

  try {
    const response = await axios.get(targetUrl, buildAxiosOpts(forceProxy, false));

    let playlist = response.data;

    // Determine the base URL for resolving relative segment paths
    const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);

    // Get the API base for building proxy URLs
    const proto = req.headers["x-forwarded-proto"] || req.protocol;
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const apiBase = `${proto}://${host}`;

    // Propagate forceProxy flag into rewritten URLs so all segments
    // also route through the SOCKS5 proxy if we're in Tier 3
    const fpParam = forceProxy ? "&forceProxy=true" : "";

    // Rewrite every line that looks like a segment/variant URL
    playlist = playlist.split("\n").map(line => {
      line = line.trim();
      if (!line || line.startsWith("#")) {
        // Rewrite URI= attributes inside #EXT tags (e.g. encryption key URIs)
        if (line.includes('URI="')) {
          line = line.replace(/URI="([^"]+)"/g, (match, uri) => {
            const absUri = uri.startsWith("http") ? uri : baseUrl + uri;
            return `URI="${apiBase}/api/proxy/media?url=${encodeURIComponent(absUri)}${fpParam}"`;
          });
        }
        return line;
      }
      // It's a URL line (segment or sub-playlist)
      const absUrl = line.startsWith("http") ? line : baseUrl + line;
      if (absUrl.endsWith(".m3u8")) {
        return `${apiBase}/api/proxy/hls?url=${encodeURIComponent(absUrl)}${fpParam}`;
      }
      return `${apiBase}/api/proxy/media?url=${encodeURIComponent(absUrl)}${fpParam}`;
    }).join("\n");

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(playlist);
  } catch (err) {
    console.error(`[/api/proxy/hls] Error proxying ${targetUrl}:`, err.message);
    if (!res.headersSent) {
      res.status(502).send("Failed to fetch HLS playlist");
    }
  }
});

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
        try {
          if (currentBatchId) {
            const batchPins = await db.getPinsByBatch(currentBatchId);
            totalPinsInBatch = batchPins.length;
          }
        } catch (e) {
          console.warn("[startup] Could not fetch batch pins:", e.message);
        }
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

// Check every hour if 24 hours have passed
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

    // Cache live results to DB (sanitized)
    pins.forEach(pin => {
      db.upsertPin(sanitizeForFirestore({
        pinUrl: pin.pinUrl || `https://www.pinterest.com/pin/${pin.id}/`,
        thumbnail: pin.thumbnail || "",
        videoSrc: pin.video_url || "",
        title: pin.title || "Pinterest Video",
        author: pin.uploader || "Pinterest",
        scrapedAt: new Date().toISOString()
      }));
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
      try {
        pins = await db.getPinsByBatch(currentBatchId);
      } catch (e) {
        console.warn("[/api/pins/random] Failed to fetch batch:", e.message);
      }
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

    // Cache live results (sanitized)
    live.forEach((pin) => {
      db.upsertPin(sanitizeForFirestore({
        pinUrl: pin.pinUrl || `https://www.pinterest.com/pin/${pin.id}/`,
        thumbnail: pin.thumbnail || "",
        videoSrc: pin.video_url || "",
        title: pin.title || "Pinterest Video",
        author: pin.uploader || "Pinterest",
        scrapedAt: new Date().toISOString()
      }));
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
          const pinObj = sanitizeForFirestore({
            pinUrl,
            thumbnail: details.thumbnail || "",
            videoSrc: details.video_url,
            title: details.title || "Pinterest Video",
            author: details.uploader || "Pinterest",
            scrapedAt: new Date().toISOString()
          });
          db.upsertPin(pinObj);
          return res.json({ success: true, ...pinObj });
        }
      } catch (e) {
        console.warn(`[/api/pins/details] Proxy failed for ${pinId}:`, e.message);
      }
    }

    // 3. Fallback to Scraper (yt-dlp with proxy support)
    console.log(`[/api/pins/details] Falling back to Scraper: ${pinUrl}`);
    const details = await scrapePinDetails(pinUrl);
    if (details.success) {
      const pinObj = sanitizeForFirestore({
        pinUrl,
        thumbnail: details.thumbnail || "",
        videoSrc: details.videoSrc || "",
        title: details.title || "Pinterest Video",
        author: details.author || "Pinterest",
        scrapedAt: new Date().toISOString()
      });
      db.upsertPin(pinObj);
      res.json({ ...details, ...pinObj, success: true });
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

// POST /api/download — Stream video download via yt-dlp
app.post("/api/download", async (req, res) => {
  const { url, quality, format } = req.body;
  if (!url) return res.status(400).json({ success: false, error: "Missing url" });

  try {
    console.log(`[/api/download] Spawning yt-dlp to stream: ${url} (${quality || 'best'})`);
    
    const { spawn } = require("child_process");
    
    // Set headers for file download
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="pinterest_video.mp4"');

    // Build yt-dlp arguments
    const args = ["-o", "-"];

    // Add proxy if available and quota permits
    if (proxyManager.canUseProxy()) {
      args.push("--proxy", proxyManager.getProxyUrl());
      proxyManager.useProxy();
    }
    
    // If quality or format is audio-only
    if (quality === "mp3" || format === "mp3" || quality === "Audio") {
      args.push("-f", "ba"); // best audio
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Disposition", 'attachment; filename="pinterest_audio.mp3"');
    } else {
      args.push("-f", "bv*+ba/b"); // best video and audio merged
    }
    
    args.push(url);

    const child = spawn("yt-dlp", args);
    
    // Pipe stdout of yt-dlp directly to the HTTP response
    child.stdout.pipe(res);

    child.stderr.on("data", (data) => {
      // Log progress or debug info from yt-dlp
      console.log(`[download-stream-stderr] ${data.toString().trim()}`);
    });

    child.on("close", (code) => {
      console.log(`[/api/download] yt-dlp streaming finished with code ${code}`);
      res.end();
    });

    // If request is aborted by the client, kill the yt-dlp process to free resources
    req.on("close", () => {
      if (!child.killed) {
        console.log(`[/api/download] Request aborted. Killing yt-dlp process.`);
        child.kill("SIGKILL");
      }
    });

  } catch (err) {
    console.error("[/api/download] Error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: "Failed to download video" });
    }
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

// GET /api/status ── 24-hour trigger status + proxy quota
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
    currentBatchId: currentBatchId,
    proxy: proxyManager.getStatus(),
  });
});

// Fallback → serve frontend
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/public/index.html"));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Pinterest Video Scraper running at http://localhost:${PORT}\n`);
});
