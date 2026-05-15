# PinVid — Pinterest Video Scraper

Scrapes Pinterest for **video-only pins**, caches them locally in SQLite, and serves a slick dark UI with live + cached search.

---

## Stack
- **Backend**: Node.js + Express
- **Scraping**: Playwright (headless Chromium, stealth mode)
- **Cache**: SQLite via `better-sqlite3`
- **Frontend**: Plain HTML/CSS/JS (served by Express)

---

## Setup

### 1. Install dependencies
```bash
cd backend
npm install
```

### 2. Install Playwright browser (one-time)
```bash
npx playwright install chromium
```

### 3. Run the server
```bash
# Production
node server.js

# Dev (auto-reload)
npx nodemon server.js
```

### 4. Open the app
Visit: **http://localhost:3001**

---

## How It Works

| Feature | What happens |
|---|---|
| Page load | Auto-scrapes Pinterest trending video feed |
| Search bar | Hits Pinterest live + queries local SQLite cache simultaneously |
| Cached tab | Shows all previously scraped pins from SQLite |
| Refresh button | Re-scrapes fresh pins |

---

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/pins/random` | Scrape trending video pins |
| `GET /api/pins/search?q=keyword` | Live scrape + cache search merged |
| `GET /api/pins/cached` | Return all cached pins from SQLite |

---

## Notes

- Pinterest may redirect to a login wall — the scraper handles this gracefully and returns an empty result
- All scraped pins are cached in `backend/data/pins.db` (SQLite)
- The scraper uses random delays + stealth headers to avoid blocks
- For best results, run from a residential IP (not a datacenter/VPS)

---

## File Structure

```
pinterest-scraper/
├── backend/
│   ├── server.js       ← Express app + API routes
│   ├── scraper.js      ← Playwright scraping logic
│   ├── db.js           ← SQLite cache layer
│   ├── data/           ← Auto-created, holds pins.db
│   └── package.json
├── frontend/
│   └── public/
│       └── index.html  ← Full UI (served by Express)
└── README.md
```
