# StockTrader — Claude Instructions

## Project Summary
Swing trading research and execution system. Node.js 20 + MySQL 8.4 + Alpaca broker API.
Runs on mini PC at 192.168.1.156 as a systemd user service, **port 3001**.
See CONTEXT.md for full architecture. See plan.txt for current status and next steps.

## ALWAYS read plan.txt first when resuming this project
It contains the current state, known issues, and exactly what to do next.

## Key Design Decisions (do not reverse without discussion)
1. **Human approves every trade** — never place orders without user clicking Approve
2. **Margin account, no borrowing** — instant settlement only, zero margin interest
3. **Anti-churn** — never recommend selling unless 20+ point score difference
4. **Paper mode default** — ALPACA_BASE_URL defaults to paper URL
5. **Cash buffer 20%** — always keep uninvested (enforced in guardrails.js)
6. **Probability cap 85%** — never show false confidence
7. **Always use provider.js** — never call data modules directly from scanner
8. **Plan-level approval** — user approves the whole daily plan, not individual stocks

## UI / Interactivity Rules (learned from production bugs)
- **NO JavaScript for navigation-critical actions** — Approve, Reject, and Scan Now are all plain `<a href>` links, not JS onclick buttons. JS has proven unreliable in this dashboard.
- Approve Plan → `GET /plan/:id/approve-now`
- Reject Plan → `GET /plan/:id/reject-now`
- Scan Now → `GET /scan-now`
- Only use JS for non-critical UI (modals, score bars, etc.)

## MySQL JSON Column Gotcha
`plan_json` and `reasons` in the DB are MySQL JSON columns. The mysql2 driver returns them as **already-parsed JavaScript objects**, not strings. Never call `JSON.parse()` on them directly — always guard:
```js
const data = typeof row.col === 'string' ? JSON.parse(row.col) : row.col;
```

## Data Source Architecture
All data fetching goes through data/provider.js which routes based on
runtime config stored in MySQL system_config table.

Switch sources at runtime (no restart needed):
```js
require('./config/sources').setSource('fundamentals', 'finnhub')
```
Or via dashboard: /settings page

Current working stack:
- priceData: alpaca (Alpaca Market Data API — fast, free, uses existing keys)
- fundamentals: finnhub (Yahoo rate-limited our IP — Finnhub as primary)
- marketContext: alpaca
- vix: yahoo (with VIXY proxy fallback)
- news: finnhub
- sentiment: stocktwits

## Yahoo Finance Rate Limiting
Yahoo Finance blocks our IP after ~10-15 rapid requests.
- Clears after 30-60 min of no requests
- Retry logic in data/yahoo.js withRetry() handles it
- Switch to finnhub via sources.js when blocked
- Do NOT run multiple test scans in quick succession

## File Map
```
server.js              → Express, all routes, HTML, startup
config/env.js          → All config from .env
config/params.js       → All scoring/risk params — DB-backed, editable via /settings
config/sources.js      → Runtime source switching (reads/writes system_config table)
db/schema.sql          → All 9 MySQL tables including system_config + portfolio_plans
db/db.js               → MySQL pool helpers
db/setup.js            → One-time DB init
data/provider.js       → UNIFIED ROUTER — always use this in scanner
data/alpacaData.js     → Alpaca Market Data (primary price source)
data/yahoo.js          → Yahoo Finance quote() + historical() + withRetry()
data/finnhub.js        → Fundamentals, analyst, earnings, news
data/sentiment.js      → StockTwits, Alpha Vantage NLP, Fear&Greed, Reddit
data/institutional.js  → SEC 13F, Dataroma superinvestors, Finviz
data/marketContext.js  → SPY/QQQ/VIXY analysis, market health score
analysis/technicals.js → RSI, MACD, Bollinger, golden/death cross, ATR
analysis/scorer.js     → Composite score + probability + VIX-adaptive threshold
screener/universe.js   → 30 symbols (expand when Polygon upgraded)
screener/scan.js       → Batch scanner, uses provider.js
trader/portfolio.js    → Daily plan builder (BUY/HOLD/EXIT/SWAP logic, anti-churn)
trader/guardrails.js   → All pre-trade safety checks
trader/executor.js     → Alpaca order placement + position sync
scheduler/cron.js      → Pre-market, midday, 5min sync, EOD (ET timezone)
notifier/email.js      → All email types (Gmail SMTP confirmed working) incl. sendDailyDigest()
stocktrader.service    → systemd unit file
stock_trader_v1.html   → Full system documentation (open in browser)
portfolio_app/yahoo_history.js → Watchlist mgmt, Alpaca bar fetch, Finnhub+Yahoo fundamentals
portfolio_app/analyzer.js      → Scoring engine (30+ signals, 0–100, BUY/HOLD/SELL + why)
portfolio_app/universe.js      → ~204-stock discovery universe, scanUniverse(), getTopPicks()
portfolio_app/scheduler.js     → 8:30 AM ET cron: refresh → analyze → universe scan → email
```

## Scoring Weights (analysis/scorer.js W object)
- Technical: 35%
- Fundamental: 25%
- Institutional: 20%
- Sentiment: 20%
- Market context: applied as point adjustment after weighting

## VIX-Adaptive Thresholds (scorer.js + params.js)
Thresholds automatically drop in fear markets — no .env changes needed:
- VIX ≥ 40 (extreme): base threshold − 20 pts
- VIX ≥ 30 (high): base threshold − 12 pts
- VIX ≥ 25 (elevated): base threshold − 6 pts

## Position Sizing (portfolio.js)
Uses ACTUAL Alpaca account equity (account.equity || account.portfolio_value), NOT params.account_size.
- maxPerPosition = accountEquity × max_position_pct (10%)
- deployable = buyingPower × portfolio_deploy_pct (50%)
- perSlot = min(deployable / openSlots, maxPerPosition)

## Known Issues (April 2026)
1. Finnhub price target returns 403 (paid feature) — gracefully handled, targetMean = null
2. VIXY proxy for VIX is approximate (VIXY × 1.8 + 2 ≈ VIX)
3. Yahoo Finance rate-limits after ~10 rapid requests (clears in 30-60 min)

## Guardrails (trader/guardrails.js — do not weaken)
- Max 4 trades/day, max 4 open positions
- Max 10% account per position, 5% stop loss
- No same-day close, no short selling, no options
- Market hours 9:35 AM – 3:45 PM ET only
- No buy within 5 days of earnings

## API Keys (.env)
- ALPACA: paper mode, account PA3S20RQWZGU, $100K paper capital
- POLYGON: hFzwnX... (free tier, 5 req/min — not primary)
- FINNHUB: d7cou5... (free, 60 req/min — primary fundamentals)
- ALPHA_VANTAGE: 9N8N9K... (free, 25 req/day — sentiment only)
- EMAIL: rrvenkatrama@gmail.com send+receive, app password set

## Database
- Host: 192.168.1.156, User: stocktrader, DB: stocktrader, Password: stocktrader123
- 9 swing trader tables: scan_sessions, candidates, trades, positions,
            daily_stats, news_cache, system_log, system_config, portfolio_plans
- 3 My Stocks tables: watchlist, price_history, stock_signals
  (portfolio_recs removed — replaced by live Alpaca positions)

## My Stocks Dashboard (port 8081)
Second dashboard — personal watchlist research + discovery, separate from swing trader.
- Service: stocktrader_portfolio.service (systemd user service, **port 8081**)
- Dashboard: http://192.168.1.156:8081/
- Entry point: server_portfolio.js
- Modules: portfolio_app/ (yahoo_history.js, analyzer.js, universe.js, scheduler.js, seed_symbols.js)
- Price history: Alpaca getDailyBars() — no rate limits, parallel batches of 5
- Fundamentals: Finnhub getFundamentals() + getAnalystRatings() (2 calls/symbol, 1200ms delay) + Yahoo quote() enrichment
- ~113 personal watchlist stocks + ~204-stock discovery universe
- Refresh schedule: 8:30 AM ET Mon–Fri
  - Phase 1: Alpaca history (parallel, fast)
  - Phase 2: Finnhub + Yahoo fundamentals (serial, 1200ms/symbol)
  - Phase 3: analyzeAll() — score all watchlist symbols
  - Phase 4: scanUniverse() — score discovery universe, find new BUY candidates
  - Phase 5: sendDailyDigest() email

### My Stocks — Portfolio Section
- **No recommended portfolios** — replaced with live Alpaca positions + open orders
- Positions table: Symbol | Signal·Price | Qty | Avg Entry | Current | Mkt Value | P&L | Trade
- Trade column: "Buy More" button (opens buy modal) + "Sell" button (opens sell modal)
- Open orders table with Cancel button
- Buy modal: market/limit/qty/TIF/extended hours, shows paper/live mode badge, available funds, live cost estimate
- Sell modal: mirrors buy modal on the sell side

### My Stocks — Discover Section
- Scans ~204-stock universe (S&P 100 + popular NASDAQ + sectors) for BUY signals not in watchlist
- Technical-only scoring (no Finnhub fundamentals for non-watchlist stocks)
- "+ Watch" button instantly adds stock to watchlist (fetches full data on next morning refresh)
- "Buy" button opens buy modal directly from Discover
- /scan-universe route triggers manual scan
- portfolio_app/universe.js: UNIVERSE array + scanUniverse() + getTopPicks()

### My Stocks Scoring (portfolio_app/analyzer.js)
Score 0–100 clamped. BUY ≥50 | HOLD ≥10 | SELL <10

**MA signals (50 vs 200 SMA):**
- Golden cross today: +20 | ≤5 sessions ago: +14 | active (50>200): +8
- Death cross ≤5 sessions: −20 | active (50<200): −8
- Price crossed above 200MA (≤5d): +18 | above 50MA (≤5d): +15
- Above 200MA: +8 | above 50MA only: +6 | below 50MA: −8 | below 200MA: −10

**EMA 9/21 short-term signals (swing entry timing):**
- EMA 9 just crossed above EMA 21 (≤1 session): +12
- EMA 9/21 bull cross 2–5 sessions ago: +8
- EMA 9 above EMA 21 (sustained): +4 | EMA 9 below EMA 21: −5
- EMA 9 crossed below EMA 21 (≤3 sessions): −10
- Full EMA stack (price > EMA9 > EMA21 > EMA50): +10 | full bearish stack: −10

**Volume confirmation:**
- Price up + volume ≥1.5x 20-day avg (institutional buying): +10
- Price down + volume ≥1.5x avg (heavy selling): −8
- Price up + volume 1.2–1.5x avg: +4

**RSI (14-period):**
- RSI <30 (deeply oversold): +10 | 30–45 (recovering): +15
- 45–60 (neutral-bullish): +5 | >70 (overbought): −15

**MACD (12/26/9):**
- Bullish cross ≤1 session: +12 | 2–5 sessions ago: +7
- MACD above signal (trend up): +4 | below signal (trend down): −4

**Valuation (stocks only, sector-relative):**
- Trailing/fwd PE 40%+ below sector avg: +12 | 20–40% below: +8 | 10–20% below: +5 | 30%+ above: −6
- Forward PE < trailing PE (earnings accelerating): +8
- P/S ratio (fallback when no PE): 40%+ below sector: +8 | 20–40% below: +5 | 50%+ above: −4
- PEG <1 (undervalued vs growth): +10 | 1–2 (fair value): +5 | >3 (expensive): −5

**Fundamental quality (Finnhub 3Y data):**
- EPS growth >20%: +8 | 10–20%: +4 | negative: −6
- Revenue growth >15%: +6 | 5–15%: +3
- ROE >20%: +6 | 10–20%: +3 | negative: −3
- Debt/equity <0.3: +4 | >2.0: −4

**Income:**
- Dividend yield ≥5%: +12 | ≥3%: +8 | ≥1.5%: +4 | ≥0.5%: +2

**Analyst consensus (≥3 analysts required):**
- Finnhub buy/sell/hold counts: ≥70% buy: +10 | ≥50% buy: +6 | ≥40% sell: −8
- Yahoo recommendationMean (1=Strong Buy→5=Strong Sell, ≥5 analysts):
  mean ≤1.5: +7 | ≤2.0: +4 | ≥4.0: −5

**Short interest (Yahoo Finance):**
- >20% short + price rising (squeeze potential): +6
- >30% short + price falling (bears winning): −4

**Market context (computed from SPY in price_history):**
- SPY above 200MA + MACD bullish: +5 (global bullish)
- SPY below 200MA: −5 (global bearish)

### My Stocks — Watchlist DB Columns
```sql
watchlist: symbol, name, sector, asset_type, is_active,
           pe_trailing, pe_forward, div_yield, ps_ratio,
           analyst_buy, analyst_sell, analyst_hold,
           eps_growth, revenue_growth, debt_equity, roe, beta, short_float,
           rec_mean, rec_count,
           fundamentals_at
```

### My Stocks Data Architecture
```
Price history  → alpacaData.getDailyBars() — fast, no rate limits, stored in price_history
PE / dividend  → finnhub.getFundamentals() — peBasicExclExtraTTM, currentDividendYieldTTM
Analyst counts → finnhub.getAnalystRatings() — totalBuy, totalSell, hold
Growth/quality → finnhub.getFundamentals() — epsGrowth3Y, revenueGrowth3Y, roe, debtEquity, beta
Name/sector    → finnhub.getProfile() — primary source (reliable); Yahoo is fallback enrichment only
Short interest → yahoo-finance2 quote() — shortPercentOfFloat
Rec consensus  → yahoo-finance2 quote() — recommendationMean, numberOfAnalystOpinions
Price targets  → yahoo-finance2 quote() — targetMeanPrice, targetHighPrice, targetLowPrice
FUND_DELAY     → 2000ms between symbols (3 Finnhub calls/symbol run in parallel via Promise.allSettled)
COALESCE       → watchlist and stock_signals UPDATEs use COALESCE so Yahoo null never overwrites good data
```

### Deployment for My Stocks
```bash
# Sync changed files
scp <file> rajramani@192.168.1.156:~/stocktrader/portfolio_app/<file>
scp server_portfolio.js rajramani@192.168.1.156:~/stocktrader/

# Restart service
ssh rajramani@192.168.1.156 "systemctl --user restart stocktrader_portfolio && sleep 3 && systemctl --user status stocktrader_portfolio --no-pager"
```

## Deployment to Mini PC (swing trader)
```bash
# Sync changed files
scp <file> rajramani@192.168.1.156:~/stocktrader/<path>

# Restart service
ssh rajramani@192.168.1.156 "systemctl --user restart stocktrader && sleep 3 && systemctl --user status stocktrader --no-pager"
```
