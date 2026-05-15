const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();

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
    viewport: { width: 1280, height: 900 },
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
  await page.waitForTimeout(3000);

  // Scroll to load more pins (increased cycles and distance)
  for (let i = 0; i < 15; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 3));
    await sleep(1500 + Math.random() * 1000);
  }

  const pins = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    // broad selector to catch all pin-like elements
    const pinElements = document.querySelectorAll(
      '[data-test-id="pin"], [data-grid-item], .GrowthUnauthPinImage, div[role="listitem"], [aria-label="Pin card"]'
    );

    pinElements.forEach((el) => {
      try {
        // Robust video indicators:
        // 1. duration label like "0:15" or "1:30"
        // 2. video element
        // 3. specific data attributes or classes
        const text = el.innerText || "";
        const hasDuration = /\d+:\d+/.test(text); 
        
        const hasVideo =
          el.querySelector("video") ||
          el.querySelector('[data-test-id="video-pin-with-controls"]') ||
          el.querySelector(".videoContainer") ||
          el.querySelector('[aria-label*="video" i]') ||
          el.querySelector('[aria-label*="Video" i]') ||
          el.querySelector(".PinCard--video") ||
          el.getAttribute("data-is-video") === "true" ||
          hasDuration;

        if (!hasVideo) return;

        // Get pin link
        const anchor = el.querySelector("a[href*='/pin/']");
        if (!anchor) return;

        const pinUrl = anchor.href;
        if (seen.has(pinUrl)) return;
        seen.add(pinUrl);

        // Get thumbnail
        const img = el.querySelector("img");
        const thumbnail = img?.src || img?.getAttribute("data-src") || "";

        // Get video src if available (often not available in grid, but we try)
        const videoEl = el.querySelector("video");
        const videoSrc = videoEl?.src || videoEl?.querySelector("source")?.src || "";

        // Get title/description
        const title =
          img?.alt ||
          el.querySelector('[data-test-id="pin-title"]')?.innerText ||
          el.querySelector(".tBJ")?.innerText ||
          "";

        // Get author
        const authorEl = el.querySelector('[data-test-id="pinner-name"], .lH2, .zI7');
        const author = authorEl?.innerText || "";

        if (pinUrl && thumbnail) {
          results.push({
            pinUrl,
            thumbnail,
            videoSrc,
            title: title.trim(),
            author: author.trim(),
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

// ─── SCRAPE RANDOM ─────────────────────────────────────────────────────────

async function scrapeRandom() {
  const browser = await launchBrowser();
  const { page, context } = await newStealthPage(browser);

  try {
    console.log("[scraper] Loading Pinterest video feed...");

    // Try the video category page first (no login required usually)
    await page.goto("https://www.pinterest.com/search/pins/?q=trending+videos&rs=typed", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    await randomDelay();

    // If redirected to login, try alternate URL
    const url = page.url();
    if (url.includes("login") || url.includes("_auth")) {
      console.log("[scraper] Login wall hit, trying alternate URL...");
      await page.goto("https://www.pinterest.com/ideas/videos/910496889176/", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await randomDelay();
    }

    const pins = await extractVideoPins(page);
    console.log(`[scraper] Found ${pins.length} video pins`);
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

module.exports = { scrapeRandom, scrapeByKeyword };
