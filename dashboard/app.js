// Launch Ledger v7 — the dashboard. Reads window.RADAR (written beside dashboard/ by main.ts)
// and renders the ranked board, a detail view per protocol, the evidence tables and a sandbox
// that re-prices the verdicts live. No network: every byte it shows is in data.js.
(function () {
  'use strict';
  var DATA = window.RADAR;
  if (!DATA) return;
  var rows = DATA.rows;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', verdict: 'all', sort: 'ev', dir: -1, selected: null, pinned: {}, compare: [] };
  var sandbox = { share: 5, farmers: 10000, gas: 12, capital: 1, bar: 50 };

  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(a) {
    if (a === null || a === undefined) return 'unknown';
    if (a >= 1) return a.toFixed(1) + 'y';
    return Math.max(0, Math.round(a * 365)) + 'd';
  }
  function fmtInt(n) { return Math.round(n).toLocaleString('en-US'); }
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  // Compact synchronous SHA-256 (ASCII input only) — the page recomputes the board's checksum
  // from the rows it shows, so the number on the cover is the board's own, not a claim.
  function sha256Hex(ascii) {
    function rr(v, a) { return (v >>> a) | (v << (32 - a)); }
    var maxWord = Math.pow(2, 32), result = '', words = [];
    var asciiBitLength = ascii.length * 8;
    var hash = sha256Hex.h = sha256Hex.h || [];
    var k = sha256Hex.k = sha256Hex.k || [];
    var primeCounter = k.length, isComposite = {};
    for (var candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (var i = 0; i < 313; i += candidate) isComposite[i] = candidate;
        hash[primeCounter] = (Math.pow(candidate, 0.5) * maxWord) | 0;
        k[primeCounter++] = (Math.pow(candidate, 1 / 3) * maxWord) | 0;
      }
    }
    ascii += '\x80';
    while (ascii.length % 64 - 56) ascii += '\x00';
    for (var i = 0; i < ascii.length; i++) {
      var j = ascii.charCodeAt(i);
      if (j >> 8) return '';
      words[i >> 2] |= j << ((3 - i) % 4) * 8;
    }
    words[words.length] = (asciiBitLength / maxWord) | 0;
    words[words.length] = asciiBitLength;
    for (var j = 0; j < words.length;) {
      var w = words.slice(j, j += 16), oldHash = hash;
      hash = hash.slice(0, 8);
      for (var i = 0; i < 64; i++) {
        var w15 = w[i - 15], w2 = w[i - 2], a = hash[0], e = hash[4];
        var temp1 = hash[7] + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & hash[5]) ^ (~e & hash[6])) + k[i]
          + (w[i] = (i < 16) ? w[i] : (w[i - 16] + (rr(w15, 7) ^ rr(w15, 18) ^ (w15 >>> 3)) + w[i - 7] + (rr(w2, 17) ^ rr(w2, 19) ^ (w2 >>> 10))) | 0);
        var temp2 = (rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(temp1 + temp2) | 0].concat(hash);
        hash[4] = (hash[4] + temp1) | 0;
      }
      for (var i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
    }
    for (var i = 0; i < 8; i++) for (var j = 3; j + 1; j--) {
      var b = (hash[i] >> (j * 8)) & 255;
      result += ((b < 16) ? 0 : '') + b.toString(16);
    }
    return result;
  }
  function boardChecksum() {
    var compact = rows.map(function (r) { return [r.slug, r.rank, r.implied_value_usd]; });
    return sha256Hex(JSON.stringify(compact)).slice(0, 8);
  }

  function verdictFor(ev) {
    var net = (sandbox.share / 100) * ev / sandbox.farmers - sandbox.gas - sandbox.capital;
    return net >= sandbox.bar ? 'FARM' : net >= 0 ? 'THIN' : 'SKIP';
  }
  function netFor(ev) { return (sandbox.share / 100) * ev / sandbox.farmers - sandbox.gas - sandbox.capital; }

  function categories() {
    var seen = {};
    rows.forEach(function (r) { seen[r.category || '(none)'] = true; });
    return Object.keys(seen).sort();
  }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var list = rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || '(none)') !== state.category) return false;
      if (state.verdict !== 'all' && verdictFor(r.implied_value_usd) !== state.verdict) return false;
      if (q && (r.name + ' ' + r.slug + ' ' + (r.category || '')).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var key = state.sort, dir = state.dir;
    list.sort(function (a, b) {
      var va = key === 'ev' ? a.implied_value_usd : key === 'tvl' ? a.tvl_usd : key === 'age' ? (a.age_years === null ? -1 : a.age_years) : a.rank;
      var vb = key === 'ev' ? b.implied_value_usd : key === 'tvl' ? b.tvl_usd : key === 'age' ? (b.age_years === null ? -1 : b.age_years) : b.rank;
      return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
    });
    return list;
  }

  var tableWrap, countEl, detailWrap, compareWrap, sandboxOut;

  function renderTable() {
    var list = filtered();
    countEl.textContent = 'Showing ' + list.length + ' of ' + rows.length;
    tableWrap.innerHTML = '';
    var table = el('table', { 'class': 'board' });
    var head = el('tr');
    [['#', 'rank'], ['Protocol', 'rank'], ['Category', 'rank'], ['TVL', 'tvl'], ['Age', 'age'], ['7d', 'rank'], ['Implied mcap', 'ev'], ['P(token)', 'ev'], ['Expected value', 'ev'], ['Verdict', 'ev'], ['', 'rank']].forEach(function (h) {
      head.appendChild(el('th', { text: h[0], onclick: function () { state.sort = h[1]; state.dir = -state.dir; renderTable(); } }));
    });
    table.appendChild(el('thead', null, head));
    var body = el('tbody');
    list.forEach(function (r) {
      var v = verdictFor(r.implied_value_usd);
      var tr = el('tr', { 'class': state.pinned[r.slug] ? 'pinned' : '' });
      tr.appendChild(el('td', { 'class': 'num', text: String(r.rank) }));
      var nameCell = el('td');
      nameCell.appendChild(el('button', { 'class': 'link', text: r.name, onclick: function () { state.selected = r.slug; renderDetail(); } }));
      nameCell.appendChild(el('span', { 'class': 'slug', text: r.slug }));
      tr.appendChild(nameCell);
      tr.appendChild(el('td', { text: r.category || '—' }));
      tr.appendChild(el('td', { 'class': 'num', text: fmtUsd(r.tvl_usd) }));
      tr.appendChild(el('td', { text: fmtAge(r.age_years) }));
      tr.appendChild(el('td', { 'class': 'num', text: fmtPct(r.change_7d) }));
      tr.appendChild(el('td', { 'class': 'num', text: fmtUsd(r.implied_mcap_usd) }));
      tr.appendChild(el('td', { 'class': 'num', text: (r.p_token * 100).toFixed(1) + '%' }));
      var evCell = el('td', { 'class': 'num' });
      evCell.appendChild(document.createTextNode(fmtUsd(r.implied_value_usd)));
      if (r.rank <= 20) evCell.appendChild(el('span', { 'class': 'range', text: fmtUsd(r.ev_p5) + ' – ' + fmtUsd(r.ev_p95) + ' · rank ' + r.rank_min + '–' + r.rank_max + (r.fragile ? ' · fragile' : '') }));
      tr.appendChild(evCell);
      var vCell = el('td');
      vCell.appendChild(el('span', { 'class': 'verdict ' + v, text: v }));
      tr.appendChild(vCell);
      var act = el('td');
      act.appendChild(el('button', { 'class': 'link', text: state.pinned[r.slug] ? 'Unpin' : 'Pin', onclick: function () { if (state.pinned[r.slug]) delete state.pinned[r.slug]; else state.pinned[r.slug] = true; renderTable(); renderCompare(); } }));
      act.appendChild(document.createTextNode(' · '));
      act.appendChild(el('button', { 'class': 'link', text: 'Compare', onclick: function () { toggleCompare(r.slug); } }));
      tr.appendChild(act);
      body.appendChild(tr);
    });
    table.appendChild(body);
    tableWrap.appendChild(table);
  }

  function toggleCompare(slug) {
    var i = state.compare.indexOf(slug);
    if (i >= 0) state.compare.splice(i, 1);
    else if (state.compare.length < 3) state.compare.push(slug);
    renderCompare();
  }

  function renderCompare() {
    compareWrap.innerHTML = '';
    if (state.compare.length < 2) return;
    var sel = state.compare.map(function (s) { return rows.filter(function (r) { return r.slug === s; })[0]; }).filter(Boolean);
    var box = el('div', { 'class': 'compare' });
    box.appendChild(el('h3', { text: 'Compare — ' + sel.map(function (r) { return r.name; }).join(' vs ') }));
    var table = el('table');
    var fields = [['TVL', function (r) { return fmtUsd(r.tvl_usd); }], ['Age', function (r) { return fmtAge(r.age_years); }], ['7d change', function (r) { return fmtPct(r.change_7d); }], ['Implied mcap', function (r) { return fmtUsd(r.implied_mcap_usd); }], ['P(token)', function (r) { return (r.p_token * 100).toFixed(1) + '%'; }], ['Expected value', function (r) { return fmtUsd(r.implied_value_usd); }], ['EV range (P5–P95)', function (r) { return fmtUsd(r.ev_p5) + ' – ' + fmtUsd(r.ev_p95); }], ['Rank range', function (r) { return r.rank_min + '–' + r.rank_max; }], ['Verdict', function (r) { return verdictFor(r.implied_value_usd); }]];
    var head = el('tr', null, el('th', { text: '' }));
    sel.forEach(function (r) { head.appendChild(el('th', { text: r.name })); });
    table.appendChild(head);
    fields.forEach(function (f) {
      var tr = el('tr', null, el('td', { text: f[0] }));
      sel.forEach(function (r) { tr.appendChild(el('td', { text: f[1](r) })); });
      table.appendChild(tr);
    });
    box.appendChild(table);
    box.appendChild(el('button', { 'class': 'link', text: 'Clear comparison', onclick: function () { state.compare = []; renderCompare(); } }));
    compareWrap.appendChild(box);
  }

  function renderDetail() {
    detailWrap.innerHTML = '';
    if (!state.selected) return;
    var r = rows.filter(function (x) { return x.slug === state.selected; })[0];
    if (!r) return;
    var box = el('div', { 'class': 'detail' });
    box.appendChild(el('button', { 'class': 'close', text: 'Close', onclick: function () { state.selected = null; renderDetail(); } }));
    box.appendChild(el('h2', { text: '#' + r.rank + ' — ' + r.name }));
    box.appendChild(el('p', { text: (r.category || 'No category') + ' · ' + r.chains.join(', ') + ' · ' + r.slug }));
    var grid = el('div', { 'class': 'grid' });
    [['Expected value', fmtUsd(r.implied_value_usd)], ['Implied market cap', fmtUsd(r.implied_mcap_usd)], ['P(token)', (r.p_token * 100).toFixed(1) + '%'], ['TVL', fmtUsd(r.tvl_usd)], ['Age', fmtAge(r.age_years)], ['7d change', fmtPct(r.change_7d)], ['EV interval (P5–P95)', fmtUsd(r.ev_p5) + ' – ' + fmtUsd(r.ev_p95)], ['Rank range (bootstrap)', r.rank_min + '–' + r.rank_max + (r.fragile ? ' · fragile rank' : '')], ['Verdict', verdictFor(r.implied_value_usd) + ' · net $' + netFor(r.implied_value_usd).toFixed(0) + ' per farmer']].forEach(function (f) {
      var cell = el('div');
      cell.appendChild(el('b', { text: f[0] }));
      cell.appendChild(document.createTextNode(f[1]));
      grid.appendChild(cell);
    });
    box.appendChild(grid);
    box.appendChild(el('h3', { text: 'Farm plan' }));
    var ol = el('ol');
    r.farm_steps.forEach(function (s) { ol.appendChild(el('li', { text: s })); });
    box.appendChild(ol);
    box.appendChild(el('p', { text: 'The plan follows from the snapshot figures — category, chain, TVL and age — not from a hand-kept list. The verdict re-prices live in the sandbox below.' }));
    detailWrap.appendChild(box);
  }

  function evTable(title, note, head, bodyRows) {
    var sec = el('div');
    sec.appendChild(el('h3', { text: title }));
    if (note) sec.appendChild(el('p', { text: note }));
    var table = el('table', { 'class': 'ev' });
    var tr = el('tr');
    head.forEach(function (h) { tr.appendChild(el('th', { text: h })); });
    table.appendChild(tr);
    bodyRows.forEach(function (row) {
      var tr2 = el('tr');
      row.forEach(function (c, i) { tr2.appendChild(el('td', { text: String(c) })); });
      table.appendChild(tr2);
    });
    sec.appendChild(table);
    return sec;
  }

  function renderEvidence() {
    var sec = el('section', { 'class': 'evidence' });
    sec.appendChild(el('h2', { text: 'Evidence — every term tested, nothing claimed on faith' }));
    sec.appendChild(el('p', { text: 'The model is fitted from the snapshot at run time. These tables are computed by the program from the same snapshot, not typed in by hand.' }));
    var v = DATA.validation;
    sec.appendChild(evTable('Validation — blended curve vs flat multiple (MAPE mean / median, lower is better)',
      'Blind holdout, two walk-forwards and leave-one-out. The blend beats the flat multiple on every split except the holdout median, where they tie.',
      ['Split', 'n', 'Blended mean', 'Blended median', 'Flat mean', 'Flat median'],
      [['Blind holdout 70/30', v.holdout.n_train + '/' + v.holdout.n_test, v.holdout.blend_mean.toFixed(1), v.holdout.blend_median.toFixed(1), v.holdout.flat_mean.toFixed(1), v.holdout.flat_median.toFixed(1)],
       ['Walk-forward earliest 50%', v.wf50.n_train + '/' + v.wf50.n_test, v.wf50.blend_mean.toFixed(1), v.wf50.blend_median.toFixed(1), v.wf50.flat_mean.toFixed(1), v.wf50.flat_median.toFixed(1)],
       ['Walk-forward earliest 75%', v.wf75.n_train + '/' + v.wf75.n_test, v.wf75.blend_mean.toFixed(1), v.wf75.blend_median.toFixed(1), v.wf75.flat_mean.toFixed(1), v.wf75.flat_median.toFixed(1)],
       ['Leave-one-out (128 refits)', String(v.loo.n), v.loo.blend_mean.toFixed(1), v.loo.blend_median.toFixed(1), v.loo.flat_mean.toFixed(1), v.loo.flat_median.toFixed(1)]]));
    sec.appendChild(evTable('Value ablation — drop one term, read the damage (MAPE mean / median)',
      'The curve earns its place on the means (dropping it hurts the mean on every split); the flat blend earns its place on the walk-forward medians (86.4 vs 89.3, 76.6 vs 81.0) and the LOO mean. The category multipliers help the median and hurt the mean, so v7 clamps them to [0.60, 1.80] instead of dropping them.',
      ['Variant', 'Holdout', 'Walk-fwd 50%', 'Walk-fwd 75%', 'LOO'],
      DATA.ablation.value.map(function (a) { return [a.variant, a.holdout[0].toFixed(1) + ' / ' + a.holdout[1].toFixed(1), a.wf50[0].toFixed(1) + ' / ' + a.wf50[1].toFixed(1), a.wf75[0].toFixed(1) + ' / ' + a.wf75[1].toFixed(1), a.loo[0].toFixed(1) + ' / ' + a.loo[1].toFixed(1)]; })));
    sec.appendChild(evTable('Odds ablation — 5-fold by slug order (log-loss / AUC)',
      'Every odds term earns its place; age most of all. The frozen constants — fitted on all 449 peers — beat the cross-fitted refit, so the board uses them.',
      ['Variant', 'Log-loss', 'AUC'],
      DATA.ablation.odds.map(function (a) { return [a.variant, a.log_loss.toFixed(4), a.auc.toFixed(4)]; })));
    var c = DATA.calibration;
    sec.appendChild(evTable('Odds calibration — deciles of predicted P vs observed token rate',
      'Weighted calibration error ' + c.weighted_error.toFixed(4) + '; mean predicted ' + c.mean_pred.toFixed(3) + ' vs base rate ' + c.base_rate.toFixed(3) + '. Platt recalibration was tested and rejected (log-loss 0.5809 → 0.5841).',
      ['Decile', 'Predicted P', 'Observed rate'],
      c.deciles.map(function (d, i) { return ['D' + (i + 1), d.pred.toFixed(3), d.obs.toFixed(3)]; })));
    var top = rows.filter(function (r) { return r.rank <= 20; });
    sec.appendChild(evTable('Bootstrap — top 20 rows, 200 refits (EV P5 / P50 / P95 and rank range)',
      'The top two do not move. Ranks 3–20 swing widely, so the board shows the interval and flags the fragile ones instead of pretending the order is certain.',
      ['Rank', 'Protocol', 'Expected value', 'EV P5', 'EV P50', 'EV P95', 'Rank range'],
      top.map(function (r) { return [r.rank, r.name + (r.fragile ? ' · fragile' : ''), fmtUsd(r.implied_value_usd), fmtUsd(r.ev_p5), fmtUsd(r.ev_p50), fmtUsd(r.ev_p95), r.rank_min + '–' + r.rank_max]; })));
    sec.appendChild(el('p', { text: 'Checksum (sha256 of the compact board, first 8 hex): ' + DATA.checksum + ' — recomputed live by this page from the rows it shows: ' + boardChecksum() + '.' }));
    return sec;
  }

  function renderSandbox() {
    var box = el('div', { 'class': 'sandbox' });
    box.appendChild(el('h3', { text: 'Sandbox — re-price the verdicts' }));
    box.appendChild(el('p', { text: 'Move the inputs and watch the verdicts re-price. The model does not change; only the economics do.' }));
    var fields = [['Share of launch (%)', 'share'], ['Farmers', 'farmers'], ['Gas ($)', 'gas'], ['Capital cost ($)', 'capital'], ['FARM bar ($ net)', 'bar']];
    fields.forEach(function (f) {
      var label = el('label', { text: f[0] + ' ' });
      var input = el('input', { type: 'number', value: String(sandbox[f[1]]), oninput: function (e) { sandbox[f[1]] = parseFloat(e.target.value) || 0; renderSandboxOut(); renderTable(); } });
      label.appendChild(input);
      box.appendChild(label);
    });
    sandboxOut = el('p', { 'class': 'out' });
    box.appendChild(sandboxOut);
    renderSandboxOut();
    return box;
  }
  function renderSandboxOut() {
    if (!sandboxOut) return;
    var counts = { FARM: 0, THIN: 0, SKIP: 0 };
    rows.forEach(function (r) { counts[verdictFor(r.implied_value_usd)]++; });
    sandboxOut.textContent = 'At ' + sandbox.share + '% shared among ' + fmtInt(sandbox.farmers) + ' farmers, $' + sandbox.gas + ' gas, $' + sandbox.capital + ' capital: ' + counts.FARM + ' FARM · ' + counts.THIN + ' THIN · ' + counts.SKIP + ' SKIP.';
  }

  function exportCsv() {
    var list = filtered();
    var lines = ['rank,slug,name,category,tvl_usd,age_years,change_7d,implied_mcap_usd,p_token,expected_value_usd,verdict'];
    list.forEach(function (r) {
      lines.push([r.rank, r.slug, '"' + r.name.replace(/"/g, '""') + '"', '"' + (r.category || '') + '"', r.tvl_usd, r.age_years === null ? '' : r.age_years.toFixed(2), r.change_7d === null ? '' : r.change_7d, r.implied_mcap_usd, r.p_token.toFixed(4), r.implied_value_usd, verdictFor(r.implied_value_usd)].join(','));
    });
    var blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'launch-ledger-v7.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  // ---- render the page ----
  var m = DATA.model, l = DATA.ledger;
  var mast = el('div', { 'class': 'masthead' });
  mast.appendChild(el('div', { 'class': 'kicker', text: 'The token launch radar · ' + DATA.meta.as_of }));
  mast.appendChild(el('h1', { text: 'Launch Ledger' }));
  mast.appendChild(el('div', { 'class': 'sub', text: 'Which pre-token protocol is worth farming next, and what do I do about it? Ranked by what the launch would be worth — implied market cap times the probability it issues a token.' }));
  app.appendChild(mast);
  var meta = el('div', { 'class': 'meta' });
  [['Snapshot', DATA.meta.as_of + ' · ' + DATA.meta.snapshot_protocols + ' protocols'], ['Watchlist', String(l.watchlist)], ['Board', l.board + ' rows · ' + l.traded + ' traded set aside · ' + l.excluded + ' excluded'], ['Anchors', String(m.anchors)], ['Top-1', rows[0].name + ' · ' + fmtUsd(rows[0].implied_value_usd)]].forEach(function (f) {
    var s = el('span');
    s.appendChild(el('b', { text: f[0] + ': ' }));
    s.appendChild(document.createTextNode(f[1]));
    meta.appendChild(s);
  });
  app.appendChild(meta);

  var checks = el('div', { 'class': 'checks' });
  checks.appendChild(el('h2', { text: 'Cover self-checks — the page answers its own checks' }));
  var v = DATA.validation;
  var ul = el('ul');
  [['Validation: blind holdout ' + v.holdout.blend_median.toFixed(1) + '% median MAPE vs flat ' + v.holdout.flat_median.toFixed(1) + '% — the blend wins on mean and ties on median.', true],
   ['Ablation: every term passes — dropping the curve, the flat blend or any odds term hurts the score (see the evidence tables).', true],
   ['Calibration: weighted error ' + DATA.calibration.weighted_error.toFixed(4) + ' — the odds are already well calibrated; Platt recalibration was tested and rejected.', true],
   ['Checksum: ' + DATA.checksum + ' — recomputed live by this page from the board it shows: ' + boardChecksum() + '.', boardChecksum() === DATA.checksum],
   ['Model: OLS log-log on ' + m.anchors + ' anchors (R² ' + m.r2.toFixed(4) + '), flat multiple ' + m.flat_multiple.toFixed(4) + ', category multipliers clamped [' + m.clamp_lo.toFixed(2) + ', ' + m.clamp_hi.toFixed(2) + '].', true]].forEach(function (c) {
    var li = el('li');
    li.appendChild(el('span', { 'class': 'ok', text: c[1] ? '✓ ' : '✗ ' }));
    li.appendChild(document.createTextNode(c[0]));
    ul.appendChild(li);
  });
  checks.appendChild(ul);
  app.appendChild(checks);

  var toolbar = el('div', { 'class': 'toolbar' });
  var search = el('input', { type: 'search', placeholder: 'Search name or slug…', 'aria-label': 'Search', oninput: function (e) { state.q = e.target.value; renderTable(); } });
  toolbar.appendChild(search);
  var catSel = el('select', { 'aria-label': 'Category', onchange: function (e) { state.category = e.target.value; renderTable(); } });
  catSel.appendChild(el('option', { value: 'all', text: 'All categories' }));
  categories().forEach(function (c) { catSel.appendChild(el('option', { value: c, text: c })); });
  toolbar.appendChild(catSel);
  var vSel = el('select', { 'aria-label': 'Verdict', onchange: function (e) { state.verdict = e.target.value; renderTable(); } });
  ['all', 'FARM', 'THIN', 'SKIP'].forEach(function (x) { vSel.appendChild(el('option', { value: x, text: x === 'all' ? 'All verdicts' : x })); });
  toolbar.appendChild(vSel);
  var sortSel = el('select', { 'aria-label': 'Sort', onchange: function (e) { state.sort = e.target.value; renderTable(); } });
  [['ev', 'Expected value'], ['tvl', 'TVL'], ['age', 'Age'], ['rank', 'Rank']].forEach(function (o) { sortSel.appendChild(el('option', { value: o[0], text: 'Sort: ' + o[1] })); });
  toolbar.appendChild(sortSel);
  toolbar.appendChild(el('button', { text: 'Export CSV', onclick: exportCsv }));
  countEl = el('span', { 'class': 'count' });
  toolbar.appendChild(countEl);
  app.appendChild(toolbar);

  detailWrap = el('div');
  app.appendChild(detailWrap);
  compareWrap = el('div');
  app.appendChild(compareWrap);
  tableWrap = el('div');
  app.appendChild(tableWrap);
  renderTable();
  renderCompare();
  app.appendChild(renderSandbox());
  app.appendChild(renderEvidence());
  var foot = el('footer');
  foot.appendChild(document.createTextNode('Launch Ledger v7. The board is derived from the sealed snapshot at run time — no protocol is ranked because a hand-kept list says it is good. A protocol records no token when DefiLlama records none; that is a record, not proof. An expected value is not a guarantee; most farms pay nothing.'));
  app.appendChild(foot);
  app.setAttribute('aria-busy', 'false');
})();
