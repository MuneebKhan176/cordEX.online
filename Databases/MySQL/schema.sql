-- CORDEX / NodeJS_Exchange schema
-- Safe to run repeatedly: no DROP statements and no existing data is deleted.
-- Database selection is handled by initDB.js from DB_NAME.

CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(20) PRIMARY KEY,
    username VARCHAR(100) NOT NULL,
    email VARCHAR(150) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pending_users (
    id VARCHAR(20) PRIMARY KEY,
    username VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    verification_code VARCHAR(6) NOT NULL,
    expires_at DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
    user_id VARCHAR(20) PRIMARY KEY,
    account_number VARCHAR(20) UNIQUE,
    balance DECIMAL(20,2) NOT NULL DEFAULT 0,
    status ENUM('ACTIVE', 'BLOCKED') DEFAULT 'ACTIVE',
    FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS ledger_transactions (
    id VARCHAR(20) PRIMARY KEY,
    from_account VARCHAR(20) NOT NULL,
    to_account VARCHAR(20) NOT NULL,
    amount DECIMAL(20,2) NOT NULL,
    type ENUM('TRANSFER', 'DEPOSIT', 'WITHDRAW') NOT NULL,
    status ENUM('PENDING', 'SUCCESS', 'FAILED') NOT NULL DEFAULT 'PENDING',
    idempotency_key VARCHAR(255) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_lt_from_account FOREIGN KEY (from_account)
        REFERENCES accounts(user_id) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_lt_to_account FOREIGN KEY (to_account)
        REFERENCES accounts(user_id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS credit_ledger (
    id VARCHAR(20) PRIMARY KEY,
    transaction_id VARCHAR(20) NOT NULL,
    account_id VARCHAR(20) NOT NULL,
    from_account_id VARCHAR(20) NOT NULL,
    amount DECIMAL(20,2) NOT NULL,
    status ENUM('PENDING', 'POSTED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    idempotency_key VARCHAR(128) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_credit_ledger_transaction (transaction_id),
    CONSTRAINT fk_credit_transaction FOREIGN KEY (transaction_id)
        REFERENCES ledger_transactions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_credit_account FOREIGN KEY (account_id)
        REFERENCES accounts(user_id) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_credit_from_account FOREIGN KEY (from_account_id)
        REFERENCES accounts(user_id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS debit_ledger (
    id VARCHAR(20) PRIMARY KEY,
    transaction_id VARCHAR(20) NOT NULL,
    account_id VARCHAR(20) NOT NULL,
    to_account_id VARCHAR(20) NOT NULL,
    amount DECIMAL(20,2) NOT NULL,
    status ENUM('PENDING', 'POSTED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    idempotency_key VARCHAR(128) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_debit_ledger_transaction (transaction_id),
    CONSTRAINT fk_debit_transaction FOREIGN KEY (transaction_id)
        REFERENCES ledger_transactions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_debit_account FOREIGN KEY (account_id)
        REFERENCES accounts(user_id) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_debit_to_account FOREIGN KEY (to_account_id)
        REFERENCES accounts(user_id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS chat_rooms (
    room_id VARCHAR(36) PRIMARY KEY,
    room_name VARCHAR(100) NOT NULL,
    description VARCHAR(255) DEFAULT NULL,
    owner_id VARCHAR(20) NOT NULL,
    owner_username VARCHAR(100) NOT NULL,
    visibility ENUM('public','private') NOT NULL DEFAULT 'public',
    password_hash VARCHAR(255) DEFAULT NULL,
    max_users INT NOT NULL DEFAULT 100,
    current_users INT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_visibility (visibility),
    INDEX idx_owner (owner_id)
);

CREATE TABLE IF NOT EXISTS spot_wallet (
    wallet_id VARCHAR(20) PRIMARY KEY,
    user_id VARCHAR(20) NOT NULL UNIQUE,
    status ENUM('ACTIVE', 'BLOCKED') NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_spot_wallet_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS spot_holdings (
    holding_id VARCHAR(20) PRIMARY KEY,
    wallet_id VARCHAR(20) NOT NULL,
    symbol VARCHAR(20) NOT NULL,
    available_quantity DECIMAL(30,10) NOT NULL DEFAULT 0,
    locked_quantity DECIMAL(30,10) NOT NULL DEFAULT 0,
    average_buy_price DECIMAL(20,8) NOT NULL DEFAULT 0,
    total_cost DECIMAL(20,2) NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_wallet_symbol (wallet_id, symbol),
    CONSTRAINT fk_holdings_wallet FOREIGN KEY (wallet_id)
        REFERENCES spot_wallet(wallet_id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS spot_orders (
    order_id VARCHAR(20) PRIMARY KEY,
    user_id VARCHAR(20) NOT NULL,
    wallet_id VARCHAR(20) NOT NULL,
    symbol VARCHAR(20) NOT NULL,
    side ENUM('BUY', 'SELL') NOT NULL,
    order_type ENUM('MARKET', 'LIMIT', 'OCO') NOT NULL,
    quantity DECIMAL(30,10) NOT NULL,
    remaining_quantity DECIMAL(30,10) NOT NULL,
    limit_price DECIMAL(20,8) DEFAULT NULL,
    locked_price DECIMAL(20,8) DEFAULT NULL,
    stop_price DECIMAL(20,8) DEFAULT NULL,
    status ENUM('OPEN','PARTIALLY_FILLED','FILLED','CANCELLED') NOT NULL DEFAULT 'OPEN',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_spot_orders_user (user_id),
    INDEX idx_spot_orders_symbol_status (symbol, status),
    INDEX idx_spot_orders_wallet (wallet_id),
    CONSTRAINT fk_spot_orders_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_spot_orders_wallet FOREIGN KEY (wallet_id)
        REFERENCES spot_wallet(wallet_id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS spot_trades (
    trade_id VARCHAR(20) PRIMARY KEY,
    order_id VARCHAR(20) NOT NULL,
    user_id VARCHAR(20) NOT NULL,
    symbol VARCHAR(20) NOT NULL,
    quantity DECIMAL(30,10) NOT NULL,
    price DECIMAL(20,8) NOT NULL,
    commission DECIMAL(20,8) NOT NULL DEFAULT 0,
    executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_spot_trades_user (user_id),
    INDEX idx_spot_trades_order (order_id),
    CONSTRAINT fk_spot_trades_order FOREIGN KEY (order_id)
        REFERENCES spot_orders(order_id) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_spot_trades_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS futures_wallet (
    wallet_id VARCHAR(20) PRIMARY KEY,
    user_id VARCHAR(20) NOT NULL UNIQUE,
    wallet_balance DECIMAL(20,2) NOT NULL DEFAULT 0,
    available_margin DECIMAL(20,2) NOT NULL DEFAULT 0,
    used_margin DECIMAL(20,2) NOT NULL DEFAULT 0,
    status ENUM('ACTIVE', 'BLOCKED') NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_futures_wallet_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS futures_orders (
    order_id VARCHAR(20) PRIMARY KEY,
    user_id VARCHAR(20) NOT NULL,
    wallet_id VARCHAR(20) NOT NULL,
    symbol VARCHAR(20) NOT NULL,
    side ENUM('BUY', 'SELL') NOT NULL,
    order_type ENUM('MARKET', 'LIMIT') NOT NULL,
    quantity DECIMAL(30,10) NOT NULL,
    remaining_quantity DECIMAL(30,10) NOT NULL,
    limit_price DECIMAL(20,8) DEFAULT NULL,
    leverage INT NOT NULL DEFAULT 1,
    margin_mode ENUM('ISOLATED', 'CROSS') NOT NULL DEFAULT 'ISOLATED',
    position_side ENUM('LONG', 'SHORT') NOT NULL,
    reduce_only BOOLEAN NOT NULL DEFAULT FALSE,
    take_profit DECIMAL(20,8) DEFAULT NULL,
    stop_loss DECIMAL(20,8) DEFAULT NULL,
    status ENUM('OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED') NOT NULL DEFAULT 'OPEN',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_futures_orders_user (user_id),
    INDEX idx_futures_orders_symbol_status (symbol, status),
    CONSTRAINT fk_futures_orders_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_futures_orders_wallet FOREIGN KEY (wallet_id)
        REFERENCES futures_wallet(wallet_id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS positions (
    position_id VARCHAR(20) PRIMARY KEY,
    user_id VARCHAR(20) NOT NULL,
    wallet_id VARCHAR(20) NOT NULL,
    last_order_id VARCHAR(20) DEFAULT NULL,
    symbol VARCHAR(20) NOT NULL,
    position_side ENUM('LONG', 'SHORT') NOT NULL,
    margin_mode ENUM('ISOLATED', 'CROSS') NOT NULL DEFAULT 'ISOLATED',
    quantity DECIMAL(30,10) NOT NULL,
    entry_price DECIMAL(20,8) NOT NULL,
    leverage INT NOT NULL,
    initial_margin DECIMAL(20,2) NOT NULL DEFAULT 0,
    take_profit DECIMAL(20,8) DEFAULT NULL,
    stop_loss DECIMAL(20,8) DEFAULT NULL,
    realized_pnl DECIMAL(20,2) NOT NULL DEFAULT 0,
    status ENUM('OPEN', 'CLOSED', 'LIQUIDATED') NOT NULL DEFAULT 'OPEN',
    opened_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    closed_at TIMESTAMP NULL DEFAULT NULL,
    INDEX idx_positions_user (user_id),
    INDEX idx_positions_symbol_status (symbol, status),
    CONSTRAINT fk_positions_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_positions_wallet FOREIGN KEY (wallet_id)
        REFERENCES futures_wallet(wallet_id) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_positions_last_order FOREIGN KEY (last_order_id)
        REFERENCES futures_orders(order_id) ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS futures_trades (
    trade_id VARCHAR(20) PRIMARY KEY,
    position_id VARCHAR(20) NOT NULL,
    order_id VARCHAR(20) NOT NULL,
    user_id VARCHAR(20) NOT NULL,
    symbol VARCHAR(20) NOT NULL,
    position_side ENUM('LONG', 'SHORT') NOT NULL,
    position_action ENUM('OPEN', 'INCREASE', 'DECREASE', 'CLOSE', 'REVERSE') NOT NULL,
    quantity DECIMAL(30,10) NOT NULL,
    price DECIMAL(20,8) NOT NULL,
    realized_pnl DECIMAL(20,2) NOT NULL DEFAULT 0,
    commission DECIMAL(20,8) NOT NULL DEFAULT 0,
    executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_futures_trades_user (user_id),
    INDEX idx_futures_trades_position (position_id),
    CONSTRAINT fk_futures_trades_position FOREIGN KEY (position_id)
        REFERENCES positions(position_id) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_futures_trades_order FOREIGN KEY (order_id)
        REFERENCES futures_orders(order_id) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_futures_trades_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS funding_payments (
    funding_id VARCHAR(20) PRIMARY KEY,
    position_id VARCHAR(20) NOT NULL,
    user_id VARCHAR(20) NOT NULL,
    symbol VARCHAR(20) NOT NULL,
    position_side ENUM('LONG', 'SHORT') NOT NULL,
    funding_rate DECIMAL(10,8) NOT NULL,
    mark_price DECIMAL(20,8) NOT NULL,
    funding_fee DECIMAL(20,2) NOT NULL,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_funding_user (user_id),
    INDEX idx_funding_position (position_id),
    CONSTRAINT fk_funding_position FOREIGN KEY (position_id)
        REFERENCES positions(position_id) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_funding_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS liquidations (
    liquidation_id VARCHAR(20) PRIMARY KEY,
    position_id VARCHAR(20) NOT NULL,
    user_id VARCHAR(20) NOT NULL,
    symbol VARCHAR(20) NOT NULL,
    position_side ENUM('LONG', 'SHORT') NOT NULL,
    margin_mode ENUM('ISOLATED', 'CROSS') NOT NULL,
    liquidated_quantity DECIMAL(30,10) NOT NULL,
    remaining_quantity DECIMAL(30,10) NOT NULL,
    liquidation_price DECIMAL(20,8) NOT NULL,
    mark_price DECIMAL(20,8) NOT NULL,
    realized_pnl DECIMAL(20,2) NOT NULL,
    is_partial BOOLEAN NOT NULL DEFAULT FALSE,
    liquidated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_liquidations_user (user_id),
    INDEX idx_liquidations_position (position_id),
    CONSTRAINT fk_liquidations_position FOREIGN KEY (position_id)
        REFERENCES positions(position_id) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_liquidations_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE
);
