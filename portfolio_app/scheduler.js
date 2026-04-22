// Daily scheduler for My Stocks dashboard
// 8:30 AM ET: data refresh → Alpha analysis → Phoenix screener (display-only) → universe scan → recommendations → email
// 9:35 AM ET: Alpha autotrader execution (buys from Stocks list where Pick=1 AND Eligible)

const { CronJob } = require('cron');
const { refreshAll }                              = require('./yahoo_history');
const { analyzeAll }                              = require('./analyzer');
const { scanUniverse }                            = require('./universe');
const { evaluate: alphaEvaluate, run: alphaRun }    = require('./autotrader');
const { scoreAll: runPhoenixScreener }               = require('./phoenix_screener');
const { sendDailyDigest, sendErrorAlert, sendAutotraderEmail } = require('../notifier/email');
const { getAlpacaPositions }                      = require('../trader/executor');
const db                                          = require('../db/db');
const settingsCache                               = require('./settingsCache');

let refreshRunning = false;

// Update prices in database every 5 minutes during market hours
async function updatePricesInDatabase() {
  try {
    // Check if we're in market hours: 9:30 AM - 4:00 PM ET, Mon-Fri
    const now = new Date();
    const etTime = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
    const etDate = new Date(etTime);
    const day = etDate.getDay();       // 0=Sun, 1-5=Mon-Fri, 6=Sat
    const hours = etDate.getHours();   // 0-23
    const mins = etDate.getMinutes();  // 0-59

    // Only run Mon-Fri between 9:30 AM and 4:00 PM (16:00)
    const isWeekday = day >= 1 && day <= 5;
    const isAfter930 = hours > 9 || (hours === 9 && mins >= 30);
    const isBeforeEOD = hours < 16;

    if (!isWeekday || !isAfter930 || !isBeforeEOD) return;

    const { getQuote } = require('../data/alpacaData');
    const { getAlpacaPositions } = require('../trader/executor');

    // Get symbols from watchlist + current portfolio positions
    const [watchlist, positions] = await Promise.all([
      db.query(`SELECT symbol FROM watchlist WHERE is_active = 1`),
      getAlpacaPositions().catch(() => []),
    ]);

    // Combine symbols (unique)
    const symbolSet = new Set();
    watchlist.forEach(row => symbolSet.add(row.symbol));
    positions.forEach(pos => symbolSet.add(pos.symbol));
    const symbols = Array.from(symbolSet);

    // Fetch real-time quotes in parallel batches
    let updated = 0;
    for (let i = 0; i < symbols.length; i += 15) {
      const batch = symbols.slice(i, i + 15);
      const results = await Promise.allSettled(
        batch.map(sym => getQuote(sym).catch(() => null))
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          const q = result.value;
          await db.query(
            'UPDATE stock_signals SET price = ?, price_change_pct = ?, generated_at = NOW() WHERE symbol = ?',
            [q.price, q.changePct || 0, q.symbol]
          );

          // Update peak_price for positions (trailing stop tracking)
          await db.query(
            `UPDATE position_flags
             SET peak_price = GREATEST(COALESCE(peak_price, 0), ?)
             WHERE symbol = ?`,
            [q.price, q.symbol]
          );

          updated++;
        }
      }

      // Small delay between batches
      if (i + 15 < symbols.length) await new Promise(r => setTimeout(r, 100));
    }

    if (updated > 0) console.log(`[Price Update] Updated ${updated} prices from Alpaca at ${etTime}`);
  } catch (err) {
    console.error('[Price Update] Error:', err.message);
  }
}

async function runDailyRefresh(fullYear = false) {
  if (refreshRunning) {
    console.log('[Portfolio Scheduler] Refresh already running — skipping');
    return;
  }
  refreshRunning = true;
  const start = Date.now();
  const errors = [];  // collect non-fatal errors across all phases

  try {
    console.log('[Portfolio Scheduler] Starting daily refresh...');

    // Phase 1+2: Price bars + fundamentals
    let quotes = {};
    try {
      quotes = await refreshAll(fullYear);
    } catch (e) {
      console.error('[Scheduler] refreshAll failed:', e.message);
      errors.push({ phase: 'Data Refresh', message: e.message });
    }

    // Phase 3: Score all watchlist symbols
    try {
      await analyzeAll(quotes);
    } catch (e) {
      console.error('[Scheduler] analyzeAll failed:', e.message);
      errors.push({ phase: 'Analysis / Scoring', message: e.message });
    }

    // Phase 4: Universe scan — discover BUY candidates not in personal watchlist
    let picks = [];
    try {
      picks = await scanUniverse();
      console.log(`[Portfolio Scheduler] Universe scan: ${picks.length} new picks`);
    } catch (e) {
      console.error('[Scheduler] Universe scan failed:', e.message);
      errors.push({ phase: 'Universe Scan', message: e.message });
    }

    // Phase 4.5a: Phoenix screener — score all watchlist symbols for deep value
    let phoenixResults = null;
    try {
      await runPhoenixScreener();
      console.log(`[Scheduler] Phoenix screener complete`);
    } catch (e) {
      console.error('[Scheduler] Phoenix screener failed:', e.message);
      errors.push({ phase: 'Phoenix Screener', message: e.message });
    }

    // Phase 4.5b: Alpha autotrader — generate recommendations (execute=false)
    let autoResults = null;
    try {
      autoResults = await alphaEvaluate(false);
      const { exits, entries } = autoResults;
      console.log(`[Scheduler] Alpha recommendations: ${entries.length} entries, ${exits.length} exits`);
    } catch (e) {
      console.error('[Scheduler] Alpha evaluate failed:', e.message);
      errors.push({ phase: 'Alpha Recommendations', message: e.message });
    }


    // Phase 5: Send daily digest email
    try {
      const signals   = await db.query(`SELECT * FROM stock_signals ORDER BY score DESC`);
      const positions = await getAlpacaPositions().catch(() => []);
      await sendDailyDigest(signals, positions, picks, autoResults, phoenixResults);
    } catch (e) {
      console.error('[Scheduler] Email failed:', e.message);
      errors.push({ phase: 'Daily Digest Email', message: e.message });
    }

    // Phase 6: Send error alert if any phase had problems
    if (errors.length > 0) {
      try {
        await sendErrorAlert(errors);
      } catch (e) {
        console.error('[Scheduler] Error alert email failed:', e.message);
      }
    }

    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`[Portfolio Scheduler] Refresh complete in ${elapsed}s (${errors.length} error(s))`);
    await db.log('info', 'portfolio_scheduler',
      `Daily refresh complete in ${elapsed}s — ${errors.length} error(s)`);

  } catch (err) {
    // Unexpected top-level failure
    console.error('[Portfolio Scheduler] Refresh failed:', err.message);
    await db.log('error', 'portfolio_scheduler', `Refresh failed: ${err.message}`);
    errors.push({ phase: 'Scheduler (fatal)', message: err.message });
    try { await sendErrorAlert(errors); } catch (_) {}
  } finally {
    refreshRunning = false;
  }
}

function startScheduler() {
  // Initialize settings cache
  settingsCache.initializeCache().catch(err => {
    console.error('[Settings Cache] Initialization failed:', err.message);
  });

  // 8:30 AM ET Monday–Friday — full data refresh + analysis + recommendations
  const morningJob = new CronJob('0 30 8 * * 1-5', () => {
    console.log('[Portfolio Scheduler] Cron fired — 8:30 AM ET');
    runDailyRefresh(false);
  }, null, true, 'America/New_York');

  // 9:35 AM ET Monday–Friday — execute Alpha + Phoenix trades (each when enabled)
  const tradeJob = new CronJob('0 35 9 * * 1-5', async () => {
    console.log('[Portfolio Scheduler] Cron fired — 9:35 AM ET (Alpha + Phoenix execution window)');

    // Alpha runs first
    let alphaResults = null;
    try {
      alphaResults = await alphaRun();
      if (alphaResults) {
        console.log(`[Portfolio Scheduler] Alpha: ${alphaResults.entries.length} buys, ${alphaResults.exits.length} sells`);
        try { await sendAutotraderEmail(alphaResults, 'Alpha'); } catch (e) {
          console.error('[Portfolio Scheduler] Alpha email failed:', e.message);
        }
      } else {
        console.log('[Portfolio Scheduler] Alpha: autorun OFF or outside hours');
      }
    } catch (e) {
      console.error('[Portfolio Scheduler] Alpha run failed:', e.message);
    }

  }, null, true, 'America/New_York');

  // Every 5 minutes during market hours (9:30 AM - 4:00 PM ET, Mon-Fri)
  const priceUpdateJob = new CronJob('*/5 9-15 * * 1-5', () => {
    updatePricesInDatabase();
  }, null, true, 'America/New_York');

  // 4:05 PM ET Mon-Fri — final price capture after market close
  const closeJob = new CronJob('0 5 16 * * 1-5', () => {
    updatePricesInDatabase();
  }, null, true, 'America/New_York');

  console.log('[Portfolio Scheduler] Scheduled: 8:30 AM refresh + 9:35 AM Alpha autotrader + every 5min price updates (9:30-16:00 ET) + 4:05 PM close snapshot (Mon-Fri)');
  return { morningJob, tradeJob, priceUpdateJob, closeJob };
}

module.exports = { startScheduler, runDailyRefresh };
