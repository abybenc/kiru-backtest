// Kiru ETF backtest engine (JS port of the tested Python engine).
// Series format: {dates: ['YYYY-MM-DD',...], v: [numbers]} ; frames: {dates, cols:{name:[...]}}
(function (root) {
  const TD = 252;

  // ---------- helpers ----------
  function align(seriesMap) {
    // inner-join on dates for all series in map {name:{dates,v}}
    const names = Object.keys(seriesMap);
    const maps = names.map(n => { const m = new Map(); const s = seriesMap[n]; s.dates.forEach((d, i) => m.set(d, s.v[i])); return m; });
    const dates = seriesMap[names[0]].dates.filter(d => maps.every(m => m.has(d) && m.get(d) != null && isFinite(m.get(d))));
    const cols = {}; names.forEach((n, k) => cols[n] = dates.map(d => maps[k].get(d)));
    return { dates, cols };
  }
  function outerAlign(seriesMap) {
    // union of dates, forward-filled, null before first value
    const names = Object.keys(seriesMap);
    const all = new Set(); names.forEach(n => seriesMap[n].dates.forEach(d => all.add(d)));
    const dates = [...all].sort();
    const cols = {};
    names.forEach(n => {
      const m = new Map(); const s = seriesMap[n]; s.dates.forEach((d, i) => m.set(d, s.v[i]));
      let last = null; cols[n] = dates.map(d => { if (m.has(d)) last = m.get(d); return last; });
    });
    return { dates, cols };
  }
  const yearsBetween = (a, b) => (new Date(b) - new Date(a)) / (365.25 * 864e5);
  const r2 = x => (x == null || !isFinite(x)) ? null : Math.round(x * 100) / 100;

  // ---------- split detection (broker candles are often unadjusted) ----------
  // ---------- data cleaning: bad ticks, mis-scaled stretches, splits ----------
  // No ETF moves 40%+ in one day; any such jump is a data artefact.
  function adjustSplits(s) {
    let dates = s.dates.slice(), v = s.v.slice(); const events = [];
    const factors = [2, 4, 5, 10, 20, 25, 50, 100];
    const near = r => { const x = r >= 1 ? r : 1 / r; const f = factors.reduce((b, f) => Math.abs(Math.log(x / f)) < Math.abs(Math.log(x / b)) ? f : b, 2); return Math.abs(x / f - 1) < 0.15 ? (r >= 1 ? f : 1 / f) : null; };
    // pass 1: big jumps (outside 0.6x..1.6x)
    const span = i => (new Date(dates[i]) - new Date(dates[i - 1])) / 864e5;
    for (let i = 1; i < v.length; i++) {
      const r = v[i] / v[i - 1];
      if ((r > 0.6 && r < 1.6) || span(i) > 10) continue;   // a move across a data hole is real, not an error
      let j = -1;   // reverse jump within 15 rows -> the stretch i..j-1 is on the wrong scale
      for (let k = i + 1; k < Math.min(v.length, i + 16); k++) { const q = v[k] / v[k - 1]; if (Math.abs(Math.log(q * r)) < 0.2) { j = k; break; } }
      if (j > 0) {
        for (let k = i; k < j; k++) v[k] /= r;
        events.push({ date: dates[i], type: 'bad prices fixed', factor: +r.toFixed(3), days: j - i });
      } else {
        const f = near(r) || r;   // persistent: split (or a source switch); rescale history before it
        for (let k = 0; k < i; k++) v[k] *= f;
        events.push({ date: dates[i], type: near(r) ? 'split' : 'level shift', factor: f >= 1 ? +f.toFixed(3) : '1:' + Math.round(1 / f) });
      }
    }
    // pass 2: single-day spikes of 20%+ that revert next day
    const keep = v.map(() => true);
    for (let i = 1; i < v.length - 1; i++) {
      const a = v[i] / v[i - 1], c = v[i + 1] / v[i - 1];
      if ((a > 1.2 || a < 0.83) && c > 0.92 && c < 1.08 && span(i) <= 10 && span(i + 1) <= 10) { keep[i] = false; events.push({ date: dates[i], type: 'bad tick removed', factor: +a.toFixed(3) }); }
    }
    dates = dates.filter((_, i) => keep[i]); v = v.filter((_, i) => keep[i]);
    return { dates, v, events };
  }
  // Fill holes (and earlier history) in `base` from `other`, scaled to match at the join.
  function spliceFill(base, other, maxGap = 10) {
    if (!other || other.dates.length < 2) return { dates: base.dates, v: base.v, filled: 0 };
    const om = new Map(other.dates.map((d, i) => [d, other.v[i]]));
    const bm = new Map(base.dates.map((d, i) => [d, base.v[i]]));
    let filled = 0;
    const scaleAt = d => { const o = om.get(d), b = bm.get(d); return (o && b) ? b / o : null; };
    // earlier history
    const first = base.dates[0]; const sc0 = scaleAt(first);
    if (sc0) other.dates.forEach((d, i) => { if (d < first) { bm.set(d, other.v[i] * sc0); filled++; } });
    // interior gaps
    for (let i = 1; i < base.dates.length; i++) {
      const a = base.dates[i - 1], z = base.dates[i];
      if ((new Date(z) - new Date(a)) / 864e5 <= maxGap) continue;
      const sc = scaleAt(a); if (!sc) continue;
      other.dates.forEach((d, k) => { if (d > a && d < z) { bm.set(d, other.v[k] * sc); filled++; } });
    }
    const dates = [...bm.keys()].sort();
    return { dates, v: dates.map(d => bm.get(d)), filled };
  }
  function bigMoves(s, from = '0000', thr = 0.15) {
    const out = []; for (let i = 1; i < s.dates.length; i++) { if (s.dates[i] < from || (new Date(s.dates[i]) - new Date(s.dates[i - 1])) / 864e5 > 10) continue; const r = s.v[i] / s.v[i - 1] - 1; if (Math.abs(r) > thr) out.push(`${s.dates[i]} ${(r * 100).toFixed(1)}%`); } return out;
  }

  // ---------- metrics ----------
  function metrics(dates, eq) {
    const n = eq.length; if (n < 2) return null;
    const rets = []; for (let i = 1; i < n; i++) rets.push(eq[i] / eq[i - 1] - 1);
    const yrs = yearsBetween(dates[0], dates[n - 1]);
    const cagr = Math.pow(eq[n - 1] / eq[0], 1 / yrs) - 1;
    let peak = eq[0], mdd = 0, peakIdx = 0, longest = 0;
    for (let i = 0; i < n; i++) {
      if (eq[i] >= peak) { const gap = (new Date(dates[i]) - new Date(dates[peakIdx])) / 864e5; if (gap > longest) longest = gap; peak = eq[i]; peakIdx = i; }
      const dd = eq[i] / peak - 1; if (dd < mdd) mdd = dd;
    }
    const tail = (new Date(dates[n - 1]) - new Date(dates[peakIdx])) / 864e5; if (tail > longest) longest = tail;
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
    const vol = sd * Math.sqrt(TD);
    return {
      start: dates[0], end: dates[n - 1], years: r2(yrs), finalX: r2(eq[n - 1] / eq[0]),
      cagr: r2(cagr * 100), mdd: r2(mdd * 100), vol: r2(vol * 100),
      sharpe: r2(vol > 0 ? mean * TD / vol : null), calmar: r2(mdd < 0 ? cagr / Math.abs(mdd) : null),
      underwaterDays: Math.round(longest),
    };
  }
  function drawdown(eq) { let p = eq[0]; return eq.map(x => { if (x > p) p = x; return (x / p - 1) * 100; }); }
  function yearly(dates, eq) {
    const out = []; let prev = eq[0], curY = dates[0].slice(0, 4), last = eq[0];
    for (let i = 0; i < dates.length; i++) {
      const y = dates[i].slice(0, 4);
      if (y !== curY) { out.push({ year: +curY, ret: r2((last / prev - 1) * 100) }); prev = last; curY = y; }
      last = eq[i];
    }
    out.push({ year: +curY, ret: r2((last / prev - 1) * 100) });
    return out;
  }

  // ---------- simulator ----------
  // frame: {dates, cols}; targets: array (len = dates) of null or {col:weight}
  // target decided at close of day t is executed at close of day t+1.
  function simulate(frame, targets, cost = 0.001, cashRate = 0, start = 100000) {
    const names = Object.keys(frame.cols), n = frame.dates.length;
    const cashD = Math.pow(1 + cashRate, 1 / TD) - 1;
    let w = Object.fromEntries(names.map(c => [c, 0])), value = start;
    const eq = new Array(n), wlog = new Array(n), trades = [];
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        let growth = 0, inv = 0; const nw = {};
        for (const c of names) {
          const p0 = frame.cols[c][i - 1], p1 = frame.cols[c][i];
          const r = (p0 && p1) ? p1 / p0 - 1 : 0;
          nw[c] = w[c] * (1 + r); growth += nw[c]; inv += w[c];
        }
        growth += (1 - inv) * (1 + cashD);
        value *= growth; for (const c of names) w[c] = nw[c] / growth;
      }
      const t = i > 0 ? targets[i - 1] : null;
      if (t) {
        let turnover = 0; for (const c of names) turnover += Math.abs((t[c] || 0) - w[c]);
        if (turnover > 1e-6) {
          value *= (1 - cost * turnover);
          w = Object.fromEntries(names.map(c => [c, t[c] || 0]));
          const held = names.filter(c => w[c] > 0);
          trades.push({ date: frame.dates[i], holding: held.length ? held.join(', ') : 'CASH', turnover: r2(turnover), value: Math.round(value) });
        }
      }
      eq[i] = value; wlog[i] = { ...w };
    }
    return { dates: frame.dates, eq, w: wlog, trades };
  }

  // ---------- Strategy A: Kiru's ratio switch ----------
  function ratioSignals(frame, lookback = 20) {
    const a = frame.cols.EQ, b = frame.cols.GOLD, n = frame.dates.length;
    const ratio = a.map((x, i) => x / b[i]);
    const targets = new Array(n).fill(null); let state = null;
    const states = new Array(n).fill(null);
    for (let i = lookback; i < n; i++) {
      let hi = -Infinity, lo = Infinity;
      for (let j = i - lookback; j < i; j++) { if (ratio[j] > hi) hi = ratio[j]; if (ratio[j] < lo) lo = ratio[j]; }
      let ns = state;
      if (ratio[i] > hi) ns = 1; else if (ratio[i] < lo) ns = 0;
      if (ns !== state && ns !== null) { targets[i] = { EQ: ns, GOLD: 1 - ns }; state = ns; }
      states[i] = state;
    }
    return { ratio, targets, states };
  }
  function runRatio(frame, lookback = 20, cost = 0.001) {
    const s = ratioSignals(frame, lookback);
    const res = simulate(frame, s.targets, cost);
    res.ratio = s.ratio; res.states = s.states;
    return res;
  }
  function ratioToday(frame, lookback = 20) {
    const s = ratioSignals(frame, lookback), n = s.ratio.length, i = n - 1;
    let hi = -Infinity, lo = Infinity;
    for (let j = i - lookback; j < i; j++) { hi = Math.max(hi, s.ratio[j]); lo = Math.min(lo, s.ratio[j]); }
    const cur = s.states[i];
    const fired = s.targets[i] ? (s.targets[i].EQ === 1 ? 'NIFTYBEES' : 'GOLDBEES') : null;
    const lastSwitch = (() => { for (let k = i; k >= 0; k--) if (s.targets[k]) return frame.dates[k]; return null; })();
    return { date: frame.dates[i], ratio: s.ratio[i], hi, lo, holding: cur === 1 ? 'NIFTYBEES' : cur === 0 ? 'GOLDBEES' : null,
      fired, lastSwitch, toLowPct: (lo / s.ratio[i] - 1) * 100, toHighPct: (hi / s.ratio[i] - 1) * 100 };
  }
  function robustness(frame, lbs = [10, 15, 20, 30, 40, 50, 60], cost = 0.001, from = '0000') {
    return lbs.map(lb => { const r = runRatio(frame, lb, cost); const s = sliceFrom(r.dates, r.eq, from); const m = metrics(s.dates, s.eq); return { lookback: lb, cagr: m.cagr, mdd: m.mdd, sharpe: m.sharpe, switches: r.trades.length }; });
  }

  // ---------- Strategy B: smooth momentum rotation ----------
  function momentumScore(px, i) {
    // avg of (6m ret / 6m ann vol) and (12m ret / 12m ann vol); null if not enough history
    let tot = 0;
    for (const n of [126, 252]) {
      if (i - n < 0 || px[i - n] == null || px[i] == null) return null;
      const ret = px[i] / px[i - n] - 1;
      const rs = []; for (let k = i - n + 1; k <= i; k++) rs.push(px[k] / px[k - 1] - 1);
      const m = rs.reduce((a, b) => a + b, 0) / rs.length;
      const sd = Math.sqrt(rs.reduce((a, b) => a + (b - m) ** 2, 0) / (rs.length - 1)) * Math.sqrt(TD);
      if (!(sd > 0)) return null;
      tot += ret / sd;
    }
    return tot / 2;
  }
  function sma(px, i, n) { if (i - n + 1 < 0) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) { if (px[k] == null) return null; s += px[k]; } return s / n; }
  function rankAt(frame, i, smaLen = 200) {
    return Object.keys(frame.cols).map(c => {
      const px = frame.cols[c], sc = momentumScore(px, i), ma = sma(px, i, smaLen);
      return { etf: c, raw: sc, score: sc == null ? null : r2(sc), aboveSma: ma != null && px[i] > ma };
    }).sort((a, b) => (b.raw ?? -1e9) - (a.raw ?? -1e9));
  }
  function runMomentum(frame, topN = 3, smaLen = 200, cost = 0.001, cashRate = 0.06) {
    const n = frame.dates.length, names = Object.keys(frame.cols);
    // first index where at least topN ETFs have a score
    let first = -1;
    const targets = new Array(n).fill(null), picks = [];
    for (let i = 0; i < n - 1; i++) {
      const monthEnd = frame.dates[i].slice(0, 7) !== frame.dates[i + 1].slice(0, 7);
      if (!monthEnd) continue;
      const ranked = rankAt(frame, i, smaLen);
      if (ranked.filter(r => r.score != null).length === 0) continue;
      if (first < 0) first = i;
      const chosen = ranked.filter(r => r.score != null && r.aboveSma).slice(0, topN).map(r => r.etf);
      const t = Object.fromEntries(names.map(c => [c, 0])); chosen.forEach(c => t[c] = 1 / topN);
      targets[i] = t;
      picks.push({ date: frame.dates[i], picks: chosen.length ? chosen.join(', ') : 'CASH', cashPct: Math.round((topN - chosen.length) / topN * 100) });
    }
    if (first < 0) return null;
    const sub = { dates: frame.dates.slice(first), cols: Object.fromEntries(names.map(c => [c, frame.cols[c].slice(first)])) };
    const res = simulate(sub, targets.slice(first), cost, cashRate);
    res.picks = picks; res.offset = first;
    return res;
  }

  function buyHold(dates, px) { const b = px.find(x => x != null); return px.map(x => x == null ? null : x / b * 100000); }
  function fixedMix(frame, weights, cost = 0.001) {
    const n = frame.dates.length, t = new Array(n).fill(null);
    t[0] = weights;
    for (let i = 0; i < n - 1; i++) if (frame.dates[i].slice(0, 4) !== frame.dates[i + 1].slice(0, 4)) t[i] = weights;
    return simulate(frame, t, cost).eq;
  }
  function sliceFrom(dates, eq, from) { const i = dates.findIndex(d => d >= from); if (i < 0) return null; return { dates: dates.slice(i), eq: eq.slice(i) }; }

  // ---------- data health: missing stretches > maxDays calendar days ----------
  function gaps(s, from = '0000', maxDays = 10) {
    const out = []; let total = 0;
    for (let i = 1; i < s.dates.length; i++) {
      if (s.dates[i] < from) continue;
      const d = (new Date(s.dates[i]) - new Date(s.dates[i - 1])) / 864e5;
      if (d > maxDays) { out.push({ from: s.dates[i - 1], to: s.dates[i], days: Math.round(d) }); total += d; }
    }
    return { list: out, totalDays: Math.round(total) };
  }
  function rowsPerYear(s, from = '0000') {
    const m = {}; s.dates.forEach(d => { if (d >= from) { const y = d.slice(0, 4); m[y] = (m[y] || 0) + 1; } }); return m;
  }

  root.Engine = { gaps, rowsPerYear, spliceFill, bigMoves, align, outerAlign, adjustSplits, metrics, drawdown, yearly, simulate, runRatio, ratioToday, robustness,
    runMomentum, rankAt, buyHold, fixedMix, sliceFrom };
})(typeof window !== 'undefined' ? window : globalThis);
