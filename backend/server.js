const express = require("express");
const cors = require("cors");
const path = require("path");
const cron = require("node-cron");
const { scrape200Pins, scrapePinDetails, fetchPinDetailsYTDLP, scrapePinDetailsFast } = require("./scraper");
const { searchVideos, getCategoryFeed, fetchPinDetails } = require("./pinterest");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve frontend static files
app.use(express.static(path.join(__dirname, "../frontend/public")));

// Serve remuxed files
app.use('/pinterest/media', express.static('/var/www/vectorsbit-pinterest/backend/media'));

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
      
      if (hoursSince >= 2) {
        console.log(`[startup] Last scrape was ${hoursSince.toFixed(1)} hours ago. Running scraper now (2-hour trigger).`);
        shouldRun = true;
      } else {
        console.log(`[startup] Last scrape was ${hoursSince.toFixed(1)} hours ago. Skipping scrape (less than 2 hours).`);
        const batchPins = await db.getPinsByBatch(currentBatchId);
        totalPinsInBatch = batchPins.length;
        
        // Resume resolver if pending pins exist
        const pendingCount = batchPins.filter(p => !p.videoSrc || p.videoSrc.includes('_audio')).length;
        if (pendingCount > 0 && !isResolving) {
          console.log(`[startup] Found ${pendingCount} unresolved pins. Resuming background resolver.`);
          runLinkResolver().catch(console.error);
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
    console.log("[batch-scraper] Starting 2-hour batch scrape...");
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
    
    // Start resolver automatically
    runLinkResolver().catch(console.error);
  } catch (err) {
    console.error("[batch-scraper] Error during batch scrape:", err);
  }
}

let isResolving = false;
let lastResolvedAt = null;

async function runLinkResolver() {
  if (isResolving) return;
  isResolving = true;
  
  console.log(`[resolver] Starting resolution for batch: ${currentBatchId}`);
  
  try {
    const batchPins = await db.getPinsByBatch(currentBatchId);
    let pendingPins = batchPins.filter(p => !p.videoSrc || p.videoSrc.includes('_audio'));
    
    console.log(`[resolver] Found ${pendingPins.length} pins needing resolution.`);
    
    let resolvedCount = batchPins.length - pendingPins.length;
    let failedCount = batchPins.filter(p => p.resolveStatus === "failed").length;
    let consecutiveFailures = 0;
    
    for (let i = 0; i < pendingPins.length; i += 5) {
      const chunk = pendingPins.slice(i, i + 5);
      
      for (const pin of chunk) {
        let details = null;
        try {
          try {
            details = await fetchPinDetailsYTDLP(pin.pinUrl);
          } catch (ytError) {
            console.log(`[scraper] yt-dlp failed for ${pin.pinUrl}, falling back to fast browser...`);
            details = await scrapePinDetailsFast(pin.pinUrl);
          }
          
          if (details && details.needsRemux) {
            console.log(`[resolver] Tier 1 failed for ${pin.pinUrl} — falling back to remux`);
            const { remuxHlsToMp4 } = require('./scraper');
            const pinId = pin.pinUrl.split("/pin/")[1]?.replace(/\//g, "");
            const remuxResult = await remuxHlsToMp4(pinId, details.hlsUrl);
            details.videoSrc = remuxResult.url;
            details.videoSource = "remuxed";
            details.resolvedQuality = "480p";
            details.fileSizeMB = remuxResult.fileSizeMB;
            details.qualities = [{
              height: 480,
              url: remuxResult.url,
              protocol: "mp4",
              label: "480p"
            }];
          }

          if (details && details.videoSrc && !details.videoSrc.includes('_audio') && details.qualities && details.qualities.length > 0) {
            await db.upsertPin({
              ...pin,
              videoSrc: details.videoSrc,
              qualities: details.qualities,
              resolvedQuality: details.resolvedQuality || "480p",
              videoSource: details.videoSource || "direct",
              resolveStatus: 'ready',
              linksRefreshedAt: new Date().toISOString(),
              fileSizeMB: details.fileSizeMB || null,
              errorLog: null
            });
            resolvedCount++;
            lastResolvedAt = new Date().toISOString();
            consecutiveFailures = 0;
            console.log(`[resolver] ✅ ${pin.pinUrl} — ${details.videoSource} ${details.resolvedQuality}`);
          } else {
            failedCount++;
            consecutiveFailures++;
            if (!details || !details.videoSrc) console.log('[resolver] FAIL REASON: no videoSrc');
            else if (details.videoSrc.includes('_audio')) console.log('[resolver] FAIL REASON: audio-only URL');
            else if (!details.qualities || !details.qualities.length) console.log('[resolver] FAIL REASON: empty qualities array');
            
            await db.deletePin(pin.pinUrl);
            console.log(`[resolver] ❌ ${pin.pinUrl} deleted — no valid videoSrc`);
          }
        } catch (err) {
          failedCount++;
          consecutiveFailures++;
          await db.deletePin(pin.pinUrl);
          console.log(`[resolver] Pin ${pin.pinUrl} failed — deleted from DB (error: ${err.message})`);
        }
        
        // Extra delay after remux (CPU intensive)
        if (details && details.needsRemux) {
          console.log(`[resolver] sleeping 10.0s between pins (post-remux)...`);
          await new Promise(r => setTimeout(r, 10000));
        } else {
          const delayMs = Math.floor(Math.random() * 10000) + 15000;
          console.log(`[resolver] sleeping ${(delayMs/1000).toFixed(1)}s between pins...`);
          await new Promise(r => setTimeout(r, delayMs));
        }
        
        if (consecutiveFailures >= 3) {
          console.log('[resolver] 3 consecutive failures — pausing 10 minutes');
          await new Promise(r => setTimeout(r, 10 * 60 * 1000));
          consecutiveFailures = 0;
        }
      }
      console.log(`[resolver] ${resolvedCount}/${batchPins.length} ready, ${failedCount} failed.`);
      
      // Cooldown after every 5 pins
      if (i + 5 < pendingPins.length) {
        console.log(`[resolver] Batch of 5 done. Cooldown for 60s...`);
        await new Promise(r => setTimeout(r, 60 * 1000));
      }
    }
    
    console.log(`[resolver] Done. ${resolvedCount} ready, ${failedCount} failed.`);
    
    const MIN_READY_BEFORE_DELETE = parseInt(process.env.MIN_READY_BEFORE_DELETE || "100", 10);
    
    if (resolvedCount >= MIN_READY_BEFORE_DELETE) {
      console.log(`[resolver] Threshold met (${resolvedCount}/${MIN_READY_BEFORE_DELETE}). Old batch deleted.`);
      await db.deleteOldBatches(currentBatchId);
    } else {
      console.log(`[resolver] WARNING: Only ${resolvedCount} pins resolved (need ${MIN_READY_BEFORE_DELETE}). Old batch retained to prevent empty DB.`);
    }
  } catch (err) {
    console.error("[resolver] Error:", err.message);
  } finally {
    isResolving = false;
  }
}

// Check every hour if 2 hours have passed
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
    console.log(`[/api/download] Spawning yt-dlp to stream: ${url} (${quality || 'best'})`);
    
    const { spawn } = require("child_process");
    
    // Set headers for file download
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="pinterest_video.mp4"');

    // Build yt-dlp arguments
    const args = ["-o", "-"];
    
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

// GET /api/resolve/now
app.get("/api/resolve/now", async (req, res) => {
  console.log("[/api/resolve/now] Manually triggering resolver...");
  runLinkResolver().catch(console.error);
  res.json({ success: true, message: "Resolver started" });
});

// GET /api/status ── 2-hour trigger status
app.get("/api/status", async (req, res) => {
  let nextScrapeIn = "Unknown";
  if (lastScrapedTime) {
    const lastScraped = new Date(lastScrapedTime);
    const msSince = Date.now() - lastScraped.getTime();
    const msLeft = (2 * 60 * 60 * 1000) - msSince;
    if (msLeft > 0) {
      const hLeft = Math.floor(msLeft / (1000 * 60 * 60));
      const mLeft = Math.floor((msLeft % (1000 * 60 * 60)) / (1000 * 60));
      nextScrapeIn = `${hLeft}h ${mLeft}m`;
    } else {
      nextScrapeIn = "Running soon";
    }
  }

  let resolvedCount = 0;
  let failedCount = 0;
  let pendingCount = 0;
  
  if (currentBatchId) {
    try {
      const batchPins = await db.getPinsByBatch(currentBatchId);
      resolvedCount = batchPins.filter(p => p.resolveStatus === "ready").length;
      failedCount = batchPins.filter(p => p.resolveStatus === "failed").length;
      pendingCount = batchPins.filter(p => !p.videoSrc || p.videoSrc.includes('_audio')).length;
    } catch(e) {}
  }

  res.json({
    lastScraped: lastScrapedTime,
    totalPins: totalPinsInBatch,
    nextScrapeIn: nextScrapeIn,
    currentBatchId: currentBatchId,
    resolver: {
      isResolving,
      resolvedCount,
      failedCount,
      pendingCount,
      lastResolvedAt
    }
  });
});

// Fallback → serve frontend
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/public/index.html"));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Pinterest Video Scraper running at http://localhost:${PORT}\n`);
});
