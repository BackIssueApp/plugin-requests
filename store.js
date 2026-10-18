// Request state: plugin-owned tables inside catalog.db (DB backups cover
// them). Item metadata is denormalized onto the request row — a request's
// history must survive the volume later being removed from the catalog cache
// or the requester's account being deleted.
//
// A request is for one of three kinds of thing: a comic volume (ComicVine
// id), a book (the metadata service's volume id), or an audiobook (its
// ASIN). Comics keep their original column; the other two carry their id in
// `external_id`. Each kind reads its library state from the tables the
// owning plugin keeps, so "available" means the same thing everywhere.
import Database from 'better-sqlite3';

export const KINDS = ['comic', 'ebook', 'audiobook'];

export function openRequestsStore(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cv_volume_id INTEGER NOT NULL,
      title TEXT, start_year TEXT, publisher TEXT, cover_url TEXT, issue_count INTEGER,
      note TEXT,
      requested_by INTEGER NOT NULL DEFAULT 0,
      requested_by_name TEXT,
      status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | declined
      decided_by_name TEXT,
      decline_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      decided_at TEXT
    );
    -- One OPEN request per volume; approved/declined rows are history and a
    -- volume may be re-requested after a decline (or after it was removed).
    CREATE UNIQUE INDEX IF NOT EXISTS idx_requests_open
      ON requests(cv_volume_id) WHERE status = 'pending' AND cv_volume_id > 0;
    CREATE TABLE IF NOT EXISTS request_votes (
      request_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      PRIMARY KEY (request_id, user_id)
    );
  `);
  // Books and audiobooks arrived after comics: the kind, the id in its own
  // catalog, the author (comics have a publisher), and — once a source has
  // put it in the library — the core issue that fulfilled it.
  const cols = db.prepare("SELECT name FROM pragma_table_info('requests')").all().map((r) => r.name);
  if (!cols.includes('kind')) db.exec("ALTER TABLE requests ADD COLUMN kind TEXT NOT NULL DEFAULT 'comic'");
  if (!cols.includes('external_id')) db.exec('ALTER TABLE requests ADD COLUMN external_id TEXT');
  if (!cols.includes('author')) db.exec('ALTER TABLE requests ADD COLUMN author TEXT');
  if (!cols.includes('fulfilled_issue_id')) db.exec('ALTER TABLE requests ADD COLUMN fulfilled_issue_id INTEGER');
  // A book's ISBN, when its catalog knows one: the surest key a download
  // source can search by.
  if (!cols.includes('isbn')) db.exec('ALTER TABLE requests ADD COLUMN isbn TEXT');
  // Whether the approval lets the download sources fetch it: set on
  // auto-approve, or when the approver may download. Older approvals keep
  // being filled as before.
  if (!cols.includes('may_download')) db.exec('ALTER TABLE requests ADD COLUMN may_download INTEGER NOT NULL DEFAULT 1');
  // The original open-index was on cv_volume_id alone; a book row carries 0
  // there, so the partial index above excludes it and this one takes over.
  const idx = db.prepare("SELECT sql FROM sqlite_master WHERE name='idx_requests_open'").get()?.sql || '';
  if (!/cv_volume_id > 0/.test(idx)) {
    db.exec('DROP INDEX IF EXISTS idx_requests_open');
    db.exec("CREATE UNIQUE INDEX idx_requests_open ON requests(cv_volume_id) WHERE status = 'pending' AND cv_volume_id > 0");
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_requests_open_ext
      ON requests(kind, external_id) WHERE status = 'pending' AND external_id IS NOT NULL`);

  const hasTable = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

  // Library state for a CV volume: the local series (if tracked) and how much
  // of it is on disk. Tolerates cores whose catalog tables are absent.
  function comicState(cvVolumeId) {
    try {
      const s = db.prepare('SELECT id FROM series WHERE cv_id = ?').get(cvVolumeId);
      if (!s) return { series_id: null, owned: 0, total: 0 };
      const owned = db.prepare(`
        SELECT COUNT(DISTINCT lf.cv_issue_id) n FROM library_files lf
          JOIN cv_issues ci ON ci.comicvine_id = lf.cv_issue_id
         WHERE ci.cv_series_id = ? AND lf.valid = 1`).get(cvVolumeId).n;
      const total = db.prepare('SELECT COUNT(*) n FROM cv_issues WHERE cv_series_id = ?').get(cvVolumeId).n;
      return { series_id: s.id, owned, total };
    } catch {
      return { series_id: null, owned: 0, total: 0 };
    }
  }

  // Library state for a book or audiobook: the issue that fulfilled the
  // request, else a row the owning plugin matched to the same catalog id,
  // else the same title (and author, when both sides know one). A file-less
  // remote entry counts — it reads/plays on demand — so owned/total is 1/1
  // the moment the row exists.
  function bookState(kind, externalId, title, author, fulfilledIssueId) {
    const table = kind === 'audiobook' ? 'audiobooks_files' : 'ebooks_files';
    if (!hasTable(table)) return { series_id: null, owned: 0, total: 0, issue_id: null };
    try {
      const found = (issueId) => {
        const i = db.prepare('SELECT id, series_id FROM issues WHERE id = ?').get(issueId);
        return i ? { series_id: i.series_id, owned: 1, total: 1, issue_id: i.id } : null;
      };
      if (fulfilledIssueId) { const f = found(fulfilledIssueId); if (f) return f; }
      if (externalId) {
        const m = db.prepare(`SELECT issue_id FROM ${table} WHERE match_id = ? AND issue_id IS NOT NULL`).get(String(externalId));
        if (m) { const f = found(m.issue_id); if (f) return f; }
      }
      if (title) {
        const rows = db.prepare(`SELECT f.issue_id, s.publisher FROM ${table} f
            JOIN issues i ON i.id = f.issue_id JOIN series s ON s.id = i.series_id
           WHERE lower(trim(i.title)) = lower(trim(?)) LIMIT 8`).all(title);
        const a = norm(author);
        const hit = rows.find((r) => !a || !r.publisher || norm(r.publisher).includes(a) || a.includes(norm(r.publisher)));
        if (hit) { const f = found(hit.issue_id); if (f) return f; }
      }
    } catch { /* plugin tables changed shape: treated as not in the library */ }
    return { series_id: null, owned: 0, total: 0, issue_id: null };
  }
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  function libraryStateOf(r) {
    return r.kind === 'comic' || !r.kind
      ? comicState(r.cv_volume_id)
      : bookState(r.kind, r.external_id, r.title, r.author, r.fulfilled_issue_id);
  }

  const withState = (userId) => (r) => {
    const lib = libraryStateOf(r);
    const votes = db.prepare('SELECT COUNT(*) n FROM request_votes WHERE request_id = ?').get(r.id).n;
    const voted = !!db.prepare('SELECT 1 FROM request_votes WHERE request_id = ? AND user_id = ?').get(r.id, userId);
    // Derived display status: an approved request whose item is fully on
    // disk (or on the shelf, for a remote book) is "available"; a partly
    // filled volume shows progress client-side.
    const display = r.status === 'approved' && lib.total > 0 && lib.owned >= lib.total ? 'available' : r.status;
    return { ...r, kind: r.kind || 'comic', ...lib, votes, voted, display };
  };

  return {
    list(userId) {
      return db.prepare('SELECT * FROM requests ORDER BY (status = \'pending\') DESC, created_at DESC')
        .all().map(withState(userId));
    },
    get(id, userId = 0) {
      const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
      return r ? withState(userId)(r) : null;
    },
    /** The open request for a comic volume, if any (dedupe target). */
    openFor(cvVolumeId) {
      return db.prepare("SELECT * FROM requests WHERE cv_volume_id = ? AND status = 'pending'").get(cvVolumeId) || null;
    },
    /** The open request for a book/audiobook by its catalog id. */
    openForExternal(kind, externalId) {
      return db.prepare("SELECT * FROM requests WHERE kind = ? AND external_id = ? AND status = 'pending'").get(kind, String(externalId)) || null;
    },
    libraryState: comicState,
    /** Library state for a book or audiobook that is not (yet) a request. */
    bookState,
    /** Create a comic request; the requester's vote counts from the start. If
     *  an open request already exists this seconds it instead (no duplicates). */
    create(userId, userName, vol, note) {
      const open = this.openFor(vol.id);
      if (open) {
        this.vote(userId, open.id, true);
        return { request: this.get(open.id, userId), seconded: true };
      }
      const r = db.prepare(`
        INSERT INTO requests (kind, cv_volume_id, title, start_year, publisher, cover_url, issue_count, note, requested_by, requested_by_name)
        VALUES ('comic', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(vol.id, vol.name ?? null, vol.start_year != null ? String(vol.start_year) : null,
          vol.publisher ?? null, vol.image_url ?? null, vol.count_of_issues ?? null,
          String(note || '').slice(0, 500) || null, userId, userName || null);
      this.vote(userId, r.lastInsertRowid, true);
      return { request: this.get(r.lastInsertRowid, userId), seconded: false };
    },
    /** Create a book or audiobook request. `item` is the normalized shape the
     *  search route hands out: { id, title, author, publisher, year, cover }. */
    createItem(userId, userName, kind, item, note) {
      if (!KINDS.includes(kind) || kind === 'comic') throw new Error('a book or audiobook kind is required');
      const open = this.openForExternal(kind, item.id);
      if (open) {
        this.vote(userId, open.id, true);
        return { request: this.get(open.id, userId), seconded: true };
      }
      const r = db.prepare(`
        INSERT INTO requests (kind, cv_volume_id, external_id, title, author, start_year, publisher, cover_url, issue_count, note, requested_by, requested_by_name, isbn)
        VALUES (?, 0, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`)
        .run(kind, String(item.id), item.title ?? null, item.author ?? null,
          item.year != null ? String(item.year) : null, item.publisher ?? null, item.cover ?? null,
          String(note || '').slice(0, 500) || null, userId, userName || null, item.isbn ? String(item.isbn) : null);
      this.vote(userId, r.lastInsertRowid, true);
      return { request: this.get(r.lastInsertRowid, userId), seconded: false };
    },
    vote(userId, requestId, on) {
      if (on) db.prepare('INSERT OR IGNORE INTO request_votes (request_id, user_id) VALUES (?, ?)').run(requestId, userId);
      else db.prepare('DELETE FROM request_votes WHERE request_id = ? AND user_id = ?').run(requestId, userId);
    },
    approve(requestId, deciderName, { download = true } = {}) {
      db.prepare(`UPDATE requests SET status='approved', decided_by_name=?, decline_reason=NULL, may_download=?,
                  decided_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`).run(deciderName || null, download ? 1 : 0, requestId);
    },
    /** The issue a source (or a later scan) put in the library for a book request. */
    fulfil(requestId, issueId) {
      db.prepare('UPDATE requests SET fulfilled_issue_id=? WHERE id=?').run(issueId, requestId);
    },
    /** Approved book/audiobook requests nothing has fulfilled yet. */
    unfulfilled() {
      return db.prepare("SELECT * FROM requests WHERE status='approved' AND kind != 'comic' AND fulfilled_issue_id IS NULL")
        .all().map((r) => ({ ...r, ...libraryStateOf(r) }));
    },
    decline(requestId, deciderName, reason) {
      db.prepare(`UPDATE requests SET status='declined', decided_by_name=?, decline_reason=?,
                  decided_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`)
        .run(deciderName || null, String(reason || '').slice(0, 500) || null, requestId);
    },
    remove(requestId) {
      db.prepare('DELETE FROM request_votes WHERE request_id = ?').run(requestId);
      db.prepare('DELETE FROM requests WHERE id = ?').run(requestId);
    },
    pendingCount() {
      return db.prepare("SELECT COUNT(*) n FROM requests WHERE status = 'pending'").get().n;
    },
    close() { db.close(); },
  };
}
