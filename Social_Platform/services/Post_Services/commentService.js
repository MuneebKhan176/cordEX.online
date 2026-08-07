/* ============================================================================
 *  Social_Platform/services/commentService.js
 * ----------------------------------------------------------------------------
 *  PHASE 11 — Comments, one level of replies, and likes on both.
 *  ----------------------------------------------------------------------------
 *  Mirrors the shape of the Post like/enrich pipeline (services/likeService.js,
 *  services/authorService.js) rather than inventing a new pattern:
 *
 *    Comment  -> belongs to a Post          (post.commentsCount denormalized)
 *    Reply    -> belongs to a Comment       (comment.repliesCount denormalized)
 *    Like     -> already generic (targetType: Post | Comment | Reply), so
 *                 comment/reply likes reuse the exact same collection posts do.
 *                 Like-only, by design — there is no dislike/downvote path
 *                 anywhere in this file or in the routes that call it.
 *
 *  RANKING-ENGINE WIRING (this is the part that actually feeds
 *  feedRanking.js / feedService.js, not just a UI feature):
 *
 *    1. post.commentsCount is incremented/decremented right here, in the
 *       same request that creates/deletes a comment. feedRanking.js's
 *       engagementScore() already reads post.commentsCount (weight ×3,
 *       second only to shares) — so every comment immediately nudges that
 *       post's score on the very next feed fetch. No feedRanking.js change
 *       needed for this half; it was already reading the field this file
 *       writes.
 *
 *    2. Posting a comment/reply also calls interestTracker.trackActivity()
 *       with activityType: 'comment' — a personalization signal exactly
 *       like watch_video/open_profile, scored against the *post's*
 *       hashtags (see interestTracker.js PHASE 11). This is what lets
 *       "user comments a lot on #btc posts" actually shift what that
 *       user's discover feed surfaces next, via
 *       feedRanking.js's interestScore() term. Fire-and-forget: a
 *       tracking failure must never fail the comment/reply itself.
 *
 *  Soft-delete only (isDeleted, matches Comment/Reply schema + Post
 *  convention in profile.js). Deleting a comment does NOT cascade-delete
 *  its replies — they just become unreachable once the parent comment is
 *  filtered out of listings, same "soft delete, don't bother cleaning up
 *  children" tradeoff posts.js already makes.
 * ==========================================================================*/

const mongoose = require('mongoose');
const { Post, Comment, Reply, Like } = require('../../social_models');
const { getAuthors } = require('./authorService');
const { getLikes } = require('./likeService');
const { trackActivity } = require('../Feed_Engine/interestTracker'); // PHASE 11 — ranking-engine wiring

const DEFAULT_PAGE_SIZE = 10;
const MAX_CONTENT_LENGTH = 1000; // matches Comment/Reply schema maxlength

function makeError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

function assertValidId(id, label) {
    if (!mongoose.Types.ObjectId.isValid(id)) throw makeError(400, `Invalid ${label}`);
}

function assertContent(content, label) {
    const trimmed = (content || '').trim();
    if (!trimmed) throw makeError(400, `${label} content is required`);
    if (trimmed.length > MAX_CONTENT_LENGTH) throw makeError(400, `${label} must be ${MAX_CONTENT_LENGTH} characters or fewer`);
    return trimmed;
}

/* ============================================================================
 * SHARED ENRICHMENT — attaches author + isLiked + isSelf to a batch of plain
 * comment/reply docs. Same idea as services/enrichService.js for posts, just
 * scoped to what a comment card actually renders (no follow state needed).
 * ==========================================================================*/
async function enrichWithAuthorAndLike(docs, myUsername, targetType) {
    if (!docs.length) return [];

    const usernames = [...new Set(docs.map(d => d.username))];
    const ids = docs.map(d => d._id);

    const [authorMap, likedSet] = await Promise.all([
        getAuthors(usernames, 'username displayName avatarUrl'),
        getLikes(myUsername, ids, targetType),
    ]);

    return docs.map(d => {
        const author = authorMap.get(d.username);
        return {
            ...d,
            author: {
                displayName: author?.displayName || d.username,
                avatarUrl: author?.avatarUrl || '',
            },
            isSelf: d.username === myUsername,
            isLiked: likedSet.has(String(d._id)),
        };
    });
}

/* ============================================================================
 * COMMENTS
 * ==========================================================================*/

// Newest first, paginated — matches the pattern getFollowingFeed() already
// uses (skip/limit + hasMore off page-full check).
async function getComments(postId, myUsername, { page = 1, pageSize = DEFAULT_PAGE_SIZE } = {}) {
    assertValidId(postId, 'post id');
    const safePage = Math.max(1, page);
    const skip = (safePage - 1) * pageSize;

    const rawComments = await Comment.find({ post: postId, isDeleted: false })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean();

    const hasMore = rawComments.length === pageSize;
    const comments = await enrichWithAuthorAndLike(rawComments, myUsername, 'Comment');

    return { comments, page: safePage, hasMore };
}

async function createComment(postId, username, content) {
    assertValidId(postId, 'post id');
    const trimmed = assertContent(content, 'Comment');

    const post = await Post.findOne({ _id: postId, isDeleted: false });
    if (!post) throw makeError(404, 'Post not found');

    const comment = await Comment.create({ post: postId, username, content: trimmed });

    // RANKING SIGNAL #1 — post.commentsCount feeds feedRanking.js's
    // engagementScore() directly on the next feed fetch.
    post.commentsCount += 1;
    await post.save();

    // RANKING SIGNAL #2 — personalization. Fire-and-forget: never let an
    // interest-tracking hiccup fail the comment itself.
    trackActivity({
        username,
        activityType: 'comment',
        post,
        targetType: 'Comment',
        targetId: comment._id,
    }).catch(() => {});

    const [enriched] = await enrichWithAuthorAndLike([comment.toObject()], username, 'Comment');
    return { comment: enriched, commentsCount: post.commentsCount };
}

async function editComment(commentId, myUsername, content) {
    assertValidId(commentId, 'comment id');
    const trimmed = assertContent(content, 'Comment');

    const comment = await Comment.findOne({ _id: commentId, isDeleted: false });
    if (!comment) throw makeError(404, 'Comment not found');
    if (comment.username !== myUsername) throw makeError(403, 'You can only edit your own comments');

    comment.content = trimmed;
    comment.isEdited = true;
    await comment.save();

    const [enriched] = await enrichWithAuthorAndLike([comment.toObject()], myUsername, 'Comment');
    return enriched;
}

async function deleteComment(commentId, myUsername) {
    assertValidId(commentId, 'comment id');

    const comment = await Comment.findOne({ _id: commentId, isDeleted: false });
    if (!comment) throw makeError(404, 'Comment not found');
    if (comment.username !== myUsername) throw makeError(403, 'You can only delete your own comments');

    comment.isDeleted = true;
    await comment.save();

    // Ranking signal in reverse — a deleted comment's weight comes back out
    // of the post's engagementScore on the next fetch.
    const updatedPost = await Post.findOneAndUpdate(
        { _id: comment.post, commentsCount: { $gt: 0 } },
        { $inc: { commentsCount: -1 } },
        { new: true }
    );

    return { commentId: comment._id, commentsCount: updatedPost?.commentsCount ?? 0 };
}

// Like-only toggle — there is no dislike/downvote path. A second call from
// the same user un-likes; it never flips to a negative state.
async function toggleCommentLike(commentId, myUsername) {
    assertValidId(commentId, 'comment id');

    const comment = await Comment.findOne({ _id: commentId, isDeleted: false });
    if (!comment) throw makeError(404, 'Comment not found');

    const existing = await Like.findOne({ username: myUsername, targetType: 'Comment', targetId: commentId });

    if (existing) {
        await Like.deleteOne({ _id: existing._id });
        comment.likesCount = Math.max(0, comment.likesCount - 1);
        await comment.save();
        return { liked: false, likesCount: comment.likesCount };
    }

    try {
        await Like.create({ username: myUsername, targetType: 'Comment', targetId: commentId });
    } catch (dupErr) {
        if (dupErr.code === 11000) throw makeError(409, 'Already liked');
        throw dupErr;
    }

    comment.likesCount += 1;
    await comment.save();
    return { liked: true, likesCount: comment.likesCount };
}

/* ============================================================================
 * REPLIES — one level deep (Reply already points at both `comment` and
 * `post` in the schema, so no thread-walking is needed to reply to a reply;
 * this deliberately doesn't support that, same as most feed UIs collapse
 * everything under the comment).
 * ==========================================================================*/

// Oldest first within a thread — reads top-to-bottom like a conversation,
// unlike the comments list itself which is newest-first.
async function getReplies(commentId, myUsername, { page = 1, pageSize = DEFAULT_PAGE_SIZE } = {}) {
    assertValidId(commentId, 'comment id');
    const safePage = Math.max(1, page);
    const skip = (safePage - 1) * pageSize;

    const rawReplies = await Reply.find({ comment: commentId, isDeleted: false })
        .sort({ createdAt: 1 })
        .skip(skip)
        .limit(pageSize)
        .lean();

    const hasMore = rawReplies.length === pageSize;
    const replies = await enrichWithAuthorAndLike(rawReplies, myUsername, 'Reply');

    return { replies, page: safePage, hasMore };
}

async function createReply(commentId, username, content) {
    assertValidId(commentId, 'comment id');
    const trimmed = assertContent(content, 'Reply');

    const comment = await Comment.findOne({ _id: commentId, isDeleted: false });
    if (!comment) throw makeError(404, 'Comment not found');

    const reply = await Reply.create({
        comment: commentId,
        post: comment.post,
        username,
        content: trimmed,
    });

    comment.repliesCount += 1;
    await comment.save();

    // RANKING SIGNAL #2 (replies) — needs the parent post's hashtags, which
    // Reply itself doesn't carry, so it's a small lean fetch rather than
    // reusing `comment` directly.
    Post.findById(comment.post).select('hashtags').lean()
        .then(parentPost => trackActivity({
            username,
            activityType: 'comment',
            post: parentPost,
            targetType: 'Reply',
            targetId: reply._id,
        }))
        .catch(() => {});

    const [enriched] = await enrichWithAuthorAndLike([reply.toObject()], username, 'Reply');
    return { reply: enriched, repliesCount: comment.repliesCount };
}

async function editReply(replyId, myUsername, content) {
    assertValidId(replyId, 'reply id');
    const trimmed = assertContent(content, 'Reply');

    const reply = await Reply.findOne({ _id: replyId, isDeleted: false });
    if (!reply) throw makeError(404, 'Reply not found');
    if (reply.username !== myUsername) throw makeError(403, 'You can only edit your own replies');

    reply.content = trimmed;
    reply.isEdited = true;
    await reply.save();

    const [enriched] = await enrichWithAuthorAndLike([reply.toObject()], myUsername, 'Reply');
    return enriched;
}

async function deleteReply(replyId, myUsername) {
    assertValidId(replyId, 'reply id');

    const reply = await Reply.findOne({ _id: replyId, isDeleted: false });
    if (!reply) throw makeError(404, 'Reply not found');
    if (reply.username !== myUsername) throw makeError(403, 'You can only delete your own replies');

    reply.isDeleted = true;
    await reply.save();

    const updatedComment = await Comment.findOneAndUpdate(
        { _id: reply.comment, repliesCount: { $gt: 0 } },
        { $inc: { repliesCount: -1 } },
        { new: true }
    );

    return { replyId: reply._id, repliesCount: updatedComment?.repliesCount ?? 0 };
}

// Like-only toggle — same as toggleCommentLike, no dislike path.
async function toggleReplyLike(replyId, myUsername) {
    assertValidId(replyId, 'reply id');

    const reply = await Reply.findOne({ _id: replyId, isDeleted: false });
    if (!reply) throw makeError(404, 'Reply not found');

    const existing = await Like.findOne({ username: myUsername, targetType: 'Reply', targetId: replyId });

    if (existing) {
        await Like.deleteOne({ _id: existing._id });
        reply.likesCount = Math.max(0, reply.likesCount - 1);
        await reply.save();
        return { liked: false, likesCount: reply.likesCount };
    }

    try {
        await Like.create({ username: myUsername, targetType: 'Reply', targetId: replyId });
    } catch (dupErr) {
        if (dupErr.code === 11000) throw makeError(409, 'Already liked');
        throw dupErr;
    }

    reply.likesCount += 1;
    await reply.save();
    return { liked: true, likesCount: reply.likesCount };
}

module.exports = {
    getComments,
    createComment,
    editComment,
    deleteComment,
    toggleCommentLike,
    getReplies,
    createReply,
    editReply,
    deleteReply,
    toggleReplyLike,
};