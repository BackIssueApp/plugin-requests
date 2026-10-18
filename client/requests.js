// Requests client — injected via window.BackIssue. Adds a "Requests" entry
// to the sidebar's plugin area (with a pending-count badge for reviewers)
// opening a full-screen overlay: the request queue (vote / approve / decline
// / withdraw) and a search tab for filing new requests — the metadata source
// for comics, and books / audiobooks where the server offers them. Every
// affordance is gated on the session's actual permissions from /api/auth/me
// — the server enforces them regardless.
(function () {
  window.BackIssue.registerClient((api) => {
    const esc = api.escapeHtml;
    // Translations: api.t when the host has it (BackIssue > 0.9.0), the inline
    // English otherwise. Catalog: locales/<lang>.json, namespace "requests".
    // `en` may be a { one, other } pair; the fallback picks on params.count.
    const fill = (s, p) => {
      if (s && typeof s === 'object') s = p && Number(p.count) === 1 ? s.one : s.other;
      return p ? String(s).replace(/\{(\w+)\}/g, (m, k) => (p[k] === undefined || p[k] === null ? m : String(p[k]))) : String(s);
    };
    const tr = (key, en, params) => { if (typeof api.t !== 'function') return fill(en, params); const v = api.t('requests.' + key, params); return v === 'requests.' + key ? fill(en, params) : v; };
    const trh = (key, en, params) => (typeof api.th === 'function' && api.t('requests.' + key) !== 'requests.' + key ? api.th('requests.' + key, params) : fill(en, params));
    // Escaped-param variant of the fallback for markup messages built by hand.
    const escParams = (p) => Object.fromEntries(Object.entries(p || {}).map(([k, v]) => [k, esc(String(v ?? ''))]));

    let overlay = null, listEl = null, gridEl = null, tabsEl = null, badgeEl = null;
    let activeTab = 'queue';           // 'queue' | 'find'
    let statusFilter = 'all';          // all | pending | approved | declined | mine
    let canCreate = false, canManage = false, canDownload = false, me = { id: 0 };
    let lastRequests = [];
    // What may be asked for here; comics always, the rest per the server.
    let media = { comic: true, ebook: false, audiobook: false };
    let kind = 'comic';
    const KIND_LABEL = { comic: () => tr('kinds.comic', 'Comics'), ebook: () => tr('kinds.ebook', 'Books'), audiobook: () => tr('kinds.audiobook', 'Audiobooks') };
    const KIND_HINT = {
      comic: () => tr('hints.comic', 'Search volumes… (e.g. Transmetropolitan)'),
      ebook: () => tr('hints.ebook', 'Search books by title or author…'),
      audiobook: () => tr('hints.audiobook', 'Search audiobooks by title or author…'),
    };

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
          '<div class="src-toggle__text"><b>' + esc(tr('settings.autoApprove', 'Requests: auto-approve')) + '</b><span class="modal__note src-toggle__note">' + trh('settings.autoApproveNote', 'Every request is approved and added to the library instantly — no review queue — and downloads right away, whoever requested it. Off = roles with “Manage requests” approve or decline each one; an approval downloads only when the approver has <b>Search &amp; download</b>.') + '</span></div>' +
        '</div>' +
        '<div class="src-toggle">' +
          '<label class="switch"><input id="set-requestsWesternOnly" type="checkbox"><span class="switch__track"></span></label>' +
          '<div class="src-toggle__text"><b>' + esc(tr('settings.westernOnly', 'Requests: Western comics only')) + '</b><span class="modal__note src-toggle__note">' + esc(tr('settings.westernOnlyNote', 'Only volumes from Western (US/UK) publishers can be searched and requested — manga and foreign-language titles are hidden. Uses a publisher allowlist.')) + '</span></div>' +
        '</div>' +
        '<div class="src-toggle">' +
          '<label class="switch"><input id="set-requestsNoCollections" type="checkbox"><span class="switch__track"></span></label>' +
          '<div class="src-toggle__text"><b>' + esc(tr('settings.noCollections', 'Requests: no collections')) + '</b><span class="modal__note src-toggle__note">' + esc(tr('settings.noCollectionsNote', 'Hide and block collected editions — trade paperbacks, hardcovers, omnibuses, “Complete” collections and the like — so only single-issue series can be requested. Detected from the volume’s title and description (the catalog has no format field), so it catches the vast majority but isn’t perfect.')) + '</span></div>' +
        '</div>';
      setSlot.appendChild(block);
    }

    // ---- sidebar entry (Library menu's plugin area) ----
    let btn = null;

    async function refreshBadge() {
      if (!badgeEl || !canManage) return;
      try {
        const r = await api.get('/api/requests/count');
        const n = r.pending || 0;
        badgeEl.textContent = n;
        badgeEl.hidden = n === 0;
      } catch { /* header stays quiet */ }
    }

    (async () => {
      await loadPerms();
      if (!canCreate) return; // no permission → no surface at all
      // Host SVG icon set (matches core nav); glyph fallback for older hosts.
      btn = api.addMenuAction(tr('menu.label', 'Requests'), openRequests, (api.icon && api.icon('mail')) || '✉', { section: 'Discover' });
      btn.id = 'requests-btn';
      btn.title = tr('menu.title', 'Request volumes for the library');
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
        '<div class="rq__panel" role="dialog" aria-label="' + esc(tr('dialog.label', 'Volume requests')) + '">' +
          '<div class="rq__head">' +
            '<div class="rq__title">📥 ' + esc(tr('dialog.title', 'Requests')) + '</div>' +
            '<div class="rq__tabs">' +
              '<button class="rq__tab" data-tab="queue">' + esc(tr('dialog.tabQueue', 'Requests')) + '</button>' +
              '<button class="rq__tab" data-tab="find">' + esc(tr('dialog.tabFind', 'Find & request')) + '</button>' +
            '</div>' +
            '<button class="rq__close" title="' + esc(tr('dialog.close', 'Close (Esc)')) + '">✕</button>' +
          '</div>' +
          '<div class="rq__body">' +
            '<div class="rq__queue">' +
              '<div class="rq__filters"></div>' +
              '<div class="rq__list"></div>' +
            '</div>' +
            '<div class="rq__find" hidden>' +
              '<div class="rq__kinds" hidden></div>' +
              '<form class="rq__searchform"><input type="search" class="rq__search" placeholder="' + esc(KIND_HINT.comic()) + '"><button class="btn btn--primary rq__go">' + esc(tr('dialog.search', 'Search')) + '</button></form>' +
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
      const FILTER_LABEL = { all: 'All', pending: 'Pending', approved: 'Approved', declined: 'Declined', mine: 'My requests' };
      for (const f of ['all', 'pending', 'approved', 'declined', 'mine']) {
        const b = document.createElement('button');
        b.className = 'rq__filter'; b.dataset.f = f;
        b.textContent = tr('filters.' + f, FILTER_LABEL[f]);
        b.onclick = () => { statusFilter = f; paintQueue(); };
        filters.appendChild(b);
      }
      overlay.querySelector('.rq__searchform').onsubmit = (e) => { e.preventDefault(); doSearch(); };
      paintKinds();
    }

    // The kind row only appears when there is more than one kind to pick.
    function paintKinds() {
      const row = overlay?.querySelector('.rq__kinds');
      if (!row) return;
      const kinds = ['comic', 'ebook', 'audiobook'].filter((k) => media[k]);
      row.hidden = kinds.length < 2;
      row.innerHTML = '';
      for (const k of kinds) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'rq__kind' + (k === kind ? ' is-active' : '');
        b.textContent = KIND_LABEL[k]();
        b.onclick = () => { kind = k; paintKinds(); gridEl.innerHTML = ''; overlay.querySelector('.rq__search').placeholder = KIND_HINT[k](); overlay.querySelector('.rq__search').focus(); };
        row.appendChild(b);
      }
      if (!media[kind]) kind = 'comic';
      overlay.querySelector('.rq__search').placeholder = KIND_HINT[kind]();
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
      listEl.innerHTML = '<div class="rq__note">' + esc(tr('queue.loading', 'Loading…')) + '</div>';
      let r;
      try { r = await api.get('/api/requests'); }
      catch (e) { listEl.innerHTML = '<div class="rq__note rq__note--bad">' + esc(tr('queue.loadFailed', 'Couldn’t load: {error}', { error: String(e) })) + '</div>'; return; }
      lastRequests = r.requests || [];
      canManage = !!r.canManage;
      if (r.media) { media = { comic: true, ...r.media }; paintKinds(); }
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
        listEl.innerHTML = '<div class="rq__note">' + (statusFilter === 'all'
          ? trh('queue.emptyAll', 'Nothing here. File the first request from <b>Find &amp; request</b>.')
          : esc(tr('queue.empty', 'Nothing here.'))) + '</div>';
        return;
      }
      for (const r of rows) listEl.appendChild(requestRow(r));
    }

    const STATUS_EN = { pending: 'pending', approved: 'approved', declined: 'declined', available: 'available' };
    function requestRow(r) {
      const el = document.createElement('div');
      const k = r.kind || 'comic';
      el.className = 'rq-row rq-row--' + r.display;
      const meta = (k === 'comic'
        ? [r.publisher, r.start_year, r.issue_count ? tr('row.issues', { one: '{count} issue', other: '{count} issues' }, { count: r.issue_count }) : null]
        : [r.author, r.start_year, r.publisher]).filter(Boolean).map(esc).join(' · ');
      const progress = r.status === 'approved' && r.total > 0 && r.display !== 'available' && k === 'comic'
        ? '<span class="rq-row__progress">' + esc(tr('row.onDisk', '{owned}/{total} on disk', { owned: r.owned, total: r.total })) + '</span>' : '';
      const badge = k === 'comic' ? '' : '<span class="rq-kind rq-kind--' + k + '">' + esc(k === 'ebook' ? tr('row.kindBook', 'Book') : tr('row.kindAudiobook', 'Audiobook')) + '</span>';
      const title = r.title || (k === 'comic' ? tr('row.untitledVolume', 'Volume {id}', { id: r.cv_volume_id }) : tr('row.untitled', 'Untitled'));
      el.innerHTML =
        '<div class="rq-row__coverwrap">' + (r.cover_url ? '<img loading="lazy" src="' + esc(r.cover_url) + '" alt="">' : '') + '</div>' +
        '<div class="rq-row__main">' +
          '<div class="rq-row__title">' + badge + esc(title) + '</div>' +
          '<div class="rq-row__meta">' + meta + '</div>' +
          '<div class="rq-row__who">' + trh('row.by', 'by <b>{name}</b> · {date}', typeof api.th === 'function' ? { name: r.requested_by_name || '?', date: (r.created_at || '').slice(0, 10) } : escParams({ name: r.requested_by_name || '?', date: (r.created_at || '').slice(0, 10) })) +
            (r.note ? ' — <i>' + esc(r.note) + '</i>' : '') + '</div>' +
          (r.status === 'declined' && r.decline_reason ? '<div class="rq-row__reason">' + esc(tr('row.declinedReason', 'Declined: {reason}', { reason: r.decline_reason })) + '</div>' : '') +
          downloadLine(r) +
        '</div>' +
        '<span class="rq-row__status rq-row__status--' + r.display + '">' + esc(STATUS_EN[r.display] ? tr('status.' + r.display, STATUS_EN[r.display]) : r.display) + progress + '</span>' +
        '<button class="rq-row__vote' + (r.voted ? ' is-on' : '') + '" title="' + esc(r.voted ? tr('row.removeVote', 'Remove your vote') : tr('row.second', 'Second this request')) + '">▲ ' + r.votes + '</button>' +
        '<span class="rq-row__actions"></span>';
      el.querySelector('.rq-row__vote').onclick = async () => {
        const res = await api.post('/api/requests/' + r.id + '/vote', { on: !r.voted }).catch(() => null);
        if (res?.request) { Object.assign(r, res.request); paintQueue(); }
      };
      const actions = el.querySelector('.rq-row__actions');
      if (r.status === 'pending' && canManage) {
        if (k === 'comic') {
          actions.append(
            actionBtn(tr('row.approve', '✓ Approve'), tr('row.approveTitle', 'Approve — adds the volume to the library'), () => decide(r, false)),
            actionBtn('✓⤓', tr('row.approveDownloadTitle', 'Approve + download every issue'), () => decide(r, true), !canDownload),
          );
        } else {
          actions.append(actionBtn(tr('row.approve', '✓ Approve'), canDownload
            ? tr('row.approveBookTitle', 'Approve — searches your download sources for it')
            : tr('row.approveBookNoDownloadTitle', 'Approve — you can’t download, so it is marked available once a scan or import brings it in'), () => decide(r, false)));
        }
        actions.append(actionBtn('✗', tr('row.declineTitle', 'Decline with a reason'), () => declineFlow(el, r)));
      }
      if ((r.status === 'pending' && r.requested_by === me.id) || canManage) {
        actions.append(actionBtn('🗑', canManage ? tr('row.deleteTitle', 'Delete this request') : tr('row.withdrawTitle', 'Withdraw your request'), async () => {
          const res = await fetch('/api/requests/' + r.id, { method: 'DELETE' }).then((x) => x.json()).catch(() => null);
          if (res && !res.error) loadQueue();
          else if (res?.error) alertNote(res.error);
        }));
      }
      return el;
    }

    // What the download sources are doing about a book request (approved
    // rows only; nothing to say once it is on the shelf).
    function downloadLine(r) {
      const d = r.download;
      if (!d || r.status !== 'approved' || r.display === 'available') return '';
      if (d.status === 'active') {
        return '<div class="rq-row__dl">' + esc(d.release
          ? tr('row.downloadingRelease', 'Downloading from {source} · {release}', { source: d.source, release: d.release })
          : tr('row.downloading', 'Downloading from {source}', { source: d.source })) + '</div>';
      }
      if (d.status === 'failed') {
        const error = d.error || tr('row.unknownError', 'unknown error');
        return '<div class="rq-row__reason">' + esc(d.source
          ? tr('row.downloadFailedSource', 'Download failed ({source}): {error} — tried again on the schedule', { source: d.source, error })
          : tr('row.downloadFailed', 'Download failed: {error} — tried again on the schedule', { error })) + '</div>';
      }
      return '';
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
      await loadQueue();
      // A book: say what the download sources did with it.
      if (res.download?.status === 'not-allowed') {
        listEl.insertAdjacentHTML('afterbegin', '<div class="rq__note">' + esc(tr('row.approvedNoDownload', 'Approved. You can’t download, so nothing was fetched — it is marked available when a scan or import brings it in.')) + '</div>');
      } else if (res.note) {
        const bad = ['no-match', 'no-sources', 'no-library', 'unsupported', 'error'].includes(res.download?.status);
        listEl.insertAdjacentHTML('afterbegin', '<div class="rq__note' + (bad ? ' rq__note--warn' : '') + '">' + esc(tr('row.approvedNote', 'Approved. {note}', { note: res.note })) + '</div>');
      }
    }

    function declineFlow(el, r) {
      if (el.querySelector('.rq-declineform')) return;
      const form = document.createElement('form');
      form.className = 'rq-declineform';
      form.innerHTML = '<input type="text" maxlength="500" placeholder="' + esc(tr('decline.placeholder', 'Reason (shown to the requester)')) + '"><button class="btn btn--sm btn--primary">' + esc(tr('decline.button', 'Decline')) + '</button>';
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
      const k = kind;
      gridEl.innerHTML = '<div class="rq__note">' + esc(tr('find.searching', 'Searching…')) + '</div>';
      let r;
      try { r = await api.get('/api/requests/search?q=' + encodeURIComponent(q) + (k === 'comic' ? '' : '&kind=' + k)); }
      catch (e) { gridEl.innerHTML = '<div class="rq__note rq__note--bad">' + esc(String(e)) + '</div>'; return; }
      if (r.error) { gridEl.innerHTML = '<div class="rq__note rq__note--bad">' + esc(r.error) + '</div>'; return; }
      gridEl.innerHTML = '';
      if (!(r.results || []).length) { gridEl.innerHTML = '<div class="rq__note">' + esc(tr('find.nothingFound', 'Nothing found for “{query}”.', { query: q })) + '</div>'; return; }
      for (const v of r.results) gridEl.appendChild(k === 'comic' ? resultCard(v) : itemCard(v));
    }

    const stateHtml = (key, en) => '<span class="rq-card__state">' + esc(tr(key, en)) + '</span>';

    // A book or audiobook result: author and year where a volume shows its
    // publisher and issue count; square art for audio.
    function itemCard(v) {
      const el = document.createElement('div');
      el.className = 'rq-card';
      const meta = [v.author, v.year, v.extra].filter(Boolean).map(esc).join(' · ');
      el.innerHTML =
        '<div class="rq-card__coverwrap' + (v.kind === 'audiobook' ? ' rq-card__coverwrap--square' : '') + '">' + (v.cover ? '<img loading="lazy" src="' + esc(v.cover) + '" alt="">' : '<span class="rq-card__none">?</span>') + '</div>' +
        '<div class="rq-card__body">' +
          '<div class="rq-card__title" title="' + esc(v.title || '') + '">' + esc(v.title || '?') + '</div>' +
          '<div class="rq-card__meta">' + (meta || '&nbsp;') + '</div>' +
          '<div class="rq-card__action"></div>' +
        '</div>';
      const action = el.querySelector('.rq-card__action');
      if (v.inLibrary) action.innerHTML = stateHtml('find.inLibrary', '✓ In library');
      else if (v.requestId) action.innerHTML = stateHtml('find.alreadyRequested', '📥 Already requested');
      else {
        const b = document.createElement('button');
        b.className = 'btn btn--primary btn--sm';
        b.textContent = tr('find.request', 'Request');
        b.onclick = () => requestFlow(el, { kind: v.kind, externalId: v.id, title: v.title, author: v.author, year: v.year, cover: v.cover }, b);
        action.appendChild(b);
      }
      return el;
    }

    function resultCard(v) {
      const el = document.createElement('div');
      el.className = 'rq-card';
      const meta = [v.publisher, v.start_year, v.count_of_issues ? tr('row.issues', { one: '{count} issue', other: '{count} issues' }, { count: v.count_of_issues }) : null].filter(Boolean).map(esc).join(' · ');
      el.innerHTML =
        '<div class="rq-card__coverwrap">' + (v.image_url ? '<img loading="lazy" src="' + esc(v.image_url) + '" alt="">' : '<span class="rq-card__none">?</span>') + '</div>' +
        '<div class="rq-card__body">' +
          '<div class="rq-card__title" title="' + esc(v.name || '') + '">' + esc(v.name || '?') + '</div>' +
          '<div class="rq-card__meta">' + (meta || '&nbsp;') + '</div>' +
          '<div class="rq-card__action"></div>' +
        '</div>';
      const action = el.querySelector('.rq-card__action');
      if (v.inLibrary) action.innerHTML = stateHtml('find.inLibrary', '✓ In library');
      else if (v.requestId) action.innerHTML = stateHtml('find.alreadyRequested', '📥 Already requested');
      else {
        const b = document.createElement('button');
        b.className = 'btn btn--primary btn--sm';
        b.textContent = tr('find.request', 'Request');
        b.onclick = () => requestFlow(el, { comicvineId: v.id }, b);
        action.appendChild(b);
      }
      return el;
    }

    // `body` is what POST /api/requests needs for this kind of thing (a
    // comicvineId, or a kind + externalId with what the card showed).
    function requestFlow(el, body, btn) {
      if (el.querySelector('.rq-noteform')) return;
      const form = document.createElement('form');
      form.className = 'rq-noteform';
      form.innerHTML = '<input type="text" maxlength="500" placeholder="' + esc(body.comicvineId ? tr('find.notePrinting', 'Why / which printing? (optional)') : tr('find.noteEdition', 'Why / which edition? (optional)')) + '"><button class="btn btn--sm btn--primary">' + esc(tr('find.send', 'Send request')) + '</button>';
      form.onsubmit = async (e) => {
        e.preventDefault();
        btn.disabled = true;
        const res = await api.post('/api/requests', { ...body, note: form.querySelector('input').value }).catch((x) => ({ error: String(x) }));
        form.remove();
        const action = el.querySelector('.rq-card__action');
        if (res.error) { action.innerHTML = '<span class="rq-card__state rq-card__state--bad">' + esc(res.error) + '</span>'; return; }
        const text = res.autoApproved
          ? (res.note ? tr('find.approvedWithNote', '✓ Approved — {note}', { note: res.note }) : tr('find.approvedAdded', '✓ Approved & added'))
          : res.seconded ? tr('find.seconded', '📥 Seconded the existing request') : tr('find.requested', '📥 Requested');
        action.innerHTML = '<span class="rq-card__state">' + esc(text) + '</span>';
        refreshBadge();
      };
      el.querySelector('.rq-card__body').appendChild(form);
      form.querySelector('input').focus();
    }
  });
})();
