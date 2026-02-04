import http from "http";
import fs from "fs/promises";

const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TELEGRAM_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "").trim();

if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing env var: TELEGRAM_BOT_TOKEN");
if (!TELEGRAM_CHAT_ID) throw new Error("Missing env var: TELEGRAM_CHAT_ID");

const SLUG_PREFIX = String(
  process.env.SLUG_PREFIX || "1-free-app-in-the-us-apple-app-store-on-"
).trim();

const FORCE_EVENT_SLUG = String(process.env.FORCE_EVENT_SLUG || "").trim();

const POLL_SECONDS = Number(process.env.POLL_SECONDS || 60);
const THRESHOLD_WARN = Number(process.env.THRESHOLD_WARN || 0.9);
const THRESHOLD_CRIT = Number(process.env.THRESHOLD_CRIT || 0.5);
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
    throw new Error(
      `HTTP ${res.status} ${res.statusText} for ${url} :: ${text.slice(0, 300)}`
    );
  }
  return await res.json();
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const st = JSON.parse(raw);
    return {
      trackedSlug: st.trackedSlug || null,
      lastProb: typeof st.lastProb === "number" ? st.lastProb : null,
      warnTriggered: Boolean(st.warnTriggered),
      critTriggered: Boolean(st.critTriggered),
      updatedAt: st.updatedAt || null,
    };
  } catch {
    return {
      trackedSlug: null,
      lastProb: null,
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
  const url = `https://api.telegram.org/bot${encodeURIComponent(
    TELEGRAM_BOT_TOKEN
  )}/sendMessage`;

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
    throw new Error(
      `Telegram sendMessage failed: HTTP ${res.status} :: ${body.slice(0, 300)}`
    );
  }
}

async function findCurrentWeeklyEventSlug() {
  if (FORCE_EVENT_SLUG) return FORCE_EVENT_SLUG;

  const url = `${GAMMA_BASE}/events?limit=200&offset=0`;
  const events = await fetchJson(url);

  const matches = (Array.isArray(events) ? events : []).filter(
    (e) => e && typeof e.slug === "string" && e.slug.startsWith(SLUG_PREFIX)
  );

  if (matches.length === 0) return null;

  const now = Date.now();

  function parseTimeMs(x) {
    if (!x) return null;
    const ms = Date.parse(x);
    return Number.isFinite(ms) ? ms : null;
  }

  const scored = matches.map((e) => {
    const endCandidates = [
      e.endDate,
      e.end_date,
      e.endTime,
      e.end_time,
      e.closeTime,
      e.close_time,
      e.resolutionTime,
      e.resolution_time,
    ];
    const endMs = endCandidates.map(parseTimeMs).find((v) => v !== null) ?? null;

    let score = 9e18;
    if (endMs !== null) {
      if (endMs >= now) score = endMs;
      else score = endMs + 1e15;
    }
    return { slug: e.slug, score, endMs };
  });

  scored.sort((a, b) => a.score - b.score);
  return scored[0].slug;
}

async function getEventBySlug(slug) {
  const url = `${GAMMA_BASE}/events/slug/${encodeURIComponent(slug)}`;
  return await fetchJson(url);
}

function extractYesTokenId(eventObj) {
  const markets = eventObj?.markets;
  if (!Array.isArray(markets) || markets.length === 0) {
    throw new Error("No markets found in event response.");
  }

  const m = markets[0];

  let outcomes = m.outcomes;
  let tokenIds = m.clobTokenIds;

  if (typeof outcomes === "string") outcomes = JSON.parse(outcomes);
  if (typeof tokenIds === "string") tokenIds = JSON.parse(tokenIds);

  const yesIndex = outcomes.findIndex((o) => String(o).toLowerCase() === "yes");
  return String(tokenIds[yesIndex]);
}

async function getYesProbability(tokenId) {
  try {
    const midUrl = `${CLOB_BASE}/midpoint?token_id=${encodeURIComponent(tokenId)}`;
    const mid = await fetchJson(midUrl);
    const p = Number(mid?.midpoint);
    if (Number.isFinite(p)) return p;
  } catch {}

  const buyUrl = `${CLOB_BASE}/price?token_id=${encodeURIComponent(tokenId)}&side=BUY`;
  const sellUrl = `${CLOB_BASE}/price?token_id=${encodeURIComponent(tokenId)}&side=SELL`;

  const [buy, sell] = await Promise.all([fetchJson(buyUrl), fetchJson(sellUrl)]);
  return (Number(buy.price) + Number(sell.price)) / 2;
}

function fmtPct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

function makeEventUrl(slug) {
  return `https://polymarket.com/event/${slug}`;
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

async function mainLoop() {
  let state = await loadState();

  console.log(`[${nowIso()}] Starting monitor. SLUG_PREFIX=${SLUG_PREFIX}`);

  while (true) {
    try {
      const currentSlug = await findCurrentWeeklyEventSlug();

      if (!currentSlug) {
        console.log(`[${nowIso()}] No matching event found. Will retry.`);
        await sleep(POLL_SECONDS * 1000);
        continue;
      }

      if (state.trackedSlug !== currentSlug) {
        state.trackedSlug = currentSlug;
        state.warnTriggered = false;
        state.critTriggered = false;
        await saveState(state);

        await sendTelegram(
          `Tracking weekly event:\n${makeEventUrl(currentSlug)}`
        );
      }

      const ev = await getEventBySlug(state.trackedSlug);
      const yesTokenId = extractYesTokenId(ev);
      const prob = await getYesProbability(yesTokenId);

      const { shouldWarn, shouldCrit } = updateTriggers(state, prob);
      await saveState(state);

      console.log(`[${nowIso()}] prob=${fmtPct(prob)}`);

      if (shouldWarn) {
        await sendTelegram(`⚠️ Dropped below ${fmtPct(THRESHOLD_WARN)}: ${fmtPct(prob)}`);
      }
      if (shouldCrit) {
        await sendTelegram(`🚨 Dropped below ${fmtPct(THRESHOLD_CRIT)}: ${fmtPct(prob)}`);
      }
    } catch (err) {
      console.error(`[${nowIso()}] Error:`, err.message);
    }

    await sleep(POLL_SECONDS * 1000);
  }
}

http.createServer((req, res) => {
  res.writeHead(200);
  res.end("running");
}).listen(PORT);

mainLoop();
