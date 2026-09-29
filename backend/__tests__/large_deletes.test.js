import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { makeTestDb, get, all, run } from './helpers/testDb.js';
import { until } from './helpers/until.js';
import locationsRouteFactory from '../routes/locations.js';
import adminRouteFactory from '../routes/admin.js';
import { selectByIds, deleteByIds } from '../bulk.js';
import { makeRecordAction, pruneHistory, tidyHistory, HISTORY_LIMIT, MAX_PAYLOAD_BYTES } from '../history.js';

/**
 * A map-sized city, deleted.
 *
 * The bug report: generate a city across the whole map, then delete any of it, and the server
 * dies with SQLITE_FULL - and keeps dying on every delete after. Three things met there: one
 * statement naming every id (refused past SQLite's 32,766 bound values), an undo history that
 * kept a full copy of every deleted row forever, and history writes with no error handler, so a
 * failed one took the whole server down.
 */

process.env.JWT_SECRET = 'test-secret';

const ADMIN_TOKEN = jwt.sign(
  { id: 1, username: 'testadmin', role: 'admin', isTemporary: false },
  'test-secret'
);
const auth = { Authorization: `Bearer ${ADMIN_TOKEN}` };

/** More than SQLite will take as bound values in one statement. */
const CITY = 40000;

const makeApp = (db) => {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const helpers = { emitUpdate: () => {}, recordAction: makeRecordAction(db) };
  const io = { emit: () => {} };
  app.use('/api/locations', locationsRouteFactory(db, io, helpers));
  app.use('/api/admin', adminRouteFactory(db, io, helpers));
  return app;
};

/** `n` generated buildings (named by zone type, as the generator does) in one statement, and their ids. */
const buildCity = async (db, n = CITY) => {
  await run(db, `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
                 INSERT INTO locations (name, x, y, z) SELECT 'CORPO', i, 0, 0 FROM n`, [n]);
  return (await all(db, 'SELECT id FROM locations ORDER BY id')).map(r => r.id);
};

const count = async (db, table) => (await get(db, `SELECT COUNT(*) AS n FROM ${table}`)).n;

/** A delete that fails partway: SQLite refuses to delete this one row. */
const refuseDeleting = (db, id) =>
  run(db, `CREATE TRIGGER refuse BEFORE DELETE ON locations WHEN old.id = ${id}
           BEGIN SELECT RAISE(ABORT, 'refused'); END`);

let db;
let app;

beforeEach(async () => {
  db = await makeTestDb();
  app = makeApp(db);
});

afterEach(() => vi.restoreAllMocks());

describe('bulk deletes', () => {
  it('deletes more ids than one statement can name', async () => {
    const ids = await buildCity(db);
    await new Promise((resolve, reject) =>
      deleteByIds(db, [{ table: 'locations', ids }], (err) => (err ? reject(err) : resolve())));
    expect(await count(db, 'locations')).toBe(0);
  });

  it('reads more ids than one statement can name', async () => {
    const ids = await buildCity(db);
    const rows = await new Promise((resolve, reject) =>
      selectByIds(db, 'locations', ids, (err, got) => (err ? reject(err) : resolve(got))));
    expect(rows).toHaveLength(CITY);
  });

  it('deletes all or nothing: a failure partway rolls the rest back', async () => {
    const ids = await buildCity(db, 3000);
    await refuseDeleting(db, ids[2500]);
    const err = await new Promise((resolve) => deleteByIds(db, [{ table: 'locations', ids }], resolve));
    expect(err).toBeTruthy();
    expect(await count(db, 'locations')).toBe(3000);
    // And the connection is usable afterwards, not stuck in a transaction.
    await run(db, `INSERT INTO locations (name, x, y, z) VALUES ('AFTER', 0, 0, 0)`);
    expect(await count(db, 'locations')).toBe(3001);
  });

  it('only names the tables it was built for', () => {
    expect(() => deleteByIds(db, [{ table: 'admin', ids: [1] }], () => {})).toThrow(/not allowed/);
  });
});

describe('POST /api/locations/batch-delete on a map-sized city', () => {
  it('deletes the whole city', async () => {
    const ids = await buildCity(db);
    const res = await request(app).post('/api/locations/batch-delete').set(auth).send({ ids });
    expect(res.status).toBe(200);
    expect(await count(db, 'locations')).toBe(0);
  });

  it('records the delete as too large to undo instead of keeping a copy of the city', async () => {
    const ids = await buildCity(db);
    await request(app).post('/api/locations/batch-delete').set(auth).send({ ids });
    const entry = await until(() => get(db, 'SELECT * FROM action_history'), { label: 'history entry' });
    expect(entry.type).toBe('location_delete');
    expect(JSON.parse(entry.payload)).toEqual({ tooLarge: true });
  });

  it('answers with an error, and deletes nothing, when the delete fails', async () => {
    const ids = await buildCity(db, 1200);
    await refuseDeleting(db, ids[1100]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).post('/api/locations/batch-delete').set(auth).send({ ids });
    expect(res.status).toBe(500);
    expect(await count(db, 'locations')).toBe(1200);
  });

  it('still keeps an ordinary delete undoable', async () => {
    const ids = await buildCity(db, 3);
    await request(app).post('/api/locations/batch-delete').set(auth).send({ ids });
    await until(() => get(db, 'SELECT * FROM action_history'), { label: 'history entry' });
    const res = await request(app).post('/api/admin/undo').set(auth);
    expect(res.status).toBe(200);
    expect(await count(db, 'locations')).toBe(3);
  });
});

describe('POST /api/locations/purge-region on a map-sized city', () => {
  it('clears a region holding more buildings than one statement can name', async () => {
    await buildCity(db);
    const res = await request(app).post('/api/locations/purge-region').set(auth)
      .send({ bounds: { min: { x: 0, z: -10 }, max: { x: CITY + 1, z: 10 } } });
    expect(res.status).toBe(200);
    expect(res.body.locations).toBe(CITY);
    expect(await count(db, 'locations')).toBe(0);
  });
});

describe('the undo history', () => {
  it(`keeps only the last ${HISTORY_LIMIT} actions`, async () => {
    const record = makeRecordAction(db);
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) record('location_create', { ids: [i] });
    // sqlite may run the inserts in any order, so this checks by row id: the newest 50 stay.
    const span = () => get(db, 'SELECT COUNT(*) AS n, MIN(id) AS lo, MAX(id) AS hi FROM action_history');
    await until(async () => {
      const s = await span();
      return s.n === HISTORY_LIMIT && s.hi === HISTORY_LIMIT + 20;
    }, { label: 'history trimmed' });
    expect((await span()).lo).toBe(21);
  });

  it('logs a failed write rather than crashing the server', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await run(db, 'DROP TABLE action_history');
    makeRecordAction(db)('location_create', { ids: [1] });
    await until(() => logged.mock.calls.length > 0, { label: 'error logged' });
    expect(logged.mock.calls[0][0]).toMatch(/location_create/);
  });

  it('trims and shrinks an already-ballooned history at startup', async () => {
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) {
      await run(db, 'INSERT INTO action_history (type, payload) VALUES (?, ?)',
        ['location_create', JSON.stringify({ ids: [i] })]);
    }
    const huge = JSON.stringify({ data: 'x'.repeat(MAX_PAYLOAD_BYTES + 1) });
    await run(db, 'INSERT INTO action_history (type, payload) VALUES (?, ?)', ['location_delete', huge]);

    await new Promise((resolve) => tidyHistory(db, resolve));

    expect(await count(db, 'action_history')).toBe(HISTORY_LIMIT);
    const newest = await get(db, 'SELECT * FROM action_history ORDER BY id DESC LIMIT 1');
    expect(newest.type).toBe('location_delete');
    expect(JSON.parse(newest.payload)).toEqual({ tooLarge: true });
  });

  it('pruning an empty history is harmless', async () => {
    const err = await new Promise((resolve) => pruneHistory(db, resolve));
    expect(err).toBeNull();
  });
});

describe('POST /api/admin/undo after a large change', () => {
  it('says the change was too large, then lets the next undo reach the one before it', async () => {
    const [id] = await buildCity(db, 1);
    await run(db, 'INSERT INTO action_history (type, payload) VALUES (?, ?)',
      ['location_create', JSON.stringify({ ids: [id] })]);
    await run(db, 'INSERT INTO action_history (type, payload) VALUES (?, ?)',
      ['region_purge', JSON.stringify({ tooLarge: true })]);

    const first = await request(app).post('/api/admin/undo').set(auth);
    expect(first.status).toBe(409);
    expect(first.body.error).toMatch(/too large to undo/i);

    const second = await request(app).post('/api/admin/undo').set(auth);
    expect(second.status).toBe(200);
    expect(second.body.type).toBe('location_create');
    expect(await count(db, 'locations')).toBe(0);
  });

  it('undoes generating a map-sized city', async () => {
    const ids = await buildCity(db);
    await run(db, 'INSERT INTO action_history (type, payload) VALUES (?, ?)',
      ['location_create', JSON.stringify({ ids })]);
    const res = await request(app).post('/api/admin/undo').set(auth);
    expect(res.status).toBe(200);
    expect(await count(db, 'locations')).toBe(0);
    expect(await count(db, 'action_history')).toBe(0);
  });
});
