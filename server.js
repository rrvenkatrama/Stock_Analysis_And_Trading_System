require('dotenv').config();
const express  = require('express');
const path     = require('path');
const { v4: uuidv4 } = require('uuid');

const cfg      = require('./config/env');
const db       = require('./db/db');
const sourceCfg = require('./config/sources');
const paramsCfg = require('./config/params');
const portfolioModule = require('./trader/portfolio');
const { getLatestCandidates } = require('./screener/scan');
const { executeBuy, executePlan, closePosition, getAccount } = require('./trader/executor');
const { sendApprovalRequest, sendPositionClosed } = require('./notifier/email');
const cron     = require('./scheduler/cron');

// mysql2 returns JSON columns already parsed — guard against double-parse
function parsePlanJson(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch (_) { return {}; } }
  return raw;
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Dashboard ────────────────────────────────────────────────────────────────
app.get('/dashboard', async (req, res) => {
  try {
    const [candidates, latestPlan, positions, account, recentTrades, dailyStats] = await Promise.all([
      getLatestCandidates(15),
      portfolioModule.getLatestPlan(),
      db.query('SELECT p.*, t.entry_price as t_entry, t.stop_price as t_stop, t.target_price as t_target FROM positions p JOIN trades t ON p.trade_id = t.id ORDER BY p.opened_at DESC'),
      getAccount().catch(() => null),
      db.query("SELECT * FROM trades WHERE status IN ('filled','closed') ORDER BY created_at DESC LIMIT 10"),
      db.query('SELECT * FROM daily_stats ORDER BY trade_date DESC LIMIT 30'),
    ]);

    res.send(renderDashboard({ candidates, latestPlan, positions, account, recentTrades, dailyStats }));
  } catch (err) {
    res.status(500).send(`<pre>Error: ${err.message}</pre>`);
  }
});

// ─── Candidate detail page ────────────────────────────────────────────────────
app.get('/candidate/:id', async (req, res) => {
  const candidate = await db.queryOne('SELECT * FROM candidates WHERE id=?', [req.params.id]);
  if (!candidate) return res.status(404).send('Not found');

  const news = await db.query(
    'SELECT * FROM news_cache WHERE symbol=? ORDER BY published_at DESC LIMIT 8',
    [candidate.symbol]
  );

  res.send(renderCandidateDetail(candidate, news));
});

// ─── Select a candidate → queue trade for approval ────────────────────────────
app.post('/candidate/:id/select', async (req, res) => {
  try {
    const candidate = await db.queryOne(
      "SELECT * FROM candidates WHERE id=? AND status='pending'",
      [req.params.id]
    );
    if (!candidate) return res.status(404).json({ error: 'Candidate not found or already actioned' });

    const token   = uuidv4();
    const expires = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 hours

    const tradeId = await db.insert(
      `INSERT INTO trades (candidate_id, symbol, side, shares, entry_price, stop_price,
       target_price, status, approval_token, approval_expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        candidate.id, candidate.symbol, 'buy',
        candidate.suggested_shares, candidate.suggested_entry,
        candidate.suggested_stop, candidate.suggested_target,
        'pending_approval', token, expires,
      ]
    );

    await db.query("UPDATE candidates SET status='selected', selected_at=NOW() WHERE id=?", [candidate.id]);

    const trade = await db.queryOne('SELECT * FROM trades WHERE id=?', [tradeId]);
    await sendApprovalRequest(trade, candidate);

    res.json({
      success:    true,
      tradeId,
      message:    `Trade queued. Approval email sent. Approve at: ${cfg.app.url}/trade/approve/${token}`,
      approveUrl: `${cfg.app.url}/trade/approve/${token}`,
      rejectUrl:  `${cfg.app.url}/trade/reject/${token}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Approve trade (from email link or dashboard) ─────────────────────────────
app.get('/trade/approve/:token', async (req, res) => {
  try {
    const trade = await db.queryOne(
      "SELECT * FROM trades WHERE approval_token=? AND status='pending_approval'",
      [req.params.token]
    );
    if (!trade) return res.send(renderMessage('Trade not found or already processed.', 'error'));

    if (new Date() > new Date(trade.approval_expires_at)) {
      await db.query("UPDATE trades SET status='cancelled' WHERE id=?", [trade.id]);
      return res.send(renderMessage('Trade approval expired. Please select a new candidate.', 'warning'));
    }

    await db.query("UPDATE trades SET status='approved', approved_at=NOW() WHERE id=?", [trade.id]);
    const result = await executeBuy(trade.id);

    res.send(renderMessage(
      `✅ Trade submitted! ${trade.shares} shares of ${trade.symbol} @ market price.<br>
       Order ID: ${result.orderId}<br>Stop loss placed at $${trade.stop_price}`,
      'success'
    ));
  } catch (err) {
    res.status(500).send(renderMessage(`Trade failed: ${err.message}`, 'error'));
  }
});

// ─── Reject trade ─────────────────────────────────────────────────────────────
app.get('/trade/reject/:token', async (req, res) => {
  const trade = await db.queryOne(
    "SELECT * FROM trades WHERE approval_token=?",
    [req.params.token]
  );
  if (trade) {
    await db.query("UPDATE trades SET status='rejected', rejected_at=NOW() WHERE id=?", [trade.id]);
    await db.query("UPDATE candidates SET status='skipped' WHERE id=?", [trade.candidate_id]);
  }
  res.send(renderMessage(`Trade for ${trade?.symbol} rejected.`, 'info'));
});

// ─── Close a position manually ────────────────────────────────────────────────
app.post('/position/:symbol/close', async (req, res) => {
  try {
    await closePosition(req.params.symbol, 'manual');
    const trade = await db.queryOne(
      'SELECT * FROM trades WHERE symbol=? AND status=\'closed\' ORDER BY closed_at DESC LIMIT 1',
      [req.params.symbol]
    );
    if (trade) await sendPositionClosed(trade);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Cancel a pending trade (expired or user-initiated) ───────────────────────
app.post('/trade/:id/cancel', async (req, res) => {
  try {
    const trade = await db.queryOne('SELECT * FROM trades WHERE id=?', [req.params.id]);
    if (!trade) return res.status(404).json({ error: 'Trade not found' });
    await db.query("UPDATE trades SET status='cancelled' WHERE id=?", [trade.id]);
    await db.query("UPDATE candidates SET status='pending', selected_at=NULL WHERE id=?", [trade.candidate_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: get positions JSON ───────────────────────────────────────────────────
app.get('/api/positions', async (req, res) => {
  const rows = await db.query(
    'SELECT p.*, t.stop_price, t.target_price, t.entry_price as orig_entry FROM positions p JOIN trades t ON p.trade_id=t.id'
  );
  res.json(rows);
});

// ─── API: get pending approvals ───────────────────────────────────────────────
app.get('/api/pending', async (req, res) => {
  const rows = await db.query(
    "SELECT * FROM trades WHERE status='pending_approval' AND approval_expires_at > NOW()"
  );
  res.json(rows);
});


// ─── Settings page ────────────────────────────────────────────────────────────
app.get('/settings', async (req, res) => {
  const current = await sourceCfg.getSources();
  res.send(renderSettings(current));
});

app.post('/settings/source', async (req, res) => {
  const { key, value } = req.body;
  try {
    const updated = await sourceCfg.setSource(key, value);
    res.json({ success: true, sources: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Portfolio plan: approve (from email or dashboard) ────────────────────────
app.get('/plan/approve/:token', async (req, res) => {
  try {
    const plan = await portfolioModule.getPlanByToken(req.params.token);
    if (!plan) return res.send(renderMessage('Plan not found.', 'error'));
    if (plan.status !== 'pending') return res.send(renderMessage(`Plan already ${plan.status}.`, 'info'));
    if (new Date() > new Date(plan.approval_expires_at)) {
      await portfolioModule.rejectPlan(plan.id);
      return res.send(renderMessage('Plan expired — a fresh plan will be generated at the next scan.', 'warning'));
    }
    await portfolioModule.approvePlan(plan.id);
    const planData = parsePlanJson(plan.plan_json);
    const results  = await executePlan(planData, plan.id);
    await portfolioModule.markExecuted(plan.id);
    const summary = `Executed: bought [${results.bought.join(', ') || 'none'}], sold [${results.sold.join(', ') || 'none'}]${results.errors.length ? `. Errors: ${results.errors.join('; ')}` : ''}`;
    res.send(renderMessage(`✅ Plan approved and executed.<br>${summary}`, 'success'));
  } catch (err) {
    res.status(500).send(renderMessage(`Execution failed: ${err.message}`, 'error'));
  }
});

app.get('/plan/reject/:token', async (req, res) => {
  const plan = await portfolioModule.getPlanByToken(req.params.token);
  if (plan) await portfolioModule.rejectPlan(plan.id);
  res.send(renderMessage('Plan rejected. No trades will be placed.', 'info'));
});

// GET versions — no JS required, work as plain links
app.get('/plan/:id/approve-now', async (req, res) => {
  try {
    const plan = await db.queryOne('SELECT * FROM portfolio_plans WHERE id=?', [req.params.id]);
    if (!plan || plan.status !== 'pending') return res.send(renderMessage('Plan not found or already actioned.', 'info'));
    await portfolioModule.approvePlan(plan.id);
    const planData = parsePlanJson(plan.plan_json);
    const results  = await executePlan(planData, plan.id);
    await portfolioModule.markExecuted(plan.id);
    const bought = (results.bought || []).join(', ') || 'none';
    const errors = results.errors?.length ? ` Errors: ${results.errors.join(', ')}` : '';
    res.send(renderMessage(`✅ Plan approved! Bought: [${bought}].${errors} <br><a href="/dashboard">← Back to Dashboard</a>`, 'success'));
  } catch (err) {
    res.send(renderMessage(`Execution failed: ${err.message} <br><a href="/dashboard">← Back to Dashboard</a>`, 'error'));
  }
});

app.get('/plan/:id/reject-now', async (req, res) => {
  try {
    await portfolioModule.rejectPlan(req.params.id);
    res.redirect('/dashboard');
  } catch (err) {
    res.send(renderMessage(`Error: ${err.message}`, 'error'));
  }
});

// ─── API: trigger scan + build plan manually ──────────────────────────────────
app.post('/api/scan', async (req, res) => {
  res.json({ message: 'Scan triggered in background' });
  const { runScanAndBuildPlan } = require('./scheduler/cron');
  runScanAndBuildPlan('premarket').catch(console.error);
});

// GET version — navigates here, triggers scan in background, redirects to dashboard
app.get('/scan-now', (req, res) => {
  const { runScanAndBuildPlan } = require('./scheduler/cron');
  runScanAndBuildPlan('premarket').catch(console.error);
  res.redirect('/dashboard');
});

// ─── Admin page — all scoring/risk parameters ─────────────────────────────────
app.get('/admin', async (req, res) => {
  const params = await paramsCfg.getParams();
  res.send(renderAdmin(params));
});

app.post('/admin/param', async (req, res) => {
  const { key, value } = req.body;
  try {
    const updated = await paramsCfg.setParam(key, value);
    res.json({ success: true, value: updated[key] });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/admin/param/reset', async (req, res) => {
  const { key } = req.body;
  try {
    const updated = await paramsCfg.resetParam(key);
    res.json({ success: true, value: updated[key] });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── API: data source health check ────────────────────────────────────────────
app.get('/api/source-health', async (req, res) => {
  const { checkSourceHealth } = require('./data/provider');
  const result = await checkSourceHealth().catch(e => ({ error: e.message }));
  res.json(result);
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', paper: cfg.alpaca.isPaper, ts: new Date() }));

// ─── Redirect root to dashboard ───────────────────────────────────────────────
app.get('/', (req, res) => res.redirect('/dashboard'));

// ─────────────────────────────────────────────────────────────────────────────
// HTML RENDERERS
// ─────────────────────────────────────────────────────────────────────────────

function renderDashboard({ candidates, latestPlan, positions, account, recentTrades, dailyStats }) {
  const modeLabel = cfg.alpaca.isPaper
    ? '<span style="background:#e67e22;color:#fff;padding:4px 10px;border-radius:4px;font-size:13px">PAPER TRADING</span>'
    : '<span style="background:#e74c3c;color:#fff;padding:4px 10px;border-radius:4px;font-size:13px">⚠ LIVE TRADING</span>';

  const winRate = (() => {
    const closed = recentTrades.filter(t => t.status === 'closed' && t.pnl !== null);
    if (!closed.length) return 'N/A';
    const wins = closed.filter(t => t.pnl > 0).length;
    return `${Math.round((wins / closed.length) * 100)}%`;
  })();

  const totalPnl = recentTrades
    .filter(t => t.pnl)
    .reduce((s, t) => s + parseFloat(t.pnl), 0);

  // ── Portfolio Plan Section ─────────────────────────────────────────────────
  const planSection = (() => {
    if (!latestPlan) {
      return `
      <div class="section" style="border-left:4px solid #3498db;background:#f0f8ff">
        <h2 style="color:#2980b9;margin-top:0">No Portfolio Plan Yet</h2>
        <p style="color:#7f8c8d">
          A plan is generated automatically after each scan (8:50 AM and 12 PM ET).
          Click <strong>▶ Scan Now</strong> above to generate one immediately.
        </p>
      </div>`;
    }

    const plan       = parsePlanJson(latestPlan.plan_json);
    const status     = latestPlan.status;
    const isPending  = status === 'pending';
    const expires    = new Date(latestPlan.approval_expires_at);
    const hoursLeft  = Math.max(0, Math.round((expires - Date.now()) / 3600000 * 10) / 10);
    const planId     = latestPlan.id;
    const approveUrl = `${cfg.app.url}/plan/approve/${latestPlan.approval_token}`;
    const rejectUrl  = `${cfg.app.url}/plan/reject/${latestPlan.approval_token}`;

    const borderColor = isPending ? '#e67e22' : status === 'executed' ? '#27ae60' : status === 'rejected' ? '#e74c3c' : '#95a5a6';
    const statusBadge = {
      pending:  `<span style="background:#e67e22;color:#fff;padding:3px 10px;border-radius:10px;font-size:13px">Pending Approval</span>`,
      approved: `<span style="background:#27ae60;color:#fff;padding:3px 10px;border-radius:10px;font-size:13px">Approved</span>`,
      executed: `<span style="background:#27ae60;color:#fff;padding:3px 10px;border-radius:10px;font-size:13px">Executed</span>`,
      rejected: `<span style="background:#e74c3c;color:#fff;padding:3px 10px;border-radius:10px;font-size:13px">Rejected</span>`,
      expired:  `<span style="background:#95a5a6;color:#fff;padding:3px 10px;border-radius:10px;font-size:13px">Expired</span>`,
    }[status] || '';

    const buyRows = (plan.buys || []).map(b => `
      <tr style="border-bottom:1px solid #eee">
        <td style="padding:10px"><span style="background:#d5f5e3;color:#27ae60;padding:3px 8px;border-radius:4px;font-weight:bold;font-size:12px">BUY</span></td>
        <td style="padding:10px;font-weight:bold;font-size:16px">${b.symbol}</td>
        <td style="padding:10px">${b.shares} shares @ $${b.price?.toFixed(2) || '—'}</td>
        <td style="padding:10px;font-weight:bold">$${b.estimatedCost?.toFixed(0) || '—'}</td>
        <td style="padding:10px"><span style="color:#27ae60;font-weight:bold">${b.score}/100</span> &nbsp; ${b.probability}% prob</td>
        <td style="padding:10px;color:#7f8c8d;font-size:12px">↑ $${b.target?.toFixed(2)} &nbsp; ↓ $${b.stop?.toFixed(2)} &nbsp; R/R ${b.riskReward}:1</td>
        <td style="padding:10px;color:#7f8c8d;font-size:12px">${(b.reasons || []).slice(0,2).join(' · ')}</td>
      </tr>`).join('');

    const exitRows = (plan.exits || []).map(e => `
      <tr style="border-bottom:1px solid #eee;background:#fff8f8">
        <td style="padding:10px"><span style="background:${e.action === 'swap' ? '#fde8d8' : '#fde8e8'};color:${e.action === 'swap' ? '#e67e22' : '#e74c3c'};padding:3px 8px;border-radius:4px;font-weight:bold;font-size:12px">${e.action === 'swap' ? 'SWAP' : 'SELL'}</span></td>
        <td style="padding:10px;font-weight:bold;font-size:16px">${e.symbol}</td>
        <td style="padding:10px;color:${parseFloat(e.gainPct) >= 0 ? '#27ae60' : '#e74c3c'}">${parseFloat(e.gainPct) >= 0 ? '+' : ''}${e.gainPct}% since entry</td>
        <td style="padding:10px" colspan="4;color:#7f8c8d;font-size:12px">${e.reason}</td>
      </tr>`).join('');

    const holdRows = (plan.holds || []).map(h => `
      <tr style="border-bottom:1px solid #eee;background:#f8fbff">
        <td style="padding:10px"><span style="background:#d6eaf8;color:#2980b9;padding:3px 8px;border-radius:4px;font-weight:bold;font-size:12px">HOLD</span></td>
        <td style="padding:10px;font-weight:bold;font-size:16px">${h.symbol}</td>
        <td style="padding:10px;color:${parseFloat(h.gainPct) >= 0 ? '#27ae60' : '#e74c3c'}">${parseFloat(h.gainPct) >= 0 ? '+' : ''}${h.gainPct}% since entry</td>
        <td style="padding:10px" colspan="4;color:#7f8c8d;font-size:12px">${h.reason}</td>
      </tr>`).join('');

    const hasHolds  = plan.holds?.length > 0;
    const noAction  = !plan.buys?.length && !plan.exits?.length;
    const noActionMsg = hasHolds
      ? 'All positions are performing well — hold everything. No new buys needed today.'
      : 'No candidates passed the scoring threshold today. No trades needed.';

    return `
    <div class="section" style="border-left:4px solid ${borderColor}">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:12px">
        <div>
          <h2 style="margin:0">Today's Portfolio Plan &nbsp;${statusBadge}</h2>
          <p style="color:#7f8c8d;margin:6px 0 0;font-size:13px">${plan.summary || ''}
            ${isPending ? `&nbsp;·&nbsp; Expires in ${hoursLeft}h` : ''}
          </p>
        </div>
        ${isPending ? `
        <div style="display:flex;gap:10px">
          <a href="/plan/${planId}/approve-now"
            style="background:#27ae60;color:#fff;padding:10px 24px;border-radius:5px;
                   font-size:15px;font-weight:bold;text-decoration:none;display:inline-block">
            ✓ Approve Plan
          </a>
          <a href="/plan/${planId}/reject-now"
            style="background:#e74c3c;color:#fff;padding:10px 20px;border-radius:5px;
                   font-size:15px;font-weight:bold;text-decoration:none;display:inline-block">
            ✗ Reject
          </a>
        </div>` : ''}
      </div>

      ${noAction && isPending ? `
      <div style="background:#f0fff4;border-radius:6px;padding:14px;color:#27ae60;font-weight:bold">
        ${noActionMsg}
      </div>` : `
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:#f8f9fa">
              <th style="padding:8px;text-align:left;color:#7f8c8d;font-size:12px">Action</th>
              <th style="padding:8px;text-align:left;color:#7f8c8d;font-size:12px">Symbol</th>
              <th style="padding:8px;text-align:left;color:#7f8c8d;font-size:12px">Size / P&L</th>
              <th style="padding:8px;text-align:left;color:#7f8c8d;font-size:12px">Cost</th>
              <th style="padding:8px;text-align:left;color:#7f8c8d;font-size:12px">Score</th>
              <th style="padding:8px;text-align:left;color:#7f8c8d;font-size:12px">Levels</th>
              <th style="padding:8px;text-align:left;color:#7f8c8d;font-size:12px">Signals</th>
            </tr>
          </thead>
          <tbody>
            ${buyRows}${exitRows}${holdRows}
          </tbody>
        </table>
      </div>
      <div style="margin-top:10px;font-size:13px;color:#7f8c8d">
        Deploying <strong>$${plan.totalCost?.toFixed(0) || 0}</strong> of
        <strong>$${plan.deployable?.toFixed(0) || 0}</strong> available (50% of buying power).
        ${isPending ? `&nbsp;·&nbsp; <a href="${approveUrl}">Approve by email link</a>` : ''}
      </div>`}
    </div>`;
  })();

  const posCards = positions.map(p => {
    const pnl      = parseFloat(p.unrealized_pnl || 0);
    const pnlColor = pnl >= 0 ? '#27ae60' : '#e74c3c';
    const pnlSign  = pnl >= 0 ? '+' : '';
    const pct      = parseFloat(p.unrealized_pct || 0);
    return `
      <div style="border:1px solid #ddd;border-radius:8px;padding:15px;margin:8px 0;background:#fff">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <strong style="font-size:18px">${p.symbol}</strong>
            <span style="color:#7f8c8d;margin-left:10px">${p.shares} shares</span>
          </div>
          <div style="text-align:right">
            <div style="font-size:20px;color:${pnlColor};font-weight:bold">
              ${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${pct.toFixed(1)}%)
            </div>
            <div style="color:#7f8c8d;font-size:13px">
              Entry: $${p.entry_price} | Current: $${p.current_price} | Stop: $${p.stop_price}
            </div>
          </div>
        </div>
        <div style="margin-top:8px">
          <button onclick="closePosition('${p.symbol}')"
            style="background:#e74c3c;color:#fff;border:none;padding:6px 14px;border-radius:4px;cursor:pointer">
            Close Position
          </button>
        </div>
      </div>`;
  }).join('') || '<p style="color:#7f8c8d">No open positions</p>';

  // Safely parse reasons column — handles JSON array, JS single-quoted array, or plain string
  function parseReasons(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    const s = String(raw).trim();
    try { return JSON.parse(s); } catch (_) {}
    try { return JSON.parse(s.replace(/'/g, '"')); } catch (_) {}
    return s.replace(/^\[|\]$/g, '').split(',').map(r => r.trim()).filter(Boolean);
  }

  // Build candidate data blobs for the info modal (embedded as JSON in page)
  const candidateData = {};
  candidates.forEach(c => {
    const reasons = parseReasons(c.reasons);
    candidateData[c.id] = {
      symbol:      c.symbol,
      sector:      c.sector      || '—',
      rsi:         c.rsi         || '—',
      riskLevel:   c.risk_level  || '—',
      rr:          c.risk_reward || '—',
      holdDays:    c.suggested_hold_days || '—',
      earningsIn:  c.days_to_earnings != null ? c.days_to_earnings + 'd' : '—',
      scores: {
        technical:   c.technical_score   || 50,
        fundamental: c.fundamental_score || 50,
        sentiment:   c.sentiment_score   || 50,
      },
      reasons,
    };
  });

  const categoryBadgeMap = {
    breakout:       '<span style="background:#f0e8ff;color:#8e44ad;padding:2px 7px;border-radius:10px;font-size:11px;font-weight:bold">⚡ Breakout</span>',
    dividend_value: '<span style="background:#fef9e7;color:#b7950b;padding:2px 7px;border-radius:10px;font-size:11px;font-weight:bold">💰 Dividend</span>',
    strong_moat:    '<span style="background:#e8f8f5;color:#1a7a4a;padding:2px 7px;border-radius:10px;font-size:11px;font-weight:bold">🏰 Moat</span>',
    core:           '',
  };

  const candRows = candidates.map(c => {
    const score      = parseFloat(c.composite_score) || 0;
    const prob       = parseFloat(c.probability_pct) || 0;
    const scoreColor = score >= 65 ? '#27ae60' : score >= 50 ? '#e67e22' : '#e74c3c';
    const riskBadge  = c.risk_level === 'low'
      ? '<span style="background:#d5f5e3;color:#27ae60;padding:2px 7px;border-radius:10px;font-size:11px">Low Risk</span>'
      : c.risk_level === 'high'
      ? '<span style="background:#fde8e8;color:#e74c3c;padding:2px 7px;border-radius:10px;font-size:11px">High Risk</span>'
      : '<span style="background:#fef9e7;color:#e67e22;padding:2px 7px;border-radius:10px;font-size:11px">Med Risk</span>';
    const catBadge   = categoryBadgeMap[c.category] || '';

    return `
      <tr style="border-bottom:1px solid #eee">
        <td style="padding:10px">
          <div style="font-weight:bold;font-size:17px">${c.symbol}</div>
          <div style="color:#7f8c8d;font-size:12px;margin-top:2px">${c.sector || ''}</div>
          ${catBadge ? `<div style="margin-top:4px">${catBadge}</div>` : ''}
        </td>
        <td style="padding:10px;font-size:15px">$${parseFloat(c.suggested_entry).toFixed(2)}</td>
        <td style="padding:10px">
          <div style="display:flex;align-items:center;gap:8px">
            <div style="background:#eee;border-radius:4px;height:10px;width:80px;flex-shrink:0">
              <div style="background:${scoreColor};width:${Math.min(score,100)}%;height:10px;border-radius:4px"></div>
            </div>
            <strong style="color:${scoreColor}">${score}/100</strong>
          </div>
        </td>
        <td style="padding:10px;color:#27ae60;font-weight:bold;font-size:15px">${prob}%</td>
        <td style="padding:10px;color:#27ae60">$${parseFloat(c.suggested_target).toFixed(2)}</td>
        <td style="padding:10px;color:#e74c3c">$${parseFloat(c.suggested_stop).toFixed(2)}</td>
        <td style="padding:10px">${riskBadge}</td>
        <td style="padding:10px">
          <button onclick="showInfo(${c.id})"
            style="background:#8e44ad;color:#fff;border:none;padding:6px 12px;
                   border-radius:4px;cursor:pointer;font-size:13px">
            Why?
          </button>
        </td>
      </tr>`;
  }).join('') || '<tr><td colspan="8" style="padding:20px;color:#7f8c8d;text-align:center">No candidates yet. Scans run pre-market (8:50 AM ET) and midday (12 PM ET). Or click ▶ Scan Now above.</td></tr>';

  const tradeRows = recentTrades.map(t => {
    const pnl      = parseFloat(t.pnl || 0);
    const pnlColor = pnl > 0 ? '#27ae60' : pnl < 0 ? '#e74c3c' : '#7f8c8d';
    return `
      <tr style="border-bottom:1px solid #eee">
        <td style="padding:8px">${t.symbol}</td>
        <td style="padding:8px">${t.status}</td>
        <td style="padding:8px">$${t.entry_price || '-'}</td>
        <td style="padding:8px">$${t.fill_price || t.close_price || '-'}</td>
        <td style="padding:8px;color:${pnlColor};font-weight:bold">
          ${t.pnl ? (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2) : '-'}
        </td>
        <td style="padding:8px;color:#7f8c8d;font-size:12px">${t.close_reason || '-'}</td>
      </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <title>StockTrader Dashboard</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    body { font-family: Arial,sans-serif; margin:0; background:#f5f5f5; color:#2c3e50; }
    .header { background:#2c3e50; color:#fff; padding:15px 25px; display:flex; justify-content:space-between; align-items:center; }
    .header h1 { margin:0; font-size:22px; }
    .container { max-width:1400px; margin:20px auto; padding:0 20px; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:15px; margin-bottom:20px; }
    .stat-card { background:#fff; border-radius:8px; padding:15px; text-align:center; box-shadow:0 1px 4px rgba(0,0,0,.1); }
    .stat-card .val { font-size:24px; font-weight:bold; }
    .stat-card .lbl { color:#7f8c8d; font-size:13px; margin-top:4px; }
    .section { background:#fff; border-radius:8px; padding:20px; margin-bottom:20px; box-shadow:0 1px 4px rgba(0,0,0,.1); }
    .section h2 { margin:0 0 15px; font-size:18px; border-bottom:2px solid #3498db; padding-bottom:8px; }
    table { width:100%; border-collapse:collapse; }
    th { text-align:left; color:#7f8c8d; font-weight:600; font-size:13px; padding:8px; background:#f8f9fa; }
    .refresh-btn { background:#3498db; color:#fff; border:none; padding:8px 16px; border-radius:4px; cursor:pointer; font-size:14px; }
    .scan-btn { background:#9b59b6; color:#fff; border:none; padding:8px 16px; border-radius:4px; cursor:pointer; font-size:14px; margin-left:8px; }
  </style>
</head>
<body>
<div class="header">
  <h1>📈 StockTrader</h1>
  <div>
    ${modeLabel}
    <button class="refresh-btn" onclick="location.reload()" style="margin-left:10px">↻ Refresh</button>
    <a href="/scan-now" class="scan-btn" style="text-decoration:none">▶ Scan Now</a>
  </div>
</div>
<div class="container">

  <div class="stats">
    <div class="stat-card">
      <div class="val" style="color:#2c3e50">$${account ? parseFloat(account.portfolio_value).toFixed(0) : '-'}</div>
      <div class="lbl">Portfolio Value</div>
    </div>
    <div class="stat-card">
      <div class="val" style="color:#2980b9">$${account ? parseFloat(account.buying_power).toFixed(0) : '-'}</div>
      <div class="lbl">Buying Power</div>
    </div>
    <div class="stat-card">
      <div class="val" style="color:#8e44ad">${positions.length} / ${cfg.risk.maxOpenPositions}</div>
      <div class="lbl">Open Positions</div>
    </div>
    <div class="stat-card">
      <div class="val" style="color:${totalPnl >= 0 ? '#27ae60' : '#e74c3c'}">
        ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(0)}
      </div>
      <div class="lbl">Total P&L (recent)</div>
    </div>
    <div class="stat-card">
      <div class="val" style="color:#27ae60">${winRate}</div>
      <div class="lbl">Win Rate</div>
    </div>
    <div class="stat-card">
      <div class="val" style="color:#e67e22">${candidates.length}</div>
      <div class="lbl">Candidates Today</div>
    </div>
  </div>

  <div class="section">
    <h2>Open Positions</h2>
    ${posCards}
  </div>

  ${planSection}

  <div class="section">
    <h2>Today's Trade Candidates <span style="color:#7f8c8d;font-size:14px;font-weight:normal">— ranked by score</span></h2>
    <div style="overflow-x:auto">
      <table>
        <thead>
          <tr>
            <th>Symbol</th><th>Price</th><th>Score</th><th>Probability</th>
            <th>Target</th><th>Stop</th><th>Risk</th><th>Action</th>
          </tr>
        </thead>
        <tbody>${candRows}</tbody>
      </table>
    </div>
  </div>

  <div class="section">
    <h2>Recent Trades</h2>
    <table>
      <thead>
        <tr><th>Symbol</th><th>Status</th><th>Entry</th><th>Exit</th><th>P&L</th><th>Reason</th></tr>
      </thead>
      <tbody>${tradeRows}</tbody>
    </table>
  </div>

</div>
<!-- Info Modal -->
<div id="info-modal" onclick="if(event.target===this)closeModal()"
  style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;
         background:rgba(0,0,0,.5);z-index:1000;overflow-y:auto;padding:40px 20px">
  <div style="background:#fff;border-radius:10px;max-width:540px;margin:0 auto;padding:28px;
              position:relative;box-shadow:0 4px 24px rgba(0,0,0,.2)">
    <button onclick="closeModal()"
      style="position:absolute;top:14px;right:16px;background:none;border:none;
             font-size:22px;cursor:pointer;color:#7f8c8d;line-height:1">×</button>
    <div id="modal-body"></div>
  </div>
</div>

<script>
const CDATA = ${JSON.stringify(candidateData)};

function scoreBar(val, color) {
  return '<div style="display:flex;align-items:center;gap:8px;margin:4px 0">' +
    '<div style="background:#eee;border-radius:3px;height:8px;width:120px;flex-shrink:0">' +
    '<div style="background:' + color + ';width:' + Math.min(val,100) + '%;height:8px;border-radius:3px"></div></div>' +
    '<span style="font-size:13px;font-weight:bold;color:' + color + '">' + val + '/100</span></div>';
}

function showInfo(id) {
  const d = CDATA[id];
  if (!d) return;

  const sc = d.scores;
  const tcol = sc.technical  >= 65 ? '#27ae60' : sc.technical  >= 50 ? '#e67e22' : '#e74c3c';
  const fcol = sc.fundamental >= 65 ? '#27ae60' : sc.fundamental >= 50 ? '#e67e22' : '#e74c3c';
  const scol = sc.sentiment  >= 65 ? '#27ae60' : sc.sentiment  >= 50 ? '#e67e22' : '#e74c3c';

  const reasonsList = d.reasons.length
    ? d.reasons.map(r => '<li style="margin:5px 0;color:#2c3e50">' + r + '</li>').join('')
    : '<li style="color:#95a5a6">No signals recorded</li>';

  document.getElementById('modal-body').innerHTML = \`
    <h2 style="margin:0 0 4px;font-size:22px">\${d.symbol}</h2>
    <div style="color:#7f8c8d;font-size:13px;margin-bottom:20px">\${d.sector} &nbsp;|&nbsp; RSI: \${d.rsi} &nbsp;|&nbsp; Earnings: \${d.earningsIn} &nbsp;|&nbsp; Hold ~\${d.holdDays} days</div>

    <div style="background:#f8f9fa;border-radius:8px;padding:16px;margin-bottom:18px">
      <div style="font-size:13px;color:#7f8c8d;font-weight:600;margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px">Score Breakdown</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div>
          <div style="font-size:12px;color:#7f8c8d;margin-bottom:3px">Technical (35%)</div>
          \${scoreBar(sc.technical, tcol)}
        </div>
        <div>
          <div style="font-size:12px;color:#7f8c8d;margin-bottom:3px">Fundamental (25%)</div>
          \${scoreBar(sc.fundamental, fcol)}
        </div>
        <div>
          <div style="font-size:12px;color:#7f8c8d;margin-bottom:3px">Sentiment (20%)</div>
          \${scoreBar(sc.sentiment, scol)}
        </div>
        <div>
          <div style="font-size:12px;color:#7f8c8d;margin-bottom:3px">Institutional (20%)</div>
          \${scoreBar(50, '#95a5a6')}
        </div>
      </div>
    </div>

    <div style="margin-bottom:16px">
      <div style="font-size:13px;color:#7f8c8d;font-weight:600;margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px">Bullish Signals</div>
      <ul style="margin:0;padding-left:20px;line-height:1.7">
        \${reasonsList}
      </ul>
    </div>

    <div style="display:flex;gap:10px;margin-top:20px">
      <div style="background:#f0f4f8;border-radius:6px;padding:10px 14px;flex:1;text-align:center">
        <div style="font-size:11px;color:#7f8c8d">Risk/Reward</div>
        <div style="font-size:18px;font-weight:bold;color:#2c3e50">\${d.rr}:1</div>
      </div>
      <div style="background:#f0f4f8;border-radius:6px;padding:10px 14px;flex:1;text-align:center">
        <div style="font-size:11px;color:#7f8c8d">Risk Level</div>
        <div style="font-size:18px;font-weight:bold;color:#2c3e50;text-transform:capitalize">\${d.riskLevel}</div>
      </div>
      <div style="background:#f0f4f8;border-radius:6px;padding:10px 14px;flex:1;text-align:center">
        <div style="font-size:11px;color:#7f8c8d">Hold Target</div>
        <div style="font-size:18px;font-weight:bold;color:#2c3e50">\${d.holdDays} days</div>
      </div>
    </div>
  \`;

  document.getElementById('info-modal').style.display = 'block';
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  document.getElementById('info-modal').style.display = 'none';
  document.body.style.overflow = '';
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

async function closePosition(symbol) {
  if (!confirm('Close position in ' + symbol + ' at market price?')) return;
  const r = await fetch('/position/' + symbol + '/close', { method: 'POST' });
  const d = await r.json();
  if (d.success) { alert('Position closed.'); location.reload(); }
  else alert('Error: ' + d.error);
}
async function triggerScan(btn) {
  btn.disabled = true; btn.textContent = 'Scanning...';
  await fetch('/api/scan', { method: 'POST' });
  btn.textContent = 'Scan triggered — refreshing in 30s...';
  setTimeout(() => location.reload(), 30000);
}
async function approvePlan(id) {
  if (!confirm('Approve this plan and place all trades now?')) return;
  const btn = document.querySelector('button[onclick="approvePlan(' + id + ')"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Executing...'; }
  try {
    const r = await fetch('/plan' + id + '/approve', { method: 'POST' });
    const d = await r.json();
    if (d.success) {
      alert('Plan approved! Bought: [' + (d.bought || []).join(', ') + ']' + (d.errors?.length ? '\nErrors: ' + d.errors.join(', ') : ''));
      location.reload();
    } else {
      alert('Error: ' + (d.error || 'Unknown error'));
      if (btn) { btn.disabled = false; btn.textContent = '✓ Approve Plan'; }
    }
  } catch(e) {
    alert('Request failed: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = '✓ Approve Plan'; }
  }
}
async function rejectPlan(id) {
  if (!confirm('Reject this plan? No trades will be placed.')) return;
  const r = await fetch('/plan' + id + '/reject', { method: 'POST' });
  const d = await r.json();
  if (d.success) { location.reload(); }
  else alert('Error: ' + (d.error || 'Unknown error'));
}
// Auto-refresh every 3 minutes
setTimeout(() => location.reload(), 180000);
</script>
</body>
</html>`;
}

function renderCandidateDetail(c, news) {
  const reasons  = (() => { try { return JSON.parse(c.reasons || '[]'); } catch(_){ return []; } })();
  const scoreColor = c.composite_score >= 70 ? '#27ae60' : c.composite_score >= 55 ? '#e67e22' : '#e74c3c';
  const maSignal = c.above_50ma && c.above_200ma ? '🟢 Above both 50MA & 200MA'
                 : c.above_50ma ? '🟡 Above 50MA, below 200MA'
                 : '🔴 Below both MAs';
  const newsHtml = news.map(n => `
    <div style="border-bottom:1px solid #eee;padding:10px 0">
      <a href="${n.url||'#'}" target="_blank" style="color:#2980b9;font-weight:bold">${n.headline}</a>
      <div style="color:#7f8c8d;font-size:12px;margin-top:4px">
        ${n.source} · ${n.published_at ? new Date(n.published_at).toLocaleString() : ''}
      </div>
    </div>`).join('') || '<p style="color:#7f8c8d">No news cached</p>';

  return `<!DOCTYPE html>
<html>
<head><title>${c.symbol} — StockTrader</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:Arial,sans-serif;margin:0;background:#f5f5f5;color:#2c3e50}
  .header{background:#2c3e50;color:#fff;padding:15px 25px}
  .container{max-width:900px;margin:20px auto;padding:0 20px}
  .card{background:#fff;border-radius:8px;padding:20px;margin-bottom:20px;box-shadow:0 1px 4px rgba(0,0,0,.1)}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:15px}
  .metric{background:#f8f9fa;border-radius:6px;padding:12px}
  .metric .val{font-size:20px;font-weight:bold}
  .metric .lbl{color:#7f8c8d;font-size:13px}
</style>
</head>
<body>
<div class="header">
  <a href="/dashboard" style="color:#fff;text-decoration:none">← Dashboard</a>
  <h1 style="margin:8px 0">${c.symbol} — ${c.company_name || ''}</h1>
  <div>${c.sector || ''}</div>
</div>
<div class="container">

  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:15px">
      <div>
        <div style="font-size:36px;font-weight:bold">$${c.suggested_entry}</div>
        <div style="color:${c.price_change_pct >= 0 ? '#27ae60' : '#e74c3c'}">
          ${c.price_change_pct >= 0 ? '▲' : '▼'} ${Math.abs(c.price_change_pct || 0).toFixed(2)}% today
        </div>
      </div>
      <div style="text-align:center">
        <div style="font-size:48px;font-weight:bold;color:${scoreColor}">${c.composite_score}</div>
        <div style="color:#7f8c8d">Score / 100</div>
        <div style="color:#27ae60;font-size:18px;font-weight:bold">${c.probability_pct}% probability</div>
      </div>
      <div style="text-align:right">
        <a href="/dashboard" style="background:#2c3e50;color:#fff;padding:12px 24px;
           border-radius:6px;text-decoration:none;font-size:14px">← Back to Dashboard</a>
      </div>
    </div>
  </div>

  <div class="card">
    <h3>Suggested Trade Levels</h3>
    <div class="grid">
      <div class="metric"><div class="val">$${c.suggested_entry}</div><div class="lbl">Entry Price</div></div>
      <div class="metric"><div class="val" style="color:#27ae60">$${c.suggested_target}</div><div class="lbl">Target (+${(((c.suggested_target-c.suggested_entry)/c.suggested_entry)*100).toFixed(1)}%)</div></div>
      <div class="metric"><div class="val" style="color:#e74c3c">$${c.suggested_stop}</div><div class="lbl">Stop Loss (-${(((c.suggested_entry-c.suggested_stop)/c.suggested_entry)*100).toFixed(1)}%)</div></div>
      <div class="metric"><div class="val">${c.suggested_shares} shares</div><div class="lbl">$${(c.suggested_shares*c.suggested_entry).toFixed(0)} position</div></div>
      <div class="metric"><div class="val">1 : ${c.risk_reward}</div><div class="lbl">Risk / Reward</div></div>
      <div class="metric"><div class="val">${c.suggested_hold_days} days</div><div class="lbl">Suggested Hold</div></div>
    </div>
  </div>

  <div class="card">
    <h3>Signal Breakdown</h3>
    <div class="grid">
      <div>
        <strong>Technical (${Math.round(c.technical_score)}/100)</strong>
        <div>RSI: ${c.rsi || 'N/A'} ${c.rsi < 35 ? '🟢 Oversold' : c.rsi > 70 ? '🔴 Overbought' : ''}</div>
        <div>MACD: ${c.macd_signal || 'neutral'}</div>
        <div>Bollinger: ${c.bollinger_position || 'normal'}</div>
        <div>${maSignal}</div>
        <div>Volume: ${c.volume_ratio}x average</div>
      </div>
      <div>
        <strong>Fundamental (${Math.round(c.fundamental_score)}/100)</strong>
        <div>P/E: ${c.pe_ratio || 'N/A'}</div>
        <div>EPS growth: ${c.eps_growth_pct || 'N/A'}%</div>
        <div>Debt/Equity: ${c.debt_equity || 'N/A'}</div>
        ${c.days_to_earnings !== null ? `<div>Earnings in: ${c.days_to_earnings} days</div>` : ''}
      </div>
      <div>
        <strong>Institutional (${Math.round(c.sentiment_score)}/100)</strong>
        <div>Short interest: ${c.short_interest_pct || 'N/A'}%</div>
      </div>
      <div>
        <strong>Sentiment (${Math.round(c.sentiment_score)}/100)</strong>
        <div>Analysts: ${c.analyst_buy} Buy / ${c.analyst_hold} Hold / ${c.analyst_sell} Sell</div>
        <div>Price target: $${c.analyst_pt || 'N/A'}</div>
        <div>StockTwits: ${c.stocktwits_bulls || 'N/A'}% bullish</div>
      </div>
    </div>
  </div>

  <div class="card">
    <h3>Why This Trade</h3>
    <ul>${reasons.map(r => `<li style="margin:6px 0">${r}</li>`).join('')}</ul>
  </div>

  <div class="card">
    <h3>Recent News</h3>
    ${newsHtml}
  </div>

</div>
</body>
</html>`;
}

function renderMessage(msg, type) {
  const colors = { success: '#27ae60', error: '#e74c3c', warning: '#e67e22', info: '#2980b9' };
  const color  = colors[type] || '#2c3e50';
  return `<!DOCTYPE html>
<html><head><title>StockTrader</title></head>
<body style="font-family:Arial,sans-serif;text-align:center;padding:60px;background:#f5f5f5">
  <div style="background:#fff;border-radius:8px;padding:40px;max-width:500px;margin:0 auto;
              border-top:4px solid ${color};box-shadow:0 2px 8px rgba(0,0,0,.1)">
    <p style="font-size:18px;color:${color}">${msg}</p>
    <a href="/dashboard" style="display:inline-block;margin-top:20px;background:#2c3e50;
       color:#fff;padding:10px 24px;border-radius:4px;text-decoration:none">← Dashboard</a>
  </div>
</body></html>`;
}

function renderSettings(current) {
  const sources = require('./config/sources');
  const options = {
    priceData:     ['alpaca', 'yahoo', 'polygon'],
    fundamentals:  ['yahoo', 'finnhub'],
    marketContext: ['alpaca', 'yahoo', 'polygon'],
    vix:           ['yahoo', 'alphavantage'],
    news:          ['yahoo', 'finnhub'],
    sentiment:     ['stocktwits', 'alphavantage', 'none'],
  };

  const labels = {
    priceData:     'Price / OHLCV Bars',
    fundamentals:  'Fundamentals & Analyst Data',
    marketContext: 'Market Context (SPY/QQQ)',
    vix:           'VIX Data',
    news:          'Company News',
    sentiment:     'Retail Sentiment',
  };

  const notes = {
    alpaca:       'Free, fast, reliable — uses your existing API key',
    yahoo:        'Free, no key needed — may rate limit under heavy use',
    polygon:      'Requires Polygon API key — free tier = 5 req/min',
    finnhub:      'Requires Finnhub API key — free tier = 60 req/min',
    stocktwits:   'Free, no key — retail trader sentiment',
    alphavantage: 'Requires Alpha Vantage key — free tier = 25 req/day',
    none:         'Disable this data source entirely',
  };

  const rows = Object.entries(options).map(([key, vals]) => `
    <tr style="border-bottom:1px solid #eee">
      <td style="padding:12px;font-weight:bold">${labels[key]}</td>
      <td style="padding:12px">
        <select id="${key}" onchange="updateSource('${key}', this.value)"
          style="padding:8px 12px;border:1px solid #ddd;border-radius:4px;font-size:14px;min-width:160px">
          ${vals.map(v => `
            <option value="${v}" ${current[key] === v ? 'selected' : ''}>
              ${v.charAt(0).toUpperCase() + v.slice(1)}
            </option>`).join('')}
        </select>
      </td>
      <td style="padding:12px;color:#27ae60;font-size:13px" id="status-${key}">
        ● Active: ${current[key]}
      </td>
      <td style="padding:12px;color:#7f8c8d;font-size:12px">${notes[current[key]] || ''}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html>
<head><title>Settings — StockTrader</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:Arial,sans-serif;margin:0;background:#f5f5f5;color:#2c3e50}
  .header{background:#2c3e50;color:#fff;padding:15px 25px}
  .nav{background:#34495e;padding:8px 25px;display:flex;gap:20px}
  .nav a{color:#bdc3c7;text-decoration:none;font-size:14px;padding:4px 0}
  .nav a:hover,.nav a.active{color:#fff}
  .container{max-width:900px;margin:20px auto;padding:0 20px}
  .card{background:#fff;border-radius:8px;padding:20px;margin-bottom:20px;box-shadow:0 1px 4px rgba(0,0,0,.1)}
  table{width:100%;border-collapse:collapse}
  th{text-align:left;color:#7f8c8d;font-size:13px;padding:8px;background:#f8f9fa}
</style>
</head>
<body>
<div class="header">
  <h1 style="margin:4px 0">Settings — Data Sources</h1>
  <div style="color:#bdc3c7;font-size:13px">Changes take effect on next scan — no restart needed</div>
</div>
<div class="nav">
  <a href="/dashboard">Dashboard</a>
  <a href="/settings" class="active">Data Sources</a>
  <a href="/admin">Scoring Params</a>
</div>
<div class="container">

  <div class="card">
    <h3 style="margin-top:0">Data Source Configuration</h3>
    <p style="color:#7f8c8d">Select which API to use for each data type.
       If a source is rate-limited or unavailable, switch to an alternative here.</p>
    <table>
      <thead>
        <tr>
          <th>Data Type</th>
          <th>Source</th>
          <th>Status</th>
          <th>Notes</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>

  <div class="card">
    <h3 style="margin-top:0">Source Health Check</h3>
    <p style="color:#7f8c8d">Test all configured sources with a live data fetch.</p>
    <button onclick="runHealthCheck()"
      style="background:#2980b9;color:#fff;border:none;padding:10px 20px;border-radius:4px;cursor:pointer;font-size:14px">
      Run Health Check
    </button>
    <div id="health-result" style="margin-top:15px;font-family:monospace;font-size:13px"></div>
  </div>

  <div class="card" style="border-left:4px solid #2980b9">
    <h3 style="margin-top:0">Scoring & Risk Parameters</h3>
    <p style="color:#7f8c8d">All scoring weights, RSI thresholds, VIX levels, market adjustments, and risk parameters
       are now fully configurable via the Admin page — stored in the database, editable without restart.</p>
    <a href="/admin"
      style="display:inline-block;background:#2980b9;color:#fff;text-decoration:none;
             padding:10px 20px;border-radius:4px;font-size:14px;font-weight:bold">
      Go to Admin — Scoring Parameters →
    </a>
  </div>

</div>
<script>
const notes = ${JSON.stringify(Object.fromEntries(
  Object.entries(options).flatMap(([k, vals]) => vals.map(v => [v, notes[v] || '']))
))};

async function updateSource(key, value) {
  const r = await fetch('/settings/source', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value }),
  });
  const d = await r.json();
  if (d.success) {
    document.getElementById('status-' + key).innerHTML = '● Active: ' + value;
    document.getElementById('status-' + key).style.color = '#27ae60';
  } else {
    alert('Error: ' + d.error);
  }
}

async function runHealthCheck() {
  const btn = event.target;
  btn.disabled = true; btn.textContent = 'Checking...';
  const r = await fetch('/api/source-health');
  const d = await r.json();
  btn.disabled = false; btn.textContent = 'Run Health Check';

  const el = document.getElementById('health-result');
  if (d.error) { el.innerHTML = '<span style="color:red">Error: ' + d.error + '</span>'; return; }

  let html = '<table style="width:100%;border-collapse:collapse">';
  for (const [type, result] of Object.entries(d.health || {})) {
    const ok = result.status === 'ok';
    html += '<tr style="border-bottom:1px solid #eee">' +
      '<td style="padding:6px;font-weight:bold">' + type + '</td>' +
      '<td style="padding:6px;color:#7f8c8d">' + result.source + '</td>' +
      '<td style="padding:6px;color:' + (ok ? '#27ae60' : '#e74c3c') + '">' +
      (ok ? '✓ OK' : '✗ ' + (result.error || result.status)) + '</td>' +
      '<td style="padding:6px;color:#7f8c8d">' + (result.bars ? result.bars + ' bars' : result.name || '') + '</td>' +
      '</tr>';
  }
  html += '</table>';
  el.innerHTML = html;
}
</script>
</body>
</html>`;
}

// ─── Admin page renderer ──────────────────────────────────────────────────────
function renderAdmin(params) {
  const { PARAM_META, DEFAULTS } = paramsCfg;

  const groupTitles = {
    risk:        'Risk & Position Sizing',
    thresholds:  'Score & Probability Thresholds',
    weights:     'Scoring Weights',
    technical:   'Technical Signal Thresholds',
    vix:         'VIX Thresholds & Adjustments',
    market:      'Market Context Adjustments',
  };

  const sections = Object.entries(PARAM_META).map(([group, fields]) => {
    const rows = fields.map(f => {
      const current = params[f.key];
      const isModified = current !== DEFAULTS[f.key];
      return `
      <tr style="border-bottom:1px solid #eee" id="row-${f.key}">
        <td style="padding:10px 8px">
          <div style="font-weight:500">${f.label}</div>
          <div style="color:#95a5a6;font-size:12px;margin-top:2px">${f.description}</div>
        </td>
        <td style="padding:10px 8px;text-align:center;color:#7f8c8d;font-size:13px">${DEFAULTS[f.key]}</td>
        <td style="padding:10px 8px">
          <input type="number"
            id="inp-${f.key}"
            value="${current}"
            step="${f.step || 1}"
            ${f.min !== undefined ? `min="${f.min}"` : ''}
            ${f.max !== undefined ? `max="${f.max}"` : ''}
            style="width:100px;padding:6px 8px;border:1px solid ${isModified ? '#e67e22' : '#ddd'};
                   border-radius:4px;font-size:14px;text-align:center"
            onchange="markDirty('${f.key}', this.value, ${DEFAULTS[f.key]})"
          >
        </td>
        <td style="padding:10px 8px">
          <button onclick="saveParam('${f.key}')"
            style="background:#2980b9;color:#fff;border:none;padding:6px 12px;border-radius:4px;cursor:pointer;font-size:13px;margin-right:4px">
            Save
          </button>
          ${isModified ? `<button onclick="resetParam('${f.key}', ${DEFAULTS[f.key]})"
            style="background:#95a5a6;color:#fff;border:none;padding:6px 10px;border-radius:4px;cursor:pointer;font-size:13px">
            Reset
          </button>` : ''}
        </td>
        <td style="padding:10px 8px;font-size:12px" id="status-${f.key}">
          ${isModified ? '<span style="color:#e67e22">Modified</span>' : '<span style="color:#bdc3c7">Default</span>'}
        </td>
      </tr>`;
    }).join('');

    return `
    <div class="card">
      <h3 style="margin-top:0;color:#2c3e50">${groupTitles[group] || group}</h3>
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="background:#f8f9fa">
            <th style="padding:8px;text-align:left;color:#7f8c8d;font-size:13px;width:40%">Parameter</th>
            <th style="padding:8px;text-align:center;color:#7f8c8d;font-size:13px;width:15%">Default</th>
            <th style="padding:8px;text-align:left;color:#7f8c8d;font-size:13px;width:20%">Current Value</th>
            <th style="padding:8px;text-align:left;color:#7f8c8d;font-size:13px;width:15%">Action</th>
            <th style="padding:8px;text-align:left;color:#7f8c8d;font-size:13px;width:10%">State</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head><title>Admin — StockTrader</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:Arial,sans-serif;margin:0;background:#f5f5f5;color:#2c3e50}
  .header{background:#2c3e50;color:#fff;padding:15px 25px}
  .nav{background:#34495e;padding:8px 25px;display:flex;gap:20px}
  .nav a{color:#bdc3c7;text-decoration:none;font-size:14px;padding:4px 0}
  .nav a:hover,.nav a.active{color:#fff}
  .container{max-width:960px;margin:20px auto;padding:0 20px}
  .card{background:#fff;border-radius:8px;padding:20px;margin-bottom:20px;box-shadow:0 1px 4px rgba(0,0,0,.1)}
  .toast{position:fixed;top:20px;right:20px;padding:10px 20px;border-radius:6px;font-size:14px;
         font-weight:bold;z-index:9999;display:none;box-shadow:0 2px 8px rgba(0,0,0,.2)}
</style>
</head>
<body>
<div class="header">
  <h1 style="margin:4px 0">Admin — Scoring Parameters</h1>
  <div style="color:#bdc3c7;font-size:13px">All changes take effect on the next scan — no restart needed</div>
</div>
<div class="nav">
  <a href="/dashboard">Dashboard</a>
  <a href="/settings">Data Sources</a>
  <a href="/admin" class="active">Scoring Params</a>
</div>
<div class="container">

  <div class="card" style="background:#fff3cd;border-left:4px solid #e67e22">
    <strong>How this works:</strong> Every value here is stored in the database and applied on the next scan.
    Orange border = modified from default. Use Reset to return to default. Weights should sum to 1.0.
    <br><br>
    <button onclick="resetAll()" style="background:#e74c3c;color:#fff;border:none;padding:8px 16px;border-radius:4px;cursor:pointer;font-size:13px">
      Reset ALL to defaults
    </button>
    <button onclick="triggerScan(this)" style="background:#27ae60;color:#fff;border:none;padding:8px 16px;border-radius:4px;cursor:pointer;font-size:13px;margin-left:8px">
      Trigger Scan Now
    </button>
  </div>

  ${sections}

</div>

<div id="toast" class="toast"></div>

<script>
function showToast(msg, color) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.background = color || '#27ae60';
  t.style.color = '#fff';
  t.style.display = 'block';
  setTimeout(() => t.style.display = 'none', 2500);
}

function markDirty(key, val, def) {
  const inp = document.getElementById('inp-' + key);
  inp.style.borderColor = parseFloat(val) !== parseFloat(def) ? '#e67e22' : '#ddd';
}

async function saveParam(key) {
  const val = document.getElementById('inp-' + key).value;
  const r = await fetch('/admin/param', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value: val }),
  });
  const d = await r.json();
  if (d.success) {
    document.getElementById('status-' + key).innerHTML = '<span style="color:#e67e22">Modified</span>';
    showToast(key + ' saved: ' + d.value);
  } else {
    showToast('Error: ' + d.error, '#e74c3c');
  }
}

async function resetParam(key, defaultVal) {
  const r = await fetch('/admin/param/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  const d = await r.json();
  if (d.success) {
    document.getElementById('inp-' + key).value = d.value;
    document.getElementById('inp-' + key).style.borderColor = '#ddd';
    document.getElementById('status-' + key).innerHTML = '<span style="color:#bdc3c7">Default</span>';
    showToast(key + ' reset to default');
  } else {
    showToast('Error: ' + d.error, '#e74c3c');
  }
}

async function resetAll() {
  if (!confirm('Reset ALL parameters to defaults? This cannot be undone.')) return;
  const keys = ${JSON.stringify(Object.values(paramsCfg.PARAM_META).flat().map(f => f.key))};
  let count = 0;
  for (const key of keys) {
    const r = await fetch('/admin/param/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    const d = await r.json();
    if (d.success) {
      const inp = document.getElementById('inp-' + key);
      if (inp) { inp.value = d.value; inp.style.borderColor = '#ddd'; }
      const st = document.getElementById('status-' + key);
      if (st) st.innerHTML = '<span style="color:#bdc3c7">Default</span>';
      count++;
    }
  }
  showToast('Reset ' + count + ' parameters to defaults');
}
</script>
</body>
</html>`;
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(cfg.app.port, () => {
  console.log(`\nStockTrader running on port ${cfg.app.port}`);
  console.log(`Dashboard: ${cfg.app.url}/dashboard`);
  console.log(`Mode: ${cfg.alpaca.isPaper ? 'PAPER TRADING' : 'LIVE TRADING'}`);
  cron.startAll();
});

module.exports = app;
