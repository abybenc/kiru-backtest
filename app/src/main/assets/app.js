/* Kiru Backtest app: data (Upstox, free, no login) -> Engine -> UI */
(function () {
  const E = window.Engine;
  const $ = s => document.querySelector(s);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.log('store fail', k, e); } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { } },
  };

  const DEFAULTS = {
    cost: 0.1, lookback: 20, topN: 3, cashRate: 6, startYear: 2008, splitYear: 2018,
    universe: 'NIFTYBEES,JUNIORBEES,BANKBEES,ITBEES,PHARMABEES,PSUBNKBEES,GOLDBEES,SILVERBEES,MON100,CPSEETF,MOM30IETF',
    keys: {},          // symbol -> Upstox instrument_key overrides
    source: 'auto',    // auto | yahoo | upstox
  };
  let S = Object.assign({}, DEFAULTS, store.get('settings', {}));
  const charts = {};

  // ---------------- native bridge ----------------
  let cbId = 0; const pending = {};
  window.__nativeCb = (id, ok, payload) => { const p = pending[id]; if (!p) return; delete pending[id]; ok ? p.res(payload) : p.rej(new Error(payload)); };
  function nget(url) {
    if (window.Native) return new Promise((res, rej) => { const id = 'r' + (++cbId); pending[id] = { res, rej }; window.Native.fetch(id, url); });
    return fetch(url).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); });
  }
  function nfind(symbols) {
    if (window.Native) return new Promise((res, rej) => { const id = 'f' + (++cbId); pending[id] = { res, rej }; window.Native.findInstruments(id, symbols.join(',')); }).then(JSON.parse);
    return Promise.reject(new Error('Instrument lookup needs the Android app'));
  }

  function status(msg, err) { const el = $('#status'); if (!msg) { el.classList.add('hidden'); return; } el.textContent = msg; el.className = 'status' + (err ? ' err' : ''); }

  // ---------------- data layer ----------------
  const fmtD = d => d.toISOString().slice(0, 10);
  async function instrumentKeys(symbols) {
    const cache = store.get('ikeys', {});
    const merged = Object.assign({}, cache, S.keys);
    const missing = symbols.filter(s => !merged[s]);
    if (missing.length && !store.get('ikeysTried_' + missing.join(','), false)) {
      status('First run: looking up ' + missing.length + ' ETF codes on Upstox (one time, ~20s)...');
      try {
        const found = await nfind(missing);
        Object.assign(cache, found); store.set('ikeys', cache); Object.assign(merged, found);
      } catch (e) { console.log('upstox lookup failed', e); }
      store.set('ikeysTried_' + missing.join(','), true);
    }
    return merged;
  }
  async function fetchCandles(key, from, to) {
    // Upstox v3 historical candles; free data endpoint, no access token required. Fetched year by year to avoid silent truncation.
    const out = new Map();
    const y0 = +from.slice(0, 4), y1 = +to.slice(0, 4);
    for (let y = y1; y >= y0; y--) {
      const a = y === y0 ? from : `${y}-01-01`, b = y === y1 ? to : `${y}-12-31`;
      const url = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(key)}/days/1/${b}/${a}`;
      try {
        const j = JSON.parse(await nget(url));
        if (j.status === 'success') (j.data.candles || []).forEach(c => out.set(String(c[0]).slice(0, 10), +c[4]));
      } catch (e) { if (y === y1) throw e; }
    }
    const dates = [...out.keys()].sort();
    return { dates, v: dates.map(d => out.get(d)) };
  }
  async function fetchYahoo(sym, from, to) {
    // Yahoo Finance daily chart; adjusted close (splits + dividends). No key needed.
    const p1 = Math.floor(new Date(from).getTime() / 1000), p2 = Math.floor(new Date(to).getTime() / 1000) + 86400;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym + '.NS')}?period1=${p1}&period2=${p2}&interval=1d&events=split`;
    const j = JSON.parse(await nget(url));
    const r = j.chart && j.chart.result && j.chart.result[0];
    if (!r || !r.timestamp) throw new Error('Yahoo: no data');
    const adj = (r.indicators.adjclose && r.indicators.adjclose[0].adjclose) || r.indicators.quote[0].close;
    const m = new Map();
    r.timestamp.forEach((t, i) => { const v = adj[i]; if (v != null && isFinite(v) && v > 0) m.set(new Date((t + 19800) * 1000).toISOString().slice(0, 10), +v); });
    const dates = [...m.keys()].sort();
    return { dates, v: dates.map(d => m.get(d)) };
  }
  function mergeInto(old, fresh) {
    const m = new Map(old.dates.map((d, k) => [d, old.v[k]])); fresh.dates.forEach((d, k) => m.set(d, fresh.v[k]));
    const ds = [...m.keys()].sort(); return { dates: ds, v: ds.map(d => m.get(d)) };
  }
  async function getSource(src, sym, key, force, today) {
    const ck = src + '_' + sym;
    let c = store.get(ck, null);
    const from = `${S.startYear - 1}-01-01`;
    const pull = (a) => src === 'up' ? fetchCandles(key, a, today) : fetchYahoo(sym, a, today);
    if (!c || force || (src === 'up' && c.key !== key) || c.from > from) {
      const raw = await pull(from);
      c = { key, from, dates: raw.dates, v: raw.v, at: today };
    } else if (c.at !== today) {
      const raw = await pull(c.dates[Math.max(0, c.dates.length - 10)]);
      c = Object.assign(c, mergeInto(c, raw), { at: today });
    }
    c.v = c.v.map(x => Math.round(x * 1e4) / 1e4);
    store.set(ck, c);
    return c;
  }
  function quality(s) { if (!s || s.dates.length < 50) return -1e9; const g = E.gaps(s, `${S.startYear}-01-01`); return -g.totalDays * 10 + s.dates.length / 1000; }
  async function loadAll(force) {
    const syms = [...new Set(S.universe.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).concat(['NIFTYBEES', 'GOLDBEES']))];
    const mode = S.source || 'auto';
    const keys = mode === 'yahoo' ? {} : await instrumentKeys(syms);
    const today = fmtD(new Date());
    const data = {}; const problems = []; const health = {};
    for (let i = 0; i < syms.length; i++) {
      const sym = syms[i];
      status(`Downloading prices ${i + 1}/${syms.length}: ${sym}`);
      let up = null, yh = null, errs = [];
      if (mode !== 'yahoo' && keys[sym]) { try { up = await getSource('up', sym, keys[sym], force, today); } catch (e) { errs.push('Upstox ' + e.message); up = store.get('up_' + sym, null); } }
      if (mode !== 'upstox') { try { yh = await getSource('yh', sym, null, force, today); } catch (e) { errs.push('Yahoo ' + e.message); yh = store.get('yh_' + sym, null); } }
      const cu = up && up.dates.length > 50 ? E.adjustSplits(up) : null;
      const cy = yh && yh.dates.length > 50 ? E.adjustSplits(yh) : null;
      if (!cu && !cy) { problems.push(sym + ': no data (' + (errs.join('; ') || 'not found') + ')'); continue; }
      const upFirst = !cy || (cu && quality(cu) >= quality(cy));
      const base = upFirst ? cu : cy, other = upFirst ? cy : cu;
      const sp = E.spliceFill(base, other);
      const adj = E.adjustSplits(sp);            // re-check joins
      data[sym] = adj;
      const g = E.gaps(adj, `${S.startYear}-01-01`);
      health[sym] = { src: (upFirst ? 'Upstox' : 'Yahoo') + (sp.filled ? ` +${sp.filled}d ${upFirst ? 'Yahoo' : 'Upstox'}` : ''), rows: adj.dates.length, first: adj.dates[0], last: adj.dates.at(-1), gaps: g,
        upGaps: up ? E.gaps(up, `${S.startYear}-01-01`).totalDays : null, yhGaps: yh ? E.gaps(yh, `${S.startYear}-01-01`).totalDays : null,
        fixes: [...(base.events || []), ...(adj.events || [])].map(e => `${e.date} ${e.type} ${e.factor}${e.days ? ' (' + e.days + 'd)' : ''}`),
        big: E.bigMoves(adj, `${S.startYear}-01-01`) };
    }
    window.__health = health;
    return { data, problems };
  }

  // ---------------- run strategies ----------------
  let R = null;
  function compute(data) {
    const cost = S.cost / 100, from = `${S.startYear}-01-01`;
    const trim = s => { const i = s.dates.findIndex(d => d >= `${S.startYear - 1}-01-01`); return { dates: s.dates.slice(i), v: s.v.slice(i) }; };
    const pairF = E.align({ EQ: trim(data.NIFTYBEES), GOLD: trim(data.GOLDBEES) });
    const A = E.runRatio(pairF, S.lookback, cost);
    // report from startYear (earlier year is warm-up for 20d window)
    const ai = Math.max(0, pairF.dates.findIndex(d => d >= from));
    const cut = arr => arr.slice(ai);
    const aD = cut(A.dates), aEq = cut(A.eq);
    const benches = {
      'Nifty/Gold switch (Kiru)': aEq,
      'Niftybees buy & hold': cut(E.buyHold(pairF.dates, pairF.cols.EQ)),
      'Goldbees buy & hold': cut(E.buyHold(pairF.dates, pairF.cols.GOLD)),
      '50/50 yearly rebal.': cut(E.fixedMix(pairF, { EQ: .5, GOLD: .5 }, cost)),
    };
    const aM = Object.fromEntries(Object.entries(benches).map(([k, v]) => [k, E.metrics(aD, v)]));
    const split = `${S.splitYear}-01-01`;
    const ins = E.sliceFrom(aD, aEq, aD[0]), oos = E.sliceFrom(aD, aEq, split);
    const insEnd = aD.findIndex(d => d >= split);
    const aSplit = { in: insEnd > 1 ? E.metrics(aD.slice(0, insEnd + 1), aEq.slice(0, insEnd + 1)) : null, out: oos ? E.metrics(oos.dates, oos.eq) : null };

    const uniSyms = S.universe.split(',').map(s => s.trim().toUpperCase()).filter(s => data[s]);
    const uniF = E.outerAlign(Object.fromEntries(uniSyms.map(s => [s, trim(data[s])])));
    const B = E.runMomentum(uniF, S.topN, 200, cost, S.cashRate / 100);
    let bD = [], bEq = [], bM = null, nbM = null, bNb = [];
    if (B) {
      const bi = Math.max(0, B.dates.findIndex(d => d >= from));
      bD = B.dates.slice(bi); bEq = B.eq.slice(bi);
      const nb = E.align({ X: data.NIFTYBEES }); const m = new Map(nb.dates.map((d, k) => [d, nb.cols.X[k]]));
      const nbPx = bD.map(d => m.get(d) ?? null); for (let k = 1; k < nbPx.length; k++) if (nbPx[k] == null) nbPx[k] = nbPx[k - 1];
      bNb = E.buyHold(bD, nbPx);
      bM = E.metrics(bD, bEq); nbM = E.metrics(bD, bNb);
    }
    const lastI = uniF.dates.length - 1;
    R = {
      pairF, A, aD, aEq, benches, aM, aSplit, pairGaps: E.gaps({ dates: pairF.dates }, from),
      yearlyA: E.yearly(aD, aEq), yearlyN: E.yearly(aD, benches['Niftybees buy & hold']), yearlyG: E.yearly(aD, benches['Goldbees buy & hold']),
      robust: E.robustness(pairF, [10, 15, 20, 30, 40, 50, 60], cost, from),
      today: E.ratioToday(pairF, S.lookback),
      uniF, B, bD, bEq, bM, nbM, bNb, rankNow: E.rankAt(uniF, lastI),
      splits: Object.entries(window.__health || {}).flatMap(([s, h]) => h.fixes.map(f => `${s}: ${f}`)),
    };
    R.bHolding = R.B ? Object.entries(R.B.w[R.B.w.length - 1]).filter(([, w]) => w > 0).map(([c]) => c) : [];
  }

  // ---------------- UI helpers ----------------
  const pct = (x, d = 1) => x == null ? '–' : `<span class="${x >= 0 ? 'pos' : 'neg'}">${x > 0 ? '+' : ''}${x.toFixed(d)}%</span>`;
  const inr = x => '₹' + Math.round(x).toLocaleString('en-IN');
  const pill = h => h === 'NIFTYBEES' ? '<span class="pill eq">NIFTYBEES</span>' : h === 'GOLDBEES' ? '<span class="pill gold">GOLDBEES</span>' : `<span class="pill cash">${h || 'none yet'}</span>`;
  function chart(id, cfg) { if (charts[id]) charts[id].destroy(); const el = document.getElementById(id); if (!el || !window.Chart) return; charts[id] = new Chart(el, cfg); }
  const thin = (arr, every) => arr.filter((_, i) => i % every === 0 || i === arr.length - 1);
  function lineCfg(labels, sets, log) {
    return {
      type: 'line', data: { labels, datasets: sets.map(s => ({ label: s.label, data: s.data, borderColor: s.color, borderWidth: s.w || 1.5, pointRadius: 0, fill: s.fill || false, backgroundColor: s.bg, borderDash: s.dash })) },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { color: '#c9ced6', boxWidth: 10, font: { size: 11 } } } },
        scales: { x: { ticks: { color: '#8b93a1', maxTicksLimit: 6, font: { size: 10 } }, grid: { color: '#1f242d' } },
          y: { type: log ? 'logarithmic' : 'linear', ticks: { color: '#8b93a1', font: { size: 10 } }, grid: { color: '#1f242d' } } }
      }
    };
  }
  function metricsTable(rows) {
    return `<div class="scroll"><table><tr><th></th><th>CAGR</th><th>Max DD</th><th>Sharpe</th><th>₹1L →</th></tr>${rows.map(([n, m]) => m ? `<tr><td>${n}</td><td>${pct(m.cagr)}</td><td>${pct(m.mdd)}</td><td>${m.sharpe ?? '–'}</td><td>${inr(m.finalX * 100000)}</td></tr>` : '').join('')}</table></div>`;
  }
  function nextMonthEnd() {
    const d = new Date(); const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    while (last.getDay() === 0 || last.getDay() === 6) last.setDate(last.getDate() - 1);
    return last.toDateString().slice(4);
  }

  // ---------------- screens ----------------
  function renderToday() {
    const t = R.today, flip = t.holding === 'NIFTYBEES' ? t.toLowPct : t.toHighPct;
    const action = t.fired ? `<div class="action switch">Signal fired today → switch 100% to ${t.fired} tomorrow</div>` : `<div class="action hold">No signal → keep holding ${t.holding || '-'}</div>`;
    const flipTxt = t.holding === 'NIFTYBEES' ? `Flips to Gold if ratio falls ${Math.abs(flip).toFixed(2)}% more` : t.holding === 'GOLDBEES' ? `Flips to Nifty if ratio rises ${Math.abs(flip).toFixed(2)}% more` : '';
    const rk = R.rankNow.map((r, i) => `<tr><td>${i + 1}. ${r.etf}${R.bHolding.includes(r.etf) ? ' ●' : ''}</td><td>${r.score ?? '–'}</td><td>${r.aboveSma ? '✅' : '❌'}</td></tr>`).join('');
    const topNow = R.rankNow.filter(r => r.score != null && r.aboveSma).slice(0, S.topN).map(r => r.etf);
    $('#tab-today').innerHTML = `
      <div class="card"><h3>⇄ Nifty / Gold switch (Kiru)</h3>
        <div class="row" style="align-items:center;gap:10px"><span class="muted">Holding now</span>${pill(t.holding)}</div>
        ${action}
        <div class="kv"><div>Ratio today</div><div>${t.ratio.toFixed(4)}</div><div>20-day high / low</div><div>${t.hi.toFixed(4)} / ${t.lo.toFixed(4)}</div><div>Last switch</div><div>${t.lastSwitch || '–'}</div></div>
        <div class="note">${flipTxt}</div>
        <div class="chart small"><canvas id="c-band"></canvas></div>
      </div>
      <div class="card"><h3>▲ Momentum rotation</h3>
        <div class="kv"><div>Holding now (backtest)</div><div>${R.bHolding.join(', ') || 'CASH'}</div><div>Next rebalance</div><div>${nextMonthEnd()}</div><div>Top ${S.topN} if it were today</div><div>${topNow.join(', ') || 'CASH'}</div></div>
        <div class="scroll" style="margin-top:8px"><table><tr><th>Rank</th><th>Score</th><th>>200 SMA</th></tr>${rk}</table></div>
        <div class="note">Score = avg of (6m return ÷ 6m volatility) and (12m return ÷ 12m volatility). ● = held now.</div>
      </div>
      <div class="card"><h3>Place the trade</h3>
        <div class="note" style="margin-bottom:8px">Orders are placed by you in your broker app. SEBI rules need a static IP for API orders, which a phone doesn't have.</div>
        <div class="row"><button class="btn" data-open="kite">Open Kite</button><button class="btn ghost" data-open="upstox">Open Upstox</button></div>
      </div>`;
    const n = 120, s = R.pairF.dates.length - n, lb = S.lookback;
    const ratio = R.A.ratio.slice(s), hi = [], lo = [];
    for (let i = s; i < R.A.ratio.length; i++) { let h = -Infinity, l = Infinity; for (let j = i - lb; j < i; j++) { h = Math.max(h, R.A.ratio[j]); l = Math.min(l, R.A.ratio[j]); } hi.push(h); lo.push(l); }
    chart('c-band', lineCfg(R.pairF.dates.slice(s), [
      { label: 'Ratio', data: ratio, color: '#4f8cff', w: 2 }, { label: '20d high', data: hi, color: '#2fbf71', dash: [4, 3] }, { label: '20d low', data: lo, color: '#e0b84a', dash: [4, 3] }]));
    document.querySelectorAll('[data-open]').forEach(b => b.onclick = () => window.Native ? window.Native.openBroker(b.dataset.open) : window.open(b.dataset.open === 'kite' ? 'https://kite.zerodha.com' : 'https://pro.upstox.com'));
  }

  const EXPLAIN = `<div class="card explain"><h3>How the switch works</h3>
    <svg viewBox="0 0 320 140" role="img" aria-label="Ratio line crossing its 20 day band">
      <rect x="0" y="0" width="320" height="140" fill="none"/>
      <path d="M0 40 H320" stroke="#2fbf71" stroke-dasharray="5 4"/><text x="4" y="34" fill="#2fbf71" font-size="10">20-day high</text>
      <path d="M0 100 H320" stroke="#e0b84a" stroke-dasharray="5 4"/><text x="4" y="114" fill="#e0b84a" font-size="10">20-day low</text>
      <path id="rp" d="M0 70 C40 60,70 80,100 65 S150 30,175 30 S220 60,240 80 S280 115,320 112" stroke="#4f8cff" stroke-width="2.5" fill="none" stroke-dasharray="420" stroke-dashoffset="420">
        <animate attributeName="stroke-dashoffset" values="420;0;0" keyTimes="0;0.8;1" dur="6s" repeatCount="indefinite"/></path>
      <circle r="5" fill="#2fbf71" cx="160" cy="36" opacity="0"><animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.33;0.36;0.95;1" dur="6s" repeatCount="indefinite"/></circle>
      <text x="120" y="20" fill="#9fc2ff" font-size="11" opacity="0">Breaks high → buy NIFTYBEES<animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.33;0.36;0.6;0.62" dur="6s" repeatCount="indefinite"/></text>
      <circle r="5" fill="#e0b84a" cx="262" cy="100" opacity="0"><animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.62;0.65;0.95;1" dur="6s" repeatCount="indefinite"/></circle>
      <text x="150" y="134" fill="#f2d27a" font-size="11" opacity="0">Breaks low → buy GOLDBEES<animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.62;0.65;0.95;1" dur="6s" repeatCount="indefinite"/></text>
    </svg>
    <div class="note">Ratio = Niftybees ÷ Goldbees. Inside the band you just hold. You are always 100% in one of the two.</div></div>`;

  function renderA() {
    const m = R.aM, k = Object.keys(R.benches);
    const ev = Math.max(1, Math.floor(R.aD.length / 600));
    const yr = R.yearlyA.map((y, i) => `<tr><td>${y.year}</td><td>${pct(y.ret)}</td><td>${pct(R.yearlyN[i]?.ret)}</td><td>${pct(R.yearlyG[i]?.ret)}</td></tr>`).join('');
    const rb = R.robust.map(r => `<tr${r.lookback === S.lookback ? ' style="font-weight:700"' : ''}><td>${r.lookback} days</td><td>${pct(r.cagr)}</td><td>${pct(r.mdd)}</td><td>${r.sharpe}</td><td>${r.switches}</td></tr>`).join('');
    const sp = R.aSplit;
    const trades = R.A.trades.filter(t => t.date >= R.aD[0]).slice().reverse().map(t => `<tr><td>${t.date}</td><td>${pill(t.holding)}</td><td>${inr(t.value)}</td></tr>`).join('');
    $('#tab-a').innerHTML = `
      <div class="card"><h3>Kiru's rule</h3><div class="note" style="font-size:13px;color:var(--fg)">Ratio = Niftybees ÷ Goldbees. Close above prior ${S.lookback}-day high → 100% Niftybees. Close below prior ${S.lookback}-day low → 100% Goldbees. Otherwise hold. Trade next day's close. Cost ${S.cost}% per side.</div>
        <div class="note">Kiru's thread (16 May 2026) claims 18.0% CAGR and −24.95% max drawdown, Jan 2008 to May 2026. Compare below.</div></div>
      ${EXPLAIN}
      ${R.pairGaps.list.length ? `<div class="card" style="border-color:var(--bad)"><h3 class="neg">Data gap warning</h3><div class="note" style="color:var(--fg)">Missing prices: ${R.pairGaps.list.map(g => `${g.from} → ${g.to} (${g.days} days)`).join(', ')}. Results across these stretches are not reliable. Try Settings → Price data source → Auto, then Re-download.</div></div>` : ''}
      <div class="card"><h3>Results ${R.aD[0]} → ${R.aD.at(-1)}</h3>${metricsTable(k.map(n => [n, m[n]]))}
        <div class="note">₹1L → means ₹1,00,000 invested at the start grew to this. Example: 18% CAGR for 18 years turns ₹1L into about ₹19.7L.</div></div>
      <div class="card"><h3>Growth of ₹1L (log scale)</h3><div class="chart"><canvas id="c-a"></canvas></div></div>
      <div class="card"><h3>Drawdown</h3><div class="chart small"><canvas id="c-add"></canvas></div><div class="note">Drawdown = fall from the last peak. Example: portfolio hits ₹2L, drops to ₹1.5L → −25% drawdown.</div></div>
      <div class="card"><h3>Is 20 days special? (robustness)</h3><div class="scroll"><table><tr><th>Window</th><th>CAGR</th><th>Max DD</th><th>Sharpe</th><th>Switches</th></tr>${rb}</table></div>
        <div class="note">If only one window works and neighbours collapse, the result is probably luck (curve fitting).</div></div>
      <div class="card"><h3>Before vs after ${S.splitYear}</h3>${metricsTable([['Before ' + S.splitYear, sp.in], ['From ' + S.splitYear, sp.out]])}
        <div class="note">Rule should hold up in both halves. A big drop in the second half is a warning.</div></div>
      <div class="card"><h3>Year by year</h3><div class="scroll"><table><tr><th>Year</th><th>Switch</th><th>Nifty</th><th>Gold</th></tr>${yr}</table></div></div>
      <details class="card"><summary>All ${R.A.trades.length} switches</summary><div class="scroll"><table><tr><th>Date</th><th>Moved to</th><th>Value</th></tr>${trades}</table></div></details>`;
    const L = thin(R.aD, ev), pal = ['#4f8cff', '#9aa3b2', '#e0b84a', '#b07cff'];
    chart('c-a', lineCfg(L, k.map((n, i) => ({ label: n, data: thin(R.benches[n], ev), color: pal[i], w: i ? 1.2 : 2.4 })), true));
    chart('c-add', lineCfg(L, [{ label: 'Switch DD %', data: thin(E.drawdown(R.aEq), ev), color: '#ef5b5b', fill: true, bg: 'rgba(239,91,91,.25)' }, { label: 'Niftybees DD %', data: thin(E.drawdown(R.benches['Niftybees buy & hold']), ev), color: '#9aa3b2', w: 1 }]));
  }

  function renderB() {
    if (!R.B) { $('#tab-b').innerHTML = '<div class="card">Not enough ETF history yet for momentum (needs 12 months).</div>'; return; }
    const ev = Math.max(1, Math.floor(R.bD.length / 600));
    const picks = R.B.picks.filter(p => p.date >= R.bD[0]).slice().reverse().map(p => `<tr><td>${p.date}</td><td style="text-align:left">${p.picks}</td></tr>`).join('');
    $('#tab-b').innerHTML = `
      <div class="card"><h3>Rule</h3><div class="note" style="font-size:13px;color:var(--fg)">Last trading day of each month: score each ETF = average of (6m return ÷ 6m volatility) and (12m return ÷ 12m volatility). Buy the top ${S.topN} that are above their 200-day average, equal weight. Empty slots sit in cash at ${S.cashRate}%.</div>
        <div class="note">Example: ETF A up 20% with 10% volatility scores 2.0; ETF B up 30% with 30% volatility scores 1.0. A ranks higher because its climb was smoother ("frog in boiling water").</div>
        <div class="note">This is Gemini's version of Kiru's momentum idea. Kiru himself mostly uses the Nifty200 Momentum 30 index fund.</div></div>
      <div class="card"><h3>Results ${R.bD[0]} → ${R.bD.at(-1)}</h3>${metricsTable([['Momentum rotation', R.bM], ['Niftybees buy & hold', R.nbM]])}</div>
      <div class="card"><h3>Growth of ₹1L (log scale)</h3><div class="chart"><canvas id="c-b"></canvas></div></div>
      <details class="card"><summary>Monthly picks (${R.B.picks.length})</summary><div class="scroll"><table><tr><th>Month end</th><th style="text-align:left">Held next month</th></tr>${picks}</table></div></details>
      <div class="card note">ETFs that launched later (like MOM30IETF) only join the ranking once they have 12 months of prices.</div>`;
    chart('c-b', lineCfg(thin(R.bD, ev), [{ label: 'Momentum', data: thin(R.bEq, ev), color: '#4f8cff', w: 2.4 }, { label: 'Niftybees', data: thin(R.bNb, ev), color: '#9aa3b2' }], true));
  }

  function paperRun(startDate, capital) {
    const out = {};
    const segA = E.sliceFrom(R.A.dates, R.A.eq, startDate);
    if (segA && segA.dates.length) {
      const cost = S.cost / 100;
      const i0 = R.A.dates.indexOf(segA.dates[0]);
      out.A = segA.dates.map((d, k) => ({ date: d, value: capital * (1 - cost) * segA.eq[k] / segA.eq[0], hold: R.A.states[i0 + k] === 1 ? 'NIFTYBEES' : R.A.states[i0 + k] === 0 ? 'GOLDBEES' : '-' }));
    }
    if (R.B) {
      const segB = E.sliceFrom(R.B.dates, R.B.eq, startDate);
      if (segB && segB.dates.length) {
        const i0 = R.B.dates.indexOf(segB.dates[0]);
        out.B = segB.dates.map((d, k) => ({ date: d, value: capital * segB.eq[k] / segB.eq[0], hold: Object.entries(R.B.w[i0 + k]).filter(([, w]) => w > 0).map(([c]) => c).join(', ') || 'CASH' }));
      }
    }
    return out;
  }
  function renderPaper() {
    const P = store.get('paper', null);
    const tmr = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    if (!P) {
      $('#tab-paper').innerHTML = `<div class="card"><h3>Start forward testing</h3>
        <div class="note" style="color:var(--fg)">Paper trade both strategies with pretend money from a start date. The app tracks what you would hold and your value every day, using real closing prices. No real orders.</div>
        <label>Start date</label><input id="p-date" type="date" value="${tmr}">
        <label>Pretend capital (₹)</label><input id="p-cap" type="number" value="100000">
        <div style="margin-top:12px"><button class="btn" id="p-go">Start paper trading</button></div></div>`;
      $('#p-go').onclick = () => { store.set('paper', { start: $('#p-date').value, capital: +$('#p-cap').value || 100000 }); renderPaper(); };
      return;
    }
    const run = paperRun(P.start, P.capital);
    const block = (name, rows) => {
      if (!rows || !rows.length) return `<div class="card"><h3>${name}</h3><div class="note">Starts ${P.start}. First result appears after that day's close (data is end of day).</div></div>`;
      const last = rows.at(-1), ret = (last.value / P.capital - 1) * 100;
      const tr = rows.slice().reverse().slice(0, 60).map(r => `<tr><td>${r.date}</td><td style="text-align:left">${r.hold}</td><td>${inr(r.value)}</td></tr>`).join('');
      return `<div class="card"><h3>${name}</h3><div class="big">${inr(last.value)} ${pct(ret, 2)}</div><div class="note">Holding: ${last.hold} · ${rows.length} trading days</div>
        <details><summary>Daily log</summary><div class="scroll"><table><tr><th>Date</th><th style="text-align:left">Holding</th><th>Value</th></tr>${tr}</table></div></details></div>`;
    };
    $('#tab-paper').innerHTML = `<div class="card"><div class="kv"><div>Started</div><div>${P.start}</div><div>Capital</div><div>${inr(P.capital)}</div></div></div>
      ${block('⇄ Nifty/Gold switch', run.A)}${block('▲ Momentum rotation', run.B)}
      <div class="card note">Paper values follow the exact backtest rules from your start date, so live results can be compared one to one with the backtest. Real fills will differ a little (slippage).</div>
      <button class="btn ghost" id="p-reset">Reset paper trading</button>`;
    $('#p-reset').onclick = () => { if (window.confirm('Reset paper trading?')) { store.del('paper'); renderPaper(); } };
  }

  function healthTable() {
    const h = window.__health || {};
    const rows = Object.entries(h).map(([s, x]) => `<tr><td>${s}</td><td style="text-align:left">${x.src}</td><td>${x.first.slice(0, 4)}</td><td>${x.rows}</td><td class="${x.gaps.totalDays ? 'neg' : 'pos'}">${x.gaps.totalDays}</td><td>${x.upGaps ?? '–'}/${x.yhGaps ?? '–'}</td><td class="${x.big.length ? 'neg' : 'pos'}">${x.big.length}</td></tr>`).join('');
    return rows ? `<div class="scroll"><table><tr><th>ETF</th><th style="text-align:left">Used</th><th>From</th><th>Days</th><th>Gap days</th><th>Upstox/Yahoo</th><th>Jumps</th></tr>${rows}</table></div>` : '<div class="note">Load data first.</div>';
  }
  function renderSettings() {
    const keys = Object.assign({}, store.get('ikeys', {}), S.keys);
    $('#tab-settings').innerHTML = `<div class="card"><h3>Backtest settings</h3>
      <label>Cost per side (%) · e.g. 0.1% on ₹1L trade = ₹100</label><input id="s-cost" type="number" step="0.01" value="${S.cost}">
      <label>Breakout window (days) · Kiru uses 20</label><input id="s-lb" type="number" value="${S.lookback}">
      <label>Momentum: ETFs to hold</label><input id="s-top" type="number" value="${S.topN}">
      <label>Cash return (% per year) for empty momentum slots</label><input id="s-cash" type="number" step="0.5" value="${S.cashRate}">
      <label>Backtest start year</label><input id="s-start" type="number" value="${S.startYear}">
      <label>Out-of-sample split year</label><input id="s-split" type="number" value="${S.splitYear}">
      <label>Price data source</label><select id="s-src" style="width:100%;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:10px;padding:10px;font:inherit">
        <option value="auto"${S.source === 'auto' ? ' selected' : ''}>Auto: best of Yahoo and Upstox (recommended)</option>
        <option value="yahoo"${S.source === 'yahoo' ? ' selected' : ''}>Yahoo Finance only</option>
        <option value="upstox"${S.source === 'upstox' ? ' selected' : ''}>Upstox only</option></select>
      <label>Momentum ETF universe (NSE symbols, comma separated)</label><textarea id="s-uni">${S.universe}</textarea>
      <div class="row" style="margin-top:12px"><button class="btn" id="s-save">Save & re-run</button><button class="btn ghost" id="s-def">Defaults</button></div></div>
      <div class="card"><h3>Data health</h3>${healthTable()}
        <div class="note">Gap days = calendar days with no prices beyond normal holidays (any stretch over 10 days). Should be 0. Example: a missing 2011 to 2014 stretch shows about 1,400 gap days. Jumps = days moving over 15%, should be 0 for ETFs (except rare crashes like Mar 2020).</div></div>
      <div class="card"><h3>Data</h3><div class="note">Prices: Yahoo Finance and Upstox historical candles (both free, no login). In Auto mode each ETF uses the source with fewer holes. Splits are detected and adjusted automatically.</div>
        <div class="note">${(R && R.splits.length) ? R.splits.join('<br>') : 'No data fixes needed.'}</div>
        <details><summary>Upstox instrument codes</summary><div class="note">${Object.entries(keys).map(([s, k]) => `${s}: ${k}`).join('<br>') || 'none yet'}</div></details>
        <div class="row" style="margin-top:10px"><button class="btn ghost" id="s-redl">Re-download all prices</button><button class="btn ghost" id="s-clear">Clear codes cache</button></div></div>
      <div class="card note">Not investment advice. Backtests show what a rule did in the past, not what it will do.</div>`;
    $('#s-save').onclick = () => {
      S = Object.assign(S, { cost: +$('#s-cost').value, lookback: Math.max(2, +$('#s-lb').value | 0), topN: Math.max(1, +$('#s-top').value | 0), cashRate: +$('#s-cash').value,
        startYear: +$('#s-start').value | 0, source: $('#s-src').value, splitYear: +$('#s-split').value | 0, universe: $('#s-uni').value.replace(/\s+/g, '') });
      store.set('settings', S); boot(false);
    };
    $('#s-def').onclick = () => { S = Object.assign({}, DEFAULTS); store.set('settings', S); boot(false); };
    $('#s-redl').onclick = () => boot(true);
    $('#s-clear').onclick = () => { store.del('ikeys'); boot(true); };
  }


  // ---------------- report + AI review ----------------
  function buildReport() {
    if (!R) return 'No data loaded yet.';
    const L = [];
    const m2 = (n, m) => m ? `${n}: CAGR ${m.cagr}%, MaxDD ${m.mdd}%, Sharpe ${m.sharpe}, Vol ${m.vol}%, Rs1L->${Math.round(m.finalX * 100000)}, longest underwater ${m.underwaterDays} days` : `${n}: n/a`;
    L.push(`KIRU BACKTEST REPORT | app data as of ${R.today.date} | generated ${new Date().toISOString().slice(0, 16)}`);
    L.push(`Settings: cost ${S.cost}%/side, lookback ${S.lookback}d, momentum topN ${S.topN}, cash ${S.cashRate}%, start ${S.startYear}, split ${S.splitYear}, source ${S.source || 'auto'}`);
    L.push('\n## DATA HEALTH (gap days should be 0)');
    Object.entries(window.__health || {}).forEach(([k, h]) => L.push(`${k}: src ${h.src}, from ${h.first}, rows ${h.rows}, gapDays ${h.gaps.totalDays}${h.gaps.list.length ? ' [' + h.gaps.list.map(g => g.from + '->' + g.to).join('; ') + ']' : ''}, upstoxGaps ${h.upGaps ?? '-'}, yahooGaps ${h.yhGaps ?? '-'}`));
    if (R.splits.length) L.push('Data fixes applied: ' + R.splits.join('; '));
    Object.entries(window.__health || {}).forEach(([k, h]) => { if (h.big.length) L.push(`${k} daily moves >15% (check!): ${h.big.slice(0, 8).join(', ')}`); });
    L.push(`Pair (NIFTYBEES/GOLDBEES) gaps after start: ${R.pairGaps.list.length ? R.pairGaps.list.map(g => `${g.from}->${g.to} (${g.days}d)`).join(', ') : 'none'}`);
    L.push(`\n## STRATEGY A: Nifty/Gold ratio switch (Kiru claims 18.0% CAGR, -24.95% MaxDD, Jan 2008-May 2026), ${R.aD[0]} -> ${R.aD.at(-1)}`);
    Object.entries(R.aM).forEach(([n, m]) => L.push(m2(n, m)));
    L.push(m2(`Before ${S.splitYear}`, R.aSplit.in)); L.push(m2(`From ${S.splitYear}`, R.aSplit.out));
    L.push('Robustness (lookback: CAGR / MaxDD / Sharpe / switches): ' + R.robust.map(r => `${r.lookback}d: ${r.cagr}/${r.mdd}/${r.sharpe}/${r.switches}`).join(' | '));
    const sw = {}; R.A.trades.forEach(t => { const y = t.date.slice(0, 4); sw[y] = (sw[y] || 0) + 1; });
    L.push('Year: switch% / nifty% / gold% / #switches');
    R.yearlyA.forEach((y, i) => L.push(`${y.year}: ${y.ret} / ${R.yearlyN[i]?.ret} / ${R.yearlyG[i]?.ret} / ${sw[y.year] || 0}`));
    const ddA = E.drawdown(R.aEq); let wi = 0; ddA.forEach((d, i) => { if (d < ddA[wi]) wi = i; });
    L.push(`Worst drawdown trough date: ${R.aD[wi]}`);
    L.push('Last 15 switches: ' + R.A.trades.slice(-15).map(t => `${t.date} ${t.holding}`).join(', '));
    const t = R.today;
    L.push(`TODAY: holding ${t.holding}, ratio ${t.ratio.toFixed(4)}, 20d high ${t.hi.toFixed(4)}, 20d low ${t.lo.toFixed(4)}, signal fired today: ${t.fired || 'none'}, last switch ${t.lastSwitch}`);
    if (R.B) {
      L.push(`\n## STRATEGY B: smooth momentum rotation, ${R.bD[0]} -> ${R.bD.at(-1)}`);
      L.push(m2('Momentum', R.bM)); L.push(m2('Niftybees B&H same period', R.nbM));
      L.push('Yearly momentum %: ' + E.yearly(R.bD, R.bEq).map(y => `${y.year}:${y.ret}`).join(' '));
      L.push('Last 6 picks: ' + R.B.picks.slice(-6).map(p => `${p.date} ${p.picks}`).join(' | '));
      L.push('Ranking now: ' + R.rankNow.map(r => `${r.etf} ${r.score ?? '-'}${r.aboveSma ? '' : '(below200)'}`).join(', '));
    }
    const P = store.get('paper', null);
    if (P) {
      const run = paperRun(P.start, P.capital);
      const f = (n, rows) => rows && rows.length ? `${n}: ${rows.length} days, value ${Math.round(rows.at(-1).value)} (${((rows.at(-1).value / P.capital - 1) * 100).toFixed(2)}%), holding ${rows.at(-1).hold}` : `${n}: not started yet`;
      L.push(`\n## PAPER TRADING since ${P.start}, capital ${P.capital}`); L.push(f('A', run.A)); L.push(f('B', run.B));
    } else L.push('\n## PAPER TRADING: not started');
    return L.join('\n');
  }

  const REVIEW_PROMPT = `You are a strict systematic-trading reviewer in the style of Kirubakaran Rajendran (Kiru): rule-based, data-first, survival-first ("In God we trust, all others must bring data"). Review the backtest report below for an Indian ETF trader who lives in Boston and will place orders manually.
Write in simple, warm Indian English. Never use em dashes. Be candid; do not hype. Whenever you use jargon (CAGR, drawdown, Sharpe, whipsaw, curve fitting), add a one-line example with real rupee numbers.
Use exactly these sections with markdown headings:
## Verdict
One line: Trust / Trust with caution / Do not trust yet, and why.
## Data check
Any gaps, splits, short history, or source problems. If data is broken, say results cannot be trusted and stop the deep analysis.
## Kiru claim vs this backtest
Compare against 18.0% CAGR and -24.95% max drawdown.
## Green flags
## Red flags
Check: robustness across lookbacks (curve fitting), before vs after split, edge over plain Goldbees and 50/50 (is the extra return worth it), whipsaw years (many switches, small return), worst drawdown and how long underwater, cost sensitivity.
## Position sizing
Using Kiru's rule (size so the worst historical drawdown costs no more than 15-20% of total capital), say how much of a portfolio could go into this, with a rupee example on Rs 10,00,000.
## Momentum strategy
Short verdict on Strategy B vs Niftybees.
## What to do today
Based on TODAY line: hold or switch, in one line.
## Next 3 experiments
Concrete settings changes to test in the app (e.g. cost 0.2%, start year 2012), each with what result would worry you.
Keep it under 500 words.

REPORT:
`;

  function npost(url, body, hn, hv) {
    if (window.Native && window.Native.post) return new Promise((res, rej) => { const id = 'p' + (++cbId); pending[id] = { res, rej }; window.Native.post(id, url, body, hn || '', hv || ''); });
    return fetch(url, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, hn ? { [hn]: hv } : {}), body }).then(async r => { const t = await r.text(); if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 300)); return t; });
  }
  async function geminiReview(report) {
    const key = store.get('geminiKey', '');
    if (!key) throw new Error('Add your Gemini API key first');
    const models = [...new Set([store.get('geminiModel', 'gemini-4-carbon'), 'gemini-4-carbon', 'gemini-3.6-flash', 'gemini-flash-latest', 'gemini-2.5-flash'].filter(Boolean))];
    const body = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: REVIEW_PROMPT + report }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 16384 } });
    let lastErr, fellBack = '';
    for (const m of models) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;
        let txt;
        try { txt = await npost(url, body, 'x-goog-api-key', key); }
        catch (e1) { if (!/UnknownHost|resolve|timeout|Connect|Socket/i.test(e1.message)) throw e1; await new Promise(r => setTimeout(r, 2000)); txt = await npost(url, body, 'x-goog-api-key', key); }
        const j = JSON.parse(txt);
        const out = (j.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
        if (!out) throw new Error('Empty answer (' + (j.candidates?.[0]?.finishReason || j.promptFeedback?.blockReason || 'unknown') + ')');
        return { text: out, model: m, note: fellBack };
      } catch (e) {
        lastErr = e;
        const paidOnly = /carbon/.test(m) && /HTTP 40[03]|HTTP 429|permission|billing|paid|quota|not available/i.test(e.message);
        if (paidOnly) { fellBack = 'Gemini 4 Carbon needs a paid key, so this review used a free model.'; continue; }
        if (!/HTTP 404|not found|not supported/i.test(e.message)) throw e;   // only fall through on unknown model
      }
    }
    throw lastErr;
  }
  function md(t) {
    const esc = x => x.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return esc(t).split('\n').map(l => {
      l = l.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
      if (/^###? /.test(l)) return `<h3 style="margin:14px 0 6px">${l.replace(/^#+ /, '')}</h3>`;
      if (/^\s*[-*] /.test(l)) return `<div style="padding-left:14px;text-indent:-10px">• ${l.replace(/^\s*[-*] /, '')}</div>`;
      return l.trim() ? `<div style="margin:4px 0">${l}</div>` : '';
    }).join('');
  }
  function renderReview() {
    const last = store.get('lastReview', null), key = store.get('geminiKey', '');
    $('#tab-review').innerHTML = `
      <div class="card"><h3>✦ AI review</h3><div class="note" style="color:var(--fg)">One tap sends every result in the app (all tabs, data health, switches, paper trades) to Gemini with a Kiru-style checklist: data check, claim vs reality, curve fitting, edge over gold, whipsaw, position sizing and today's action.</div>
        <div class="row" style="margin-top:10px"><button class="btn" id="r-run">Run AI review</button></div>
        <div id="r-out" style="margin-top:10px">${last ? `<div class="note">Last review: ${last.at} · ${last.model} · data ${last.data}</div>${last.note ? `<div class="note" style="color:var(--gold)">${last.note}</div>` : ''}${md(last.text)}` : '<div class="note">No review yet.</div>'}</div></div>
      <div class="card"><h3>Send to Claude instead</h3><div class="note">Copies the full report as text. Paste it in your Claude chat, no screenshots needed.</div>
        <div class="row" style="margin-top:8px"><button class="btn ghost" id="r-copy">Copy report</button><button class="btn ghost" id="r-share">Share…</button><button class="btn ghost" id="r-view">View report</button></div>
        <pre id="r-rep" class="hidden" style="white-space:pre-wrap;font-size:11px;color:var(--muted)"></pre></div>
      <div class="card"><h3>Gemini key</h3><div class="note">Free key from aistudio.google.com → Get API key. Stored only on this phone.</div>
        <label>API key</label><input id="r-key" type="password" value="${key ? '••••••••' + key.slice(-4) : ''}" placeholder="AIza...">
        <label>Model</label><select id="r-model" style="width:100%;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:10px;padding:10px;font:inherit">
          ${[['gemini-4-carbon', 'Gemini 4 Carbon: deepest, paid key (~₹4 to ₹8 per review)'], ['gemini-3.6-flash', 'Gemini 3.6 Flash: fast, free tier']].map(([v, l]) => `<option value="${v}"${store.get('geminiModel', 'gemini-4-carbon') === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <div class="note">If Carbon is refused (free key), the app falls back to Flash automatically.</div>
        <div class="row" style="margin-top:10px"><button class="btn ghost" id="r-save">Save key</button></div></div>`;
    $('#r-save').onclick = () => { const v = $('#r-key').value.trim(); if (v && !v.startsWith('••')) store.set('geminiKey', v); store.set('geminiModel', $('#r-model').value || 'gemini-4-carbon'); status('Gemini key saved'); setTimeout(() => status(''), 1500); renderReview(); };
    $('#r-copy').onclick = () => { const t = buildReport(); if (window.Native && window.Native.copy) window.Native.copy(t); else navigator.clipboard && navigator.clipboard.writeText(t); };
    $('#r-share').onclick = () => { const t = buildReport(); if (window.Native && window.Native.share) window.Native.share(t); };
    $('#r-view').onclick = () => { const el = $('#r-rep'); el.textContent = buildReport(); el.classList.toggle('hidden'); };
    $('#r-run').onclick = async () => {
      const out = $('#r-out'); out.innerHTML = '<div class="note">Gemini is reading your backtest... (10 to 40 seconds)</div>';
      try {
        const r = await geminiReview(buildReport());
        const rec = { text: r.text, model: r.model, note: r.note, at: new Date().toLocaleString('en-IN'), data: R.today.date };
        store.set('lastReview', rec); renderReview();
      } catch (e) { const net = /UnknownHost|Unable to resolve|timeout|ConnectException|SocketException/i.test(e.message); out.innerHTML = `<div class="note neg">Review failed: ${e.message.replace(/</g, '&lt;')}</div><div class="note">${net ? 'Network problem, not your key. Check internet, VPN or Private DNS, then try again.' : 'Check the key, or pick Gemini 3.6 Flash.'}</div>`; }
    };
  }
  function renderAll() { renderToday(); renderA(); renderB(); renderPaper(); renderReview(); renderSettings(); $('#asof').textContent = 'data ' + R.today.date; }

  // ---------------- boot ----------------
  let busy = false;
  async function boot(force) {
    if (busy) return; busy = true;
    try {
      const { data, problems } = await loadAll(force);
      if (!data.NIFTYBEES || !data.GOLDBEES) throw new Error('Could not load NIFTYBEES/GOLDBEES. ' + problems.join('; '));
      status('Running backtests...');
      await new Promise(r => setTimeout(r, 30));
      compute(data); renderAll();
      status(problems.length ? 'Note: ' + problems.join(' · ') : '', problems.length > 0 && problems.some(p => !p.includes('saved')));
      if (!problems.length) setTimeout(() => status(''), 100);
    } catch (e) {
      console.log(e);
      status('Problem: ' + e.message + '. Check internet and tap ⟳.', true);
      renderSettings(); renderReview();
    } finally { busy = false; }
  }
  document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
    document.querySelectorAll('nav button').forEach(x => x.classList.toggle('on', x === b));
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
    Object.values(charts).forEach(c => c.resize());
    window.scrollTo(0, 0);
  });
  $('#refresh').onclick = () => boot(false);
  try { Object.keys(localStorage).filter(k => k.startsWith('px_')).forEach(k => localStorage.removeItem(k)); } catch (e) { }
  window.__boot = boot;
  boot(false);
})();
