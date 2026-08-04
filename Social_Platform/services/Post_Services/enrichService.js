/* ============================================================================
 *  Social_Platform/services/enrichService.js
 * ----------------------------------------------------------------------------
 *  PHASE 6 — the merge layer. authorService / likeService / followService
 *  each answer one question in parallel; this just stitches their results
 *  onto a list of plain post objects. This replaces the enrichPosts() /
 *  enrichSquarePosts() functions that used to be copy-pasted (with minor
 *  differences) into posts.js and insights.js separately.
 * ----------------------------------------------------------------------------
 *  Both callers need slightly different shapes:
 *    - posts.js wants  author.followersCount + `isFollowingAuthor`
 *    - insights.js wants no followersCount on author + `isFollowing`
 *  Rather than fork the function again, both differences are just options.
 * ==========================================================================*/

const { getAuthors } = require('./authorService');
const { getLikes } = require('./likeService');
const { getFollows } = require('./followService');

/**
 * @param {Array} posts - plain post objects/lean docs to enrich
 * @param {string} myUsername - the viewer
 * @param {Object} [options]
 * @param {string} [options.authorProjection] - Mongo projection string passed to authorService
 * @param {boolean} [options.includeFollowersCount=true] - whether author.followersCount is attached
 * @param {string} [options.followingFieldName='isFollowingAuthor'] - key name for the follow flag
 *   (posts.js uses "isFollowingAuthor", insights.js uses "isFollowing")
 */
async function enrichPosts(posts, myUsername, options = {}) {
    if (!posts.length) return [];

    const {
        authorProjection = 'username displayName avatarUrl followersCount',
        includeFollowersCount = true,
        followingFieldName = 'isFollowingAuthor',
    } = options;

    const usernames = [...new Set(posts.map(p => p.username))];
    const postIds    = posts.map(p => p._id);

    // Three independent lookups, fetched in parallel — none of them
    // depends on another's result.
    const [authorData, followData, likeData] = await Promise.all([
        getAuthors(usernames, authorProjection),
        getFollows(myUsername),
        getLikes(myUsername, postIds),
    ]);

    return posts.map(p => {
        const author = authorData.get(p.username);

        const authorPayload = {
            displayName: author?.displayName || p.username,
            avatarUrl: author?.avatarUrl || '',
        };
        if (includeFollowersCount) {
            authorPayload.followersCount = author?.followersCount || 0;
        }

        return {
            ...p,
            author: authorPayload,
            isSelf: p.username === myUsername,
            [followingFieldName]: followData.has(p.username),
            isLiked: likeData.has(String(p._id)),
        };
    });
}

module.exports = { enrichPosts };