// ─── PROXY MANAGER ─────────────────────────────────────────────────────────
// Centralized SOCKS5 proxy usage tracker shared across the entire app.
// Both scraping (yt-dlp) and playback (Tier 3) consume from the same pool.

const PROXY_URL = process.env.PROXY_URL || "";
const PROXY_DAILY_LIMIT = parseInt(process.env.PROXY_DAILY_LIMIT || "8", 10);

let usesToday = 0;
let resetDate = new Date().toDateString();

function _resetIfNewDay() {
  const today = new Date().toDateString();
  if (today !== resetDate) {
    usesToday = 0;
    resetDate = today;
    console.log("[proxyManager] Daily counter reset");
  }
}

/**
 * Check whether we can still use the SOCKS5 proxy today.
 * @returns {boolean}
 */
function canUseProxy() {
  _resetIfNewDay();
  return !!(PROXY_URL && usesToday < PROXY_DAILY_LIMIT);
}

/**
 * Record one proxy use.  Returns false if the limit was already hit.
 * @returns {boolean} true if the use was recorded, false if limit exceeded
 */
function useProxy() {
  _resetIfNewDay();
  if (!PROXY_URL || usesToday >= PROXY_DAILY_LIMIT) {
    console.log(`[proxyManager] ❌ Proxy limit reached (${usesToday}/${PROXY_DAILY_LIMIT})`);
    return false;
  }
  usesToday++;
  console.log(`[proxyManager] ✅ Proxy used (${usesToday}/${PROXY_DAILY_LIMIT} today)`);
  return true;
}

/**
 * Current proxy status for the /api/status endpoint.
 */
function getStatus() {
  _resetIfNewDay();
  // Calculate when the counter resets (next midnight)
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);

  return {
    usesToday,
    limit: PROXY_DAILY_LIMIT,
    resetsAt: tomorrow.toISOString(),
    proxyConfigured: !!PROXY_URL,
  };
}

/**
 * The raw proxy URL from env (for yt-dlp --proxy flag, axios agent, etc.)
 */
function getProxyUrl() {
  return PROXY_URL;
}

module.exports = { canUseProxy, useProxy, getStatus, getProxyUrl };
