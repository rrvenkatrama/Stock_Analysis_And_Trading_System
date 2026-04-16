// Stock universe — top liquid, analyst-covered stocks across multiple categories
// Upgrade Polygon to $29/mo to expand back to full S&P500 universe

const UNIVERSE = [
  // ── Mega-cap tech (highest liquidity, most analyst coverage) ──
  'AAPL',  // Apple
  'MSFT',  // Microsoft
  'NVDA',  // Nvidia — AI leader
  'GOOGL', // Alphabet
  'AMZN',  // Amazon
  'META',  // Meta
  'TSLA',  // Tesla
  'AMD',   // AMD — semiconductor
  'AVGO',  // Broadcom
  'CRM',   // Salesforce

  // ── Financials ────────────────────────────────────────────────
  'JPM',   // JPMorgan
  'GS',    // Goldman Sachs
  'V',     // Visa
  'MA',    // Mastercard

  // ── Healthcare ────────────────────────────────────────────────
  'UNH',   // UnitedHealth
  'LLY',   // Eli Lilly
  'ABBV',  // AbbVie

  // ── Consumer ──────────────────────────────────────────────────
  'WMT',   // Walmart
  'COST',  // Costco
  'NKE',   // Nike

  // ── Energy ────────────────────────────────────────────────────
  'XOM',   // ExxonMobil
  'CVX',   // Chevron

  // ── Industrials ───────────────────────────────────────────────
  'CAT',   // Caterpillar
  'GE',    // GE Aerospace

  // ── Communication ─────────────────────────────────────────────
  'NFLX',  // Netflix
  'DIS',   // Disney

  // ── High-conviction growth ────────────────────────────────────
  'CRWD',  // CrowdStrike
  'PLTR',  // Palantir
  'PANW',  // Palo Alto Networks
  'COIN',  // Coinbase

  // ── DIVIDEND VALUE candidates (high yield, low PE, durable businesses) ──
  'VZ',    // Verizon — ~6.5% yield, PE ~8
  'T',     // AT&T — ~6% yield, PE ~8
  'PFE',   // Pfizer — ~6% yield, PE ~10 (post-COVID dip)
  'KO',    // Coca-Cola — ~3% yield, PE ~22, moat
  'JNJ',   // Johnson & Johnson — ~3% yield, PE ~14
  'IBM',   // IBM — ~4.5% yield, PE ~18, AI transformation
  'MO',    // Altria — ~8% yield, PE ~10 (high yield, controversial)

  // ── STRONG MOAT + HIGH ANALYST CONVICTION ────────────────────
  'BRK.B', // Berkshire — Buffett moat, diversified
  'MCO',   // Moody's — pricing power, monopoly-like
  'SPGI',  // S&P Global — duopoly with Moody's, 90%+ analyst buy
  'MSCI',  // MSCI — index licensing, 90%+ margins
  'WM',    // Waste Management — recession-proof infrastructure

  // ── BREAKOUT-READY (momentum + news sensitivity) ─────────────
  'UBER',  // Uber — high liquidity, catalyst-prone
  'HOOD',  // Robinhood — news-sensitive, high beta
  'RBLX',  // Roblox — gaming/AI catalyst stock
  'SHOP',  // Shopify — e-commerce breakouts
];

module.exports = { UNIVERSE };
