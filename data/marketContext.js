// Market context — SPY/QQQ/VIX trend, sector ETF strength, market health
// Used to apply market-wide adjustments to all candidate scores

const alpacaData = require('./alpacaData');
const yf         = require('yahoo-finance2').default;
const cfg        = require('../config/env');

// Sector ETFs mapped to Finnhub industry names
const SECTOR_ETFS = {
  'XLK': 'Technology',
  'XLV': 'Healthcare',
  'XLF': 'Financials',
  'XLY': 'Consumer Discretionary',
  'XLP': 'Consumer Staples',
  'XLE': 'Energy',
  'XLB': 'Materials',
  'XLI': 'Industrials',
  'XLU': 'Utilities',
  'XLRE': 'Real Estate',
  'XLC': 'Communication Services',
  'XBI': 'Biotechnology',
  'SMH': 'Semiconductors',
};

// Fetch daily bars via Alpaca for market context symbols
async function fetchBars(symbol, days = 210) {
  const bars = await alpacaData.getDailyBars(symbol, days);
  return bars.map(b => ({ close: b.close, volume: b.volume, date: b.date }));
}

function sma(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function analyzeBars(bars, symbol) {
  if (bars.length < 50) return null;
  const closes  = bars.map(b => b.close);
  const current = closes[closes.length - 1];
  const ma50    = sma(closes, 50);
  const ma200   = sma(closes, 200);

  // Golden/Death cross: compare today's 50MA vs 200MA to yesterday's
  let crossSignal = 'none';
  if (closes.length >= 201) {
    const prevMa50  = sma(closes.slice(0, -1), 50);
    const prevMa200 = sma(closes.slice(0, -1), 200);
    if (prevMa50 && prevMa200 && ma50 && ma200) {
      if (prevMa50 <= prevMa200 && ma50 > ma200) crossSignal = 'golden_cross';
      if (prevMa50 >= prevMa200 && ma50 < ma200) crossSignal = 'death_cross';
    }
  }

  return {
    symbol,
    price:         current,
    ma50,
    ma200,
    aboveMa50:     ma50  ? current > ma50  : null,
    aboveMa200:    ma200 ? current > ma200 : null,
    deathCross:    ma50 && ma200 ? ma50 < ma200 : false,
    goldenCross:   ma50 && ma200 ? ma50 > ma200 : false,
    crossSignal,
    changePct1d:   bars.length >= 2
                     ? ((current - closes[closes.length - 2]) / closes[closes.length - 2]) * 100
                     : 0,
    changePct5d:   bars.length >= 5
                     ? ((current - closes[closes.length - 5]) / closes[closes.length - 5]) * 100
                     : 0,
    changePct20d:  bars.length >= 20
                     ? ((current - closes[closes.length - 20]) / closes[closes.length - 20]) * 100
                     : 0,
  };
}

// VIX from Alpaca (VIXY ETF as proxy) with Yahoo fallback
async function getVIX() {
  // Try Alpaca first using VIXY (ProShares VIX Short-Term ETF) as VIX proxy
  try {
    const bars = await alpacaData.getDailyBars('VIXY', 5);
    if (bars.length) {
      const price = bars[bars.length - 1].close;
      // VIXY ~$10-25 range maps roughly to VIX 15-35
      // Use a linear approximation: VIX ≈ VIXY * 1.8 + 2
      const score = Math.round(price * 1.8 + 2);
      return {
        score,
        level: score < 15 ? 'low'
             : score < 20 ? 'normal'
             : score < 30 ? 'elevated'
             : 'extreme_fear',
        source: 'vixy_proxy',
      };
    }
  } catch (_) {}

  // Fallback to Yahoo ^VIX
  try {
    const q     = await yf.quote('^VIX');
    const score = q.regularMarketPrice || 20;
    return {
      score,
      level: score < 15 ? 'low'
           : score < 20 ? 'normal'
           : score < 30 ? 'elevated'
           : 'extreme_fear',
      source: 'yahoo',
    };
  } catch (_) {
    return { score: 20, level: 'normal', source: 'default' };
  }
}

// Full market context — called once per scan session, cached in memory
let _cache = null;
let _cacheTime = 0;
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

async function getMarketContext() {
  if (_cache && Date.now() - _cacheTime < CACHE_TTL) return _cache;

  const [spyBars, qqqBars, vix, ...sectorBars] = await Promise.allSettled([
    fetchBars('SPY'),
    fetchBars('QQQ'),
    getVIX(),
    ...Object.keys(SECTOR_ETFS).map(etf => fetchBars(etf, 60)),
  ]);

  const spy = spyBars.status === 'fulfilled' ? analyzeBars(spyBars.value, 'SPY') : null;
  const qqq = qqqBars.status === 'fulfilled' ? analyzeBars(qqqBars.value, 'QQQ') : null;
  const vixData = vix.status === 'fulfilled' ? vix.value : { score: 20, level: 'normal' };

  // Sector strength: 20-day return for each sector ETF
  const sectorStrength = {};
  const etfKeys = Object.keys(SECTOR_ETFS);
  sectorBars.forEach((result, i) => {
    if (result.status === 'fulfilled' && result.value.length >= 20) {
      const bars   = result.value;
      const closes = bars.map(b => b.close);
      const ret20d = ((closes[closes.length - 1] - closes[closes.length - 20]) /
                       closes[closes.length - 20]) * 100;
      sectorStrength[SECTOR_ETFS[etfKeys[i]]] = Math.round(ret20d * 100) / 100;
    }
  });

  // Overall market health score
  let marketHealth = 100;
  if (spy?.deathCross)   marketHealth -= 25;
  if (qqq?.deathCross)   marketHealth -= 15;
  if (!spy?.aboveMa200)  marketHealth -= 15;
  if (!spy?.aboveMa50)   marketHealth -= 10;
  if (vixData.score > 30) marketHealth -= 15;
  if (vixData.score > 25) marketHealth -= 5;
  if (spy?.changePct5d < -3) marketHealth -= 10;
  marketHealth = Math.max(0, Math.min(100, marketHealth));

  _cache = {
    spy,
    qqq,
    vix: vixData,
    sectorStrength,
    marketHealth,
    marketTrend: marketHealth >= 70 ? 'bullish'
               : marketHealth >= 40 ? 'neutral'
               : 'bearish',
    updatedAt: new Date(),
  };
  _cacheTime = Date.now();
  return _cache;
}

// Get the sector strength score for a given sector label
function getSectorScore(sectorStrength, sector) {
  if (!sector) return 0;
  for (const [key, val] of Object.entries(sectorStrength)) {
    if (sector.toLowerCase().includes(key.toLowerCase())) return val;
  }
  return 0;
}

function fmt(d) { return d.toISOString().split('T')[0]; }

module.exports = { getMarketContext, getSectorScore, SECTOR_ETFS };
