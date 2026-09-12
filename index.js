// Requests plugin for BackIssue — users ask for volumes, books and
// audiobooks; curators approve. Viewers search (ComicVine for comics, the
// metadata service for books and audiobooks) and file requests (duplicates
// become votes); roles with requests.manage review the queue, approve or
// decline with a reason. Approving a comic adds the volume to the library;
// approving a book asks every remote source that can search and shelves the
// hit as an on-demand entry — or leaves the request waiting, to be asked
// again by the hourly job and satisfied by any later scan that matches.
// Books and audiobooks only appear where the owning plugin is loaded and a
// library of that type exists. Downloads after approval are triggered
// CLIENT-side through the core download endpoint, so they run under the
// acting user's own downloads permission — this plugin never escalates
// anyone's rights.
import Database from 'better-sqlite3';
import config from '../../src/config.js';
import { makeCvClient } from '../../src/cv.js';
import { addSeriesFromCv } from '../../src/cvmatch.js';
import { ensureCvIssueRow, queueIssues, setIssueWants } from '../../src/db.js';
import { roleGrants, CORE_PERMISSIONS } from '../../src/users.js';
import { registeredPermissions, registeredRemoteMediaSources, pluginLibraryTypes } from '../../src/plugins.js';
import { openRequestsStore } from './store.js';
import { isWestern } from './western.js';
import { isCollection } from './collections.js';

export default function register(api) {
  api.registerClientAsset({ js: 'client/requests.js', css: 'client/requests.css' });

  // Grantable permissions: filing requests is viewer-tier, deciding them is
  // trusted-tier. Custom roles can hold either independently.
  const CAN_CREATE = api.registerPermission ? 'requests.create' : 'viewer';
  const CAN_MANAGE = api.registerPermission ? 'requests.manage' : 'trusted';
  api.registerPermission?.({
    key: 'requests.create',
    label: 'Request volumes',
    description: 'Search and request comics, books and audiobooks for the library (and vote on requests)',
    tier: 'viewer',
  });
  api.registerPermission?.({
    key: 'requests.manage',
    label: 'Manage requests',
    description: 'Approve or decline requests (approval adds the volume, book or audiobook to the library)',
    tier: 'trusted',
  });

  api.registerSettings({
    requestsAutoApprove: { type: 'bool' }, // every request is approved + added instantly
    requestsWesternOnly: { type: 'bool' }, // only Western-publisher volumes may be requested
    requestsNoCollections: { type: 'bool' }, // block TPBs / hardcovers / omnibuses / other compilations
  });

  // Is this volume requestable under the current policy? "Western only" allows a
  // volume only if its publisher is on the Western allowlist (western.js);
  // "No collections" blocks collected editions (TPB/HC/omnibus/…) detected
  // heuristically (collections.js). Foreign AND unknown fail Western; the
  // heuristic errs toward the strong signals.
  const requestable = (vol) =>
    (!config.requestsWesternOnly || isWestern(vol?.publisher)) &&
    (!config.requestsNoCollections || !isCollection(vol));

  const store = openRequestsStore(config.dbPath);
  const cv = () => makeCvClient(config);
  const uid = (req) => req.user?.id ?? 0;
  const uname = (req) => req.user?.username || 'local';
  // Raise a notification through the core system (absent on old cores).
  const notify = (req, e) => { try { req.app?.locals?.notify?.(e); } catch { /* core lacks notifications */ } };
  // Own connection to catalog.db for core-table work (adding volumes, role
  // lookups) — same file the app uses; WAL makes concurrent writers safe.
  let coreDb = null;
  const requireCoreDb = () => {
    if (!coreDb) {
      coreDb = new Database(config.dbPath);
      coreDb.pragma('journal_mode = WAL');
      coreDb.pragma('busy_timeout = 5000');
    }
    return coreDb;
  };
  // Fine-grained checks inside handlers go through the same role/permission
  // engine the middleware uses — custom roles included.
  const grants = (req, perm) => {
    if (!req.user || req.user.id === 0) return true; // open mode = implicit admin
    const catalog = new Map([...CORE_PERMISSIONS, ...registeredPermissions()].map((p) => [p.key, p]));
    try { return roleGrants(requireCoreDb(), req.user.role, perm, catalog); }
    catch { return false; }
  };
  const manages = (req) => grants(req, 'requests.manage');
  // The core's notifier, remembered from the last request so the hourly job
  // (which has no request) can still tell a requester their book landed.
  let notifyLater = null;
  const remember = (req) => { notifyLater = req.app?.locals?.notify || notifyLater; };

  // ---- books and audiobooks ----------------------------------------------
  // Only where the owning plugin is loaded (it registers the library type)
  // and a library of that type exists. Their metadata clients and stores are
  // soft imports — an absent plugin simply leaves the kind off.
  const kindOf = (k) => (k === 'ebook' || k === 'audiobook') ? k : 'comic';
  const libraryFor = (type) => {
    try { return requireCoreDb().prepare('SELECT id FROM libraries WHERE type=? ORDER BY sort_order, id LIMIT 1').get(type)?.id ?? null; }
    catch { return null; }
  };
  function mediaEnabled() {
    let types = new Set();
    try { types = new Set((pluginLibraryTypes?.() || []).map((t) => t.id)); } catch { /* older core */ }
    const has = (t) => types.has(t) && libraryFor(t) != null;
    return { ebook: has('ebook'), audiobook: has('audiobook') };
  }
  async function bookClient(kind) {
    try {
      if (kind === 'ebook') { const { makeBooksClient } = await import('../ebooks/metadata.js'); return makeBooksClient(config); }
      const { makeAudiobookClient } = await import('../audiobooks/metadata.js'); return makeAudiobookClient(config);
    } catch { return null; }
  }
  const stores = {};
  async function bookStore(kind) {
    if (stores[kind]) return stores[kind];
    try {
      const mod = kind === 'ebook' ? await import('../ebooks/store.js') : await import('../audiobooks/store.js');
      const open = mod.openEbooksStore || mod.openAudiobooksStore;
      stores[kind] = open ? open(config.dbPath) : null;
    } catch { stores[kind] = null; }
    return stores[kind];
  }
  const year4 = (v) => { const m = String(v || '').match(/\d{4}/); return m ? m[0] : null; };
  // One shape for both kinds, whatever the service calls the fields.
  const normBook = (r) => ({
    kind: 'ebook', id: String(r.id), title: r.title || 'Untitled',
    author: (Array.isArray(r.authors) ? r.authors : []).join(', ') || null,
    publisher: r.publisher || null, year: year4(r.published_date), cover: r.thumbnail || null,
    extra: Number.isFinite(r.page_count) && r.page_count > 0 ? `${r.page_count} pages` : null,
  });
  const normAudio = (r) => ({
    kind: 'audiobook', id: String(r.asin), title: r.title || 'Untitled',
    author: (Array.isArray(r.authors) ? r.authors : []).join(', ') || null,
    publisher: r.publisher || null, year: year4(r.published_date), cover: r.thumbnail || null,
    extra: [
      Array.isArray(r.narrators) && r.narrators.length ? 'read by ' + r.narrators.join(', ') : null,
      Number.isFinite(r.duration_min) && r.duration_min > 0 ? `${Math.round(r.duration_min / 60)}h` : null,
    ].filter(Boolean).join(' · ') || null,
  });
  const annotateItem = (item) => {
    const lib = store.bookState(item.kind, item.id, item.title, item.author, null);
    const open = store.openForExternal(item.kind, item.id);
    return { ...item, inLibrary: lib.issue_id != null, seriesId: lib.series_id, requestId: open?.id ?? null };
  };
  /** The service's own record of an item, by id; null when it can't say. */
  async function lookupItem(kind, id) {
    const client = await bookClient(kind);
    if (!client?.available?.()) return null;
    try {
      if (kind === 'ebook') { const b = await client.volume(id); return b ? normBook(b) : null; }
      const a = await client.book(id); return a ? normAudio(a) : null;
    } catch { return null; }
  }

  // Is this source's hit the book that was asked for? Titles must share most
  // of the shorter title's words, and the authors must not contradict.
  const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  function similar(want, meta) {
    const a = new Set(norm(want.title).split(' ').filter(Boolean));
    const b = new Set(norm(meta?.title).split(' ').filter(Boolean));
    if (!a.size || !b.size) return false;
    const [small, big] = a.size <= b.size ? [a, b] : [b, a];
    let n = 0; for (const w of small) if (big.has(w)) n++;
    if (n / small.size < 0.6) return false;
    const theirs = norm(meta?.author || (Array.isArray(meta?.authors) ? meta.authors.join(' ') : ''));
    if (!theirs || !want.authors.length) return true;
    return want.authors.some((x) => {
      const nx = norm(x); const last = nx.split(' ').pop();
      return !!nx && (theirs.includes(nx) || nx.includes(theirs) || (last && theirs.includes(last)));
    });
  }

  /** Try to put an approved book/audiobook request on the shelf from a remote
   *  source. Returns { source, issueId, seriesId } or null when no source has it. */
  async function fulfil(r) {
    const kind = kindOf(r.kind);
    if (kind === 'comic') return null;
    const libraryId = libraryFor(kind);
    if (!libraryId) return null;
    let sources = [];
    try { sources = (registeredRemoteMediaSources?.(kind) || []).filter((src) => typeof src.search === 'function'); } catch { /* older core */ }
    const want = { title: r.title, authors: r.author ? String(r.author).split(',').map((a) => a.trim()).filter(Boolean) : [] };
    for (const src of sources) {
      let hits = [];
      try { hits = await src.search(null, r.title); } catch { continue; }
      const hit = (hits || []).find((h) => h?.remote_id != null && similar(want, h.meta));
      if (!hit) continue;
      const st = await bookStore(kind);
      if (!st?.catalogRemote) return null;
      const out = st.catalogRemote({ libraryId, source: src.id, remoteId: String(hit.remote_id), meta: hit.meta || {} });
      if (!out?.issueId) continue;
      store.fulfil(r.id, out.issueId);
      return { source: src.label || src.id, issueId: out.issueId, seriesId: out.seriesId };
    }
    return null;
  }

  // Approved book requests nothing has filled yet: a scan or import may have
  // brought the book in since (title/author match), or a source may have it
  // now. Either way the requester hears about it.
  api.registerJob?.({
    id: 'requests-fulfil',
    label: 'Fill approved book requests',
    scheduleKey: 'requestsFulfilHours',
    run: async () => {
      for (const r of store.unfulfilled()) {
        let landed = null;
        if (r.issue_id) { store.fulfil(r.id, r.issue_id); landed = { issueId: r.issue_id }; }
        else landed = await fulfil(r).catch(() => null);
        if (landed && notifyLater) {
          try { notifyLater({ type: 'request.available', category: 'request', level: 'success', title: 'Your request is in', body: `${r.title || 'A book'} is now in the library.`, userId: r.requested_by }); } catch { /* best-effort */ }
        }
      }
    },
  });

  // Queue every missing issue of the (just-added) volume and kick the core
  // download worker. Normally gated by the acting user's own downloads.grab —
  // the requester on auto-approve, the approver on a manual approve. `force`
  // bypasses that gate: it's set when the SERVER is configured to auto-download
  // added volumes (autoDownloadOnAdd), an admin-level automation that shouldn't
  // hinge on which user happened to trigger it.
  function queueVolumeDownloads(req, cvVolumeId, { force = false } = {}) {
    if (!force && !grants(req, 'downloads.grab')) return 0;
    const core = requireCoreDb();
    const sid = core.prepare('SELECT id FROM series WHERE cv_id = ?').get(cvVolumeId)?.id;
    if (!sid) return 0;
    const missing = core.prepare(`
      SELECT ci.comicvine_id, ci.issue_number, ci.name FROM cv_issues ci
       WHERE ci.cv_series_id = ? AND NOT EXISTS
         (SELECT 1 FROM library_files lf WHERE lf.cv_issue_id = ci.comicvine_id AND lf.valid = 1)
    `).all(cvVolumeId);
    const ids = missing.map((ci) => ensureCvIssueRow(core, {
      seriesId: sid, cvIssueId: ci.comicvine_id, number: ci.issue_number, title: ci.name,
    }));
    if (ids.length) {
      queueIssues(core, ids);
      req.app?.locals?.startDownloads?.(); // absent on old cores → rows resume at next kick/boot
    }
    return ids.length;
  }

  // An approved request is a WANT, not just a one-off download: every missing
  // issue of the volume is picked for the requester (reason request:<id>), so
  // automation keeps after them whatever the series' monitoring policy, and
  // the requester is told when each one lands. No-op where the policy already
  // wants them; tolerated on a core without picks.
  function wantVolume(cvVolumeId, requestId, userId) {
    const core = requireCoreDb();
    const sid = core.prepare('SELECT id FROM series WHERE cv_id = ?').get(cvVolumeId)?.id;
    if (!sid) return 0;
    const ids = core.prepare(`SELECT ci.comicvine_id id FROM cv_issues ci WHERE ci.cv_series_id = ?
      AND NOT EXISTS (SELECT 1 FROM library_files lf WHERE lf.cv_issue_id = ci.comicvine_id AND lf.valid = 1)`).all(cvVolumeId).map((r) => r.id);
    try { return setIssueWants(core, sid, ids, true, { reason: `request:${requestId}`, userId: userId || null }).changed; }
    catch { return 0; }
  }

  // GET /api/requests — the queue, newest pending first, with per-user vote
  // state and live library progress. Any requester may see all requests
  // (votes only make sense in the open).
  api.registerRoute('get', '/api/requests', (req, res) => {
    remember(req);
    res.json({
      requests: store.list(uid(req)),
      pending: store.pendingCount(),
      autoApprove: !!config.requestsAutoApprove,
      canManage: manages(req),
      // Which kinds may be requested here (comics always; the others only
      // with their plugin and a library of that type).
      media: { comic: true, ...mediaEnabled() },
    });
  }, { access: CAN_CREATE });

  // GET /api/requests/count — just the pending tally, for the sidebar badge.
  // The badge used to pull the whole queue (half a megabyte on a busy
  // install) on every page load to read one number.
  api.registerRoute('get', '/api/requests/count', (req, res) => {
    res.json({ pending: store.pendingCount(), canManage: manages(req) });
  }, { access: CAN_CREATE });

  // GET /api/requests/search?q= — ComicVine volume search annotated with
  // library/request state so the UI can offer the right action per result.
  api.registerRoute('get', '/api/requests/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ results: [] });
    const kind = kindOf(req.query.kind);
    if (kind !== 'comic') {
      // Books and audiobooks: the metadata service's catalog, annotated the
      // same way (on the shelf already? already asked for?).
      if (!mediaEnabled()[kind]) return res.status(400).json({ error: `${kind === 'ebook' ? 'books' : 'audiobooks'} can’t be requested on this server` });
      const client = await bookClient(kind);
      if (!client) return res.status(503).json({ error: 'the metadata service is not available' });
      try {
        if (!client.available()) await client.ensureKey?.();
        const found = (await client.search(q, 12)) || [];
        return res.json({ results: found.map(kind === 'ebook' ? normBook : normAudio).map(annotateItem) });
      } catch (e) { return res.status(502).json({ error: String(e?.message || e) }); }
    }
    try {
      // No-collections detection leans on the volume blurb, so pull descriptions
      // for the search too (a collected edition often only reveals itself there —
      // e.g. "Trade paperback collecting …" on a plainly-named volume).
      const found = await cv().search(q, { withDescription: !!config.requestsNoCollections });
      // Policy filters (Western-only / no-collections) hide disallowed volumes
      // from the results outright, so they can't be requested (the create route
      // enforces the same, since a crafted request would bypass the UI).
      const filtered = config.requestsWesternOnly || config.requestsNoCollections;
      const allowed = filtered ? found.filter(requestable) : found;
      res.json({
        results: allowed.map((v) => {
          const lib = store.libraryState(v.id);
          const open = store.openFor(v.id);
          return {
            ...v,
            inLibrary: lib.series_id != null,
            seriesId: lib.series_id,
            requestId: open?.id ?? null,
          };
        }),
      });
    } catch (e) { res.status(502).json({ error: String(e?.message || e) }); }
  }, { access: CAN_CREATE });

  // POST /api/requests { comicvineId, note } — file a request. Duplicate of an
  // open request → seconds it (vote). Already in the library → says so.
  // With auto-approve on, the volume is added immediately and the response
  // carries what the CLIENT needs to optionally start downloads itself.
  api.registerRoute('post', '/api/requests', async (req, res) => {
    remember(req);
    const body = req.body || {};
    const kind = kindOf(body.kind);
    if (kind !== 'comic') {
      // A book or audiobook: the service's own record of it (falling back to
      // what the client saw), deduped by catalog id like volumes are.
      if (!mediaEnabled()[kind]) return res.status(400).json({ error: `${kind === 'ebook' ? 'books' : 'audiobooks'} can’t be requested on this server` });
      const id = String(body.externalId || '').trim();
      if (!id) return res.status(400).json({ error: 'externalId required' });
      const item = (await lookupItem(kind, id)) || (body.title ? { kind, id, title: String(body.title), author: body.author || null, publisher: null, year: body.year || null, cover: body.cover || null } : null);
      if (!item) return res.status(404).json({ error: 'no such item' });
      const lib = store.bookState(kind, id, item.title, item.author, null);
      if (lib.issue_id != null) return res.status(409).json({ error: 'already in the library', seriesId: lib.series_id });
      try {
        const { request, seconded } = store.createItem(uid(req), uname(req), kind, item, body.note);
        if (seconded) return res.json({ request, seconded: true });
        if (config.requestsAutoApprove) {
          store.approve(request.id, 'auto-approve');
          const f = await fulfil(store.get(request.id, uid(req)));
          notify(req, { type: 'request.approved', category: 'request', level: 'success', title: 'Request added', body: f ? `${item.title} was added to the library.` : `${item.title} was approved — it will be added when a source has it.` });
          return res.json({ request: store.get(request.id, uid(req)), autoApproved: true, fulfilled: !!f, seriesId: f?.seriesId ?? null });
        }
        notify(req, { type: 'request.filed', category: 'request', level: 'info', title: 'New request', body: `${uname(req)} requested ${item.title}${item.author ? ' by ' + item.author : ''}.` });
        return res.json({ request });
      } catch (e) { return res.status(502).json({ error: String(e?.message || e) }); }
    }
    const cvId = Number(body.comicvineId);
    if (!cvId) return res.status(400).json({ error: 'comicvineId required' });
    const lib = store.libraryState(cvId);
    if (lib.series_id != null) {
      return res.status(409).json({ error: 'already in the library', seriesId: lib.series_id });
    }
    try {
      const vol = await cv().volume(cvId);
      // Enforce the request policies server-side (the search hides these, but a
      // crafted request would otherwise slip through). The create path has the
      // volume's full description, so collection detection is strongest here.
      if (!requestable(vol)) {
        const why = (config.requestsNoCollections && isCollection(vol))
          ? 'collected editions (TPBs, omnibuses, …) can’t be requested on this server'
          : 'only Western comics can be requested on this server';
        return res.status(403).json({ error: why });
      }
      const { request, seconded } = store.create(uid(req), uname(req), vol, (req.body || {}).note);
      if (seconded) return res.json({ request, seconded: true });
      if (config.requestsAutoApprove) {
        const r = await addSeriesFromCv(requireCoreDb(), cv(), cvId);
        store.approve(request.id, 'auto-approve');
        wantVolume(cvId, request.id, uid(req));
        // With auto-download-on-add configured, missing issues download for
        // every auto-approved request regardless of the requester's own
        // permission (it's a server-wide automation). Otherwise they still
        // download when the requester's role may grab.
        const queued = queueVolumeDownloads(req, cvId, { force: !!config.autoDownloadOnAdd });
        notify(req, { type: 'request.approved', category: 'request', level: 'success', title: 'Request added', body: `${vol.name} was added to the library.` });
        return res.json({ request: store.get(request.id, uid(req)), autoApproved: true, seriesId: r.seriesId, queued });
      }
      // Heads-up for reviewers (broadcast; the webhook pings their channel).
      notify(req, { type: 'request.filed', category: 'request', level: 'info', title: 'New request', body: `${uname(req)} requested ${vol.name}${vol.start_year ? ' (' + vol.start_year + ')' : ''}.` });
      res.json({ request });
    } catch (e) { res.status(502).json({ error: String(e?.message || e) }); }
  }, { access: CAN_CREATE });

  // POST /api/requests/:id/vote { on }
  api.registerRoute('post', '/api/requests/:id/vote', (req, res) => {
    const r = store.get(Number(req.params.id), uid(req));
    if (!r) return res.status(404).json({ error: 'no such request' });
    store.vote(uid(req), r.id, !!(req.body || {}).on);
    res.json({ request: store.get(r.id, uid(req)) });
  }, { access: CAN_CREATE });

  // POST /api/requests/:id/approve { download? } — adds the volume to the
  // library, marks the request approved, and (with download:true) queues
  // every missing issue server-side under the APPROVER's own permission.
  api.registerRoute('post', '/api/requests/:id/approve', async (req, res) => {
    remember(req);
    const r = store.get(Number(req.params.id), uid(req));
    if (!r) return res.status(404).json({ error: 'no such request' });
    if (r.status !== 'pending') return res.status(400).json({ error: 'request already decided' });
    if (kindOf(r.kind) !== 'comic') {
      // A book: approve, then shelve it from a source if one has it. Nothing
      // to download — a remote entry reads/plays on demand.
      try {
        store.approve(r.id, uname(req));
        const f = await fulfil(r);
        const after = store.get(r.id, uid(req));
        notify(req, { type: 'request.approved', category: 'request', level: 'success', title: 'Request approved', body: f ? `Your request for ${r.title || 'a book'} was approved and it is in the library now.` : `Your request for ${r.title || 'a book'} was approved — it will be added when a source has it.`, userId: r.requested_by });
        return res.json({ request: after, seriesId: after.series_id, fulfilled: !!f, source: f?.source ?? null });
      } catch (e) { return res.status(502).json({ error: String(e?.message || e) }); }
    }
    try {
      await addSeriesFromCv(requireCoreDb(), cv(), r.cv_volume_id);
      store.approve(r.id, uname(req));
      wantVolume(r.cv_volume_id, r.id, r.requested_by);
      const queued = (req.body || {}).download ? queueVolumeDownloads(req, r.cv_volume_id) : 0;
      const after = store.get(r.id, uid(req));
      // Tell the requester (targeted — only they + managers see it).
      notify(req, { type: 'request.approved', category: 'request', level: 'success', title: 'Request approved', body: `Your request for ${r.title || 'a volume'} was approved${queued ? ` — ${queued} issue(s) downloading` : ''}.`, userId: r.requested_by });
      res.json({ request: after, seriesId: after.series_id, queued });
    } catch (e) { res.status(502).json({ error: String(e?.message || e) }); }
  }, { access: CAN_MANAGE });

  // POST /api/requests/:id/decline { reason }
  api.registerRoute('post', '/api/requests/:id/decline', (req, res) => {
    const r = store.get(Number(req.params.id), uid(req));
    if (!r) return res.status(404).json({ error: 'no such request' });
    if (r.status !== 'pending') return res.status(400).json({ error: 'request already decided' });
    const reason = (req.body || {}).reason;
    store.decline(r.id, uname(req), reason);
    notify(req, { type: 'request.declined', category: 'request', level: 'warn', title: 'Request declined', body: reason ? `${r.title || 'Your request'}: ${reason}` : `Your request for ${r.title || 'a volume'} was declined.`, userId: r.requested_by });
    res.json({ request: store.get(r.id, uid(req)) });
  }, { access: CAN_MANAGE });

  // DELETE /api/requests/:id — managers delete anything; a requester may
  // withdraw their OWN request while it's still pending.
  api.registerRoute('delete', '/api/requests/:id', (req, res) => {
    const r = store.get(Number(req.params.id), uid(req));
    if (!r) return res.status(404).json({ error: 'no such request' });
    const own = r.requested_by === uid(req) && r.status === 'pending';
    if (!own && !manages(req)) {
      return res.status(403).json({ error: 'you can only withdraw your own pending requests' });
    }
    store.remove(r.id);
    res.json({ ok: true });
  }, { access: CAN_CREATE });
}
