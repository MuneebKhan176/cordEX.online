const express = require('express');
const verifyToken = require('../middle/middleware');
const { getGeminiResponse } = require('./geminiService');
const { checkAnalyticsConnection } = require('./aiTools');

const router = express.Router();

const MAX_MESSAGE_CHARS = 1000;
const MAX_HISTORY_CHARS = 2000;

// Each chat message can trigger several Gemini calls (see MAX_TOOL_ROUNDS in
// geminiService.js), so cap messages per user. In-memory: resets on restart
// and is per-process, which is fine for a single Node instance.
const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_MAX_MESSAGES = 15;
const hits = new Map(); // userId -> [timestamps]

function isRateLimited(userId) {
  const key = String(userId);
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX_MESSAGES) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, stamps] of hits) {
    const recent = stamps.filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length) hits.set(key, recent);
    else hits.delete(key);
  }
}, RATE_WINDOW_MS).unref();

// One-time connectivity report in the Node console a few seconds after boot
// (delay lets the Python service finish starting if both are launched together).
setTimeout(() => {
  console.log('[AI_chatbot] Router loaded: POST /api/ai-chatbot/message (auth required)');
  checkAnalyticsConnection().catch((e) => console.error('[AI_chatbot] connection check crashed:', e.message));
}, 3000).unref();

// History is client-supplied, so treat it as untrusted: text only, bounded.
function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const turns = history
    .filter((t) => t && typeof t.text === 'string' && t.text.trim())
    .slice(-6)
    .map((t) => ({
      role: t.role === 'user' ? 'user' : 'bot',
      text: t.text.slice(0, MAX_HISTORY_CHARS),
    }));
  // Gemini expects the conversation to start with a user turn.
  while (turns.length && turns[0].role !== 'user') turns.shift();
  return turns;
}

async function handleChatMessage(req, res) {
  try {
    // verifyToken already rejected anything without a valid JWT. This is a
    // belt-and-braces check; the id is NEVER read from body/query/history.
    const userId = req.user && req.user.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message:
          "Please sign in to use the assistant. I can't access private account or trading information without valid authentication.",
      });
    }

    const { message, history } = req.body || {};

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ success: false, message: 'Message is required.' });
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      return res.status(400).json({ success: false, message: 'Message is too long.' });
    }

    if (isRateLimited(userId)) {
      return res.status(429).json({
        success: false,
        message: "You're sending messages too quickly. Please wait a few minutes and try again.",
      });
    }

    const reply = await getGeminiResponse({
      message: message.trim(),
      history: sanitizeHistory(history),
      // Raw id exactly as the JWT carried it (same type the live-state layer
      // and WebSocket gateway use). Python-bound calls stringify it themselves.
      userId,
    });

    return res.json({ success: true, reply });
  } catch (err) {
    console.error('[AI_chatbot] handleChatMessage error:', err.message);
    // Graceful fallback so the widget never shows a raw error
    return res.json({
      success: true,
      reply:
        "Sorry, I'm having trouble reaching my knowledge base right now 🤖 — try again in a moment, or check the Support panel.",
      fallback: true,
    });
  }
}

// POST /api/ai-chatbot/message   (requires a valid login cookie / Bearer token)
// body: { message: string, history?: [{role: 'user'|'bot', text: string}] }
router.post('/api/ai-chatbot/message', verifyToken, handleChatMessage);

module.exports = router;