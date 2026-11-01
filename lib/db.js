import { neon } from '@neondatabase/serverless';

let sql;
/** Run one parameterised statement; resolves to an array of rows. */
export function q(text, params = []) {
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
export function mutateRow(table, id, actorId, { set = {}, remove = false }) {
  ident(table);
  const params = [id, actorId];
  let setSql = 'deleted_at = now()';
  if (!remove) {
    setSql = Object.entries(set).map(([c, v]) => { params.push(v); return `${ident(c)} = $${params.length}`; }).join(', ');
  }
  const action = remove ? 'delete' : 'update';
  return q(
    `WITH old AS (SELECT * FROM ${table} WHERE id = $1 AND player_id = $2 AND deleted_at IS NULL),
          upd AS (UPDATE ${table} SET ${setSql} WHERE id IN (SELECT id FROM old) RETURNING *),
          a AS (INSERT INTO audit_log (table_name,row_id,action,actor_id,before,after)
                SELECT '${table}', upd.id, '${action}', $2, to_jsonb(old), to_jsonb(upd)
                FROM old JOIN upd ON old.id = upd.id)
     SELECT * FROM upd`,
    params,
  );
}
