// Institutional & Smart Money data
// Sources:
//   - SEC EDGAR 13F filings (free, official API)
//   - Dataroma superinvestor portfolios (scrape)
//   - Finviz institutional ownership & insider activity (scrape)

const axios   = require('axios');
const cheerio = require('cheerio');

const EDGAR_BASE   = 'https://efts.sec.gov';
const FINVIZ_BASE  = 'https://finviz.com';
const DATAROMA_BASE = 'https://www.dataroma.com';

// Superinvestors tracked (Dataroma portfolio IDs)
const SUPERINVESTORS = [
  { name: 'Warren Buffett',      id: 'brk' },
  { name: 'Bill Ackman',         id: 'ps' },
  { name: 'David Tepper',        id: 'appaloosa' },
  { name: 'Seth Klarman',        id: 'baupost' },
  { name: 'Howard Marks',        id: 'oak' },
  { name: 'Stanley Druckenmiller', id: 'duquesne' },
  { name: 'Michael Burry',       id: 'scion' },
];

// ─── Finviz Institutional & Insider Data ─────────────────────────────────────
// Scrapes the Finviz quote page for ownership & insider transaction summary
async function getFinvizOwnership(symbol) {
  try {
    const res = await axios.get(`${FINVIZ_BASE}/quote.ashx?t=${symbol}`, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    const $ = cheerio.load(res.data);
    const data = {};

    // Parse the snapshot table key-value pairs
    $('table.snapshot-table2 tr').each((_, row) => {
      const cells = $(row).find('td');
      for (let i = 0; i < cells.length - 1; i += 2) {
        const key = $(cells[i]).text().trim();
        const val = $(cells[i + 1]).text().trim();
        if (key === 'Inst Own')    data.instOwnPct     = parseFloat(val) || 0;
        if (key === 'Inst Trans')  data.instTransPct   = parseFloat(val) || 0;
        if (key === 'Insider Own') data.insiderOwnPct  = parseFloat(val) || 0;
        if (key === 'Insider Trans') data.insiderTransPct = parseFloat(val) || 0;
        if (key === 'Short Float') data.shortFloatPct  = parseFloat(val) || 0;
        if (key === 'Short Ratio') data.shortRatio     = parseFloat(val) || 0;
      }
    });

    // Determine insider sentiment
    // Positive insiderTransPct = net buying, Negative = net selling
    data.insiderBuying  = (data.insiderTransPct || 0) > 0;
    data.insiderSelling = (data.insiderTransPct || 0) < -5;

    return data;
  } catch (_) {
    return {
      instOwnPct: 0, instTransPct: 0,
      insiderOwnPct: 0, insiderTransPct: 0,
      shortFloatPct: 0, shortRatio: 0,
      insiderBuying: false, insiderSelling: false,
    };
  }
}

// ─── Dataroma Superinvestor Check ─────────────────────────────────────────────
// Checks if the symbol appears in any superinvestor's current portfolio
async function getSuperinvestorHoldings(symbol) {
  try {
    const res = await axios.get(`${DATAROMA_BASE}/m/holdings/h.php`, {
      params: { s: symbol },
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
    });

    const $ = cheerio.load(res.data);
    const holders = [];

    $('table.gridNW tbody tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length >= 3) {
        const managerName = $(cells[0]).text().trim();
        const portPct     = parseFloat($(cells[2]).text()) || 0;
        const activity    = $(cells[3])?.text().trim() || '';
        if (managerName) {
          holders.push({ manager: managerName, portPct, activity });
        }
      }
    });

    const recentlyAdded = holders.filter(h =>
      h.activity.toLowerCase().includes('add') ||
      h.activity.toLowerCase().includes('new')
    );

    return {
      superinvestorCount: holders.length,
      recentlyAdded:      recentlyAdded.length,
      holders:            holders.slice(0, 5),
    };
  } catch (_) {
    return { superinvestorCount: 0, recentlyAdded: 0, holders: [] };
  }
}

// ─── SEC EDGAR 13F Recent Activity ────────────────────────────────────────────
// Checks recent 13F filings mentioning the symbol (last 90 days)
async function getEdgar13FActivity(symbol) {
  try {
    const res = await axios.get(`${EDGAR_BASE}/efts/v1/business/company`, {
      params: {
        q:          `"${symbol}"`,
        dateRange:  'custom',
        startdt:    fmtDate(addDays(new Date(), -90)),
        enddt:      fmtDate(new Date()),
        forms:      '13F-HR',
      },
      timeout: 10000,
    });

    const hits = res.data?.hits?.hits || [];
    return {
      recentFilings: hits.length,
      filers: hits.slice(0, 3).map(h => ({
        filer: h._source?.entity_name,
        filed: h._source?.file_date,
      })),
    };
  } catch (_) {
    return { recentFilings: 0, filers: [] };
  }
}

// ─── Combined institutional signal ────────────────────────────────────────────
async function getInstitutionalSignal(symbol) {
  const [finviz, superinvestor, edgar] = await Promise.allSettled([
    getFinvizOwnership(symbol),
    getSuperinvestorHoldings(symbol),
    getEdgar13FActivity(symbol),
  ]);

  return {
    finviz:        finviz.status       === 'fulfilled' ? finviz.value       : {},
    superinvestor: superinvestor.status === 'fulfilled' ? superinvestor.value : {},
    edgar:         edgar.status        === 'fulfilled' ? edgar.value        : {},
  };
}

function fmtDate(d) { return d.toISOString().split('T')[0]; }
function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

module.exports = { getInstitutionalSignal, getFinvizOwnership, getSuperinvestorHoldings };
