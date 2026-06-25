/**
 * pinterest.js — Hardened 3-Layer Pinterest Proxy
 *
 * Layer 1: Pinterest internal JSON API (fast, may get 403)
 * Layer 2: Playwright stealth browser scraper (slow, most reliable)
 * Layer 3: Returns empty so server.js can serve from DB
 *
 * Self-healing: rotates User-Agents, re-inits sessions, retries with backoff.
 */

const axios = require("axios");
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();

chromium.use(stealth);

// ─── HELPERS ───────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rotating User-Agents — if Pinterest blocks one, next request uses another
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function buildHeaders(ua) {
  return {
    "User-Agent": ua,
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": "https://www.pinterest.com/",
    "Origin": "https://www.pinterest.com",
    "X-Requested-With": "XMLHttpRequest",
    "X-APP-VERSION": "5f8d6b2",
    "X-Pinterest-AppState": "active",
    "DNT": "1",
    "Connection": "keep-alive",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };
}

// ─── CACHE ─────────────────────────────────────────────────────────────────

const _cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCached(key) {
  const entry = _cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  return null;
}

function setCached(key, data) {
  _cache.set(key, { data, ts: Date.now() });
}

// ─── SESSION (Layer 1 support) ─────────────────────────────────────────────

let sessionCookies = "";
let csrfToken = "";
let currentUA = randomUA();
let sessionInitAttempts = 0;

async function initSession() {
  sessionInitAttempts++;
  currentUA = randomUA(); // Rotate UA on every re-init

  try {
    console.log(`[pinterest] Initializing session (attempt #${sessionInitAttempts}, UA: ...${currentUA.slice(-30)})`);
    const res = await axios.get("https://www.pinterest.com/", {
      headers: {
        "User-Agent": currentUA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 12000,
      maxRedirects: 5,
    });

    const raw = res.headers["set-cookie"] || [];
    sessionCookies = raw.map((c) => c.split(";")[0]).join("; ");

    const csrfMatch = sessionCookies.match(/csrftoken=([^;]+)/);
    csrfToken = csrfMatch?.[1] || "";

    if (csrfToken) {
      console.log(`[pinterest] ✅ Session ready. CSRF: ${csrfToken.slice(0, 8)}...`);
    } else {
      console.warn("[pinterest] ⚠️ No CSRF token found.");
    }
  } catch (err) {
    console.error("[pinterest] ❌ Session init failed:", err.message);
  }
}

// ─── LAYER 1: Internal JSON API ─────────────────────────────────────────────

async function fetchViaAPI(resourceName, options, sourceUrl, retries = 3) {
  const data = JSON.stringify({ options });
  const url = `https://www.pinterest.com/resource/${resourceName}/get/?source_url=${encodeURIComponent(sourceUrl)}&data=${encodeURIComponent(data)}&_=${Date.now()}`;

  const axiosOptions = {
    headers: {
      ...buildHeaders(currentUA),
      "Cookie": sessionCookies,
      ...(csrfToken ? { "X-CSRFToken": csrfToken } : {}),
    },
    timeout: 15000,
  };

  if (process.env.PROXY_URL) {
    try {
      const parsed = new URL(process.env.PROXY_URL);
      axiosOptions.proxy = {
        protocol: parsed.protocol.replace(":", ""),
        host: parsed.hostname,
        port: parseInt(parsed.port, 10),
      };
      if (parsed.username) {
        axiosOptions.proxy.auth = {
          username: decodeURIComponent(parsed.username),
          password: decodeURIComponent(parsed.password)
        };
      }
    } catch (err) {
      console.warn("[pinterest] Failed to parse PROXY_URL for axios:", err.message);
    }
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await axios.get(url, axiosOptions);
      if (res.status === 200) return res.data;
    } catch (err) {
      const status = err.response?.status;
      console.warn(`[pinterest] API attempt ${attempt}/${retries} failed: ${status || err.message}`);
      if (status === 401 || status === 403) {
        await initSession(); // Re-init with new UA
      }
      if (attempt < retries) await sleep(1000 * attempt); // Backoff
    }
  }
  throw new Error("Pinterest API blocked after retries");
}

function normalizeAPIPin(pin, bookmark = "") {
  if (!pin || pin.type !== "pin") return null;

  const videos = pin.videos?.video_list;
  let videoUrl = "";
  if (videos) {
    // Quality fallback chain: best → worst → any available
    videoUrl =
      videos.V_720P?.url ||
      videos.V_480P?.url ||
      videos.V_360P?.url ||
      videos.V_HLSV3_MOBILE?.url ||
      videos.V_HLSV4?.url ||
      Object.values(videos).find(v => v?.url)?.url || "";
  }

  if (!videoUrl) return null;

  return {
    id: pin.id,
    pinUrl: `https://www.pinterest.com/pin/${pin.id}/`,
    title: pin.title || pin.description?.slice(0, 100) || "Pinterest Video",
    thumbnail: pin.images?.["736x"]?.url || pin.images?.orig?.url || "",
    video_url: videoUrl,
    uploader: pin.pinner?.username || "Pinterest",
    uploader_url: `https://www.pinterest.com/${pin.pinner?.username || ""}`,
    source: "pinterest",
    bookmark,
  };
}

// ─── LAYER 2: Playwright Stealth Scraper ────────────────────────────────────

let _browserBusy = false; // Prevent concurrent browser launches (OOM protection)

async function fetchViaBrowser(query) {
  // Prevent multiple browsers launching at once
  if (_browserBusy) {
    console.log("[pinterest] 🎭 Browser already busy, skipping...");
    return [];
  }
  _browserBusy = true;

  console.log(`[pinterest] 🎭 Launching browser for: "${query}"`);
  let browser = null;
  let context = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
        "--disable-dev-shm-usage", // Prevent /dev/shm crashes in Docker/low-mem
        "--window-size=1920,1080",
      ],
      proxy: process.env.PROXY_URL ? { server: process.env.PROXY_URL } : undefined
    });

    const ua = randomUA();
    context = await browser.newContext({
      userAgent: ua,
      viewport: { width: 1920, height: 1080 },
      locale: "en-US",
      timezoneId: "America/New_York",
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
    });

    const page = await context.newPage();

    // Deep anti-detection
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      window.chrome = { runtime: {}, loadTimes: () => ({}) };
      // Spoof permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (params) =>
        params.name === "notifications"
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(params);
    });

    const searchUrl = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}&rs=typed`;
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 40000 });
    await sleep(3000);

    // Dismiss overlays/login prompts aggressively
    await page.evaluate(() => {
      // Click close buttons
      const closeSelectors = [
        '[aria-label="Close"]', '[data-test-id="close-button"]',
        ".FullPageSignup__closeButton",
        '[data-test-id="unauthenticated-signup-sheet-close-btn"]',
        'button[aria-label="decline"]', '[data-test-id="signup-modal-close"]',
      ];
      closeSelectors.forEach(s => { try { document.querySelector(s)?.click(); } catch(e) {} });

      // Remove overlay divs
      document.querySelectorAll('[data-test-id="signup-modal"], [data-test-id="fullPageSignup"]')
        .forEach(el => el.remove());
    });

    await sleep(500);

    // Scroll to load more pins — deeper scrolling for more results
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await sleep(600 + Math.random() * 400);
    }

    // Extract pins from the DOM with WIDE selector coverage
    const pins = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      // Many selectors — Pinterest changes these often, so cast a wide net
      const elements = document.querySelectorAll([
        '[data-test-id="pin"]',
        '[data-grid-item]',
        'div[role="listitem"]',
        '[data-test-id="pinWrapper"]',
        // Class-based fallbacks (Pinterest obfuscates these)
        ".GrowthUnauthPinImage",
        ".Y6S", ".XiG", ".Yl-",
      ].join(", "));

      elements.forEach((el) => {
        try {
          const text = el.innerText || "";
          const hasDuration = /\d+:\d+/.test(text);

          // Multiple ways to detect a video pin
          const hasVideo =
            el.querySelector("video") ||
            el.querySelector("video source") ||
            el.querySelector('[data-test-id="video-pin-with-controls"]') ||
            el.querySelector('[aria-label*="video" i]') ||
            el.querySelector('[aria-label*="Video" i]') ||
            el.querySelector(".vContainer") ||
            el.querySelector(".PinCard--video") ||
            el.querySelector('[data-test-id="pinWithVideoIcon"]') ||
            hasDuration;

          if (!hasVideo) return;

          // Find the pin link
          const anchor = el.querySelector("a[href*='/pin/']");
          if (!anchor) return;

          const pinUrl = anchor.href;
          if (seen.has(pinUrl)) return;
          seen.add(pinUrl);

          // Get thumbnail
          const img = el.querySelector("img");
          const thumbnail = img?.src || img?.getAttribute("data-src") || img?.getAttribute("srcset")?.split(" ")[0] || "";

          // Try to get video URL (usually lazy-loaded so often empty at grid level)
          const video = el.querySelector("video");
          const videoUrl = video?.src || video?.querySelector("source")?.src || "";
          const pinId = pinUrl.match(/\/pin\/(\d+)/)?.[1] || "";

          if (pinUrl && thumbnail) {
            results.push({
              id: pinId,
              pinUrl,
              title: (
                img?.alt ||
                el.querySelector('[data-test-id="pin-title"]')?.innerText ||
                el.querySelector('[data-test-id="pinrep-title"]')?.innerText ||
                text.slice(0, 100) ||
                "Pinterest Video"
              ).trim(),
              thumbnail,
              video_url: videoUrl,
              uploader: (
                el.querySelector('[data-test-id="pinner-name"]')?.innerText ||
                el.querySelector('[data-test-id="pinCreatorName"]')?.innerText ||
                "Pinterest"
              ).trim(),
              uploader_url: "",
              source: "pinterest",
            });
          }
        } catch (e) {}
      });

      return results;
    });

    console.log(`[pinterest] 🎭 Browser extracted ${pins.length} pins`);
    return pins;
  } catch (err) {
    console.error(`[pinterest] 🎭 Browser error: ${err.message}`);
    return [];
  } finally {
    _browserBusy = false;
    try { if (context) await context.close(); } catch(e) {}
    try { if (browser) await browser.close(); } catch(e) {}
  }
}

// ─── PUBLIC API ─────────────────────────────────────────────────────────────

async function searchVideos(query, bookmark = "") {
  const cacheKey = `search:${query}:${bookmark}`;
  const cached = getCached(cacheKey);
  if (cached) {
    console.log(`[pinterest] 📦 Cache hit: "${query}"`);
    return cached;
  }

  // --- LAYER 1: Try JSON API ---
  try {
    console.log(`[pinterest] 🌐 Layer 1 (API) for: "${query}"`);
    const options = {
      query,
      scope: "pins",
      filters: "videos",
      page_size: 25,
      bookmarks: bookmark ? [bookmark] : [],
    };
    const res = await fetchViaAPI("BaseSearchResource", options, `/search/pins/?q=${encodeURIComponent(query)}`);
    const results = res?.resource_response?.data?.results || [];
    const nextBookmark = res?.resource_response?.bookmark || "";
    const pins = results.map((p) => normalizeAPIPin(p, nextBookmark)).filter(Boolean);

    if (pins.length > 0) {
      const data = { pins, bookmark: nextBookmark };
      setCached(cacheKey, data);
      console.log(`[pinterest] ✅ Layer 1 → ${pins.length} pins`);
      return data;
    }
    console.warn("[pinterest] ⚠️ Layer 1 → 0 video pins, falling back...");
  } catch (err) {
    console.warn(`[pinterest] ⚠️ Layer 1 failed: ${err.message}`);
  }

  // --- LAYER 2: Browser scraper ---
  try {
    console.log(`[pinterest] 🎭 Layer 2 (Browser) for: "${query}"`);
    const pins = await fetchViaBrowser(query);
    if (pins.length > 0) {
      const data = { pins, bookmark: "" };
      setCached(cacheKey, data);
      console.log(`[pinterest] ✅ Layer 2 → ${pins.length} pins`);
      return data;
    }
  } catch (err) {
    console.error(`[pinterest] ❌ Layer 2 failed: ${err.message}`);
  }

  // --- LAYER 3: Return empty (server.js DB fallback) ---
  console.warn("[pinterest] ⚠️ All layers failed → DB fallback.");
  return { pins: [], bookmark: "" };
}

async function getCategoryFeed(category, bookmark = "") {
  const cacheKey = `category:${category}:${bookmark}`;
  const cached = getCached(cacheKey);
  if (cached) {
    console.log(`[pinterest] 📦 Cache hit: "${category}"`);
    return cached;
  }

  // LAYER 1: Try TopicFeedResource
  try {
    console.log(`[pinterest] 🌐 Layer 1 (API) category: "${category}"`);
    const options = { tag: category, page_size: 25, bookmarks: bookmark ? [bookmark] : [] };
    const res = await fetchViaAPI("TopicFeedResource", options, `/ideas/${encodeURIComponent(category)}/`);
    const results = res?.resource_response?.data || [];
    const nextBookmark = res?.resource_response?.bookmark || "";
    const pins = results.map((p) => normalizeAPIPin(p, nextBookmark)).filter(Boolean);

    if (pins.length > 0) {
      const data = { pins, bookmark: nextBookmark };
      setCached(cacheKey, data);
      return data;
    }
  } catch (err) {
    console.warn(`[pinterest] ⚠️ Category API failed: ${err.message}`);
    if (err.response?.status === 401 || err.response?.status === 403) await initSession();
  }

  // LAYER 2: Fall back to search
  return searchVideos(category + " videos", bookmark);
}

async function fetchPinDetails(pinId) {
  const cacheKey = `pin:${pinId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const options = { field_set_key: "unauth_react_main_pin", id: pinId };
    const res = await fetchViaAPI("PinResource", options, `/pin/${pinId}/`);
    const pinData = res?.resource_response?.data;
    if (pinData) {
      const normalized = normalizeAPIPin(pinData);
      if (normalized) {
        setCached(cacheKey, normalized);
        return normalized;
      }
    }
  } catch (err) {
    console.warn(`[pinterest] Pin detail API failed for ${pinId}: ${err.message}`);
  }

  return null;
}

// Init on startup
initSession();

module.exports = { searchVideos, getCategoryFeed, fetchPinDetails };
