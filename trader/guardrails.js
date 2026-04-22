// Guardrails — enforces all trading rules before any order is placed
// Every trade MUST pass all checks here before execution

const db  = require('../db/db');
const cfg = require('../config/env');

// Check all guardrails for a proposed trade
// Returns { allowed: true } or { allowed: false, reason: '...' }
async function checkAll(symbol, shares, price, isSell = false) {
  const checks = await Promise.all([
    checkDailyTradeLimit(),
    checkMaxOpenPositions(),
    checkMaxPositionSize(shares, price),
    checkNoExistingPosition(symbol),
    checkMarketHours(),
    checkMinimumAccountBuffer(shares, price),
    isSell ? checkSufficientShares(symbol, shares) : Promise.resolve({ allowed: true }),
  ]);

  for (const check of checks) {
    if (!check.allowed) return check;
  }
  return { allowed: true };
}

// Max 4 new trades opened today
async function checkDailyTradeLimit() {
  const today = new Date().toISOString().split('T')[0];
  const rows = await db.query(
    `SELECT COUNT(*) as cnt FROM trades
     WHERE DATE(created_at) = ? AND status NOT IN ('rejected','cancelled')
       AND side = 'buy'`,
    [today]
  );
  const cnt = rows[0]?.cnt || 0;
  if (cnt >= cfg.risk.maxDailyTrades) {
    return { allowed: false, reason: `Daily trade limit reached (${cnt}/${cfg.risk.maxDailyTrades})` };
  }
  return { allowed: true };
}

// Max N open positions simultaneously
async function checkMaxOpenPositions() {
  const rows = await db.query(
    "SELECT COUNT(*) as cnt FROM positions"
  );
  const cnt = rows[0]?.cnt || 0;
  if (cnt >= cfg.risk.maxOpenPositions) {
    return { allowed: false, reason: `Max open positions reached (${cnt}/${cfg.risk.maxOpenPositions})` };
  }
  return { allowed: true };
}

// No duplicate positions in same symbol
async function checkNoExistingPosition(symbol) {
  const row = await db.queryOne(
    "SELECT id FROM positions WHERE symbol = ?",
    [symbol]
  );
  if (row) {
    return { allowed: false, reason: `Already holding a position in ${symbol}` };
  }
  return { allowed: true };
}

// Max 10% of account per trade
async function checkMaxPositionSize(shares, price) {
  const positionValue = shares * price;
  const maxPosition   = cfg.risk.accountSize * cfg.risk.maxPositionPct;
  if (positionValue > maxPosition) {
    return {
      allowed: false,
      reason: `Position size $${positionValue.toFixed(0)} exceeds max $${maxPosition.toFixed(0)} (${cfg.risk.maxPositionPct * 100}% of account)`,
    };
  }
  return { allowed: true };
}

// Always keep at least 20% of account as cash buffer
async function checkMinimumAccountBuffer(shares, price) {
  const positionValue = shares * price;
  const rows = await db.query(
    "SELECT SUM(shares * entry_price) as invested FROM positions"
  );
  const currentlyInvested = parseFloat(rows[0]?.invested || 0);
  const afterTrade        = currentlyInvested + positionValue;
  const maxInvest         = cfg.risk.accountSize * 0.80;

  if (afterTrade > maxInvest) {
    return {
      allowed: false,
      reason: `Would invest $${afterTrade.toFixed(0)} — exceeds 80% account limit ($${maxInvest.toFixed(0)})`,
    };
  }
  return { allowed: true };
}

// Only trade during regular market hours (9:35 AM – 3:45 PM ET)
function checkMarketHours() {
  const now = new Date();
  // Convert to ET
  const etOffset = -5; // EST (adjust for EDT: -4)
  const isDST = isDaylightSaving(now);
  const etHour = (now.getUTCHours() + (isDST ? -4 : -5) + 24) % 24;
  const etMin  = now.getUTCMinutes();
  const etTime = etHour * 60 + etMin;

  const open  = 9 * 60 + 35;  // 9:35 AM
  const close = 15 * 60 + 45; // 3:45 PM

  // Check weekday
  const dayOfWeek = now.getUTCDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return { allowed: false, reason: 'Market is closed (weekend)' };
  }
  if (etTime < open || etTime > close) {
    return { allowed: false, reason: `Market hours only (9:35–3:45 PM ET). Current ET time: ${etHour}:${String(etMin).padStart(2,'0')}` };
  }
  return { allowed: true };
}

function isDaylightSaving(d) {
  const jan = new Date(d.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(d.getFullYear(), 6, 1).getTimezoneOffset();
  return d.getTimezoneOffset() < Math.max(jan, jul);
}

// Prevent short selling — check available shares before allowing sell
async function checkSufficientShares(symbol, shares) {
  try {
    const { getAlpacaPositions } = require('./executor');
    const positions = await getAlpacaPositions().catch(() => []);
    const holding = positions.find(p => p.symbol === symbol);
    const availableQty = holding ? Math.max(0, parseInt(holding.qty_available || holding.qty || 0)) : 0;
    if (availableQty < shares) {
      return {
        allowed: false,
        reason: `Insufficient shares to sell (have ${availableQty}, selling ${shares}). Short selling not allowed.`
      };
    }
    return { allowed: true };
  } catch (e) {
    return { allowed: false, reason: `Failed to check shares: ${e.message}` };
  }
}

module.exports = { checkAll, checkDailyTradeLimit, checkMaxOpenPositions, checkMarketHours };
