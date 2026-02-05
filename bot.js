/**
 * Polymarket Weekly “#1 Free App” Monitor -> Telegram Alerts (Stable)
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
 * - LOOKAHEAD_DAYS (default: 10)     // window to find newly created next-week markets
 * - SLUG_SCAN_SECONDS (default: 600) // how often to scan Gamma for a new weekly market
 * - PORT (default: 10000)
 *
 * Daily status env vars (optional):
 * - DAILY_STATUS_ENABLED (default: true)
 * - DAILY_STATUS_UTC_HOUR (default: 9)
 * - DAILY_STATUS_UTC_MINUTE (default: 0)
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
const SLUG_SCAN_SECONDS = Number(process.env.SLUG_SCAN_SECONDS || 600);
const PORT = Number(process.env.PORT || 10000);

const DAILY_STATUS_ENABLED = String(process.env.DAILY_STATUS_ENABLED || "true").trim().toLowerCase() !== "false";
const DAILY_STATUS_UTC_HOUR = Number(process.env.DAILY_STATUS_UTC_HOUR || 9);
const DAILY_STATUS_UTC_MINUTE = Number(process.env.DAILY_STATUS_UTC_MINUTE || 0);

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";

const STATE_PATH = "./state.json";

function nowIso() {
  return new Date().toISOString();
}

function utcDateKey(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isAfterDailyStatusTimeUTC(d = new Date()) {
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  if (h > DAILY_STATUS_UTC_HOUR) return true;
  if (h < DAILY_STATUS_UTC_HOUR) return false;
  return m >= DAILY_STATUS_UTC_MINUTE;
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
      lastDailyStatusUtcDate: st.lastDailyStatusUtcDate || null,
      updatedAt: st.updatedAt || null,
    };
  } catch {
    return {
      trackedSlug: null,
      warnTriggered: false,
      critTriggered: false,
      lastDailyStatusUtcDate: null,
      updatedAt: null,
    };
  }
}

async function saveState(state) {
  const out = { ...state, updatedAt: nowIso() };
  await fs.writeFile(STATE_PATH, JSON.stringify(out, null, 2), "utf8");
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

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

async function findWeeklySlugAuto() {
  if (FORCE_EVENT_SLUG) return FORCE_EVENT_SLUG;

  const phrase = "#1 free app in the us apple app store";
  const slugPrefix = "1-free-app-in-the-us-apple-app-store-on-";

  const now = new Date();
  const nowMs = now.getTime();
  const lookaheadMs = LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000;
  const maxEndMs = nowMs + lookaheadMs;

  const url =
    `${GAMMA_BASE}/events` +
    `?active=true&closed=false&limit=200&order=createdAt&ascending=false`;

  const events = await fetchJson(url);
  if (!Array.isArray(events) || events.length === 0) return null;

  for (const ev of events) {
    const slug = String(ev?.slug || "").trim();
    const title = String(ev?.title || "").trim().toLowerCase();

    const isMatch =
      (slug && slug.startsWith(slugPrefix)) ||
      (title && title.includes(phrase));

    if (!isMatch) continue;

    const endDateStr = ev?.endDate;
    const endMs = endDateStr ? Date.parse(endDateStr) : NaN;
    if (!Number.isFinite(endMs)) continue;
    if (endMs <= nowMs) continue;
    if (endMs > maxEndMs) continue;

    if (!slug) continue;

    try {
      const full = await getEventBySlug(slug);
      if (full && full.slug) return slug;
    } catch {
      // skip
    }
  }

  // Fallback slug guessing.
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

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

function marketTextBlob(m) {
  return [
    m?.title,
    m?.question,
    m?.description,
    m?.marketTitle,
    m?.marketQuestion,
  ]
    .map((x) => String(x || ""))
    .join(" ")
    .toLowerCase();
}

function pickMarket(eventObj) {
  const markets = eventObj?.markets;
  if (!Array.isArray(markets) || markets.length === 0) {
    throw new Error("No markets found in event response.");
  }

  const target = norm(OUTCOME_NAME);

  // Multi-outcome market case.
  for (const m of markets) {
    const outcomes = parseArrayMaybeJson(m?.outcomes);
    if (!outcomes) continue;
    const hasTarget = outcomes.some((o) => norm(o) === target);
    if (hasTarget) return m;
  }

  // Per-outcome binary market case (Yes/No, but question/title contains ChatGPT).
  const byText = markets.find((m) => marketTextBlob(m).includes(target));
  if (byText) return byText;

  const sample = markets
    .slice(0, 8)
    .map((m) => String(m?.title || m?.question || "").slice(0, 80))
    .filter(Boolean);

  throw new Error(
    `Could not find a market for "${OUTCOME_NAME}". Sample market labels: ${sample.join(" | ")}`
  );
}

function extractTokenId(marketObj) {
  const outcomes = parseArrayMaybeJson(marketObj?.outcomes);
  const tokenIds = parseArrayMaybeJson(marketObj?.clobTokenIds);

  if (!outcomes || !tokenIds || outcomes.length !== tokenIds.length) {
    throw new Error("Market outcomes/clobTokenIds missing or malformed.");
  }

  const yesIndex = outcomes.findIndex((o) => norm(o) === "yes");
  if (yesIndex >= 0) {
    const tok = tokenIds[yesIndex];
    if (!tok) throw new Error("YES token id was empty.");
    return { tokenId: String(tok), label: OUTCOME_NAME };
  }

  const target = norm(OUTCOME_NAME);
  const idx = outcomes.findIndex((o) => norm(o) === target);
  if (idx < 0) {
    throw new Error(
      `Outcome "${OUTCOME_NAME}" not found. Outcomes sample: ${outcomes.slice(0, 20).join(", ")}`
    );
  }

  const tok = tokenIds[idx];
  if (!tok) throw new Error(`Token id for outcome "${OUTCOME_NAME}" was empty.`);
  return { tokenId: String(tok), label: OUTCOME_NAME };
}

async function getProbability(tokenId) {
  try {
    const mid = await fetchJson(`${CLOB_BASE}/midpoint?token_id=${encodeURIComponent(tokenId)}`);
    const p = Number(mid?.midpoint);
    if (Number.isFinite(p)) return p;
  } catch {
    // fall back
  }

  const buyUrl = `${CLOB_BASE}/price?token_id=${encodeURIComponent(tokenId)}&side=buy`;
  const sellUrl = `${CLOB_BASE}/price?token_id=${encodeURIComponent(tokenId)}&side=sell`;

  const [buy, sell] = await Promise.all([fetchJson(buyUrl), fetchJson(sellUrl)]);
  const pb = Number(buy?.price);
  const ps = Number(sell?.price);

  if (!Number.isFinite(pb) || !Number.isFinite(ps)) {
    throw new Error("Could not read buy/sell price as numbers.");
  }

  return (pb + ps) / 2;
}

function updateTriggers(state, prob) {
  if (prob >= THRESHOLD_WARN) state.warnTriggered = false;
  if (prob >= THRESHOLD_CRIT) state.critTriggered = false;

  const shouldWarn = !state.warnTriggered && prob < THRESHOLD_WARN;
  const shouldCrit = !state.critTriggered && prob < THRESHOLD_CRIT;

  if (shouldWarn) state.warnTriggered = true;
  if (shouldCrit) state.critTriggered = true;

  return { shouldWarn, shouldCrit };
}

async function maybeSendDailyStatus(state, slug, marketLabel, prob) {
  if (!DAILY_STATUS_ENABLED) return false;

  const todayKey = utcDateKey(new Date());
  if (state.lastDailyStatusUtcDate === todayKey) return false;
  if (!isAfterDailyStatusTimeUTC(new Date())) return false;

  const lines = [
    `✅ Daily status (UTC ${String(DAILY_STATUS_UTC_HOUR).padStart(2, "0")}:${String(DAILY_STATUS_UTC_MINUTE).padStart(2, "0")}):`,
    `Tracking: ${OUTCOME_NAME}`,
    `Current: ${fmtPct(prob)}`,
    `Market: ${marketLabel || "(unknown)"}`,
    `Event: ${eventUrl(slug)}`,
  ];

  await sendTelegram(lines.join("\n"));

  state.lastDailyStatusUtcDate = todayKey;
  await saveState(state);
  return true;
}

async function mainLoop() {
  let state = await loadState();

  console.log(
    `[${nowIso()}] Starting. FORCE_EVENT_SLUG=${FORCE_EVENT_SLUG || "(none)"} OUTCOME_NAME=${OUTCOME_NAME} POLL_SECONDS=${POLL_SECONDS} LOOKAHEAD_DAYS=${LOOKAHEAD_DAYS} SLUG_SCAN_SECONDS=${SLUG_SCAN_SECONDS} DAILY_STATUS_ENABLED=${DAILY_STATUS_ENABLED} DAILY_STATUS_UTC=${DAILY_STATUS_UTC_HOUR}:${DAILY_STATUS_UTC_MINUTE}`
  );

  let nextSlugScanAt = 0;

  while (true) {
    try {
      let slug = state.trackedSlug;

      if (!slug || Date.now() >= nextSlugScanAt) {
        nextSlugScanAt = Date.now() + SLUG_SCAN_SECONDS * 1000;

        const found = await findWeeklySlugAuto();
        if (found) slug = found;

        if (!slug) {
          console.log(
            `[${nowIso()}] No weekly event found yet. Next scan in ${SLUG_SCAN_SECONDS}s.`
          );
          await sleep(POLL_SECONDS * 1000);
          continue;
        }
      }

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

      const marketLabel = String(market?.title || market?.question || "").slice(0, 180);
      console.log(`[${nowIso()}] Picked market: ${marketLabel}`);

      const { tokenId, label } = extractTokenId(market);

      const prob = await getProbability(tokenId);

      console.log(`[${nowIso()}] ${label} prob=${fmtPct(prob)} | slug=${state.trackedSlug}`);

      // Daily status message (once per day).
      await maybeSendDailyStatus(state, state.trackedSlug, marketLabel, prob);

      const { shouldWarn, shouldCrit } = updateTriggers(state, prob);
      await saveState(state);

      if (shouldWarn) {
        await sendTelegram(
          `⚠️ ${label} dropped below ${fmtPct(THRESHOLD_WARN)}: now ${fmtPct(prob)}\n${eventUrl(
            state.trackedSlug
          )}`
        );
      }
      if (shouldCrit) {
        await sendTelegram(
          `🚨 ${label} dropped below ${fmtPct(THRESHOLD_CRIT)}: now ${fmtPct(prob)}\n${eventUrl(
            state.trackedSlug
          )}`
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
