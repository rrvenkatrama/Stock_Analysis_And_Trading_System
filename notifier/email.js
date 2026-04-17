// Email notifications — trade alerts, approvals, position updates
const nodemailer = require('nodemailer');
const cfg        = require('../config/env');

const transporter = nodemailer.createTransport({
  host:   cfg.email.host,
  port:   cfg.email.port,
  secure: false,
  auth:   { user: cfg.email.user, pass: cfg.email.pass },
});

// Safely parse the reasons column — handles JSON array, JS array (single quotes), or plain string
function parseReasons(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  const s = String(raw).trim();
  try { return JSON.parse(s); } catch (_) {}
  // JS array with single quotes → swap quotes and retry
  try { return JSON.parse(s.replace(/'/g, '"')); } catch (_) {}
  // Comma-separated plain string fallback
  return s.replace(/^\[|\]$/g, '').split(',').map(r => r.trim()).filter(Boolean);
}

function riskColor(risk) {
  return risk === 'low' ? '#27ae60' : risk === 'medium' ? '#e67e22' : '#e74c3c';
}

function scoreBar(score) {
  const fill  = Math.round(score);
  const color = score >= 70 ? '#27ae60' : score >= 50 ? '#e67e22' : '#e74c3c';
  return `
    <div style="background:#eee;border-radius:4px;height:10px;width:200px;display:inline-block;vertical-align:middle">
      <div style="background:${color};width:${fill}%;height:10px;border-radius:4px"></div>
    </div>
    <span style="margin-left:8px;font-weight:bold;color:${color}">${fill}/100</span>`;
}

// ─── Trade Candidate Alert ────────────────────────────────────────────────────
// Sent when a new scan produces candidates (summary digest)
async function sendCandidateDigest(candidates) {
  if (!candidates.length) return;
  if (!cfg.email.user) return;

  const rows = candidates.slice(0, 8).map(c => `
    <tr>
      <td style="padding:8px;font-weight:bold">${c.symbol}</td>
      <td style="padding:8px">$${c.suggested_entry}</td>
      <td style="padding:8px">${scoreBar(c.composite_score)}</td>
      <td style="padding:8px;color:#27ae60;font-weight:bold">${c.probability_pct}%</td>
      <td style="padding:8px">
        <a href="${cfg.app.url}/candidate/${c.id}"
           style="background:#2980b9;color:#fff;padding:6px 14px;border-radius:4px;text-decoration:none">
          View &amp; Select
        </a>
      </td>
    </tr>`).join('');

  await transporter.sendMail({
    from:    `StockTrader <${cfg.email.user}>`,
    to:      cfg.email.to,
    subject: `📊 ${candidates.length} Trade Candidates Ready — Top: ${candidates[0].symbol} (${candidates[0].composite_score}/100)`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:700px">
        <h2 style="color:#2c3e50">Today's Top Trade Candidates</h2>
        <p style="color:#7f8c8d">Scan completed. Review and select trades to execute.</p>
        <table style="width:100%;border-collapse:collapse;border:1px solid #ddd">
          <thead style="background:#2c3e50;color:#fff">
            <tr>
              <th style="padding:8px;text-align:left">Symbol</th>
              <th style="padding:8px;text-align:left">Price</th>
              <th style="padding:8px;text-align:left">Score</th>
              <th style="padding:8px;text-align:left">Probability</th>
              <th style="padding:8px;text-align:left">Action</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="margin-top:20px">
          <a href="${cfg.app.url}/dashboard"
             style="background:#2c3e50;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none">
            Open Full Dashboard
          </a>
        </p>
        <p style="color:#bdc3c7;font-size:12px">
          ${cfg.alpaca.isPaper ? '⚠️ PAPER TRADING MODE' : '🔴 LIVE TRADING'} |
          Candidates expire in 8 hours
        </p>
      </div>`,
  });
}

// ─── Trade Approval Request ───────────────────────────────────────────────────
async function sendApprovalRequest(trade, candidate) {
  if (!cfg.email.user) return;

  const approveUrl = `${cfg.app.url}/trade/approve/${trade.approval_token}`;
  const rejectUrl  = `${cfg.app.url}/trade/reject/${trade.approval_token}`;
  const expires    = new Date(trade.approval_expires_at).toLocaleTimeString();
  const reasons    = parseReasons(candidate.reasons).map(r => `<li>${r}</li>`).join('');

  await transporter.sendMail({
    from:    `StockTrader <${cfg.email.user}>`,
    to:      cfg.email.to,
    subject: `⚡ Trade Request: BUY ${trade.shares} ${trade.symbol} @ $${trade.entry_price}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px">
        <h2 style="color:#2c3e50">Trade Approval Required</h2>
        <div style="background:#f8f9fa;border-left:4px solid #2980b9;padding:15px;margin:15px 0">
          <h3 style="margin:0;color:#2c3e50">BUY ${trade.shares} shares of ${trade.symbol}</h3>
          <p style="margin:8px 0;color:#7f8c8d">${candidate.company_name || ''} · ${candidate.sector || ''}</p>
          <table style="width:100%;margin-top:10px">
            <tr>
              <td><strong>Entry:</strong> $${trade.entry_price}</td>
              <td><strong>Target:</strong> $${trade.target_price} (+${(((trade.target_price-trade.entry_price)/trade.entry_price)*100).toFixed(1)}%)</td>
              <td><strong>Stop:</strong> $${trade.stop_price} (-${(((trade.entry_price-trade.stop_price)/trade.entry_price)*100).toFixed(1)}%)</td>
            </tr>
            <tr style="margin-top:8px">
              <td><strong>Score:</strong> ${candidate.composite_score}/100</td>
              <td><strong>Probability:</strong> <span style="color:#27ae60">${candidate.probability_pct}%</span></td>
              <td><strong>Risk:</strong> <span style="color:${riskColor(candidate.risk_level)}">${(candidate.risk_level||'').toUpperCase()}</span></td>
            </tr>
            <tr>
              <td><strong>Risk/Reward:</strong> 1:${trade.risk_reward || '?'}</td>
              <td><strong>Hold:</strong> ${candidate.suggested_hold_days} days</td>
              <td><strong>Position:</strong> $${(trade.shares * trade.entry_price).toFixed(0)}</td>
            </tr>
          </table>
        </div>
        <h4>Why this trade:</h4>
        <ul style="color:#555">${reasons}</ul>
        <div style="margin:25px 0;text-align:center">
          <a href="${approveUrl}"
             style="background:#27ae60;color:#fff;padding:14px 30px;border-radius:6px;
                    text-decoration:none;font-size:16px;font-weight:bold;margin-right:15px">
            ✓ APPROVE TRADE
          </a>
          <a href="${rejectUrl}"
             style="background:#e74c3c;color:#fff;padding:14px 30px;border-radius:6px;
                    text-decoration:none;font-size:16px;font-weight:bold">
            ✗ REJECT
          </a>
        </div>
        <p style="color:#e74c3c;font-size:13px;text-align:center">
          ⏰ Expires at ${expires} (2 hours) — you can also approve/reject from the dashboard
        </p>
        <p style="color:#bdc3c7;font-size:12px;text-align:center">
          ${cfg.alpaca.isPaper ? '⚠️ PAPER TRADING MODE — No real money involved' : '🔴 LIVE TRADING'}
        </p>
      </div>`,
  });
}

// ─── Trade Filled Confirmation ────────────────────────────────────────────────
async function sendFillConfirmation(trade) {
  if (!cfg.email.user) return;
  await transporter.sendMail({
    from:    `StockTrader <${cfg.email.user}>`,
    to:      cfg.email.to,
    subject: `✅ Filled: ${trade.shares} ${trade.symbol} @ $${trade.fill_price}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:500px">
        <h2 style="color:#27ae60">Order Filled</h2>
        <p><strong>${trade.shares} shares of ${trade.symbol}</strong> bought at <strong>$${trade.fill_price}</strong></p>
        <p>Stop loss set at <strong>$${trade.stop_price}</strong></p>
        <p>Target: <strong>$${trade.target_price}</strong></p>
        <p><a href="${cfg.app.url}/portfolio">View Portfolio</a></p>
      </div>`,
  });
}

// ─── Stop Loss / Position Closed ─────────────────────────────────────────────
async function sendPositionClosed(trade) {
  if (!cfg.email.user) return;
  const pnl      = parseFloat(trade.pnl || 0);
  const pnlColor = pnl >= 0 ? '#27ae60' : '#e74c3c';
  const pnlSign  = pnl >= 0 ? '+' : '';
  await transporter.sendMail({
    from:    `StockTrader <${cfg.email.user}>`,
    to:      cfg.email.to,
    subject: `${pnl >= 0 ? '✅' : '🔴'} Closed: ${trade.symbol} ${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${trade.pnl_pct?.toFixed(1)}%)`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:500px">
        <h2 style="color:${pnlColor}">${trade.symbol} Position Closed</h2>
        <p>Reason: <strong>${(trade.close_reason || '').replace(/_/g, ' ')}</strong></p>
        <p>Entry: $${trade.entry_price} → Close: $${trade.close_price}</p>
        <p style="font-size:20px;color:${pnlColor}">
          <strong>P&L: ${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${trade.pnl_pct?.toFixed(1)}%)</strong>
        </p>
        <p><a href="${cfg.app.url}/history">View Trade History</a></p>
      </div>`,
  });
}

// ─── Portfolio Plan Email ─────────────────────────────────────────────────────
async function sendPortfolioPlan(plan, token) {
  if (!cfg.email.user) return;

  const approveUrl = `${cfg.app.url}/plan/approve/${token}`;
  const rejectUrl  = `${cfg.app.url}/plan/reject/${token}`;

  const buyRows = (plan.buys || []).map(b => `
    <tr style="border-bottom:1px solid #eee">
      <td style="padding:8px;font-weight:bold;color:#27ae60">BUY</td>
      <td style="padding:8px;font-weight:bold;font-size:15px">${b.symbol}</td>
      <td style="padding:8px">${b.shares} shares @ ~$${b.price.toFixed(2)}</td>
      <td style="padding:8px;font-weight:bold">$${b.estimatedCost.toFixed(0)}</td>
      <td style="padding:8px">${scoreBar(b.score)} &nbsp; ${b.probability}%</td>
      <td style="padding:8px;color:#7f8c8d;font-size:12px">${(b.reasons || []).slice(0,2).join('; ')}</td>
    </tr>`).join('');

  const exitRows = (plan.exits || []).map(e => `
    <tr style="border-bottom:1px solid #eee">
      <td style="padding:8px;font-weight:bold;color:#e74c3c">${e.action === 'swap' ? 'SWAP' : 'SELL'}</td>
      <td style="padding:8px;font-weight:bold;font-size:15px">${e.symbol}</td>
      <td style="padding:8px" colspan="2">${e.gainPct > 0 ? '+' : ''}${e.gainPct}% since entry</td>
      <td style="padding:8px" colspan="2;color:#7f8c8d;font-size:12px">${e.reason}</td>
    </tr>`).join('');

  const holdRows = (plan.holds || []).map(h => `
    <tr style="border-bottom:1px solid #eee">
      <td style="padding:8px;font-weight:bold;color:#2980b9">HOLD</td>
      <td style="padding:8px;font-weight:bold;font-size:15px">${h.symbol}</td>
      <td style="padding:8px" colspan="2">${h.gainPct > 0 ? '+' : ''}${h.gainPct}% since entry</td>
      <td style="padding:8px" colspan="2;color:#7f8c8d;font-size:12px">${h.reason}</td>
    </tr>`).join('');

  const hasAction = plan.buys?.length || plan.exits?.length;

  await transporter.sendMail({
    from:    `StockTrader <${cfg.email.user}>`,
    to:      cfg.email.to,
    subject: `📋 Daily Portfolio Plan — ${plan.summary}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:750px">
        <h2 style="color:#2c3e50;margin-bottom:4px">Daily Portfolio Plan</h2>
        <p style="color:#7f8c8d;margin-top:0">${plan.summary}</p>

        <div style="background:#f8f9fa;border-radius:8px;padding:14px;margin:16px 0;
                    display:flex;gap:20px;flex-wrap:wrap">
          <div><strong>Buying Power:</strong> $${plan.buyingPower?.toFixed(0) || '—'}</div>
          <div><strong>Deploying:</strong> $${plan.totalCost?.toFixed(0) || 0}</div>
          <div><strong>Positions:</strong>
            ${plan.buys?.length || 0} new &nbsp;·&nbsp;
            ${plan.exits?.length || 0} exits &nbsp;·&nbsp;
            ${plan.holds?.length || 0} holds</div>
          <div><strong>Mode:</strong> ${cfg.alpaca.isPaper ? '⚠️ PAPER' : '🔴 LIVE'}</div>
        </div>

        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <thead style="background:#2c3e50;color:#fff">
            <tr>
              <th style="padding:8px;text-align:left">Action</th>
              <th style="padding:8px;text-align:left">Symbol</th>
              <th style="padding:8px;text-align:left">Size</th>
              <th style="padding:8px;text-align:left">Cost</th>
              <th style="padding:8px;text-align:left">Score / Prob</th>
              <th style="padding:8px;text-align:left">Why</th>
            </tr>
          </thead>
          <tbody>
            ${buyRows}
            ${exitRows}
            ${holdRows}
          </tbody>
        </table>

        ${hasAction ? `
        <div style="margin:28px 0;text-align:center">
          <a href="${approveUrl}"
             style="background:#27ae60;color:#fff;padding:14px 32px;border-radius:6px;
                    text-decoration:none;font-size:16px;font-weight:bold;margin-right:16px">
            ✓ APPROVE PLAN
          </a>
          <a href="${rejectUrl}"
             style="background:#e74c3c;color:#fff;padding:14px 32px;border-radius:6px;
                    text-decoration:none;font-size:16px;font-weight:bold">
            ✗ REJECT
          </a>
        </div>
        <p style="color:#e74c3c;font-size:13px;text-align:center">
          ⏰ Expires end of trading day — or approve/reject from the dashboard
        </p>` : `
        <p style="text-align:center;color:#7f8c8d;margin-top:20px">
          No trades needed today — all positions are on track.
          <br><a href="${cfg.app.url}/dashboard">View Dashboard</a>
        </p>`}
      </div>`,
  });
}

// ─── Autorun Mode Change Email ────────────────────────────────────────────────
async function sendModeChangeEmail(mode) {
  if (!cfg.email.user || !cfg.email.to) return;
  const isOn     = mode === 'ON';
  const color    = isOn ? '#27ae60' : '#e67e22';
  const icon     = isOn ? '▶' : '⏸';
  const headline = isOn
    ? 'Autorun is now ON. Trades will execute automatically at 9:35 AM ET on the next trading day.'
    : 'Autorun is now OFF. Recommendations will continue to arrive by email — no trades will execute until re-enabled.';

  await transporter.sendMail({
    from:    `My Stocks <${cfg.email.user}>`,
    to:      cfg.email.to,
    subject: `${icon} My Stocks Autorun: ${mode}`,
    html: `
<div style="font-family:Arial,sans-serif;max-width:600px;background:#fff;border:1px solid #ddd;border-radius:8px;overflow:hidden">
  <div style="background:#1a1f35;padding:20px 24px">
    <h1 style="color:${color};margin:0;font-size:18px">${icon} Autorun Switched ${mode}</h1>
    <div style="color:#718096;margin-top:6px;font-size:12px">${new Date().toLocaleString('en-US',{timeZone:'America/New_York'})} ET</div>
  </div>
  <div style="padding:20px 24px;font-size:13px;color:#2d3748">
    <p>${headline}</p>
    ${isOn ? `<ul style="color:#2d3748;line-height:1.8">
      <li>Only stocks in your personal watchlist (is_active=1) are traded</li>
      <li>Max 8 open positions; one position per symbol</li>
      <li>Hard stop: −8% from entry (full sell)</li>
      <li>Soft exits at 50%: score&lt;25, RSI&gt;75, EMA cross, MACD bear, 30d time stop</li>
      <li>No trading within 5 days of earnings</li>
    </ul>` : ''}
    <div style="margin-top:16px">
      <a href="http://192.168.1.156:8081/"
         style="background:#1a1f35;color:#63b3ed;padding:10px 20px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:bold">
        Open My Stocks Dashboard →
      </a>
    </div>
  </div>
</div>`,
  });
  console.log(`[Email] Autorun mode change: ${mode}`);
}

// ─── Autotrader Execution Email ───────────────────────────────────────────────
// Sent after the 9:35 AM execution window when autorun is ON
async function sendAutotraderEmail(results, strategyLabel = 'Alpha') {
  if (!cfg.email.user || !cfg.email.to) return;
  if (!results) return;

  const { exits, entries, regime, errors } = results;
  const total = exits.length + entries.length;
  if (total === 0 && !errors.length) return; // nothing to report

  const exitRows = exits.map(a => {
    const pnlColor = a.pnlPct >= 0 ? '#27ae60' : '#e74c3c';
    return `<tr style="border-bottom:1px solid #eee">
      <td style="padding:8px;font-weight:bold">${a.symbol}</td>
      <td style="padding:8px;color:#e74c3c">SELL ${a.sellPct}%</td>
      <td style="padding:8px">${a.qty} shares @ $${a.currentPrice?.toFixed(2)}</td>
      <td style="padding:8px;color:${pnlColor}">${a.pnlPct?.toFixed(1)}%</td>
      <td style="padding:8px;color:#718096;font-size:12px">${a.reason}</td>
      <td style="padding:8px">${a.executed ? '✅' : (a.error ? '❌' : '—')}</td>
    </tr>`;
  }).join('');

  const isPhoenix   = strategyLabel === 'Phoenix';
  const headerColor = isPhoenix ? '#805ad5' : '#63b3ed';
  const headerBg    = isPhoenix ? '#1a1540' : '#1a1f35';
  const stratIcon   = isPhoenix ? '🔥' : '⚡';

  const entryRows = entries.map(a => `
    <tr style="border-bottom:1px solid #eee">
      <td style="padding:8px;font-weight:bold">${a.symbol}</td>
      <td style="padding:8px;color:#27ae60">BUY</td>
      <td style="padding:8px">${a.qty} shares @ ~$${a.price?.toFixed(2)}</td>
      <td style="padding:8px">${scoreBar(a.score)}</td>
      <td style="padding:8px;color:#718096;font-size:12px">${isPhoenix
        ? `${Math.abs(a.pctFrom52h||0).toFixed(0)}% below 52wk high · EPS ${a.epsGrowth||'?'}%`
        : `${a.confirmations} confirmations · vol ${a.volRatio ?? '—'}x`}</td>
      <td style="padding:8px">${a.executed ? '✅' : (a.error ? '❌' : '—')}</td>
    </tr>`).join('');

  const errorRows = errors.map(e => `<tr>
    <td style="padding:6px;color:#fc8181;font-weight:bold">${e.phase}${e.symbol ? ' — ' + e.symbol : ''}</td>
    <td style="padding:6px;font-family:monospace;font-size:11px">${e.message}</td>
  </tr>`).join('');

  await transporter.sendMail({
    from:    `My Stocks <${cfg.email.user}>`,
    to:      cfg.email.to,
    subject: `${stratIcon} ${strategyLabel} Executed — ${entries.length} buy${entries.length !== 1 ? 's' : ''}, ${exits.length} sell${exits.length !== 1 ? 's' : ''}`,
    html: `
<div style="font-family:Arial,sans-serif;max-width:700px;background:#fff;border:1px solid #ddd;border-radius:8px;overflow:hidden">
  <div style="background:${headerBg};padding:20px 24px">
    <h1 style="color:${headerColor};margin:0;font-size:18px">${stratIcon} ${strategyLabel} — Today's Trades</h1>
    <div style="color:#718096;margin-top:6px;font-size:12px">${new Date().toLocaleString('en-US',{timeZone:'America/New_York'})} ET${regime ? ` · Regime: ${regime}` : ''}</div>
  </div>
  <div style="padding:20px 24px">
    ${exits.length ? `
    <h2 style="color:#e74c3c;font-size:14px;border-bottom:2px solid #eee;padding-bottom:6px;margin-bottom:10px">Sells (${exits.length})</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead style="background:#fdf0f0"><tr>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Symbol</th>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Action</th>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Qty / Price</th>
        <th style="padding:8px;text-align:left;color:#7f8c8d">P&L</th>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Reason</th>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Status</th>
      </tr></thead>
      <tbody>${exitRows}</tbody>
    </table>` : ''}
    ${entries.length ? `
    <h2 style="color:#27ae60;font-size:14px;border-bottom:2px solid #eee;padding-bottom:6px;margin:20px 0 10px">Buys (${entries.length})</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead style="background:#f0faf4"><tr>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Symbol</th>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Action</th>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Qty / Price</th>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Score</th>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Signals</th>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Status</th>
      </tr></thead>
      <tbody>${entryRows}</tbody>
    </table>` : ''}
    ${errors.length ? `
    <h2 style="color:#e74c3c;font-size:13px;margin:20px 0 8px">Errors (${errors.length})</h2>
    <table style="width:100%;border-collapse:collapse;font-size:12px;background:#1a0f0f;border-radius:6px">
      <tbody>${errorRows}</tbody>
    </table>` : ''}
    <div style="margin-top:20px;text-align:center">
      <a href="http://192.168.1.156:8081/"
         style="background:#1a1f35;color:#63b3ed;padding:10px 20px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:bold">
        Open My Stocks Dashboard →
      </a>
    </div>
  </div>
</div>`,
  });
  console.log(`[Email] Autotrader execution email: ${entries.length} buys, ${exits.length} sells`);
}

// ─── My Stocks Daily Digest ───────────────────────────────────────────────────
// signals: array from stock_signals table (score, recommendation, symbol, name, price, why)
// positions: array from Alpaca /positions API
// autotraderResults: from autotrader.evaluate(false) — recommendations only, no orders placed
async function sendDailyDigest(signals, positions, picks = [], autotraderResults = null, phoenixResults = null) {
  if (!cfg.email.user || !cfg.email.to) return;

  const today    = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  const mode     = cfg.alpaca.isPaper ? '📄 PAPER TRADING' : '💰 LIVE TRADING';
  const modeColor = cfg.alpaca.isPaper ? '#2980b9' : '#e74c3c';

  const posMap   = new Map(positions.map(p => [p.symbol, p]));

  // ── Section 1: Your current positions ────────────────────────────────────────
  const posRows = positions.length ? positions.map(p => {
    const sig     = signals.find(s => s.symbol === p.symbol);
    const pnl     = parseFloat(p.unrealized_pl  || 0);
    const pnlPct  = parseFloat(p.unrealized_plpc || 0) * 100;
    const pnlSign = pnl >= 0 ? '+' : '';
    const pnlColor = pnl >= 0 ? '#27ae60' : '#e74c3c';
    const rec     = sig ? sig.recommendation : '—';
    const recColor = rec === 'BUY' ? '#27ae60' : rec === 'SELL' ? '#e74c3c' : '#e67e22';
    return `<tr style="border-bottom:1px solid #eee">
      <td style="padding:8px;font-weight:bold">${p.symbol}</td>
      <td style="padding:8px">${parseInt(p.qty)}</td>
      <td style="padding:8px">$${parseFloat(p.avg_entry_price).toFixed(2)}</td>
      <td style="padding:8px">$${parseFloat(p.current_price).toFixed(2)}</td>
      <td style="padding:8px;color:${pnlColor};font-weight:bold">${pnlSign}$${Math.abs(pnl).toFixed(0)} (${pnlSign}${pnlPct.toFixed(1)}%)</td>
      <td style="padding:8px;font-weight:bold;color:${recColor}">${rec}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="6" style="padding:10px;color:#7f8c8d">No open positions.</td></tr>';

  // ── Section 2: BUY signals (not already owned, top 10 by score) ──────────────
  const buySignals = signals
    .filter(s => s.recommendation === 'BUY' && !posMap.has(s.symbol))
    .slice(0, 10);
  const buyRows = buySignals.length ? buySignals.map(s => `
    <tr style="border-bottom:1px solid #eee">
      <td style="padding:8px;font-weight:bold">${s.symbol}</td>
      <td style="padding:8px;color:#7f8c8d;font-size:12px">${s.name || ''}</td>
      <td style="padding:8px">$${parseFloat(s.price||0).toFixed(2)}</td>
      <td style="padding:8px">${scoreBar(s.score)}</td>
      <td style="padding:8px;font-size:11px;color:#7f8c8d;max-width:220px">${(s.why||'').replace(/Score:\d+\/100 \| /,'').split(' | ').slice(0,3).join(' · ')}</td>
    </tr>`).join('') : '<tr><td colspan="5" style="padding:10px;color:#7f8c8d">No strong buy signals today.</td></tr>';

  // ── Section 3: HOLD signals for owned stocks ──────────────────────────────────
  const holdOwned = positions
    .map(p => ({ pos: p, sig: signals.find(s => s.symbol === p.symbol) }))
    .filter(x => x.sig && x.sig.recommendation === 'HOLD');

  const holdRows = holdOwned.length ? holdOwned.map(({ pos, sig }) => `
    <tr style="border-bottom:1px solid #eee">
      <td style="padding:8px;font-weight:bold">${pos.symbol}</td>
      <td style="padding:8px">${parseInt(pos.qty)} shares</td>
      <td style="padding:8px">$${parseFloat(pos.current_price).toFixed(2)}</td>
      <td style="padding:8px">${scoreBar(sig.score)}</td>
    </tr>`).join('') : '<tr><td colspan="4" style="padding:10px;color:#7f8c8d">No hold positions today.</td></tr>';

  // ── Section 4: SELL signals for owned stocks ──────────────────────────────────
  const sellOwned = positions
    .map(p => ({ pos: p, sig: signals.find(s => s.symbol === p.symbol) }))
    .filter(x => x.sig && x.sig.recommendation === 'SELL');

  const sellRows = sellOwned.length ? sellOwned.map(({ pos, sig }) => {
    const pnl = parseFloat(pos.unrealized_pl || 0);
    return `<tr style="border-bottom:1px solid #eee">
      <td style="padding:8px;font-weight:bold">${pos.symbol}</td>
      <td style="padding:8px">${parseInt(pos.qty)} shares</td>
      <td style="padding:8px">$${parseFloat(pos.current_price).toFixed(2)}</td>
      <td style="padding:8px;color:${pnl>=0?'#27ae60':'#e74c3c'};font-weight:bold">${pnl>=0?'+':''}$${Math.abs(pnl).toFixed(0)}</td>
      <td style="padding:8px;color:#e74c3c;font-weight:bold">⚠ SELL</td>
    </tr>`;
  }).join('') : '';

  const buyCount  = signals.filter(s => s.recommendation === 'BUY').length;
  const holdCount = signals.filter(s => s.recommendation === 'HOLD').length;
  const sellCount = signals.filter(s => s.recommendation === 'SELL').length;

  // ── New picks from universe scan (top 15 for email) ───────────────────────
  const topPicks  = (picks || []).slice(0, 15);
  const pickRows  = topPicks.length ? topPicks.map(s => `
    <tr style="border-bottom:1px solid #eee">
      <td style="padding:8px;font-weight:bold;color:#7c3aed">${s.symbol}</td>
      <td style="padding:8px;color:#7f8c8d;font-size:12px">${s.name || '—'}</td>
      <td style="padding:8px">$${parseFloat(s.price||0).toFixed(2)}</td>
      <td style="padding:8px">${scoreBar(s.score)}</td>
      <td style="padding:8px;font-size:11px;color:#7f8c8d;max-width:240px">${(s.why||'').replace(/Score:\d+\/100 \| /,'').split(' | ').slice(0,3).join(' · ')}</td>
    </tr>`).join('') : '<tr><td colspan="5" style="padding:10px;color:#7f8c8d">No new picks today — run universe scan first.</td></tr>';

  await transporter.sendMail({
    from:    `My Stocks <${cfg.email.user}>`,
    to:      cfg.email.to,
    subject: `📊 My Stocks Daily — ${today} | ${buyCount} Buy · ${holdCount} Hold · ${picks.length} New Picks`,
    html: `
<div style="font-family:Arial,sans-serif;max-width:750px;background:#fff;border:1px solid #ddd;border-radius:8px;overflow:hidden">
  <div style="background:#1a1f35;padding:20px 24px">
    <h1 style="color:#63b3ed;margin:0;font-size:20px">📊 My Stocks Daily Digest</h1>
    <div style="color:#718096;margin-top:6px;font-size:13px">${today}</div>
    <div style="margin-top:8px;display:inline-block;background:${modeColor};color:#fff;padding:3px 10px;border-radius:4px;font-size:12px;font-weight:bold">${mode}</div>
  </div>

  <div style="padding:20px 24px">
    <div style="display:flex;gap:20px;margin-bottom:20px">
      <div style="background:#f0faf4;border-radius:8px;padding:12px 20px;text-align:center">
        <div style="font-size:24px;font-weight:bold;color:#27ae60">${buyCount}</div>
        <div style="font-size:12px;color:#7f8c8d">BUY Signals</div>
      </div>
      <div style="background:#fdf9f0;border-radius:8px;padding:12px 20px;text-align:center">
        <div style="font-size:24px;font-weight:bold;color:#e67e22">${holdCount}</div>
        <div style="font-size:12px;color:#7f8c8d">HOLD Signals</div>
      </div>
      <div style="background:#fdf0f0;border-radius:8px;padding:12px 20px;text-align:center">
        <div style="font-size:24px;font-weight:bold;color:#e74c3c">${sellCount}</div>
        <div style="font-size:12px;color:#7f8c8d">SELL Signals</div>
      </div>
      <div style="background:#f0f4ff;border-radius:8px;padding:12px 20px;text-align:center">
        <div style="font-size:24px;font-weight:bold;color:#2980b9">${positions.length}</div>
        <div style="font-size:12px;color:#7f8c8d">Open Positions</div>
      </div>
      <div style="background:#f5f0ff;border-radius:8px;padding:12px 20px;text-align:center">
        <div style="font-size:24px;font-weight:bold;color:#7c3aed">${picks.length}</div>
        <div style="font-size:12px;color:#7f8c8d">New Picks</div>
      </div>
    </div>

    ${positions.length ? `
    <h2 style="color:#2c3e50;font-size:15px;border-bottom:2px solid #eee;padding-bottom:8px;margin-bottom:12px">📂 Your Positions</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead style="background:#f8f9fa"><tr>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Symbol</th>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Qty</th>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Entry</th>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Current</th>
        <th style="padding:8px;text-align:left;color:#7f8c8d">P&L</th>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Signal</th>
      </tr></thead>
      <tbody>${posRows}</tbody>
    </table>` : ''}

    ${sellOwned.length ? `
    <h2 style="color:#e74c3c;font-size:15px;border-bottom:2px solid #eee;padding-bottom:8px;margin:20px 0 12px">⚠ Consider Selling</h2>
    <p style="color:#7f8c8d;font-size:12px;margin-bottom:8px">You own these stocks — today's signal suggests selling.</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead style="background:#fdf0f0"><tr>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Symbol</th>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Qty</th>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Current</th>
        <th style="padding:8px;text-align:left;color:#7f8c8d">P&L</th>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Action</th>
      </tr></thead>
      <tbody>${sellRows}</tbody>
    </table>` : ''}

    <h2 style="color:#27ae60;font-size:15px;border-bottom:2px solid #eee;padding-bottom:8px;margin:20px 0 12px">🟢 Top Buy Opportunities</h2>
    <p style="color:#7f8c8d;font-size:12px;margin-bottom:8px">Stocks not currently in your portfolio with BUY signal, ranked by score.</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead style="background:#f0faf4"><tr>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Symbol</th>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Name</th>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Price</th>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Score</th>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Key Signals</th>
      </tr></thead>
      <tbody>${buyRows}</tbody>
    </table>

    ${holdOwned.length ? `
    <h2 style="color:#e67e22;font-size:15px;border-bottom:2px solid #eee;padding-bottom:8px;margin:20px 0 12px">🟡 Hold — No Action Needed</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead style="background:#fdf9f0"><tr>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Symbol</th>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Qty</th>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Current</th>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Score</th>
      </tr></thead>
      <tbody>${holdRows}</tbody>
    </table>` : ''}

    <h2 style="color:#7c3aed;font-size:15px;border-bottom:2px solid #eee;padding-bottom:8px;margin:20px 0 12px">🔭 Momentum Leaders &amp; New Picks</h2>
    <p style="color:#7f8c8d;font-size:12px;margin-bottom:8px">Top BUY signals from ~200 tracked stocks <em>not</em> in your watchlist — sorted by score. Add to watchlist to track full fundamentals.</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead style="background:#f5f0ff"><tr>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Symbol</th>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Name</th>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Price</th>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Score</th>
        <th style="padding:8px;text-align:left;color:#7f8c8d">Key Signals</th>
      </tr></thead>
      <tbody>${pickRows}</tbody>
    </table>

    ${autotraderResults && (autotraderResults.exits.length || autotraderResults.entries.length) ? `
    <h2 style="color:#dd6b20;font-size:15px;border-bottom:2px solid #eee;padding-bottom:8px;margin:20px 0 12px">⚡ Alpha Autotrader — Tomorrow's Recommendations</h2>
    <p style="color:#7f8c8d;font-size:12px;margin-bottom:8px">Market regime: <strong>${autotraderResults.regime || 'unknown'}</strong>. These trades will execute at 9:35 AM ET if Alpha is ON.</p>
    ${autotraderResults.exits.length ? `
    <p style="font-size:12px;font-weight:bold;color:#e74c3c;margin:8px 0 4px">Suggested Sells (${autotraderResults.exits.length})</p>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <tbody>${autotraderResults.exits.map(a => `<tr style="border-bottom:1px solid #eee">
        <td style="padding:6px;font-weight:bold">${a.symbol}</td>
        <td style="padding:6px;color:#e74c3c">${a.sellPct}% sell</td>
        <td style="padding:6px;color:#718096">${a.reason}</td>
      </tr>`).join('')}</tbody>
    </table>` : ''}
    ${autotraderResults.entries.length ? `
    <p style="font-size:12px;font-weight:bold;color:#27ae60;margin:12px 0 4px">Suggested Buys (${autotraderResults.entries.length})</p>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <tbody>${autotraderResults.entries.map(a => `<tr style="border-bottom:1px solid #eee">
        <td style="padding:6px;font-weight:bold">${a.symbol}</td>
        <td style="padding:6px;color:#27ae60">Buy ${a.qty} shares</td>
        <td style="padding:6px">$${a.price?.toFixed(2)}</td>
        <td style="padding:6px">${scoreBar(a.score)}</td>
      </tr>`).join('')}</tbody>
    </table>` : ''}` : ''}

    ${phoenixResults && (phoenixResults.exits.length || phoenixResults.entries.length) ? `
    <h2 style="color:#805ad5;font-size:15px;border-bottom:2px solid #eee;padding-bottom:8px;margin:20px 0 12px">🔥 Phoenix Autotrader — Tomorrow's Recommendations</h2>
    <p style="color:#7f8c8d;font-size:12px;margin-bottom:8px">VIX: <strong>${phoenixResults.vix ?? 'n/a'}</strong> · Sizing multiplier: <strong>${phoenixResults.vixMult ?? 1.0}×</strong>. These trades execute at 9:35 AM ET if Phoenix is ON.</p>
    ${phoenixResults.exits.length ? `
    <p style="font-size:12px;font-weight:bold;color:#e74c3c;margin:8px 0 4px">Suggested Sells (${phoenixResults.exits.length})</p>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <tbody>${phoenixResults.exits.map(a => `<tr style="border-bottom:1px solid #eee">
        <td style="padding:6px;font-weight:bold">${a.symbol}</td>
        <td style="padding:6px;color:#e74c3c">${a.sellPct}% sell</td>
        <td style="padding:6px;color:#718096">${a.reason}</td>
        <td style="padding:6px;color:${a.pnlPct>=0?'#27ae60':'#e74c3c'}">${a.pnlPct>=0?'+':''}${a.pnlPct?.toFixed(1)}%</td>
      </tr>`).join('')}</tbody>
    </table>` : ''}
    ${phoenixResults.entries.length ? `
    <p style="font-size:12px;font-weight:bold;color:#805ad5;margin:12px 0 4px">Suggested Buys (${phoenixResults.entries.length})</p>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <tbody>${phoenixResults.entries.map(a => `<tr style="border-bottom:1px solid #eee">
        <td style="padding:6px;font-weight:bold">${a.symbol}</td>
        <td style="padding:6px;color:#805ad5">Buy ${a.qty} shares @ $${a.price?.toFixed(2)}</td>
        <td style="padding:6px">Score: ${a.score}</td>
        <td style="padding:6px;color:#718096">${Math.abs(a.pctFrom52h ?? 0).toFixed(0)}% below 52wk high · EPS +${parseFloat(a.epsGrowth ?? 0).toFixed(0)}%</td>
      </tr>`).join('')}</tbody>
    </table>` : ''}` : ''}

    <div style="margin-top:24px;text-align:center;padding:16px;background:#f8f9fa;border-radius:6px">
      <a href="http://192.168.1.156:8081/"
         style="background:#1a1f35;color:#63b3ed;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:13px">
        Open My Stocks Dashboard →
      </a>
    </div>
  </div>
  <div style="background:#f8f9fa;padding:12px 24px;font-size:11px;color:#bdc3c7;text-align:center">
    My Stocks Dashboard · ${mode} · Generated ${new Date().toLocaleString('en-US', {timeZone:'America/New_York'})} ET
  </div>
</div>`,
  });
  console.log(`[Email] Daily digest sent to ${cfg.email.to}`);
}

// ─── Error Alert ─────────────────────────────────────────────────────────────
// Sent when daily refresh pipeline encounters errors or exceptions
async function sendErrorAlert(errors) {
  if (!cfg.email.user || !cfg.email.to) return;
  if (!errors || errors.length === 0) return;

  const rows = errors.map(e => `
    <tr>
      <td style="padding:8px 12px;font-weight:bold;color:#fc8181;white-space:nowrap">${e.phase || '—'}</td>
      <td style="padding:8px 12px;font-family:monospace;font-size:12px;color:#e2e8f0;word-break:break-word">${e.message || String(e)}</td>
      <td style="padding:8px 12px;color:#718096;font-size:11px;white-space:nowrap">${e.symbol || ''}</td>
    </tr>`).join('');

  await transporter.sendMail({
    from:    `StockTrader <${cfg.email.user}>`,
    to:      cfg.email.to,
    subject: `⚠️ My Stocks — ${errors.length} error${errors.length !== 1 ? 's' : ''} during daily refresh`,
    html: `
<div style="font-family:Arial,sans-serif;background:#0d1117;color:#e2e8f0;padding:24px;max-width:700px;margin:auto">
  <div style="font-size:20px;font-weight:bold;color:#fc8181;margin-bottom:6px">⚠️ Daily Refresh Errors</div>
  <div style="color:#718096;font-size:13px;margin-bottom:20px">${new Date().toLocaleString('en-US',{timeZone:'America/New_York'})} ET</div>
  <div style="background:#1a0f0f;border:1px solid #6b2c2c;border-radius:8px;overflow:hidden;margin-bottom:20px">
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr style="background:#2d1515">
          <th style="padding:10px 12px;text-align:left;color:#fc8181;font-size:12px">Phase</th>
          <th style="padding:10px 12px;text-align:left;color:#fc8181;font-size:12px">Error</th>
          <th style="padding:10px 12px;text-align:left;color:#fc8181;font-size:12px">Symbol</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <div style="font-size:12px;color:#718096">
    Other phases completed normally. Check logs for full stack traces:<br>
    <code style="color:#90cdf4">journalctl --user -u stocktrader_portfolio -n 100 --no-pager</code>
  </div>
</div>`,
  });
  console.log(`[Email] Error alert sent — ${errors.length} error(s)`);
}

module.exports = {
  sendCandidateDigest,
  sendApprovalRequest,
  sendPortfolioPlan,
  sendFillConfirmation,
  sendPositionClosed,
  sendDailyDigest,
  sendErrorAlert,
  sendModeChangeEmail,
  sendAutotraderEmail,
};
