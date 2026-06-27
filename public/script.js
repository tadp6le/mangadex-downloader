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
let currentMangaTitle = '';
let toastTimeouts = { error: null, success: null };

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
function hideToast(type) {
    const toast = type === 'error' ? errorToast : successToast;
    toast.style.display = 'none';
    
    // Clear any pending timeout
    if (toastTimeouts[type]) {
        clearTimeout(toastTimeouts[type]);
        toastTimeouts[type] = null;
    }
}

function showToast(type, message, duration = 3000) {
    const toast = type === 'error' ? errorToast : successToast;
    const messageEl = type === 'error' ? errorToastMessage : successToastMessage;
    const closeBtn = toast.querySelector('.toast-close');
    
    // Clear any existing timeout
    if (toastTimeouts[type]) {
        clearTimeout(toastTimeouts[type]);
    }
    
    messageEl.textContent = message;
    toast.style.display = 'flex';
    
    // Close button functionality
    closeBtn.onclick = (e) => {
        e.stopPropagation();
        hideToast(type);
    };
    
    // Auto-hide after duration
    toastTimeouts[type] = setTimeout(() => {
        hideToast(type);
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

// ============ FORMAT UTILITIES ============
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

function sanitizeFilename(str) {
    return str.replace(/[^a-z0-9._-]/gi, '_').replace(/_{2,}/g, '_');
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
        
        // Store manga title for download
        currentMangaTitle = data.title;
        
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
            <td><button class="action-btn" data-id="${ch.id}" data-chapter="${ch.chapter}" data-title="${ch.title}">📥 Download</button></td>
        `;
        chaptersBody.appendChild(tr);
    });

    attachDownloadListeners();
}

function attachDownloadListeners() {
    document.querySelectorAll('.action-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const chapterId = e.target.getAttribute('data-id');
            const chapterNum = e.target.getAttribute('data-chapter');
            const chapterTitle = e.target.getAttribute('data-title');
            downloadChapter(chapterId, chapterNum, chapterTitle);
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
async function downloadChapter(chapterId, chapterNum, chapterTitle) {
    const downloadId = Math.random().toString(36).substring(2, 15);
    
    downloadModal.style.display = 'flex';
    progressStatus.textContent = 'Connecting...';
    progressFile.textContent = '-';
    
    closeModalBtn.onclick = () => {
        downloadModal.style.display = 'none';
    };

    let evtSource;
    let totalSize = 0;
    
    try {
        // Open SSE stream for progress updates
        evtSource = new EventSource(`/api/progress/${downloadId}`);
        
        evtSource.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.totalSize) {
                totalSize = data.totalSize;
            }
            updateProgress(data, totalSize);
            
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
        const fileSize = formatFileSize(blob.size);
        
        // Create proper filename
        const sanitizedManga = sanitizeFilename(currentMangaTitle);
        const sanitizedChapter = sanitizeFilename(chapterNum || 'unknown');
        const filename = `${sanitizedManga}_ch${sanitizedChapter}.cbz`;
        
        // Trigger browser download
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
        
        // Update UI
        progressStatus.textContent = '✓ Complete!';
        progressFile.textContent = `Downloaded: ${filename} (${fileSize})`;
        showToast('success', `Downloaded: ${fileSize}`);
        
        setTimeout(() => {
            downloadModal.style.display = 'none';
        }, 2000);
        
    } catch (error) {
        console.error('Download error:', error);
        progressStatus.textContent = '✗ Error!';
        progressFile.textContent = error.message;
        showToast('error', `Download failed: ${error.message}`);
        
        setTimeout(() => {
            downloadModal.style.display = 'none';
        }, 3000);
        
    } finally {
        if (evtSource) evtSource.close();
    }
}

function updateProgress(data, totalSize) {
    const fileSizeText = totalSize ? ` (${formatFileSize(totalSize)})` : '';
    
    switch (data.status) {
        case 'waiting':
            progressStatus.textContent = 'Waiting to start...';
            progressFile.textContent = '-';
            break;
        case 'preparing':
            progressStatus.textContent = 'Preparing...';
            progressFile.textContent = 'Fetching chapter info';
            break;
        case 'downloading':
            progressStatus.textContent = `Downloading images...${fileSizeText}`;
            progressFile.textContent = `📄 ${data.file}`;
            break;
        case 'archiving':
            progressStatus.textContent = `Creating CBZ archive...${fileSizeText}`;
            progressFile.textContent = 'Packaging files';
            break;
        case 'finished':
            progressStatus.textContent = '✓ Complete!';
            progressFile.textContent = `Ready to save${fileSizeText}`;
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