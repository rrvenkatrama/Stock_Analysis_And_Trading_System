# Stock Analysis & Trading System

A sophisticated dual-dashboard swing trading research and execution platform built on Node.js, MySQL, and Alpaca broker API.

Two fully operational dashboards running on a home mini PC at **192.168.1.156**:

1. **Swing Trader** (port 3001) — Automated swing trading with human approval gates
2. **My Stocks** (port 8081) — Personal watchlist research, discovery universe, and live autotrading

---

## 🎯 Project Overview

**Goal:** Supplement income via disciplined systematic swing trading using signal-based analysis and risk-managed execution.

**Trading Capital:** $100K Alpaca paper account (testing before live deployment)

**Key Philosophy:** Human approves every trade. Never fully automated.

---

## 🚀 Quick Start

### Prerequisites
- Node.js 20+
- MySQL 8.4+
- Alpaca broker account (paper or live)
- API keys: Finnhub, Polygon, Alpha Vantage, Gmail (SMTP)

### Setup

```bash
# 1. Clone and install
git clone https://github.com/rrvenkatrama/Stock_Analysis_And_Trading_System.git
cd Stock_Analysis_And_Trading_System
npm install

# 2. Create .env file with API keys
cp .env.example .env
# Edit .env with your Alpaca, Finnhub, Polygon keys, etc.

# 3. Initialize database
mysql -u stocktrader -p stocktrader123 stocktrader < db/schema.sql
node db/setup.js

# 4. Start My Stocks dashboard (port 8081)
node server_portfolio.js

# 5. Start Swing Trader (port 3001)
node server.js
```

### Production Deployment

Runs as systemd user services on Ubuntu 25.10 at **192.168.1.156**:

```bash
# Deploy My Stocks
scp server_portfolio.js rajramani@192.168.1.156:~/stocktrader/
scp -r portfolio_app/* rajramani@192.168.1.156:~/stocktrader/portfolio_app/
ssh rajramani@192.168.1.156 "systemctl --user restart stocktrader_portfolio && sleep 3 && systemctl --user status stocktrader_portfolio --no-pager"

# Deploy Swing Trader
scp server.js rajramani@192.168.1.156:~/stocktrader/
ssh rajramani@192.168.1.156 "systemctl --user restart stocktrader && sleep 3 && systemctl --user status stocktrader --no-pager"
```

See [CLAUDE.md](CLAUDE.md) for complete deployment checklist and systemd service template.

---

## 📊 My Stocks Dashboard (Port 8081)

**Live watchlist research, discovery scanner, and autotrader execution.**

### Features

**5 Tabs:**
- **Portfolio** — Live Alpaca positions with per-position autotrader toggle
- **Stocks** — Personal watchlist (ONLY place to buy) with eligibility badges
- **Discover** — Universe scan for new BUY candidates (+ Watch → buy from Stocks)
- **Phoenix** — Deep value contrarian signals (+ Watch → buy from Stocks)
- **Long Haul** — Dividend payers 20%+ below 52wk high (display only)

**Signal-Count Scoring System:**
- Formula: `(positive_signals - negative_signals) / max(5, total_signals) × 100`
- Score ranges: **−100 to +100** (can be negative)
- Thresholds: **BUY >50% | HOLD 20–50% | SELL ≤20%**
- 30+ signals: MA crossovers, EMA swings, RSI, MACD, volume, valuation, fundamentals, analyst consensus, sentiment

**Autotrader Eligibility (5 Gates):**
1. **Market Regime** — BULL/BEAR/CAUTION/UNKNOWN
2. **Score > 50%** — Signal-count based threshold
3. **RSI (30–65)** — Neutral zone avoids overbought penalty
4. **Not Overextended** — ≤8% above 50DMA for good entry
5. **Tier 1 Confirmations** — ≥2 of 4: RSI window + MACD bullish + above 50MA + volume ≥1.3x

**Per-Position Autotrader Flags:**
- Alpha autotrader buy → sets `autotrader_on=1`
- Manual buy of new position → sets `autotrader_on=0` (hands-off)
- Manual buy of existing position → flag unchanged
- Autotrader exit/stop-loss only runs for flag=1 positions

**Scheduling:**
- **8:30 AM ET (Mon–Fri):** Full refresh (price history + fundamentals), analysis, Phoenix screener, universe scan, email digest
- **9:35 AM ET (Mon–Fri):** Alpha autotrader execution (buys + exits)

---

## 🤖 Swing Trader Dashboard (Port 3001)

**Automated swing trading with human approval gates.**

### Features

**Multi-Layer Scoring:**
- Technical (35%), Fundamental (25%), Institutional (20%), Sentiment (20%)
- VIX-adaptive thresholds: drops in fear markets (VIX ≥25)
- Weighted 0–100 scale with probability estimates

**Risk Guardrails:**
- Max 4 open positions, 10% per position, 5% stop loss
- 20% cash buffer always
- Max 4 trades/day
- No same-day close, no borrowing, market hours only

**Execution Flow:**
1. Scanner identifies candidates (48+ stocks)
2. Builds daily trading plan (BUY/HOLD/EXIT/SWAP)
3. User reviews and approves plan
4. Human clicks Approve → executes all orders
5. Email confirmation with fills

---

## 📁 Architecture

### Key Directories

```
db/                    → MySQL schema + helpers
config/                → Environment, params, runtime source switching
data/                  → Unified data provider (router to alpha, yahoo, finnhub, etc.)
analysis/              → Scoring engine, technical indicators (swing trader)
screener/              → Universe scanner, batch processing
trader/                → Portfolio planning, guardrails, order execution
portfolio_app/         → My Stocks scoring, autotrader, universe, scheduler
notifier/              → Email notifications (Gmail SMTP)
```

### Data Flow

```
Market Data (Alpaca/Yahoo)
        ↓
Fundamentals (Finnhub)
        ↓
Data Provider (router)
        ↓
Analysis Engine (scorer, technicals)
        ↓
Screener / Autotrader
        ↓
Risk Guardrails
        ↓
Order Execution (Alpaca API)
        ↓
Email Notification
```

### Database

**9 Swing Trader Tables:**
- `scan_sessions`, `candidates`, `trades`, `positions`, `daily_stats`, `news_cache`, `system_log`, `system_config`, `portfolio_plans`

**3 My Stocks Tables:**
- `watchlist` (113+ stocks with fundamentals)
- `price_history` (daily OHLCV)
- `stock_signals` (scored signals snapshot)

**Supporting:**
- `position_flags` — per-ticker autotrader toggle
- `analyst_upgrades` — weekly analyst grade changes

---

## ⚙️ Configuration

### Runtime Data Sources (No Restart Needed)

Switch sources via `/settings` or `config/sources.js`:

| Data Type | Current | Backup |
|-----------|---------|--------|
| Price Bars | Alpaca | Yahoo |
| Fundamentals | Finnhub | Yahoo |
| Market Context | Alpaca | Yahoo |
| VIX | VIXY proxy | Yahoo ^VIX |
| News | Finnhub | SEC EDGAR |
| Sentiment | StockTwits | Alpha Vantage |

### Scoring Parameters

Edit via `/settings` or `config/params.js`:
- Base thresholds (55 swing trader, >50% My Stocks)
- Position sizing (10% max, 50% deploy)
- Risk limits (5% stop loss, 4 max positions)
- Time stops (30 days for autotrader)

---

## 📋 Requirements Met

### Core Features ✓
- ✓ Signal-count scoring (30+ signals, binary ±1 contribution)
- ✓ VIX-adaptive thresholds (drops in fear markets)
- ✓ Autotrader per-position flags (manual vs. auto-managed)
- ✓ Phoenix strategy (screener display-only, no buying)
- ✓ 5 eligibility gates with pass/fail indicators
- ✓ RSI thresholds (neutral zone 45–65, overbought ≥65)
- ✓ Buy discipline (Stocks tab only)
- ✓ Watchlist protection (can't remove if in portfolio)
- ✓ Golden cross stars (⭐ pulsing, ★ active, ☆ none)
- ✓ Long Haul dividend filter (20%+ below 52wk high)
- ✓ Market regime gates (BULL/BEAR/CAUTION/UNKNOWN)
- ✓ Human approval on every trade

### Data Quality ✓
- ✓ Alpaca price data (fast, no rate limits)
- ✓ Finnhub fundamentals (primary, reliable)
- ✓ Yahoo enrichment (analyst consensus, price targets)
- ✓ StockTwits sentiment
- ✓ SEC 13F institutional holdings
- ✓ Rate-limit handling (Yahoo 10–15 req buffer)

---

## 🐛 Known Issues

1. **Finnhub price targets** — 403 (paid feature), gracefully skipped
2. **VIXY proxy for VIX** — Approximate (VIXY × 1.8 + 2 ≈ VIX)
3. **Yahoo rate-limits** — Clears after 30–60 min of no requests
4. **Analyst ratings** — Populate weekly, empty until first refresh
5. **Buyback % always null** — Finnhub free tier limitation
6. **RSI signal display** — Only shows outside neutral zone (45–65)

---

## 📈 Performance

**Full My Stocks Refresh:** 5–6 min (122 symbols)
- Price history: ~15s (Alpaca, parallel batches)
- Fundamentals: ~4 min (Finnhub serial + Yahoo enrichment)
- Analysis: ~30s (scoring + signal aggregation)
- Email: ~5s (Gmail SMTP)

**Swing Trader Scan:** 2–3 min (48+ symbols)
- Data fetch: ~30s (parallel providers)
- Analysis: ~1 min (weighted scoring)
- Plan generation: ~30s (BUY/HOLD/EXIT/SWAP logic)

---

## 📚 Documentation

- **[CLAUDE.md](CLAUDE.md)** — Complete system instructions, API keys, service setup
- **[CONTEXT.md](CONTEXT.md)** — Architecture, data stack, tier explanations
- **[plan.txt](plan.txt)** — Current status, next steps, deployment checklist
- **[stock_trader_v1.html](stock_trader_v1.html)** — Full system documentation (open in browser)

---

## 🔐 Security

- Paper mode default (ALPACA_BASE_URL points to paper URL)
- API keys in `.env` (never committed)
- Guard against SQL injection (parameterized queries)
- XSS protection (HTML entity encoding)
- Session-based trading (human approval gates)
- No JavaScript for critical actions (Approve/Reject are plain links)

---

## 📞 Support

**Issues / Questions:**
- Check [CLAUDE.md](CLAUDE.md) for deployment troubleshooting
- Review [plan.txt](plan.txt) for current known issues
- See [stock_trader_v1.html](stock_trader_v1.html) for detailed strategy explanations

**Development:**
- Node.js 20, MySQL 8.4
- Run tests: `npm test`
- Deploy: `scp` + `systemctl restart`

---

## 📄 License

Private project. All rights reserved.

---

**Last Updated:** 2026-04-20 (Session 7)
**Status:** Production Ready ✓
**Mode:** Paper Trading (Paper account $100K)
