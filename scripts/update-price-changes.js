// One-time script to recalculate price changes (1D%, 1M%, YTD%, 1Y%)
const db = require('../db/db');
const analyzer = require('../portfolio_app/analyzer');
const settingsCache = require('../portfolio_app/settingsCache');

async function updateAllPriceChanges() {
  try {
    console.log('[Price Update] Starting price change calculation for all stocks...');
    await settingsCache.reloadSettings();
    const start = Date.now();

    // Get all active watchlist symbols
    const symbols = await db.query(
      `SELECT DISTINCT symbol FROM watchlist WHERE is_active = 1 ORDER BY symbol`
    );

    console.log(`[Price Update] Found ${symbols.length} active stocks`);

    let updated = 0;
    let skipped = 0;
    let errors = 0;

    for (const row of symbols) {
      const sym = row.symbol;
      try {
        const result = await analyzer.analyzeSymbol(sym);
        if (result) {
          updated++;
          console.log(`✓ ${sym}: ${result.recommendation} (${result.score.toFixed(0)}/100)`);
        } else {
          skipped++;
          console.log(`⊘ ${sym}: skipped (insufficient data)`);
        }
      } catch (e) {
        errors++;
        console.log(`✗ ${sym}: ${e.message}`);
      }
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\n[Price Update] Complete in ${elapsed}s`);
    console.log(`  ✓ Updated: ${updated}`);
    console.log(`  ⊘ Skipped: ${skipped}`);
    console.log(`  ✗ Errors: ${errors}`);

    process.exit(0);
  } catch (err) {
    console.error('[Price Update] Fatal error:', err.message);
    process.exit(1);
  }
}

updateAllPriceChanges();
