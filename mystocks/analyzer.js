// MyStocks recommendation engine — scoring and Buy/Hold/Sell logic

const db = require('../db/db');
const provider = require('../data/provider');
const { analyzeTechnicals } = require('./technicals');
const { getPriceHistory, getLatestPrice } = require('./datapuller');

/**
 * Score individual factors and generate recommendation
 */
async function analyzeStock(ticker) {
  console.log(`[Analyzer] Analyzing ${ticker}...`);

  try {
    // Get price history (last 250 days)
    const priceHistory = await getPriceHistory(ticker, 250);
    if (!priceHistory || priceHistory.length < 50) {
      console.log(`[Analyzer] Insufficient price data for ${ticker}`);
      return null;
    }

    // Analyze technicals
    const tech = analyzeTechnicals(priceHistory);
    if (!tech) {
      console.log(`[Analyzer] Technical analysis failed for ${ticker}`);
      return null;
    }

    // Get fundamentals from provider
    let fundamentals = {};
    let news = [];
    try {
      fundamentals = await provider.getFundamentalsAndProfile(ticker).catch(() => ({}));
      news = await provider.getNews(ticker).catch(() => []);
    } catch (err) {
      console.warn(`[Analyzer] Could not get fundamentals for ${ticker}:`, err.message);
    }

    // Calculate individual factor scores (0-100)
    const scores = {
      technical: scoreTechnical(tech),
      rsiSignal: scoreRSI(tech.rsi),
      maSignal: scoreMovingAverages(tech.currentPrice, tech.ma50, tech.ma200, tech.above50ma, tech.above200ma),
      crossover: scoreCrossover(tech.goldenCross, tech.deathCross),
      momentum: scoreMomentum(tech.momentum),
      fundamentals: scoreFundamentals(fundamentals),
      sentiment: scoreSentiment(news),
    };

    // Weighted composite score
    const weights = {
      rsiSignal: 0.15,
      maSignal: 0.25,       // High weight for MA signals
      crossover: 0.20,      // High weight for golden/death cross
      momentum: 0.10,
      fundamentals: 0.15,
      sentiment: 0.15,
    };

    let compositeScore = 0;
    for (const [key, weight] of Object.entries(weights)) {
      if (scores[key] !== null) compositeScore += scores[key] * weight;
    }

    // Determine recommendation
    const recommendation = getRecommendation(compositeScore, tech);
    const confidence = Math.min(100, Math.abs(compositeScore - 50) + 50);

    // Generate reasoning
    const reasons = buildReasons(scores, tech, fundamentals);

    return {
      ticker,
      currentPrice: tech.currentPrice,
      priceChangePct: tech.changePct,
      rsi: tech.rsi,
      ma50: tech.ma50,
      ma200: tech.ma200,
      above50ma: tech.above50ma ? 1 : 0,
      above200ma: tech.above200ma ? 1 : 0,
      goldenCross: tech.goldenCross ? 1 : 0,
      deathCross: tech.deathCross ? 1 : 0,
      peRatio: fundamentals.pe || null,
      earningsGrowthPct: fundamentals.epsGrowthPct || null,
      analystRating: fundamentals.analystRating || null,
      analystBuyCnt: fundamentals.analystBuy || 0,
      analystHoldCnt: fundamentals.analystHold || 0,
      analystSellCnt: fundamentals.analystSell || 0,
      newsSentiment: scores.sentiment,
      momentumScore: tech.momentum,
      technicalScore: scores.technical,
      fundamentalScore: scores.fundamentals,
      compositeScore,
      recommendation,
      confidencePct: confidence,
      reasons,
    };

  } catch (err) {
    console.error(`[Analyzer] Error analyzing ${ticker}:`, err.message);
    await db.log('error', 'mystocks', `Analysis failed for ${ticker}: ${err.message}`);
    return null;
  }
}

/**
 * Score RSI (0-100)
 * RSI < 30 = oversold/bullish = high score
 * RSI > 70 = overbought/bearish = low score
 * RSI 40-60 = neutral
 */
function scoreRSI(rsi) {
  if (!rsi) return 50; // Neutral

  if (rsi < 30) return Math.max(75, 100 - (rsi * 1.2));  // Oversold = BUY signal
  if (rsi > 70) return Math.min(25, (rsi - 70) * 0.5);   // Overbought = SELL signal
  return 50 + (50 - rsi) * 0.5; // Scale 40-60 → 30-70
}

/**
 * Score moving average position
 * Above both MA50 and MA200 = bullish = high score
 */
function scoreMovingAverages(price, ma50, ma200, above50, above200) {
  if (!ma50 || !ma200 || !price) return 50;

  if (above200 && above50) return 85;      // Above both = strong buy
  if (above200 && !above50) return 65;     // Above 200 but below 50 = buy signal
  if (!above200 && above50) return 45;     // Above 50 but below 200 = caution
  return 25;                                // Below both = sell
}

/**
 * Score crossover signals
 * Golden cross = strong buy
 * Death cross = strong sell
 */
function scoreCrossover(goldenCross, deathCross) {
  if (goldenCross) return 95;    // Golden cross = very strong buy
  if (deathCross) return 10;     // Death cross = very strong sell
  return 50;                      // No signal = neutral
}

/**
 * Score momentum
 * Positive momentum > 5% = bullish
 * Negative momentum < -5% = bearish
 */
function scoreMomentum(momentum) {
  if (!momentum) return 50;
  if (momentum > 10) return 80;
  if (momentum > 5) return 65;
  if (momentum < -10) return 20;
  if (momentum < -5) return 35;
  return 50;
}

/**
 * Score fundamentals (PE, earnings growth, analyst rating)
 */
function scoreFundamentals(fund) {
  let score = 50;

  // PE ratio (lower better for value, but not too low)
  if (fund.pe) {
    if (fund.pe < 10) score += 5;      // Very cheap
    else if (fund.pe < 15) score += 15; // Cheap
    else if (fund.pe < 25) score += 5;  // Fair
    else if (fund.pe > 40) score -= 20; // Expensive
  }

  // Earnings growth (positive = bullish)
  if (fund.epsGrowthPct) {
    if (fund.epsGrowthPct > 20) score += 15;
    else if (fund.epsGrowthPct > 10) score += 10;
    else if (fund.epsGrowthPct < -10) score -= 15;
  }

  // Analyst rating (1=buy, 5=sell)
  if (fund.analystRating) {
    if (fund.analystRating < 2) score += 15;     // Buy
    else if (fund.analystRating > 4) score -= 15; // Sell
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * Score news sentiment (-1 to +1 → 0 to 100)
 */
function scoreSentiment(newsList) {
  if (!newsList || newsList.length === 0) return 50;

  // Simple heuristic: count positive vs negative keywords
  const positiveKeywords = ['bullish', 'surge', 'rally', 'gain', 'jump', 'beat', 'upgrade', 'outperform'];
  const negativeKeywords = ['bearish', 'plunge', 'crash', 'loss', 'miss', 'downgrade', 'underperform', 'concern'];

  let positiveCount = 0;
  let negativeCount = 0;

  newsList.slice(0, 10).forEach(article => {
    const text = (article.title || '').toLowerCase();
    positiveCount += positiveKeywords.filter(kw => text.includes(kw)).length;
    negativeCount += negativeKeywords.filter(kw => text.includes(kw)).length;
  });

  const net = positiveCount - negativeCount;
  return 50 + Math.max(-25, Math.min(25, net * 5)); // Scale -25 to +25
}

/**
 * Score pure technical metrics
 */
function scoreTechnical(tech) {
  let score = 50;

  // Volume
  const volumeRatio = tech.volumeRatio || 1;
  if (volumeRatio > 1.5) score += 5;
  if (volumeRatio < 0.5) score -= 5;

  // Bollinger Bands
  if (tech.bollingerPosition === 'oversold') score += 10;
  if (tech.bollingerPosition === 'overbought') score -= 10;

  return Math.max(0, Math.min(100, score));
}

/**
 * Determine BUY/HOLD/SELL based on composite score
 */
function getRecommendation(score, tech) {
  // Thresholds
  const BUY_THRESHOLD = 65;
  const SELL_THRESHOLD = 35;

  if (score >= BUY_THRESHOLD) {
    return 'buy';
  } else if (score <= SELL_THRESHOLD) {
    return 'sell';
  }
  return 'hold';
}

/**
 * Build reasoning array
 */
function buildReasons(scores, tech, fund) {
  const reasons = [];

  // Technical reasons
  if (tech.goldenCross) reasons.push('Golden cross detected (bullish)');
  if (tech.deathCross) reasons.push('Death cross detected (bearish)');
  
  if (tech.rsi < 30) reasons.push(`RSI oversold (${tech.rsi.toFixed(0)})`);
  else if (tech.rsi > 70) reasons.push(`RSI overbought (${tech.rsi.toFixed(0)})`);

  if (tech.above200ma && tech.above50ma) reasons.push('Trading above 50 & 200 MA');
  if (!tech.above200ma) reasons.push('Below 200-day MA (bearish)');

  if (tech.momentum > 10) reasons.push(`Strong momentum (+${tech.momentum.toFixed(1)}%)`);
  if (tech.momentum < -10) reasons.push(`Negative momentum (${tech.momentum.toFixed(1)}%)`);

  // Fundamental reasons
  if (fund.pe && fund.pe < 15) reasons.push(`Attractive valuation (P/E: ${fund.pe.toFixed(1)})`);
  if (fund.pe && fund.pe > 40) reasons.push(`High valuation (P/E: ${fund.pe.toFixed(1)})`);

  if (fund.epsGrowthPct && fund.epsGrowthPct > 20) reasons.push(`Strong EPS growth (+${fund.epsGrowthPct.toFixed(0)}%)`);
  if (fund.analystRating && fund.analystRating < 2.5) reasons.push('Analyst bullish');
  if (fund.analystRating && fund.analystRating > 3.5) reasons.push('Analyst bearish');

  return reasons.slice(0, 4); // Top 4 reasons
}

/**
 * Save analysis to database
 */
async function saveAnalysis(analysis) {
  try {
    const why = JSON.stringify(analysis.reasons);

    await db.query(
      `INSERT INTO stock_analysis (
        ticker, analysis_date, rsi_14, ma_50, ma_200, above_50ma, above_200ma,
        golden_cross, death_cross, current_price, price_change_pct,
        pe_ratio, earnings_growth_pct, analyst_rating,
        analyst_buy_cnt, analyst_hold_cnt, analyst_sell_cnt,
        news_sentiment, momentum_score, technical_score, fundamental_score,
        composite_score, recommendation, confidence_pct, why
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
        rsi_14=VALUES(rsi_14), ma_50=VALUES(ma_50), ma_200=VALUES(ma_200),
        composite_score=VALUES(composite_score), recommendation=VALUES(recommendation),
        confidence_pct=VALUES(confidence_pct), why=VALUES(why)`,
      [
        analysis.ticker,
        new Date().toISOString().split('T')[0],
        analysis.rsi,
        analysis.ma50,
        analysis.ma200,
        analysis.above50ma,
        analysis.above200ma,
        analysis.goldenCross,
        analysis.deathCross,
        analysis.currentPrice,
        analysis.priceChangePct,
        analysis.peRatio,
        analysis.earningsGrowthPct,
        analysis.analystRating,
        analysis.analystBuyCnt,
        analysis.analystHoldCnt,
        analysis.analystSellCnt,
        analysis.newsSentiment,
        analysis.momentumScore,
        analysis.technicalScore,
        analysis.fundamentalScore,
        analysis.compositeScore,
        analysis.recommendation,
        analysis.confidencePct,
        why,
      ]
    );

    console.log(`[Analyzer] ✓ ${analysis.ticker} saved: ${analysis.recommendation.toUpperCase()} (${analysis.compositeScore.toFixed(0)}/100)`);
    return true;
  } catch (err) {
    console.error(`[Analyzer] Save failed for ${analysis.ticker}:`, err.message);
    return false;
  }
}

module.exports = {
  analyzeStock,
  saveAnalysis,
};
