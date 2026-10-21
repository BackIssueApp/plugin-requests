// Requests plugin for BackIssue — users ask for volumes, books and
// audiobooks; curators approve. Viewers search (ComicVine for comics, the
// metadata service for books and audiobooks) and file requests (duplicates
// become votes); roles with requests.manage review the queue, approve or
// decline with a reason. Approving a comic adds the volume to the library;
// approving a book asks every remote source that can search and shelves the
// hit as an on-demand entry — or leaves the request waiting, to be asked
// again by the hourly job and satisfied by any later scan that matches.
// Books and audiobooks only appear where the owning plugin is loaded and a
// library of that type exists. An approval downloads when auto-approve is
// on (a server-wide choice) or when the approver holds downloads.grab;
// otherwise it only adds to the library — this plugin never escalates
// anyone's rights.
import Database from 'better-sqlite3';
import config from '../../src/config.js';
import { makeCvClient } from '../../src/cv.js';
import { addSeriesFromCv } from '../../src/cvmatch.js';
import { ensureCvIssueRow, queueIssues, setIssueWants } from '../../src/db.js';
import { roleGrants, CORE_PERMISSIONS } from '../../src/users.js';
import { registeredPermissions, pluginLibraryTypes } from '../../src/plugins.js';
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
    // Per media type: on = that type can't be searched or requested here.
    requestsNoComics: { type: 'bool' },
    requestsNoBooks: { type: 'bool' },
    requestsNoAudiobooks: { type: 'bool' },
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
  // Which kinds may be requested: comics unless turned off; books and
  // audiobooks need their plugin and library too.
  function mediaEnabled() {
    let types = new Set();
    try { types = new Set((pluginLibraryTypes?.() || []).map((t) => t.id)); } catch { /* older core */ }
    const has = (t) => types.has(t) && libraryFor(t) != null;
    return {
      comic: !config.requestsNoComics,
      ebook: !config.requestsNoBooks && has('ebook'),
      audiobook: !config.requestsNoAudiobooks && has('audiobook'),
    };
  }
  const KIND_PLURAL = { comic: 'comics', ebook: 'books', audiobook: 'audiobooks' };
  const kindOff = (res, kind) => res.status(400).json({ error: `${KIND_PLURAL[kind]} can’t be requested on this server` });
  async function bookClient(kind) {
    try {
      if (kind === 'ebook') { const { makeBooksClient } = await import('../ebooks/metadata.js'); return makeBooksClient(config); }
      const { makeAudiobookClient } = await import('../audiobooks/metadata.js'); return makeAudiobookClient(config);
    } catch { return null; }
  }
  const year4 = (v) => { const m = String(v || '').match(/\d{4}/); return m ? m[0] : null; };
  // One shape for both kinds, whatever the service calls the fields.
  const normBook = (r) => ({
    kind: 'ebook', id: String(r.id), title: r.title || 'Untitled',
    author: (Array.isArray(r.authors) ? r.authors : []).join(', ') || null,
    publisher: r.publisher || null, year: year4(r.published_date), cover: r.thumbnail || null,
    isbn: r.isbn_13 || r.isbn_10 || null,
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

  // ---- getting a book from the download sources ---------------------------
  // An approved book or audiobook goes to the app's media download: every
  // enabled download source that serves its kind — usenet and torrent
  // always, a site source only when it declares ebooks or audiobooks — is
  // searched in priority order, the first match is grabbed, and the plugin
  // that owns the library type files the result. The request is marked
  // fulfilled when the file lands (onMediaDownload below), or by the job when
  // a scan or import brings the book in some other way. Remote catalogs
  // (on-demand shelves) are not consulted: what they carry is on the shelf
  // already, so a request for it would never be filed.
  const REF = (id) => `requests:${id}`;
  const refId = (ref) => { const m = /^requests:(\d+)$/.exec(String(ref || '')); return m ? Number(m[1]) : null; };
  const canDownload = typeof api.downloadMedia === 'function';
  /** The latest download attempt for a request, for the queue row:
   *  { status: 'active' | 'imported' | 'failed', source, release, error }. */
  function downloadState(r) {
    if (!canDownload || kindOf(r.kind) === 'comic') return null;
    try {
      const g = requireCoreDb().prepare('SELECT source, title, status, error, grabbed_at FROM grabs WHERE ref = ? ORDER BY id DESC LIMIT 1').get(REF(r.id));
      return g ? { status: g.status, source: g.source, release: g.title, error: g.error, at: g.grabbed_at } : null;
    } catch { return null; }
  }
  /** Ask the sources for an approved book. → { status, source?, release?, error? }
   *  where status is grabbed | downloading | imported | active (already on
   *  its way) | no-match | no-sources | no-library | unsupported | error. */
  async function fulfil(r) {
    const kind = kindOf(r.kind);
    if (kind === 'comic') return { status: 'n/a' };
    const libraryId = libraryFor(kind);
    if (!libraryId) return { status: 'no-library' };
    if (!canDownload) return { status: 'unsupported' };
    const current = downloadState(r);
    if (current?.status === 'active') return { status: 'active', source: current.source, release: current.release };
    try {
      return await api.downloadMedia({
        db: requireCoreDb(), type: kind, libraryId, ref: REF(r.id),
        title: r.title, author: r.author || null, year: r.start_year || null, isbn: r.isbn || null,
      });
    } catch (e) { return { status: 'error', error: String(e?.message || e) }; }
  }
  /** Fetch an approved book only when the approval allowed it. */
  const fulfilIfAllowed = (r) => (r.may_download === 0 ? Promise.resolve({ status: 'not-allowed' }) : fulfil(r));
  const KIND_WORD = { ebook: 'book', audiobook: 'audiobook' };
  /** One line for the person who approved: what happened to the download. */
  function downloadNote(f, r) {
    const t = r.title || `the ${KIND_WORD[kindOf(r.kind)] || 'book'}`;
    switch (f?.status) {
      case 'grabbed': case 'downloading': return `${t} is downloading from ${f.source}${f.release ? ` (${f.release})` : ''}.`;
      case 'active': return `${t} is already downloading from ${f.source}.`;
      case 'imported': return `${t} is in the library now.`;
      case 'no-match': return `No source had ${t} — it will be tried again on the Fill approved book requests schedule.`;
      case 'no-sources': return `No download source is enabled that carries ${KIND_WORD[kindOf(r.kind)] || 'book'}s — turn one on under Settings → Downloading.`;
      case 'no-library': return `There is no ${KIND_WORD[kindOf(r.kind)] || 'book'} library to file it into.`;
      case 'unsupported': return 'This version of the app cannot download books — update it to 0.8.4 or later.';
      case 'error': return `The download could not start: ${f.error}`;
      case 'not-allowed': return `You can't download, so nothing was fetched — ${t} is marked available when a scan or import brings it in.`;
      default: return '';
    }
  }
  // The download landed (or did not): the request is fulfilled and the
  // requester told; a failure is left for the job to retry.
  api.onMediaDownload?.((e) => {
    const id = refId(e?.ref);
    if (!id) return;
    const r = store.get(id);
    if (!r || r.status !== 'approved') return;
    if (e.event === 'imported' && e.issueId) {
      store.fulfil(id, e.issueId);
      if (notifyLater) {
        try { notifyLater({ type: 'request.available', category: 'request', level: 'success', title: 'Your request is in', body: `${r.title || 'Your book'} is now in the library.`, userId: r.requested_by }); } catch { /* best-effort */ }
      }
    }
  });

  // Approved book requests nothing has filled yet: a scan or import may have
  // brought the book in since (title/author match) — then the requester
  // hears about it — or the sources are asked again (a new release may have
  // been posted; a failed grab's release is blacklisted, so the next-best is
  // tried). A download already in flight is left alone.
  // Every six hours unless the Jobs page says otherwise.
  config.requestsFulfilCron ??= '0 */6 * * *';
  config.requestsFulfilEnabled ??= true;
  api.registerJob?.({
    id: 'requests-fulfil',
    label: 'Fill approved book requests',
    scheduleKey: 'requestsFulfilHours',
    run: async () => {
      let asked = 0; let landed = 0;
      for (const r of store.unfulfilled()) {
        if (r.issue_id) {
          store.fulfil(r.id, r.issue_id); landed++;
          if (notifyLater) {
            try { notifyLater({ type: 'request.available', category: 'request', level: 'success', title: 'Your request is in', body: `${r.title || 'A book'} is now in the library.`, userId: r.requested_by }); } catch { /* best-effort */ }
          }
          continue;
        }
        if (r.may_download === 0) continue; // approved by someone who can't download
        const f = await fulfil(r).catch(() => null);
        if (f && ['grabbed', 'downloading', 'imported'].includes(f.status)) asked++;
        if (f?.status === 'no-sources' || f?.status === 'unsupported') break; // the same answer for every request
      }
      return { asked, landed };
    },
  });

  // Queue every missing issue of the (just-added) volume and kick the core
  // download worker. Gated by the approver's own downloads.grab on a manual
  // approve; `force` bypasses that for auto-approve, a server-wide choice
  // that shouldn't hinge on which user happened to file the request.
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
      requests: store.list(uid(req)).map((r) => (r.kind && r.kind !== 'comic' ? { ...r, download: downloadState(r) } : r)),
      pending: store.pendingCount(),
      autoApprove: !!config.requestsAutoApprove,
      canManage: manages(req),
      // Which kinds may be requested here (each can be turned off in
      // settings; books and audiobooks also need their plugin and library).
      media: mediaEnabled(),
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
    if (!mediaEnabled()[kind]) return kindOff(res, kind);
    if (kind !== 'comic') {
      // Books and audiobooks: the metadata service's catalog, annotated the
      // same way (on the shelf already? already asked for?).
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
    if (!mediaEnabled()[kind]) return kindOff(res, kind);
    if (kind !== 'comic') {
      // A book or audiobook: the service's own record of it (falling back to
      // what the client saw), deduped by catalog id like volumes are.
      const id = String(body.externalId || '').trim();
      if (!id) return res.status(400).json({ error: 'externalId required' });
      const item = (await lookupItem(kind, id)) || (body.title ? { kind, id, title: String(body.title), author: body.author || null, publisher: null, year: body.year || null, cover: body.cover || null, isbn: body.isbn || null } : null);
      if (!item) return res.status(404).json({ error: 'no such item' });
      const lib = store.bookState(kind, id, item.title, item.author, null);
      if (lib.issue_id != null) return res.status(409).json({ error: 'already in the library', seriesId: lib.series_id });
      try {
        const { request, seconded } = store.createItem(uid(req), uname(req), kind, item, body.note);
        if (seconded) return res.json({ request, seconded: true });
        if (config.requestsAutoApprove) {
          store.approve(request.id, 'auto-approve');
          const approved = store.get(request.id, uid(req));
          const f = await fulfil(approved);
          notify(req, { type: 'request.approved', category: 'request', level: 'success', title: 'Request approved', body: `${item.title} was approved. ${downloadNote(f, approved)}`.trim() });
          return res.json({ request: store.get(request.id, uid(req)), autoApproved: true, download: f, note: downloadNote(f, approved) });
        }
        notify(req, { type: 'request.filed', category: 'request', level: 'info', title: 'New request', body: `${uname(req)} requested ${item.title}${item.author ? ' by ' + item.author : ''}.`, params: { user: uname(req), what: `${item.title}${item.author ? ' · ' + item.author : ''}` } });
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
        // Auto-approve is the admin's say-so: missing issues download
        // whoever filed the request.
        const queued = queueVolumeDownloads(req, cvId, { force: true });
        notify(req, { type: 'request.approved', category: 'request', level: 'success', title: 'Request added', body: `${vol.name} was added to the library.` });
        return res.json({ request: store.get(request.id, uid(req)), autoApproved: true, seriesId: r.seriesId, queued });
      }
      // Heads-up for reviewers (broadcast; the webhook pings their channel).
      notify(req, { type: 'request.filed', category: 'request', level: 'info', title: 'New request', body: `${uname(req)} requested ${vol.name}${vol.start_year ? ' (' + vol.start_year + ')' : ''}.`, params: { user: uname(req), what: `${vol.name}${vol.start_year ? ' (' + vol.start_year + ')' : ''}` } });
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
      // A book: approve, then — when the approver may download — ask the
      // download sources for it. The requester is told now that it was
      // approved, and again when the file lands.
      try {
        store.approve(r.id, uname(req), { download: grants(req, 'downloads.grab') });
        const f = await fulfilIfAllowed(store.get(r.id, uid(req)));
        const after = store.get(r.id, uid(req));
        const started = ['grabbed', 'downloading', 'active'].includes(f?.status);
        notify(req, { type: 'request.approved', category: 'request', level: 'success', title: 'Request approved', body: `Your request for ${r.title || 'a book'} was approved${f?.status === 'imported' ? ' and it is in the library now' : started ? ' and it is downloading' : f?.status === 'not-allowed' ? ' — you will hear when it reaches the library' : ' — it will be added when a source has it'}.`, userId: r.requested_by });
        return res.json({ request: after, seriesId: after.series_id, download: f, note: downloadNote(f, r) });
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
