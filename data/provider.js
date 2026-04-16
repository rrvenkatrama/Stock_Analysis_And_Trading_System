// Unified data provider — routes requests to the configured data source
// The scanner always calls this instead of individual data modules directly
// Switch sources at runtime via dashboard /settings — no restart needed

const sources    = require('../config/sources');
const alpacaData = require('./alpacaData');
const yahoo      = require('./yahoo');
const polygon    = require('./polygon');
const finnhub    = require('./finnhub');
const sentiment  = require('./sentiment');

// ─── Price / OHLCV bars ───────────────────────────────────────────────────────
async function getDailyBars(symbol, days = 210) {
  const cfg = await sources.getSources();
  switch (cfg.priceData) {
    case 'yahoo':   return yahoo.getDailyBars(symbol, days);
    case 'polygon': return polygon.getDailyBars(symbol, days);
    case 'alpaca':
    default:        return alpacaData.getDailyBars(symbol, days);
  }
}

// ─── Fundamentals + profile ───────────────────────────────────────────────────
async function getFundamentalsAndProfile(symbol) {
  const cfg = await sources.getSources();
  switch (cfg.fundamentals) {
    case 'finnhub': {
      const [fund, profile, analyst, pt, earnings] = await Promise.all([
        finnhub.getFundamentals(symbol),
        finnhub.getProfile(symbol),
        finnhub.getAnalystRatings(symbol),
        finnhub.getPriceTarget(symbol),
        finnhub.getEarnings(symbol),
      ]);
      return {
        name:          profile.name,
        sector:        profile.sector,
        pe:            fund.pe,
        epsGrowthPct:  fund.epsGrowthPct,
        revenueGrowth: fund.revenueGrowth,
        debtEquity:    fund.debtEquity,
        beta:          fund.beta,
        analystBuy:    analyst.totalBuy,
        analystHold:   analyst.hold,
        analystSell:   analyst.totalSell,
        analystTarget: pt.targetMean,
        analystTargetHigh: pt.targetHigh,
        analystTargetLow:  pt.targetLow,
        earningsDate:  earnings.earningsDate,
        daysToEarnings: earnings.daysToEarnings,
        shortFloatPct: null,
        insiderBuying:  false,
        insiderSelling: false,
        instOwnPct:    null,
      };
    }
    case 'yahoo':
    default:
      return yahoo.getFundamentalsAndProfile(symbol);
  }
}

// ─── News ─────────────────────────────────────────────────────────────────────
async function getNews(symbol) {
  const cfg = await sources.getSources();
  switch (cfg.news) {
    case 'finnhub': return finnhub.getNews(symbol);
    case 'yahoo':
    default:        return yahoo.getNews(symbol);
  }
}

// ─── Sentiment ────────────────────────────────────────────────────────────────
async function getSentiment(symbol) {
  const cfg = await sources.getSources();
  switch (cfg.sentiment) {
    case 'alphavantage': {
      const [st, news] = await Promise.all([
        sentiment.getStockTwitsSentiment(symbol),
        sentiment.getNewsSentiment(symbol),
      ]);
      return { stocktwits: st, news };
    }
    case 'none':
      return { stocktwits: { bullishPct: 50, bearishPct: 50, messageCount: 0 }, news: { avgSentiment: 0 } };
    case 'stocktwits':
    default:
      return {
        stocktwits: await sentiment.getStockTwitsSentiment(symbol),
        news: { avgSentiment: 0 },
      };
  }
}

// ─── VIX ─────────────────────────────────────────────────────────────────────
async function getVIX() {
  const cfg = await sources.getSources();
  // Yahoo Finance ^VIX or Alpha Vantage
  if (cfg.vix === 'alphavantage') {
    return sentiment.getFearGreedIndex(); // uses CNN Fear & Greed as proxy
  }
  // Default: Yahoo via marketContext (handled internally)
  return null; // marketContext.js handles VIX fetch directly
}

// ─── Status check — test all configured sources ───────────────────────────────
async function checkSourceHealth() {
  const cfg = await sources.getSources();
  const results = {};

  // Price data
  try {
    const bars = await getDailyBars('AAPL', 5);
    results.priceData = { source: cfg.priceData, status: bars.length > 0 ? 'ok' : 'no_data', bars: bars.length };
  } catch (e) {
    results.priceData = { source: cfg.priceData, status: 'error', error: e.message };
  }

  // Fundamentals
  try {
    const fund = await getFundamentalsAndProfile('AAPL');
    results.fundamentals = { source: cfg.fundamentals, status: fund.name ? 'ok' : 'no_data', name: fund.name };
  } catch (e) {
    results.fundamentals = { source: cfg.fundamentals, status: 'error', error: e.message };
  }

  // Sentiment
  try {
    const sent = await getSentiment('AAPL');
    results.sentiment = { source: cfg.sentiment, status: 'ok', bullishPct: sent.stocktwits?.bullishPct };
  } catch (e) {
    results.sentiment = { source: cfg.sentiment, status: 'error', error: e.message };
  }

  return { sources: cfg, health: results };
}

module.exports = { getDailyBars, getFundamentalsAndProfile, getNews, getSentiment, getVIX, checkSourceHealth };
