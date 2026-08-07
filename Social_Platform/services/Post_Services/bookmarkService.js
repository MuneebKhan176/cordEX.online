/* ============================================================================
 *  Social_Platform/services/bookmarkService.js
 * ----------------------------------------------------------------------------
 *  PHASE 12 — Bookmarks ("Save post"). Same toggle pattern as follow_unfollow.js
 *  (create/delete a relationship row) and the same enrichment pattern as
 *  likeService.js (batch Set<targetId> lookup for a viewer).
 *  ----------------------------------------------------------------------------
 *  RANKING-ENGINE WIRING: toggleBookmark() increments/decrements
 *  Post.saveCount directly — that's the exact field feedRanking.js's
 *  engagementScore() already reads (weight ×2, same tier as likes). No
 *  change was needed in feedRanking.js/feedService.js for this to take
 *  effect; the field just needed a real writer, same story as
 *  commentsCount before it.
 * ==========================================================================*/

const mongoose = require('mongoose');
const { Bookmark, Post } = require('../../social_models');

function makeError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

// Toggles a bookmark for `username` on `postId`. Mirrors toggleCommentLike's
// shape in commentService.js — create/delete + counter adjust + return the
// new state so the route can respond without a second read.
async function toggleBookmark(postId, username) {
    if (!mongoose.Types.ObjectId.isValid(postId)) throw makeError(400, 'Invalid post id');

    const post = await Post.findOne({ _id: postId, isDeleted: false });
    if (!post) throw makeError(404, 'Post not found');

    const existing = await Bookmark.findOne({ username, post: postId });

    if (existing) {
        await Bookmark.deleteOne({ _id: existing._id });
        post.saveCount = Math.max(0, post.saveCount - 1);
        await post.save();
        return { bookmarked: false, saveCount: post.saveCount };
    }

    try {
        await Bookmark.create({ username, post: postId });
    } catch (dupErr) {
        if (dupErr.code === 11000) throw makeError(409, 'Already bookmarked');
        throw dupErr;
    }

    post.saveCount += 1;
    await post.save();
    return { bookmarked: true, saveCount: post.saveCount };
}

// Returns Set<postIdString> of everything `username` has bookmarked, scoped
// to just the postIds passed in — same batch shape as likeService.getLikes(),
// consumed by enrichService.js to attach isBookmarked to feed posts.
async function getBookmarkedSet(username, postIds) {
    if (!username || !postIds || !postIds.length) return new Set();

    const rows = await Bookmark.find({
        username,
        post: { $in: postIds },
    }).select('post').lean();

    return new Set(rows.map(r => String(r.post)));
}

// The "Bookmarks" tab itself — chronological by save time (newest saved
// first), NOT re-ranked by feedRanking.js. Saving something is already an
// explicit, deliberate choice by the viewer; re-scoring what they asked to
// see in a specific order would be surprising, same reasoning
// getFollowingFeed() uses for staying chronological.
async function getBookmarkedFeed(username, { page = 1, pageSize = 10 } = {}) {
    const safePage = Math.max(1, page);
    const skip = (safePage - 1) * pageSize;

    const rows = await Bookmark.find({ username })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize)
        .populate({ path: 'post', match: { isDeleted: false } })
        .lean();

    // A bookmarked post that was later soft-deleted comes back as post: null
    // from the populate match above — drop those rather than showing a
    // broken card. (Same "don't bother cleaning up" tradeoff as soft-delete
    // elsewhere in this codebase; an edge case, not a correctness bug.)
    const posts = rows.map(r => r.post).filter(Boolean);
    const hasMore = rows.length === pageSize;

    return { posts, page: safePage, hasMore };
}

module.exports = { toggleBookmark, getBookmarkedSet, getBookmarkedFeed };