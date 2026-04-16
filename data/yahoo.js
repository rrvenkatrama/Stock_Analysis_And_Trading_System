// Yahoo Finance data via yahoo-finance2
// Uses quote() for fast data, quoteSummary() for deep fundamentals with fallback

const yf = require('yahoo-finance2').default;

// Retry wrapper for rate limits
async function withRetry(fn, retries = 3, delayMs = 15000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const blocked = err.message?.includes('Too Many') ||
                      err.message?.includes('429') ||
                      err.message?.includes('Unexpected token') ||
                      err.message?.includes('invalid json');
      if (blocked && i < retries - 1) {
        await new Promise(r => setTimeout(r, delayMs * (i + 1)));
        continue;
      }
      throw err;
    }
  }
}

// ─── Historical bars (fallback only — prefer alpacaData.js) ──────────────────
async function getDailyBars(symbol, days = 210) {
  try {
    const endDate   = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days - 80);

    const result = await withRetry(() => yf.historical(symbol, {
      period1:  startDate,
      period2:  endDate,
      interval: '1d',
    }));

    return result
      .filter(b => b.close)
      .map(b => ({
        date:   b.date,
        open:   b.open,
        high:   b.high,
        low:    b.low,
        close:  b.adjClose || b.close,
        volume: b.volume,
      }));
  } catch (_) {
    return [];
  }
}

// ─── Fundamentals via quote() — fast, rarely blocked ─────────────────────────
async function getFundamentalsAndProfile(symbol) {
  try {
    // yf.quote() is a single lightweight call — much less likely to be blocked
    const q = await withRetry(() => yf.quote(symbol));

    // Parse earnings date
    let earningsDate   = null;
    let daysToEarnings = null;
    const ets = q.earningsTimestampStart || q.earningsTimestamp;
    if (ets) {
      earningsDate = new Date(ets * 1000);
      const today  = new Date(); today.setHours(0,0,0,0);
      daysToEarnings = Math.round((earningsDate - today) / 86400000);
      if (daysToEarnings < 0) { earningsDate = null; daysToEarnings = null; } // past earnings
    }

    // Parse analyst rating string e.g. "2.1 - Buy" → buy/hold/sell counts (estimated)
    let analystBuy = 0, analystHold = 0, analystSell = 0;
    const rating = parseFloat(q.averageAnalystRating) || 0;
    const n      = q.numberOfAnalystOpinions || 0;
    if (n > 0 && rating > 0) {
      // Rating scale: 1=StrongBuy, 2=Buy, 3=Hold, 4=Sell, 5=StrongSell
      if      (rating <= 2.0) { analystBuy  = n; }
      else if (rating <= 2.8) { analystBuy  = Math.round(n * 0.6); analystHold = n - analystBuy; }
      else if (rating <= 3.5) { analystHold = n; }
      else                    { analystSell = Math.round(n * 0.6); analystHold = n - analystSell; }
    }

    return {
      name:           q.longName || q.shortName || symbol,
      sector:         q.sector   || null,
      industry:       q.industry || null,
      pe:             q.trailingPE   || q.forwardPE   || null,
      forwardPE:      q.forwardPE    || null,
      eps:            q.trailingEps  || null,
      epsGrowthPct:   q.earningsQuarterlyGrowth != null ? q.earningsQuarterlyGrowth * 100 : null,
      revenueGrowth:  q.revenueGrowth != null ? q.revenueGrowth * 100 : null,
      debtEquity:     q.debtToEquity || null,
      roe:            q.returnOnEquity != null ? q.returnOnEquity * 100 : null,
      profitMargin:   q.profitMargins != null ? q.profitMargins * 100 : null,
      beta:           q.beta         || null,
      shortFloatPct:  q.shortPercentOfFloat != null ? q.shortPercentOfFloat * 100 : null,
      shortRatio:     q.shortRatio   || null,
      analystBuy,
      analystHold,
      analystSell,
      analystTarget:     q.targetMeanPrice  || null,
      analystTargetHigh: q.targetHighPrice  || null,
      analystTargetLow:  q.targetLowPrice   || null,
      recommendation:    q.recommendationKey || null,
      instOwnPct:        q.heldPercentInstitutions != null ? q.heldPercentInstitutions * 100 : null,
      insiderBuying:  false,
      insiderSelling: false,
      earningsDate,
      daysToEarnings,
    };
  } catch (err) {
    return {};
  }
}

// ─── Company news ─────────────────────────────────────────────────────────────
async function getNews(symbol) {
  try {
    const result = await withRetry(() => yf.search(symbol, { newsCount: 8, quotesCount: 0 }));
    return (result.news || []).map(n => ({
      headline:    n.title,
      source:      n.publisher,
      url:         n.link,
      publishedAt: n.providerPublishTime ? new Date(n.providerPublishTime * 1000) : null,
    }));
  } catch (_) {
    return [];
  }
}

// ─── Sector average P/E ───────────────────────────────────────────────────────
const SECTOR_PE = {
  'Technology':               28,
  'Communication Services':   18,
  'Consumer Cyclical':        22,
  'Consumer Defensive':       20,
  'Healthcare':               20,
  'Financial Services':       14,
  'Industrials':              20,
  'Basic Materials':          15,
  'Energy':                   12,
  'Utilities':                18,
  'Real Estate':              35,
  'default':                  20,
};

function getSectorPE(sector) {
  if (!sector) return SECTOR_PE.default;
  for (const [key, pe] of Object.entries(SECTOR_PE)) {
    if (sector.toLowerCase().includes(key.toLowerCase())) return pe;
  }
  return SECTOR_PE.default;
}

module.exports = { getDailyBars, getFundamentalsAndProfile, getNews, getSectorPE };
