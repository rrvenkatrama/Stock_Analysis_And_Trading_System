// My Stocks Research Dashboard — port 8081
require('dotenv').config();
const express  = require('express');
const cfg      = require('./config/env');
const db       = require('./db/db');
const yh       = require('./portfolio_app/yahoo_history');
const { analyzeAll, analyzeSymbol } = require('./portfolio_app/analyzer');
const { startScheduler, runDailyRefresh } = require('./portfolio_app/scheduler');
const settingsCache = require('./portfolio_app/settingsCache');
const {
  getAccount, getAlpacaPositions, getOpenOrders,
  cancelAlpacaOrder, placeDirectOrder, getMarketClock, getPortfolioHistory,
} = require('./trader/executor');
const { getDailyBars } = require('./data/alpacaData');
const { getTopPicks } = require('./portfolio_app/universe');
const { run: autoRun } = require('./portfolio_app/autotrader');

const PORT = parseInt(process.env.PORTFOLIO_PORT) || 8081;
const app  = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function parseJ(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch (_) { return {}; } }
  return raw;
}

// ─── CSS ─────────────────────────────────────────────────────────────────────
const STYLE = `
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7f9fc;color:#1a202c;font-size:13px}
a{color:inherit;text-decoration:none}
.header{background:linear-gradient(135deg,#1a365d 0%,#2c5282 100%);border-bottom:1px solid #2a4a7f;padding:14px 24px;display:flex;align-items:center;gap:20px;flex-wrap:wrap}
.header h1{font-size:18px;font-weight:700;color:#bee3f8;white-space:nowrap}
.badge{display:inline-block;padding:2px 8px;border-radius:9px;font-size:11px;font-weight:700;white-space:nowrap}
.badge-buy{background:#f0fff4;color:#276749;border:1px solid #9ae6b4}
.badge-hold{background:#ebf8ff;color:#2b6cb0;border:1px solid #bee3f8}
.badge-sell{background:#fff5f5;color:#9b2c2c;border:1px solid #feb2b2}
.badge-etf{background:#faf5ff;color:#6b46c1;border:1px solid #d6bcfa}
.badge-paper{background:#ebf8ff;color:#2b6cb0;border:1px solid #bee3f8;font-size:11px;font-weight:700;padding:3px 10px;border-radius:5px}
.badge-live{background:#fff5f5;color:#c53030;border:1px solid #feb2b2;font-size:11px;font-weight:700;padding:3px 10px;border-radius:5px}
.stat-bar{display:flex;gap:16px;padding:10px 24px;background:#ffffff;border-bottom:1px solid #e2e8f0;box-shadow:0 1px 3px rgba(0,0,0,.06);flex-wrap:wrap;align-items:center}
.stat{text-align:center;min-width:70px}
.stat .num{font-size:22px;font-weight:700;line-height:1}
.stat .lbl{font-size:10px;color:#718096;margin-top:2px;text-transform:uppercase;letter-spacing:.5px}
.btn{display:inline-block;padding:6px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;border:none;white-space:nowrap}
.btn-primary{background:#3182ce;color:#fff}.btn-primary:hover{background:#2b6cb0}
.btn-success{background:#276749;color:#c6f6d5}.btn-success:hover{background:#22543d}
.btn-danger{background:#9b2c2c;color:#fed7d7}.btn-danger:hover{background:#742a2a}
.btn-warn{background:#c05621;color:#feebc8}.btn-warn:hover{background:#9c4221}
.btn-sm{padding:4px 10px;font-size:11px}
.btn-xs{padding:3px 8px;font-size:11px;border-radius:4px}
.card{background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
table{width:100%;border-collapse:collapse}
th{background:#f0f4f8;color:#4a5568;text-align:left;padding:8px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;white-space:nowrap;border-bottom:2px solid #e2e8f0;cursor:pointer;user-select:none;position:sticky;top:0;z-index:1}
th:hover{color:#2c5282}
th.sort-asc::after{content:" ▲";color:#3182ce}
th.sort-desc::after{content:" ▼";color:#3182ce}
td{padding:10px 10px;border-bottom:1px solid #edf2f7;vertical-align:middle;background:#ffffff}
tr:hover td{background:#f7fafc}
.score-bar{background:#e2e8f0;border-radius:4px;height:6px;width:80px;overflow:hidden;display:inline-block;vertical-align:middle;margin-left:6px}
.score-fill{height:100%;border-radius:4px}
.tbl-wrap{overflow-x:auto;overflow-y:auto}
.signal-up{color:#276749;font-weight:600}.signal-down{color:#c53030;font-weight:600}.signal-neu{color:#718096}
input[type=text],input[type=number],select{background:#ffffff;border:1px solid #e2e8f0;color:#1a202c;padding:6px 10px;border-radius:6px;font-size:13px;outline:none;width:100%}
input[type=text]:focus,input[type=number]:focus,select:focus{border-color:#3182ce;box-shadow:0 0 0 2px rgba(49,130,206,.15)}
.filter-bar{padding:10px 24px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:#ffffff;border-bottom:1px solid #e2e8f0}
.section-hdr{padding:14px 24px 0;font-size:14px;font-weight:700;color:#2c5282}
.section-sub{font-size:11px;color:#718096;font-weight:400;margin-left:8px}
.portfolio-wrap{padding:12px 24px 16px}
.pnl-pos{color:#276749;font-weight:600}.pnl-neg{color:#c53030;font-weight:600}
.tag{display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:600}
.tag-golden{background:#fff7ed;color:#c05621;border:1px solid #f6ad55}
.tag-death{background:#fff5f5;color:#9b2c2c;border:1px solid #feb2b2}
.modal-bg{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.5);z-index:100;align-items:center;justify-content:center}
.modal-box{background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;padding:20px;max-width:420px;width:92%;max-height:90vh;overflow-y:auto;box-shadow:0 10px 40px rgba(0,0,0,.15)}
.modal-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.modal-title{font-weight:700;font-size:15px;color:#2c5282}
.modal-close{background:none;border:none;color:#718096;font-size:20px;cursor:pointer;line-height:1}
.form-group{margin-bottom:11px}
.form-label{font-size:11px;color:#718096;display:block;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px}
.info-box{font-size:12px;padding:8px 10px;border-radius:5px;background:#f7fafc;border:1px solid #e2e8f0;margin-bottom:11px;color:#4a5568}
.cost-row{display:flex;justify-content:space-between;align-items:center;font-size:12px;padding:7px 10px;background:#f7fafc;border:1px solid #e2e8f0;border-radius:5px;margin-bottom:11px}
.chart-modal-box{background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;padding:20px;max-width:820px;width:96%;max-height:92vh;overflow-y:auto;box-shadow:0 10px 40px rgba(0,0,0,.15)}
.chart-ctrl-btn{padding:4px 10px;font-size:11px;font-weight:600;border-radius:4px;cursor:pointer;border:1px solid #e2e8f0;background:#f7fafc;color:#4a5568}
.chart-ctrl-btn.active{background:#ebf8ff;color:#2b6cb0;border-color:#bee3f8}
.filter-btn{background:#2d3748;color:#718096;border:1px solid #4a5568;border-radius:4px;cursor:pointer}
.filter-btn:hover{background:#4a5568;color:#a0aec0}
.filter-btn-active{background:#3182ce;color:#bee3f8;border-color:#2b6cb0}
.perf-tbl td{padding:1px 6px 1px 0;border:none;font-size:11px;background:none}
#stocks-table th:nth-child(1){position:sticky;left:0;z-index:3;background:#f0f4f8;width:30px;text-align:center}
#stocks-table td:nth-child(1){position:sticky;left:0;z-index:2;background:#ffffff;width:30px;text-align:center}
#stocks-table th:nth-child(2){position:sticky;left:30px;z-index:3;background:#f0f4f8}
#stocks-table td:nth-child(2){position:sticky;left:30px;z-index:2;background:#ffffff}
#stocks-table tr:hover td:nth-child(1),#stocks-table tr:hover td:nth-child(2){background:#f7fafc}
@keyframes starPulse{0%,100%{transform:scale(1);filter:drop-shadow(0 0 2px #d69e2e)}50%{transform:scale(1.35);filter:drop-shadow(0 0 9px #f6ad55)}}
.star-recent{animation:starPulse 1.8s ease-in-out infinite;display:inline-block;cursor:default;font-size:17px}
.star-active{color:#d69e2e;cursor:default;font-size:15px}
.star-none{color:#4a5568;cursor:default;font-size:14px}
.tab-nav{display:flex;gap:0;background:#1a1f2e;padding:0 24px;border-bottom:2px solid #2d3748;position:sticky;top:56px;z-index:40}
.tab-btn{padding:10px 20px;font-size:13px;font-weight:600;cursor:pointer;border:none;background:transparent;color:#718096;border-bottom:3px solid transparent;margin-bottom:-2px;white-space:nowrap;transition:color .15s,border-color .15s}
.tab-btn:hover{color:#e2e8f0}
.tab-btn.active{color:#63b3ed;border-bottom-color:#3182ce}
.tab-content{display:none}
.tab-content.active{display:block}
</style>`;

// ─── JS ───────────────────────────────────────────────────────────────────────
const JS = `
<script>
function sortTable(col){
  const t=document.getElementById('stocks-table');
  const th=document.querySelectorAll('#stocks-table th');
  const rows=Array.from(t.querySelectorAll('tbody tr'));
  const idx=Array.from(th).findIndex(e=>e.dataset.col===col);
  const asc=th[idx].classList.contains('sort-asc');
  th.forEach(e=>e.classList.remove('sort-asc','sort-desc'));
  th[idx].classList.add(asc?'sort-desc':'sort-asc');
  rows.sort((a,b)=>{
    const av=a.cells[idx]?.dataset?.val??a.cells[idx]?.textContent??'';
    const bv=b.cells[idx]?.dataset?.val??b.cells[idx]?.textContent??'';
    const an=parseFloat(av),bn=parseFloat(bv);
    if(!isNaN(an)&&!isNaN(bn)) return asc?bn-an:an-bn;
    return asc?bv.localeCompare(av):av.localeCompare(bv);
  });
  const tbody=t.querySelector('tbody');rows.forEach(r=>tbody.appendChild(r));
}
// ── Enhanced filtering system with localStorage ────────────────────────────────
const FilterState = {
  search: '',
  recommendation: '',
  goldenCross: 'all',
  eligibility: '',
  pickFlag: '',
  inPortfolio: '',
  watchlist: '',
  watchlistSymbols: new Set(),

  applyAll() {
    this.saveToLocalStorage();
    this.applyFilters();
  },

  saveToLocalStorage() {
    try {
      localStorage.setItem('stocks-filter-state', JSON.stringify({
        search: this.search,
        recommendation: this.recommendation,
        goldenCross: this.goldenCross,
        eligibility: this.eligibility,
        pickFlag: this.pickFlag,
        inPortfolio: this.inPortfolio,
        watchlist: this.watchlist,
      }));
    } catch (e) {}
  },

  loadFromLocalStorage() {
    try {
      const saved = JSON.parse(localStorage.getItem('stocks-filter-state') || '{}');
      this.search = saved.search || '';
      this.recommendation = saved.recommendation || '';
      this.goldenCross = saved.goldenCross || 'all';
      this.eligibility = saved.eligibility || '';
      this.pickFlag = saved.pickFlag || '';
      this.inPortfolio = saved.inPortfolio || '';
      this.watchlist = saved.watchlist || '';
      // Only apply filters if table exists
      if (document.getElementById('stocks-table')) {
        this.applyFilters();
      }
      this.updateUI();
    } catch (e) {}
  },

  applyFilters() {
    document.querySelectorAll('#stocks-table tbody tr').forEach(r => {
      const searchMatch = !this.search ||
        (r.dataset.sym || '').toLowerCase().includes(this.search.toLowerCase()) ||
        (r.dataset.name || '').toLowerCase().includes(this.search.toLowerCase());

      const recMatch = !this.recommendation || r.dataset.rec === this.recommendation;
      const gcMatch = this.goldenCross === 'all' || (r.dataset.cross || 'none') === this.goldenCross;
      const eligMatch = !this.eligibility || r.dataset.eligible === this.eligibility;
      const pickMatch = !this.pickFlag || r.dataset.pick === this.pickFlag;
      const portfolioMatch = !this.inPortfolio || r.dataset.inport === this.inPortfolio;
      const watchlistMatch = !this.watchlist || this.watchlistSymbols.has((r.dataset.sym || '').toUpperCase());

      r.style.display = (searchMatch && recMatch && gcMatch && eligMatch && pickMatch && portfolioMatch && watchlistMatch) ? '' : 'none';
    });
  },

  updateUI() {
    const searchEl = document.querySelector('input[placeholder*="Search"]');
    if (searchEl) searchEl.value = this.search;
    const recEl = document.querySelector('select[onchange*="filterRec"]');
    if (recEl) recEl.value = this.recommendation;
    document.querySelectorAll('#gcf-all, #gcf-recent, #gcf-approaching, #gcf-active, #gcf-none').forEach(b => b.classList.remove('filter-btn-active'));
    const gcBtn = document.getElementById('gcf-' + this.goldenCross);
    if (gcBtn) gcBtn.classList.add('filter-btn-active');
    const eligEl = document.getElementById('elig-filter');
    if (eligEl) eligEl.value = this.eligibility;
    const pickEl = document.getElementById('pick-filter');
    if (pickEl) pickEl.value = this.pickFlag;
    const portEl = document.getElementById('port-filter');
    if (portEl) portEl.value = this.inPortfolio;
  }
};

function filterSearch(val){
  FilterState.search = val;
  FilterState.applyAll();
}

function filterRec(val){
  FilterState.recommendation = val;
  FilterState.applyAll();
}

function filterGoldenCross(state){
  FilterState.goldenCross = state;
  FilterState.applyAll();
}

function filterEligibility(val){
  FilterState.eligibility = val;
  FilterState.applyAll();
}

function filterPickFlag(val){
  FilterState.pickFlag = val;
  FilterState.applyAll();
}

function filterPortfolio(val){
  FilterState.inPortfolio = val;
  FilterState.applyAll();
}

function clearAllFilters(){
  FilterState.search = '';
  FilterState.recommendation = '';
  FilterState.goldenCross = 'all';
  FilterState.eligibility = '';
  FilterState.pickFlag = '';
  FilterState.inPortfolio = '';
  FilterState.watchlist = '';
  FilterState.watchlistSymbols.clear();
  FilterState.applyAll();
  FilterState.updateUI();
  document.getElementById('watchlist-filter').value = '';
}

async function filterByWatchlist(groupId) {
  FilterState.watchlist = groupId;
  if (groupId) {
    try {
      const resp = await fetch('/api/watchlist-groups/' + groupId + '/stocks');
      const json = await resp.json();
      FilterState.watchlistSymbols = new Set(json.data || []);
    } catch (e) {
      console.error('Error loading watchlist stocks:', e);
      FilterState.watchlistSymbols.clear();
    }
  } else {
    FilterState.watchlistSymbols.clear();
  }
  FilterState.applyAll();
}

// ── Filter presets (save/load filter combinations) ─────────────────────────────
const FilterPresets = {
  get() {
    try { return JSON.parse(localStorage.getItem('stocks-filter-presets') || '{}'); }
    catch (e) { return {}; }
  },

  save(name, state) {
    const presets = this.get();
    presets[name] = state;
    try { localStorage.setItem('stocks-filter-presets', JSON.stringify(presets)); }
    catch (e) {}
  },

  load(name) {
    const presets = this.get();
    if (presets[name]) {
      FilterState.search = presets[name].search || '';
      FilterState.recommendation = presets[name].recommendation || '';
      FilterState.goldenCross = presets[name].goldenCross || 'all';
      FilterState.eligibility = presets[name].eligibility || '';
      FilterState.pickFlag = presets[name].pickFlag || '';
      FilterState.inPortfolio = presets[name].inPortfolio || '';
      FilterState.applyAll();
      FilterState.updateUI();
    }
  },

  delete(name) {
    const presets = this.get();
    delete presets[name];
    try { localStorage.setItem('stocks-filter-presets', JSON.stringify(presets)); }
    catch (e) {}
    this.updatePresetUI();
  },

  updatePresetUI() {
    const presets = this.get();
    const list = document.getElementById('preset-list');
    if (!list) return;
    list.innerHTML = '';
    Object.keys(presets).forEach((name, idx) => {
      const div = document.createElement('div');
      div.style.cssText = 'display:inline-flex;align-items:center;gap:3px;background:#ebf8ff;color:#2b6cb0;border:1px solid #bee3f8;border-radius:4px;padding:4px 8px;font-size:11px;cursor:pointer';
      div.innerHTML = '<span style="flex:1">' + name + '</span><span style="font-weight:700;color:#c53030;margin-left:3px">×</span>';
      const loadBtn = div.querySelector('span:first-child');
      const delBtn = div.querySelector('span:last-child');
      loadBtn.onclick = () => FilterPresets.load(name);
      delBtn.onclick = (e) => { FilterPresets.delete(name); FilterPresets.updatePresetUI(); e.stopPropagation(); };
      list.appendChild(div);
    });
  }
};

function saveCurrentFilter(){
  const name = prompt('Save this filter as:');
  if (!name) return;
  FilterPresets.save(name, {
    search: FilterState.search,
    recommendation: FilterState.recommendation,
    goldenCross: FilterState.goldenCross,
    eligibility: FilterState.eligibility,
    pickFlag: FilterState.pickFlag,
    inPortfolio: FilterState.inPortfolio,
  });
  FilterPresets.updatePresetUI();
  alert('Filter "' + name + '" saved!');
}

// ── Why modal ─────────────────────────────────────────────────────────────────
function showWhy(sym,why,updatedAt){
  document.getElementById('why-modal-sym').textContent=sym+' — Signal Breakdown';
  // Handle new format with newlines or old format with pipes
  const isNewFormat = why.includes('\\nDecision:');
  let html = '';

  if(isNewFormat) {
    // New format: Signal Score / Layer 4 / Decision sections
    html = '<div style="white-space:pre-wrap;font-family:monospace;font-size:12px;line-height:1.6;color:#2d3748">' +
           why.replace(/</g,'&lt;').replace(/>/g,'&gt;') +
           '</div>';
  } else {
    // Old format: pipe-separated signals
    const parts=why.split(' | ');
    html=parts.map((p,i)=>{
      if(i===0&&p.startsWith('Score:')){
        return '<div style="padding:8px 0 10px;border-bottom:2px solid #e2e8f0;color:#2c5282;font-weight:700;font-size:14px">'+p+'</div>';
      }
      const col=p.startsWith('+')?'#276749':p.startsWith('-')?'#c53030':'#1a202c';
      return '<div style="padding:6px 0;border-bottom:1px solid #edf2f7;color:'+col+'">'+p+'</div>';
    }).join('');
  }

  if(updatedAt) html+='<div style="margin-top:12px;font-size:11px;color:#a0aec0;text-align:right">Last updated: '+updatedAt+' ET</div>';
  document.getElementById('why-modal-body').innerHTML=html;
  document.getElementById('why-modal').style.display='flex';
}
function closeWhy(){document.getElementById('why-modal').style.display='none';}

function showBlock(sym,gateJson){
  document.getElementById('why-modal-sym').textContent=sym+' — Autotrader Eligibility';
  try{
    const gates=JSON.parse(gateJson);
    let html='';
    for(const g of gates){
      const icon=g.pass?'✓':'✗';
      const color=g.pass?'#22543d':'#742a2a';
      const bgColor=g.pass?'#c6f6d5':'#fed7d7';
      const border=g.pass?'#9ae6b4':'#fc8181';
      const detailStr=g.detail||'';
      const msgStr=g.msg?' — '+g.msg:'';
      html+='<div style="padding:9px;border:1px solid '+border+';background:'+bgColor+';border-radius:4px;margin-bottom:6px;color:'+color+'">'
        +'<span style="font-weight:700;font-size:14px">'+icon+'</span> <span style="font-weight:600">'+g.name+'</span> '
        +'<span style="font-weight:700;color:#2d3748">'+detailStr+'</span>'+msgStr
        +'</div>';
    }
    document.getElementById('why-modal-body').innerHTML=html
      +'<div style="margin-top:12px;font-size:11px;color:#a0aec0">Conditions are checked at 9:35 AM using 8:30 AM snapshot data.</div>';
  }catch(e){
    document.getElementById('why-modal-body').innerHTML='<div style="color:#c53030">Error parsing eligibility data</div>';
  }
  document.getElementById('why-modal').style.display='flex';
}

function showSellBlock(sym, gateJson) {
  document.getElementById('why-modal-sym').textContent = sym + ' — Autotrader Sell Evaluation';
  try {
    const gates = JSON.parse(gateJson);
    let html = '';
    for (const g of gates) {
      const icon = g.pass ? '✓' : '✗';
      const color = g.pass ? '#742a2a' : '#22543d';
      const bgColor = g.pass ? '#fed7d7' : '#c6f6d5';
      const border = g.pass ? '#fc8181' : '#9ae6b4';
      html += '<div style="padding:9px;border:1px solid ' + border + ';background:' + bgColor + ';border-radius:4px;margin-bottom:6px;color:' + color + '">'
        + '<span style="font-weight:700;font-size:14px">' + icon + '</span> <span style="font-weight:600">' + g.name + '</span> '
        + '<span style="font-weight:700;color:#2d3748">' + (g.detail || '') + '</span>'
        + '</div>';
    }
    document.getElementById('why-modal-body').innerHTML = html
      + '<div style="margin-top:12px;font-size:11px;color:#a0aec0">Evaluated using latest 8:30 AM snapshot. Sell only executes if AT: ON.</div>';
  } catch (e) {
    document.getElementById('why-modal-body').innerHTML = '<div style="color:#c53030">Error parsing sell data</div>';
  }
  document.getElementById('why-modal').style.display = 'flex';
}

// ── Buy modal ─────────────────────────────────────────────────────────────────
let _buySym='',_buyMktPrice=0;

function openBuy(sym,price,name){
  _buySym=sym;_buyMktPrice=parseFloat(price)||0;
  document.getElementById('buy-title').textContent='Buy '+sym+(name?' — '+name:'');
  const modeEl=document.getElementById('buy-mode');
  modeEl.textContent=window._isPaper?'📄 PAPER TRADE':'💰 LIVE TRADE';
  modeEl.className=window._isPaper?'badge-paper':'badge-live';
  modeEl.style.cssText='font-size:11px;font-weight:700;padding:3px 10px;border-radius:5px;display:inline-block;margin-bottom:12px;'+(window._isPaper?'background:#0d2040;color:#76e4f7;border:1px solid #2c5282':'background:#2d0d0d;color:#fc8181;border:1px solid #9b2c2c');
  document.getElementById('buy-avail').textContent='$'+(window._buyingPower||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
  document.getElementById('buy-qty').value=1;
  document.getElementById('buy-type').value='market';
  document.getElementById('buy-type').disabled=false;
  document.getElementById('buy-limit-price').value=price?parseFloat(price).toFixed(2):'';
  document.getElementById('buy-limit-row').style.display='none';
  document.getElementById('buy-tif').value='day';
  document.getElementById('buy-tif').disabled=false;
  document.getElementById('buy-ext').checked=false;
  const notice=document.getElementById('buy-mkt-notice');
  notice.textContent=window._mktOpen?'🟢 Market open — executes immediately':'🔴 Market closed — queued until next open';
  notice.style.color=window._mktOpen?'#48bb78':'#fc8181';
  updateBuyCost();
  document.getElementById('buy-modal').style.display='flex';
}
function closeBuy(){document.getElementById('buy-modal').style.display='none';}
function onBuyTypeChange(){
  const isLim=document.getElementById('buy-type').value==='limit';
  document.getElementById('buy-limit-row').style.display=isLim?'block':'none';
  updateBuyCost();
}
function onExtChange(){
  const ext=document.getElementById('buy-ext').checked;
  if(ext){
    document.getElementById('buy-type').value='limit';
    document.getElementById('buy-type').disabled=true;
    document.getElementById('buy-limit-row').style.display='block';
    document.getElementById('buy-tif').value='day';
    document.getElementById('buy-tif').disabled=true;
  } else {
    document.getElementById('buy-type').disabled=false;
    document.getElementById('buy-tif').disabled=false;
    onBuyTypeChange();
  }
  updateBuyCost();
}
function updateBuyCost(){
  const qty=parseInt(document.getElementById('buy-qty').value)||0;
  const isLim=document.getElementById('buy-type').value==='limit';
  const lp=parseFloat(document.getElementById('buy-limit-price').value)||0;
  const effPrice=isLim&&lp>0?lp:_buyMktPrice;
  const cost=qty*effPrice;
  const remaining=(window._buyingPower||0)-cost;
  const el=document.getElementById('buy-cost-row');
  if(qty>0&&effPrice>0){
    document.getElementById('buy-cost-val').textContent='$'+cost.toFixed(2);
    const remEl=document.getElementById('buy-remaining-val');
    remEl.textContent='$'+remaining.toFixed(2);
    remEl.style.color=remaining>=0?'#48bb78':'#fc8181';
    el.style.display='flex';
  } else {
    el.style.display='none';
  }
}
async function submitBuy(){
  const qty=parseInt(document.getElementById('buy-qty').value);
  const type=document.getElementById('buy-type').value;
  const lp=parseFloat(document.getElementById('buy-limit-price').value)||null;
  const tif=document.getElementById('buy-tif').value;
  const ext=document.getElementById('buy-ext').checked;
  if(!qty||qty<1){alert('Enter quantity ≥ 1');return;}
  if(type==='limit'&&(!lp||lp<=0)){alert('Enter a valid limit price');return;}
  const body={symbol:_buySym,side:'buy',qty,type,timeInForce:tif,extendedHours:ext};
  if(type==='limit')body.limitPrice=lp;
  const btn=document.getElementById('buy-submit');
  btn.textContent='Placing…';btn.disabled=true;
  try{
    const r=await fetch('/order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const d=await r.json();
    if(d.error){alert('Error: '+d.error);btn.textContent='Place Buy Order';btn.disabled=false;return;}
    closeBuy();window.location.reload();
  }catch(e){alert('Failed: '+e.message);btn.textContent='Place Buy Order';btn.disabled=false;}
}

// ── Sell modal ─────────────────────────────────────────────────────────────────
let _sellSym='',_sellMktPrice=0,_sellMaxQty=0;

function openSell(sym,qty,price,name){
  _sellSym=sym;_sellMktPrice=parseFloat(price)||0;_sellMaxQty=parseInt(qty)||0;
  document.getElementById('sell-title').textContent='Sell '+sym+(name?' — '+name:'');
  const modeEl=document.getElementById('sell-mode');
  modeEl.textContent=window._isPaper?'📄 PAPER TRADE':'💰 LIVE TRADE';
  modeEl.style.cssText='font-size:11px;font-weight:700;padding:3px 10px;border-radius:5px;display:inline-block;margin-bottom:12px;'+(window._isPaper?'background:#0d2040;color:#76e4f7;border:1px solid #2c5282':'background:#2d0d0d;color:#fc8181;border:1px solid #9b2c2c');
  document.getElementById('sell-qty').value=qty;
  document.getElementById('sell-qty').max=qty;
  document.getElementById('sell-holding').textContent='Holding '+qty+' shares @ $'+parseFloat(price).toFixed(2);
  document.getElementById('sell-type').value='market';
  document.getElementById('sell-type').disabled=false;
  document.getElementById('sell-limit-price').value=price?parseFloat(price).toFixed(2):'';
  document.getElementById('sell-limit-row').style.display='none';
  document.getElementById('sell-tif').value='day';
  const notice=document.getElementById('sell-mkt-notice');
  notice.textContent=window._mktOpen?'🟢 Market open — executes immediately':'🔴 Market closed — queued until next open';
  notice.style.color=window._mktOpen?'#48bb78':'#fc8181';
  updateSellProceeds();
  document.getElementById('sell-modal').style.display='flex';
}
function closeSell(){document.getElementById('sell-modal').style.display='none';}
function onSellTypeChange(){
  const isLim=document.getElementById('sell-type').value==='limit';
  document.getElementById('sell-limit-row').style.display=isLim?'block':'none';
  updateSellProceeds();
}
function updateSellProceeds(){
  const qty=parseInt(document.getElementById('sell-qty').value)||0;
  const isLim=document.getElementById('sell-type').value==='limit';
  const lp=parseFloat(document.getElementById('sell-limit-price').value)||0;
  const effPrice=isLim&&lp>0?lp:_sellMktPrice;
  const proceeds=qty*effPrice;
  const el=document.getElementById('sell-proceeds-row');
  if(qty>0&&effPrice>0){
    document.getElementById('sell-proceeds-val').textContent='$'+proceeds.toFixed(2);
    el.style.display='flex';
  } else {
    el.style.display='none';
  }
}
async function submitSell(){
  const qty=parseInt(document.getElementById('sell-qty').value);
  const type=document.getElementById('sell-type').value;
  const lp=parseFloat(document.getElementById('sell-limit-price').value)||null;
  const tif=document.getElementById('sell-tif').value;
  if(!qty||qty<1){alert('Enter quantity ≥ 1');return;}
  if(qty>_sellMaxQty){alert('Cannot sell more than you hold ('+_sellMaxQty+')');return;}
  if(type==='limit'&&(!lp||lp<=0)){alert('Enter a valid limit price');return;}
  const body={symbol:_sellSym,side:'sell',qty,type,timeInForce:tif};
  if(type==='limit')body.limitPrice=lp;
  const btn=document.getElementById('sell-submit');
  btn.textContent='Placing…';btn.disabled=true;
  try{
    const r=await fetch('/order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const d=await r.json();
    if(d.error){alert('Error: '+d.error);btn.textContent='Place Sell Order';btn.disabled=false;return;}
    closeSell();window.location.reload();
  }catch(e){alert('Failed: '+e.message);btn.textContent='Place Sell Order';btn.disabled=false;}
}

// ── Performance chart ─────────────────────────────────────────────────────────
let _chartSym='',_chartPeriod='1y',_chartBenches=new Set(['SPY']),_perfChart=null;
const _chartColors={stock:'#f6ad55',SPY:'#63b3ed',QQQ:'#b794f4',DIA:'#68d391'};

function openChart(sym,name){
  _chartSym=sym;
  document.getElementById('chart-modal-title').textContent=sym+(name?' — '+name:'')+' · Performance';
  document.getElementById('chart-modal').style.display='flex';
  _syncChartBtns();
  loadChart();
}
function closeChart(){
  document.getElementById('chart-modal').style.display='none';
  if(_perfChart){_perfChart.destroy();_perfChart=null;}
}
function setChartPeriod(p){
  _chartPeriod=p;
  _syncChartBtns();
  loadChart();
}
function toggleBench(b){
  if(_chartBenches.has(b))_chartBenches.delete(b);
  else _chartBenches.add(b);
  _syncChartBtns();
  loadChart();
}
function _syncChartBtns(){
  document.querySelectorAll('.chart-period-btn').forEach(b=>b.classList.toggle('active',b.dataset.p===_chartPeriod));
  document.querySelectorAll('.chart-bench-btn').forEach(b=>b.classList.toggle('active',_chartBenches.has(b.dataset.b)));
}
async function loadChart(){
  const benches=[..._chartBenches].join(',');
  const url='/position-chart/'+_chartSym+'?period='+_chartPeriod+(benches?'&benchmarks='+benches:'');
  const loading=document.getElementById('chart-loading');
  const canvas=document.getElementById('perf-chart');
  loading.textContent='Loading…';loading.style.display='block';canvas.style.display='none';
  if(_perfChart){_perfChart.destroy();_perfChart=null;}
  try{
    const data=await fetch(url).then(r=>r.json());
    if(data.error)throw new Error(data.error);
    _renderChart(data);
  }catch(e){
    loading.textContent='Could not load chart data: '+e.message;
  }
}
function _renderChart(data){
  const loading=document.getElementById('chart-loading');
  const canvas=document.getElementById('perf-chart');
  const stockBars=data[_chartSym]||[];
  if(!stockBars.length){loading.textContent='No data available for this period';return;}
  loading.style.display='none';canvas.style.display='block';
  const labels=stockBars.map(b=>b.date);
  function normalize(bars){
    if(!bars||!bars.length)return [];
    const pm=new Map(bars.map(b=>[b.date,b.close]));
    const prices=labels.map(d=>pm.get(d)||null);
    const base=prices.find(p=>p!=null);
    if(!base)return [];
    return prices.map(p=>p!=null?Math.round(p/base*10000)/100:null);
  }
  const datasets=[{
    label:_chartSym,data:normalize(stockBars),
    borderColor:_chartColors.stock,backgroundColor:'transparent',
    borderWidth:2.5,pointRadius:0,tension:0.1,spanGaps:true,
  }];

  // 50d and 200d MAs — normalized using same base as price so crossovers are visible
  const base=stockBars.find(b=>b.close!=null)?.close||1;
  const ma50data=stockBars.map(b=>b.ma50!=null?Math.round(b.ma50/base*10000)/100:null);
  const ma200data=stockBars.map(b=>b.ma200!=null?Math.round(b.ma200/base*10000)/100:null);
  if(ma50data.some(v=>v!=null))datasets.push({
    label:'50d MA',data:ma50data,
    borderColor:'#f6e05e',backgroundColor:'transparent',
    borderWidth:1.5,borderDash:[4,3],pointRadius:0,tension:0.1,spanGaps:true,
  });
  if(ma200data.some(v=>v!=null))datasets.push({
    label:'200d MA',data:ma200data,
    borderColor:'#fc8181',backgroundColor:'transparent',
    borderWidth:1.5,borderDash:[6,4],pointRadius:0,tension:0.1,spanGaps:true,
  });

  const benchLabels={SPY:'S&P 500',QQQ:'Nasdaq 100',DIA:'Dow Jones'};
  for(const b of _chartBenches){
    if(data[b]&&data[b].length)datasets.push({
      label:benchLabels[b]||b,data:normalize(data[b]),
      borderColor:_chartColors[b]||'#a0aec0',backgroundColor:'transparent',
      borderWidth:1.5,borderDash:[5,3],pointRadius:0,tension:0.1,spanGaps:true,
    });
  }
  _perfChart=new Chart(canvas,{
    type:'line',data:{labels,datasets},
    options:{
      responsive:true,maintainAspectRatio:false,animation:false,
      interaction:{mode:'index',intersect:false},
      plugins:{
        legend:{labels:{color:'#4a5568',font:{size:11},boxWidth:20}},
        tooltip:{
          backgroundColor:'#ffffff',titleColor:'#2c5282',bodyColor:'#1a202c',borderColor:'#e2e8f0',borderWidth:1,
          callbacks:{
            title:items=>items[0]?.label||'',
            label:ctx=>' '+ctx.dataset.label+': '+
              (ctx.parsed.y!=null?(ctx.parsed.y-100>=0?'+':'')+(ctx.parsed.y-100).toFixed(1)+'%':'—'),
          }
        }
      },
      scales:{
        x:{ticks:{color:'#718096',maxTicksLimit:7,font:{size:10},maxRotation:0},grid:{color:'#edf2f7'}},
        y:{ticks:{color:'#718096',font:{size:10},callback:v=>(v>=100?'+':'')+(v-100).toFixed(0)+'%'},grid:{color:'#edf2f7'}},
      }
    }
  });
}

// ── Tab navigation ────────────────────────────────────────────────────────────
function switchTab(name){
  document.querySelectorAll('.tab-content').forEach(el=>el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el=>el.classList.remove('active'));
  const content=document.getElementById('tab-'+name);
  const btn=document.querySelector('.tab-btn[data-tab="'+name+'"]');
  if(content)content.classList.add('active');
  if(btn)btn.classList.add('active');
  try{localStorage.setItem('active-tab',name);}catch(_){}
}
document.addEventListener('DOMContentLoaded', function restoreTab(){
  try{
    const saved=localStorage.getItem('active-tab')||'portfolio';
    switchTab(saved);
  }catch(_){switchTab('portfolio');}
});

// ── Pick toggle button handler ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function attachPickToggle(){
  document.querySelectorAll('.pick-toggle-btn').forEach(btn => {
    btn.addEventListener('click', function(e){
      e.preventDefault();
      e.stopPropagation();
      const url = this.getAttribute('data-pick-url');
      if(url) window.location = url;
    });
  });
});

// ── Bulk pick toggle ────────────────────────────────────────────────────────────
async function bulkTogglePick() {
  const checked = document.querySelectorAll('.pick-select-cb:checked');
  const symbols = Array.from(checked).map(cb => cb.dataset.sym);
  if (!symbols.length) return;
  const r = await fetch('/watchlist/toggle-pick-bulk', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ symbols })
  });
  if (r.ok) window.location.reload();
  else alert('Bulk toggle failed');
}

function updatePickSelCount() {
  const n = document.querySelectorAll('.pick-select-cb:checked').length;
  const btn = document.getElementById('bulk-pick-btn');
  const cnt = document.getElementById('pick-sel-count');
  if (btn) btn.style.display = n > 0 ? '' : 'none';
  if (cnt) cnt.textContent = n;
}

document.addEventListener('DOMContentLoaded', function setupBulkPick(){
  document.addEventListener('change', function(e){
    if (e.target.classList.contains('pick-select-cb')) updatePickSelCount();
  });
  const selectAll = document.getElementById('pick-select-all');
  if (selectAll) {
    selectAll.addEventListener('change', function(){
      const visible = Array.from(document.querySelectorAll('#stocks-table tbody tr'))
        .filter(r => r.style.display !== 'none');
      visible.forEach(row => {
        const cb = row.querySelector('.pick-select-cb');
        if (cb) cb.checked = selectAll.checked;
      });
      updatePickSelCount();
    });
  }
});

// ── Restore filters from localStorage ──────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function restoreFilters(){
  try{
    FilterState.loadFromLocalStorage();
    FilterPresets.updatePresetUI();
    // Load watchlist dropdown and restore selected watchlist
    loadWatchlistDropdown().then(() => {
      const sel = document.getElementById('watchlist-filter');
      if (FilterState.watchlist && sel) {
        sel.value = FilterState.watchlist;
        filterByWatchlist(FilterState.watchlist);
      }
    }).catch(() => {});
  }catch(_){}
});

document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){closeWhy();closeBuy();closeSell();closeChart();closeNews();}
});

// ── News modal ────────────────────────────────────────────────────────────────
let _newsSym='';
function openNews(sym,name){
  _newsSym=sym;
  document.getElementById('news-modal-title').textContent='📰 '+sym+(name?' — '+name:'')+' · Latest News';
  document.getElementById('news-modal').style.display='flex';
  document.querySelectorAll('.news-tab-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab==='finnhub'));
  loadNews('finnhub');
}
function closeNews(){document.getElementById('news-modal').style.display='none';}
function setNewsTab(tab){
  document.querySelectorAll('.news-tab-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  loadNews(tab);
}
async function loadNews(tab){
  const body=document.getElementById('news-modal-body');
  body.innerHTML='<div style="color:#718096;padding:24px 0;text-align:center">Loading…</div>';
  try{
    const data=await fetch('/news/'+_newsSym+'?source='+tab).then(r=>r.json());
    if(data.error||!data.articles||!data.articles.length){
      body.innerHTML='<div style="color:#718096;padding:24px 0;text-align:center">No recent news found.</div>';
      return;
    }
    body.innerHTML=data.articles.map(a=>{
      const dt=a.publishedAt?new Date(a.publishedAt).toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'';
      return '<div style="padding:10px 0;border-bottom:1px solid #edf2f7">'+
        '<a href="'+a.url+'" target="_blank" rel="noopener" style="color:#2b6cb0;font-weight:600;font-size:13px;line-height:1.4;display:block;margin-bottom:3px">'+a.headline+'</a>'+
        '<span style="font-size:11px;color:#718096">'+(a.source||'')+(dt?' · '+dt+' ET':'')+'</span></div>';
    }).join('');
  }catch(e){
    body.innerHTML='<div style="color:#c53030;padding:12px 0">Failed to load: '+e.message+'</div>';
  }
}

function openTVChart(sym) {
  window.open(
    'https://finance.yahoo.com/chart/' + encodeURIComponent(sym),
    'yfchart_' + sym,
    'width=1200,height=750,toolbar=0,menubar=0,scrollbars=0,resizable=1'
  );
}
function closeTVChart() {}

// ── Watchlist Modal Functions ──────────────────────────────────────────────────
function openWatchlistModal() {
  document.getElementById('watchlist-modal').style.display = 'flex';
  loadWatchlistDropdown();
  loadGroups();
  loadAllStocks();
}

function closeWatchlistModal() {
  document.getElementById('watchlist-modal').style.display = 'none';
}

async function loadWatchlistDropdown() {
  const sel = document.getElementById('watchlist-filter');
  sel.innerHTML = '<option value="">Watchlist: All Stocks</option>';
  try {
    const resp = await fetch('/api/watchlist-groups');
    const json = await resp.json();
    if (json.success) {
      json.data.forEach(g => {
        const opt = document.createElement('option');
        opt.value = g.id;
        opt.textContent = g.name + ' (' + g.stock_count + ')';
        sel.appendChild(opt);
      });
    }
  } catch (e) {
    console.error('Error loading watchlist dropdown:', e);
  }
}

async function loadGroups() {
  const list = document.getElementById('watchlist-groups-list');
  list.innerHTML = '<div style="padding:8px;color:#718096;font-size:12px">All Stocks</div>';
  try {
    const resp = await fetch('/api/watchlist-groups');
    const json = await resp.json();
    if (json.success) {
      json.data.forEach(g => {
        const el = document.createElement('div');
        el.style.cssText = 'padding:8px;cursor:pointer;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;';
        el.onmouseover = () => el.style.background = '#f9fafb';
        el.onmouseout = () => el.style.background = '';
        const span = document.createElement('span');
        span.textContent = g.name;
        span.style.cssText = 'flex:1;font-size:12px;cursor:pointer';
        span.onclick = (e) => { e.stopPropagation(); selectGroup(g.id, g.name, el); };
        el.appendChild(span);

        const btnRename = document.createElement('button');
        btnRename.textContent = '✏';
        btnRename.style.cssText = 'background:none;border:none;color:#4299e1;cursor:pointer;font-size:12px;padding:0 4px';
        btnRename.onclick = (e) => { e.stopPropagation(); renameGroup(g.id); };
        el.appendChild(btnRename);

        const btnDelete = document.createElement('button');
        btnDelete.textContent = '🗑';
        btnDelete.style.cssText = 'background:none;border:none;color:#f56565;cursor:pointer;font-size:12px;padding:0 4px';
        btnDelete.onclick = (e) => { e.stopPropagation(); deleteGroup(g.id); };
        el.appendChild(btnDelete);

        el.onclick = () => selectGroup(g.id, g.name, el);
        list.appendChild(el);
      });
    }
  } catch (e) {
    console.error('Error loading groups:', e);
  }
}

let currentSelectedGroupId = null;
let currentSelectedGroupName = null;

async function selectGroup(id, name, el) {
  currentSelectedGroupId = id;
  currentSelectedGroupName = name;
  document.getElementById('add-stocks-btn').textContent = 'Add Selected to ' + name;
  await loadGroupStocks(id);
  // Highlight selected group
  document.querySelectorAll('#watchlist-groups-list > div').forEach(div => div.style.background = '');
  if (el) el.style.background = '#edf2f7';
}

async function loadGroupStocks(id) {
  try {
    const resp = await fetch('/api/watchlist-groups/' + id + '/stocks');
    const json = await resp.json();
    const groupSymbols = new Set(json.data || []);
    // Update checkboxes
    document.querySelectorAll('#stocks-list input[type="checkbox"]').forEach(cb => {
      cb.checked = groupSymbols.has(cb.value.toUpperCase());
    });
    document.getElementById('select-all-checkbox').checked = false;
  } catch (e) {
    console.error('Error loading group stocks:', e);
  }
}

async function loadAllStocks() {
  const list = document.getElementById('stocks-list');
  list.innerHTML = '<div style="padding:8px;color:#718096;font-size:12px">Loading stocks...</div>';
  try {
    const resp = await fetch('/api/stocks');
    const json = await resp.json();
    if (json.data) {
      list.innerHTML = '';
      json.data.forEach(stock => {
        const div = document.createElement('div');
        div.style.cssText = 'padding:4px;margin:2px 0;display:flex;align-items:center;gap:6px';
        div.innerHTML = '<input type="checkbox" value="' + stock.symbol + '" />' +
          '<span style="font-size:12px;flex:1">' + stock.symbol + '</span>' +
          '<span style="font-size:11px;color:#718096">' + (stock.name || '') + '</span>';
        list.appendChild(div);
      });
    }
  } catch (e) {
    console.error('Error loading stocks:', e);
  }
}

function searchStocks(query) {
  const q = query.toLowerCase();
  document.querySelectorAll('#stocks-list > div').forEach(el => {
    const text = el.textContent.toLowerCase();
    el.style.display = text.includes(q) ? '' : 'none';
  });
}

function toggleSelectAll() {
  const all = document.getElementById('select-all-checkbox').checked;
  document.querySelectorAll('#stocks-list input[type="checkbox"]').forEach(cb => {
    if (cb.closest('div').style.display !== 'none') {
      cb.checked = all;
    }
  });
}

async function addSelectedToGroup() {
  if (!currentSelectedGroupId) {
    alert('Please select a watchlist first');
    return;
  }
  const selected = Array.from(document.querySelectorAll('#stocks-list input[type="checkbox"]:checked'))
    .map(cb => cb.value);
  if (selected.length === 0) {
    alert('Please select at least one stock');
    return;
  }
  try {
    const resp = await fetch('/api/watchlist-groups/' + currentSelectedGroupId + '/stocks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols: selected })
    });
    const json = await resp.json();
    if (json.success) {
      alert('Added ' + selected.length + ' stock(s) to ' + currentSelectedGroupName);
      loadWatchlistDropdown();
      loadGroups();
      loadGroupStocks(currentSelectedGroupId);
    } else {
      alert('Error: ' + json.error);
    }
  } catch (e) {
    console.error('Error adding stocks:', e);
    alert('Error adding stocks');
  }
}

async function createGroup() {
  const name = document.getElementById('new-group-name').value.trim();
  if (!name) {
    alert('Enter a watchlist name');
    return;
  }
  try {
    const resp = await fetch('/api/watchlist-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const json = await resp.json();
    if (json.success) {
      document.getElementById('new-group-name').value = '';
      loadGroups();
      loadWatchlistDropdown();
      alert('Watchlist created');
    } else {
      alert('Error: ' + json.error);
    }
  } catch (e) {
    console.error('Error creating group:', e);
    alert('Error creating watchlist');
  }
}

async function renameGroup(id) {
  const current = Array.from(document.querySelectorAll('#watchlist-groups-list > div'))
    .find(el => el.innerHTML.includes('renameGroup(' + id + ')'));
  if (!current) return;
  const newName = prompt('New name:', current.textContent.split('✏')[0].trim());
  if (!newName) return;
  try {
    const resp = await fetch('/api/watchlist-groups/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName })
    });
    const json = await resp.json();
    if (json.success) {
      loadGroups();
      loadWatchlistDropdown();
      if (currentSelectedGroupId === id) {
        currentSelectedGroupName = newName;
        document.getElementById('add-stocks-btn').textContent = 'Add Selected to ' + newName;
      }
    } else {
      alert('Error: ' + json.error);
    }
  } catch (e) {
    console.error('Error renaming group:', e);
    alert('Error renaming watchlist');
  }
}

async function deleteGroup(id) {
  if (!confirm('Delete this watchlist and all its stocks?')) return;
  try {
    const resp = await fetch('/api/watchlist-groups/' + id, { method: 'DELETE' });
    const json = await resp.json();
    if (json.success) {
      loadGroups();
      loadWatchlistDropdown();
      if (currentSelectedGroupId === id) {
        currentSelectedGroupId = null;
        currentSelectedGroupName = null;
      }
    } else {
      alert('Error: ' + json.error);
    }
  } catch (e) {
    console.error('Error deleting group:', e);
    alert('Error deleting watchlist');
  }
}

// ── Transactions ───────────────────────────────────────────────────────────────
let allTransactions = [];

async function loadTransactions() {
  try {
    const resp = await fetch('/api/transactions');
    const json = await resp.json();
    if (json.success) {
      allTransactions = json.data || [];
      renderTransactions(allTransactions);
    }
  } catch (e) {
    console.error('Error loading transactions:', e);
  }
}

function renderTransactions(txns) {
  const tbody = document.getElementById('txn-body');
  if (!txns.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:16px;color:#718096">No transactions found</td></tr>';
    return;
  }

  tbody.innerHTML = txns.map(t => {
    const date = t.timestamp ? new Date(t.timestamp).toLocaleString('en-US', {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'}) : '—';
    const actionColor = t.action === 'buy' ? '#48bb78' : '#fc8181';
    const actionLabel = t.action.toUpperCase();
    const sourceLabel = t.source === 'autotrader' ? '⚡ Autotrader' : '👤 Manual';
    const sourceBg = t.source === 'autotrader' ? 'rgba(49, 130, 206, 0.1)' : 'rgba(160, 174, 192, 0.1)';
    const pnl = t.pnl || t.pnl_pct ? \`<span style="color:\${t.pnl >= 0 ? '#48bb78' : '#fc8181'}">\${t.pnl ? '$' + t.pnl.toFixed(2) : ''} \${t.pnl_pct ? t.pnl_pct.toFixed(1) + '%' : ''}</span>\` : '—';
    const totalAmt = t.total_amount ? '$' + parseFloat(t.total_amount).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2}) : '—';

    return \`<tr>
      <td>\${date}</td>
      <td><strong>\${t.symbol}</strong></td>
      <td><span style="color:\${actionColor};font-weight:600">\${actionLabel}</span></td>
      <td>\${t.shares}</td>
      <td>\${t.price ? '$' + parseFloat(t.price).toFixed(2) : '—'}</td>
      <td>\${totalAmt}</td>
      <td><span style="background:\${sourceBg};padding:2px 6px;border-radius:3px;font-size:11px">\${sourceLabel}</span></td>
      <td style="max-width:220px;font-size:11px;color:#718096">\${t.reason || '—'}</td>
      <td>\${pnl}</td>
    </tr>\`;
  }).join('');
}

function filterTransactions() {
  const search = document.getElementById('txn-search').value.toUpperCase();
  const source = document.getElementById('txn-source').value;
  const action = document.getElementById('txn-action').value;

  const filtered = allTransactions.filter(t => {
    const matchSearch = !search || t.symbol.includes(search);
    const matchSource = !source || t.source === source;
    const matchAction = !action || t.action === action;
    return matchSearch && matchSource && matchAction;
  });

  renderTransactions(filtered);
}

document.addEventListener('DOMContentLoaded', function initTransactions(){
  try { loadTransactions(); } catch(_){}
});

// ── Real-time price refresh (every 5 min during market hours) ────────────────
</script>`;

// ─── My Portfolio section ─────────────────────────────────────────────────────
function upgradeCell(u) {
  if (!u) return '—';
  const icon  = u.action === 'up'   ? '↑' : u.action === 'down' ? '↓'
              : u.action === 'init' ? '★' : '→';
  const color = u.action === 'up'   ? '#276749' : u.action === 'down' ? '#c53030' : '#718096';
  const grade = u.to_grade || '—';
  const daysAgo = Math.round((Date.now() - new Date(u.grade_date).getTime()) / 86400000);
  const agoTxt  = daysAgo === 0 ? 'today' : daysAgo === 1 ? '1d ago' : `${daysAgo}d ago`;
  const firmTxt = u.firm ? u.firm.replace(/,.*/, '') : '—';
  return `<span style="font-size:12px;color:${color};font-weight:600">${icon} ${grade}</span><br><span style="font-size:10px;color:#718096">${firmTxt} · ${agoTxt}</span>`;
}

function perfCell(p) {
  const f = v => v != null
    ? `<span style="color:${v>=0?'#276749':'#c53030'};font-weight:600">${v>=0?'+':''}${v.toFixed(1)}%</span>`
    : '<span style="color:#a0aec0">—</span>';
  return `<table class="perf-tbl">
    <tr><td style="color:#ffffff;font-weight:600">1W</td><td>${f(p?.w1)}</td><td style="color:#ffffff;font-weight:600;padding-left:6px">1M</td><td>${f(p?.m1)}</td></tr>
    <tr><td style="color:#ffffff;font-weight:600">3M</td><td>${f(p?.m3)}</td><td style="color:#ffffff;font-weight:600;padding-left:6px">6M</td><td>${f(p?.m6)}</td></tr>
    <tr><td style="color:#ffffff;font-weight:600">1Y</td><td>${f(p?.y1)}</td><td style="color:#ffffff;font-weight:600;padding-left:6px">YTD</td><td>${f(p?.ytd)}</td></tr>
  </table>`;
}

function starCell(crossType, crossAgo) {
  const recentWindow = settingsCache.getGoldenCross()?.pulsing_glow_days ?? 5;
  if (crossType === 'golden_cross') {
    const ago = crossAgo != null ? parseInt(crossAgo) : null;
    if (ago !== null && ago <= recentWindow)
      return `<td style="text-align:center"><span class="star-recent" title="Golden cross ${ago}d ago — 50DMA just crossed above 200DMA">⭐</span></td>`;
    return `<td style="text-align:center"><span class="star-active" title="Active golden cross — 50DMA above 200DMA">★</span></td>`;
  }
  return `<td style="text-align:center"><span class="star-none" title="No golden cross">☆</span></td>`;
}

function portfolioSection(positions, openOrders, account, signalMap, upgradeMap = new Map(), perfMap = new Map(), portfolioReturns = {}, flagMap = new Map(), allSettings = {}, peakPriceMap = new Map(), spySig = null) {
  const totalValue    = positions.reduce((s, p) => s + parseFloat(p.market_value  || 0), 0);
  const totalPnl      = positions.reduce((s, p) => s + parseFloat(p.unrealized_pl || 0), 0);
  const totalCost     = positions.reduce((s, p) => s + parseFloat(p.cost_basis    || 0), 0);
  const totalTodayPnl = positions.reduce((s, p) => s + parseFloat(p.unrealized_intraday_pl || 0), 0);
  const pnlColor      = totalPnl >= 0 ? '#48bb78' : '#fc8181';
  const totalPnlPct   = totalCost > 0 ? (totalPnl / totalCost) * 100 : null;
  const totalTodayPct = (totalValue - totalTodayPnl) > 0 ? (totalTodayPnl / (totalValue - totalTodayPnl)) * 100 : null;
  const todayColor    = totalTodayPnl >= 0 ? '#48bb78' : '#fc8181';
  const cashTxt    = account ? `$${parseFloat(account.cash||0).toLocaleString(undefined,{maximumFractionDigits:0})} cash` : '—';
  const equityTxt  = account ? `$${parseFloat(account.equity||account.portfolio_value||0).toLocaleString(undefined,{maximumFractionDigits:0})} equity` : '—';

  const pr = portfolioReturns;
  const prFmt = v => v != null
    ? `<span style="color:${v>=0?'#48bb78':'#fc8181'};font-weight:700">${v>=0?'+':''}${v.toFixed(2)}%</span>`
    : '<span style="color:#4a5568">—</span>';

  // ─── Sell flag evaluator — mirrors autotrader.js evaluateExit() logic ───────────
  function buildSellStatus(p, sig, peakPrice, sellSettings, spySig) {
    const currentPrice = parseFloat(p.current_price);
    const avgEntry     = parseFloat(p.avg_entry_price);
    const pnlPct       = ((currentPrice - avgEntry) / avgEntry) * 100;
    const peak         = peakPrice != null ? peakPrice : avgEntry;

    const hardStopPct           = sellSettings.hard_stop_pct               ?? -8;
    const trailingActivationPct = sellSettings.trailing_stop_activation_pct ?? 5;
    const trailingStopPct       = sellSettings.trailing_stop_pct            ?? 5;
    const extendedPricePct      = sellSettings.extended_price_pct           ?? 10;

    const conditions = [];
    let decision = 'HOLD', triggerLayer = null;

    // Layer 1: Hard Stop
    const l1 = pnlPct <= hardStopPct;
    conditions.push({ name: `L1 Hard Stop (P&L ≤ ${hardStopPct}%)`, pass: l1, detail: `${pnlPct.toFixed(1)}%` });
    if (l1 && !triggerLayer) { decision = 'SELL'; triggerLayer = 1; }

    // Layer 2: Trailing Stop
    const l2act = pnlPct >= trailingActivationPct;
    const l2trig = l2act && currentPrice <= peak * (1 - trailingStopPct / 100);
    conditions.push({ name: `L2 Trailing Activated (gain ≥ ${trailingActivationPct}%)`, pass: l2act, detail: `${pnlPct.toFixed(1)}%` });
    conditions.push({ name: `L2 Trailing Trigger (price ≤ peak × ${100 - trailingStopPct}%)`, pass: l2trig, detail: `$${currentPrice.toFixed(2)} vs peak $${peak.toFixed(2)}` });
    if (l2trig && !triggerLayer) { decision = 'SELL'; triggerLayer = 2; }

    // Layer 3: RSI Overbought + Extended Price
    const rsi      = sig?.rsi != null ? parseFloat(sig.rsi) : null;
    const ma50     = sig?.ma50 != null ? parseFloat(sig.ma50) : null;
    const rsiHigh  = rsi !== null && rsi >= 75;
    const pct50    = (ma50 && ma50 > 0) ? ((currentPrice / ma50) - 1) * 100 : null;
    const extended = pct50 !== null && pct50 >= extendedPricePct;
    conditions.push({ name: `L3 RSI Overbought (≥ 75)`, pass: rsiHigh, detail: rsi !== null ? rsi.toFixed(1) : '?' });
    conditions.push({ name: `L3 Extended (≥ ${extendedPricePct}% above 50DMA)`, pass: extended, detail: pct50 !== null ? pct50.toFixed(1) + '%' : '?' });
    if (rsiHigh && extended && !triggerLayer) { decision = 'SELL'; triggerLayer = 3; }

    // Layer 4: pre_sell_score
    const ma200  = sig?.ma200 != null ? parseFloat(sig.ma200) : null;
    const price  = sig?.price != null ? parseFloat(sig.price) : currentPrice;
    const c4a = ma50 !== null && price < ma50;
    const c4b = ma50 !== null && ma200 !== null && ma50 < ma200;
    const c4c = sig?.macd_trend === 'bearish';
    const bearAgo = sig?.ema9_bear_cross_ago != null ? parseInt(sig.ema9_bear_cross_ago) : null;
    const bullAgo = sig?.ema9_bull_cross_ago != null ? parseInt(sig.ema9_bull_cross_ago) : null;
    const c4d = bearAgo !== null && (bullAgo === null || bearAgo < bullAgo);
    const spyPrice = spySig?.price != null ? parseFloat(spySig.price) : null;
    const spyMa50  = spySig?.ma50  != null ? parseFloat(spySig.ma50)  : null;
    const c4e = spyPrice !== null && spyMa50 !== null && spyPrice < spyMa50;
    const score = [c4a, c4b, c4c, c4d, c4e].filter(Boolean).length;

    conditions.push({ name: 'L4 Price < 50DMA', pass: c4a, detail: ma50 ? `$${price.toFixed(2)} vs $${ma50.toFixed(2)}` : '?' });
    conditions.push({ name: 'L4 50DMA < 200DMA', pass: c4b, detail: (ma50 && ma200) ? `$${ma50.toFixed(2)} vs $${ma200.toFixed(2)}` : '?' });
    conditions.push({ name: 'L4 MACD Bearish', pass: c4c, detail: sig?.macd_trend || '?' });
    conditions.push({ name: 'L4 EMA9 < EMA21', pass: c4d, detail: bearAgo !== null ? `bear ${bearAgo}d ago${bullAgo !== null ? `, bull ${bullAgo}d ago` : ''}` : 'no bear cross' });
    conditions.push({ name: 'L4 SPY < SPY 50DMA', pass: c4e, detail: (spyPrice && spyMa50) ? `$${spyPrice.toFixed(2)} vs $${spyMa50.toFixed(2)}` : '?' });
    conditions.push({ name: `L4 Pre-Sell Score ≥ 3`, pass: score >= 3, detail: `${score}/5` });
    if (score >= 3 && !triggerLayer) { decision = 'SELL'; triggerLayer = 4; }

    return { decision, triggerLayer, conditions };
  }

  const posRows = positions.length ? positions.map(p => {
    const pnl    = parseFloat(p.unrealized_pl  || 0);
    const pnlPct = parseFloat(p.unrealized_plpc || 0) * 100;
    const pc     = pnl >= 0 ? '#48bb78' : '#fc8181';
    const sign   = pnl >= 0 ? '+' : '';
    const qty      = parseInt(p.qty);
    const price    = parseFloat(p.current_price || 0);
    const posChgPct = p.unrealized_intraday_plpc != null ? parseFloat(p.unrealized_intraday_plpc) * 100 : null;
    const posChgColor = posChgPct !== null ? (posChgPct >= 0 ? '#48bb78' : '#fc8181') : '#2d3748';
    const nameSafe = ((signalMap.get(p.symbol)?.name) || p.symbol).replace(/'/g, "\\'");

    const sig = signalMap.get(p.symbol);
    const sigChg = sig?.price_change_pct != null ? parseFloat(sig.price_change_pct) : null;
    const sigPriceColor = sigChg !== null ? (sigChg >= 0 ? '#48bb78' : '#fc8181') : '#718096';
    const sigPrice = sig?.price ? `<br><span style="font-weight:600;color:${sigPriceColor};font-size:11px">$${parseFloat(sig.price).toFixed(2)}</span>` : '';
    const recBadge = sig
      ? (sig.recommendation === 'BUY'  ? `<span class="badge badge-buy">▲ BUY</span>${sigPrice}`
       : sig.recommendation === 'SELL' ? `<span class="badge badge-sell">▼ SELL</span>${sigPrice}`
       :                                 `<span class="badge badge-hold">● HOLD</span>${sigPrice}`)
      : '<span style="color:#718096;font-size:10px">—</span>';

    const whySafe = sig?.why ? sig.why.replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/\n/g,'\\n') : '';
    const posUpdatedAt = sig?.generated_at ? new Date(sig.generated_at).toLocaleString('en-US',{timeZone:'America/New_York',hour12:true,month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : '';
    const posWhyBtn = whySafe ? `<button onclick="showWhy('${p.symbol}','${whySafe}','${posUpdatedAt}')" class="btn btn-xs" style="background:#ebf8ff;color:#2b6cb0;border:1px solid #bee3f8">Why?</button>` : '—';
    const posSector = sig?.sector ? `<span style="font-size:11px;color:#718096">${sig.sector}</span>` : '—';

    const tgtMean = sig?.target_mean ? parseFloat(sig.target_mean) : null;
    const tgtHigh = sig?.target_high ? parseFloat(sig.target_high) : null;
    const tgtLow  = sig?.target_low  ? parseFloat(sig.target_low)  : null;
    let posTargetCell = '—';
    if (tgtMean && price > 0) {
      const upside = ((tgtMean - price) / price) * 100;
      const uColor = upside >= 0 ? '#276749' : '#c53030';
      const uSign  = upside >= 0 ? '+' : '';
      posTargetCell = `<span style="font-weight:600;color:${uColor}">$${tgtMean.toFixed(0)}</span>
        <span style="font-size:10px;color:${uColor}"> ${uSign}${upside.toFixed(0)}%</span>`;
      if (tgtHigh && tgtLow)
        posTargetCell += `<br><span style="font-size:10px;color:#718096">$${tgtLow.toFixed(0)}–$${tgtHigh.toFixed(0)}</span>`;
    }
    const posUpgradeCell = upgradeCell(upgradeMap.get(p.symbol));
    const posPerf = perfMap.get(p.symbol);
    const posPerfCell = perfCell(posPerf);
    const chartBtn = `<button onclick="openChart('${p.symbol}','${nameSafe}')" class="btn btn-xs" style="background:#faf5ff;color:#6b46c1;border:1px solid #d6bcfa;display:block;margin-top:4px;width:100%">📈 Chart</button>`;

    const tradeBtn = `<button onclick="openBuy('${p.symbol}','${price}','${nameSafe}')" class="btn btn-success btn-xs">+ Buy</button>
      <button onclick="openSell('${p.symbol}','${qty}','${price}','${nameSafe}')" class="btn btn-warn btn-xs" style="margin-left:4px">Sell</button>`;

    const atOn = flagMap.get(p.symbol) ?? false;
    const atBtn = atOn
      ? `<a href="/position/${p.symbol}/toggle-autotrader" class="btn btn-xs" style="background:#1a365d;color:#bee3f8;border:1px solid #3182ce;white-space:nowrap" title="Autotrader managing this position — click to disable">⚡ AT: ON</a>`
      : `<a href="/position/${p.symbol}/toggle-autotrader" class="btn btn-xs" style="background:#2d3748;color:#718096;border:1px solid #4a5568;white-space:nowrap" title="Autotrader NOT managing — click to enable">⚡ AT: OFF</a>`;

    // Sell flag badge
    let sellFlagCell;
    if (!atOn) {
      sellFlagCell = `<span style="color:#4a5568;font-size:11px">— N/A</span>`;
    } else {
      const sellSettings = allSettings?.sell || {};
      const peak = peakPriceMap.get(p.symbol) ?? null;
      const status = buildSellStatus(p, sig, peak, sellSettings, spySig);
      const gateJson = JSON.stringify(status.conditions).replace(/"/g, '&quot;');
      if (status.decision === 'SELL') {
        sellFlagCell = `<span style="display:inline-flex;align-items:center;gap:3px">
          <span style="background:#742a2a;color:#feb2b2;border:1px solid #c53030;border-radius:4px;padding:2px 7px;font-size:11px;font-weight:700">⚠ SELL</span>
          <button onclick="showSellBlock('${p.symbol}','${gateJson}')" class="btn btn-xs" style="background:#742a2a;color:#feb2b2;border:1px solid #c53030;padding:3px 5px;font-weight:700">?</button>
        </span>`;
      } else {
        sellFlagCell = `<span style="display:inline-flex;align-items:center;gap:3px">
          <span style="background:#1a3a1a;color:#9ae6b4;border:1px solid #276749;border-radius:4px;padding:2px 7px;font-size:11px;font-weight:700">✓ Hold</span>
          <button onclick="showSellBlock('${p.symbol}','${gateJson}')" class="btn btn-xs" style="background:#1a3a1a;color:#9ae6b4;border:1px solid #276749;padding:3px 5px;font-weight:700">?</button>
        </span>`;
      }
    }

    return `<tr>
      ${starCell(sig?.cross_type, sig?.golden_cross_ago)}
      <td><b style="cursor:pointer;text-decoration:underline dotted" onclick="openTVChart('${p.symbol}','${nameSafe}')">${p.symbol}</b><br><span style="color:#718096;font-size:11px">${nameSafe}</span>
        <div style="margin-top:5px;white-space:nowrap">${tradeBtn}</div>
        <button onclick="openNews('${p.symbol}','${nameSafe}')" class="btn btn-xs" style="background:#fffaf0;color:#c05621;border:1px solid #fbd38d;margin-top:4px;width:100%">News</button>
      </td>
      <td>${atBtn}</td>
      <td>${sellFlagCell}</td>
      <td>${recBadge}</td>
      <td>${posWhyBtn}</td>
      <td>${posSector}</td>
      <td>${posTargetCell}</td>
      <td>${posUpgradeCell}</td>
      <td>${posPerfCell}${chartBtn}</td>
      <td>${qty}</td>
      <td>$${parseFloat(p.avg_entry_price).toFixed(2)}</td>
      <td><span style="font-weight:600;color:${posChgColor}">$${price.toFixed(2)}</span></td>
      <td><span style="font-weight:600;color:${posChgColor}">${posChgPct !== null ? (posChgPct>=0?'+':'')+posChgPct.toFixed(2)+'%' : '—'}</span></td>
      <td>$${parseFloat(p.market_value).toLocaleString(undefined,{maximumFractionDigits:0})}</td>
      <td style="color:${pc};font-weight:600">${sign}$${Math.abs(pnl).toFixed(0)} (${sign}${pnlPct.toFixed(1)}%)</td>
    </tr>`;
  }).join('') : `<tr><td colspan="16" style="color:#718096;text-align:center;padding:12px 0">No open positions — use the Buy button on any stock below.</td></tr>`;

  const ordRows = openOrders.length ? openOrders.map(o => {
    const lp  = o.limit_price ? ` @ $${parseFloat(o.limit_price).toFixed(2)}` : '';
    const dt  = o.submitted_at
      ? new Date(o.submitted_at).toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})
      : '';
    const sideBadge = o.side === 'buy' ? '<span class="badge badge-buy">Buy</span>' : '<span class="badge badge-sell">Sell</span>';
    const statusColor = ['new','accepted','pending_new','held'].includes(o.status) ? '#3182ce' : '#a0aec0';
    return `<tr>
      <td><b>${o.symbol}</b></td>
      <td>${sideBadge}</td>
      <td>${o.qty}</td>
      <td>${o.type}${lp}</td>
      <td style="color:#a0aec0">${o.time_in_force}${o.extended_hours?' +ext':''}</td>
      <td style="color:${statusColor}">${o.status}</td>
      <td style="color:#718096;font-size:11px">${dt}</td>
      <td><a href="/order/${o.id}/cancel" class="btn btn-danger btn-xs"
             onclick="return confirm('Cancel ${o.side} ${o.qty} ${o.symbol}?')">Cancel</a></td>
    </tr>`;
  }).join('') : '';

  return `
<div class="portfolio-wrap">
  <div class="card">
    <div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:${positions.length?'12':'0'}px;align-items:center">
      <div class="stat"><div class="num" style="color:#000">${equityTxt}</div><div class="lbl">Total Equity</div></div>
      <div class="stat"><div class="num" style="color:#90cdf4">${cashTxt}</div><div class="lbl">Available Cash</div></div>
      <div class="stat"><div class="num" style="color:#63b3ed">$${totalValue.toLocaleString(undefined,{maximumFractionDigits:0})}</div><div class="lbl">Market Value</div></div>
      <div class="stat"><div class="num" style="color:${pnlColor}">${totalPnl>=0?'+':''}$${Math.abs(totalPnl).toFixed(0)}</div><div class="lbl">Unrealized P&L</div></div>
      <div class="stat"><div class="num" style="color:${pnlColor}">${totalPnlPct !== null ? (totalPnlPct>=0?'+':'')+totalPnlPct.toFixed(2)+'%' : '—'}</div><div class="lbl">Total Return</div></div>
      <div class="stat"><div class="num" style="color:${todayColor}">${totalTodayPct !== null ? (totalTodayPct>=0?'+':'')+totalTodayPct.toFixed(2)+'%' : '—'}</div><div class="lbl">Today's Gain</div></div>
      <div class="stat"><div class="num" style="color:#000">${positions.length}</div><div class="lbl">Positions</div></div>
      <div class="stat"><div class="num" style="color:#3182ce">${openOrders.length}</div><div class="lbl">Open Orders</div></div>
    </div>
    ${positions.length ? `<div style="display:flex;gap:0;flex-wrap:wrap;background:#0f1320;border-radius:8px;padding:8px 16px;margin-bottom:12px;align-items:center;gap:4px">
      <span style="font-size:11px;color:#ffffff;margin-right:8px;white-space:nowrap;font-weight:600">Portfolio returns:</span>
      <span style="font-size:11px;color:#ffffff;margin-right:2px">1D</span>${prFmt(pr.d1)}&ensp;
      <span style="font-size:11px;color:#ffffff;margin-right:2px">1W</span>${prFmt(pr.w1)}&ensp;
      <span style="font-size:11px;color:#ffffff;margin-right:2px">1M</span>${prFmt(pr.m1)}&ensp;
      <span style="font-size:11px;color:#ffffff;margin-right:2px">3M</span>${prFmt(pr.m3)}&ensp;
      <span style="font-size:11px;color:#ffffff;margin-right:2px">6M</span>${prFmt(pr.m6)}&ensp;
      <span style="font-size:11px;color:#ffffff;margin-right:2px">YTD</span>${prFmt(pr.ytd)}&ensp;
      <span style="font-size:11px;color:#ffffff;margin-right:2px">1Y</span>${prFmt(pr.y1)}
    </div>` : ''}
    ${positions.length ? `
    <div style="font-size:11px;font-weight:700;color:#718096;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">Positions</div>
    <div class="tbl-wrap" style="max-height:480px">
    <table><thead><tr>
      <th style="width:30px;text-align:center">★</th><th>Symbol · Trade</th><th>Autotrader</th><th>Sell Flag</th><th>Signal · Price</th><th>Why</th><th>Sector</th>
      <th>Price Target</th><th>Analyst Action</th>
      <th>Performance · Chart</th>
      <th>Qty</th><th>Avg Entry</th><th>Current</th><th>Chg%</th>
      <th>Mkt Value</th><th>Unrealized P&L</th>
    </tr></thead><tbody>${posRows}</tbody></table>
    </div>` : `<div style="color:#718096;font-size:12px;padding:4px 0">No open positions. Use the Buy button on any stock below.</div>`}
    ${openOrders.length ? `
    <div style="font-size:11px;font-weight:700;color:#718096;margin:14px 0 6px;text-transform:uppercase;letter-spacing:.5px">Open Orders</div>
    <div class="tbl-wrap" style="max-height:360px">
    <table><thead><tr>
      <th>Symbol</th><th>Side</th><th>Qty</th><th>Type</th><th>TIF</th><th>Status</th><th>Submitted</th><th></th>
    </tr></thead><tbody>${ordRows}</tbody></table>
    </div>` : ''}
  </div>
</div>
`;
}

// ─── Stock table row ──────────────────────────────────────────────────────────
function stockRow(s, upgrade, pickFlag, positionSet) {
  const recBadge = s.recommendation === 'BUY'  ? '<span class="badge badge-buy">▲ BUY</span>'
                 : s.recommendation === 'SELL' ? '<span class="badge badge-sell">▼ SELL</span>'
                 :                               '<span class="badge badge-hold">● HOLD</span>';
  const scoreColor = s.score >= 60 ? '#48bb78' : s.score >= 40 ? '#3182ce' : '#fc8181';
  const scoreBar = `<div class="score-bar"><div class="score-fill" style="width:${s.score||0}%;background:${scoreColor}"></div></div>`;
  const rsiColor = s.rsi < 30 ? '#fc8181' : s.rsi > 70 ? '#3182ce' : '#48bb78';
  const rsiTxt   = s.rsi ? `<span style="color:${rsiColor}">${parseFloat(s.rsi).toFixed(1)}</span>` : '—';
  const macdCls  = ['bullish','above_signal'].includes(s.macd_trend) ? 'signal-up'
                 : ['bearish','below_signal'].includes(s.macd_trend) ? 'signal-down' : 'signal-neu';
  const above50  = s.above_50ma  ? '<span class="signal-up">✓</span>' : '<span class="signal-down">✗</span>';
  const above200 = s.above_200ma ? '<span class="signal-up">✓</span>' : '<span class="signal-down">✗</span>';

  const ma50f  = s.ma50  ? parseFloat(s.ma50)  : null;
  const ma200f = s.ma200 ? parseFloat(s.ma200) : null;
  const approachingGolden = ma50f && ma200f && ma50f < ma200f && (ma200f - ma50f) / ma200f < 0.025;
  let crossTag = '';
  if (s.cross_type === 'golden_cross') {
    const ago = s.golden_cross_ago !== null ? parseInt(s.golden_cross_ago) : null;
    crossTag = (ago !== null && ago <= 15)
      ? `<span class="tag tag-golden">☀ Golden cross (${ago}d ago)</span>`
      : `<span class="tag tag-golden">☀ Above GC</span>`;
  } else if (s.cross_type === 'death_cross') {
    const ago = s.death_cross_ago !== null ? parseInt(s.death_cross_ago) : null;
    if (ago !== null && ago <= 15) {
      crossTag = `<span class="tag tag-death">☠ Death cross (${ago}d ago)</span>`;
    } else if (approachingGolden) {
      crossTag = `<span class="tag" style="background:#f0fff4;color:#276749;border:1px solid #9ae6b4">↗ Approaching GC</span>`;
    } else {
      crossTag = `<span class="tag" style="background:#fff5f5;color:#9b2c2c;border:1px solid #feb2b2">↓ Below GC</span>`;
    }
  } else if (approachingGolden) {
    crossTag = `<span class="tag" style="background:#f0fff4;color:#276749;border:1px solid #9ae6b4">↗ Approaching GC</span>`;
  }

  const assetTag = (s.asset_type === 'etf' || s.asset_type === 'fund')
    ? ' <span class="badge badge-etf" style="font-size:10px">ETF/FUND</span>' : '';
  const raw52h = s.pct_from_52high != null ? parseFloat(s.pct_from_52high) : null;
  const raw52l = s.pct_from_52low  != null ? parseFloat(s.pct_from_52low)  : null;
  const h52Color = raw52h !== null ? (Math.abs(raw52h) < 10 ? '#48bb78' : Math.abs(raw52h) < 35 ? '#3182ce' : '#fc8181') : '#718096';
  const pe    = s.pe_trailing ? parseFloat(s.pe_trailing).toFixed(1) : '—';
  const fpe   = s.pe_forward  ? parseFloat(s.pe_forward).toFixed(1)  : '—';
  const dyVal = s.dividend_yield != null ? parseFloat(s.dividend_yield) : null;
  const dy    = dyVal !== null && dyVal > 0 ? dyVal.toFixed(2)+'%' : '—';
  const chg      = s.price_change_pct != null ? parseFloat(s.price_change_pct) : null;
  const chg1m    = s.chg_1m != null ? parseFloat(s.chg_1m) : null;
  const chgYtd   = s.chg_ytd != null ? parseFloat(s.chg_ytd) : null;
  const chg1y    = s.chg_1y != null ? parseFloat(s.chg_1y) : null;
  const priceColor = chg !== null ? (chg >= 0 ? '#48bb78' : '#fc8181') : '#2d3748';
  const price    = s.price ? `<span style="font-weight:600;color:${priceColor}">$${parseFloat(s.price).toFixed(2)}</span>` : '—';
  const chgTxt   = chg !== null ? `<span style="font-weight:600;color:${priceColor}">${chg>=0?'+':''}${chg.toFixed(2)}%</span>` : '—';
  const chg1mTxt = chg1m !== null ? `<span style="color:${chg1m >= 0 ? '#48bb78' : '#fc8181'}">${chg1m>=0?'+':''}${chg1m.toFixed(2)}%</span>` : '—';
  const chgYtdTxt = chgYtd !== null ? `<span style="color:${chgYtd >= 0 ? '#48bb78' : '#fc8181'}">${chgYtd>=0?'+':''}${chgYtd.toFixed(2)}%</span>` : '—';
  const chg1yTxt = chg1y !== null ? `<span style="color:${chg1y >= 0 ? '#48bb78' : '#fc8181'}">${chg1y>=0?'+':''}${chg1y.toFixed(2)}%</span>` : '—';
  const nameSafe = (s.name || '').replace(/'/g, "\\'");
  const whySafe  = s.why ? s.why.replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/\n/g,'\\n') : '';
  const updatedAtSafe = s.generated_at ? new Date(s.generated_at).toLocaleString('en-US',{timeZone:'America/New_York',hour12:true,month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : '';
  const whyBtn   = s.why ? `<button onclick="showWhy('${s.symbol}','${whySafe}','${updatedAtSafe}')" class="btn btn-xs" style="background:#ebf8ff;color:#2b6cb0;border:1px solid #bee3f8">Why?</button>` : '';
  const isEtf = s.asset_type === 'etf' || s.asset_type === 'fund';
  const buyBtn = isEtf
    ? `<button class="btn btn-xs" style="background:#f7fafc;color:#a0aec0;border:1px solid #e2e8f0;cursor:not-allowed" disabled>Buy</button>`
    : `<button onclick="openBuy('${s.symbol}','${s.price||0}','${nameSafe}')" class="btn btn-success btn-xs">Buy</button>`;
  // ── Pick/No Pick toggle button ───────────────────────────────────────────
  let pickToggleBtn;
  const pickUrl = `/watchlist/toggle-pick/${s.symbol}`;
  if (pickFlag === 1) {
    pickToggleBtn = `<span class="pick-toggle-btn btn btn-xs" data-pick-url="${pickUrl}" style="background:#1a3a1a;color:#9ae6b4;border:1px solid #276749;display:inline-block;cursor:pointer" title="Stock marked for autotrader. Click to unmark.">✓ Pick</span>`;
  } else {
    pickToggleBtn = `<span class="pick-toggle-btn btn btn-xs" data-pick-url="${pickUrl}" style="background:#742a2a;color:#feb2b2;border:1px solid #c53030;display:inline-block;cursor:pointer" title="Stock NOT marked for autotrader. Click to mark.">🚫 No Pick</span>`;
  }

  const sectorTxt = s.sector ? `<span style="font-size:11px;color:#718096">${s.sector}</span>` : '—';

  // Price target cell
  const tgtMean  = s.target_mean ? parseFloat(s.target_mean) : null;
  const tgtHigh  = s.target_high ? parseFloat(s.target_high) : null;
  const tgtLow   = s.target_low  ? parseFloat(s.target_low)  : null;
  const priceNum = s.price ? parseFloat(s.price) : 0;
  let targetCell = '—';
  if (tgtMean && priceNum > 0) {
    const upside = ((tgtMean - priceNum) / priceNum) * 100;
    const uColor = upside >= 0 ? '#276749' : '#c53030';
    const uSign  = upside >= 0 ? '+' : '';
    targetCell   = `<span style="font-weight:600;color:${uColor}">$${tgtMean.toFixed(0)}</span> <span style="font-size:10px;color:${uColor}">${uSign}${upside.toFixed(0)}%</span>`;
    if (tgtHigh && tgtLow)
      targetCell += `<br><span style="font-size:10px;color:#718096">$${tgtLow.toFixed(0)}–$${tgtHigh.toFixed(0)}</span>`;
  }

  const gcState = s.cross_type === 'golden_cross' && s.golden_cross_ago !== null && parseInt(s.golden_cross_ago) <= (settingsCache.getGoldenCross()?.pulsing_glow_days ?? 5) ? 'recent'
                : s.cross_type === 'golden_cross' ? 'active'
                : s.cross_type === 'approaching_golden_cross' ? 'approaching' : 'none';
  const pickState = pickFlag === 1 ? 'pick' : 'noselect';
  const portfolioState = positionSet.has(s.symbol) ? 'in' : 'out';
  return `<tr data-rec="${s.recommendation}" data-sym="${s.symbol}" data-name="${s.name||''}" data-cross="${gcState}" data-pick="${pickState}" data-inport="${portfolioState}">
    <td style="text-align:center"><input type="checkbox" class="pick-select-cb" data-sym="${s.symbol}" style="cursor:pointer;accent-color:#48bb78"></td>
    ${starCell(s.cross_type, s.golden_cross_ago)}
    <td><b style="cursor:pointer;text-decoration:underline dotted" onclick="openTVChart('${s.symbol}','${nameSafe}')">${s.symbol}</b>${assetTag}<br><span style="color:#718096;font-size:11px">${s.name||''}</span>
      <div style="margin-top:5px;display:flex;gap:4px;flex-wrap:nowrap;align-items:center;white-space:nowrap;overflow-x:auto">
        ${buyBtn}
        ${pickToggleBtn}
        <button onclick="openNews('${s.symbol}','${nameSafe}')" class="btn btn-xs" style="background:#fffaf0;color:#c05621;border:1px solid #fbd38d">News</button>
        <a href="/watchlist/remove/${s.symbol}" class="btn btn-danger btn-xs"
           onclick="return confirm('Remove ${s.symbol}?')">✕</a>
      </div>
    </td>
    <td data-val="${s.price||0}">${price}</td>
    <td data-val="${chg??-999}">${chgTxt}</td>
    <td data-val="${chg1m??-999}">${chg1mTxt}</td>
    <td data-val="${chgYtd??-999}">${chgYtdTxt}</td>
    <td data-val="${chg1y??-999}">${chg1yTxt}</td>
    <td style="text-align:center;font-size:11px;font-weight:600;color:${positionSet.has(s.symbol) ? '#276749' : '#718096'}">${positionSet.has(s.symbol) ? '✓ In Portfolio' : 'Not in Portfolio'}</td>
    <td>${recBadge}<br>${scoreBar}<span style="font-size:11px;color:${scoreColor}">${parseFloat(s.score||0).toFixed(0)}/100</span></td>
    <td>${whyBtn}</td>
    <td>${sectorTxt}</td>
    <td>${targetCell}</td>
    <td>${upgradeCell(upgrade)}</td>
    <td data-val="${s.rsi||0}">${rsiTxt}</td>
    <td class="${macdCls}">${s.macd_trend||'—'}</td>
    <td>${above50}</td><td>${above200}</td>
    <td data-val="${s.ma50||0}">${s.ma50?'$'+parseFloat(s.ma50).toFixed(2):'—'}</td>
    <td data-val="${s.ma200||0}">${s.ma200?'$'+parseFloat(s.ma200).toFixed(2):'—'}</td>
    <td data-val="${raw52h||0}"><span style="color:${h52Color}">${raw52h!==null?Math.abs(raw52h).toFixed(1)+'%':'—'}</span></td>
    <td data-val="${raw52l||0}"><span class="signal-up">${raw52l!==null?raw52l.toFixed(1)+'%':'—'}</span></td>
    <td>${crossTag||'—'}</td>
    <td data-val="${s.pe_trailing||0}">${pe}</td>
    <td data-val="${s.pe_forward||0}">${fpe}${s.fwd_pe_improving?'<span class="signal-up" style="font-size:10px"> ▼</span>':''}</td>
    <td data-val="${dyVal||0}">${dy}</td>
  </tr>`;
}

// ─── Main dashboard route ─────────────────────────────────────────────────────
app.get('/', async (req, res) => {
  try {
    const [signals, positions, openOrders, account, clock, picks, recentUpgrades, allSettings] = await Promise.all([
      db.query(`SELECT * FROM stock_signals ORDER BY score DESC`),
      getAlpacaPositions().catch(() => []),
      getOpenOrders().catch(() => []),
      getAccount().catch(() => null),
      getMarketClock().catch(() => ({ is_open: false })),
      getTopPicks(50).catch(() => []),
      db.query(
        `SELECT a.* FROM analyst_upgrades a
         INNER JOIN (
           SELECT symbol, MAX(grade_date) AS md FROM analyst_upgrades GROUP BY symbol
         ) m ON a.symbol = m.symbol AND a.grade_date = m.md
         WHERE a.grade_date >= DATE_SUB(NOW(), INTERVAL 90 DAY)
         ORDER BY a.grade_date DESC`
      ).catch(() => []),
      settings.getSettings().catch(() => ({ gates: { overextension_pct: 8 } })),
    ]);

    const signalMap    = new Map(signals.map(s => [s.symbol, s]));
    const upgradeMap   = new Map(recentUpgrades.map(u => [u.symbol, u]));
    const pickFlagRows = await db.query(`SELECT symbol, pick_flag FROM watchlist WHERE is_active = 1`).catch(() => []);
    const pickFlagMap  = new Map(pickFlagRows.map(r => [r.symbol, r.pick_flag ?? 0]));
    const flagRows     = await db.query(`SELECT symbol, autotrader_on, peak_price FROM position_flags`).catch(() => []);
    const flagMap      = new Map(flagRows.map(r => [r.symbol, !!r.autotrader_on]));
    const peakPriceMap = new Map(flagRows.map(r => [r.symbol, r.peak_price ? parseFloat(r.peak_price) : null]));

    // SPY for sell flag evaluation (Layer 4)
    const spySig = signalMap.get('SPY') || null;

    // ── Per-position price history (for the position table perf cells) ──
    const perfMap = new Map();
    if (positions.length > 0) {
      const posSyms = positions.map(p => p.symbol);
      const ph = posSyms.map(() => '?').join(',');
      const rows = await db.query(
        `SELECT symbol, close FROM price_history
         WHERE symbol IN (${ph})
           AND trade_date >= DATE_SUB(NOW(), INTERVAL 390 DAY)
         ORDER BY symbol, trade_date DESC`,
        posSyms
      ).catch(() => []);
      const grouped = {};
      for (const r of rows) {
        if (!grouped[r.symbol]) grouped[r.symbol] = [];
        grouped[r.symbol].push(parseFloat(r.close));
      }
      const now = new Date();
      const ytdCalDays = Math.floor((now - new Date(now.getFullYear(), 0, 1)) / 86400000);
      const ytdIdx = Math.round(ytdCalDays * 252 / 365);
      for (const [sym, closes] of Object.entries(grouped)) {
        const cur = closes[0];
        const pct = n => closes[n] != null ? (cur - closes[n]) / closes[n] * 100 : null;
        perfMap.set(sym, { d1: pct(1), w1: pct(5), m1: pct(21), m3: pct(63), m6: pct(126), y1: pct(252), ytd: pct(ytdIdx) });
      }
    }

    // ── Portfolio-level period returns from Alpaca portfolio history ──
    // equity[] is daily snapshots DESC; timestamps are unix seconds
    // Only show a period if the portfolio existed for that full duration
    const portfolioReturns = {};
    try {
      const hist = await getPortfolioHistory();
      const equities   = hist.equity     || [];
      const timestamps = hist.timestamp  || [];
      // Filter to entries where equity > 0 (portfolio existed)
      const live = timestamps.map((t, i) => ({ t, e: equities[i] })).filter(x => x.e > 0);
      if (live.length >= 2) {
        const latest    = live[live.length - 1].e;
        const latestTs  = live[live.length - 1].t;
        const firstTs   = live[0].t;                 // oldest point with positions
        const ageMs     = (latestTs - firstTs) * 1000;
        const dayMs     = 86400000;

        const pctAt = (daysAgo) => {
          const targetTs = latestTs - daysAgo * 86400;
          // find closest entry at or before targetTs that is within the live range
          if (targetTs < firstTs) return null;        // portfolio didn't exist yet
          const closest = live.slice().reverse().find(x => x.t <= targetTs + 3600); // +1h tolerance
          return closest ? (latest - closest.e) / closest.e * 100 : null;
        };

        const now = new Date();
        const ytdDays = Math.floor((now - new Date(now.getFullYear(), 0, 1)) / dayMs);

        portfolioReturns.d1  = pctAt(1);
        portfolioReturns.w1  = pctAt(7);
        portfolioReturns.m1  = pctAt(30);
        portfolioReturns.m3  = pctAt(91);
        portfolioReturns.m6  = pctAt(182);
        portfolioReturns.ytd = pctAt(ytdDays);
        portfolioReturns.y1  = pctAt(365);
      }
    } catch (_) { /* portfolio history unavailable */ }

    const buyingPower  = account ? parseFloat(account.buying_power || account.cash || 0) : 0;
    const buyCount     = signals.filter(s => s.recommendation === 'BUY').length;
    const holdCount    = signals.filter(s => s.recommendation === 'HOLD').length;
    const sellCount    = signals.filter(s => s.recommendation === 'SELL').length;
    const lastRefresh  = signals[0]?.generated_at
      ? new Date(signals[0].generated_at).toLocaleString('en-US',{timeZone:'America/New_York'})+' ET'
      : 'Never';
    const mktStatus = clock.is_open
      ? '<span style="color:#48bb78">🟢 Market Open</span>'
      : '<span style="color:#fc8181">🔴 Market Closed</span>';
    const modeBadge = cfg.alpaca.isPaper
      ? '<span class="badge-paper">📄 PAPER</span>'
      : '<span class="badge-live">💰 LIVE</span>';

    // Long Haul: dividend payers, stable, 20%+ below 52wk high, not overvalued
    const longHaulStocks = signals.filter(s => {
      const dy   = s.div_yield != null ? parseFloat(s.div_yield) : 0;
      const h52  = s.pct_from_52high != null ? parseFloat(s.pct_from_52high) : 0;
      const pe   = s.pe_trailing != null ? parseFloat(s.pe_trailing) : null;
      const fpe  = s.pe_forward  != null ? parseFloat(s.pe_forward)  : null;
      const beta = s.beta != null ? parseFloat(s.beta) : 999;
      const notOvervalued = (pe !== null && pe > 0 && pe < 35) || (fpe !== null && fpe > 0 && fpe < 28);
      return dy > 0 && h52 <= -20 && notOvervalued && beta < 1.5;
    }).sort((a, b) => parseFloat(b.div_yield) - parseFloat(a.div_yield));

    const longHaulRows = longHaulStocks.map(s => {
      const nameSafe = (s.name||'').replace(/'/g,"\\'");
      const dy       = parseFloat(s.div_yield).toFixed(2);
      const h52      = parseFloat(s.pct_from_52high).toFixed(1);
      const pe       = s.pe_trailing ? parseFloat(s.pe_trailing).toFixed(1) : '—';
      const fpe      = s.pe_forward  ? parseFloat(s.pe_forward).toFixed(1)  : '—';
      const beta     = s.beta ? parseFloat(s.beta).toFixed(2) : '—';
      const chg      = s.price_change_pct != null ? parseFloat(s.price_change_pct) : null;
      const chgColor = chg !== null ? (chg >= 0 ? '#48bb78' : '#fc8181') : '#718096';
      const priceTxt = `<span style="font-weight:600;color:${chgColor}">$${parseFloat(s.price||0).toFixed(2)}</span>`;
      const chgTxt   = chg !== null ? `<span style="color:${chgColor}">${chg>=0?'+':''}${chg.toFixed(2)}%</span>` : '—';
      const scoreColor = s.score >= 60 ? '#48bb78' : s.score >= 40 ? '#3182ce' : '#fc8181';
      const recBadge = s.recommendation === 'BUY'  ? '<span class="badge badge-buy">▲ BUY</span>'
                     : s.recommendation === 'SELL' ? '<span class="badge badge-sell">▼ SELL</span>'
                     :                               '<span class="badge badge-hold">● HOLD</span>';
      return `<tr>
        ${starCell(s.cross_type, s.golden_cross_ago)}
        <td><b style="cursor:pointer;text-decoration:underline dotted" onclick="openTVChart('${s.symbol}')">${s.symbol}</b><br>
          <span style="color:#718096;font-size:11px">${s.name||''}</span><br>
          <div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap">
            <button onclick="openNews('${s.symbol}','${nameSafe}')" class="btn btn-xs" style="background:#fffaf0;color:#c05621;border:1px solid #fbd38d">News</button>
          </div>
        </td>
        <td>${priceTxt}<br>${chgTxt}</td>
        <td><span style="color:#48bb78;font-weight:700">${dy}%</span></td>
        <td><span style="color:#fc8181;font-weight:600">${h52}%</span></td>
        <td>${pe}</td>
        <td>${fpe}</td>
        <td>${beta}</td>
        <td>${recBadge}<br><span style="font-size:11px;color:${scoreColor}">${Math.round(s.score||0)}/100</span></td>
        <td style="font-size:11px;color:#718096;max-width:200px">${s.sector||'—'}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="10" style="padding:16px;text-align:center;color:#718096">No Long Haul picks yet — data refreshes at 8:30 AM ET</td></tr>';

    const positionSet = new Set(positions.map(p => p.symbol));
    const stockRows   = signals.map(s => stockRow(s, upgradeMap.get(s.symbol), pickFlagMap.get(s.symbol) ?? 0, positionSet)).join('');
    const pfSection   = portfolioSection(positions, openOrders, account, signalMap, upgradeMap, perfMap, portfolioReturns, flagMap, allSettings, peakPriceMap, spySig);

    const discoverRows = picks.map(s => {
      const scoreColor  = s.score >= 60 ? '#48bb78' : s.score >= 40 ? '#3182ce' : '#fc8181';
      const whySafe     = s.why ? s.why.replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/\n/g,'\\n') : '';
      const whyBtn      = s.why ? `<button onclick="showWhy('${s.symbol}','${whySafe}')" class="btn btn-xs" style="background:#1a1540;color:#b794f4;border:1px solid #6b46c1">Why?</button>` : '';
      const topSignals  = (s.why||'').replace(/Score:\d+\/100 \| /,'').split(' | ').slice(0,2).join(' · ');
      const dChg        = s.price_change_pct != null ? parseFloat(s.price_change_pct) : null;
      const dChgColor   = dChg !== null ? (dChg >= 0 ? '#48bb78' : '#fc8181') : '#2d3748';
      const dPriceTxt   = `<span style="font-weight:600;color:${dChgColor}">$${parseFloat(s.price||0).toFixed(2)}</span>`;
      const dChgTxt     = dChg !== null ? `<span style="font-weight:600;color:${dChgColor}">${dChg>=0?'+':''}${dChg.toFixed(2)}%</span>` : '—';
      return `<tr>
        <td><b style="color:#b794f4;cursor:pointer;text-decoration:underline dotted" onclick="openTVChart('${s.symbol}','${(s.name||'').replace(/'/g,"\\'")}'">${s.symbol}</b><br><span style="color:#718096;font-size:11px">${s.name||''}</span></td>
        <td>${dPriceTxt}</td>
        <td>${dChgTxt}</td>
        <td><span style="font-weight:700;color:${scoreColor}">${Math.round(s.score)}</span>/100</td>
        <td>${whyBtn}</td>
        <td style="font-size:11px;color:#718096;max-width:250px">${topSignals}</td>
        <td style="white-space:nowrap">
          <a href="/watchlist/add-quick/${s.symbol}" class="btn btn-xs" style="background:#2d2040;color:#b794f4;border:1px solid #6b46c1">+ Watch</a>
          <button onclick="openNews('${s.symbol}','${(s.name||'').replace(/'/g,"\\'")}')'" class="btn btn-xs" style="background:#fffaf0;color:#c05621;border:1px solid #fbd38d;margin-top:4px;display:block;width:100%">News</button>
        </td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" style="padding:12px;color:#718096;text-align:center">No new picks yet — universe scan runs at 8:30 AM ET. <a href="/scan-universe" style="color:#b794f4">Run Now</a></td></tr>';

    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>My Stocks Dashboard</title>${STYLE}
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.2/dist/chart.umd.min.js"></script>
</head>
<body>
<script>
window._mktOpen     = ${clock.is_open};
window._isPaper     = ${cfg.alpaca.isPaper};
window._buyingPower = ${buyingPower.toFixed(2)};
</script>

${JS}

<div class="header">
  <div style="flex:1">
    <h1>📊 My Stocks Dashboard</h1>
    <div style="font-size:11px;color:#718096;margin-top:3px">
      Last refresh: ${lastRefresh} · ${mktStatus} · ${modeBadge}
    </div>
  </div>
  <form action="/watchlist/add" method="POST" style="display:flex;gap:8px;align-items:center">
    <input type="text" name="symbol" placeholder="Add ticker…" style="width:110px">
    <button type="submit" class="btn btn-primary btn-sm">+ Add</button>
  </form>
  <a href="/refresh-now" class="btn btn-primary btn-sm">↻ Refresh Now</a>
  <a href="/settings" class="btn btn-sm" style="background:rgba(255,255,255,.15);color:#fbbf24">⚙ Settings</a>
  <a href="http://192.168.1.156:3001/dashboard" class="btn btn-sm" style="background:rgba(255,255,255,.15);color:#bee3f8">↗ Swing Trader</a>
</div>


<!-- Tab navigation -->
<div class="tab-nav">
  <button class="tab-btn active" data-tab="portfolio" onclick="switchTab('portfolio')">💼 Portfolio · ${positions.length}</button>
  <button class="tab-btn" data-tab="stocks" onclick="switchTab('stocks')">📊 Stocks · ${signals.length} · <span style="color:#48bb78">${buyCount} Buy</span></button>
  <button class="tab-btn" data-tab="discover" onclick="switchTab('discover')">🔭 Discover · ${picks.length}</button>
  <button class="tab-btn" data-tab="longhaul" onclick="switchTab('longhaul')" style="color:#68d391">🌱 Long Haul · ${longHaulStocks.length}</button>
  <button class="tab-btn" data-tab="transactions" onclick="switchTab('transactions')">📜 Transactions</button>
</div>

<!-- Portfolio tab -->
<div id="tab-portfolio" class="tab-content active">
${pfSection}
</div>

<!-- Stocks tab -->
<div id="tab-stocks" class="tab-content">
<div style="display:flex;align-items:center;gap:16px;padding:8px 24px;background:#1a1f2e;border-bottom:1px solid #2d3748;font-size:11px;color:#718096">
  <span>📅 Last data run: <b style="color:#a0aec0">${lastRefresh}</b></span>
  <span style="flex:1"></span>
  <span>Score ≥50 = BUY · 10–49 = HOLD · &lt;10 = SELL</span>
  <div class="stat" style="margin:0"><div class="num" style="color:#276749;font-size:16px">${buyCount}</div><div class="lbl">Buy</div></div>
  <div class="stat" style="margin:0"><div class="num" style="color:#3182ce;font-size:16px">${holdCount}</div><div class="lbl">Hold</div></div>
  <div class="stat" style="margin:0"><div class="num" style="color:#c53030;font-size:16px">${sellCount}</div><div class="lbl">Sell</div></div>
</div>
<div class="filter-bar">
  <input type="text" placeholder="Search symbol or name…" oninput="filterSearch(this.value)" style="width:150px">
  <select onchange="filterRec(this.value)" style="width:auto">
    <option value="">Signal: All</option>
    <option value="BUY">Signal: BUY only</option>
    <option value="HOLD">Signal: HOLD only</option>
    <option value="SELL">Signal: SELL only</option>
  </select>
  <select id="elig-filter" onchange="filterEligibility(this.value)" style="width:auto">
    <option value="">Status: All</option>
    <option value="eligible">Status: ✓ Eligible</option>
    <option value="blocked">Status: ⚠ Blocked</option>
  </select>
  <select id="pick-filter" onchange="filterPickFlag(this.value)" style="width:auto">
    <option value="">Pick: All</option>
    <option value="pick">Pick: ✓ Yes</option>
    <option value="noselect">Pick: 🚫 No</option>
  </select>
  <select id="port-filter" onchange="filterPortfolio(this.value)" style="width:auto">
    <option value="">Portfolio: All</option>
    <option value="in">Portfolio: In</option>
    <option value="out">Portfolio: Not In</option>
  </select>
  <select id="watchlist-filter" onchange="filterByWatchlist(this.value)" style="width:auto">
    <option value="">Watchlist: All Stocks</option>
  </select>
  <button onclick="openWatchlistModal()" class="btn" style="background:#2d3748;color:#e2e8f0;font-size:11px;padding:4px 10px">☰ Manage Watchlists</button>
  <button id="bulk-pick-btn" onclick="bulkTogglePick()" class="btn" style="background:#1a3a1a;color:#9ae6b4;border:1px solid #276749;font-size:11px;padding:4px 10px;display:none">Toggle Pick (<span id="pick-sel-count">0</span>)</button>
  <button onclick="clearAllFilters()" class="btn" style="background:#f7fafc;color:#4a5568;border:1px solid #e2e8f0;font-size:11px;padding:4px 10px;margin-left:auto">Clear All</button>
  <button onclick="saveCurrentFilter()" class="btn" style="background:#f0fff4;color:#276749;border:1px solid #9ae6b4;font-size:11px;padding:4px 10px">Save Filter</button>
</div>
<div style="padding:8px 24px;background:#fff;border-bottom:1px solid #e2e8f0;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
  <span style="color:#718096;font-size:11px">Golden Cross:</span>
  <button onclick="filterGoldenCross('all')" id="gcf-all" class="filter-btn filter-btn-active" style="font-size:11px;padding:3px 8px;margin:0 1px">All</button>
  <button onclick="filterGoldenCross('recent')" id="gcf-recent" class="filter-btn" style="font-size:11px;padding:3px 8px;margin:0 1px">⭐</button>
  <button onclick="filterGoldenCross('approaching')" id="gcf-approaching" class="filter-btn" style="font-size:11px;padding:3px 8px;margin:0 1px">🟢</button>
  <button onclick="filterGoldenCross('active')" id="gcf-active" class="filter-btn" style="font-size:11px;padding:3px 8px;margin:0 1px">★</button>
  <button onclick="filterGoldenCross('none')" id="gcf-none" class="filter-btn" style="font-size:11px;padding:3px 8px;margin:0 1px">☆</button>
</div>
<div id="preset-list" style="padding:8px 24px;background:#f7fafc;border-bottom:1px solid #e2e8f0;display:flex;gap:6px;flex-wrap:wrap;font-size:11px"></div>
<div class="tbl-wrap" style="max-height:calc(100vh - 220px);margin:0 24px 16px">
<table id="stocks-table">
<thead><tr>
  <th style="width:24px;text-align:center;cursor:default">
    <input type="checkbox" id="pick-select-all" title="Select all visible" style="cursor:pointer;accent-color:#48bb78">
  </th>
  <th style="width:30px;text-align:center;cursor:default">★</th>
  <th data-col="sym"    onclick="sortTable('sym')">Symbol / Name</th>
  <th data-col="price"  onclick="sortTable('price')">Price</th>
  <th data-col="chg"    onclick="sortTable('chg')">Chg 1D%</th>
  <th data-col="chg1m"  onclick="sortTable('chg1m')">Chg 1M%</th>
  <th data-col="chgytd" onclick="sortTable('chgytd')">Chg YTD%</th>
  <th data-col="chg1y"  onclick="sortTable('chg1y')">Chg 1Y%</th>
  <th style="width:110px;text-align:center">Portfolio</th>
  <th data-col="score"  onclick="sortTable('score')">⚡ Alpha</th>
  <th data-col="phx">🔥 Phoenix</th>
  <th data-col="why">Why</th>
  <th data-col="sector">Sector</th>
  <th data-col="target">Price Target</th>
  <th data-col="action">Analyst Action</th>
  <th data-col="rsi"    onclick="sortTable('rsi')">RSI</th>
  <th data-col="macd"   onclick="sortTable('macd')">MACD</th>
  <th data-col="50ma"   onclick="sortTable('50ma')">Above 50DMA</th>
  <th data-col="200ma"  onclick="sortTable('200ma')">Above 200DMA</th>
  <th data-col="ma50v"  onclick="sortTable('ma50v')">50DMA</th>
  <th data-col="ma200v" onclick="sortTable('ma200v')">200DMA</th>
  <th data-col="52h"    onclick="sortTable('52h')">% Below 52W Hi</th>
  <th data-col="52l"    onclick="sortTable('52l')">% Above 52W Lo</th>
  <th data-col="cross"  onclick="sortTable('cross')">Cross</th>
  <th data-col="pe"     onclick="sortTable('pe')">P/E</th>
  <th data-col="fpe"    onclick="sortTable('fpe')">Fwd P/E</th>
  <th data-col="div"    onclick="sortTable('div')">Div%</th>
</tr></thead>
<tbody>${stockRows}</tbody>
</table>
</div>
</div>

<!-- Discover tab -->
<div id="tab-discover" class="tab-content">
<div style="display:flex;align-items:center;gap:12px;padding:8px 24px;background:#1a1f2e;border-bottom:1px solid #2d3748;font-size:11px;color:#718096">
  <span>${picks.length} momentum leaders &amp; new picks not in your watchlist</span>
  <span style="flex:1"></span>
  <a href="/scan-universe" class="btn btn-xs" style="background:#faf5ff;color:#6b46c1;border:1px solid #d6bcfa;font-size:11px">↻ Scan Now</a>
</div>
<div class="tbl-wrap" style="max-height:calc(100vh - 200px);margin:0 24px 16px">
<table>
<thead><tr>
  <th>Symbol / Name</th>
  <th>Price</th>
  <th>Chg%</th>
  <th>Score</th>
  <th>Why</th>
  <th>Key Signals</th>
  <th></th>
</tr></thead>
<tbody>${discoverRows}</tbody>
</table>
</div>
</div>

<!-- Long Haul tab -->
<div id="tab-longhaul" class="tab-content">
<div style="display:flex;align-items:center;gap:12px;padding:8px 24px;background:linear-gradient(135deg,#1a2e1a,#1e3d2e);border-bottom:1px solid #276749;font-size:11px;color:#68d391">
  <span>${longHaulStocks.length} dividend payers · 20%+ below 52wk high · not overvalued · beta &lt; 1.5</span>
</div>
<div class="tbl-wrap" style="max-height:calc(100vh - 200px);margin:0 24px 16px">
<table>
<thead><tr style="background:#1a2e1a">
  <th style="width:30px;text-align:center;cursor:default">★</th>
  <th>Symbol / Name</th>
  <th>Price</th>
  <th>Div Yield</th>
  <th>vs 52wk High</th>
  <th>P/E</th>
  <th>Fwd P/E</th>
  <th>Beta</th>
  <th>Signal</th>
  <th>Sector</th>
</tr></thead>
<tbody>${longHaulRows}</tbody>
</table>
</div>
</div>

<!-- Transactions tab -->
<div id="tab-transactions" class="tab-content">
<div style="padding:16px 24px">
  <div style="margin-bottom:12px;display:flex;gap:8px;align-items:center">
    <input type="text" id="txn-search" placeholder="Search symbol..." onkeyup="filterTransactions()" style="padding:6px 10px;border:1px solid #cbd5e0;border-radius:4px;font-size:12px;width:150px" />
    <select id="txn-source" onchange="filterTransactions()" style="padding:6px 10px;border:1px solid #cbd5e0;border-radius:4px;font-size:12px">
      <option value="">All Sources</option>
      <option value="autotrader">Autotrader</option>
      <option value="manual">Manual</option>
    </select>
    <select id="txn-action" onchange="filterTransactions()" style="padding:6px 10px;border:1px solid #cbd5e0;border-radius:4px;font-size:12px">
      <option value="">All Actions</option>
      <option value="buy">Buys</option>
      <option value="sell">Sells</option>
    </select>
  </div>
</div>
<div class="tbl-wrap" style="max-height:calc(100vh - 220px);margin:0 24px 16px">
<table id="txn-table">
<thead><tr>
  <th>Date</th>
  <th>Symbol</th>
  <th>Action</th>
  <th>Shares</th>
  <th>Price</th>
  <th>Total</th>
  <th>Source</th>
  <th>Reason</th>
  <th>P&L</th>
</tr></thead>
<tbody id="txn-body" style="font-size:12px">
  <tr><td colspan="9" style="text-align:center;padding:16px;color:#718096">Loading transactions...</td></tr>
</tbody>
</table>
</div>
</div>

<!-- Why modal -->
<div id="why-modal" class="modal-bg" onclick="if(event.target===this)closeWhy()">
  <div class="modal-box">
    <div class="modal-header">
      <div class="modal-title" id="why-modal-sym"></div>
      <button class="modal-close" onclick="closeWhy()">✕</button>
    </div>
    <div id="why-modal-body" style="font-size:13px"></div>
  </div>
</div>

<!-- Performance chart modal -->
<div id="chart-modal" class="modal-bg" onclick="if(event.target===this)closeChart()">
  <div class="chart-modal-box">
    <div class="modal-header">
      <div class="modal-title" id="chart-modal-title">Performance Chart</div>
      <button class="modal-close" onclick="closeChart()">✕</button>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:14px">
      <span style="font-size:11px;color:#718096">Period:</span>
      <button class="chart-ctrl-btn chart-period-btn" data-p="1m" onclick="setChartPeriod('1m')">1M</button>
      <button class="chart-ctrl-btn chart-period-btn" data-p="3m" onclick="setChartPeriod('3m')">3M</button>
      <button class="chart-ctrl-btn chart-period-btn" data-p="6m" onclick="setChartPeriod('6m')">6M</button>
      <button class="chart-ctrl-btn chart-period-btn active" data-p="1y" onclick="setChartPeriod('1y')">1Y</button>
      <button class="chart-ctrl-btn chart-period-btn" data-p="2y" onclick="setChartPeriod('2y')">2Y</button>
      <button class="chart-ctrl-btn chart-period-btn" data-p="5y" onclick="setChartPeriod('5y')">5Y</button>
      <span style="flex:1"></span>
      <span style="font-size:11px;color:#718096">vs:</span>
      <button class="chart-ctrl-btn chart-bench-btn active" data-b="SPY" onclick="toggleBench('SPY')">S&amp;P 500</button>
      <button class="chart-ctrl-btn chart-bench-btn" data-b="QQQ" onclick="toggleBench('QQQ')">Nasdaq 100</button>
      <button class="chart-ctrl-btn chart-bench-btn" data-b="DIA" onclick="toggleBench('DIA')">Dow</button>
    </div>
    <div style="position:relative;height:340px">
      <div id="chart-loading" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#718096;font-size:13px">Loading…</div>
      <canvas id="perf-chart" style="display:none"></canvas>
    </div>
    <div style="font-size:10px;color:#4a5568;margin-top:10px">Normalized to 100 at period start. SPY = S&amp;P 500, QQQ = Nasdaq 100, DIA = Dow Jones. Data via Alpaca.</div>
  </div>
</div>

<!-- Buy modal -->
<div id="buy-modal" class="modal-bg" onclick="if(event.target===this)closeBuy()">
  <div class="modal-box">
    <div class="modal-header">
      <div class="modal-title" id="buy-title">Buy</div>
      <button class="modal-close" onclick="closeBuy()">✕</button>
    </div>
    <div id="buy-mode" style="margin-bottom:12px"></div>
    <div class="info-box" style="margin-bottom:11px">
      Available to trade: <b id="buy-avail" style="color:#63b3ed">—</b>
    </div>
    <div class="form-group">
      <label class="form-label">Quantity</label>
      <input type="number" id="buy-qty" min="1" step="1" value="1" oninput="updateBuyCost()">
    </div>
    <div class="form-group">
      <label class="form-label">Order Type</label>
      <select id="buy-type" onchange="onBuyTypeChange()">
        <option value="market">Market</option>
        <option value="limit">Limit</option>
      </select>
    </div>
    <div class="form-group" id="buy-limit-row" style="display:none">
      <label class="form-label">Limit Price ($)</label>
      <input type="number" id="buy-limit-price" min="0.01" step="0.01" oninput="updateBuyCost()">
    </div>
    <div class="cost-row" id="buy-cost-row" style="display:none">
      <span>Estimated cost: <b id="buy-cost-val" style="color:#e2e8f0">—</b></span>
      <span>Remaining: <b id="buy-remaining-val">—</b></span>
    </div>
    <div class="form-group">
      <label class="form-label">Time in Force</label>
      <select id="buy-tif">
        <option value="day">Day</option>
        <option value="gtc">GTC — Good Till Cancelled</option>
        <option value="ioc">IOC — Immediate Or Cancel</option>
        <option value="fok">FOK — Fill Or Kill</option>
      </select>
    </div>
    <div class="form-group">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;color:#a0aec0">
        <input type="checkbox" id="buy-ext" onchange="onExtChange()" style="width:14px;height:14px;accent-color:#3182ce">
        Extended hours (limit orders only)
      </label>
    </div>
    <div id="buy-mkt-notice" style="font-size:11px;padding:7px 10px;border-radius:5px;background:#0f1117;border:1px solid #2d3748;margin-bottom:12px"></div>
    <div style="display:flex;gap:8px">
      <button id="buy-submit" class="btn btn-success" style="flex:1" onclick="submitBuy()">Place Buy Order</button>
      <button class="btn" style="background:#2d3748" onclick="closeBuy()">Cancel</button>
    </div>
  </div>
</div>

<!-- Sell modal -->
<div id="sell-modal" class="modal-bg" onclick="if(event.target===this)closeSell()">
  <div class="modal-box">
    <div class="modal-header">
      <div class="modal-title" id="sell-title">Sell</div>
      <button class="modal-close" onclick="closeSell()">✕</button>
    </div>
    <div id="sell-mode" style="margin-bottom:12px"></div>
    <div class="info-box" style="margin-bottom:11px;color:#a0aec0" id="sell-holding"></div>
    <div class="form-group">
      <label class="form-label">Quantity to Sell</label>
      <input type="number" id="sell-qty" min="1" step="1" oninput="updateSellProceeds()">
    </div>
    <div class="form-group">
      <label class="form-label">Order Type</label>
      <select id="sell-type" onchange="onSellTypeChange()">
        <option value="market">Market</option>
        <option value="limit">Limit</option>
      </select>
    </div>
    <div class="form-group" id="sell-limit-row" style="display:none">
      <label class="form-label">Limit Price ($)</label>
      <input type="number" id="sell-limit-price" min="0.01" step="0.01" oninput="updateSellProceeds()">
    </div>
    <div class="cost-row" id="sell-proceeds-row" style="display:none">
      <span>Estimated proceeds: <b id="sell-proceeds-val" style="color:#48bb78">—</b></span>
    </div>
    <div class="form-group">
      <label class="form-label">Time in Force</label>
      <select id="sell-tif">
        <option value="day">Day</option>
        <option value="gtc">GTC — Good Till Cancelled</option>
        <option value="ioc">IOC — Immediate Or Cancel</option>
      </select>
    </div>
    <div id="sell-mkt-notice" style="font-size:11px;padding:7px 10px;border-radius:5px;background:#0f1117;border:1px solid #2d3748;margin-bottom:12px"></div>
    <div style="display:flex;gap:8px">
      <button id="sell-submit" class="btn btn-warn" style="flex:1" onclick="submitSell()">Place Sell Order</button>
      <button class="btn" style="background:#2d3748" onclick="closeSell()">Cancel</button>
    </div>
  </div>
</div>

<!-- News modal -->
<div id="news-modal" class="modal-bg" onclick="if(event.target===this)closeNews()">
  <div class="modal-box" style="max-width:1100px;width:96%">
    <div class="modal-header">
      <div class="modal-title" id="news-modal-title">News</div>
      <button class="modal-close" onclick="closeNews()">✕</button>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:14px">
      <button class="chart-ctrl-btn news-tab-btn active" data-tab="finnhub" onclick="setNewsTab('finnhub')">📡 Company News</button>
      <button class="chart-ctrl-btn news-tab-btn" data-tab="sec" onclick="setNewsTab('sec')">🏛 SEC Filings</button>
    </div>
    <div id="news-modal-body" style="max-height:880px;overflow-y:auto;padding-right:4px"></div>
  </div>
</div>

<!-- TradingView chart modal -->
<div id="tv-modal" class="modal-bg" onclick="if(event.target===this)closeTVChart()" style="display:none">
  <div style="background:#fff;border-radius:10px;width:96%;max-width:1100px;height:85vh;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,.3)">
    <div class="modal-header" style="border-bottom:1px solid #e2e8f0">
      <div class="modal-title" id="tv-modal-title">Chart</div>
      <button class="modal-close" onclick="closeTVChart()">✕</button>
    </div>
    <iframe id="tv-iframe" src="" frameborder="0" style="flex:1;min-height:0;border-radius:0 0 10px 10px;width:100%"></iframe>
  </div>
</div>

<!-- Manage Watchlists modal -->
<div id="watchlist-modal" class="modal-bg" onclick="if(event.target===this)closeWatchlistModal()" style="display:none">
  <div style="background:#fff;border-radius:10px;width:90%;max-width:900px;height:80vh;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,.3)">
    <div class="modal-header" style="border-bottom:1px solid #e2e8f0">
      <div class="modal-title">Manage Watchlists</div>
      <button class="modal-close" onclick="closeWatchlistModal()">✕</button>
    </div>
    <div style="display:flex;flex:1;min-height:0;gap:12px;padding:16px;overflow:hidden">
      <!-- Left panel: Watchlist groups -->
      <div style="width:30%;border-right:1px solid #e2e8f0;display:flex;flex-direction:column;overflow:hidden">
        <div style="font-size:12px;font-weight:600;color:#4a5568;margin-bottom:8px">Watchlists</div>
        <div style="flex:1;overflow-y:auto;border:1px solid #e2e8f0;border-radius:6px;margin-bottom:8px">
          <div id="watchlist-groups-list" style="padding:8px"></div>
        </div>
        <div style="display:flex;gap:4px">
          <input id="new-group-name" type="text" placeholder="New watchlist name" style="flex:1;padding:6px;border:1px solid #cbd5e0;border-radius:4px;font-size:12px" />
          <button onclick="createGroup()" class="btn" style="background:#48bb78;color:#fff;font-size:11px;padding:6px 10px">Add</button>
        </div>
      </div>
      <!-- Right panel: Stock search and selection -->
      <div style="flex:1;display:flex;flex-direction:column;overflow:hidden">
        <div style="margin-bottom:8px">
          <input id="stock-search" type="text" placeholder="Search by ticker or name" onkeyup="searchStocks(this.value)" style="width:100%;padding:6px;border:1px solid #cbd5e0;border-radius:4px;font-size:12px" />
        </div>
        <div style="margin-bottom:8px;display:flex;align-items:center;gap:6px">
          <input id="select-all-checkbox" type="checkbox" onchange="toggleSelectAll()" />
          <label for="select-all-checkbox" style="font-size:12px;color:#4a5568;cursor:pointer;user-select:none">Select All Visible</label>
        </div>
        <div id="stocks-list" style="flex:1;overflow-y:auto;border:1px solid #e2e8f0;border-radius:6px;padding:8px;background:#f9fafb"></div>
        <div style="margin-top:8px">
          <button id="add-stocks-btn" onclick="addSelectedToGroup()" class="btn" style="width:100%;background:#3182ce;color:#fff;font-size:12px;padding:8px">Add Selected to [Group]</button>
        </div>
      </div>
    </div>
  </div>
</div>

</body></html>`);
  } catch (err) {
    res.status(500).send(`<pre>Error: ${err.message}\n${err.stack}</pre>`);
  }
});

// ─── Add ticker ───────────────────────────────────────────────────────────────
app.post('/watchlist/add', async (req, res) => {
  const symbol = (req.body.symbol || '').toUpperCase().trim();
  if (!symbol) return res.redirect('/');
  try {
    await yh.addTicker(symbol);
    await yh.fetchHistory(symbol, true);
    const q = await yh.fetchQuote(symbol);
    if (q) {
      await db.query(`UPDATE watchlist SET name=?, sector=?, asset_type=? WHERE symbol=?`,
        [q.name, q.sector, q.assetType, symbol]);
      await analyzeSymbol(symbol, q);
    }
    res.redirect('/');
  } catch (err) {
    res.redirect('/?error=' + encodeURIComponent(err.message));
  }
});

// ─── Remove ticker ────────────────────────────────────────────────────────────
app.get('/watchlist/remove/:symbol', async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const positions = await getAlpacaPositions().catch(() => []);
  if (positions.some(p => p.symbol === sym)) {
    return res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">${STYLE}</head><body>
      <div style="padding:60px 24px;max-width:480px;margin:0 auto;text-align:center">
        <div style="font-size:52px;margin-bottom:16px">⚠️</div>
        <h2 style="color:#c53030;margin-bottom:12px">Cannot Remove ${sym}</h2>
        <p style="color:#4a5568;line-height:1.6;margin-bottom:24px">
          <strong>${sym}</strong> is currently in your portfolio.<br>
          Sell your position first, then remove it from the watchlist.
        </p>
        <a href="/" class="btn btn-primary">← Back to Dashboard</a>
      </div></body></html>`);
  }
  await yh.removeTicker(sym);
  res.redirect('/');
});

// ─── Toggle Pick/No Pick flag ────────────────────────────────────────────────
app.get('/watchlist/toggle-pick/:symbol', async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  // If stock not in watchlist, INSERT with pick_flag=1; if exists, toggle flag
  await db.query(
    `INSERT INTO watchlist (symbol, pick_flag, is_active) VALUES (?, 1, 1)
     ON DUPLICATE KEY UPDATE pick_flag = 1 - pick_flag`,
    [sym]
  );
  res.redirect('/');
});

// ─── Bulk toggle pick flag ───────────────────────────────────────────────────
app.post('/watchlist/toggle-pick-bulk', express.json(), async (req, res) => {
  const symbols = req.body.symbols;
  if (!Array.isArray(symbols) || symbols.length === 0)
    return res.status(400).json({ error: 'No symbols' });
  for (const sym of symbols) {
    await db.query(
      `INSERT INTO watchlist (symbol, pick_flag, is_active) VALUES (?, 1, 1)
       ON DUPLICATE KEY UPDATE pick_flag = 1 - pick_flag`,
      [sym.toUpperCase()]
    );
  }
  res.json({ ok: true, toggled: symbols.length });
});

// ─── Add from Discover section (GET, one-click) ───────────────────────────────
app.get('/watchlist/add-quick/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase().trim();
  try {
    await yh.addTicker(symbol);
    await yh.fetchHistory(symbol, false); // bars already fetched by universe scan
    const q = await yh.fetchQuote(symbol);
    if (q) {
      await db.query(
        `UPDATE watchlist SET name=?, sector=?, asset_type=? WHERE symbol=?`,
        [q.name, q.sector, q.assetType, symbol]
      );
      await analyzeSymbol(symbol, q);
    }
  } catch (_) {}
  res.redirect('/');
});

// ─── Phoenix toggle ───────────────────────────────────────────────────────────
app.get('/phoenix/toggle', async (req, res) => {
  try {
    const row     = await db.queryOne(`SELECT config_value FROM system_config WHERE config_group='phoenix' AND config_key='phoenix_enabled'`);
    const current = row?.config_value === '1';
    await db.query(
      `INSERT INTO system_config (config_group, config_key, config_value)
       VALUES ('phoenix', 'phoenix_enabled', ?)
       ON DUPLICATE KEY UPDATE config_value=VALUES(config_value)`,
      [current ? '0' : '1']
    );
    await db.log('info', 'phoenix', `Phoenix toggled ${current ? 'ON→OFF' : 'OFF→ON'}`);
    res.redirect('/');
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// ─── Phoenix docs ─────────────────────────────────────────────────────────────
app.get('/docs/phoenix', (req, res) => {
  const fs = require('fs');
  const f  = require('path').join(__dirname, 'phoenix_strategy.html');
  if (fs.existsSync(f)) res.sendFile(f);
  else res.status(404).send('Phoenix strategy doc not found');
});

// ─── Phoenix manual execute ───────────────────────────────────────────────────
app.get('/phoenix/execute-now', async (req, res) => {
  res.json({ status: 'started', message: 'Phoenix autotrader executing — check /autotrader/history and email' });
  try { await phoenixRun(); } catch (e) { console.error('[Manual Phoenix]', e.message); }
});

// ─── Manual refresh ───────────────────────────────────────────────────────────
app.get('/refresh-now', (req, res) => {
  res.redirect('/');
  setImmediate(() => runDailyRefresh(false).catch(console.error));
});

// ─── Refresh price targets (background, slow Yahoo pass) ─────────────────────
app.get('/refresh-targets', (req, res) => {
  res.redirect('/?msg=targets-refresh-started');
  setImmediate(() => yh.refreshTargets().catch(console.error));
});

// ─── Performance chart data ───────────────────────────────────────────────────
// Returns bars for symbol + benchmarks. Symbol bars include ma50/ma200 fields.
app.get('/position-chart/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase().replace(/[^A-Z0-9.]/g, '');
  const period  = req.query.period || '1y';
  const rawB    = req.query.benchmarks || '';
  const allowed = new Set(['SPY','QQQ','DIA']);
  const benchmarks = rawB ? rawB.split(',').map(s => s.toUpperCase()).filter(s => allowed.has(s)) : [];

  // Calendar days for the display window + 300 extra trading days for SMA200 warmup
  const calDays = { '1m': 50, '3m': 100, '6m': 200, '1y': 390, '2y': 780, '5y': 1950 };
  const displayDays = calDays[period] || 390;
  const maDays = displayDays + 430; // enough history for SMA200 on any period

  function sma(closes, period) {
    return closes.map((_, i) => {
      if (i < period - 1) return null;
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += closes[j];
      return sum / period;
    });
  }

  try {
    const [symbolBars, ...benchResults] = await Promise.all([
      getDailyBars(symbol, maDays),
      ...benchmarks.map(s => getDailyBars(s, displayDays)),
    ]);

    // Compute MAs over full history, then slice to display window
    const allCloses = symbolBars.map(b => b.close);
    const ma50arr   = sma(allCloses, 50);
    const ma200arr  = sma(allCloses, 200);
    const sliceFrom = Math.max(0, symbolBars.length - displayDays);

    const out = {};
    out[symbol] = symbolBars.slice(sliceFrom).map((b, i) => {
      const idx = sliceFrom + i;
      return {
        date:  new Date(b.date).toISOString().split('T')[0],
        close: b.close,
        ma50:  ma50arr[idx],
        ma200: ma200arr[idx],
      };
    });

    benchmarks.forEach((s, i) => {
      out[s] = benchResults[i].map(b => ({
        date:  new Date(b.date).toISOString().split('T')[0],
        close: b.close,
      }));
    });

    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Manual universe scan ─────────────────────────────────────────────────────
app.get('/scan-universe', (req, res) => {
  const { scanUniverse } = require('./portfolio_app/universe');
  res.redirect('/');
  setImmediate(() => scanUniverse().catch(console.error));
});

// ─── Autorun toggle ───────────────────────────────────────────────────────────
// Plain <a href> per UI design rules — no JS required for navigation-critical action
app.get('/autorun/toggle', async (req, res) => {
  try {
    const row     = await db.queryOne(`SELECT config_value FROM system_config WHERE config_group='autotrader' AND config_key='autorun_enabled'`);
    const current = row?.config_value === '1';
    const newVal  = current ? '0' : '1';
    await db.query(
      `INSERT INTO system_config (config_group, config_key, config_value)
       VALUES ('autotrader', 'autorun_enabled', ?)
       ON DUPLICATE KEY UPDATE config_value=?, updated_at=NOW()`,
      [newVal, newVal]
    );
    await db.log('info', 'autorun', `Autorun toggled ${current ? 'ON→OFF' : 'OFF→ON'}`);
    const { sendModeChangeEmail } = require('./notifier/email');
    sendModeChangeEmail(newVal === '1' ? 'ON' : 'OFF').catch(console.error);
    res.redirect('/');
  } catch (err) {
    console.error('[Autorun toggle]', err.message);
    res.redirect('/');
  }
});

app.get('/autorun/status', async (req, res) => {
  const row = await db.queryOne(`SELECT config_value FROM system_config WHERE config_group='autotrader' AND config_key='autorun_enabled'`);
  res.json({ autorun: row?.config_value === '1' });
});

app.get('/autorun/execute-now', async (req, res) => {
  res.json({ status: 'started', message: 'Autotrader executing — check /autotrader/history and email for results' });
  try {
    await autoRun();
  } catch (e) {
    console.error('[Manual autoRun] Error:', e.message);
  }
});

// ─── Place order (buy or sell) ────────────────────────────────────────────────
app.post('/order', async (req, res) => {
  try {
    const { symbol, qty, side, type, timeInForce, limitPrice, extendedHours } = req.body;
    if (!symbol || !qty || !type) return res.status(400).json({ error: 'symbol, qty, type required' });
    const orderSide = side === 'sell' ? 'sell' : 'buy';
    if (type === 'limit' && (!limitPrice || parseFloat(limitPrice) <= 0))
      return res.status(400).json({ error: 'limitPrice required for limit orders' });

    const sym = String(symbol).toUpperCase();

    // Prevent short selling — check available shares before allowing sell
    if (orderSide === 'sell') {
      try {
        const positions = await getAlpacaPositions().catch(() => []);
        const holding = positions.find(p => p.symbol === sym);
        const availableQty = holding ? parseInt(holding.qty_available || holding.qty || 0) : 0;
        if (availableQty < parseInt(qty)) {
          return res.status(400).json({
            error: `Cannot sell ${qty} shares — only ${availableQty} available. Short selling not allowed.`
          });
        }
      } catch (e) {
        return res.status(500).json({ error: `Failed to check position: ${e.message}` });
      }
    }

    const order = await placeDirectOrder({
      symbol:        sym,
      qty:           parseInt(qty),
      side:          orderSide,
      type,
      timeInForce:   timeInForce || 'day',
      limitPrice:    limitPrice ? parseFloat(limitPrice) : null,
      extendedHours: !!extendedHours,
    });
    await db.log('info', 'portfolio_order',
      `${orderSide} order: ${qty} ${sym} ${type} ${timeInForce}`, { orderId: order.id });

    // For manual buys: set autotrader=OFF only if this is a NEW position (not already held)
    if (orderSide === 'buy') {
      const existing = await db.queryOne(
        `SELECT symbol FROM position_flags WHERE symbol=?`, [sym]
      );
      if (!existing) {
        await db.query(
          `INSERT INTO position_flags (symbol, autotrader_on) VALUES (?,0)
           ON DUPLICATE KEY UPDATE autotrader_on=0, updated_at=NOW()`,
          [sym]
        );
      }
    }

    res.json({ id: order.id, status: order.status });
  } catch (err) {
    console.error('[Order]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Autotrader flag toggle ───────────────────────────────────────────────────
app.get('/position/:symbol/toggle-autotrader', async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const row = await db.queryOne(`SELECT autotrader_on FROM position_flags WHERE symbol=?`, [sym]);
  const newVal = row ? (row.autotrader_on ? 0 : 1) : 1;
  await db.query(
    `INSERT INTO position_flags (symbol, autotrader_on) VALUES (?,?)
     ON DUPLICATE KEY UPDATE autotrader_on=VALUES(autotrader_on), updated_at=NOW()`,
    [sym, newVal]
  );
  res.redirect('/');
});

// ─── Cancel order ─────────────────────────────────────────────────────────────
app.get('/order/:id/cancel', async (req, res) => {
  try { await cancelAlpacaOrder(req.params.id); } catch (_) {}
  res.redirect('/');
});

// ─── APIs ─────────────────────────────────────────────────────────────────────
app.get('/api/stocks', async (req, res) => {
  try {
    const data = await db.query(`SELECT symbol, name FROM stock_signals ORDER BY symbol`);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get('/api/positions', async (req, res) => {
  const [positions, orders] = await Promise.all([
    getAlpacaPositions().catch(() => []),
    getOpenOrders().catch(() => []),
  ]);
  res.json({ positions, orders });
});

app.get('/api/transactions', async (req, res) => {
  try {
    // Get autotrader transactions
    const autotraderTxns = await db.query(`
      SELECT
        id,
        symbol,
        action,
        qty as shares,
        price,
        executed_at as timestamp,
        'autotrader' as source,
        strategy,
        CASE WHEN action = 'buy' THEN entry_reason ELSE exit_reason END AS reason,
        ROUND(qty * price, 2) AS total_amount
      FROM autotrader_trades
      ORDER BY executed_at DESC
      LIMIT 200
    `);

    // Get manual trades (filled only)
    const manualTxns = await db.query(`
      SELECT
        id,
        symbol,
        side as action,
        shares,
        COALESCE(fill_price, entry_price) as price,
        COALESCE(filled_at, approved_at, created_at) as timestamp,
        'manual' as source,
        NULL as strategy,
        COALESCE(close_reason, 'pending') as reason,
        ROUND(shares * COALESCE(fill_price, entry_price), 2) AS total_amount,
        pnl,
        pnl_pct
      FROM trades
      WHERE status IN ('filled', 'closed')
      ORDER BY filled_at DESC
      LIMIT 200
    `);

    // Combine and sort by timestamp
    const combined = [...autotraderTxns, ...manualTxns]
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 200);

    res.json({ success: true, data: combined });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/docs/scoring', (_, res) => res.sendFile(require('path').join(__dirname, 'scoringmethodology.html')));
app.get('/health', (_, res) => res.json({ status: 'ok', port: PORT, mode: cfg.alpaca.isPaper ? 'paper' : 'live' }));

// ─── News ─────────────────────────────────────────────────────────────────────
// source=finnhub (default): Finnhub /company-news — cached in news_cache table
// source=sec: SEC EDGAR Atom RSS — 8-K and material filings, no API key needed
app.get('/news/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase().replace(/[^A-Z0-9.]/g, '');
  const source = req.query.source === 'sec' ? 'sec' : 'finnhub';
  try {
    if (source === 'sec') {
      const axios = require('axios');
      const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(symbol)}&type=8-K&dateb=&owner=include&count=10&search_text=&output=atom`;
      const resp = await axios.get(url, {
        timeout: 8000,
        headers: { 'User-Agent': 'StockTrader/1.0 stocktrader-app/contact' },
      });
      const xml = resp.data;
      const articles = [];
      const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
      let m;
      while ((m = entryRe.exec(xml)) !== null) {
        const e     = m[1];
        const title = (/<title[^>]*>([\s\S]*?)<\/title>/.exec(e) || [])[1];
        const link  = (/<link[^>]+href="([^"]+)"/.exec(e) || [])[1];
        const date  = (/<updated>([\s\S]*?)<\/updated>/.exec(e) || [])[1];
        if (title && link) {
          articles.push({
            headline:    title.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim(),
            source:      'SEC EDGAR',
            url:         link.startsWith('http') ? link : 'https://www.sec.gov' + link,
            publishedAt: date || null,
          });
        }
      }
      return res.json({ articles: articles.slice(0, 10) });
    }

    // Finnhub — already cached in news_cache
    const finnhub = require('./data/finnhub');
    const raw = await finnhub.getNews(symbol, 72);
    const articles = raw.map(a => ({
      headline:    a.headline,
      source:      a.source,
      url:         a.url,
      publishedAt: a.publishedAt || a.published_at || null,
    }));
    res.json({ articles });
  } catch (err) {
    res.status(500).json({ error: err.message, articles: [] });
  }
});

// ─── Autotrader History ───────────────────────────────────────────────────────
app.get('/autotrader/history', async (req, res) => {
  try {
    const [trades, logs] = await Promise.all([
      db.query(`SELECT * FROM autotrader_trades ORDER BY executed_at DESC LIMIT 200`),
      db.query(`SELECT level, module, message, created_at FROM system_log
                WHERE module IN ('autotrader','autorun','phoenix')
                ORDER BY created_at DESC LIMIT 200`),
    ]);

    const buys  = trades.filter(t => t.action === 'buy');
    const sells = trades.filter(t => t.action === 'sell');
    const syms  = [...new Set(trades.map(t => t.symbol))];

    const tradeRows = trades.map(t => {
      const badge = t.action === 'buy'
        ? `<span style="background:#f0fff4;color:#276749;border:1px solid #9ae6b4;padding:2px 8px;border-radius:9px;font-size:11px;font-weight:700">BUY</span>`
        : `<span style="background:#fff5f5;color:#9b2c2c;border:1px solid #feb2b2;padding:2px 8px;border-radius:9px;font-size:11px;font-weight:700">SELL</span>`;
      const stratBadge = (t.strategy || 'alpha') === 'phoenix'
        ? `<span style="background:#faf5ff;color:#6b21a8;border:1px solid #d8b4fe;padding:2px 7px;border-radius:9px;font-size:10px;font-weight:700">🔥 Phoenix</span>`
        : `<span style="background:#eff6ff;color:#1e40af;border:1px solid #bfdbfe;padding:2px 7px;border-radius:9px;font-size:10px;font-weight:700">⚡ Alpha</span>`;
      const pct  = t.sell_pct ? `${t.sell_pct}%` : '—';
      const date = new Date(t.executed_at).toLocaleString('en-US', { timeZone: 'America/New_York', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
      const reason = t.exit_reason ? `<span style="color:#718096;font-size:12px">${t.exit_reason}</span>` : '—';
      return `<tr>
        <td>${date} ET</td>
        <td><strong>${t.symbol}</strong></td>
        <td>${badge}</td>
        <td>${stratBadge}</td>
        <td>${t.qty}</td>
        <td>${pct}</td>
        <td>${reason}</td>
        <td style="font-size:11px;color:#a0aec0">${t.alpaca_order_id || '—'}</td>
      </tr>`;
    }).join('') || `<tr><td colspan="8" style="text-align:center;color:#718096;padding:32px">No trades executed yet — autotrader hasn't run in execute mode</td></tr>`;

    const logRows = logs.map(l => {
      const color = l.level === 'error' ? '#9b2c2c' : l.level === 'warn' ? '#744210' : '#2b6cb0';
      const bg    = l.level === 'error' ? '#fff5f5' : l.level === 'warn' ? '#fffff0' : '#ebf8ff';
      const date  = new Date(l.created_at).toLocaleString('en-US', { timeZone: 'America/New_York', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
      return `<tr>
        <td>${date} ET</td>
        <td><span style="background:${bg};color:${color};padding:1px 7px;border-radius:9px;font-size:11px;font-weight:700">${l.level.toUpperCase()}</span></td>
        <td style="font-size:12px;color:#718096">${l.module}</td>
        <td style="font-size:13px">${l.message}</td>
      </tr>`;
    }).join('') || `<tr><td colspan="4" style="text-align:center;color:#718096;padding:32px">No log entries yet</td></tr>`;

    const modeBadge = cfg.alpaca.isPaper
      ? `<span style="background:#ebf8ff;color:#2b6cb0;border:1px solid #bee3f8;padding:3px 10px;border-radius:9px;font-size:12px;font-weight:700">PAPER</span>`
      : `<span style="background:#fff5f5;color:#9b2c2c;border:1px solid #feb2b2;padding:3px 10px;border-radius:9px;font-size:12px;font-weight:700">LIVE</span>`;

    res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Autotrader History</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7f9fc;color:#1a202c;font-size:14px}
.header{background:linear-gradient(135deg,#1a365d,#2c5282);padding:18px 32px;color:#fff;display:flex;align-items:center;gap:16px}
.header h1{font-size:20px;font-weight:700}
.header a{color:#90cdf4;font-size:13px;text-decoration:none;margin-left:auto}
.header a:hover{text-decoration:underline}
.content{padding:28px 32px;max-width:1200px}
.cards{display:flex;gap:16px;margin-bottom:24px;flex-wrap:wrap}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px 24px;min-width:140px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.card .val{font-size:28px;font-weight:700;color:#2c5282}
.card .lbl{font-size:12px;color:#718096;margin-top:4px;text-transform:uppercase;letter-spacing:.5px}
h2{font-size:16px;font-weight:700;color:#2c5282;margin:28px 0 12px;padding-bottom:8px;border-bottom:2px solid #e2e8f0}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;margin-bottom:8px}
th{background:#f0f4f8;color:#4a5568;text-align:left;padding:9px 14px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid #e2e8f0;white-space:nowrap}
td{padding:9px 14px;border-bottom:1px solid #edf2f7;vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:#f7fafc}
</style></head><body>
<div class="header">
  <h1>🤖 Autotrader History</h1>
  ${modeBadge}
  <a href="/">← Back to Dashboard</a>
</div>
<div class="content">

  <div class="cards">
    <div class="card"><div class="val">${trades.length}</div><div class="lbl">Total Trades</div></div>
    <div class="card"><div class="val" style="color:#276749">${buys.length}</div><div class="lbl">Buys Executed</div></div>
    <div class="card"><div class="val" style="color:#9b2c2c">${sells.length}</div><div class="lbl">Sells Executed</div></div>
    <div class="card"><div class="val">${syms.length}</div><div class="lbl">Symbols Traded</div></div>
    <div class="card"><div class="val">${logs.length}</div><div class="lbl">Log Entries</div></div>
  </div>

  <h2>📋 Trade History</h2>
  <table>
    <tr><th>Date / Time</th><th>Symbol</th><th>Action</th><th>Strategy</th><th>Qty</th><th>Sell %</th><th>Reason</th><th>Order ID</th></tr>
    ${tradeRows}
  </table>

  <h2>📝 Decision Log</h2>
  <table>
    <tr><th>Date / Time</th><th>Level</th><th>Module</th><th>Message</th></tr>
    ${logRows}
  </table>

</div></body></html>`);
  } catch (err) {
    res.status(500).send(`<pre>Error: ${err.message}</pre>`);
  }
});

// ─── Real-time prices endpoint ────────────────────────────────────────────────
// ─── TradingView chart page (served into iframe) ──────────────────────────────
app.get('/tv-chart/:symbol', (req, res) => {
  const sym = req.params.symbol.toUpperCase().replace(/[^A-Z0-9.]/g, '');
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>html,body{margin:0;padding:0;height:100%;overflow:hidden}#chart{height:100%;width:100%}</style>
</head><body>
<div id="chart"></div>
<script src="https://s3.tradingview.com/tv.js"></script>
<script>
new TradingView.widget({
  container_id: 'chart',
  autosize: true,
  symbol: '${sym}',
  interval: 'D',
  timezone: 'America/New_York',
  theme: 'light',
  style: '2',
  locale: 'en',
  range: '12M',
  withdateranges: true,
  hide_side_toolbar: false,
  allow_symbol_change: true,
  save_image: true,
  studies: [
    { id: 'MASimple@tv-basicstudies', inputs: { length: 50 },
      overrides: { 'ma.color': '#E53E3E', 'ma.linewidth': 2 } },
    { id: 'MASimple@tv-basicstudies', inputs: { length: 200 },
      overrides: { 'ma.color': '#2B6CB0', 'ma.linewidth': 2 } }
  ],
  overrides: {
    'mainSeriesProperties.lineStyle.color': '#000000',
    'mainSeriesProperties.lineStyle.linewidth': 2
  }
});
</script>
</body></html>`);
});

// ─── SETTINGS PAGE ────────────────────────────────────────────────────────────
const settings = require('./portfolio_app/settings');

app.get('/settings', async (req, res) => {
  try {
    const allSettings = await settings.getSettings();
    const signalWeights = await settings.getSignalWeights();
    const marketRegime = await settings.getMarketRegime();
    const changelog = await settings.getChangelog(10);

    // Format changelog for display
    const changeLog = changelog.map(log => {
      // mysql2 auto-parses JSON columns
      const changes = log.change_json
        ? (typeof log.change_json === 'string' ? JSON.parse(log.change_json) : log.change_json)
        : {};
      return {
        time: new Date(log.changed_at).toLocaleString('en-US', {timeZone:'America/New_York',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}),
        category: log.category,
        changedBy: log.changed_by,
        changes
      };
    });

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Autotrader Settings</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      margin: 0;
      padding: 0;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 30px;
      border-bottom: 2px solid #1e293b;
      padding-bottom: 15px;
    }
    .header h1 {
      margin: 0;
      font-size: 24px;
      color: #f1f5f9;
    }
    .header-buttons {
      display: flex;
      gap: 10px;
    }
    .btn {
      padding: 8px 16px;
      border: 1px solid #475569;
      background: #1e293b;
      color: #e2e8f0;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      transition: all 0.2s;
    }
    .btn:hover { background: #334155; }
    .btn.primary {
      background: #3b82f6;
      border-color: #2563eb;
      color: white;
    }
    .btn.primary:hover { background: #2563eb; }
    .btn.danger {
      background: #dc2626;
      border-color: #991b1b;
      color: white;
    }
    .btn.danger:hover { background: #b91c1c; }

    .tabs {
      display: flex;
      gap: 0;
      margin-bottom: 20px;
      border-bottom: 2px solid #1e293b;
      flex-wrap: wrap;
    }
    .tab-btn {
      padding: 12px 20px;
      background: none;
      border: none;
      color: #94a3b8;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      border-bottom: 3px solid transparent;
      transition: all 0.2s;
      white-space: nowrap;
    }
    .tab-btn:hover { color: #cbd5e1; }
    .tab-btn.active {
      color: #3b82f6;
      border-bottom-color: #3b82f6;
    }

    .tab-content {
      display: none;
      animation: fadeIn 0.3s ease-in;
    }
    .tab-content.active { display: block; }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

    .section {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .section h3 {
      margin: 0 0 15px 0;
      font-size: 16px;
      color: #f1f5f9;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .info-banner {
      background: #1e3a8a;
      border-left: 4px solid #3b82f6;
      padding: 12px 15px;
      margin-bottom: 15px;
      border-radius: 4px;
      font-size: 12px;
      color: #bfdbfe;
    }
    .setting-group {
      margin-bottom: 20px;
      padding-bottom: 20px;
      border-bottom: 1px solid #334155;
    }
    .setting-group:last-child { border-bottom: none; }

    .setting-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      align-items: center;
      margin-bottom: 15px;
    }
    .setting-row.full { grid-template-columns: 1fr; }

    .setting-label {
      font-size: 13px;
      color: #cbd5e1;
      font-weight: 500;
    }
    .setting-help {
      font-size: 11px;
      color: #64748b;
      margin-top: 4px;
    }

    .input-group {
      display: flex;
      gap: 10px;
      align-items: center;
    }
    input[type="number"], input[type="text"], select {
      padding: 8px 12px;
      background: #0f172a;
      border: 1px solid #475569;
      color: #e2e8f0;
      border-radius: 4px;
      font-size: 13px;
      flex: 1;
    }
    input[type="number"] { width: 80px; }
    input[type="number"]:focus, input[type="text"]:focus, select:focus {
      outline: none;
      border-color: #3b82f6;
      box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.1);
    }

    .signal-weights-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 15px;
    }
    .signal-card {
      background: #0f172a;
      border: 1px solid #334155;
      padding: 12px;
      border-radius: 4px;
    }
    .signal-card .name {
      font-size: 13px;
      font-weight: 600;
      color: #f1f5f9;
      margin-bottom: 4px;
    }
    .signal-card .type {
      font-size: 11px;
      color: #64748b;
      margin-bottom: 8px;
    }
    .signal-card .weight-input {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .signal-card input {
      flex: 1;
    }

    .status-badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      margin-right: 8px;
    }
    .status-badge.bull { background: #1a3a1a; color: #86efac; }
    .status-badge.caution { background: #3d2a00; color: #fbbf24; }
    .status-badge.bear { background: #742a2a; color: #fca5a5; }
    .status-badge.unknown { background: #1e293b; color: #94a3b8; }

    .changelog {
      max-height: 300px;
      overflow-y: auto;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 4px;
      padding: 12px;
    }
    .changelog-entry {
      font-size: 12px;
      padding: 8px;
      border-bottom: 1px solid #334155;
      color: #cbd5e1;
    }
    .changelog-entry:last-child { border-bottom: none; }
    .changelog-time {
      font-weight: 600;
      color: #94a3b8;
    }

    .status-message {
      padding: 12px 15px;
      border-radius: 4px;
      margin-bottom: 15px;
      font-size: 13px;
      display: none;
    }
    .status-message.show { display: block; }
    .status-message.success {
      background: #1a3a1a;
      border: 1px solid #4ade80;
      color: #86efac;
    }
    .status-message.error {
      background: #742a2a;
      border: 1px solid #f87171;
      color: #fca5a5;
    }
  </style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>🔧 Autotrader Settings</h1>
    <div class="header-buttons">
      <a href="/" class="btn" style="background:rgba(255,255,255,.15);color:#e2e8f0">← Dashboard</a>
      <button class="btn" onclick="resetAllToDefaults()">Reset to Defaults</button>
      <button class="btn primary" onclick="saveAllChanges()">Save Changes</button>
    </div>
  </div>

  <div id="statusMessage" class="status-message"></div>

  <div class="tabs">
    <button class="tab-btn active" onclick="switchTab('tab1')">1. Market Regime</button>
    <button class="tab-btn" onclick="switchTab('tab2')">2. Eligibility Gates</button>
    <button class="tab-btn" onclick="switchTab('tab3')">3. Buy Criteria</button>
    <button class="tab-btn" onclick="switchTab('tab4')">4. Sell/Exit</button>
    <button class="tab-btn" onclick="switchTab('tab5')">5. Score Formula</button>
    <button class="tab-btn" onclick="switchTab('tab6')">6. Signal Weights</button>
    <button class="tab-btn" onclick="switchTab('tab7')">7. Golden Cross</button>
    <button class="tab-btn" onclick="switchTab('tab8')">8. Position Limits</button>
  </div>

  <!-- TAB 1: MARKET REGIME (Read-only) -->
  <div id="tab1" class="tab-content active">
    <div class="section">
      <h3>📊 Market Regime (Informational - Read Only)</h3>
      <div class="info-banner">
        Market regime is determined by SPY position relative to moving averages. This controls whether autotrader can enter new positions.
      </div>

      <div class="setting-row full">
        <div>
          <div class="setting-label">Current Regime</div>
          <div style="margin-top: 8px; font-size: 14px;">
            <span class="status-badge ${marketRegime.regime}">${marketRegime.regime.toUpperCase()}</span>
            <span style="color: #94a3b8;">${marketRegime.details}</span>
          </div>
        </div>
      </div>

      <div class="setting-group">
        <h3>Regime Rules</h3>
        <div style="font-size: 13px; color: #cbd5e1; line-height: 1.8;">
          <p><strong style="color: #86efac;">BULL:</strong> SPY > 200MA AND SPY > 50MA → Entries Allowed</p>
          <p><strong style="color: #fbbf24;">CAUTION:</strong> SPY > 200MA BUT SPY < 50MA → No Entries (correction in progress)</p>
          <p><strong style="color: #fca5a5;">BEAR:</strong> SPY < 200MA → No Entries (bear market)</p>
          <p><strong style="color: #94a3b8;">UNKNOWN:</strong> SPY not found → No Entries (safe default)</p>
        </div>
      </div>
    </div>
  </div>

  <!-- TAB 2: ELIGIBILITY GATES -->
  <div id="tab2" class="tab-content">
    <div class="section">
      <h3>✓ Eligibility Gates (5 Required to Pass)</h3>
      <div class="info-banner">
        All 5 gates must pass for a stock to be marked "✓ Eligible". Any failure = "⚠ Blocked"
      </div>

      <div class="setting-group">
        <div class="setting-label">Gate 2: Score Threshold</div>
        <div class="setting-help">Minimum score % required (0-100)</div>
        <div class="input-group">
          <input type="number" id="scoreThreshold" min="0" max="100" value="${allSettings.gates.score_threshold}" />%
        </div>
      </div>

      <div class="setting-group">
        <div class="setting-label">Gate 3: RSI Window</div>
        <div class="setting-help">RSI must be within this range (avoid oversold <30 and overbought >70)</div>
        <div class="input-group">
          <input type="number" id="rsiMin" min="0" max="50" value="${allSettings.gates.rsi_min}" /> to <input type="number" id="rsiMax" min="50" max="100" value="${allSettings.gates.rsi_max}" />
        </div>
      </div>

      <div class="setting-group">
        <div class="setting-label">Gate 4: Overextension Limit</div>
        <div class="setting-help">Max % above 50-day moving average (entry risk if too extended)</div>
        <div class="input-group">
          <input type="number" id="overextensionPct" min="0" max="50" step="0.5" value="${allSettings.gates.overextension_pct}" />%
        </div>
      </div>

      <div class="setting-group">
        <div class="setting-label">Gate 5: Tier 1 Confirmations</div>
        <div class="setting-help">Minimum technical confirmations needed (RSI window, MACD bullish, >50MA, volume)</div>
        <div class="input-group">
          <input type="number" id="minConfirmations" min="1" max="4" value="${allSettings.gates.min_confirmations}" /> of 4
        </div>
      </div>
    </div>
  </div>

  <!-- TAB 3: BUY ENTRY CRITERIA -->
  <div id="tab3" class="tab-content">
    <div class="section">
      <h3>📈 Buy Entry Criteria</h3>
      <div class="info-banner">
        pick_flag=1 is REQUIRED and cannot be disabled. This ensures only manually marked stocks are bought.
      </div>

      <div class="setting-group">
        <div class="setting-label">Minimum Price</div>
        <div class="setting-help">Avoid penny stocks and micro-caps</div>
        <div class="input-group">
          <input type="number" id="minPrice" min="1" step="0.50" value="${allSettings.buy.min_price}" />
        </div>
      </div>

      <div class="setting-group">
        <div class="setting-label">Pick Flag</div>
        <div style="font-size: 13px; color: #cbd5e1; margin-top: 8px;">
          <strong>✓ REQUIRED AND CANNOT BE DISABLED</strong><br/>
          Only stocks with pick_flag=1 in watchlist can be bought
        </div>
      </div>

      <div class="setting-group">
        <div class="setting-label">Exclude Stocks with Earnings Within</div>
        <div class="setting-help">Avoid earnings volatility (days ahead)</div>
        <div class="input-group">
          <input type="number" id="excludeEarningsDays" min="0" max="30" value="${allSettings.buy.exclude_earnings_days}" /> days
        </div>
      </div>
    </div>
  </div>

  <!-- TAB 4: SELL/EXIT CRITERIA -->
  <div id="tab4" class="tab-content">
    <div class="section">
      <h3>🔴 Exit Rules</h3>
      <div class="info-banner">
        4 exit layers evaluate sequentially. Applies only to autotrader positions. After SELL_100, stock marked as "No Pick".
      </div>

      <div class="setting-group">
        <div class="setting-label">Layer 1: Hard Stop Loss %</div>
        <div class="setting-help">Price ≤ entry × (1 - X%) → SELL_100 (capital protection)</div>
        <div class="input-group">
          <input type="number" id="hardStopPct" min="-50" max="0" step="0.5" value="${allSettings.sell.hard_stop_pct}" />%
        </div>
      </div>

      <div class="setting-group">
        <div class="setting-label">Layer 2: Trailing Stop Activation</div>
        <div class="setting-help">Trailing stop only activates after gain ≥ X% (e.g., +5%)</div>
        <div class="input-group">
          <input type="number" id="trailingActivationPct" min="0" max="50" step="0.5" value="${allSettings.sell.trailing_stop_activation_pct}" />%
        </div>
      </div>

      <div class="setting-group">
        <div class="setting-label">Layer 2: Trailing Stop %</div>
        <div class="setting-help">Price ≤ peak × (1 - X%) → SELL_100 (profit protection)</div>
        <div class="input-group">
          <input type="number" id="trailingStopPct" min="1" max="30" step="0.5" value="${allSettings.sell.trailing_stop_pct}" />%
        </div>
      </div>

      <div class="setting-group">
        <div class="setting-label">Layer 3: RSI Overbought + Extended Price</div>
        <div class="setting-help">RSI ≥ 75 AND price ≥ X% above 50DMA → SELL_100</div>
        <div class="input-group">
          <input type="number" id="extendedPricePct" min="0" max="50" step="0.5" value="${allSettings.sell.extended_price_pct}" />%
        </div>
      </div>

      <div class="setting-group">
        <div style="background: #1a202c; padding: 12px; border-radius: 4px; border-left: 3px solid #3182ce;">
          <div class="setting-label">Layer 4: pre_sell_score (Auto-calculated)</div>
          <div style="font-size: 12px; color: #cbd5e1; margin-top: 8px; line-height: 1.6;">
            <strong>Checks 5 conditions:</strong><br/>
            • Price &lt; 50DMA → +1<br/>
            • 50DMA &lt; 200DMA → +1<br/>
            • MACD trending bearish → +1<br/>
            • EMA9 &lt; EMA21 → +1<br/>
            • SPY &lt; SPY_50DMA → +1<br/><br/>
            <strong>If pre_sell_score ≥ 3 → SELL_100</strong><br/>
            <em>(Not configurable — depends on market conditions)</em>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- TAB 5: SCORE FORMULA -->
  <div id="tab5" class="tab-content">
    <div class="section">
      <h3>📊 Signal-Count Scoring Formula</h3>
      <div class="info-banner">
        Signal weights (Tab 6) determine signal strength. Score range: −100 to +100
      </div>

      <div class="setting-group">
        <div style="background: #0f172a; padding: 15px; border-radius: 4px; margin-bottom: 15px; font-family: monospace; font-size: 12px;">
          Score = (Σ Positive Signals − Σ Negative Signals) / max(5, Total Signals) × 100
        </div>
      </div>

      <div class="setting-group">
        <div class="setting-label">BUY Threshold</div>
        <div class="input-group">
          <input type="number" id="scoreThresholdBuy" min="0" max="100" value="${allSettings.scoring.score_threshold_buy}" />%
        </div>
      </div>

      <div class="setting-group">
        <div class="setting-label">HOLD Range</div>
        <div class="input-group">
          <input type="number" id="scoreHoldMin" min="0" max="50" value="${allSettings.scoring.score_threshold_hold_min}" />% to <input type="number" id="scoreHoldMax" min="20" max="100" value="${allSettings.scoring.score_threshold_hold_max}" />%
        </div>
      </div>

      <div class="setting-group">
        <div class="setting-label">SELL Threshold</div>
        <div class="input-group">
          Score ≤ <input type="number" id="scoreThresholdSell" min="0" max="50" value="${allSettings.scoring.score_threshold_sell}" />%
        </div>
      </div>
    </div>
  </div>

  <!-- TAB 6: SIGNAL WEIGHTS -->
  <div id="tab6" class="tab-content">
    <div class="section">
      <h3>⚖️ Signal Weights (Default=1.0)</h3>
      <div class="info-banner">
        Each signal defaults to weight 1.0 (counts as +1 or -1). Increase to 2.0 or 3.0 to emphasize important signals. Example: Golden Cross weight 3.0 = counts as +3 when it fires.
      </div>

      <div id="signalWeightsContainer"></div>
    </div>
  </div>

  <!-- TAB 7: GOLDEN CROSS -->
  <div id="tab7" class="tab-content">
    <div class="section">
      <h3>☀️ Golden Cross Detection & Signals</h3>
      <div class="info-banner">
        Golden cross = 50MA crosses above 200MA. "Pulsing glow" shows fresh crosses after stable period below.
      </div>

      <div class="setting-group">
        <div class="setting-label">Fast MA Period (SMA)</div>
        <div class="setting-help">Usually 50 days</div>
        <div class="input-group">
          <input type="number" id="gcFastMa" min="20" max="100" value="${allSettings.golden_cross.detection_fast_ma}" /> days
        </div>
      </div>

      <div class="setting-group">
        <div class="setting-label">Slow MA Period (SMA)</div>
        <div class="setting-help">Usually 200 days</div>
        <div class="input-group">
          <input type="number" id="gcSlowMa" min="100" max="300" value="${allSettings.golden_cross.detection_slow_ma}" /> days
        </div>
      </div>

      <div class="setting-group">
        <div class="setting-label">Pulsing Glow (⭐) Criteria</div>
        <div class="setting-help">Golden cross within last X days AND was below GC for prior Y sessions</div>
      </div>

      <div class="setting-group">
        <div class="setting-label">Recent Cross Window</div>
        <div class="setting-help">Golden cross must have occurred within this many days</div>
        <div class="input-group">
          <input type="number" id="gcPulsingDays" min="1" max="30" value="${allSettings.golden_cross.pulsing_glow_days}" /> days ago
        </div>
      </div>

      <div class="setting-group">
        <div class="setting-label">Stable Period (Before Cross)</div>
        <div class="setting-help">Must have been below GC for this many consecutive trading sessions before the cross (prevents yo-yo)</div>
        <div class="input-group">
          <input type="number" id="gcStableSessions" min="5" max="60" value="${allSettings.golden_cross.stable_period_sessions}" /> trading sessions
        </div>
      </div>

      <div class="setting-group">
        <div class="setting-label">Golden Cross Signal Weight</div>
        <div class="setting-help">Set via Tab 6 - Signal Weights</div>
      </div>
    </div>
  </div>

  <!-- TAB 8: POSITION LIMITS -->
  <div id="tab8" class="tab-content">
    <div class="section">
      <h3>💰 Position & Deployment Limits</h3>
      <div class="info-banner">
        Account-wide constraints. Cash buffer + Deployment should equal ~100%.
      </div>

      <div class="setting-group">
        <div class="setting-label">Max Open Positions</div>
        <div class="setting-help">Autotrader can hold up to N simultaneous positions</div>
        <div class="input-group">
          <input type="number" id="maxPositions" min="1" max="30" value="${allSettings.limits.max_positions}" /> positions
        </div>
      </div>

      <div class="setting-group">
        <div class="setting-label">Max Per Position %</div>
        <div class="setting-help">Maximum equity per position (before VIX scaling)</div>
        <div class="input-group">
          <input type="number" id="maxPerPositionPct" min="1" max="50" step="0.5" value="${allSettings.limits.max_per_position_pct}" />% of equity
        </div>
      </div>

      <div class="setting-group">
        <div class="setting-label">Max Total Deployment %</div>
        <div class="setting-help">Maximum total equity deployed into positions</div>
        <div class="input-group">
          <input type="number" id="maxDeploymentPct" min="20" max="95" step="5" value="${allSettings.limits.max_deployment_pct}" />%
        </div>
      </div>

      <div class="setting-group">
        <div class="setting-label">Min Cash Buffer %</div>
        <div class="setting-help">Always uninvested, ready for opportunities</div>
        <div class="input-group">
          <input type="number" id="minCashBufferPct" min="5" max="50" step="5" value="${allSettings.limits.min_cash_buffer_pct}" />%
        </div>
      </div>

      <div class="setting-group">
        <div class="setting-label">VIX 20-30 Position Size Multiplier</div>
        <div class="setting-help">Scales down position size in elevated volatility</div>
        <div class="input-group">
          <input type="number" id="vix2030Mult" min="0.1" max="1.0" step="0.05" value="${allSettings.limits.vix_20_30_mult}" />x
        </div>
      </div>

      <div class="setting-group">
        <div class="setting-label">VIX >30 Position Size Multiplier</div>
        <div class="setting-help">Scales down position size in high volatility</div>
        <div class="input-group">
          <input type="number" id="vix30PlusMult" min="0.1" max="1.0" step="0.05" value="${allSettings.limits.vix_30_plus_mult}" />x
        </div>
      </div>
    </div>

    <div class="section">
      <h3>Recent Changes</h3>
      <div class="changelog">
        ${changeLog.length === 0
          ? '<div class="changelog-entry" style="color: #64748b;">No recent changes</div>'
          : changeLog.map(log => `
            <div class="changelog-entry">
              <div class="changelog-time">${log.time}</div>
              <div style="color: #cbd5e1; margin-top: 2px;">
                <strong>${log.category}</strong> by ${log.changedBy}
              </div>
            </div>
          `).join('')
        }
      </div>
    </div>
  </div>

</div>

<script>

function switchTab(tabName) {
  document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  const tabEl = document.getElementById(tabName) || document.getElementById('tab-' + tabName);
  if(tabEl) tabEl.classList.add('active');
  if(event && event.target) event.target.classList.add('active');
}

function showStatus(msg, type) {
  const el = document.getElementById('statusMessage');
  el.textContent = msg;
  el.className = 'status-message show ' + type;
  setTimeout(() => el.classList.remove('show'), 4000);
}

async function saveAllChanges() {
  try {
    const gatesData = {
      score_threshold: parseFloat(document.getElementById('scoreThreshold').value),
      rsi_min: parseFloat(document.getElementById('rsiMin').value),
      rsi_max: parseFloat(document.getElementById('rsiMax').value),
      overextension_pct: parseFloat(document.getElementById('overextensionPct').value),
      min_confirmations: parseInt(document.getElementById('minConfirmations').value)
    };

    const buyData = {
      min_price: parseFloat(document.getElementById('minPrice').value),
      require_pick_flag: 1,
      exclude_earnings_days: parseInt(document.getElementById('excludeEarningsDays').value)
    };

    const sellData = {
      hard_stop_pct: parseFloat(document.getElementById('hardStopPct').value),
      trailing_stop_activation_pct: parseFloat(document.getElementById('trailingActivationPct').value),
      trailing_stop_pct: parseFloat(document.getElementById('trailingStopPct').value),
      extended_price_pct: parseFloat(document.getElementById('extendedPricePct').value)
    };

    const scoringData = {
      score_threshold_buy: parseFloat(document.getElementById('scoreThresholdBuy').value),
      score_threshold_hold_min: parseFloat(document.getElementById('scoreHoldMin').value),
      score_threshold_hold_max: parseFloat(document.getElementById('scoreHoldMax').value),
      score_threshold_sell: parseFloat(document.getElementById('scoreThresholdSell').value)
    };

    const gcData = {
      detection_fast_ma: parseInt(document.getElementById('gcFastMa').value),
      detection_slow_ma: parseInt(document.getElementById('gcSlowMa').value),
      pulsing_glow_days: parseInt(document.getElementById('gcPulsingDays').value),
      stable_period_sessions: parseInt(document.getElementById('gcStableSessions').value)
    };

    const limitsData = {
      max_positions: parseInt(document.getElementById('maxPositions').value),
      max_per_position_pct: parseFloat(document.getElementById('maxPerPositionPct').value),
      max_deployment_pct: parseFloat(document.getElementById('maxDeploymentPct').value),
      min_cash_buffer_pct: parseFloat(document.getElementById('minCashBufferPct').value),
      vix_20_30_mult: parseFloat(document.getElementById('vix2030Mult').value),
      vix_30_plus_mult: parseFloat(document.getElementById('vix30PlusMult').value)
    };

    // Save all settings
    await Promise.all([
      fetch('/api/settings/gates', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(gatesData) }),
      fetch('/api/settings/buy', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(buyData) }),
      fetch('/api/settings/sell', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(sellData) }),
      fetch('/api/settings/scoring', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(scoringData) }),
      fetch('/api/settings/golden_cross', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(gcData) }),
      fetch('/api/settings/limits', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(limitsData) })
    ]);

    // Save signal weights
    document.querySelectorAll('.signal-weight-input').forEach(async input => {
      const name = input.getAttribute('data-signal');
      const weight = parseFloat(input.value);
      await fetch('/api/signal-weight/' + name, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({weight}) });
    });

    showStatus('✓ All settings saved successfully', 'success');
  } catch (err) {
    showStatus('✗ Error saving: ' + err.message, 'error');
  }
}

async function resetAllToDefaults() {
  if (!confirm('Reset all settings to defaults? This cannot be undone.')) return;
  try {
    const res = await fetch('/api/settings/reset', { method: 'POST' });
    if (res.ok) {
      showStatus('✓ Settings reset to defaults', 'success');
      setTimeout(() => location.reload(), 1000);
    }
  } catch (err) {
    showStatus('✗ Error: ' + err.message, 'error');
  }
}

// Populate signal weights
async function populateSignalWeights() {
  const res = await fetch('/api/signal-weights');
  const weights = await res.json();
  const container = document.getElementById('signalWeightsContainer');
  const html = Object.entries(weights).map(([type, signals]) => {
    return '<div class="setting-group"><h4 style="color: #cbd5e1; margin: 10px 0;">' + type.replace(/_/g, ' ').toUpperCase() + '</h4><div class="signal-weights-grid">' + signals.map(s => {
      return '<div class="signal-card"><div class="name">' + s.name.replace(/_/g, ' ') + '</div><div class="type">' + type + '</div><div class="weight-input"><input type="number" class="signal-weight-input" data-signal="' + s.name + '" min="-10" max="10" step="0.5" value="' + s.weight + '" /><span style="color: #64748b; font-size: 12px;">x</span></div><div class="setting-help" style="margin-top: 4px;">' + (s.description || '') + '</div></div>';
    }).join('') + '</div></div>';
  }).join('');
  container.innerHTML = html;
}

populateSignalWeights();
</script>
</body>
</html>`;

    res.send(html);
  } catch (err) {
    res.status(500).send(`<pre>Error: ${err.message}</pre>`);
  }
});

// ─── SETTINGS API ENDPOINTS ────────────────────────────────────────────────────

app.post('/api/settings/:category', async (req, res) => {
  try {
    const { category } = req.params;
    const updated = await settings.updateSettings(category, req.body, 'web');
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/signal-weights', async (req, res) => {
  try {
    const weights = await settings.getSignalWeights();
    res.json(weights);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/signal-weight/:signal', async (req, res) => {
  try {
    const { signal } = req.params;
    const { weight } = req.body;
    const updated = await settings.updateSignalWeight(signal, weight, 'web');
    res.json({ success: true, weight: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings/reset', async (req, res) => {
  try {
    // Reset all settings to defaults
    const defaults = {
      gates: {score_threshold:50,rsi_min:30,rsi_max:70,overextension_pct:8,min_confirmations:2},
      buy: {min_price:5,require_pick_flag:1,exclude_earnings_days:5},
      sell: {hard_stop_pct:-8,trailing_stop_activation_pct:5,trailing_stop_pct:5,extended_price_pct:10},
      scoring: {score_threshold_buy:50,score_threshold_hold_min:20,score_threshold_hold_max:50,score_threshold_sell:20},
      golden_cross: {detection_fast_ma:50,detection_slow_ma:200,pulsing_glow_days:5,stable_period_sessions:20},
      limits: {max_positions:15,max_per_position_pct:10,max_deployment_pct:80,min_cash_buffer_pct:20,vix_20_30_mult:0.75,vix_30_plus_mult:0.50}
    };
    for (const [cat, data] of Object.entries(defaults)) {
      await settings.updateSettings(cat, data, 'reset');
    }
    // Reset signal weights
    await db.query('UPDATE signal_weights SET weight = 1.0');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Watchlist Groups API ──────────────────────────────────────────────────────

// GET /api/watchlist-groups — List all groups with stock counts
app.get('/api/watchlist-groups', async (req, res) => {
  try {
    const groups = await db.query(`
      SELECT
        g.id,
        g.name,
        COUNT(gs.symbol) AS stock_count
      FROM watchlist_groups g
      LEFT JOIN watchlist_group_stocks gs ON g.id = gs.group_id
      GROUP BY g.id, g.name
      ORDER BY g.name
    `);
    res.json({ success: true, data: groups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/watchlist-groups — Create new watchlist group
app.post('/api/watchlist-groups', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'Group name required' });
    }
    const result = await db.query(
      'INSERT INTO watchlist_groups (name) VALUES (?)',
      [name.trim()]
    );
    res.json({ success: true, data: { id: result.insertId, name, stock_count: 0 } });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      res.status(400).json({ error: 'Group name already exists' });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

// PUT /api/watchlist-groups/:id — Rename watchlist group
app.put('/api/watchlist-groups/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'Group name required' });
    }
    await db.query('UPDATE watchlist_groups SET name = ? WHERE id = ?', [name.trim(), id]);
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      res.status(400).json({ error: 'Group name already exists' });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

// DELETE /api/watchlist-groups/:id — Delete watchlist group and members
app.delete('/api/watchlist-groups/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM watchlist_groups WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/watchlist-groups/:id/stocks — Get symbols in a watchlist group
app.get('/api/watchlist-groups/:id/stocks', async (req, res) => {
  try {
    const { id } = req.params;
    const stocks = await db.query(
      'SELECT symbol FROM watchlist_group_stocks WHERE group_id = ? ORDER BY symbol',
      [id]
    );
    res.json({ success: true, data: stocks.map(s => s.symbol) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/watchlist-groups/:id/stocks — Add stocks to watchlist group
app.post('/api/watchlist-groups/:id/stocks', async (req, res) => {
  try {
    const { id } = req.params;
    const { symbols } = req.body;
    if (!Array.isArray(symbols) || symbols.length === 0) {
      return res.status(400).json({ error: 'symbols array required' });
    }

    for (const symbol of symbols) {
      await db.query(
        'INSERT IGNORE INTO watchlist_group_stocks (group_id, symbol) VALUES (?, ?)',
        [id, symbol.toUpperCase()]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/watchlist-groups/:id/stocks/:symbol — Remove one stock from group
app.delete('/api/watchlist-groups/:id/stocks/:symbol', async (req, res) => {
  try {
    const { id, symbol } = req.params;
    await db.query(
      'DELETE FROM watchlist_group_stocks WHERE group_id = ? AND symbol = ?',
      [id, symbol.toUpperCase()]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Startup ──────────────────────────────────────────────────────────────────
async function start() {
  app.listen(PORT, () => {
    console.log(`My Stocks Dashboard running on port ${PORT}`);
    console.log(`Dashboard: http://192.168.1.156:${PORT}/`);
    console.log(`Mode: ${cfg.alpaca.isPaper ? 'PAPER TRADING' : 'LIVE TRADING'}`);
  });
  startScheduler();
  try {
    const symbols = require('./portfolio_app/seed_symbols');
    const wlCount = await db.queryOne(`SELECT COUNT(*) AS n FROM watchlist WHERE is_active = 1`);
    if (!wlCount || wlCount.n === 0) await yh.seedWatchlist(symbols);
    const histCount = await db.queryOne(`SELECT COUNT(*) AS n FROM price_history`);
    const sigCount  = await db.queryOne(`SELECT COUNT(*) AS n FROM stock_signals`);
    if (!sigCount || sigCount.n === 0) {
      if (!histCount || histCount.n <= 1000) {
        await yh.seedWatchlist(symbols);
        console.log('[Startup] No data yet. Full history fetch starts in 90 seconds...');
        setTimeout(() => runDailyRefresh(true).catch(console.error), 90 * 1000);
      } else {
        console.log(`[Startup] ${histCount.n} price rows found. Running analysis now...`);
        setTimeout(async () => {
          try { await analyzeAll({}); console.log('[Startup] Analysis complete'); }
          catch (e) { console.error('[Startup] Analysis failed:', e.message); }
        }, 5000);
      }
    }
  } catch (err) {
    console.error('[Startup] Seed check failed:', err.message);
  }
}

start().catch(err => { console.error('Startup failed:', err); process.exit(1); });
