/* ============================================================================
 *  Social_Platform/socket/handlers/likeHandler.js
 * ----------------------------------------------------------------------------
 *  PHASE 11 — PART 1: real-time likes.
 *  Thin wrapper around websocketService.sendToUser() — the only job here
 *  is deciding *who* should hear about a like and *what shape* the payload
 *  takes. Called from the like routes (insights.js / posts.js) right after
 *  the DB write, matching the flow diagram: DB update -> WS server ->
 *  target user.
 *
 *  PHASE 11 — PART 2: also persists a durable Notification row via
 *  notificationService, but only on the "liked" transition — unliking a
 *  post was never a notification on any platform, so there's nothing to
 *  write (or un-write) there.
 * ==========================================================================*/

const { sendToUser, EVENTS } = require('../../../Web_Sockets/websocketService');
const notificationService = require('../../services/Post_Services/notificationService');

// post          -> the Post doc/object that was liked (needs .username, ._id)
// actorUsername -> who clicked like/unlike
// liked         -> true = liked, false = unliked (toggle result)
// likesCount    -> the post's updated like count
function emitPostLiked({ post, actorUsername, liked, likesCount }) {
    if (!post?.username || post.username === actorUsername) return; // no self-notify

    sendToUser(post.username, {
        event: EVENTS.POST_LIKED,
        data: {
            postId: String(post._id),
            actorUsername,
            liked,
            likesCount,
            at: new Date().toISOString(),
        },
    });

    if (liked) {
        notificationService.notifyLike({ post, actorUsername })
            .catch(err => console.error('⚠️ notifyLike error:', err));
    }
}

module.exports = { emitPostLiked };