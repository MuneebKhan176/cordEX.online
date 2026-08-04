/* ============================================================================
 *  Social_Platform/services/recommendationService.js
 * ----------------------------------------------------------------------------
 *  PHASE 7 — owns "what tends to appear alongside what". Every time a post
 *  goes up, we bump a co-occurrence count for every pair of hashtags on it
 *  (e.g. a post tagged #btc #trading nudges the btc<->trading pair). This
 *  is the seed for a future "related hashtags" / "you might also like"
 *  feature — deliberately simple in-memory storage for now, same pattern as
 *  cache/profileCache.js (Phase 4): plain Node Map, no Redis, no new Mongo
 *  collection, easy to swap out later once the shape of "recommendations"
 *  is nailed down.
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
// co-occurrence count descending. Not wired into any route yet — exposed
// for whichever endpoint eventually wants "related tags" suggestions.
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

module.exports = { updateRecommendations, getRelatedHashtags };