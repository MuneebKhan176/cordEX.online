/* ============================================================================
 *  Social_Platform/socket/handlers/commentHandler.js
 * ----------------------------------------------------------------------------
 *  PHASE 11 — PART 1: real-time comments (and, since replies/comment-likes
 *  live in the same service, those too — keeps every "someone interacted
 *  with your comment thread" event in one file instead of splitting hairs
 *  between comments and replies).
 *
 *  PHASE 11 — PART 2: emitNewComment()/emitNewReply() now also persist a
 *  durable Notification row via notificationService, so "X commented on
 *  your post" / "X replied to your comment" survive a refresh and show up
 *  on /notifications, not just as a live toast if you happened to be
 *  online. emitCommentLiked()/emitReplyLiked() deliberately stay live-only
 *  — see note below.
 * ==========================================================================*/

const { sendToUser, EVENTS } = require('../../../Web_Sockets/websocketService');
const notificationService = require('../../services/Post_Services/notificationService');

// Notify the POST owner that a new top-level comment landed.
function emitNewComment({ postId, postOwnerUsername, comment, commentsCount, actorUsername }) {
    if (!postOwnerUsername || postOwnerUsername === actorUsername) return;

    sendToUser(postOwnerUsername, {
        event: EVENTS.NEW_COMMENT,
        data: {
            postId: String(postId),
            commentId: String(comment._id),
            content: comment.content,
            actorUsername,
            commentsCount,
            at: new Date().toISOString(),
        },
    });

    notificationService.notifyComment({
        post: { _id: postId, username: postOwnerUsername },
        actorUsername,
    }).catch(err => console.error('⚠️ notifyComment error:', err));
}

// A reply can be relevant to two different people — the comment's author
// (someone replied to *you*) and the post's author (activity on *your*
// post) — so this notifies both, deduped, minus the actor themselves.
// Only the comment owner gets a durable Notification row though — the
// post owner already gets the live bump above, and giving them a bell
// entry for every reply on every comment on their post would flood
// /notifications with noise they didn't ask for.
function emitNewReply({ postId, postOwnerUsername, commentId, commentOwnerUsername, reply, repliesCount, actorUsername }) {
    const recipients = new Set(
        [postOwnerUsername, commentOwnerUsername].filter(u => u && u !== actorUsername)
    );

    recipients.forEach((username) => {
        sendToUser(username, {
            event: EVENTS.NEW_REPLY,
            data: {
                postId: String(postId),
                commentId: String(commentId),
                replyId: String(reply._id),
                content: reply.content,
                actorUsername,
                repliesCount,
                at: new Date().toISOString(),
            },
        });
    });

    if (commentOwnerUsername && commentOwnerUsername !== actorUsername) {
        notificationService.notifyReply({ postId, commentOwnerUsername, actorUsername })
            .catch(err => console.error('⚠️ notifyReply error:', err));
    }
}

function emitCommentLiked({ commentId, commentOwnerUsername, actorUsername, liked, likesCount }) {
    if (!commentOwnerUsername || commentOwnerUsername === actorUsername) return;

    sendToUser(commentOwnerUsername, {
        event: EVENTS.COMMENT_LIKED,
        data: { commentId: String(commentId), actorUsername, liked, likesCount, at: new Date().toISOString() },
    });
    // No Notification row — comment/reply likes stay live-only, same
    // bounded-fan-out call notificationService already makes for
    // notifyNewPostToFollowers().
}

function emitReplyLiked({ replyId, replyOwnerUsername, actorUsername, liked, likesCount }) {
    if (!replyOwnerUsername || replyOwnerUsername === actorUsername) return;

    sendToUser(replyOwnerUsername, {
        event: EVENTS.REPLY_LIKED,
        data: { replyId: String(replyId), actorUsername, liked, likesCount, at: new Date().toISOString() },
    });
}

module.exports = { emitNewComment, emitNewReply, emitCommentLiked, emitReplyLiked };