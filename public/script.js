/* ==========================================================================
   MangaDex Downloader — Frontend logic
   Downloads flow through the browser's native download manager
   (so they show up in Ctrl/Cmd+J with size + pause/cancel).
   A bottom-left tray mirrors progress locally.
   ========================================================================== */

(() => {
  'use strict';

  /* ---------- Element refs ---------- */
  const $ = (id) => document.getElementById(id);

  const els = {
    searchForm:    $('searchForm'),
    urlInput:      $('urlInput'),
    fetchBtn:      $('fetchBtn'),
    pasteBtn:      $('pasteBtn'),
    status:        $('status'),
    mangaInfo:     $('mangaInfo'),
    mangaTitle:    $('mangaTitle'),
    chapterCount:  $('chapterCount'),
    chaptersList:  $('chaptersList'),
    chaptersBody:  $('chaptersBody'),
    emptyChapters: $('emptyChapters'),
    chapterFilter: $('chapterFilter'),
    checkAll:      $('checkAll'),
    selectAllBtn:  $('selectAllBtn'),
    downloadSelectedBtn: $('downloadSelectedBtn'),
    selectedCount: $('selectedCount'),

    tray:          $('downloadTray'),
    trayToggle:    $('trayToggle'),
    trayPanel:     $('trayPanel'),
    trayList:      $('trayList'),
    trayCount:     $('trayCount'),
    trayClearBtn:  $('trayClearBtn'),

    toasts:        $('toasts'),
  };

  /* ---------- State ---------- */
  const state = {
    chapters: [],
    filtered:  [],
    selected:  new Set(),
    downloads: new Map(), // downloadId -> { chapterId, label, row, li, bar, sizeEl, subEl, evtSource }
  };

  /* ---------- Toasts ---------- */
  const toastIcons = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    error:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    info:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  };

  function toast(message, type = 'info', duration = 3500) {
    const el = document.createElement('div');
    el.className = `toast toast--${type}`;
    el.innerHTML = `
      <span class="toast__icon">${toastIcons[type] || toastIcons.info}</span>
      <span class="toast__msg">${escapeHtml(message)}</span>
    `;
    els.toasts.appendChild(el);
    setTimeout(() => {
      el.classList.add('is-leaving');
      el.addEventListener('animationend', () => el.remove(), { once: true });
    }, duration);
  }

  /* ---------- Helpers ---------- */
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const val = bytes / Math.pow(1024, i);
    return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function setStatus(text, kind = '') {
    els.status.textContent = text || '';
    els.status.classList.remove('is-error', 'is-success');
    if (kind === 'error')   els.status.classList.add('is-error');
    if (kind === 'success') els.status.classList.add('is-success');
  }

  /* ---------- Fetch chapters ---------- */
  async function fetchChapters(url) {
    const response = await fetch('/api/fetch-chapters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!response.ok) {
      let msg = `Request failed (${response.status})`;
      try {
        const err = await response.json();
        if (err && err.error) msg = err.error;
      } catch (_) { /* noop */ }
      throw new Error(msg);
    }
    return response.json();
  }

  els.searchForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = els.urlInput.value.trim();
    if (!url) {
      toast('Please paste a MangaDex URL first', 'error');
      els.urlInput.focus();
      return;
    }

    els.fetchBtn.disabled = true;
    els.fetchBtn.querySelector('.btn__label').textContent = 'Fetching…';
    setStatus('Fetching chapters… This can take a moment for long series.');
    els.mangaInfo.hidden = true;
    els.chaptersList.hidden = true;
    state.chapters = [];
    state.filtered = [];
    state.selected.clear();

    try {
      const data = await fetchChapters(url);
      state.chapters = data.chapters || [];
      state.filtered = [...state.chapters];
      renderManga(data.title);
      renderChapters();
      setStatus(
        state.chapters.length
          ? `Found ${state.chapters.length} English chapter${state.chapters.length === 1 ? '' : 's'}.`
          : 'No English chapters were found for this series.',
        'success'
      );
    } catch (err) {
      setStatus(`Error: ${err.message}`, 'error');
      toast(err.message, 'error', 5000);
    } finally {
      els.fetchBtn.disabled = false;
      els.fetchBtn.querySelector('.btn__label').textContent = 'Fetch Chapters';
    }
  });

  /* ---------- Paste from clipboard ---------- */
  els.pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        els.urlInput.value = text.trim();
        els.urlInput.focus();
        toast('Pasted from clipboard', 'info', 1800);
      }
    } catch (_) {
      toast('Clipboard permission denied', 'error');
    }
  });

  /* ---------- Render: manga header ---------- */
  function renderManga(title) {
    els.mangaTitle.textContent = title || 'Untitled';
    els.chapterCount.textContent = state.chapters.length;
    els.mangaInfo.hidden = false;
    els.chaptersList.hidden = false;
    updateSelectedCount();
  }

  /* ---------- Render: chapters ---------- */
  function renderChapters() {
    els.chaptersBody.innerHTML = '';

    if (state.filtered.length === 0) {
      els.emptyChapters.hidden = false;
      els.checkAll.checked = false;
      els.checkAll.indeterminate = false;
      return;
    }
    els.emptyChapters.hidden = true;

    const frag = document.createDocumentFragment();
    state.filtered.forEach((ch) => {
      const tr = document.createElement('tr');
      tr.dataset.id = ch.id;
      if (state.selected.has(ch.id)) tr.classList.add('is-selected');
      const titleHtml = ch.title
        ? `<span class="ch-title">${escapeHtml(ch.title)}</span>`
        : `<span class="ch-title ch-title--muted">No title</span>`;
      tr.innerHTML = `
        <td class="col-check"><input type="checkbox" class="row-check" ${state.selected.has(ch.id) ? 'checked' : ''} aria-label="Select chapter ${escapeHtml(ch.chapter || '')}" /></td>
        <td class="col-ch"><span class="ch-num">${escapeHtml(ch.chapter || '—')}</span></td>
        <td class="col-title">${titleHtml}</td>
        <td class="col-pages"><span class="ch-pages">${ch.pages}</span></td>
        <td class="col-action">
          <button class="dl-btn" data-id="${ch.id}" data-label="Ch. ${escapeHtml(ch.chapter || '—')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>
            Download
          </button>
        </td>
      `;
      frag.appendChild(tr);
    });
    els.chaptersBody.appendChild(frag);
    syncCheckAll();
  }

  /* ---------- Filter ---------- */
  els.chapterFilter.addEventListener('input', () => {
    const q = els.chapterFilter.value.trim().toLowerCase();
    if (!q) {
      state.filtered = [...state.chapters];
    } else {
      state.filtered = state.chapters.filter((ch) => {
        const haystack = `${ch.chapter || ''} ${ch.title || ''} ${ch.volume || ''}`.toLowerCase();
        return haystack.includes(q);
      });
    }
    renderChapters();
  });

  /* ---------- Selection ---------- */
  els.chaptersBody.addEventListener('change', (e) => {
    const row = e.target.closest('tr');
    if (!row) return;
    const id = row.dataset.id;
    if (e.target.classList.contains('row-check')) {
      if (e.target.checked) { state.selected.add(id); row.classList.add('is-selected'); }
      else                   { state.selected.delete(id); row.classList.remove('is-selected'); }
      updateSelectedCount();
      syncCheckAll();
    }
  });

  els.checkAll.addEventListener('change', () => {
    const ids = state.filtered.map((c) => c.id);
    if (els.checkAll.checked) ids.forEach((id) => state.selected.add(id));
    else                       ids.forEach((id) => state.selected.delete(id));
    els.chaptersBody.querySelectorAll('tr').forEach((tr) => {
      const cb = tr.querySelector('.row-check');
      if (cb) cb.checked = state.selected.has(tr.dataset.id);
      tr.classList.toggle('is-selected', state.selected.has(tr.dataset.id));
    });
    updateSelectedCount();
  });

  els.selectAllBtn.addEventListener('click', () => {
    const allSelected = state.filtered.every((c) => state.selected.has(c.id));
    const ids = state.filtered.map((c) => c.id);
    if (allSelected) ids.forEach((id) => state.selected.delete(id));
    else              ids.forEach((id) => state.selected.add(id));
    els.chaptersBody.querySelectorAll('tr').forEach((tr) => {
      const cb = tr.querySelector('.row-check');
      if (cb) cb.checked = state.selected.has(tr.dataset.id);
      tr.classList.toggle('is-selected', state.selected.has(tr.dataset.id));
    });
    syncCheckAll();
    updateSelectedCount();
  });

  function syncCheckAll() {
    const total = state.filtered.length;
    const sel   = state.filtered.filter((c) => state.selected.has(c.id)).length;
    els.checkAll.checked  = total > 0 && sel === total;
    els.checkAll.indeterminate = sel > 0 && sel < total;
  }

  function updateSelectedCount() {
    const n = state.selected.size;
    els.selectedCount.textContent = n;
    els.downloadSelectedBtn.disabled = n === 0;
    els.downloadSelectedBtn.querySelector('span').innerHTML =
      n > 0 ? `Download (<span id="selectedCount">${n}</span>)` : 'Download';
  }

  /* ---------- Batch download ---------- */
  els.downloadSelectedBtn.addEventListener('click', () => {
    const ids = [...state.selected];
    if (ids.length === 0) return;
    toast(`Queued ${ids.length} download${ids.length === 1 ? '' : 's'} — check the browser's Downloads panel`, 'info', 4500);
    ids.forEach((id, i) => {
      const ch = state.chapters.find((c) => c.id === id);
      const label = ch ? `Ch. ${ch.chapter || '—'}` : id.slice(0, 8);
      setTimeout(() => downloadChapter(id, label), i * 300);
    });
  });

  /* ---------- Per-row download button ---------- */
  els.chaptersBody.addEventListener('click', (e) => {
    const btn = e.target.closest('.dl-btn');
    if (!btn) return;
    const id = btn.dataset.id;
    const label = btn.dataset.label || id.slice(0, 8);
    downloadChapter(id, label);
  });

  /* ---------- Tray toggle ---------- */
  els.trayToggle.addEventListener('click', () => {
    const open = !els.trayPanel.hidden;
    els.trayPanel.hidden = open;
    els.trayToggle.setAttribute('aria-expanded', String(!open));
  });
  els.trayClearBtn.addEventListener('click', () => {
    [...els.trayList.querySelectorAll('li.is-done, li.is-error')].forEach((li) => li.remove());
    updateTrayCount();
  });

  function updateTrayCount() {
    const active = state.downloads.size;
    els.trayCount.textContent = active;
    els.trayCount.classList.toggle('is-idle', active === 0);
    els.tray.hidden = false;
  }

  function addTrayRow(downloadId, label) {
    const li = document.createElement('li');
    li.dataset.id = downloadId;
    li.innerHTML = `
      <div class="tray-row__top">
        <span class="tray-row__name">${escapeHtml(label)}</span>
        <span class="tray-row__size" data-role="size">—</span>
      </div>
      <div class="tray-row__progress"><div class="tray-row__bar" data-role="bar"></div></div>
      <div class="tray-row__sub">
        <span data-role="stage">Starting…</span>
        <span data-role="count">0 / 0</span>
      </div>
    `;
    els.trayList.appendChild(li);
    updateTrayCount();
    return {
      li,
      bar:   li.querySelector('[data-role="bar"]'),
      size:  li.querySelector('[data-role="size"]'),
      stage: li.querySelector('[data-role="stage"]'),
      count: li.querySelector('[data-role="count"]'),
    };
  }

  /* ---------- Core download flow ----------
     Trigger native browser download via anchor.click().
     Server sends Content-Length → browser shows exact size + native progress + pause/cancel.
     We mirror progress locally via SSE.
  */
  function downloadChapter(chapterId, label) {
    const downloadId = (crypto.randomUUID && crypto.randomUUID()) ||
      Math.random().toString(36).slice(2) + Date.now().toString(36);

    const rowEls = addTrayRow(downloadId, label);

    const evtSource = new EventSource(`/api/progress/${downloadId}`);
    state.downloads.set(downloadId, {
      chapterId,
      label,
      evtSource,
      ...rowEls,
    });
    updateTrayCount();

    evtSource.onmessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch (_) { return; }

      switch (data.status) {
        case 'waiting':
          rowEls.stage.textContent = 'Connecting…';
          break;
        case 'preparing':
          rowEls.stage.textContent = 'Fetching info…';
          break;
        case 'downloading': {
          const downloaded = data.downloaded || 0;
          const total = data.total || 0;
          rowEls.stage.textContent = `Downloading ${escapeHtml(data.file || '')}`;
          rowEls.count.textContent = `${downloaded} / ${total || '?'}`;
          if (total > 0) {
            rowEls.bar.style.width = Math.min(100, Math.round((downloaded / total) * 100)) + '%';
          } else {
            rowEls.bar.style.width = '100%';
          }
          break;
        }
        case 'archiving':
          rowEls.stage.textContent = 'Packaging CBZ…';
          rowEls.bar.style.width = '100%';
          break;
        case 'finished':
          rowEls.stage.textContent = 'Done — browser is saving…';
          rowEls.size.textContent = formatBytes(data.sizeBytes) || '';
          rowEls.bar.classList.add('is-done');
          rowEls.bar.style.width = '100%';
          rowEls.count.textContent = `${data.total || '?'} / ${data.total || '?'}`;
          rowEls.li.classList.add('is-done');
          evtSource.close();
          markChapterDone(chapterId);
          setTimeout(() => {
            state.downloads.delete(downloadId);
            updateTrayCount();
          }, 3000);
          break;
        case 'error':
          rowEls.stage.textContent = `Failed: ${escapeHtml(data.file || 'Unknown error')}`;
          rowEls.bar.classList.add('is-error');
          rowEls.li.classList.add('is-error');
          evtSource.close();
          toast(data.file || 'Download failed', 'error', 5000);
          setTimeout(() => {
            state.downloads.delete(downloadId);
            updateTrayCount();
          }, 6000);
          break;
      }
    };

    evtSource.onerror = () => { /* server closed */ };

    // Native browser download
    const a = document.createElement('a');
    a.href = `/api/download/${chapterId}?downloadId=${downloadId}`;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function markChapterDone(chapterId) {
    const row = els.chaptersBody.querySelector(`tr[data-id="${chapterId}"]`);
    if (!row) return;
    const btn = row.querySelector('.dl-btn');
    if (btn) {
      btn.classList.add('is-done');
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Downloaded`;
    }
    state.selected.delete(chapterId);
    row.classList.remove('is-selected');
    const cb = row.querySelector('.row-check');
    if (cb) cb.checked = false;
    updateSelectedCount();
    syncCheckAll();
  }

  /* ---------- Keyboard shortcut: Cmd/Ctrl+Enter ---------- */
  els.urlInput.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      els.searchForm.requestSubmit();
    }
  });

  updateTrayCount();
})();
