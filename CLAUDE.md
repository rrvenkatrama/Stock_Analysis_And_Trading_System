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
9. **Phoenix buying DISABLED** — Phoenix screener runs but auto-buys are off; user manually adds via + Watch then buys from Stocks tab
10. **Buy buttons only on Stocks tab** — Discover, Phoenix, Long Haul have + Watch / News only
11. **position_flags controls per-position autotrader** — do not remove this system
12. **SMA 50/200 primary, EMA 50/200 secondary** — golden cross uses SMA (institutional standard, fewer false signals); EMA tracked as early-warning confirmation

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

## Autotrader — Manual Buy Interaction
When user manually buys via the Buy button while autotrader is ON:
- Autotrader has NO pre-trade awareness of manual buys
- **EXIT EVALUATION APPLIES**: next 9:35 AM run evaluates ALL positions (including manual) — will soft-exit (50%) or hard-stop (-8%) if exit rules trigger
- Manual positions count against maxPositions limit
- 30-day time stop does NOT apply to manual buys (getDaysHeld() reads autotrader_trades only, returns null → skip)

## Autotrader — Why High-Score Stocks May Not Be Selected
1. Signal data at 9:35 AM = 8:30 AM snapshot. Manual refresh after 8:30 changes scores but autotrader already ran.
2. Tier 2 blocks: >8% above 50MA (e.g. TWLO currently 12% above → blocked)
3. Tier 1 RSI window is 30–55, NOT just ≤65 (RSI=58 fails Tier 1 RSI confirmation)
4. Slots fill in score-DESC order — bot stops when maxPositions reached

## Known Issues (April 2026)
1. Finnhub price target returns 403 (paid feature) — gracefully handled, targetMean = null
2. VIXY proxy for VIX is approximate (VIXY × 1.8 + 2 ≈ VIX)
3. Yahoo Finance rate-limits after ~10 rapid requests (clears in 30-60 min)
   — sector/name now from Finnhub (fixed 2026-04-16) so rate-limit no longer blocks core data
   — price targets still Yahoo-only; COALESCE protects once populated
4. analyst_upgrades table populates weekly — will be empty until next weekly pass
5. VIXY/SPY must be in watchlist for VIX sizing and 50MA gate to work

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

### My Stocks — Position Flags (Autotrader per Position)
New DB table `position_flags (symbol PK, autotrader_on TINYINT, updated_at DATETIME)`.
- Alpha autotrader buys → sets flag=1
- Manual buy (new position) → sets flag=0 in /order POST route
- Manual buy (existing position) → flag unchanged
- Autotrader exit/manage → only runs for flag=1 positions
- Phoenix buying disabled (return before Phase 2 in phoenix_autotrader.js)
- Portfolio UI: ⚡ AT: ON / AT: OFF toggle → GET /position/:symbol/toggle-autotrader
- Alpha buy: skips symbols already in portfolio (regardless of flag)

### My Stocks — Portfolio Section
- **No recommended portfolios** — replaced with live Alpaca positions + open orders
- Positions table: Symbol | Autotrader | Signal·Price | Qty | Avg Entry | Current | Mkt Value | P&L | Trade
- Trade column: "Buy More" button (opens buy modal) + "Sell" button (opens sell modal)
- Open orders table with Cancel button
- Buy modal: market/limit/qty/TIF/extended hours, shows paper/live mode badge, available funds, live cost estimate
- Sell modal: mirrors buy modal on the sell side

### My Stocks — Long Haul Tab (added session 5)
Filters stock_signals (watchlist only) for: div_yield>0, pct_from_52high≤-20, (pe_trailing<35 OR pe_forward<28), beta<1.5.
Sorted by dividend yield desc. Columns: Symbol, Price/Chg, Div Yield, vs 52wk High, P/E, Fwd P/E, Beta, Signal, Sector.
No Buy button (stocks are already in Stocks list). News + Chart popup only.

### My Stocks — Tab Buy Rules
- **Stocks tab**: ONLY tab with Buy button. This is the single entry point for manual buys.
- **Discover tab**: + Watch + News only. No Buy.
- **Phoenix tab**: + Watch + News only. No Buy.
- **Long Haul tab**: News + Chart only. No Buy, no Watch (already in watchlist).
To buy from any non-Stocks tab: use + Watch first, then buy from Stocks tab.

### My Stocks — Watchlist Protection (Session 6)
- Cannot remove a stock from watchlist if it's currently in the portfolio (Alpaca positions)
- Attempting removal shows error page: "Sell your position first, then remove it from the watchlist"
- Protects against accidental watchlist removal while holding the position
- Check enforced server-side against live Alpaca positions

### My Stocks — Chart Popup
Ticker click → window.open Yahoo Finance (1200×750 popup window).
`function openTVChart(sym)` uses `window.open('https://finance.yahoo.com/chart/' + sym, ...)`
Yahoo Finance saves chart layout (indicators, colors) in browser localStorage after first setup.
TradingView iframe/widget approaches were tried and abandoned — iframe blocked, colors not customizable.

### My Stocks — Golden Cross Star Column (Session 6)
First column in all tabs shows 3-state golden cross indicator:
- **⭐ pulsing glow** — SMA golden cross within last 5 days (momentum breakout, strong buy signal)
- **★ solid gold** — active golden cross (50SMA > 200SMA, >5 days ago)
- **☆ faint grey** — no golden cross or death cross active
- **🟢 flashing green** — approaching golden cross (gap <2.5%) + EMA already bullish (early confirmation)

EMA 50/200 tracked as secondary confirmation — when EMA crosses before SMA, it signals trend shift starting.

### My Stocks — Autotrader Eligibility Badge (Session 6)
Stocks tab shows smart status badge with auto-trade eligibility:
- **✓ Eligible** (dark green) — passes all autotrader gates right now
- **⚠ Blocked [?]** (amber) — one or more gates failing; click **?** to see exactly which ones
- **🚫 No Pick** (red) — user manually excluded

The **?** popup lists all blocking conditions in priority order:
- Market regime (BEAR/CAUTION blocks all entries)
- Score threshold (≥65 required)
- RSI window (30–65 required)
- Overextension (≤8% above 50DMA)
- Tier 1 confirmations (need ≥2 of: RSI in 30–65, MACD bullish, above 50MA, volume ≥1.3x)

Conditions checked at 9:35 AM using 8:30 AM snapshot data.

### My Stocks — Discover Section
- Scans ~204-stock universe (S&P 100 + popular NASDAQ + sectors) for BUY signals not in watchlist
- Technical-only scoring (no Finnhub fundamentals for non-watchlist stocks)
- "+ Watch" button instantly adds stock to watchlist (fetches full data on next morning refresh)
- "Buy" button opens buy modal directly from Discover
- /scan-universe route triggers manual scan
- portfolio_app/universe.js: UNIVERSE array + scanUniverse() + getTopPicks()

### My Stocks Scoring (portfolio_app/analyzer.js)
Signal-count based: Score = (positive_signals - negative_signals) / max(5, total_signals) × 100
BUY >50 | HOLD 20–50 | SELL ≤20 (score can be negative)

**MA signals (50 vs 200 SMA):**
- Golden cross today: +20 | ≤5 sessions ago: +14 | active (50>200): +8
- Death cross ≤5 sessions: −20 | active (50<200): −8
- Price crossed above 200MA (≤5d): +18 | above 50MA (≤5d): +15
- Above 200MA: +8 | above 50MA only: +6 | below 50MA: −8 | below 200MA: −10

**Overextension above 50DMA (Session 6 — poor entry risk):**
- 10–15% above 50DMA: −5 (stretched entry)
- 15–25% above 50DMA: −10
- >25% above 50DMA: −15 (mean-reversion risk)

**EMA 9/21 short-term signals (swing entry timing):**
- EMA 9 just crossed above EMA 21 (≤1 session): +12
- EMA 9/21 bull cross 2–5 sessions ago: +8
- EMA 9 above EMA 21 (sustained): +4 | EMA 9 below EMA 21: −5
- EMA 9 crossed below EMA 21 (≤3 sessions): −10
- Full EMA stack (price > EMA9 > EMA21 > EMA50): +10 | full bearish stack: −10

**EMA 50/200 secondary confirmation (Session 6):**
- Tracked separately from SMA 50/200 (primary for golden cross)
- EMA bullish cross: early warning signal (~2 days before SMA)
- Shown in star column as 🟢 green flashing when approaching golden cross + EMA already crossed
- Visible in dashboard to show when momentum is shifting before official SMA cross

**Volume confirmation:**
- Price up + volume ≥1.5x 20-day avg (institutional buying): +10
- Price down + volume ≥1.5x avg (heavy selling): −8
- Price up + volume 1.2–1.5x avg: +4

**RSI (14-period):**
- RSI < 30 (oversold): +1 signal | 30–45 (recovering): +1 signal
- RSI 45–65 (neutral): no signal | RSI ≥ 65 (overbought): −1 signal

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
