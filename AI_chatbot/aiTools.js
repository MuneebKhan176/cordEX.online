const path = require('path');

// Same .env geminiService.js uses. Env vars below are read lazily (at call
// time) so load order between modules never matters.
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { searchKnowledgeBase } = require('./knowledgeBase');

const GENERIC_ERROR = 'Unable to retrieve trading data.';

/* ═══════════════════════════════════════════════════════════════════════
   TOOL DECLARATIONS (what Gemini sees)
   No tool has a user_id parameter. Identity is injected by the server
   (ctx.userId, from verifyToken -> req.user.id) and nothing else.
   ═══════════════════════════════════════════════════════════════════════ */
const PERIOD_PROPS = {
  days: { type: 'INTEGER', description: 'Look-back window in days, 1-365. Defaults to 30.' },
  symbol: {
    type: 'STRING',
    description: 'Optional symbol filter, e.g. BTC or BTCUSDT. Omit to include all symbols.',
  },
};
const LIMIT_PROP = {
  limit: { type: 'INTEGER', description: 'Max rows to return, 1-50. Defaults to 20.' },
};

const TOOL_DECLARATIONS = [
  {
    name: 'search_knowledge_base',
    description:
      'Search the platform knowledge base (FAQ) for how-to answers, feature explanations and trading concepts such as OCO orders, stop loss, margin, leverage.',
    parameters: {
      type: 'OBJECT',
      properties: { query: { type: 'STRING', description: 'Short search text.' } },
      required: ['query'],
    },
  },
  {
    name: 'get_futures_performance',
    description:
      "The signed-in user's own historical Futures performance over a period: closed positions, win rate, gross profit/loss, realized PnL, commissions, funding fees, liquidations, per symbol and in total.",
    parameters: { type: 'OBJECT', properties: { ...PERIOD_PROPS } },
  },
  {
    name: 'get_futures_trade_history',
    description: "The signed-in user's own recent Futures fills (most recent first).",
    parameters: { type: 'OBJECT', properties: { ...PERIOD_PROPS, ...LIMIT_PROP } },
  },
  {
    name: 'get_spot_trade_history',
    description: "The signed-in user's own recent Spot trades (most recent first).",
    parameters: { type: 'OBJECT', properties: { ...PERIOD_PROPS, ...LIMIT_PROP } },
  },
  {
    name: 'get_spot_performance',
    description:
      "The signed-in user's own Spot performance over a period: buy/sell counts and volume, plus an ESTIMATED realized profit/loss (average-cost method), per symbol and in total.",
    parameters: { type: 'OBJECT', properties: { ...PERIOD_PROPS } },
  },
  {
    name: 'get_current_futures_positions',
    description:
      "The signed-in user's CURRENT open Futures positions with live data: entry price, quantity, leverage, margin mode, take-profit / stop-loss (null = not set), mark price, unrealized PnL and liquidation price. Use for any question about what the user holds right now, their unrealized PnL, or whether a position has a stop loss or take profit.",
    parameters: {
      type: 'OBJECT',
      properties: {
        symbol: { type: 'STRING', description: 'Optional symbol filter, e.g. BTC or BTCUSDT.' },
      },
    },
  },
  {
    name: 'get_current_futures_wallet',
    description:
      "The signed-in user's CURRENT live Futures wallet: wallet balance, available margin, used margin and margin ratio.",
  },
];

/* ═══════════════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════════════ */
const fail = (error = GENERIC_ERROR) => ({ success: false, error });

// Returns a clean args object containing only whitelisted keys, or null if
// a value is invalid (e.g. a malformed symbol). Gemini's args are untrusted.
function sanitizeArgs(allowed, raw) {
  const out = {};
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const key of allowed) {
    const v = src[key];
    if (v === undefined || v === null || v === '') continue;
    if (key === 'days' || key === 'limit') {
      const n = Math.trunc(Number(v));
      if (!Number.isFinite(n)) continue;
      out[key] = key === 'days' ? Math.min(Math.max(n, 1), 365) : Math.min(Math.max(n, 1), 50);
    } else if (key === 'symbol') {
      const s = String(v).trim().toUpperCase();
      if (!/^[A-Z0-9]{2,20}$/.test(s)) return null;
      out.symbol = s;
    }
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════
   NODE -> PYTHON CONNECTION
   ═══════════════════════════════════════════════════════════════════════ */

// "localhost" can resolve to ::1 first on Node 18+, while uvicorn listens on
// 127.0.0.1 only -> ECONNREFUSED even though the service is running. Always
// talk to 127.0.0.1 instead.
function analyticsBaseUrl() {
  const raw = process.env.AI_ANALYTICS_SERVICE_URL;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.hostname === 'localhost') u.hostname = '127.0.0.1';
    return u.origin;
  } catch (_e) {
    return null;
  }
}

const START_HINT = 'Start it from the repo root with:  python -m ai_analytics';

// Node -> Python (historical / static data). Authenticated with the shared
// internal secret; user_id is the server-verified id, never Gemini's.
async function callAnalytics(name, userId, args) {
  const baseUrl = analyticsBaseUrl();
  const secret = process.env.AI_INTERNAL_SERVICE_SECRET;
  if (!baseUrl || !secret) {
    console.error('[AI_tools] AI_ANALYTICS_SERVICE_URL / AI_INTERNAL_SERVICE_SECRET missing or invalid in routes/.env');
    return fail();
  }

  const started = Date.now();
  let resp;
  try {
    resp = await fetch(`${baseUrl}/v1/tool/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
      body: JSON.stringify({ user_id: String(userId), args }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    // err.cause carries the real reason (ECONNREFUSED, ETIMEDOUT, ...);
    // a bare "fetch failed" hides it.
    const code = err.cause?.code || err.message;
    console.error(`[AI_tools] ✗ analytics service unreachable at ${baseUrl} (${code}) for tool=${name}.`);
    if (code === 'ECONNREFUSED') {
      console.error(`[AI_tools]   Nothing is listening there. ${START_HINT}`);
    }
    return fail();
  }

  if (resp.status === 401) {
    console.error('[AI_tools] ✗ analytics service rejected the secret: AI_INTERNAL_SERVICE_SECRET differs between Node and Python (restart both after editing .env).');
    return fail();
  }
  if (!resp.ok) {
    console.error(`[AI_tools] ✗ analytics service returned HTTP ${resp.status} for tool=${name}`);
    return fail();
  }

  const json = await resp.json();
  if (json && json.success) {
    console.log(`[AI_tools] ✓ tool=${name} user=${userId} answered by analytics service (${Date.now() - started} ms)`);
    return { success: true, data: json.data };
  }
  console.error(`[AI_tools] ✗ tool=${name}: analytics service is up but the query failed — see the PYTHON console for the exact MySQL error.`);
  return fail();
}

/**
 * Startup / on-demand diagnostics. Logs exactly which link is broken:
 *   Node env -> Python service reachable -> secret accepted -> MySQL reachable.
 */
async function checkAnalyticsConnection() {
  const base = analyticsBaseUrl();
  const secret = process.env.AI_INTERNAL_SERVICE_SECRET;
  console.log(`[AI_chatbot] Analytics link: URL=${base || 'NOT SET/INVALID'}  secret=${secret ? 'set' : 'NOT SET'}`);
  if (!base || !secret) {
    console.error('[AI_chatbot] ✗ Set AI_ANALYTICS_SERVICE_URL (e.g. http://127.0.0.1:8001) and AI_INTERNAL_SERVICE_SECRET in routes/.env, then restart Node.');
    return false;
  }

  let health;
  try {
    const resp = await fetch(`${base}/health`, { signal: AbortSignal.timeout(6000) });
    health = resp.ok ? await resp.json().catch(() => ({})) : null;
    if (!resp.ok) {
      console.error(`[AI_chatbot] ✗ ${base}/health returned HTTP ${resp.status} — something else is using this port, or an old analytics build is running.`);
      return false;
    }
  } catch (err) {
    console.error(`[AI_chatbot] ✗ Analytics service UNREACHABLE at ${base} (${err.cause?.code || err.message}). ${START_HINT}`);
    return false;
  }
  console.log('[AI_chatbot] ✓ Analytics service is reachable (Python is running).');

  // Auth probe: dummy id that matches no real user; returns zero rows.
  try {
    const resp = await fetch(`${base}/v1/tool/get_spot_trade_history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
      body: JSON.stringify({ user_id: 'HEALTHCHECK', args: { limit: 1 } }),
      signal: AbortSignal.timeout(6000),
    });
    if (resp.status === 401) {
      console.error('[AI_chatbot] ✗ Secret mismatch: AI_INTERNAL_SERVICE_SECRET is different for Node and Python. Restart both after fixing.');
      return false;
    }
    const json = await resp.json().catch(() => ({}));
    if (resp.ok && json.success) {
      console.log('[AI_chatbot] ✓ Secret accepted and a real read-only query succeeded. RAG data path is WORKING.');
      return true;
    }
  } catch (err) {
    console.error('[AI_chatbot] ✗ Auth probe failed:', err.cause?.code || err.message);
    return false;
  }

  console.error(`[AI_chatbot] ✗ Python is up but cannot read MySQL (health db=${health && health.db}). Look at the PYTHON console for "[DB] ... FAILED" with the exact reason.`);
  return false;
}

function pythonTool(name, allowedArgs) {
  return async (rawArgs, ctx) => {
    const args = sanitizeArgs(allowedArgs, rawArgs);
    if (args === null) return fail('Invalid symbol.');
    return callAnalytics(name, ctx.userId, args);
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   LIVE TOOLS — reuse the existing Node trading/live-state layer
   (Python never sees live state, and nothing is recreated here)
   ═══════════════════════════════════════════════════════════════════════ */

// Static half (MySQL, through the read-only analytics layer) merged with the
// live half (RAM) using the app's own mergeForFrontend() from liveStateStore.
async function getCurrentFuturesPositions(rawArgs, ctx) {
  const args = sanitizeArgs(['symbol'], rawArgs);
  if (args === null) return fail('Invalid symbol.');

  const res = await callAnalytics('get_open_futures_positions', ctx.userId, args);
  if (!res.success) return res;

  let liveStore;
  try {
    // IMPORTANT: this path/casing must match how the rest of the server requires
    // this module, so the SAME in-memory instance (the one whose listeners were
    // attached at startup) is used.
    liveStore = require('../Futures_Engine/liveStateStore');
  } catch (err) {
    console.error('[AI_tools] liveStateStore unavailable:', err.message);
    return fail('Live position data is unavailable right now.');
  }

  const positions = (res.data.positions || []).map((row) => {
    const m = liveStore.mergeForFrontend({ ...row, user_id: String(ctx.userId) });
    return {
      symbol: m.symbol,
      position_side: m.position_side,
      margin_mode: m.margin_mode,
      quantity: m.quantity,
      entry_price: m.entry_price,
      leverage: m.leverage,
      initial_margin: m.initial_margin,
      take_profit: m.take_profit,
      stop_loss: m.stop_loss,
      realized_pnl_so_far: m.realized_pnl,
      mark_price: m.mark_price,
      unrealized_pnl: m.unrealized_pnl,
      liquidation_price: m.liquidation_price,
      live_data_available: m.mark_price !== null && m.mark_price !== undefined,
      opened_at: row.opened_at,
    };
  });

  return {
    success: true,
    data: {
      count: positions.length,
      positions,
      data_notes: [
        'mark_price, unrealized_pnl and liquidation_price are live values; they are null until the engine has sent a price tick for the position. liquidation_price is also null for CROSS margin.',
        'take_profit / stop_loss of null means none is set on the position. They are the values last saved on the position record.',
      ],
    },
  };
}

async function getCurrentFuturesWallet(_rawArgs, ctx) {
  let merge;
  try {
    merge = require('../Futures_Engine/futuresWalletMerge');
  } catch (err) {
    console.error('[AI_tools] futuresWalletMerge unavailable:', err.message);
    return fail('Live wallet data is unavailable right now.');
  }

  const w = await merge.getMergedFuturesWallet(ctx.userId);
  if (!w) return fail('No futures wallet was found for this account.');

  return {
    success: true,
    data: {
      wallet_balance: w.walletBalance,
      available_margin: w.availableMargin,
      used_margin: w.usedMargin,
      margin_ratio: w.marginRatio,
      status: w.status,
      live: !!w.live,
    },
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   DISPATCH — only declared tools are executable
   ═══════════════════════════════════════════════════════════════════════ */
const PRIVATE_HANDLERS = {
  get_futures_performance: pythonTool('get_futures_performance', ['days', 'symbol']),
  get_futures_trade_history: pythonTool('get_futures_trade_history', ['days', 'symbol', 'limit']),
  get_spot_trade_history: pythonTool('get_spot_trade_history', ['days', 'symbol', 'limit']),
  get_spot_performance: pythonTool('get_spot_performance', ['days', 'symbol']),
  get_current_futures_positions: getCurrentFuturesPositions,
  get_current_futures_wallet: getCurrentFuturesWallet,
};

/**
 * ctx.userId MUST come from the server's verified auth context. Gemini's
 * arguments are treated as untrusted and are never used for identity.
 */
async function executeTool(name, rawArgs, ctx) {
  try {
    if (name === 'search_knowledge_base') {
      const query = rawArgs && typeof rawArgs.query === 'string' ? rawArgs.query.slice(0, 300) : '';
      const results = searchKnowledgeBase(query);
      console.log(`[AI_tools] ✓ tool=search_knowledge_base matched ${results.length} FAQ entr${results.length === 1 ? 'y' : 'ies'}`);
      return { success: true, data: { results } };
    }

    const handler = Object.prototype.hasOwnProperty.call(PRIVATE_HANDLERS, name)
      ? PRIVATE_HANDLERS[name]
      : null;
    if (!handler) return fail('Unknown tool.');

    if (!ctx || !ctx.userId) {
      return fail('Authentication is required to access private trading data.');
    }
    return await handler(rawArgs, ctx);
  } catch (err) {
    console.error('[AI_tools] executeTool failed:', name, err.cause?.code || err.message);
    return fail();
  }
}

module.exports = { TOOL_DECLARATIONS, executeTool, checkAnalyticsConnection };