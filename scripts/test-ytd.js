const db = require('../db/db');

(async () => {
  try {
    const bars = await db.query(
      `SELECT trade_date, close FROM price_history WHERE symbol = 'AAPL' ORDER BY trade_date DESC LIMIT 365`
    );

    console.log(`Found ${bars.length} bars for AAPL (fetched 365)`);

    const now = new Date();
    const ytdStart = new Date(now.getFullYear(), 0, 1);
    console.log(`YTD start date: ${ytdStart.toISOString()}`);

    // Find first bar >= Jan 1
    const ytdIndex = bars.findIndex(b => new Date(b.trade_date) >= ytdStart);
    console.log(`YTD index: ${ytdIndex}`);

    // Show date range
    console.log(`Newest bar: ${bars[0].trade_date}`);
    console.log(`Oldest bar: ${bars[bars.length-1].trade_date}`);

    if (ytdIndex >= 0) {
      console.log(`YTD bar found at index ${ytdIndex}: ${bars[ytdIndex].trade_date} - close: ${bars[ytdIndex].close}`);
    } else {
      console.log('No YTD bar found');
    }

    // Check if we even have data from Jan 1, 2026
    const jan1Bar = bars.find(b => {
      const d = new Date(b.trade_date);
      return d.getFullYear() === 2026 && d.getMonth() === 0;
    });
    if (jan1Bar) {
      console.log(`Found January 2026 data: ${jan1Bar.trade_date}`);
    } else {
      console.log('No January 2026 data found in the 365-bar window');
    }

    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
