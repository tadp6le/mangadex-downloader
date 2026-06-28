/* ==========================================================================
   MangaDex Downloader — Frontend logic
   Same backend contract, polished UX.
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
    mangaCover:    $('mangaCover'),
    chapterCount:  $('chapterCount'),
    chaptersList:  $('chaptersList'),
    chaptersBody:  $('chaptersBody'),
    emptyChapters: $('emptyChapters'),
    chapterFilter: $('chapterFilter'),
    checkAll:      $('checkAll'),
    selectAllBtn:  $('selectAllBtn'),
    downloadSelectedBtn: $('downloadSelectedBtn'),
    selectedCount: $('selectedCount'),

    modal:         $('downloadModal'),
    modalChapterLabel: $('modalChapterLabel'),
    progressBar:   $('progressBar'),
    progressCount: $('progressCount'),
    progressPercent: $('progressPercent'),
    progressStatus: $('progressStatus'),
    progressFile:  $('progressFile'),
    statusDot:     $('statusDot'),
    cancelDownloadBtn: $('cancelDownloadBtn'),
    toasts:        $('toasts'),
  };

  /* ---------- State ---------- */
  const state = {
    chapters: [],         // full list from server
    filtered: [],         // after filter
    selected: new Set(),  // selected chapter IDs
    inFlight: new Set(),  // active downloadIds
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
            CBZ
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

  els.downloadSelectedBtn.addEventListener('click', () => {
    const ids = [...state.selected];
    if (ids.length === 0) return;
    toast(`Starting ${ids.length} download${ids.length === 1 ? '' : 's'}…`, 'info');
    ids.forEach((id, i) => {
      const ch = state.chapters.find((c) => c.id === id);
      const label = ch ? `Ch. ${ch.chapter || '—'}` : id.slice(0, 8);
      setTimeout(() => downloadChapter(id, null, label), i * 400);
    });
  });

  /* ---------- Per-row download button ---------- */
  els.chaptersBody.addEventListener('click', (e) => {
    const btn = e.target.closest('.dl-btn');
    if (!btn) return;
    const id = btn.dataset.id;
    const label = btn.dataset.label || id.slice(0, 8);
    downloadChapter(id, btn, label);
  });

  /* ---------- Modal control ---------- */
  function openModal(chapterLabel) {
    els.modalChapterLabel.textContent = chapterLabel || 'Preparing…';
    els.progressBar.style.width = '0%';
    els.progressCount.textContent = '0 / 0';
    els.progressPercent.textContent = '0%';
    els.progressStatus.textContent = 'Initializing…';
    els.progressFile.textContent = '—';
    els.statusDot.className = 'dot dot--pulse';
    els.cancelDownloadBtn.hidden = true;
    els.modal.classList.add('is-open');
    els.modal.setAttribute('aria-hidden', 'false');
  }

  function closeModal() {
    els.modal.classList.remove('is-open');
    els.modal.setAttribute('aria-hidden', 'true');
  }

  els.cancelDownloadBtn.addEventListener('click', closeModal);
  els.modal.querySelector('.modal__backdrop').addEventListener('click', closeModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.modal.classList.contains('is-open')) closeModal();
  });

  /* ---------- Download flow ---------- */
  function downloadChapter(chapterId, btn, label) {
    const downloadId = (crypto.randomUUID && crypto.randomUUID()) ||
      Math.random().toString(36).slice(2) + Date.now().toString(36);

    state.inFlight.add(downloadId);
    openModal(label);

    let totalEstimate = 0;
    let downloadedCount = 0;
    let finished = false;

    const evtSource = new EventSource(`/api/progress/${downloadId}`);

    evtSource.onmessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch (_) { return; }

      switch (data.status) {
        case 'waiting':
          els.progressStatus.textContent = 'Connecting to server…';
          els.progressFile.textContent = 'Waiting for download to start…';
          break;

        case 'preparing':
          els.progressStatus.textContent = 'Fetching chapter info…';
          els.progressFile.textContent = 'Contacting MangaDex…';
          break;

        case 'downloading':
          // MangaDex files are named like "01-abc.jpg" or "1.jpg" — infer progress
          const m = String(data.file || '').match(/^(\d+)/);
          if (m) {
            const num = parseInt(m[1], 10);
            if (!totalEstimate || num > totalEstimate) totalEstimate = num;
            downloadedCount = Math.max(downloadedCount, num);
          }
          els.progressStatus.textContent = 'Downloading pages…';
          els.progressFile.textContent = data.file || '—';
          updateProgressUI(downloadedCount, totalEstimate);
          break;

        case 'archiving':
          els.progressStatus.textContent = 'Packaging CBZ archive…';
          els.progressFile.textContent = 'Zipping pages…';
          els.progressBar.style.width = '100%';
          els.progressPercent.textContent = '100%';
          els.progressCount.textContent = `${totalEstimate || '?'} / ${totalEstimate || '?'}`;
          els.statusDot.classList.remove('dot--pulse');
          els.statusDot.classList.add('dot--ok');
          break;

        case 'finished':
          els.progressStatus.textContent = 'Saved to your device';
          els.progressFile.textContent = `chapter_${chapterId.slice(0, 8)}.cbz`;
          els.statusDot.classList.remove('dot--pulse');
          els.statusDot.classList.add('dot--ok');
          els.cancelDownloadBtn.hidden = false;
          finished = true;
          evtSource.close();
          break;

        case 'error':
          els.progressStatus.textContent = 'Download failed';
          els.progressFile.textContent = data.file || 'Unknown error';
          els.statusDot.classList.remove('dot--pulse');
          els.statusDot.classList.add('dot--err');
          els.cancelDownloadBtn.hidden = false;
          finished = true;
          evtSource.close();
          toast(data.file || 'Download failed', 'error', 5000);
          break;
      }
    };

    evtSource.onerror = () => { /* server closed stream — fetch() result will handle it */ };

    function updateProgressUI(done, total) {
      if (!total) {
        els.progressBar.style.width = '100%';
        els.progressCount.textContent = `${done} pages`;
        els.progressPercent.textContent = '…';
      } else {
        const pct = Math.min(100, Math.round((done / total) * 100));
        els.progressBar.style.width = pct + '%';
        els.progressCount.textContent = `${done} / ${total}`;
        els.progressPercent.textContent = pct + '%';
      }
    }

    // Trigger actual file download
    fetch(`/api/download/${chapterId}?downloadId=${downloadId}`)
      .then((response) => {
        if (!response.ok) throw new Error('Failed to generate archive');
        return response.blob();
      })
      .then((blob) => {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `chapter_${chapterId}.cbz`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);

        if (btn) {
          btn.classList.add('is-done');
          btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Done`;
          btn.disabled = true;
        }

        toast(`Downloaded ${label || 'chapter'}`, 'success');
        state.selected.delete(chapterId);
        const row = els.chaptersBody.querySelector(`tr[data-id="${chapterId}"]`);
        if (row) {
          row.classList.remove('is-selected');
          const cb = row.querySelector('.row-check');
          if (cb) cb.checked = false;
        }
        updateSelectedCount();
        syncCheckAll();

        setTimeout(() => {
          if (finished) closeModal();
        }, 900);
      })
      .catch((err) => {
        console.error('Download failed:', err);
        els.progressStatus.textContent = 'Download failed';
        els.progressFile.textContent = err.message;
        els.statusDot.classList.remove('dot--pulse');
        els.statusDot.classList.add('dot--err');
        els.cancelDownloadBtn.hidden = false;
        toast(err.message, 'error', 5000);
      })
      .finally(() => {
        state.inFlight.delete(downloadId);
        evtSource.close();
      });
  }

  /* ---------- Keyboard shortcut: Cmd/Ctrl+Enter to fetch ---------- */
  els.urlInput.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      els.searchForm.requestSubmit();
    }
  });
})();
