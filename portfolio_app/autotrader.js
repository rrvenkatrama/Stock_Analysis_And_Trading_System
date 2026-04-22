// Auto-trading engine for My Stocks dashboard
// 3-Tier architecture: Market Regime → Quality Filter → Technical Entry/Exit
//
// Tier 3 (Market Regime): SPY signals from stock_signals table
//   BULL:    SPY above 200MA AND above 50MA  → entries allowed
//   CAUTION: SPY above 200MA but below 50MA → correction in progress, block entries
//   BEAR:    SPY below 200MA                → bear market, block entries
//   UNKNOWN: SPY not in stock_signals       → block entries (safe default)
// Tier 2 (Quality Filter): score ≥50%, price ≥$5, RSI ≤65, not >8% extended above 50MA
// Tier 1 (Entry Gate):     pick_flag=1, score >50%, ≥2 technical confirmations, no earnings within 5d
//
// Exit rules:
//   Hard stop  (100% sell): price ≤ entry − 8%
//   Soft exits  (50% sell): score <25 | RSI >75 | EMA 9 crossed below EMA 21 ≤3d ago |
//                           MACD turned bearish | held ≥30d with no gain
//
// Called from scheduler.js:
//   8:30 AM ET: evaluate(false) → recommendations in daily digest
//   9:35 AM ET: run()           → live execution when autorun_enabled='1'

const axios   = require('axios');
const cfg     = require('../config/env');
const db      = require('../db/db');
const finnhub = require('../data/finnhub');
const settingsCache = require('./settingsCache');

// ─── Alpaca API helpers ───────────────────────────────────────────────────────
function headers() {
  return {
    'APCA-API-KEY-ID':     cfg.alpaca.key,
    'APCA-API-SECRET-KEY': cfg.alpaca.secret,
    'Content-Type':        'application/json',
  };
}
async function alpacaGet(path) {
  const res = await axios.get(`${cfg.alpaca.baseUrl}/v2${path}`, { headers: headers(), timeout: 10000 });
  return res.data;
}
async function alpacaPost(path, body) {
  const res = await axios.post(`${cfg.alpaca.baseUrl}/v2${path}`, body, { headers: headers(), timeout: 10000 });
  return res.data;
}

// ─── Config helpers ───────────────────────────────────────────────────────────
async function getConfig(key, defaultValue = null) {
  const row = await db.queryOne(
    "SELECT config_value FROM system_config WHERE config_group='autotrader' AND config_key=?",
    [key]
  );
  return row ? row.config_value : defaultValue;
}

// ─── Market regime (Tier 3) ───────────────────────────────────────────────────
// Uses pre-computed stock_signals for SPY — avoids redundant data fetch
// SPY below 50MA is an early warning (correction) — blocks entries before 200MA cross
async function getMarketRegime() {
  const spy = await db.queryOne(
    'SELECT above_200ma, above_50ma FROM stock_signals WHERE symbol = ?', ['SPY']
  );
  if (!spy)             return 'unknown';
  if (!spy.above_200ma) return 'bear';
  if (!spy.above_50ma)  return 'caution';  // above 200MA but below 50MA — correction
  return 'bull';
}

// ─── VIX estimate from VIXY price_history ────────────────────────────────────
// VIXY × 1.8 + 2 ≈ VIX. Returns null if VIXY not tracked.
async function getVixEstimate() {
  const row = await db.queryOne(
    'SELECT close FROM price_history WHERE symbol = ? ORDER BY trade_date DESC LIMIT 1',
    ['VIXY']
  );
  return row ? parseFloat(row.close) * 1.8 + 2 : null;
}

// VIX → position size multiplier
//   VIX < 20  → 1.00 (normal)
//   VIX 20-30 → 0.75 (elevated vol — size down 25%)
//   VIX > 30  → 0.50 (high vol / correction — size down 50%)
function vixMultiplier(vix) {
  if (vix === null || vix < 20) return 1.0;
  if (vix < 30) return 0.75;
  return 0.5;
}

// ─── Volume ratio from price_history (last 21 trading days) ──────────────────
async function getVolumeRatio(symbol) {
  const rows = await db.query(
    'SELECT volume FROM price_history WHERE symbol = ? ORDER BY trade_date DESC LIMIT 22',
    [symbol]
  );
  if (rows.length < 6) return null;
  const vols = rows.map(r => parseInt(r.volume)).filter(v => v > 0);
  if (vols.length < 6) return null;
  const todayVol = vols[0];
  const avg = vols.slice(1).reduce((a, b) => a + b, 0) / (vols.length - 1);
  return avg > 0 ? todayVol / avg : null;
}

// ─── Days since last autotrader buy ──────────────────────────────────────────
async function getDaysHeld(symbol) {
  const row = await db.queryOne(
    `SELECT executed_at FROM autotrader_trades
     WHERE symbol = ? AND action = 'buy' ORDER BY executed_at DESC LIMIT 1`,
    [symbol]
  );
  if (!row) return null;
  return Math.floor((Date.now() - new Date(row.executed_at).getTime()) / 86400000);
}

// ─── Tier 2: Quality filter (uses settings.gates) ──────────────────────────────
function passesTier2(sig) {
  if (!sig) return false;
  const gatesSettings = settingsCache.getGates();
  const scoreThreshold = gatesSettings.score_threshold !== undefined ? gatesSettings.score_threshold : 50;
  const buySettings = settingsCache.getBuy();
  const minPrice = buySettings.min_price !== undefined ? buySettings.min_price : 5;
  const rsiMax = gatesSettings.rsi_max !== undefined ? gatesSettings.rsi_max : 65;
  const overextensionPct = gatesSettings.overextension_pct !== undefined ? gatesSettings.overextension_pct : 8;

  if (sig.score < scoreThreshold) return false;
  if (!sig.price || sig.price < minPrice) return false;
  if (sig.rsi !== null && sig.rsi > rsiMax) return false;
  if (sig.ma50 && sig.price > sig.ma50 * (1 + overextensionPct / 100)) return false;
  return true;
}

// ─── Count Tier 1 technical confirmations (uses settings.gates) ─────────────────
// Returns count of confirmations; eligibility requires ≥ min_confirmations
function countConfirmations(sig, volRatio) {
  const gatesSettings = settingsCache.getGates();
  const rsiMin = gatesSettings.rsi_min !== undefined ? gatesSettings.rsi_min : 30;
  const rsiMax = gatesSettings.rsi_max !== undefined ? gatesSettings.rsi_max : 65;

  let n = 0;
  if (sig.rsi !== null && sig.rsi >= rsiMin && sig.rsi <= rsiMax) n++;
  if (['bullish', 'above_signal'].includes(sig.macd_trend)) n++;
  if (sig.above_50ma) n++;
  if (volRatio !== null && volRatio >= 1.3) n++;
  return n;
}

// ─── Position sizing (uses settings.limits) ──────────────────────────────────
// Respects min cash buffer, max deployment, and per-position limits from settings
function calcPositionSize(accountEquity, buyingPower, openSlots, price, vixMult = 1.0) {
  const limitsSettings = settingsCache.getLimits();
  const minCashBufferPct = limitsSettings.min_cash_buffer_pct !== undefined ? limitsSettings.min_cash_buffer_pct : 20;
  const maxDeploymentPct = limitsSettings.max_deployment_pct !== undefined ? limitsSettings.max_deployment_pct : 80;
  const maxPerPositionPct = limitsSettings.max_per_position_pct !== undefined ? limitsSettings.max_per_position_pct : 10;

  const cashBuffer = accountEquity * (minCashBufferPct / 100);
  const maxDeployable = accountEquity * (maxDeploymentPct / 100);
  const deployable = Math.min(buyingPower - cashBuffer, maxDeployable - (accountEquity - buyingPower));
  const maxPerPos  = accountEquity * (maxPerPositionPct / 100) * vixMult;
  const perSlot    = Math.min(Math.max(0, deployable / Math.max(openSlots, 1)), maxPerPos);
  return Math.floor(perSlot / price);
}

// ─── Evaluate exit for a single open position (uses settings.sell) ────────────
// Returns { qty, sellPct, reason } or null (hold)
async function evaluateExit(position, sig) {
  const currentPrice = parseFloat(position.current_price);
  const avgEntry     = parseFloat(position.avg_entry_price);
  const qty          = parseInt(position.qty);
  const pnlPct       = ((currentPrice - avgEntry) / avgEntry) * 100;
  const peakPrice    = position.peak_price ? parseFloat(position.peak_price) : avgEntry;

  const sellSettings = settingsCache.getSell();
  const hardStopPct = sellSettings.hard_stop_pct !== undefined ? sellSettings.hard_stop_pct : -8;
  const trailingActivationPct = sellSettings.trailing_stop_activation_pct !== undefined ? sellSettings.trailing_stop_activation_pct : 5;
  const trailingStopPct = sellSettings.trailing_stop_pct !== undefined ? sellSettings.trailing_stop_pct : 5;
  const extendedPricePct = sellSettings.extended_price_pct !== undefined ? sellSettings.extended_price_pct : 10;

  // 1. Hard Stop: price <= entry * (1 - hard_stop_pct)
  if (pnlPct <= hardStopPct) {
    return { qty, sellPct: 100, reason: `Hard stop: ${pnlPct.toFixed(1)}% from entry` };
  }

  // 2. Trailing Stop: price <= peak * (1 - trailing_stop_pct)
  // Only activate if position has gained >= trailing_activation_pct%
  if (pnlPct >= trailingActivationPct && currentPrice <= peakPrice * (1 - trailingStopPct / 100)) {
    return { qty, sellPct: 100, reason: `Trailing stop: price ${currentPrice} <= peak ${peakPrice.toFixed(2)} × (1 - ${trailingStopPct}%)` };
  }

  // 3. RSI Overbought + Extended Price: RSI >= 75 AND price >= extended_pct% above 50DMA
  if (sig && sig.rsi !== null && sig.rsi >= 75 && sig.ma50) {
    const pctAbove50 = ((currentPrice / sig.ma50) - 1) * 100;
    if (pctAbove50 >= extendedPricePct) {
      return { qty, sellPct: 100, reason: `RSI overbought (${sig.rsi.toFixed(1)}) + extended ${pctAbove50.toFixed(1)}% above 50DMA` };
    }
  }

  // 4. pre_sell_score: Check multiple bearish conditions
  if (sig) {
    let preSellScore = 0;
    if (sig.price < sig.ma50) preSellScore += 1;
    if (sig.ma50 < sig.ma200) preSellScore += 1;
    if (sig.macd_trend === 'bearish') preSellScore += 1;
    if (sig.ema9 < sig.ema21) preSellScore += 1;

    // Check SPY 50DMA for market regime
    const spy = await db.queryOne(`SELECT ma50 FROM stock_signals WHERE symbol='SPY'`);
    const spyCurrent = await db.queryOne(`SELECT price FROM stock_signals WHERE symbol='SPY'`);
    if (spy && spyCurrent && spyCurrent.price < spy.ma50) preSellScore += 1;

    if (preSellScore >= 3) {
      return {
        qty,
        sellPct: 100,
        reason: `pre_sell_score ${preSellScore}≥3: ${[
          sig.price < sig.ma50 ? 'price<50DMA' : null,
          sig.ma50 < sig.ma200 ? '50DMA<200DMA' : null,
          sig.macd_trend === 'bearish' ? 'MACD bearish' : null,
          sig.ema9 < sig.ema21 ? 'EMA9<EMA21' : null,
          spy && spyCurrent && spyCurrent.price < spy.ma50 ? 'SPY<50DMA' : null
        ].filter(Boolean).join(', ')}`
      };
    }
  }

  return null; // hold
}

// ─── Place a market order and record it ──────────────────────────────────────
async function placeOrder(symbol, side, qty, reason = '', sellPct = null, price = null) {
  const order = await alpacaPost('/orders', {
    symbol,
    qty,
    side,
    type:          'market',
    time_in_force: 'day',
  });
  const entryReason = side === 'buy'  ? reason : null;
  const exitReason  = side === 'sell' ? reason : null;
  await db.query(
    `INSERT INTO autotrader_trades (symbol, action, qty, price, exit_reason, entry_reason, sell_pct, alpaca_order_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [symbol, side, qty, price, exitReason, entryReason, sellPct, order.id]
  );
  await db.log('info', 'autotrader',
    `${side.toUpperCase()} ${qty} ${symbol} — ${reason} (order ${order.id})`);
  return order;
}

// ─── Main evaluate — generates recommendations or executes trades ─────────────
// execute=false (8:30 AM): returns results for digest email, no orders placed
// execute=true  (9:35 AM): places real orders, sends execution email
async function evaluate(execute = false) {
  const results = {
    mode:    execute ? 'execute' : 'recommend',
    regime:  null,
    vix:     null,
    vixMult: null,
    exits:   [],
    entries: [],
    skipped: [],
    errors:  [],
  };

  try {
    // ── Tier 3: Market regime ────────────────────────────────────────────────
    const regime  = await getMarketRegime();
    results.regime = regime;

    // Get live positions from Alpaca
    let positions = [];
    try {
      positions = await alpacaGet('/positions');
    } catch (e) {
      results.errors.push({ phase: 'positions', message: e.message });
    }
    const heldSymbols = new Set(positions.map(p => p.symbol));

    // ── Phase 1: Exit evaluation (runs regardless of market regime) ───────────
    if (positions.length) {
      // Load position_flags — only manage positions with autotrader_on=1
      const flagRows = await db.query(`SELECT symbol, autotrader_on FROM position_flags`);
      const flagMap  = new Map(flagRows.map(r => [r.symbol, r.autotrader_on]));

      const placeholders = positions.map(() => '?').join(',');
      const sigs = await db.query(
        `SELECT * FROM stock_signals WHERE symbol IN (${placeholders})`,
        positions.map(p => p.symbol)
      );
      const sigMap = new Map(sigs.map(s => [s.symbol, s]));

      for (const pos of positions) {
        // Skip positions not managed by autotrader
        if (!flagMap.get(pos.symbol)) continue;
        try {
          const exit = await evaluateExit(pos, sigMap.get(pos.symbol));
          if (!exit) continue;

          const pnlPct = ((parseFloat(pos.current_price) - parseFloat(pos.avg_entry_price))
                         / parseFloat(pos.avg_entry_price)) * 100;
          const action = {
            symbol:       pos.symbol,
            action:       'sell',
            qty:          exit.qty,
            sellPct:      exit.sellPct,
            reason:       exit.reason,
            currentPrice: parseFloat(pos.current_price),
            avgEntry:     parseFloat(pos.avg_entry_price),
            pnlPct,
          };
          results.exits.push(action);

          if (execute) {
            try {
              await placeOrder(pos.symbol, 'sell', exit.qty, exit.reason, exit.sellPct, parseFloat(pos.current_price));
              action.executed = true;
              if (exit.sellPct === 100 || exit.qty >= parseInt(pos.qty)) {
                heldSymbols.delete(pos.symbol);
                // Mark as "No Pick" when fully exited
                await db.query(
                  `UPDATE watchlist SET pick_flag = 0 WHERE symbol = ?`,
                  [pos.symbol]
                );
              }
            } catch (e) {
              action.executed = false;
              action.error = e.message;
              results.errors.push({ phase: 'sell', symbol: pos.symbol, message: e.message });
            }
          }
        } catch (e) {
          results.errors.push({ phase: 'exit_eval', symbol: pos.symbol, message: e.message });
        }
      }
    }

    // ── Phase 2: Entry evaluation (skip unless regime is bull) ───────────────
    const regimeMessages = {
      bear:    'Market regime: BEAR (SPY below 200MA) — no new entries',
      caution: 'Market regime: CAUTION (SPY below 50MA — correction in progress) — no new entries',
      unknown: 'Market regime: UNKNOWN (SPY not in stock_signals) — no new entries',
    };
    if (regime !== 'bull') {
      results.skipped.push({ reason: regimeMessages[regime] });
    } else {
      // Fetch VIX for position sizing
      const vix  = await getVixEstimate();
      const mult = vixMultiplier(vix);
      results.vix     = vix  ? +vix.toFixed(1)  : null;
      results.vixMult = mult;
      if (mult < 1.0) {
        await db.log('info', 'autotrader',
          `VIX ~${results.vix} → position size reduced to ${mult * 100}%`);
      }

      let account = {};
      try {
        account = await alpacaGet('/account');
      } catch (e) {
        results.errors.push({ phase: 'account', message: e.message });
      }

      const accountEquity = parseFloat(account.equity || account.portfolio_value || 0);
      const buyingPower   = parseFloat(account.buying_power || 0);
      const maxPositions  = parseInt(await getConfig('autorun_max_positions', '8'));
      const openSlots     = Math.max(0, maxPositions - heldSymbols.size);

      if (openSlots <= 0) {
        results.skipped.push({ reason: `Portfolio full: ${heldSymbols.size}/${maxPositions} positions` });
      } else {
        // Watchlist-only BUY candidates, pick_flag=1 AND recommendation=BUY, sorted by score
        const candidates = await db.query(
          `SELECT ss.* FROM stock_signals ss
           INNER JOIN watchlist w ON w.symbol = ss.symbol AND w.is_active = 1 AND w.pick_flag = 1
           WHERE ss.recommendation = 'BUY' AND ss.price >= 5
           ORDER BY ss.score DESC
           LIMIT 20`
        );

        let slotsUsed = 0;
        for (const sig of candidates) {
          if (slotsUsed >= openSlots) break;

          if (heldSymbols.has(sig.symbol)) {
            results.skipped.push({ symbol: sig.symbol, reason: 'Already in portfolio' });
            continue;
          }

          // Unified scoring already applied in analyzer.js:
          // - score >= threshold (Tier 2 equivalent)
          // - Layer 4 pre-buy check blocks momentum deterioration
          // - All 60+ signals evaluated for BUY recommendation
          // No separate Tier gates needed.

          // Volume ratio (for logging/transparency)
          const volRatio = await getVolumeRatio(sig.symbol);

          // Earnings guard: skip if earnings within 5 days
          try {
            const earnings = await finnhub.getEarnings(sig.symbol);
            if (earnings.daysToEarnings !== null && earnings.daysToEarnings >= 0 && earnings.daysToEarnings <= 5) {
              results.skipped.push({ symbol: sig.symbol, score: sig.score,
                reason: `Earnings in ${earnings.daysToEarnings}d — skip` });
              continue;
            }
          } catch (_) {}

          // Position sizing (VIX-adjusted)
          const shares = calcPositionSize(accountEquity, buyingPower, openSlots - slotsUsed, sig.price, mult);
          if (shares < 1) {
            results.skipped.push({ symbol: sig.symbol, score: sig.score,
              reason: 'Position size < 1 share (insufficient funds)' });
            continue;
          }

          const action = {
            symbol:       sig.symbol,
            action:       'buy',
            qty:          shares,
            price:        sig.price,
            score:        sig.score,
            confirmations,
            volRatio:     volRatio ? +volRatio.toFixed(2) : null,
            vixMult:      mult,
          };
          results.entries.push(action);

          if (execute) {
            try {
              // Build detailed buy reason listing which confirmations passed
              const confirmDetail = [];
              const gs = settingsCache.getGates();
              const rsiMin = gs.rsi_min ?? 30, rsiMax = gs.rsi_max ?? 65;
              if (sig.rsi !== null && sig.rsi >= rsiMin && sig.rsi <= rsiMax) confirmDetail.push(`RSI ${sig.rsi.toFixed(1)}`);
              if (['bullish', 'above_signal'].includes(sig.macd_trend)) confirmDetail.push(`MACD ${sig.macd_trend}`);
              if (sig.above_50ma) confirmDetail.push('above 50MA');
              if (volRatio !== null && volRatio >= 1.3) confirmDetail.push(`vol ${volRatio.toFixed(1)}x`);
              const buyReason = `Score ${sig.score.toFixed(1)} | ${confirmDetail.join(' | ')}`;
              await placeOrder(sig.symbol, 'buy', shares, buyReason, null, sig.price);
              action.executed = true;
              heldSymbols.add(sig.symbol);
              slotsUsed++;
              // Mark as autotrader-managed
              await db.query(
                `INSERT INTO position_flags (symbol, autotrader_on) VALUES (?,1)
                 ON DUPLICATE KEY UPDATE autotrader_on=1, updated_at=NOW()`,
                [sig.symbol]
              );
            } catch (e) {
              action.executed = false;
              action.error = e.message;
              results.errors.push({ phase: 'buy', symbol: sig.symbol, message: e.message });
            }
          } else {
            slotsUsed++;
          }
        }
      }
    }

  } catch (err) {
    results.errors.push({ phase: 'autotrader', message: err.message });
    await db.log('error', 'autotrader', `evaluate() failed: ${err.message}`);
  }

  return results;
}

// ─── run() — called by 9:35 AM cron when autorun is ON ───────────────────────
// Checks autorun_enabled config and market hours before executing
async function run() {
  const enabled = await getConfig('autorun_enabled', '0');
  if (enabled !== '1') return null;

  // Must be within market hours: 9:35 AM – 3:45 PM ET
  const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et    = new Date(etStr);
  const minuteOfDay = et.getHours() * 60 + et.getMinutes();
  if (minuteOfDay < 9 * 60 + 35 || minuteOfDay > 15 * 60 + 45) {
    await db.log('warn', 'autotrader', 'run() called outside market hours — skipping');
    return null;
  }

  await db.log('info', 'autotrader', 'Autorun ON — executing morning trades');
  return evaluate(true);
}

module.exports = { evaluate, run, getMarketRegime };
