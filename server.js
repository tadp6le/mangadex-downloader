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
HELPER: DOWNLOAD CHAPTER IMAGES
================================ */
async function getChapterImages(chapterId) {
const atHomeRes = await mangadexApi.get("/at-home/server/${chapterId}");
const { baseUrl, chapter } = atHomeRes.data;
const { hash, dataSaver } = chapter;

return dataSaver.map(filename => ({
    url: `${baseUrl}/data-saver/${hash}/${filename}`,
    filename
}));

}

/* ================================
HELPER: CREATE CBZ BUFFER
================================ */
async function createArchive(imagesList) {
return new Promise(async (resolve, reject) => {
const chunks = [];
const archive = archiver('zip', { zlib: { level: 0 } });

    archive.on('data', (c) => chunks.push(c));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);

    for (let img of imagesList) {
        const res = await axios.get(img.url, { responseType: 'arraybuffer' });
        archive.append(res.data, { name: img.filename });
    }

    archive.finalize();
});

}

/* ================================
SINGLE DOWNLOAD (WITH NAME)
================================ */
app.get('/api/download/:chapterId', async (req, res) => {
const chapterId = req.params.chapterId;
const customName = req.query.name || "chapter_${chapterId}";

try {
    const images = await getChapterImages(chapterId);
    const buffer = await createArchive(images);

    res.setHeader('Content-Type', 'application/vnd.comicbook+zip');
    res.setHeader('Content-Disposition', `attachment; filename="${customName}.cbz"`);
    res.setHeader('Content-Length', buffer.length);

    res.end(buffer);
} catch (err) {
    console.error(err);
    res.status(500).send('Download failed');
}

});

/* ================================
MERGED DOWNLOAD
================================ */
app.get('/api/download-merged', async (req, res) => {
const ids = req.query.ids.split(',');
const name = req.query.name || 'merged';

try {
    let allImages = [];

    for (let id of ids) {
        const imgs = await getChapterImages(id);
        allImages.push(...imgs);
    }

    const buffer = await createArchive(allImages);

    res.setHeader('Content-Type', 'application/vnd.comicbook+zip');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.cbz"`);
    res.setHeader('Content-Length', buffer.length);

    res.end(buffer);
} catch (err) {
    console.error(err);
    res.status(500).send('Merge failed');
}

});

/* ================================
FETCH CHAPTERS + COVER
================================ */
app.post('/api/fetch-chapters', async (req, res) => {
const { url } = req.body;

const match = url.match(/title\/([a-f0-9-]+)/);
if (!match) return res.status(400).json({ error: 'Invalid URL' });

const uuid = match[1];

try {
    const mangaRes = await mangadexApi.get(`/manga/${uuid}`, {
        params: { includes: ['cover_art'] }
    });

    const data = mangaRes.data.data;

    const titleObj = data.attributes.title;
    const title = titleObj.en || Object.values(titleObj)[0];

    // COVER
    let coverFileName = null;
    let mangaId = uuid;

    const rel = data.relationships.find(r => r.type === 'cover_art');
    if (rel) {
        const coverRes = await mangadexApi.get(`/cover/${rel.id}`);
        coverFileName = coverRes.data.data.attributes.fileName;
    }

    // CHAPTERS
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

    res.json({
        title,
        chapters,
        coverFileName,
        mangaId
    });

} catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch' });
}

});

app.listen(PORT, () => console.log("Running on http://localhost:${PORT}"));
