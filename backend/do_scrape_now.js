const scraper = require('./scraper');
const db = require('./db');

async function doScrapeNow() {
  try {
    console.log("Starting scrape NOW...");
    const pins = await scraper.scrape200Pins();
    console.log(`Scraped ${pins.length} pins.`);
    if (pins.length > 0) {
      const newBatchId = "batch_manual_" + Date.now();
      const timestamp = new Date().toISOString();
      await db.saveBatchPins(pins, newBatchId, timestamp);
      console.log(`Saved batch ${newBatchId} with ${pins.length} pins. Database updated.`);
    }
  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}

doScrapeNow();
