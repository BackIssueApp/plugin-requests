// Request state: plugin-owned tables inside catalog.db (DB backups cover
// them). Volume metadata is denormalized onto the request row — a request's
// history must survive the volume later being removed from the catalog cache
// or the requester's account being deleted.
import Database from 'better-sqlite3';

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
      ON requests(cv_volume_id) WHERE status = 'pending';
    CREATE TABLE IF NOT EXISTS request_votes (
      request_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      PRIMARY KEY (request_id, user_id)
    );
  `);

  // Library state for a CV volume: the local series (if tracked) and how much
  // of it is on disk. Tolerates cores whose catalog tables are absent.
  function libraryState(cvVolumeId) {
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

  const withState = (userId) => (r) => {
    const lib = libraryState(r.cv_volume_id);
    const votes = db.prepare('SELECT COUNT(*) n FROM request_votes WHERE request_id = ?').get(r.id).n;
    const voted = !!db.prepare('SELECT 1 FROM request_votes WHERE request_id = ? AND user_id = ?').get(r.id, userId);
    // Derived display status: an approved request whose volume is fully on
    // disk is "available"; partially-filled shows progress client-side.
    const display = r.status === 'approved' && lib.total > 0 && lib.owned >= lib.total ? 'available' : r.status;
    return { ...r, ...lib, votes, voted, display };
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
    /** The open request for a volume, if any (dedupe target). */
    openFor(cvVolumeId) {
      return db.prepare("SELECT * FROM requests WHERE cv_volume_id = ? AND status = 'pending'").get(cvVolumeId) || null;
    },
    libraryState,
    /** Create a request; the requester's vote counts from the start. If an
     *  open request already exists this seconds it instead (no duplicates). */
    create(userId, userName, vol, note) {
      const open = this.openFor(vol.id);
      if (open) {
        this.vote(userId, open.id, true);
        return { request: this.get(open.id, userId), seconded: true };
      }
      const r = db.prepare(`
        INSERT INTO requests (cv_volume_id, title, start_year, publisher, cover_url, issue_count, note, requested_by, requested_by_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(vol.id, vol.name ?? null, vol.start_year != null ? String(vol.start_year) : null,
          vol.publisher ?? null, vol.image_url ?? null, vol.count_of_issues ?? null,
          String(note || '').slice(0, 500) || null, userId, userName || null);
      this.vote(userId, r.lastInsertRowid, true);
      return { request: this.get(r.lastInsertRowid, userId), seconded: false };
    },
    vote(userId, requestId, on) {
      if (on) db.prepare('INSERT OR IGNORE INTO request_votes (request_id, user_id) VALUES (?, ?)').run(requestId, userId);
      else db.prepare('DELETE FROM request_votes WHERE request_id = ? AND user_id = ?').run(requestId, userId);
    },
    approve(requestId, deciderName) {
      db.prepare(`UPDATE requests SET status='approved', decided_by_name=?, decline_reason=NULL,
                  decided_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`).run(deciderName || null, requestId);
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
