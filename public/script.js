(() => {
'use strict';

const $ = (id) => document.getElementById(id);

const els = {
  searchForm: $('searchForm'),
  urlInput: $('urlInput'),
  chaptersList: $('chaptersList'),
  mangaTitle: $('mangaTitle'),
  downloadSelectedBtn: $('downloadSelectedBtn'),
  customName: $('customName')
};

let chapters = [];
let selected = new Set();

/* FETCH */
els.searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const res = await fetch('/api/fetch-chapters', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ url: els.urlInput.value })
  });

  const data = await res.json();

  chapters = data.chapters || [];
  els.mangaTitle.textContent = data.title || "";

  render();
});

/* RENDER MOBILE LIST */
function render() {
  els.chaptersList.innerHTML = "";

  chapters.forEach(ch => {
    const div = document.createElement('div');
    div.className = "chapter";

    const left = document.createElement('div');
    left.className = "chapter-left";

    const cb = document.createElement('input');
    cb.type = "checkbox";

    cb.onchange = () => {
      if (cb.checked) selected.add(ch);
      else selected.delete(ch);
    };

    const label = document.createElement('span');
    label.textContent = "Chapter " + ch.chapter;

    left.append(cb, label);

    const btn = document.createElement('button');
    btn.className = "download-btn";
    btn.textContent = "Download";

    btn.onclick = () => downloadSingle(ch);

    div.append(left, btn);

    els.chaptersList.appendChild(div);
  });
}

/* SINGLE */
function downloadSingle(ch) {
  let base = els.customName.value || "chapter";
  let name = `${base} ${ch.chapter}`;

  const edit = prompt("Edit filename:", name);
  if (edit) name = edit;

  window.open(`/api/download/${ch.id}?name=${encodeURIComponent(name)}`);
}

/* MERGED */
els.downloadSelectedBtn.onclick = () => {
  if (selected.size === 0) {
    alert("Select chapters");
    return;
  }

  const sorted = Array.from(selected).sort((a,b)=>a.chapter - b.chapter);

  const start = sorted[0].chapter;
  const end = sorted[sorted.length-1].chapter;

  let base = els.customName.value || "chapter";
  let name = `${base} ${start}-${end}`;

  const edit = prompt("Edit merged filename:", name);
  if (edit) name = edit;

  const ids = sorted.map(c => c.id).join(",");

  window.open(`/api/download-merged?ids=${ids}&name=${encodeURIComponent(name)}`);
};

})();
