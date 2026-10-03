"""Domain-specific, read-only analytics. Each function takes the TRUSTED
user_id (supplied by the Node server from its verified JWT) and validated args.
All SQL is written here by the developer and fully parameterized.

Symbol conventions in this schema (from the app's own routes/persistence):
  - Futures tables store the FULL pair  ("BTCUSDT")
  - Spot tables store the BASE ticker    ("BTC")
Either form is accepted from the caller and normalized here."""

from .db import ReadOnlyDB

db = ReadOnlyDB()

FUTURES_NOTES = [
    "Performance is grouped by position close time. A closed/liquidated position's realized_pnl covers its whole life, including partial closes before the period. PnL from partial closes of positions that are still open is not included.",
    "realized_pnl is the amount credited to the user's futures wallet. Commission is reported separately; whether the engine already deducted it inside realized_pnl is engine-defined, so present the figures separately and do not combine them.",
    "Commission totals only cover fills recorded in the trade table. TP/SL-triggered closes are not recorded there, so commission (and fill counts) can be understated.",
    "funding_fee_total: positive means the user paid funding, negative means the user received it.",
]
SPOT_NOTES = [
    "Spot realized PnL is an ESTIMATE computed by replaying the user's full trade history with the average-cost method; the app does not store spot realized PnL.",
    "Spot commission is currently recorded as 0 for every fill.",
    "Notional values are quantity x price (USDT).",
]
SPOT_REPLAY_LIMIT = 50000


def _f(v):
    return float(v) if v is not None else 0.0


def _i(v):
    return int(v) if v is not None else 0


def _win_rate(wins, total):
    return round(100.0 * wins / total, 2) if total else None


def _futures_symbol(s: str) -> str:
    s = s.upper()
    return s if s.endswith("USDT") else s + "USDT"


def _spot_symbol(s: str) -> str:
    s = s.upper()
    return s[:-4] if s.endswith("USDT") and len(s) > 4 else s


def _symbol_filter(args, params, normalize):
    if args.symbol:
        params.append(normalize(args.symbol))
        return " AND symbol = %s"
    return ""


# ── Futures ──────────────────────────────────────────────────────────────────
def get_futures_performance(user_id, args):
    params = [args.days]
    sym = _symbol_filter(args, params, _futures_symbol)

    closed = db.fetch_for_user(
        "SELECT symbol, COUNT(*) AS closed_positions, "
        "SUM(realized_pnl > 0) AS winning_positions, "
        "SUM(realized_pnl < 0) AS losing_positions, "
        "SUM(CASE WHEN realized_pnl > 0 THEN realized_pnl ELSE 0 END) AS gross_profit, "
        "SUM(CASE WHEN realized_pnl < 0 THEN realized_pnl ELSE 0 END) AS gross_loss, "
        "SUM(realized_pnl) AS total_realized_pnl, "
        "SUM(status = 'LIQUIDATED') AS liquidated_positions "
        "FROM ai_futures_positions "
        "WHERE user_id = %s AND status IN ('CLOSED','LIQUIDATED') "
        "AND closed_at >= DATE_SUB(NOW(), INTERVAL %s DAY)" + sym +
        " GROUP BY symbol ORDER BY symbol",
        user_id, params,
    )
    fees = db.fetch_for_user(
        "SELECT symbol, COUNT(*) AS fills, SUM(commission) AS commission_total "
        "FROM ai_futures_trades "
        "WHERE user_id = %s AND executed_at >= DATE_SUB(NOW(), INTERVAL %s DAY)" + sym +
        " GROUP BY symbol",
        user_id, params,
    )
    funding = db.fetch_for_user(
        "SELECT symbol, SUM(funding_fee) AS funding_fee_total "
        "FROM ai_futures_funding "
        "WHERE user_id = %s AND applied_at >= DATE_SUB(NOW(), INTERVAL %s DAY)" + sym +
        " GROUP BY symbol",
        user_id, params,
    )

    def blank(s):
        return {
            "symbol": s, "closed_positions": 0, "winning_positions": 0, "losing_positions": 0,
            "win_rate_pct": None, "gross_profit": 0.0, "gross_loss": 0.0, "total_realized_pnl": 0.0,
            "liquidated_positions": 0, "fills": 0, "commission_total": 0.0, "funding_fee_total": 0.0,
        }

    by_symbol = {}
    for r in closed:
        n, w = _i(r["closed_positions"]), _i(r["winning_positions"])
        row = blank(r["symbol"])
        row.update({
            "closed_positions": n,
            "winning_positions": w,
            "losing_positions": _i(r["losing_positions"]),
            "win_rate_pct": _win_rate(w, n),
            "gross_profit": round(_f(r["gross_profit"]), 2),
            "gross_loss": round(_f(r["gross_loss"]), 2),
            "total_realized_pnl": round(_f(r["total_realized_pnl"]), 2),
            "liquidated_positions": _i(r["liquidated_positions"]),
        })
        by_symbol[r["symbol"]] = row
    for r in fees:
        row = by_symbol.setdefault(r["symbol"], blank(r["symbol"]))
        row["fills"] = _i(r["fills"])
        row["commission_total"] = round(_f(r["commission_total"]), 8)
    for r in funding:
        by_symbol.setdefault(r["symbol"], blank(r["symbol"]))["funding_fee_total"] = round(
            _f(r["funding_fee_total"]), 2)

    rows = sorted(by_symbol.values(), key=lambda x: x["symbol"])
    n = sum(r["closed_positions"] for r in rows)
    w = sum(r["winning_positions"] for r in rows)
    totals = {
        "closed_positions": n,
        "winning_positions": w,
        "losing_positions": sum(r["losing_positions"] for r in rows),
        "win_rate_pct": _win_rate(w, n),
        "gross_profit": round(sum(r["gross_profit"] for r in rows), 2),
        "gross_loss": round(sum(r["gross_loss"] for r in rows), 2),
        "total_realized_pnl": round(sum(r["total_realized_pnl"] for r in rows), 2),
        "commission_total": round(sum(r["commission_total"] for r in rows), 8),
        "funding_fee_total": round(sum(r["funding_fee_total"] for r in rows), 2),
        "liquidated_positions": sum(r["liquidated_positions"] for r in rows),
    }
    return {"period_days": args.days, "by_symbol": rows, "totals": totals, "data_notes": FUTURES_NOTES}


def get_futures_trade_history(user_id, args):
    params = [args.days]
    sym = _symbol_filter(args, params, _futures_symbol)
    params.append(args.limit)
    rows = db.fetch_for_user(
        "SELECT symbol, position_side, position_action, quantity, price, "
        "realized_pnl, commission, executed_at "
        "FROM ai_futures_trades "
        "WHERE user_id = %s AND executed_at >= DATE_SUB(NOW(), INTERVAL %s DAY)" + sym +
        " ORDER BY executed_at DESC LIMIT %s",
        user_id, params,
    )
    return {"period_days": args.days, "count": len(rows), "trades": rows, "data_notes": FUTURES_NOTES}


def get_open_futures_positions(user_id, args):
    """STATIC half of the open-position view only (from MySQL). The Node layer
    merges the LIVE half (mark price, uPnL, liquidation price) from
    liveStateStore. This tool is internal: it is not declared to Gemini."""
    params = []
    sym = _symbol_filter(args, params, _futures_symbol)
    rows = db.fetch_for_user(
        "SELECT symbol, position_side, margin_mode, quantity, entry_price, leverage, "
        "initial_margin, take_profit, stop_loss, realized_pnl, opened_at "
        "FROM ai_futures_positions "
        "WHERE user_id = %s AND status = 'OPEN'" + sym +
        " ORDER BY opened_at DESC",
        user_id, params,
    )
    return {"positions": rows}


# ── Spot ─────────────────────────────────────────────────────────────────────
def get_spot_trade_history(user_id, args):
    params = [args.days]
    sym = _symbol_filter(args, params, _spot_symbol)
    params.append(args.limit)
    rows = db.fetch_for_user(
        "SELECT symbol, side, order_type, quantity, price, commission, executed_at "
        "FROM ai_spot_trades "
        "WHERE user_id = %s AND executed_at >= DATE_SUB(NOW(), INTERVAL %s DAY)" + sym +
        " ORDER BY executed_at DESC LIMIT %s",
        user_id, params,
    )
    return {"period_days": args.days, "count": len(rows), "trades": rows, "data_notes": SPOT_NOTES[1:]}


def _replay_spot(rows, window_seconds):
    """Average-cost replay over the user's full fill history (oldest first).
    Cost basis needs ALL prior buys; only activity inside the window is reported."""
    state = {}  # symbol -> [qty, avg_cost]
    out = {}
    for r in rows:
        s = r["symbol"]
        q, p, fee = _f(r["quantity"]), _f(r["price"]), _f(r.get("commission"))
        st = state.setdefault(s, [0.0, 0.0])
        o = out.setdefault(s, {
            "symbol": s, "fills": 0, "buy_fills": 0, "sell_fills": 0,
            "buy_notional": 0.0, "sell_notional": 0.0, "commission_total": 0.0,
            "estimated_realized_pnl": 0.0, "profitable_sell_fills": 0, "losing_sell_fills": 0,
            "unmatched_sell_quantity": 0.0,
        })
        in_win = r.get("age_seconds") is not None and r["age_seconds"] < window_seconds

        if r["side"] == "BUY":
            total = st[0] * st[1] + q * p
            st[0] += q
            st[1] = total / st[0] if st[0] else 0.0
            if in_win:
                o["buy_fills"] += 1
                o["buy_notional"] += q * p
        else:
            matched = min(q, st[0])
            pnl = matched * (p - st[1])
            st[0] -= matched
            if in_win:
                o["sell_fills"] += 1
                o["sell_notional"] += q * p
                o["estimated_realized_pnl"] += pnl
                o["unmatched_sell_quantity"] += q - matched
                if pnl > 0:
                    o["profitable_sell_fills"] += 1
                elif pnl < 0:
                    o["losing_sell_fills"] += 1
        if in_win:
            o["fills"] += 1
            o["commission_total"] += fee
    return out


def get_spot_performance(user_id, args):
    params = []
    sym = _symbol_filter(args, params, _spot_symbol)
    params.append(SPOT_REPLAY_LIMIT)
    rows = db.fetch_for_user(
        "SELECT symbol, side, quantity, price, commission, "
        "TIMESTAMPDIFF(SECOND, executed_at, NOW()) AS age_seconds "
        "FROM ai_spot_trades WHERE user_id = %s" + sym +
        " ORDER BY executed_at ASC, trade_id ASC LIMIT %s",
        user_id, params,
    )
    replay = _replay_spot(rows, args.days * 86400)

    out = []
    for s in sorted(replay):
        o = replay[s]
        if o["fills"] == 0:
            continue
        for k in ("buy_notional", "sell_notional", "estimated_realized_pnl"):
            o[k] = round(o[k], 2)
        o["commission_total"] = round(o["commission_total"], 8)
        o["unmatched_sell_quantity"] = round(o["unmatched_sell_quantity"], 10)
        out.append(o)

    notes = list(SPOT_NOTES)
    if len(rows) >= SPOT_REPLAY_LIMIT:
        notes.append("History was truncated at the replay limit, so estimates may be incomplete.")
    totals = {
        "fills": sum(o["fills"] for o in out),
        "buy_notional": round(sum(o["buy_notional"] for o in out), 2),
        "sell_notional": round(sum(o["sell_notional"] for o in out), 2),
        "estimated_realized_pnl": round(sum(o["estimated_realized_pnl"] for o in out), 2),
        "commission_total": round(sum(o["commission_total"] for o in out), 8),
    }
    return {"period_days": args.days, "by_symbol": out, "totals": totals, "data_notes": notes}


# Whitelist: the ONLY things the HTTP layer can run.
TOOLS = {
    "get_futures_performance": get_futures_performance,
    "get_futures_trade_history": get_futures_trade_history,
    "get_open_futures_positions": get_open_futures_positions,
    "get_spot_trade_history": get_spot_trade_history,
    "get_spot_performance": get_spot_performance,
}