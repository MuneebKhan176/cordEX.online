/* ============================================================================
 *  Social_Platform/socket/handlers/followHandler.js
 * ----------------------------------------------------------------------------
 *  PHASE 11 — PART 1: real-time follows. Deliberately only fires on
 *  follow, not unfollow — "so-and-so unfollowed you" isn't a notification
 *  any social platform surfaces, same reasoning Notification's `type` enum
 *  (like/comment/reply/follow/mention) already only has "follow", not
 *  "unfollow".
 *
 *  PHASE 11 — PART 2: also persists a durable Notification row via
 *  notificationService so a new follower shows up on /notifications, not
 *  just as a live toast.
 * ==========================================================================*/

const { sendToUser, EVENTS } = require('../../../Web_Sockets/websocketService');
const notificationService = require('../../services/Post_Services/notificationService');

function emitNewFollower({ targetUsername, actorUsername, followersCount }) {
    if (!targetUsername || targetUsername === actorUsername) return;

    sendToUser(targetUsername, {
        event: EVENTS.NEW_FOLLOWER,
        data: { actorUsername, followersCount, at: new Date().toISOString() },
    });

    notificationService.notifyFollow({ followingUsername: targetUsername, actorUsername })
        .catch(err => console.error('⚠️ notifyFollow error:', err));
}

module.exports = { emitNewFollower };