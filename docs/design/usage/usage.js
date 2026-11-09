(() => {
  const { options, start, dayMs, runs } = globalThis.usageStudyFixture;
  const dims = Object.keys(options);
  const singular = { device: 'Device', project: 'Project', model: 'Model', provider: 'Provider', harness: 'Harness' };
  const plural = {
    device: 'Devices',
    project: 'Projects',
    model: 'Models',
    provider: 'Providers',
    harness: 'Harnesses',
  };
  const compare = document.body.dataset.view === 'compare';
  const root = document.querySelector('#root');
  const dialog = document.querySelector('#filters');
  const tip = document.querySelector('#tip');
  const themes = {
    dark: ['#63aff5', '#8bd6bc', '#b29ae7', '#f2b18a', '#d8c273', '#84cdd7'],
    light: ['#1e6bba', '#147d68', '#8554b4', '#af582d', '#8c6a12', '#297b89'],
  };
  const glyphs = {
    filter: '<path d="M3 6h18M3 12h18M3 18h18"/><path d="M8 3v6m8 0v6M9 15v6"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    down: '<path d="m7 10 5 5 5-5"/>',
    close: '<path d="m7 7 10 10M7 17 17 7"/>',
    export: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 10h18"/>',
    split: '<path d="m4 7 8-4 8 4-8 4-8-4Zm0 5 8 4 8-4m-16 5 8 4 8-4"/>',
    arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
    left: '<path d="m14 6-6 6 6 6"/>',
    right: '<path d="m9 6 6 6-6 6"/>',
    focus: '<path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6"/><circle cx="12" cy="12" r="2"/>',
    cursor: '<path d="m5 3 5 17 3-7 7-3-15-7Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 1v3m0 16v3M1 12h3m16 0h3M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2"/>',
    moon: '<path d="M20 15.2A9 9 0 0 1 8.8 4 9 9 0 1 0 20 15.2Z"/>',
    tick: '<path d="m5 12 4 4 10-10"/>',
    monitor: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M12 17v3m-5 0h10"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
    chart: '<path d="M3 3v18h18M7 15l4-5 4 2 5-7"/>',
    hash: '<path d="m10 3-3 18m10-18-3 18M4 9h16M3 15h16"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    list: '<path d="M3 5h18M3 12h18M3 19h18"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    flask: '<path d="M9 3h6m-5 0v7L4 19q-1 2 2 2h12q3 0 2-2l-6-9V3M7 15h10"/>',
  };
  const ic = (n, s = 16) =>
    `<svg aria-hidden="true" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${glyphs[n]}</svg>`;
  const safe = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const hueOrder = {
    device: [0, 1, 2, 3],
    model: [2, 0, 3, 1, 4],
    project: [1, 3, 5, 4, 0, 2],
    provider: [3, 0, 2, 4],
    harness: [3, 5, 1, 2],
  };
  const color = (dim, val) => themes[document.documentElement.dataset.theme][hueOrder[dim][options[dim].indexOf(val)]];
  const compact = (n) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(n);
  const dollars = (n) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: n < 100 ? 2 : 0,
    }).format(n);
  const fmt = (n, m) => (m === 'cost' ? dollars(n) : compact(n));
  const pct = (n, total) => (total ? `${((100 * n) / total).toFixed(1)}%` : '0%');
  const date = (day, full = false) =>
    new Date(start + day * dayMs).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      ...(full ? { year: 'numeric' } : {}),
      timeZone: 'UTC',
    });
  const rangeOptions = [
    [1, '1 day'],
    [7, '7 days'],
    [30, '30 days'],
    [180, '6 months'],
  ];
  function read() {
    const p = new URLSearchParams(
      location.protocol === 'file:' && location.hash ? location.hash.slice(1) : location.search,
    );
    return {
      range: rangeOptions.find(([r]) => String(r) === p.get('range'))?.[0] ?? 30,
      split: dims.includes(p.get('split')) ? p.get('split') : compare ? 'model' : 'device',
      metric: p.get('metric') === 'cost' ? 'cost' : 'tokens',
      scale: p.get('scale') === 'series' ? 'series' : 'shared',
      filters: Object.fromEntries(dims.map((k) => [k, options[k].filter((v) => p.getAll(k).includes(v))])),
    };
  }
  const initialTheme = new URLSearchParams(
    location.protocol === 'file:' && location.hash ? location.hash.slice(1) : location.search,
  ).get('theme');
  if (['dark', 'light'].includes(initialTheme)) document.documentElement.dataset.theme = initialTheme;
  const rowsPerPage = 12;
  let state = read(),
    page = 0,
    query = '',
    facet = 'all',
    lastOpener = null,
    draft,
    selection,
    calc;
  function params() {
    const p = new URLSearchParams();
    p.set('range', String(state.range));
    p.set('split', state.split);
    p.set('metric', state.metric);
    p.set('theme', document.documentElement.dataset.theme);
    if (state.scale === 'series') p.set('scale', 'series');
    for (const k of dims) for (const v of state.filters[k]) p.append(k, v);
    return p.toString();
  }
  function otherView(name) {
    const p = new URLSearchParams(params());
    if (!location.search.includes('split=')) p.delete('split');
    return `${name}.${location.pathname.endsWith('.htm') ? 'htm' : 'html'}?${p}`;
  }
  const chipValues = (filters = state.filters) => dims.flatMap((k) => filters[k].map((v) => [k, v]));
  const flip = (items, v) => (items.includes(v) ? items.filter((x) => x !== v) : [...items, v]);
  const notice = (t) => {
    document.querySelector('#announcement').textContent = t;
  };
  function commit(message, drill = false) {
    page = 0;
    const url = location.protocol === 'file:' ? '#' + params() : '?' + params();
    if (url !== (location.protocol === 'file:' ? location.hash : location.search))
      history.pushState({ drill }, '', url);
    render();
    notice(message + ' ' + calc.list.length.toLocaleString('en-US') + ' sessions.');
  }
  function toggle(k, v) {
    state.filters[k] = flip(state.filters[k], v);
    commit(`${singular[k]} filter updated.`);
  }
  function focus(k, v) {
    const same = state.filters[k].length === 1 && state.filters[k][0] === v;
    state.filters[k] = [v];
    const order = ['device', 'model', 'project', 'provider', 'harness'];
    const next = [...order.slice(order.indexOf(k) + 1), ...order.slice(0, order.indexOf(k))].find(
      (d) =>
        state.filters[d].length !== 1 && new Set(calc.list.filter((row) => row[k] === v).map((row) => row[d])).size > 1,
    );
    if (state.split === k && next) state.split = next;
    else if (same) return;
    commit(`Only ${singular[k]}: ${v}. Now grouped by ${singular[state.split]}.`, true);
    if (!dialog.open && document.activeElement === document.body)
      root.querySelector('[data-act="back"]')?.focus({ preventScroll: true });
  }
  function clearFilters() {
    for (const k of dims) state.filters[k] = [];
    commit('All usage filters cleared.');
  }
  function data() {
    const { range, filters, split, metric } = state;
    const first = 180 - range,
      size = range === 180 ? 6 : 1,
      buckets = range === 1 ? 24 : Math.ceil(range / size);
    const matches = (r) => dims.every((k) => !filters[k].length || filters[k].includes(r[k]));
    const list = runs.filter((r) => r.day >= first && matches(r));
    const series = options[split].map((name) => ({
      name,
      val: 0,
      count: 0,
      priced: 0,
      points: Array(buckets).fill(0),
    }));
    let tokens = 0,
      cost = 0,
      input = 0,
      cached = 0,
      unpriced = 0;
    const totals = Array(buckets).fill(0);
    for (const r of list) {
      const i = range === 1 ? Math.floor(r.minute / 60) : Math.floor((r.day - first) / size),
        v = r[metric],
        row = series[options[split].indexOf(r[split])];
      row.val += v;
      row.count++;
      if (r.priced) row.priced++;
      row.points[i] += v;
      totals[i] += v;
      tokens += r.tokens;
      cost += r.cost;
      input += r.input;
      cached += r.cached;
      if (!r.priced) unpriced += r.tokens;
    }
    const ranked = series.filter((x) => x.count).sort((a, b) => b.val - a.val);
    return {
      terminal: list.length > 0 && dims.every((k) => list.every((r) => r[k] === list[0][k])),
      first,
      size,
      buckets,
      list,
      ranked,
      totals,
      tokens,
      cost,
      cached,
      input,
      unpriced,
      total: metric === 'cost' ? cost : tokens,
    };
  }
  function period() {
    return state.range === 1 ? date(179, true) : `${date(calc.first)} – ${date(179)}`;
  }
  function bucketLabel(i, short = false) {
    if (state.range === 1) return `${String(i).padStart(2, '0')}:00`;
    const day = calc.first + i * calc.size;
    return calc.size === 1 || short ? date(day) : `${date(day)} – ${date(Math.min(day + calc.size - 1, 179))}`;
  }
  const cadence = () => (state.range === 1 ? 'Hourly' : state.range === 180 ? '6-day buckets' : 'Daily');
  const swatch = (c) => `<span class="swatch" style="--sw:${c}" aria-hidden="true"></span>`;
  const action = (name, k, v) => `data-act="${name}" data-d="${k}" data-v="${safe(v)}"`;
  function rangeControl(id = 'range') {
    return `<label class="select-control range">${ic('calendar')}<span class="sr">Date range</span><select id="${id}" data-control="range" aria-label="Date range">${rangeOptions.map(([v, n]) => `<option value="${v}" ${v === state.range ? 'selected' : ''}>${n}</option>`).join('')}</select>${ic('down', 13)}</label>`;
  }
  function splitControl() {
    return `<label class="select-control split">${ic('split')}<span>${compare ? 'Compare' : 'Split'} by</span><select id="split" aria-label="${compare ? 'Compare' : 'Split'} by">${dims.map((k) => `<option value="${k}" ${state.split === k ? 'selected' : ''}>${singular[k]}</option>`).join('')}</select>${ic('down', 13)}</label>`;
  }
  function metricControl() {
    return `<div class="seg" role="group" aria-label="Chart metric">${['tokens', 'cost'].map((v) => `<button data-act="metric" data-v="${v}" aria-pressed="${v === state.metric}">${v === 'tokens' ? 'Tokens' : 'Cost'}</button>`).join('')}</div>`;
  }
  const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K';
  const paletteButton = (cls = '', label = 'Filter usage') =>
    `<button class="filter-button ${cls}" data-act="palette" aria-haspopup="dialog">${ic('filter')}<span>${label}</span><kbd>${shortcut}</kbd></button>`;
  function chips() {
    const all = chipValues();
    return `<div class="chips" aria-label="Active filters">${all.length ? `<button class="filter-summary" data-act="palette" aria-haspopup="dialog">${ic('filter', 13)} ${all.length} ${all.length === 1 ? 'filter' : 'filters'}</button>` : ''}${all.length ? all.map(([k, v]) => `<button class="chip" ${action('toggle', k, v)} aria-label="Remove ${singular[k]} filter: ${safe(v)}"><span>${singular[k]}:</span> ${safe(v)} ${ic('close', 12)}</button>`).join('') + `<button class="clear" data-act="clear">Clear all</button>` : '<span class="scope-all">All usage</span>'}</div>`;
  }
  function mast() {
    const dark = document.documentElement.dataset.theme === 'dark';
    return `<header class="mast"><div class="mast-in"><div class="brand"><svg width="28" height="28" viewBox="0 0 28 28" fill="currentColor" aria-hidden="true"><path d="M2 16h5v10H2zM11 9h5v17h-5zM20 2h5v24h-5z"/></svg><span>Token tracker<span class="brand-dot">.</span></span></div><nav aria-label="Design proposals"><a href="${otherView('overview')}" ${!compare ? 'aria-current="page"' : ''}>${ic('chart', 14)}Overview</a><a href="${otherView('compare')}" ${compare ? 'aria-current="page"' : ''}>${ic('list', 14)}Compare</a></nav><div class="mast-end"><span class="sample">${ic('flask', 14)} Sample data</span><button class="icon-btn" data-act="theme" aria-label="Use ${dark ? 'light' : 'dark'} theme">${ic(dark ? 'sun' : 'moon', 17)}</button></div></div></header>`;
  }
  function heading() {
    return `<div class="heading"><h1>${compare ? 'Comparison desk' : 'Usage overview'}</h1><button class="plain export" data-act="export">${ic('export', 15)}Export CSV</button></div>`;
  }
  function kpis() {
    return `<section class="kpis" aria-label="Usage summary">${[
      ['Total tokens', compact(calc.tokens), 'tokens processed'],
      [
        'Estimated API cost',
        calc.tokens && calc.tokens === calc.unpriced ? 'Unpriced' : dollars(calc.cost),
        'at sample rates',
      ],
      ['Sessions', calc.list.length.toLocaleString('en-US'), 'in this scope'],
      ['Cache hit rate', calc.input ? pct(calc.cached, calc.input) : '—', 'of input tokens'],
    ]
      .map(
        ([k, v, sub], i) =>
          `<div class="kpi"><div class="kpi-label"${i === 1 ? ' title="Sample rates. Unpriced tokens are excluded."' : ''}>${k}</div><strong>${v}</strong><div class="kpi-foot">${i === 0 ? period() : i === 1 && calc.unpriced ? 'Priced tokens only' : sub}</div></div>`,
      )
      .join('')}</section>`;
  }
  function ticks() {
    const steps = calc.buckets > 10 ? 5 : Math.min(4, calc.buckets);
    return `<div class="xaxis">${Array.from({ length: steps }, (_, i) => `<span>${bucketLabel(Math.round((i * (calc.buckets - 1)) / (steps - 1)), true)}</span>`).join('')}</div>`;
  }
  function nice(v) {
    if (!v) return 1;
    const raw = v / 4,
      p = 10 ** Math.floor(Math.log10(raw));
    return ([1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10].find((x) => x >= raw / p) ?? 10) * p * 4;
  }
  function scaleLabel(v) {
    return (
      (state.metric === 'cost' ? '$' : '') +
      new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(v)
    );
  }
  function blank() {
    return `<div class="empty">${ic('search', 22)}<strong>No matching sessions</strong><button class="clear" data-act="clear">Clear filters</button></div>`;
  }
  const unknownCost = (row) => state.metric === 'cost' && !row.priced;
  const seriesValue = (row) => (unknownCost(row) ? 'Unpriced' : fmt(row.val, state.metric));
  const seriesShare = (row) => (unknownCost(row) ? '—' : pct(row.val, calc.total));
  function bars() {
    if (!calc.list.length) return blank();
    if (state.metric === 'cost' && calc.tokens === calc.unpriced)
      return `<div class="empty"><strong>No priced usage in this scope</strong><button class="clear" data-act="metric" data-v="tokens">View tokens</button></div>`;
    const scale = nice(Math.max(...calc.totals)),
      w = 800,
      h = 192,
      step = w / calc.buckets,
      bw = Math.min(step * 0.71, 56);
    const marks = calc.totals
      .map((_, i) => {
        let y = h;
        return calc.ranked
          .map((row) => {
            const value = row.points[i],
              rh = (value * h) / scale;
            if (!value) return '';
            y -= rh;
            return `<rect ${calc.terminal ? '' : action('inspect', state.split, row.name)} ${calc.terminal ? 'data-static' : 'data-bucket'}="${i}" x="${i * step + (step - bw) / 2}" y="${y}" width="${bw}" height="${rh}" fill="${color(state.split, row.name)}"/>`;
          })
          .join('');
      })
      .join('');
    return `<div class="plot"><div class="yaxis">${[4, 3, 2, 1, 0].map((v) => `<span>${scaleLabel((scale * v) / 4)}</span>`).join('')}</div><div class="plot-body"><div class="plot-lines">${'<i></i>'.repeat(5)}</div><svg class="bars" role="img" aria-label="${cadence()} ${state.metric} stacked by ${singular[state.split].toLowerCase()}; ${calc.terminal ? 'fully narrowed scope' : 'use the adjacent series buttons to inspect or filter with a keyboard'}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${marks}</svg>${ticks()}</div></div>`;
  }
  function rankList() {
    // The labels are the legend, the breakdown and the keyboard equivalent of selecting a mark.
    return `<div class="rank" role="group" aria-label="${plural[state.split]} breakdown"><div class="rank-items">${calc.ranked.map((row) => `<button class="rank-item" ${action('inspect', state.split, row.name)} aria-label="Inspect ${safe(row.name)}: ${seriesValue(row)}, ${seriesShare(row)}">${swatch(color(state.split, row.name))}<span class="rank-name">${safe(row.name)}</span><span class="rank-val">${seriesValue(row)}</span><span class="num">${seriesShare(row)}</span></button>`).join('') || '<p class="muted">No series in scope.</p>'}</div></div>`;
  }
  function drillBack() {
    return history.state?.drill
      ? `<button data-act="back" class="back" aria-label="Undo last drill-down">${ic('left', 13)} Back</button>`
      : '';
  }
  function terminalActivity() {
    const peak = Math.max(...calc.totals),
      average = calc.total / calc.list.length,
      missing = state.metric === 'cost' && calc.tokens === calc.unpriced;
    return `<section class="activity terminal"><div class="section-head"><div class="title-line">${drillBack()}<h2>Session activity</h2></div><div class="controls">${metricControl()}</div></div><div class="chart-frame"><div class="stacked">${bars()}</div><div class="terminal-summary"><strong>Fully narrowed</strong><p>${calc.list.length.toLocaleString()} matching sessions</p><dl><dt>Peak ${state.range === 1 ? 'hour' : 'period'}</dt><dd>${missing ? 'Unpriced' : fmt(peak, state.metric)}${missing ? '' : ` · ${bucketLabel(calc.totals.indexOf(peak))}`}</dd><dt>Average per session</dt><dd>${missing ? 'Unpriced' : fmt(average, state.metric)}</dd></dl></div></div><div class="chart-foot"><a href="#sessions-title" data-act="jump-sessions">View matching sessions ↓</a><span>${period()} · UTC</span></div></section>`;
  }
  function activity() {
    if (calc.terminal) return terminalActivity();
    return `<section class="activity"><div class="section-head"><div class="title-line">${drillBack()}<h2>${state.metric === 'cost' ? 'Cost activity' : 'Token activity'}</h2><span class="frequency">${cadence()}</span></div><div class="controls">${splitControl()}${metricControl()}</div></div><div class="stacked">${bars()}</div>${rankList()}<div class="chart-foot"><span>${ic('cursor', 14)} Select a segment to inspect or filter</span><span>${period()} · UTC</span></div></section>`;
  }
  function sessions() {
    const count = calc.list.length,
      max = Math.max(1, Math.ceil(count / rowsPerPage));
    page = Math.min(page, max - 1);
    return `<section class="sessions"><div class="section-head"><div class="title-line"><h2 id="sessions-title" tabindex="-1">Sessions</h2><span class="count">${count.toLocaleString('en-US')}</span></div><div class="pages"><span>${count ? `${page * rowsPerPage + 1}–${Math.min(page * rowsPerPage + rowsPerPage, count)}` : '0'} of ${count.toLocaleString('en-US')}</span><button class="icon-btn" data-act="prev" aria-label="Previous sessions" ${page === 0 ? 'disabled' : ''}>${ic('left', 14)}</button><button class="icon-btn" data-act="next" aria-label="Next sessions" ${page === max - 1 ? 'disabled' : ''}>${ic('right', 14)}</button></div></div><div class="table-scroll"><table><thead><tr><th>Project</th><th>Model</th><th>Device</th><th>Started <span class="tz">(UTC)</span></th><th>Tokens</th></tr></thead><tbody>${
      calc.list
        .slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage)
        .map(
          (r) =>
            `<tr><td><button ${action('inspect', 'project', r.project)} title="Inspect project: ${r.project}">${r.project}</button></td><td><button ${action('inspect', 'model', r.model)} title="Inspect model: ${r.model}">${r.model}</button></td><td><button ${action('inspect', 'device', r.device)} title="Inspect device: ${r.device}">${r.device}</button></td><td>${date(r.day)} · ${String(Math.floor(r.minute / 60)).padStart(2, '0')}:${String(r.minute % 60).padStart(2, '0')}</td><td>${compact(r.tokens)}</td></tr>`,
        )
        .join('') || '<tr><td colspan="5">No sessions in this scope.</td></tr>'
    }</tbody></table></div></section>`;
  }
  const expanded = new Set(['device', 'model', 'project']);
  document.addEventListener(
    'toggle',
    (e) => {
      if (e.target.matches?.('details[data-group]') && e.target.isConnected) {
        if (e.target.open) expanded.add(e.target.dataset.group);
        else expanded.delete(e.target.dataset.group);
      }
    },
    true,
  );
  function rail() {
    return `<aside class="rail" aria-label="Scope filters"><div class="rail-title">${ic('filter')}<h2>Scope</h2></div><div class="rail-range"><span class="period-label">Period</span>${rangeControl()}<span class="rail-dates">${period()} · UTC</span></div>${paletteButton('more', 'Search filters')}<div class="rail-chip">${chips()}</div>${['device', 'model', 'project'].map((k) => `<details class="facets" data-group="${k}" ${expanded.has(k) ? 'open' : ''}><summary class="facet-head"><strong>${singular[k]}</strong><span>${state.filters[k].length || ''}</span>${ic('down', 12)}</summary>${options[k].map((v, i) => `<label class="facet"><input type="checkbox" id="scope-${k}-${i}" ${action('toggle', k, v)} ${state.filters[k].includes(v) ? 'checked' : ''}><span>${safe(v)}</span></label>`).join('')}</details>`).join('')}</aside>`;
  }
  function comparePlot() {
    if (calc.terminal) return terminalActivity();
    const maximum = nice(Math.max(0, ...calc.ranked.flatMap((r) => r.points))),
      n = calc.buckets,
      w = 600,
      h = 48;
    return `<section class="matrix"><div class="section-head"><div class="title-line">${drillBack()}<h2>Series comparison</h2></div><div class="controls">${splitControl()}${metricControl()}</div></div><div class="matrix-head"><span>${singular[state.split]}</span><span>${cadence()} trend <em>· ${state.scale === 'series' ? 'per-series scale' : 'shared scale'}</em></span><span>${state.metric === 'tokens' ? 'Tokens' : 'Est. cost'}</span><span>Share</span></div><div class="matrix-rows${calc.ranked.length > 5 ? ' six-rows' : ''}">${
      calc.ranked
        .map((r) => {
          const c = color(state.split, r.name),
            peak = state.scale === 'series' ? nice(Math.max(...r.points)) : maximum,
            coordinates = r.points
              .map((v, i) => `${((i / (n - 1)) * w).toFixed(2)} ${(h - (v / peak) * h).toFixed(2)}`)
              .join(' L');
          return `<button class="matrix-row" ${action('inspect', state.split, r.name)} aria-label="Inspect ${r.name}, ${seriesValue(r)}, ${seriesShare(r)}"><span class="matrix-label">${swatch(c)}${r.name}</span><span class="trend-cell${unknownCost(r) ? ' unpriced' : ''}" title="${unknownCost(r) ? 'No sample rate' : `Scale: 0–${scaleLabel(peak)}`}"><svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="M0 ${h} L${coordinates} L${w} ${h}Z" fill="${c}" fill-opacity=".14"/><path d="M${coordinates}" fill="none" stroke="${c}" stroke-width="1.8" vector-effect="non-scaling-stroke"/></svg></span><strong>${seriesValue(r)}</strong><span class="num">${seriesShare(r)}</span></button>`;
        })
        .join('') || blank()
    }</div><div class="matrix-axis"><span></span><div>${ticks()}</div><span></span><span></span></div><div class="chart-foot"><span>${ic('cursor', 14)} Select a trend to inspect or filter</span><span><label class="scale-select">Scale <select data-control="scale" id="scale" aria-label="Trend scale"><option value="shared" ${state.scale === 'shared' ? 'selected' : ''}>Shared · 0–${scaleLabel(maximum)}</option><option value="series" ${state.scale === 'series' ? 'selected' : ''}>Per series</option></select></label></span></div></section>`;
  }
  function render() {
    tip.hidden = true;
    const old = document.activeElement;
    const retain = old?.id
      ? `#${CSS.escape(old.id)}`
      : old?.dataset?.act
        ? ['act', 'd', 'v']
            .filter((k) => old.dataset[k] !== undefined)
            .map((k) => `[data-${k}="${CSS.escape(old.dataset[k])}"]`)
            .join('')
        : null;
    calc = data();
    root.innerHTML = `${mast()}<main id="main" tabindex="-1">${heading()}${compare ? `<div class="workspace">${rail()}<div class="desk"><div class="scope-shelf"><div class="mobile-scope"><strong>${ic('filter', 14)} Scope</strong>${rangeControl('mobile-range')}</div><div class="mobile-facets">${['device', 'model', 'project', 'all'].map((k) => `<button data-act="palette" data-d="${k}" aria-haspopup="dialog">${singular[k] || 'More'} ${(k === 'all' ? state.filters.provider.length + state.filters.harness.length : state.filters[k].length) || ''} ${ic('down', 11)}</button>`).join('')}</div><div class="mobile-chips">${chips()}</div></div>${kpis()}${comparePlot()}${sessions()}</div></div>` : `<div class="scope-bar"><div class="scope-date">${rangeControl()}</div>${paletteButton()}${chips()}</div>${kpis()}${activity()}${sessions()}`}</main><footer><span>Token tracker</span><span>Design study ${compare ? '02' : '01'} / 02 · Fictional usage</span></footer>`;
    if (retain && !dialog.open) {
      const target = [...root.querySelectorAll(retain)].find(
        (el) => el.getClientRects().length && el.tagName !== 'rect',
      );
      target?.focus({ preventScroll: true });
    }
  }
  function inspectionTarget() {
    return selection.targets[Number(dialog.querySelector('#inspect-target').value)];
  }
  function inspectionActions() {
    const [k, v] = inspectionTarget(),
      selected = state.filters[k];
    const only = dialog.querySelector('[data-act="only-target"]'),
      toggleButton = dialog.querySelector('[data-act="toggle-target"]');
    only.textContent = `Only this ${singular[k].toLowerCase()} →`;
    only.disabled = selected.length === 1 && selected[0] === v && (calc.terminal || state.split !== k);
    if (only.disabled) only.textContent = 'Already isolated';
    toggleButton.textContent = selected.includes(v) ? 'Remove from filter' : 'Include in filter';
    dialog.querySelector('.replace-note').textContent =
      selected.length > 1 ? `“Only” replaces ${selected.length} selected ${plural[k].toLowerCase()}.` : '';
  }
  function inspect(el, event) {
    const { d, v } = el.dataset,
      trend = event.target.closest('.trend-cell');
    const i =
      el.dataset.bucket !== undefined
        ? Number(el.dataset.bucket)
        : trend
          ? Math.max(
              0,
              Math.min(
                calc.buckets - 1,
                Math.round(
                  ((event.clientX - trend.getBoundingClientRect().left) / trend.getBoundingClientRect().width) *
                    (calc.buckets - 1),
                ),
              ),
            )
          : null;
    const rows = calc.list.filter(
      (r) =>
        r[d] === v &&
        (i === null ||
          i === (state.range === 1 ? Math.floor(r.minute / 60) : Math.floor((r.day - calc.first) / calc.size))),
    );
    const amount = rows.reduce((a, r) => a + r[state.metric], 0),
      display =
        state.metric === 'cost' && rows.length && !rows.some((r) => r.priced)
          ? 'Unpriced'
          : fmt(amount, state.metric) + (state.metric === 'tokens' ? ' tokens' : '');
    const targets = [[d, v]];
    for (const k of ['model', 'project', 'device'].filter((k) => k !== d)) {
      const sums = new Map();
      for (const r of rows) sums.set(r[k], (sums.get(r[k]) ?? 0) + r[state.metric]);
      for (const [value] of [...sums].sort((a, b) => b[1] - a[1])) targets.push([k, value]);
    }
    selection = { targets };
    lastOpener = el;
    tip.hidden = true;
    dialog.dataset.kind = 'inspect';
    dialog.innerHTML = `<div class="dialog-head"><h2 id="filter-title">${swatch(color(d, v))}${safe(v)}</h2><button class="icon-btn" data-act="dismiss" aria-label="Close inspection">${ic('close')}</button></div><div class="inspection-amount"><strong>${display}</strong><span>${i === null ? period() : bucketLabel(i)} · UTC</span></div><label class="inspect-field">Filter across ${period()}<select id="inspect-target">${[...new Set(targets.map(([k]) => k))].map((k) => `<optgroup label="${plural[k]}">${targets.map(([kd, value], n) => (kd === k ? `<option value="${n}">${singular[k]}: ${safe(value)}</option>` : '')).join('')}</optgroup>`).join('')}</select></label><p class="replace-note"></p><div class="inspect-actions"><button class="plain" data-act="toggle-target"></button><button class="done" data-act="only-target"></button></div>`;
    inspectionActions();
    dialog.showModal();
    dialog.querySelector('[data-act="dismiss"]').focus({ preventScroll: true });
  }
  function draftChips() {
    return chipValues(draft)
      .map(
        ([k, v]) =>
          `<button ${action('remove-draft', k, v)} aria-label="Remove ${singular[k]}: ${v}">${singular[k]}: ${v} ${ic('close', 10)}</button>`,
      )
      .join('');
  }
  function paletteResults() {
    const q = query.trim().toLowerCase();
    return (
      dims
        .filter((k) => facet === 'all' || facet === k)
        .map((k) => {
          const vals = options[k].filter((v) => `${v} ${singular[k]}`.toLowerCase().includes(q));
          return vals.length
            ? `<div class="result-group"><h3>${plural[k]}</h3>${vals.map((v) => `<button ${action('draft', k, v)} aria-pressed="${draft[k].includes(v)}"><span>${v}</span><span class="box">${ic('tick', 12)}</span></button>`).join('')}</div>`
            : '';
        })
        .join('') || '<p class="no-result">No matches. Try a model, project or device name.</p>'
    );
  }
  function paintPalette() {
    dialog.innerHTML = `<div class="dialog-head"><h2 id="filter-title">Filter usage</h2><button class="icon-btn" data-act="dismiss" aria-label="Close filters">${ic('close')}</button></div><label class="search">${ic('search')}<input id="query" type="search" aria-label="Search filter values" placeholder="Search models, projects, devices…" autocomplete="off" value="${safe(query)}"/></label><div class="filter-tabs" aria-label="Search in">${['all', ...dims].map((k) => `<button data-act="facet" data-d="${k}" aria-pressed="${facet === k}">${plural[k] || 'All'}</button>`).join('')}</div><div id="draft-summary">${draftChips()}</div><div id="results">${paletteResults()}</div><div class="dialog-foot"><button class="clear" data-act="clear-draft" ${chipValues(draft).length ? '' : 'disabled'}>Clear all</button><span id="picked">${chipValues(draft).length} selected</span><button class="done" data-act="apply">Apply filters</button></div>`;
  }
  function openPalette(trigger, group = 'all') {
    tip.hidden = true;
    dialog.dataset.kind = 'palette';
    draft = Object.fromEntries(dims.map((k) => [k, [...state.filters[k]]]));
    lastOpener = trigger;
    query = '';
    facet = group;
    paintPalette();
    dialog.showModal();
    document.querySelector('#query').focus();
  }
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    const fallback =
      dialog.dataset.kind === 'inspect'
        ? (root.querySelector('[data-act="back"]') ?? root.querySelector('#split'))
        : [...root.querySelectorAll('[data-act="palette"]')].find((el) => el.getClientRects().length);
    const target =
      lastOpener?.isConnected && lastOpener.tagName !== 'rect' && lastOpener !== document.body ? lastOpener : fallback;
    target?.focus({ preventScroll: true });
  });
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
    }
  });
  document.addEventListener('input', (e) => {
    if (e.target.id === 'query') {
      query = e.target.value;
      dialog.querySelector('#results').innerHTML = paletteResults();
      dialog.querySelector('#results').scrollTop = 0;
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'inspect-target') inspectionActions();
    if (e.target.dataset.control === 'scale') {
      state.scale = e.target.value;
      commit('Trend scale changed.');
    }
    if (e.target.id === 'split') {
      state.split = e.target.value;
      commit(`Grouped by ${singular[state.split]}.`);
    }
    if (e.target.dataset.control === 'range') {
      state.range = Number(e.target.value);
      commit(`Period set to ${rangeOptions.find(([r]) => r === state.range)[1]}.`);
    }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (dialog.open) dialog.close();
      else openPalette(document.activeElement);
    }
  });
  function download() {
    const rows = [
      ['session', 'project', 'model', 'device', 'provider', 'harness', 'started_utc', 'tokens', 'estimated_usd'],
      ...calc.list.map((r) => [
        r.id,
        r.project,
        r.model,
        r.device,
        r.provider,
        r.harness,
        new Date(start + r.day * dayMs + r.minute * 60000).toISOString(),
        r.tokens,
        r.priced ? r.cost.toFixed(4) : '',
      ]),
    ];
    const blob = new Blob([rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv;charset=utf-8' }),
      a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'token-tracker-sample.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    notice('Exported filtered sample sessions.');
  }
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const { act, d, v } = el.dataset;
    switch (act) {
      case 'palette':
        openPalette(el, d || 'all');
        break;
      case 'dismiss':
        dialog.close();
        break;
      case 'facet':
        facet = d;
        for (const btn of dialog.querySelectorAll('[data-act="facet"]'))
          btn.setAttribute('aria-pressed', String(btn === el));
        dialog.querySelector('#results').innerHTML = paletteResults();
        dialog.querySelector('#results').scrollTop = 0;
        break;
      case 'toggle':
        toggle(d, v);
        break;
      case 'apply':
        state.filters = draft;
        dialog.close();
        commit('Applied filters.');
        break;
      case 'clear-draft':
        for (const k of dims) draft[k] = [];
        paintPalette();
        dialog.querySelector('#query').focus();
        break;
      case 'remove-draft':
      case 'draft':
        draft[d] = flip(draft[d], v);
        {
          dialog.querySelector('#draft-summary').innerHTML = draftChips();
          for (const btn of dialog.querySelectorAll('[data-act="draft"]'))
            btn.setAttribute('aria-pressed', String(draft[btn.dataset.d].includes(btn.dataset.v)));
          if (act === 'remove-draft') dialog.querySelector('#query').focus();
          dialog.querySelector('#picked').textContent = `${chipValues(draft).length} selected`;
          dialog.querySelector('[data-act="clear-draft"]').disabled = !chipValues(draft).length;
        }
        break;
      case 'inspect':
        inspect(el, e);
        break;
      case 'only-target': {
        const [k, value] = inspectionTarget();
        dialog.close();
        focus(k, value);
        break;
      }
      case 'toggle-target': {
        const [k, value] = inspectionTarget();
        dialog.close();
        toggle(k, value);
        break;
      }
      case 'clear':
        clearFilters();
        break;
      case 'theme':
        document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        history.replaceState(history.state, '', location.protocol === 'file:' ? '#' + params() : '?' + params());
        render();
        break;
      case 'jump-sessions':
        e.preventDefault();
        document.querySelector('#sessions-title').focus();
        break;
      case 'back':
        history.back();
        break;
      case 'metric':
        state.metric = v;
        commit(`Showing ${v}.`);
        break;
      case 'prev':
      case 'next':
        page += act === 'prev' ? -1 : 1;
        render();
        break;
      case 'export':
        download();
        break;
    }
  });
  document.addEventListener('pointermove', (e) => {
    const el = e.target.closest('[data-bucket],.trend-cell');
    if (dialog.open || !el || e.pointerType === 'touch') {
      tip.hidden = true;
      return;
    }
    const rowEl = el.closest('[data-v]'),
      row = calc.ranked.find((r) => r.name === rowEl.dataset.v);
    if (!row) return;
    const rect = el.getBoundingClientRect(),
      i = el.hasAttribute('data-bucket')
        ? Number(el.dataset.bucket)
        : Math.max(
            0,
            Math.min(calc.buckets - 1, Math.round(((e.clientX - rect.left) / rect.width) * (calc.buckets - 1))),
          );
    tip.innerHTML = `<b>${bucketLabel(i)}</b><span>${swatch(color(state.split, row.name))}${row.name}<strong>${unknownCost(row) ? 'Unpriced' : fmt(row.points[i], state.metric)}${state.metric === 'tokens' ? ' tokens' : ''}</strong></span>`;
    tip.hidden = false;
    tip.style.left = Math.max(8, Math.min(innerWidth - tip.offsetWidth - 8, e.clientX + 13)) + 'px';
    tip.style.top = Math.max(8, e.clientY - tip.offsetHeight - 10) + 'px';
  });
  document.addEventListener('pointerout', (e) => {
    if (!e.relatedTarget) tip.hidden = true;
  });
  window.addEventListener('scroll', () => (tip.hidden = true), { passive: true });
  window.addEventListener('popstate', () => {
    if (dialog.open) dialog.close();
    state = read();
    const theme = new URLSearchParams(location.protocol === 'file:' ? location.hash.slice(1) : location.search).get(
      'theme',
    );
    if (['dark', 'light'].includes(theme)) document.documentElement.dataset.theme = theme;
    page = 0;
    render();
  });
  render();
})();
