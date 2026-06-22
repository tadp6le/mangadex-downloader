const express = require('express');
const axios = require('axios');
const archiver = require('archiver');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- CRITICAL FIX: Dedicated Axios Instance ---
// MangaDex REQUIRES a User-Agent. Creating an instance ensures it is sent with every API call.
const mangadexApi = axios.create({
    baseURL: 'https://api.mangadex.org',
    timeout: 15000, // 15 seconds timeout to prevent hanging
    headers: {
        'User-Agent': 'MangaDexDownloader/1.0 (Node.js Application; +https://github.com/your-repo)'
    }
});

const activeDownloads = new Map();

const downloadWithConcurrency = async (tasks, limit) => {
    let index = 0;
    const worker = async () => {
        while (index < tasks.length) {
            const currentIndex = index++;
            const task = tasks[currentIndex];
            await task();
        }
    };
    const workers = Array(Math.min(limit, tasks.length)).fill(null).map(() => worker());
    await Promise.all(workers);
};

// SSE Endpoint for Real-Time Progress
app.get('/api/progress/:downloadId', (req, res) => {
    const downloadId = req.params.downloadId;
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); 
    res.flushHeaders(); 
    const interval = setInterval(() => {
        const progress = activeDownloads.get(downloadId);
        if (progress) {
            res.write(`data: ${JSON.stringify(progress)}\n\n`);
            if (progress.status === 'finished' || progress.status === 'error') {
                clearInterval(interval);
                setTimeout(() => res.end(), 500);
            }
        } else {
            res.write(`data: ${JSON.stringify({ status: 'waiting', file: 'Waiting for download to start...' })}\n\n`);
        }
    }, 300);

    req.on('close', () => clearInterval(interval));
});

// Download Endpoint
app.get('/api/download/:chapterId', async (req, res) => {
    const chapterId = req.params.chapterId;
    const downloadId = req.query.downloadId || crypto.randomUUID();
    let tempDir = null;

    activeDownloads.set(downloadId, { status: 'preparing', file: 'Fetching chapter info...' });

    const cleanup = async () => {
        activeDownloads.delete(downloadId);
        if (tempDir) {
            await fs.remove(tempDir).catch(err => console.error('Cleanup error:', err));
            tempDir = null;
        }
    };

    try {
        // Use the dedicated mangadexApi instance
        const atHomeRes = await mangadexApi.get(`/at-home/server/${chapterId}`);
        const { baseUrl, chapter } = atHomeRes.data;
        const { hash, data } = chapter;

        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mangadex-'));
        activeDownloads.set(downloadId, { status: 'downloading', file: 'Starting image downloads...' });

        const tasks = data.map((filename) => async () => {
            activeDownloads.set(downloadId, { status: 'downloading', file: filename });
            
            const url = `${baseUrl}/data/${hash}/${filename}`;
            const filePath = path.join(tempDir, filename);
            const writer = fs.createWriteStream(filePath);
            
            // Pass User-Agent to image downloads as well to avoid Cloudflare blocks            const response = await axios({ 
                url, 
                method: 'GET', 
                responseType: 'stream',
                headers: {
                    'User-Agent': 'MangaDexDownloader/1.0 (Node.js Application; +https://github.com/your-repo)'
                }
            });
            response.data.pipe(writer);
            
            return new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });
        });

        await downloadWithConcurrency(tasks, 5);

        activeDownloads.set(downloadId, { status: 'archiving', file: 'Creating CBZ archive...' });

        const archive = archiver('zip', { zlib: { level: 0 } });
        res.setHeader('Content-Type', 'application/vnd.comicbook+zip');
        res.setHeader('Content-Disposition', `attachment; filename="chapter_${chapterId}.cbz"`);
        archive.pipe(res);

        for (const filename of data) {
            const filePath = path.join(tempDir, filename);
            archive.file(filePath, { name: filename });
        }

        await archive.finalize();
        activeDownloads.set(downloadId, { status: 'finished', file: 'Done!' });

        res.on('finish', cleanup);
        res.on('close', cleanup);

    } catch (error) {
        console.error('Download error:', error.message);
        activeDownloads.set(downloadId, { status: 'error', file: error.message });
        await cleanup();
        if (!res.headersSent) {
            res.status(500).send('Error generating CBZ archive');
        }
    }
});

// --- UPDATED: Fetch Chapters Endpoint with Detailed Error Handling ---
app.post('/api/fetch-chapters', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    const match = url.match(/title\/([a-f0-9-]+)/);
    if (!match) return res.status(400).json({ error: 'Invalid MangaDex URL format. Please use a URL like https://mangadex.org/title/uuid/...' });
    const uuid = match[1];

    try {
        const mangaRes = await mangadexApi.get(`/manga/${uuid}`);
        const titleObj = mangaRes.data.data.attributes.title;
        const title = titleObj.en || Object.values(titleObj)[0];

        const limit = 500;
        let offset = 0;
        let allChapters = [];

        while (true) {
            const feedRes = await mangadexApi.get(`/manga/${uuid}/feed`, {
                params: {
                    'translatedLanguage[]': 'en',
                    limit, offset,
                    'order[chapter]': 'asc',
                    'order[volume]': 'asc'
                }
            });
            allChapters.push(...feedRes.data.data);
            if (feedRes.data.total <= offset + limit) break;
            offset += limit;
        }

        const chapters = allChapters
            .filter(ch => !ch.attributes.externalUrl && ch.attributes.pages > 0)
            .map(ch => ({
                id: ch.id, chapter: ch.attributes.chapter,
                title: ch.attributes.title, pages: ch.attributes.pages,
                volume: ch.attributes.volume
            }));

        res.json({ title, chapters });
    } catch (error) {
        // --- NEW: Detailed Error Logging ---
        console.error('--- MangaDex API Error ---');
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Data:', error.response.data);
        } else {
            console.error('Error Message:', error.message);
        }
        console.error('--------------------------');

        // Return the actual error to the frontend so you can see it in the UI
        let errorMsg = 'Failed to fetch data from MangaDex.';        if (error.response) {
            errorMsg = `MangaDex API Error (${error.response.status}): ${JSON.stringify(error.response.data)}`;
        } else if (error.code === 'ECONNABORTED') {
            errorMsg = 'Request timed out. MangaDex might be slow or blocking the connection.';
        } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
            errorMsg = 'Network error: Could not connect to MangaDex.';
        } else {
            errorMsg = error.message;
        }
        
        res.status(500).json({ error: errorMsg });
    }
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
