import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBalances, splitCents, gameStatus, daysUntil, validateSpend, validateDeposit, nextPlanner, validateDate, checkSpendAgainstDate, rpsOutcome, sanitizeRound, checkRpsRound } from '../lib/game.js';
import { signSession, verifySession, hashPin, verifyPin, readCookie } from '../lib/auth.js';

const players = [{ id: 1, name: 'Nolan', starting_cents: 0 }, { id: 2, name: 'Aurora', starting_cents: 0 }];

test('balance = deposits - non-gas spends; gas tracked but ignored', () => {
  const b = computeBalances({
    players,
    deposits: [{ player_id: 1, amount_cents: 10000 }, { player_id: 1, amount_cents: 5000, deleted_at: 'x' }],
    spends: [
      { player_id: 1, amount_cents: 2500, is_gas: false },
      { player_id: 1, amount_cents: 4000, is_gas: true },
      { player_id: 2, amount_cents: 1000, is_gas: false, deleted_at: 'x' },
    ],
  });
  assert.equal(b[1].saved_cents, 7500);
  assert.equal(b[1].gas_cents, 4000);
  assert.equal(b[2].saved_cents, 0);
});

test('balance can go negative and has no cap at the $7k milestone', () => {
  const b = computeBalances({ players, deposits: [{ player_id: 1, amount_cents: 900000 }], spends: [{ player_id: 2, amount_cents: 100 }] });
  assert.equal(b[1].saved_cents, 900000);
  assert.equal(b[2].saved_cents, -100);
});

test('splitCents gives the odd cent to the logger and always sums', () => {
  assert.deepEqual(splitCents(1001), [501, 500]);
  assert.deepEqual(splitCents(1000), [500, 500]);
  for (const n of [1, 2, 3, 9999]) assert.equal(splitCents(n).reduce((a, b) => a + b), n);
});

test('game window: start inclusive, end exclusive', () => {
  const s = { start_date: '2027-05-15', end_date: '2027-08-23' };
  assert.equal(gameStatus(s, new Date('2027-05-14T12:00:00Z')), 'prelaunch');
  assert.equal(gameStatus(s, new Date('2027-05-15T00:00:00Z')), 'open');
  assert.equal(gameStatus(s, new Date('2027-08-22T23:59:00Z')), 'open');
  assert.equal(gameStatus(s, new Date('2027-08-23T00:00:00Z')), 'ended');
  assert.equal(daysUntil('2027-05-15', new Date('2027-05-10T09:00:00Z')), 5);
});

test('solo spend charges the proposer; gas is flagged', () => {
  const v = validateSpend({ amount_cents: 4000, category: 'gas', via: 'solo' }, 1, 2);
  assert.equal(v.rows.length, 1);
  assert.equal(v.rows[0].player_id, 1);
  assert.equal(v.rows[0].is_gas, true);
  assert.equal(v.rows[0].texted_first, false);
});

test('immunity splits the whole bill 50/50 across both players, same group', () => {
  const v = validateSpend({ amount_cents: 6001, category: 'dinner', via: 'immunity' }, 1, 2);
  assert.deepEqual(v.rows.map((r) => [r.player_id, r.amount_cents]), [[1, 3001], [2, 3000]]);
  assert.ok(v.rows[0].split_group && v.rows[0].split_group === v.rows[1].split_group);
});

test('bad input is rejected', () => {
  assert.ok(validateSpend({ amount_cents: 12.5, category: 'dinner' }, 1, 2).error);
  assert.ok(validateSpend({ amount_cents: 100, category: 'nope' }, 1, 2).error);
    assert.ok(validateDeposit({ amount_cents: -5 }).error);
  assert.ok(validateDeposit({ amount_cents: '50' }).error);
});

test('sessions: valid, forged, tampered and expired tokens', () => {
  const now = 1_000_000;
  const t = signSession(2, 'secret-secret-secret', now);
  assert.equal(verifySession(t, 'secret-secret-secret', now + 1000), 2);
  assert.equal(verifySession(t, 'other-secret-secret!', now + 1000), null);
  assert.equal(verifySession(t.replace(/^2\./, '1.'), 'secret-secret-secret', now + 1000), null);
  assert.equal(verifySession(t, 'secret-secret-secret', now + 31 * 24 * 3600 * 1000), null);
  assert.equal(verifySession('garbage', 'secret-secret-secret'), null);
  assert.equal(readCookie('a=1; session=abc.def; b=2', 'session'), 'abc.def');
});

test('PIN hashing round-trips', () => {
  const h = hashPin('1234');
  assert.ok(verifyPin('1234', h));
  assert.ok(!verifyPin('1235', h));
});

test('date turns alternate from the coin-flip winner; skips do not pass the turn', () => {
  const ids = [1, 2];
  assert.equal(nextPlanner(1, [], ids), 1);
  assert.equal(nextPlanner(1, [{ status: 'done' }], ids), 2);
  assert.equal(nextPlanner(1, [{ status: 'done' }, { status: 'done' }], ids), 1);
  assert.equal(nextPlanner(1, [{ status: 'skipped' }], ids), 1);
  assert.equal(nextPlanner(2, [{ status: 'planned' }], ids), 1);
  assert.equal(nextPlanner(null, [], ids), 1);
});

test('a date needs a title and a valid scope', () => {
  assert.ok(validateDate({ title: ' ', scope: ['dinner'] }).error);
  assert.ok(validateDate({ title: 'x', scope: [] }).error);
  assert.ok(validateDate({ title: 'x', scope: ['bowling'] }).error);
  assert.ok(validateDate({ title: 'x', scope: ['dinner'], planned_for: '06/01/2027' }).error);
  assert.ok(validateDate({ title: 'x', scope: ['dinner'], budget_cap_cents: 0 }).error);
  const ok = validateDate({ title: ' Taco night ', scope: ['dinner', 'dinner', 'treat'], budget_cap_cents: 8000, planned_for: '2027-06-01' });
  assert.deepEqual(ok.row, { title: 'Taco night', scope: ['dinner', 'treat'], budget_cap_cents: 8000, planned_for: '2027-06-01' });
});

test('spends tied to a date must fit its scope', () => {
  const date = { scope: ['dinner', 'treat'], status: 'planned' };
  assert.equal(checkSpendAgainstDate('dinner', date), null);
  assert.match(checkSpendAgainstDate('activity', date), /scope/);
  assert.ok(checkSpendAgainstDate('dinner', { ...date, status: 'skipped' }));
  assert.ok(checkSpendAgainstDate('dinner', undefined));
  assert.ok(checkSpendAgainstDate('dinner', { ...date, deleted_at: 'x' }));
});

test('rock-paper-scissors outcomes', () => {
  assert.equal(rpsOutcome('rock', 'scissors'), 'p1');
  assert.equal(rpsOutcome('rock', 'paper'), 'p2');
  assert.equal(rpsOutcome('scissors', 'paper'), 'p1');
  assert.equal(rpsOutcome('paper', 'rock'), 'p1');
  assert.equal(rpsOutcome('paper', 'paper'), 'tie');
  assert.throws(() => rpsOutcome('rock', null));
});

test('an unresolved round never reveals anyone\'s move', () => {
  const r = { id: 1, topic: 'pizza', started_by: 1, ties: 0, p1_move: 'rock', p2_move: null };
  for (const me of [1, 2]) {
    const s = sanitizeRound(r, me, 1);
    assert.equal(JSON.stringify(s).includes('rock'), false);
    assert.equal(s.resolved, false);
  }
  assert.equal(sanitizeRound(r, 1, 1).i_moved, true);
  assert.equal(sanitizeRound(r, 1, 1).they_moved, false);
  assert.equal(sanitizeRound(r, 2, 1).they_moved, true);
  const done = sanitizeRound({ ...r, p2_move: 'paper', winner_id: 2, resolved_at: 'x' }, 1, 1);
  assert.deepEqual([done.resolved, done.p1_move, done.p2_move, done.winner_id], [true, 'rock', 'paper', 2]);
});

test('only the winner can spend a decided, unused round', () => {
  const round = { resolved_at: 'x', winner_id: 2 };
  assert.equal(checkRpsRound(round, 2, false), null);
  assert.match(checkRpsRound(round, 1, false), /winner/);
  assert.match(checkRpsRound(round, 2, true), /already/);
  assert.match(checkRpsRound({ ...round, resolved_at: null }, 2, false), /not been decided/);
  assert.ok(checkRpsRound(undefined, 2, false));
  assert.ok(checkRpsRound({ ...round, cancelled_at: 'x' }, 2, false));
});

test('rps spend charges the winner and needs a round id', () => {
  assert.ok(validateSpend({ amount_cents: 100, category: 'dinner', via: 'rps' }, 1, 2).error);
  const v = validateSpend({ amount_cents: 5000, category: 'dinner', via: 'rps', rps_round_id: 7 }, 2, 1);
  assert.deepEqual(v.rows.map((r) => [r.player_id, r.proposed_by, r.rps_round_id, r.via]), [[2, 2, 7, 'rps']]);
});
