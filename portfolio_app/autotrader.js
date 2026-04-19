// Auto-trading engine for My Stocks dashboard
// 3-Tier architecture: Market Regime → Quality Filter → Technical Entry/Exit
//
// Tier 3 (Market Regime): SPY signals from stock_signals table
//   BULL:    SPY above 200MA AND above 50MA  → entries allowed
//   CAUTION: SPY above 200MA but below 50MA → correction in progress, block entries
//   BEAR:    SPY below 200MA                → bear market, block entries
//   UNKNOWN: SPY not in stock_signals       → block entries (safe default)
// Tier 2 (Quality Filter): score ≥50, price ≥$5, RSI ≤65, not >8% extended above 50MA
// Tier 1 (Entry Gate):     score ≥65, ≥2 technical confirmations, no earnings within 5d
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

// ─── Tier 2: Quality filter ───────────────────────────────────────────────────
function passesTier2(sig) {
  if (!sig) return false;
  if (sig.score < 50)                              return false;
  if (!sig.price || sig.price < 5)                 return false;
  if (sig.rsi !== null && sig.rsi > 65)            return false; // not overbought
  if (sig.ma50 && sig.price > sig.ma50 * 1.08)    return false; // not extended >8% above 50MA
  return true;
}

// ─── Count Tier 1 technical confirmations ────────────────────────────────────
// Require ≥2: RSI 30–65, MACD bullish/above signal, above 50MA, volume ≥1.3x
function countConfirmations(sig, volRatio) {
  let n = 0;
  if (sig.rsi !== null && sig.rsi >= 30 && sig.rsi <= 65)       n++;
  if (['bullish', 'above_signal'].includes(sig.macd_trend))      n++;
  if (sig.above_50ma)                                            n++;
  if (volRatio !== null && volRatio >= 1.3)                      n++;
  return n;
}

// ─── Position sizing ─────────────────────────────────────────────────────────
// Keeps 20% cash buffer; deploys 50% of remaining buying power across open slots.
// vixMult scales maxPerPos down in high-volatility markets (0.5 – 1.0).
function calcPositionSize(accountEquity, buyingPower, openSlots, price, vixMult = 1.0) {
  const cashBuffer = accountEquity * 0.20;
  const deployable = Math.max(0, (buyingPower - cashBuffer) * 0.50);
  const maxPerPos  = accountEquity * 0.10 * vixMult;
  const perSlot    = Math.min(deployable / Math.max(openSlots, 1), maxPerPos);
  return Math.floor(perSlot / price);
}

// ─── Evaluate exit for a single open position ─────────────────────────────────
// Returns { qty, sellPct, reason } or null (hold)
async function evaluateExit(position, sig) {
  const currentPrice = parseFloat(position.current_price);
  const avgEntry     = parseFloat(position.avg_entry_price);
  const qty          = parseInt(position.qty);
  const pnlPct       = ((currentPrice - avgEntry) / avgEntry) * 100;
  const daysHeld     = await getDaysHeld(position.symbol);

  // Hard stop: -8% below entry → 100% sell
  if (pnlPct <= -8) {
    return { qty, sellPct: 100, reason: `Hard stop: ${pnlPct.toFixed(1)}% from entry` };
  }

  // Soft exits: 50% sell (edge case: if holding 1 share, sell the whole position)
  const halfQty = Math.max(1, Math.floor(qty * 0.5));
  const softSell = (reason) => ({ qty: qty === 1 ? 1 : halfQty, sellPct: qty === 1 ? 100 : 50, reason });

  if (sig) {
    if (sig.score < 25)
      return softSell(`Score deteriorated to ${sig.score}`);

    if (sig.rsi !== null && sig.rsi > 75)
      return softSell(`RSI overbought (${sig.rsi?.toFixed ? sig.rsi.toFixed(1) : sig.rsi})`);

    if (sig.ema9_bear_cross_ago !== null && sig.ema9_bear_cross_ago !== undefined && sig.ema9_bear_cross_ago <= 3)
      return softSell(`EMA 9 crossed below EMA 21 (${sig.ema9_bear_cross_ago}d ago)`);

    if (sig.macd_trend === 'bearish')
      return softSell('MACD turned bearish');
  }

  // Time stop: held ≥30 days with no gain
  if (daysHeld !== null && daysHeld >= 30 && pnlPct <= 0)
    return softSell(`Time stop: ${daysHeld}d held, no gain`);

  return null; // hold
}

// ─── Place a market order and record it ──────────────────────────────────────
async function placeOrder(symbol, side, qty, reason = '', sellPct = null) {
  const order = await alpacaPost('/orders', {
    symbol,
    qty,
    side,
    type:          'market',
    time_in_force: 'day',
  });
  await db.query(
    `INSERT INTO autotrader_trades (symbol, action, qty, exit_reason, sell_pct, alpaca_order_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [symbol, side, qty, reason || null, sellPct, order.id]
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
              await placeOrder(pos.symbol, 'sell', exit.qty, exit.reason, exit.sellPct);
              action.executed = true;
              if (exit.sellPct === 100 || exit.qty >= parseInt(pos.qty)) {
                heldSymbols.delete(pos.symbol);
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
        // Watchlist-only BUY candidates, score ≥65, sorted by score
        const candidates = await db.query(
          `SELECT ss.* FROM stock_signals ss
           INNER JOIN watchlist w ON w.symbol = ss.symbol AND w.is_active = 1 AND w.no_pick = 0
           WHERE ss.recommendation = 'BUY' AND ss.score >= 65 AND ss.price >= 5
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

          // Tier 2: Quality filter
          if (!passesTier2(sig)) {
            results.skipped.push({ symbol: sig.symbol, score: sig.score,
              reason: `Tier 2 fail (score=${sig.score} price=$${sig.price} rsi=${sig.rsi})` });
            continue;
          }

          // Volume ratio
          const volRatio = await getVolumeRatio(sig.symbol);

          // Tier 1: ≥2 technical confirmations
          const confirmations = countConfirmations(sig, volRatio);
          if (confirmations < 2) {
            results.skipped.push({ symbol: sig.symbol, score: sig.score,
              reason: `Only ${confirmations}/2 technical confirmations` });
            continue;
          }

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
              await placeOrder(sig.symbol, 'buy', shares,
                `Score ${sig.score}, ${confirmations} confirmations`);
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
