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

  // Scroll aggressively to load more pins
  for (let i = 0; i < 15; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 3));
    await sleep(600 + Math.random() * 400);
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

        const rawUrl = anchor.href;
        const pinUrl = rawUrl.split('?')[0].replace(/\/$/, "");
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

    // Full mega-list of 100+ categories — pick 20 random ones each run for maximum rotation
    const allCategories = [
      // Lifestyle & Entertainment
      "Gaming Walkthroughs videos", "Tech Gadget Reviews videos", "Personal Finance Investing videos",
      "AI Tutorials Automation videos", "Daily Life Vlogs videos", "Educational Explainers videos",
      "Fitness Workout Routines videos", "Product Unboxing videos", "ASMR Content videos",
      "Video Podcasts", "Cooking Recipe Tutorials videos", "Software Coding Lessons videos",
      "Travel Vlogs videos", "Documentary Deep Dives videos", "Comedy Skits videos",
      "Reaction Videos", "Challenge Tag Videos", "Music Covers videos",
      "Fashion OOTD videos", "Beauty Makeup Tutorials videos",
      // Gaming
      "Game Lets Plays videos", "Game Highlights Speedruns videos", "Movie Media Reviews videos",
      "Book Literary Reviews videos", "Motivational Speeches videos", "True Crime Storytelling videos",
      "Quiet Meditation Sessions videos", "Pet Animal Compilations videos", "Product Showcases videos",
      "Behind the Scenes BTS videos",
      // Business
      "Company Culture Meet the Team videos", "Client Testimonials videos", "Webinar Recordings videos",
      "Social Media Ads UGC videos", "App Promos videos", "Recruitment Job Intros videos",
      "Holiday Seasonal Greetings videos", "Corporate Training videos", "Sales Presentations videos",
      "FAQ Q&A Sessions videos",
      // Production Styles
      "Talking Head Commentary videos", "Screen Recordings Screencasts", "360 Degree VR Experiences videos",
      "Time Lapse videos", "Slow Motion Footage videos", "Drone Aerial Cinematography videos",
      "Live Streams videos", "Slideshows Photo Collages videos", "Kinetic Typography videos",
      "2D Animation videos", "3D Animation videos", "Motion Graphics videos",
      "Green Screen Chroma Key videos", "Split Screen Interviews videos",
      // Personal Content
      "Silent Visual Storytelling videos", "YouTube Shorts Vertical Reels", "Day in the Life Professional videos",
      "Whats in My Bag videos", "Get Ready With Me GRWM videos", "Comparison Cheap vs Expensive videos",
      "Travel Hidden Gem Guides videos", "Collection Tours Sneakers videos", "Failed Blooper Reels videos",
      "Flashback Throwback Memories videos",
      // Educational
      "Whiteboard Animations videos", "Infographic Videos", "News Recaps videos",
      "Language Lessons videos", "Science Experiments videos", "DIY Crafting videos",
      "Myth Busting videos", "Career Guidance videos", "Philosophy Thought Pieces videos",
      "Stand Up Comedy Clips videos",
      // Creative
      "Prank Videos", "Lyric Videos", "Dance Choreography videos",
      "Parody Spoof Videos", "Short Films", "Stop Motion Animation videos",
      "Personality Character Skits videos", "ASMR Roleplay videos",
      // Marketing
      "Pitch Videos", "Video Emails", "Client Onboarding videos",
      "Press Release Media Kits videos", "Hyper Lapse videos", "User Generated Ad Content",
      // Finance
      "Debt Payoff Documentaries videos", "First Time Investor Guides videos",
      "Prompt Engineering Masterclasses videos", "Automation Workflow Guides videos",
      "Property Investing Real Estate videos", "Micro Hobby Tutorials videos",
      // Trending
      "Transformation Before After videos", "Trend Jacking Audio Mashups videos",
      "Faceless AI Avatars videos", "Local Restaurant City Guides videos",
      // Original categories
      "Food and Beverage videos", "Home Decor videos", "Style and Fashion videos",
      "Hair Styling videos", "Nail Art videos", "Gardening and Plants videos",
      "Home Organization videos", "Event and Wedding Planning videos", "Art and Illustration videos",
      "Mental Health and Wellness videos", "Productivity and Planning videos", "Photography and Videography videos",
      "Graphic Design and Lettering videos", "Business and Marketing Strategy videos"
    ];

    // Shuffle and pick 20 random categories each run — over multiple runs this covers all 100+ categories
    const shuffled = allCategories.sort(() => 0.5 - Math.random());
    const selectedKeywords = shuffled.slice(0, 20);
    console.log(`[scraper] Selected categories this run: ${selectedKeywords.join(', ')}`);
    // Target: 10 pins per category × 20 categories = 200 pins
    const targetPerCategory = 10;
    
    let allPins = [];
    
    for (const keyword of selectedKeywords) {
      console.log(`[scraper] Fetching pins for category: ${keyword} (have ${allPins.length} so far)`);
      await page.goto(`https://www.pinterest.com/search/pins/?q=${encodeURIComponent(keyword)}&rs=typed`, {
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

      let currentKeywordPins = [];
      let attempts = 0;
      let lastCount = 0;
      let stuckRounds = 0;

      // Scroll up to 25 times per category to find enough video pins
      while (currentKeywordPins.length < targetPerCategory && attempts < 25) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 3));
        await sleep(800 + Math.random() * 800);
        
        const newPins = await extractVideoPins(page);
        
        // Deduplicate against both the globally collected pins and currently collected pins
        const seen = new Set([...allPins, ...currentKeywordPins].map(p => p.pinUrl));
        for (const p of newPins) {
          if (!seen.has(p.pinUrl)) {
            currentKeywordPins.push(p);
            seen.add(p.pinUrl);
          }
        }
        
        // If no new pins for 4 rounds, move on to next category
        if (currentKeywordPins.length === lastCount) {
          stuckRounds++;
          if (stuckRounds >= 4) {
            console.log(`[scraper] No new pins found for 4 rounds, moving on from: ${keyword}`);
            break;
          }
        } else {
          stuckRounds = 0;
          lastCount = currentKeywordPins.length;
        }
        
        console.log(`[scraper] ${keyword}: ${currentKeywordPins.length}/${targetPerCategory} video pins (attempt ${attempts+1})`);
        attempts++;
      }
      
      console.log(`[scraper] ✓ Category done: ${keyword} → ${currentKeywordPins.length} pins`);
      allPins = allPins.concat(currentKeywordPins);
    }

    // We have pins. Let's make sure we have around 200 and shuffle them.
    allPins = allPins.sort(() => 0.5 - Math.random());
    allPins = allPins.slice(0, 200);

    console.log(`[scraper] Fetching video sources for ${allPins.length} pins before saving...`);
    const enrichedPins = [];
    const BATCH_SIZE = 5;

    for (let i = 0; i < allPins.length; i += BATCH_SIZE) {
      const batch = allPins.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map(async (pin) => {
        try {
          const details = await fetchPinDetailsYTDLP(pin.pinUrl, { forceNoProxy: true });
          if (details && details.videoSrc) {
             return {
               ...pin,
               videoSrc: details.videoSrc,
               qualities: details.qualities || [],
             };
          }
        } catch (e) {
          console.warn(`[scraper] Error fetching details for ${pin.pinUrl}: ${e.message}`);
        }
        return null;
      }));

      for (const r of results) {
        if (r) enrichedPins.push(r);
      }
      console.log(`[scraper] Resolved videoSrc batch ${Math.floor(i/BATCH_SIZE)+1}/${Math.ceil(allPins.length/BATCH_SIZE)} | Enriched: ${enrichedPins.length}`);
    }

    console.log(`[scraper] ✅ Finished collecting ${enrichedPins.length} fully enriched video pins.`);
    return enrichedPins;
  } catch (error) {
    console.error("[scraper] Real error during scrape200Pins:", error);
    throw error;
  } finally {
    try {
      if (context) await context.close();
    } catch (e) {
      console.warn("[scraper] Failed to close context:", e.message);
    }
    try {
      if (browser) await browser.close();
    } catch (e) {
      console.warn("[scraper] Failed to close browser:", e.message);
    }
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
  } catch (error) {
    console.error("[scraper] Real error during scrapeByKeyword:", error);
    throw error;
  } finally {
    try {
      if (context) await context.close();
    } catch (e) {
      console.warn("[scraper] Failed to close context:", e.message);
    }
    try {
      if (browser) await browser.close();
    } catch (e) {
      console.warn("[scraper] Failed to close browser:", e.message);
    }
  }
}

// ─── HLS → MP4 CONVERTER ────────────────────────────────────────────────────
// Pinterest CDN HLS URLs follow this exact pattern:
//   https://v1.pinimg.com/videos/mc/hls/AA/BB/CC/HASH_480w.m3u8
// The direct MP4 equivalent is:
//   https://v1.pinimg.com/videos/mc/720p/AA/BB/CC/HASH.mp4
//
// This function converts any Pinterest HLS URL into a direct mp4 URL.
function hlsToMp4(hlsUrl) {
  try {
    let mp4Url = hlsUrl;
    // Pinterest HLS URLs follow: https://v1.pinimg.com/videos/mc/hls/AA/BB/CC/HASH_480w.m3u8
    // Directly replace /hls/ with /720p/
    mp4Url = mp4Url.replace(/\/hls\//i, '/720p/');
    // Remove resolution suffixes like _480w, _720w, _t1
    mp4Url = mp4Url.replace(/_\d+w\.m3u8$/i, '.mp4');
    mp4Url = mp4Url.replace(/_t\d+\.m3u8$/i, '.mp4');
    // Ensure extension is mp4
    mp4Url = mp4Url.replace(/\.m3u8$/i, '.mp4');
    
    console.log(`[scraper] 🔄 Converted HLS/m3u8 → MP4: ${mp4Url.substring(0, 70)}...`);
    return mp4Url;
  } catch (e) {
    return hlsUrl;
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

          // ── TIER 1: Direct MP4 from Pinterest CDN (v1.pinimg.com) ────────
          // Pinterest serves direct .mp4 files (e.g. V_720P format). These are
          // the most reliable — grab ANY direct mp4 regardless of resolution.
          const directMp4Formats = allFormats.filter(f =>
            (f.url.includes('.mp4') || f.ext === 'mp4') &&
            !f.url.includes('.m3u8') &&
            !f.protocol?.includes('m3u8') &&
            !f.url.includes('.cmfv')
          );

          // ── TIER 2: HLS streams as fallback ──────────────────────────────
          const hlsFormats = allFormats.filter(f =>
            f.url.includes('.m3u8') || f.protocol?.includes('m3u8')
          );

          if (directMp4Formats.length > 0) {
            // Pick the lowest available resolution direct mp4 (save bandwidth)
            directMp4Formats.sort((a, b) => (a.height || 9999) - (b.height || 9999));
            const chosen = directMp4Formats[0];
            videoSrc = chosen.url;
            console.log(`[scraper] ✅ Direct MP4 selected: ${chosen.ext || 'mp4'} @ ${chosen.height || '?'}p | url starts: ${chosen.url.substring(0,60)}`);
          } else if (hlsFormats.length > 0) {
            // Convert HLS → direct MP4 using Pinterest CDN URL pattern
            hlsFormats.sort((a, b) => (a.tbr || 0) - (b.tbr || 0));
            const chosen = hlsFormats[0];
            const convertedUrl = hlsToMp4(chosen.url);
            videoSrc = convertedUrl;
            console.log(`[scraper] ✅ HLS→MP4 converted: ${chosen.height || '?'}p @ ${chosen.tbr || '?'}kbps`);
          } else {
            console.log(`[scraper] ❌ No usable format found for this pin.`);
          }

          // Build quality picker list (direct mp4 only, all resolutions)
          const seenHeights = new Set();
          directMp4Formats
            .sort((a, b) => (b.height || 0) - (a.height || 0))
            .forEach(f => {
              if (!f.height || seenHeights.has(f.height)) return;
              seenHeights.add(f.height);
              qualities.push({
                label: `${f.height}p`,
                height: f.height,
                tbr: Math.round(f.tbr || 0),
                url: f.url,
                protocol: 'mp4'
              });
            });

          console.log(`[scraper] Quality options: ${qualities.map(q => `${q.label}`).join(', ') || 'none'}`);
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

