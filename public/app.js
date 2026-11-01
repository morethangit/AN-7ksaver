const $ = (id) => document.getElementById(id);
const CATEGORIES = ['dinner','activity','treat','groceries','shopping','entertainment','other','gas'];
const COLORS = ['#e0457b', '#2f80ed'];
const money = (c) => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toCents = (s) => {
  const t = String(s).replace(/[$,\s]/g, '');
  if (!/^\d*\.?\d{0,2}$/.test(t) || t === '' || t === '.') return NaN;
  return Math.round(Number(t) * 100);
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const needAmount = (s) => { const c = toCents(s); if (!Number.isFinite(c) || c <= 0) throw new Error('Enter an amount like 25 or 25.50'); return c; };

async function api(path, method = 'GET', body) {
  const r = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || r.statusText), { status: r.status });
  return data;
}
const fail = (e) => { $('err').textContent = e.message; };

/** Replace a <select>'s options but keep what the user had picked, so a refresh never undoes a choice. */
function setOptions(sel, html) {
  const keep = sel.value;
  sel.innerHTML = html;
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

let state;
async function load({ quiet = false } = {}) {
  if (!quiet) $('err').textContent = '';
  try { state = await api('/api/state'); }
  catch (e) {
    if (e.status === 401) { $('login').hidden = false; $('game').hidden = true; state = null; return; }
    return quiet ? undefined : fail(e);
  }
  $('login').hidden = true; $('game').hidden = false;
  render();
}

function render() {
  const { standings, settings, status, me } = state;
  const goal = settings.milestone_cents;
  const open = status === 'open';
  const banner = status === 'prelaunch' ? `Game starts in ${state.days_to_start} day${state.days_to_start === 1 ? '' : 's'} (${settings.start_date}). Logging opens then.`
    : status === 'ended' ? 'The game is over!' : `${state.days_to_end} day${state.days_to_end === 1 ? '' : 's'} left`;
  $('actions').hidden = !open;

  const w = state.result;
  $('winner').hidden = !w;
  if (w) $('winner').innerHTML = w.tie ? `<div class="big">🤝 It's a tie at ${money(w.saved_cents)}</div>`
    : `<div class="big">🏆 ${esc(w.name)} wins!</div><div>saved ${money(w.saved_cents)}, ahead by ${money(w.margin_cents)}</div>`;

  $('board').innerHTML = `<div class="mute">${esc(banner)}</div>` + standings.map((p, i) => `
    <div style="margin-top:12px"><div class="row"><b>${i === 0 && p.saved_cents > 0 ? '👑 ' : ''}${esc(p.name)}${p.id === me ? ' (you)' : ''}</b>
    <span class="big">${money(p.saved_cents)}</span></div>
    <div class="bar"><i style="width:${Math.max(0, Math.min(100, p.saved_cents / goal * 100))}%"></i></div>
    <div class="mute">${p.hit_milestone ? '🎉 Hit the ' + money(goal) + ' milestone! ' : ''}${money(goal)} milestone · gas ${money(p.gas_cents)} (doesn't count)</div></div>`).join('') +
    (standings.length > 1 && !w ? `<div class="mute" style="margin-top:12px">${standings[0].saved_cents === standings[1].saved_cents ? 'All tied up' : esc(standings[0].name) + ' leads by ' + money(state.leader_gap_cents)}</div>` : '');

  const names = Object.fromEntries(standings.map((p) => [p.id, p.name]));
  renderChart(names);
  renderDates(names);
  renderRps(names);
  renderFeed(names);
}

function renderChart(names) {
  const pts = state.series;
  $('chartCard').hidden = pts.length < 2;
  if (pts.length < 2) return;
  const ids = state.standings.map((p) => p.id).sort((a, b) => a - b);
  const all = pts.flatMap((p) => ids.map((id) => p.balances[id] ?? 0)).concat(0);
  const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1;
  const W = 300, H = 120, pad = 6;
  const x = (i) => pad + (i / (pts.length - 1)) * (W - 2 * pad);
  const y = (v) => H - pad - ((v - lo) / span) * (H - 2 * pad);
  const lines = ids.map((id, k) => `<polyline fill="none" stroke="${COLORS[k % 2]}" stroke-width="2.5" stroke-linejoin="round" points="${pts.map((p, i) => `${x(i).toFixed(1)},${y(p.balances[id] ?? 0).toFixed(1)}`).join(' ')}"/>`).join('');
  $('chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Saved over time"><line x1="${pad}" x2="${W - pad}" y1="${y(0)}" y2="${y(0)}" stroke="currentColor" opacity=".2" stroke-dasharray="3 3"/>${lines}</svg>`;
  $('legend').innerHTML = ids.map((id, k) => `<span class="dot" style="background:${COLORS[k % 2]}"></span>${esc(names[id])}`).join('') + ` · ${esc(pts[0].day)} to ${esc(pts[pts.length - 1].day)}`;
}

/** Fold the two halves of an immunity split into one line; everything else stays as is. */
function feedItems() {
  const items = [], seen = new Map();
  for (const f of state.feed) {
    if (f.kind === 'spend' && f.split_group) {
      const g = seen.get(f.split_group);
      if (g) { g.halves.push(f); g.total += f.amount_cents; g.edited ||= f.edited; continue; }
      const item = { ...f, kind: 'split', halves: [f], total: f.amount_cents };
      seen.set(f.split_group, item); items.push(item);
    } else items.push(f);
  }
  return items;
}

function renderFeed(names) {
  const { me, status } = state;
  $('feed').innerHTML = feedItems().map((f) => {
    const split = f.kind === 'split';
    const mineRow = split ? f.halves.find((h) => h.player_id === me) : (f.player_id === me ? f : null);
    const can = mineRow && status === 'open';
    const kind = f.kind === 'deposit' ? 'deposit' : 'spend';
    const who = split ? f.halves.map((h) => esc(names[h.player_id])).join(' &amp; ') : esc(names[f.player_id]);
    const what = f.kind === 'deposit' ? 'saved' : `spent (${esc(f.category)}${split ? ', split' : ''})`;
    const halves = split ? `<div class="split">${f.halves.map((h) => `${esc(names[h.player_id])} ${money(h.amount_cents)}`).join(' · ')}</div>` : '';
    const viaTxt = f.via === 'rps' ? ' <span class="badge">RPS win</span>' : '';
    const warn = f.kind !== 'deposit' && !f.texted_first && !f.is_gas ? ' <span class="badge">no text first</span>' : '';
    return `<li><div class="row"><span><b>${who}</b> ${what} ${money(split ? f.total : f.amount_cents)}
      ${f.edited ? '<span class="badge">edited</span>' : ''}${viaTxt}${warn}</span>
      ${can ? `<span class="acts"><button class="ghost" data-edit="${kind}:${mineRow.id}">edit</button><button class="ghost" data-del="${kind}:${mineRow.id}">delete</button></span>` : ''}</div>
      ${halves}<div class="mute">${esc(f.note || '')} ${new Date(f.created_at).toLocaleDateString()}</div></li>`;
  }).join('') || '<li class="mute">Nothing yet.</li>';
}

const EMOJI = { rock: '🪨', paper: '📄', scissors: '✂️' };
function renderRps(names) {
  const { rps, me, status } = state;
  const open = status === 'open';
  const cur = rps.find((r) => !r.resolved);
  const done = rps.filter((r) => r.resolved);
  if (cur) {
    $('rpsInfo').innerHTML = `<div><b>${esc(cur.topic)}</b>${cur.ties ? ` <span class="badge">${cur.ties} tie${cur.ties > 1 ? 's' : ''}, go again</span>` : ''}</div>` +
      (cur.i_moved ? `<div class="mute">Locked in. Waiting for the other person…</div>`
        : `<div class="row" style="margin:8px 0">${['rock','paper','scissors'].map((m) => `<button data-move="${cur.id}:${m}" style="width:32%">${EMOJI[m]}<br>${m}</button>`).join('')}</div>` +
          (cur.they_moved ? '<div class="mute">They have picked. Your turn.</div>' : ''))
      + (open ? `<button class="ghost" data-rpscancel="${cur.id}">cancel round</button>` : '');
  } else $('rpsInfo').innerHTML = '';
  $('rpsForm').hidden = !(open && !cur);
  $('rpsHist').innerHTML = done.slice(0, 5).map((r) => {
    const wm = r.winner_id === r.p1_id ? r.p1_move : r.p2_move, lm = r.winner_id === r.p1_id ? r.p2_move : r.p1_move;
    return `<li><b>${esc(r.topic)}</b><div class="mute">${esc(names[r.winner_id])}'s ${EMOJI[wm]} beats ${EMOJI[lm]} · ${esc(names[r.winner_id])} picks &amp; pays${r.used ? ' · spend logged' : ''}</div></li>`;
  }).join('');
  const mine = done.filter((r) => r.winner_id === me && !r.used);
  setOptions($('spRps'), '<option value="">Not an RPS win</option>' + mine.map((r) => `<option value="${r.id}">I won RPS: ${esc(r.topic)}</option>`).join(''));
  $('spRps').hidden = !mine.length;
}

function renderDates(names) {
  const { open_date: od, next_planner_id: turn, me, status, dates } = state;
  const open = status === 'open';
  const scopeTxt = (d) => d.scope.map((x) => (x === 'treat' ? 'sweet treat' : x)).join(' + ');
  if (od) {
    $('dateInfo').innerHTML = `<div><b>${esc(od.title)}</b> <span class="mute">planned by ${esc(names[od.planner_id])}</span></div>
      <div class="mute">${esc(scopeTxt(od))}${od.budget_cap_cents ? ' · cap ' + money(od.budget_cap_cents) : ''}${od.planned_for ? ' · ' + esc(String(od.planned_for).slice(0, 10)) : ''}${od.edited ? ' <span class="badge">edited</span>' : ''}</div>
      ${open ? `<button class="ghost" data-dstatus="done:${od.id}">✓ done</button><button class="ghost" data-dstatus="skipped:${od.id}">skip</button>` : ''}`;
  } else {
    $('dateInfo').innerHTML = `<div>${turn === me ? "It's <b>your</b> turn to plan a date." : `Waiting on <b>${esc(names[turn])}</b> to plan the next date.`}</div>`;
  }
  $('dateForm').hidden = !(open && !od && turn === me);
  $('dateHist').innerHTML = dates.filter((d) => d.status !== 'planned').map((d) =>
    `<li><b>${esc(d.title)}</b> <span class="badge">${d.status}</span><div class="mute">${esc(names[d.planner_id])} · ${esc(scopeTxt(d))}</div></li>`).join('');
  setOptions($('spDate'), '<option value="">Not part of a date</option>' + (od ? `<option value="${od.id}">Date: ${esc(od.title)}</option>` : ''));
}

const url = (kind, id) => `/api/${kind === 'deposit' ? 'deposits' : 'spends'}?id=${id}`;
const run = async (fn, e) => { $('err').textContent = ''; try { await fn(e); await load(); } catch (x) { fail(x); } };
// Form submits and button handlers: stop the browser's own submit/navigation.
const guard = (fn) => (e) => { e?.preventDefault?.(); return run(fn, e); };
// Delegated clicks on a whole card: must NOT preventDefault, or checkboxes and submit buttons inside it stop working.
// `pick` returns the clicked action element (or null to ignore the click).
const delegate = (pick, fn) => (e) => { const el = pick(e); return el ? run(() => fn(el, e)) : undefined; };

$('login').onsubmit = guard(async () => { await api('/api/login', 'POST', { name: $('who').value, pin: $('pin').value }); $('pin').value = ''; });
$('out').onclick = guard(() => api('/api/login', 'DELETE'));
$('snap').onclick = guard(async () => { await api('/api/snapshot', 'POST'); alert('Snapshot saved.'); });
$('depForm').onsubmit = guard(async (e) => {
  await api('/api/deposits', 'POST', { amount_cents: needAmount($('depAmt').value), note: $('depNote').value }); e.target.reset();
});
$('spendForm').onsubmit = guard(async (e) => {
  const rps = $('spRps').value;
  await api('/api/spends', 'POST', {
    amount_cents: needAmount($('spAmt').value), category: $('spCat').value, note: $('spNote').value, texted_first: $('spText').checked,
    via: rps ? 'rps' : $('spSplit').checked ? 'immunity' : 'solo', rps_round_id: rps ? Number(rps) : undefined,
    date_id: $('spDate').value ? Number($('spDate').value) : null,
  });
  e.target.reset();
});
$('feed').onclick = delegate((e) => e.target.closest('[data-del],[data-edit]'), async (el) => {
  const del = el.dataset.del, edit = el.dataset.edit;
  if (del) {
    const [k, id] = del.split(':');
    if (confirm('Delete this entry? It stays in the history.')) await api(url(k, id), 'DELETE');
  }
  if (edit) {
    const [k, id] = edit.split(':');
    const item = feedItems().find((f) => (f.kind === 'split' ? f.halves : [f]).some((r) => r.id === Number(id) && (k === 'deposit') === (f.kind === 'deposit')));
    const total = item.kind === 'split' ? item.total : item.amount_cents;
    const amt = prompt(item.kind === 'split' ? 'Total bill (split 50/50)' : 'Amount', (total / 100).toFixed(2)); if (amt === null) return;
    const note = prompt('Note', item.note ?? ''); if (note === null) return;
    await api(url(k, id), 'PATCH', { amount_cents: needAmount(amt), note });
  }
});

$('rpsForm').onsubmit = guard(async (e) => { await api('/api/rps', 'POST', { topic: $('rpsTopic').value }); e.target.reset(); });
$('rpsCard').onclick = delegate((e) => e.target.closest('[data-move],[data-rpscancel]'), async (el) => {
  if (el.dataset.move) { const [id, move] = el.dataset.move.split(':'); await api(`/api/rps?id=${id}`, 'PATCH', { move }); }
  if (el.dataset.rpscancel && confirm('Cancel this round?')) await api(`/api/rps?id=${el.dataset.rpscancel}`, 'DELETE');
});

$('dateForm').onsubmit = guard(async (e) => {
  const scope = [...e.target.querySelectorAll('input[name=scope]:checked')].map((c) => c.value);
  const cap = $('dtCap').value.trim();
  await api('/api/dates', 'POST', { title: $('dtTitle').value, scope, budget_cap_cents: cap ? needAmount(cap) : null, planned_for: $('dtDay').value || null });
  e.target.reset();
});
$('dateCard').onclick = delegate((e) => e.target.closest('[data-dstatus]'), async (el) => {
  const [status, id] = el.dataset.dstatus.split(':');
  if (confirm(`Mark this date as ${status}?`)) await api(`/api/dates?id=${id}`, 'PATCH', { status });
});

$('spCat').innerHTML = CATEGORIES.map((c) => `<option value="${c}">${c}${c === 'gas' ? ' (doesn\'t count)' : ''}</option>`).join('');
load();
// Pick up the other person's changes without a manual refresh.
setInterval(() => { if (state && !document.hidden) load({ quiet: true }); }, 20000);
document.addEventListener('visibilitychange', () => { if (state && !document.hidden) load({ quiet: true }); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
