# PinVid — Pinterest Video Scraper

Scrapes Pinterest for **video-only pins**, caches them in Firestore, and serves a slick dark UI with a rolling 96-hour batch feed.

---

## Stack
- **Backend**: Node.js + Express
- **Scraping**: Playwright (headless Chromium, stealth mode)
- **Database**: Firebase Firestore
- **Scheduling**: node-cron (96-hour rolling cache)
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

### 3. Firebase Setup
You must configure Firebase Firestore for the database:
1. Go to the [Firebase Console](https://console.firebase.google.com/).
2. Create a new project (or use an existing one).
3. Enable **Firestore Database** in the project.
4. Go to **Project Settings** > **Service Accounts**.
5. Click **Generate new private key**.
6. Save the downloaded file as `backend/serviceAccountKey.json`.

### 4. Create `.env`
In the `backend` directory, create a `.env` file (or use the provided template):
```env
FIREBASE_KEY_PATH=./serviceAccountKey.json
PORT=3001
```

### 5. Run Migration (If upgrading from SQLite)
If you have existing data in `backend/data/pins.db`, run the one-time migration script:
```bash
cd backend
node migrate.js
```

### 6. Run the server
```bash
# Production
node server.js

# Dev (auto-reload)
npm run dev
```

### 7. Open the app
Visit: **http://localhost:3001**

---

## How It Works

| Feature | What happens |
|---|---|
| Background Scraper | Automatically runs every 96 hours to gather 200 fresh pins into Firestore. |
| Page load | Pulls exactly from the current Firestore batch and shuffles pins using Fisher-Yates. |
| Refresh button | Re-shuffles the current cache without triggering a new scrape. |
| Detail View | Fetches detailed video URLs natively via Pinterest Proxy + Scraper fallback. |

---

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/pins/random` | Returns shuffled pins from the current 96-hour batch |
| `GET /api/pinterest/feed` | Used for pagination, falls back to cache |
| `GET /api/status` | Returns timestamp of last scrape and next schedule |

---

## File Structure

```text
pinterest-scraper/
├── backend/
│   ├── server.js             ← Express app + API routes + Cron
│   ├── scraper.js            ← Playwright scraping logic
│   ├── db.js                 ← Firestore wrapper methods
│   ├── firebase.js           ← Firebase Admin initialization
│   ├── migrate.js            ← SQLite to Firestore migration script
│   ├── .env                  ← Environment variables
│   ├── serviceAccountKey.json← Your Firebase Credentials (ignored in git)
│   └── package.json
├── frontend/
│   └── public/
│       └── index.html        ← Full UI (served by Express)
└── README.md
```
