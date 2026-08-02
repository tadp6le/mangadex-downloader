(() => {
'use strict';

const $ = (id) => document.getElementById(id);

const els = {
searchForm: $('searchForm'),
urlInput: $('urlInput'),
chaptersBody: $('chaptersBody'),
mangaTitle: $('mangaTitle'),
checkAll: $('checkAll'),
downloadSelectedBtn: $('downloadSelectedBtn'),
customName: $('customName'),
coverImage: $('coverImage')
};

let chapters = [];
let selected = new Set();

/* ================================
FETCH CHAPTERS + COVER
================================ */
els.searchForm.addEventListener('submit', async (e) => {
e.preventDefault();

const res = await fetch('/api/fetch-chapters', {
method: 'POST',
headers: {'Content-Type':'application/json'},
body: JSON.stringify({ url: els.urlInput.value })
});

const data = await res.json();

chapters = data.chapters || [];
renderChapters();

els.mangaTitle.textContent = data.title || "";

// ✅ SHOW COVER
if (data.coverFileName && data.mangaId) {
els.coverImage.src = "https://uploads.mangadex.org/covers/${data.mangaId}/${data.coverFileName}.jpg";
els.coverImage.style.display = "block";
}
});

/* ================================
RENDER CHAPTER LIST
================================ */
function renderChapters() {
els.chaptersBody.innerHTML = "";

chapters.forEach(ch => {
const tr = document.createElement('tr');

const tdCheck = document.createElement('td');
const cb = document.createElement('input');
cb.type = "checkbox";

cb.onchange = () => {
  if (cb.checked) selected.add(ch);
  else selected.delete(ch);
};

tdCheck.appendChild(cb);

const tdNum = document.createElement('td');
tdNum.textContent = ch.chapter;

const tdBtn = document.createElement('td');
const btn = document.createElement('button');
btn.textContent = "Download";

btn.onclick = () => downloadSingle(ch);

tdBtn.appendChild(btn);

tr.append(tdCheck, tdNum, tdBtn);
els.chaptersBody.appendChild(tr);

});
}

/* ================================
SINGLE DOWNLOAD (WITH RENAME)
================================ */
async function downloadSingle(ch) {
let base = els.customName.value || "chapter";
let name = "${base} ${ch.chapter}";

const edit = prompt("Edit filename:", name);
if (edit) name = edit;

window.open("/api/download/${ch.id}?name=${encodeURIComponent(name)}");
}

/* ================================
MULTI DOWNLOAD (MERGED)
================================ */
els.downloadSelectedBtn.onclick = async () => {
if (selected.size === 0) {
alert("No chapters selected");
return;
}

const sorted = Array.from(selected).sort((a,b)=>a.chapter - b.chapter);

const start = sorted[0].chapter;
const end = sorted[sorted.length-1].chapter;

let base = els.customName.value || "chapter";
let name = "${base} ${start}-${end}";

const edit = prompt("Edit merged filename:", name);
if (edit) name = edit;

const ids = sorted.map(c => c.id).join(",");

window.open("/api/download-merged?ids=${ids}&name=${encodeURIComponent(name)}");
};

/* ================================
SELECT ALL
================================ */
els.checkAll.onchange = () => {
const checked = els.checkAll.checked;
selected.clear();

document.querySelectorAll('#chaptersBody input[type=checkbox]').forEach((cb, i) => {
cb.checked = checked;
if (checked) selected.add(chapters[i]);
});
};

})();
