/**
 * pinterest.js — 3-Layer Fallback Pinterest Proxy
 *
 * Layer 1: Pinterest internal JSON API (fast, may get 403)
 * Layer 2: Playwright stealth browser scraper (slow, reliable)
 * Layer 3: Returns empty so server.js can serve from DB
 */

const axios = require("axios");
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();

chromium.use(stealth);

// ─── HELPERS ───────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SPOOF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
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

async function initSession() {
  try {
    console.log("[pinterest-proxy] Initializing guest session...");
    const res = await axios.get("https://www.pinterest.com/", {
      headers: {
        "User-Agent": SPOOF_HEADERS["User-Agent"],
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 10000,
      maxRedirects: 5,
    });

    const raw = res.headers["set-cookie"] || [];
    sessionCookies = raw.map((c) => c.split(";")[0]).join("; ");

    // Extract csrftoken
    const csrfMatch = sessionCookies.match(/csrftoken=([^;]+)/);
    csrfToken = csrfMatch?.[1] || "";

    if (csrfToken) {
      console.log("[pinterest-proxy] ✅ Session ready. CSRF:", csrfToken.slice(0, 8) + "...");
    } else {
      console.warn("[pinterest-proxy] ⚠️  No CSRF token found in cookies.");
    }
  } catch (err) {
    console.error("[pinterest-proxy] ❌ Session init failed:", err.message);
  }
}

// ─── LAYER 1: Internal JSON API ─────────────────────────────────────────────

async function fetchViaAPI(resourceName, options, sourceUrl) {
  const data = JSON.stringify({ options });
  const url = `https://www.pinterest.com/resource/${resourceName}/get/?source_url=${encodeURIComponent(sourceUrl)}&data=${encodeURIComponent(data)}&_=${Date.now()}`;

  const res = await axios.get(url, {
    headers: {
      ...SPOOF_HEADERS,
      "Cookie": sessionCookies,
      ...(csrfToken ? { "X-CSRFToken": csrfToken } : {}),
    },
    timeout: 15000,
  });

  if (res.status !== 200) throw new Error(`Pinterest API returned ${res.status}`);
  return res.data;
}

function normalizeAPIPin(pin, bookmark = "") {
  if (!pin || pin.type !== "pin") return null;

  const videos = pin.videos?.video_list;
  let videoUrl = "";
  if (videos) {
    videoUrl =
      videos.V_720P?.url ||
      videos.V_480P?.url ||
      videos.V_360P?.url ||
      videos.V_HLSV3_MOBILE?.url ||
      Object.values(videos)[0]?.url || "";
  }

  if (!videoUrl) return null;

  return {
    id: pin.id,
    pinUrl: `https://www.pinterest.com/pin/${pin.id}/`,
    title: pin.title || pin.description || "Pinterest Video",
    thumbnail: pin.images?.["736x"]?.url || pin.images?.orig?.url || "",
    video_url: videoUrl,
    uploader: pin.pinner?.username || "Pinterest",
    uploader_url: `https://www.pinterest.com/${pin.pinner?.username || ""}`,
    source: "pinterest",
    bookmark,
  };
}

// ─── LAYER 2: Playwright Stealth Scraper ────────────────────────────────────

async function fetchViaBrowser(query) {
  console.log(`[pinterest-proxy] 🎭 Launching browser for: "${query}"`);
  
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--window-size=1920,1080",
    ],
  });

  const context = await browser.newContext({
    userAgent: SPOOF_HEADERS["User-Agent"],
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    timezoneId: "America/New_York",
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  });

  const page = await context.newPage();

  // Deep anti-detection
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
    window.chrome = { runtime: {} };
  });

  try {
    const url = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}&rs=typed`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35000 });
    await sleep(2500);

    // Dismiss overlays/login prompts
    await page.evaluate(() => {
      const selectors = [
        '[aria-label="Close"]',
        '[data-test-id="close-button"]',
        ".FullPageSignup__closeButton",
        '[data-test-id="unauthenticated-signup-sheet-close-btn"]',
      ];
      selectors.forEach((s) => document.querySelector(s)?.click());
    });

    // Scroll to load more pins
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await sleep(800);
    }

    // Extract video pins from the DOM
    const pins = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      const elements = document.querySelectorAll(
        '[data-test-id="pin"], [data-grid-item], div[role="listitem"], .Y6S, .XiG'
      );

      elements.forEach((el) => {
        try {
          const text = el.innerText || "";
          const hasDuration = /\d+:\d+/.test(text);
          const hasVideo =
            el.querySelector("video") ||
            el.querySelector('[data-test-id="video-pin-with-controls"]') ||
            el.querySelector('[aria-label*="video" i]') ||
            el.querySelector(".vContainer") ||
            hasDuration;

          if (!hasVideo) return;

          const anchor = el.querySelector("a[href*='/pin/']");
          if (!anchor) return;

          const pinUrl = anchor.href;
          if (seen.has(pinUrl)) return;
          seen.add(pinUrl);

          const img = el.querySelector("img");
          const thumbnail = img?.src || img?.getAttribute("data-src") || "";
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
                "Pinterest Video"
              ).trim(),
              thumbnail,
              video_url: videoUrl,
              uploader: el.querySelector('[data-test-id="pinner-name"]')?.innerText?.trim() || "Pinterest",
              uploader_url: "",
              source: "pinterest",
            });
          }
        } catch (e) {}
      });

      return results;
    });

    console.log(`[pinterest-proxy] 🎭 Browser extracted ${pins.length} pins`);
    return pins;
  } finally {
    await context.close();
    await browser.close();
  }
}

// ─── PUBLIC API ─────────────────────────────────────────────────────────────

async function searchVideos(query, bookmark = "") {
  const cacheKey = `search:${query}:${bookmark}`;
  const cached = getCached(cacheKey);
  if (cached) {
    console.log(`[pinterest-proxy] 📦 Cache hit: "${query}"`);
    return cached;
  }

  // --- LAYER 1: Try JSON API ---
  try {
    console.log(`[pinterest-proxy] 🌐 Layer 1 (API) for: "${query}"`);
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
      console.log(`[pinterest-proxy] ✅ Layer 1 returned ${pins.length} pins`);
      return data;
    }
    console.warn("[pinterest-proxy] ⚠️  Layer 1 returned 0 video pins, falling back...");
  } catch (err) {
    console.warn(`[pinterest-proxy] ⚠️  Layer 1 failed: ${err.message}`);
    // Re-init session on auth failure
    if (err.response?.status === 401 || err.response?.status === 403) {
      await initSession();
    }
  }

  // --- LAYER 2: Browser scraper ---
  try {
    console.log(`[pinterest-proxy] 🎭 Layer 2 (Browser) for: "${query}"`);
    const pins = await fetchViaBrowser(query);
    if (pins.length > 0) {
      const data = { pins, bookmark: "" };
      setCached(cacheKey, data);
      return data;
    }
  } catch (err) {
    console.error(`[pinterest-proxy] ❌ Layer 2 failed: ${err.message}`);
  }

  // --- LAYER 3: Return empty (server.js will serve from DB) ---
  console.warn("[pinterest-proxy] ⚠️  All layers failed, returning empty for DB fallback.");
  return { pins: [], bookmark: "" };
}

async function getCategoryFeed(category, bookmark = "") {
  const cacheKey = `category:${category}:${bookmark}`;
  const cached = getCached(cacheKey);
  if (cached) {
    console.log(`[pinterest-proxy] 📦 Cache hit: "${category}"`);
    return cached;
  }

  // --- LAYER 1 ---
  try {
    console.log(`[pinterest-proxy] 🌐 Layer 1 (API) for category: "${category}"`);
    const options = { tag: category, page_size: 25, bookmarks: bookmark ? [bookmark] : [] };
    const res = await fetchViaAPI("TopicFeedResource", options, `/ideas/${encodeURIComponent(category)}/`);
    const results = res?.resource_response?.data || [];
    const nextBookmark = res?.resource_response?.bookmark || "";
    const pins = results.map((p) => normalizeAPIPin(p, nextBookmark)).filter(Boolean);

    if (pins.length > 0) {
      const data = { pins, bookmark: nextBookmark };
      setCached(cacheKey, data);
      console.log(`[pinterest-proxy] ✅ Layer 1 returned ${pins.length} pins`);
      return data;
    }
  } catch (err) {
    console.warn(`[pinterest-proxy] ⚠️  Layer 1 failed: ${err.message}`);
    if (err.response?.status === 401 || err.response?.status === 403) await initSession();
  }

  // --- LAYER 2: Fall back to search ---
  console.log(`[pinterest-proxy] 🎭 Layer 2 — searching by category name: "${category}"`);
  return searchVideos(category, bookmark);
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
    console.warn(`[pinterest-proxy] Pin detail API failed for ${pinId}: ${err.message}`);
  }

  return null;
}

// Initialise session on startup
initSession();

module.exports = { searchVideos, getCategoryFeed, fetchPinDetails };
