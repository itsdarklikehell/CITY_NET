import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'module';
import { makeTestDb, run } from './helpers/testDb.js';
import locationsRouteFactory from '../routes/locations.js';
import sheetsRouteFactory from '../routes/sheets.js';

/**
 * NPC sheets and silhouetted faces stay with the GM.
 *
 * The map list and the token card are public. They used to hand every player each linked
 * NPC's whole sheet, and the real portrait of an NPC the GM had silhouetted - the silhouette
 * being only a filter on the player's own screen.
 */

process.env.JWT_SECRET = 'test-secret';
const require_ = createRequire(import.meta.url);
// The same object the middleware holds, so granting here is granting there.
const { elevatedUsers } = require_('../middleware/auth');
const { canReadNpcSheets, redactLocation, redactTokenCard } = require_('../sheets/npcPrivacy');

const sign = (claims) => jwt.sign(claims, 'test-secret');
const GM = sign({ id: 1, username: 'gm', role: 'admin', isTemporary: false });
const EDITOR = sign({ username: 'ghost', isTemporary: true });     // granted editing rights below
const REVOKED = sign({ username: 'ex-editor', isTemporary: true }); // grant not (or no longer) held
const PLAYER = sign({ username: 'vex', role: 'player' });

const CALLERS = {
  anonymous: null,
  player: PLAYER,
  'editor whose grant was revoked': REVOKED,
};

const FACE = '/uploads/headshots/hidden-face.png';
const SHOWN = '/uploads/headshots/shown-face.png';
const PLAYER_FACE = '/uploads/portraits/vex.png';
const SECRET_NOTE = 'boss of the Maelstrom cell, 40 HP';

const makeApp = (db) => {
  const app = express();
  app.use(express.json());
  const io = { emit: () => {} };
  const helpers = { emitUpdate: () => {}, recordAction: () => {} };
  app.use('/api/locations', locationsRouteFactory(db, io, helpers));
  app.use('/api/sheets', sheetsRouteFactory(db, io));
  return app;
};

let db;
let app;
let hidden;   // enemy token, linked sheet silhouetted
let shown;    // friendly token, linked sheet not silhouetted
let player;   // a player's own token

const npc = async (location_id, portrait, silhouette) => {
  const sheet = await run(db,
    `INSERT INTO character_sheets (username, system, data, portrait_url, is_npc, npc_label) VALUES ('gm', 'cwn', ?, ?, 1, 'NPC')`,
    [JSON.stringify({ name: 'KATANA', description: 'Scarred.', gm_notes: SECRET_NOTE, portrait_shadow_filter: silhouette }), portrait]);
  await run(db, 'INSERT INTO npc_sheet_links (location_id, sheet_id) VALUES (?, ?)', [location_id, sheet.lastID]);
};

beforeEach(async () => {
  db = await makeTestDb();
  app = makeApp(db);
  elevatedUsers.add('ghost');
  hidden = (await run(db, `INSERT INTO locations (name, x, y, z, shape) VALUES ('KATANA', 0, 0, 0, 'enemy_rhombus')`)).lastID;
  shown = (await run(db, `INSERT INTO locations (name, x, y, z, shape) VALUES ('FIXER', 1, 0, 0, 'friendly_rhombus')`)).lastID;
  player = (await run(db, `INSERT INTO locations (name, x, y, z, shape, owner) VALUES ('VEX', 2, 0, 0, 'rhombus', 'vex')`)).lastID;
  await npc(hidden, FACE, 1);
  await npc(shown, SHOWN, 0);
  await run(db, `INSERT INTO character_sheets (username, system, data, portrait_url, is_npc) VALUES ('vex', 'cwn', '{}', ?, 0)`, [PLAYER_FACE]);
});

afterEach(() => elevatedUsers.delete('ghost'));

const list = async (token) => {
  const req = request(app).get('/api/locations');
  if (token) req.set('Authorization', `Bearer ${token}`);
  const res = await req;
  expect(res.status).toBe(200);
  return Object.fromEntries(res.body.map(r => [r.id, r]));
};

const card = async (id, token) => {
  const req = request(app).get(`/api/sheets/npcs/link-public/${id}`);
  if (token) req.set('Authorization', `Bearer ${token}`);
  const res = await req;
  expect(res.status).toBe(200);
  return res.body;
};

describe('GET /api/locations', () => {
  for (const [who, token] of Object.entries(CALLERS)) {
    it(`gives the ${who} no NPC sheet and no silhouetted face`, async () => {
      const res = await request(app).get('/api/locations').set(token ? { Authorization: `Bearer ${token}` } : {});
      // Checked on the raw text too, so a sheet cannot slip through under another key.
      expect(res.text).not.toContain(SECRET_NOTE);
      expect(res.text).not.toContain(FACE);
      const rows = Object.fromEntries(res.body.map(r => [r.id, r]));
      for (const row of Object.values(rows)) expect(row).not.toHaveProperty('sheet_data');
      expect(rows[hidden].portrait_url).toBeNull();
      expect(rows[shown].portrait_url).toBe(SHOWN);
      expect(rows[player].portrait_url).toBe(PLAYER_FACE);
    });
  }

  for (const [who, token] of Object.entries({ GM, 'granted editor': EDITOR })) {
    it(`gives the ${who} the sheets for initiative, and the real portraits`, async () => {
      const rows = await list(token);
      expect(JSON.parse(rows[hidden].sheet_data).gm_notes).toBe(SECRET_NOTE);
      expect(rows[hidden].portrait_url).toBe(FACE);
      expect(rows[hidden].portrait_shadow_filter).toBe(1);
      expect(rows[shown].portrait_url).toBe(SHOWN);
    });
  }

  it('treats a forged token as anonymous', async () => {
    const forged = jwt.sign({ id: 1, username: 'gm', role: 'admin' }, 'not-the-secret');
    const rows = await list(forged);
    expect(rows[hidden]).not.toHaveProperty('sheet_data');
    expect(rows[hidden].portrait_url).toBeNull();
  });
});

describe('GET /api/sheets/npcs/link-public/:location_id', () => {
  for (const [who, token] of Object.entries(CALLERS)) {
    it(`gives the ${who} the name but not a silhouetted face`, async () => {
      const body = await card(hidden, token);
      expect(body.sheet_name).toBe('KATANA');
      expect(body.portrait_url).toBeNull();
      expect(JSON.stringify(body)).not.toContain(SECRET_NOTE);
    });

    it(`still gives the ${who} a face that is not silhouetted`, async () => {
      expect((await card(shown, token)).portrait_url).toBe(SHOWN);
    });
  }

  it('gives the GM the real portrait, silhouette flag and all', async () => {
    const body = await card(hidden, GM);
    expect(body.portrait_url).toBe(FACE);
    expect(body.portrait_shadow_filter).toBe(1);
  });

  it('answers an unlinked token with nothing', async () => {
    expect(await card(player)).toEqual({});
  });
});

describe('npcPrivacy rules', () => {
  it('lets the GM and granted editors read sheets, and no one else', () => {
    expect(canReadNpcSheets({ role: 'admin', isTemporary: false })).toBe(true);
    expect(canReadNpcSheets({ username: 'ghost', isTemporary: true })).toBe(true);
    expect(canReadNpcSheets({ username: 'vex', role: 'player' })).toBe(false);
    expect(canReadNpcSheets({ username: 'reset', role: 'player_reset' })).toBe(false);
    expect(canReadNpcSheets(null)).toBe(false);
  });

  it('reads the silhouette flag however the sheet stored it', () => {
    const row = { id: 1, portrait_url: FACE, sheet_data: '{}' };
    for (const on of [1, '1', true]) expect(redactLocation({ ...row, portrait_shadow_filter: on }, false).portrait_url).toBeNull();
    for (const off of [0, '0', null, undefined, false]) expect(redactLocation({ ...row, portrait_shadow_filter: off }, false).portrait_url).toBe(FACE);
  });

  it('leaves the original row alone', () => {
    const row = { id: 1, portrait_url: FACE, sheet_data: '{}', portrait_shadow_filter: 1 };
    redactLocation(row, false);
    expect(row).toEqual({ id: 1, portrait_url: FACE, sheet_data: '{}', portrait_shadow_filter: 1 });
  });

  it('passes an empty token card through', () => {
    expect(redactTokenCard(undefined, false)).toBeUndefined();
  });
});
