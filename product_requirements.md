# StockTrader — Product Requirements Document

**Version:** 2.2  
**Date:** April 2026  
**Author:** Rajesh Ramani  
**Status:** Living document — updated as features ship

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Infrastructure](#2-infrastructure)
3. [Data Sources](#3-data-sources)
4. [Database Schema](#4-database-schema)
5. [File Map](#5-file-map)
6. [Swing Trader Dashboard (Port 3001)](#6-swing-trader-dashboard-port-3001)
7. [My Stocks Dashboard (Port 8081)](#7-my-stocks-dashboard-port-8081)
   - 7.1 [UI Layout & Theme](#71-ui-layout--theme)
   - 7.2 [Header & Stat Bar](#72-header--stat-bar)
   - 7.3 [Portfolio Section](#73-portfolio-section)
   - 7.4 [Stocks Section](#74-stocks-section)
   - 7.5 [Discover Section](#75-discover-section)
   - 7.6 [Modals](#76-modals)
   - 7.7 [Data Refresh Pipeline](#77-data-refresh-pipeline)
   - 7.8 [Scoring Engine](#78-scoring-engine)
   - 7.9 [Email Notifications](#79-email-notifications)
   - 7.10 [API Routes](#710-api-routes)
8. [Auto-Trading System (New Feature)](#8-auto-trading-system-new-feature)
   - 8.1 [Autorun Toggle](#81-autorun-toggle)
   - 8.2 [Tier 3 — Market Regime Filter](#82-tier-3--market-regime-filter)
   - 8.3 [Tier 2 — Quality + Mean Reversion Filter](#83-tier-2--quality--mean-reversion-filter)
   - 8.4 [Tier 1 — Entry/Exit Execution Rules](#84-tier-1--entryexit-execution-rules)
   - 8.5 [Risk Management Guardrails](#85-risk-management-guardrails)
   - 8.6 [Autorun OFF Mode (Recommendation)](#86-autorun-off-mode-recommendation)
   - 8.7 [Autorun ON Mode (Auto-Execute)](#87-autorun-on-mode-auto-execute)
   - 8.8 [Trade Notifications (Email)](#88-trade-notifications-email)
9. [Non-Functional Requirements](#9-non-functional-requirements)
10. [Known Issues & Constraints](#10-known-issues--constraints)
11. [Design Decisions (Do Not Reverse)](#11-design-decisions-do-not-reverse)

---

## 1. System Overview

StockTrader is a personal swing trading research and execution system with two independent dashboards:

| Dashboard | Port | Purpose |
|-----------|------|---------|
| Swing Trader | 3001 | Short-term scan-and-execute: universe scan, daily plan, human-approved trades |
| My Stocks | 8081 | Personal watchlist research: 113+ stocks, long-hold scoring, Alpaca execution |

Both dashboards share the same Alpaca brokerage account, MySQL database, and data layer. The **My Stocks dashboard (port 8081) is the primary focus of this document** and the target for the Auto-Trading feature.

---

## 2. Infrastructure

| Component | Value |
|-----------|-------|
| Server | Mini PC at 192.168.1.156 |
| OS | Ubuntu 25.10 |
| Runtime | Node.js 20 |
| Database | MySQL 8.4 |
| Broker | Alpaca (paper mode by default; live switchable via .env) |
| Services | systemd user services via `loginctl enable-linger` |
| Swing Trader service | `stocktrader.service` |
| My Stocks service | `stocktrader_portfolio.service` |
| Timezone | America/New_York (all cron expressions use ET) |

### Deployment Pattern

```bash
# Deploy My Stocks changes
scp <file> rajramani@192.168.1.156:~/stocktrader/<path>
ssh rajramani@192.168.1.156 "systemctl --user restart stocktrader_portfolio && sleep 3 && systemctl --user status stocktrader_portfolio --no-pager"
```

---

## 3. Data Sources

| Data Type | Primary Source | Fallback | Notes |
|-----------|---------------|----------|-------|
| Price bars (OHLCV) | Alpaca Market Data API | — | No rate limits; parallel batches of 5 |
| PE, EPS growth, ROE, D/E | Finnhub `/stock/metric` | — | 60 req/min free; 1200ms delay between symbols |
| Analyst buy/sell/hold counts | Finnhub `/stock/recommendation` | — | 2nd Finnhub call per symbol |
| Upgrades/downgrades | Finnhub `/stock/upgrade-downgrade` | — | Free; refreshed weekly, max 20 symbols/run |
| Name, sector, short interest | Yahoo Finance `quote()` | Finnhub profile | Rate-limits after ~10 rapid requests; graceful degradation |
| Analyst consensus (rec mean) | Yahoo Finance `quote()` | — | `recommendationMean` + `numberOfAnalystOpinions` |
| Price targets (mean/high/low) | Yahoo Finance `quote()` | — | Free via `targetMeanPrice/High/Low` fields |
| VIX | Yahoo Finance (VIXY proxy) | — | VIXY × 1.8 + 2 ≈ VIX |
| Market news | Finnhub `/company-news` | — | Cached in `news_cache` table |

### Rate Limit Management

- **FUND_DELAY = 1200ms** between symbols during fundamentals phase (2 Finnhub calls/symbol → safe at 60 req/min)
- **QUOTE_DELAY = 800ms** between Yahoo quote calls
- **Upgrade refresh**: max 20 stale symbols per run, 2000ms delay; weekly cadence (upgrades_at < 7 days)
- Yahoo Finance blocks IP after ~10 rapid requests; clears in 30–60 min; switch to Finnhub via sources.js when blocked

---

## 4. Database Schema

### Swing Trader Tables (9)
`scan_sessions`, `candidates`, `trades`, `positions`, `daily_stats`, `news_cache`, `system_log`, `system_config`, `portfolio_plans`

### My Stocks Tables (3)

#### `watchlist`
```sql
symbol          VARCHAR(10) PRIMARY KEY
name            VARCHAR(200)
sector          VARCHAR(100)
asset_type      ENUM('stock','etf','fund') DEFAULT 'stock'
is_active       TINYINT(1) DEFAULT 1
pe_trailing     DECIMAL(10,2)
pe_forward      DECIMAL(10,2)
div_yield       DECIMAL(8,4)
ps_ratio        DECIMAL(10,2)
analyst_buy     INT
analyst_sell    INT
analyst_hold    INT
eps_growth      DECIMAL(8,4)
revenue_growth  DECIMAL(8,4)
debt_equity     DECIMAL(10,4)
roe             DECIMAL(8,4)
beta            DECIMAL(8,4)
short_float     DECIMAL(8,4)
rec_mean        DECIMAL(4,2)
rec_count       INT
target_mean     DECIMAL(10,2)
target_high     DECIMAL(10,2)
target_low      DECIMAL(10,2)
fundamentals_at TIMESTAMP
upgrades_at     TIMESTAMP NULL DEFAULT NULL
```

#### `price_history`
```sql
symbol      VARCHAR(10)
trade_date  DATE
open        DECIMAL(12,4)
high        DECIMAL(12,4)
low         DECIMAL(12,4)
close       DECIMAL(12,4)
adj_close   DECIMAL(12,4)
volume      BIGINT
PRIMARY KEY (symbol, trade_date)
```

#### `stock_signals`
```sql
symbol               VARCHAR(10) PRIMARY KEY
score                INT
recommendation       ENUM('BUY','HOLD','SELL')
why                  TEXT                    -- pipe-delimited signal list
price                DECIMAL(12,4)
price_change_pct     DECIMAL(8,2)
rsi                  DECIMAL(6,2)
oversold             TINYINT(1)
macd_trend           VARCHAR(20)             -- 'bullish'|'above_signal'|'bearish'|'below_signal'|'neutral'
macd_cross_ago       INT
macd_value           DECIMAL(10,4)
macd_signal_value    DECIMAL(10,4)
macd_histogram       DECIMAL(10,4)
above_50ma           TINYINT(1)
above_200ma          TINYINT(1)
ma50                 DECIMAL(12,4)
ma200                DECIMAL(12,4)
ema50                DECIMAL(12,4)
ema200               DECIMAL(12,4)
cross_type           VARCHAR(20)
golden_cross_ago     INT
death_cross_ago      INT
price_crossed_50ma_ago  INT
price_crossed_200ma_ago INT
ema9_bull_cross_ago  INT                     -- sessions since EMA9 crossed above EMA21
ema9_bear_cross_ago  INT                     -- sessions since EMA9 crossed below EMA21
high_52w             DECIMAL(12,4)
low_52w              DECIMAL(12,4)
pct_from_52high      DECIMAL(8,2)
pct_from_52low       DECIMAL(8,2)
pe_trailing          DECIMAL(10,2)
pe_forward           DECIMAL(10,2)
fwd_pe_improving     TINYINT(1)
dividend_yield       DECIMAL(8,4)
target_mean          DECIMAL(10,2)
target_high          DECIMAL(10,2)
target_low           DECIMAL(10,2)
name                 VARCHAR(200)
sector               VARCHAR(100)
asset_type           VARCHAR(10)
generated_at         TIMESTAMP
```

#### `autotrader_trades`
```sql
id               INT AUTO_INCREMENT PRIMARY KEY
symbol           VARCHAR(10) NOT NULL
action           ENUM('buy','sell') NOT NULL
qty              INT NOT NULL
price            DECIMAL(12,4) DEFAULT NULL
exit_reason      VARCHAR(200) DEFAULT NULL
sell_pct         INT DEFAULT NULL
alpaca_order_id  VARCHAR(100) DEFAULT NULL
executed_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
INDEX idx_sym (symbol)
INDEX idx_at  (executed_at)
```

#### `analyst_upgrades`
```sql
id          INT AUTO_INCREMENT PRIMARY KEY
symbol      VARCHAR(10)
action      VARCHAR(20)   -- 'up','down','maintain','init','reit'
from_grade  VARCHAR(100)
to_grade    VARCHAR(100)
firm        VARCHAR(200)
grade_date  DATE
fetched_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
UNIQUE KEY uniq_sym_firm_date (symbol, firm, grade_date)
```

#### `system_config` (shared — data sources + autorun settings)
```sql
id            INT AUTO_INCREMENT PRIMARY KEY
config_group  VARCHAR(40) NOT NULL    -- e.g. 'sources', 'autotrader'
config_key    VARCHAR(60) NOT NULL    -- e.g. 'fundamentals', 'autorun_enabled'
config_value  VARCHAR(120) NOT NULL
updated_at    DATETIME ON UPDATE CURRENT_TIMESTAMP
UNIQUE KEY (config_group, config_key)
```

Autorun rows:
- `config_group='autotrader'`, `config_key='autorun_enabled'` → `'0'` or `'1'`
- `config_group='autotrader'`, `config_key='autorun_max_positions'` → `'8'` (default)

Data-source rows (group `'sources'`): keys `fundamentals`, `priceData`, `news`, etc.

---

## 5. File Map

```
server.js                      Swing Trader Express app (port 3001)
server_portfolio.js            My Stocks Express app (port 8081) ← primary
config/env.js                  All config from .env
config/params.js               Scoring/risk params (DB-backed, editable via /settings)
config/sources.js              Runtime data source switching
db/schema.sql                  All MySQL table definitions
db/db.js                       MySQL pool helpers (query, queryOne, insert, log)
db/setup.js                    One-time DB init script
data/provider.js               Unified data router (swing trader only)
data/alpacaData.js             Alpaca Market Data — getDailyBars(), getAccount(), etc.
data/yahoo.js                  Yahoo Finance quote() + historical() + withRetry()
data/finnhub.js                Fundamentals, analyst ratings, earnings, news,
                               upgrades/downgrades, getSectorPE(), getSectorPS()
data/sentiment.js              StockTwits, Alpha Vantage NLP, Fear&Greed, Reddit
data/institutional.js          SEC 13F, Dataroma, Finviz
data/marketContext.js          SPY/QQQ/VIXY analysis, market health score
analysis/technicals.js         RSI, MACD, Bollinger, golden/death cross, ATR
analysis/scorer.js             Swing trader composite score + probability
screener/universe.js           Swing trader 30-symbol universe
screener/scan.js               Swing trader batch scanner
trader/portfolio.js            Daily plan builder (BUY/HOLD/EXIT/SWAP)
trader/guardrails.js           Pre-trade safety checks
trader/executor.js             Alpaca order placement + position sync
scheduler/cron.js              Swing trader crons (pre-market, midday, 5min, EOD)
notifier/email.js              All email types including sendDailyDigest(), sendErrorAlert()
portfolio_app/yahoo_history.js Watchlist mgmt, Alpaca bars, Finnhub+Yahoo fundamentals,
                               refreshAll(), refreshUpgrades()
portfolio_app/analyzer.js      My Stocks scoring engine (30+ signals, BUY/HOLD/SELL)
portfolio_app/universe.js      204-stock discovery universe, scanUniverse(), getTopPicks()
portfolio_app/scheduler.js     8:30 AM ET (refresh→analyze→universe→autotrader eval→email)
                               9:35 AM ET (autotrader execute if autorun ON)
portfolio_app/seed_symbols.js  Initial watchlist seed script
portfolio_app/autotrader.js    Auto-trading engine (3-tier: regime→quality→entry/exit)
stocktrader.service            systemd unit (swing trader, port 3001)
stocktrader_portfolio.service  systemd unit (My Stocks, port 8081)
```

---

## 6. Swing Trader Dashboard (Port 3001)

### Purpose
Scans a ~30-symbol universe for short-term swing trade opportunities. Builds a daily plan (BUY/HOLD/EXIT/SWAP). Requires **human approval before any order is placed**.

### Key Design Rules
- Human approves every trade (approve = `GET /plan/:id/approve-now`)
- Anti-churn: never recommend selling unless 20+ point score difference
- Paper mode default (ALPACA_BASE_URL defaults to paper URL)
- Cash buffer 20% always uninvested
- Max 4 trades/day, max 4 open positions
- No buy within 5 days of earnings
- Market hours only: 9:35 AM – 3:45 PM ET

### Navigation
- Approve Plan → `GET /plan/:id/approve-now`
- Reject Plan → `GET /plan/:id/reject-now`
- Scan Now → `GET /scan-now`
- All navigation uses plain `<a href>` links (no JS onclick) — learned from production failures

---

## 7. My Stocks Dashboard (Port 8081)

### 7.1 UI Layout & Theme

**Color palette:**

| Token | Hex | Usage |
|-------|-----|-------|
| Body background | `#f7f9fc` | Page background |
| Card/table background | `#ffffff` | Cards, table rows |
| Table header bg | `#f0f4f8` | `th` backgrounds |
| Border light | `#e2e8f0` | Card, table, input borders |
| Border lighter | `#edf2f7` | Row separators |
| Text primary | `#1a202c` | Body text |
| Text secondary | `#718096` | Labels, metadata |
| Text muted | `#4a5568` | Column headers |
| Header gradient | `#1a365d` → `#2c5282` | Top nav bar |
| Header text | `#bee3f8` | H1 in header |
| Accent blue | `#3182ce` | Links, buttons, sort indicator |
| Green (up/buy) | `#276749` | Positive values, BUY badge text |
| Green light | `#9ae6b4` | BUY badge border |
| Green bg | `#f0fff4` | BUY badge background |
| Red (down/sell) | `#c53030` | Negative values, SELL badge text |
| Red light | `#feb2b2` | SELL badge border |
| Red bg | `#fff5f5` | SELL badge background |
| Yellow (hold) | `#744210` | HOLD badge text |
| Yellow light | `#f6e05e` | HOLD badge border |
| Yellow bg | `#fffff0` | HOLD badge background |
| Purple | `#6b46c1` | ETF/FUND badge, chart button |
| Hover row | `#f7fafc` | Table row hover state |

**Typography:** `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`, base 13px

**Responsive:** `<meta name="viewport" content="width=device-width,initial-scale=1">`

### 7.2 Header & Stat Bar

**Header (`div.header`):**
- Left: "📊 My Stocks Research" (h1, white)
- Badges: PAPER TRADE (blue) or LIVE TRADE (red), market open/closed status
- Right-side buttons (plain `<a href>` links styled as buttons):
  - `Refresh Now` → `GET /refresh-now` (triggers full data refresh)
  - `⏸ Autorun: OFF` / `▶ Autorun: ON` → `GET /autorun/toggle` (shows confirmation dialog)
  - `Scoring Guide` → `/docs/scoring` (opens scoringmethodology.html)
  - `↗ Swing Trader` → `http://192.168.1.156:3001/dashboard`
  - `Add Ticker` (form: text input → POST `/watchlist/add`)

**Stat bar (`div.stat-bar`):**
- Total Stocks (watchlist count)
- BUY signals (count of recommendation = 'BUY')
- HOLD signals
- SELL signals
- Last Refresh timestamp
- Market status (Open / Closed)

### 7.3 Portfolio Section

**Section header:** `💼 My Portfolio · N positions · $X equity · $Y cash`  
Collapsible via `toggleSection('sec-portfolio')`. State persisted in `localStorage`.

**Positions table** (columns, left to right):

| # | Column | Content |
|---|--------|---------|
| 1 | Symbol · Trade | **Symbol** bold + ETF badge (if applicable) + name (gray, 11px) + Buy/Sell buttons inline (below name) |
| 2 | Signal · Price | BUY/HOLD/SELL badge + last analyzed price (gray, 11px) |
| 3 | Why | "Why?" button → opens Why modal |
| 4 | Sector | Sector name from signals table |
| 5 | Price Target | Mean target price + % upside/downside (color-coded) + range (low–high) |
| 6 | Analyst Action | Most recent upgrade/downgrade: icon (↑↓→★) + grade + firm + days ago |
| 7 | Performance · Chart | 1D/1W/1M/1Y % gains in 2×2 grid + 📈 Chart button |
| 8 | Qty | Integer share count |
| 9 | Avg Entry | Average cost basis ($/share) |
| 10 | Current | Current market price |
| 11 | Mkt Value | Total market value |
| 12 | Unrealized P&L | $ and % gain/loss (green/red) |

- Max height 240px with vertical scroll
- Buy button: `class="btn btn-success btn-xs"`, calls `openBuy(sym, price, name)`
- Sell button: `class="btn btn-warn btn-xs"`, calls `openSell(sym, qty, price, name)`

**Open Orders table** (when orders exist):
Symbol | Side (badge) | Qty | Type + limit price | TIF | Status (color) | Submitted ET | Cancel button

**Summary stats strip** (above table):
- Market Value (blue)
- Unrealized P&L (green/red)
- Position count
- Open Orders count

### 7.4 Stocks Section

**Section header:** `📋 My Stocks · N symbols`  
Collapsible. Has filter bar above table.

**Filter bar:**
- Signal filter: dropdown (All / BUY / HOLD / SELL) → filters by `data-rec` attribute
- Text search: input → filters by symbol or name (`data-sym`, `data-name`)

**Stocks table** (`id="stocks-table"`, sortable):

| # | Column | `data-col` | Content |
|---|--------|-----------|---------|
| 1 | Symbol | `sym` | **Symbol** bold + ETF/FUND badge + name (gray) + **Buy/Remove buttons inline** (flex div below name) — **sticky first column** |
| 2 | Signal | `rec` | BUY/HOLD/SELL badge |
| 3 | Score | `score` | Numeric score + color-coded score bar (80px wide, 6px tall) |
| 4 | Why | — | "Why?" button → opens Why modal |
| 5 | Sector | `sector` | Sector string |
| 6 | Price | `price` | Current close price |
| 7 | RSI | `rsi` | RSI value (green <30, red >70) |
| 8 | MACD | `macd` | signal-up / signal-down / signal-neu class |
| 9 | 50MA | `a50` | ✓ (green) or ✗ (red) |
| 10 | 200MA | `a200` | ✓ / ✗ |
| 11 | Cross | — | Tag: `☀ Golden cross (Nd ago)` / `☀ Above GC` / `↗ Approaching GC` / `↓ Below GC` / `☠ Death cross (Nd ago)` |
| 12 | 52W | — | Distance from 52-week high (negative %) and low (positive %) |
| 13 | PE | `pe` | Trailing PE or P/S ratio (gray if P/S) |
| 14 | Div % | `div` | Dividend yield % |
| 15 | Target | `target` | Analyst mean target + % upside (color-coded) + range |
| 16 | Analyst | — | Last upgrade/downgrade: icon + grade + firm + days ago |

- First column (`th:first-child`, `td:first-child`) is sticky (`position:sticky; left:0`) for horizontal scroll
- All `th` have `data-col` attribute and call `sortTable(col)` on click
- Sort indicator: `▲` / `▼` appended via CSS `::after` on `.sort-asc` / `.sort-desc` class
- Row `data-rec`, `data-sym`, `data-name` attributes used by filter functions

**Cross tag logic:**
- `cross_type === 'golden_cross'` AND `golden_cross_ago <= 15`: `☀ Golden cross (Nd ago)` (yellow tag)
- `cross_type === 'golden_cross'` (older): `☀ Above GC` (yellow tag)
- `cross_type === 'death_cross'` AND `death_cross_ago <= 15`: `☠ Death cross (Nd ago)` (red tag)
- `cross_type === 'death_cross'` AND approaching (50MA within 2.5% below 200MA): `↗ Approaching GC` (green tag)
- `cross_type === 'death_cross'` otherwise: `↓ Below GC` (red tag)
- No cross + approaching: `↗ Approaching GC` (green tag)

### 7.5 Discover Section

**Section header:** `🔍 Discover · Top picks from 204-stock universe`  
Collapsible.

- Scans ~204-stock universe (S&P 100 + popular NASDAQ + sector ETFs) for BUY signals not already in watchlist
- Technical-only scoring (no Finnhub fundamentals for non-watchlist stocks)
- Displayed as a card grid, one card per pick
- Each card shows: Symbol, Score, Recommendation badge, key signals
- **"+ Watch"** button → `GET /watchlist/add/:symbol` (adds to watchlist; full data on next morning refresh)
- **"Buy"** button → opens Buy modal directly

### 7.6 Modals

#### Why Modal (`id="why-modal"`)
- Triggered by `showWhy(sym, why)` JS function
- Header: `{symbol} — Signal Breakdown`
- Body: `why` string split on ` | ` separator; first part (Score:) rendered as large blue heading
- Positive signals (starting with `+`): color `#276749`
- Negative signals (starting with `-`): color `#c53030`
- Neutral: color `#1a202c`
- Row borders: `#edf2f7`
- Close: X button or Escape key

#### Buy Modal (`id="buy-modal"`)
- Triggered by `openBuy(sym, price, name)`
- Fields: Qty (number), Order Type (market/limit), Limit Price (shown when limit selected), TIF (day/gtc/opg/cls), Extended Hours (checkbox)
- Info boxes: Paper/Live trade badge, Available buying power, Market open/closed status
- Cost estimate row: Total Cost + Remaining buying power (updates live on input change)
- Extended hours: forces limit order + day TIF, disables those selectors
- Submit: POST `/order` with `{symbol, side:'buy', qty, type, timeInForce, extendedHours, limitPrice?}`
- On success: reload page

#### Sell Modal (`id="sell-modal"`)
- Mirrors Buy modal but side = 'sell'
- Shows "Holding N shares @ $price"
- Qty capped at position size
- Proceeds estimate (not cost)

#### News Modal (`id="news-modal"`)
- Triggered by `openNews(sym, name)` — `News` button in Stocks table and Positions table
- Header: `📰 {SYMBOL} — {Name} · Latest News`
- Two source tabs:
  - **Company News** (Finnhub) — `GET /news/{symbol}?source=finnhub`
  - **SEC Filings** (EDGAR) — `GET /news/{symbol}?source=sec`
- Body: scrollable list of articles; each shows headline (link), source, and published date (ET)
- Data source:
  - Finnhub: `finnhub.getNews(symbol, 72)` — up to 72 hours of cached news
  - SEC EDGAR: Atom RSS feed at `sec.gov/cgi-bin/browse-edgar` — 8-K filings, regex-parsed
- Max height: 880px with vertical scroll; modal max-width 1100px
- Close: X button, Escape key, or clicking outside

#### Chart Modal (`id="chart-modal"`)
- Triggered by `openChart(sym, name)`
- Renders Chart.js 4.4.2 line chart (loaded from jsDelivr CDN)
- Period buttons: 1M / 3M / 6M / 1Y / 2Y / 5Y
- Benchmark toggles: SPY (S&P 500) / QQQ (Nasdaq 100) / DIA (Dow Jones) — multi-select
- All series normalized to 100 at period start; Y-axis shows % change from start
- Data source: `GET /position-chart/:symbol?period=1y&benchmarks=SPY,QQQ`
- Series colors: stock=#f6ad55, SPY=#63b3ed, QQQ=#b794f4, DIA=#68d391
- Benchmarks rendered as dashed lines (borderDash: [5,3])
- Tooltip: white background, shows % gain/loss vs period start for each series
- Chart destroyed on modal close to prevent memory leaks

### 7.7 Data Refresh Pipeline

Two scheduled cron jobs in `portfolio_app/scheduler.js`, Monday–Friday:

| Cron | Time (ET) | Purpose |
|------|-----------|---------|
| Morning refresh | **8:30 AM** | Full data pipeline + autotrader recommendations + email |
| Execution window | **9:35 AM** | Autotrader order execution (only when `autorun_enabled='1'`) |

Manual trigger: `GET /refresh-now` (runs 8:30 AM pipeline in background, returns immediately)

#### 8:30 AM Pipeline (7 phases)

**Phase 1 — Price History (Alpaca, parallel)**
- For each symbol in watchlist (is_active=1):
  - Fetch last 15 bars (or 380 bars if fullYear=true) via `alpaca.getDailyBars()`
  - Upsert into `price_history` table
- Batches of 5 symbols in parallel (no rate limits on Alpaca)

**Phase 2 — Fundamentals (Finnhub primary + Yahoo enrichment, serial)**
- For each symbol, serial with 1200ms delay:
  1. `finnhub.getFundamentals()` → PE, EPS growth, revenue growth, ROE, D/E, beta, dividend yield, P/S
  2. `yf.quote()` → name, sector, asset type, forward PE, short float, rec mean/count, price targets
  3. `finnhub.getAnalystRatings()` → buy/sell/hold counts
  4. UPDATE `watchlist` row with all fetched data + `fundamentals_at=NOW()`

**Phase 3 — Upgrades/Downgrades (Finnhub, weekly)**
- Query watchlist for symbols where `upgrades_at IS NULL OR upgrades_at < 7 days ago`, LIMIT 20
- For each stale symbol: `finnhub.getUpgradesDowngrades()` → upsert into `analyst_upgrades`
- 2000ms delay between symbols; UPDATE `watchlist SET upgrades_at=NOW()`

**Phase 4 — Analysis**
- `analyzeAll(quotes)` → scores all watchlist symbols, writes `stock_signals` table
- Pre-computes SPY market context (above 200MA? MACD bullish?) for all stocks in one pass

**Phase 4.5 — Autotrader Recommendations (always runs, never executes)**
- `autotrader.evaluate(false)` → runs all 3 tiers, returns `{exits, entries, skipped, regime}`
- Produces recommendations only — **no orders placed at 8:30 AM**
- Results passed to daily digest email as "Tomorrow's Recommended Trades"

**Phase 5 — Universe Scan**
- `scanUniverse()` → scores 204-stock discovery universe, returns top BUY picks not in watchlist

**Phase 6 — Email**
- `sendDailyDigest(signals, positions, picks, autotraderResults)` → morning summary email
  - Includes autotrader recommendations section when entries or exits were found

**Phase 7 — Error Alert**
- If any phase collected errors: `sendErrorAlert(errors)` → red HTML table email listing phase/error

#### 9:35 AM Execution Cron

- Calls `autotrader.run()` — checks `autorun_enabled='1'` and market hours (9:35–15:45 ET)
- If autorun is OFF or outside hours: no-op (logs only)
- If autorun is ON: places market orders via Alpaca for any triggered buys/sells
- On completion: `sendAutotraderEmail(results)` — execution summary with ✅/❌ per order

### 7.8 Scoring Engine

`portfolio_app/analyzer.js` — Composite score 0–100, clamped.

**Recommendation thresholds:**
- BUY ≥ 50
- HOLD ≥ 10
- SELL < 10

#### MA Signals (50 vs 200 SMA)

| Condition | Points |
|-----------|--------|
| Golden cross today | +20 |
| Golden cross ≤5 sessions ago | +14 |
| 50MA actively above 200MA | +8 |
| Death cross ≤5 sessions | −20 |
| 50MA actively below 200MA (death cross) | −8 |
| Price crossed above 200MA (≤5 sessions) | +18 |
| Price crossed above 50MA (≤5 sessions) | +15 |
| Price above 200MA | +8 |
| Price above 50MA only | +6 |
| Price below 50MA | −8 |
| Price below 200MA | −10 |

#### EMA 9/21 Short-Term Signals

| Condition | Points |
|-----------|--------|
| EMA 9 just crossed above EMA 21 (≤1 session) | +12 |
| EMA 9/21 bull cross 2–5 sessions ago | +8 |
| EMA 9 above EMA 21 (sustained) | +4 |
| EMA 9 below EMA 21 | −5 |
| EMA 9 crossed below EMA 21 (≤3 sessions) | −10 |
| Full EMA bull stack (price > EMA9 > EMA21 > EMA50) | +10 |
| Full EMA bear stack | −10 |

#### Volume Confirmation

| Condition | Points |
|-----------|--------|
| Price up + volume ≥1.5x 20-day avg | +10 |
| Price down + volume ≥1.5x avg | −8 |
| Price up + volume 1.2–1.5x avg | +4 |

#### RSI (14-period)

| Range | Points |
|-------|--------|
| RSI < 30 (deeply oversold) | +10 |
| RSI 30–45 (recovering) | +15 |
| RSI 45–60 (neutral-bullish) | +5 |
| RSI > 70 (overbought) | −15 |

#### MACD (12/26/9)

| Condition | Points |
|-----------|--------|
| Bullish cross ≤1 session | +12 |
| Bullish cross 2–5 sessions ago | +7 |
| MACD above signal (trend up) | +4 |
| MACD below signal (trend down) | −4 |

#### Valuation (stocks only, sector-relative)

| Condition | Points |
|-----------|--------|
| Trailing/fwd PE 40%+ below sector avg | +12 |
| PE 20–40% below sector avg | +8 |
| PE 10–20% below sector avg | +5 |
| PE 30%+ above sector avg | −6 |
| Forward PE < trailing PE (earnings accelerating) | +8 |
| P/S ratio 40%+ below sector avg | +8 |
| P/S 20–40% below sector avg | +5 |
| P/S 50%+ above sector avg | −4 |
| PEG < 1 | +10 |
| PEG 1–2 | +5 |
| PEG > 3 | −5 |

#### Price Target Upside

| Condition | Points |
|-----------|--------|
| Analyst mean target ≥30% above current price | +8 |
| ≥15% above | +5 |
| ≥10% below current price (downgrade risk) | −6 |

#### Fundamental Quality (Finnhub 3Y data)

| Condition | Points |
|-----------|--------|
| EPS growth > 20% | +8 |
| EPS growth 10–20% | +4 |
| EPS growth negative | −6 |
| Revenue growth > 15% | +6 |
| Revenue growth 5–15% | +3 |
| ROE > 20% | +6 |
| ROE 10–20% | +3 |
| ROE negative | −3 |
| Debt/equity < 0.3 | +4 |
| Debt/equity > 2.0 | −4 |

#### Income

| Dividend Yield | Points |
|----------------|--------|
| ≥ 5% | +12 |
| ≥ 3% | +8 |
| ≥ 1.5% | +4 |
| ≥ 0.5% | +2 |

#### Analyst Consensus (min 3 analysts)

| Condition | Points |
|-----------|--------|
| Finnhub: ≥70% buy ratings | +10 |
| Finnhub: ≥50% buy ratings | +6 |
| Finnhub: ≥40% sell ratings | −8 |
| Yahoo recMean ≤1.5 (Strong Buy, ≥5 analysts) | +7 |
| Yahoo recMean ≤2.0 (Buy) | +4 |
| Yahoo recMean ≥4.0 (Sell) | −5 |

#### Short Interest (Yahoo Finance)

| Condition | Points |
|-----------|--------|
| > 20% short + price rising (squeeze setup) | +6 |
| > 30% short + price falling (bears winning) | −4 |

#### Market Context (SPY from price_history)

| Condition | Points |
|-----------|--------|
| SPY above 200MA + MACD bullish | +5 |
| SPY below 200MA | −5 |

### 7.9 Email Notifications

All emails sent via Gmail SMTP (rrvenkatrama@gmail.com, app password configured). All are HTML-formatted with inline styles.

**Daily Digest** (`sendDailyDigest`) — sent at 8:30 AM after refresh:
- Subject: `📊 My Stocks Daily — {today} | {N} Buy · {N} Hold · {N} New Picks`
- Sections: summary counters, current positions + P&L, consider-selling list, top BUY opportunities, hold positions, universe new picks
- When autotrader recommendations exist: "🤖 Autotrader — Tomorrow's Recommendations" section with suggested buys/sells

**Autotrader Execution Email** (`sendAutotraderEmail`) — sent at 9:35 AM after execution:
- Subject: `▶ Autotrader Executed — N buys, N sells`
- Tables: Sells (symbol, %, qty, price, P&L%, reason, status ✅/❌), Buys (symbol, qty, price, score, confirmations, status)
- Errors section if any orders failed

**Mode Change Email** (`sendModeChangeEmail`) — sent immediately on toggle:
- Subject: `⏸ My Stocks Autorun: OFF` or `▶ My Stocks Autorun: ON`
- When turning ON: lists all active guardrails (watchlist-only, max 8 positions, hard stop rules, etc.)

**Error Alert** (`sendErrorAlert`) — sent when any scheduler phase throws an exception:
- Subject: `⚠️ My Stocks — {N} error(s) during daily refresh`
- Body: dark-themed HTML table with columns: Phase | Error Message | Symbol

### 7.10 API Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Main dashboard (full HTML page render) |
| GET | `/refresh-now` | Trigger full data refresh (background) |
| GET | `/scan-universe` | Trigger universe scan (background) |
| POST | `/watchlist/add` | Add ticker (form body: `symbol`) |
| GET | `/watchlist/add/:symbol` | Add ticker (URL param, used from Discover) |
| GET | `/watchlist/remove/:symbol` | Soft-delete (set is_active=0) |
| GET | `/analyze/:symbol` | Re-analyze single symbol |
| POST | `/order` | Place buy or sell order via Alpaca |
| GET | `/order/:id/cancel` | Cancel open Alpaca order |
| GET | `/position-chart/:symbol` | Chart data: `?period=1y&benchmarks=SPY,QQQ` |
| GET | `/autorun/toggle` | Toggle autorun on/off (plain `<a href>`, confirms via JS dialog) |
| GET | `/autorun/status` | Return current autorun state as JSON `{autorun: bool}` |
| GET | `/news/:symbol` | Return `{articles:[{headline,source,url,publishedAt}]}` · `?source=finnhub\|sec` |
| GET | `/docs/scoring` | Serve scoringmethodology.html |

---

## 8. Auto-Trading System (New Feature)

### 8.1 Autorun Toggle

**Storage:** `system_config` table — `config_group='autotrader'`, `config_key='autorun_enabled'`, `config_value='0'` or `'1'`. Default `'0'`.

**UI in header:**
- When OFF: `<a href="/autorun/toggle">⏸ Autorun: OFF</a>` (gray) — clicking shows JS confirmation dialog before proceeding
- When ON: `<a href="/autorun/toggle">▶ Autorun: ON</a>` (green) — clicking shows JS confirmation dialog before proceeding

**Toggle route** (`GET /autorun/toggle`):
1. Read current `config_value` from `system_config` (group=autotrader, key=autorun_enabled)
2. Flip it (`'0'` → `'1'`, `'1'` → `'0'`) via UPSERT
3. Log the change to `system_log`
4. Send `sendModeChangeEmail(mode)` asynchronously
5. Redirect to `/`

**Effect on cron schedule:**
- **8:30 AM always:** `evaluate(false)` runs, recommendations included in digest email — no orders
- **9:35 AM:** if `autorun_enabled='1'`, `autotrader.run()` executes orders + sends execution email
- If `autorun_enabled='0'` at 9:35 AM: no-op (logged only)

**Important timing rule:** Turning Autorun ON mid-day does NOT trigger immediate evaluation of existing positions. The first evaluation always happens at the **next morning's 8:30 AM scheduled run**. This prevents unintended mid-day orders placed without a full overnight data refresh.

**First-run behaviour (Autorun just turned ON):** On the first 8:30 AM run after enabling, `autotrader.run()` evaluates all current Alpaca positions — including any opened manually before Autorun was enabled — against the exit rules. It does not blindly inherit them; every position is checked.

### 8.2 Tier 3 — Market Regime Filter

This is the **outermost gate**. If the market regime is BEAR, no new buy orders are placed.

**Inputs:** SPY daily bars from `price_history` table

**BULL regime** (all conditions met):
- SPY price is above its 200-day SMA
- SPY MACD is in bullish territory (MACD line above signal line)
- VIX < 25 (low fear; read from `system_config` key `last_vix` or computed via VIXY proxy)

**BEAR regime** (any one condition triggers):
- SPY price is below its 200-day SMA, OR
- VIX ≥ 30

**Regime actions:**
| Regime | New Buys | Existing Positions |
|--------|----------|--------------------|
| BULL | Allowed (proceed to Tier 2/1) | Normal exit rules apply |
| BEAR | Blocked | Exit if score drops below 25; hold dividend stocks (div_yield ≥ 3%) |

Regime is recomputed at the start of each `autotrader.run()` call.

### 8.3 Tier 2 — Quality + Mean Reversion Filter

**Universe restriction:** The autotrader operates exclusively on stocks in the personal watchlist (`watchlist` table, `is_active = 1`). Stocks from the Discover universe, any external source, or manually typed symbols are never traded automatically. If you want the autotrader to consider a stock, it must first be added to the watchlist via the "+ Add" button or "+ Watch" in Discover.

Only stocks passing **all three** of these criteria proceed to Tier 1:

1. **Quality gate** (fundamental health):
   - Score ≥ 50 on the existing 30+ signal engine (ensures minimum technical health)
   - At least one of: ROE > 15%, EPS growth > 10%, dividend yield > 1.5%, PE below sector avg
   - NOT a penny stock (price ≥ $5)
   - NOT an ETF or fund (`asset_type = 'stock'` only, unless explicitly whitelisted)

2. **Oversold filter** (mean reversion entry):
   - RSI < 55 (not overbought — room to run)
   - Price is not more than 5% above its 50-day SMA (not extended/overextended)

3. **Volume confirmation:**
   - Most recent bar: volume ≥ 1.0x 20-day average (minimum liquidity, not in decline)

### 8.4 Tier 1 — Entry/Exit Execution Rules

#### Entry Conditions (all must be met)

1. Score ≥ 65
2. At least 2 of the following technical confirmations:
   - RSI between 30 and 55
   - Price crossed above 50-day SMA within last 3 sessions
   - MACD bullish cross within last 5 sessions
   - Volume ≥ 1.3x 20-day average on an up day
3. **No existing position in this symbol** — if any shares of this symbol are currently held in Alpaca (regardless of how they were opened), no additional shares are purchased. This enforces diversification: one position per symbol, and a new stock must be selected instead.
4. Not already at max positions (default 8)
5. Sufficient buying power after 20% cash buffer
6. Not within 5 days of next earnings date (Finnhub calendar)
7. Market is open (9:35 AM – 3:45 PM ET)

#### Re-entry Rule

Once a position is **fully closed** (Alpaca reports qty = 0 for that symbol), the autotrader may repurchase that stock on any future run if the entry conditions are met again. There is no permanent blacklist — only the current-position check blocks re-entry.

#### Exit Conditions and Sell Quantity

Exit sells are **partial by default (50% of held shares)** to reduce impact from false signals and preserve upside on partial recoveries. The only exception is the hard stop-loss, which always exits the full position.

| Condition | Shares Sold | Rationale |
|-----------|-------------|-----------|
| Price closes 8%+ below entry price | **100% (full exit)** | Hard stop — capital preservation, no partial |
| Score drops below 25 | **50% (half exit)** | Signal deteriorating, reduce exposure |
| RSI > 75 | **50% (half exit)** | Overbought — take partial profit, let rest run |
| EMA 9 crosses below EMA 21 (≤3 sessions ago) | **50% (half exit)** | Short-term reversal signal — `ema9_bear_cross_ago` ≤ 3 |
| MACD turned bearish (just crossed below signal) | **50% (half exit)** | Momentum reversal confirmation |
| Held ≥ 30 calendar days with no gain | **50% (half exit)** | Time stop — capital not working, trim and reallocate |

**Note on manual positions:** The autotrader evaluates and may sell positions opened manually via the Buy button, not only positions it opened itself. Any position in Alpaca is subject to the exit rules once Autorun is ON.

**Rounding:** `floor(currentQty × 0.5)`, minimum 1 share. If result is 0 shares (e.g. holding only 1 share and half = 0.5), sell the full position instead.

#### Position Sizing

- `cashBuffer  = accountEquity × 0.20` (keep 20% always uninvested)
- `deployable  = max(0, (buyingPower − cashBuffer) × 0.50)` (deploy 50% of remaining power)
- `maxPerPos   = accountEquity × 0.10` (10% max per position)
- `perSlot     = min(deployable / openSlots, maxPerPos)`
- `shares      = floor(perSlot / currentPrice)`
- Minimum order: 1 share; if `perSlot < currentPrice`, position is skipped

#### Order Type

- **Entry orders:** Market orders during regular hours (9:35 AM – 3:45 PM ET)
- **Exit orders:** Market orders (prioritize execution over price)
- No extended hours orders in autorun mode

### 8.5 Risk Management Guardrails

These apply in both Autorun ON and OFF modes. The auto-trader checks these before placing any order.

| Rule | Limit |
|------|-------|
| Max open positions | 8 (configurable via system_config) |
| Max position size | 10% of account equity |
| Cash buffer | Always keep 20% uninvested |
| Max trades per day | 8 (resets at midnight ET) |
| Hard stop loss | 8% below entry — full exit, no partial |
| Partial exit sell | 50% of held shares for all other exit conditions |
| Watchlist-only | Only stocks in `watchlist` table (`is_active=1`) are eligible for auto-trade |
| One position per symbol | No adding to existing positions; diversify into a different stock |
| Re-entry after full close | Allowed once Alpaca qty = 0 for that symbol |
| Manually opened positions | Subject to exit rules once Autorun is ON |
| No earnings proximity | No buy within 5 calendar days of next earnings |
| Market hours only | 9:35 AM – 3:45 PM ET (entry and exit) |
| No short selling | Long-only |
| No options | Equities only |
| No same-day close | No buy and sell of same symbol within same trading day |
| No penny stocks | Price ≥ $5 required |
| Daily drawdown pause | If account drops 3% in one trading day, pause new buys for 48h |
| Evaluation timing | Turning Autorun ON never triggers immediate orders; first run is next 8:30 AM |
| Correlation limit | Avoid holding 2 stocks from same sector with correlation > 0.8 (aspirational v2) |

These guardrails are checked in `portfolio_app/autotrader.js` (new file) and reuse logic from `trader/guardrails.js` where possible.

### 8.6 Autorun OFF Mode (Recommendation)

**This is the current default behavior, formalized.**

When `autorun_enabled = '0'`:

1. `runDailyRefresh()` runs normally at 8:30 AM
2. All phases (price, fundamentals, analysis, universe scan) execute as usual
3. `stock_signals` table is populated with fresh scores
4. **Auto-trader evaluates** which trades would be triggered (runs through all 3 tiers) but does **not** place orders
5. Daily digest email includes a new section: **"Recommended Trades (Autorun OFF)"**
   - BUY recommendations: table of symbol / score / reason / suggested position size
   - SELL recommendations: table of held symbols with exit rationale
   - Footer note: "Autorun is OFF — these are recommendations only. Enable Autorun to execute automatically."

### 8.7 Autorun ON Mode (Auto-Execute)

When `autorun_enabled = '1'`:

**Execution flow** (runs at **9:35 AM ET** via separate cron, after morning data is fresh):

```
autotrader.run()   [9:35 AM ET Mon–Fri only; never on toggle or mid-day]
  │
  ├── 0. Check autorun_enabled = '1' and 9:35–15:45 ET market window
  │       (returns null / no-op if either fails)
  │
  ├── 1. Check Tier 3: market regime from stock_signals (SPY above_200ma)
  │       ├── BEAR → skip all buys; exit logic still runs
  │       └── BULL → proceed to exits and entries
  │
  ├── 2. Evaluate exit conditions for ALL current Alpaca positions
  │       (includes manually opened positions)
  │       ├── Price 8%+ below entry              → sell 100% (hard stop)
  │       ├── Score < 25                         → sell 50%
  │       ├── RSI > 75                           → sell 50%
  │       ├── ema9_bear_cross_ago ≤ 3 sessions   → sell 50%
  │       ├── MACD turned bearish                → sell 50%
  │       ├── Held ≥ 30 calendar days, no gain   → sell 50%
  │       └── For each triggered condition: place market sell order
  │
  ├── 3. Check entry conditions for watchlist stocks (is_active=1) only
  │       ├── Skip any symbol already held (qty > 0 in Alpaca)
  │       ├── Tier 2: score ≥50, price ≥$5, RSI ≤65, not >8% above 50MA
  │       ├── Tier 1: score ≥65, ≥2 technical confirmations
  │       ├── Guardrails: max 8 positions, 20% cash buffer, earnings ≥5d away
  │       └── Size position → place market buy order
  │
  └── 4. Return results → sendAutotraderEmail(results)
          → every decision recorded in autotrader_trades table
          → every order logged to system_log
```

**Note:** The 8:30 AM pipeline always calls `evaluate(false)` (recommendations only, no orders). The 9:35 AM cron is the only place orders are placed.

**Logging:** Every decision (buy, sell, skip + reason) logged to `autotrader_trades` and `system_log` source=`'autotrader'`.

### 8.8 Trade Notifications (Email)

**When Autorun is ON** — daily digest email gains a new section:

**"Today's Auto-Trades"**
- Buys executed: Symbol | Shares | Price | Est. Cost | Reason (top 3 signals)
- Sells executed: Symbol | Shares Sold | % of Position | Price | Proceeds | Exit Reason
- Skipped (guardrail blocked): Symbol | Reason blocked (e.g. "already held", "earnings in 3 days")
- If no trades: "No trades executed today — no signals met all 3 tiers"

**On any order error** — immediate error alert email:
- Subject: `⚠️ Autotrader Error — {symbol} {side} failed`
- Body: symbol, order details, error message, account state

**On Autorun mode change:**
- Subject: `🤖 Autorun {turned ON / turned OFF}`
- Body: timestamp, who triggered it, current positions list

---

## 9. Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| Dashboard load time | < 3s for full page render |
| Refresh pipeline duration | < 15 min for 113 symbols |
| Order placement latency | < 5s from decision to Alpaca API call |
| Uptime | systemd restart-on-failure; auto-start on boot |
| Email delivery | < 5 min after refresh completes |
| Data freshness | Price data ≤ 1 trading day old |
| Fundamentals freshness | Refreshed daily; upgrades weekly |

---

## 10. Known Issues & Constraints

1. **Finnhub `/stock/price-target` returns 403** — this is a paid feature. Workaround: use Yahoo Finance `yf.quote()` fields `targetMeanPrice`, `targetHighPrice`, `targetLowPrice` (free, zero extra calls).
2. **Yahoo Finance rate-limits after ~10 rapid requests** — clears in 30–60 min. Mitigated by 800ms delay and `withRetry()` with exponential backoff.
3. **VIXY proxy for VIX is approximate** — formula: `VIXY × 1.8 + 2 ≈ VIX`. Acceptable for regime filter (not used for precise values).
4. **price_history only stores ~380 days** — 2Y/5Y gains show `—` in the table. Chart modal fetches from Alpaca on-demand (any period).
5. **No sector correlation check implemented yet** — the correlation guardrail in §8.5 is aspirational for v1; skip if correlation data not readily available.
6. **Alpaca paper mode** — all orders go to paper account by default. Set `ALPACA_BASE_URL` to live URL in `.env` to go live.
7. **No intraday monitoring** — auto-trader only runs once at 8:30 AM. Stop-loss is checked on next day's open price, not intraday. This is intentional (swing trading, not day trading).

---

## 11. Design Decisions (Do Not Reverse Without Discussion)

1. **Human approval always available** — the Autorun OFF mode is the default and must remain functional even when Autorun ON is active. The toggle must be reachable in one click from the dashboard header.
2. **Plain `<a href>` for navigation-critical actions** — Approve, Reject, Toggle Autorun, Scan Now, Refresh Now, Add/Remove ticker. No JS onclick for these. Learned from production failures.
3. **No day trading** — hold period minimum is 1 trading day (no same-day close). Time stop fires at 30 calendar days with no gain — reduce (50% sell), don't fully exit. Sweet spot is 5–20 day swing holds.
4. **No margin, no borrowing** — instant settlement only. Cash buffer 20% enforced.
5. **Exit-first philosophy** — in `autotrader.run()`, exits are evaluated before entries. Freeing up capital takes priority.
6. **All 3 tiers must agree** — a trade only executes when Regime (T3) + Quality/Oversold (T2) + Technical entry (T1) all pass. One tier veto blocks the trade.
7. **Scoring engine unchanged** — the auto-trader is a consumer of `stock_signals`, not a replacement. The existing 30+ signal engine continues to run unchanged; the auto-trader adds gating logic on top.
8. **MySQL JSON column guard** — `plan_json` and `reasons` columns are returned as already-parsed objects by mysql2. Always guard: `typeof row.col === 'string' ? JSON.parse(row.col) : row.col`.
9. **Paper mode default** — `ALPACA_BASE_URL` defaults to paper URL in `.env`. Autorun ON in paper mode is safe for testing.
10. **Anti-churn** — never sell a position unless the exit condition is clearly triggered. Score drift alone (score going from 60 to 45) does not trigger a sell — threshold is score < 25.
11. **Watchlist is the autotrader's universe** — the autotrader never trades a stock that is not in the personal watchlist. Adding a stock to the watchlist is the explicit human act of authorising the autotrader to consider it.
12. **One position per symbol, no averaging down** — if a symbol is held (any qty > 0 in Alpaca), the autotrader will not buy more of it regardless of score. A fresh slot must open (via exit or at capacity) before a new buy is placed. This prevents concentration risk and forces diversification across the watchlist.
13. **Partial exits by default** — selling half on non-stop-loss conditions preserves upside on positions that recover. The hard stop (8% below entry) is the only full-exit trigger because capital preservation overrides upside preservation in a loss scenario.
14. **Re-entry is permitted** — once fully out (qty = 0), a stock can be repurchased. No permanent blacklists. The scoring engine decides whether conditions warrant re-entry.
15. **Manual positions inherit exit rules on Autorun ON** — the autotrader does not distinguish between positions it opened and positions opened manually. Once Autorun is ON, all held positions are subject to exit conditions at the next 8:30 AM run.
16. **No immediate execution on toggle** — turning Autorun ON mid-day triggers no immediate orders. This prevents unintended trades on stale intraday data and gives the user time to reconsider before the next market open.
