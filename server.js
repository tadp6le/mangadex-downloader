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

const UA = 'MangaDexDownloader/1.0 (Node.js Application; +https://github.com/your-repo)';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Dedicated Axios Instance for MangaDex API
const mangadexApi = axios.create({
    baseURL: 'https://api.mangadex.org',
    timeout: 15000,
    headers: { 'User-Agent': UA }
});

const activeDownloads = new Map(); // live progress for single downloads AND batches
const readyBatches = new Map();    // batchId -> { filePath, tempDir, filename, sizeBytes }

// --- Filename helpers -------------------------------------------------------
const sanitizeFilenamePart = (str, maxLen = 60) =>
    String(str || '')
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/[\\/:*?"<>|]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[.\s]+$/, '')
        .slice(0, maxLen)
        .replace(/[.\s]+$/, '')
        || 'Manga';

const buildCbzFilename = (query, chapterId) => {
    const words = String(query.title || '').trim().split(/\s+/).filter(Boolean);
    const shortTitle = sanitizeFilenamePart(words.slice(0, 3).join(' '));
    const chapterNum = query.chapter ? String(query.chapter).trim() : '';
    if (chapterNum) return `${shortTitle} - Ch. ${chapterNum}.cbz`;
    return `${shortTitle} - ${chapterId.slice(0, 8)}.cbz`;
};

const setContentDisposition = (res, filename) => {
    const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.setHeader('Content-Disposition',
        `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
};

const downloadWithConcurrency = async (tasks, limit) => {
    let index = 0;
    const worker = async () => {
        while (index < tasks.length) {
            const currentIndex = index++;
            await tasks[currentIndex]();
        }
    };
    const workers = Array(Math.min(limit, tasks.length)).fill(null).map(() => worker());
    await Promise.all(workers);
};

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

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
            if (['finished', 'error', 'batch-ready', 'batch-error'].includes(progress.status)) {
                clearInterval(interval);
                setTimeout(() => res.end(), 500);
            }
        } else {
            res.write(`data: ${JSON.stringify({ status: 'waiting', file: 'Waiting for download to start...' })}\n\n`);
        }
    }, 300);

    req.on('close', () => clearInterval(interval));
});

// ---------- Single chapter download (unchanged behavior) ----------
app.get('/api/download/:chapterId', async (req, res) => {
    const chapterId = req.params.chapterId;
    const downloadId = req.query.downloadId || crypto.randomUUID();
    let tempDir = null;

    activeDownloads.set(downloadId, {
        status: 'preparing',
        file: 'Fetching chapter info...',
        downloaded: 0,
        total: 0,
        sizeBytes: 0
    });

    const cleanup = async () => {
        activeDownloads.delete(downloadId);
        if (tempDir) {
            await fs.remove(tempDir).catch(err => console.error('Cleanup error:', err));
            tempDir = null;
        }
    };

    try {
        const atHomeRes = await mangadexApi.get(`/at-home/server/${chapterId}`);
        const { baseUrl, chapter } = atHomeRes.data;
        const { hash, dataSaver } = chapter;
        const data = dataSaver;
        const total = data.length;

        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mangadex-'));

        let downloaded = 0;
        activeDownloads.set(downloadId, {
            status: 'downloading',
            file: 'Starting image downloads...',
            downloaded,
            total,
            sizeBytes: 0
        });

        const tasks = data.map((filename) => async () => {
            const url = `${baseUrl}/data-saver/${hash}/${filename}`;
            const filePath = path.join(tempDir, filename);
            const writer = fs.createWriteStream(filePath);

            const response = await axios({
                url: url,
                method: 'GET',
                responseType: 'stream',
                headers: { 'User-Agent': UA }
            });
            response.data.pipe(writer);

            return new Promise((resolve, reject) => {
                writer.on('finish', () => {
                    downloaded++;
                    activeDownloads.set(downloadId, {
                        status: 'downloading',
                        file: filename,
                        downloaded,
                        total,
                        sizeBytes: 0
                    });
                    resolve();
                });
                writer.on('error', reject);
            });
        });

        await downloadWithConcurrency(tasks, 5);

        activeDownloads.set(downloadId, {
            status: 'archiving',
            file: 'Creating CBZ archive...',
            downloaded: total,
            total,
            sizeBytes: 0
        });

        const archiveBuffer = await new Promise((resolve, reject) => {
            const chunks = [];
            const archive = archiver('zip', { zlib: { level: 0 } });
            archive.on('data', (chunk) => chunks.push(chunk));
            archive.on('end', () => resolve(Buffer.concat(chunks)));
            archive.on('error', reject);
            for (const filename of data) {
                archive.file(path.join(tempDir, filename), { name: filename });
            }
            archive.finalize();
        });

        const sizeBytes = archiveBuffer.length;
        const filename = buildCbzFilename(req.query, chapterId);

        res.setHeader('Content-Type', 'application/vnd.comicbook+zip');
        setContentDisposition(res, filename);
        res.setHeader('Content-Length', sizeBytes);
        res.setHeader('Access-Control-Expose-Headers', 'Content-Length');

        activeDownloads.set(downloadId, {
            status: 'finished',
            file: filename,
            downloaded: total,
            total,
            sizeBytes
        });

        res.end(archiveBuffer);

        res.on('finish', cleanup);
        res.on('close', cleanup);

    } catch (error) {
        console.error('Download error:', error.message);
        activeDownloads.set(downloadId, {
            status: 'error',
            file: error.message,
            downloaded: 0,
            total: 0,
            sizeBytes: 0
        });
        await cleanup();
        if (!res.headersSent) {
            res.status(500).send('Error generating CBZ archive');
        }
    }
});

// ---------- NEW: Batch download (many chapters -> ONE zip) ----------
app.post('/api/batch', (req, res) => {
    const { title, chapters } = req.body || {};
    if (!Array.isArray(chapters) || chapters.length === 0) {
        return res.status(400).json({ error: 'No chapters selected.' });
    }

    // Only one batch can build at a time (protects against rate limits)
    for (const p of activeDownloads.values()) {
        if (p.batch && ['batch-preparing', 'batch-downloading', 'batch-packing'].includes(p.status)) {
            return res.status(409).json({ error: 'A batch is already being built. Wait for it or save it first.' });
        }
    }

    const batchId = crypto.randomUUID();
    activeDownloads.set(batchId, {
        batch: true,
        status: 'batch-preparing',
        file: 'Preparing…',
        downloaded: 0,
        total: chapters.length,
        sizeBytes: 0
    });

    // Reply immediately; the heavy work happens in the background
    res.json({ batchId });
    buildBatch(batchId, title || '', chapters).catch(err => console.error('Batch crashed:', err));
});

async function buildBatch(batchId, title, chapters) {
    let tempDir = null;
    const setProgress = (obj) => activeDownloads.set(batchId, { batch: true, ...obj });

    try {
        setProgress({ status: 'batch-preparing', file: 'Preparing…', downloaded: 0, total: chapters.length, sizeBytes: 0 });

        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mangadex-batch-'));
        const zipPath = path.join(tempDir, 'batch.zip');
        const zipStream = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 0 } }); // images are already compressed
        archive.pipe(zipStream);

        const total = chapters.length;
        const usedFolders = new Set();
        let skipped = 0;

        for (let i = 0; i < total; i++) {
            const ch = chapters[i];
            const label = ch.chapter ? `Ch. ${ch.chapter}` : `Chapter ${i + 1}`;

            try {
                if (!ch.id || !UUID_RE.test(ch.id)) throw new Error('Invalid chapter id');

                setProgress({
                    status: 'batch-downloading',
                    file: label,
                    downloaded: i,
                    total,
                    pageDone: 0,
                    pageTotal: 0,
                    sizeBytes: 0
                });

                const atHomeRes = await mangadexApi.get(`/at-home/server/${ch.id}`);
                const { baseUrl, chapter } = atHomeRes.data;
                const { hash, dataSaver } = chapter;

                // Unique, filesystem-safe folder name per chapter
                let folderName = label.replace(/[\\/:*?"<>|]/g, '').trim() || `Chapter ${i + 1}`;
                let n = 2;
                while (usedFolders.has(folderName.toLowerCase())) folderName = `${label} (${n++})`;
                usedFolders.add(folderName.toLowerCase());

                const chapterDir = path.join(tempDir, folderName);
                await fs.ensureDir(chapterDir);

                let pageDone = 0;
                const pageTotal = dataSaver.length;

                const tasks = dataSaver.map((filename) => async () => {
                    const writer = fs.createWriteStream(path.join(chapterDir, filename));
                    const response = await axios({
                        url: `${baseUrl}/data-saver/${hash}/${filename}`,
                        method: 'GET',
                        responseType: 'stream',
                        headers: { 'User-Agent': UA }
                    });
                    response.data.pipe(writer);
                    return new Promise((resolve, reject) => {
                        writer.on('finish', () => {
                            pageDone++;
                            setProgress({
                                status: 'batch-downloading',
                                file: label,
                                downloaded: i,
                                total,
                                pageDone,
                                pageTotal,
                                sizeBytes: 0
                            });
                            resolve();
                        });
                        writer.on('error', reject);
                    });
                });
                await downloadWithConcurrency(tasks, 5);

                archive.directory(chapterDir, folderName);
            } catch (err) {
                // One bad chapter doesn't kill the whole batch
                console.error(`Batch: failed ${label}:`, err.message);
                skipped++;
                setProgress({
                    status: 'batch-downloading',
                    file: `Skipped ${label} (${err.message})`,
                    downloaded: i + 1,
                    total,
                    pageDone: 0,
                    pageTotal: 0,
                    sizeBytes: 0
                });
            }
        }

        if (skipped === total) throw new Error('Every chapter failed to download');

        setProgress({ status: 'batch-packing', file: 'Creating ZIP archive…', downloaded: total, total, sizeBytes: 0 });

        await archive.finalize();
        await new Promise((resolve, reject) => {
            zipStream.on('close', resolve);
            zipStream.on('error', reject);
        });

        const stat = await fs.stat(zipPath);

        // File name like "One Piece - Ch. 1-50.zip"
        const nums = chapters.map(c => parseFloat(c.chapter)).filter(v => !isNaN(v));
        const shortTitle = sanitizeFilenamePart(String(title || '').trim().split(/\s+/).slice(0, 3).join(' '));
        let base;
        if (nums.length === total) {
            const min = Math.min(...nums);
            const max = Math.max(...nums);
            base = (min === max)
                ? `${shortTitle} - Ch. ${min}`
                : `${shortTitle} - Ch. ${min}-${max}`;
        } else {
            base = `${shortTitle} - Batch (${total} chapter${total === 1 ? '' : 's'})`;
        }
        const filename = `${sanitizeFilenamePart(base, 80)}.zip`;

        readyBatches.set(batchId, { filePath: zipPath, tempDir, filename, sizeBytes: stat.size });

        setProgress({
            status: 'batch-ready',
            file: filename,
            downloaded: total - skipped,
            total,
            skipped,
            sizeBytes: stat.size
        });

        // Keep the finished zip available for 30 minutes (lets you re-save), then clean up
        setTimeout(() => {
            readyBatches.delete(batchId);
            activeDownloads.delete(batchId);
            fs.remove(tempDir).catch(() => {});
        }, 30 * 60 * 1000);

    } catch (error) {
        console.error('Batch error:', error.message);
        setProgress({
            status: 'batch-error',
            file: error.message,
            downloaded: 0,
            total: chapters.length,
            sizeBytes: 0
        });
        if (tempDir) fs.remove(tempDir).catch(() => {});
        activeDownloads.delete(batchId);
    }
}

// Serves the finished zip — only called when the user presses "Save ZIP"
app.get('/api/batch-file/:batchId', (req, res) => {
    const batch = readyBatches.get(req.params.batchId);
    if (!batch) return res.status(404).send('Batch not found (it expired). Build it again.');

    res.setHeader('Content-Type', 'application/zip');
    setContentDisposition(res, batch.filename);
    res.setHeader('Content-Length', batch.sizeBytes);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length');

    const stream = fs.createReadStream(batch.filePath);
    stream.on('error', (err) => {
        console.error('Batch stream error:', err.message);
        if (!res.headersSent) res.status(500).send('Error reading archive');
        else res.destroy();
    });
    stream.pipe(res);
});

// Fetch Chapters Endpoint
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
                    limit: limit,
                    offset: offset,
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
                id: ch.id,
                chapter: ch.attributes.chapter,
                title: ch.attributes.title,
                pages: ch.attributes.pages,
                volume: ch.attributes.volume
            }));

        res.json({ title: title, chapters: chapters });
    } catch (error) {
        console.error('--- MangaDex API Error ---');
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Data:', error.response.data);
        } else {
            console.error('Error Message:', error.message);
        }
        console.error('--------------------------');

        let errorMsg = 'Failed to fetch data from MangaDex.';
        if (error.response) {
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
