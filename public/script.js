// ============ DOM ELEMENTS ============
const urlInput = document.getElementById('urlInput');
const fetchBtn = document.getElementById('fetchBtn');
const statusEl = document.getElementById('status');
const mangaCard = document.getElementById('mangaCard');
const mangaTitleEl = document.getElementById('mangaTitle');
const chapterCount = document.getElementById('chapterCount');
const chaptersSection = document.getElementById('chaptersSection');
const chaptersTable = document.getElementById('chaptersTable');
const chaptersBody = document.getElementById('chaptersBody');
const chapterFilter = document.getElementById('chapterFilter');
const emptyState = document.getElementById('emptyState');
const downloadModal = document.getElementById('downloadModal');
const progressStatus = document.getElementById('progressStatus');
const progressFile = document.getElementById('progressFile');
const closeModalBtn = document.getElementById('closeModalBtn');
const themeBtn = document.getElementById('themeBtn');
const errorToast = document.getElementById('errorToast');
const successToast = document.getElementById('successToast');
const errorToastMessage = document.getElementById('errorToastMessage');
const successToastMessage = document.getElementById('successToastMessage');
const skeletonTemplate = document.getElementById('skeletonRow');

// ============ STATE ============
let allChapters = [];
let filteredChapters = [];

// ============ THEME TOGGLE ============
function initTheme() {
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme);
}

function setTheme(theme) {
    if (theme === 'dark') {
        document.documentElement.classList.add('dark-mode');
        localStorage.setItem('theme', 'dark');
    } else {
        document.documentElement.classList.remove('dark-mode');
        localStorage.setItem('theme', 'light');
    }
}

function toggleTheme() {
    const isDark = document.documentElement.classList.contains('dark-mode');
    setTheme(isDark ? 'light' : 'dark');
}

themeBtn.addEventListener('click', toggleTheme);

// ============ TOAST NOTIFICATIONS ============
function showToast(type, message, duration = 4000) {
    const toast = type === 'error' ? errorToast : successToast;
    const messageEl = type === 'error' ? errorToastMessage : successToastMessage;
    
    messageEl.textContent = message;
    toast.style.display = 'flex';
    
    const closeBtn = toast.querySelector('.toast-close');
    closeBtn.onclick = () => {
        toast.style.display = 'none';
    };
    
    setTimeout(() => {
        toast.style.display = 'none';
    }, duration);
}

// ============ LOADING STATE ============
function showSkeletonLoaders(count = 5) {
    chaptersBody.innerHTML = '';
    for (let i = 0; i < count; i++) {
        const skeleton = skeletonTemplate.content.cloneNode(true);
        chaptersBody.appendChild(skeleton);
    }
}

// ============ CHAPTER FETCHING ============
fetchBtn.addEventListener('click', fetchChapters);
urlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') fetchChapters();
});

async function fetchChapters() {
    const url = urlInput.value.trim();
    if (!url) {
        showToast('error', 'Please enter a MangaDex URL');
        return;
    }

    fetchBtn.disabled = true;
    statusEl.textContent = 'Fetching chapters...';
    statusEl.className = 'status-message';
    mangaCard.style.display = 'none';
    chaptersSection.style.display = 'none';
    
    showSkeletonLoaders();
    chaptersSection.style.display = 'block';

    try {
        const response = await fetch('/api/fetch-chapters', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to fetch chapters');
        }

        const data = await response.json();
        
        // Update manga info
        mangaTitleEl.textContent = data.title;
        chapterCount.textContent = `${data.chapters.length} chapters`;
        mangaCard.style.display = 'block';
        
        // Store and display chapters
        allChapters = data.chapters;
        displayChapters(allChapters);
        
        statusEl.textContent = `✓ Found ${data.chapters.length} English chapters`;
        statusEl.className = 'status-message success';
        showToast('success', 'Chapters loaded successfully!');
        
    } catch (error) {
        statusEl.textContent = `⚠ ${error.message}`;
        statusEl.className = 'status-message error';
        showToast('error', error.message);
        chaptersBody.innerHTML = '';
        emptyState.style.display = 'block';
    } finally {
        fetchBtn.disabled = false;
    }
}

// ============ CHAPTER DISPLAY ============
function displayChapters(chapters) {
    chaptersBody.innerHTML = '';
    emptyState.style.display = 'none';
    
    if (chapters.length === 0) {
        emptyState.style.display = 'block';
        return;
    }

    chapters.forEach(ch => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${escapeHtml(ch.chapter || 'N/A')}</td>
            <td>${escapeHtml(ch.title || 'No Title')}</td>
            <td>${ch.pages}</td>
            <td>${escapeHtml(ch.volume || '-')}</td>
            <td><button class="action-btn" data-id="${ch.id}">📥 Download</button></td>
        `;
        chaptersBody.appendChild(tr);
    });

    attachDownloadListeners();
}

function attachDownloadListeners() {
    document.querySelectorAll('.action-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const chapterId = e.target.getAttribute('data-id');
            downloadChapter(chapterId);
        });
    });
}

// ============ CHAPTER FILTERING ============
chapterFilter.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase();
    
    filteredChapters = allChapters.filter(ch => {
        const chapterNum = (ch.chapter || '').toString().toLowerCase();
        const title = (ch.title || '').toLowerCase();
        return chapterNum.includes(query) || title.includes(query);
    });
    
    displayChapters(filteredChapters);
});

// ============ DOWNLOAD ============
async function downloadChapter(chapterId) {
    const downloadId = Math.random().toString(36).substring(2, 15);
    
    downloadModal.style.display = 'flex';
    progressStatus.textContent = 'Connecting...';
    progressFile.textContent = '-';
    
    closeModalBtn.onclick = () => {
        downloadModal.style.display = 'none';
    };

    let evtSource;
    
    try {
        // Open SSE stream for progress updates
        evtSource = new EventSource(`/api/progress/${downloadId}`);
        
        evtSource.onmessage = (event) => {
            const data = JSON.parse(event.data);
            updateProgress(data);
            
            if (data.status === 'finished' || data.status === 'error') {
                evtSource.close();
            }
        };
        
        evtSource.onerror = (error) => {
            console.error('SSE Error:', error);
            evtSource.close();
        };

        // Start download
        const response = await fetch(`/api/download/${chapterId}?downloadId=${downloadId}`);
        
        if (!response.ok) {
            throw new Error(`Download failed with status ${response.status}`);
        }

        const blob = await response.blob();
        
        // Trigger browser download
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `chapter_${chapterId}.cbz`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
        
        // Update UI
        progressStatus.textContent = 'Complete!';
        progressFile.textContent = 'Downloaded successfully';
        showToast('success', 'Chapter downloaded!');
        
        setTimeout(() => {
            downloadModal.style.display = 'none';
        }, 2000);
        
    } catch (error) {
        console.error('Download error:', error);
        progressStatus.textContent = 'Error!';
        progressFile.textContent = error.message;
        showToast('error', `Download failed: ${error.message}`);
        
        setTimeout(() => {
            downloadModal.style.display = 'none';
        }, 3000);
        
    } finally {
        if (evtSource) evtSource.close();
    }
}

function updateProgress(data) {
    switch (data.status) {
        case 'waiting':
            progressStatus.textContent = 'Waiting to start...';
            break;
        case 'preparing':
            progressStatus.textContent = 'Preparing...';
            progressFile.textContent = 'Fetching chapter info';
            break;
        case 'downloading':
            progressStatus.textContent = 'Downloading images...';
            progressFile.textContent = `📄 ${data.file}`;
            break;
        case 'archiving':
            progressStatus.textContent = 'Creating CBZ archive...';
            progressFile.textContent = 'Packaging files';
            break;
        case 'finished':
            progressStatus.textContent = '✓ Complete!';
            progressFile.textContent = 'Ready to download';
            break;
        case 'error':
            progressStatus.textContent = '✗ Error!';
            progressFile.textContent = data.file;
            break;
    }
}

// ============ UTILITIES ============
function escapeHtml(text) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
}

// ============ INITIALIZATION ============
initTheme();

// Allow closing modal with Escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && downloadModal.style.display === 'flex') {
        downloadModal.style.display = 'none';
    }
});