const db = require('../db/db');

(async () => {
  try {
    const bars = await db.query(
      `SELECT trade_date, close FROM price_history WHERE symbol = 'AAPL' ORDER BY trade_date ASC`
    );

    console.log(`Total bars: ${bars.length}`);
    if (bars.length > 0) {
      console.log(`First bar: ${bars[0].trade_date}`);
      console.log(`Last bar: ${bars[bars.length - 1].trade_date}`);
    }

    // Check for 2026 bars
    const bars2026 = bars.filter(b => {
      const d = new Date(b.trade_date);
      return d.getFullYear() === 2026;
    });

    console.log(`Bars from 2026: ${bars2026.length}`);
    if (bars2026.length > 0) {
      console.log(`First 2026 bar: ${bars2026[0].trade_date}`);
      console.log(`First 2026 close: ${bars2026[0].close}`);
    }

    // Check latest bar
    const latest = bars[bars.length - 1];
    console.log(`Latest bar: ${latest.trade_date}, close: ${latest.close}`);

    // Calculate YTD from first 2026 bar
    if (bars2026.length > 0) {
      const ytdPrice = bars2026[0].close;
      const latestPrice = latest.close;
      const chgYtd = ((latestPrice - ytdPrice) / ytdPrice) * 100;
      console.log(`YTD return: ${chgYtd.toFixed(2)}%`);
    }

    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
