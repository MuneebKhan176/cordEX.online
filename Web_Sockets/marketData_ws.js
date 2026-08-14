const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { sendPriceUpdate } = require('../Spot_Engine/engineClient');
const { conn, jwtSecret } = require('../db_connection'); // added jwtSecret

// Path browsers connect to on YOUR server (not Binance directly).
const WS_PATH = '/ws/market-data';

// Coins we track. `stream` is the Binance symbol (lowercase) used in the
// combined-stream URL. Stablecoins pegged 1:1 to USD with no USDT pair on
// Binance are seeded with a static price instead of streamed.
const COINS = [
  { id: 'bitcoin',     stream: 'btcusdt',  symbol: 'BTC',  name: 'Bitcoin',  rank: 1 },
  { id: 'ethereum',    stream: 'ethusdt',  symbol: 'ETH',  name: 'Ethereum', rank: 2 },
  { id: 'tether',      stream: null,       symbol: 'USDT', name: 'Tether',   rank: 3, staticPrice: 1.0 },
  { id: 'binancecoin', stream: 'bnbusdt',  symbol: 'BNB',  name: 'BNB',      rank: 4 },
  { id: 'solana',      stream: 'solusdt',  symbol: 'SOL',  name: 'Solana',   rank: 5 },
  { id: 'usd-coin',    stream: 'usdcusdt', symbol: 'USDC', name: 'USD Coin', rank: 6, staticPrice: 1.0 },
  { id: 'ripple',      stream: 'xrpusdt',  symbol: 'XRP',  name: 'XRP',      rank: 7 },
];

const KLINE_INTERVALS = ['15m', '1h', '4h', '12h', '1d', '1w', '1M'];

let started = false;
let snapshotInterval = null;
let portfolioInterval = null;

const STREAMED_COINS = COINS.filter(c => c.stream);

const tickerStreams = STREAMED_COINS.map(c => c.stream + '@ticker');
const klineStreams = [];
STREAMED_COINS.forEach(c => {
  KLINE_INTERVALS.forEach(iv => klineStreams.push(c.stream + '@kline_' + iv));
});

const BINANCE_URL =
  'wss://stream.binance.com:9443/stream?streams=' +
  [...tickerStreams, ...klineStreams].join('/');

const liveData = {};
COINS.filter(c => c.staticPrice != null).forEach(c => {
  liveData[c.id] = {
    id: c.id, symbol: c.symbol, name: c.name, rank: c.rank,
    price: c.staticPrice, changePct: 0, high: c.staticPrice, low: c.staticPrice, quoteVol: 0,
  };
});

const klines = {};

let binanceSocket = null;
let binanceReconnectTimer = null;
const clients = new Set();

function connectToBinance() {
  binanceSocket = new WebSocket(BINANCE_URL);

  binanceSocket.on('open', () => {});

  binanceSocket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    const payload = msg.data;
    if (!payload || !payload.e) return;

    if (payload.e === '24hrTicker') {
      handleTickerPayload(payload);
    } else if (payload.e === 'kline') {
      handleKlinePayload(payload);
    }
  });

  binanceSocket.on('close', () => {
    console.warn('[market_data] Binance upstream closed — reconnecting in 3s');
    scheduleBinanceReconnect();
  });

  binanceSocket.on('error', (err) => {
    console.error('[market_data] Binance upstream error:', err.message);
  });
}

function handleTickerPayload(t) {
  const coin = STREAMED_COINS.find(c => c.stream === t.s.toLowerCase());
  if (!coin) return;

  const price = parseFloat(t.c);

  liveData[coin.id] = {
    id: coin.id, symbol: coin.symbol, name: coin.name, rank: coin.rank,
    price,
    changePct: parseFloat(t.P),
    high:      parseFloat(t.h),
    low:       parseFloat(t.l),
    quoteVol:  parseFloat(t.q),
  };

  sendPriceUpdate(coin.symbol + 'USDT', price).catch(() => {});
}

function handleKlinePayload(payload) {
  const coin = STREAMED_COINS.find(c => c.stream === payload.s.toLowerCase());
  if (!coin) return;

  const k = payload.k;
  if (!k || !KLINE_INTERVALS.includes(k.i)) return;

  if (!klines[coin.id]) klines[coin.id] = {};
  klines[coin.id][k.i] = {
    t: k.t,
    o: parseFloat(k.o),
    h: parseFloat(k.h),
    l: parseFloat(k.l),
    c: parseFloat(k.c),
    v: parseFloat(k.v),
    x: !!k.x,
  };
}

function scheduleBinanceReconnect() {
  clearTimeout(binanceReconnectTimer);
  binanceReconnectTimer = setTimeout(connectToBinance, 3000);
}

function getLivePrice(symbol) {
  const coin = COINS.find(c => c.symbol === symbol);
  if (!coin) return null;
  const entry = liveData[coin.id];
  if (entry) return entry.price;
  return coin.staticPrice != null ? coin.staticPrice : null;
}

function broadcastSnapshot() {
  if (clients.size === 0) return;
  const payload = JSON.stringify({
    type: 'snapshot',
    data: liveData,
    klines,
    ts: Date.now(),
  });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

function priceHoldings(holdingRows) {
  let totalValue = 0;
  const holdings = holdingRows.map(h => {
    const price = getLivePrice(h.symbol) ?? parseFloat(h.average_buy_price) ?? 0;
    const available = parseFloat(h.available_quantity);
    const locked = parseFloat(h.locked_quantity);
    const value = (available + locked) * price;
    totalValue += value;
    return {
      symbol: h.symbol,
      availableQuantity: available,
      lockedQuantity: locked,
      averageBuyPrice: parseFloat(h.average_buy_price),
      currentPrice: price,
      value,
    };
  });
  return { totalValue, holdings };
}

function pushPortfolioForUser(userId, socketsForUser) {
  conn.query(
    `SELECT sw.wallet_id, sw.status, sh.symbol, sh.available_quantity, sh.locked_quantity, sh.average_buy_price
     FROM spot_wallet sw
     LEFT JOIN spot_holdings sh ON sh.wallet_id = sw.wallet_id
        AND (sh.available_quantity > 0 OR sh.locked_quantity > 0)
     WHERE sw.user_id = ?`,
    [userId],
    (err, rows) => {
      if (err || !rows.length) return;
      const { wallet_id, status } = rows[0];
      const holdingRows = rows.filter(r => r.symbol);
      const { totalValue, holdings } = priceHoldings(holdingRows);

      const payload = JSON.stringify({
        type: 'portfolio',
        data: { walletId: wallet_id, status, totalValue, holdings },
        ts: Date.now(),
      });
      for (const ws of socketsForUser) {
        if (ws.readyState === WebSocket.OPEN) ws.send(payload);
      }
    }
  );
}

function broadcastPortfolios() {
  const byUser = new Map();
  for (const ws of clients) {
    if (!ws.userId) continue;
    if (!byUser.has(ws.userId)) byUser.set(ws.userId, []);
    byUser.get(ws.userId).push(ws);
  }
  for (const [userId, sockets] of byUser) {
    pushPortfolioForUser(userId, sockets);
  }
}

function notifyUserTradeUpdate(userId, payload) {
  if (!userId) return;
  let delivered = 0;
  for (const ws of clients) {
    if (ws.userId === userId && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'trade_update', ts: Date.now(), ...payload }));
      delivered++;
    }
  }
  return delivered;
}

// Resolve userId from the same auth cookie middle/middleware.js uses.
// Now uses jwtSecret from db_connection.js — same secret the login flow
// and /api/ws-token both use, so this no longer silently disagrees with
// the rest of the auth system.
function getUserIdFromRequest(req) {
  try {
    const raw = req.headers.cookie || '';
    const cookies = Object.fromEntries(
      raw.split(';').filter(Boolean).map(c => {
        const idx = c.indexOf('=');
        return [c.slice(0, idx).trim(), decodeURIComponent(c.slice(idx + 1).trim())];
      })
    );
    const token = cookies.token;
    if (!token) return null;
    const decoded = jwt.verify(token, jwtSecret);
    return decoded.id || decoded.userId || null;
  } catch (e) {
    return null;
  }
}

function initialize(wss) {

    if (started) {

      return;

    }

    started = true;


    wss.on("connection", (ws, req) => {


        ws.userId = getUserIdFromRequest(req);

        ws.isAlive = true;

        clients.add(ws);

        ws.send(JSON.stringify({

            type: "snapshot",

            data: liveData,

            klines,

            ts: Date.now()

        }));

        ws.on("pong", () => {

            ws.isAlive = true;

        });

        ws.on("close", () => {

            clients.delete(ws);

        });

        ws.on("error", (err) => {

            console.error("[market_data] Socket error:", err);

            clients.delete(ws);

        });

    });

    connectToBinance();

    snapshotInterval = setInterval(() => {

        broadcastSnapshot();

    }, 1000);

    portfolioInterval = setInterval(() => {

        broadcastPortfolios();

    }, 2500);

    setInterval(() => {

        for (const ws of clients) {

            if (ws.isAlive === false) {

                ws.terminate();

                clients.delete(ws);

                continue;

            }

            ws.isAlive = false;

            ws.ping();

        }

    }, 30000);

}
module.exports = {

    initialize,

    WS_PATH,

    COINS,

    KLINE_INTERVALS,

    getLivePrice,

    notifyUserTradeUpdate,

};