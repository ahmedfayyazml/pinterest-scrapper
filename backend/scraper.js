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

function fetchPinDetailsYTDLP(pinUrl, { forceNoProxy = false } = {}) {
  return new Promise((resolve, reject) => {
    // Build yt-dlp command with optional proxy
    // forceNoProxy=true skips proxy entirely (used by link-refresh cron to protect daily quota)
    let cmd = "yt-dlp -j";
    const proxyUrl = proxyManager.getProxyUrl();
    if (!forceNoProxy && proxyManager.canUseProxy()) {
      cmd += ` --proxy "${proxyUrl}"`;
      proxyManager.useProxy();
      console.log(`[scraper] Fetching details via yt-dlp (WITH PROXY) for: ${pinUrl}`);
    } else {
      const status = proxyManager.getStatus();
      const reason = forceNoProxy ? 'forceNoProxy=true' : `quota: ${status.usesToday}/${status.limit}`;
      console.log(`[scraper] Fetching details via yt-dlp (no proxy, ${reason}) for: ${pinUrl}`);
    }
    cmd += ` "${pinUrl}"`;

    exec(cmd, { timeout: 30000 }, (error, stdout, stderr) => {
      if (error) {
        return reject(new Error(stderr || error.message));
      }
      try {
        const info = JSON.parse(stdout);
        let videoSrc = "";
        let qualities = [];
        
        if (info.formats && info.formats.length > 0) {
          const allFormats = info.formats.filter(f => f.url);

          // 1. Prefer direct MP4 formats (exclude any HLS/m3u8)
          const mp4Formats = allFormats.filter(f =>
            (f.url.includes('.mp4') || f.ext === 'mp4') &&
            !f.url.includes('.m3u8') && !f.protocol?.includes('m3u8')
          );

          // 2. Any non-HLS, non-cmfv format as fallback
          const nonHlsFormats = allFormats.filter(f =>
            !f.url.includes('.m3u8') && !f.protocol?.includes('m3u8') &&
            !f.url.includes('.cmfv')
          );

          // ── TARGET QUALITY: 480p MAX ────────────────────────────────
          // Prefer the 480p MP4. If not available, take the next best
          // resolution that is ≤ 480p. Only fall back to higher if there
          // is literally nothing at or below 480p.
          const preferred = mp4Formats.length > 0 ? mp4Formats : nonHlsFormats;
          if (preferred.length > 0) {
            // Sort descending by height so we can find the best ≤480p
            preferred.sort((a, b) => (b.height || 0) - (a.height || 0));

            // Look for best ≤ 480p first
            const under480 = preferred.filter(f => (f.height || 0) <= 480);
            // Exact 480p
            const exact480 = preferred.find(f => f.height === 480);

            let chosen;
            if (exact480) {
              chosen = exact480; // ideal: 480p
            } else if (under480.length > 0) {
              chosen = under480[0]; // best below 480p (e.g. 360p)
            } else {
              // Nothing at or below 480p — take lowest available (least bad)
              chosen = preferred[preferred.length - 1];
            }

            videoSrc = chosen.url;
            console.log(`[scraper] Selected 480p-target format: ${chosen.ext || 'unknown'} @ ${chosen.height || '?'}p / ${chosen.tbr || '?'}kbps`);
          } else {
            console.log(`[scraper] WARNING: No direct MP4 found for this pin. videoSrc will be empty.`);
          }

          // Build qualities array — MP4 only, cap at 480p
          // Exclude anything above 480p (720p, 1080p, etc.)
          const seenHeights = new Set();
          mp4Formats
            .filter(f => f.height && f.height <= 480)
            .sort((a, b) => (b.height || 0) - (a.height || 0))
            .forEach(f => {
              if (seenHeights.has(f.height)) return;
              seenHeights.add(f.height);
              qualities.push({
                label: `${f.height}p`,
                height: f.height,
                tbr: Math.round(f.tbr || 0),
                url: f.url,
                protocol: 'mp4'
              });
            });

          // Sort: highest quality first (still all ≤ 480p)
          qualities.sort((a, b) => (b.height || 0) - (a.height || 0));
          console.log(`[scraper] Qualities (480p cap): ${qualities.map(q => `${q.label}@${q.tbr}k`).join(', ') || 'none'}`);
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
          qualities,
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

async function scrapePinDetails(pinUrl, { contextQuery = "", forceNoProxy = false } = {}) {
  try {
    // 1. Try yt-dlp first (FAST & ROBUST) — NO related pins fetch here
    // forceNoProxy=true is passed by the link-refresh cron to avoid burning SOCKS5 quota
    const details = await fetchPinDetailsYTDLP(pinUrl, { forceNoProxy });
    return details;
  } catch (ytdlpError) {
    console.warn(`[scraper] yt-dlp failed, falling back to browser scraper: ${ytdlpError.message}`);
    
    // 2. Playwright fallback — video only, no related pins
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

// ─── FETCH RELATED PINS (separate, non-blocking) ──────────────────────────
// Called AFTER the response is already sent to the client.
// Results are cached in Firestore for instant access next time.
async function fetchRelatedPins(title, contextQuery = "") {
  try {
    const { searchVideos } = require("./pinterest");
    let keyword = contextQuery;
    if (!keyword) {
      const words = (title || "").replace(/[^\w\s]/g, "").split(/\s+/).filter(w => w.length > 3);
      keyword = words.length > 0 ? words.slice(0, 2).join(" ") + " video" : "aesthetic video";
    }
    console.log(`[scraper] [background] Fetching related pins: "${keyword}"`);
    const searchResult = await searchVideos(keyword);
    if (searchResult && searchResult.pins) {
      return searchResult.pins.map(p => ({
        pinUrl: p.pinUrl,
        thumbnail: p.thumbnail,
        title: p.title,
        author: p.uploader || "Pinterest"
      })).slice(0, 20);
    }
    return [];
  } catch (e) {
    console.warn("[scraper] [background] Related pins fetch failed:", e.message);
    return [];
  }
}

module.exports = { scrape200Pins, scrapeByKeyword, scrapePinDetails, fetchRelatedPins };

