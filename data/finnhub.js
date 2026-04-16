// Finnhub — fundamentals, earnings, analyst ratings, price targets, company news
const axios = require('axios');
const cfg   = require('../config/env');
const db    = require('../db/db');

const BASE = 'https://finnhub.io/api/v1';

async function get(path, params = {}) {
  const res = await axios.get(`${BASE}${path}`, {
    params: { ...params, token: cfg.finnhub.apiKey },
    timeout: 10000,
  });
  return res.data;
}

// Basic financials (P/E, EPS growth, revenue growth, debt/equity)
async function getFundamentals(symbol) {
  try {
    const data = await get('/stock/metric', { symbol, metric: 'all' });
    const m = data.metric || {};
    return {
      pe:            m['peBasicExclExtraTTM']   || m['peTTM']         || null,
      eps:           m['epsBasicExclExtraAnnual'] || null,
      epsGrowthPct:  m['epsGrowth3Y']            || null,
      revenueGrowth: m['revenueGrowth3Y']        || null,
      debtEquity:    m['totalDebt/totalEquityAnnual'] || null,
      roa:           m['roaRfy']                 || null,
      roe:           m['roeRfy']                 || null,
      currentRatio:  m['currentRatioAnnual']     || null,
      beta:          m['beta']                   || null,
      // currentDividendYieldTTM is more reliably populated in Finnhub free tier
      dividendYield: m['currentDividendYieldTTM'] || m['dividendYieldIndicatedAnnual'] || null,
      psRatio:       m['priceToSalesTTM']         || null,
      fiftyTwoWeekHigh: m['52WeekHigh']           || null,
      fiftyTwoWeekLow:  m['52WeekLow']            || null,
    };
  } catch (_) {
    return {};
  }
}

// Company profile (sector P/E not available in free tier — we use hardcoded averages)
async function getProfile(symbol) {
  try {
    const data = await get('/stock/profile2', { symbol });
    return {
      name:        data.name,
      sector:      data.finnhubIndustry,
      country:     data.country,
      exchange:    data.exchange,
      marketCap:   data.marketCapitalization * 1e6,
      shareCount:  data.shareOutstanding * 1e6,
      logo:        data.logo,
      webUrl:      data.weburl,
    };
  } catch (_) {
    return {};
  }
}

// Analyst recommendation trends
async function getAnalystRatings(symbol) {
  try {
    const data = await get('/stock/recommendation', { symbol });
    const latest = data[0] || {};
    return {
      strongBuy:  latest.strongBuy  || 0,
      buy:        latest.buy        || 0,
      hold:       latest.hold       || 0,
      sell:       latest.sell       || 0,
      strongSell: latest.strongSell || 0,
      totalBuy:   (latest.strongBuy || 0) + (latest.buy || 0),
      totalSell:  (latest.sell      || 0) + (latest.strongSell || 0),
      period:     latest.period,
    };
  } catch (_) {
    return { totalBuy: 0, totalSell: 0, hold: 0 };
  }
}

// Price target consensus
async function getPriceTarget(symbol) {
  try {
    const data = await get('/stock/price-target', { symbol });
    return {
      targetHigh:   data.targetHigh,
      targetLow:    data.targetLow,
      targetMean:   data.targetMean,
      targetMedian: data.targetMedian,
      analysts:     data.numberOfAnalysts,
    };
  } catch (_) {
    return {};
  }
}

// Upcoming earnings dates
async function getEarnings(symbol) {
  try {
    const from = fmtDate(new Date());
    const to   = fmtDate(addDays(new Date(), 30));
    const data = await get('/calendar/earnings', { symbol, from, to });
    const next = (data.earningsCalendar || [])[0];
    if (!next) return { daysToEarnings: null };
    const earningsDate = new Date(next.date);
    const today        = new Date();
    today.setHours(0, 0, 0, 0);
    const days = Math.round((earningsDate - today) / 86400000);
    return {
      earningsDate: next.date,
      daysToEarnings: days,
      epsEstimate:  next.epsEstimate,
      revenueEstimate: next.revenueEstimate,
    };
  } catch (_) {
    return { daysToEarnings: null };
  }
}

// Recent company news — last 48 hours
async function getNews(symbol, hours = 48) {
  try {
    // Check cache first
    const cached = await db.query(
      `SELECT * FROM news_cache
       WHERE symbol = ? AND published_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
       ORDER BY published_at DESC LIMIT 10`,
      [symbol, hours]
    );
    if (cached.length >= 3) return cached;

    const from = fmtDate(addDays(new Date(), -3));
    const to   = fmtDate(new Date());
    const data = await get('/company-news', { symbol, from, to });
    const articles = (data || []).slice(0, 10);

    // Cache them
    for (const a of articles) {
      try {
        await db.insert(
          `INSERT IGNORE INTO news_cache (symbol, headline, source, url, sentiment, published_at)
           VALUES (?, ?, ?, ?, ?, FROM_UNIXTIME(?))`,
          [symbol, a.headline?.slice(0, 511), a.source, a.url?.slice(0, 511),
           null, a.datetime]
        );
      } catch (_) {}
    }

    return articles.map(a => ({
      headline:    a.headline,
      source:      a.source,
      url:         a.url,
      publishedAt: new Date(a.datetime * 1000),
      sentiment:   null,
    }));
  } catch (_) {
    return [];
  }
}

// Sector-average P/S ratios (price-to-sales TTM benchmarks by industry)
const SECTOR_PS = {
  'Technology':              6,
  'Software':                8,
  'Semiconductors':          5,
  'Healthcare':              4,
  'Biotechnology':          10,
  'Financials':              2,
  'Consumer Discretionary':  1.5,
  'Consumer Staples':        1.2,
  'Energy':                  1,
  'Materials':               1.5,
  'Industrials':             2,
  'Utilities':               2,
  'Real Estate':             5,
  'Communication Services':  3,
  'default':                 3,
};

function getSectorPS(sector) {
  for (const [key, ps] of Object.entries(SECTOR_PS)) {
    if (sector && sector.toLowerCase().includes(key.toLowerCase())) return ps;
  }
  return SECTOR_PS.default;
}

// Sector-average P/E ratios (hardcoded — Finnhub free tier doesn't have sector P/E)
const SECTOR_PE = {
  'Technology':           28,
  'Software':             35,
  'Semiconductors':       25,
  'Healthcare':           20,
  'Biotechnology':        30,
  'Financials':           14,
  'Consumer Discretionary': 22,
  'Consumer Staples':     20,
  'Energy':               12,
  'Materials':            15,
  'Industrials':          20,
  'Utilities':            18,
  'Real Estate':          35,
  'Communication Services': 18,
  'default':              20,
};

function getSectorPE(sector) {
  for (const [key, pe] of Object.entries(SECTOR_PE)) {
    if (sector && sector.toLowerCase().includes(key.toLowerCase())) return pe;
  }
  return SECTOR_PE.default;
}

// Analyst upgrades/downgrades — free tier endpoint
// Returns last 90 days of analyst actions (action: up/down/maintain/init/reit)
async function getUpgradesDowngrades(symbol, days = 90) {
  try {
    const from = fmtDate(addDays(new Date(), -days));
    const data = await get('/stock/upgrade-downgrade', { symbol, from });
    return (data || []).slice(0, 15).map(u => ({
      action:    u.action    || 'maintain',
      fromGrade: u.fromGrade || null,
      toGrade:   u.toGrade   || null,
      firm:      u.company   || null,
      gradeDate: new Date(u.gradeTime * 1000).toISOString().split('T')[0],
    }));
  } catch (_) {
    return [];
  }
}

function fmtDate(d) {
  return d.toISOString().split('T')[0];
}
function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

module.exports = {
  getFundamentals,
  getProfile,
  getAnalystRatings,
  getPriceTarget,
  getUpgradesDowngrades,
  getEarnings,
  getNews,
  getSectorPE,
  getSectorPS,
};
