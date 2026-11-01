import { neon } from '@neondatabase/serverless';

let sql;
let runner;
/** Tests point every query at a local Postgres instead of Neon: (text, params) => Promise<rows[]>. */
export function setRunner(fn) { runner = fn; }

/** Run one parameterised statement; resolves to an array of rows. */
export function q(text, params = []) {
  if (runner) return runner(text, params);
  sql ??= neon(process.env.DATABASE_URL);
  return sql.query(text, params);
}

const IDENT = /^[a-z_]+$/;
const ident = (s) => { if (!IDENT.test(s)) throw new Error(`bad identifier: ${s}`); return s; };

/**
 * Insert rows and write their audit entries in ONE statement, so a row can never
 * exist without its audit trail. Table and column names come from code, never
 * from request data; they are still checked.
 */
export function createRows(table, rows, actorId) {
  ident(table);
  const cols = Object.keys(rows[0]).map(ident);
  const params = [];
  const tuples = rows.map((r) => '(' + cols.map((c) => { params.push(r[c]); return `$${params.length}`; }).join(',') + ')');
  params.push(actorId);
  const actor = `$${params.length}`;
  return q(
    `WITH ins AS (INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')} RETURNING *),
          a AS (INSERT INTO audit_log (table_name,row_id,action,actor_id,after)
                SELECT '${table}', id, 'create', ${actor}, to_jsonb(ins) FROM ins)
     SELECT * FROM ins ORDER BY id`,
    params,
  );
}

/**
 * Edit or soft-delete one of the actor's own live rows, with before/after audit,
 * in one statement. Resolves to [] if the row is missing, deleted or not theirs.
 */
export function mutateRow(table, id, actorId, { set = {}, remove = false, owner = 'player_id' }) {
  ident(table);
  // owner: the column that must equal the actor, or null when either player may act (e.g. closing a shared date).
  const ownerSql = owner ? `AND ${ident(owner)} = $2` : '';
  const params = [id, actorId];
  let setSql = 'deleted_at = now()';
  if (!remove) {
    setSql = Object.entries(set).map(([c, v]) => { params.push(v); return `${ident(c)} = $${params.length}`; }).join(', ');
  }
  const action = remove ? 'delete' : 'update';
  return q(
    `WITH old AS (SELECT * FROM ${table} WHERE id = $1 ${ownerSql} AND deleted_at IS NULL),
          upd AS (UPDATE ${table} SET ${setSql} WHERE id IN (SELECT id FROM old) RETURNING *),
          a AS (INSERT INTO audit_log (table_name,row_id,action,actor_id,before,after)
                SELECT '${table}', upd.id, '${action}', $2, to_jsonb(old), to_jsonb(upd)
                FROM old JOIN upd ON old.id = upd.id)
     SELECT * FROM upd`,
    params,
  );
}

/**
 * Edit or soft-delete BOTH halves of an immunity split in one statement. Either person in the
 * split may do it (it is a shared bill); each half gets its own before/after audit row.
 * `mine`/`theirs` are the new amounts for the actor's half and the partner's half.
 * Resolves to [] if the group is gone or the actor is not in it.
 */
export function mutateSplit(groupId, actorId, { set = {}, mine = null, theirs = null, remove = false }) {
  const params = [groupId, actorId];
  const parts = [];
  if (remove) parts.push('deleted_at = now()');
  else {
    for (const [c, v] of Object.entries(set)) { params.push(v); parts.push(`${ident(c)} = $${params.length}`); }
    if (mine !== null) {
      params.push(mine, theirs);
      parts.push(`amount_cents = CASE WHEN player_id = $2 THEN $${params.length - 1}::int ELSE $${params.length}::int END`);
    }
  }
  const action = remove ? 'delete' : 'update';
  return q(
    `WITH old AS (SELECT * FROM spends WHERE split_group = $1 AND deleted_at IS NULL
                  AND EXISTS (SELECT 1 FROM spends x WHERE x.split_group = $1 AND x.player_id = $2 AND x.deleted_at IS NULL)),
          upd AS (UPDATE spends SET ${parts.join(', ')} WHERE id IN (SELECT id FROM old) RETURNING *),
          a AS (INSERT INTO audit_log (table_name,row_id,action,actor_id,before,after)
                SELECT 'spends', upd.id, '${action}', $2, to_jsonb(old), to_jsonb(upd) FROM old JOIN upd ON old.id = upd.id)
     SELECT * FROM upd ORDER BY id`,
    params,
  );
}
