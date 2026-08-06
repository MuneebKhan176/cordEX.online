/* ============================================================================
 *  Social_Platform/services/feedRanking.js
 * ----------------------------------------------------------------------------
 *  PHASE 9 — replaces the old "followers + time" score with:
 *
 *      score = (friendship  × 0.35)
 *            + (interest    × 0.25)
 *            + (engagement  × 0.25)
 *            + (recency     × 0.15)
 *
 *  Each factor is normalized to roughly a 0–1 range before weighting, so no
 *  single term dominates just because its raw units happen to be bigger
 *  (e.g. raw view counts vs. a 0/0.5/1 friendship flag). Tune weights or
 *  normalization curves in exactly one place.
 *
 *  PHASE 10.2 — this file is now the "Ranking Engine" layer in the feed
 *  pipeline. calculateScore() (below) still answers "what's the score for
 *  ONE post" exactly as it did in Phase 9. rankPosts() is new: it's the
 *  batch entry point services/feedService.js calls to turn a pool of
 *  candidate posts + viewer context into a sorted list, so feedService no
 *  longer does its own .map(score).sort() inline.
 *
 *  PHASE 11 — COMMENTS WIRING (no formula change, two existing hooks now
 *  actually get fed):
 *
 *    1. engagementScore() below already weighted post.commentsCount ×3
 *      (second only to shares ×4) — that field is written directly by
 *      services/commentService.js the moment a comment or reply is
 *      created/deleted, so every comment nudges a post's engagement term
 *      on the very next feed fetch. Nothing in this file had to change for
 *      that half to work; it just needed a real writer, which it now has.
 *
 *    2. interestScore() below reads the viewer's Map<hashtag, score> from
 *      interestTracker.getInterestMap(). commentService.js now calls
 *      interestTracker.trackActivity({ activityType: 'comment', ... }) on
 *      every comment/reply, scored against the hashtags of the post being
 *      commented on — so a user who frequently comments on #btc posts will
 *      see their interestScore for #btc rise, which raises rankPosts()'s
 *      output for future #btc posts. See interestTracker.js PHASE 11 for
 *      the weight (40, between watch_video and view_crypto/btc/eth).
 *
 *  Consumed by:
 *    - Social_Platform/services/feedService.js  -> rankPosts()
 *
 *  This file replaces the old services/feedScore.js. If anything else in
 *  the codebase still imports feedScore.js, repoint it here.
 * ==========================================================================*/

const MS_PER_HOUR = 1000 * 60 * 60;
const DECAY_HOURS = 48; // recency half-life-ish — tune here

// Hours since the post was created (never negative, even with clock skew).
function getAgeHours(post) {
    const createdAt = post.createdAt ? new Date(post.createdAt) : new Date();
    return Math.max(0, (Date.now() - createdAt.getTime()) / MS_PER_HOUR);
}

// 0–1, exponential decay — a post drops to ~37% of its recency score after
// DECAY_HOURS, and keeps fading smoothly rather than falling off a cliff.
function recencyScore(post) {
    return Math.exp(-getAgeHours(post) / DECAY_HOURS);
}

// 0–1-ish, log-scaled raw engagement so a viral post doesn't blow the scale
// out relative to everything else. Facebook-style priority baked into the
// per-signal multipliers: shares > comments > saves > likes, with
// views/clicks/watch-time as weak supporting signals.
//
// PHASE 11 — post.commentsCount here is the same field
// services/commentService.js increments/decrements on every comment/reply
// create/delete, so this term is live the moment someone comments.
function engagementScore(post) {
    const raw =
        (post.sharesCount || 0) * 4 +
        (post.commentsCount || 0) * 3 +
        (post.saveCount || 0) * 2 +
        (post.likesCount || 0) * 1 +
        (post.viewsCount || 0) * 0.1 +
        (post.clickCount || 0) * 0.1 +
        (post.watchSeconds || 0) * 0.02;
    return Math.log10(raw + 1) / 4; // /4 roughly caps typical posts near 1
}

// 0–1-ish, sum of the viewer's interest score (from UserInterest, built by
// interestTracker.js) across this post's hashtags, log-squashed so a single
// hyper-engaged tag doesn't dominate the whole term.
//
// PHASE 11 — UserInterest rows now also get bumped by comment/reply
// creation (interestTracker.js activityType: 'comment'), not just views —
// so this term reflects commenting behavior too, not just passive viewing.
function interestScore(post, interestMap) {
    if (!interestMap || !interestMap.size || !post.hashtags?.length) return 0;
    const raw = post.hashtags.reduce((sum, tag) => sum + (interestMap.get(tag) || 0), 0);
    return Math.log10(raw + 1) / 3;
}

// 0 / 0.5 / 1 — pulled from friendshipService.getFriendshipMap():
// mutual follow = 1, one-way follow (either direction) = 0.5, none = 0.
function friendshipScoreFor(post, friendshipMap) {
    return friendshipMap?.get(post.username) || 0;
}

// post           -> plain post object with sharesCount/commentsCount/saveCount/
//                    likesCount/viewsCount/clickCount/watchSeconds/createdAt/hashtags/username
// author         -> plain author object (kept for signature compatibility with
//                    existing callers; not used directly in the Phase 9 formula
//                    since friendship now carries the "who you know" signal)
// interestMap    -> optional Map<hashtag, score> for the viewer
// friendshipMap  -> optional Map<username, 0|0.5|1> for the viewer
function calculateScore(post, author, interestMap = null, friendshipMap = null) {
    const friendship = friendshipScoreFor(post, friendshipMap);
    const interest = interestScore(post, interestMap);
    const engagement = engagementScore(post);
    const recency = recencyScore(post);

    return (
        friendship * 0.35 +
        interest * 0.25 +
        engagement * 0.25 +
        recency * 0.15
    );
}

/* ============================================================================
 * PHASE 10.2 — RANKING ENGINE ENTRY POINT
 * ----------------------------------------------------------------------------
 * Everything above this point answers "what's the score for ONE post".
 * rankPosts() is the batch entry point that answers "given a pool of
 * candidate posts and this viewer's context, what order should they be
 * shown in" — this is the piece feedService.js now delegates to instead
 * of running its own .map(calculateScore).sort() inline, so the pipeline
 * reads as a clean:
 *
 *      feedService (fetch candidates + context)
 *        -> feedRanking.rankPosts (score + sort)
 *        -> feedService (paginate)
 *        -> route (enrich + respond)
 *
 * posts                  -> array of plain post objects (candidates to rank)
 * context.authorMap      -> Map<username, authorProfile> (kept for signature
 *                            symmetry with calculateScore; not used directly
 *                            in the Phase 9 formula, see friendshipScoreFor)
 * context.interestMap    -> Map<hashtag, score> for the viewer
 * context.friendshipMap  -> Map<username, 0|0.5|1> for the viewer
 *
 * Returns posts in ranked order, each with a `_score` field attached for
 * debugging/observability (e.g. logging why post X outranked post Y).
 * Callers that don't want it in the API response can strip it during
 * enrichment/serialization — it's never persisted to Mongo. Ties break on
 * _id descending (newest wins), matching the pre-10.2 inline sort exactly.
 * ==========================================================================*/
function rankPosts(posts, { authorMap = null, interestMap = null, friendshipMap = null } = {}) {
    return posts
        .map(post => ({
            ...post,
            _score: calculateScore(post, authorMap?.get(post.username), interestMap, friendshipMap),
        }))
        .sort((a, b) => b._score - a._score || String(b._id).localeCompare(String(a._id)));
}

module.exports = {
    calculateScore,
    rankPosts,
    getAgeHours,
    recencyScore,
    engagementScore,
    interestScore,
    friendshipScoreFor,
};