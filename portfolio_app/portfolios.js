// Portfolio builder — generates 3 risk-tier portfolios from scored stock signals
// Each portfolio: ranked BUY candidates, allocation %, shares, dollar amounts

const db = require('../db/db');

// ─── Portfolio definitions ────────────────────────────────────────────────────
const PORTFOLIO_DEFS = [
  {
    name:       'Aggressive / High Risk',
    risk_level: 'high',
    maxStocks:  8,
    minScore:   60,
    maxPctPer:  20,   // max % per single stock
    // Selection bias: momentum (recent crosses, high score)
    sortBonus: s => {
      let b = 0;
      if (s.cross_type === 'golden_cross') b += 10;
      if (s.golden_cross_ago !== null && s.golden_cross_ago <= 5) b += 8;
      if (s.price_crossed_200ma_ago !== null) b += 6;
      if (s.price_crossed_50ma_ago  !== null) b += 4;
      if (s.macd_cross_ago !== null && s.macd_cross_ago <= 2) b += 5;
      return b;
    },
  },
  {
    name:       'Moderate / Medium Risk',
    risk_level: 'medium',
    maxStocks:  10,
    minScore:   45,
    maxPctPer:  15,
    // Selection bias: balance of momentum + value
    sortBonus: s => {
      let b = 0;
      if (s.cross_type === 'golden_cross') b += 5;
      if (s.fwd_pe_improving) b += 6;
      if (s.pe_trailing && s.pe_trailing <= 20) b += 4;
      if (s.rsi && s.rsi < 50) b += 3;  // room to run
      return b;
    },
  },
  {
    name:       'Balanced / Low Risk',
    risk_level: 'low',
    maxStocks:  12,
    minScore:   30,
    maxPctPer:  10,
    // Selection bias: value + dividend + lower volatility
    sortBonus: s => {
      let b = 0;
      if (s.dividend_yield && s.dividend_yield >= 3) b += 8;
      if (s.pe_trailing && s.pe_trailing <= 15) b += 6;
      if (s.fwd_pe_improving) b += 4;
      if (s.above_200ma) b += 3;  // stability
      return b;
    },
  },
];

// ─── Allocate by score weight with a per-stock cap ───────────────────────────
function allocate(candidates, maxPctPer, budget) {
  if (!candidates.length) return [];

  const totalScore = candidates.reduce((s, c) => s + c.score, 0);

  // First pass: raw weights
  let allocs = candidates.map(c => ({
    ...c,
    rawPct: totalScore > 0 ? (c.score / totalScore) * 100 : 100 / candidates.length,
  }));

  // Second pass: cap at maxPctPer and redistribute remainder
  let capped = false;
  do {
    capped = false;
    const uncapped = allocs.filter(a => a.rawPct < maxPctPer);
    const capSum   = allocs.filter(a => a.rawPct >= maxPctPer).reduce((s, a) => s + a.rawPct - maxPctPer, 0);
    if (capSum > 0 && uncapped.length > 0) {
      const uncappedScore = uncapped.reduce((s, a) => s + a.score, 0);
      allocs = allocs.map(a => {
        if (a.rawPct >= maxPctPer) { capped = true; return { ...a, rawPct: maxPctPer }; }
        const bonus = uncappedScore > 0 ? (a.score / uncappedScore) * capSum : capSum / uncapped.length;
        return { ...a, rawPct: a.rawPct + bonus };
      });
    }
  } while (capped && allocs.some(a => a.rawPct > maxPctPer + 0.01));

  // Round percentages (ensure sum = 100)
  const rounded = allocs.map(a => ({ ...a, allocation_pct: Math.round(a.rawPct * 10) / 10 }));
  const diff = 100 - rounded.reduce((s, a) => s + a.allocation_pct, 0);
  if (rounded.length > 0) rounded[0].allocation_pct = Math.round((rounded[0].allocation_pct + diff) * 10) / 10;

  // Dollar amounts and shares
  return rounded.map(a => {
    const dollarAmt = Math.round((budget * a.allocation_pct / 100) * 100) / 100;
    const shares    = a.price > 0 ? Math.floor(dollarAmt / a.price) : 0;
    const actual    = Math.round(shares * a.price * 100) / 100;
    return {
      symbol:         a.symbol,
      name:           a.name           || a.symbol,
      score:          Math.round(a.score * 10) / 10,
      recommendation: a.recommendation,
      allocation_pct: a.allocation_pct,
      price:          a.price,
      shares,
      amount:         actual,
      reason:         a.why || '',
      cross_type:     a.cross_type,
      rsi:            a.rsi,
    };
  }).filter(a => a.shares > 0);
}

// ─── Build all 3 portfolios and save to DB ────────────────────────────────────
async function buildPortfolios(budgets = {}) {
  const defaultBudgets = { high: 5000, medium: 10000, low: 20000 };
  const B = { ...defaultBudgets, ...budgets };

  // Fetch all scored BUY/HOLD signals, stocks only (exclude ETF/funds for execution)
  const rows = await db.query(
    `SELECT s.*, w.asset_type AS wl_type
     FROM stock_signals s
     JOIN watchlist w ON w.symbol = s.symbol
     WHERE s.recommendation IN ('BUY','HOLD')
       AND w.is_active = 1
       AND (s.asset_type = 'stock' OR s.asset_type IS NULL)
     ORDER BY s.score DESC`
  );

  const portfolioIds = [];

  for (const def of PORTFOLIO_DEFS) {
    const budget = B[def.risk_level];

    // Filter by minimum score
    let candidates = rows.filter(r => r.score >= def.minScore);

    // Apply sort bonus to prioritize the right type of stocks per tier
    candidates = candidates
      .map(r => ({ ...r, sortScore: r.score + def.sortBonus(r) }))
      .sort((a, b) => b.sortScore - a.sortScore)
      .slice(0, def.maxStocks);

    const holdings = allocate(candidates, def.maxPctPer, budget);
    const totalDeployed = holdings.reduce((s, h) => s + h.amount, 0);
    const cashLeft = Math.round((budget - totalDeployed) * 100) / 100;

    // Expire any prior pending portfolios of same risk level
    await db.query(
      `UPDATE portfolio_recs SET status='pending'
       WHERE risk_level = ? AND status = 'pending'`,
      [def.risk_level]
    );

    const id = await db.insert(
      `INSERT INTO portfolio_recs (name, risk_level, budget_usd, holdings, status)
       VALUES (?, ?, ?, ?, 'pending')`,
      [def.name, def.risk_level, budget, JSON.stringify({ holdings, cashLeft, totalDeployed })]
    );

    portfolioIds.push(id);
    console.log(`[Portfolios] Built "${def.name}": ${holdings.length} stocks, $${totalDeployed} of $${budget}`);
  }

  return portfolioIds;
}

// ─── Latest PENDING recommended portfolios (high / medium / low only) ────────
async function getLatestPortfolios() {
  return db.query(
    `SELECT p.*
     FROM portfolio_recs p
     INNER JOIN (
       SELECT risk_level, MAX(id) AS max_id
       FROM portfolio_recs
       WHERE risk_level IN ('high','medium','low') AND status = 'pending'
       GROUP BY risk_level
     ) latest ON p.id = latest.max_id
     ORDER BY FIELD(p.risk_level,'high','medium','low')`
  );
}

// ─── All executed portfolios + pending custom portfolios ─────────────────────
async function getActivePortfolios() {
  return db.query(
    `SELECT * FROM portfolio_recs
     WHERE status = 'executed'
        OR (risk_level = 'custom' AND status = 'pending')
     ORDER BY id DESC`
  );
}

// ─── Build a custom portfolio from user-selected symbols ─────────────────────
async function buildCustomPortfolio(name, budget, symbols) {
  if (!symbols || symbols.length === 0) throw new Error('No symbols provided');
  const placeholders = symbols.map(() => '?').join(',');
  const rows = await db.query(
    `SELECT * FROM stock_signals WHERE symbol IN (${placeholders}) AND price > 0`,
    symbols
  );
  if (!rows.length) throw new Error('No signal data found for selected symbols');

  // Score-weighted with no per-stock cap — user explicitly chose these stocks
  const maxPctPer = Math.min(100, Math.max(20, Math.round(100 / rows.length) + 10));
  const holdings = allocate(rows, maxPctPer, budget);
  const totalDeployed = holdings.reduce((s, h) => s + h.amount, 0);
  const cashLeft = Math.round((budget - totalDeployed) * 100) / 100;

  const id = await db.insert(
    `INSERT INTO portfolio_recs (name, risk_level, budget_usd, holdings, status)
     VALUES (?, 'custom', ?, ?, 'pending')`,
    [name, budget, JSON.stringify({ holdings, cashLeft, totalDeployed })]
  );
  console.log(`[Portfolios] Built custom "${name}": ${holdings.length} stocks, $${totalDeployed} of $${budget}`);
  return id;
}

module.exports = { buildPortfolios, getLatestPortfolios, getActivePortfolios, buildCustomPortfolio };
