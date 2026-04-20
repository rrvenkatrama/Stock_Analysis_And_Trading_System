# StockTrader — Project Context

## What We Are Building

Two dashboards running on a home mini PC (192.168.1.156):

1. **Swing Trader** (port 3001) — Scans 48+ stocks twice daily, scores and ranks candidates using multiple signal layers, builds a complete portfolio plan (BUY / HOLD / EXIT / SWAP) for human approval. **Human approves every plan. Not a fully automated bot.**

2. **My Stocks** (port 8081) — Personal watchlist research + discovery dashboard. 113+ stocks, 30+ signal scoring engine, 204-stock discovery universe, live Alpaca positions, and a 3-tier auto-trading engine that executes at 9:35 AM ET when enabled.

---

## Problem Statement

- User lost capital during the "SaaSpocalypse" AI market disruption
- Goal: supplement income via disciplined systematic swing trading
- Trading capital: $100K Alpaca paper account (testing before going live)
- Live capital will be separate when ready

---

## Swing Trader — Trading Strategy

**Swing Trading — hold 3–10 days per position**

- Alpaca **margin account** for instant settlement (never borrow — zero margin interest)
- No PDT issues — never close same day as open
- Stop loss on every position, placed automatically after buy fills

### Risk Parameters
| Parameter | Value |
|-----------|-------|
| Account size | $100K (paper) |
| Max position | 10% ($10,000) |
| Stop loss | 5% below entry (auto-placed) |
| Max open positions | 4 |
| Max new trades/day | 4 |
| Cash buffer | 20% always |
| Deploy per plan | 50% of buying power |
| Base score threshold | 55 (VIX-adaptive — drops in fear markets) |
| Base probability threshold | 55% |

---

## Data Stack

| Data Type | Current Source | Backup |
|-----------|---------------|--------|
| Price bars | Alpaca Market Data | Yahoo Finance |
| Fundamentals | Finnhub | Yahoo Finance |
| Market context (SPY/QQQ) | Alpaca | Yahoo |
| VIX | VIXY proxy (Alpaca) | Yahoo ^VIX |
| News | Finnhub + SEC EDGAR | — |
| Retail sentiment | StockTwits | Alpha Vantage |
| Institutional | SEC 13F + Dataroma + Finviz | — |

**Runtime switching:** Change source without restart via `/settings` dashboard or `config/sources.js`. Source stored in MySQL system_config table.

---

## Swing Trader Scoring System

Composite score 0–100 + probability estimate 35–85%. **Baseline = 50 (neutral).**

### Weights
| Category | Weight |
|----------|--------|
| Technical | 35% |
| Fundamental | 25% |
| Institutional | 20% |
| Sentiment | 20% |
| Market context | Point adjustment after weighting (±20 pts max) |

### VIX-Adaptive Thresholds
| VIX | Threshold Reduction | Effective Threshold |
|-----|---------------------|---------------------|
| < 25 | 0 pts | 55 |
| 25–29 | −6 pts | 49 |
| 30–39 | −12 pts | 43 |
| ≥ 40 | −20 pts | 35 |

---

## My Stocks Scoring System (portfolio_app/analyzer.js)

**Signal-count based formula (Session 7):** Score = (positive_signals − negative_signals) / max(5, total_signals) × 100

Score ranges **−100 to +100** (can be negative). **BUY >50% | HOLD 20–50% | SELL ≤20%**

30+ signals across: MA crossovers (50/200 SMA), EMA 9/21 short-term swing timing, volume confirmation, RSI (14-period), MACD (12/26/9), sector-relative valuation (PE/PS/PEG), fundamental quality (EPS/revenue/ROE/D-E), dividend income, analyst consensus (Finnhub counts + Yahoo recommendationMean), short interest squeeze, market context (SPY above/below 200MA).

**Each signal counts as ±1,** not weighted points. RSI thresholds (Session 7):
- RSI < 30 or 30–45 → +1 signal
- RSI 45–65 → neutral (no signal)
- RSI ≥ 65 → −1 signal

**Autotrader behavior with manual buys:** When user buys manually while autotrader is ON, the position is immediately executed. At next 9:35 AM run, autotrader evaluates ALL Alpaca positions — including manual buys — and will hard-stop (−8%) or soft-exit (50%) based on signal data. The 30-day time stop does NOT apply to manual positions (getDaysHeld() only reads autotrader_trades, returns null for manual).

**Why high-score stocks may be skipped:**
1. Signal data used = 8:30 AM snapshot; dashboard may show different scores if manually refreshed later
2. Tier 2 blocks stocks >8% extended above 50MA (e.g. TWLO at 12% above)
3. Tier 1 RSI window is 30–65, not just ≤65 (neutral zone 45–65 has no contribution)
4. Portfolio slots fill (sorted by score DESC, stops when maxPositions reached)

---

## My Stocks — 3-Tier Auto-Trading Engine

`portfolio_app/autotrader.js` — executes automatically at 9:35 AM ET when autorun is ON.

**Tier 3 (Market Regime):** SPY above_200ma from stock_signals — outermost gate, no new buys in bear market.

**Tier 2 (Quality Filter):** score >50%, price ≥$5, RSI ≤65, not >8% extended above 50MA, watchlist-only.

**Tier 1 (Entry Gate):** ≥2 technical confirmations (RSI 30–65 window, MACD bullish, above 50MA, volume ≥1.3x), no earnings within 5d, open portfolio slot available.

**Exit Rules:**
- Hard stop 100% sell: price ≤ entry − 8%
- Soft exit 50% sell: score <25 | RSI >75 | EMA 9 crossed below EMA 21 ≤3d ago | MACD bearish | held ≥30d with no gain

**Position Sizing:**
- cashBuffer = equity × 0.20
- deployable = max(0, (buyingPower − cashBuffer) × 0.50)
- maxPerPos = equity × 0.10
- shares = floor(min(deployable/openSlots, maxPerPos) / price)

**Schedule:**
- 8:30 AM ET: evaluate(false) → recommendations in daily digest email, no orders
- 9:35 AM ET: autoRun() → live execution when autorun_enabled = '1' in system_config

---

## Architecture

```
[Swing Trader — port 3001]
  scheduler/cron.js
    8:50 AM  → Pre-market scan → build plan → email approval request
    12:00 PM → Midday scan → rebuild plan if needed
    Every 5m → Position price sync (market hours only)
    4:15 PM  → EOD summary email

  screener/scan.js → data/provider.js → analysis/technicals.js → analysis/scorer.js → MySQL

  Approval flow (plain <a href> links — no JS):
    GET /plan/:id/approve-now → guardrails.js → executor.js → email confirmation

[My Stocks — port 8081]
  portfolio_app/scheduler.js
    8:30 AM ET Mon–Fri:
      Phase 1: Alpaca price history (parallel batches of 5)
      Phase 2: Finnhub + Yahoo fundamentals (serial, 2000ms/symbol, 3 Finnhub calls in parallel)
      Phase 3: analyzeAll() — score all 113+ watchlist symbols
      Phase 4: scanUniverse() — score 204-stock discovery universe
      Phase 4.5: autoEvaluate(false) → autotrader recommendations for email
      Phase 5: sendDailyDigest(signals, positions, picks, autoResults)
    9:35 AM ET Mon–Fri:
      autoRun() → live execution when autorun_enabled='1'

  server_portfolio.js (Express):
    /            → My Stocks dashboard (watchlist + positions + discover)
    /scan-now    → manual refresh trigger
    /scan-universe → manual universe scan
    /autorun/toggle → flip autorun_enabled in system_config
    /autorun/status → JSON status
    /news/:symbol   → Finnhub + SEC EDGAR news (cached)
    /docs/scoring   → scoring methodology HTML
    /buy, /sell, /cancel-order → Alpaca order execution
    /position-chart → position performance chart data (with 50d/200d MA server-side)
```

---

## User Workflows

### Swing Trader
1. **8:50 AM ET** — System scans 48 stocks, emails portfolio plan
2. **Open dashboard** at `http://192.168.1.156:3001/dashboard`
3. **Review plan** — BUY/HOLD/EXIT recommendations with scores, signals, levels
4. **Click Approve Plan** (or email link) after 9:35 AM ET
5. Orders placed → stop losses set automatically
6. Monitor via dashboard — 5-min P&L sync during market hours
7. **4:15 PM ET** — EOD summary email

### My Stocks (Autorun ON)
1. **8:30 AM ET** — Refresh fires: price history + fundamentals + analysis + universe scan
2. **Email arrives** with watchlist scores, portfolio status, discover picks, and autotrader recommendations
3. **9:35 AM ET** — Autotrader executes: exits first, then entries (if bull regime)
4. **Email arrives** with execution summary (fills, P&L, reasons)
5. **Dashboard** shows live Alpaca positions with Buy More / Sell buttons

---

## Current State (April 2026)

### Swing Trader (port 3001) — Phase 3 Active
- Fully deployed and operational on mini PC
- Paper trading active — scan fires Mon–Fri 8:50 AM ET
- Universe: 48 symbols with category tags (breakout/dividend_value/strong_moat)
- VIX-adaptive thresholds active (VIX=56 → effective threshold 35)

### My Stocks (port 8081) — Fully Operational
- 113+ personal watchlist stocks with daily fundamentals refresh
- Name/sector from Finnhub getProfile() (primary); Yahoo is enrichment-only
  COALESCE in all UPDATEs prevents Yahoo nulls from overwriting Finnhub data
- FUND_DELAY: 2000ms between symbols (3 Finnhub calls/symbol via Promise.allSettled)
- 30+ signal scoring engine (analyzer.js)
- 204-stock discovery universe (universe.js) — tech-only scoring for non-watchlist
- Auto-trading engine deployed (autotrader.js) — autorun_enabled='0' by default
- News modal: Finnhub (cached) + SEC EDGAR Atom RSS tabs, per symbol
- Live Alpaca positions panel with Buy More / Sell modals
- Open orders panel with Cancel button
- Discovery panel with "+ Watch" and "Buy" buttons
- Portfolio stats bar: Positions | Invested | P&L | Total Return % | Today's Gain %
- Chg% column in all three sections (Stocks, Portfolio, Discover); prices colored green/red
- RSI badge colors: red=oversold (<30), green=mid (30-70), blue=overbought (>70)
- Performance chart: 50d MA (amber dashed) + 200d MA (red dashed) overlays
  Server fetches 430 extra calendar days for MA warmup; MAs normalized to % return base

---

## Database

Host: 192.168.1.156 | User: stocktrader | DB: stocktrader | Password: stocktrader123

### Swing Trader Tables (9)
scan_sessions, candidates, trades, positions, daily_stats, news_cache, system_log, system_config, portfolio_plans

### My Stocks Tables (3)
watchlist, price_history, stock_signals

### Autotrader Table
autotrader_trades — every executed buy/sell, drives getDaysHeld() for 30-day time stop

### system_config Schema (critical — NOT key/value)
```sql
config_group VARCHAR(40),   -- e.g. 'autotrader'
config_key   VARCHAR(60),   -- e.g. 'autorun_enabled'
config_value VARCHAR(120)   -- e.g. '1' or '8'
```
Query pattern: `SELECT config_value FROM system_config WHERE config_group='autotrader' AND config_key=?`

---

## Key Bugs Fixed (Sessions 2026-04-12 to 2026-04-16)

| Bug | Fix |
|-----|-----|
| plan_json MySQL JSON column double-parsed → empty plan | Guard: `typeof === 'string' ? JSON.parse() : value` |
| Approve/Reject/Scan buttons used JS (broken in dashboard) | Converted to plain `<a href>` GET routes |
| ACCOUNT_SIZE=10000 → $1K max position instead of $10K | Updated to 100000; portfolio.js uses actual Alpaca equity |
| ADD COLUMN IF NOT EXISTS rejected by MySQL 8.4 | Used information_schema.COLUMNS conditional + PREPARE/EXECUTE pattern |
| system_config assumed key/value columns — actual schema is config_group/config_key/config_value | Corrected all queries in autotrader.js and server_portfolio.js |
| ema9_bear_cross_ago computed in analyzer but not stored | Added to INSERT/UPDATE statement and stock_signals columns |
| Shell heredoc expanded backtick-quoted SQL identifiers | Removed backtick quoting, used correct column names |
| Sector/name always NULL — Yahoo Finance returned HTML error page (rate-limited) | Made Finnhub getProfile() primary source; Yahoo enrichment-only with COALESCE |
| stock_signals sector still NULL even after watchlist fix | analyzer.js INSERT used in-memory quoteData (Yahoo null) — fixed with COALESCE in ON DUPLICATE KEY UPDATE |
| SMA200 incorrect on short display windows (1m/3m view) | Server fetches 430 extra calendar days for warmup; slices to display range after computing |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20 |
| Web | Express.js |
| Database | MySQL 8.4 on 192.168.1.156 |
| Broker | Alpaca (paper mode) |
| Indicators | technicalindicators npm |
| Email | nodemailer (Gmail SMTP) |
| Scheduler | cron npm (ET timezone) |
| Hosting | Mini PC 192.168.1.156 Ubuntu 25.10 |
| Swing Trader | systemd user service port **3001** |
| My Stocks | systemd user service port **8081** |

---

## File Map

```
server.js              → Swing trader Express + all routes + HTML
server_portfolio.js    → My Stocks Express + all routes + HTML (port 8081)
config/env.js          → All config from .env
config/params.js       → All scoring/risk params — DB-backed, editable via /settings
config/sources.js      → Runtime source switching (reads/writes system_config table)
db/schema.sql          → 9 swing trader tables incl. system_config + portfolio_plans
db/db.js               → MySQL pool helpers
data/provider.js       → UNIFIED ROUTER — always use this in scanner
data/alpacaData.js     → Alpaca Market Data (primary price source)
data/yahoo.js          → Yahoo Finance quote() + historical() + withRetry()
data/finnhub.js        → Fundamentals, analyst, earnings, news, getEarnings()
data/sentiment.js      → StockTwits, Alpha Vantage NLP, Fear&Greed, Reddit
data/institutional.js  → SEC 13F, Dataroma superinvestors, Finviz
data/marketContext.js  → SPY/QQQ/VIXY analysis, market health score
analysis/technicals.js → RSI, MACD, Bollinger, golden/death cross, ATR
analysis/scorer.js     → Composite score + probability + VIX-adaptive threshold
screener/universe.js   → 48 symbols with category tags
screener/scan.js       → Batch scanner, uses provider.js
trader/portfolio.js    → Daily plan builder (BUY/HOLD/EXIT/SWAP, anti-churn)
trader/guardrails.js   → All pre-trade safety checks
trader/executor.js     → Alpaca order placement + position sync
scheduler/cron.js      → Pre-market, midday, 5min sync, EOD (ET timezone)
notifier/email.js      → sendDailyDigest(), sendModeChangeEmail(), sendAutotraderEmail()
stocktrader.service    → systemd unit file (port 3001)
stock_trader_v1.html   → Full swing trader documentation

portfolio_app/yahoo_history.js → Watchlist mgmt, Alpaca bar fetch, Finnhub+Yahoo fundamentals
portfolio_app/analyzer.js      → 30+ signal scoring engine (0-100, BUY/HOLD/SELL + why)
portfolio_app/autotrader.js    → 3-tier auto-trading engine (entry/exit/sizing)
portfolio_app/universe.js      → 204-stock discovery universe, scanUniverse(), getTopPicks()
portfolio_app/scheduler.js     → 8:30 AM + 9:35 AM ET crons
portfolio_app/seed_symbols.js  → One-time watchlist seed from spreadsheet
stocktrader_portfolio.service  → systemd unit file (port 8081)
```

---

## API Keys (.env)

- ALPACA: paper mode, account PA3S20RQWZGU, $100K paper capital
- POLYGON: hFzwnX... (free tier, 5 req/min — not primary)
- FINNHUB: d7cou5... (free, 60 req/min — primary fundamentals)
- ALPHA_VANTAGE: 9N8N9K... (free, 25 req/day — sentiment only)
- EMAIL: rrvenkatrama@gmail.com send+receive, app password set

---

## Known Issues (April 2026)

1. Finnhub price target returns 403 (paid feature) — gracefully handled, targetMean = null
2. VIXY proxy for VIX is approximate (VIXY × 1.8 + 2 ≈ VIX)
3. Yahoo Finance rate-limits after ~10 rapid requests (clears in 30-60 min)
   — sector/name now from Finnhub so this no longer blocks core data
   — price targets still Yahoo-only; COALESCE protects once populated
4. VIXY and SPY must be in watchlist for VIX sizing and 50MA regime gate to work
   — SPY absent from stock_signals → regime = 'unknown' → autotrader blocks all entries

---

## Deployment

```bash
# Sync My Stocks files
scp portfolio_app/<file> rajramani@192.168.1.156:~/stocktrader/portfolio_app/<file>
scp server_portfolio.js rajramani@192.168.1.156:~/stocktrader/

# Restart My Stocks
ssh rajramani@192.168.1.156 "systemctl --user restart stocktrader_portfolio && sleep 3 && systemctl --user status stocktrader_portfolio --no-pager"

# Sync swing trader files
scp <file> rajramani@192.168.1.156:~/stocktrader/<path>

# Restart swing trader
ssh rajramani@192.168.1.156 "systemctl --user restart stocktrader && sleep 3 && systemctl --user status stocktrader --no-pager"

# Check logs
ssh rajramani@192.168.1.156 "journalctl --user -u stocktrader_portfolio -n 30 --no-pager"
ssh rajramani@192.168.1.156 "journalctl --user -u stocktrader -n 30 --no-pager"
```
