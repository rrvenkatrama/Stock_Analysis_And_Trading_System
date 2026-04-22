const db = require('../db/db');
const analyzer = require('../portfolio_app/analyzer');

(async () => {
  try {
    const result = await analyzer.analyzeSymbol('AAPL');
    console.log('Result:', result);

    // Check database
    const row = await db.queryOne(
      'SELECT price_change_pct, chg_1m, chg_ytd, chg_1y FROM stock_signals WHERE symbol = ?',
      ['AAPL']
    );
    console.log('DB values:', row);
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
