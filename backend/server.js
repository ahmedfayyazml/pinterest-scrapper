require('dotenv').config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const cron = require("node-cron");
const axios = require("axios");
const { scrape200Pins, scrapePinDetails, fetchRelatedPins } = require("./scraper");
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
  const t0 = Date.now();
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("Missing ?url=");

  const forceProxy = req.query.forceProxy === "true";
  const shortUrl = targetUrl.split('/').slice(-2).join('/');
  console.log(`[media] ─── Request received: ${shortUrl} | forceProxy=${forceProxy} | t=${t0}`);
  console.log(`[media] [proxy] SOCKS5 active: ${forceProxy}`);

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
  }

  try {
    console.log(`[media] Starting axios request: t+${Date.now() - t0}ms`);
    const response = await axios.get(targetUrl, buildAxiosOpts(forceProxy, true));
    const t1 = Date.now();
    console.log(`[media] Got first byte from CDN: t+${t1 - t0}ms`);
    console.log(`[cdn] Response time: ${t1 - t0}ms`);

    // Forward content headers
    const ct = response.headers["content-type"];
    if (ct) res.setHeader("Content-Type", ct);
    const cl = response.headers["content-length"];
    if (cl) res.setHeader("Content-Length", cl);
    const cr = response.headers["content-range"];
    if (cr) res.setHeader("Content-Range", cr);
    const ar = response.headers["accept-ranges"];
    if (ar) res.setHeader("Accept-Ranges", ar);

    const sizeMB = cl ? (parseInt(cl) / (1024 * 1024)).toFixed(2) : 'unknown';
    const isHls = (ct || '').includes('mpegurl') || targetUrl.includes('.m3u8');
    console.log(`[media] Type: ${isHls ? 'HLS segment' : (ct || 'unknown')} | File size: ${sizeMB} MB`);

    // Cache for 1 hour to reduce repeat fetches
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Access-Control-Allow-Origin", "*");

    console.log(`[media] Starting pipe to client: t+${Date.now() - t0}ms`);
    response.data.pipe(res);
    response.data.on('end', () => {
      console.log(`[media] ─── Pipe complete: ${shortUrl} | total=${Date.now() - t0}ms`);
    });
  } catch (err) {
    console.error(`[media] ❌ Error proxying ${shortUrl}: ${err.message} | t+${Date.now() - t0}ms`);
    if (!res.headersSent) {
      res.status(502).send("Failed to fetch media");
    }
  }
});

// HLS .m3u8 proxy — rewrites segment URLs inside the playlist
// Supports forceProxy param for Tier 3 fallback
app.get("/api/proxy/hls", async (req, res) => {
  const t0 = Date.now();
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("Missing ?url=");

  const forceProxy = req.query.forceProxy === "true";
  const shortUrl = targetUrl.split('/').slice(-2).join('/');
  console.log(`[hls] ─── Request received: ${shortUrl} | forceProxy=${forceProxy} | t=${t0}`);
  console.log(`[hls] [proxy] SOCKS5 active: ${forceProxy}`);

  // Tier 3 gate
  if (forceProxy) {
    if (!proxyManager.canUseProxy()) {
      return res.status(429).json({
        error: "Proxy limit reached for today",
        ...proxyManager.getStatus(),
      });
    }
    proxyManager.useProxy();
  }

  try {
    console.log(`[hls] Fetching manifest: t+${Date.now() - t0}ms`);
    const response = await axios.get(targetUrl, buildAxiosOpts(forceProxy, false));
    const t1 = Date.now();

    let playlist = response.data;
    const manifestSize = playlist.length;
    console.log(`[hls] Manifest received, size: ${manifestSize} bytes | fetch took: ${t1 - t0}ms`);

    // Determine the base URL for resolving relative segment paths
    const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);

    // Get the API base for building proxy URLs
    const proto = req.headers["x-forwarded-proto"] || req.protocol;
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const apiBase = `${proto}://${host}`;

    // Propagate forceProxy flag into rewritten URLs so all segments
    // also route through the SOCKS5 proxy if we're in Tier 3
    const fpParam = forceProxy ? "&forceProxy=true" : "";

    console.log(`[hls] Rewriting segment URLs: t+${Date.now() - t0}ms`);
    // Count segments
    let segmentCount = 0;
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
      segmentCount++;
      // It's a URL line (segment or sub-playlist)
      const absUrl = line.startsWith("http") ? line : baseUrl + line;
      if (absUrl.endsWith(".m3u8")) {
        return `${apiBase}/api/proxy/hls?url=${encodeURIComponent(absUrl)}${fpParam}`;
      }
      return `${apiBase}/api/proxy/media?url=${encodeURIComponent(absUrl)}${fpParam}`;
    }).join("\n");

    console.log(`[hls] Segments: ${segmentCount}`);
    console.log(`[hls] Sending rewritten manifest to client: t+${Date.now() - t0}ms`);

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(playlist);
    console.log(`[hls] ─── Done: ${shortUrl} | total=${Date.now() - t0}ms`);
  } catch (err) {
    console.error(`[hls] ❌ Error proxying ${shortUrl}: ${err.message} | t+${Date.now() - t0}ms`);
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

// ─── LINK REFRESH CRON ────────────────────────────────────────────────────
// Runs every 90 minutes via setInterval. Re-fetches direct video URLs for
// every pin in the current batch (Pinterest URLs expire ~1.5h).
// NEVER uses the SOCKS5 proxy — always forceNoProxy=true.

let linkRefreshLastRun = null;
let linkRefreshNextRun = null;
let linkRefreshIsRunning = false;
let linkRefreshStats = { totalPins: 0, resolvedPins: 0, failedPins: 0, pendingPins: 0 };

async function runLinkRefresh() {
  if (linkRefreshIsRunning) {
    console.log('[link-refresh] Already running — skipping this cycle.');
    return;
  }
  linkRefreshIsRunning = true;
  linkRefreshLastRun = new Date().toISOString();
  // Schedule next run timestamp
  linkRefreshNextRun = new Date(Date.now() + 90 * 60 * 1000).toISOString();

  console.log('[link-refresh] ─── Starting link pre-fetch cycle...');

  try {
    // Fetch pins from current batch (or all pins if no batch yet)
    let pins = [];
    if (currentBatchId) {
      pins = await db.getPinsByBatch(currentBatchId);
    }
    if (pins.length === 0) {
      pins = await db.getAllPins();
    }

    const LINK_TTL_MS = 90 * 60 * 1000; // 90 minutes
    const now = Date.now();

    // Re-fetch ALL pins (overwrite even fresh ones to keep URLs valid)
    const toRefresh = pins.filter(p => p.pinUrl);

    linkRefreshStats.totalPins = toRefresh.length;
    linkRefreshStats.resolvedPins = 0;
    linkRefreshStats.failedPins = 0;
    linkRefreshStats.pendingPins = toRefresh.length;

    console.log(`[link-refresh] ${toRefresh.length} pins to refresh`);

    const BATCH_SIZE = 10;
    for (let i = 0; i < toRefresh.length; i += BATCH_SIZE) {
      const batch = toRefresh.slice(i, i + BATCH_SIZE);

      await Promise.all(batch.map(async (pin) => {
        try {
          // Always forceNoProxy — never burn the 8/day SOCKS5 quota here
          const details = await scrapePinDetails(pin.pinUrl, { forceNoProxy: true });
          if (details.success && details.videoSrc) {
            await db.upsertPin(sanitizeForFirestore({
              ...pin,
              videoSrc: details.videoSrc,
              qualities: details.qualities || [],
              linksRefreshedAt: new Date().toISOString(),
            }));
            linkRefreshStats.resolvedPins++;
            linkRefreshStats.pendingPins = Math.max(0, linkRefreshStats.pendingPins - 1);
          } else {
            linkRefreshStats.failedPins++;
            linkRefreshStats.pendingPins = Math.max(0, linkRefreshStats.pendingPins - 1);
            console.warn(`[link-refresh] Failed (no videoSrc): ${pin.pinUrl}`);
          }
        } catch (err) {
          linkRefreshStats.failedPins++;
          linkRefreshStats.pendingPins = Math.max(0, linkRefreshStats.pendingPins - 1);
          console.warn(`[link-refresh] Error for ${pin.pinUrl}: ${err.message}`);
        }
      }));

      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(toRefresh.length / BATCH_SIZE);
      console.log(`[link-refresh] Batch ${batchNum}/${totalBatches} done | Resolved: ${linkRefreshStats.resolvedPins}, Failed: ${linkRefreshStats.failedPins}`);

      // Rate-limit: randomized delay between batches (skip after last batch)
      if (i + BATCH_SIZE < toRefresh.length) {
        const delay = 2500 + Math.random() * 1500; // 2500–4000ms
        await new Promise(r => setTimeout(r, delay));
      }
    }

    console.log(`[link-refresh] ─── Cycle complete | Resolved: ${linkRefreshStats.resolvedPins}/${linkRefreshStats.totalPins}, Failed: ${linkRefreshStats.failedPins}`);
  } catch (err) {
    console.error('[link-refresh] Fatal error during cycle:', err);
  } finally {
    linkRefreshIsRunning = false;
  }
}

// Run immediately 5 minutes after startup (let batch scrape settle first),
// then repeat every 90 minutes.
setTimeout(() => {
  runLinkRefresh();
  setInterval(runLinkRefresh, 90 * 60 * 1000);
}, 5 * 60 * 1000);

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
  const t0 = Date.now();
  console.log(`[random] ─── Request received: t=${t0}`);
  try {
    let pins = [];
    if (currentBatchId) {
      try {
        console.log(`[random] Firestore query started (batch: ${currentBatchId}): t+${Date.now() - t0}ms`);
        pins = await db.getPinsByBatch(currentBatchId);
        console.log(`[random] [firestore] Query took: ${Date.now() - t0}ms | returned ${pins.length} pins`);
      } catch (e) {
        console.warn("[random] Failed to fetch batch:", e.message);
      }
    }
    
    if (pins.length === 0) {
      const t1 = Date.now();
      console.log(`[random] Firestore getAllPins started: t+${t1 - t0}ms`);
      pins = await db.getAllPins();
      console.log(`[random] [firestore] getAllPins took: ${Date.now() - t1}ms | returned ${pins.length} pins`);
    }
    
    // Fisher-Yates shuffle
    for (let i = pins.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pins[i], pins[j]] = [pins[j], pins[i]];
    }
    
    console.log(`[random] Shuffle done, sending response: t+${Date.now() - t0}ms | ${pins.length} pins`);
    res.json({ success: true, count: pins.length, pins });
  } catch (err) {
    console.error("[random] Error:", err.message);
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

// GET /api/pins/details?url=pinUrl&relatedOnly=true (optional)
app.get("/api/pins/details", async (req, res) => {
  const t0 = Date.now();
  const pinUrl = req.query.url;
  const relatedOnly = req.query.relatedOnly === "true";
  if (!pinUrl) return res.status(400).json({ success: false, error: "Missing ?url= parameter" });

  const pinId = pinUrl.split("/pin/")[1]?.replace(/\//g, "");

  // ── relatedOnly mode: return cached related or random pins INSTANTLY ─────
  if (relatedOnly) {
    console.log(`[details] ─── relatedOnly request for: ${pinId}`);
    try {
      const allCached = await db.getAllPins();
      const cached = allCached.find(p => p.pinUrl === pinUrl);

      // 1. If we have real related pins cached → serve them
      if (cached && cached.relatedPins && cached.relatedPins.length > 0) {
        console.log(`[details] relatedOnly: serving ${cached.relatedPins.length} cached related pins`);
        return res.json({ success: true, related: cached.relatedPins });
      }

      // 2. No cached related → return random pins from DB INSTANTLY
      //    (don't wait 30s for Playwright to search)
      const otherPins = allCached
        .filter(p => p.pinUrl !== pinUrl && p.thumbnail)
        .map(p => ({ pinUrl: p.pinUrl, thumbnail: p.thumbnail, title: p.title || 'Pinterest Video', author: p.author || 'Pinterest' }));
      
      // Shuffle and pick 12
      for (let i = otherPins.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [otherPins[i], otherPins[j]] = [otherPins[j], otherPins[i]];
      }
      const instantRelated = otherPins.slice(0, 12);
      console.log(`[details] relatedOnly: no cache, returning ${instantRelated.length} random DB pins instantly`);
      res.json({ success: true, related: instantRelated });

      // 3. Fire-and-forget: fetch REAL related pins in background for next time
      const title = cached?.title || "aesthetic video";
      fetchRelatedPins(title).then(related => {
        if (related.length > 0 && cached) {
          db.upsertPin(sanitizeForFirestore({ ...cached, relatedPins: related }));
          console.log(`[details] [background] Cached ${related.length} real related pins for ${pinId}`);
        }
      }).catch(err => console.log(`[details] [background] Related fetch failed: ${err.message}`));
      return;
    } catch (err) {
      console.error(`[details] relatedOnly error: ${err.message}`);
      return res.json({ success: true, related: [] });
    }
  }

  // ── Normal mode: fetch video data, return FAST, related in background ───
  console.log(`[details] ─── Request received for: ${pinId} | t=${t0}`);

  try {
    // 1. Check DB Cache first
    console.log(`[details] Firestore lookup started: t+${Date.now() - t0}ms`);
    const allCached = await db.getAllPins();
    const tFirestore = Date.now() - t0;
    console.log(`[details] [firestore] Query took: ${tFirestore}ms | ${allCached.length} total pins`);
    const cached = allCached.find(p => p.pinUrl === pinUrl);
    // 2. Check freshness: treat cache as valid only if linksRefreshedAt is within 90 minutes
    const LINK_TTL_MS = 90 * 60 * 1000;
    const cachedHasVideo = cached && cached.videoSrc;
    const cachedIsHls = cachedHasVideo && cached.videoSrc.includes('.m3u8');
    const isExpired = !cached?.linksRefreshedAt ||
      (Date.now() - new Date(cached.linksRefreshedAt).getTime()) > LINK_TTL_MS;

    console.log(`[details] Firestore result: ${
      cachedHasVideo
        ? (cachedIsHls ? 'CACHE HIT (HLS — stale, re-fetching MP4)' : isExpired ? 'CACHE HIT (MP4 — expired, re-fetching)' : 'CACHE HIT (MP4 — fresh)')
        : cached ? 'CACHE HIT (no videoSrc)' : 'CACHE MISS'
    } | t+${Date.now() - t0}ms`);

    // Serve from cache only if it's a fresh, non-HLS MP4
    if (cachedHasVideo && !cachedIsHls && !isExpired) {
      console.log(`[details] Sending cached MP4 response: t+${Date.now() - t0}ms`);
      // Include cached relatedPins and qualities if available
      const related = cached.relatedPins || [];
      const qualities = cached.qualities || [];
      return res.json({ success: true, ...cached, related, qualities });
    }

    // 2. Try Pinterest API (FAST)
    if (pinId) {
      try {
        const t1 = Date.now();
        console.log(`[details] Pinterest API fetch started: t+${t1 - t0}ms`);
        const details = await fetchPinDetails(pinId);
        console.log(`[details] Pinterest API returned: t+${Date.now() - t0}ms (took ${Date.now() - t1}ms)`);
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
          console.log(`[details] Sending API response FAST: t+${Date.now() - t0}ms`);
          res.json({ success: true, ...pinObj, qualities: [], related: [] });

          // Fire-and-forget: fetch related in background
          fetchRelatedPins(pinObj.title).then(related => {
            if (related.length > 0) {
              db.upsertPin(sanitizeForFirestore({ ...pinObj, relatedPins: related }));
              console.log(`[details] [background] Cached ${related.length} related pins for ${pinId}`);
            }
          }).catch(err => console.log(`[details] [background] Related failed silently: ${err.message}`));
          return;
        }
      } catch (e) {
        console.warn(`[details] Pinterest API failed for ${pinId}: ${e.message} | t+${Date.now() - t0}ms`);
      }
    }

    // 3. Fallback to Scraper (yt-dlp — now FAST, no related pins blocking)
    const tScraper = Date.now();
    console.log(`[details] [scraper] Scraper triggered: true | t+${tScraper - t0}ms`);
    const details = await scrapePinDetails(pinUrl);
    console.log(`[details] Scraper returned: t+${Date.now() - t0}ms (scraper took ${Date.now() - tScraper}ms)`);
    if (details.success) {
      const qualities = details.qualities || [];
      const pinObj = sanitizeForFirestore({
        pinUrl,
        thumbnail: details.thumbnail || "",
        videoSrc: details.videoSrc || "",
        qualities,
        title: details.title || "Pinterest Video",
        author: details.author || "Pinterest",
        scrapedAt: new Date().toISOString()
      });
      db.upsertPin(pinObj);
      console.log(`[details] Sending response FAST: t+${Date.now() - t0}ms`);
      res.json({ ...details, ...pinObj, qualities, related: [], success: true });

      // Fire-and-forget: fetch related in background
      fetchRelatedPins(pinObj.title).then(related => {
        if (related.length > 0) {
          db.upsertPin(sanitizeForFirestore({ ...pinObj, relatedPins: related }));
          console.log(`[details] [background] Cached ${related.length} related pins for ${pinId}`);
        }
      }).catch(err => console.log(`[details] [background] Related failed silently: ${err.message}`));
    } else {
      console.log(`[details] Scraper failed, returning error: t+${Date.now() - t0}ms`);
      res.status(500).json(details);
    }
  } catch (err) {
    console.error(`[details] Global Error: ${err.message} | t+${Date.now() - t0}ms`);
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

// GET /api/links/status — Link pre-fetch job status
app.get('/api/links/status', async (req, res) => {
  const LINK_TTL_MS = 90 * 60 * 1000;
  const now = Date.now();

  let resolvedPins = 0;
  let pendingPins = 0;

  try {
    let pins = [];
    if (currentBatchId) {
      pins = await db.getPinsByBatch(currentBatchId);
    } else {
      pins = await db.getAllPins();
    }

    pins.forEach(p => {
      const hasFreshVideo = p.videoSrc && p.linksRefreshedAt &&
        (now - new Date(p.linksRefreshedAt).getTime()) <= LINK_TTL_MS;
      if (hasFreshVideo) {
        resolvedPins++;
      } else {
        pendingPins++;
      }
    });
  } catch (e) {
    console.warn('[link-refresh] /api/links/status DB query failed:', e.message);
  }

  res.json({
    lastRun: linkRefreshLastRun,
    nextRun: linkRefreshNextRun,
    totalPins: linkRefreshStats.totalPins,
    resolvedPins,
    pendingPins,
    failedPins: linkRefreshStats.failedPins,
    isRunning: linkRefreshIsRunning,
  });
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

app.listen(PORT, async () => {
  console.log(`\n🚀 Pinterest Video Scraper running at http://localhost:${PORT}\n`);

  // ─── STARTUP CDN PING TEST ─────────────────────────────────────────────
  try {
    const pingUrl = 'https://i.pinimg.com/originals/78/7f/de/787fde77fc71b2d30724ccf1a225bdad.jpg';
    const t0 = Date.now();
    const resp = await axios.head(pingUrl, {
      timeout: 10000,
      headers: { ...PINTEREST_HEADERS },
    });
    console.log(`[startup] CDN ping: ${Date.now() - t0}ms | status=${resp.status}`);
  } catch (e) {
    console.log(`[startup] CDN ping: FAILED (${e.message})`);
  }
});
