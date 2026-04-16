// Portfolio builder — creates 3-4 recommended portfolios with allocations

const db = require('../db/db');
const crypto = require('crypto');

/**
 * Build 3-4 recommended portfolios based on latest analysis
 */
async function buildPortfolioRecommendations() {
  console.log('[PortfolioBuilder] Building recommended portfolios...');

  try {
    // Get all stocks with latest analysis
    const stocks = await db.query(`
      SELECT sa.*, ms.sector
      FROM stock_analysis sa
      JOIN my_stocks ms ON sa.ticker = ms.ticker
      WHERE (sa.ticker, sa.analysis_date) IN (
        SELECT ticker, MAX(analysis_date) FROM stock_analysis GROUP BY ticker
      )
      AND sa.recommendation IN ('buy', 'hold')
      AND ms.status = 'active'
      ORDER BY sa.composite_score DESC
    `);

    if (stocks.length === 0) {
      console.log('[PortfolioBuilder] No candidate stocks found');
      return [];
    }

    // Separate by recommendation strength
    const strongBuys = stocks.filter(s => s.composite_score >= 75);
    const buys = stocks.filter(s => s.composite_score >= 65 && s.composite_score < 75);
    const holds = stocks.filter(s => s.composite_score < 65);

    const portfolios = [];

    // Portfolio 1: Conservative (Low Risk)
    const conservative = buildConvervativePortfolio(stocks, strongBuys, buys, holds);
    if (conservative) portfolios.push(conservative);

    // Portfolio 2: Moderate (Medium Risk)
    const moderate = buildModeratePortfolio(stocks, strongBuys, buys, holds);
    if (moderate) portfolios.push(moderate);

    // Portfolio 3: Aggressive (High Risk)
    const aggressive = buildAggressivePortfolio(stocks, strongBuys, buys, holds);
    if (aggressive) portfolios.push(aggressive);

    // Save portfolios to database
    for (const portfolio of portfolios) {
      await savePortfolio(portfolio);
    }

    console.log(`[PortfolioBuilder] Generated ${portfolios.length} portfolios`);
    return portfolios;

  } catch (err) {
    console.error('[PortfolioBuilder] Error:', err.message);
    await db.log('error', 'mystocks', `Portfolio building failed: ${err.message}`);
    return [];
  }
}

/**
 * Conservative Portfolio (Low Risk)
 * - Fewer positions, higher conviction stocks
 * - Only strong buys + select buys
 * - Even allocation
 */
function buildConvervativePortfolio(allStocks, strongBuys, buys, holds) {
  if (allStocks.length < 3) return null;

  // Pick top 5-6 stocks with best scores
  const selected = allStocks.slice(0, Math.min(6, Math.ceil(allStocks.length * 0.25)));

  // Diversify by sector if possible
  const diversified = diversifySectors(selected);

  // Equal weight or slightly favor higher scores
  const totalScore = diversified.reduce((s, st) => s + st.composite_score, 0);
  const holdings = diversified.map(stock => ({
    ticker: stock.ticker,
    allocation_pct: (stock.composite_score / totalScore) * 100,
    reason: buildHoldingReason(stock),
  }));

  // Normalize to 100%
  const totalAlloc = holdings.reduce((s, h) => s + h.allocation_pct, 0);
  holdings.forEach(h => { h.allocation_pct = (h.allocation_pct / totalAlloc) * 100; });

  return {
    name: 'Conservative Core Holdings',
    risk_level: 'conservative',
    description: 'Low-risk portfolio with high-conviction stocks. Fewer positions for focused portfolio management.',
    holdings,
    allocation_json: JSON.stringify(holdings),
    approvalToken: generateToken(),
  };
}

/**
 * Moderate Portfolio (Medium Risk)
 * - Balanced mix of strong conviction + opportunistic plays
 * - Mix of strong buys, buys, and select holds
 */
function buildModeratePortfolio(allStocks, strongBuys, buys, holds) {
  if (allStocks.length < 5) return null;

  // Pick 10-12 stocks: favor higher scores but include some diversification
  const selected = allStocks.slice(0, Math.min(12, Math.ceil(allStocks.length * 0.5)));
  const diversified = diversifySectors(selected);

  const holdings = diversified.map(stock => {
    const scoreWeight = (stock.composite_score / 100) * 2; // Score 50→100, weight 1→2
    const allocation = 5 + (scoreWeight - 1) * 5; // Base 5% + bonus
    return {
      ticker: stock.ticker,
      allocation_pct: allocation,
      reason: buildHoldingReason(stock),
    };
  });

  // Normalize to 100%
  const totalAlloc = holdings.reduce((s, h) => s + h.allocation_pct, 0);
  holdings.forEach(h => { h.allocation_pct = (h.allocation_pct / totalAlloc) * 100; });

  return {
    name: 'Balanced Growth Portfolio',
    risk_level: 'moderate',
    description: 'Moderate-risk portfolio with both core holdings and growth opportunities. Diversified across sectors.',
    holdings,
    allocation_json: JSON.stringify(holdings),
    approvalToken: generateToken(),
  };
}

/**
 * Aggressive Portfolio (High Risk)
 * - Larger positions with highest scoring stocks
 * - Include some "emerging opportunity" holds
 */
function buildAggressivePortfolio(allStocks, strongBuys, buys, holds) {
  if (allStocks.length < 4) return null;

  // Pick 15-20 stocks: broader selection, favor top scores
  const selected = allStocks.slice(0, Math.min(20, Math.ceil(allStocks.length * 0.7)));
  const diversified = diversifySectors(selected);

  const holdings = diversified.map(stock => {
    // Aggressive: weight by score cubed for more differentiation
    const scoreNorm = stock.composite_score / 100;
    const weight = Math.pow(scoreNorm, 1.5); // Amplify score differences
    return {
      ticker: stock.ticker,
      allocation_pct: weight * 100,
      reason: buildHoldingReason(stock),
    };
  });

  // Normalize to 100%
  const totalAlloc = holdings.reduce((s, h) => s + h.allocation_pct, 0);
  holdings.forEach(h => { h.allocation_pct = (h.allocation_pct / totalAlloc) * 100; });

  return {
    name: 'Aggressive Opportunity Portfolio',
    risk_level: 'aggressive',
    description: 'High-conviction portfolio with concentrated bets on top-rated stocks. Higher volatility, higher potential return.',
    holdings,
    allocation_json: JSON.stringify(holdings),
    approvalToken: generateToken(),
  };
}

/**
 * Diversify selections by sector if possible
 */
function diversifySectors(stocks) {
  const sectorMap = {};

  // Group by sector
  stocks.forEach(s => {
    const sector = s.sector || 'Unknown';
    if (!sectorMap[sector]) sectorMap[sector] = [];
    sectorMap[sector].push(s);
  });

  // Pick top from each sector
  const diversified = [];
  for (const sector in sectorMap) {
    diversified.push(sectorMap[sector][0]); // Top from each sector
  }

  // If we have fewer than requested, add more top scores
  if (diversified.length < stocks.length) {
    const remaining = stocks.filter(s => !diversified.includes(s));
    diversified.push(...remaining.slice(0, stocks.length - diversified.length));
  }

  return diversified.slice(0, stocks.length);
}

/**
 * Build human-readable reason for holding
 */
function buildHoldingReason(stock) {
  const reasons = [];

  if (stock.composite_score >= 75) reasons.push('Strong technical setup');
  if (stock.above_200ma) reasons.push('Trading above 200-day MA');
  if (stock.golden_cross) reasons.push('Golden cross signal');
  if (stock.pe_ratio && stock.pe_ratio < 15) reasons.push('Attractive valuation');
  if (stock.earnings_growth_pct && stock.earnings_growth_pct > 15) reasons.push('Strong earnings growth');

  return reasons.slice(0, 2).join('; ') || 'Quality opportunity';
}

/**
 * Save portfolio to database
 */
async function savePortfolio(portfolio) {
  try {
    const id = await db.insert(
      `INSERT INTO my_portfolios 
       (name, risk_level, description, allocation_json, approval_token, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [
        portfolio.name,
        portfolio.risk_level,
        portfolio.description,
        portfolio.allocation_json,
        portfolio.approvalToken,
      ]
    );

    // Insert holdings
    for (const holding of portfolio.holdings) {
      await db.insert(
        `INSERT INTO portfolio_holdings 
         (portfolio_id, ticker, allocation_pct, reason)
         VALUES (?, ?, ?, ?)`,
        [id, holding.ticker, holding.allocation_pct, holding.reason]
      );
    }

    console.log(`[PortfolioBuilder] ✓ Portfolio saved: ${portfolio.name}`);
    return id;
  } catch (err) {
    console.error('[PortfolioBuilder] Save failed:', err.message);
    return null;
  }
}

/**
 * Generate approval token
 */
function generateToken() {
  return crypto.randomBytes(20).toString('hex').substring(0, 40);
}

/**
 * Get all pending portfolios with holdings
 */
async function getPendingPortfolios() {
  const portfolios = await db.query(
    `SELECT * FROM my_portfolios WHERE status='pending' ORDER BY created_at DESC`
  );

  for (const portfolio of portfolios) {
    portfolio.holdings = await db.query(
      `SELECT ticker, allocation_pct, reason FROM portfolio_holdings WHERE portfolio_id=?`,
      [portfolio.id]
    );
    portfolio.allocation_json = JSON.parse(portfolio.allocation_json || '[]');
  }

  return portfolios;
}

module.exports = {
  buildPortfolioRecommendations,
  getPendingPortfolios,
};
