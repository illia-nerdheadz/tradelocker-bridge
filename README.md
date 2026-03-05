# TradeLocker → Bubble Bridge

> Real-time WebSocket bridge that streams TradeLocker account data into a Bubble database — live equity tracking, drawdown calculations, and P&L metrics, all computed on the fly.

![Node.js](https://img.shields.io/badge/Node.js-≥18-339933?style=flat-square&logo=node.js&logoColor=white)
![Socket.IO](https://img.shields.io/badge/Socket.IO-4.x-010101?style=flat-square&logo=socket.io&logoColor=white)
![Railway](https://img.shields.io/badge/Deploy-Railway-0B0D0E?style=flat-square&logo=railway&logoColor=white)

---

## What it does

Connects to the **TradeLocker Brand WebSocket API** and listens for real-time `AccountStatus` events. For each active trading account, it:

1. Fetches the linked `UserChallengeLevel` and `TradeLockerAccount` records from Bubble
2. Computes 18 live trading metrics (DDD, TDD, equity, drawdown %, profit %, etc.)
3. PATCHes the results back into Bubble — continuously, on every tick

---

## Architecture

```
TradeLocker WSS API
        │
        │  AccountStatus events (real-time)
        ▼
 ┌─────────────────┐
 │  bridge (Node)  │  ← this repo
 │                 │
 │  in-memory      │  lazy-loaded account cache
 │  account store  │
 └────────┬────────┘
          │  Bubble Data API (GET + PATCH)
          ▼
    Bubble Database
    ┌─────────────────────┐
    │  UserChallengeLevel │  ← metrics written here
    │  TradeLockerAccount │  ← equity_rollover source
    └─────────────────────┘
```

---

## Metrics computed

| Field | Description |
|---|---|
| `Current Balance` | Live account balance |
| `Equity` | Current equity |
| `Closed Profit` | Balance minus start balance |
| `Open Profit` | Margin in use |
| `DDD` | Daily drawdown (equity vs rollover) |
| `TDD` | Total drawdown (equity vs start) |
| `Max DDD / Max TDD` | Historical peak drawdowns |
| `DDD% / TDD%` | Drawdown as % of allowed limit |
| `MaxDDD% / MaxTDD%` | Peak drawdown percentages |
| `profit%` | Closed profit as % of start balance |
| `Losses` | Balance deficit from start |
| `Costs / Revenue` | P&L components |
| `Revenue-Costs` | Net P&L |
| `Max Balance` | Highest balance reached |
| `All trades closed` | Boolean — no open positions |
| `First open trade date` | Timestamp of first trade |

---

## Setup

### 1. Clone & install

```bash
git clone https://github.com/illia-nerdheadz/tradelocker-bridge.git
cd tradelocker-bridge
npm install
```

### 2. Configure environment

Copy `.env.example` and fill in your values:

```bash
cp .env.example .env
```

```env
# TradeLocker Brand API key
BRAND_API_KEY=your_brand_api_key

# Bubble Data API
BUBBLE_API_TOKEN=your_bubble_api_token
BUBBLE_DATA_API_URL=https://your-app.bubbleapps.io/version-xxx/api/1.1/obj

# Set automatically by Railway
PORT=3000
```

### 3. Run

```bash
npm start
```

---

## Deploy to Railway

1. Push to GitHub (already done)
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
3. Select `tradelocker-bridge`
4. Add environment variables in **Variables** tab:
   - `BRAND_API_KEY`
   - `BUBBLE_API_TOKEN`
   - `BUBBLE_DATA_API_URL`
5. Deploy — Railway auto-restarts on every `git push`

The bridge includes a lightweight HTTP server (`GET /` → `200 ok`) to satisfy Railway's health check and keep the process alive.

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `BRAND_API_KEY` | ✅ | TradeLocker Brand API key |
| `BUBBLE_API_TOKEN` | ✅ | Bubble Data API token |
| `BUBBLE_DATA_API_URL` | ✅ | Base URL for Bubble Data API objects |
| `PORT` | — | HTTP port (default: `3000`, set by Railway) |

---

## Tech stack

- **[Socket.IO Client](https://socket.io/docs/v4/client-api/)** — WebSocket connection to TradeLocker
- **[dotenv](https://github.com/motdotla/dotenv)** — environment config
- **Node.js `fetch`** — Bubble Data API calls (built-in, Node ≥18)
- **Node.js `http`** — keep-alive server for Railway
