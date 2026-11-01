// Pure game logic: no I/O, so it is unit-tested directly (test/game.test.mjs).
// All money is integer cents.

export const CATEGORIES = [
  'dinner', 'activity', 'treat', 'groceries',
  'shopping', 'entertainment', 'other', 'gas',
];

/** Gas never counts toward the game. */
export const isGas = (category) => category === 'gas';

/** Odd cent goes to the first element (the person logging it). */
export function splitCents(total) {
  const a = Math.ceil(total / 2);
  return [a, total - a];
}

/**
 * saved = starting + deposits - non-gas spends. Soft-deleted rows are ignored.
 * Gas is tallied separately so it stays visible but never moves the score.
 */
export function computeBalances({ players, deposits, spends }) {
  const out = {};
  for (const p of players) {
    out[p.id] = {
      id: p.id, name: p.name,
      deposited_cents: 0, spent_cents: 0, gas_cents: 0,
      saved_cents: p.starting_cents ?? 0,
    };
  }
  for (const d of deposits) {
    if (d.deleted_at || !out[d.player_id]) continue;
    out[d.player_id].deposited_cents += d.amount_cents;
    out[d.player_id].saved_cents += d.amount_cents;
  }
  for (const s of spends) {
    if (s.deleted_at || !out[s.player_id]) continue;
    if (s.is_gas) { out[s.player_id].gas_cents += s.amount_cents; continue; }
    out[s.player_id].spent_cents += s.amount_cents;
    out[s.player_id].saved_cents -= s.amount_cents;
  }
  return out;
}

/** start_date inclusive, end_date exclusive (end = first day of fall classes). Dates are 'YYYY-MM-DD' (UTC). */
export function gameStatus(settings, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  if (today < settings.start_date) return 'prelaunch';
  if (today >= settings.end_date) return 'ended';
  return 'open';
}

export function daysUntil(dateStr, now = new Date()) {
  const today = Date.parse(now.toISOString().slice(0, 10));
  return Math.round((Date.parse(dateStr) - today) / 86400000);
}

const isCents = (n) => Number.isInteger(n) && n > 0 && n <= 100_000_00;
const cleanNote = (n) => (typeof n === 'string' && n.trim() ? n.trim().slice(0, 280) : null);

export function validateDeposit(body) {
  if (!isCents(body?.amount_cents)) return { error: 'amount_cents must be a positive whole number of cents' };
  return { row: { amount_cents: body.amount_cents, note: cleanNote(body.note) } };
}

/**
 * Turns a request into the row(s) to insert.
 *  - solo: the actor's idea, the actor pays.
 *  - immunity: both said it at once; whole bill split 50/50, odd cent to the logger.
 *  - rps: not built yet (phase 5).
 */
export function validateSpend(body, actorId, otherId) {
  if (!isCents(body?.amount_cents)) return { error: 'amount_cents must be a positive whole number of cents' };
  if (!CATEGORIES.includes(body.category)) return { error: `category must be one of: ${CATEGORIES.join(', ')}` };
  const via = body.via ?? 'solo';
  if (via === 'rps') return { error: 'rock-paper-scissors spends are not available yet', status: 501 };
  if (via !== 'solo' && via !== 'immunity') return { error: 'via must be solo or immunity' };

  const base = {
    category: body.category,
    note: cleanNote(body.note),
    texted_first: body.texted_first === true,
    is_gas: isGas(body.category),
    via,
    date_id: Number.isInteger(body.date_id) ? body.date_id : null,
    split_group: null,
  };
  if (via === 'solo') {
    return { rows: [{ ...base, player_id: actorId, proposed_by: actorId, amount_cents: body.amount_cents }] };
  }
  const group = globalThis.crypto.randomUUID();
  const [mine, theirs] = splitCents(body.amount_cents);
  return {
    rows: [
      { ...base, split_group: group, player_id: actorId, proposed_by: actorId, amount_cents: mine },
      { ...base, split_group: group, player_id: otherId, proposed_by: otherId, amount_cents: theirs },
    ],
  };
}

// ---- Dates -----------------------------------------------------------------

export const DATE_SCOPES = ['dinner', 'activity', 'treat'];

/**
 * Dates alternate, starting with the coin-flip winner. A skipped date does not
 * pass the turn: the same person plans again. `dates` = live (non-deleted) rows.
 */
export function nextPlanner(firstPlannerId, dates, playerIds) {
  const first = playerIds.includes(firstPlannerId) ? firstPlannerId : playerIds[0];
  const other = playerIds.find((id) => id !== first);
  const taken = dates.filter((d) => d.status !== 'skipped').length;
  return taken % 2 === 0 ? first : other;
}

const validDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/** A date must be defined up front: a title and a scope of dinner and/or activity and/or treat. */
export function validateDate(body) {
  const title = typeof body?.title === 'string' ? body.title.trim().slice(0, 120) : '';
  if (!title) return { error: 'title is required' };
  const scope = Array.isArray(body.scope) ? [...new Set(body.scope)] : [];
  if (!scope.length || !scope.every((s) => DATE_SCOPES.includes(s))) {
    return { error: `scope must include at least one of: ${DATE_SCOPES.join(', ')}` };
  }
  let cap = null;
  if (body.budget_cap_cents != null) {
    if (!isCents(body.budget_cap_cents)) return { error: 'budget_cap_cents must be a positive whole number of cents' };
    cap = body.budget_cap_cents;
  }
  if (body.planned_for != null && !validDay(body.planned_for)) return { error: 'planned_for must be YYYY-MM-DD' };
  return { row: { title, scope, budget_cap_cents: cap, planned_for: body.planned_for ?? null } };
}

/** A spend tied to a date must fall inside what the date was planned to cover. */
export function checkSpendAgainstDate(category, date) {
  if (!date || date.deleted_at) return 'that date does not exist';
  if (date.status === 'skipped') return 'that date was skipped';
  if (!date.scope.includes(category)) return `that date's scope is ${date.scope.join(' + ')}, not ${category}`;
  return null;
}
