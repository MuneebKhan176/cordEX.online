/* ============================================================================
 *  Social_Platform/services/feedScore.js
 * ----------------------------------------------------------------------------
 *  Centralized feed-ranking formula. Previously this math lived inline
 *  inside the Mongo aggregation pipeline in posts.js (`popularityScore` +
 *  `recencySeconds` -> `feedScore`). Pulled out here so every endpoint that
 *  needs to rank posts — discover today; following, search, hashtag pages,
 *  etc. later — shares one scoring function instead of each re-deriving its
 *  own weighting. Tune the formula in exactly one place.
 * ----------------------------------------------------------------------------
 *  PHASE 2 — engagement ranking weights, Facebook-style priority:
 *    shares > comments > likes
 *  saves/clicks/watch-time are supporting signals layered in below that
 *  core ordering (saves > raw likes since a save is stronger intent than a
 *  tap-like; clicks and watch-seconds are weak/soft signals, so each unit
 *  contributes only a little on its own but adds up for heavily-viewed or
 *  video-heavy posts).
 * ----------------------------------------------------------------------------
 *  PHASE 3 — personalization. calculateScore() now optionally takes the
 *  viewer's interest profile (a Map<hashtag, score> built by
 *  services/interestTracker.js from their UserActivity history) and adds a
 *  bonus for any hashtag on the post the viewer has shown interest in —
 *  e.g. someone who's been viewing "crypto" posts gets crypto-tagged posts
 *  ranked higher than someone who never engages with that tag. This is
 *  what makes two different users see two different discover feeds.
 * ==========================================================================*/

const MS_PER_HOUR = 1000 * 60 * 60;

// Hours since the post was created (never negative, even for clock skew).
function getAgeHours(post) {
    const createdAt = post.createdAt ? new Date(post.createdAt) : new Date();
    return Math.max(0, (Date.now() - createdAt.getTime()) / MS_PER_HOUR);
}

// Sums the viewer's interest score for every hashtag this post carries.
// interestMap -> Map<hashtag, score> from interestTracker.getInterestMap(),
// or null/undefined for an anonymous/un-personalized score (contributes 0).
function getPersonalizationBonus(post, interestMap) {
    if (!interestMap || !interestMap.size || !post.hashtags?.length) return 0;
    return post.hashtags.reduce((sum, tag) => sum + (interestMap.get(tag) || 0), 0);
}

// post        -> plain post object with likesCount / commentsCount / viewsCount /
//                sharesCount / saveCount / clickCount / watchSeconds / createdAt / hashtags
// author      -> plain author object with followersCount (may be null/undefined —
//                e.g. if the author profile lookup missed for some reason)
// interestMap -> optional Map<hashtag, score> for the viewer (see above)
function calculateScore(post, author, interestMap = null) {
    const ageHours = getAgeHours(post);
    const followersCount = author?.followersCount || 0;

    return (
        (post.sharesCount || 0) * 20 +      // highest weight — Facebook prioritizes shares above all
        (post.commentsCount || 0) * 12 +    // second — comments beat plain likes
        (post.saveCount || 0) * 8 +         // saves are strong intent, ranked below comments
        (post.likesCount || 0) * 5 +        // lowest of the core engagement signals
        (post.viewsCount || 0) * 0.3 +
        (post.clickCount || 0) * 0.2 +      // weak/soft signal
        (post.watchSeconds || 0) * 0.05 +   // accumulates for video-heavy posts
        Math.log10(followersCount + 1) * 20 -
        ageHours * 2 +
        getPersonalizationBonus(post, interestMap)
    );
}

module.exports = { calculateScore, getAgeHours, getPersonalizationBonus };