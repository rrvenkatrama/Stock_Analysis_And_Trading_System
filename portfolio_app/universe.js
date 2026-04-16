// Universe scanner — discovers BUY candidates outside the personal watchlist
// Uses Alpaca for price bars (no rate limits) + technicals-only scoring
// Runs after analyzeAll() each morning; results stored in stock_signals

const db           = require('../db/db');
const { fetchHistory, getActiveSymbols } = require('./yahoo_history');
const { analyzeSymbol } = require('./analyzer');

// ─── Curated universe: ~200 liquid US stocks across all sectors ───────────────
// The watchlist filter in getTopPicks() dynamically excludes whatever the user
// has already added, so overlap with personal watchlist is fine.
const UNIVERSE = [
  // Technology & Semiconductors
  'AAPL','MSFT','GOOGL','META','NVDA','AMD','INTC','AVGO','QCOM','TXN',
  'MU','AMAT','LRCX','KLAC','MRVL','ARM','SMCI','ORCL','ADBE','CRM',
  'NOW','INTU','SNOW','PLTR','PANW','CRWD','ZS','FTNT','NET','DDOG',
  'WDAY','TEAM','DELL','HPE','ANET','CDNS','SNPS','OKTA','TWLO','HUBS',
  'MDB','GTLB','APP','BILL','ZI',
  // Consumer Discretionary & Tech-adjacent
  'AMZN','TSLA','HD','LOW','COST','WMT','TGT','BURL','ROST','TJX',
  'NKE','SBUX','MCD','YUM','CMG','DPZ','DRI','DKNG','DASH','ABNB',
  'UBER','BKNG','MAR','HLT','MGM','LVS','EBAY','ETSY','RH','DECK',
  'LULU','F','GM','RIVN',
  // Healthcare & Biotech
  'JNJ','UNH','LLY','ABBV','MRK','PFE','AMGN','GILD','REGN','VRTX',
  'BIIB','MRNA','BMY','TMO','DHR','ABT','MDT','SYK','BSX','ISRG',
  'ZBH','CI','HUM','ELV','CVS','GEHC','DXCM','PODD','HOLX','ALGN',
  // Financials
  'JPM','BAC','WFC','GS','MS','C','BLK','SPGI','MCO','AXP',
  'COF','DFS','PNC','USB','SCHW','ICE','CME','CBOE','NDAQ','FIS',
  'AIG','MET','PRU','AFL','RJF',
  // Energy
  'XOM','CVX','COP','EOG','SLB','HAL','PSX','VLO','MPC','OXY',
  'DVN','KMI','OKE','WMB','LNG','CTRA','MRO',
  // Industrials & Transport
  'CAT','DE','HON','BA','LMT','RTX','NOC','GD','GE','EMR',
  'ITW','FDX','UPS','CSX','NSC','UNP','WM','RSG','CARR','OTIS',
  'SAIA','XPO','JBHT',
  // Materials & Chemicals
  'LIN','APD','ECL','SHW','FCX','NEM','AA','CLF',
  // Utilities
  'NEE','DUK','SO','D','AEP','EXC','AWK','WEC',
  // Communication & Media
  'T','VZ','TMUS','CMCSA','DIS','NFLX','WBD','CHTR','FOXA',
  'ROKU','TTD','ZM','SNAP','PINS',
];

// ─── Fetch / refresh price bars for universe symbols ─────────────────────────
// Uses full-year fetch for new symbols, incremental (15d) for existing ones
async function fetchUniverseBars(sym) {
  const row = await db.queryOne(
    'SELECT COUNT(*) AS cnt FROM price_history WHERE symbol = ?', [sym]
  );
  const fullYear = !row || (row.cnt < 200);
  return fetchHistory(sym, fullYear);
}

// ─── Score all universe symbols not already in the watchlist ─────────────────
async function scanUniverse() {
  const watchlistSyms = new Set(await getActiveSymbols());
  const toScan = UNIVERSE.filter(s => !watchlistSyms.has(s));

  console.log(`[Universe] Scanning ${toScan.length} stocks (${UNIVERSE.length - toScan.length} already in watchlist)`);

  // Phase 1: Price bars — parallel batches of 5, no rate limits on Alpaca
  for (let i = 0; i < toScan.length; i += 5) {
    const batch = toScan.slice(i, i + 5);
    await Promise.all(batch.map(fetchUniverseBars));
    process.stdout.write(`\r[Universe] Bars: ${Math.min(i + 5, toScan.length)}/${toScan.length}`);
  }
  console.log('');

  // Phase 2: Technical scoring (no fundamental data for non-watchlist stocks)
  let done = 0;
  for (const sym of toScan) {
    try {
      await analyzeSymbol(sym, null);
    } catch (_) {}
    done++;
    process.stdout.write(`\r[Universe] Scoring: ${done}/${toScan.length}`);
  }
  console.log(`\n[Universe] Done`);

  return getTopPicks(100);
}

// ─── Query top-scoring universe stocks not in watchlist ───────────────────────
async function getTopPicks(limit = 100) {
  return db.query(
    `SELECT s.* FROM stock_signals s
     LEFT JOIN watchlist w ON s.symbol = w.symbol AND w.is_active = 1
     WHERE w.symbol IS NULL
       AND s.recommendation = 'BUY'
       AND s.generated_at >= DATE_SUB(NOW(), INTERVAL 25 HOUR)
     ORDER BY s.score DESC
     LIMIT ?`,
    [limit]
  );
}

module.exports = { scanUniverse, getTopPicks, UNIVERSE };
