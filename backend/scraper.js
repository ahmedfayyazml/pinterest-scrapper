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

// ─── SCRAPE RANDOM ─────────────────────────────────────────────────────────

async function scrapeRandom() {
  const browser = await launchBrowser();
  const { page, context } = await newStealthPage(browser);

  try {
    console.log("[scraper] Fetching trending video pins...");

    // Try a broad search for videos - most stable way to get results without login
    const fallbacks = ["aesthetic videos", "nature videos", "funny videos", "cooking videos"];
    const randomKeyword = fallbacks[Math.floor(Math.random() * fallbacks.length)];
    
    await page.goto(`https://www.pinterest.com/search/pins/?q=${encodeURIComponent(randomKeyword)}&rs=typed`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    await page.waitForTimeout(3000);
    
    let pins = await extractVideoPins(page);
    
    // If still empty, try one more direct idea page
    if (pins.length === 0) {
      console.log("[scraper] Search fallback failed, trying direct ideas page...");
      await page.goto("https://www.pinterest.com/ideas/videos/910496889176/", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      pins = await extractVideoPins(page);
    }

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

async function scrapePinDetails(pinUrl, contextQuery = "") {
  const browser = await launchBrowser();
  const { page, context } = await newStealthPage(browser);

  try {
    console.log(`[scraper] Fetching details for: ${pinUrl} (Context: ${contextQuery || 'Feed'})`);
    // Use domcontentloaded to avoid networkidle timeouts on heavy Pinterest pages
    await page.goto(pinUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    
    // Scroll more to trigger related pins ("More like this" is often lower)
    await page.evaluate(() => window.scrollBy(0, 1500));
    await page.waitForTimeout(3000);

    const details = await page.evaluate(() => {
      let videoSrc = "";
      let title = "";
      let description = "";
      let author = "";
      let uploadDate = "";
      let viewCount = null;

      // 1. Try JSON-LD (Schema.org) - Most reliable for metadata
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
            
            if (video.interactionStatistic) {
              const stats = Array.isArray(video.interactionStatistic) ? video.interactionStatistic : [video.interactionStatistic];
              const viewStat = stats.find(s => s.interactionType?.includes("WatchAction") || s.interactionType?.includes("ViewAction"));
              if (viewStat) viewCount = viewStat.userInteractionCount;
            }
          } else if (root["@type"] === "SocialMediaPosting" || root["@type"] === "Article") {
            title = root.headline || root.name || title;
            description = root.articleBody || root.description || description;
            author = root.author?.name || author;
            uploadDate = root.datePublished || root.dateCreated || uploadDate;
          }
        } catch (e) {}
      });

      // 2. Fallback to DOM Selectors
      if (!videoSrc) {
        const videoEl = document.querySelector("video");
        videoSrc = videoEl?.src || videoEl?.querySelector("source")?.src || "";
      }
      
      if (!title) title = document.querySelector('h1, [data-test-id="pinTitle"]')?.innerText || "";
      if (!description) description = document.querySelector('[data-test-id="pin-description-text"], .p7I')?.innerText || "";
      if (!author) author = document.querySelector('[data-test-id="pinner-name"]')?.innerText || "";
      
      if (uploadDate) {
        try {
          const d = new Date(uploadDate);
          if (!isNaN(d.getTime())) {
            uploadDate = d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
          } else {
            uploadDate = "Recently";
          }
        } catch(e) {
          uploadDate = "Recently";
        }
      } else {
        uploadDate = "Recently";
      }

      // Related pins
      const relatedResults = [];
      const relatedSeen = new Set();
      const pinElements = document.querySelectorAll('[data-test-id="pin"], .GrowthUnauthPinImage, [data-grid-item]');
      
      pinElements.forEach(el => {
        try {
          const anchor = el.querySelector("a[href*='/pin/']");
          if (!anchor) return;
          const url = anchor.href;
          if (relatedSeen.has(url) || url.includes(window.location.pathname)) return;
          relatedSeen.add(url);

          const img = el.querySelector("img");
          const thumb = img?.src || "";
          if (!thumb || thumb.includes("75x75") || thumb.includes("user")) return;

          relatedResults.push({
            pinUrl: url,
            thumbnail: thumb,
            title: (img?.alt || "Pinterest Video").trim(),
            author: el.querySelector('[data-test-id="pinner-name"]')?.innerText || "Pinterest",
          });
        } catch (e) {}
      });

      return {
        videoSrc,
        title: title.trim(),
        description: description.trim(),
        author: author.trim(),
        viewCount,
        uploadDate,
        related: relatedResults.slice(0, 20)
      };
    });

    // FALLBACK: If no related pins found, or if we want to honor the search/feed context
    if (details.related.length < 5) {
      console.log(`[scraper] Not enough related pins. Using context: ${contextQuery || 'Trending'}`);
      try {
        let keyword = contextQuery;
        if (!keyword) {
          // If from feed, pick something from title or just generic trending
          const words = details.title.split(/\s+/).filter(w => w.length > 3);
          keyword = words.length > 0 ? words[0] + " trending" : "trending videos";
        }
        
        const searchUrl = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(keyword)}&rs=typed`;
        await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
        await page.evaluate(() => window.scrollBy(0, 800));
        await page.waitForTimeout(2000);
        
        const fallbackPins = await page.evaluate(() => {
          const results = [];
          const seen = new Set();
          const items = document.querySelectorAll('[data-test-id="pin"], .GrowthUnauthPinImage');
          items.forEach(el => {
            try {
              const anchor = el.querySelector("a[href*='/pin/']");
              if (!anchor || seen.has(anchor.href)) return;
              const img = el.querySelector("img");
              if (!img || !img.src || img.src.includes("75x75")) return;
              seen.add(anchor.href);
              results.push({
                pinUrl: anchor.href,
                thumbnail: img.src,
                title: img.alt || "Related Video",
                author: el.querySelector('[data-test-id="pinner-name"]')?.innerText || "Pinterest",
              });
            } catch(e) {}
          });
          return results;
        });
        
        // Merge results
        details.related = [...details.related, ...fallbackPins].slice(0, 20);
      } catch (e) {}
    }

    return { success: true, ...details };
  } catch (err) {
    console.error(`[scraper] Detail fetch failed: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    await context.close();
    await browser.close();
  }
}

module.exports = { scrapeRandom, scrapeByKeyword, scrapePinDetails };
