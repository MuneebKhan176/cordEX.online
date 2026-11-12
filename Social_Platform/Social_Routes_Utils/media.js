/* ============================================================================
 *  Social_Platform/routes/media.js
 * ----------------------------------------------------------------------------
 *  PHASE 8 — quality resolution for adaptive video streaming.
 *  Actual byte-streaming/seeking is handled natively by R2's CDN (which
 *  supports HTTP Range requests, same as any S3-compatible store) — the
 *  browser's <video> tag does the range negotiation on its own once it has
 *  a direct URL. This endpoint just decides 480p vs 720p based on either an
 *  explicit ?quality= param or the client's connection hint, then redirects.
 * ==========================================================================*/

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const verifyToken = require('../../middle/middleware');
const { Post } = require('../../Databases/MongoDB/social_models');

router.get('/api/media/video/:postId/:mediaOrder', verifyToken, async (req, res) => {
    try {
        const { postId, mediaOrder } = req.params;
        if (!mongoose.Types.ObjectId.isValid(postId))
            return res.status(400).json({ success: false, message: 'Invalid post id' });

        const post = await Post.findOne({ _id: postId, isDeleted: false }).select('media').lean();
        if (!post) return res.status(404).json({ success: false, message: 'Post not found' });

        const item = post.media[parseInt(mediaOrder, 10)];
        if (!item || item.type !== 'video')
            return res.status(404).json({ success: false, message: 'Video not found' });

        // Explicit choice wins
        let quality = req.query.quality; // '480p' | '720p'

        // Otherwise infer from client hints (Save-Data header, or Network
        // Information API values the frontend can forward as a query param
        // since the header itself isn't always exposed to JS)
        if (!quality) {
            const saveData = req.headers['save-data'] === 'on';
            const downlink = parseFloat(req.query.downlink); // Mbps, sent by frontend via navigator.connection.downlink
            const effectiveType = req.query.effectiveType;   // '2g' | '3g' | '4g'

            const isSlow = saveData || effectiveType === '2g' || effectiveType === '3g' || (downlink && downlink < 2);
            quality = isSlow ? '480p' : '720p';
        }

        const url = quality === '480p' ? item.video480p : item.video720p;
        const fallback = item.video720p || item.video480p || item.url;

        return res.redirect(302, url || fallback);

    } catch (err) {
        console.error('⚠️ GET /api/media/video error:', err);
        return res.status(500).json({ success: false, message: 'Failed to resolve video' });
    }
});

module.exports = router;