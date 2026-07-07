// Requests: store logic (dedupe→votes, lifecycle, derived availability) and
// the permission surface exercised through the real core server — a viewer
// files and votes but cannot decide; a trusted user approves; withdrawal
// rules hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openRequestsStore } from '../store.js';

function tmpdir() {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'requests-test-'));
  return { p, rm: () => fs.rmSync(p, { recursive: true, force: true }) };
}

const VOL = { id: 4242, name: 'Transmetropolitan', start_year: '1997', publisher: 'DC Comics', image_url: 'https://cv/tm.jpg', count_of_issues: 60 };

test('store: create → duplicate seconds it → approve → derived availability', () => {
  const { p: dir, rm } = tmpdir();
  try {
    const store = openRequestsStore(path.join(dir, 'cat.db'));
    const { request, seconded } = store.create(3, 'reader', VOL, 'please!');
    assert.equal(seconded, false);
    assert.equal(request.status, 'pending');
    assert.equal(request.votes, 1, "the requester's vote counts");
    assert.equal(request.note, 'please!');

    // same volume again, another user → seconds the open request
    const dup = store.create(4, 'other', VOL, 'me too');
    assert.equal(dup.seconded, true);
    assert.equal(dup.request.id, request.id);
    assert.equal(dup.request.votes, 2);
    assert.equal(store.list(3).length, 1, 'no duplicate rows');

    // votes toggle per user
    store.vote(4, request.id, false);
    assert.equal(store.get(request.id, 3).votes, 1);

    store.approve(request.id, 'admin');
    let r = store.get(request.id, 3);
    assert.equal(r.status, 'approved');
    assert.equal(r.display, 'approved', 'not yet available — nothing on disk');

    // once the library has every issue of the volume, display flips to available
    const db = new Database(path.join(dir, 'cat.db'));
    db.exec(`
      CREATE TABLE series (id INTEGER PRIMARY KEY, cv_id INTEGER);
      CREATE TABLE cv_issues (comicvine_id INTEGER PRIMARY KEY, cv_series_id INTEGER);
      CREATE TABLE library_files (path TEXT PRIMARY KEY, cv_issue_id INTEGER, valid INTEGER);
      INSERT INTO series VALUES (1, 4242);
      INSERT INTO cv_issues VALUES (11, 4242), (12, 4242);
      INSERT INTO library_files VALUES ('/x/1.cbz', 11, 1), ('/x/2.cbz', 12, 1);
    `);
    db.close();
    r = store.get(request.id, 3);
    assert.equal(r.display, 'available');
    assert.equal(r.owned, 2);
    assert.equal(r.total, 2);
    assert.equal(r.series_id, 1);

    // a declined request keeps its reason; the volume can be re-requested
    const second = store.create(3, 'reader', { ...VOL, id: 5555, name: 'Planetary' }, null);
    store.decline(second.request.id, 'admin', 'not this year');
    assert.equal(store.get(second.request.id, 3).decline_reason, 'not this year');
    const again = store.create(4, 'other', { ...VOL, id: 5555, name: 'Planetary' }, null);
    assert.equal(again.seconded, false, 'declined ≠ open — a fresh request is allowed');

    store.remove(request.id);
    assert.equal(store.list(3).some((x) => x.id === request.id), false);
    store.close();
  } finally { rm(); }
});

test('routes: viewer files + votes but cannot decide; trusted approves', async () => {
  process.env.PLUGINS_DIR = 'nonexistent-' + Date.now(); // keep other plugins out
  const { openDb } = await import('../../../src/db.js');
  const { createApp } = await import('../../../src/server.js');
  const { pluginApi, registeredRoutes } = await import('../../../src/plugins.js');
  const registerRequests = (await import('../index.js')).default;
  const config = (await import('../../../src/config.js')).default;

  // A fake ComicVine so approve's addSeriesFromCv works offline.
  const http = await import('node:http');
  const fakeCv = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status_code: 1, error: 'OK', results: {
      id: 4242, name: 'Transmetropolitan', start_year: 1997,
      publisher: { name: 'DC Comics' }, count_of_issues: 2,
      image: { medium_url: 'https://cv/tm.jpg' },
      issues: [{ id: 9101, issue_number: '1', name: 'One' }, { id: 9102, issue_number: '2', name: 'Two' }],
    } }));
  });
  await new Promise((r) => fakeCv.listen(0, r));

  const { p: dir, rm } = tmpdir();
  const oldDbPath = config.dbPath;
  const oldCvBase = config.cvBaseUrl, oldKeys = config.comicvineKeys;
  config.dbPath = path.join(dir, 'cat.db');
  config.cvBaseUrl = `http://localhost:${fakeCv.address().port}`;
  config.comicvineKeys = 'test-key';
  const db = openDb(config.dbPath);
  registerRequests(pluginApi);
  const kicks = [];
  const app = createApp({
    db, state: { queue: {} },
    getSettings: () => ({}), saveSettings: (b) => b,
    prepareRedownload: async () => {}, runDownloads: async () => kicks.push(1),
    pluginRoutes: registeredRoutes(),
  });
  const s = await new Promise((res) => { const x = app.listen(0, () => res(x)); });
  const base = `http://localhost:${s.address().port}`;
  const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];
  try {
    // accounts: admin (implicit trusted), viewer
    const reg = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'adminpass1' }),
    });
    const A = { cookie: cookieOf(reg), 'content-type': 'application/json' };
    await fetch(`${base}/api/users`, {
      method: 'POST', headers: A,
      body: JSON.stringify({ username: 'casual', password: 'viewerpass1', role: 'viewer' }),
    });
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'casual', password: 'viewerpass1' }),
    });
    const V = { cookie: cookieOf(login), 'content-type': 'application/json' };

    // seed a request directly (creating via POST would call ComicVine)
    const { openRequestsStore: open2 } = await import('../store.js');
    const st = open2(config.dbPath);
    const seeded = st.create(3, 'casual', VOL, null).request;
    st.close();

    // viewer: sees the queue, votes — but decisions 403
    const list = await (await fetch(`${base}/api/requests`, { headers: V })).json();
    assert.equal(list.requests.length, 1);
    assert.equal(list.canManage, false);
    const vote = await fetch(`${base}/api/requests/${seeded.id}/vote`, { method: 'POST', headers: V, body: '{"on":true}' });
    assert.equal(vote.status, 200);
    assert.equal((await fetch(`${base}/api/requests/${seeded.id}/decline`, { method: 'POST', headers: V, body: '{}' })).status, 403);
    assert.equal((await fetch(`${base}/api/requests/${seeded.id}/approve`, { method: 'POST', headers: V, body: '{}' })).status, 403);
    // viewer can't delete someone else's request either (requested_by=3 ≠ casual's id)
    const delOther = await fetch(`${base}/api/requests/${seeded.id}`, { method: 'DELETE', headers: V });
    assert.equal(delOther.status, 403);

    // admin sees canManage and declines with a reason
    const listA = await (await fetch(`${base}/api/requests`, { headers: A })).json();
    assert.equal(listA.canManage, true);
    const dec = await fetch(`${base}/api/requests/${seeded.id}/decline`, {
      method: 'POST', headers: A, body: JSON.stringify({ reason: 'duplicates an omnibus' }),
    });
    assert.equal(dec.status, 200);
    assert.equal((await dec.json()).request.status, 'declined');

    // approve + download: the volume is added (via the fake CV) and every
    // missing issue queues SERVER-side, kicking the download worker
    const st2 = open2(config.dbPath);
    const again = st2.create(3, 'casual', VOL, 'second try').request;
    st2.close();
    const appr = await fetch(`${base}/api/requests/${again.id}/approve`, {
      method: 'POST', headers: A, body: JSON.stringify({ download: true }),
    });
    assert.equal(appr.status, 200);
    const body = await appr.json();
    assert.equal(body.request.status, 'approved');
    assert.equal(body.queued, 2, 'both issues of the fake volume queued');
    const rows = db.prepare("SELECT status FROM issues WHERE url LIKE 'cvissue:%'").all();
    assert.equal(rows.length, 2);
    assert.ok(rows.every((x) => x.status === 'queued'));
    assert.ok(kicks.length >= 1, 'the download worker was kicked server-side');
  } finally {
    s.close();
    fakeCv.close();
    config.dbPath = oldDbPath;
    config.cvBaseUrl = oldCvBase;
    config.comicvineKeys = oldKeys;
    try { rm(); } catch { /* Windows file locks — temp dir reaped by OS */ }
  }
});
