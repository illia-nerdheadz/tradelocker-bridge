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

  // Bubble
  BUBBLE_WEBHOOK_URL: process.env.BUBBLE_WEBHOOK_URL,
  // Example: https://yourapp.bubbleapps.io/version-test/api/1.1/wf/tradelocker-update
};

// ============ VALIDATION ============
if (!CONFIG.BRAND_API_KEY) {
  console.error("❌ BRAND_API_KEY is not set in environment variables");
  process.exit(1);
}
if (!CONFIG.BUBBLE_WEBHOOK_URL) {
  console.error("❌ BUBBLE_WEBHOOK_URL is not set in environment variables");
  process.exit(1);
}

// ============ SEND TO BUBBLE ============
async function sendToBubble(data) {
  try {
    const response = await fetch(CONFIG.BUBBLE_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      console.error(`❌ Bubble responded with ${response.status}: ${await response.text()}`);
    } else {
      console.log(`✅ Sent to Bubble: account=${data.accountId} balance=${data.balance} equity=${data.equity}`);
    }
  } catch (err) {
    console.error("❌ Error sending to Bubble:", err.message);
  }
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

  // AccountStatus — send balance & equity to Bubble
  if (data.type === "AccountStatus") {
    // DEBUG: log raw data for D#1860538
    if (data.accountId === "D#1860538") {
      console.log("🔍 RAW D#1860538:", JSON.stringify(data));
    }
    const payload = {
      accountId: data.accountId,
      balance: parseFloat(data.balance) || 0,
      equity: parseFloat(data.equity) || 0,
      marginUsed: parseFloat(data.marginUsed) || 0,
      synced: syncComplete,
    };

    console.log(`📊 AccountStatus: ${payload.accountId} | balance: ${payload.balance} | equity: ${payload.equity}`);
    sendToBubble(payload);
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
