// Polygon.io — price data, OHLCV bars, snapshot quotes
const axios = require('axios');
const cfg   = require('../config/env');

const BASE = 'https://api.polygon.io';

async function get(path, params = {}, retries = 3) {
  try {
    const res = await axios.get(`${BASE}${path}`, {
      params: { ...params, apiKey: cfg.polygon.apiKey },
      timeout: 10000,
    });
    return res.data;
  } catch (err) {
    if (err.response?.status === 429 && retries > 0) {
      // Rate limited — wait 15 seconds and retry
      await new Promise(r => setTimeout(r, 15000));
      return get(path, params, retries - 1);
    }
    throw err;
  }
}

// Latest quote snapshot for a list of symbols (up to 250 at once)
async function getSnapshots(symbols) {
  if (!symbols.length) return {};
  const data = await get('/v2/snapshot/locale/us/markets/stocks/tickers', {
    tickers: symbols.join(','),
  });
  const map = {};
  for (const t of (data.tickers || [])) {
    map[t.ticker] = {
      symbol:        t.ticker,
      price:         t.day?.c   || t.lastTrade?.p || 0,
      open:          t.day?.o   || 0,
      high:          t.day?.h   || 0,
      low:           t.day?.l   || 0,
      prevClose:     t.prevDay?.c || 0,
      changePct:     t.todaysChangePerc || 0,
      volume:        t.day?.v   || 0,
      avgVolume:     t.day?.v   || 0,   // updated below with aggs
      vwap:          t.day?.vw  || 0,
    };
  }
  return map;
}

// Daily OHLCV bars — last N days
async function getDailyBars(symbol, days = 60) {
  const to   = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days - 20); // buffer for weekends/holidays

  const data = await get(`/v2/aggs/ticker/${symbol}/range/1/day/${fmt(from)}/${fmt(to)}`, {
    adjusted: true,
    sort:     'asc',
    limit:    days + 20,
  });
  return (data.results || []).slice(-(days)).map(b => ({
    date:   new Date(b.t),
    open:   b.o,
    high:   b.h,
    low:    b.l,
    close:  b.c,
    volume: b.v,
    vwap:   b.vw,
  }));
}

// Intraday 5-min bars for today
async function getIntradayBars(symbol) {
  const today = fmt(new Date());
  const data  = await get(`/v2/aggs/ticker/${symbol}/range/5/minute/${today}/${today}`, {
    adjusted: true,
    sort:     'asc',
    limit:    100,
  });
  return (data.results || []).map(b => ({
    time:   new Date(b.t),
    open:   b.o,
    high:   b.h,
    low:    b.l,
    close:  b.c,
    volume: b.v,
  }));
}

// Ticker details (name, sector, etc.)
async function getTickerDetails(symbol) {
  try {
    const data = await get(`/v3/reference/tickers/${symbol}`);
    const r = data.results || {};
    return {
      name:        r.name,
      sector:      r.sic_description,
      marketCap:   r.market_cap,
      shareCount:  r.share_class_shares_outstanding,
      exchange:    r.primary_exchange,
    };
  } catch (_) {
    return {};
  }
}

function fmt(d) {
  return d.toISOString().split('T')[0];
}

module.exports = { getSnapshots, getDailyBars, getIntradayBars, getTickerDetails };
