const fs = require('fs');
const path = require('path');

const FAQ_PATH = path.join(__dirname, 'faq.json');

let faqData = [];
try {
  faqData = JSON.parse(fs.readFileSync(FAQ_PATH, 'utf-8'));
} catch (err) {
  console.error('[AI_chatbot] Failed to load faq.json:', err.message);
}

// Lowercase word tokens with a light plural strip ("orders" -> "order").
// Applied identically to queries, keywords and questions, so they stay comparable.
function tokens(text) {
  return (String(text || '').toLowerCase().match(/[a-z0-9]+/g) || []).map((w) =>
    w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w
  );
}

// Padded so a keyword only matches on whole-word boundaries:
// "ai" matches "ask the ai" but not "explain".
function padded(text) {
  const t = tokens(text);
  return t.length ? ` ${t.join(' ')} ` : '';
}

// Precompute normalized keywords/questions once.
const index = faqData.map((entry) => ({
  entry,
  keywords: (entry.keywords || []).map(padded).filter(Boolean),
  question: padded(entry.question),
}));

/**
 * Retrieval seam for the knowledge base. Today: whole-word keyword scoring
 * over faq.json. Later you can swap the body for embeddings/vector search
 * without touching the chatbot, Gemini service, or tool declarations.
 */
function searchKnowledgeBase(query, limit = 4) {
  const q = padded(query);
  if (!q) return [];

  return index
    .map(({ entry, keywords, question }) => {
      let score = 0;
      keywords.forEach((kw) => {
        if (q.includes(kw)) score += 2;
      });
      if (question && q.includes(question)) score += 3;
      return { entry, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => ({ question: s.entry.question, answer: s.entry.answer }));
}

module.exports = { searchKnowledgeBase };