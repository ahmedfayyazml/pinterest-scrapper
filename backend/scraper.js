const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
const { exec } = require("child_process");
const proxyManager = require("./proxyManager");

chromium.use(stealth);

// ─── HELPERS ───────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomDelay = () => sleep(2000 + Math.random() * 2000);

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
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
    ],
  });
}

async function newStealthPage(browser) {
  const context = await browser.newContext({
    userAgent: randomUA(),
    viewport: { width: 1920, height: 1080 },
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
  // Close any popups/overlays
  try {
    await page.evaluate(() => {
      const selectors = ['[aria-label="Close"]', '[data-test-id="close-button"]', '.FullPageSignup__closeButton'];
      selectors.forEach(s => document.querySelector(s)?.click());
    });
  } catch (e) {}

  await page.waitForTimeout(2000);

  // Faster scroll for initial load
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    await sleep(800 + Math.random() * 500);
  }

  const pins = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    // Catch all possible pin containers
    const pinElements = document.querySelectorAll(
      '[data-test-id="pin"], [data-grid-item], .GrowthUnauthPinImage, div[role="listitem"], .Y6S, .XiG'
    );

    pinElements.forEach((el) => {
      try {
        const text = el.innerText || "";
        const hasDuration = /\d+:\d+/.test(text); 
        
        const hasVideo =
          el.querySelector("video") ||
          el.querySelector('[data-test-id="video-pin-with-controls"]') ||
          el.querySelector('[aria-label*="video" i]') ||
          el.querySelector('[aria-label*="Video" i]') ||
          el.querySelector(".PinCard--video") ||
          el.querySelector(".play-icon") ||
          el.querySelector(".video-icon") ||
          el.querySelector(".vContainer") ||
          hasDuration;

        if (!hasVideo) return;

        const anchor = el.querySelector("a[href*='/pin/']");
        if (!anchor) return;

        const pinUrl = anchor.href;
        if (seen.has(pinUrl)) return;
        seen.add(pinUrl);

        // Get thumbnail
        const img = el.querySelector("img");
        const thumbnail = img?.src || img?.getAttribute("data-src") || "";

        if (pinUrl && thumbnail) {
          results.push({
            pinUrl,
            thumbnail,
            title: (img?.alt || el.querySelector('[data-test-id="pin-title"]')?.innerText || "Pinterest Video").trim(),
            author: (el.querySelector('[data-test-id="pinner-name"]')?.innerText || "Pinterest").trim(),
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

// ─── SCRAPE 200 PINS ───────────────────────────────────────────────────────

async function scrape200Pins() {
  const browser = await launchBrowser();
  const { page, context } = await newStealthPage(browser);

  try {
    console.log("[scraper] Fetching 200 trending video pins...");

    const fallbacks = ["aesthetic videos", "nature videos", "funny videos", "cooking videos", "satisfying videos"];
    const randomKeyword = fallbacks[Math.floor(Math.random() * fallbacks.length)];
    
    await page.goto(`https://www.pinterest.com/search/pins/?q=${encodeURIComponent(randomKeyword)}&rs=typed`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    await page.waitForTimeout(3000);
    
    // Close any popups/overlays
    try {
      await page.evaluate(() => {
        const selectors = ['[aria-label="Close"]', '[data-test-id="close-button"]', '.FullPageSignup__closeButton'];
        selectors.forEach(s => document.querySelector(s)?.click());
      });
    } catch (e) {}

    let pins = [];
    let attempts = 0;
    while (pins.length < 200 && attempts < 30) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await sleep(1000 + Math.random() * 1000);
      
      const newPins = await extractVideoPins(page);
      
      // Deduplicate
      const seen = new Set(pins.map(p => p.pinUrl));
      for (const p of newPins) {
        if (!seen.has(p.pinUrl)) {
          pins.push(p);
          seen.add(p.pinUrl);
        }
      }
      
      console.log(`[scraper] Collected ${pins.length}/200 pins...`);
      attempts++;
    }

    // Limit to exactly 200
    pins = pins.slice(0, 200);

    console.log(`[scraper] Finished collecting ${pins.length} video pins`);
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

    // Wait for pins to appear
    await page.waitForSelector('[data-test-id="pin"], [aria-label="Pin card"]', { timeout: 10000 }).catch(() => {
      console.log("[scraper] Search grid did not load within timeout");
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

// ─── YT-DLP EXTRACTION (with residential proxy support) ────────────────────

function fetchPinDetailsYTDLP(pinUrl) {
  return new Promise((resolve, reject) => {
    // Build yt-dlp command with optional proxy
    let cmd = "yt-dlp -j";
    const proxyUrl = proxyManager.getProxyUrl();
    if (proxyManager.canUseProxy()) {
      cmd += ` --proxy "${proxyUrl}"`;
      proxyManager.useProxy();
      console.log(`[scraper] Fetching details via yt-dlp (WITH PROXY) for: ${pinUrl}`);
    } else {
      const status = proxyManager.getStatus();
      console.log(`[scraper] Fetching details via yt-dlp (no proxy, quota: ${status.usesToday}/${status.limit}) for: ${pinUrl}`);
    }
    cmd += ` "${pinUrl}"`;

    exec(cmd, { timeout: 30000 }, (error, stdout, stderr) => {
      if (error) {
        return reject(new Error(stderr || error.message));
      }
      try {
        const info = JSON.parse(stdout);
        let videoSrc = "";
        
        if (info.formats && info.formats.length > 0) {
          const sorted = info.formats.filter(f => f.url).sort((a, b) => {
            const aIsMp4 = a.url.includes('.mp4') || a.ext === 'mp4';
            const bIsMp4 = b.url.includes('.mp4') || b.ext === 'mp4';
            if (aIsMp4 && !bIsMp4) return -1;
            if (!aIsMp4 && bIsMp4) return 1;
            
            const aIsM3u8 = a.url.includes('.m3u8') || a.protocol?.includes('m3u8');
            const bIsM3u8 = b.url.includes('.m3u8') || b.protocol?.includes('m3u8');
            if (!aIsM3u8 && bIsM3u8) return -1;
            if (aIsM3u8 && !bIsM3u8) return 1;

            return (b.tbr || 0) - (a.tbr || 0);
          });
          
          if (sorted.length > 0) {
            videoSrc = sorted[0].url;
          }
        }
        
        if (!videoSrc) {
          videoSrc = info.url || "";
        }

        let uploadDate = "Recently";
        if (info.upload_date) {
          const y = info.upload_date.substring(0, 4);
          const m = info.upload_date.substring(4, 6);
          const d = info.upload_date.substring(6, 8);
          const dateObj = new Date(`${y}-${m}-${d}`);
          if (!isNaN(dateObj.getTime())) {
            uploadDate = dateObj.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
          }
        }

        resolve({
          success: true,
          videoSrc,
          title: info.title || "Pinterest Video",
          description: info.description || "",
          author: info.uploader || "Pinterest User",
          viewCount: info.view_count || null,
          uploadDate,
          thumbnail: info.thumbnail || "",
          related: []
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function scrapePinDetails(pinUrl, contextQuery = "") {
  try {
    // 1. Try yt-dlp first (FAST & ROBUST)
    const details = await fetchPinDetailsYTDLP(pinUrl);
    
    // Fetch related pins using searchVideos from pinterest.js
    try {
      const { searchVideos } = require("./pinterest");
      let keyword = contextQuery;
      if (!keyword) {
        const words = details.title.replace(/[^\w\s]/g, "").split(/\s+/).filter(w => w.length > 3);
        keyword = words.length > 0 ? words.slice(0, 2).join(" ") + " video" : "aesthetic video";
      }
      console.log(`[scraper] Fetching related pins using search query: "${keyword}"`);
      const searchResult = await searchVideos(keyword);
      if (searchResult && searchResult.pins) {
        details.related = searchResult.pins.map(p => ({
          pinUrl: p.pinUrl,
          thumbnail: p.thumbnail,
          title: p.title,
          author: p.uploader || "Pinterest"
        })).slice(0, 20);
      }
    } catch (e) {
      console.warn("[scraper] Failed to fetch related pins:", e.message);
    }
    
    return details;
  } catch (ytdlpError) {
    console.warn(`[scraper] yt-dlp failed, falling back to browser scraper: ${ytdlpError.message}`);
    
    // 2. Playwright fallback
    const browser = await launchBrowser();
    const { page, context } = await newStealthPage(browser);

    try {
      console.log(`[scraper] [browser-fallback] Fetching details for: ${pinUrl}`);
      await page.goto(pinUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.evaluate(() => window.scrollBy(0, 1500));
      await page.waitForTimeout(3000);

      const details = await page.evaluate(() => {
        let videoSrc = "";
        let title = "";
        let description = "";
        let author = "";
        let uploadDate = "";
        let viewCount = null;

        // Try JSON-LD
        const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
        jsonLdScripts.forEach(script => {
          try {
            const data = JSON.parse(script.innerText);
            const root = Array.isArray(data) ? data[0] : data;
            
            if (root["@type"] === "VideoObject" || root.video) {
              const video = root.video || root;
              videoSrc = video.contentUrl || video.embedUrl || videoSrc;
              uploadDate = video.uploadDate || video.datePublished || video.dateCreated || uploadDate;
              title = root.name || title;
              description = root.description || description;
              author = root.author?.name || author;
            }
          } catch (e) {}
        });

        if (!videoSrc) {
          const videoEl = document.querySelector("video");
          videoSrc = videoEl?.src || videoEl?.querySelector("source")?.src || "";
        }
        
        if (!title) title = document.querySelector('h1, [data-test-id="pinTitle"]')?.innerText || "";
        if (!description) description = document.querySelector('[data-test-id="pin-description-text"], .p7I')?.innerText || "";
        if (!author) author = document.querySelector('[data-test-id="pinner-name"]')?.innerText || "";

        return {
          videoSrc,
          title: title.trim(),
          description: description.trim(),
          author: author.trim(),
          viewCount,
          uploadDate: uploadDate || "Recently",
          related: []
        };
      });

      // Get fallback related
      try {
        const { searchVideos } = require("./pinterest");
        const words = details.title.replace(/[^\w\s]/g, "").split(/\s+/).filter(w => w.length > 3);
        const keyword = words.length > 0 ? words.slice(0, 2).join(" ") + " video" : "aesthetic video";
        const searchResult = await searchVideos(keyword);
        if (searchResult && searchResult.pins) {
          details.related = searchResult.pins.map(p => ({
            pinUrl: p.pinUrl,
            thumbnail: p.thumbnail,
            title: p.title,
            author: p.uploader || "Pinterest"
          })).slice(0, 20);
        }
      } catch (e) {}

      return { success: true, ...details };
    } catch (err) {
      console.error(`[scraper] Browser fallback failed: ${err.message}`);
      return { success: false, error: err.message };
    } finally {
      await context.close();
      await browser.close();
    }
  }
}

module.exports = { scrape200Pins, scrapeByKeyword, scrapePinDetails };
