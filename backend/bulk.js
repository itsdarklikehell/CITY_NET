// Big reads and deletes by id, in pieces SQLite can take.
//
// A map-sized city is tens of thousands of rows, and deleting or undoing one used to be a
// single statement naming every id: past SQLite's limit of 32,766 bound values it is refused
// outright, and short of it a statement that large needs a great deal of scratch space - the
// kind of request that ends in SQLITE_FULL on a machine with plenty of free disk. So ids go in
// pieces, all inside one transaction so a delete still happens entirely or not at all, and
// every piece has its error handled: a failure rolls back and is reported, never left to crash
// the server as an unhandled 'error' event.

const CHUNK = 500;

// Table names are never taken from a request; this is the whole list that may be named here.
const TABLES = new Set(['locations', 'roads', 'overpasses', 'water_bodies']);

const pieces = (ids, size = CHUNK) => {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
};

const marks = (n) => new Array(n).fill('?').join(',');

const checkTable = (table) => {
  if (!TABLES.has(table)) throw new Error(`bulk: table not allowed: ${table}`);
};

/** SELECT * FROM table WHERE id IN (ids), in pieces. cb(err, rows). */
function selectByIds(db, table, ids, cb) {
  checkTable(table);
  const parts = pieces(ids);
  const rows = [];
  let i = 0;
  const next = () => {
    if (i >= parts.length) return cb(null, rows);
    const part = parts[i++];
    db.all(`SELECT * FROM ${table} WHERE id IN (${marks(part.length)})`, part, (err, got) => {
      if (err) return cb(err);
      rows.push(...got);
      next();
    });
  };
  next();
}

/**
 * Delete ids from one or more tables as a single transaction, in pieces.
 *
 * `deletions` is `[{ table, ids }]`. cb(err) - on any error everything is rolled back, so a
 * failed delete leaves the map as it was rather than half gone.
 */
function deleteByIds(db, deletions, cb) {
  const steps = [];
  for (const { table, ids } of deletions) {
    checkTable(table);
    for (const part of pieces(ids || [])) steps.push({ table, part });
  }
  if (steps.length === 0) return cb(null);

  const fail = (err) => db.run('ROLLBACK', () => cb(err));
  db.run('BEGIN TRANSACTION', (err) => {
    if (err) return cb(err);
    let i = 0;
    const next = () => {
      if (i >= steps.length) {
        return db.run('COMMIT', (e) => (e ? fail(e) : cb(null)));
      }
      const { table, part } = steps[i++];
      db.run(`DELETE FROM ${table} WHERE id IN (${marks(part.length)})`, part, (e) => (e ? fail(e) : next()));
    };
    next();
  });
}

module.exports = { selectByIds, deleteByIds, CHUNK };
