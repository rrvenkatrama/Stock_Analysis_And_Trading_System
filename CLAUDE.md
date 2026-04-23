# StockTrader: Claude Code Instructions

**Project**: Swing trading research and execution system  
**Stack**: Node.js 20 + MySQL 8.4 + Alpaca broker API + Anthropic Claude API  
**Deployment**: Mini PC at 192.168.1.156, systemd user services (ports 3001 & 8081)  
**Version**: 3.0

---

## Before Starting Any Session

1. **Read SCORING_METHODOLOGY.md** — All signal weights, thresholds, Layer 4 logic
2. **Read this file** — Project rules and architecture
3. **Check plan.txt** — Current state and known issues
4. **Check memory/** — Recent session notes

---

## Key Design Decisions (Do NOT Reverse)

### Trading Rules (Non-Negotiable)
1. **Human approves every trade** — Never place orders without user Approve button
2. **Margin account, no borrowing** — Instant settlement only; zero margin interest
3. **No shorting** — Paper account has shorting disabled; handle API errors gracefully
4. **Paper mode default** — ALPACA_BASE_URL defaults to paper trading
5. **Cash buffer 20%** — Always keep ≥20% of total equity as cash floor
6. **Daily spend cap 25%** — Deploy at most 25% of spendable cash (cash minus 20% floor) per day
7. **Max 5 new tickers/day** — New position entries only; adding to existing positions doesn't count
8. **Claude ranks new buys** — Top-10 eligible candidates sent to Claude Haiku; Claude picks 1-5 to buy
9. **No LLM for sells** — All exit decisions are pure rule-based (4-layer algorithm)
10. **Probability cap 85%** — Never show false confidence; max 85% probability

### System Architecture (Core)
7. **Use provider.js for all data** — Never call data modules (yahoo, finnhub, alpaca) directly from scanner
8. **Plan-level approval** — User approves whole daily plan, not individual stocks
9. **Signal weights configurable** — Change via database; no code hardcoding
10. **Layer 4 overrides buy signals** — ≥3 bearish conditions force SELL despite high score
11. **Position flags per stock** — `position_flags.autotrader_on` controls per-position AT logic
12. **SMA 50/200 primary** — Golden cross uses SMA (institutional standard, fewer false signals)
13. **EMA 50/200 secondary** — Early warning; shows when SMA cross is coming

### UI/UX Rules
14. **Navigation actions are plain `<a href>` links** — Approve, Reject, Scan Now NOT buttons
    - Approve Plan → `GET /plan/:id/approve-now`
    - Reject Plan → `GET /plan/:id/reject-now`
    - Scan Now → `GET /scan-now`
15. **Buy button ONLY on Stocks tab** — Discover and Long Haul have + Watch / News only
16. **No JavaScript for critical actions** — Links, not onclick buttons (proven unreliable)
17. **My Stocks tabs have separate functions**:
    - **Stocks**: Watchlist + live Alpaca positions, BUY button, full analysis
    - **Discover**: ~204-stock universe, BUY button direct, + Watch button
    - **Long Haul**: Dividend stocks, no Buy (already in Stocks), News + Chart only
    - **Transactions**: Buy/sell history with prices, reasons, totals

### MySQL JSON Gotcha
18. **Never `JSON.parse()` on json columns** — mysql2 driver returns already-parsed objects:
    ```javascript
    // WRONG: causes double-parse error
    const data = JSON.parse(row.plan_json);
    
    // RIGHT: check type first
    const data = typeof row.plan_json === 'string' ? JSON.parse(row.plan_json) : row.plan_json;
    ```

---

## Scoring System (Critical for All Changes)

**Read SCORING_METHODOLOGY.md for complete detail.**

### Quick Rules
- **Signal weights**: Fully configurable in `signal_weights` table (any value: +3, -2.5, etc.)
- **Score formula**: `(Σ positive - Σ |negative|) / max(5, total) × 100`
- **Recommendations**:
  - BUY: score > 50
  - HOLD: 20 ≤ score ≤ 50
  - SELL: score < 20
- **RSI overbought threshold**: 70 (changed from 65 on 2026-04-22)
- **Layer 4 override**: ≥3 of 5 momentum conditions → FORCE SELL
- **Golden cross pulsing window**: reads from `pulsing_glow_days` in settings (not hardcoded)
- **settingsCache must reload** before analyzer runs (batch scripts must call `await settingsCache.reloadSettings()`)

---

## Database Schema

### Key Tables
```
watchlist              — ~113 personal stocks (active=1/0, pick_flag, autotrader_on)
stock_signals          — Latest score/recommendation for each watchlist stock
price_history          — Daily bars (symbol, date, open/high/low/close/volume)
position_flags         — Per-stock autotrader ON/OFF toggle
signal_weights         — Configurable signal weights (database-backed scoring)

autotrader_trades      — Executed orders (symbol, action, qty, price, entry_reason, exit_reason,
                         claude_rank, claude_confidence, claude_reasoning, claude_market)
```

### Critical Columns
- **watchlist.pick_flag** = 1/0 (user manually included/excluded from autotrader)
- **position_flags.autotrader_on** = 1/0 (autotrader can manage this position)
- **stock_signals.chg_1d, chg_1m, chg_ytd, chg_1y** = Period returns (calculated by analyzer)
- **autotrader_trades.claude_rank** = Claude's ranking (1=top pick) for buy decisions
- **autotrader_trades.claude_reasoning** = Claude's explanation for buying this stock

---

## Data Sources & Rate Limits

### Current Working Stack
- **Price data**: Alpaca (fast, no limits, existing keys)
- **Fundamentals**: Finnhub (primary; Yahoo blocks after ~10-15 rapid requests)
- **Market context**: Alpaca + SPY in watchlist
- **VIX**: Yahoo (VIXY proxy fallback: VIX ≈ VIXY × 1.8 + 2)
- **News**: Finnhub
- **Sentiment**: StockTwits

### Rate Limits
- **Yahoo Finance**: Blocks IP after ~10-15 rapid requests; clears after 30-60 min
- **Finnhub**: 60 req/min free tier; 2000ms delay between symbols recommended
- **Alpaca**: No rate limits for market data
- **Polygon**: Free tier 5 req/min (NOT primary; backup only)

### Refresh Schedule (8:30 AM ET Mon-Fri)
1. Alpaca price history (parallel batches of 5, fast)
2. Finnhub + Yahoo fundamentals (serial, 1200ms/symbol)
3. Analyzer: Score all watchlist stocks
4. Universe scan: Find BUY candidates not in watchlist
5. Email digest

---

## Autotrader Position Management

### Buy Flow (at 9:35 AM ET) — v3.0 with Claude AI

**Capital guardrails (checked first):**
- Cash floor: always keep ≥20% of total equity
- Daily spend cap: 25% of (cash − floor). E.g. $100K equity, $60K cash → $40K spendable → $10K cap today
- Max 5 new ticker symbols per day (tracked via today's buys in autotrader_trades)
- Max 15 total open positions

**Candidate selection:**
1. Fetch top-10 BUY-rated stocks: pick_flag=1, NOT already in portfolio, sorted by score DESC
2. Skip any with earnings within 5 days (Finnhub earnings check)

**Claude advisory (portfolio_app/claude_advisor.js):**
3. Send all 10 candidates to Claude Haiku 4.5 with:
   - Market context: regime, VIX, Fear & Greed, SPY status
   - Full signal breakdown per stock: every bullish/bearish signal with weight
   - All 5 Layer 4 conditions explicitly listed as met/not met
4. Claude returns ranked JSON: symbols_to_buy[], rankings[], market_assessment
5. Fallback to top-5-by-score if Claude fails or returns bad JSON

**Execution:**
6. Buy Claude's picks in ranked order (rank 1 first)
7. Position size = daily cap ÷ number of picks (equal split), capped at 10% equity per position
8. Stop when daily cap exhausted or 5 new tickers bought today

### Buy Eligibility Criteria
- recommendation = 'BUY' (score > 50, Layer 4 ≤ 2)
- RSI in 30-70 window (not overbought)
- Price ≥ $5
- pick_flag = 1 (manually selected)
- Not already in portfolio (new positions only)
- Market regime: BULL (SPY above both 50MA and 200MA)

### Sell Algorithm (4 Sequential Layers, First Triggered = Exit)
Runs at 9:35 AM ET only for positions with autotrader_on=1:

**Layer 1: Hard Stop (Capital Protection)**
- Trigger: P&L ≤ -8% (configurable `hard_stop_pct`)
- Action: Sell 100%, log "Hard stop: -8.1%"

**Layer 2: Trailing Stop (Profit Protection)**
- Activation: P&L ≥ +5% (configurable `trailing_stop_activation_pct`)
- Trigger: Current ≤ Peak × (1 - 5%) (configurable `trailing_stop_pct`)
- Peak tracked every 5 min in `position_flags.peak_price`
- Action: Sell 100%, log "Trailing stop: $45 ≤ $52"

**Layer 3: RSI Overbought + Extended Price**
- Trigger: RSI ≥ 75 AND price ≥ 10% above 50MA (configurable `extended_price_pct`)
- Action: Sell 100%, log "RSI 76 + 11% extended"

**Layer 4: Pre-Sell Score (Momentum Deterioration)**
- Trigger: ≥3 of 5 conditions:
  1. Price < 50MA
  2. 50MA < 200MA
  3. MACD bearish
  4. EMA9 < EMA21
  5. SPY < SPY 50MA
- Action: Sell 100%, log "pre_sell_score 3/5: price below 50MA, 50MA below 200MA, EMA9 below EMA21"

**Post-Exit**: Mark position pick_flag = 0 (user must re-select before autotrader buys again)

---

## Deployment Environment

### Mini PC Details
- **Host**: 192.168.1.156
- **SSH user**: rajramani
- **Sudo password**: yanni123
- **OS**: Ubuntu 25.10
- **Node**: 20.x
- **MySQL**: 8.4 on same machine
- **Services**: systemd user services via `loginctl enable-linger`

### Service Ports
- **3001**: Swing Trader (stocktrader.service)
- **8081**: My Stocks Dashboard (stocktrader_portfolio.service)

### Systemd User Service Template
```ini
[Unit]
Description=StockTrader Service
After=network.target
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=/home/rajramani/stocktrader
Environment=ALPACA_BASE_URL=https://paper-api.alpaca.markets
ExecStartPre=/bin/sleep 5
ExecStartPre=-/usr/bin/fuser -k PORT/tcp
ExecStart=/usr/bin/node /home/rajramani/stocktrader/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

**Critical Rules:**
- `WantedBy=default.target` (NOT `multi-user.target` — user services won't auto-start on system target)
- `-/usr/bin/fuser -k PORT/tcp` (kills stale process from boot race condition; `-` ignores failure when free)
- `After=network.target` only (NO mysql.service — silently ignored in user scope)
- Verify symlink exists: `ls ~/.config/systemd/user/default.target.wants/`

### Deployment Checklist
```bash
# 1. Sync files
scp <file> rajramani@192.168.1.156:~/stocktrader/<path>

# 2. Reload + restart
ssh rajramani@192.168.1.156 "systemctl --user daemon-reload && systemctl --user restart stocktrader_portfolio"

# 3. Verify status
ssh rajramani@192.168.1.156 "systemctl --user status stocktrader_portfolio --no-pager"

# 4. Test reboot persistence (optional)
ssh rajramani@192.168.1.156 "echo 'yanni123' | sudo -S reboot"
# Wait 60s, then check status
```

---

## API Keys (.env)

Store in **~/.env** (git-ignored), loaded at startup:

```
ALPACA_KEY=PKF2JLP5SA7RGGXIU2VVVKTKZI
ALPACA_SECRET=BXnDaqDxDkv8137EvS7gEYmfSKD5YnzbC8jd4Y6c2bEV
ALPACA_BASE_URL=https://paper-api.alpaca.markets

FINNHUB_KEY=d7cou5...
POLYGON_KEY=hFzwnX...
ALPHA_VANTAGE_KEY=9N8N9K...

EMAIL_USER=rrvenkatrama@gmail.com
EMAIL_PASS=<app-specific password — not Gmail password>
```

**Note**: ALPACA keys are paper account (PA3S20RQWZGU, $100K capital). Paper API URL used by default.

---

## My Stocks Dashboard Features

### Stocks Tab
- **Columns**: Symbol, Price, Chg 1D%, Chg 1M%, Chg YTD%, Chg 1Y%, Portfolio, Signal, Sector
- **Star column**: Golden/death cross status (⭐ pulsing = recent, ★ solid = active, ☆ grey = none)
- **Badge**: Autotrader eligibility (✓ Eligible, ⚠ Blocked with reasons, 🚫 No Pick)
- **Buy button**: Opens modal (market/limit, TIF, extended hours)
- **Bulk pick toggle**: Checkbox column + "Toggle Pick (N)" button for multi-select

### Discover Tab
- Scans ~204-stock universe for BUY signals not in watchlist
- "+ Watch" button adds stock to watchlist (fetches full data next morning)
- "Buy" button opens buy modal directly

### Long Haul Tab
- Dividend stocks: div_yield > 0, pct_from_52high ≤ -20, PE/Fwd PE thresholds, beta < 1.5
- Sorted by dividend yield (descending)
- News + Chart popup only; no Buy button

### Transactions Tab
- Buy/sell history with symbol, action, qty, price, total amount, reason, P&L
- Shows entry_reason for buys, exit_reason for sells
- Sortable by date, symbol, P&L

---

## Common Debugging

### "Column count doesn't match value count"
**Cause**: Added new columns to INSERT but forgot new ? placeholders.  
**Fix**: Count columns in INSERT, count ? in VALUES. Add/remove as needed.

### "Signal Score: 0/100 (0 bullish, 0 bearish)"
**Cause**: settingsCache not reloaded before analyzer ran.  
**Fix**: Batch scripts must call `await settingsCache.reloadSettings()`

### "Cannot remove stock from watchlist — sell position first"
**Cause**: Stock is in Alpaca positions; prevents accidental removal.  
**Fix**: Sell the position on the UI first, then remove from watchlist.

### Weights Changed, Scores Not Updated
**Cause**: Cache still in memory; not reloaded.  
**Fix**: Restart service or manually call `settingsCache.reloadSettings()`

---

## File Map

### Root
```
server.js                   — Express, all routes, HTML, startup
CLAUDE.md                   — THIS FILE
SCORING_METHODOLOGY.md      — Detailed scoring guide
plan.txt                    — Current session status
.env                        — API keys (git-ignored)
```

### Config & Database
```
config/env.js               — .env loading
config/sources.js           — Runtime data source switching
db/schema.sql               — 9 MySQL tables
db/db.js                    — MySQL pool helpers
db/setup.js                 — One-time DB init
```

### Data Modules (Use via provider.js)
```
data/provider.js            — UNIFIED ROUTER (use this for everything)
data/alpacaData.js          — Alpaca price/bars
data/yahoo.js               — Yahoo Finance quote + historical
data/finnhub.js             — Fundamentals, analyst, news
data/sentiment.js           — StockTwits, Fear&Greed, Reddit
data/institutional.js       — SEC 13F, superinvestor holdings
data/marketContext.js       — SPY analysis, market health
```

### Analysis
```
analysis/technicals.js      — RSI, MACD, Bollinger, crosses, ATR
analysis/scorer.js          — Composite score + probability + VIX-adaptive threshold
```

### Trading
```
screener/universe.js        — 30 symbols for swing trader
screener/scan.js            — Batch scanner (uses provider.js)
trader/portfolio.js         — Daily plan builder (BUY/HOLD/EXIT/SWAP logic)
trader/guardrails.js        — Pre-trade safety checks
trader/executor.js          — Alpaca order placement + sync
```

### Scheduler
```
scheduler/cron.js           — Pre-market, midday, 5min sync, EOD (ET timezone)
notifier/email.js           — Gmail SMTP; daily digest + alerts
```

### Portfolio App (My Stocks Dashboard, port 8081)
```
portfolio_app/analyzer.js   — Signal scoring engine; 30+ signals, 0-100 score
portfolio_app/universe.js   — ~204-stock discovery universe
portfolio_app/yahoo_history.js — Alpaca bars, Finnhub/Yahoo fundamentals
portfolio_app/scheduler.js  — 8:30 AM ET cron: refresh → analyze → scan → email
portfolio_app/settingsCache.js — In-memory settings cache (database-backed)
portfolio_app/settings.js   — Settings API; loads from system_config
portfolio_app/claude_advisor.js — Claude Haiku AI ranking for buy decisions
server_portfolio.js         — Express, HTML, routes for dashboard
```

### Services
```
stocktrader.service         — Swing trader systemd unit file
stocktrader_portfolio.service — My Stocks dashboard systemd unit file
```

### Scripts (One-Off Tools)
```
scripts/update-price-changes.js — Recalculate CHG 1D/1M/YTD/1Y for all stocks
scripts/test-analyzer.js        — Test analyzer on single symbol
scripts/debug-ytd.js            — Debug YTD calculation
```

---

## Session Handoff Checklist

When resuming work:
- [ ] Read SCORING_METHODOLOGY.md
- [ ] Read this CLAUDE.md
- [ ] Check plan.txt for state
- [ ] Check memory/MEMORY.md for recent session notes
- [ ] Verify .env API keys are current
- [ ] Test that settingsCache.reloadSettings() works if modifying weights

---

## Never Do These

❌ **Hardcode signal weights** in analyzer.js  
❌ **Call data modules directly** (use provider.js)  
❌ **Default signal weight = 1.0** (use 0)  
❌ **Use LLM for sell decisions** — sells are always rule-based 4-layer algorithm  
❌ **Hardcode pulsing_glow_days** — always read from settingsCache.getGoldenCross()  
❌ **Forget Layer 4 override** (≥3 bearish = SELL)  
❌ **Use `multi-user.target` for systemd user services**  
❌ **JSON.parse() on mysql2 JSON columns** (already parsed)  
❌ **Place orders without user Approve** link  
❌ **Use buttons for critical navigation** (use `<a href>` links)  
❌ **Allow shorting** (disabled in paper account; handle errors gracefully)  

---

## Always Do These

✅ **Read SCORING_METHODOLOGY.md before modifying scoring**  
✅ **Use provider.js for all data fetching**  
✅ **Call settingsCache.reloadSettings() in batch scripts**  
✅ **Pass claudeFields to placeOrder() for all autotrader buys**  
✅ **Always fallback gracefully** if Claude API fails (use top-5-by-score)  
✅ **Test systemd symlink** after service changes  
✅ **Verify `<a href>` links work** for Approve/Reject/Scan  
✅ **Document breaking changes** in memory/session*.md  
✅ **Test Layer 4 override** when modifying sell logic  
✅ **Handle API errors gracefully** (no shorting, rate limits)  

---

## Document History

| Date | Changes |
|---|---|
| 2026-04-22 | v2.0 — Complete rewrite. Clarified signal weights are configurable, Layer 4 logic, UI rules, systemd gotchas, data sources, autotrader algorithm. |
| 2026-04-22 | v3.0 — Claude AI buy advisor: daily spend cap (25%), max 5 tickers/day, Claude Haiku ranks top-10 candidates, no LLM for sells. RSI overbought threshold changed 65→70. Golden cross pulsing reads from settings. |
