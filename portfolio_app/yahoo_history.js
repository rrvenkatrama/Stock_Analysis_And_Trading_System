// Data layer for My Stocks dashboard
// Price history  → Alpaca (no rate limits, already configured)
// Fundamentals   → Finnhub (60 req/min, already configured) — PE, dividend, sector
// Name/type      → Yahoo Finance quote() as enrichment (serial, graceful on rate limit)

const yf      = require('yahoo-finance2').default;
const alpaca  = require('../data/alpacaData');
const finnhub = require('../data/finnhub');
const db      = require('../db/db');

// Finnhub free tier = 60 req/min. We make 3 calls/symbol (fundamentals + profile + analyst).
// 2000ms between symbols => 0.5 symbols/sec => ~90 calls/min: safe with burst allowance.
const FUND_DELAY  = 2000; // ms between symbols during fundamentals phase
const QUOTE_DELAY = 800;  // ms between Yahoo quote calls (name/type enrichment only)

const ETF_TYPES  = new Set(['ETF', 'EXCHANGE_TRADED_FUND']);
const FUND_TYPES = new Set(['MUTUALFUND', 'MONEY_MARKET']);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function classifyAssetType(quote) {
  const qt = (quote?.quoteType || '').toUpperCase();
  if (ETF_TYPES.has(qt))  return 'etf';
  if (FUND_TYPES.has(qt)) return 'fund';
  return 'stock';
}

async function withRetry(fn, retries = 3, delayMs = 12000) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); } catch (err) {
      const blocked = err.message?.includes('Too Many') ||
                      err.message?.includes('429') ||
                      err.message?.includes('Unexpected token') ||
                      err.message?.includes('invalid json');
      if (blocked && i < retries - 1) {
        console.log(`\n[YF] Rate limited — waiting ${Math.round(delayMs * (i + 1) / 1000)}s...`);
        await sleep(delayMs * (i + 1));
        continue;
      }
      throw err;
    }
  }
}

// ─── Watchlist management ──────────────────────────────────────────────────────
async function seedWatchlist(symbols) {
  let inserted = 0;
  for (const sym of symbols) {
    try {
      await db.query(`INSERT IGNORE INTO watchlist (symbol) VALUES (?)`, [sym.toUpperCase()]);
      inserted++;
    } catch (_) {}
  }
  console.log(`[Watchlist] Seeded ${inserted} symbols`);
}

async function addTicker(symbol) {
  symbol = symbol.toUpperCase().trim();
  await db.query(
    `INSERT INTO watchlist (symbol, is_active) VALUES (?, 1)
     ON DUPLICATE KEY UPDATE is_active = 1`,
    [symbol]
  );
}

async function removeTicker(symbol) {
  await db.query(`UPDATE watchlist SET is_active = 0 WHERE symbol = ?`, [symbol.toUpperCase()]);
}

async function getActiveSymbols() {
  const rows = await db.query(`SELECT symbol FROM watchlist WHERE is_active = 1 ORDER BY symbol`);
  return rows.map(r => r.symbol);
}

// ─── Fetch price history from Alpaca and upsert into price_history ────────────
async function fetchHistory(symbol, fullYear = false) {
  try {
    const days = fullYear ? 380 : 15;
    const bars = await alpaca.getDailyBars(symbol, days);
    if (!bars || bars.length === 0) return 0;

    let count = 0;
    for (const bar of bars) {
      if (!bar.close || bar.close <= 0) continue;
      const d = bar.date instanceof Date
        ? bar.date.toISOString().slice(0, 10)
        : String(bar.date).slice(0, 10);
      await db.query(
        `INSERT INTO price_history (symbol, trade_date, open, high, low, close, adj_close, volume)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           open=VALUES(open), high=VALUES(high), low=VALUES(low),
           close=VALUES(close), adj_close=VALUES(adj_close), volume=VALUES(volume)`,
        [symbol, d,
         bar.open  || null, bar.high || null, bar.low || null,
         bar.close, bar.close, bar.volume || 0]
      );
      count++;
    }
    return count;
  } catch (err) {
    console.error(`[Alpaca] History fetch failed for ${symbol}: ${err.message}`);
    return 0;
  }
}

// ─── Fetch fundamentals: Finnhub (PE, div, sector) + Yahoo (enrichment) ────────
async function fetchQuote(symbol) {
  // Finnhub fundamentals + profile in parallel — reliable, rate-limited at 2000ms/symbol
  let peTrailing = null, peForward = null, divYield = null, psRatio = null;
  let epsGrowth = null, revenueGrowth = null, debtEquity = null, roe = null, beta = null;
  let name = symbol, sector = null, assetType = 'stock';
  const [fund, profile] = await Promise.allSettled([
    finnhub.getFundamentals(symbol),
    finnhub.getProfile(symbol),
  ]);
  if (fund.status === 'fulfilled' && fund.value) {
    const f = fund.value;
    peTrailing    = f.pe            || null;
    divYield      = f.dividendYield != null ? f.dividendYield : null;
    psRatio       = f.psRatio       || null;
    epsGrowth     = f.epsGrowthPct  != null ? f.epsGrowthPct  : null;
    revenueGrowth = f.revenueGrowth != null ? f.revenueGrowth : null;
    debtEquity    = f.debtEquity    != null ? f.debtEquity    : null;
    roe           = f.roe           != null ? f.roe           : null;
    beta          = f.beta          != null ? f.beta          : null;
  }
  if (profile.status === 'fulfilled' && profile.value) {
    const p = profile.value;
    name   = p.name   || name;
    sector = p.sector || null;
  }

  // Yahoo quote — enrichment: forward PE, short interest, rec consensus, price targets
  // Yahoo is rate-limited after ~10-15 requests; all fields here are optional enrichment
  let forwardPE = null, shortFloat = null, recMean = null, recCount = null;
  let targetMean = null, targetHigh = null, targetLow = null;
  try {
    const q = await yf.quote(symbol, {}, { validateResult: false });
    if (q) {
      if (!name || name === symbol) name = q.longName || q.shortName || symbol;
      if (!sector) sector = q.sector || null;
      assetType  = classifyAssetType(q);
      forwardPE  = q.forwardPE || null;
      shortFloat  = q.shortPercentOfFloat    != null ? q.shortPercentOfFloat * 100 : null;
      recMean     = q.recommendationMean     != null ? q.recommendationMean       : null;
      recCount    = q.numberOfAnalystOpinions!= null ? q.numberOfAnalystOpinions  : null;
      targetMean  = q.targetMeanPrice        != null ? q.targetMeanPrice          : null;
      targetHigh  = q.targetHighPrice        != null ? q.targetHighPrice          : null;
      targetLow   = q.targetLowPrice         != null ? q.targetLowPrice           : null;
      if (peTrailing === null && q.trailingPE) peTrailing = q.trailingPE;
      if (divYield === null) {
        divYield = q.trailingAnnualDividendYield
          ? q.trailingAnnualDividendYield * 100
          : (q.dividendYield ? q.dividendYield * 100 : null);
      }
    }
  } catch (_) { /* Yahoo failed — Finnhub data still used */ }

  return {
    symbol, name, sector, assetType,
    peTrailing, peForward: forwardPE, divYield, psRatio,
    epsGrowth, revenueGrowth, debtEquity, roe, beta, shortFloat,
    recMean, recCount, targetMean, targetHigh, targetLow,
  };
}

// ─── Get bars from DB for analysis ─────────────────────────────────────────────
async function getBarsFromDB(symbol, limit = 260) {
  const rows = await db.query(
    `SELECT trade_date, open, high, low, close, volume
     FROM price_history
     WHERE symbol = ?
     ORDER BY trade_date DESC
     LIMIT ?`,
    [symbol, limit]
  );
  return rows.reverse().map(r => ({
    date:   r.trade_date,
    open:   parseFloat(r.open)  || 0,
    high:   parseFloat(r.high)  || 0,
    low:    parseFloat(r.low)   || 0,
    close:  parseFloat(r.close),
    volume: parseInt(r.volume)  || 0,
  }));
}

// ─── Batch refresh: Alpaca history (fast) + Finnhub/Yahoo fundamentals (serial) ─
async function refreshAll(fullYear = false) {
  const symbols = await getActiveSymbols();
  console.log(`[Refresh] ${symbols.length} symbols | fullYear=${fullYear}`);

  // Phase 1: Alpaca price history — parallel, no rate limits
  let histOk = 0;
  for (let i = 0; i < symbols.length; i += 5) {
    const batch  = symbols.slice(i, i + 5);
    const counts = await Promise.all(batch.map(s => fetchHistory(s, fullYear)));
    histOk += counts.filter(n => n > 0).length;
    process.stdout.write(`\r[Refresh] History: ${Math.min(i + 5, symbols.length)}/${symbols.length} (${histOk} ok)`);
  }
  console.log(`\n[Refresh] History done — ${histOk}/${symbols.length} symbols`);

  // Phase 2: Fundamentals — Finnhub (primary) + Yahoo (enrichment), serial
  const quotes = {};
  console.log(`[Refresh] Fetching fundamentals (Finnhub + Yahoo)...`);
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    const q   = await fetchQuote(sym);
    if (q) {
      quotes[sym] = q;

      // Fetch analyst ratings (second Finnhub call per symbol)
      let analystBuy = 0, analystSell = 0, analystHold = 0;
      try {
        const ratings = await finnhub.getAnalystRatings(sym);
        analystBuy  = ratings.totalBuy  || 0;
        analystSell = ratings.totalSell || 0;
        analystHold = ratings.hold      || 0;
      } catch (_) {}

      await db.query(
        `UPDATE watchlist SET
         name=COALESCE(?,name), sector=COALESCE(?,sector), asset_type=COALESCE(?,asset_type),
         pe_trailing=COALESCE(?,pe_trailing), pe_forward=COALESCE(?,pe_forward),
         div_yield=COALESCE(?,div_yield), ps_ratio=COALESCE(?,ps_ratio),
         analyst_buy=?, analyst_sell=?, analyst_hold=?,
         eps_growth=COALESCE(?,eps_growth), revenue_growth=COALESCE(?,revenue_growth),
         debt_equity=COALESCE(?,debt_equity), roe=COALESCE(?,roe),
         beta=COALESCE(?,beta), short_float=COALESCE(?,short_float),
         rec_mean=COALESCE(?,rec_mean), rec_count=COALESCE(?,rec_count),
         target_mean=COALESCE(?,target_mean), target_high=COALESCE(?,target_high),
         target_low=COALESCE(?,target_low),
         fundamentals_at=NOW()
         WHERE symbol=?`,
        [q.name, q.sector, q.assetType,
         q.peTrailing, q.peForward, q.divYield, q.psRatio,
         analystBuy, analystSell, analystHold,
         q.epsGrowth, q.revenueGrowth, q.debtEquity, q.roe, q.beta, q.shortFloat,
         q.recMean, q.recCount,
         q.targetMean, q.targetHigh, q.targetLow,
         sym]
      );
    }
    process.stdout.write(`\r[Refresh] Fundamentals: ${i + 1}/${symbols.length}`);
    if (i + 1 < symbols.length) await sleep(FUND_DELAY);
  }
  console.log(`\n[Refresh] Fundamentals done — ${Object.keys(quotes).length}/${symbols.length}`);

  // Phase 3: Upgrade/downgrade refresh — weekly, separate Finnhub pass
  try {
    await refreshUpgrades();
  } catch (e) {
    console.error('[Refresh] Upgrades failed:', e.message);
  }

  return quotes;
}

// ─── Read cached fundamentals from watchlist (used by analyzer when quoteData is null) ──
async function getFundamentalsFromDB(symbol) {
  const row = await db.queryOne(
    `SELECT name, sector, asset_type, pe_trailing, pe_forward, div_yield,
            ps_ratio, analyst_buy, analyst_sell, analyst_hold,
            eps_growth, revenue_growth, debt_equity, roe, beta, short_float,
            rec_mean, rec_count, target_mean, target_high, target_low
     FROM watchlist WHERE symbol = ?`,
    [symbol]
  );
  if (!row) return null;
  return {
    name:          row.name,
    sector:        row.sector,
    assetType:     row.asset_type    || 'stock',
    peTrailing:    row.pe_trailing   != null ? parseFloat(row.pe_trailing)   : null,
    peForward:     row.pe_forward    != null ? parseFloat(row.pe_forward)    : null,
    divYield:      row.div_yield     != null ? parseFloat(row.div_yield)     : null,
    psRatio:       row.ps_ratio      != null ? parseFloat(row.ps_ratio)      : null,
    analystBuy:    row.analyst_buy   != null ? parseInt(row.analyst_buy)     : null,
    analystSell:   row.analyst_sell  != null ? parseInt(row.analyst_sell)    : null,
    analystHold:   row.analyst_hold  != null ? parseInt(row.analyst_hold)    : null,
    epsGrowth:     row.eps_growth    != null ? parseFloat(row.eps_growth)    : null,
    revenueGrowth: row.revenue_growth!= null ? parseFloat(row.revenue_growth): null,
    debtEquity:    row.debt_equity   != null ? parseFloat(row.debt_equity)   : null,
    roe:           row.roe           != null ? parseFloat(row.roe)           : null,
    beta:          row.beta          != null ? parseFloat(row.beta)          : null,
    shortFloat:    row.short_float   != null ? parseFloat(row.short_float)   : null,
    recMean:       row.rec_mean      != null ? parseFloat(row.rec_mean)      : null,
    recCount:      row.rec_count     != null ? parseInt(row.rec_count)       : null,
    targetMean:    row.target_mean   != null ? parseFloat(row.target_mean)   : null,
    targetHigh:    row.target_high   != null ? parseFloat(row.target_high)   : null,
    targetLow:     row.target_low    != null ? parseFloat(row.target_low)    : null,
  };
}

// ─── Refresh upgrades/downgrades for stale symbols — weekly, separate Finnhub pass ──
// Processes up to 60 symbols per run (2s delay each = ~2 min max).
async function refreshUpgrades() {
  const stale = await db.query(
    `SELECT symbol FROM watchlist
     WHERE is_active = 1
       AND (upgrades_at IS NULL OR upgrades_at < DATE_SUB(NOW(), INTERVAL 7 DAY))
     ORDER BY upgrades_at ASC
     LIMIT 60`
  );
  if (!stale.length) return;

  console.log(`[Refresh] Upgrades: ${stale.length} stale symbols`);
  for (let i = 0; i < stale.length; i++) {
    const sym = stale[i].symbol;
    try {
      const actions = await finnhub.getUpgradesDowngrades(sym);
      if (actions.length) {
        for (const u of actions) {
          await db.query(
            `INSERT INTO analyst_upgrades (symbol, action, from_grade, to_grade, firm, grade_date)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE action=VALUES(action), from_grade=VALUES(from_grade),
               to_grade=VALUES(to_grade), fetched_at=NOW()`,
            [sym, u.action, u.fromGrade, u.toGrade, u.firm, u.gradeDate]
          );
        }
      }
      await db.query(`UPDATE watchlist SET upgrades_at=NOW() WHERE symbol=?`, [sym]);
    } catch (_) {}
    process.stdout.write(`\r[Refresh] Upgrades: ${i + 1}/${stale.length}`);
    if (i + 1 < stale.length) await sleep(2000);
  }
  console.log('');
}

// ─── Refresh price targets for symbols missing them — slow Yahoo pass ────────
// Processes up to 15 symbols per run with 12s spacing to avoid rate-limiting.
// Only touches symbols where target_mean IS NULL (COALESCE protects existing data).
async function refreshTargets() {
  const stale = await db.query(
    `SELECT symbol FROM watchlist
     WHERE is_active = 1 AND target_mean IS NULL
     ORDER BY fundamentals_at ASC
     LIMIT 15`
  );
  if (!stale.length) {
    console.log('[Targets] All symbols already have price targets');
    return 0;
  }

  console.log(`[Targets] Fetching price targets for ${stale.length} symbols (12s spacing)...`);
  let updated = 0;
  for (let i = 0; i < stale.length; i++) {
    const sym = stale[i].symbol;
    try {
      const q = await withRetry(() => yf.quote(sym, {}, { validateResult: false }));
      if (q) {
        const targetMean = q.targetMeanPrice  != null ? q.targetMeanPrice  : null;
        const targetHigh = q.targetHighPrice  != null ? q.targetHighPrice  : null;
        const targetLow  = q.targetLowPrice   != null ? q.targetLowPrice   : null;
        const recMean    = q.recommendationMean     != null ? q.recommendationMean       : null;
        const recCount   = q.numberOfAnalystOpinions!= null ? q.numberOfAnalystOpinions  : null;
        const forwardPE  = q.forwardPE || null;
        const shortFloat = q.shortPercentOfFloat    != null ? q.shortPercentOfFloat * 100 : null;

        await db.query(
          `UPDATE watchlist SET
           target_mean  = COALESCE(target_mean,  ?),
           target_high  = COALESCE(target_high,  ?),
           target_low   = COALESCE(target_low,   ?),
           rec_mean     = COALESCE(rec_mean,     ?),
           rec_count    = COALESCE(rec_count,    ?),
           pe_forward   = COALESCE(pe_forward,   ?),
           short_float  = COALESCE(short_float,  ?)
           WHERE symbol = ?`,
          [targetMean, targetHigh, targetLow, recMean, recCount, forwardPE, shortFloat, sym]
        );
        if (targetMean !== null) updated++;
        process.stdout.write(`\r[Targets] ${i + 1}/${stale.length} — ${sym} target: ${targetMean ?? 'n/a'}`);
      }
    } catch (err) {
      console.error(`\n[Targets] ${sym} failed: ${err.message}`);
    }
    if (i + 1 < stale.length) await sleep(12000);
  }
  console.log(`\n[Targets] Done — ${updated}/${stale.length} targets populated`);
  return updated;
}

module.exports = {
  seedWatchlist, addTicker, removeTicker,
  getActiveSymbols, fetchHistory, fetchQuote,
  getBarsFromDB, refreshAll, refreshUpgrades, getFundamentalsFromDB, refreshTargets,
};
