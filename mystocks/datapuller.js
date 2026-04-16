// Yahoo Finance data puller — pulls 1 year historical data for stocks

const db = require('../db/db');
const yahooFinance = require('yahoo-finance2').default;

// Configuration
const HISTORY_DAYS = 365; // 1 year
const BATCH_SIZE = 10;
const DELAY_MS = 1000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Pull 1 year of historical price data from Yahoo Finance
 * Stores in stock_prices table
 */
async function pullStockData(ticker) {
  console.log(`[DataPuller] Pulling ${HISTORY_DAYS}-day history for ${ticker}...`);

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - HISTORY_DAYS * 24 * 60 * 60 * 1000);

  try {
    const result = await yahooFinance.historical(ticker, {
      period1: startDate,
      period2: endDate,
      interval: '1d',
    });

    if (!result || result.length === 0) {
      console.log(`[DataPuller] No data found for ${ticker}`);
      return 0;
    }

    let inserted = 0;
    for (const candle of result) {
      try {
        const dateStr = new Date(candle.date).toISOString().split('T')[0];
        
        await db.query(
          `INSERT INTO stock_prices 
           (ticker, date, open_price, high_price, low_price, close_price, volume, adjusted_close)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             open_price=VALUES(open_price), high_price=VALUES(high_price),
             low_price=VALUES(low_price), close_price=VALUES(close_price),
             volume=VALUES(volume), adjusted_close=VALUES(adjusted_close)`,
          [
            ticker,
            dateStr,
            parseFloat(candle.open) || null,
            parseFloat(candle.high) || null,
            parseFloat(candle.low) || null,
            parseFloat(candle.close) || null,
            parseInt(candle.volume) || null,
            parseFloat(candle.adjClose) || null,
          ]
        );
        inserted++;
      } catch (err) {
        console.error(`[DataPuller] DB error for ${ticker} on ${candle.date}:`, err.message);
      }
    }

    console.log(`[DataPuller] ✓ ${ticker}: ${inserted} price records stored`);
    return inserted;

  } catch (err) {
    console.error(`[DataPuller] Failed to pull ${ticker}:`, err.message);
    await db.log('error', 'mystocks', `Data pull failed for ${ticker}: ${err.message}`);
    return 0;
  }
}

/**
 * Pull data for all active tracked stocks (batch with delays)
 */
async function pullAllStocks() {
  console.log('[DataPuller] Starting batch pull for all stocks...');

  const stocks = await db.query(
    'SELECT ticker FROM my_stocks WHERE status="active"'
  );

  if (!stocks.length) {
    console.log('[DataPuller] No active stocks to pull');
    return;
  }

  for (let i = 0; i < stocks.length; i += BATCH_SIZE) {
    const batch = stocks.slice(i, i + BATCH_SIZE);
    
    await Promise.all(
      batch.map(s => pullStockData(s.ticker))
    );

    if (i + BATCH_SIZE < stocks.length) {
      console.log(`[DataPuller] Batch complete, waiting ${DELAY_MS}ms before next...`);
      await sleep(DELAY_MS);
    }
  }

  console.log('[DataPuller] All stock data pull complete');
}

/**
 * Get latest price for a ticker from database
 */
async function getLatestPrice(ticker) {
  const row = await db.queryOne(
    `SELECT close_price, date FROM stock_prices 
     WHERE ticker=? 
     ORDER BY date DESC 
     LIMIT 1`,
    [ticker]
  );
  return row;
}

/**
 * Get N days of historical data (for technical analysis)
 */
async function getPriceHistory(ticker, days = 250) {
  return db.query(
    `SELECT * FROM stock_prices 
     WHERE ticker=? 
     ORDER BY date DESC 
     LIMIT ?`,
    [ticker, days]
  );
}

module.exports = {
  pullStockData,
  pullAllStocks,
  getLatestPrice,
  getPriceHistory,
};
