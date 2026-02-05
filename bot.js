/**
 * Polymarket Weekly “#1 Free App” Monitor -> Telegram Alerts (Final Clean Stable)
 *
 * Required env vars:
 * - TELEGRAM_BOT_TOKEN
 * - TELEGRAM_CHAT_ID
 *
 * Recommended env vars:
 * - OUTCOME_NAME (default: "ChatGPT")
 * - POLL_SECONDS (default: 60)
 * - THRESHOLD_WARN (default: 0.90)
 * - THRESHOLD_CRIT (default: 0.50)
 * - LOOKAHEAD_DAYS (default: 10)  // buffer window to find newly created next-week markets
 * - PORT (default: 10000)
 *
 * Optional env vars:
 * - FORCE_EVENT_SLUG (if set, disables auto-roll and tracks this exact slug)
 */

import http from "http";
import fs from "fs/promises";

const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TELEGRAM_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "").trim();
if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing env var: TELEGRAM_BOT_TOKEN");
if (!TELEGRAM_CHAT_ID) throw new Error("Missing env var: TELEGRAM_CHAT_ID");

const OUTCOME_NAME = String(process.env.OUTCOME_NAME || "ChatGPT").trim();
const FORCE_EVENT_SLUG = String(process.env.FORCE_EVENT_SLUG || "").trim();

const POLL_SECONDS = Number(process.env.POLL_SECONDS || 60);
const THRESHOLD_WARN = Number(process.env.THRESHOLD_WARN || 0.9);
const THRESHOLD_CRIT = Number(process.env.THRESHOLD_CRIT || 0.5);
const LOOKAHEAD_DAYS = Number(process.env.LOOKAHEAD_DAYS || 10);
const PORT = Number(process.env.PORT || 10000);

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";

const STATE_PATH = "./state.json";

function nowIso() {
  return new Date().toISOString();
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      accept: "application/json",
      ...(opts.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url} :: ${text.slice(0, 200)}`);
  }
  return await res.json();
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const st = JSON.parse(raw);
    return {
      trackedSlug: st.trackedSlug || null,
      warnTriggered: Boolean(st.warnTriggered),
      critTriggered: Boolean(st.critTriggered),
      updatedAt: st.updatedAt || null,
    };
  } catch {
    return {
      trackedSlug: null,
      warnTriggered: false,
      critTriggered: false,
      updatedAt: null,
    };
  }
}

async function saveState(state) {
  const out = { ...state, updatedAt: nowIso() };
  await fs.writeFile(STATE_PATH, JSON.stringify(out, null, 2), "utf8");
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${encodeURIComponent(TELEGRAM_BOT_TOKEN)}/sendMessage`;
  const payload = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    disable_web_page_preview: true,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram sendMessage failed: HTTP ${res.status} :: ${body.slice(0, 200)}`);
  }
}

function fmtPct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

function eventUrl(slug) {
  return `https://polymarket.com/event/${slug}`;
}

async function getEventBySlug(slug) {
  return await fetchJson(`${GAMMA_BASE}/events/slug/${encodeURIComponent(slug)}`);
}

function slugForDate(d) {
  const month = d.toLocaleString("en-US", { month: "long" }).toLowerCase();
  const day = d.getDate();
  return `1-free-app-in-the-us-apple-app-store-on-${month}-${day}`;
}

/**
 * Weekly slug detection:
 * - If FORCE_EVENT_SLUG is set, it always returns that.
 * - Otherwise, it checks today through LOOKAHEAD_DAYS ahead (buffer),
 *   plus weekly offsets (7/14/21) as a secondary net.
 *
 * The buffer is what makes this robust even if the market is created early
 * or the weekly date shifts by a day.
 */
async function findWeeklySlugAuto() {
  if (FORCE_EVENT_SLUG) return FORCE_EVENT_SLUG;

  const now = new Date();
  const candidates = [];

  for (let i = 0; i <= LOOKAHEAD_DAYS; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    candidates.push(d);
  }

  for (const w of [7, 14, 21]) {
    const d = new Date(now);
    d.setDate(d.getDate() + w);
    candidates.push(d);
  }

  // De-duplicate by slug while preserving order
  const seen = new Set();
  const slugs = [];
  for (const d of candidates) {
    const s = slugForDate(d);
    if (!seen.has(s)) {
      seen.add(s);
      slugs.push(s);
    }
  }

  for (const slug of slugs) {
    try {
      const ev = await getEventBySlug(slug);
      if (ev && ev.slug) return slug;
    } catch {
      // not found yet
    }
  }

  return null;
}

function parseArrayMaybeJson(x) {
  if (Array.isArray(x)) return x;
  if (typeof x === "string") {
    try {
      const parsed = JSON.parse(x);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Prefer the market that actually contains the tracked outcome in its outcomes list.
 * This is more reliable than using the question text.
 */
function pickMarket(eventObj) {
  const markets = eventObj?.markets;
  if (!Array.isArray(markets) || markets.length === 0) {
    throw new Error("No markets found in event response.");
  }

  const target = OUTCOME_NAME.trim().toLowerCase();

  function marketHasOutcome(m, wantedLower) {
    const outcomes = parseArrayMaybeJson(m?.outcomes);
    if (!outcomes) return false;
    return outcomes.some((o) => String(o).trim().toLowerCase() === wantedLower);
  }

  // First: a market that contains OUTCOME_NAME
  const byOutcome = markets.find((m) => marketHasOutcome(m, target));
  if (byOutcome) return byOutcome;

  // Second: a binary Yes/No market
  const byYes = markets.find((m) => marketHasOutcome(m, "yes"));
  if (byYes) return byYes;

  // Fallback: first market
  return markets[0];
}

/**
 * Extract token id:
 * - If market has "Yes", treat as binary and track Yes.
 * - Otherwise track OUTCOME_NAME for multi-outcome markets.
 */
function extractTokenId(marketObj) {
  const outcomes = parseArrayMaybeJson(marketObj?.outcomes);
  const tokenIds = parseArrayMaybeJson(marketObj?.clobTokenIds);

  if (!outcomes || !tokenIds || outcomes.length !== tokenIds.length) {
    throw new Error("Market outcomes/clobTokenIds missing or malformed.");
  }

  const yesIndex = outcomes.findIndex((o) => String(o).trim().toLowerCase() === "yes");
  if (yesIndex >= 0) {
    const tok = tokenIds[yesIndex];
    if (!tok) throw new Error("YES token id was empty.");
    return { tokenId: String(tok), label: "Yes" };
  }

  const target = OUTCOME_NAME.trim().toLowerCase();
  const idx = outcomes.findIndex((o) => String(o).trim().toLowerCase() === target);
  if (idx < 0) {
    throw new Error(
      `Outcome "${OUTCOME_NAME}" not found. Outcomes sample: ${outcomes.slice(0, 20).join(", ")}`
    );
  }

  const tok = tokenIds[idx];
  if (!tok) throw new Error(`Token id for outcome "${OUTCOME_NAME}" was empty.`);
  return { tokenId: String(tok), label: OUTCOME_NAME };
}

/**
 * Get live probability:
 * - Prefer midpoint
 * - Fall back to average of BUY/SELL
 */
async function getProbability(tokenId) {
  try {
    const mid = await fetchJson(`${CLOB_BASE}/midpoint?token_id=${encodeURIComponent(tokenId)}`);
    const p = Number(mid?.midpoint);
    if (Number.isFinite(p)) return p;
  } catch {
    // fall back
  }

  const buyUrl = `${CLOB_BASE}/price?token_id=${encodeURIComponent(tokenId)}&side=BUY`;
  const sellUrl = `${CLOB_BASE}/price?token_id=${encodeURIComponent(tokenId)}&side=SELL`;

  const [buy, sell] = await Promise.all([fetchJson(buyUrl), fetchJson(sellUrl)]);
  const pb = Number(buy?.price);
  const ps = Number(sell?.price);

  if (!Number.isFinite(pb) || !Number.isFinite(ps)) {
    throw new Error("Could not read buy/sell price as numbers.");
  }

  return (pb + ps) / 2;
}

/**
 * Threshold crossing logic (anti-spam):
 * - Triggers only once per “below threshold episode”
 * - Resets when recovered above threshold
 */
function updateTriggers(state, prob) {
  if (prob >= THRESHOLD_WARN) state.warnTriggered = false;
  if (prob >= THRESHOLD_CRIT) state.critTriggered = false;

  const shouldWarn = !state.warnTriggered && prob < THRESHOLD_WARN;
  const shouldCrit = !state.critTriggered && prob < THRESHOLD_CRIT;

  if (shouldWarn) state.warnTriggered = true;
  if (shouldCrit) state.critTriggered = true;

  return { shouldWarn, shouldCrit };
}

async function mainLoop() {
  let state = await loadState();

  console.log(
    `[${nowIso()}] Starting. FORCE_EVENT_SLUG=${FORCE_EVENT_SLUG || "(none)"} OUTCOME_NAME=${OUTCOME_NAME} POLL_SECONDS=${POLL_SECONDS} LOOKAHEAD_DAYS=${LOOKAHEAD_DAYS}`
  );

  while (true) {
    try {
      const slug = await findWeeklySlugAuto();
      if (!slug) {
        console.log(`[${nowIso()}] No weekly event found yet. Will retry.`);
        await sleep(POLL_SECONDS * 1000);
        continue;
      }

      // New week detected
      if (state.trackedSlug !== slug) {
        state.trackedSlug = slug;
        state.warnTriggered = false;
        state.critTriggered = false;
        await saveState(state);

        await sendTelegram(
          `🆕 New weekly market detected:\n${eventUrl(slug)}\nTracking: ${OUTCOME_NAME}`
        );
      }

      const ev = await getEventBySlug(state.trackedSlug);
      const market = pickMarket(ev);
      const { tokenId, label } = extractTokenId(market);

      const prob = await getProbability(tokenId);

      console.log(`[${nowIso()}] ${label} prob=${fmtPct(prob)} | slug=${state.trackedSlug}`);

      const { shouldWarn, shouldCrit } = updateTriggers(state, prob);
      await saveState(state);

      if (shouldWarn) {
        await sendTelegram(
          `⚠️ ${label} dropped below ${fmtPct(THRESHOLD_WARN)}: now ${fmtPct(prob)}\n${eventUrl(state.trackedSlug)}`
        );
      }
      if (shouldCrit) {
        await sendTelegram(
          `🚨 ${label} dropped below ${fmtPct(THRESHOLD_CRIT)}: now ${fmtPct(prob)}\n${eventUrl(state.trackedSlug)}`
        );
      }
    } catch (err) {
      console.error(`[${nowIso()}] Error:`, err?.message || err);
    }

    await sleep(POLL_SECONDS * 1000);
  }
}

/* Health server for Render and uptime checks */
http
  .createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("running");
  })
  .listen(PORT, () => console.log(`[${nowIso()}] HTTP server listening on :${PORT}`));

mainLoop().catch((e) => {
  console.error(`[${nowIso()}] Fatal:`, e);
  process.exit(1);
});
