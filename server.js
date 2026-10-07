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
app.use(express.urlencoded({ extended: true })); // needed for the batch download form
app.use(express.static('public'));

// Dedicated Axios Instance for MangaDex API
const mangadexApi = axios.create({
    baseURL: 'https://api.mangadex.org',
    timeout: 15000,
    headers: { 'User-Agent': UA }
});

const activeDownloads = new Map();

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

// Makes sure two chapters with the same number don't collide in the zip
function uniqueChapterName(shortTitle, chapterNum, used) {
    const base = chapterNum ? `${shortTitle} - Ch. ${chapterNum}` : `${shortTitle} - Chapter`;
    let name = `${base}.cbz`;
    let n = 2;
    while (used.has(name.toLowerCase())) name = `${base} (${n++}).cbz`;
    used.add(name.toLowerCase());
    return name;
}

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
            if (['finished', 'error', 'batch-error'].includes(progress.status)) {
                clearInterval(interval);
                setTimeout(() => res.end(), 500);
            }
        } else {
            res.write(`data: ${JSON.stringify({ status: 'waiting', file: 'Waiting for download to start...' })}\n\n`);
        }
    }, 300);

    req.on('close', () => clearInterval(interval));
});

// ---------- Single chapter download (unchanged, data-saver images) ----------
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
            const url = `${baseUrl}/data-saver/${hash}/${filename}`; // LOW QUALITY (data-saver)
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

// ---------- Batch download: MANY chapters -> ONE zip of .cbz files ----------
// Pressing the Download (N) button submits a hidden form here.
// The zip streams to the browser while it's being built, so the download
// starts immediately and shows up in the browser's Downloads panel.
app.post('/api/batch-download', async (req, res) => {
    let payload;
    try {
        payload = JSON.parse(req.body.payload || '{}');
    } catch (_) {
        return res.status(400).send('Bad request');
    }

    const title = String(payload.title || '');
    const chapters = Array.isArray(payload.chapters) ? payload.chapters : [];
    const batchId = payload.downloadId || crypto.randomUUID();

    if (chapters.length === 0) return res.status(400).send('No chapters selected.');

    const total = chapters.length;
    activeDownloads.set(batchId, {
        batch: true,
        status: 'batch-preparing',
        file: 'Preparing…',
        downloaded: 0,
        total,
        sizeBytes: 0
    });

    // Zip name like "One Piece - Ch. 1-50.zip"
    const nums = chapters.map(c => parseFloat(c.chapter)).filter(v => !isNaN(v));
    const shortTitle = sanitizeFilenamePart(String(title).trim().split(/\s+/).slice(0, 3).join(' '));
    let zipBase;
    if (nums.length === total && total > 0) {
        const min = Math.min(...nums);
        const max = Math.max(...nums);
        zipBase = (min === max) ? `${shortTitle} - Ch. ${min}` : `${shortTitle} - Ch. ${min}-${max}`;
    } else {
        zipBase = `${shortTitle} - ${total} chapter${total === 1 ? '' : 's'}`;
    }
    const zipName = `${sanitizeFilenamePart(zipBase, 80)}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    setContentDisposition(res, zipName);
    res.flushHeaders(); // makes the download appear in the browser right away

    const archive = archiver('zip', { zlib: { level: 0 } });
    let sentBytes = 0;
    archive.on('data', (chunk) => { sentBytes += chunk.length; });
    archive.pipe(res);

    let tempDir = null;
    const setProgress = (obj) => activeDownloads.set(batchId, { batch: true, ...obj });
    const cleanup = () => {
        const dir = tempDir;
        tempDir = null;
        if (dir) setTimeout(() => fs.remove(dir).catch(() => {}), 5000);
        setTimeout(() => activeDownloads.delete(batchId), 8000);
    };

    // If the user cancels the download in the browser, stop everything
    res.on('close', () => {
        if (!res.writableEnded) {
            setProgress({ status: 'batch-error', file: 'Canceled in browser', downloaded: 0, total, sizeBytes: 0 });
            try { archive.abort(); } catch (_) { /* noop */ }
            cleanup();
        }
    });

    try {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mangadex-batch-'));
        const usedNames = new Set();
        let okCount = 0;

        for (let i = 0; i < total; i++) {
            if (res.writableEnded || res.destroyed) break; // canceled

            const ch = chapters[i];
            const label = ch.chapter ? `Ch. ${ch.chapter}` : `Chapter ${i + 1}`;

            try {
                if (!ch.id || !UUID_RE.test(ch.id)) throw new Error('Invalid chapter id');

                setProgress({ status: 'batch-downloading', file: label, downloaded: i, total, pageDone: 0, pageTotal: 0, sizeBytes: 0 });

                const atHomeRes = await mangadexApi.get(`/at-home/server/${ch.id}`);
                const { baseUrl, chapter } = atHomeRes.data;
                const { hash, dataSaver } = chapter;

                const pageDir = path.join(tempDir, `pages_${i}`);
                await fs.ensureDir(pageDir);

                let pageDone = 0;
                const pageTotal = dataSaver.length;

                const tasks = dataSaver.map((filename) => async () => {
                    const writer = fs.createWriteStream(path.join(pageDir, filename));
                    const response = await axios({
                        url: `${baseUrl}/data-saver/${hash}/${filename}`, // LOW QUALITY (data-saver)
                        method: 'GET',
                        responseType: 'stream',
                        headers: { 'User-Agent': UA }
                    });
                    response.data.pipe(writer);
                    return new Promise((resolve, reject) => {
                        writer.on('finish', () => {
                            pageDone++;
                            setProgress({ status: 'batch-downloading', file: label, downloaded: i, total, pageDone, pageTotal, sizeBytes: 0 });
                            resolve();
                        });
                        writer.on('error', reject);
                    });
                });
                await downloadWithConcurrency(tasks, 5);

                setProgress({ status: 'batch-packing', file: label, downloaded: i, total, pageDone: pageTotal, pageTotal, sizeBytes: 0 });

                // Pack this chapter's images into its own .cbz file
                const cbzName = uniqueChapterName(shortTitle, ch.chapter ? String(ch.chapter).trim() : '', usedNames);
                const cbzPath = path.join(tempDir, `ch_${i}.cbz`);
                await new Promise((resolve, reject) => {
                    const output = fs.createWriteStream(cbzPath);
                    const chapterArchive = archiver('zip', { zlib: { level: 0 } });
                    output.on('close', resolve);
                    output.on('error', reject);
                    chapterArchive.on('error', reject);
                    chapterArchive.pipe(output);
                    for (const filename of dataSaver) {
                        chapterArchive.file(path.join(pageDir, filename), { name: filename });
                    }
                    chapterArchive.finalize();
                });

                // Delete the loose images — only the .cbz goes into the big zip
                await fs.remove(pageDir);

                archive.file(cbzPath, { name: cbzName });
                okCount++;
            } catch (err) {
                // One bad chapter doesn't kill the whole batch
                console.error(`Batch: failed ${label}:`, err.message);
                setProgress({ status: 'batch-downloading', file: `Skipped ${label} (${err.message})`, downloaded: i + 1, total, pageDone: 0, pageTotal: 0, sizeBytes: 0 });
            }
        }

        if (okCount === 0) throw new Error('Every chapter failed to download');

        setProgress({ status: 'batch-finalizing', file: 'Finishing ZIP…', downloaded: total, total, sizeBytes: 0 });

        await archive.finalize();
        // archive.pipe(res) ends the HTTP response automatically when done

        setProgress({ status: 'finished', file: zipName, downloaded: okCount, total, sizeBytes: sentBytes });
        cleanup();

    } catch (error) {
        console.error('Batch error:', error.message);
        setProgress({ status: 'batch-error', file: error.message, downloaded: 0, total, sizeBytes: 0 });
        try { archive.abort(); } catch (_) { /* noop */ }
        if (!res.writableEnded) res.destroy();
        cleanup();
    }
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
