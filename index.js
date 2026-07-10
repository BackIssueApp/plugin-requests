// Requests plugin for BackIssue — users ask for volumes, curators approve.
// Viewers search ComicVine and file requests (duplicates become votes);
// roles with requests.manage review the queue, approve (which adds the
// volume to the library) or decline with a reason. Downloads after approval
// are triggered CLIENT-side through the core download endpoint, so they run
// under the acting user's own downloads permission — this plugin never
// escalates anyone's rights.
import Database from 'better-sqlite3';
import config from '../../src/config.js';
import { makeCvClient } from '../../src/cv.js';
import { addSeriesFromCv } from '../../src/cvmatch.js';
import { ensureCvIssueRow, queueIssues } from '../../src/db.js';
import { roleGrants, CORE_PERMISSIONS } from '../../src/users.js';
import { registeredPermissions } from '../../src/plugins.js';
import { openRequestsStore } from './store.js';
import { isWestern } from './western.js';

export default function register(api) {
  api.registerClientAsset({ js: 'client/requests.js', css: 'client/requests.css' });

  // Grantable permissions: filing requests is viewer-tier, deciding them is
  // trusted-tier. Custom roles can hold either independently.
  const CAN_CREATE = api.registerPermission ? 'requests.create' : 'viewer';
  const CAN_MANAGE = api.registerPermission ? 'requests.manage' : 'trusted';
  api.registerPermission?.({
    key: 'requests.create',
    label: 'Request volumes',
    description: 'Search ComicVine and request volumes for the library (and vote on requests)',
    tier: 'viewer',
  });
  api.registerPermission?.({
    key: 'requests.manage',
    label: 'Manage requests',
    description: 'Approve or decline volume requests (approval adds the volume to the library)',
    tier: 'trusted',
  });

  api.registerSettings({
    requestsAutoApprove: { type: 'bool' }, // every request is approved + added instantly
    requestsWesternOnly: { type: 'bool' }, // only Western-publisher volumes may be requested
  });

  // Is this volume requestable under the current policy? With "Western only"
  // on, a volume is allowed only if its ComicVine publisher is on the Western
  // allowlist (see western.js) — foreign AND unknown publishers are blocked.
  const requestable = (vol) => !config.requestsWesternOnly || isWestern(vol?.publisher);

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

  // GET /api/requests — the queue, newest pending first, with per-user vote
  // state and live library progress. Any requester may see all requests
  // (votes only make sense in the open).
  api.registerRoute('get', '/api/requests', (req, res) => {
    res.json({
      requests: store.list(uid(req)),
      pending: store.pendingCount(),
      autoApprove: !!config.requestsAutoApprove,
      canManage: manages(req),
    });
  }, { access: CAN_CREATE });

  // GET /api/requests/search?q= — ComicVine volume search annotated with
  // library/request state so the UI can offer the right action per result.
  api.registerRoute('get', '/api/requests/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ results: [] });
    try {
      const found = await cv().search(q);
      // "Western only" hides non-Western volumes from the results outright, so
      // they can't be requested (the create route enforces it too).
      const allowed = config.requestsWesternOnly ? found.filter(requestable) : found;
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
    const cvId = Number((req.body || {}).comicvineId);
    if (!cvId) return res.status(400).json({ error: 'comicvineId required' });
    const lib = store.libraryState(cvId);
    if (lib.series_id != null) {
      return res.status(409).json({ error: 'already in the library', seriesId: lib.series_id });
    }
    try {
      const vol = await cv().volume(cvId);
      // Enforce the Western-only policy server-side (the search hides these, but
      // a crafted request would otherwise slip through).
      if (!requestable(vol)) {
        return res.status(403).json({ error: 'only Western comics can be requested on this server' });
      }
      const { request, seconded } = store.create(uid(req), uname(req), vol, (req.body || {}).note);
      if (seconded) return res.json({ request, seconded: true });
      if (config.requestsAutoApprove) {
        const r = await addSeriesFromCv(requireCoreDb(), cv(), cvId);
        store.approve(request.id, 'auto-approve');
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
    const r = store.get(Number(req.params.id), uid(req));
    if (!r) return res.status(404).json({ error: 'no such request' });
    if (r.status !== 'pending') return res.status(400).json({ error: 'request already decided' });
    try {
      await addSeriesFromCv(requireCoreDb(), cv(), r.cv_volume_id);
      store.approve(r.id, uname(req));
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
