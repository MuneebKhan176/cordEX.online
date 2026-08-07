/* ============================================================================
 *  Social_Platform/services/Feed_Engine/recommendationService.js
 * ----------------------------------------------------------------------------
 *  PHASE 7 — owns "what tends to appear alongside what". Every time a post
 *  goes up, we bump a co-occurrence count for every pair of hashtags on it
 *  (e.g. a post tagged #btc #trading nudges the btc<->trading pair). This
 *  is the seed for a future "related hashtags" / "you might also like"
 *  feature — deliberately simple in-memory storage for now, same pattern as
 *  cache/profileCache.js (Phase 4): plain Node Map, no Redis, no new Mongo
 *  collection, easy to swap out later once the shape of "recommendations"
 *  is nailed down.
 *
 *  PHASE 10.3 — the read side. Until now this file was write-only: every
 *  post creation fed the co-occurrence map (updateRecommendations), but
 *  nothing ever read it back during feed serving. applyRecommendationBoost()
 *  closes that loop: given a viewer's interestMap (Phase 9, from
 *  interestTracker.js) and an already-ranked list of posts, it finds
 *  hashtags that frequently co-occur with the viewer's top interests and
 *  gives a small nudge to posts carrying those "adjacent" tags — even if
 *  the viewer has never directly interacted with that exact hashtag. This
 *  is what lets someone who's shown interest in #btc start surfacing
 *  #trading posts without #trading needing its own tracked interest score.
 *
 *  Called from services/feedService.js, AFTER feedRanking.rankPosts() and
 *  BEFORE pagination — a boost applied after the page is already sliced
 *  can't change which posts appear, only reorder ones already chosen, so
 *  it has to sit inside the ranking step, not after it.
 * ==========================================================================*/

// "tagA|tagB" (sorted so order doesn't matter) -> count
const cooccurrenceMap = new Map();

function pairKey(tagA, tagB) {
    return [tagA, tagB].sort().join('|');
}

// Bumps the co-occurrence score for every unique pair of hashtags on this
// post. A post with 1 or 0 hashtags has no pairs, so it's a no-op.
async function updateRecommendations(hashtags) {
    if (!hashtags || hashtags.length < 2) return;

    for (let i = 0; i < hashtags.length; i++) {
        for (let j = i + 1; j < hashtags.length; j++) {
            const key = pairKey(hashtags[i], hashtags[j]);
            cooccurrenceMap.set(key, (cooccurrenceMap.get(key) || 0) + 1);
        }
    }
}

// Returns the top-N hashtags most often seen alongside `tag`, sorted by
// co-occurrence count descending.
function getRelatedHashtags(tag, limit = 5) {
    const scored = [];

    for (const [key, count] of cooccurrenceMap.entries()) {
        const [a, b] = key.split('|');
        if (a === tag) scored.push({ tag: b, count });
        else if (b === tag) scored.push({ tag: a, count });
    }

    return scored
        .sort((x, y) => y.count - x.count)
        .slice(0, limit)
        .map(s => s.tag);
}

// Pulls the viewer's N highest-scored hashtags out of their interestMap
// (same Map<hashtag, score> shape interestTracker.getInterestMap() returns).
function getTopInterestTags(interestMap, limit = 5) {
    if (!interestMap || !interestMap.size) return [];
    return [...interestMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([tag]) => tag);
}

/* ============================================================================
 * PHASE 10.3 — applies a small score nudge to posts whose hashtags are
 * "adjacent" to the viewer's top tracked interests (per the co-occurrence
 * map above), without needing the viewer to have interacted with that
 * exact tag before.
 * ----------------------------------------------------------------------------
 * rankedPosts     -> output of feedRanking.rankPosts() — each post already
 *                     carries a numeric `_score` field to nudge
 * interestMap     -> Map<hashtag, score> for the viewer (from
 *                     interestTracker.getInterestMap())
 * relatedPerTag   -> how many related tags to pull per top interest tag
 * boostPerMatch   -> score added per matching related hashtag on a post
 * maxBoost        -> cap so one heavily-tagged post can't run away with it
 *
 * Deliberately conservative: with an empty/cold co-occurrence map (e.g.
 * right after deploy, before enough posts exist to build real
 * relationships) this is a full no-op and ranking behaves exactly as
 * Phase 9/10.2 already did — the boost only ever adds on top of the
 * existing score, never replaces or reorders independently of it.
 * ==========================================================================*/
function applyRecommendationBoost(
    rankedPosts,
    { interestMap = null, relatedPerTag = 5, boostPerMatch = 0.03, maxBoost = 0.15 } = {}
) {
    const topTags = getTopInterestTags(interestMap, 5);
    if (!topTags.length) return rankedPosts;

    const relatedSet = new Set();
    topTags.forEach(tag => getRelatedHashtags(tag, relatedPerTag).forEach(t => relatedSet.add(t)));
    if (!relatedSet.size) return rankedPosts;

    let touched = false;
    const boosted = rankedPosts.map(post => {
        const matches = (post.hashtags || []).filter(t => relatedSet.has(t)).length;
        if (!matches) return post;

        touched = true;
        const boost = Math.min(maxBoost, matches * boostPerMatch);
        return { ...post, _score: (post._score || 0) + boost };
    });

    // Only re-sort if something actually changed — avoids a wasted sort on
    // the (common, cheap-to-detect) no-match case.
    if (!touched) return rankedPosts;

    return boosted.sort((a, b) => b._score - a._score || String(b._id).localeCompare(String(a._id)));
}

module.exports = {
    updateRecommendations,
    getRelatedHashtags,
    getTopInterestTags,
    applyRecommendationBoost,
};