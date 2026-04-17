// Phoenix Strategy — Deep Value Contrarian Screener
// Scores fundamentally strong companies that have been deeply discounted by market fear.
//
// Hard gates (all must pass before scoring):
//   1. Price ≥40% below 52-week high
//   2. Price today < price 1 year ago (YoY decline confirmed)
//   3. EPS growth > 0% (earnings intact — not a value trap)
//   4. Revenue growth > 0% (top line still growing)
//   5. Forward P/E < sector avg OR Forward P/S < sector avg (actually cheap vs peers)
//
// Scoring (0–100):
//   Earnings quality  (max 40): EPS growth + revenue growth tiers
//   Business quality  (max 24): ROE + debt/equity
//   Valuation         (max 27): fwd P/E vs sector, fwd P/S vs sector, drawdown depth
//   Mgmt confidence   (max 18): buybacks + analyst consensus
//
// Recommendation: BUY ≥60 | WATCH 35–59 | PASS <35

const db      = require('../db/db');
const { getBarsFromDB, getActiveSymbols, getFundamentalsFromDB } = require('./yahoo_history');
const { getSectorPE, getSectorPS } = require('../data/finnhub');

// ─── Sector average P/E fallbacks (broad defaults when Finnhub returns null) ─
const SECTOR_PE_DEFAULTS = {
  'Technology':            28,
  'Health Care':           22,
  'Consumer Discretionary':20,
  'Communication Services':18,
  'Financials':            14,
  'Industrials':           20,
  'Consumer Staples':      22,
  'Energy':                13,
  'Materials':             16,
  'Utilities':             18,
  'Real Estate':           30,
};
const SECTOR_PS_DEFAULTS = {
  'Technology':            6,
  'Health Care':           3,
  'Consumer Discretionary':1.5,
  'Communication Services':3,
  'Financials':            2.5,
  'Industrials':           1.5,
  'Consumer Staples':      0.8,
  'Energy':                1.2,
  'Materials':             1.2,
  'Utilities':             2,
  'Real Estate':           6,
};

function sectorPeDefault(sector)  { return SECTOR_PE_DEFAULTS[sector] || 20; }
function sectorPsDefault(sector)  { return SECTOR_PS_DEFAULTS[sector]  || 2;  }

// ─── Hard gates ───────────────────────────────────────────────────────────────
// Returns { pass: bool, reason: string }
function applyHardGates(fund, sig, sectorPeAvg, sectorPsAvg) {
  const pct = parseFloat(sig.pct_from_52high ?? 0);

  // Gate 1: ≥40% below 52wk high
  if (pct > -40) {
    return { pass: false, reason: `Only ${Math.abs(pct).toFixed(1)}% below 52wk high (need ≥40%)` };
  }

  // Gate 2: Price below 1yr ago
  if (sig.price_1y_ago && sig.price) {
    const yoyChg = ((parseFloat(sig.price) - parseFloat(sig.price_1y_ago)) / parseFloat(sig.price_1y_ago)) * 100;
    if (yoyChg >= 0) {
      return { pass: false, reason: `Price up ${yoyChg.toFixed(1)}% YoY (need YoY decline)` };
    }
  }
  // If price_1y_ago not available, skip gate 2 (we do our best)

  // Gate 3: EPS growth > 0
  const eps = parseFloat(fund.eps_growth ?? 0);
  if (eps <= 0) {
    return { pass: false, reason: `EPS growth ${eps.toFixed(1)}% ≤ 0 (value trap risk)` };
  }

  // Gate 4: Revenue growth > 0
  const rev = parseFloat(fund.revenue_growth ?? 0);
  if (rev <= 0) {
    return { pass: false, reason: `Revenue growth ${rev.toFixed(1)}% ≤ 0` };
  }

  // Gate 5: Valuation check (at least one of P/E or P/S must be below sector avg)
  const pe = fund.pe_forward ? parseFloat(fund.pe_forward) : null;
  const ps = fund.ps_ratio   ? parseFloat(fund.ps_ratio)   : null;
  if (pe !== null && sectorPeAvg !== null && pe >= sectorPeAvg) {
    if (ps !== null && sectorPsAvg !== null && ps >= sectorPsAvg) {
      return { pass: false, reason: `Fwd P/E ${pe.toFixed(1)} ≥ sector avg ${sectorPeAvg.toFixed(1)} AND P/S ${ps.toFixed(2)} ≥ sector avg ${sectorPsAvg.toFixed(2)}` };
    }
  }

  return { pass: true, reason: '' };
}

// ─── Phoenix scoring engine ───────────────────────────────────────────────────
function scorePhoenix(fund, sig, sectorPeAvg, sectorPsAvg) {
  let score = 0;
  const why  = [];

  const eps    = parseFloat(fund.eps_growth     ?? 0);
  const rev    = parseFloat(fund.revenue_growth ?? 0);
  const roe    = parseFloat(fund.roe            ?? 0);
  const de     = fund.debt_equity != null ? parseFloat(fund.debt_equity) : null;
  const pe     = fund.pe_forward  != null ? parseFloat(fund.pe_forward)  : null;
  const ps     = fund.ps_ratio    != null ? parseFloat(fund.ps_ratio)    : null;
  const buyPct = fund.analyst_buy  ? parseInt(fund.analyst_buy)  : 0;
  const sellPct= fund.analyst_sell ? parseInt(fund.analyst_sell) : 0;
  const holdPct= fund.analyst_hold ? parseInt(fund.analyst_hold) : 0;
  const total  = buyPct + sellPct + holdPct;
  const buyRatio = total > 0 ? buyPct / total : null;
  const drawdown = Math.abs(parseFloat(sig.pct_from_52high ?? 0));
  const buybackPct = sig.shares_buyback_pct != null ? parseFloat(sig.shares_buyback_pct) : null;

  // ── Earnings quality (max 40) ──────────────────────────────────────────────
  if (eps > 20)       { score += 20; why.push(`EPS growth ${eps.toFixed(0)}%`); }
  else if (eps > 10)  { score += 12; why.push(`EPS growth ${eps.toFixed(0)}%`); }
  else if (eps > 5)   { score +=  6; why.push(`EPS growth ${eps.toFixed(0)}%`); }
  else if (eps > 0)   { score +=  2; why.push(`EPS growth ${eps.toFixed(0)}%`); }

  if (rev > 15)       { score += 12; why.push(`Revenue growth ${rev.toFixed(0)}%`); }
  else if (rev > 5)   { score +=  6; why.push(`Revenue growth ${rev.toFixed(0)}%`); }
  else if (rev > 0)   { score +=  2; why.push(`Revenue growth ${rev.toFixed(0)}%`); }

  // ── Business quality (max 24) ─────────────────────────────────────────────
  if (roe > 20)       { score += 10; why.push(`ROE ${roe.toFixed(0)}%`); }
  else if (roe > 10)  { score +=  5; why.push(`ROE ${roe.toFixed(0)}%`); }
  else if (roe < 0)   { score -=  5; why.push(`ROE negative (${roe.toFixed(0)}%)`); }

  if (de !== null) {
    if (de < 0.5)     { score +=  8; why.push(`D/E ${de.toFixed(2)} (low leverage)`); }
    else if (de < 1.5){ score +=  4; why.push(`D/E ${de.toFixed(2)}`); }
    else if (de > 2.0){ score -=  6; why.push(`D/E ${de.toFixed(2)} (high leverage)`); }
  }

  // ── Valuation vs sector (max 27) ──────────────────────────────────────────
  if (pe !== null && sectorPeAvg !== null && sectorPeAvg > 0) {
    const peDiff = (sectorPeAvg - pe) / sectorPeAvg; // positive = below sector
    if (peDiff >= 0.40)      { score += 15; why.push(`Fwd P/E ${pe.toFixed(1)} (40%+ below sector ${sectorPeAvg.toFixed(0)})`); }
    else if (peDiff >= 0.20) { score +=  8; why.push(`Fwd P/E ${pe.toFixed(1)} (20-40% below sector)`); }
    else if (peDiff >= 0.10) { score +=  4; why.push(`Fwd P/E ${pe.toFixed(1)} (10-20% below sector)`); }
  } else if (ps !== null && sectorPsAvg !== null && sectorPsAvg > 0) {
    const psDiff = (sectorPsAvg - ps) / sectorPsAvg;
    if (psDiff >= 0.40)      { score += 12; why.push(`P/S ${ps.toFixed(2)} (40%+ below sector ${sectorPsAvg.toFixed(1)})`); }
    else if (psDiff >= 0.20) { score +=  7; why.push(`P/S ${ps.toFixed(2)} (20-40% below sector)`); }
  }

  if (drawdown >= 60)       { score += 10; why.push(`${drawdown.toFixed(0)}% below 52wk high (extreme discount)`); }
  else if (drawdown >= 40)  { score +=  5; why.push(`${drawdown.toFixed(0)}% below 52wk high`); }

  // ── Management confidence + analyst sentiment (max 18) ────────────────────
  if (buybackPct !== null) {
    if (buybackPct <= -2)    { score += 10; why.push(`Active buybacks (shares -${Math.abs(buybackPct).toFixed(1)}% YoY)`); }
    else if (buybackPct <= -1){ score +=  5; why.push(`Moderate buybacks (shares -${Math.abs(buybackPct).toFixed(1)}% YoY)`); }
  }

  if (buyRatio !== null) {
    if (buyRatio >= 0.60)    { score +=  8; why.push(`${Math.round(buyRatio*100)}% analysts Buy`); }
    else if (buyRatio >= 0.40){ score +=  4; why.push(`${Math.round(buyRatio*100)}% analysts Buy`); }
    else if (buyRatio < 0.20) { score -=  6; why.push(`Only ${Math.round(buyRatio*100)}% analysts Buy`); }
  }

  score = Math.min(100, Math.max(0, Math.round(score)));
  const recommendation = score >= 60 ? 'BUY' : score >= 35 ? 'WATCH' : 'PASS';

  return { score, recommendation, why: why.join(' · ') };
}

// ─── Score a single symbol ────────────────────────────────────────────────────
async function scoreSymbol(symbol) {
  const fund = await getFundamentalsFromDB(symbol);
  if (!fund) return null;

  // Get pre-computed signal data (for price, 52wk range, pct_from_52high)
  const sig = await db.queryOne(
    `SELECT price, price_change_pct, high_52w, low_52w, pct_from_52high,
            shares_buyback_pct, analyst_buy, analyst_sell, analyst_hold
     FROM stock_signals WHERE symbol = ?`, [symbol]
  );
  if (!sig || !sig.price) return null;

  // Get price 1 year ago from price_history (~252 trading days)
  const yearAgoRow = await db.queryOne(
    `SELECT close FROM price_history WHERE symbol = ?
     ORDER BY trade_date DESC LIMIT 1 OFFSET 251`, [symbol]
  );
  sig.price_1y_ago       = yearAgoRow ? parseFloat(yearAgoRow.close) : null;
  sig.shares_buyback_pct = sig.shares_buyback_pct ?? fund.shares_buyback_pct ?? null;

  // Sector averages (Finnhub, with fallback to hardcoded defaults)
  const sector     = fund.sector || sig.sector || null;
  let sectorPeAvg  = null;
  let sectorPsAvg  = null;
  try {
    sectorPeAvg = sector ? (await getSectorPE(sector)  ?? sectorPeDefault(sector)) : null;
    sectorPsAvg = sector ? (await getSectorPS(sector)  ?? sectorPsDefault(sector)) : null;
  } catch (_) {
    sectorPeAvg = sectorPeDefault(sector);
    sectorPsAvg = sectorPsDefault(sector);
  }

  const gate = applyHardGates(fund, sig, sectorPeAvg, sectorPsAvg);
  if (!gate.pass) {
    return { symbol, score: 0, recommendation: 'PASS', why: `Gate fail: ${gate.reason}`, gatePass: false };
  }

  const { score, recommendation, why } = scorePhoenix(fund, sig, sectorPeAvg, sectorPsAvg);

  // Build YoY price change
  const price1y  = sig.price_1y_ago;
  const price1yChg = price1y
    ? ((parseFloat(sig.price) - price1y) / price1y) * 100
    : null;

  return {
    symbol,
    name:           fund.name,
    sector,
    price:          parseFloat(sig.price),
    price_change_pct: sig.price_change_pct,
    high_52w:       sig.high_52w,
    low_52w:        sig.low_52w,
    pct_from_52high: sig.pct_from_52high,
    price_1y_ago:   price1y,
    price_change_1y: price1yChg?.toFixed(2) ?? null,
    eps_growth:     fund.eps_growth,
    revenue_growth: fund.revenue_growth,
    roe:            fund.roe,
    debt_equity:    fund.debt_equity,
    pe_forward:     fund.pe_forward,
    ps_ratio:       fund.ps_ratio,
    dividend_yield: fund.div_yield,
    analyst_buy:    fund.analyst_buy,
    analyst_sell:   fund.analyst_sell,
    analyst_hold:   fund.analyst_hold,
    shares_buyback_pct: sig.shares_buyback_pct,
    score,
    recommendation,
    why,
    gatePass: true,
  };
}

// ─── Score all active watchlist symbols and upsert to phoenix_signals ─────────
async function scoreAll() {
  const symbols = await getActiveSymbols();
  const results = [];

  for (const symbol of symbols) {
    try {
      const r = await scoreSymbol(symbol);
      if (!r) continue;

      await db.query(
        `INSERT INTO phoenix_signals
           (symbol, name, sector, price, price_change_pct, high_52w, low_52w,
            pct_from_52high, price_1y_ago, price_change_1y,
            eps_growth, revenue_growth, roe, debt_equity,
            pe_forward, ps_ratio, dividend_yield,
            analyst_buy, analyst_sell, analyst_hold,
            shares_buyback_pct, score, recommendation, why)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           name=VALUES(name), sector=VALUES(sector), price=VALUES(price),
           price_change_pct=VALUES(price_change_pct),
           high_52w=VALUES(high_52w), low_52w=VALUES(low_52w),
           pct_from_52high=VALUES(pct_from_52high),
           price_1y_ago=VALUES(price_1y_ago), price_change_1y=VALUES(price_change_1y),
           eps_growth=VALUES(eps_growth), revenue_growth=VALUES(revenue_growth),
           roe=VALUES(roe), debt_equity=VALUES(debt_equity),
           pe_forward=VALUES(pe_forward), ps_ratio=VALUES(ps_ratio),
           dividend_yield=VALUES(dividend_yield),
           analyst_buy=VALUES(analyst_buy), analyst_sell=VALUES(analyst_sell),
           analyst_hold=VALUES(analyst_hold),
           shares_buyback_pct=VALUES(shares_buyback_pct),
           score=VALUES(score), recommendation=VALUES(recommendation), why=VALUES(why),
           generated_at=NOW()`,
        [
          r.symbol, r.name, r.sector, r.price, r.price_change_pct,
          r.high_52w, r.low_52w, r.pct_from_52high,
          r.price_1y_ago, r.price_change_1y,
          r.eps_growth, r.revenue_growth, r.roe, r.debt_equity,
          r.pe_forward, r.ps_ratio, r.dividend_yield,
          r.analyst_buy, r.analyst_sell, r.analyst_hold,
          r.shares_buyback_pct,
          r.score, r.recommendation, r.why,
        ]
      );

      if (r.gatePass) results.push(r);
    } catch (e) {
      console.error(`[Phoenix Screener] ${symbol} error:`, e.message);
    }
  }

  const buys   = results.filter(r => r.recommendation === 'BUY').length;
  const watches = results.filter(r => r.recommendation === 'WATCH').length;
  console.log(`[Phoenix Screener] Scored ${results.length} gate-passing stocks: ${buys} BUY, ${watches} WATCH`);
  return results;
}

// ─── Get current Phoenix BUY/WATCH signals from DB (for dashboard) ────────────
async function getPhoenixSignals(minRec = 'WATCH') {
  const recs = minRec === 'BUY' ? `('BUY')` : `('BUY','WATCH')`;
  return db.query(
    `SELECT * FROM phoenix_signals WHERE recommendation IN ${recs} ORDER BY score DESC`
  );
}

module.exports = { scoreAll, scoreSymbol, getPhoenixSignals };
