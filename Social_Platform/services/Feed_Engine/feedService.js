/* ============================================================================
 *  Social_Platform/services/Feed_Engine/feedService.js
 * ----------------------------------------------------------------------------
 *  PHASE 10.1 — Feed Service Layer
 *
 *  Before this file, insights.js and posts.js each ran their own copy of
 *  the "build candidates -> score -> sort -> paginate" pipeline directly
 *  inside the route handler (and the two copies had already started to
 *  drift — different PAGE_SIZE, insights.js missing the ?hashtag filter,
 *  etc). This file is the single place that logic lives now:
 *
 *      Route -> feedService -> MongoDB (+ ranking/friendship/interest
 *               helpers already built in Phase 9) -> Return
 *
 *  PHASE 10.2 — Ranking Engine
 *
 *  feedService used to score and sort candidates itself, inline
 *  (.map(calculateScore).sort(...)). That job now belongs to
 *  feedRanking.rankPosts().
 *
 *  PHASE 10.3 — Recommendations + Enrichment
 *
 *  Two additions to getDiscoverFeed():
 *
 *   1. Recommendations — after rankPosts() but BEFORE pagination,
 *      recommendationService.applyRecommendationBoost() nudges scores
 *      toward posts whose hashtags co-occur with the viewer's tracked
 *      interests. It has to run before the page is sliced — a boost
 *      applied after pagination can only reorder posts already chosen,
 *      it can't change which ones make the page, which defeats the point.
 *
 *   2. Enrichment — every fetch function now takes an optional `enrich`
 *      callback. Routes pass in whichever enrichment helper they already
 *      use (enrichSquarePosts in insights.js, enrichPostsForFeed in
 *      posts.js) and feedService calls it as the final pipeline step, so
 *      the route body itself no longer orchestrates "fetch, then
 *      enrich" — it just describes what it wants and hands off.
 *
 *  Full pipeline for the ranked feed:
 *
 *      Route -> feedService (fetch candidates + viewer context)
 *                 -> feedRanking.rankPosts        (Phase 10.2 — score + sort)
 *                 -> recommendationService.boost   (Phase 10.3 — nudge + re-sort)
 *                 -> feedService                   (paginate, strip _score)
 *                 -> enrich(posts)                 (Phase 10.3 — caller-supplied)
 *                 -> Return
 *
 *  getInterestMap(), getFriendshipMap(), and getManyProfiles() are still
 *  the same Phase 9 building blocks — only orchestration moved. Routes
 *  remain responsible for auth (verifyToken), response shape
 *  (sendResponse), and the enrichment implementation itself — this file
 *  just decides *when* enrichment runs in the pipeline, not *how*.
 * ==========================================================================*/

const { SocialProfile, Post, Follow } = require('../../social_models');
const { rankPosts } = require('./feedRanking'); // PHASE 10.2
const { applyRecommendationBoost } = require('./recommendationService'); // PHASE 10.3
const { getInterestMap } = require('./interestTracker');
const { getFriendshipMap } = require('./friendshipService');
const { getManyProfiles } = require('../../cache/profileCache');

const DEFAULT_PAGE_SIZE = 10;

// Runs the caller-supplied enrichment callback if one was given, otherwise
// passes posts through untouched. Kept as a tiny shared helper so every
// fetch function below treats `enrich` the same way.
async function maybeEnrich(posts, myUsername, enrich) {
    return enrich ? enrich(posts, myUsername) : posts;
}

/* ============================================================================
 * DISCOVER — ranked feed (Phase 9 formula, Phase 10.2 ranking engine,
 * Phase 10.3 recommendation boost + enrichment), paginated
 * ----------------------------------------------------------------------------
 * options:
 *   page      (1-based, default 1)
 *   pageSize  (default 10)
 *   hashtag   (optional, already-normalized lowercase tag with no '#')
 *   enrich    (optional async (posts, myUsername) => enrichedPosts)
 *
 * Returns { posts, page, hasMore }. If `enrich` isn't passed, `posts` are
 * plain lean objects — callers that still want to enrich separately can.
 * ==========================================================================*/
async function getDiscoverFeed(myUsername, { page = 1, pageSize = DEFAULT_PAGE_SIZE, hashtag = null, enrich = null } = {}) {
    const safePage = Math.max(1, page);
    const skip = (safePage - 1) * pageSize;

    const baseMatch = { isDeleted: false };
    if (hashtag) baseMatch.hashtags = hashtag;

    const candidatePosts = await Post.find(baseMatch).lean();

    const usernames = [...new Set(candidatePosts.map(p => p.username))];
    const [authorMap, interestMap, friendshipMap] = await Promise.all([
        getManyProfiles(usernames, SocialProfile, 'username followersCount'),
        getInterestMap(myUsername),
        getFriendshipMap(myUsername, usernames),
    ]);

    let ranked = rankPosts(candidatePosts, { authorMap, interestMap, friendshipMap });
    ranked = applyRecommendationBoost(ranked, { interestMap }); // PHASE 10.3

    // _score is a ranking-engine debug field — strip it here so it never
    // accidentally leaks into an API response.
    const pagePosts = ranked.slice(skip, skip + pageSize).map(({ _score, ...post }) => post);
    const hasMore = skip + pageSize < ranked.length;

    const posts = await maybeEnrich(pagePosts, myUsername, enrich);

    return { posts, page: safePage, hasMore };
}

/* ============================================================================
 * DISCOVER — "what's new since I last looked" (used by ?after=... polling)
 * ----------------------------------------------------------------------------
 * Deliberately NOT re-ranked/boosted — this is a small, time-ordered top-up
 * list, same behavior as the original inline route code. Still supports
 * `enrich` so callers don't have to special-case this path.
 * ==========================================================================*/
async function getDiscoverFeedAfter(afterDate, { limit = 20, hashtag = null, enrich = null, myUsername = null } = {}) {
    const match = { isDeleted: false, createdAt: { $gt: afterDate } };
    if (hashtag) match.hashtags = hashtag;

    const posts = await Post.find(match).sort({ createdAt: -1 }).limit(limit).lean();
    return maybeEnrich(posts, myUsername, enrich);
}

/* ============================================================================
 * FOLLOWING — chronological feed from accounts the viewer follows
 * ----------------------------------------------------------------------------
 * Returns { posts, page, hasMore, followingUsernames }. followingUsernames
 * is included so callers that need it elsewhere (e.g. new-post-count)
 * don't have to re-query Follow themselves.
 * ==========================================================================*/
async function getFollowingFeed(myUsername, { page = 1, pageSize = DEFAULT_PAGE_SIZE, enrich = null } = {}) {
    const followingUsernames = await getFollowingUsernames(myUsername);

    if (!followingUsernames.length) {
        return { posts: [], page: 1, hasMore: false, followingUsernames };
    }

    const safePage = Math.max(1, page);
    const skip = (safePage - 1) * pageSize;

    const rawPosts = await Post.find({ isDeleted: false, username: { $in: followingUsernames } })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean();

    const hasMore = rawPosts.length === pageSize;
    const posts = await maybeEnrich(rawPosts, myUsername, enrich);

    return { posts, page: safePage, hasMore, followingUsernames };
}

/* ============================================================================
 * FOLLOWING — "what's new since I last looked"
 * ==========================================================================*/
async function getFollowingFeedAfter(myUsername, afterDate, { limit = 20, enrich = null } = {}) {
    const followingUsernames = await getFollowingUsernames(myUsername);
    if (!followingUsernames.length) return [];

    const posts = await Post.find({
        isDeleted: false,
        username: { $in: followingUsernames },
        createdAt: { $gt: afterDate },
    })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

    return maybeEnrich(posts, myUsername, enrich);
}

/* ============================================================================
 * NEW-POSTS COUNT — badge/pill counter, discover vs following scoped
 * ==========================================================================*/
async function getNewPostsCount({ since, feed, myUsername }) {
    const match = { isDeleted: false, createdAt: { $gt: since } };

    if (feed === 'following') {
        const followingUsernames = await getFollowingUsernames(myUsername);
        if (!followingUsernames.length) return 0;
        match.username = { $in: followingUsernames };
    }

    return Post.countDocuments(match);
}

/* ============================================================================
 * INTERNAL HELPER — not exported, shared by the following-feed functions
 * above so "who do I follow" isn't queried with three slightly different
 * copies of the same filter.
 * ==========================================================================*/
async function getFollowingUsernames(myUsername) {
    const myFollows = await Follow.find({ followerUsername: myUsername })
        .select('followingUsername')
        .lean();
    return myFollows.map(f => f.followingUsername).filter(u => u !== myUsername);
}

module.exports = {
    getDiscoverFeed,
    getDiscoverFeedAfter,
    getFollowingFeed,
    getFollowingFeedAfter,
    getNewPostsCount,
};