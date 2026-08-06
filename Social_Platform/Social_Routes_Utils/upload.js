/* ============================================================================
 *  Social_Platform/routes/upload.js
 * ----------------------------------------------------------------------------
 *  PHASE 8 — chunked media upload for the post composer.
 *
 *  Flow (client-driven):
 *    POST /api/upload/init            { fileName, fileSize, mimeType, kind }
 *                                      -> { uploadId, chunkSize, totalChunks }
 *    POST /api/upload/chunk/:id       raw chunk bytes, header X-Chunk-Index
 *                                      -> { received, totalChunks, progress }
 *    POST /api/upload/complete/:id    -> assembles + uploads to R2
 *                                         images: resolves synchronously
 *                                         videos: 202, transcodes in background
 *    GET  /api/upload/status/:id      -> { status, progress, media }
 *                                         (composer polls this for the
 *                                         progress bar + to know when a
 *                                         video's 480p/720p are ready)
 *    DELETE /api/upload/:id           -> cancel/remove a pending session
 *                                         (frees up the "1 video" slot)
 *
 *  Restrictions enforced here:
 *    - Only 1 active video upload session per user at a time (mirrors
 *      "only 1 video per post" — posts.js is the final authority at
 *      post-creation time, this is just an earlier UX guard).
 *    - Video hard cap: 50MB, checked at /init before any chunk is accepted.
 *    - Image cap: 8MB, unchanged from the original composer.
 * ==========================================================================*/

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const { encode: encodeBlurHash } = require('blurhash');

const verifyToken = require('../../middle/middleware');
const { uploadPostMedia } = require('../../chat/services/uploadService');

const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50MB hard cap
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;  // unchanged from composer
const CHUNK_SIZE = 512 * 1024;            // 512KB per chunk
const SESSION_TTL_MS = 30 * 60 * 1000;

// uploadId -> session state (in-memory; swap for Redis if you scale to
// multiple Node instances — same tradeoff already documented in
// cache/profileCache.js)
const sessions = new Map();

// username -> uploadId of their currently-active video session (enforces
// "1 video at a time" before the post is even created)
const activeVideoSessionByUser = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
        if (now - s.createdAt > SESSION_TTL_MS) {
            if (s.kind === 'video' && activeVideoSessionByUser.get(s.username) === id) {
                activeVideoSessionByUser.delete(s.username);
            }
            sessions.delete(id);
        }
    }
}, 5 * 60 * 1000);

function sendResponse(res, status, success, message, data = null) {
    return res.status(status).json({ success, message, data });
}

/* ============================================================================
 * INIT — start a new chunked upload session
 * ==========================================================================*/
router.post('/api/upload/init', verifyToken, (req, res) => {
    const { fileName, fileSize, mimeType, kind } = req.body;
    const username = req.user.username;

    if (!fileName || !fileSize || !mimeType || !['image', 'video'].includes(kind))
        return sendResponse(res, 400, false, 'Missing or invalid upload metadata');

    if (kind === 'image' && fileSize > MAX_IMAGE_BYTES)
        return sendResponse(res, 400, false, 'Image exceeds the 8MB limit');

    if (kind === 'video') {
        if (fileSize > MAX_VIDEO_BYTES)
            return sendResponse(res, 400, false, 'Video exceeds the 50MB limit');

        const existing = activeVideoSessionByUser.get(username);
        if (existing && sessions.has(existing))
            return sendResponse(res, 409, false, 'You can only upload 1 video per post — remove the current one first');
    }

    const uploadId = crypto.randomUUID();
    const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);

    sessions.set(uploadId, {
        fileName, fileSize, mimeType, kind, username,
        chunks: new Map(),
        totalChunks,
        createdAt: Date.now(),
        status: 'uploading',
        progress: 0,
        result: null,
    });

    if (kind === 'video') activeVideoSessionByUser.set(username, uploadId);

    return sendResponse(res, 200, true, 'Upload session started', { uploadId, chunkSize: CHUNK_SIZE, totalChunks });
});

/* ============================================================================
 * CHUNK — accept one chunk of raw bytes
 * ==========================================================================*/
router.post(
    '/api/upload/chunk/:id',
    verifyToken,
    express.raw({ type: '*/*', limit: '2mb' }),
    (req, res) => {
        const session = sessions.get(req.params.id);
        if (!session) return sendResponse(res, 404, false, 'Upload session not found or expired');
        if (session.username !== req.user.username) return sendResponse(res, 403, false, 'Not your upload session');

        const index = parseInt(req.headers['x-chunk-index'], 10);
        if (Number.isNaN(index)) return sendResponse(res, 400, false, 'Missing X-Chunk-Index header');

        session.chunks.set(index, req.body);
        session.progress = session.chunks.size / session.totalChunks;

        return sendResponse(res, 200, true, 'Chunk received', {
            received: session.chunks.size,
            totalChunks: session.totalChunks,
            progress: session.progress,
        });
    }
);

/* ============================================================================
 * COMPLETE — assemble chunks and process (image sync, video async)
 * ==========================================================================*/
router.post('/api/upload/complete/:id', verifyToken, async (req, res) => {
    const uploadId = req.params.id;
    const session = sessions.get(uploadId);
    if (!session) return sendResponse(res, 404, false, 'Upload session not found or expired');
    if (session.username !== req.user.username) return sendResponse(res, 403, false, 'Not your upload session');
    if (session.chunks.size !== session.totalChunks)
        return sendResponse(res, 400, false, `Missing chunks: got ${session.chunks.size}/${session.totalChunks}`);

    const buffer = Buffer.concat(
        Array.from({ length: session.totalChunks }, (_, i) => session.chunks.get(i))
    );
    session.chunks.clear();

    if (session.kind === 'image') {
        try {
            const media = await processImage(buffer, session);
            session.status = 'ready';
            session.progress = 1;
            session.result = media;
            return sendResponse(res, 200, true, 'Image ready', { uploadId, status: 'ready', media });
        } catch (err) {
            session.status = 'failed';
            console.error('⚠️ image processing error:', err);
            return sendResponse(res, 500, false, err.message || 'Image processing failed');
        }
    }

    // Video — respond immediately, transcode in background, client polls /status
    session.status = 'processing';
    session.progress = 0;
    processVideoAsync(uploadId, buffer, session).catch(err => {
        console.error('⚠️ processVideoAsync error:', err);
        const s = sessions.get(uploadId);
        if (s) s.status = 'failed';
    });

    return sendResponse(res, 202, true, 'Video accepted, processing started', { uploadId, status: 'processing' });
});

/* ============================================================================
 * STATUS — poll for progress bar + readiness
 * ==========================================================================*/
router.get('/api/upload/status/:id', verifyToken, (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return sendResponse(res, 404, false, 'Upload session not found or expired');

    return sendResponse(res, 200, true, 'ok', {
        status: session.status,
        progress: session.progress,
        media: session.result,
    });
});

/* ============================================================================
 * CANCEL — remove a pending/completed session (e.g. user removes the video
 * from the composer before posting, freeing up the "1 video" slot)
 * ==========================================================================*/
router.delete('/api/upload/:id', verifyToken, (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return sendResponse(res, 200, true, 'Already gone');
    if (session.username !== req.user.username) return sendResponse(res, 403, false, 'Not your upload session');

    if (session.kind === 'video' && activeVideoSessionByUser.get(session.username) === req.params.id) {
        activeVideoSessionByUser.delete(session.username);
    }
    sessions.delete(req.params.id);
    return sendResponse(res, 200, true, 'Upload session cancelled');
});

/* ============================================================================
 * IMAGE PROCESSING — thumbnail + compressed + original, plus blurhash
 * ==========================================================================*/
async function processImage(buffer, session) {
    const metadata = await sharp(buffer).metadata();
    const aspectRatio = metadata.width && metadata.height ? metadata.width / metadata.height : null;

    // Tiny raw pixels for the blurhash placeholder
    const { data, info } = await sharp(buffer)
        .raw().ensureAlpha()
        .resize(32, 32, { fit: 'inside' })
        .toBuffer({ resolveWithObject: true });
    const blurHash = encodeBlurHash(new Uint8ClampedArray(data), info.width, info.height, 4, 3);

    const [thumbBuf, compressedBuf] = await Promise.all([
        sharp(buffer).resize(480).jpeg({ quality: 70 }).toBuffer(),
        sharp(buffer).resize(800).jpeg({ quality: 65 }).toBuffer(),
    ]);

    const [original, thumb, compressed] = await Promise.all([
        uploadPostMedia({ buffer, mimetype: session.mimeType, originalName: session.fileName, username: session.username }),
        uploadPostMedia({ buffer: thumbBuf, mimetype: 'image/jpeg', originalName: 'thumb.jpg', username: session.username }),
        uploadPostMedia({ buffer: compressedBuf, mimetype: 'image/jpeg', originalName: 'compressed.jpg', username: session.username }),
    ]);

    return {
        type: 'image',
        url: original.url,
        thumbUrl: thumb.url,          // backward compat with existing grid views
        thumbnailUrl: thumb.url,      // PHASE 8 naming used by the progressive loader
        compressedUrl: compressed.url,
        blurHash,
        aspectRatio,
        width: metadata.width,
        height: metadata.height,
    };
}

/* ============================================================================
 * VIDEO TRANSCODING — 480p + 720p, faststart for streaming playback
 * ==========================================================================*/
async function processVideoAsync(uploadId, buffer, session) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-video-'));
    const srcPath = path.join(tmpDir, 'source.mp4');
    fs.writeFileSync(srcPath, buffer);

    const out480 = path.join(tmpDir, '480p.mp4');
    const out720 = path.join(tmpDir, '720p.mp4');

    const transcode = (input, output, height) => new Promise((resolve, reject) => {
        ffmpeg(input)
            .videoFilters(`scale=-2:${height}`)
            // +faststart moves the moov atom to the front of the file so
            // playback can begin before the whole thing downloads — this is
            // what makes <video src=...> stream instead of "download then play"
            .outputOptions(['-preset veryfast', '-movflags +faststart', '-crf 23'])
            .on('progress', p => {
                const s = sessions.get(uploadId);
                if (s) s.progress = Math.min(0.95, (s.progress || 0) + (p.percent || 0) / 100 / 2);
            })
            .on('end', resolve)
            .on('error', reject)
            .save(output);
    });

    try {
        await transcode(srcPath, out480, 480);
        await transcode(srcPath, out720, 720);

        const duration = await new Promise((resolve) => {
            ffmpeg.ffprobe(srcPath, (err, data) => resolve(err ? null : data.format.duration));
        });

        const [raw, v480, v720] = await Promise.all([
            uploadPostMedia({ buffer, mimetype: session.mimeType, originalName: session.fileName, username: session.username }),
            uploadPostMedia({ buffer: fs.readFileSync(out480), mimetype: 'video/mp4', originalName: '480p.mp4', username: session.username }),
            uploadPostMedia({ buffer: fs.readFileSync(out720), mimetype: 'video/mp4', originalName: '720p.mp4', username: session.username }),
        ]);

        const s = sessions.get(uploadId);
        if (s) {
            s.status = 'ready';
            s.progress = 1;
            s.result = {
                type: 'video',
                url: raw.url,
                video480p: v480.url,
                video720p: v720.url,
                duration,
                quality: 'ready',
            };
        }
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        if (activeVideoSessionByUser.get(session.username) === uploadId) {
            activeVideoSessionByUser.delete(session.username);
        }
    }
}

module.exports = router;