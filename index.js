require("dotenv").config();
const { io } = require("socket.io-client");

// ============ CONFIGURATION ============
const CONFIG = {
  // TradeLocker
  SERVER_URL: "wss://api.tradelocker.com",
  NAMESPACE: "/brand-socket",
  HANDSHAKE_PATH: "/brand-api/socket.io",
  TYPE: "DEMO",
  BRAND_API_KEY: process.env.BRAND_API_KEY,

  // Bubble Data API
  BUBBLE_API_TOKEN: process.env.BUBBLE_API_TOKEN,
  BUBBLE_DATA_API_URL: process.env.BUBBLE_DATA_API_URL,
};

// ============ VALIDATION ============
if (!CONFIG.BRAND_API_KEY) {
  console.error("❌ BRAND_API_KEY is not set in environment variables");
  process.exit(1);
}
if (!CONFIG.BUBBLE_API_TOKEN || !CONFIG.BUBBLE_DATA_API_URL) {
  console.error("❌ BUBBLE_API_TOKEN or BUBBLE_DATA_API_URL is not set");
  process.exit(1);
}

// ============ IN-MEMORY ACCOUNT STORE ============
const accountStore = new Map(); // tradelocker_acc_id → { bubbleId, fields... } or null

// ============ DAILY RESET TRACKING ============
const RESET_TIMEZONE = process.env.RESET_TIMEZONE || "Europe/Kyiv";

function getTzDateTime(timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: parseInt(get("hour")),
    minute: parseInt(get("minute")),
  };
}

// Initialize: if already past 00:20 today, mark today as reset so we don't double-reset on startup
const _initTz = getTzDateTime(RESET_TIMEZONE);
let lastResetDate =
  _initTz.hour > 0 || _initTz.minute >= 20 ? _initTz.date : null;
console.log(`📅 Daily reset timezone: ${RESET_TIMEZONE} | lastResetDate: ${lastResetDate}`);

async function checkAndPerformDailyReset() {
  const { date, hour, minute } = getTzDateTime(RESET_TIMEZONE);
  // Trigger at 00:20 or later, once per day
  if ((hour > 0 || minute >= 20) && lastResetDate !== date) {
    lastResetDate = date;
    console.log(`🔄 Daily rollover reset triggered for ${date}`);
    for (const [accId, entry] of accountStore.entries()) {
      if (!entry) continue;
      try {
        // Re-fetch equity_rollover from Bubble
        const tlaResults = await bubbleGet("TradeLockerAccount", [
          { key: "acc_id", constraint_type: "equals", value: accId },
        ]);
        const tla = tlaResults && tlaResults.length > 0 ? tlaResults[0] : null;
        if (tla && tla.status === "ACTIVE") {
          entry.equityRollover = parseFloat(tla.equity_rollover) || 0;
        }
        // Reset daily DDD fields
        entry.DDD = 0;
        entry.MaxDDD = 0;
        entry["DDD%"] = 0;
        entry["MaxDDD%"] = 0;
        console.log(`  ✅ ${accId}: equityRollover=${entry.equityRollover}, DDD fields reset`);
      } catch (err) {
        console.error(`  ❌ Daily reset failed for ${accId}:`, err.message);
      }
    }
    console.log("✅ Daily reset complete");
  }
}

// ============ BUBBLE DATA API HELPERS ============
async function bubbleGet(table, constraints) {
  const params = new URLSearchParams({
    api_token: CONFIG.BUBBLE_API_TOKEN,
    constraints: JSON.stringify(constraints),
  });
  const url = `${CONFIG.BUBBLE_DATA_API_URL}/${table}?${params}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Bubble GET ${table} failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  return json.response.results;
}

async function bubblePatch(table, id, body) {
  const url = `${CONFIG.BUBBLE_DATA_API_URL}/${table}/${id}?api_token=${CONFIG.BUBBLE_API_TOKEN}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Bubble PATCH ${table}/${id} failed: ${res.status} ${await res.text()}`);
  }
}

// ============ FETCH ACCOUNT DATA (LAZY) ============
async function fetchAccountData(accId) {
  // Already cached (either data or null)
  if (accountStore.has(accId)) return accountStore.get(accId);

  try {
    // 1. Fetch UserChallengeLevel
    const uclResults = await bubbleGet("UserChallengeLevel", [
      { key: "tradelocker_acc_id", constraint_type: "equals", value: accId },
    ]);

    if (!uclResults || uclResults.length === 0) {
      console.log(`⚠️ No UCL found for ${accId} — skipping`);
      accountStore.set(accId, null);
      return null;
    }

    const ucl = uclResults[0];

    // 2. Fetch TradeLockerAccount for equity_rollover
    const tlaResults = await bubbleGet("TradeLockerAccount", [
      { key: "acc_id", constraint_type: "equals", value: accId },
    ]);

    const tla = tlaResults && tlaResults.length > 0 ? tlaResults[0] : null;

    if (!tla || tla.status !== "ACTIVE") {
      console.log(`⚠️ TLA for ${accId} not found or not ACTIVE — skipping`);
      accountStore.set(accId, null);
      return null;
    }

    const entry = {
      bubbleId: ucl._id,
      equityRollover: parseFloat(tla.equity_rollover) || 0,
      // UCL fields from Bubble
      StartBalance: parseFloat(ucl["Start Balance"]) || 0,
      minDailyDrawdown: parseFloat(ucl["min_daily_drawdown"]) || 0,
      minTotalDrawdown: parseFloat(ucl["min_total_drawdown"]) || 0,
      // Computed fields (initialize from Bubble or 0)
      ClosedProfit: parseFloat(ucl["Closed Profit"]) || 0,
      CurrentBalance: parseFloat(ucl["Current Balance"]) || 0,
      DDD: parseFloat(ucl["DDD"]) || 0,
      TDD: parseFloat(ucl["TDD"]) || 0,
      Equity: parseFloat(ucl["Equity"]) || 0,
      Losses: parseFloat(ucl["Losses"]) || 0,
      OpenProfit: parseFloat(ucl["Open Profit"]) || 0,
      MaxBalance: parseFloat(ucl["Max Balance"]) || 0,
      Costs: parseFloat(ucl["Costs"]) || 0,
      Revenue: parseFloat(ucl["Revenue"]) || 0,
      "Revenue-Costs": parseFloat(ucl["Revenue-Costs"]) || 0,
      MaxDDD: parseFloat(ucl["Max DDD"]) || 0,
      MaxTDD: parseFloat(ucl["Max TDD"]) || 0,
      "DDD%": parseFloat(ucl["DDD %"]) || 0,
      "TDD%": parseFloat(ucl["TDD %"]) || 0,
      "profit%": parseFloat(ucl["profit %"]) || 0,
      "MaxDDD%": parseFloat(ucl["Max DDD%"]) || 0,
      "MaxTDD%": parseFloat(ucl["Max TDD%"]) || 0,
      AllTradesClosed: false,
      FirstOpenTradeDate: ucl["First open trade date"] || null,
    };

    accountStore.set(accId, entry);
    console.log(`📥 Loaded UCL for ${accId} (bubble id: ${entry.bubbleId}, StartBalance: ${entry.StartBalance})`);
    return entry;
  } catch (err) {
    console.error(`❌ Error fetching data for ${accId}:`, err.message);
    // Don't cache on error — retry next time
    return undefined;
  }
}

// ============ COMPUTE FIELDS ============
function computeFields(accId, wsData) {
  const entry = accountStore.get(accId);
  if (!entry) return null;

  const balance = wsData.balance;
  const equity = wsData.equity;
  const marginUsed = wsData.marginUsed;
  const S = entry.StartBalance;

  // --- Stage 1 ---
  entry.ClosedProfit = balance > 0 ? balance - S : entry.ClosedProfit;
  entry.CurrentBalance = balance > 0 ? balance : entry.CurrentBalance;
  entry.DDD = Math.max(0, entry.equityRollover - equity);
  entry.TDD = Math.max(0, S - equity);
  entry.Equity = equity;
  entry.Losses = Math.max(0, S - entry.CurrentBalance);
  entry.OpenProfit = marginUsed;
  entry.AllTradesClosed = marginUsed === 0;
  entry.MaxBalance = Math.max(balance, entry.MaxBalance);
  entry.Costs = entry.CurrentBalance - S;

  const equityMinusStart = equity - S;
  if (equityMinusStart > entry.TDD) {
    entry.Revenue = S * (1 - equity / equityMinusStart);
  } else {
    entry.Revenue = S * (entry["TDD%"] || 0);
  }
  entry["Revenue-Costs"] = entry.Revenue - entry.Costs;

  // --- Stage 2 ---
  entry.MaxDDD = Math.max(entry.DDD, entry.MaxDDD);
  entry.MaxTDD = Math.max(entry.TDD, entry.MaxTDD);

  const dailyDenom = entry.minDailyDrawdown * S;
  entry["DDD%"] = dailyDenom > 0 ? entry.DDD / dailyDenom : 0;

  const totalDenom = entry.minTotalDrawdown * S;
  entry["TDD%"] = totalDenom > 0 ? entry.TDD / totalDenom : 0;

  entry["profit%"] = Math.max(0, entry.ClosedProfit / S);

  // --- Stage 3 ---
  entry["MaxDDD%"] = Math.max(entry["DDD%"], entry["MaxDDD%"]);
  entry["MaxTDD%"] = Math.max(entry["TDD%"], entry["MaxTDD%"]);

  return entry;
}

// ============ UPDATE BUBBLE ============
async function updateBubble(accId) {
  const entry = accountStore.get(accId);
  if (!entry) return;

  const body = {
    "Closed Profit": entry.ClosedProfit,
    "Current Balance": entry.CurrentBalance,
    "DDD": entry.DDD,
    "TDD": entry.TDD,
    "Equity": entry.Equity,
    "Losses": entry.Losses,
    "Open Profit": entry.OpenProfit,
    "Max Balance": entry.MaxBalance,
    "Costs": entry.Costs,
    "Revenue": entry.Revenue,
    "Revenue-Costs": entry["Revenue-Costs"],
    "Max DDD": entry.MaxDDD,
    "Max TDD": entry.MaxTDD,
    "DDD %": entry["DDD%"],
    "TDD %": entry["TDD%"],
    "profit %": entry["profit%"],
    "Max DDD%": entry["MaxDDD%"],
    "Max TDD%": entry["MaxTDD%"],
    "All trades closed": entry.AllTradesClosed,
  };

  // Set First open trade date if not yet set
  if (!entry.FirstOpenTradeDate) {
    const now = new Date().toISOString();
    body["First open trade date"] = now;
    entry.FirstOpenTradeDate = now; // mark in cache so we don't set it again
  }

  try {
    await bubblePatch("UserChallengeLevel", entry.bubbleId, body);
    console.log(`✅ PATCH UCL for ${accId} | equity=${entry.Equity} balance=${entry.CurrentBalance}`);
  } catch (err) {
    console.error(`❌ PATCH failed for ${accId}:`, err.message);
  }
}

// ============ PROCESS ACCOUNT STATUS ============
async function processAccountStatus(wsData) {
  const accId = wsData.accountId;
  const equity = wsData.equity;

  // Skip if equity is 0
  if (equity === 0) return;

  // Check if daily reset is needed (runs at 00:20 in RESET_TIMEZONE)
  await checkAndPerformDailyReset();

  // Fetch from Bubble if not cached
  const entry = await fetchAccountData(accId);

  // Skip if UCL not found or fetch failed
  if (!entry) return;

  // Compute and update
  computeFields(accId, wsData);
  await updateBubble(accId);
}

// ============ SOCKET CONNECTION ============
let syncComplete = false;

const socket = io(CONFIG.SERVER_URL + CONFIG.NAMESPACE, {
  path: CONFIG.HANDSHAKE_PATH,
  transports: ["websocket"],
  query: { type: CONFIG.TYPE },
  extraHeaders: { "brand-api-key": CONFIG.BRAND_API_KEY },
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 3000,
  reconnectionDelayMax: 30000,
});

// ============ EVENT HANDLERS ============
socket.on("connect", () => {
  console.log(`🟢 Connected to TradeLocker (${CONFIG.TYPE})`);
  console.log(`   Socket ID: ${socket.id}`);
  syncComplete = false;
});

socket.on("stream", (data) => {
  // SyncEnd — initial sync is complete
  if (data.type === "Property" && data.name === "SyncEnd") {
    syncComplete = true;
    console.log("🔄 Initial sync complete — now receiving real-time updates");
    return;
  }

  // AccountStatus — compute UCL fields and send to Bubble
  if (data.type === "AccountStatus") {
    const wsData = {
      accountId: data.accountId,
      balance: parseFloat(data.balance) || 0,
      equity: parseFloat(data.equity) || 0,
      marginUsed: parseFloat(data.marginUsed) || 0,
      synced: syncComplete,
    };

    console.log(`📊 AccountStatus: ${wsData.accountId} | balance: ${wsData.balance} | equity: ${wsData.equity}`);
    processAccountStatus(wsData);
  }
});

socket.on("connection", (data) => {
  if (data.status === "error") {
    console.error(`🔴 Connection error [${data.code}]: ${data.message}`);
  } else {
    console.log(`🔵 Connection status [${data.code}]: ${data.message}`);
  }
});

socket.on("disconnect", (reason) => {
  console.log(`🟡 Disconnected: ${reason}`);
});

socket.on("connect_error", (error) => {
  console.error(`🔴 Connection error: ${error.message}`);
});

// ============ GRACEFUL SHUTDOWN ============
process.on("SIGINT", () => {
  console.log("\n⏹️  Shutting down...");
  socket.disconnect();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n⏹️  Shutting down...");
  socket.disconnect();
  process.exit(0);
});

console.log("🚀 TradeLocker → Bubble bridge starting...");
console.log(`   Server: ${CONFIG.SERVER_URL}`);
console.log(`   Type: ${CONFIG.TYPE}`);

// ============ HTTP SERVER (Railway keep-alive) ============
const http = require("http");
http.createServer((_, res) => res.end("ok")).listen(process.env.PORT || 3000);
