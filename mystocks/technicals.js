// Technical analysis for MyStocks — RSI, MA, signals, momentum

/**
 * Calculate Simple Moving Average
 */
function calculateSMA(prices, period) {
  if (prices.length < period) return null;
  const sum = prices.slice(0, period).reduce((a, b) => a + b, 0);
  return sum / period;
}

/**
 * Calculate RSI (Relative Strength Index)
 */
function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = prices[i - 1] - prices[i];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period; i < prices.length; i++) {
    const diff = prices[i - 1] - prices[i];
    const currentGain = diff > 0 ? diff : 0;
    const currentLoss = diff > 0 ? 0 : -diff;

    avgGain = (avgGain * (period - 1) + currentGain) / period;
    avgLoss = (avgLoss * (period - 1) + currentLoss) / period;
  }

  const rs = avgGain / (avgLoss || 1);
  const rsi = 100 - (100 / (1 + rs));
  return rsi;
}

/**
 * Calculate MACD (Moving Average Convergence Divergence)
 */
function calculateMACD(prices) {
  if (prices.length < 26) return null;

  const fastEMA = calculateEMA(prices, 12);
  const slowEMA = calculateEMA(prices, 26);
  const signalEMA = calculateEMA(prices.map(() => fastEMA - slowEMA), 9);

  return {
    macd: fastEMA - slowEMA,
    signal: signalEMA,
    isBullishCross: (fastEMA - slowEMA) > signalEMA && (fastEMA - slowEMA) > 0,
    isBearishCross: (fastEMA - slowEMA) < signalEMA && (fastEMA - slowEMA) < 0,
  };
}

/**
 * Calculate EMA (Exponential Moving Average)
 */
function calculateEMA(prices, period) {
  if (prices.length < period) return null;

  const k = 2 / (period + 1);
  let ema = calculateSMA(prices, period);

  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }

  return ema;
}

/**
 * Full technical analysis on price bars
 */
function analyzeTechnicals(priceData) {
  // priceData: array of {date, close, high, low, volume} sorted DESC by date (newest first)
  if (!priceData || priceData.length < 50) return null;

  const closes = priceData.map(p => p.close_price || p.closePrice || p.close);
  const highs = priceData.map(p => p.high_price || p.highPrice || p.high);
  const lows = priceData.map(p => p.low_price || p.lowPrice || p.low);
  const volumes = priceData.map(p => p.volume);

  // Latest candle info
  const currentPrice = closes[0];
  const previousClose = closes[1];
  const change = currentPrice - previousClose;
  const changePct = (change / previousClose) * 100;
  const currentVolume = volumes[0];
  const avgVolume = volumes.slice(0, 20).reduce((a, b) => a + b, 0) / 20;

  // Moving averages (reversed to ascending order for calculation)
  const closesAsc = [...closes].reverse();
  const ma50 = calculateSMA(closesAsc, 50);
  const ma200 = calculateSMA(closesAsc, 200);

  // RSI
  const rsi = calculateRSI(closes, 14);

  // Golden Cross / Death Cross detection
  let goldenCross = false;
  let deathCross = false;
  if (closes.length > 200) {
    const ma50Prev = calculateSMA(closesAsc.slice(1), 50);
    const ma200Prev = calculateSMA(closesAsc.slice(1), 200);
    
    if (ma50Prev && ma50 && ma200Prev && ma200) {
      goldenCross = ma50Prev < ma200Prev && ma50 > ma200;
      deathCross = ma50Prev > ma200Prev && ma50 < ma200;
    }
  }

  // Bollinger Bands (20-period)
  const sma20 = calculateSMA(closesAsc, 20);
  let bollingerPosition = 'normal';
  if (sma20) {
    const variance = closesAsc.slice(0, 20).reduce((sum, p) => sum + Math.pow(p - sma20, 2), 0) / 20;
    const stdDev = Math.sqrt(variance);
    const upper = sma20 + (2 * stdDev);
    const lower = sma20 - (2 * stdDev);
    
    if (currentPrice > upper) bollingerPosition = 'overbought';
    else if (currentPrice < lower) bollingerPosition = 'oversold';
  }

  // Momentum (rate of change)
  const momentum = ((currentPrice - closesAsc[19]) / closesAsc[19]) * 100; // 20-day momentum

  return {
    currentPrice,
    change,
    changePct,
    volume: currentVolume,
    avgVolume,
    volumeRatio: currentVolume / avgVolume,
    rsi,
    ma50,
    ma200,
    above50ma: currentPrice > ma50,
    above200ma: currentPrice > ma200,
    goldenCross,
    deathCross,
    bollingerPosition,
    momentum,
  };
}

module.exports = {
  analyzeTechnicals,
  calculateSMA,
  calculateEMA,
  calculateRSI,
  calculateMACD,
};
