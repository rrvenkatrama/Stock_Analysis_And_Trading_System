// Sentiment data — StockTwits retail mood, Alpha Vantage news NLP, Fear & Greed
const axios   = require('axios');
const cfg     = require('../config/env');

// ─── StockTwits ────────────────────────────────────────────────────────────────
// Returns bullish %, bearish %, message count from last 24h
async function getStockTwitsSentiment(symbol) {
  try {
    const res = await axios.get(
      `https://api.stocktwits.com/api/2/streams/symbol/${symbol}.json`,
      { timeout: 8000 }
    );
    const messages = res.data?.messages || [];
    if (!messages.length) return { bullishPct: 50, bearishPct: 50, messageCount: 0 };

    let bulls = 0, bears = 0, neutral = 0;
    for (const m of messages) {
      const s = m.entities?.sentiment?.basic;
      if (s === 'Bullish')  bulls++;
      else if (s === 'Bearish') bears++;
      else neutral++;
    }
    const total = bulls + bears + neutral || 1;
    return {
      bullishPct:   Math.round((bulls / total) * 100),
      bearishPct:   Math.round((bears / total) * 100),
      messageCount: messages.length,
    };
  } catch (_) {
    return { bullishPct: 50, bearishPct: 50, messageCount: 0 };
  }
}

// ─── Alpha Vantage News Sentiment ─────────────────────────────────────────────
// Returns avg sentiment score (-1 to +1) from last 50 articles
async function getNewsSentiment(symbol) {
  try {
    const res = await axios.get('https://www.alphavantage.co/query', {
      params: {
        function:  'NEWS_SENTIMENT',
        tickers:   symbol,
        limit:     50,
        apikey:    cfg.alphaVantage.apiKey,
      },
      timeout: 10000,
    });

    const feed = res.data?.feed || [];
    if (!feed.length) return { avgSentiment: 0, articleCount: 0, headlines: [] };

    let total = 0;
    const headlines = [];
    for (const article of feed) {
      const tickerSentiment = article.ticker_sentiment?.find(t => t.ticker === symbol);
      if (tickerSentiment) {
        total += parseFloat(tickerSentiment.ticker_sentiment_score || 0);
      }
      if (headlines.length < 5) {
        headlines.push({
          headline:    article.title,
          source:      article.source,
          url:         article.url,
          publishedAt: article.time_published,
          sentiment:   parseFloat(tickerSentiment?.ticker_sentiment_score || 0),
        });
      }
    }

    return {
      avgSentiment: Math.round((total / feed.length) * 100) / 100,
      articleCount: feed.length,
      headlines,
    };
  } catch (_) {
    return { avgSentiment: 0, articleCount: 0, headlines: [] };
  }
}

// ─── CNN Fear & Greed Index ────────────────────────────────────────────────────
// Scrapes the public Fear & Greed score (0=extreme fear, 100=extreme greed)
async function getFearGreedIndex() {
  try {
    const res = await axios.get(
      'https://production.dataviz.cnn.io/index/fearandgreed/graphdata',
      { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const score = res.data?.fear_and_greed?.score;
    const rating = res.data?.fear_and_greed?.rating;
    return {
      score:  score ? Math.round(score) : 50,
      rating: rating || 'neutral',
    };
  } catch (_) {
    return { score: 50, rating: 'neutral' };
  }
}

// ─── Reddit mention count ──────────────────────────────────────────────────────
// Counts recent mentions on r/wallstreetbets and r/stocks via Pushshift
async function getRedditMentions(symbol) {
  try {
    const res = await axios.get('https://api.pushshift.io/reddit/search/comment', {
      params: { q: symbol, subreddit: 'wallstreetbets,stocks', size: 100, after: '24h' },
      timeout: 8000,
    });
    return { mentions: res.data?.data?.length || 0 };
  } catch (_) {
    // Pushshift is sometimes unreliable — return 0 gracefully
    return { mentions: 0 };
  }
}

module.exports = {
  getStockTwitsSentiment,
  getNewsSentiment,
  getFearGreedIndex,
  getRedditMentions,
};
