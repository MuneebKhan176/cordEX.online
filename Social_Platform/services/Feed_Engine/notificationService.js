/* ============================================================================
 *  Social_Platform/services/notificationService.js
 * ----------------------------------------------------------------------------
 *  PHASE 7 — owns "who needs to be told about this new post". For now that
 *  means @mention notifications: if the composer text contains @someone and
 *  that user exists, they get a Notification row (type: "mention"), same as
 *  the existing Notification schema already supports. Self-mentions are
 *  skipped, duplicate mentions of the same user in one post are collapsed
 *  to a single notification.
 * ----------------------------------------------------------------------------
 *  Kept deliberately narrow — broadcasting to every follower on every post
 *  would flood Notification with one row per follower per post, which is a
 *  fan-out problem worth its own design pass later. Mentions are a small,
 *  bounded, clearly-intentional signal, so they're safe to do inline here.
 * ==========================================================================*/

const { SocialProfile, Notification } = require('../../social_models');

const MENTION_REGEX = /@([a-zA-Z0-9_]{1,30})/g;

// Pulls unique, lowercase-normalized @mentions out of post content.
function extractMentionedUsernames(content) {
    if (!content) return [];
    const matches = [...content.matchAll(MENTION_REGEX)].map(m => m[1]);
    return [...new Set(matches)];
}

// Creates one "mention" Notification per real, distinct user mentioned in
// the post (excluding the author mentioning themselves). Silently skips
// usernames that don't correspond to a real profile.
async function createNotifications({ post, authorUsername }) {
    const mentioned = extractMentionedUsernames(post?.content)
        .filter(u => u.toLowerCase() !== authorUsername.toLowerCase());

    if (!mentioned.length) return;

    const existingProfiles = await SocialProfile.find(
        { username: { $in: mentioned } },
        'username'
    ).lean();

    if (!existingProfiles.length) return;

    const notifications = existingProfiles.map(p => ({
        recipientUsername: p.username,
        actorUsername: authorUsername,
        type: 'mention',
        targetType: 'Post',
        targetId: post._id,
    }));

    await Notification.insertMany(notifications, { ordered: false }).catch(err =>
        console.error('⚠️ createNotifications insertMany error:', err)
    );
}

module.exports = { createNotifications, extractMentionedUsernames };