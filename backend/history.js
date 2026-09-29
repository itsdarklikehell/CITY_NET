// The undo history (`action_history`), kept to a sensible size.
//
// It used to grow forever: every delete stored a full copy of every row it removed, and nothing
// but an undo ever took an entry out. Deleting a map-sized city wrote one entry of hundreds of
// megabytes, every retry another, until the database could not grow and every write failed. So:
//
//  - only the last HISTORY_LIMIT actions are kept;
//  - a change too large to keep a copy of is still recorded, as "too large to undo", so the undo
//    button says so rather than undoing something older by mistake;
//  - a failed write is logged, never left to crash the server as an unhandled 'error' event.

const HISTORY_LIMIT = 50;
/** Past this, a change is recorded without its copy. Roughly five thousand buildings. */
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const TOO_LARGE = JSON.stringify({ tooLarge: true });

/** Keep the newest HISTORY_LIMIT entries. cb(err) optional. */
function pruneHistory(db, cb) {
  db.run(
    `DELETE FROM action_history WHERE id NOT IN (SELECT id FROM action_history ORDER BY id DESC LIMIT ?)`,
    [HISTORY_LIMIT],
    (err) => {
      if (err) console.error('Failed to trim the undo history:', err.message);
      if (cb) cb(err);
    },
  );
}

/**
 * Once at startup: trim the history, and drop the copies from any entry too large to keep.
 *
 * What lets a database that already ballooned recover by updating and restarting: freed pages
 * are reused by SQLite, so the next write has room again.
 */
function tidyHistory(db, cb) {
  pruneHistory(db, () => {
    db.run(
      'UPDATE action_history SET payload = ? WHERE length(payload) > ?',
      [TOO_LARGE, MAX_PAYLOAD_BYTES],
      (err) => {
        if (err) console.error('Failed to shrink the undo history:', err.message);
        if (cb) cb(err);
      },
    );
  });
}

/** recordAction(type, payload) for the routes, bound to this database. */
function makeRecordAction(db) {
  return (type, payload) => {
    let json = JSON.stringify(payload);
    if (json.length > MAX_PAYLOAD_BYTES) json = TOO_LARGE;
    db.run('INSERT INTO action_history (type, payload) VALUES (?, ?)', [type, json], (err) => {
      if (err) {
        console.error(`Failed to record "${type}" for undo:`, err.message);
        return;
      }
      pruneHistory(db);
    });
  };
}

module.exports = { makeRecordAction, pruneHistory, tidyHistory, HISTORY_LIMIT, MAX_PAYLOAD_BYTES };
