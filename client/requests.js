// Requests client — injected via window.BackIssue. Adds a "Requests" entry
// to the sidebar's plugin area (with a pending-count badge for reviewers)
// opening a full-screen overlay: the request queue (vote / approve / decline
// / withdraw) and a ComicVine search tab for filing new requests. Every
// affordance is gated on the session's actual permissions from /api/auth/me
// — the server enforces them regardless.
(function () {
  window.BackIssue.registerClient((api) => {
    const esc = api.escapeHtml;
    let overlay = null, listEl = null, gridEl = null, tabsEl = null, badgeEl = null;
    let activeTab = 'queue';           // 'queue' | 'find'
    let statusFilter = 'all';          // all | pending | approved | declined | mine
    let canCreate = false, canManage = false, canDownload = false, me = { id: 0 };
    let lastRequests = [];

    // ---- permissions ----
    // The bridge exposes the already-resolved session (api.me) — zero extra
    // roundtrips on modern cores; older cores fall back to fetching.
    async function loadPerms() {
      try {
        let r = api.me?.();
        if (!r || (!r.user && !r.openMode)) r = await api.get('/api/auth/me');
        me = r.user || { id: 0 };
        const perms = r.openMode ? ['*'] : (r.user?.permissions || []);
        const has = (p) => perms.includes('*') || perms.includes(p);
        canCreate = r.openMode || has('requests.create');
        canManage = r.openMode || has('requests.manage');
        canDownload = r.openMode || has('downloads.grab');
      } catch { canCreate = canManage = canDownload = false; }
    }

    // Settings block (Settings → Sources area — the plugin settings slot).
    // Not a download source — mount in the dedicated Plugins settings tab when
    // the core has one, falling back to the Sources slot on older cores.
    const setSlot = api.slot('settings-plugin-panels') || api.slot('settings-plugin-sources');
    if (setSlot) {
      const block = document.createElement('div');
      block.className = 'src-block';
      block.innerHTML =
        '<div class="src-toggle">' +
          '<label class="switch"><input id="set-requestsAutoApprove" type="checkbox"><span class="switch__track"></span></label>' +
          '<div class="src-toggle__text"><b>Requests: auto-approve</b><span class="modal__note src-toggle__note">Every volume request is approved and added to the library instantly — no review queue. Off = roles with “Manage requests” approve or decline each one. When <b>Download on add</b> (Downloading settings) is also on, auto-approved requests download their missing issues automatically, regardless of who requested them.</span></div>' +
        '</div>' +
        '<div class="src-toggle">' +
          '<label class="switch"><input id="set-requestsWesternOnly" type="checkbox"><span class="switch__track"></span></label>' +
          '<div class="src-toggle__text"><b>Requests: Western comics only</b><span class="modal__note src-toggle__note">Only volumes from Western (US/UK) publishers can be searched and requested — manga and foreign-language titles are hidden. Uses a publisher allowlist.</span></div>' +
        '</div>' +
        '<div class="src-toggle">' +
          '<label class="switch"><input id="set-requestsNoCollections" type="checkbox"><span class="switch__track"></span></label>' +
          '<div class="src-toggle__text"><b>Requests: no collections</b><span class="modal__note src-toggle__note">Hide and block collected editions — trade paperbacks, hardcovers, omnibuses, “Complete” collections and the like — so only single-issue series can be requested. Detected from the volume’s title and description (ComicVine has no format field), so it catches the vast majority but isn’t perfect.</span></div>' +
        '</div>';
      setSlot.appendChild(block);
    }

    // ---- sidebar entry (Library menu's plugin area) ----
    let btn = null;

    async function refreshBadge() {
      if (!badgeEl || !canManage) return;
      try {
        const r = await api.get('/api/requests');
        const n = r.pending || 0;
        badgeEl.textContent = n;
        badgeEl.hidden = n === 0;
      } catch { /* header stays quiet */ }
    }

    (async () => {
      await loadPerms();
      if (!canCreate) return; // no permission → no surface at all
      // Host SVG icon set (matches core nav); glyph fallback for older hosts.
      btn = api.addMenuAction('Requests', openRequests, (api.icon && api.icon('mail')) || '✉', { section: 'Discover' });
      btn.id = 'requests-btn';
      btn.title = 'Request volumes for the library';
      badgeEl = document.createElement('span');
      badgeEl.className = 'rq-badge';
      badgeEl.hidden = true;
      btn.appendChild(badgeEl);
      refreshBadge();
    })();

    // ---- overlay ----
    function openRequests() {
      if (!overlay) build();
      overlay.classList.add('is-open');
      document.body.classList.add('requests-open');
      selectTab(activeTab);
    }
    function closeRequests() {
      overlay?.classList.remove('is-open');
      document.body.classList.remove('requests-open');
      refreshBadge();
    }

    function build() {
      overlay = document.createElement('div');
      overlay.className = 'rq';
      overlay.innerHTML =
        '<div class="rq__backdrop"></div>' +
        '<div class="rq__panel" role="dialog" aria-label="Volume requests">' +
          '<div class="rq__head">' +
            '<div class="rq__title">📥 Requests</div>' +
            '<div class="rq__tabs">' +
              '<button class="rq__tab" data-tab="queue">Requests</button>' +
              '<button class="rq__tab" data-tab="find">Find &amp; request</button>' +
            '</div>' +
            '<button class="rq__close" title="Close (Esc)">✕</button>' +
          '</div>' +
          '<div class="rq__body">' +
            '<div class="rq__queue">' +
              '<div class="rq__filters"></div>' +
              '<div class="rq__list"></div>' +
            '</div>' +
            '<div class="rq__find" hidden>' +
              '<form class="rq__searchform"><input type="search" class="rq__search" placeholder="Search ComicVine volumes… (e.g. Transmetropolitan)"><button class="btn btn--primary rq__go">Search</button></form>' +
              '<div class="rq__grid"></div>' +
            '</div>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
      listEl = overlay.querySelector('.rq__list');
      gridEl = overlay.querySelector('.rq__grid');
      tabsEl = overlay.querySelector('.rq__tabs');
      overlay.querySelector('.rq__close').onclick = closeRequests;
      overlay.querySelector('.rq__backdrop').onclick = closeRequests;
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay.classList.contains('is-open')) closeRequests();
      });
      for (const b of tabsEl.querySelectorAll('.rq__tab')) b.onclick = () => selectTab(b.dataset.tab);
      const filters = overlay.querySelector('.rq__filters');
      for (const f of ['all', 'pending', 'approved', 'declined', 'mine']) {
        const b = document.createElement('button');
        b.className = 'rq__filter'; b.dataset.f = f;
        b.textContent = f === 'mine' ? 'My requests' : f[0].toUpperCase() + f.slice(1);
        b.onclick = () => { statusFilter = f; paintQueue(); };
        filters.appendChild(b);
      }
      overlay.querySelector('.rq__searchform').onsubmit = (e) => { e.preventDefault(); doSearch(); };
    }

    function selectTab(key) {
      activeTab = key;
      for (const b of tabsEl.querySelectorAll('.rq__tab')) b.classList.toggle('is-active', b.dataset.tab === key);
      overlay.querySelector('.rq__queue').hidden = key !== 'queue';
      overlay.querySelector('.rq__find').hidden = key !== 'find';
      if (key === 'queue') loadQueue();
      else overlay.querySelector('.rq__search').focus();
    }

    // ---- the queue ----
    async function loadQueue() {
      listEl.innerHTML = '<div class="rq__note">Loading…</div>';
      let r;
      try { r = await api.get('/api/requests'); }
      catch (e) { listEl.innerHTML = '<div class="rq__note rq__note--bad">Couldn’t load: ' + esc(String(e)) + '</div>'; return; }
      lastRequests = r.requests || [];
      canManage = !!r.canManage;
      paintQueue();
      refreshBadge();
    }

    function paintQueue() {
      for (const b of overlay.querySelectorAll('.rq__filter')) b.classList.toggle('is-active', b.dataset.f === statusFilter);
      const rows = lastRequests.filter((r) =>
        statusFilter === 'all' ? true
        : statusFilter === 'mine' ? r.requested_by === me.id
        : r.status === statusFilter);
      listEl.innerHTML = '';
      if (!rows.length) {
        listEl.innerHTML = '<div class="rq__note">Nothing here. ' + (statusFilter === 'all' ? 'File the first request from <b>Find &amp; request</b>.' : '') + '</div>';
        return;
      }
      for (const r of rows) listEl.appendChild(requestRow(r));
    }

    const STATUS_LABEL = { pending: 'pending', approved: 'approved', declined: 'declined', available: 'available' };
    function requestRow(r) {
      const el = document.createElement('div');
      el.className = 'rq-row rq-row--' + r.display;
      const meta = [r.publisher, r.start_year, r.issue_count ? r.issue_count + ' issues' : null].filter(Boolean).map(esc).join(' · ');
      const progress = r.status === 'approved' && r.total > 0 && r.display !== 'available'
        ? '<span class="rq-row__progress">' + r.owned + '/' + r.total + ' on disk</span>' : '';
      el.innerHTML =
        '<div class="rq-row__coverwrap">' + (r.cover_url ? '<img loading="lazy" src="' + esc(r.cover_url) + '" alt="">' : '') + '</div>' +
        '<div class="rq-row__main">' +
          '<div class="rq-row__title">' + esc(r.title || 'Volume ' + r.cv_volume_id) + '</div>' +
          '<div class="rq-row__meta">' + meta + '</div>' +
          '<div class="rq-row__who">by <b>' + esc(r.requested_by_name || '?') + '</b> · ' + esc((r.created_at || '').slice(0, 10)) +
            (r.note ? ' — <i>' + esc(r.note) + '</i>' : '') + '</div>' +
          (r.status === 'declined' && r.decline_reason ? '<div class="rq-row__reason">Declined: ' + esc(r.decline_reason) + '</div>' : '') +
        '</div>' +
        '<span class="rq-row__status rq-row__status--' + r.display + '">' + (STATUS_LABEL[r.display] || r.display) + progress + '</span>' +
        '<button class="rq-row__vote' + (r.voted ? ' is-on' : '') + '" title="' + (r.voted ? 'Remove your vote' : 'Second this request') + '">▲ ' + r.votes + '</button>' +
        '<span class="rq-row__actions"></span>';
      el.querySelector('.rq-row__vote').onclick = async () => {
        const res = await api.post('/api/requests/' + r.id + '/vote', { on: !r.voted }).catch(() => null);
        if (res?.request) { Object.assign(r, res.request); paintQueue(); }
      };
      const actions = el.querySelector('.rq-row__actions');
      if (r.status === 'pending' && canManage) {
        actions.append(
          actionBtn('✓ Approve', 'Approve — adds the volume to the library', () => decide(r, false)),
          actionBtn('✓⤓', 'Approve + download every issue', () => decide(r, true), !canDownload),
          actionBtn('✗', 'Decline with a reason', () => declineFlow(el, r)),
        );
      }
      if ((r.status === 'pending' && r.requested_by === me.id) || canManage) {
        actions.append(actionBtn('🗑', canManage ? 'Delete this request' : 'Withdraw your request', async () => {
          const res = await fetch('/api/requests/' + r.id, { method: 'DELETE' }).then((x) => x.json()).catch(() => null);
          if (res && !res.error) loadQueue();
          else if (res?.error) alertNote(res.error);
        }));
      }
      return el;
    }

    function actionBtn(label, title, fn, hidden) {
      const b = document.createElement('button');
      b.className = 'btn btn--ghost btn--sm rq-act';
      b.textContent = label; b.title = title;
      if (hidden) b.style.display = 'none';
      b.onclick = fn;
      return b;
    }

    async function decide(r, download) {
      // Downloads queue server-side under this user's own downloads permission.
      const res = await api.post('/api/requests/' + r.id + '/approve', { download }).catch((e) => ({ error: String(e) }));
      if (res.error) return alertNote(res.error);
      loadQueue();
    }

    function declineFlow(el, r) {
      if (el.querySelector('.rq-declineform')) return;
      const form = document.createElement('form');
      form.className = 'rq-declineform';
      form.innerHTML = '<input type="text" maxlength="500" placeholder="Reason (shown to the requester)"><button class="btn btn--sm btn--primary">Decline</button>';
      form.onsubmit = async (e) => {
        e.preventDefault();
        const res = await api.post('/api/requests/' + r.id + '/decline', { reason: form.querySelector('input').value }).catch(() => null);
        if (res && !res.error) loadQueue();
      };
      el.appendChild(form);
      form.querySelector('input').focus();
    }

    function alertNote(msg) {
      listEl.insertAdjacentHTML('afterbegin', '<div class="rq__note rq__note--bad">' + esc(msg) + '</div>');
    }

    // ---- find & request ----
    async function doSearch() {
      const q = overlay.querySelector('.rq__search').value.trim();
      if (!q) return;
      gridEl.innerHTML = '<div class="rq__note">Searching ComicVine…</div>';
      let r;
      try { r = await api.get('/api/requests/search?q=' + encodeURIComponent(q)); }
      catch (e) { gridEl.innerHTML = '<div class="rq__note rq__note--bad">' + esc(String(e)) + '</div>'; return; }
      if (r.error) { gridEl.innerHTML = '<div class="rq__note rq__note--bad">' + esc(r.error) + '</div>'; return; }
      gridEl.innerHTML = '';
      if (!(r.results || []).length) { gridEl.innerHTML = '<div class="rq__note">No volumes found for “' + esc(q) + '”.</div>'; return; }
      for (const v of r.results) gridEl.appendChild(resultCard(v));
    }

    function resultCard(v) {
      const el = document.createElement('div');
      el.className = 'rq-card';
      const meta = [v.publisher, v.start_year, v.count_of_issues ? v.count_of_issues + ' issues' : null].filter(Boolean).map(esc).join(' · ');
      el.innerHTML =
        '<div class="rq-card__coverwrap">' + (v.image_url ? '<img loading="lazy" src="' + esc(v.image_url) + '" alt="">' : '<span class="rq-card__none">?</span>') + '</div>' +
        '<div class="rq-card__body">' +
          '<div class="rq-card__title" title="' + esc(v.name || '') + '">' + esc(v.name || '?') + '</div>' +
          '<div class="rq-card__meta">' + (meta || '&nbsp;') + '</div>' +
          '<div class="rq-card__action"></div>' +
        '</div>';
      const action = el.querySelector('.rq-card__action');
      if (v.inLibrary) action.innerHTML = '<span class="rq-card__state">✓ In library</span>';
      else if (v.requestId) action.innerHTML = '<span class="rq-card__state">📥 Already requested</span>';
      else {
        const b = document.createElement('button');
        b.className = 'btn btn--primary btn--sm';
        b.textContent = 'Request';
        b.onclick = () => requestFlow(el, v, b);
        action.appendChild(b);
      }
      return el;
    }

    function requestFlow(el, v, btn) {
      if (el.querySelector('.rq-noteform')) return;
      const form = document.createElement('form');
      form.className = 'rq-noteform';
      form.innerHTML = '<input type="text" maxlength="500" placeholder="Why / which printing? (optional)"><button class="btn btn--sm btn--primary">Send request</button>';
      form.onsubmit = async (e) => {
        e.preventDefault();
        btn.disabled = true;
        const res = await api.post('/api/requests', { comicvineId: v.id, note: form.querySelector('input').value }).catch((x) => ({ error: String(x) }));
        form.remove();
        const action = el.querySelector('.rq-card__action');
        if (res.error) { action.innerHTML = '<span class="rq-card__state rq-card__state--bad">' + esc(res.error) + '</span>'; return; }
        action.innerHTML = '<span class="rq-card__state">' +
          (res.autoApproved ? '✓ Approved &amp; added' : res.seconded ? '📥 Seconded the existing request' : '📥 Requested') + '</span>';
        refreshBadge();
      };
      el.querySelector('.rq-card__body').appendChild(form);
      form.querySelector('input').focus();
    }
  });
})();
