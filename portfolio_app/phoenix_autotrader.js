// Phoenix Strategy — Deep Value Contrarian Auto-Trader
// Manages its own virtual cash pool (50% of portfolio equity).
// Positions tagged strategy='phoenix' in autotrader_trades.
//
// Entry: Phoenix score ≥60, passes all hard gates, no earnings within 5d
// Exit:
//   Hard stop: price ≤ entry − 15%  → 100% sell
//   Soft exits (50% sell):
//     - EPS growth turns negative (fund deteriorating)
//     - Phoenix score < 30
//     - Analyst consensus flips to mostly sell (<20% buy)
//     - Held ≥60d with no gain ≥5% (time stop)
//     - Price recovered to within 15% of 52wk high (take partial profit)
//
// Called from scheduler.js at 9:35 AM ET when phoenix_enabled='1'

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
  const r = await axios.get(`${cfg.alpaca.baseUrl}/v2${path}`, { headers: headers(), timeout: 10000 });
  return r.data;
}
async function alpacaPost(path, body) {
  const r = await axios.post(`${cfg.alpaca.baseUrl}/v2${path}`, body, { headers: headers(), timeout: 10000 });
  return r.data;
}

// ─── Config helpers ───────────────────────────────────────────────────────────
async function getConfig(key, defaultValue = null) {
  const row = await db.queryOne(
    "SELECT config_value FROM system_config WHERE config_group='phoenix' AND config_key=?",
    [key]
  );
  return row ? row.config_value : defaultValue;
}

// ─── VIX estimate from VIXY price_history ─────────────────────────────────────
async function getVixEstimate() {
  const row = await db.queryOne(
    'SELECT close FROM price_history WHERE symbol = ? ORDER BY trade_date DESC LIMIT 1',
    ['VIXY']
  );
  return row ? parseFloat(row.close) * 1.8 + 2 : null;
}

function vixMultiplier(vix) {
  if (vix === null || vix < 20) return 1.0;
  if (vix < 30) return 0.75;
  return 0.5;
}

// ─── Days since Phoenix bought this symbol ────────────────────────────────────
async function getDaysHeld(symbol) {
  const row = await db.queryOne(
    `SELECT executed_at FROM autotrader_trades
     WHERE symbol = ? AND action = 'buy' AND strategy = 'phoenix'
     ORDER BY executed_at DESC LIMIT 1`,
    [symbol]
  );
  if (!row) return null;
  return Math.floor((Date.now() - new Date(row.executed_at).getTime()) / 86400000);
}

// ─── Virtual cash pool: Phoenix equity = total equity × 50% ──────────────────
// Looks at Alpaca positions tagged as 'phoenix' in autotrader_trades to determine
// how much of the Phoenix pool is currently deployed.
async function getPhoenixBuyingPower(totalEquity, totalBuyingPower, phoenixHeldSymbols, allPositions) {
  // Phoenix's share of total equity
  const phoenixEquity = totalEquity * 0.50;

  // Market value of positions currently held by Phoenix
  const heldValues = allPositions
    .filter(p => phoenixHeldSymbols.has(p.symbol))
    .reduce((sum, p) => sum + parseFloat(p.market_value || 0), 0);

  // Available buying power within Phoenix pool (can't exceed actual Alpaca buying power)
  const phoenixAvailable = Math.max(0, phoenixEquity - heldValues);
  return Math.min(phoenixAvailable, totalBuyingPower * 0.50);
}

// ─── Position sizing (Phoenix pool) ──────────────────────────────────────────
function calcPositionSize(phoenixEquity, phoenixBuyingPower, openSlots, price, vixMult = 1.0) {
  const cashBuffer = phoenixEquity * 0.20;
  const deployable = Math.max(0, (phoenixBuyingPower - cashBuffer) * 0.50);
  const maxPerPos  = phoenixEquity * 0.10 * vixMult;
  const perSlot    = Math.min(deployable / Math.max(openSlots, 1), maxPerPos);
  return Math.floor(perSlot / price);
}

// ─── Evaluate exit for one Phoenix position ───────────────────────────────────
async function evaluateExit(position, phxSig) {
  const currentPrice = parseFloat(position.current_price);
  const avgEntry     = parseFloat(position.avg_entry_price);
  const qty          = parseInt(position.qty);
  const pnlPct       = ((currentPrice - avgEntry) / avgEntry) * 100;
  const daysHeld     = await getDaysHeld(position.symbol);
  const halfQty      = Math.max(1, Math.floor(qty * 0.5));
  const softSell     = (reason) => ({ qty: qty === 1 ? 1 : halfQty, sellPct: qty === 1 ? 100 : 50, reason });

  // Hard stop: −15% from entry
  if (pnlPct <= -15) {
    return { qty, sellPct: 100, reason: `Hard stop: ${pnlPct.toFixed(1)}% from entry` };
  }

  if (phxSig) {
    // Score collapse
    if (phxSig.score < 30)
      return softSell(`Phoenix score collapsed to ${phxSig.score}`);

    // Analyst consensus flipped negative
    const buyCount  = parseInt(phxSig.analyst_buy  || 0);
    const sellCount = parseInt(phxSig.analyst_sell || 0);
    const holdCount = parseInt(phxSig.analyst_hold || 0);
    const totalAn   = buyCount + sellCount + holdCount;
    if (totalAn >= 3 && buyCount / totalAn < 0.20)
      return softSell(`Analyst consensus turned negative (${buyCount}/${totalAn} buy)`);

    // EPS growth turned negative — value trap
    if (phxSig.eps_growth !== null && parseFloat(phxSig.eps_growth) < 0)
      return softSell(`EPS growth turned negative (${parseFloat(phxSig.eps_growth).toFixed(1)}%)`);

    // Partial profit: price recovered to within 15% of 52wk high
    if (phxSig.high_52w && phxSig.price) {
      const pctFrom52h = ((parseFloat(phxSig.price) - parseFloat(phxSig.high_52w)) / parseFloat(phxSig.high_52w)) * 100;
      if (pctFrom52h >= -15)
        return softSell(`Recovered to within 15% of 52wk high — take partial profit`);
    }
  }

  // Time stop: held ≥60 days with no meaningful gain
  if (daysHeld !== null && daysHeld >= 60 && pnlPct < 5)
    return softSell(`Time stop: ${daysHeld}d held, gain only ${pnlPct.toFixed(1)}%`);

  return null; // hold
}

// ─── Place order and record with strategy='phoenix' ───────────────────────────
async function placeOrder(symbol, side, qty, reason = '', sellPct = null) {
  const order = await alpacaPost('/orders', {
    symbol, qty, side, type: 'market', time_in_force: 'day',
  });
  await db.query(
    `INSERT INTO autotrader_trades (symbol, strategy, action, qty, exit_reason, sell_pct, alpaca_order_id)
     VALUES (?, 'phoenix', ?, ?, ?, ?, ?)`,
    [symbol, side, qty, reason || null, sellPct, order.id]
  );
  await db.log('info', 'phoenix',
    `${side.toUpperCase()} ${qty} ${symbol} — ${reason} (order ${order.id})`);
  return order;
}

// ─── Main evaluate — generates recommendations or executes trades ─────────────
// execute=false → recommendations only (8:30 AM digest)
// execute=true  → live orders (9:35 AM)
async function evaluate(execute = false) {
  const results = {
    mode:    execute ? 'execute' : 'recommend',
    vix:     null,
    vixMult: null,
    exits:   [],
    entries: [],
    skipped: [],
    errors:  [],
  };

  try {
    // Live Alpaca positions
    let allPositions = [];
    try { allPositions = await alpacaGet('/positions'); } catch (e) {
      results.errors.push({ phase: 'positions', message: e.message });
    }

    // Which symbols are Phoenix-held?
    const phoenixTrades = await db.query(
      `SELECT DISTINCT symbol FROM autotrader_trades WHERE strategy='phoenix' AND action='buy'`
    );
    // Cross-reference with actual Alpaca positions (might have been manually sold)
    const alpacaHeld    = new Set(allPositions.map(p => p.symbol));
    const phoenixHeld   = new Set(
      phoenixTrades.map(r => r.symbol).filter(s => alpacaHeld.has(s))
    );

    // ── Phase 1: Exit evaluation ───────────────────────────────────────────────
    const phoenixPositions = allPositions.filter(p => phoenixHeld.has(p.symbol));
    if (phoenixPositions.length) {
      const placeholders = phoenixPositions.map(() => '?').join(',');
      const phxSigs = await db.query(
        `SELECT * FROM phoenix_signals WHERE symbol IN (${placeholders})`,
        phoenixPositions.map(p => p.symbol)
      );
      const sigMap = new Map(phxSigs.map(s => [s.symbol, s]));

      for (const pos of phoenixPositions) {
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
            strategy:     'phoenix',
          };
          results.exits.push(action);

          if (execute) {
            try {
              await placeOrder(pos.symbol, 'sell', exit.qty, exit.reason, exit.sellPct);
              action.executed = true;
              if (exit.sellPct === 100) phoenixHeld.delete(pos.symbol);
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

    // ── Phase 2: Entry evaluation — DISABLED (manual buys only from Phoenix tab) ─
    return results; // buying disabled; exits above still run

    // ── Phase 2: Entry evaluation ─────────────────────────────────────────────
    const vix    = await getVixEstimate();
    const mult   = vixMultiplier(vix);
    results.vix     = vix  ? +vix.toFixed(1)  : null;
    results.vixMult = mult;

    let account = {};
    try { account = await alpacaGet('/account'); } catch (e) {
      results.errors.push({ phase: 'account', message: e.message });
    }

    const totalEquity      = parseFloat(account.equity || account.portfolio_value || 0);
    const totalBuyingPower = parseFloat(account.buying_power || 0);
    const phoenixEquity    = totalEquity * 0.50;
    const phoenixBP        = await getPhoenixBuyingPower(totalEquity, totalBuyingPower, phoenixHeld, allPositions);
    const maxPositions     = parseInt(await getConfig('phoenix_max_positions', '4'));
    const openSlots        = Math.max(0, maxPositions - phoenixHeld.size);

    if (openSlots <= 0) {
      results.skipped.push({ reason: `Phoenix portfolio full: ${phoenixHeld.size}/${maxPositions} positions` });
    } else {
      // BUY candidates: phoenix_signals BUY, score ≥60, not already held
      const candidates = await db.query(
        `SELECT ps.*, w.is_active FROM phoenix_signals ps
         INNER JOIN watchlist w ON w.symbol = ps.symbol AND w.is_active = 1 AND w.no_pick = 0
         WHERE ps.recommendation = 'BUY' AND ps.score >= 60
         ORDER BY ps.score DESC LIMIT 20`
      );

      let slotsUsed = 0;
      for (const sig of candidates) {
        if (slotsUsed >= openSlots) break;

        // Skip if Alpha already holds this symbol (no double-owning)
        if (alpacaHeld.has(sig.symbol) && !phoenixHeld.has(sig.symbol)) {
          results.skipped.push({ symbol: sig.symbol, score: sig.score,
            reason: 'Already held by Alpha strategy' });
          continue;
        }

        if (phoenixHeld.has(sig.symbol)) {
          results.skipped.push({ symbol: sig.symbol, reason: 'Already held by Phoenix' });
          continue;
        }

        // Earnings guard: no earnings within 5 days
        try {
          const earnings = await finnhub.getEarnings(sig.symbol);
          if (earnings.daysToEarnings !== null && earnings.daysToEarnings >= 0 && earnings.daysToEarnings <= 5) {
            results.skipped.push({ symbol: sig.symbol, score: sig.score,
              reason: `Earnings in ${earnings.daysToEarnings}d — skip` });
            continue;
          }
        } catch (_) {}

        const shares = calcPositionSize(phoenixEquity, phoenixBP, openSlots - slotsUsed, sig.price, mult);
        if (shares < 1) {
          results.skipped.push({ symbol: sig.symbol, score: sig.score,
            reason: 'Position size < 1 share (insufficient Phoenix pool funds)' });
          continue;
        }

        const action = {
          symbol:       sig.symbol,
          action:       'buy',
          qty:          shares,
          price:        sig.price,
          score:        sig.score,
          pctFrom52h:   sig.pct_from_52high,
          epsGrowth:    sig.eps_growth,
          strategy:     'phoenix',
          vixMult:      mult,
        };
        results.entries.push(action);

        if (execute) {
          try {
            await placeOrder(sig.symbol, 'buy', shares,
              `Phoenix score ${sig.score}, ${Math.abs(sig.pct_from_52high).toFixed(0)}% below 52wk high`);
            action.executed = true;
            phoenixHeld.add(sig.symbol);
            slotsUsed++;
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

  } catch (err) {
    results.errors.push({ phase: 'phoenix', message: err.message });
    await db.log('error', 'phoenix', `evaluate() failed: ${err.message}`);
  }

  return results;
}

// ─── run() — called by 9:35 AM cron when phoenix_enabled='1' ─────────────────
async function run() {
  const enabled = await getConfig('phoenix_enabled', '0');
  if (enabled !== '1') return null;

  const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et    = new Date(etStr);
  const min   = et.getHours() * 60 + et.getMinutes();
  if (min < 9 * 60 + 35 || min > 15 * 60 + 45) {
    await db.log('warn', 'phoenix', 'run() called outside market hours — skipping');
    return null;
  }

  await db.log('info', 'phoenix', 'Phoenix autotrader running');
  return evaluate(true);
}

module.exports = { evaluate, run };
