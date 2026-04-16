// Alpaca Market Data API — historical bars, latest quotes
// Uses same API keys as trading. Free tier = 15-min delayed data.
// No separate signup needed.

const axios = require('axios');
const cfg   = require('../config/env');

const DATA_BASE = 'https://data.alpaca.markets/v2';

const headers = () => ({
  'APCA-API-KEY-ID':     cfg.alpaca.key,
  'APCA-API-SECRET-KEY': cfg.alpaca.secret,
});

// Daily OHLCV bars — last N calendar days
async function getDailyBars(symbol, days = 210) {
  try {
    const start = new Date();
    start.setDate(start.getDate() - days - 80); // larger buffer to ensure 200+ trading days

    let bars = [];
    let nextToken = null;

    // Paginate to get all bars
    do {
      const params = {
        timeframe:  '1Day',
        start:      start.toISOString().split('T')[0],
        limit:      1000,
        adjustment: 'all',  // split + dividend adjusted
        feed:       'iex',  // free tier data feed
      };
      if (nextToken) params.page_token = nextToken;

      const res = await axios.get(`${DATA_BASE}/stocks/${symbol}/bars`, {
        headers: headers(),
        params,
        timeout: 10000,
      });

      bars      = bars.concat(res.data.bars || []);
      nextToken = res.data.next_page_token || null;
    } while (nextToken && bars.length < days + 30);

    return bars.slice(-(days)).map(b => ({
      date:   new Date(b.t),
      open:   b.o,
      high:   b.h,
      low:    b.l,
      close:  b.c,
      volume: b.v,
      vwap:   b.vw,
    }));
  } catch (err) {
    return [];
  }
}

// Latest quote snapshot for a symbol
async function getQuote(symbol) {
  try {
    const res = await axios.get(`${DATA_BASE}/stocks/${symbol}/snapshot`, {
      headers: headers(),
      params:  { feed: 'iex' },
      timeout: 8000,
    });
    const s = res.data?.snapshot || res.data;
    return {
      symbol,
      price:     s.latestTrade?.p  || s.minuteBar?.c || 0,
      volume:    s.dailyBar?.v     || 0,
      avgVolume: s.prevDailyBar?.v || 0,
      vwap:      s.dailyBar?.vw    || 0,
      changePct: s.dailyBar && s.prevDailyBar
        ? ((s.dailyBar.c - s.prevDailyBar.c) / s.prevDailyBar.c) * 100
        : 0,
    };
  } catch (_) {
    return null;
  }
}

module.exports = { getDailyBars, getQuote };
