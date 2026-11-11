-- CORDEX AI / RAG restricted read-only layer.
-- Applied by initAIPermissions.js after schema.sql.
-- __AI_DB_USER__ and __AI_DB_PASSWORD__ are injected from environment.
-- Docker uses '%' because the analytics service connects over the private
-- Compose network. The MySQL port is not published on the VPS host.

CREATE OR REPLACE SQL SECURITY DEFINER VIEW ai_futures_positions AS
SELECT position_id, user_id, symbol, position_side, margin_mode, quantity,
       entry_price, leverage, initial_margin, take_profit, stop_loss,
       realized_pnl, status, opened_at, closed_at
FROM positions;

CREATE OR REPLACE SQL SECURITY DEFINER VIEW ai_futures_trades AS
SELECT trade_id, position_id, user_id, symbol, position_side, position_action,
       quantity, price, realized_pnl, commission, executed_at
FROM futures_trades;

CREATE OR REPLACE SQL SECURITY DEFINER VIEW ai_futures_funding AS
SELECT funding_id, position_id, user_id, symbol, position_side,
       funding_rate, funding_fee, applied_at
FROM funding_payments;

-- side is stored on spot_orders, not spot_trades.
CREATE OR REPLACE SQL SECURITY DEFINER VIEW ai_spot_trades AS
SELECT t.trade_id, t.order_id, t.user_id, t.symbol, o.side, o.order_type,
       t.quantity, t.price, t.commission, t.executed_at
FROM spot_trades t
JOIN spot_orders o ON o.order_id = t.order_id;

CREATE USER IF NOT EXISTS '__AI_DB_USER__'@'%'
    IDENTIFIED BY __AI_DB_PASSWORD__
    WITH MAX_USER_CONNECTIONS 10;
ALTER USER '__AI_DB_USER__'@'%'
    IDENTIFIED BY __AI_DB_PASSWORD__
    WITH MAX_USER_CONNECTIONS 10;

GRANT SELECT ON ai_futures_positions TO '__AI_DB_USER__'@'%';
GRANT SELECT ON ai_futures_trades TO '__AI_DB_USER__'@'%';
GRANT SELECT ON ai_futures_funding TO '__AI_DB_USER__'@'%';
GRANT SELECT ON ai_spot_trades TO '__AI_DB_USER__'@'%';

FLUSH PRIVILEGES;
