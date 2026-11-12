/* ============================================================================
 *  Social_Platform/services/notificationService.js
 * ----------------------------------------------------------------------------
 *  PHASE 11 Part 2 — this is now the ONLY place a Notification row gets
 *  created. Every handler (like/comment/reply/follow) calls into here
 *  instead of writing to the Notification collection directly, so read
 *  (getNotifications/getUnreadCount) and write stay in one file.
 *
 *  pushAndPersist() does both halves of "notification": writes the durable
 *  row (so /notifications and the unread badge survive a refresh/offline
 *  period) AND pushes a live WS event (so it's instant if the recipient is
 *  connected right now). Self-notifications are always dropped here, in
 *  one place, rather than re-checked in every caller.
 * ==========================================================================*/

const { SocialProfile, Notification, Follow } = require('../../../Databases/MongoDB/social_models');
const websocketService = require('../../../Web_Sockets/websocketService'); // adjust if your root differs
const { SOCIAL_EVENTS, NOTIFICATION_TYPES } = require('../../constants/events');
const { getAuthors } = require('./authorService');

const MENTION_REGEX = /@([a-zA-Z0-9_]{1,30})/g;

function extractMentionedUsernames(content) {
    if (!content) return [];
    const matches = [...content.matchAll(MENTION_REGEX)].map(m => m[1]);
    return [...new Set(matches)];
}

/* ============================================================================
 * CORE WRITE PATH
 * ==========================================================================*/
async function pushAndPersist({ recipientUsername, actorUsername, type, targetType = null, targetId = null }) {
    if (!recipientUsername || recipientUsername === actorUsername) return null; // never notify yourself

    const doc = await Notification.create({
        recipientUsername,
        actorUsername,
        type,
        targetType,
        targetId,
    });

    websocketService.sendToUser(recipientUsername, {
        event: SOCIAL_EVENTS.NOTIFICATION,
        data: {
            _id: doc._id,
            type: doc.type,
            actorUsername: doc.actorUsername,
            targetType: doc.targetType,
            targetId: doc.targetId,
            isRead: doc.isRead,
            createdAt: doc.createdAt,
        },
    });

    return doc;
}

/* ============================================================================
 * PER-EVENT ENTRY POINTS — called by the socket handlers
 * ==========================================================================*/
function notifyLike({ post, actorUsername }) {
    return pushAndPersist({
        recipientUsername: post.username,
        actorUsername,
        type: NOTIFICATION_TYPES.LIKE,
        targetType: 'Post',
        targetId: post._id,
    });
}

function notifyComment({ post, actorUsername }) {
    return pushAndPersist({
        recipientUsername: post.username,
        actorUsername,
        type: NOTIFICATION_TYPES.COMMENT,
        targetType: 'Post',
        targetId: post._id,
    });
}

function notifyReply({ postId, commentOwnerUsername, actorUsername }) {
    return pushAndPersist({
        recipientUsername: commentOwnerUsername,
        actorUsername,
        type: NOTIFICATION_TYPES.REPLY,
        targetType: 'Post',
        targetId: postId,
    });
}

function notifyFollow({ followingUsername, actorUsername }) {
    return pushAndPersist({
        recipientUsername: followingUsername,
        actorUsername,
        type: NOTIFICATION_TYPES.FOLLOW,
        targetType: null,
        targetId: null,
    });
}

// Mentions — unchanged behavior, now routed through pushAndPersist so a
// mention also gets a live push instead of only a silent DB row.
async function createNotifications({ post, authorUsername }) {
    const mentioned = extractMentionedUsernames(post?.content)
        .filter(u => u.toLowerCase() !== authorUsername.toLowerCase());

    if (!mentioned.length) return;

    const existingProfiles = await SocialProfile.find(
        { username: { $in: mentioned } },
        'username'
    ).lean();

    await Promise.all(existingProfiles.map(p =>
        pushAndPersist({
            recipientUsername: p.username,
            actorUsername,
            type: NOTIFICATION_TYPES.MENTION,
            targetType: 'Post',
            targetId: post._id,
        }).catch(err => console.error('⚠️ mention notification error:', err))
    ));
}

// New-post fan-out — deliberately NOT a persisted Notification (that would
// be one row per follower per post, same fan-out cost your file header
// already flagged as a "design pass later"). It's just a live "new_post"
// ping so a connected follower's feed can show the existing new-posts
// banner sooner. Nothing to show on /notifications for this one.
async function notifyNewPostToFollowers({ post, authorUsername }) {
    const followers = await Follow.find({ followingUsername: authorUsername })
        .select('followerUsername')
        .lean();

    followers.forEach(f => {
        websocketService.sendToUser(f.followerUsername, {
            event: SOCIAL_EVENTS.NEW_POST,
            data: { postId: post._id, authorUsername },
        });
    });
}

/* ============================================================================
 * READ PATH — powers notifications.html + the sidebar bell badge
 * ==========================================================================*/
async function getNotifications(username, { page = 1, pageSize = 20 } = {}) {
    const safePage = Math.max(1, page);
    const skip = (safePage - 1) * pageSize;

    const rows = await Notification.find({ recipientUsername: username })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean();

    const hasMore = rows.length === pageSize;

    const actorUsernames = [...new Set(rows.map(r => r.actorUsername))];
    const authorMap = await getAuthors(actorUsernames, 'username displayName avatarUrl');

    const notifications = rows.map(r => {
        const author = authorMap.get(r.actorUsername);
        return {
            ...r,
            actor: {
                displayName: author?.displayName || r.actorUsername,
                avatarUrl: author?.avatarUrl || '',
            },
        };
    });

    return { notifications, page: safePage, hasMore };
}

async function getUnreadCount(username) {
    return Notification.countDocuments({ recipientUsername: username, isRead: false });
}

async function markAsRead(notificationId, username) {
    await Notification.updateOne(
        { _id: notificationId, recipientUsername: username },
        { $set: { isRead: true } }
    );
}

async function markAllAsRead(username) {
    await Notification.updateMany(
        { recipientUsername: username, isRead: false },
        { $set: { isRead: true } }
    );
}

module.exports = {
    extractMentionedUsernames,
    createNotifications,
    notifyLike,
    notifyComment,
    notifyReply,
    notifyFollow,
    notifyNewPostToFollowers,
    getNotifications,
    getUnreadCount,
    markAsRead,
    markAllAsRead,
};