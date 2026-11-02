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

export const DEFAULT_TZ = 'America/New_York';

/** Today's calendar date ('YYYY-MM-DD') where the players live, not in UTC. */
export function todayIn(tz = DEFAULT_TZ, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz || DEFAULT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** start_date inclusive, end_date exclusive (end = first day of fall classes), judged in settings.timezone. */
export function gameStatus(settings, now = new Date()) {
  const today = todayIn(settings.timezone, now);
  if (today < settings.start_date) return 'prelaunch';
  if (today >= settings.end_date) return 'ended';
  return 'open';
}

export function daysUntil(dateStr, now = new Date(), tz = DEFAULT_TZ) {
  return Math.round((Date.parse(dateStr) - Date.parse(todayIn(tz, now))) / 86400000);
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
 *  - rps: the winner of a resolved round picks and pays (checked against the round by the API).
 */
export function validateSpend(body, actorId, otherId) {
  if (!isCents(body?.amount_cents)) return { error: 'amount_cents must be a positive whole number of cents' };
  if (!CATEGORIES.includes(body.category)) return { error: `category must be one of: ${CATEGORIES.join(', ')}` };
  const via = body.via ?? 'solo';
  if (!['solo', 'immunity', 'rps'].includes(via)) return { error: 'via must be solo, immunity or rps' };
  if (via === 'rps' && !Number.isInteger(body.rps_round_id)) return { error: 'rps_round_id is required for an rps spend' };

  const base = {
    category: body.category,
    note: cleanNote(body.note),
    texted_first: body.texted_first === true,
    is_gas: isGas(body.category),
    via,
    date_id: Number.isInteger(body.date_id) ? body.date_id : null,
    split_group: null,
    rps_round_id: via === 'rps' ? body.rps_round_id : null,
  };
  if (via === 'solo' || via === 'rps') {
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

// ---- Rock-paper-scissors ---------------------------------------------------

export const MOVES = ['rock', 'paper', 'scissors'];
const BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

/** 'p1' | 'p2' | 'tie' (p1 = the lower player id). */
export function rpsOutcome(m1, m2) {
  if (!MOVES.includes(m1) || !MOVES.includes(m2)) throw new Error('both moves are required');
  if (m1 === m2) return 'tie';
  return BEATS[m1] === m2 ? 'p1' : 'p2';
}

/**
 * What a player is allowed to see. An unresolved round NEVER includes either
 * move, only who has picked, so the second picker cannot be influenced.
 */
export function sanitizeRound(r, me, p1Id) {
  const base = { id: r.id, topic: r.topic, started_by: r.started_by, ties: r.ties };
  if (r.resolved_at) {
    return { ...base, resolved: true, p1_id: p1Id, p1_move: r.p1_move, p2_move: r.p2_move, winner_id: r.winner_id, used: Boolean(r.used) };
  }
  const [mine, theirs] = me === p1Id ? [r.p1_move, r.p2_move] : [r.p2_move, r.p1_move];
  return { ...base, resolved: false, i_moved: Boolean(mine), they_moved: Boolean(theirs) };
}

/** Only the winner of a finished round can log its spend, and only once. Returns an error string or null. */
export function checkRpsRound(round, actorId, alreadyUsed) {
  if (!round || round.cancelled_at) return 'that rock-paper-scissors round does not exist';
  if (!round.resolved_at) return 'that round has not been decided yet';
  if (round.winner_id !== actorId) return 'only the winner of the round picks and pays';
  if (alreadyUsed) return 'that round has already been used for a spend';
  return null;
}

export const cleanTopic = (t) => (typeof t === 'string' ? t.trim().slice(0, 120) : '');

// ---- Results & charts ------------------------------------------------------

/** Cumulative saved balance per player at the end of each day that had activity (for the trend chart). */
export function balanceSeries({ players, deposits, spends }) {
  const events = [];
  for (const d of deposits) if (!d.deleted_at) events.push({ t: new Date(d.created_at), id: d.player_id, delta: d.amount_cents });
  for (const s of spends) if (!s.deleted_at && !s.is_gas) events.push({ t: new Date(s.created_at), id: s.player_id, delta: -s.amount_cents });
  events.sort((a, b) => a.t - b.t);
  const run = Object.fromEntries(players.map((p) => [p.id, p.starting_cents ?? 0]));
  const days = new Map();
  for (const e of events) {
    if (!(e.id in run)) continue;
    run[e.id] += e.delta;
    days.set(e.t.toISOString().slice(0, 10), { ...run });
  }
  return [...days].map(([day, balances]) => ({ day, balances }));
}

/** Winner of a finished game: most saved. `standings` is sorted high to low. */
export function finalResult(standings) {
  if (standings.length < 2) return null;
  const [a, b] = standings;
  if (a.saved_cents === b.saved_cents) return { tie: true, saved_cents: a.saved_cents };
  return { tie: false, id: a.id, name: a.name, saved_cents: a.saved_cents, margin_cents: a.saved_cents - b.saved_cents };
}
