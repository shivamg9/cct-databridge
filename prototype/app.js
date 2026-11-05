/* CCT DataBridge prototype UI. Vanilla JS, no build step.
 * All values interpolated into markup go through html`` which escapes them;
 * uploaded file contents are untrusted and are only ever rendered escaped. */
(function () {
  'use strict';
  const DB = window.DataBridge;
  const SCHEMA = window.NSR_SCHEMA;
  const E = DB.createEngine(SCHEMA, { seed: 20261027 });
  DB.seedDemo(E);
  const S = E.state;
  const T = window.UiTerms;
  // The console opens as the everyday user. Switch roles with "Acting as" to see Settings.
  E.setRole('INGESTION_OPERATOR');
  const FIELD = Object.fromEntries(SCHEMA.fields.map((f) => [f.name, f]));
  const DAY = 86400000;

  // ---------------------------------------------------------------------------
  // Escaping template + helpers
  // ---------------------------------------------------------------------------
  class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
  const raw = (s) => new Raw(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtv = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(fmtv).join('') : v === null || v === undefined || v === false ? '' : esc(v));
  function html(strings, ...vals) { let o = strings[0]; vals.forEach((v, i) => { o += fmtv(v) + strings[i + 1]; }); return raw(o); }

  const num = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-GB'));
  const pct = (x, d) => (x === null || x === undefined || isNaN(x) ? '—' : (x * 100).toFixed(d === undefined ? 1 : d) + '%');
  const pad2 = (n) => String(n).padStart(2, '0');
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtTime(ts, withSec) {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}${withSec === false ? '' : ':' + pad2(d.getSeconds())}`;
  }
  function rel(ts) {
    if (!ts) return '—';
    const s = Math.round((S.now - ts) / 1000);
    if (s < 0) return `in ${dur(-s * 1000)}`;
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  }
  function dur(ms) {
    if (ms === null || ms === undefined) return '—';
    if (ms < 1000) return `${ms} ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
    return `${(ms / 3600000).toFixed(1)} h`;
  }
  // All operator-facing wording for engine codes and states comes from ui-terms.js.
  const label = T.sentence;
  const pill = (kind, v) => {
    if (kind === 'run') { const s = T.runStatus(v); return html`<span class="pill ${s.tone}">${s.label}</span>`; }
    const [l, tone] = T.recordStatus(kind, v);
    return html`<span class="pill ${tone}">${l}</span>`;
  };
  const roleName = (k) => T.ROLE_LABELS[k] || DB.ROLES[k].label;
  const fieldLabel = (name) => (FIELD[name] ? FIELD[name].label : label(name));
  const issueText = (i) => T.issueText(i, i.field && FIELD[i.field] ? FIELD[i.field].label : null);
  const srcName = (id) => (E.getSource(id) || { name: 'Unknown source' }).name;
  const modes = (s) => s.modes.map(T.modeLabel).join(' or ');
  // Settings and technical details (codes, keys, trace IDs) are shown only to these roles. This is a
  // presentation choice; the engine's permission checks are unchanged and are what protects actions.
  const techAllowed = () => T.SETTINGS_ROLES.includes(S.role);
  // Expandable sections remember whether they are open, so a re-render does not collapse them.
  const detailsKey = (summary) => `${UI.page}:${String(summary).replace(/\s*\(\d+\)$/, '')}`;
  const isOpen = (key, dflt) => (UI.openDetails.has(key) ? UI.openDetails.get(key) : !!dflt);
  function techDetails(content, summary) {
    if (!techAllowed()) return '';
    const s = summary || 'Technical details';
    return html`<details class="tech" data-key="${detailsKey(s)}" ${raw(isOpen(detailsKey(s)) ? 'open' : '')}><summary>${s}</summary><div class="tech-body">${content}</div></details>`;
  }
  const moreDetails = (summary, content, open) => html`<details class="more" data-key="${detailsKey(summary)}" ${raw(isOpen(detailsKey(summary), open) ? 'open' : '')}><summary>${summary}</summary><div class="more-body">${content}</div></details>`;

  function maskVal(name, v) {
    if (v === null || v === undefined || v === '') return '—';
    const f = FIELD[name];
    if (!f) return String(v);
    if (f.sensitivePersonal) return '■ restricted';
    if (name === 'latitude' || name === 'longitude') return `≈ ${Number(v).toFixed(1)} (coarsened)`;
    const s = String(v);
    if (/^High/.test(f.sensitivity)) return '•••• ' + s.slice(-4);
    if (/^Medium/.test(f.sensitivity)) return s.length <= 1 ? '•' : s[0] + '•'.repeat(Math.min(5, s.length - 1));
    return s;
  }
  const person = (r) => (r.canonical ? `${maskVal('given_name', r.canonical.given_name)} ${maskVal('family_name', r.canonical.family_name)}` : '—');

  // ---------------------------------------------------------------------------
  // UI state
  // ---------------------------------------------------------------------------
  const UI = {
    page: 'home', tview: 'list', tstatus: '', openDetails: new Map(), runId: null, runTab: 'records', recFilter: 'all', recordId: null, sourceId: null,
    filters: { range: '7d', sourceId: '', mode: '', status: '' },
    runsQ: { q: '', sourceId: '', mode: '', status: '', sort: 'createdAt', dir: -1 },
    errQ: { code: '', sourceId: '', tab: 'action' }, errOpen: null,
    wiz: newWizard(), mapSource: 'SRC-NSR-NASSCO', mapDraft: null, mapTab: 'mapping', mapTest: null, mapVal: null, mapNote: '',
    schemaQ: { q: '', object: '', mandatory: '', sens: '', fill: '' },
    reconScope: '', reconOpen: null, lineQ: '', auditQ: '', sourceForm: null, modal: null, toast: null, animating: new Set(), auto: false, payloadView: null,
    // Send to NSR. Keys live in this object only (page memory), never in storage.
    nsr: { key: '', submitKey: '', operator: '', cfg: null, households: null, deliveries: null, selected: [], preview: null, result: null, confirm: false, busy: false, error: null, notes: {} },
  };
  function newWizard() { return { step: 1, sourceId: '', mode: '', file: null, upload: null, headerCheck: null, sim: {}, dry: null, ack: false, testResult: null, runId: null, showIssues: false, save: null }; }

  // Settings pages are for administrators; anyone else asking for one lands on Home.
  const allowedPage = (page) => (T.SETTINGS_PAGES.includes(page) && !techAllowed() ? 'home' : page);
  function go(page, extra) {
    UI.page = allowedPage(page);
    Object.assign(UI, extra || {});
    try { history.replaceState(null, '', '#' + page); } catch (_) { /* sandboxed */ }
    window.scrollTo(0, 0);
  }
  function toast(msg, crit) {
    UI.toast = { msg: T.scrub(msg), crit };
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { UI.toast = null; render(); }, crit ? 6500 : 4200);
  }
  const dis = (perm) => (E.can(perm) ? raw('') : raw(` disabled title="${esc(`Your role (${roleName(S.role)}) cannot ${T.PERM_LABELS[perm] || 'do this'}.`)}"`));
  // Engine refusals and validation errors, reworded for the person who triggered them.
  function plainError(err) {
    const m = /does not have permission: (\S+)/.exec(err.message || '');
    if (m) return `Your role (${roleName(S.role)}) cannot ${T.PERM_LABELS[m[1]] || 'do this'}. Attempt recorded in the audit log.`;
    return T.plainMessage(err.message);
  }

  // ---------------------------------------------------------------------------
  // Charts (SVG + HTML bars). Palette and mark specs follow the dataviz reference.
  // ---------------------------------------------------------------------------
  const C = { good: 'var(--good)', warn: 'var(--warn)', serious: 'var(--serious)', crit: 'var(--crit)', muted: 'var(--neutral-mark)', s1: 'var(--s1)', s2: 'var(--s2)', s3: 'var(--s3)', s4: 'var(--s4)' };
  const SRC_COLOR = { 'SRC-NSR-NASSCO': C.s1, 'SRC-STATE-JOSH': C.s2, 'SRC-LGA-UPLOAD': C.s3, 'SRC-LEGACY-PILOT': C.s4 };
  const srcColor = (id) => SRC_COLOR[id] || C.s4;
  function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }
  const legend = (items) => html`<div class="legend">${items.map((i) => html`<span><i style="background:${i.color}"></i>${i.name}</span>`)}</div>`;
  function chartTable(head, rows) {
    return html`<details class="chart-table"><summary>Table view</summary><div class="tbl-wrap"><table><thead><tr>${head.map((h) => html`<th>${h}</th>`)}</tr></thead><tbody>${rows.map((r) => html`<tr>${r.map((c) => html`<td>${c}</td>`)}</tr>`)}</tbody></table></div></details>`;
  }

  function columns({ cats, series, h, fmt, totals, xLabel }) {
    const W = 600, H = h || 190, L = 38, R = 8, T = 16, B = 26;
    const pw = W - L - R, ph = H - T - B;
    const sums = cats.map((_, i) => series.reduce((s, se) => s + (se.values[i] || 0), 0));
    const max = niceMax(Math.max(1, ...sums));
    const band = pw / Math.max(cats.length, 1), bw = Math.min(34, band * 0.62);
    const ticks = [0, max / 2, max];
    let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map((s) => s.name).join(', '))}">`;
    ticks.forEach((t) => { const y = T + ph - (t / max) * ph; svg += `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y}" y2="${y}"/><text x="${L - 6}" y="${y + 3}" text-anchor="end">${esc(fmt ? fmt(t) : Math.round(t))}</text>`; });
    cats.forEach((c, i) => {
      const x = L + band * i + (band - bw) / 2;
      let y = T + ph;
      series.forEach((se) => {
        const v = se.values[i] || 0;
        if (!v) return;
        const hh = (v / max) * ph;
        const gap = y < T + ph ? 2 : 0;
        const hDraw = Math.max(1, hh - gap);
        svg += `<rect x="${x}" y="${y - hh}" width="${bw}" height="${hDraw}" rx="2" fill="${se.color}" data-tip="${esc(`${c.tip || c.label}\n${se.name}: ${fmt ? fmt(v) : num(v)}`)}"/>`;
        y -= hh;
      });
      if (totals && sums[i]) svg += `<text class="val" x="${x + bw / 2}" y="${y - 4}" text-anchor="middle">${esc(fmt ? fmt(sums[i]) : num(sums[i]))}</text>`;
      if (c.label) svg += `<text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${esc(c.label)}</text>`;
    });
    svg += `<line class="axis" x1="${L}" x2="${W - R}" y1="${T + ph}" y2="${T + ph}"/>`;
    if (xLabel) svg += `<text x="${W - R}" y="${H - 8}" text-anchor="end">${esc(xLabel)}</text>`;
    svg += '</svg>';
    return raw(svg);
  }

  function lines({ cats, series, h, fmt, threshold }) {
    const W = 600, H = h || 190, L = 40, R = 10, T = 14, B = 26;
    const pw = W - L - R, ph = H - T - B;
    const all = series.flatMap((s) => s.values.filter((v) => v !== null && v !== undefined));
    const max = niceMax(Math.max(1, ...all, threshold ? threshold.value : 0));
    const x = (i) => L + (cats.length <= 1 ? pw / 2 : (pw * i) / (cats.length - 1));
    const y = (v) => T + ph - (v / max) * ph;
    let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map((s) => s.name).join(', '))}">`;
    [0, max / 2, max].forEach((t) => { svg += `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 6}" y="${y(t) + 3}" text-anchor="end">${esc(fmt ? fmt(t) : Math.round(t))}</text>`; });
    if (threshold) svg += `<line x1="${L}" x2="${W - R}" y1="${y(threshold.value)}" y2="${y(threshold.value)}" stroke="var(--crit)" stroke-dasharray="4 4" stroke-width="1"/><text x="${W - R}" y="${y(threshold.value) - 4}" text-anchor="end" style="fill:var(--crit-ink)">${esc(threshold.label)}</text>`;
    const step = Math.max(1, Math.ceil(cats.length / 8));
    cats.forEach((c, i) => { if (i % step === 0 || i === cats.length - 1) svg += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(c.label)}</text>`; });
    svg += `<line class="axis" x1="${L}" x2="${W - R}" y1="${T + ph}" y2="${T + ph}"/>`;
    series.forEach((se) => {
      const pts = se.values.map((v, i) => (v === null || v === undefined ? null : [x(i), y(v)]));
      const d = pts.filter(Boolean).map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
      if (d) svg += `<path d="${d}" fill="none" stroke="${se.color}" stroke-width="2" stroke-linejoin="round"/>`;
      pts.forEach((p, i) => { if (p) svg += `<circle cx="${p[0]}" cy="${p[1]}" r="4" fill="${se.color}" stroke="var(--surface)" stroke-width="2" data-tip="${esc(`${cats[i].tip || cats[i].label}\n${se.name}: ${fmt ? fmt(se.values[i]) : num(se.values[i])}`)}"/>`; });
    });
    svg += '</svg>';
    return raw(svg);
  }

  // rows: [{label, sub, segs:[{name, color, v}], value}]
  function hbars(rows, opts) {
    opts = opts || {};
    const max = opts.max || Math.max(1, ...rows.map((r) => r.segs.reduce((s, x) => s + x.v, 0)));
    if (!rows.length) return html`<div class="empty">No data for the current filters.</div>`;
    return html`<div class="hb">${rows.map((r) => html`
      <div class="hb-row"><div class="hb-l">${r.label}${r.sub ? html`<span>${r.sub}</span>` : ''}</div>
      <div class="hb-track">${r.segs.filter((s) => s.v > 0).map((s) => html`<i style="width:${((s.v / max) * 100).toFixed(2)}%;background:${s.color}" data-tip="${`${r.label}\n${s.name}: ${opts.fmt ? opts.fmt(s.v) : num(s.v)}`}"></i>`)}</div>
      <div class="hb-v">${r.value !== undefined ? r.value : num(r.segs.reduce((s, x) => s + x.v, 0))}</div></div>`)}</div>`;
  }

  // ---------------------------------------------------------------------------
  // Shell
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Attention model: open engine errors grouped by source and issue type. Shared by the
  // overview card, the navigation count and the Exceptions screen so they always agree.
  // ---------------------------------------------------------------------------
  const STUCK = ['AWAITING_RETRY', 'UNKNOWN', 'DEAD_LETTER'];
  function attentionGroups(filter) {
    const f = filter || {};
    const groups = new Map();
    for (const e of S.errors) {
      if (e.resolution !== 'OPEN' && e.resolution !== 'RETRYING') continue;
      if (f.sourceId && e.sourceId !== f.sourceId) continue;
      if (f.code && e.code !== f.code) continue;
      const msg = T.friendlyError(e.code);
      const auto = e.resolution === 'RETRYING' || msg.auto;
      const key = `${e.sourceId || '-'}|${e.code}|${auto ? 'auto' : 'open'}`;
      const g = groups.get(key) || { key, code: e.code, msg, auto, needsUser: !auto && msg.needsUser, sourceId: e.sourceId, errors: [], recordIds: new Set(), runIds: new Set(), at: 0 };
      g.errors.push(e);
      if (e.recordId) g.recordIds.add(e.recordId);
      if (e.runId) g.runIds.add(e.runId);
      g.at = Math.max(g.at, e.at);
      groups.set(key, g);
    }
    return [...groups.values()].sort((a, b) => (b.needsUser - a.needsUser) || b.at - a.at);
  }
  // Marking as reviewed only records that someone looked at it. It is offered only where the
  // records are not waiting on a delivery, a match decision or replication.
  function canMarkReviewed(g) {
    if (g.auto || ['MATCH_REQUIRES_REVIEW', 'MASTER_WRITE_OUTCOME_UNKNOWN', 'REPLICA_SYNC_FAILED', 'REPLICA_SYNC_PENDING'].includes(g.code)) return false;
    return [...g.recordIds].every((id) => { const r = E.findRecord(id); return !r || !STUCK.includes(r.primary.status); });
  }
  function attentionTotals() {
    const gs = attentionGroups();
    const recs = new Set(), transfers = new Set();
    gs.filter((g) => g.needsUser).forEach((g) => { g.recordIds.forEach((id) => recs.add(id)); if (!g.recordIds.size) g.errors.forEach((e) => transfers.add(e.runId || e.id)); });
    return { records: recs.size, transfers: transfers.size, total: recs.size + transfers.size, groups: gs };
  }
  function navCounts() {
    return { attention: attentionTotals().total };
  }
  // Screen register, following the NigeriaG2P naming convention NG2P-{MODULE}-{###}.
  // CDB (CCT DataBridge) is a proposed module code, not one of the 26 areas in the client baseline.
  const PAGE_META = {
    home: ['001', 'Transfer operator'], runs: ['002', 'Transfer operator'], run: ['003', 'Transfer operator'], errors: ['004', 'Platform admin'],
    recon: ['005', 'Platform admin'], sources: ['006', 'Source admin'], destinations: ['007', 'Platform admin'], mapping: ['008', 'Source admin'],
    ingest: ['009', 'Transfer operator'], quality: ['010', 'Data quality analyst'], lineage: ['011', 'Data quality analyst'], audit: ['012', 'Auditor'],
    security: ['013', 'Auditor'], architecture: ['014', 'Platform admin'], settings: ['015', 'Platform admin'],
  };
  const screenId = () => `NG2P-CDB-${(PAGE_META[UI.page] || PAGE_META.home)[0]}`;
  // Which of the four sections a page belongs to.
  const section = (p) => (p === 'run' ? 'runs' : T.SETTINGS_PAGES.includes(p) ? 'settings' : p);

  function shell(content) {
    const nc = navCounts();
    const nav = T.NAV.filter(([k]) => k !== 'settings' || techAllowed());
    return html`<div class="strip"><span>NigeriaG2P · CCT DataBridge</span><span>Demo · synthetic data</span></div>
      <div class="shell">
      <nav class="rail" aria-label="Main">
        <div class="brand"><span class="brand-word">NigeriaG2P</span><span class="brand-sub">Staff services</span><span class="brand-app">CCT DataBridge</span></div>
        <div class="nav-wrap"><div class="nav-group">${nav.map(([k, l]) => html`
          <button class="nav-btn" data-act="nav" data-arg="${k}" ${raw(section(UI.page) === k ? 'aria-current="page"' : '')}>${l}
          ${k === 'runs' && nc.attention ? html`<span class="nav-count" title="Needs Attention">${nc.attention}</span>` : ''}</button>`)}</div></div>
        <div class="rail-role"><b>Role</b>${roleName(S.role)}</div>
        <div class="rail-foot">Prototype v0.5 · NigeriaG2P v1.0</div>
      </nav>
      <div class="main">
        <header class="topbar">
          <div class="env"><span class="module-name">CCT DataBridge</span></div>
          <div class="clock" title="Demo clock: runs retries and replication checks"><span>Demo clock</span><time>${fmtTime(S.now, false)}</time>
            <button class="btn sm" data-act="clock" data-arg="30000">+30 s</button>
            <button class="btn sm" data-act="clock" data-arg="180000">+3 min</button>
            <button class="btn sm" data-act="auto" aria-pressed="${UI.auto}">${UI.auto ? 'Pause' : 'Play'}</button></div>
          <div class="who"><label for="role">Acting as</label>
            <select id="role" data-change="role">${Object.keys(DB.ROLES).map((k) => html`<option value="${k}" ${raw(S.role === k ? 'selected' : '')}>${roleName(k)}</option>`)}</select></div>
        </header>
        <main class="content">${content}</main>
        <div class="page-foot">${screenId()} · Synthetic data</div>
      </div></div>
      ${modal()}${UI.toast ? html`<div class="toast ${UI.toast.crit ? 'crit' : ''}" role="status">${UI.toast.msg}</div>` : ''}`;
  }
  // Page header: breadcrumb (screen ID, parent section), title, actions. Notes are no longer shown.
  function head(title, note, actions, crumbs) {
    const parent = T.SETTINGS_PAGES.includes(UI.page) && UI.page !== 'settings' ? html` / <button data-act="nav" data-arg="settings">Settings</button>` : '';
    return html`<div class="page-head"><div><div class="crumbs">${screenId()}${parent}${crumbs ? html` / ${crumbs}` : ''}</div><h1>${title}</h1></div>${actions ? html`<div class="btns">${actions}</div>` : ''}</div>`;
  }

  // ---------------------------------------------------------------------------
  // Overview
  // ---------------------------------------------------------------------------
  function filterBar(f, key) {
    return html`<div class="filters">
      <div class="stack" style="gap:4px"><span class="small muted">Period</span><div class="seg">${[['today', 'Today'], ['24h', '24 h'], ['7d', '7 days'], ['all', 'All']].map(([v, l]) => html`<button data-act="filter" data-arg="${key}.range=${v}" aria-pressed="${f.range === v}">${l}</button>`)}</div></div>
      <label class="field">Source<select data-change="filter" data-key="${key}.sourceId"><option value="">All sources</option>${S.sources.filter((s) => !s.removed).map((s) => html`<option value="${s.id}" ${raw(f.sourceId === s.id ? 'selected' : '')}>${s.name}</option>`)}</select></label>
      <label class="field">Method<select data-change="filter" data-key="${key}.mode"><option value="">All methods</option><option value="API" ${raw(f.mode === 'API' ? 'selected' : '')}>API</option><option value="IMPORT" ${raw(f.mode === 'IMPORT' ? 'selected' : '')}>File upload</option></select></label></div>`;
  }

  function kpi(k, v, d, tone, act, arg) {
    const body = html`<span class="k">${k}</span><span class="v">${v}</span>${d ? html`<span class="d">${d}</span>` : ''}`;
    return act ? html`<button class="kpi" data-tone="${tone || ''}" data-act="${act}" data-arg="${arg || ''}">${body}</button>` : html`<div class="kpi" data-tone="${tone || ''}">${body}</div>`;
  }
  // "3 records and 1 transfer need attention."
  function attentionSentence(at) {
    const n = (x, one, many) => `${num(x)} ${x === 1 ? one : many}`;
    const parts = [at.records ? n(at.records, 'record', 'records') : '', at.transfers ? n(at.transfers, 'transfer', 'transfers') : ''].filter(Boolean);
    return `${parts.join(' and ')} ${at.total === 1 ? 'needs' : 'need'} attention.`;
  }

  function pageHome() {
    const rc = E.metrics({ range: 'all' }).reconciliation;
    const at = attentionTotals();
    return html`
      ${head('Home', null, html`<button class="btn primary lg" data-act="nav" data-arg="ingest" ${dis('run.start')}>Add Records</button>`)}
      ${at.total ? html`<div class="callout warn alert-row" role="status"><b>${attentionSentence(at)}</b><button class="btn" data-act="attention-all">View</button></div>` : html`<div class="callout ok" role="status">Nothing needs attention.</div>`}
      <div class="kpis kpis-3">
        ${kpi('Records received', num(rc.received), '', '', 'nav', 'runs')}
        ${kpi('Records transferred', num(rc.primaryWritten), '', 'good', 'nav', 'runs')}
        ${kpi('Needs Attention', num(at.total), '', at.total ? 'crit' : '', 'attention-all', '')}
      </div>`;
  }

  // Operational analytics, shown on Data quality rather than the overview.
  function analyticsPanels(f) {
    const a = E.analytics(f);
    const dayCats = a.days.map((d) => { const dt = new Date(d + 'T12:00:00'); return { label: `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getDay()]} ${dt.getDate()}`, tip: d }; });
    const L = { written: 'Written', pending: 'Pending', failed: 'Write failed', rejected: 'Rejected' };
    const srcRows = a.bySource.map((s) => ({ label: s.name, segs: [{ name: L.written, color: C.good, v: s.written }, { name: L.rejected, color: C.serious, v: s.rejected }, { name: L.failed, color: C.crit, v: s.failed }, { name: L.pending, color: C.warn, v: s.received - s.written - s.rejected - s.failed }] }));
    const cats = Object.entries(a.issueCats).sort((x, y) => y[1] - x[1]);
    const out = a.outcomes;
    const outTotal = Object.values(out).reduce((s, v) => s + v, 0);
    const tp = a.throughput.slice(-14);
    const sids = Object.keys(a.errorTrend);
    return html`<div class="grid">
        <section class="panel c8"><header><h3>Records per day</h3></header><div class="body">
          ${legend([{ name: L.written, color: C.good }, { name: L.pending, color: C.warn }, { name: L.failed, color: C.crit }, { name: L.rejected, color: C.serious }])}
          ${columns({ cats: dayCats, totals: true, series: [{ name: L.written, color: C.good, values: a.byDay.map((d) => d.written) }, { name: L.pending, color: C.warn, values: a.byDay.map((d) => d.outstanding) }, { name: L.failed, color: C.crit, values: a.byDay.map((d) => d.failed) }, { name: L.rejected, color: C.serious, values: a.byDay.map((d) => d.rejected) }] })}
          ${chartTable(['Day', 'Received', 'Written', 'Pending', 'Write failed', 'Rejected'], a.byDay.map((d) => [d.day, d.received, d.written, d.outstanding, d.failed, d.rejected]))}</div></section>
        <section class="panel c4"><header><h3>Write outcomes</h3><span class="sub">${num(outTotal)} sent</span></header><div class="body">
          ${hbars([['Written', out.WRITTEN, C.good], ['Retry scheduled', out.AWAITING_RETRY, C.warn], ['Outcome unknown', out.UNKNOWN, C.serious], ['Write failed', out.DEAD_LETTER, C.crit], ['Awaiting commit', out.IN_FLIGHT, C.muted]].map(([l, v, c]) => ({ label: l, segs: [{ name: l, color: c, v }] })), { max: Math.max(1, outTotal) })}</div></section>
        <section class="panel c6"><header><h3>Results by source</h3></header><div class="body">
          ${legend([{ name: L.written, color: C.good }, { name: L.rejected, color: C.serious }, { name: L.failed, color: C.crit }, { name: L.pending, color: C.warn }])}
          ${hbars(srcRows)}</div></section>
        <section class="panel c6"><header><h3>Top validation errors</h3></header><div class="body">
          ${hbars(cats.map(([k, v]) => ({ label: T.friendlyError(k).title, segs: [{ name: T.friendlyError(k).title, color: C.s1, v }] })))}</div></section>
      </div>
      ${moreDetails('More charts', html`<div class="grid">
        <section class="panel c6"><header><h3>Results by method</h3></header><div class="body">
          ${hbars(['API', 'IMPORT'].flatMap((md) => { const x = a.byMode[md]; return [{ label: `${T.modeLabel(md)}: write rate`, sub: `${num(x.written)} of ${num(x.accepted)}`, segs: [{ name: 'Written', color: C.s1, v: x.accepted ? x.written / x.accepted : 0 }], value: pct(x.accepted ? x.written / x.accepted : null) }, { label: `${T.modeLabel(md)}: validity`, sub: `${num(x.valid)} of ${num(x.received)}`, segs: [{ name: 'Valid', color: C.s3, v: x.received ? x.valid / x.received : 0 }], value: pct(x.received ? x.valid / x.received : null) }]; }), { max: 1, fmt: (v) => pct(v) })}</div></section>
        <section class="panel c6"><header><h3>Throughput</h3><span class="sub">Records/min, last ${tp.length} transfers</span></header><div class="body">
          ${legend([{ name: 'API', color: C.s1 }, { name: 'File upload', color: C.s2 }])}
          ${columns({ cats: tp.map((t) => ({ label: '', tip: fmtTime(t.at, false) })), series: [{ name: 'API', color: C.s1, values: tp.map((t) => (t.mode === 'API' ? t.perMin : 0)) }, { name: 'File upload', color: C.s2, values: tp.map((t) => (t.mode === 'IMPORT' ? t.perMin : 0)) }], xLabel: 'oldest → newest' })}
          ${chartTable(['Transfer', 'Method', 'Records/min'], tp.map((t) => [fmtTime(t.at, false), T.modeLabel(t.mode), t.perMin]))}</div></section>
        <section class="panel c6"><header><h3>Retries per day</h3></header><div class="body">
          ${columns({ cats: dayCats, totals: true, series: [{ name: 'Retries', color: C.s4, values: a.byDay.map((d) => d.retries) }] })}</div></section>
        <section class="panel c6"><header><h3>Replication lag</h3><span class="sub">Seconds, per transfer</span></header><div class="body">
          ${legend([{ name: 'Max', color: C.s2 }, { name: 'Average', color: C.s1 }])}
          ${a.lagByRun.length ? lines({ cats: a.lagByRun.map((l) => ({ label: fmtTime(l.at, false).replace(/ \d\d:\d\d$/, ''), tip: fmtTime(l.at, false) })), series: [{ name: 'Max', color: C.s2, values: a.lagByRun.map((l) => +l.maxS.toFixed(1)) }, { name: 'Average', color: C.s1, values: a.lagByRun.map((l) => +l.avgS.toFixed(1)) }], fmt: (v) => `${v}s`, threshold: { value: S.destinations[1].lagThresholdMs / 1000, label: 'threshold 60 s' } }) : html`<div class="empty">No replication data.</div>`}</div></section>
        <section class="panel c12"><header><h3>Exceptions by source</h3></header><div class="body">
          ${legend(sids.map((sid) => ({ name: srcName(sid), color: srcColor(sid) })))}
          ${sids.length ? lines({ cats: dayCats, series: sids.map((sid) => ({ name: srcName(sid), color: srcColor(sid), values: a.days.map((d) => a.errorTrend[sid][d]) })) }) : html`<div class="empty">No exceptions.</div>`}</div></section>
      </div>`)}`;
  }

  // ---------------------------------------------------------------------------
  // Transfer history and transfer details
  // ---------------------------------------------------------------------------
  // Five timeline steps, derived from engine stages and, where stages are not enough,
  // from record states. A step never shows as done before the records say so.
  function journey(run) {
    const rc = E.reconcileSummary([run]);
    const st = E.runStatus(run);
    const byKey = Object.fromEntries(run.stages.map((s) => [s.key, s]));
    const ended = run.stageIdx >= run.stages.length;
    return T.JOURNEY.map(([name, keys], i) => {
      const ss = keys.map((k) => byKey[k]).filter(Boolean);
      const has = (x) => ss.some((s) => x.includes(s.status));
      let state, tone, note = '';
      if (has(['FAILED'])) [state, tone] = ['Failed', 'crit'];
      else if (ss.every((s) => s.status === 'SKIPPED')) [state, tone] = [run.dryRun ? 'Not in validation' : 'Skipped', ''];
      else if (has(['RUNNING']) || (has(['DONE', 'WARN']) && has(['PENDING']))) [state, tone] = ['Running', 'info run'];
      else if (ss.every((s) => s.status === 'PENDING')) [state, tone] = ['Pending', ''];
      else [state, tone] = has(['WARN']) ? ['Done with warnings', 'warn'] : ['Done', 'good'];
      const done = tone === 'good' || tone === 'warn';
      if (i === 0 && done) note = `${num(rc.received)} received`;
      if (i === 1 && done) note = `${num(rc.accepted)} valid · ${num(rc.rejectedBeforeDelivery + rc.heldForReview)} held`;
      if (i === 2 && done) {
        note = `${num(rc.primaryWritten)} written`;
        if (rc.unknown) [state, tone] = ['Outcome unknown', 'crit'];
        else if (rc.awaitingRetry || rc.inFlight) [state, tone] = ['Partial', 'warn'];
      }
      if (i === 3 && done) {
        note = `${num(rc.replicaConfirmed)} replicated`;
        if (rc.replicaFailed) [state, tone] = ['Failed', 'crit'];
        else if (rc.replicaPending) [state, tone] = ['Pending', 'warn'];
      }
      if (i === 4 && ended && !run.fatal && !run.blocked && !run.dryRun && !['COMPLETED', 'COMPLETED_WITH_ERRORS'].includes(st)) [state, tone, note] = ['Open', 'warn', T.runStatus(st).label];
      return { name, state, tone, note };
    });
  }
  function journeyView(run) {
    return html`<ol class="journey">${journey(run).map((j, i) => html`<li data-tone="${j.tone}"><span class="j-n">${j.tone === 'good' ? '✓' : i + 1}</span><span class="j-l">${j.name}</span><span class="pill ${j.tone}">${j.state}</span>${j.note ? html`<span class="small muted">${j.note}</span>` : ''}</li>`)}</ol>`;
  }
  const stopCode = (run) => (run.blocked ? 'FIELD_MAPPING_FAILED' : run.fatal ? (/^([A-Z_]+):/.exec(run.fatal.message) || [])[1] : null);
  // One-line outcome of a transfer, from engine state.
  function resultMessage(run) {
    const st = UI.animating.has(run.id) ? 'RUNNING' : E.runStatus(run);
    const rc = E.reconcileSummary([run]);
    if (st === 'RUNNING' || st === 'QUEUED') return { tone: '', text: 'Transfer in progress.' };
    const code = stopCode(run);
    if (code) { const m = T.friendlyError(code); return { tone: 'crit', title: `${m.title}.`, text: `${m.impact || 'Nothing written.'} ${m.next}` }; }
    const review = rc.rejectedBeforeDelivery + rc.heldForReview + rc.primaryFailed;
    const pending = rc.awaitingRetry + rc.inFlight;
    const parts = [`${num(rc.primaryWritten)} of ${num(rc.received)} written`];
    if (rc.unknown) parts.push(`${num(rc.unknown)} outcome unknown`);
    if (pending) parts.push(`${num(pending)} retry scheduled`);
    if (review) parts.push(`${num(review)} exceptions`);
    if (rc.replicaFailed) parts.push(`${num(rc.replicaFailed)} not replicated`);
    else if (rc.replicaPending) parts.push('replication pending');
    else if (rc.primaryWritten) parts.push('replicated');
    const s = T.runStatus(st);
    return { tone: st === 'COMPLETED' ? 'good' : ['NEEDS_RECONCILIATION', 'REPLICA_FAILED'].includes(st) ? 'crit' : 'warn', title: `${s.label}.`, text: `${parts.join(' · ')}.` };
  }
  const resultCallout = (run) => { const r = resultMessage(run); return html`<div class="callout ${r.tone === 'good' ? 'ok' : r.tone}" role="status">${r.title ? html`<b>${r.title}</b> ` : ''}${r.text}</div>`; };

  const runState = (run) => (UI.animating.has(run.id) ? 'RUNNING' : E.runStatus(run));
  const simplePill = (st) => { const x = T.simpleStatus(st); return html`<span class="pill ${x.tone}">${x.label}</span>`; };

  function runsTable(runs) {
    if (!runs.length) return html`<div class="empty"><b>No transfers.</b></div>`;
    return html`<div class="tbl-wrap"><table class="t"><thead><tr><th>Date</th><th>Source</th><th class="num">Records</th><th>Status</th><th></th></tr></thead><tbody>
      ${runs.map((run) => html`<tr><td>${fmtTime(run.createdAt, false)}</td><td>${run.sourceName}</td><td class="num">${num(run.records.length)}</td><td>${simplePill(runState(run))}</td>
        <td class="num"><button class="btn sm" data-act="run" data-arg="${run.id}">View Details</button></td></tr>`)}
      </tbody></table></div>`;
  }

  // Transfers: the list, or what needs attention across all transfers.
  function pageRuns() {
    const at = attentionTotals();
    const all = S.runs.slice().reverse();
    const runs = UI.tstatus ? all.filter((r) => T.simpleStatus(runState(r)).label === UI.tstatus) : all;
    const views = [['list', 'All Transfers'], ['attention', `Needs Attention (${num(at.total)})`]].concat(E.can('nsr.preview') ? [['nsr', 'Send to NSR']] : []);
    if (UI.tview === 'nsr' && !E.can('nsr.preview')) UI.tview = 'list';
    const body = UI.tview === 'attention' ? attentionView() : UI.tview === 'nsr' ? nsrView() : html`
      <label class="field inline">Status<select data-change="bind" data-key="tstatus"><option value="">All</option>${T.SIMPLE_STATUSES.map((l) => html`<option value="${l}" ${raw(UI.tstatus === l ? 'selected' : '')}>${l}</option>`)}</select></label>
      <section class="panel"><div class="body flush">${runsTable(runs)}</div></section>`;
    return html`${head('Transfers', null, html`<button class="btn primary" data-act="nav" data-arg="ingest" ${dis('run.start')}>Add Records</button>`)}
      <div class="tabs big" role="tablist">${views.map(([k, l]) => html`<button role="tab" aria-selected="${UI.tview === k}" data-act="tview" data-arg="${k}">${l}</button>`)}</div>
      ${body}`;
  }

  function attentionView() {
    const gs = attentionGroups();
    const act = gs.filter((g) => g.needsUser), auto = gs.filter((g) => !g.needsUser);
    const retryable = S.runs.flatMap((r) => r.records).filter((r) => ['AWAITING_RETRY', 'UNKNOWN'].includes(r.primary.status) || (r.primary.status === 'DEAD_LETTER' && !(r.fault && r.fault.kind === 'permanent')));
    return html`${act.length ? html`<section class="panel">${retryable.length > 1 ? html`<header><span class="sub">${num(act.length)} issue(s)</span><button class="btn" data-act="retry-all" ${dis('run.retry')}>Retry All (${num(retryable.length)})</button></header>` : ''}<div class="body flush">${groupRows(act)}</div></section>` : html`<div class="callout ok">Nothing needs attention.</div>`}
      ${auto.length ? moreDetails(`Handled automatically (${auto.length})`, groupRows(auto)) : ''}
      ${techAllowed() ? html`<div class="btns"><button class="btn sm ghost" data-act="nav" data-arg="errors">Exception Log</button><button class="btn sm ghost" data-act="nav" data-arg="recon">Reconciliation</button></div>` : ''}`;
  }

  // ---------------------------------------------------------------------------
  // Send to NSR: the outbound OpenG2P NSR webhook, through the DataBridge API (/api/v1/nsr/...).
  // The server decides who may submit (DATABRIDGE_NSR_SUBMIT_KEY); the role check here only shapes the screen.
  // ---------------------------------------------------------------------------
  const NSR_STATUS = {
    READY: ['Ready', 'good'], VALIDATION_FAILED: ['Needs correction', 'warn'],
    PENDING: ['Sending', 'info run'], RETRY_SCHEDULED: ['Will retry', 'info run'], ACCEPTED: ['Received by NSR', 'good'],
    CONFIRMATION_PENDING: ['Check NSR', 'warn'], REJECTED: ['Rejected by NSR', 'crit'], DELIVERY_FAILED: ['Not delivered', 'crit'],
  };
  const NSR_REASONS = {
    CONSENT_NOT_GIVEN: 'Consent to share data was not given.', CONSENT_MISSING: 'Consent is not recorded for every member.',
    NO_HEAD: 'No household head is marked.', MULTIPLE_HEADS: 'More than one household head is marked.', HEAD_CONFLICT: 'Head of household details disagree.',
    MEMBER_COUNT_MISMATCH: 'The member count does not match the members on file.', MEMBER_COUNT_MISSING: 'The member count is missing.',
    DUPLICATE_MEMBER: 'The same person appears twice.', HOUSEHOLD_FIELD_CONFLICT: 'Members have different household details, for example the address.',
    MIXED_SYNTHETIC: 'Test and real records are mixed.', SYNTHETIC_NOT_ALLOWED: 'Test records cannot be sent to NSR here.',
    TOO_MANY_MEMBERS: 'Too many members for one submission.', HOUSEHOLD_NOT_FOUND: 'Household not found.',
    NSR_WEBHOOK_DISABLED: 'Sending to NSR is switched off in this environment.', NSR_SUBMIT_FORBIDDEN: 'This key cannot send to NSR. Enter the NSR submit key.',
    UNAUTHORISED: 'The API key was not accepted.', OPERATOR_REQUIRED: 'Enter your name or operator ID.', DUPLICATE_SUBMISSION: 'Already sent, or being sent.',
    BATCH_TOO_LARGE: 'Too many households at once. Select fewer.', VALIDATION_FAILED: 'Some households need correction first.',
    CONFIRMATION_REQUIRED: 'Check NSR first, then confirm.', NOT_RETRYABLE: 'This delivery cannot be retried.', NETWORK: 'The DataBridge API cannot be reached from this page.',
  };
  const nsrPill = (s) => { const [l, tone] = NSR_STATUS[s] || [label(s), '']; return html`<span class="pill ${tone}">${l}</span>`; };
  const nsrReason = (code) => NSR_REASONS[code] || 'Something went wrong. Ask an administrator.';

  async function nsrApi(method, path, body, asOperator) {
    const n = UI.nsr;
    const headers = { 'X-API-Key': asOperator ? n.submitKey : n.key };
    if (asOperator) headers['X-Operator-Id'] = n.operator;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try { res = await fetch('/api/v1/nsr' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); } catch (e) { throw Object.assign(new Error('network'), { code: 'NETWORK' }); }
    let data = null;
    try { data = await res.json(); } catch (e) { throw Object.assign(new Error('network'), { code: 'NETWORK' }); }
    if (!res.ok) throw Object.assign(new Error(data.error && data.error.message), { code: data.error && data.error.code, details: data.error && data.error.details, status: res.status });
    return data;
  }
  // Runs one API step, then re-renders. Errors become a plain sentence on the screen.
  function nsrRun(fn) {
    UI.nsr.busy = true; UI.nsr.error = null;
    Promise.resolve().then(fn).catch((e) => { UI.nsr.error = e; }).finally(() => { UI.nsr.busy = false; render(); });
  }
  async function nsrLoad() {
    const n = UI.nsr;
    n.cfg = await nsrApi('GET', '/config');
    n.households = (await nsrApi('GET', '/households')).items;
    n.deliveries = (await nsrApi('GET', '/deliveries?page_size=50')).items;
  }

  function nsrView() {
    const n = UI.nsr;
    const canSend = E.can('nsr.submit');
    const err = n.error ? html`<div class="callout crit" role="alert"><b>${nsrReason(n.error.code)}</b>${n.error.details && n.error.details.length ? html`<div class="small">${n.error.details.map((d) => html`<div>${d.household_serial || ''} ${d.errors ? d.errors.map((e) => nsrReason(e.code)).join(' ') : nsrReason(d.code)}</div>`)}</div>` : ''}</div>` : '';
    const connect = html`<section class="panel"><header><b>Connect</b>${n.cfg ? html`<span class="sub">${n.cfg.enabled ? 'Sending is on' : 'Sending is off: you can check households, nothing is sent'}</span>` : ''}</header><div class="body">
      <div class="filters">
        <label class="field">API key<input type="password" id="nsr-key" autocomplete="off" data-live data-bind="nsr.key" value="${n.key}"></label>
        ${canSend ? html`<label class="field">NSR submit key<input type="password" id="nsr-submit-key" autocomplete="off" data-live data-bind="nsr.submitKey" value="${n.submitKey}"></label>
        <label class="field">Your name or ID<input id="nsr-operator" autocomplete="off" data-live data-bind="nsr.operator" value="${n.operator}" maxlength="64"></label>` : ''}
        <button class="btn primary" data-act="nsr-connect" ${raw(n.busy || !n.key ? 'disabled' : '')}>${n.households ? 'Refresh' : 'Connect'}</button>
      </div><div class="small muted">Keys stay in this page only and are cleared when you close it.</div></div></section>`;
    if (!n.households) return html`${err}${connect}`;

    const ready = n.households.filter((h) => h.status === 'READY');
    const rows = n.households.map((h) => {
      const on = n.selected.includes(h.household_serial);
      return html`<tr><td><input type="checkbox" aria-label="Select ${h.household_serial}" data-act="nsr-toggle" data-arg="${h.household_serial}" ${raw(on ? 'checked' : '')} ${raw(h.status === 'READY' ? '' : 'disabled')}></td>
        <td>${h.household_serial}</td><td class="num">${num(h.members)}</td><td>${[h.lga_name, h.state_name].filter(Boolean).join(', ')}</td><td>${nsrPill(h.status)}</td>
        <td class="small">${h.errors.length ? h.errors.map(nsrReason).join(' ') : h.latest_delivery ? html`Last sent: ${nsrPill(h.latest_delivery.status)}` : ''}</td></tr>`;
    });
    const pick = html`<section class="panel"><header><b>1. Select households</b><span class="sub">${num(ready.length)} of ${num(n.households.length)} ready</span>
        <button class="btn" data-act="nsr-preview" ${raw(n.busy || !n.selected.length ? 'disabled' : '')}>Check Selected (${num(n.selected.length)})</button></header>
      <div class="body flush"><div class="tbl-wrap"><table class="t"><thead><tr><th></th><th>Household</th><th>Members</th><th>Area</th><th>Status</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table></div></div></section>`;

    const p = n.preview;
    const review = p ? html`<section class="panel"><header><b>2. Review</b>${nsrPill(p.status)}</header><div class="body stack">
        ${p.households.map((h) => html`<div><b>${h.household_serial}</b> ${nsrPill(h.status)} <span class="small muted">${num(h.members)} member(s)</span>
          ${h.errors.length ? html`<ul class="small">${h.errors.map((e) => html`<li>${nsrReason(e.code)}</li>`)}</ul>` : ''}
          ${h.warnings.length ? moreDetails(`Notes for the NSR team (${h.warnings.length})`, html`<ul class="small">${h.warnings.map((w) => html`<li>${w.field ? html`<b>${w.field}</b>: ` : ''}${w.message}</li>`)}</ul>`) : ''}</div>`)}
        ${p.request ? moreDetails('Show the request NSR will receive', html`<dl class="kv small"><dt>Method</dt><dd>${p.request.method}</dd><dt>Address</dt><dd>${p.request.url}</dd><dt>Format</dt><dd>${p.request.format}</dd><dt>Values</dt><dd>${p.view === 'full' ? 'Shown in full (test data)' : 'Masked here; NSR receives the stored values'}</dd></dl>
          <pre class="code">${JSON.stringify(p.request.body, null, 2)}</pre>`) : ''}
      </div></section>` : '';

    const sendable = p && p.status === 'READY' && n.cfg && n.cfg.enabled;
    const send = p && canSend ? html`<section class="panel"><header><b>3. Send</b></header><div class="body stack">
        ${!n.cfg.enabled ? html`<div class="callout warn">${nsrReason('NSR_WEBHOOK_DISABLED')}</div>` : ''}
        <label class="row confirm"><input type="checkbox" id="nsr-confirm" data-bind="nsr.confirm" data-type="check" ${raw(n.confirm ? 'checked' : '')}> I have reviewed ${num(p.households.length)} household(s) and want to send them to the NSR Household Register.</label>
        <div class="btns"><button class="btn primary" data-act="nsr-submit" ${dis('nsr.submit')} ${raw(!sendable || !n.confirm || n.busy || !n.submitKey || !n.operator ? 'disabled' : '')}>Send to NSR</button></div>
      </div></section>` : '';

    const r = n.result;
    const result = r ? html`<div class="callout ${r.status === 'ACCEPTED' ? 'ok' : ['REJECTED', 'DELIVERY_FAILED'].includes(r.status) ? 'crit' : 'warn'}" role="status">
        <b>${{ ACCEPTED: 'Sent. NSR received the message.', RETRY_SCHEDULED: 'NSR is busy. DataBridge will try again automatically.', CONFIRMATION_PENDING: 'No clear answer from NSR. Check NSR before sending again.', REJECTED: 'NSR rejected the message.', DELIVERY_FAILED: 'Not delivered.' }[r.status] || 'Sending…'}</b>
        <div>${r.correlation_id ? html`NSR reference: <b>${r.correlation_id}</b>. ` : ''}${r.status === 'ACCEPTED' ? 'NSR adds households in the background; confirm in the Household Register.' : r.last_reason || ''}</div></div>` : '';

    const dl = n.deliveries || [];
    const deliveries = html`<section class="panel"><header><b>Deliveries</b><span class="sub">${num(dl.length)}</span></header><div class="body flush">${dl.length ? html`<div class="tbl-wrap"><table class="t"><thead><tr><th>Sent</th><th>Households</th><th>Status</th><th>NSR reference</th><th>Tries</th><th></th></tr></thead><tbody>
      ${dl.map((d) => html`<tr><td>${fmtTime(Date.parse(d.created_at), false)}</td><td class="small">${d.households.map((h) => h.household_serial).join(', ')}</td><td>${nsrPill(d.status)}</td><td class="small">${d.correlation_id || '—'}</td><td class="num">${num(d.attempt_count)}</td>
        <td class="num">${['RETRY_SCHEDULED', 'DELIVERY_FAILED'].includes(d.status) && canSend ? html`<button class="btn sm" data-act="nsr-retry" data-arg="${d.id}" ${dis('nsr.submit')}>Retry</button>` : ''}
        ${d.status === 'CONFIRMATION_PENDING' && canSend ? html`<input class="sm" placeholder="What did you check in NSR?" data-bind="nsr.notes.${d.id}" value="${n.notes[d.id] || ''}">
          <button class="btn sm" data-act="nsr-reconcile" data-arg="${d.id}|ACCEPTED" ${dis('nsr.submit')}>Found in NSR</button><button class="btn sm" data-act="nsr-reconcile" data-arg="${d.id}|NOT_RECEIVED" ${dis('nsr.submit')}>Not in NSR</button>` : ''}</td></tr>`)}
      </tbody></table></div>${moreDetails('Advanced details', html`<pre class="code">${JSON.stringify(dl.map((d) => ({ id: d.id, status: d.status, message_id: d.message_id, ack: d.ack, registry_commit: d.registry_commit, last_reason: d.last_reason, next_attempt_at: d.next_attempt_at, reconciliation: d.reconciliation })), null, 2)}</pre>`)}` : html`<div class="empty">Nothing sent yet.</div>`}</div></section>`;
    return html`${err}${connect}${result}${pick}${review}${send}${deliveries}`;
  }

  // Record IDs with an open issue that needs a person. Shared by the transfer summary and its lists.
  function attentionIds() {
    const ids = new Set();
    attentionGroups().filter((g) => g.needsUser).forEach((g) => g.recordIds.forEach((id) => ids.add(id)));
    return ids;
  }
  // One plain status per record for operators; the full states stay in Advanced Details.
  function recordState(r, open) {
    const p = r.primary.status;
    if (open.has(r.id) || ['UNKNOWN', 'DEAD_LETTER'].includes(p) || r.dedup.status === 'MATCH_REVIEW' || r.replica.status === 'FAILED') return ['Needs Attention', 'warn'];
    if (p === 'WRITTEN') return ['Transferred', 'good'];
    if (['AWAITING_RETRY', 'IN_FLIGHT'].includes(p)) return ['Processing', 'info run'];
    if (['DUPLICATE_IN_BATCH', 'REJECTED_REVIEW'].includes(r.dedup.status)) return ['Skipped', ''];
    return ['Not sent', ''];
  }
  function simpleRecords(recs, open) {
    if (!recs.length) return html`<div class="empty">No records.</div>`;
    const o = open || attentionIds();
    return html`<div class="tbl-wrap"><table class="t"><thead><tr><th>Record</th><th>Person</th><th>Status</th><th>Issue</th><th></th></tr></thead><tbody>
      ${recs.slice(0, 200).map((r) => { const [l, tone] = recordState(r, o); return html`<tr><td class="small">${r.sourceRecordId}</td><td>${person(r)}</td><td><span class="pill ${tone}">${l}</span></td><td class="small">${recordIssue(r)}</td><td class="num">${recordActions(r)}</td></tr>`; })}
      </tbody></table>${recs.length > 200 ? html`<div class="empty">First 200 of ${num(recs.length)}.</div>` : ''}</div>`;
  }
  // "Transfer completed. 48 records transferred. 2 need attention."
  function simpleResult(run, open) {
    const st = runState(run);
    const rc = E.reconcileSummary([run]);
    if (st === 'RUNNING' || st === 'QUEUED') return { tone: '', title: 'Processing', text: `${num(rc.received)} records received so far.` };
    const code = stopCode(run);
    if (code) { const m = T.friendlyError(code); return { tone: 'crit', title: 'Transfer failed', text: `${m.title}. ${m.next}` }; }
    const o = open || attentionIds();
    const by = {};
    run.records.forEach((r) => { const l = recordState(r, o)[0]; by[l] = (by[l] || 0) + 1; });
    const n = (x, one, many) => `${num(x)} ${x === 1 ? one : many}`;
    const parts = [`${n(rc.primaryWritten, 'record', 'records')} transferred.`];
    if (by['Needs Attention']) parts.push(`${num(by['Needs Attention'])} ${by['Needs Attention'] === 1 ? 'needs' : 'need'} attention.`);
    if (by.Processing) parts.push(`${num(by.Processing)} processing.`);
    if (by.Skipped) parts.push(`${n(by.Skipped, 'duplicate', 'duplicates')} skipped.`);
    // Written to Master Registry 1, copy to Master Registry 2 not yet confirmed.
    if (rc.replicaPending && !by['Needs Attention']) parts.push('Final check in progress.');
    const x = T.simpleStatus(st);
    const title = { Completed: 'Transfer completed', Processing: 'Transfer processing', Failed: 'Transfer failed' }[x.label] || 'Transfer needs attention';
    return { tone: x.tone === 'good' ? 'good' : x.tone === 'crit' ? 'crit' : x.tone === 'warn' ? 'warn' : '', title, text: parts.join(' ') };
  }
  const resultBox = (r) => html`<div class="callout result ${r.tone === 'good' ? 'ok' : r.tone}" role="status"><b>${r.title}</b><div>${r.text}</div></div>`;

  const REC_FILTERS = [
    ['all', 'All', () => true], ['invalid', 'Invalid', (r) => E.classify(r) === 'INVALID'], ['dup', 'Duplicate in file', (r) => r.dedup.status === 'DUPLICATE_IN_BATCH'],
    ['review', 'Possible duplicate', (r) => ['MATCH_REVIEW', 'APPROVED_NEW', 'REJECTED_REVIEW'].includes(r.dedup.status)], ['written', 'Written', (r) => r.primary.status === 'WRITTEN'],
    ['retry', 'Retry scheduled', (r) => r.primary.status === 'AWAITING_RETRY'], ['unknown', 'Outcome unknown', (r) => r.primary.status === 'UNKNOWN'], ['dead', 'Write failed', (r) => r.primary.status === 'DEAD_LETTER'],
    ['r2p', 'Replication pending', (r) => r.replica.status === 'PENDING'], ['r2f', 'Replication failed', (r) => r.replica.status === 'FAILED'],
  ];
  // The most useful short fact about a record.
  function recordIssue(r) {
    const iss = r.validation.issues.find((i) => i.severity === 'ERROR');
    if (iss) return issueText(iss);
    if (r.dedup.status === 'DUPLICATE_IN_BATCH') return 'Duplicate in file; first copy kept.';
    if (r.dedup.status === 'MATCH_REVIEW') return 'May already exist (other source).';
    if (r.dedup.status === 'REJECTED_REVIEW') return 'Rejected as duplicate.';
    const p = r.primary.status;
    if (p === 'AWAITING_RETRY') return `Retry ${r.primary.nextRetryAt <= S.now ? 'due now' : rel(r.primary.nextRetryAt)}.`;
    if (p === 'UNKNOWN') return 'Write not confirmed. Reconcile.';
    if (p === 'DEAD_LETTER') return r.fault && r.fault.kind === 'permanent' ? 'Rejected by registry. Correct at source.' : `Failed after ${r.primary.attempts.length} attempts. Retry is safe.`;
    if (r.replica.status === 'FAILED') return 'Not found in Master Registry 2.';
    if (r.replica.status === 'PENDING' && p === 'WRITTEN') return 'Replication pending.';
    if (r.primary.duplicatePrevented) return 'Resent; duplicate write prevented.';
    return '';
  }
  const recordActions = (r) => html`<div class="btns" style="justify-content:flex-end">${techAllowed() ? html`<button class="btn sm ghost" data-act="lineage" data-arg="${r.id}">Lineage</button>` : ''}
    ${STUCK.includes(r.primary.status) ? html`<button class="btn sm" data-act="retry-rec" data-arg="${r.id}" ${dis('run.retry')} ${raw(r.fault && r.fault.kind === 'permanent' && r.primary.status === 'DEAD_LETTER' ? 'disabled title="Rejected by the registry. Correct at source and resend."' : '')}>Retry</button>` : ''}
    ${r.dedup.status === 'MATCH_REVIEW' ? html`<button class="btn sm" data-act="review" data-arg="${r.id}" ${dis('error.resolve')}>Review</button>` : ''}</div>`;
  function recordsTable(recs, withSource) {
    if (!recs.length) return html`<div class="empty">No records.</div>`;
    return html`<div class="tbl-wrap"><table class="t"><thead><tr><th>Record</th>${withSource ? html`<th>Source</th>` : ''}<th>Person (masked)</th><th>Validation</th><th>Registry 1</th><th>Registry 2</th><th>Detail</th><th></th></tr></thead><tbody>
      ${recs.slice(0, 200).map((r) => html`<tr><td class="small">${r.sourceRecordId}<div class="muted">row ${r.id.slice(-4)}</div></td>${withSource ? html`<td class="small">${srcName(r.sourceId)}</td>` : ''}<td>${person(r)}</td>
        <td>${E.classify(r) === 'INVALID' ? pill('validation', 'INVALID') : ['DUPLICATE_IN_BATCH', 'MATCH_REVIEW', 'REJECTED_REVIEW'].includes(r.dedup.status) ? pill('dedup', r.dedup.status) : pill('validation', r.validation.status)}</td>
        <td>${pill('primary', r.primary.status)}</td><td>${pill('replica', r.replica.status)}</td><td class="small" style="max-width:280px">${recordIssue(r)}</td><td>${recordActions(r)}</td></tr>`)}
      </tbody></table>${recs.length > 200 ? html`<div class="empty">First 200 of ${num(recs.length)}.</div>` : ''}</div>`;
  }
  // Exceptions for one transfer, grouped by type, all states.
  function issueSummary(errors) {
    if (!errors.length) return html`<div class="empty"><b>No exceptions.</b></div>`;
    const by = {};
    errors.forEach((e) => { (by[e.code] = by[e.code] || []).push(e); });
    const state = (list) => { const c = {}; list.forEach((e) => { const l = T.recordStatus('resolution', e.resolution)[0]; c[l] = (c[l] || 0) + 1; }); return Object.entries(c).map(([l, n]) => `${n} ${l.toLowerCase()}`).join(' · '); };
    return html`<div class="tbl-wrap"><table class="t"><thead><tr><th>Exception</th><th class="num">Records</th><th>Status</th><th>Next step</th></tr></thead><tbody>
      ${Object.entries(by).map(([code, list]) => { const m = T.friendlyError(code); return html`<tr><td><b>${m.title}</b><div class="small muted">${m.explain}</div></td><td class="num">${num(new Set(list.map((e) => e.recordId || e.id)).size)}</td><td class="small">${state(list)}</td><td class="small">${m.next}</td></tr>`; })}
      </tbody></table></div>
      <div class="body">${techDetails(errorsTechTable(errors))}</div>`;
  }
  function errorsTechTable(list) {
    return html`<div class="tbl-wrap"><table class="t"><thead><tr><th>Reference</th><th>Code</th><th>Stage</th><th>Record</th><th>Detail</th><th>Retryable</th><th class="num">Retries</th><th>Resolution</th></tr></thead><tbody>
      ${list.slice().reverse().slice(0, 300).map((e) => html`<tr><td class="mono small">${e.id}<div class="muted">${fmtTime(e.at)}</div></td><td class="mono small">${e.code}</td><td class="small mono">${e.stage}</td><td class="mono small">${e.recordId || '—'}</td>
        <td class="small" style="max-width:320px">${e.detail}${e.field ? html`<div class="muted">field: ${e.field}</div>` : ''}<div class="muted mono">${e.traceId}</div></td><td>${e.retryable ? 'Yes' : 'No'}</td><td class="num">${e.retryCount}</td><td class="small mono">${e.resolution}${e.resolutionNote ? html`<div class="muted">${e.resolutionNote}</div>` : ''}</td></tr>`)}
      </tbody></table></div>`;
  }

  function pageRun() {
    const run = E.getRun(UI.runId);
    if (!run) return html`<div class="empty">Transfer not found.</div>`;
    const rc = E.reconcileSummary([run]);
    const open = attentionIds();
    const attn = run.records.filter((r) => recordState(r, open)[0] === 'Needs Attention');
    const canRetry = rc.awaitingRetry + rc.primaryFailed + rc.unknown;
    const canCheck = rc.unknown + rc.replicaFailed;
    const actions = html`${canCheck ? html`<button class="btn primary" data-act="reconcile" data-arg="${run.id}" ${dis('run.reconcile')}>Reconcile</button>` : ''}${canRetry ? html`<button class="btn ${canCheck ? '' : 'primary'}" data-act="retry-run" data-arg="${run.id}" ${dis('run.retry')}>Retry</button>` : ''}`;
    return html`${head(run.sourceName, null, actions, html`<button data-act="nav" data-arg="runs">Transfers</button>`)}
      ${resultBox(simpleResult(run, open))}
      <p class="small muted" style="margin:0">${fmtTime(run.createdAt, false)} · ${T.modeLabel(run.mode)}${run.file ? ` · ${run.file.safeName || run.file.name}` : ''} · ${num(run.records.length)} records</p>
      ${attn.length ? html`<section class="panel"><header><h2>Needs Attention (${num(attn.length)})</h2></header>${simpleRecords(attn, open)}</section>` : ''}
      ${run.records.length ? moreDetails(`All Records (${run.records.length})`, html`${simpleRecords(run.records, open)}<div class="btns" style="margin-top:12px"><button class="btn sm" data-act="report" data-arg="${run.id}" ${dis('report.download')}>Download Report</button></div>`) : ''}
      ${techDetails(advancedRun(run, rc), 'Advanced Details')}`;
  }
  // Everything the previous transfer page showed, for administrators, analysts and auditors.
  function advancedRun(run, rc) {
    const errs = S.errors.filter((e) => e.runId === run.id);
    const tabs = [['records', `Records (${run.records.length})`], ['errors', `Exceptions (${new Set(errs.map((e) => e.code)).size})`], ['recon', 'Reconciliation'], ['attempts', 'Write attempts'], ['events', 'Events'], ['mapping', 'Mapping'], ['audit', 'Audit log']];
    let body;
    if (UI.runTab === 'records') {
      const flt = REC_FILTERS.find((x) => x[0] === UI.recFilter) || REC_FILTERS[0];
      body = html`<div class="body"><div class="seg wrap" role="group" aria-label="Filter records">${REC_FILTERS.map(([k, l, fn]) => { const n = run.records.filter(fn).length; return k !== 'all' && !n ? '' : html`<button data-act="recfilter" data-arg="${k}" aria-pressed="${UI.recFilter === k}">${l} (${n})</button>`; })}</div></div>${recordsTable(run.records.filter(flt[2]))}`;
    } else if (UI.runTab === 'errors') body = issueSummary(errs);
    else if (UI.runTab === 'attempts') {
      const att = run.records.flatMap((r) => r.primary.attempts.map((a) => ({ r, a }))).sort((x, y) => x.a.at - y.a.at);
      const shown = att.filter((x) => x.a.n > 1 || x.a.outcome !== 'ACCEPTED' || x.a.by !== 'pipeline');
      const result = (o) => ({ ACCEPTED: 'Written', RECONCILED_FOUND: 'Found on reconcile', TIMEOUT: 'Timeout', REJECTED: 'Rejected' }[o] || 'Temporary failure');
      body = html`<div class="body"><p class="small muted" style="margin:0">Automatic retry: up to ${S.destinations[0].retry.maxAttempts} attempts. Resends never create duplicates.</p></div>
        <div class="tbl-wrap"><table class="t"><thead><tr><th>Time</th><th>Record</th><th class="num">Attempt</th><th>Result</th><th>By</th></tr></thead><tbody>
        ${shown.map(({ r, a }) => html`<tr><td class="small">${fmtTime(a.at)}</td><td class="small">${r.sourceRecordId}</td><td class="num">${a.n}</td><td class="small">${result(a.outcome)}</td><td class="small">${a.by === 'pipeline' ? 'Automatic' : a.by}</td></tr>`)}
        </tbody></table><div class="empty small">${num(att.length - shown.length)} first-attempt writes hidden.</div></div>
        <div class="body">${techDetails(html`<div class="small muted" style="margin-bottom:8px">Retry policy: ${S.destinations[0].retry.maxAttempts} attempts, exponential backoff from ${S.destinations[0].retry.baseMs / 1000} s (×${S.destinations[0].retry.factor}, cap ${S.destinations[0].retry.capMs / 1000} s), ${S.destinations[0].retry.jitter} jitter. Every attempt carries the same idempotency key.</div>
          <div class="tbl-wrap"><table class="t"><thead><tr><th>At</th><th>Record</th><th class="num">#</th><th>Outcome</th><th class="num">HTTP</th><th class="num">Latency</th><th>Idempotency key</th><th>Note</th></tr></thead><tbody>
          ${shown.map(({ r, a }) => html`<tr><td class="small">${fmtTime(a.at)}</td><td class="mono small">${r.id.slice(-4)}</td><td class="num">${a.n}</td><td class="mono small">${a.outcome}</td><td class="num">${a.http || '—'}</td><td class="num">${a.latencyMs} ms</td><td class="mono small">${a.idemKey.slice(0, 12)}…</td><td class="small">${a.note}</td></tr>`)}</tbody></table></div>`, 'Technical details')}</div>`;
    } else if (UI.runTab === 'recon') body = html`<div class="body">${totalsView(rc)}</div>`;
    else if (UI.runTab === 'events') body = html`<div class="tbl-wrap"><table class="t"><tbody>${run.events.map((e) => html`<tr><td class="small" style="width:150px">${fmtTime(e.at)}</td><td style="width:1%"><span class="pill ${e.level === 'error' ? 'crit' : e.level === 'warn' ? 'warn' : ''}">${e.level === 'error' ? 'Error' : e.level === 'warn' ? 'Warning' : 'Info'}</span></td><td>${T.scrub(e.msg)}</td></tr>`)}</tbody></table></div>`;
    else if (UI.runTab === 'mapping') body = html`<div class="body"><p class="small muted" style="margin:0">Mapping version ${run.mappingVersion}.</p></div><div class="tbl-wrap"><table class="t"><thead><tr><th>Source field(s)</th><th>Transform</th><th>Registry field</th></tr></thead><tbody>${run.mappingRows.map((r) => html`<tr><td class="small">${r.sources.join(' + ') || 'Constant'}</td><td>${DB.TRANSFORMS[r.op].label}${r.arg ? html` <span class="tag">${r.arg}</span>` : ''}</td><td>${fieldLabel(r.target)}</td></tr>`)}</tbody></table></div>`;
    else body = auditTable(S.audit.filter((a) => a.target.includes(run.id)));

    const s = E.getSource(run.sourceId);
    const pend = rc.awaitingRetry + rc.unknown + rc.inFlight + rc.replicaPending;
    const exc = rc.rejectedBeforeDelivery + rc.heldForReview + rc.primaryFailed + rc.replicaFailed;
    const tiles = [['Received', rc.received, ''], ['Written', rc.primaryWritten, 'good'], ['Replicated', rc.replicaConfirmed, ''], ['Pending', pend, pend ? 'warn' : ''], ['Exceptions', exc, exc ? 'serious' : '']];
    return html`<div class="stack">
      <p style="margin:0">Status: ${pill('run', runState(run))}</p>
      ${journeyView(run)}
      <div class="kpis">${tiles.map(([k, v, tone]) => kpi(k, num(v), '', tone))}</div>
      <div class="grid"><div class="c6"><dl class="kv">
          <dt>Source</dt><dd><button class="btn ghost" style="padding:0" data-act="source" data-arg="${s.id}">${s.name}</button></dd><dt>Method</dt><dd>${T.modeLabel(run.mode)}${run.mode === 'API' ? html` <span class="mock-tag">mock</span>` : ''}</dd>
          ${run.file ? html`<dt>File</dt><dd>${run.file.safeName || run.file.name} · ${(run.file.size / 1024).toFixed(1)} KB</dd>` : ''}
          <dt>Started by</dt><dd>${run.triggeredBy}</dd><dt>Approval</dt><dd>${run.approvedBy ? `${run.approvedBy}, after validation` : run.scenarioId ? 'Demo scenario' : '—'}</dd>
          <dt>Start / end</dt><dd>${fmtTime(run.startedAt)} → ${fmtTime(run.endedAt)}</dd><dt>Reference</dt><dd class="small">${run.id}</dd></dl></div>
        <div class="c6"><table class="t"><tbody>${run.stages.map((stg) => html`<tr><td class="small">${T.STAGE_LABELS[stg.key] || label(stg.key)}</td><td>${pill('stage', stg.status)}</td><td class="small muted">${stg.startedAt ? fmtTime(stg.startedAt) : ''}</td></tr>`)}</tbody></table></div></div>
        ${techDetails(html`<dl class="kv small"><dt>Run ID</dt><dd class="mono">${run.id}</dd><dt>Trace ID</dt><dd class="mono">${run.traceId}</dd><dt>Mapping</dt><dd>v${run.mappingVersion} (${run.transformVersion})</dd>
          ${run.mode === 'API' ? html`<dt>Endpoint</dt><dd class="mono">${s.method} ${s.baseUrl}${s.endpoint}</dd><dt>API calls</dt><dd>${run.apiStats.requests} requests · ${run.apiStats.pages} pages · ${run.apiStats.throttled} throttled · ${run.apiStats.timeouts} timeouts</dd>` : ''}
          ${run.file ? html`<dt>Checksum</dt><dd class="mono">sha256 ${run.file.checksum ? run.file.checksum.slice(0, 24) + '…' : '—'}</dd>` : ''}
          <dt>Batches</dt><dd>${run.batches.length ? run.batches.map((b) => `${b.id} (${b.size})`).join(', ') : '—'}</dd>${run.fatal ? html`<dt>Stopped with</dt><dd class="mono">${run.fatal.stage}: ${run.fatal.message}</dd>` : ''}</dl>
          <table class="t"><thead><tr><th>Stage</th><th>Status</th><th>In → out</th><th>Note</th></tr></thead><tbody>${run.stages.map((stg) => html`<tr><td class="mono small">${stg.key}</td><td class="mono small">${stg.status}</td><td class="small">${stg.inCount !== null ? stg.inCount : ''}${stg.outCount !== null ? ` → ${stg.outCount}` : ''}${stg.failCount ? ` · ✕ ${stg.failCount}` : ''}</td><td class="small">${stg.note}</td></tr>`)}</tbody></table>`)}
      <section class="panel"><div class="tabs" role="tablist">${tabs.map(([k, l]) => html`<button role="tab" aria-selected="${UI.runTab === k}" data-act="tab" data-arg="${k}">${l}</button>`)}</div>${body}</section></div>`;
  }

  // ---------------------------------------------------------------------------
  // Exceptions
  // ---------------------------------------------------------------------------
  function groupActions(g) {
    const s = E.getSource(g.sourceId);
    const main = { Retry: ['grp-retry', 'run.retry'], Reconcile: ['grp-check', 'run.reconcile'], 'Correct mapping': ['map-open', 'mapping.edit'], 'Upload file': ['ingest-from', 'run.start'], 'View source': ['source', null] }[g.msg.action];
    const retryable = [...g.recordIds].some((id) => { const r = E.findRecord(id); return r && STUCK.includes(r.primary.status) && !(r.fault && r.fault.kind === 'permanent' && r.primary.status === 'DEAD_LETTER'); });
    const checkable = [...g.runIds].some((id) => { const x = E.reconcileSummary([E.getRun(id)]); return x.unknown || x.replicaFailed || x.destinationMismatch; });
    let primary = '';
    if (main && main[0] === 'grp-retry') primary = retryable ? html`<button class="btn sm primary" data-act="grp-retry" data-arg="${g.key}" ${dis('run.retry')}>Retry</button>` : '';
    else if (main && main[0] === 'grp-check') primary = checkable ? html`<button class="btn sm primary" data-act="grp-check" data-arg="${g.key}" ${dis('run.reconcile')}>Reconcile</button>` : '';
    else if (main && s && (main[0] !== 'source' || techAllowed())) primary = html`<button class="btn sm primary" data-act="${main[0]}" data-arg="${s.id}" ${main[1] ? dis(main[1]) : ''}>${g.msg.action}</button>`;
    return html`<div class="btns" style="justify-content:flex-end">${primary}
      <button class="btn sm" data-act="grp-toggle" data-arg="${g.key}" aria-expanded="${UI.errOpen === g.key}">${UI.errOpen === g.key ? 'Hide' : 'View'}</button></div>`;
  }
  function groupRows(groups) {
    if (!groups.length) return html`<div class="empty">None.</div>`;
    return html`<div class="tbl-wrap"><table class="t"><thead><tr><th>Issue</th><th>Source</th><th class="num">Records</th><th></th></tr></thead><tbody>
      ${groups.map((g) => html`<tr class="${UI.errOpen === g.key ? 'sel' : ''}"><td><b>${g.msg.title}</b><div class="small muted">${g.msg.next}</div></td><td>${srcName(g.sourceId)}</td>
        <td class="num">${g.recordIds.size ? num(g.recordIds.size) : '—'}</td><td>${groupActions(g)}</td></tr>
        ${UI.errOpen === g.key ? html`<tr class="expand"><td colspan="4"><div class="stack">
          ${g.msg.impact ? html`<p class="small" style="margin:0">${g.msg.impact}</p>` : ''}
          ${g.recordIds.size ? simpleRecords([...g.recordIds].map((id) => E.findRecord(id)).filter(Boolean)) : html`<div class="btns">${[...g.runIds].map((id) => html`<button class="btn sm" data-act="run" data-arg="${id}">Transfer ${fmtTime(E.getRun(id).createdAt, false)}</button>`)}</div>`}
          <div class="btns">${g.runIds.size ? html`<button class="btn sm" data-act="grp-report" data-arg="${g.key}" ${dis('report.download')}>Download Report</button>` : ''}${canMarkReviewed(g) ? html`<button class="btn sm ghost" data-act="grp-ack" data-arg="${g.key}" ${dis('error.resolve')} title="Records the review. Does not correct the records.">Mark Reviewed</button>` : ''}</div>
          ${techDetails(errorsTechTable(g.errors))}</div></td></tr>` : ''}`)}
      </tbody></table></div>`;
  }

  function pageErrors() {
    const q = UI.errQ;
    const all = attentionGroups({ sourceId: q.sourceId, code: q.code });
    const action = all.filter((g) => g.needsUser), info = all.filter((g) => !g.needsUser);
    const recs = S.runs.flatMap((r) => r.records);
    const dead = recs.filter((r) => r.primary.status === 'DEAD_LETTER' && (!q.sourceId || r.sourceId === q.sourceId));
    const done = S.errors.filter((e) => ['RESOLVED', 'ACKNOWLEDGED'].includes(e.resolution) && (!q.sourceId || e.sourceId === q.sourceId) && (!q.code || e.code === q.code));
    const retryable = recs.filter((r) => ['AWAITING_RETRY', 'UNKNOWN'].includes(r.primary.status) || (r.primary.status === 'DEAD_LETTER' && !(r.fault && r.fault.kind === 'permanent')));
    const presentCodes = [...new Set(S.errors.map((e) => e.code))];
    const tabs = [['action', `Open (${action.length})`], ['info', `Automatic (${info.length})`], ['dead', `Write failures (${dead.length})`], ['done', `Resolved (${done.length})`], ['types', 'Exception types']];
    let body;
    if (q.tab === 'action') body = groupRows(action);
    else if (q.tab === 'info') body = groupRows(info);
    else if (q.tab === 'dead') body = html`${dead.length ? html`<div class="tbl-wrap"><table class="t"><thead><tr><th>Record</th><th>Source</th><th>Person (masked)</th><th class="num">Attempts</th><th>Reason</th><th>Retryable</th><th></th></tr></thead><tbody>
      ${dead.map((r) => { const perm = r.fault && r.fault.kind === 'permanent'; return html`<tr><td class="small">${r.sourceRecordId}</td><td class="small">${srcName(r.sourceId)}</td><td>${person(r)}</td><td class="num">${r.primary.attempts.length}</td><td class="small">${perm ? 'Rejected by registry' : 'Retries exhausted'}</td><td>${perm ? html`<span class="pill crit">No</span>` : html`<span class="pill good">Yes</span>`}</td><td>${recordActions(r)}</td></tr>`; })}
      </tbody></table></div>
      <div class="body">${techDetails(html`<table class="t"><thead><tr><th>Record</th><th>Run</th><th>Last response</th></tr></thead><tbody>${dead.map((r) => { const a = r.primary.attempts[r.primary.attempts.length - 1]; return html`<tr><td class="mono small">${r.id}</td><td class="mono small">${r.runId}</td><td class="small">${a.http} · ${a.note}</td></tr>`; })}</tbody></table>`)}</div>` : html`<div class="empty">No write failures.</div>`}`;
    else if (q.tab === 'done') body = done.length ? html`<div class="tbl-wrap"><table class="t"><thead><tr><th>Time</th><th>Source</th><th>Exception</th><th>Outcome</th><th>Note</th></tr></thead><tbody>${done.slice().reverse().slice(0, 200).map((e) => html`<tr><td class="small">${fmtTime(e.resolvedAt || e.at)}</td><td class="small">${srcName(e.sourceId)}</td><td>${T.friendlyError(e.code).title}</td><td>${pill('resolution', e.resolution)}</td><td class="small">${T.scrub(e.resolutionNote)}</td></tr>`)}</tbody></table></div><div class="body">${techDetails(errorsTechTable(done))}</div>` : html`<div class="empty">None resolved yet.</div>`;
    else body = html`<div class="tbl-wrap"><table class="t"><thead><tr><th>Exception</th><th>Meaning</th><th>Next step</th><th>Automatic</th><th class="num">Count</th></tr></thead><tbody>${Object.keys(DB.ERROR_TAXONOMY).map((k) => { const m = T.friendlyError(k); return html`<tr><td><b>${m.title}</b></td><td class="small">${m.explain}</td><td class="small">${m.next}</td><td>${m.auto ? 'Yes' : 'No'}</td><td class="num">${S.errors.filter((e) => e.code === k).length}</td></tr>`; })}</tbody></table></div>
      <div class="body">${techDetails(html`<table class="t"><thead><tr><th>Code</th><th>Label</th><th>Stage</th><th>Severity</th><th>Retryable</th><th>Engine description</th></tr></thead><tbody>${Object.entries(DB.ERROR_TAXONOMY).map(([k, t]) => html`<tr><td class="mono small">${k}</td><td class="small">${T.friendlyError(k).title}</td><td class="mono small">${t.stage}</td><td class="small">${t.severity}</td><td>${t.retryable ? 'Yes' : 'No'}</td><td class="small">${t.desc}</td></tr>`)}</tbody></table>`, 'Technical details: codes')}</div>`;
    return html`${head('Exception Log', null, html`<button class="btn" data-act="retry-all" ${dis('run.retry')} ${raw(retryable.length ? '' : 'disabled title="Nothing to retry."')}>Retry all (${retryable.length})</button>`)}
      <div class="filters"><label class="field">Source<select data-change="bind" data-key="errQ.sourceId"><option value="">All</option>${S.sources.map((s) => html`<option value="${s.id}" ${raw(q.sourceId === s.id ? 'selected' : '')}>${s.name}</option>`)}</select></label>
        <label class="field">Exception<select data-change="bind" data-key="errQ.code"><option value="">All</option>${presentCodes.map((c) => html`<option value="${c}" ${raw(q.code === c ? 'selected' : '')}>${T.friendlyError(c).title}</option>`)}</select></label></div>
      <section class="panel"><div class="tabs" role="tablist">${tabs.map(([k, l]) => html`<button role="tab" aria-selected="${q.tab === k}" data-act="errtab" data-arg="${k}">${l}</button>`)}</div>${body}</section>`;
  }

  // ---------------------------------------------------------------------------
  // Reconciliation
  // ---------------------------------------------------------------------------
  // Six non-overlapping totals: received = not sent + review + pending + written.
  const TOTALS = [
    ['received', 'Received', ['received'], 'From source or file'],
    ['notSent', 'Not sent', ['rejectedBeforeDelivery', 'notProcessed'], 'Invalid, duplicate or stopped'],
    ['review', 'Exceptions', ['heldForReview', 'primaryFailed'], 'Possible duplicates, write failures'],
    ['processing', 'Pending', ['awaitingRetry', 'unknown', 'inFlight'], 'Retry or unconfirmed'],
    ['added', 'Written', ['primaryWritten'], 'Master Registry 1'],
    ['copied', 'Replicated', ['replicaConfirmed'], 'Master Registry 2'],
  ];
  const BUCKETS = [
    ['received', 'Received'], ['rejectedBeforeDelivery', 'Rejected (validation or duplicate)'], ['notProcessed', 'Not processed'], ['heldForReview', 'Possible duplicate'],
    ['accepted', 'Accepted for write'], ['primaryWritten', 'Written'], ['primaryFailed', 'Write failed'], ['awaitingRetry', 'Retry scheduled'], ['unknown', 'Outcome unknown'],
    ['inFlight', 'Awaiting commit'], ['replicaConfirmed', 'Replicated'], ['replicaPending', 'Replication pending'], ['replicaFailed', 'Replication failed'],
  ];
  const bucketIds = (rc, key) => { const t = TOTALS.find((x) => x[0] === key); return (t ? t[2] : [key]).flatMap((k) => rc.ids[k] || []); };
  const bucketCount = (rc, key) => { const t = TOTALS.find((x) => x[0] === key); return (t ? t[2] : [key]).reduce((s, k) => s + (rc[k] || 0), 0); };
  function totalsView(rc) {
    const open = UI.reconOpen;
    const v = (k) => bucketCount(rc, k);
    const notes = [];
    if (rc.unknown) notes.push(`${num(rc.unknown)} write outcome(s) unknown. Reconcile checks Master Registry 1, then resends safely.`);
    if (rc.awaitingRetry || rc.inFlight) notes.push(`${num(rc.awaitingRetry + rc.inFlight)} retry scheduled or awaiting commit.`);
    if (rc.replicaPending) notes.push(`${num(rc.replicaPending)} written but replication pending.`);
    if (rc.replicaFailed) notes.push(`${num(rc.replicaFailed)} not replicated. Reconcile requests re-sync.`);
    if (rc.heldForReview) notes.push(`${num(rc.heldForReview)} possible duplicate(s) awaiting review.`);
    if (rc.primaryFailed) notes.push(`${num(rc.primaryFailed)} write failure(s).`);
    return html`<div class="stack">
      <div class="kpis totals">${TOTALS.map(([k, l, , d]) => html`<button class="kpi" data-tone="${k === 'added' || k === 'copied' ? 'good' : (k === 'review' || k === 'processing') && v(k) ? 'warn' : ''}" data-act="recon-open" data-arg="${k}" aria-pressed="${open === k}" ${raw(v(k) ? '' : 'disabled')}><span class="k">${l}</span><span class="v">${num(v(k))}</span><span class="d">${d}</span></button>`)}</div>
      <p class="small" style="margin:0"><b>Balance:</b> ${num(v('received'))} received = ${num(v('notSent'))} not sent + ${num(v('review'))} exceptions + ${num(v('processing'))} pending + ${num(v('added'))} written. Of ${num(v('added'))} written: ${num(rc.replicaConfirmed)} replicated, ${num(rc.replicaPending)} pending, ${num(rc.replicaFailed)} failed.</p>
      ${notes.length ? html`<div class="callout warn"><b>Open items</b><ul style="margin:6px 0 0;padding-left:18px">${notes.map((x) => html`<li>${x}</li>`)}</ul></div>` : html`<div class="callout ok">Balanced. All records accounted for.</div>`}
      ${open ? html`<div class="panel"><header><h3>${(TOTALS.find((t) => t[0] === open) || BUCKETS.find((b) => b[0] === open) || [, open])[1]}: ${num(bucketIds(rc, open).length)}</h3><button class="btn sm" data-act="recon-open" data-arg="">Close</button></header>${recordsTable(bucketIds(rc, open).map((id) => E.findRecord(id)), true)}</div>` : ''}
      ${moreDetails('Detailed breakdown', html`<table class="t"><thead><tr><th>Bucket</th><th class="num">Records</th><th></th></tr></thead><tbody>
        ${BUCKETS.map(([k, l]) => html`<tr class="${open === k ? 'sel' : ''}"><td>${l}</td><td class="num">${num(rc[k])}</td><td><button class="btn sm" data-act="recon-open" data-arg="${k}" ${raw(rc[k] ? '' : 'disabled title="Empty."')}>View records</button></td></tr>`)}</tbody></table>
        ${techDetails(html`<div class="stack small">${rc.checks.map((c) => html`<div class="spread"><span>${c.name}</span><span class="mono">${num(c.lhs)} ${c.ok ? '=' : '≠'} ${num(c.rhs)} ${c.ok ? 'ok' : 'mismatch'}</span></div>`)}</div>
          <dl class="kv small" style="margin-top:10px"><dt>SR1 acknowledged (middleware ledger)</dt><dd>${num(rc.primaryWritten)}</dd><dt>Held by SR1 (query by idempotency key, mock)</dt><dd>${num(rc.destinationCount)}</dd><dt>Confirmed on SR2</dt><dd>${num(rc.replicaConfirmed)}</dd><dt>Duplicate writes prevented</dt><dd>${num(rc.duplicatesPrevented)}</dd></dl>`, 'Technical details: identity checks')}`)}
    </div>`;
  }
  function pageRecon() {
    const runs = UI.reconScope ? [E.getRun(UI.reconScope)] : E.filterRuns({ range: UI.filters.range });
    const rc = E.reconcileSummary(runs);
    const need = S.runs.filter((r) => { const x = E.reconcileSummary([r]); return x.unknown || x.replicaFailed || x.destinationMismatch; });
    const why = (x) => [x.unknown ? `${x.unknown} outcome unknown` : '', x.replicaFailed ? `${x.replicaFailed} not replicated` : '', x.destinationMismatch && !x.unknown ? 'count mismatch' : ''].filter(Boolean).join(' · ');
    return html`${head('Reconciliation')}
      <div class="filters"><label class="field">Scope<select data-change="bind" data-key="reconScope"><option value="">All transfers (${({ today: 'today', '24h': '24 h', '7d': '7 days', all: 'all time' })[UI.filters.range]})</option>${S.runs.slice().reverse().map((r) => html`<option value="${r.id}" ${raw(UI.reconScope === r.id ? 'selected' : '')}>${fmtTime(r.createdAt, false)} · ${r.sourceName} · ${T.runStatus(E.runStatus(r)).label}</option>`)}</select></label></div>
      ${need.length ? html`<section class="panel"><header><h3>Reconciliation required</h3></header><div class="body flush"><table class="t"><tbody>${need.map((r) => html`<tr><td>${r.sourceName}<div class="small muted">${fmtTime(r.createdAt, false)}</div></td><td class="small">${why(E.reconcileSummary([r]))}</td><td class="num"><div class="btns" style="justify-content:flex-end"><button class="btn sm" data-act="recon-scope" data-arg="${r.id}">View</button><button class="btn sm primary" data-act="reconcile" data-arg="${r.id}" ${dis('run.reconcile')}>Reconcile</button></div></td></tr>`)}</tbody></table></div></section>` : ''}
      <section class="panel"><header><h3>${UI.reconScope ? `${E.getRun(UI.reconScope).sourceName} · ${fmtTime(E.getRun(UI.reconScope).createdAt, false)}` : `${runs.length} transfer(s)`}</h3>${UI.reconScope ? html`<button class="btn sm" data-act="recon-scope" data-arg="">All transfers</button>` : ''}</header><div class="body">${totalsView(rc)}</div></section>`;
  }

  // ---------------------------------------------------------------------------
  // Sources
  // ---------------------------------------------------------------------------
  const LAYOUTS = { NASSCO_FORM_45: 'NASSCO NSR form 4.5', JOSH_V2: 'State registry v2 (assumed)', CCT_TEMPLATE_V1: 'CCT template v1' };
  // Engine connection-check step names, shortened.
  const CHECK_STEPS = { 'Source enabled': 'Source enabled', 'Template registered': 'Template registered', 'Quarantine bucket writable (simulated)': 'Quarantine ready', 'Egress / SSRF policy': 'Address allowed', 'DNS + TLS 1.3 handshake (simulated)': 'Secure connection (TLS)', 'Fetch credential from vault (simulated)': 'Credentials (vault)', 'Authenticate with source': 'Authentication', 'Probe schema (1 record)': 'Schema check' };
  const checkList = (steps) => html`<ul class="checks">${steps.map(([n, ok, d]) => html`<li><span class="${ok ? 'ok-i' : 'no-i'}">${ok ? '✓' : '✕'}</span><span><b>${CHECK_STEPS[n] || n}</b>${ok ? '' : html` <span class="muted">${T.scrub(d)}</span>`}</span></li>`)}</ul>`;
  function pageSources() {
    const list = S.sources.filter((s) => !s.removed);
    const removed = S.sources.filter((s) => s.removed);
    const sel = UI.sourceId && E.getSource(UI.sourceId);
    return html`${head('Sources', 'Credentials are stored as vault references; secrets are never shown.', html`<button class="btn primary" data-act="source-new" ${dis('source.edit')}>Add source</button>`)}
      <section class="panel"><div class="tbl-wrap"><table class="t"><thead><tr><th>Source</th><th>Method</th><th>Health</th><th>Enabled</th><th>Last success</th><th>Last failure</th><th></th></tr></thead><tbody>
        ${list.map((s) => html`<tr class="${UI.sourceId === s.id ? 'sel' : ''}"><td><button class="btn ghost" style="padding:0;font-weight:600" data-act="source" data-arg="${s.id}">${s.name}</button><div class="small muted">${s.type} · ${s.env}</div></td><td>${modes(s)}</td><td>${pill('health', s.enabled ? s.health : 'DISABLED')}</td>
          <td><button class="btn sm" data-act="toggle-source" data-arg="${s.id}" ${dis('source.toggle')} aria-pressed="${s.enabled}">${s.enabled ? 'Disable' : 'Enable'}</button></td>
          <td class="small">${rel(s.lastSuccessAt)}</td><td class="small">${rel(s.lastFailureAt)}</td>
          <td><div class="btns"><button class="btn sm" data-act="source-test" data-arg="${s.id}" ${dis('source.test')}>Check connection</button><button class="btn sm" data-act="source-edit" data-arg="${s.id}" ${dis('source.edit')}>Edit</button><button class="btn sm" data-act="ingest-from" data-arg="${s.id}" ${dis('run.start')}>New transfer</button><button class="btn sm danger" data-act="source-remove" data-arg="${s.id}" ${dis('source.edit')}>Remove</button></div></td></tr>`)}
      </tbody></table></div>${removed.length ? html`<div class="body small muted">Removed (history kept): ${removed.map((s) => s.name).join(', ')}</div>` : ''}</section>
      ${sel ? sourceDetail(sel) : html`<div class="callout">Select a source to view details.</div>`}`;
  }
  function sourceDetail(s) {
    const runs = S.runs.filter((r) => r.sourceId === s.id).slice().reverse();
    const mp = S.mappings[s.id];
    const v = E.validateMapping(s.id);
    const t = UI.testResult && UI.testResult.sourceId === s.id ? UI.testResult : null;
    const basic = [['Organisation', s.org], ['Description', s.description], ['Environment', s.env], ['Method', modes(s)], ['Schedule', s.frequency], ['Created', `${fmtTime(s.createdAt)} · ${s.createdBy}`], ['Updated', `${fmtTime(s.updatedAt)} · ${s.updatedBy}`]];
    const tech = [['Source ID', s.id], ['Base URL', s.baseUrl || '—'], ['Endpoint', s.endpoint ? `${s.method} ${s.endpoint}` : '—'], ['Credential', s.authRef], ['Pagination', s.pagination], ['Incremental', s.incremental], ['Watermark', s.watermark ? fmtTime(s.watermark) : '—'], ['Import format', s.importFormat], ['Layout', LAYOUTS[s.layout] || s.layout], ['Schema version', s.schemaVersion]];
    return html`<div class="grid">
      <section class="panel c5"><header><h3>${s.name}</h3>${s.connection === 'API' ? html`<span class="mock-tag">mock</span>` : ''}</header><div class="body"><dl class="kv">${basic.map(([k, val]) => html`<dt>${k}</dt><dd>${val}</dd>`)}</dl>
        ${moreDetails('Configuration', html`<dl class="kv small">${tech.map(([k, val]) => html`<dt>${k}</dt><dd class="${/URL|Credential|ID/.test(k) ? 'mono' : ''}">${val}</dd>`)}</dl>`)}</div></section>
      <div class="c7 stack">
        <section class="panel"><header><h3>Connection</h3><button class="btn sm" data-act="source-test" data-arg="${s.id}" ${dis('source.test')}>Check connection</button></header><div class="body">
          ${t ? html`<p style="margin:0 0 8px">${t.ok ? html`<span class="pill good">Connected</span>` : html`<span class="pill crit">Failed</span>`} <span class="small muted">${fmtTime(t.at)} · simulated</span></p>${moreDetails('Checks', checkList(t.steps), !t.ok)}` : html`<p class="small muted" style="margin:0">Not checked in this session.</p>`}</div></section>
        <section class="panel"><header><h3>Field mapping</h3><button class="btn sm" data-act="map-open" data-arg="${s.id}">Open</button></header><div class="body small">Version ${mp.version} · required ${v.requiredMapped}/${v.requiredTotal} ${v.ok ? html`<span class="pill good">Valid</span>` : html`<span class="pill crit">Mapping error</span>`}</div></section>
        <section class="panel"><header><h3>Transfers</h3><span class="sub">${runs.length}</span></header><div class="body flush">${runs.length ? html`<table class="t"><tbody>${runs.slice(0, 8).map((r) => html`<tr><td class="small">${fmtTime(r.createdAt, false)}</td><td>${T.modeLabel(r.mode)}</td><td class="num small">${num(E.reconcileSummary([r]).primaryWritten)}/${num(r.records.length)} written</td><td>${pill('run', E.runStatus(r))}</td><td><button class="btn sm" data-act="run" data-arg="${r.id}">View</button></td></tr>`)}</tbody></table>` : html`<div class="empty">No transfers.</div>`}</div></section>
      </div></div>`;
  }
  function sourceForm() {
    const f = UI.sourceForm;
    const inp = (k, l, ph, wide) => html`<label class="field ${wide ? 'wide' : ''}">${l}<input type="text" id="sf-${k}" data-bind="sourceForm.${k}" value="${f[k] || ''}" placeholder="${ph || ''}" ${raw(k === 'id' && !f._new ? 'readonly' : '')}></label>`;
    const sel = (k, l, opts) => html`<label class="field">${l}<select id="sf-${k}" data-bind="sourceForm.${k}" data-rerender>${opts.map(([v, t]) => html`<option value="${v}" ${raw(String(f[k]) === String(v) ? 'selected' : '')}>${t}</option>`)}</select></label>`;
    return html`<div class="form">
      ${inp('name', 'Name', 'e.g. Kaduna State Registry')}
      ${sel('type', 'Type', [['National Registry', 'National registry'], ['State Registry', 'State registry'], ['File Upload', 'File upload'], ['Other', 'Other']])}
      ${inp('org', 'Organisation')}${inp('description', 'Description', '', true)}
      ${sel('env', 'Environment', [['Development', 'Development'], ['Testing', 'Testing'], ['Production', 'Production']])}
      ${sel('connection', 'Method', [['API', 'API'], ['IMPORT', 'File upload']])}
      ${inp('frequency', 'Schedule', 'Manual / Daily 02:00')}
      <label class="field"><span>Enabled</span><select data-bind="sourceForm.enabled" data-type="bool"><option value="true" ${raw(f.enabled ? 'selected' : '')}>Yes</option><option value="false" ${raw(!f.enabled ? 'selected' : '')}>No</option></select></label>
      ${f.connection === 'API' ? html`${inp('baseUrl', 'Base URL (https)', 'https://example.mock.invalid', true)}${inp('authRef', 'Credential (vault reference)', 'vault://databridge/sources/…', true)}` : ''}
      <details class="wide more" ${raw(f._new ? 'open' : '')}><summary>Advanced</summary><div class="form more-body">
        ${inp('id', 'Source ID', 'SRC-STATE-EXAMPLE')}
        ${sel('layout', 'Source layout', Object.entries(LAYOUTS))}
        ${f.connection === 'API' ? html`${inp('endpoint', 'Endpoint', '/v1/records')}${sel('method', 'HTTP method', [['GET', 'GET'], ['POST', 'POST']])}${inp('pagination', 'Pagination', 'cursor, page size 100')}${inp('incremental', 'Incremental fetch', 'updated_since watermark')}` : html`${inp('importFormat', 'Import format', 'CCT template v1 (.csv / .xlsx)')}`}
        ${inp('schemaVersion', 'Schema version')}</div></details>
      <div class="wide small muted">https only; allow-listed hosts (.gov.ng, .mock.invalid). Credentials: vault references only.</div>
      ${f._error ? html`<div class="wide callout crit">${T.scrub(f._error)}</div>` : ''}</div>`;
  }

  // ---------------------------------------------------------------------------
  // Destinations
  // ---------------------------------------------------------------------------
  function pageDestinations() {
    const [p, r] = S.destinations;
    const m = E.metrics({ range: 'all' });
    const stateList = [
      ['Received', 'Read from source or file'], ['Valid', 'Passed validation'], ['Accepted', 'Valid, unique, sent for write'],
      ['Written', 'Confirmed by Master Registry 1'], ['Replicated', 'Confirmed in Master Registry 2'],
      ['Write failed', 'Rejected, or retries exhausted'], ['Retry scheduled', 'Temporary failure; automatic retry'], ['Outcome unknown', 'Unconfirmed write; reconcile before resending'],
    ];
    const card = (d) => html`<section class="panel c6"><header><h3>${d.role === 'PRIMARY' ? 'Master Registry 1' : 'Master Registry 2'} <span class="muted small">${d.role === 'PRIMARY' ? 'Primary · write' : 'Replica · read-only'}</span></h3>${pill('health', d.enabled ? d.health : 'DISABLED')}</header><div class="body"><dl class="kv">
      ${d.role === 'PRIMARY' ? html`<dt>Last write</dt><dd>${rel(d.lastDeliveryAt)}</dd><dt>Written</dt><dd>${num(m.deliveredSR1)}</dd><dt>Duplicates prevented</dt><dd>${num(m.duplicatesPrevented)}</dd><dt>Max attempts</dt><dd>${d.retry.maxAttempts}</dd>`
        : html`<dt>Last sync</dt><dd>${rel(d.lastSyncAt)}</dd><dt>Replication</dt><dd>${num(m.confirmedSR2)} replicated · ${num(m.replicaPending)} pending · ${num(m.replicaFailed)} failed</dd><dt>Lag</dt><dd>${dur(m.replicationLagMs)} (threshold ${d.lagThresholdMs / 1000} s)</dd>`}
      </dl><div class="btns" style="margin-top:12px"><button class="btn sm" data-act="dest-health" data-arg="${d.id}">Check connection</button>
      ${d.role === 'PRIMARY' ? html`<button class="btn sm" data-act="dest-toggle" data-arg="${d.id}" ${dis('destination.edit')}>${d.enabled ? 'Disable' : 'Enable'}</button><label class="small row">Max attempts <select data-change="maxattempts" ${dis('destination.edit')}>${[3, 5, 8].map((n) => html`<option ${raw(d.retry.maxAttempts === n ? 'selected' : '')}>${n}</option>`)}</select></label>` : ''}</div>
      ${techDetails(html`<dl class="kv small"><dt>ID</dt><dd class="mono">${d.id}</dd><dt>Name</dt><dd>${d.name}</dd><dt>Endpoint</dt><dd class="mono">${d.endpoint}</dd><dt>Credentials</dt><dd class="mono">${d.authRef}</dd><dt>Delivery policy</dt><dd>${d.deliveryPolicy}</dd><dt>Retry policy</dt><dd>${d.retry.maxAttempts} attempts · base ${d.retry.baseMs / 1000} s ×${d.retry.factor} · cap ${d.retry.capMs / 1000} s · ${d.retry.jitter} jitter</dd></dl>`)}</div></section>`;
    return html`${head('Destinations', 'Writes go to Master Registry 1 only; Master Registry 2 is verified as its replica.')}
      <div class="grid">${card(p)}${card(r)}</div>
      <div class="grid">
        <section class="panel c6"><header><h3>Record states</h3></header><div class="body flush"><table class="t"><tbody>${stateList.map(([a, b]) => html`<tr><td><b>${a}</b></td><td class="small muted">${b}</td></tr>`)}</tbody></table></div></section>
        <section class="panel c6"><header><h3>Delivery guarantees</h3></header><div class="body stack note">
          <p style="margin:0"><b>No duplicate writes.</b> Resends are recognised and not saved twice.</p>
          <p style="margin:0"><b>Written means confirmed.</b> Acceptance alone is not counted.</p>
          <p style="margin:0"><b>No silent overwrite.</b> Cross-source matches go to review.</p>
          ${techDetails(html`<p style="margin:0"><b>At-least-once delivery, made effectively-once by idempotency.</b> Idempotency key = sha256(source key | source version | payload). Exactly-once is not claimed: it holds only if SR1 enforces the key. The platform endpoint <span class="mono">/partner/ingest_data</span> is asynchronous and returns an <span class="mono">ingest_id</span>; persisting and checking the key there is a required platform change. Unknown outcomes are resolved by querying SR1 by key before resending; SR2 is probed by internal record ID.</p>`, 'Technical details: delivery semantics')}</div></section>
      </div>`;
  }

  // ---------------------------------------------------------------------------
  // New transfer: five steps + demo scenarios
  // ---------------------------------------------------------------------------
  const SIM_FIELDS = [
    ['authFail', 'Authentication failure', 'bool', 'API'], ['rateLimit', 'Rate limit on page 2', 'bool', 'API'], ['pageTimeout', 'Timeout on page 3', 'bool', 'API'], ['schemaDrift', 'Source schema change', 'bool', 'API'],
    ['missing', 'Missing required fields', 'num'], ['invalid', 'Invalid formats', 'num'], ['crossSource', 'Cross-source duplicates', 'num', 'API'],
    ['transient', 'Temporary write failures', 'num'], ['permanent', 'Write rejections', 'num'], ['unknown', 'Unknown write outcomes', 'num'], ['exhaust', 'Writes failing every attempt', 'num'],
    ['replicaDelayMs', 'Replication delay', 'delay'], ['replicaFail', 'Replication failures', 'num'],
  ];
  const UPLOAD_CHECKS = [[/^File name/, 'File name'], [/^Extension/, 'File type (.csv, .xlsx)'], [/^Size/, 'Size ≤ 5 MB'], [/^File signature/, 'Content matches type'], [/^MIME/, 'MIME type'], [/^Macros/, 'Formulas not executed']];
  const uploadCheckName = (n) => (UPLOAD_CHECKS.find(([re]) => re.test(n)) || [, n])[1];
  const WIZ_STEPS = ['Select Source', 'Upload or Receive', 'Review and Submit'];

  function pageIngest() {
    const w = UI.wiz;
    const s = w.sourceId && E.getSource(w.sourceId);
    const done = !!w.runId;
    let body;
    if (done) body = submittedView(E.getRun(w.runId));
    else if (w.step === 1) body = html`<h2 class="q">Select Source</h2>
      <div class="choice big">${S.sources.filter((x) => !x.removed).map((x) => html`<button data-act="wiz-source" data-arg="${x.id}" aria-pressed="${w.sourceId === x.id}" ${raw(x.enabled ? '' : 'disabled')}><b>${x.name}</b><span>${modes(x)}</span>${x.enabled ? '' : html`<span class="pill">Disabled</span>`}</button>`)}</div>`;
    else if (w.step === 2) body = html`<h2 class="q">${s.name}</h2>
      ${s.modes.length > 1 ? html`<div class="choice big">
        <button data-act="wiz-mode" data-arg="IMPORT" aria-pressed="${w.mode === 'IMPORT'}"><b>Upload File</b><span>CSV or Excel</span></button>
        <button data-act="wiz-mode" data-arg="API" aria-pressed="${w.mode === 'API'}"><b>Receive from Source</b><span>New records</span></button></div>` : ''}
      ${w.mode === 'IMPORT' ? uploadStep(s) : w.mode === 'API' ? html`<p style="margin:0">New records since ${fmtTime(s.watermark, false)}.</p><div><button class="btn primary lg" data-act="wiz-receive" ${dis('run.start')}>Receive Records</button></div>` : ''}`;
    else body = reviewStep();
    return html`${head('Add Records')}
      <section class="panel"><header><ol class="steps big" aria-label="Steps">${WIZ_STEPS.map((l, i) => { const n = i + 1; const ok = done || n < w.step; return html`<li class="step-chip ${ok ? 'done' : ''}" ${raw(!done && n === w.step ? 'aria-current="step"' : '')}><b>${ok ? '✓' : n}</b>${l}</li>`; })}</ol></header>
        <div class="body stack">${body}
        ${!done && w.step > 1 ? html`<div class="wiz-foot"><button class="btn" data-act="wiz-step" data-arg="${w.step - 1}">Back</button></div>` : ''}</div></section>
      ${techAllowed() ? moreDetails('Demo Tools', html`<div class="stack">${w.mode && !done ? simPanel() : ''}${scenarioLab()}</div>`) : ''}`;
  }
  // "20 records checked. 18 valid. 2 need correction."
  function reviewStep() {
    const w = UI.wiz;
    const d = w.dry;
    if (!d) return html`<div class="empty">Nothing to review.</div>`;
    const code = stopCode(d);
    if (code) {
      const m = T.friendlyError(code);
      return html`<h2 class="q">Review and Submit</h2><div class="callout crit result"><b>${m.title}</b><div>${m.next}</div></div>
        <div class="btns">${code === 'FIELD_MAPPING_FAILED' && E.can('mapping.edit') ? html`<button class="btn" data-act="map-open" data-arg="${w.sourceId}">Correct Mapping</button>` : ''}<button class="btn primary" data-act="wiz-step" data-arg="2">Try Again</button></div>
        ${techDetails(html`<table class="t"><tbody>${d.stages.map((stg) => html`<tr><td class="mono small">${stg.key}</td><td class="mono small">${stg.status}</td><td class="small">${stg.note}</td></tr>`)}</tbody></table>`)}`;
    }
    const rc = E.reconcileSummary([d]);
    const issues = d.records.filter((r) => E.classify(r) !== 'ACCEPTED');
    return html`<h2 class="q">Review and Submit</h2>
      <div class="callout ${issues.length ? 'warn' : 'ok'} result" role="status"><b>${num(rc.received)} records checked. ${num(rc.accepted)} valid.${issues.length ? ` ${num(issues.length)} need correction.` : ''}</b></div>
      ${issues.length ? html`<div class="btns"><button class="btn" data-act="wiz-issues" aria-expanded="${w.showIssues}">${w.showIssues ? 'Hide Issues' : 'View Issues'}</button>${w.showIssues ? html`<button class="btn sm ghost" data-act="wiz-report" ${dis('report.download')}>Download Report</button>` : ''}</div>
        ${w.showIssues ? html`<div class="tbl-wrap"><table class="t"><thead><tr><th>Record</th><th>Person</th><th>Issue</th></tr></thead><tbody>${issues.slice(0, 100).map((r) => html`<tr><td class="small">${r.sourceRecordId}</td><td>${person(r)}</td><td class="small">${recordIssue(r)}</td></tr>`)}</tbody></table></div>` : ''}
        ${rc.accepted ? html`<label class="row confirm"><input type="checkbox" id="wiz-ack" data-bind="wiz.ack" data-type="check" ${raw(w.ack ? 'checked' : '')}> Submit the ${num(rc.accepted)} valid records. ${num(issues.length)} will not be transferred.</label>` : ''}` : ''}
      ${rc.accepted ? html`<div><button class="btn primary lg" data-act="wiz-start" ${dis('run.start')} ${raw(!issues.length || w.ack ? '' : 'disabled title="Tick the box above first."')}>Submit ${num(rc.accepted)} Records</button></div>` : html`<div class="callout crit">No valid records. Correct the file and try again.</div>`}
      ${w.file && w.file.preview ? moreDetails('File Preview', html`<div class="tbl-wrap" style="max-height:320px"><table class="t"><thead><tr>${w.file.headers.map((h) => html`<th>${h}</th>`)}</tr></thead><tbody>${w.file.preview.map((r) => html`<tr>${w.file.headers.map((_, i) => { const v = r[i] === undefined ? '' : String(r[i]); return html`<td class="small ${/^[=+\-@]/.test(v) && !/^[+-]?\d/.test(v) ? 'formula' : ''}">${maskPreview(w.file.headers[i], v)}</td>`; })}</tr>`)}</tbody></table></div>`) : ''}
      ${techDetails(html`<dl class="kv small"><dt>Validation run</dt><dd class="mono">${d.dryRunId}</dd><dt>Mapping</dt><dd>v${d.mappingVersion}</dd>${w.file && w.file.checksum ? html`<dt>Checksum</dt><dd class="mono">sha256 ${w.file.checksum.slice(0, 24)}…</dd>` : ''}</dl><table class="t"><tbody>${d.stages.map((stg) => html`<tr><td class="mono small">${stg.key}</td><td class="mono small">${stg.status}</td><td class="small">${stg.note}</td></tr>`)}</tbody></table>`)}`;
  }
  // After Submit: a simple progress bar, then "Transfer completed. 48 records transferred. 2 need attention."
  function submittedView(run) {
    if (!run) return html`<div class="empty">Transfer not found.</div>`;
    if (UI.animating.has(run.id)) {
      const pct = Math.round((run.stageIdx / run.stages.length) * 100);
      return html`<h2 class="q">Processing</h2><div class="progress" role="progressbar" aria-label="Transfer progress" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>`;
    }
    const open = attentionIds();
    const r = simpleResult(run, open);
    const attn = r.tone === 'crit' || run.records.some((x) => recordState(x, open)[0] === 'Needs Attention');
    return html`${resultBox(r)}${savePanel(run)}<div class="btns"><button class="btn" data-act="run" data-arg="${run.id}">${attn ? 'View Issues' : 'View Details'}</button><button class="btn primary lg" data-act="wiz-done">Done</button></div>`;
  }
  // Transfers run in this browser only. Send to NSR reads the server, so processed records are saved there explicitly.
  const savable = (run) => run.records.filter((r) => r.primary.masterId);
  function savePanel(run) {
    const count = savable(run).length;
    if (!count || !E.can('run.start')) return '';
    const s = UI.wiz.save;
    const saved = s && !s.busy && s.done > 0;
    return html`<section class="panel"><header><b>Save for Send to NSR</b></header><div class="body stack">
      <p style="margin:0">${num(count)} records are ready. Save them to the server to send them to NSR.</p>
      <label class="field">API key<input type="password" id="wiz-api-key" autocomplete="off" data-live data-bind="nsr.key" value="${UI.nsr.key}"></label>
      ${s && s.error ? html`<div class="callout crit" role="alert"><b>${nsrReason(s.error)}</b></div>` : ''}
      ${s && s.failed.length ? html`<div class="callout crit" role="alert"><b>${num(s.failed.length)} records were not saved.</b><ul class="small">${s.failed.slice(0, 20).map((f) => html`<li>${f}</li>`)}</ul></div>` : ''}
      ${saved ? html`<div class="callout ok" role="status"><b>${num(s.done)} of ${num(s.total)} records saved.</b></div>` : ''}
      <div class="btns"><button class="btn primary" data-act="wiz-save" ${raw(!UI.nsr.key || (s && s.busy) ? 'disabled' : '')}>${s && s.busy ? `Saving ${num(s.done)} of ${num(s.total)}` : 'Save to Server'}</button>
      ${saved && E.can('nsr.preview') ? html`<button class="btn" data-act="wiz-open-nsr">Open Send to NSR</button>` : ''}</div></div></section>`;
  }
  // One request per record, the API's limit. Saving again is safe: an unchanged record stays as it is.
  async function saveRun(run) {
    const records = savable(run).map((r) => DB.backendRecord(SCHEMA, r));
    const s = UI.wiz.save = { busy: true, done: 0, total: records.length, failed: [], error: null };
    render();
    for (const rec of records) {
      let res, data;
      try {
        res = await fetch('/api/v1/records', { method: 'POST', headers: { 'X-API-Key': UI.nsr.key, 'Content-Type': 'application/json' }, body: JSON.stringify(rec) });
        data = await res.json();
      } catch (e) { s.error = 'NETWORK'; break; }
      if (res.status === 401) { s.error = 'UNAUTHORISED'; break; }
      if (res.ok) s.done++;
      else s.failed.push(`${rec.given_name || rec.internal_record_id}: ${((data.error && data.error.details) || []).map((d) => d.message).join('; ') || (data.error && data.error.message) || 'not saved'}`);
      render();
    }
    s.busy = false;
    render();
  }
  function simPanel() {
    const w = UI.wiz;
    return html`<details class="panel demo" ${raw(Object.keys(w.sim).some((k) => k !== 'pages' && w.sim[k]) ? 'open' : '')}><summary style="padding:10px 14px;cursor:pointer"><b>Simulate faults</b> <span class="mock-tag">demo</span></summary><div class="body form">
      ${SIM_FIELDS.filter((f) => !f[3] || f[3] === w.mode).map(([k, l, t]) => t === 'bool' ? html`<label class="row small"><input type="checkbox" id="sim-${k}" data-bind="wiz.sim.${k}" data-type="check" ${raw(w.sim[k] ? 'checked' : '')}> ${l}</label>` : t === 'delay' ? html`<label class="field">${l}<select id="sim-${k}" data-bind="wiz.sim.${k}" data-type="num"><option value="0">None</option><option value="180000" ${raw(w.sim[k] === 180000 ? 'selected' : '')}>3 minutes</option></select></label>` : html`<label class="field">${l}<input type="number" min="0" max="10" id="sim-${k}" data-bind="wiz.sim.${k}" data-type="num" value="${w.sim[k] || 0}"></label>`)}
      </div></details>`;
  }
  function uploadStep() {
    const u = UI.wiz.upload;
    return html`<div class="drop" id="drop"><p style="margin:0 0 12px"><b>Drop a CSV or Excel file here</b></p><label class="btn primary lg" for="wiz-file">Choose File</label><input type="file" id="wiz-file" accept=".csv,.xlsx" hidden>
        <div class="btns" style="justify-content:center;margin-top:12px"><button class="btn sm ghost" data-act="template">Download Template</button></div></div>
      ${u && !u.ok ? html`<div class="callout crit result"><b>File not accepted</b><div>${u.checks.filter((c) => !c.ok).map((c) => uploadCheckName(c.name)).join(', ')}. ${T.friendlyError('FILE_FORMAT_INVALID').next}</div></div>` : ''}
      ${moreDetails('Demo Files', html`<div class="btns"><button class="btn sm" data-act="wiz-sample" data-arg="good">Valid</button><button class="btn sm" data-act="wiz-sample" data-arg="duplicates">Duplicates</button><button class="btn sm" data-act="wiz-sample" data-arg="drift">Schema mismatch</button><button class="btn sm" data-act="wiz-sample" data-arg="malicious">Malicious</button></div>`)}`;
  }
  const maskPreview = (h, v) => (FIELD[h] && /^High/.test(FIELD[h].sensitivity) && v ? maskVal(h, v) : v);
  function scenarioLab() {
    return html`<details class="panel demo"><summary style="padding:14px 18px;cursor:pointer"><b>Demo scenarios (${DB.SCENARIOS.length})</b> <span class="small muted">Run through the same engine.</span></summary><div class="body"><div class="scen">
      ${DB.SCENARIOS.map((sc) => { const [t, x] = T.SCENARIO_TEXT[sc.id] || [sc.title, sc.expect]; return html`<div class="scen-card"><h4><span>${sc.id}</span>${t}</h4><p>${x}</p><div class="spread"><span class="small muted">${srcName(sc.source)} · ${T.modeLabel(sc.mode)}</span><button class="btn sm primary" data-act="scenario" data-arg="${sc.id}" ${dis('run.start')}>Run</button></div></div>`; })}
    </div></div></details>`;
  }

  // ---------------------------------------------------------------------------
  // Settings: administrator pages grouped in one place
  // ---------------------------------------------------------------------------
  const SETTINGS_HINT = { sources: 'Registries and uploads', mapping: 'Source to registry fields', destinations: 'Master registries', audit: 'Who did what', security: 'Roles and permissions', recon: 'Account for every record', errors: 'All exceptions', quality: 'Validation trends', lineage: 'Trace a record', architecture: 'Technical reference' };
  function pageSettings() {
    return html`${head('Settings')}
      ${T.SETTINGS_GROUPS.map(([g, items]) => html`<section class="stack" style="gap:10px"><h2 class="q">${g}</h2><div class="choice">${items.map(([k, l]) => html`<button data-act="nav" data-arg="${k}"><b>${l}</b><span>${SETTINGS_HINT[k]}</span></button>`)}</div></section>`)}`;
  }

  // ---------------------------------------------------------------------------
  // Mapping + schema
  // ---------------------------------------------------------------------------
  function mappingSummary(v) {
    const total = SCHEMA.fields.length;
    return html`<div class="stack"><div class="cov" aria-hidden="true"><i style="width:${(v.requiredMapped / total) * 100}%;background:var(--good)"></i><i style="width:${((v.mappedCount - v.requiredMapped) / total) * 100}%;background:var(--s1)"></i><i style="width:${((v.systemCount + v.derivedCount) / total) * 100}%;background:var(--s4)"></i><i style="width:${(v.requiredMissing.length / total) * 100}%;background:var(--crit)"></i></div>
      <div class="legend"><span><i style="background:var(--good)"></i>Required mapped: ${v.requiredMapped}/${v.requiredTotal}</span><span><i style="background:var(--s1)"></i>Optional mapped: ${v.mappedCount - v.requiredMapped}</span><span><i style="background:var(--s4)"></i>System-filled: ${v.systemCount + v.derivedCount}</span><span><i style="background:var(--crit)"></i>Required unmapped: ${v.requiredMissing.length}</span><span><i style="background:var(--surface-3)"></i>Optional unmapped: ${v.optionalUnmapped}</span></div>
      ${v.requiredMissing.length ? html`<div class="callout crit small"><b>Unmapped required fields:</b> ${v.requiredMissing.map(fieldLabel).join(', ')}. Transfers are blocked.</div>` : ''}
      ${v.conditionalMissing.length ? html`<div class="callout warn small"><b>Unmapped conditional fields:</b> ${v.conditionalMissing.map(fieldLabel).join(', ')}.</div>` : ''}</div>`;
  }
  function pageMapping() {
    const sid = UI.mapSource;
    const s = E.getSource(sid);
    const mp = S.mappings[sid];
    if (!UI.mapDraft || UI.mapDraft.sourceId !== sid) UI.mapDraft = { sourceId: sid, rows: JSON.parse(JSON.stringify(mp.rows)) };
    const rows = UI.mapDraft.rows;
    const v = E.validateMapping(sid, rows);
    const rowErr = new Set(v.errors.filter((e) => e.row !== null).map((e) => e.row));
    const dirty = JSON.stringify(rows) !== JSON.stringify(mp.rows);
    const srcFields = E.sourceFieldsFor(sid);
    const targets = SCHEMA.fields.filter((f) => f.fill === 'source');
    const tabs = [['mapping', 'Mapping'], ['schema', `Schema (${SCHEMA.fields.length})`], ['history', `Versions (${mp.history.length})`]];
    let body;
    if (UI.mapTab === 'mapping') body = html`<div class="body stack">${mappingSummary(v)}
        ${v.errors.filter((e) => e.row !== null).length ? html`<div class="callout crit small"><b>Mapping errors</b>${v.errors.filter((e) => e.row !== null).map((e) => html`<div>Row ${e.row + 1}: ${T.scrub(e.msg)}</div>`)}</div>` : ''}</div>
      <datalist id="src-fields">${srcFields.map((f) => html`<option value="${f}"></option>`)}</datalist>
      <div class="tbl-wrap"><table class="t"><thead><tr><th>#</th><th>Source field(s)</th><th></th><th>Transform</th><th>Argument</th><th></th><th>Registry field</th><th>Required</th><th></th></tr></thead><tbody>
        ${rows.map((r, i) => { const f = FIELD[r.target]; const t = DB.TRANSFORMS[r.op]; return html`<tr class="map-row ${rowErr.has(i) ? 'err' : ''}"><td class="small muted">${i + 1}</td>
          <td style="min-width:160px"><input type="text" id="mr-${i}-s" list="src-fields" data-bind="mapDraft.rows.${i}.sources" data-type="list" data-rerender value="${r.sources.join(', ')}" placeholder="${r.op === 'constant' ? '(none)' : 'field'}"></td><td class="map-arrow">→</td>
          <td style="min-width:170px"><select id="mr-${i}-o" data-bind="mapDraft.rows.${i}.op" data-rerender>${Object.entries(DB.TRANSFORMS).map(([k, x]) => html`<option value="${k}" ${raw(r.op === k ? 'selected' : '')}>${x.label}</option>`)}</select></td>
          <td style="min-width:130px">${t && t.arg ? html`<input type="text" id="mr-${i}-a" data-bind="mapDraft.rows.${i}.arg" data-rerender value="${r.arg || ''}" placeholder="${t.arg}">` : html`<span class="muted small">—</span>`}</td><td class="map-arrow">→</td>
          <td style="min-width:190px"><select id="mr-${i}-t" data-bind="mapDraft.rows.${i}.target" data-rerender><option value="">Select field…</option>${targets.map((x) => html`<option value="${x.name}" ${raw(r.target === x.name ? 'selected' : '')}>${x.label} (${x.name})</option>`)}</select></td>
          <td>${f ? html`<span class="pill ${f.mandatory === 'Yes' ? 'crit' : f.mandatory === 'Conditional' ? 'warn' : ''}">${f.mandatory === 'Yes' ? 'Required' : f.mandatory === 'Conditional' ? 'Sometimes' : 'Optional'}</span>` : ''}</td>
          <td><button class="btn sm ghost" data-act="map-del" data-arg="${i}" ${dis('mapping.edit')} title="Remove this row" aria-label="Remove row ${i + 1}">✕</button></td></tr>`; })}
      </tbody></table></div>
      <div class="body btns"><button class="btn" data-act="map-add" ${dis('mapping.edit')}>Add row</button><button class="btn" data-act="map-test">Test sample</button><button class="btn" data-act="map-revert" ${raw(dirty ? '' : 'disabled title="No changes."')}>Discard changes</button>
        <input type="text" id="map-note" data-bind="mapNote" value="${UI.mapNote}" placeholder="Change note (required)" style="min-width:240px" aria-label="Change note">
        <button class="btn primary" data-act="map-publish" ${dis('mapping.edit')} ${raw(dirty && v.ok && UI.mapNote.trim() ? '' : `disabled title="${esc(!dirty ? 'No changes.' : !v.ok ? 'Fix mapping errors first.' : 'Add a change note.')}"`)}>Publish v${mp.version + 1}</button>
        ${dirty ? html`<span class="pill warn">Unpublished</span>` : html`<span class="pill good">v${mp.version} live</span>`}</div>
      ${UI.mapTest ? html`<div class="body stack">${UI.mapTest.issues.filter((x) => x.severity === 'ERROR').length ? html`<div class="callout crit small"><b>Sample failed validation.</b>${UI.mapTest.issues.map((x) => html`<div>${issueText(x)}</div>`)}</div>` : html`<div class="callout ok small"><b>Sample valid.</b>${UI.mapTest.issues.map((x) => html`<div>${issueText(x)}</div>`)}</div>`}
        ${techDetails(html`<div class="grid"><div class="c6"><h4 style="margin:0 0 6px">Sample source record <span class="small muted">(synthetic)</span></h4><pre class="code">${JSON.stringify(UI.mapTest.payload, null, 2)}</pre></div><div class="c6"><h4 style="margin:0 0 6px">Registry record produced</h4>${UI.mapTest.issues.length ? html`<div class="small mono" style="margin-bottom:6px">${UI.mapTest.issues.map((x) => html`<div>${x.code}: ${x.message}</div>`)}</div>` : ''}<pre class="code">${JSON.stringify(UI.mapTest.canonical, null, 2)}</pre></div></div>`, 'Technical details: sample payload')}</div>` : ''}`;
    else if (UI.mapTab === 'schema') body = schemaTable(new Set(rows.map((r) => r.target)));
    else body = html`<div class="tbl-wrap"><table class="t"><thead><tr><th>Version</th><th>Published</th><th>By</th><th>Note</th></tr></thead><tbody>${mp.history.slice().reverse().map((h) => html`<tr><td>v${h.version}${h.version === mp.version ? html` <span class="pill good">Live</span>` : ''}</td><td class="small">${fmtTime(h.at)}</td><td class="small">${h.by}</td><td>${h.note}</td></tr>`)}</tbody></table></div>`;
    return html`${head('Field mapping', html`Schema: ${SCHEMA.fields.length} fields from the NSR build sheet (draft, not an approved standard).`)}
      <div class="filters"><label class="field">Source<select data-change="map-source">${S.sources.filter((x) => !x.removed).map((x) => html`<option value="${x.id}" ${raw(sid === x.id ? 'selected' : '')}>${x.name}</option>`)}</select></label>
        <div class="small"><span class="muted">Layout</span> ${LAYOUTS[s.layout]} · <span class="muted">fields</span> ${srcFields.length} · <span class="muted">v${mp.version}</span> ${fmtTime(mp.publishedAt)}</div>
        <div class="small" style="margin-left:auto"><span class="pill ${SCHEMA.fields.length === SCHEMA.fieldCount ? 'good' : 'crit'}">${SCHEMA.fields.length} fields verified</span></div></div>
      <section class="panel"><div class="tabs" role="tablist">${tabs.map(([k, l]) => html`<button role="tab" aria-selected="${UI.mapTab === k}" data-act="maptab" data-arg="${k}">${l}</button>`)}</div>${body}</section>`;
  }
  function schemaTable(mapped) {
    const q = UI.schemaQ;
    const groups = {};
    SCHEMA.fields.forEach((f) => { groups[f.object] = groups[f.object] || {}; groups[f.object][f.group] = (groups[f.object][f.group] || 0) + 1; });
    const list = SCHEMA.fields.filter((f) => (!q.object || f.object === q.object) && (!q.mandatory || f.mandatory === q.mandatory) && (!q.fill || f.fill === q.fill) && (!q.sens || (q.sens === 'pii' ? f.pii : q.sens === 'special' ? f.sensitivePersonal : !f.pii)) && (!q.q || (f.name + ' ' + f.label + ' ' + f.group + ' ' + f.nsrSource).toLowerCase().includes(q.q.toLowerCase())));
    return html`<div class="body stack"><div class="row small">${Object.entries(groups).map(([o, g]) => html`<span><b>${o}</b> ${Object.values(g).reduce((a, b) => a + b, 0)} <span class="muted">(${Object.entries(g).map(([k, v]) => `${k} ${v}`).join(' · ')})</span></span>`)}</div>
      <div class="filters" style="padding:0;border:0"><label class="field">Search<input type="search" id="schema-q" data-bind="schemaQ.q" data-live value="${q.q}" placeholder="Field, label or NSR question"></label>
        <label class="field">Object<select data-change="bind" data-key="schemaQ.object"><option value="">All</option>${['System', 'Household', 'Individual'].map((o) => html`<option ${raw(q.object === o ? 'selected' : '')}>${o}</option>`)}</select></label>
        <label class="field">Required<select data-change="bind" data-key="schemaQ.mandatory"><option value="">Any</option>${[['Yes', 'Required'], ['Conditional', 'Sometimes'], ['No', 'Optional']].map(([o, l]) => html`<option value="${o}" ${raw(q.mandatory === o ? 'selected' : '')}>${l}</option>`)}</select></label>
        <label class="field">Filled by<select data-change="bind" data-key="schemaQ.fill"><option value="">Any</option>${[['source', 'Source'], ['derived', 'Derived'], ['system', 'System']].map(([o, l]) => html`<option value="${o}" ${raw(q.fill === o ? 'selected' : '')}>${l}</option>`)}</select></label>
        <label class="field">Sensitivity<select data-change="bind" data-key="schemaQ.sens"><option value="">Any</option><option value="pii" ${raw(q.sens === 'pii' ? 'selected' : '')}>Personal data</option><option value="special" ${raw(q.sens === 'special' ? 'selected' : '')}>Sensitive (health, religion)</option><option value="low" ${raw(q.sens === 'low' ? 'selected' : '')}>Not personal</option></select></label>
        <span class="small muted">${list.length} of ${SCHEMA.fields.length}</span></div></div>
      <div class="tbl-wrap" style="max-height:620px"><table class="t"><thead><tr><th>Field</th><th>Object</th><th>Type</th><th>Required</th><th>Match key</th><th>Sensitivity</th><th>Filled by</th><th>Mapped</th>${techAllowed() ? html`<th>Rule</th><th>Masking</th>` : ''}<th>NSR source</th></tr></thead><tbody>
      ${list.map((f) => html`<tr><td>${f.label}<div class="small muted mono">${f.name}</div></td><td class="small">${f.object}<div class="muted">${f.group} · ${f.phase}</div></td><td class="small">${f.type}${f.codeList ? html`<div class="muted">options: ${f.codeList}</div>` : ''}</td>
        <td><span class="pill ${f.mandatory === 'Yes' ? 'crit' : f.mandatory === 'Conditional' ? 'warn' : ''}">${f.mandatory === 'Yes' ? 'Required' : f.mandatory === 'Conditional' ? 'Sometimes' : 'Optional'}</span></td><td>${f.matchKey ? 'Proposed' : ''}</td><td class="small">${f.sensitivity}${f.sensitivePersonal ? html`<div><span class="pill crit">Special category</span></div>` : f.pii ? html`<div><span class="pill warn">Personal</span></div>` : ''}</td>
        <td class="small">${{ source: 'Source', derived: 'Derived', system: 'System' }[f.fill] || f.fill}</td><td>${f.fill !== 'source' ? html`<span class="muted small">n/a</span>` : mapped.has(f.name) ? html`<span class="ok-i" aria-label="Matched">✓</span>` : f.mandatory === 'Yes' ? html`<span class="no-i" aria-label="Not matched">✕</span>` : html`<span class="muted">—</span>`}</td>
        ${techAllowed() ? html`<td class="small mono" style="max-width:220px">${f.validation}</td><td class="small" style="max-width:200px">${f.masking}</td>` : ''}<td class="small">${f.nsrSource}</td></tr>`)}
      </tbody></table></div>`;
  }

  // ---------------------------------------------------------------------------
  // Data quality
  // ---------------------------------------------------------------------------
  function pageQuality() {
    const runs = E.filterRuns(UI.filters);
    const bySrc = {};
    runs.forEach((run) => run.records.forEach((r) => {
      const x = (bySrc[run.sourceId] = bySrc[run.sourceId] || { n: 0, valid: 0, fields: {}, complete: {}, warn: 0 });
      x.n++;
      if (r.validation.status === 'VALID') x.valid++;
      r.validation.issues.forEach((i) => { if (i.severity === 'ERROR') x.fields[i.field] = (x.fields[i.field] || 0) + 1; else x.warn++; });
      if (r.canonical) S.mappings[run.sourceId].rows.forEach((m) => { x.complete[m.target] = (x.complete[m.target] || 0) + (r.canonical[m.target] !== undefined && r.canonical[m.target] !== '' ? 1 : 0); });
    }));
    const sid = UI.filters.sourceId || Object.keys(bySrc)[0];
    const sel = bySrc[sid];
    return html`${head('Data quality', 'Validation results by source for the selected period.')}
      ${filterBar(UI.filters, 'filters')}
      <section class="panel"><header><h3>Validity by source</h3></header><div class="tbl-wrap"><table class="t"><thead><tr><th>Source</th><th class="num">Received</th><th class="num">Valid</th><th class="num">Validity</th><th class="num">Warnings</th><th>Top failing fields</th></tr></thead><tbody>
        ${Object.entries(bySrc).map(([id, x]) => html`<tr><td>${srcName(id)}</td><td class="num">${num(x.n)}</td><td class="num">${num(x.valid)}</td><td class="num">${pct(x.valid / x.n)}</td><td class="num">${num(x.warn)}</td><td class="small">${Object.entries(x.fields).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([f, n]) => `${fieldLabel(f)} (${n})`).join(', ') || '—'}</td></tr>`)}
      </tbody></table></div>${Object.keys(bySrc).length ? '' : html`<div class="empty">No records.</div>`}</section>
      ${analyticsPanels(UI.filters)}
      ${sel ? html`<section class="panel"><header><h3>Field completeness: ${srcName(sid)}</h3><span class="sub">Mapped fields</span></header><div class="body">
        ${hbars(Object.entries(sel.complete).sort((a, b) => a[1] - b[1]).map(([f, n]) => ({ label: fieldLabel(f), sub: FIELD[f] && FIELD[f].mandatory === 'Yes' ? 'required' : FIELD[f] && FIELD[f].mandatory === 'Conditional' ? 'conditional' : '', segs: [{ name: 'Complete', color: FIELD[f] && FIELD[f].mandatory === 'Yes' ? C.s1 : C.s3, v: n / sel.n }], value: pct(n / sel.n, 0) })), { max: 1, fmt: (v) => pct(v) })}
        <p class="small muted">Optional fields (e.g. BVN) are often empty for non-heads.</p></div></section>` : ''}`;
  }

  // ---------------------------------------------------------------------------
  // Lineage
  // ---------------------------------------------------------------------------
  function pageLineage() {
    const q = UI.lineQ.trim().toLowerCase();
    const all = S.runs.flatMap((r) => r.records);
    if (!UI.recordId) {
      const hits = q ? all.filter((r) => [r.id, r.sourceRecordId, r.primary.masterId, r.idemKey].some((x) => x && x.toLowerCase().includes(q))).slice(0, 40) : all.filter((r) => r.primary.status !== 'WRITTEN' || r.replica.status !== 'CONFIRMED').slice(-20).reverse();
      return html`${head('Data lineage', 'Trace a record from source to both master registries.')}
        <div class="filters"><label class="field" style="flex:1">Search<input type="search" id="line-q" data-bind="lineQ" data-live value="${UI.lineQ}" placeholder="Source reference or master record ID"></label></div>
        <section class="panel"><header><h3>${q ? `${hits.length} result(s)` : 'Recent incomplete records'}</h3></header><div class="tbl-wrap"><table class="t"><tbody>${hits.map((r) => html`<tr><td class="small">${r.sourceRecordId}<div class="muted">${srcName(r.sourceId)}</div></td><td>${person(r)}</td><td>${pill('primary', r.primary.status)}</td><td>${pill('replica', r.replica.status)}</td><td><button class="btn sm" data-act="lineage" data-arg="${r.id}">Lineage</button></td></tr>`)}</tbody></table>${hits.length ? '' : html`<div class="empty">No records found.</div>`}</div></section>`;
    }
    const L = E.lineage(UI.recordId);
    const r = L.record;
    const pr = L.provenance;
    const [pl] = T.recordStatus('primary', r.primary.status);
    const [rl] = T.recordStatus('replica', r.replica.status);
    const nodes = [
      ['Source', L.source.name, `${r.sourceRecordId}\nUpdated ${fmtTime(r.sourceUpdatedAt)}`, 'good'],
      [L.run.mode === 'API' ? 'Received (API)' : 'Received (file)', fmtTime(r.times.extractedAt), L.run.mode === 'API' ? '' : (L.run.file || {}).safeName || '', 'good'],
      ['Validation', T.recordStatus('validation', r.validation.status)[0], r.validation.issues.length ? `${r.validation.issues.length} issue(s)` : '', r.validation.status === 'VALID' ? 'good' : r.validation.status === 'INVALID' ? 'crit' : 'none'],
      ['Duplicate detection', T.recordStatus('dedup', r.dedup.status)[0], r.transform.status === 'OK' ? '' : 'Conversion failed', r.transform.status === 'OK' ? (['DUPLICATE_IN_BATCH', 'MATCH_REVIEW', 'REJECTED_REVIEW'].includes(r.dedup.status) ? 'warn' : 'good') : 'crit'],
      ['Master Registry 1', pl, `${r.primary.masterId ? `${r.primary.masterId}\n` : ''}${r.primary.writtenAt ? fmtTime(r.primary.writtenAt) : `${r.primary.attempts.length} attempt(s)`}`, r.primary.status === 'WRITTEN' ? 'good' : r.primary.status === 'NOT_ATTEMPTED' ? 'none' : ['UNKNOWN', 'DEAD_LETTER'].includes(r.primary.status) ? 'crit' : 'warn'],
      ['Master Registry 2', rl, r.replica.confirmedAt ? `${fmtTime(r.replica.confirmedAt)}\nLag ${dur(r.replica.lagMs)}` : r.replica.status === 'PENDING' ? `Waiting ${dur(S.now - r.primary.writtenAt)}` : '', r.replica.status === 'CONFIRMED' ? 'good' : r.replica.status === 'FAILED' ? 'crit' : r.replica.status === 'PENDING' ? 'warn' : 'none'],
    ];
    const c = r.canonical || {};
    const result = (o) => ({ ACCEPTED: 'Written', RECONCILED_FOUND: 'Found on reconcile', TIMEOUT: 'Timeout', REJECTED: 'Rejected' }[o] || 'Temporary failure');
    const whatNow = recordIssue(r);
    return html`${head(`Record ${r.sourceRecordId}`, null, html`<button class="btn" data-act="raw" data-arg="${r.id}" ${dis('payload.view')}>View payload</button>${STUCK.includes(r.primary.status) ? html`<button class="btn" data-act="retry-rec" data-arg="${r.id}" ${dis('run.retry')}>Retry</button>` : ''}${r.dedup.status === 'MATCH_REVIEW' ? html`<button class="btn primary" data-act="review" data-arg="${r.id}" ${dis('error.resolve')}>Review</button>` : ''}`, html`<button data-act="nav" data-arg="lineage">Data lineage</button> / <button data-act="run" data-arg="${r.runId}">Transfer ${fmtTime(L.run.createdAt, false)}</button> / ${r.sourceRecordId}`)}
      ${whatNow ? html`<div class="callout ${['UNKNOWN', 'DEAD_LETTER'].includes(r.primary.status) || E.classify(r) === 'INVALID' ? 'crit' : 'warn'}">${whatNow}</div>` : ''}
      <section class="panel"><header><h3>Lineage</h3></header><div class="body"><div class="lineage">${nodes.map((n, i) => html`${i ? html`<div class="ln-arrow" aria-hidden="true">→</div>` : ''}<div class="ln-node" data-s="${n[3]}"><span class="small muted">${n[0]}</span><h4>${n[1] || '—'}</h4><div class="meta" style="white-space:pre-line">${n[2]}</div></div>`)}</div></div></section>
      <div class="grid">
        <section class="panel c6"><header><h3>Provenance</h3></header><div class="body"><dl class="kv">
          <dt>Source</dt><dd>${L.source.name}</dd><dt>Source reference</dt><dd>${r.sourceRecordId}</dd><dt>Transfer</dt><dd>${T.modeLabel(L.run.mode)} · ${fmtTime(L.run.createdAt, false)}</dd>
          <dt>Mapping</dt><dd>Version ${L.run.mappingVersion}</dd><dt>Master record</dt><dd>${r.primary.masterId || '—'}</dd></dl>
          ${techDetails(html`<dl class="kv small">${Object.entries(pr).map(([k, v]) => html`<dt class="mono">${k}</dt><dd class="${/id|key|trace/i.test(k) ? 'mono' : ''}">${typeof v === 'number' ? fmtTime(v) : v === null || v === undefined ? '—' : v}</dd>`)}</dl>`)}</div></section>
        <div class="c6 stack">
          ${r.validation.issues.length ? html`<section class="panel"><header><h3>Validation</h3></header><div class="body small stack">${r.validation.issues.map((i) => html`<div><span class="pill ${i.severity === 'ERROR' ? 'crit' : 'warn'}">${i.severity === 'ERROR' ? 'Error' : 'Warning'}</span> ${issueText(i)}</div>`)}
            ${techDetails(html`${r.validation.issues.map((i) => html`<div class="mono">${i.code} · ${i.field} · ${i.message}</div>`)}`)}</div></section>` : ''}
          <section class="panel"><header><h3>Write attempts</h3></header><div class="body flush">${r.primary.attempts.length ? html`<table class="t"><tbody>${r.primary.attempts.map((a) => html`<tr><td class="num">#${a.n}</td><td class="small">${fmtTime(a.at)}</td><td class="small">${result(a.outcome)}</td><td class="small muted">${a.by === 'pipeline' ? 'Automatic' : a.by}</td></tr>`)}</tbody></table>
            <div class="body">${techDetails(html`<table class="t"><tbody>${r.primary.attempts.map((a) => html`<tr><td class="num">#${a.n}</td><td class="mono small">${a.outcome}</td><td class="small">${a.http || ''}</td><td class="small">${a.note}</td><td class="mono small">${a.idemKey.slice(0, 12)}…</td></tr>`)}</tbody></table>`)}</div>` : html`<div class="empty">Not sent.</div>`}</div></section>
          <section class="panel"><header><h3>Location</h3>${r.geo ? html`<span class="pill">${r.geo.locationType}</span>` : ''}</header><div class="body">${r.geo ? html`<dl class="kv small"><dt>Coordinates</dt><dd>${maskVal('latitude', r.geo.lat)}, ${maskVal('longitude', r.geo.lon)}</dd><dt>Accuracy</dt><dd>${r.geo.accuracyM ? r.geo.accuracyM + ' m' : '—'}</dd><dt>Admin areas</dt><dd>${r.geo.adminIds.join(' › ')}</dd><dt>Source</dt><dd>${r.geo.geoSource}</dd><dt>Method</dt><dd>${r.geo.collectionMethod}</dd><dt>Observed</dt><dd>${fmtTime(r.geo.observedAt)}</dd><dt>Validation</dt><dd>${r.geo.validation}</dd></dl>
            ${moreDetails('About this location', html`<p class="small muted" style="margin:0">Residential location as supplied by the source. Not a service point; never inferred. Precise values need payload permission.</p>`)}${techDetails(html`<dl class="kv small"><dt>CRS</dt><dd>${r.geo.crs}</dd></dl>`)}` : html`<div class="empty">No location supplied.</div>`}</div></section>
          <section class="panel"><header><h3>Registry record (masked)</h3><span class="sub">${Object.keys(c).length}/${SCHEMA.fields.length} fields</span></header><div class="body"><dl class="kv small">${Object.entries(c).map(([k, v]) => html`<dt>${fieldLabel(k)}</dt><dd>${maskVal(k, typeof v === 'boolean' ? (v ? 'Yes' : 'No') : v)}</dd>`)}</dl></div></section>
        </div></div>`;
  }

  // ---------------------------------------------------------------------------
  // Audit, security, architecture
  // ---------------------------------------------------------------------------
  function auditTable(list) {
    if (!list.length) return html`<div class="empty">No audit events.</div>`;
    const tech = techAllowed();
    return html`<div class="tbl-wrap"><table class="t"><thead><tr><th>Time</th><th>User</th><th>Role</th><th>Action</th><th>Outcome</th><th>Detail</th>${tech ? html`<th>Reference</th>` : ''}</tr></thead><tbody>${list.slice().reverse().slice(0, 300).map((a) => { const [ol, ot] = T.OUTCOMES[a.outcome] || [label(a.outcome), 'serious']; return html`<tr><td class="small">${fmtTime(a.at)}</td><td class="small">${a.actor}</td><td class="small">${roleName(a.role)}</td><td>${T.auditAction(a.action)}</td><td><span class="pill ${ot}">${ol}</span></td><td class="small">${T.scrub(a.detail)}</td>${tech ? html`<td class="mono small muted tech-ref">${a.id} · ${a.action}<div>${a.target}</div></td>` : ''}</tr>`; })}</tbody></table></div>`;
  }
  function pageAudit() {
    if (!E.can('audit.view')) return html`${head('Audit log')}<div class="panel"><div class="empty"><b>Access denied.</b>Auditor or platform admin only.</div></div>`;
    const q = UI.auditQ.toLowerCase();
    const list = S.audit.filter((a) => !q || (a.action + ' ' + T.auditAction(a.action) + ' ' + a.target + ' ' + a.detail + ' ' + a.outcome + ' ' + (T.OUTCOMES[a.outcome] || [''])[0]).toLowerCase().includes(q));
    return html`${head('Audit log', 'Append-only. Contains no personal data.')}
      <div class="filters"><label class="field" style="flex:1">Search<input type="search" id="audit-q" data-bind="auditQ" data-live value="${UI.auditQ}" placeholder="Action, target or outcome"></label><span class="small muted">${list.length} of ${S.audit.length}</span></div>
      <section class="panel">${auditTable(list)}</section>`;
  }
  const OWASP = [
    ['A01', 'Broken Access Control', 'Operator triggers retries or reads payloads for another programme', 'Server-side RBAC per action; object-level checks on run/record IDs; purpose + justification for raw payload', 'Engine authz() on every mutating call; UI only hides', 'Role switch → actions refused; denial audited'],
    ['A02', 'Security Misconfiguration', 'Default credentials or permissive CORS on the console API', 'Hardened Helm values, CSP, CORS allow-list, no debug endpoints', 'Ingress + API config', 'Config scan in CI; DAST'],
    ['A03', 'Software Supply Chain Failures', 'Compromised parser library (xlsx/CSV) in the worker image', 'Pinned versions, SBOM, signature verification, image scanning', 'CI pipeline, registry', 'SCA + Trivy gates'],
    ['A04', 'Cryptographic Failures', 'PII readable in object store or backups', 'TLS 1.3, mTLS between services, AES-256 at rest via KMS, field-level encryption for NIN/BVN/account', 'Storage, DB, service mesh', 'Key rotation drill; TLS scan'],
    ['A05', 'Injection', 'CSV formula injection, SQL injection via mapping args, XSS through file cells', 'Values-only parsing, formula neutralisation on export, parameterised queries, escaped rendering', 'Parser, export, UI', 'Prototype: formula cell test; escaped preview'],
    ['A06', 'Insecure Design', 'Retry creates duplicate beneficiaries; unknown outcome marked success', 'Idempotency keys, explicit UNKNOWN state, reconciliation before resend', 'Delivery service', 'Unknown-outcome + duplicate-prevention tests'],
    ['A07', 'Authentication Failures', 'Shared admin account; long-lived tokens', 'Keycloak OIDC, MFA for admins, short-lived tokens, per-source client credentials', 'IdP, gateway', 'Token TTL tests; MFA policy check'],
    ['A08', 'Software or Data Integrity Failures', 'Tampered upload or mapping changed without review', 'Checksums on files, versioned mappings with change note, maker-checker (planned)', 'Upload scan, mapping service', 'Checksum shown per run; mapping history'],
    ['A09', 'Security Logging and Alerting Failures', 'Silent bulk export or payload access', 'Append-only audit with justification, alerting on DENIED spikes and lag', 'Audit service, SIEM', 'Audit log entries for payload views and denials'],
    ['A10', 'Mishandling of Exceptional Conditions', 'Timeouts treated as success; partial batch hides failures', 'Typed error taxonomy, per-record states, no "completed" while outstanding', 'Orchestrator, run status', 'Run status derivation tests'],
  ];
  function pageSecurity() {
    if (!E.can('security.view')) return html`${head('Access control')}<div class="panel"><div class="empty"><b>Access denied.</b>Auditor or platform admin only.</div></div>`;
    const refs = S.sources.filter((s) => s.authRef && s.authRef !== '—').map((s) => [s.name, s.authRef]).concat(S.destinations.map((d) => [d.role === 'PRIMARY' ? 'Master Registry 1' : 'Master Registry 2', d.authRef]));
    return html`${head('Access control', 'Simulated controls are demonstrated by the prototype, not production systems.')}
      <section class="panel"><header><h3>Permissions</h3><span class="sub">Current role highlighted</span></header><div class="tbl-wrap"><table class="t"><thead><tr><th>Permission</th>${Object.keys(DB.ROLES).map((k) => html`<th style="${k === S.role ? 'color:var(--brand)' : ''}">${roleName(k)}</th>`)}</tr></thead><tbody>
        ${DB.PERMISSIONS.map(([p]) => html`<tr><td>${label(T.PERM_LABELS[p] || p)}${techAllowed() ? html`<div class="small muted mono">${p}</div>` : ''}</td>${Object.entries(DB.ROLES).map(([k, r]) => html`<td class="${k === S.role ? 'sel' : ''}">${r.perms.includes(p) ? html`<span class="ok-i" aria-label="Yes">✓</span>` : html`<span class="muted" aria-label="No">—</span>`}</td>`)}</tr>`)}
      </tbody></table></div><div class="body small muted">Enforced server-side. Platform admins cannot view payloads; analysts can, with an audited reason.</div></section>
      <div class="grid">
        <section class="panel c6"><header><h3>Secrets</h3><span class="mock-tag">simulated vault</span></header><div class="body stack"><p class="small muted" style="margin:0">Vault references only; values never shown.</p><table class="t"><tbody>${refs.map(([n, r]) => html`<tr><td>${n}</td><td class="mono small">${r}</td><td class="small muted">Hidden</td></tr>`)}</tbody></table>
          ${techDetails(html`<p class="note" style="margin:0">Production: HashiCorp Vault (or cloud secrets manager) issuing short-lived credentials; KMS/HSM-held keys, rotation every 90 days; AES-256 at rest for database, object store zones (raw, staging, canonical, reject) and backups; TLS 1.3 at the edge and mTLS inside the cluster. The prototype does not encrypt anything and does not claim to.</p>`)}</div></section>
        <section class="panel c6"><header><h3>Data protection</h3></header><div class="body"><ul class="checks small">
          ${['Synthetic records only (NIN prefix 99)', 'Sensitive fields masked by build-sheet sensitivity', 'Health and religion hidden in lists', 'Coordinates coarsened without payload permission', 'Messages name fields, not values; reports redacted', 'Payload view needs permission and an audited reason', 'Uploads stay in the browser; previews masked', 'Exports neutralise = + - @ (formula injection)'].map((x) => html`<li><span class="ok-i">✓</span><span>${x}</span></li>`)}</ul></div></section>
      </div>
      ${moreDetails('OWASP controls', html`<section class="panel"><header><h3>OWASP Top 10:2025</h3><span class="sub">Full matrix with remaining risk: docs/security/owasp-controls.md</span></header><div class="tbl-wrap"><table class="t"><thead><tr><th>ID</th><th>Category</th><th>Middleware threat</th><th>Mitigation</th><th>Enforcement point</th><th>Verification</th></tr></thead><tbody>${OWASP.map((o) => html`<tr><td class="mono">${o[0]}</td><td><b>${o[1]}</b></td><td class="small">${o[2]}</td><td class="small">${o[3]}</td><td class="small">${o[4]}</td><td class="small">${o[5]}</td></tr>`)}</tbody></table></div></section>
      <section class="panel"><header><h3>OWASP API risks</h3></header><div class="tbl-wrap"><table class="t"><tbody>${[
        ['API1 Broken Object Level Authorization', 'Run and record IDs are checked against the caller’s programme scope, not only the role.'],
        ['API2 Broken Authentication', 'Per-source OAuth client credentials from vault; console tokens 5 min; no API keys in URLs.'],
        ['API4 Unrestricted Resource Consumption', 'Upload 5 MB cap (prototype), page-size limits, per-source rate budget, chunked processing.'],
        ['API7 Server Side Request Forgery', 'Configurable base URLs pass an https-only, allow-listed, no-IP-literal, no-internal-host check (try it in Add source).'],
        ['API9 Improper Inventory Management', 'Every source and destination is registered with environment, owner and version; removed sources stay in inventory.'],
        ['API10 Unsafe Consumption of APIs', 'Upstream responses are schema-checked (fingerprint), size-bounded and never trusted for redirects.'],
      ].map(([a, b]) => html`<tr><td style="width:300px"><b>${a}</b></td><td class="small">${b}</td></tr>`)}</tbody></table></div></section>`)}`;
  }
  function pageArchitecture() {
    return html`${head('Architecture', html`Eight diagrams from editable Mermaid source in <span class="mono">docs/architecture/</span>. Proposed components only.`)}
      <div class="callout"><b>Summary:</b> sources → validation → Master Registry 1 → replication check (Master Registry 2) → reconciliation. Unconfirmed outcomes become exceptions.</div>
      <div class="callout small">Grounded in the registry codebase: the platform already exposes <span class="mono">POST /partner/ingest_data</span> (partner API) feeding <span class="mono">incoming_raw_data</span> → Celery classification → transformation → ingest workers (max 5 attempts), and file imports through <span class="mono">import_file_process_queue</span> with a unique <span class="mono">(document_id, record_number)</span> log. DataBridge sits in front of that as the multi-source orchestrator and adds provenance, idempotency, replica verification and reconciliation.</div>`;
  }

  // ---------------------------------------------------------------------------
  // Modals
  // ---------------------------------------------------------------------------
  function modal() {
    const m = UI.modal;
    if (!m) return '';
    let title, body, foot, wide;
    if (m.type === 'source-form') {
      title = UI.sourceForm._new ? 'Add source' : `Edit ${UI.sourceForm.name}`;
      body = sourceForm();
      foot = html`<button class="btn" data-act="modal-close">Cancel</button><button class="btn primary" data-act="source-save">${UI.sourceForm._new ? 'Add source' : 'Save'}</button>`;
      wide = true;
    } else if (m.type === 'remove') {
      const s = E.getSource(m.id);
      const dep = E.sourceDependencies(m.id);
      title = `Remove ${s.name}?`;
      body = html`<p style="margin:0">Soft delete: the source is disabled and hidden; history is kept.</p><dl class="kv"><dt>Transfers</dt><dd>${dep.runs}</dd><dt>In progress</dt><dd>${dep.activeRuns}</dd><dt>Records written</dt><dd>${dep.masterRecords} (kept)</dd></dl>${dep.activeRuns ? html`<div class="callout crit">Blocked: transfer in progress.</div>` : ''}`;
      foot = html`<button class="btn" data-act="modal-close">Cancel</button><button class="btn danger" data-act="source-remove-confirm" data-arg="${m.id}" ${raw(dep.activeRuns ? 'disabled title="Transfer in progress."' : '')}>Remove</button>`;
    } else if (m.type === 'file') {
      title = m.name;
      body = html`<p class="note" style="margin:0">${m.note || ''}</p><pre class="code" id="file-text">${m.text}</pre>`;
      foot = html`<span class="small muted" style="margin-right:auto">If download is blocked, use Copy.</span><button class="btn" data-act="copy-file">Copy</button><button class="btn primary" data-act="download-file">Download</button>`;
      wide = true;
    } else if (m.type === 'review') {
      const r = E.findRecord(m.id);
      const other = S.master.records.get(r.dedup.matchedWith);
      title = 'Possible duplicate';
      body = html`<p style="margin:0">Same NIN as an existing master record from another source. Never merged automatically.</p><div class="grid"><div class="c6 panel"><header><h3>Incoming · ${srcName(r.sourceId)}</h3></header><div class="body"><dl class="kv small"><dt>Source reference</dt><dd>${r.sourceRecordId}</dd><dt>Name</dt><dd>${person(r)}</dd><dt>Date of birth</dt><dd>${maskVal('birth_date', r.canonical.birth_date)}</dd><dt>NIN</dt><dd>${maskVal('nin', r.canonical.nin)}</dd><dt>Household</dt><dd>${r.canonical.nsr_household_serial}</dd></dl></div></div>
        <div class="c6 panel"><header><h3>Existing master record</h3></header><div class="body"><dl class="kv small"><dt>Master ID</dt><dd>${other ? other.masterId : r.dedup.matchedWith}</dd><dt>From</dt><dd>${other ? srcName(other.sourceId) : '—'}</dd><dt>Name</dt><dd>${other ? maskVal('given_name', other.given) + ' …' : '—'}</dd><dt>NIN</dt><dd>${other ? maskVal('nin', other.nin) : '—'}</dd><dt>Version</dt><dd>${other ? other.version : '—'}</dd></dl></div></div></div>`;
      foot = html`<button class="btn" data-act="modal-close">Later</button><button class="btn" data-act="review-decide" data-arg="REJECT" ${dis('error.resolve')}>Reject as duplicate</button><button class="btn primary" data-act="review-decide" data-arg="APPROVE_NEW" ${dis('error.resolve')}>Approve as new</button>`;
    } else if (m.type === 'raw') {
      title = 'View payload';
      body = UI.payloadView ? html`<div class="callout warn small">Unmasked synthetic payload. Access audited.</div><pre class="code">${JSON.stringify(UI.payloadView, null, 2)}</pre>` : html`<p style="margin:0">Restricted. Enter a reason; it is audited.</p><label class="field">Reason<textarea id="raw-just" rows="3" data-bind="modal.just" placeholder="e.g. Ticket DQ-1042">${m.just || ''}</textarea></label>`;
      foot = UI.payloadView ? html`<button class="btn" data-act="modal-close">Close</button>` : html`<button class="btn" data-act="modal-close">Cancel</button><button class="btn primary" data-act="raw-confirm" data-arg="${m.id}">View payload</button>`;
      wide = !!UI.payloadView;
    } else if (m.type === 'health') {
      title = `Connection: ${m.name}`;
      body = html`${checkList(m.steps)}<p class="small muted" style="margin:0">Simulated.</p>`;
      foot = html`<button class="btn" data-act="modal-close">Close</button>`;
    } else if (m.type === 'ack') {
      const g = attentionGroups().find((x) => x.key === m.key);
      title = 'Mark reviewed?';
      body = g ? html`<p style="margin:0"><b>${g.msg.title}</b> · ${srcName(g.sourceId)} · ${g.recordIds.size ? `${num(g.recordIds.size)} record(s)` : 'transfer'}</p><div class="callout warn small">Records the review only. Records are not corrected or written.</div>` : html`<p style="margin:0">Already closed.</p>`;
      foot = html`<button class="btn" data-act="modal-close">Cancel</button>${g ? html`<button class="btn primary" data-act="grp-ack-confirm" data-arg="${m.key}" ${dis('error.resolve')}>Mark reviewed</button>` : ''}`;
    }
    return html`<div class="scrim" data-act="scrim"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${title}"><header><h2>${title}</h2><button class="btn ghost" data-act="modal-close" aria-label="Close">✕</button></header><div class="body">${body}</div><footer>${foot}</footer></div></div>`;
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  function animate(run, after) {
    UI.animating.add(run.id);
    const t = setInterval(() => {
      E.stepRun(run);
      if (run.stageIdx >= run.stages.length || run.fatal || run.blocked) {
        clearInterval(t);
        UI.animating.delete(run.id);
        const r = resultMessage(run);
        toast(`${run.sourceName}: ${r.title || r.text}`, r.tone === 'crit');
        if (after) after(run);
      }
      render();
    }, 380);
  }
  function startScenario(id) {
    const sc = DB.SCENARIOS.find((x) => x.id === id);
    const opts = { mode: sc.mode, scenarioId: id, sim: { ...(sc.sim || {}) } };
    if (sc.file) opts.file = E.sampleFile(sc.file, sc.source);
    const res = E.startRun(sc.source, opts);
    if (res.blocked) { toast(`Blocked: ${srcName(sc.source)} is disabled. Audited.`, true); go('runs', { tview: 'attention', errOpen: null }); return; }
    go('run', { runId: res.id, runTab: 'records', recFilter: 'all' });
    animate(res);
  }
  function offerFile(name, text, note) { UI.modal = { type: 'file', name, text, note }; }
  function templateCsv() {
    const cols = SCHEMA.fields.filter((f) => f.fill === 'source');
    const ex = E.sampleFile('good', 'SRC-LGA-UPLOAD');
    const rows = E.parseCsv(ex.text);
    const idx = Object.fromEntries(rows[0].map((h, i) => [h, i]));
    return DB.toCsv([cols.map((f) => f.name)].concat(rows.slice(1, 3).map((r) => cols.map((f) => (idx[f.name] !== undefined ? r[idx[f.name]] : '')))));
  }
  async function readUpload(file) {
    const w = UI.wiz;
    const head8 = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    const meta = { name: file.name, size: file.size, mime: file.type, headBytes: [...head8] };
    const u = E.validateUpload(meta);
    w.upload = u; w.file = null; w.headerCheck = null; w.dry = null;
    if (!u.ok) { w.file = { ...meta, rejected: true }; render(); return; }
    let rows, text = null;
    if (u.ext === 'csv') { text = await file.text(); rows = E.parseCsv(text); }
    else {
      if (!window.XLSX) { toast('Excel parser unavailable. Upload CSV instead.', true); return; }
      const buf = await file.arrayBuffer();
      const wb = window.XLSX.read(buf, { type: 'array', cellFormula: false, cellHTML: false, cellStyles: false });
      rows = window.XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
    }
    let checksum = null;
    try { const d = await crypto.subtle.digest('SHA-256', await file.arrayBuffer()); checksum = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join(''); } catch (_) { checksum = DB.sha256(text || file.name + file.size); }
    setFile({ ...meta, text, rows, checksum });
    validateNow();
  }
  function setFile(f) {
    const w = UI.wiz;
    const rows = f.rows || E.parseCsv(f.text);
    w.file = { ...f, rows, headers: (rows[0] || []).map(String), preview: rows.slice(1, 11), rowCount: Math.max(0, rows.length - 1) };
    w.headerCheck = E.checkHeaders(w.sourceId, w.file.headers);
    w.dry = null;
  }
  // Choosing a source moves straight to step 2; a single-method source needs no method choice.
  function pickSource(id) {
    const s = E.getSource(id);
    UI.wiz = newWizard();
    UI.wiz.sourceId = id;
    if (!s.enabled) return;
    UI.wiz.step = 2;
    if (s.modes.length === 1) UI.wiz.mode = s.modes[0];
  }
  // Mapping, validation and duplicate checks run as soon as there is something to check. Nothing is written.
  function validateNow() {
    const w = UI.wiz;
    w.dry = E.dryRun(w.sourceId, { mode: w.mode, sim: { ...w.sim }, file: w.file ? engineFile(w.file) : null });
    w.showIssues = false; w.ack = false; w.step = 3;
  }
  const engineFile = (f) => ({ name: f.name, size: f.size, mime: f.mime, headBytes: f.headBytes, text: f.text, rows: f.rows, checksum: f.checksum });
  const findGroup = (key) => attentionGroups().find((g) => g.key === key);
  // Combines per-transfer error reports; each run's header row is kept only once.
  function combinedReport(runIds) {
    const parts = runIds.map((id) => E.runReport(id));
    if (parts.length === 1) return parts[0];
    const lines = [];
    parts.forEach((p, i) => { const ls = p.text.split(/\r?\n/).filter(Boolean); lines.push(...(i ? ls.slice(1) : ls)); });
    return { name: 'error_report_combined.csv', text: lines.join('\n') + '\n' };
  }
  function retrySummary(t) {
    const bits = [`${num(t.delivered)}/${num(t.retried)} written`];
    if (t.dp) bits.push(`${num(t.dp)} duplicate writes prevented`);
    if (t.skipped) bits.push(`${num(t.skipped)} rejected (correct at source)`);
    if (t.retried - t.delivered - t.skipped > 0) bits.push('rest retry automatically');
    return `Retry: ${bits.join(' · ')}.`;
  }
  const checkSummary = (r) => `Reconciled: ${num(r.confirmed)} confirmed · ${num(r.requeued)} resent${r.replicaResync ? ` · ${num(r.replicaResync)} re-sync requested` : ''}. Advance the clock to complete.`;

  const ACTIONS = {
    nav: (p) => { if (p === 'ingest' && UI.page !== 'ingest') UI.wiz = UI.wiz.step > 1 && !UI.wiz.runId ? UI.wiz : newWizard(); go(p, p === 'lineage' ? { recordId: null } : null); },
    tview: (v) => { UI.tview = v; UI.errOpen = null; },
    'nsr-connect': () => nsrRun(nsrLoad),
    'nsr-toggle': (serial) => { const s = UI.nsr.selected; UI.nsr.selected = s.includes(serial) ? s.filter((x) => x !== serial) : s.concat(serial); UI.nsr.preview = null; UI.nsr.confirm = false; },
    'nsr-preview': () => nsrRun(async () => { UI.nsr.result = null; UI.nsr.confirm = false; UI.nsr.preview = await nsrApi('POST', '/preview', { household_serials: UI.nsr.selected }); }),
    'nsr-submit': () => nsrRun(async () => {
      const serials = UI.nsr.selected;
      UI.nsr.result = serials.length === 1
        ? await nsrApi('POST', '/submit', { household_serial: serials[0], confirm: true }, true)
        : await nsrApi('POST', '/submit/batch', { household_serials: serials, confirm: true }, true);
      Object.assign(UI.nsr, { selected: [], preview: null, confirm: false });
      await nsrLoad();
    }),
    'nsr-retry': (id) => nsrRun(async () => { UI.nsr.result = await nsrApi('POST', `/deliveries/${id}/retry`, {}, true); await nsrLoad(); }),
    'nsr-reconcile': (arg) => nsrRun(async () => {
      const [id, outcome] = arg.split('|');
      UI.nsr.result = await nsrApi('POST', `/deliveries/${id}/reconcile`, { outcome, note: UI.nsr.notes[id] || '' }, true);
      await nsrLoad();
    }),
    goto: (t) => {
      const m = { 'errors-dead': ['errors', { tab: 'dead' }], 'errors-retry': ['errors', { tab: 'info', code: 'MASTER_WRITE_FAILED' }], 'errors-review': ['errors', { tab: 'action', code: 'MATCH_REQUIRES_REVIEW' }], 'errors-validation': ['errors', { tab: 'action' }] }[t];
      if (m) go(m[0], { errQ: { ...UI.errQ, code: '', sourceId: '', ...m[1] } }); else go(t);
    },
    'attention-all': () => go('runs', { tview: 'attention', errOpen: null }),
    'attention-source': () => go('runs', { tview: 'attention', errOpen: null }),
    'attention-open': (key) => go('runs', { tview: 'attention', errOpen: key }),
    clock: (ms) => { E.advanceClock(Number(ms)); toast(`Clock +${dur(Number(ms))}. Retries and replication checks ran.`); },
    auto: () => {
      UI.auto = !UI.auto;
      clearInterval(ACTIONS.auto.t);
      if (UI.auto) ACTIONS.auto.t = setInterval(() => { E.advanceClock(5000); render(); }, 1000);
    },
    filter: (arg) => { const [k, v] = arg.split('='); const [obj, key] = k.split('.'); UI[obj][key] = v; },
    run: (id) => go('run', { runId: id, runTab: 'records', recFilter: 'all' }),
    'run-tab': (arg) => { const [id, tab] = arg.split('|'); go('run', { runId: id, runTab: tab }); },
    tab: (t) => { UI.runTab = t; },
    recfilter: (k) => { UI.recFilter = k; },
    sort: (k) => { if (UI.runsQ.sort === k) UI.runsQ.dir *= -1; else { UI.runsQ.sort = k; UI.runsQ.dir = -1; } },
    'retry-run': (id) => { const r = E.retryRecords(id); toast(retrySummary({ retried: r.retried, delivered: r.delivered, dp: r.duplicatesPrevented, skipped: r.skipped.length })); },
    'retry-rec': (id) => { const rec = E.findRecord(id); const r = E.retryRecords(rec.runId, [id]); toast(r.skipped.length ? 'Rejected by registry. Correct at source.' : r.delivered ? `Written${r.duplicatesPrevented ? ' (duplicate write prevented)' : ''}.` : 'Write failed; automatic retry scheduled.', !!r.skipped.length); },
    'retry-all': () => { const t = { retried: 0, delivered: 0, dp: 0, skipped: 0 }; S.runs.forEach((run) => { if (run.records.some((r) => STUCK.includes(r.primary.status))) { const x = E.retryRecords(run.id); t.retried += x.retried; t.delivered += x.delivered; t.dp += x.duplicatesPrevented; t.skipped += x.skipped.length; } }); toast(retrySummary(t)); },
    reconcile: (id) => { toast(checkSummary(E.reconcileRun(id))); },
    report: (id) => { const r = E.runReport(id); offerFile(r.name, r.text, 'Identifiers redacted; formula cells neutralised.'); },
    'grp-toggle': (key) => { UI.errOpen = UI.errOpen === key ? null : key; },
    'grp-retry': (key) => {
      const g = findGroup(key); if (!g) return;
      const t = { retried: 0, delivered: 0, dp: 0, skipped: 0 };
      g.runIds.forEach((runId) => { const ids = [...g.recordIds].filter((id) => { const r = E.findRecord(id); return r && r.runId === runId && STUCK.includes(r.primary.status); }); if (ids.length) { const x = E.retryRecords(runId, ids); t.retried += x.retried; t.delivered += x.delivered; t.dp += x.duplicatesPrevented; t.skipped += x.skipped.length; } });
      toast(retrySummary(t));
    },
    'grp-check': (key) => {
      const g = findGroup(key); if (!g) return;
      const t = { confirmed: 0, requeued: 0, replicaResync: 0 };
      g.runIds.forEach((runId) => { const x = E.reconcileSummary([E.getRun(runId)]); if (x.unknown || x.replicaFailed || x.destinationMismatch) { const r = E.reconcileRun(runId); t.confirmed += r.confirmed; t.requeued += r.requeued; t.replicaResync += r.replicaResync; } });
      toast(checkSummary(t));
    },
    'grp-report': (key) => { const g = findGroup(key); if (!g) return; const r = combinedReport([...g.runIds]); offerFile(r.name, r.text, 'Identifiers redacted; formula cells neutralised.'); },
    'grp-ack': (key) => { UI.modal = { type: 'ack', key }; },
    'grp-ack-confirm': (key) => { const g = findGroup(key); UI.modal = null; if (!g) return; g.errors.forEach((e) => E.resolveError(e.id, 'Marked reviewed from Exceptions')); toast('Marked reviewed. Records unchanged.'); },
    'recon-open': (k) => { if (UI.page !== 'recon' && UI.page !== 'run') go('recon'); UI.reconOpen = k || null; },
    'recon-scope': (id) => { UI.reconScope = id; UI.reconOpen = null; },
    errtab: (t) => { UI.errQ.tab = t; UI.errOpen = null; },
    ack: (id) => { E.resolveError(id, 'Marked as reviewed'); },
    review: (id) => { UI.modal = { type: 'review', id }; },
    'review-decide': (d) => { const r = E.resolveReview(UI.modal.id, d); UI.modal = null; toast(d === 'APPROVE_NEW' ? `Approved as new: ${r.primary.masterId}.` : 'Rejected as duplicate.'); },
    lineage: (id) => go('lineage', { recordId: id }),
    raw: (id) => { UI.payloadView = null; UI.modal = { type: 'raw', id, just: '' }; },
    'raw-confirm': (id) => { UI.payloadView = E.viewRawPayload(id, UI.modal.just || ''); },
    source: (id) => go('sources', { sourceId: id, testResult: null }),
    'source-new': () => { UI.sourceForm = { _new: true, id: 'SRC-', name: '', type: 'State Registry', org: '', description: '', env: 'Development', connection: 'API', layout: 'JOSH_V2', baseUrl: 'https://', endpoint: '/v1/records', method: 'GET', authRef: 'vault://databridge/sources/', pagination: 'offset/limit 100', incremental: 'updated_since watermark', importFormat: '', schemaVersion: 'v1', frequency: 'Manual', enabled: true }; UI.modal = { type: 'source-form' }; },
    'source-edit': (id) => { UI.sourceForm = { ...E.getSource(id), _new: false }; UI.modal = { type: 'source-form' }; },
    'source-save': () => {
      const f = { ...UI.sourceForm };
      const isNew = f._new;
      delete f._new; delete f._error;
      f.modes = f.connection === 'API' ? (isNew ? ['API'] : E.getSource(f.id).modes) : ['IMPORT'];
      if (f.connection === 'IMPORT') { f.baseUrl = ''; f.authRef = '—'; }
      try {
        if (isNew) E.addSource(f);
        else { const { id, createdAt, createdBy, updatedAt, updatedBy, removed, lastSuccessAt, lastFailureAt, health, watermark, ...patch } = f; E.updateSource(id, patch); }
        UI.modal = null; UI.sourceId = f.id; toast(isNew ? `${f.name || 'Source'} added. Check connection next.` : 'Saved.');
      } catch (e) { UI.sourceForm._error = plainError(e); }
    },
    'source-remove': (id) => { UI.modal = { type: 'remove', id }; },
    'source-remove-confirm': (id) => { E.removeSource(id); UI.modal = null; UI.sourceId = null; toast('Source removed. History kept.'); },
    'toggle-source': (id) => { const s = E.getSource(id); E.setSourceEnabled(id, !s.enabled); toast(`${s.name} ${s.enabled ? 'enabled' : 'disabled'}.`); },
    'source-test': (id) => { UI.sourceId = id; UI.testResult = { sourceId: id, ...E.testConnection(id) }; if (UI.page !== 'sources') go('sources'); },
    'ingest-from': (id) => { pickSource(id); go('ingest'); },
    'dest-health': (id) => { const d = S.destinations.find((x) => x.id === id); const name = d.role === 'PRIMARY' ? 'Master Registry 1' : 'Master Registry 2'; UI.modal = { type: 'health', id, name, steps: [['Reachable', d.enabled, d.enabled ? '' : 'Disabled'], ['mTLS certificate', true, ''], [d.role === 'PRIMARY' ? 'Test write (not committed)' : 'Read probe', d.enabled, '']] }; },
    'dest-toggle': () => { E.updateDestination('MASTER_SR1', { enabled: !S.destinations[0].enabled }); toast(S.destinations[0].enabled ? 'Master Registry 1 enabled.' : 'Master Registry 1 disabled. New transfers will fail pre-flight.', !S.destinations[0].enabled); },
    'map-open': (id) => go('mapping', { mapSource: id, mapDraft: null, mapTest: null, mapTab: 'mapping' }),
    maptab: (t) => { UI.mapTab = t; },
    'map-add': () => { UI.mapDraft.rows.push({ sources: [], op: 'trim', arg: null, target: '' }); },
    'map-del': (i) => { UI.mapDraft.rows.splice(Number(i), 1); },
    'map-revert': () => { UI.mapDraft = null; UI.mapTest = null; },
    'map-test': () => { UI.mapTest = E.testMapping(UI.mapSource, UI.mapDraft.rows, Math.floor(Math.random() * 3)); },
    'map-publish': () => { const mp = E.publishMapping(UI.mapSource, UI.mapDraft.rows, UI.mapNote.trim()); UI.mapNote = ''; UI.mapDraft = null; toast(`Mapping v${mp.version} published.`); },
    template: () => offerFile('nsr_import_template.csv', templateCsv(), `CCT template v1: ${SCHEMA.fields.filter((f) => f.fill === 'source').length} columns, 2 synthetic rows.`),
    'wiz-source': (id) => pickSource(id),
    'wiz-mode': (m) => { UI.wiz.mode = m; UI.wiz.file = null; UI.wiz.upload = null; UI.wiz.dry = null; UI.wiz.headerCheck = null; },
    'wiz-step': (n) => { const w = UI.wiz; w.step = Math.max(1, Math.min(3, Number(n))); w.dry = null; w.ack = false; w.showIssues = false; if (w.step <= 2) { w.file = null; w.upload = null; w.headerCheck = null; } if (w.step === 1) w.mode = ''; },
    'wiz-reset': () => { UI.wiz = newWizard(); },
    'wiz-receive': () => validateNow(),
    'wiz-done': () => { UI.wiz = newWizard(); go('home'); },
    'wiz-save': () => { saveRun(E.getRun(UI.wiz.runId)); },
    'wiz-open-nsr': () => { UI.wiz = newWizard(); go('runs', { tview: 'nsr' }); nsrRun(nsrLoad); },
    'wiz-sample': (k) => { const f = E.sampleFile(k, UI.wiz.sourceId); const u = E.validateUpload(f); UI.wiz.upload = u; UI.wiz.dry = null; if (u.ok) { setFile({ ...f, checksum: DB.sha256(f.text) }); validateNow(); } else { UI.wiz.file = { ...f, rejected: true }; UI.wiz.headerCheck = null; } },
    'wiz-issues': () => { UI.wiz.showIssues = !UI.wiz.showIssues; },
    'wiz-report': () => {
      const d = UI.wiz.dry;
      const rows = [['row', 'source_reference', 'problem', 'code']];
      d.records.filter((r) => E.classify(r) !== 'ACCEPTED').forEach((r, i) => { const iss = r.validation.issues.find((x) => x.severity === 'ERROR'); rows.push([i + 1, r.sourceRecordId, recordIssue(r), iss ? iss.code : r.dedup.status]); });
      offerFile('validation_issues.csv', DB.toCsv(rows), 'Excluded records with reasons. Formula cells neutralised.');
    },
    'wiz-start': () => {
      const w = UI.wiz;
      const res = E.startRun(w.sourceId, { mode: w.mode, sim: { ...w.sim }, file: w.file ? engineFile(w.file) : null, approvedBy: S.user, dryRunRef: w.dry ? w.dry.dryRunId : null });
      if (res.blocked) { toast(`Blocked: ${srcName(w.sourceId)} is disabled.`, true); return; }
      w.runId = res.id;
      animate(res);
    },
    scenario: (id) => startScenario(id),
    'modal-close': () => { UI.modal = null; UI.payloadView = null; },
    scrim: (_, el, ev) => { if (ev.target === el) { UI.modal = null; UI.payloadView = null; } },
    'copy-file': () => { const t = UI.modal.text; navigator.clipboard.writeText(t).then(() => toast('Copied.'), () => { const sel = window.getSelection(); const r = document.createRange(); r.selectNodeContents(document.getElementById('file-text')); sel.removeAllRanges(); sel.addRange(r); toast('Copy blocked. Text selected: press Ctrl+C.'); }); },
    'download-file': () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([UI.modal.text], { type: 'text/csv' })); a.download = UI.modal.name; document.body.appendChild(a); a.click(); a.remove(); },
  };

  // ---------------------------------------------------------------------------
  // Binding + events
  // ---------------------------------------------------------------------------
  function setPath(obj, path, val) {
    const ks = path.split('.');
    let o = obj;
    ks.slice(0, -1).forEach((k) => { if (o[k] === undefined) o[k] = {}; o = o[k]; });
    o[ks[ks.length - 1]] = val;
  }
  function coerce(el) {
    const t = el.dataset.type;
    if (t === 'check') return el.checked;
    if (t === 'bool') return el.value === 'true';
    if (t === 'num') return Number(el.value) || 0;
    if (t === 'list') return el.value.split(',').map((x) => x.trim()).filter(Boolean);
    return el.value;
  }
  let liveTimer;
  document.addEventListener('input', (e) => {
    const el = e.target.closest('[data-bind]');
    if (!el) return;
    setPath(UI, el.dataset.bind, coerce(el));
    if (el.dataset.live !== undefined) { clearTimeout(liveTimer); liveTimer = setTimeout(render, 160); }
  });
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.id === 'wiz-file' && el.files[0]) { readUpload(el.files[0]).then(render).catch((err) => { toast(plainError(err), true); render(); }); return; }
    if (el.dataset.bind) { setPath(UI, el.dataset.bind, coerce(el)); if (el.dataset.rerender !== undefined || el.type === 'checkbox' || el.tagName === 'SELECT') render(); return; }
    const k = el.dataset.change;
    if (!k) return;
    try {
      if (k === 'role') { E.setRole(el.value); UI.page = allowedPage(UI.page); toast(`Acting as ${roleName(el.value)}.`); }
      else if (k === 'filter' || k === 'bind') setPath(UI, el.dataset.key, el.value);
      else if (k === 'map-source') { UI.mapSource = el.value; UI.mapDraft = null; UI.mapTest = null; }
      else if (k === 'maxattempts') { E.updateDestination('MASTER_SR1', { retry: { ...S.destinations[0].retry, maxAttempts: Number(el.value) } }); toast(`Max attempts: ${el.value}.`); }
    } catch (err) { toast(plainError(err), true); }
    render();
  });
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const fn = ACTIONS[el.dataset.act];
    if (!fn) return;
    if (el.dataset.act !== 'scrim') e.preventDefault();
    try { fn(el.dataset.arg, el, e); } catch (err) { toast(plainError(err), true); }
    render();
  });
  document.addEventListener('dragover', (e) => { const d = e.target.closest && e.target.closest('#drop'); if (d) { e.preventDefault(); d.classList.add('over'); } });
  document.addEventListener('dragleave', (e) => { const d = e.target.closest && e.target.closest('#drop'); if (d) d.classList.remove('over'); });
  document.addEventListener('drop', (e) => { const d = e.target.closest && e.target.closest('#drop'); if (!d) return; e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) readUpload(f).then(render).catch((err) => { toast(plainError(err), true); render(); }); });
  // Remember open/closed expandable sections across re-renders. 'toggle' does not bubble, so capture it.
  document.addEventListener('toggle', (e) => { const k = e.target.dataset && e.target.dataset.key; if (k) UI.openDetails.set(k, e.target.open); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && UI.modal) { UI.modal = null; UI.payloadView = null; render(); } });

  const tip = document.getElementById('tip');
  document.addEventListener('mousemove', (e) => {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (!el) { tip.hidden = true; return; }
    tip.textContent = el.getAttribute('data-tip');
    tip.hidden = false;
    const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
    tip.style.left = x + 'px';
    tip.style.top = (e.clientY + 14) + 'px';
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const PAGE_FN = { home: pageHome, settings: pageSettings, runs: pageRuns, run: pageRun, errors: pageErrors, recon: pageRecon, sources: pageSources, destinations: pageDestinations, ingest: pageIngest, mapping: pageMapping, quality: pageQuality, lineage: pageLineage, audit: pageAudit, security: pageSecurity, architecture: pageArchitecture };
  function render() {
    const active = document.activeElement;
    const focusId = active && active.id;
    const selStart = active && 'selectionStart' in active ? active.selectionStart : null;
    let content;
    UI.page = allowedPage(UI.page);
    try { content = PAGE_FN[UI.page](); } catch (err) { console.error(err); content = html`<div class="callout crit"><b>This view failed to render.</b> ${err.message}</div>`; }
    document.getElementById('app').innerHTML = shell(content).s;
    const arch = document.getElementById('arch-static');
    if (arch) { const on = UI.page === 'architecture'; arch.classList.toggle('offstage', !on); arch.setAttribute('aria-hidden', String(!on)); }
    if (focusId) {
      const el = document.getElementById(focusId);
      if (el && el !== document.activeElement) { el.focus(); try { if (selStart !== null) el.setSelectionRange(selStart, selStart); } catch (_) { /* not a text input */ } }
    }
  }
  const startPage = (location.hash || '').replace('#', '');
  if (PAGE_FN[startPage] && startPage !== 'run') UI.page = allowedPage(startPage);
  render();

  // Mermaid fallback for local file viewing (hosted artifacts render Mermaid natively).
  setTimeout(() => {
    const pres = [...document.querySelectorAll('#arch-static pre.mermaid')];
    if (!pres.length || pres.some((p) => p.querySelector('svg')) || document.querySelector('#arch-static svg')) return;
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/mermaid/10.9.1/mermaid.min.js';
    s.onload = () => { try { window.mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict' }); window.mermaid.run({ nodes: pres }); } catch (e) { console.warn(e); } };
    document.head.appendChild(s);
  }, 3500);
})();
