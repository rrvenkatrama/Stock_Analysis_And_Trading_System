// Auto-trading engine for My Stocks dashboard
// 3-Tier architecture: Market Regime → Quality Filter → Technical Entry/Exit
//
// Tier 3 (Market Regime): SPY signals from stock_signals table
//   BULL:    SPY above 200MA AND above 50MA  → entries allowed
//   CAUTION: SPY above 200MA but below 50MA → correction in progress, block entries
//   BEAR:    SPY below 200MA                → bear market, block entries
//   UNKNOWN: SPY not in stock_signals       → block entries (safe default)
// Tier 2 (Quality Filter): score ≥50%, price ≥$5, RSI ≤70, not >8% extended above 50MA
// Tier 1 (Entry Gate):     pick_flag=1, score ≥65, ≥2 technical confirmations, no earnings within 5d
//
// Buy flow (9:35 AM ET):
//   1. Skip symbols already in portfolio (new positions only)
//   2. Daily spend cap = 25% of (cash - 20% equity floor)
//   3. Top 10 eligible candidates → Claude AI ranking → buy Claude's picks (up to 5 new tickers/day)
//   4. Falls back to top-5-by-score if Claude fails
//
// Exit rules (rule-based only, no LLM):
//   Layer 1 — Hard stop      (100% sell): P&L ≤ hard_stop_pct (default -8%)
//   Layer 2 — Trailing stop  (100% sell): P&L ≥ activation_pct then price ≤ peak × (1 - trailing_pct)
//   Layer 3 — RSI overbought (100% sell): RSI ≥ 75 AND price ≥ extended_pct% above 50DMA
//   Layer 4 — Pre-sell score (100% sell): ≥3 of 5 bearish momentum conditions
//
// Called from scheduler.js:
//   8:30 AM ET: evaluate(false) → recommendations in daily digest
//   9:35 AM ET: run()           → live execution when autorun_enabled='1'

const axios          = require('axios');
const cfg            = require('../config/env');
const db             = require('../db/db');
const finnhub        = require('../data/finnhub');
const settingsCache  = require('./settingsCache');
const claudeAdvisor  = require('./claude_advisor');

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
async function getMarketRegime() {
  const spy = await db.queryOne(
    'SELECT above_200ma, above_50ma FROM stock_signals WHERE symbol = ?', ['SPY']
  );
  if (!spy)             return 'unknown';
  if (!spy.above_200ma) return 'bear';
  if (!spy.above_50ma)  return 'caution';
  return 'bull';
}

// ─── VIX estimate from VIXY price_history ────────────────────────────────────
async function getVixEstimate() {
  const row = await db.queryOne(
    'SELECT close FROM price_history WHERE symbol = ? ORDER BY trade_date DESC LIMIT 1',
    ['VIXY']
  );
  return row ? parseFloat(row.close) * 1.8 + 2 : null;
}

// VIX → position size multiplier
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

// ─── Count new ticker symbols already bought today ───────────────────────────
// "New ticker" = symbol bought today that is NOT in the current position set.
// Symbols added to existing positions are already in heldSymbols and don't count.
async function getTodayNewTickerCount(heldSymbols) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const rows  = await db.query(
    `SELECT DISTINCT symbol FROM autotrader_trades
     WHERE action = 'buy' AND DATE(executed_at) = ?`,
    [today]
  );
  // Count only symbols bought today that are new (not pre-existing positions)
  return rows.filter(r => !heldSymbols.has(r.symbol)).length;
}

// ─── Daily spend cap ─────────────────────────────────────────────────────────
// Returns maximum dollars to deploy today.
// Rule: deploy at most 25% of (cash - 20% equity floor).
// Minimum usable = 0 (returns 0 if fully deployed or at floor).
function calcDailySpendCap(accountEquity, buyingPower) {
  const limitsSettings    = settingsCache.getLimits();
  const minCashBufferPct  = limitsSettings.min_cash_buffer_pct !== undefined ? limitsSettings.min_cash_buffer_pct : 20;
  const cashFloor         = accountEquity * (minCashBufferPct / 100);
  const spendable         = Math.max(0, buyingPower - cashFloor);
  return spendable * 0.25; // 25% of spendable cash
}

// ─── Per-position size given daily cap and number of picks ───────────────────
// Splits daily cap equally across all Claude picks.
// Also enforces absolute max-per-position from settings (10% equity).
function calcPositionSizeFromCap(dailyCap, numPicks, price, accountEquity, vixMult = 1.0) {
  const limitsSettings   = settingsCache.getLimits();
  const maxPerPositionPct = limitsSettings.max_per_position_pct !== undefined ? limitsSettings.max_per_position_pct : 10;
  const maxPerPos        = accountEquity * (maxPerPositionPct / 100) * vixMult;
  const perPickDollars   = Math.min(dailyCap / Math.max(numPicks, 1), maxPerPos);
  return Math.floor(perPickDollars / price);
}

// ─── Tier 2: Quality filter (uses settings.gates) ───────────────────────────
function passesTier2(sig) {
  if (!sig) return false;
  const gatesSettings    = settingsCache.getGates();
  const scoreThreshold   = gatesSettings.score_threshold   !== undefined ? gatesSettings.score_threshold   : 50;
  const minPrice         = settingsCache.getBuy().min_price !== undefined ? settingsCache.getBuy().min_price : 5;
  const rsiMax           = gatesSettings.rsi_max            !== undefined ? gatesSettings.rsi_max            : 70;
  const overextensionPct = gatesSettings.overextension_pct  !== undefined ? gatesSettings.overextension_pct  : 8;

  if (sig.score < scoreThreshold) return false;
  if (!sig.price || sig.price < minPrice) return false;
  if (sig.rsi !== null && sig.rsi > rsiMax) return false;
  if (sig.ma50 && sig.price > sig.ma50 * (1 + overextensionPct / 100)) return false;
  return true;
}

// ─── Count Tier 1 technical confirmations (uses settings.gates) ─────────────
function countConfirmations(sig, volRatio) {
  const gatesSettings = settingsCache.getGates();
  const rsiMin = gatesSettings.rsi_min !== undefined ? gatesSettings.rsi_min : 30;
  const rsiMax = gatesSettings.rsi_max !== undefined ? gatesSettings.rsi_max : 70;

  let n = 0;
  if (sig.rsi !== null && sig.rsi >= rsiMin && sig.rsi <= rsiMax) n++;
  if (['bullish', 'above_signal'].includes(sig.macd_trend)) n++;
  if (sig.above_50ma) n++;
  if (volRatio !== null && volRatio >= 1.3) n++;
  return n;
}

// ─── Evaluate exit for a single open position (uses settings.sell) ────────────
// Returns { qty, sellPct, reason } or null (hold)
async function evaluateExit(position, sig) {
  const currentPrice = parseFloat(position.current_price);
  const avgEntry     = parseFloat(position.avg_entry_price);
  const qty          = parseInt(position.qty);
  const pnlPct       = ((currentPrice - avgEntry) / avgEntry) * 100;
  const peakPrice    = position.peak_price ? parseFloat(position.peak_price) : avgEntry;

  const sellSettings         = settingsCache.getSell();
  const hardStopPct          = sellSettings.hard_stop_pct                  !== undefined ? sellSettings.hard_stop_pct                  : -8;
  const trailingActivationPct = sellSettings.trailing_stop_activation_pct  !== undefined ? sellSettings.trailing_stop_activation_pct  : 5;
  const trailingStopPct      = sellSettings.trailing_stop_pct              !== undefined ? sellSettings.trailing_stop_pct              : 5;
  const extendedPricePct     = sellSettings.extended_price_pct             !== undefined ? sellSettings.extended_price_pct             : 10;

  // Layer 1: Hard Stop
  if (pnlPct <= hardStopPct) {
    return { qty, sellPct: 100, reason: `Hard stop: ${pnlPct.toFixed(1)}% from entry` };
  }

  // Layer 2: Trailing Stop
  if (pnlPct >= trailingActivationPct && currentPrice <= peakPrice * (1 - trailingStopPct / 100)) {
    return { qty, sellPct: 100, reason: `Trailing stop: price ${currentPrice} <= peak ${peakPrice.toFixed(2)} × (1 - ${trailingStopPct}%)` };
  }

  // Layer 3: RSI Overbought + Extended Price
  if (sig && sig.rsi !== null && sig.rsi >= 75 && sig.ma50) {
    const pctAbove50 = ((currentPrice / sig.ma50) - 1) * 100;
    if (pctAbove50 >= extendedPricePct) {
      return { qty, sellPct: 100, reason: `RSI overbought (${sig.rsi.toFixed(1)}) + extended ${pctAbove50.toFixed(1)}% above 50DMA` };
    }
  }

  // Layer 4: Pre-sell score
  if (sig) {
    let preSellScore = 0;
    if (sig.price < sig.ma50)          preSellScore++;
    if (sig.ma50  < sig.ma200)         preSellScore++;
    if (sig.macd_trend === 'bearish')  preSellScore++;
    if (sig.ema9  < sig.ema21)         preSellScore++;

    const spy = await db.queryOne(`SELECT price, ma50 FROM stock_signals WHERE symbol='SPY'`);
    if (spy && parseFloat(spy.price) < parseFloat(spy.ma50)) preSellScore++;

    if (preSellScore >= 3) {
      return {
        qty,
        sellPct: 100,
        reason: `pre_sell_score ${preSellScore}≥3: ${[
          sig.price < sig.ma50         ? 'price<50DMA'    : null,
          sig.ma50  < sig.ma200        ? '50DMA<200DMA'   : null,
          sig.macd_trend === 'bearish' ? 'MACD bearish'   : null,
          sig.ema9  < sig.ema21        ? 'EMA9<EMA21'     : null,
          spy && parseFloat(spy.price) < parseFloat(spy.ma50) ? 'SPY<50DMA' : null,
        ].filter(Boolean).join(', ')}`
      };
    }
  }

  return null; // hold
}

// ─── Place a market order and record it ──────────────────────────────────────
async function placeOrder(symbol, side, qty, reason = '', sellPct = null, price = null, claudeFields = {}) {
  try {
    const order = await alpacaPost('/orders', {
      symbol,
      qty,
      side,
      type:          'market',
      time_in_force: 'day',
    });

    const entryReason      = side === 'buy'  ? reason : null;
    const exitReason       = side === 'sell' ? reason : null;
    const claudeRank       = claudeFields.rank       ?? null;
    const claudeConfidence = claudeFields.confidence ?? null;
    const claudeReasoning  = claudeFields.reasoning  ?? null;
    const claudeMarket     = claudeFields.market     ?? null;

    await db.query(
      `INSERT INTO autotrader_trades
         (symbol, action, qty, price, exit_reason, entry_reason,
          claude_rank, claude_confidence, claude_reasoning, claude_market,
          sell_pct, alpaca_order_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [symbol, side, qty, price, exitReason, entryReason,
       claudeRank, claudeConfidence, claudeReasoning, claudeMarket,
       sellPct, order.id]
    );

    await db.log('info', 'autotrader',
      `${side.toUpperCase()} ${qty} ${symbol} — ${reason} (order ${order.id})`);
    return order;
  } catch (err) {
    const msg     = err.response?.data?.message || err.message || 'Unknown error';
    const errText = `${side.toUpperCase()} order failed: ${symbol} ${qty}sh — ${msg}`;
    await db.log('error', 'autotrader', errText);
    throw new Error(errText);
  }
}

// ─── Main evaluate — generates recommendations or executes trades ─────────────
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
    const regime   = await getMarketRegime();
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
      const flagRows = await db.query(`SELECT symbol, autotrader_on FROM position_flags`);
      const flagMap  = new Map(flagRows.map(r => [r.symbol, r.autotrader_on]));

      const placeholders = positions.map(() => '?').join(',');
      const sigs = await db.query(
        `SELECT * FROM stock_signals WHERE symbol IN (${placeholders})`,
        positions.map(p => p.symbol)
      );
      const sigMap = new Map(sigs.map(s => [s.symbol, s]));

      for (const pos of positions) {
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
                await db.query(`UPDATE watchlist SET pick_flag = 0 WHERE symbol = ?`, [pos.symbol]);
              }
            } catch (e) {
              action.executed = false;
              action.error    = e.message;
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
      return results;
    }

    // Fetch VIX for position sizing
    const vix  = await getVixEstimate();
    const mult = vixMultiplier(vix);
    results.vix     = vix  ? +vix.toFixed(1)  : null;
    results.vixMult = mult;
    if (mult < 1.0) {
      await db.log('info', 'autotrader', `VIX ~${results.vix} → position size reduced to ${mult * 100}%`);
    }

    let account = {};
    try {
      account = await alpacaGet('/account');
    } catch (e) {
      results.errors.push({ phase: 'account', message: e.message });
    }

    const accountEquity = parseFloat(account.equity || account.portfolio_value || 0);
    const buyingPower   = parseFloat(account.buying_power || 0);
    const maxPositions  = parseInt(await getConfig('autorun_max_positions', '15'));
    const openSlots     = Math.max(0, maxPositions - heldSymbols.size);

    if (openSlots <= 0) {
      results.skipped.push({ reason: `Portfolio full: ${heldSymbols.size}/${maxPositions} positions` });
      return results;
    }

    // Daily spend cap: 25% of (cash - 20% equity floor)
    const dailySpendCap = calcDailySpendCap(accountEquity, buyingPower);
    if (dailySpendCap < 10) {
      results.skipped.push({ reason: `Daily spend cap too low ($${dailySpendCap.toFixed(0)}) — at or near cash floor` });
      return results;
    }
    results.dailySpendCap = +dailySpendCap.toFixed(2);

    // How many new tickers already bought today? Max 5/day.
    const todayNewTickers   = await getTodayNewTickerCount(heldSymbols);
    const newTickerSlotsLeft = Math.min(5 - todayNewTickers, openSlots);
    if (newTickerSlotsLeft <= 0) {
      results.skipped.push({ reason: `Daily new ticker limit reached (${todayNewTickers}/5 bought today)` });
      return results;
    }

    // Fetch top-10 BUY candidates: new positions only, pick_flag=1, sorted by score
    const candidates = await db.query(
      `SELECT ss.* FROM stock_signals ss
       INNER JOIN watchlist w ON w.symbol = ss.symbol AND w.is_active = 1 AND w.pick_flag = 1
       WHERE ss.recommendation = 'BUY'
         AND ss.price >= 5
         AND ss.symbol NOT IN (${heldSymbols.size > 0 ? [...heldSymbols].map(() => '?').join(',') : "'__NONE__'"})
       ORDER BY ss.score DESC
       LIMIT 10`,
      heldSymbols.size > 0 ? [...heldSymbols] : []
    );

    if (!candidates.length) {
      results.skipped.push({ reason: 'No BUY-rated candidates available for new positions' });
      return results;
    }

    // Pre-screen: earnings guard (skip if earnings within 5 days)
    const eligible = [];
    for (const sig of candidates) {
      try {
        const earnings = await finnhub.getEarnings(sig.symbol);
        if (earnings.daysToEarnings !== null && earnings.daysToEarnings >= 0 && earnings.daysToEarnings <= 5) {
          results.skipped.push({ symbol: sig.symbol, score: sig.score,
            reason: `Earnings in ${earnings.daysToEarnings}d — skip` });
          continue;
        }
      } catch (_) {}
      eligible.push(sig);
    }

    if (!eligible.length) {
      results.skipped.push({ reason: 'All candidates have earnings within 5 days' });
      return results;
    }

    // ── Claude advisory: rank eligible candidates ─────────────────────────────
    let claudeResult = null;
    try {
      claudeResult = await claudeAdvisor.getRankedPicks(eligible, regime, vix, null);
    } catch (e) {
      await db.log('warn', 'autotrader', `Claude advisor error: ${e.message}`);
    }

    // Build ranked buy list: use Claude's symbols_to_buy (up to newTickerSlotsLeft)
    // Fallback to top eligible by score if Claude failed entirely
    let symbolsToBuy = [];
    let rankingMap   = new Map(); // symbol → { rank, confidence, reasoning }
    let marketAssessment = '';

    if (claudeResult && claudeResult.symbols_to_buy.length > 0) {
      symbolsToBuy     = claudeResult.symbols_to_buy.slice(0, newTickerSlotsLeft);
      marketAssessment = claudeResult.market_assessment || '';
      for (const r of claudeResult.rankings) {
        rankingMap.set(r.symbol, { rank: r.rank, confidence: r.confidence, reasoning: r.reasoning });
      }
      await db.log('info', 'autotrader',
        `Claude picked: ${symbolsToBuy.join(', ')} (${claudeResult.fallback ? 'fallback' : 'AI'})`);
    } else {
      symbolsToBuy = eligible.slice(0, newTickerSlotsLeft).map(s => s.symbol);
      await db.log('warn', 'autotrader', `No Claude result — using top-${symbolsToBuy.length} by score`);
    }

    // Build a signal map for quick lookup
    const sigMap = new Map(eligible.map(s => [s.symbol, s]));

    // Execute buys in Claude's ranked order
    let totalSpent = 0;
    for (const symbol of symbolsToBuy) {
      const sig = sigMap.get(symbol);
      if (!sig) continue;

      const remaining = dailySpendCap - totalSpent;
      if (remaining < sig.price) {
        results.skipped.push({ symbol, reason: `Daily spend cap exhausted ($${remaining.toFixed(0)} left, price $${parseFloat(sig.price).toFixed(2)})` });
        break;
      }

      const volRatio     = await getVolumeRatio(symbol);
      const confirmCount = countConfirmations(sig, volRatio);
      const ranking      = rankingMap.get(symbol) || {};

      // Build buy reason string
      const confirmDetail = [];
      const gs = settingsCache.getGates();
      const rsiMin = gs.rsi_min ?? 30, rsiMax = gs.rsi_max ?? 70;
      if (sig.rsi !== null && sig.rsi >= rsiMin && sig.rsi <= rsiMax) confirmDetail.push(`RSI ${parseFloat(sig.rsi).toFixed(1)}`);
      if (['bullish', 'above_signal'].includes(sig.macd_trend)) confirmDetail.push(`MACD ${sig.macd_trend}`);
      if (sig.above_50ma) confirmDetail.push('above 50MA');
      if (volRatio !== null && volRatio >= 1.3) confirmDetail.push(`vol ${volRatio.toFixed(1)}x`);
      const buyReason = `Score ${parseFloat(sig.score).toFixed(1)} | Claude rank #${ranking.rank ?? '?'} | ${confirmDetail.join(' | ')}`;

      const shares = calcPositionSizeFromCap(
        Math.min(remaining, dailySpendCap),
        symbolsToBuy.length,
        parseFloat(sig.price),
        accountEquity,
        mult
      );

      const action = {
        symbol,
        action:        'buy',
        qty:           shares,
        price:         parseFloat(sig.price),
        score:         parseFloat(sig.score),
        confirmations: confirmCount,
        volRatio:      volRatio ? +volRatio.toFixed(2) : null,
        vixMult:       mult,
        claudeRank:    ranking.rank ?? null,
        claudeConf:    ranking.confidence ?? null,
      };
      results.entries.push(action);

      if (execute) {
        if (shares < 1) {
          results.skipped.push({ symbol, reason: 'Position size < 1 share (insufficient funds)' });
          continue;
        }
        try {
          await placeOrder(
            symbol, 'buy', shares, buyReason, null, parseFloat(sig.price),
            {
              rank:       ranking.rank       ?? null,
              confidence: ranking.confidence ?? null,
              reasoning:  ranking.reasoning  ?? null,
              market:     marketAssessment   || null,
            }
          );
          action.executed = true;
          heldSymbols.add(symbol);
          totalSpent += shares * parseFloat(sig.price);

          // Mark as autotrader-managed
          await db.query(
            `INSERT INTO position_flags (symbol, autotrader_on) VALUES (?,1)
             ON DUPLICATE KEY UPDATE autotrader_on=1, updated_at=NOW()`,
            [symbol]
          );
        } catch (e) {
          action.executed = false;
          action.error    = e.message;
          results.errors.push({ phase: 'buy', symbol, message: e.message });
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
async function run() {
  const enabled = await getConfig('autorun_enabled', '0');
  if (enabled !== '1') return null;

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
