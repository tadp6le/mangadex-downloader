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

const mangadexApi = axios.create({
    baseURL: 'https://api.mangadex.org',
    timeout: 15000,
    headers: {
        'User-Agent': 'MangaDexDownloader/1.0'
    }
});

const activeDownloads = new Map();

/* ================================
   ORIGINAL SINGLE DOWNLOAD (UNCHANGED)
================================ */
app.get('/api/download/:chapterId', async (req, res) => {
    const chapterId = req.params.chapterId;
    const customName = req.query.name || `chapter_${chapterId}`;
    let tempDir = null;

    try {
        const atHomeRes = await mangadexApi.get(`/at-home/server/${chapterId}`);
        const { baseUrl, chapter } = atHomeRes.data;
        const { hash, dataSaver } = chapter;

        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mangadex-'));

        for (let filename of dataSaver) {
            const url = `${baseUrl}/data-saver/${hash}/${filename}`;
            const filePath = path.join(tempDir, filename);

            const response = await axios({
                url,
                method: 'GET',
                responseType: 'stream'
            });

            const writer = fs.createWriteStream(filePath);
            response.data.pipe(writer);

            await new Promise((res, rej) => {
                writer.on('finish', res);
                writer.on('error', rej);
            });
        }

        const archivePath = path.join(tempDir, `${customName}.cbz`);
        const output = fs.createWriteStream(archivePath);
        const archive = archiver('zip', { zlib: { level: 0 } });

        archive.pipe(output);

        for (let file of dataSaver) {
            archive.file(path.join(tempDir, file), { name: file });
        }

        await archive.finalize();

        output.on('close', () => {
            res.download(archivePath, `${customName}.cbz`, async () => {
                await fs.remove(tempDir);
            });
        });

    } catch (err) {
        console.error(err);
        res.status(500).send('Download failed');
        if (tempDir) await fs.remove(tempDir);
    }
});

/* ================================
   NEW: MERGE MULTIPLE CHAPTERS
================================ */
app.get('/api/download-merged', async (req, res) => {
    const ids = (req.query.ids || "").split(',').filter(Boolean);
    const customName = req.query.name || "merged";
    let tempDir = null;

    if (ids.length === 0) {
        return res.status(400).send("No chapters selected");
    }

    try {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mangadex-'));

        let counter = 0;

        for (let chapterId of ids) {
            const atHomeRes = await mangadexApi.get(`/at-home/server/${chapterId}`);
            const { baseUrl, chapter } = atHomeRes.data;
            const { hash, dataSaver } = chapter;

            for (let filename of dataSaver) {
                const url = `${baseUrl}/data-saver/${hash}/${filename}`;

                // IMPORTANT: prefix to avoid overwrite
                const newName = `${counter}_${filename}`;
                const filePath = path.join(tempDir, newName);

                const response = await axios({
                    url,
                    method: 'GET',
                    responseType: 'stream'
                });

                const writer = fs.createWriteStream(filePath);
                response.data.pipe(writer);

                await new Promise((res, rej) => {
                    writer.on('finish', res);
                    writer.on('error', rej);
                });

                counter++;
            }
        }

        const archivePath = path.join(tempDir, `${customName}.cbz`);
        const output = fs.createWriteStream(archivePath);
        const archive = archiver('zip', { zlib: { level: 0 } });

        archive.pipe(output);

        const files = await fs.readdir(tempDir);

        for (let file of files) {
            if (file.endsWith(".cbz")) continue;
            archive.file(path.join(tempDir, file), { name: file });
        }

        await archive.finalize();

        output.on('close', () => {
            res.download(archivePath, `${customName}.cbz`, async () => {
                await fs.remove(tempDir);
            });
        });

    } catch (err) {
        console.error(err);
        res.status(500).send('Merge failed');
        if (tempDir) await fs.remove(tempDir);
    }
});

/* ================================
   FETCH CHAPTERS (UNCHANGED)
================================ */
app.post('/api/fetch-chapters', async (req, res) => {
    const { url } = req.body;

    const match = url.match(/title\/([a-f0-9-]+)/);
    if (!match) return res.status(400).json({ error: 'Invalid URL' });

    const uuid = match[1];

    try {
        const mangaRes = await mangadexApi.get(`/manga/${uuid}`);
        const titleObj = mangaRes.data.data.attributes.title;
        const title = titleObj.en || Object.values(titleObj)[0];

        const feedRes = await mangadexApi.get(`/manga/${uuid}/feed`, {
            params: {
                'translatedLanguage[]': 'en',
                limit: 500,
                'order[chapter]': 'asc'
            }
        });

        const chapters = feedRes.data.data.map(ch => ({
            id: ch.id,
            chapter: ch.attributes.chapter
        }));

        res.json({ title, chapters });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch' });
    }
});

app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
