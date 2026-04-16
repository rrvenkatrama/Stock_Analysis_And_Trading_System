// MyStocks Dashboard Server — Port 8081
// Tracks personal stock watchlist with recommendations and portfolio builder

const express = require('express');
const db = require('./db/db');
const cfg = require('./config/env');
const { getParams } = require('./config/params');
const { startScheduler } = require('./mystocks/scheduler');
const { buildPortfolioRecommendations, getPendingPortfolios } = require('./mystocks/portfolio-builder');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = 8081;

// ─── Database initialization ──────────────────────────────────────────────────
async function initDb() {
  const schema = `
    -- MyStocks tracking tables
    CREATE TABLE IF NOT EXISTS my_stocks (
      id                    INT AUTO_INCREMENT PRIMARY KEY,
      ticker                VARCHAR(10) NOT NULL UNIQUE,
      company_name          VARCHAR(120),
      sector                VARCHAR(60),
      date_added            DATETIME DEFAULT CURRENT_TIMESTAMP,
      status                ENUM('active','inactive') DEFAULT 'active',
      INDEX idx_ticker (ticker),
      INDEX idx_status (status)
    );

    CREATE TABLE IF NOT EXISTS stock_prices (
      id                    INT AUTO_INCREMENT PRIMARY KEY,
      ticker                VARCHAR(10) NOT NULL,
      date                  DATE NOT NULL,
      open_price            DECIMAL(10,2),
      high_price            DECIMAL(10,2),
      low_price             DECIMAL(10,2),
      close_price           DECIMAL(10,2),
      volume                BIGINT,
      adjusted_close        DECIMAL(10,2),
      UNIQUE KEY uk_ticker_date (ticker, date),
      FOREIGN KEY (ticker) REFERENCES my_stocks(ticker),
      INDEX idx_ticker (ticker),
      INDEX idx_date (date)
    );

    CREATE TABLE IF NOT EXISTS stock_analysis (
      id                    INT AUTO_INCREMENT PRIMARY KEY,
      ticker                VARCHAR(10) NOT NULL,
      analysis_date         DATE NOT NULL,
      rsi_14                DECIMAL(6,2),
      ma_50                 DECIMAL(10,2),
      ma_200                DECIMAL(10,2),
      above_50ma            TINYINT(1) DEFAULT 0,
      above_200ma           TINYINT(1) DEFAULT 0,
      golden_cross          TINYINT(1) DEFAULT 0,
      death_cross           TINYINT(1) DEFAULT 0,
      current_price         DECIMAL(10,2),
      price_change_pct      DECIMAL(6,2),
      pe_ratio              DECIMAL(8,2),
      earnings_growth_pct   DECIMAL(8,2),
      analyst_rating        DECIMAL(3,2),
      analyst_buy_cnt       INT,
      analyst_hold_cnt      INT,
      analyst_sell_cnt      INT,
      news_sentiment        DECIMAL(4,2),
      momentum_score        DECIMAL(6,2),
      technical_score       DECIMAL(6,2),
      fundamental_score     DECIMAL(6,2),
      composite_score       DECIMAL(6,2),
      recommendation        ENUM('buy','hold','sell'),
      confidence_pct        DECIMAL(5,2),
      why                   JSON,
      created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_ticker_date (ticker, analysis_date),
      FOREIGN KEY (ticker) REFERENCES my_stocks(ticker),
      INDEX idx_ticker (ticker),
      INDEX idx_date (analysis_date)
    );

    CREATE TABLE IF NOT EXISTS my_portfolios (
      id                    INT AUTO_INCREMENT PRIMARY KEY,
      name                  VARCHAR(120) NOT NULL,
      risk_level            ENUM('conservative','moderate','aggressive') NOT NULL,
      description           TEXT,
      allocation_json       JSON,
      status                ENUM('pending','approved','executing','active','closed') DEFAULT 'pending',
      approval_token        VARCHAR(60) UNIQUE,
      approved_at           DATETIME,
      created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_status (status),
      INDEX idx_risk (risk_level)
    );

    CREATE TABLE IF NOT EXISTS portfolio_holdings (
      id                    INT AUTO_INCREMENT PRIMARY KEY,
      portfolio_id          INT NOT NULL,
      ticker                VARCHAR(10) NOT NULL,
      allocation_pct        DECIMAL(5,2),
      shares                INT,
      reason                TEXT,
      added_at              DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (portfolio_id) REFERENCES my_portfolios(id),
      FOREIGN KEY (ticker) REFERENCES my_stocks(ticker),
      INDEX idx_portfolio (portfolio_id),
      INDEX idx_ticker (ticker)
    );
  `;

  for (const stmt of schema.split('CREATE TABLE')) {
    if (stmt.trim()) {
      await db.query('CREATE TABLE' + stmt).catch(() => {}); // Ignore if table exists
    }
  }
  console.log('[MyStocks] Database initialized');
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/', async (req, res) => {
  try {
    const trackedStocks = await db.query(
      'SELECT * FROM my_stocks WHERE status="active" ORDER BY ticker'
    );
    const latestAnalysis = await db.query(
      `SELECT * FROM stock_analysis
       WHERE (ticker, analysis_date) IN (
         SELECT ticker, MAX(analysis_date) FROM stock_analysis GROUP BY ticker
       )
       ORDER BY composite_score DESC`
    );
    const portfolios = await db.query(
      'SELECT * FROM my_portfolios ORDER BY created_at DESC LIMIT 10'
    );

    res.send(renderDashboard({
      trackedStocks,
      latestAnalysis,
      portfolios,
    }));
  } catch (err) {
    console.error('[MyStocks] Dashboard error:', err);
    res.status(500).send('Error loading dashboard');
  }
});

// Add new ticker to watchlist
app.post('/api/add-ticker', async (req, res) => {
  const { ticker, company_name, sector } = req.body;
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });

  try {
    const existing = await db.queryOne('SELECT id FROM my_stocks WHERE ticker=?', [ticker.toUpperCase()]);
    if (existing) return res.status(400).json({ error: 'Ticker already tracked' });

    const id = await db.insert(
      'INSERT INTO my_stocks (ticker, company_name, sector) VALUES (?, ?, ?)',
      [ticker.toUpperCase(), company_name || null, sector || null]
    );

    // Trigger immediate data pull
    const { pullStockData } = require('./mystocks/datapuller');
    pullStockData(ticker.toUpperCase()).catch(console.error);

    res.json({ success: true, id, message: 'Ticker added. Data pull initiated.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get portfolio recommendations
app.get('/api/portfolios/recommend', async (req, res) => {
  try {
    const portfolios = await getPendingPortfolios();
    const formatted = portfolios.map(p => ({
      id: p.id,
      name: p.name,
      risk_level: p.risk_level,
      description: p.description,
      holdings: p.holdings,
    }));
    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manually trigger analysis
app.get('/api/analysis/trigger', async (req, res) => {
  try {
    const { triggerAnalysisNow } = require('./mystocks/scheduler');
    triggerAnalysisNow().catch(console.error);
    res.json({ message: 'Analysis triggered in background' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Approve portfolio
app.post('/api/portfolio/:id/approve', async (req, res) => {
  try {
    await db.query(
      'UPDATE my_portfolios SET status=?, approved_at=NOW() WHERE id=?',
      ['approved', req.params.id]
    );
    res.json({ success: true, message: 'Portfolio approved' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── HTML Rendering ───────────────────────────────────────────────────────────

function renderDashboard({ trackedStocks, latestAnalysis, portfolios }) {
  const analysisMap = {};
  latestAnalysis.forEach(a => {
    analysisMap[a.ticker] = a;
  });

  const stockRows = trackedStocks.map(stock => {
    const analysis = analysisMap[stock.ticker] || {};
    const why = analysis.why ? JSON.parse(typeof analysis.why === 'string' ? analysis.why : JSON.stringify(analysis.why)) : [];

    return \`
      <tr>
        <td style="font-weight:bold">\${stock.ticker}</td>
        <td>\${stock.company_name || '-'}</td>
        <td>\${stock.sector || '-'}</td>
        <td style="text-align:right">\${analysis.current_price ? \`$\${analysis.current_price.toFixed(2)}\` : '-'}</td>
        <td style="text-align:right;color:\${(analysis.price_change_pct || 0) > 0 ? '#27ae60' : '#e74c3c'}\">
          \${analysis.price_change_pct ? \`\${analysis.price_change_pct > 0 ? '+' : ''}\${analysis.price_change_pct.toFixed(2)}%\` : '-'}
        </td>
        <td style="text-align:center">\${analysis.rsi_14 ? analysis.rsi_14.toFixed(1) : '-'}</td>
        <td style="text-align:center">\${analysis.above_50ma ? '✓' : '-'}</td>
        <td style="text-align:center">\${analysis.above_200ma ? '✓' : '-'}</td>
        <td style="text-align:center;font-weight:bold">\${analysis.golden_cross ? '✓ GOLD' : analysis.death_cross ? '✗ DEATH' : '-'}</td>
        <td style="text-align:right">\${analysis.pe_ratio ? analysis.pe_ratio.toFixed(2) : '-'}</td>
        <td style="text-align:right">\${analysis.earnings_growth_pct ? \`\${analysis.earnings_growth_pct > 0 ? '+' : ''}\${analysis.earnings_growth_pct.toFixed(1)}%\` : '-'}</td>
        <td style="text-align:center">\${analysis.analyst_rating ? analysis.analyst_rating.toFixed(2) : '-'}</td>
        <td style="text-align:center;color:\${analysis.news_sentiment > 0.3 ? '#27ae60' : analysis.news_sentiment < -0.3 ? '#e74c3c' : '#7f8c8d'}">
          \${analysis.news_sentiment ? analysis.news_sentiment.toFixed(2) : '-'}
        </td>
        <td style="text-align:right">\${analysis.momentum_score ? analysis.momentum_score.toFixed(1) : '-'}</td>
        <td style="text-align:right;font-weight:bold">\${analysis.composite_score ? analysis.composite_score.toFixed(1) : '-'}</td>
        <td style="text-align:center;font-weight:bold;color:\${
          analysis.recommendation === 'buy' ? '#27ae60' :
          analysis.recommendation === 'sell' ? '#e74c3c' : '#f39c12'
        }">
          \${(analysis.recommendation || '-').toUpperCase()}
        </td>
        <td style="font-size:12px;color:#7f8c8d">\${
          why.length > 0 ? why.slice(0, 2).join(' • ') : '-'
        }</td>
      </tr>
    \`;
  }).join('');

  return \`
    <!DOCTYPE html>
    <html>
    <head>
      <title>MyStocks Dashboard</title>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f7fa; color: #2c3e50; }
        .navbar { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px 30px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
        .navbar h1 { font-size: 24px; font-weight: 600; }
        .container { max-width: 100%; margin: 0 auto; padding: 30px 20px; }
        .section { background: white; border-radius: 8px; padding: 25px; margin-bottom: 30px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
        .section-title { font-size: 18px; font-weight: 600; margin-bottom: 20px; color: #2c3e50; border-bottom: 2px solid #667eea; padding-bottom: 10px; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; }
        th { background: #f8f9fa; padding: 12px 8px; text-align: left; font-weight: 600; color: #2c3e50; border-bottom: 2px solid #e9ecef; }
        td { padding: 12px 8px; border-bottom: 1px solid #e9ecef; }
        tr:hover { background: #f8f9fa; }
        .btn { padding: 10px 16px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; transition: all 0.2s; }
        .btn-primary { background: #667eea; color: white; }
        .btn-primary:hover { background: #5568d3; }
        .add-ticker { display: flex; gap: 10px; margin-bottom: 20px; }
        .add-ticker input { flex: 1; padding: 10px 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 13px; }
        .input-group { flex: 1; }
        .input-group label { display: block; font-size: 11px; color: #7f8c8d; margin-bottom: 4px; }
        .input-group input { width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; }
        .tag { display: inline-block; background: #ecf0f1; color: #2c3e50; padding: 4px 10px; border-radius: 4px; font-size: 11px; margin-right: 6px; }
        .buy { color: #27ae60; font-weight: 600; }
        .sell { color: #e74c3c; font-weight: 600; }
        .hold { color: #f39c12; font-weight: 600; }
      </style>
    </head>
    <body>
      <div class="navbar">
        <h1>📊 MyStocks Dashboard</h1>
        <p style="font-size: 13px; margin-top: 5px; opacity: 0.9">Track, analyze, and build custom portfolios</p>
      </div>

      <div class="container">
        <!-- Add New Ticker Section -->
        <div class="section">
          <div class="section-title">Add Stock to Watchlist</div>
          <form class="add-ticker" onsubmit="addTicker(event)">
            <div class="input-group" style="flex: 2;">
              <label>Ticker</label>
              <input type="text" id="ticker" placeholder="e.g., AAPL" required style="text-transform: uppercase;">
            </div>
            <div class="input-group">
              <label>Company Name</label>
              <input type="text" id="company" placeholder="Optional">
            </div>
            <div class="input-group">
              <label>Sector</label>
              <input type="text" id="sector" placeholder="Optional">
            </div>
            <button class="btn btn-primary" style="align-self: flex-end; margin-top: 20px;">Add Ticker</button>
          </form>
        </div>

        <!-- Stock Analysis Table -->
        <div class="section">
          <div class="section-title">Tracked Stocks Analysis</div>
          <table>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Company</th>
                <th>Sector</th>
                <th>Price</th>
                <th>Change %</th>
                <th>RSI(14)</th>
                <th>50MA</th>
                <th>200MA</th>
                <th>Crossover</th>
                <th>P/E</th>
                <th>EPS Growth</th>
                <th>Analyst</th>
                <th>News</th>
                <th>Momentum</th>
                <th>Score</th>
                <th>Rec</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              \${stockRows}
            </tbody>
          </table>
        </div>

        <!-- Portfolio Recommendations -->
        <div class="section">
          <div class="section-title">Recommended Portfolios</div>
          <p style="color:#7f8c8d;margin-bottom:15px">Click "View Recommendations" to generate dynamic portfolio allocations based on current market analysis.</p>
          <button class="btn btn-primary" onclick="loadPortfolios()">View Recommendations</button>
          <div id="portfolios" style="margin-top: 20px;"></div>
        </div>
      </div>

      <script>
        async function addTicker(e) {
          e.preventDefault();
          const ticker = document.getElementById('ticker').value.toUpperCase();
          const company = document.getElementById('company').value;
          const sector = document.getElementById('sector').value;

          const res = await fetch('/api/add-ticker', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticker, company_name: company, sector })
          });
          const data = await res.json();
          alert(data.message || data.error);
          if (data.success) location.reload();
        }

        async function loadPortfolios() {
          document.getElementById('portfolios').innerHTML = '<p style="color:#7f8c8d">Loading recommendations...</p>';
          const res = await fetch('/api/portfolios/recommend');
          const portfolios = await res.json();
          
          let html = '';
          portfolios.forEach(p => {
            html += \`
              <div style="background:#f8f9fa;border:1px solid #ddd;padding:15px;border-radius:6px;margin-bottom:15px;">
                <h3 style="margin-bottom:10px;">\${p.name} <span class="tag">\${p.risk_level}</span></h3>
                <p style="color:#7f8c8d;font-size:12px;margin-bottom:10px;">\${p.description}</p>
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-bottom:15px;">
                  \${p.holdings.map(h => \`
                    <div style="background:white;padding:10px;border-radius:4px;border-left:3px solid #667eea;">
                      <strong>\${h.ticker}</strong> - \${h.allocation_pct}%<br>
                      <span style="color:#7f8c8d;font-size:11px;">\${h.reason}</span>
                    </div>
                  \`).join('')}
                </div>
                <button class="btn btn-primary" onclick="approvePortfolio(\${p.id})">Approve & Execute</button>
              </div>
            \`;
          });
          document.getElementById('portfolios').innerHTML = html || '<p style="color:#e74c3c">No portfolios generated.</p>';
        }

        async function approvePortfolio(id) {
          const res = await fetch(\`/api/portfolio/\${id}/approve\`, { method: 'POST' });
          const data = await res.json();
          alert(data.message || data.error);
          if (data.success) loadPortfolios();
        }
      </script>
    </body>
    </html>
  \`;
}

// ─── Startup ───────────────────────────────────────────────────────────────────

async function start() {
  try {
    await initDb();
    
    // Start daily scheduler
    startScheduler();
    
    // Load initial data from Excel file if needed
    const existingStocks = await db.query('SELECT COUNT(*) as cnt FROM my_stocks');
    if (existingStocks[0]?.cnt === 0) {
      console.log('[MyStocks] Loading initial stocks from Excel file...');
      await loadStocksFromExcel();
    }

    app.listen(PORT, () => {
      console.log(`\n[MyStocks] Dashboard running on http://localhost:${PORT}`);
      console.log(`[MyStocks] Database: ${cfg.db.database}`);
      console.log(`[MyStocks] Scheduler: Active\n`);
    });
  } catch (err) {
    console.error('[MyStocks] Startup failed:', err);
    process.exit(1);
  }
}

/**
 * Load initial stock tickers from Excel file
 */
async function loadStocksFromExcel() {
  try {
    const XLSX = require('xlsx');
    const wb = XLSX.readFile('/Users/rajeshramani/php/Stocks/stocks_summary_2025-11-13 10_26_10.xlsx');
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

    let loaded = 0;
    for (let i = 1; i < rows.length; i++) {
      const [ticker, company, sector] = rows[i];

      if (!ticker) continue;

      try {
        await db.insert(
          'INSERT INTO my_stocks (ticker, company_name, sector) VALUES (?, ?, ?)',
          [ticker.toString().toUpperCase().trim(), company || null, sector || null]
        );
        loaded++;
      } catch (err) {
        // Skip duplicates
      }
    }

    console.log(`[MyStocks] Loaded ${loaded} stocks from Excel`);

    // Trigger initial data pull
    const { pullAllStocks } = require('./mystocks/datapuller');
    pullAllStocks().catch(console.error);

  } catch (err) {
    console.error('[MyStocks] Excel load error:', err.message);
  }
}

start();
