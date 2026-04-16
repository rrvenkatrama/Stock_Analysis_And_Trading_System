require('dotenv').config();

module.exports = {
  alpaca: {
    baseUrl: process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets',
    key:     process.env.ALPACA_KEY,
    secret:  process.env.ALPACA_SECRET,
    isPaper: (process.env.ALPACA_BASE_URL || 'paper').includes('paper'),
  },

  polygon: {
    apiKey: process.env.POLYGON_API_KEY,
  },

  finnhub: {
    apiKey: process.env.FINNHUB_API_KEY,
  },

  alphaVantage: {
    apiKey: process.env.ALPHA_VANTAGE_API_KEY,
  },

  db: {
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT) || 3306,
    user:     process.env.DB_USER     || 'stocktrader',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME     || 'stocktrader',
  },

  email: {
    host:    process.env.SMTP_HOST || 'smtp.gmail.com',
    port:    parseInt(process.env.SMTP_PORT) || 587,
    user:    process.env.SMTP_USER,
    pass:    process.env.SMTP_PASS,
    to:      process.env.NOTIFY_EMAIL,
  },

  app: {
    port:    parseInt(process.env.PORT) || 3000,
    url:     process.env.APP_URL || 'http://localhost:3000',
    env:     process.env.NODE_ENV || 'development',
  },

  risk: {
    accountSize:      parseFloat(process.env.ACCOUNT_SIZE)      || 10000,
    maxPositionPct:   parseFloat(process.env.MAX_POSITION_PCT)  || 0.10,
    stopLossPct:      parseFloat(process.env.STOP_LOSS_PCT)     || 0.05,
    maxOpenPositions: parseInt(process.env.MAX_OPEN_POSITIONS)  || 4,
    maxDailyTrades:   parseInt(process.env.MAX_DAILY_TRADES)    || 4,
    minScore:         parseFloat(process.env.MIN_SCORE_THRESHOLD) || 65,
    minProbability:   parseFloat(process.env.MIN_PROBABILITY)   || 60,
  },
};
