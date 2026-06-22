const urlInput = document.getElementById('urlInput');
const fetchBtn = document.getElementById('fetchBtn');
const statusEl = document.getElementById('status');
const mangaInfoEl = document.getElementById('mangaInfo');
const mangaTitleEl = document.getElementById('mangaTitle');
const chaptersListEl = document.getElementById('chaptersList');
const chaptersBody = document.getElementById('chaptersBody');

fetchBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url) return alert('Please enter a MangaDex URL');

    fetchBtn.disabled = true;
    statusEl.textContent = 'Fetching chapters... Please wait.';
    chaptersListEl.style.display = 'none';
    mangaInfoEl.style.display = 'none';
    chaptersBody.innerHTML = '';

    try {
        const response = await fetch('/api/fetch-chapters', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });

        if (!response.ok) throw new Error((await response.json()).error);
        const data = await response.json();
        
        mangaTitleEl.textContent = data.title;
        mangaInfoEl.style.display = 'block';

        data.chapters.forEach(ch => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${ch.chapter || 'N/A'}</td>
                <td>${ch.title || 'No Title'}</td>
                <td>${ch.pages}</td>
                <td><button class="action-btn" data-id="${ch.id}">Download CBZ</button></td>
            `;
            chaptersBody.appendChild(tr);
        });

        chaptersListEl.style.display = 'block';
        statusEl.textContent = `Found ${data.chapters.length} English chapters.`;
        
        document.querySelectorAll('.action-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const chapterId = e.target.getAttribute('data-id');
                downloadChapter(chapterId, e.target);
            });
        });

    } catch (error) {
        statusEl.textContent = `Error: ${error.message}`;
        statusEl.style.color = '#cf6679';
    } finally {
        fetchBtn.disabled = false;
    }
});

// --- NEW: Advanced Download Function with Real-Time UI ---
function downloadChapter(chapterId, btn) {
    // Generate a unique ID to link the SSE stream with the Fetch request
    const downloadId = Math.random().toString(36).substring(2, 15);
    
    const modal = document.getElementById('downloadModal');
    const progressStatus = document.getElementById('progressStatus');
    const progressFile = document.getElementById('progressFile');
    
    // Show the modal
    modal.style.display = 'flex';
    progressStatus.textContent = 'Status: Connecting...';
    progressFile.textContent = 'Current file: -';

    // 1. Open Server-Sent Events stream to listen for file names
    const evtSource = new EventSource(`/api/progress/${downloadId}`);
    
    evtSource.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        if (data.status === 'waiting') {
            progressStatus.textContent = 'Status: Connecting to server...';
        } else if (data.status === 'preparing') {
            progressStatus.textContent = 'Status: Fetching chapter info...';
            progressFile.textContent = 'Current file: -';
        } else if (data.status === 'downloading') {
            progressStatus.textContent = 'Status: Downloading images...';
            progressFile.textContent = `Current file: ${data.file}`; // Shows exact filename!
        } else if (data.status === 'archiving') {
            progressStatus.textContent = 'Status: Creating CBZ archive...';
            progressFile.textContent = 'Current file: Packaging files...';
        } else if (data.status === 'finished') {
            progressStatus.textContent = 'Status: Complete!';
            progressFile.textContent = 'Saving to your device...';
            evtSource.close();
        } else if (data.status === 'error') {
            progressStatus.textContent = 'Status: Error!';
            progressFile.textContent = data.file;
            evtSource.close();
        }
    };
    
    evtSource.onerror = () => evtSource.close();

    // 2. Start the actual file download using Fetch API
    fetch(`/api/download/${chapterId}?downloadId=${downloadId}`)
        .then(response => {
            if (!response.ok) throw new Error('Failed to generate archive');
            return response.blob(); // Downloads entirely into browser memory
        })
        .then(blob => {
            // Trigger the native browser download
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `chapter_${chapterId}.cbz`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            window.URL.revokeObjectURL(url);
            
            // Hide modal after a brief delay
            setTimeout(() => { modal.style.display = 'none'; }, 2000);
        })
        .catch(error => {
            console.error('Download failed:', error);
            progressStatus.textContent = 'Status: Download Failed';
            progressFile.textContent = error.message;
            setTimeout(() => { modal.style.display = 'none'; }, 4000);
        })
        .finally(() => {
            evtSource.close(); // Ensure SSE connection is always closed
        });
      }
