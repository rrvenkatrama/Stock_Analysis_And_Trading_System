const { getBarsFromDB } = require('../portfolio_app/yahoo_history');

(async () => {
  try {
    const bars = await getBarsFromDB('AAPL', 365);
    console.log(`Got ${bars.length} bars`);

    const closes = bars.map(b => b.close);
    const price = closes[closes.length - 1];
    const now = new Date();
    const currentYear = now.getFullYear();

    console.log(`Current year: ${currentYear}`);
    console.log(`Current price: ${price}`);

    let chgYtd = null;
    let foundBar = null;
    // bars array is ordered newest to oldest, find oldest bar in current year
    for (let i = bars.length - 1; i >= 0; i--) {
      const barDate = new Date(bars[i].trade_date);
      console.log(`[${i}] ${bars[i].trade_date} -> ${barDate.toISOString()} (year: ${barDate.getFullYear()})`);
      if (barDate.getFullYear() === currentYear && bars[i].close > 0) {
        foundBar = bars[i];
        chgYtd = ((price - bars[i].close) / bars[i].close) * 100;
        console.log(`Found YTD bar at index ${i}: ${bars[i].trade_date}, close: ${bars[i].close}, chgYtd: ${chgYtd}`);
        break;
      }
    }

    if (!foundBar) {
      console.log('No 2026 bar found!');
    }

    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
