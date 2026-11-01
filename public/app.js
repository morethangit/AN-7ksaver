const $ = (id) => document.getElementById(id);
const CATEGORIES = ['dinner','activity','treat','groceries','shopping','entertainment','other','gas'];
const money = (c) => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toCents = (s) => { const n = Number(String(s).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : NaN; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

async function api(path, method = 'GET', body) {
  const r = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || r.statusText), { status: r.status });
  return data;
}
const fail = (e) => { $('err').textContent = e.message; };

let state;
async function load() {
  $('err').textContent = '';
  try { state = await api('/api/state'); }
  catch (e) { if (e.status === 401) { $('login').hidden = false; $('game').hidden = true; return; } return fail(e); }
  $('login').hidden = true; $('game').hidden = false;
  render();
}

function render() {
  const { standings, settings, status, me } = state;
  const goal = settings.milestone_cents;
  const banner = status === 'prelaunch' ? `Game starts in ${state.days_to_start} days (${settings.start_date}). Logging opens then.`
    : status === 'ended' ? 'The game is over!' : `${state.days_to_end} days left`;
  $('board').innerHTML = `<div class="mute">${esc(banner)}</div>` + standings.map((p, i) => `
    <div style="margin-top:12px"><div class="row"><b>${i === 0 && p.saved_cents > 0 ? '👑 ' : ''}${esc(p.name)}${p.id === me ? ' (you)' : ''}</b>
    <span class="big">${money(p.saved_cents)}</span></div>
    <div class="bar"><i style="width:${Math.max(0, Math.min(100, p.saved_cents / goal * 100))}%"></i></div>
    <div class="mute">${p.hit_milestone ? '🎉 Hit the ' + money(goal) + ' milestone! ' : ''}${money(goal)} milestone · gas ${money(p.gas_cents)} (doesn't count)</div></div>`).join('') +
    (standings.length > 1 ? `<div class="mute" style="margin-top:12px">${esc(standings[0].name)} leads by ${money(state.leader_gap_cents)}</div>` : '');

  const names = Object.fromEntries(standings.map((p) => [p.id, p.name]));
  $('feed').innerHTML = state.feed.map((f) => {
    const mine = f.player_id === me && status === 'open' && !f.split_group;
    const what = f.kind === 'deposit' ? 'saved' : `spent (${esc(f.category)}${f.via === 'immunity' ? ', split' : ''})`;
    const warn = f.kind === 'spend' && !f.texted_first && !f.is_gas ? '<span class="badge">no text first</span>' : '';
    return `<li><div class="row"><span><b>${esc(names[f.player_id])}</b> ${what} ${money(f.amount_cents)}
      ${f.edited ? '<span class="badge">edited</span>' : ''}${warn}</span>
      ${mine ? `<span><button class="ghost" data-edit="${f.kind}:${f.id}">edit</button><button class="ghost" data-del="${f.kind}:${f.id}">delete</button></span>` : ''}</div>
      <div class="mute">${esc(f.note || '')} ${new Date(f.created_at).toLocaleDateString()}</div></li>`;
  }).join('') || '<li class="mute">Nothing yet.</li>';
}

const url = (kind, id) => `/api/${kind === 'deposit' ? 'deposits' : 'spends'}?id=${id}`;
const guard = (fn) => async (e) => { e?.preventDefault?.(); try { await fn(e); await load(); } catch (x) { fail(x); } };

$('login').onsubmit = guard(async () => { await api('/api/login', 'POST', { name: $('who').value, pin: $('pin').value }); $('pin').value = ''; });
$('out').onclick = guard(() => api('/api/login', 'DELETE'));
$('snap').onclick = guard(async () => { await api('/api/snapshot', 'POST'); alert('Snapshot saved.'); });
$('depForm').onsubmit = guard(async (e) => {
  const amount_cents = toCents($('depAmt').value);
  await api('/api/deposits', 'POST', { amount_cents, note: $('depNote').value }); e.target.reset();
});
$('spendForm').onsubmit = guard(async (e) => {
  const amount_cents = toCents($('spAmt').value);
  await api('/api/spends', 'POST', { amount_cents, category: $('spCat').value, note: $('spNote').value, texted_first: $('spText').checked, via: $('spSplit').checked ? 'immunity' : 'solo' });
  e.target.reset();
});
$('feed').onclick = guard(async (e) => {
  const del = e.target.dataset.del, edit = e.target.dataset.edit;
  if (del) { const [k, id] = del.split(':'); if (confirm('Delete this entry? (It stays in the history.)')) await api(url(k, id), 'DELETE'); }
  if (edit) {
    const [k, id] = edit.split(':'); const cur = state.feed.find((f) => f.kind === k && f.id === Number(id));
    const amt = prompt('Amount', (cur.amount_cents / 100).toFixed(2)); if (amt === null) return;
    const note = prompt('Note', cur.note ?? ''); if (note === null) return;
    await api(url(k, id), 'PATCH', { amount_cents: toCents(amt), note });
  }
});

$('spCat').innerHTML = CATEGORIES.map((c) => `<option value="${c}">${c}${c === 'gas' ? ' (doesn\'t count)' : ''}</option>`).join('');
load();
