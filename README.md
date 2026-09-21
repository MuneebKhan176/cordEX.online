# cordEX.online

> A full-stack crypto trading and social platform built around Node.js, MySQL, MongoDB, WebSockets, external market-data services, and native C++ trading engines.

cordEX.online is a demonstration trading platform that combines trading, wallets, social content, real-time communication, and AI support in one application.

## Table of Contents

- Overview
- Architecture at a Glance
- Technology Stack
- Repository Structure
- Application Server
- Database Architecture
- Authentication
- Wallet and Ledger System
- Spot Trading Engine
- Futures Trading Engine
- Real-Time WebSocket Architecture
- Social Platform
- Feed and Recommendation Pipeline
- Chat System
- AI Support Assistant
- Media Pipeline
- Representative Data Flows
- Local Development
- Security and Consistency
- Architectural Limitations
- Design Principles
- License

---

# Overview

The repository contains several logical subsystems:

- Spot trading
- Futures trading
- Funding, spot, and futures wallets
- JWT authentication and email verification
- Social profiles and content
- Ranked social feeds
- Public/private real-time chat rooms
- Live cryptocurrency market data
- AI customer-support chatbot
- Media upload and processing

The central architectural idea is:

**Node.js owns application orchestration and durable application persistence, while the C++ engines own latency-sensitive trading state and execution logic.**

This is currently a modular monolithic application with separate native trading processes, rather than a fully distributed microservice deployment.

---

# Architecture at a Glance

    Browser UI
       |
       | HTTP / REST + WebSocket
       v
    Node.js / Express
       |
       +----------------------+----------------------+
       |                      |                      |
       v                      v                      v
    MySQL                  MongoDB             External APIs
    |                      |                   Binance / Gemini
    |                      |                   Object Storage
    |                      |
    |                      +-- Profiles
    |                      +-- Posts
    |                      +-- Comments
    |                      +-- Likes / Follows
    |                      +-- Feed data
    |
    +-- Users
    +-- Accounts
    +-- Wallets
    +-- Orders
    +-- Positions
    +-- Transfers
       |
       +-----------------------+
       |                       |
       v                       v
    C++ Spot Engine       C++ Futures Engine
       TCP :9000             TCP :9001
       |                       |
       +-- Order book          +-- Positions
       +-- Matching            +-- Margin / PnL
       +-- MARKET/LIMIT        +-- Liquidation
       +-- OCO behavior        +-- Funding / TP-SL

The important boundary is:

    Node.js
        = API, authentication, persistence, orchestration, WebSockets

    C++ engines
        = live trading state, matching, risk calculations

---

# Technology Stack

## Backend

- Node.js
- Express 5
- JWT
- bcrypt / bcryptjs
- mysql2
- Mongoose
- MongoDB
- WebSocket (ws)
- Nodemailer
- Multer
- Sharp
- FFmpeg integration
- AWS S3-compatible SDK

## Trading

- C++20
- Standalone Asio
- TCP sockets
- In-memory order books and futures risk state

## Frontend

The current frontend uses server-served HTML/CSS/JavaScript pages organized around authentication, dashboard, trading, wallets, social features, and chat.

---

# Repository Structure

    cordEX.online/
    |
    +-- AI_chatbot/
    |   +-- chatbotController.js
    |   +-- geminiService.js
    |   +-- faq.json
    |   +-- requirements.txt
    |
    +-- Frontend/
    |   +-- Auth_UI/
    |   +-- ChatRoom_UI/
    |   +-- Square_UI/
    |   +-- TradePanels_UI/
    |   +-- Wallets_UI/
    |   +-- dashboard.html
    |   +-- index.html
    |
    +-- Futures_Engine/
    |   +-- futures_engine.cpp
    |   +-- futuresEngineClient.js
    |   +-- futuresBootstrap.js
    |   +-- futuresPriceFeed.js
    |   +-- futuresRehydrate.js
    |   +-- futures_Persistence.js
    |   +-- LiveStateStore.js
    |   +-- futuresWalletMerge.js
    |
    +-- Social_Platform/
    |   +-- social_models.js
    |   +-- posts.js
    |   +-- profile.js
    |   +-- follow_unfollow.js
    |   +-- insights.js
    |   +-- notifications.js
    |   +-- postView.js
    |   +-- cache/
    |   +-- services/
    |   +-- socket/
    |   +-- Social_Routes_Utils/
    |
    +-- Spot_Engine/
    |   +-- trade_engine.cpp
    |   +-- engineClient.js
    |   +-- Spot_Engine.md
    |
    +-- Web_Sockets/
    |   +-- ws_manager.js
    |   +-- marketData_ws.js
    |   +-- futuresLive_ws.js
    |   +-- websocketService.js
    |   +-- chatrooms_ws.js
    |
    +-- Wallets_Config/
    |   +-- walletServices.js
    |   +-- walletTransfer.js
    |   +-- spotHoldings_Lock.js
    |   +-- walletIdGenerator.js
    |
    +-- chat/
    |   +-- chatAuth.js
    |   +-- chatDb.js
    |   +-- handlers/
    |   +-- managers/
    |   +-- services/
    |
    +-- routes/
    |   +-- authRoutes.js
    |   +-- bankingAuth.js
    |   +-- walletRoutes.js
    |   +-- spotPanel_Route.js
    |   +-- futuresPanel_Route.js
    |   +-- chatRoom_Routes.js
    |   +-- uploadRoutes.js
    |   +-- ws_auth.js
    |
    +-- db_connection.js
    +-- web.js
    +-- mailer.js
    +-- package.json

---

# Application Server

The main entry point is web.js.

It:

1. Connects to MongoDB.
2. Creates the Express application.
3. Registers HTTP routes.
4. Serves the frontend and uploads.
5. Attaches the WebSocket gateways.
6. Bootstraps the futures subsystem.
7. Initializes the chat manager.
8. Starts the HTTP server on port 7070.

The high-level structure is:

    web.js
      |
      +-- MongoDB
      |
      +-- Authentication
      +-- Wallets
      +-- Banking / transfers
      +-- Spot
      +-- Futures
      +-- Social
      +-- Comments / media
      +-- Notifications
      +-- Chat
      +-- AI chatbot
      |
      +-- WebSocket manager
      |     +-- Chat
      |     +-- Market data
      |     +-- Futures
      |     +-- Social
      |
      +-- Futures bootstrap
            +-- Live state
            +-- Persistence
            +-- Price feed
            +-- Engine rehydration

The Express 404 handler is registered last so feature routes remain reachable.

---

# Database Architecture

cordEX.online deliberately uses two databases because the application's data has two very different consistency and access patterns.

## MySQL: financial and transactional state

MySQL is the durable source of truth for consistency-sensitive data:

- Users
- Accounts
- Wallets
- Wallet balances
- Spot holdings
- Orders
- Positions
- Transfers
- Chat-room metadata

The application uses a MySQL connection pool.

For simple operations:

    Request
       |
       v
    MySQL pool
       |
       v
    query
       |
       v
    connection returned to pool

For transactions:

    Request
       |
       v
    getConnection()
       |
       v
    BEGIN
       |
       +-- SELECT ... FOR UPDATE
       +-- UPDATE
       +-- INSERT
       |
       v
    COMMIT / ROLLBACK
       |
       v
    release()

The dedicated connection is important because all statements in one transaction must execute on the same physical MySQL connection.

## MongoDB: social and content state

MongoDB stores document-oriented social data:

- Social profiles
- Posts
- Media attachments
- Comments
- Replies
- Follows
- Likes
- Bookmarks
- Polls
- Hashtags
- User activity
- Notifications

Mongoose provides the schemas, indexes, and document operations.

---

# Authentication

Authentication is implemented in the Express application.

The registration flow is approximately:

    POST /register
         |
         +-- Validate input
         +-- Hash password
         +-- Create pending verification record
         +-- Send verification email
                  |
                  v
            POST /verify-email
                  |
                  +-- Create SQL user
                  +-- Create account
                  +-- Create wallets
                  +-- Commit SQL transaction
                  +-- Create Mongo social profile
                           |
                           v
                         Login
                           |
                           v
                       JWT cookie

The system uses:

- JWT
- HTTP cookies
- bcrypt password hashing
- Email verification codes
- Authentication middleware

A useful consistency boundary exists during email verification: SQL user/account/wallet creation is transactional, and the Mongo social profile is created after the SQL transaction succeeds.

---

# Wallet and Ledger System

The application has three logical wallet types:

    User
      |
      +-- Funding Wallet
      |
      +-- Spot Wallet
      |
      +-- Futures Wallet

## Funding wallet

Represents the user's main account balance.

## Spot wallet

Stores asset holdings and separates:

- available quantity
- locked quantity

This is important because funds reserved by an open order must not also be transferable.

## Futures wallet

Stores the durable futures wallet balance.

Rapidly changing values such as:

- available margin
- used margin
- unrealized PnL
- liquidation information

are handled by the futures engine/live-state layer.

## Wallet transfers

Wallet transfers use a real SQL transaction.

The implementation locks involved wallets in a canonical order:

    funding -> spot -> futures

The order is independent of transfer direction.

For example, both:

    funding -> futures

and:

    futures -> funding

follow the same lock ordering, reducing deadlock risk.

The transfer sequence is:

    BEGIN
      |
      +-- Lock required wallet rows
      +-- Validate spendable balance
      +-- Debit source
      +-- Credit destination
      |
    COMMIT
      |
      +-- Sync futures engine if required

---

# Spot Trading Engine

The spot engine is a separate C++ process.

Default endpoint:

    127.0.0.1:9000

Node communicates with it through Spot_Engine/engineClient.js.

## Responsibility split

### Node.js

- JWT authentication
- Authorization
- Balance checks
- Business validation
- Durable database persistence
- HTTP API
- WebSocket broadcasting

### C++ engine

- In-memory order books
- Matching
- MARKET execution
- LIMIT execution
- OCO-related execution behavior
- Engine-level validation

The C++ engine does not directly access MySQL.

## TCP protocol

Communication uses newline-delimited JSON.

    Node
      |
      | PLACE_ORDER
      v
    C++ Spot Engine
      |
      +-- ORDER_ACK
      +-- EXECUTION
      +-- ORDER_BOOK_UPDATE

A single inbound packet can produce multiple outbound messages. The Node client therefore processes the TCP stream line-by-line rather than assuming one response per request.

## Persistent connection

engineClient.js maintains one shared TCP connection for the Node process.

It provides:

- request IDs
- pending request tracking
- reconnect behavior
- queued writes
- timeout handling
- asynchronous execution events
- order-book update events

## State boundary

The C++ order book is RAM-only.

    MySQL
      = durable order/application state

    C++ engine
      = live matching state

If the C++ process restarts, its in-memory order book is lost. Durable open orders therefore require reconciliation/re-submission.

---

# Futures Trading Engine

The futures engine follows the same Node-to-C++ architecture but also owns live risk-management state.

Default endpoint:

    127.0.0.1:9001

Important integration files include:

- Futures_Engine/futuresEngineClient.js
- Futures_Engine/futuresBootstrap.js
- Futures_Engine/futuresPriceFeed.js
- Futures_Engine/futuresRehydrate.js
- Futures_Engine/LiveStateStore.js
- Futures_Engine/futures_Persistence.js

## Futures responsibilities

The engine handles live behavior around:

- Positions
- Leverage
- Margin
- Unrealized PnL
- Mark price
- Liquidation
- TP/SL
- Funding
- Position updates

## Static vs live state

    C++ Futures Engine
            |
            +-- Live RAM
            |     +-- mark price
            |     +-- PnL
            |     +-- margin
            |     +-- liquidation state
            |
            +-- Push events
                  +-- position updates
                  +-- margin updates
                  +-- liquidation
                  +-- funding

    MySQL
       |
       +-- durable trading state
       +-- fills
       +-- persisted positions
       +-- funding/liquidation records

This prevents high-frequency market ticks from turning every calculation into a database write.

## Communication types

Request/response is used for:

- PLACE_ORDER
- CANCEL_ORDER

Fire-and-forget is used for:

- PRICE_UPDATE
- MARK_PRICE_UPDATE
- FUNDING_TICK
- UPDATE_TP_SL
- SYNC_WALLET
- SYNC_POSITION

The distinction matters because high-frequency actions produce push events rather than traditional RPC acknowledgements.

## Price feed

futuresPriceFeed.js obtains live prices and sends:

- PRICE_UPDATE for matching
- MARK_PRICE_UPDATE for PnL, margin, and liquidation calculations

The current implementation uses approximately:

- 1-second price ticks
- 2-second mark-price ticks

## Rehydration

The futures engine keeps important state in RAM. futuresRehydrate.js can reconstruct engine state from durable MySQL data when the engine connects or reconnects.

    MySQL durable state
            |
            +-- SYNC_WALLET
            +-- SYNC_POSITION
                    |
                    v
            C++ Futures RAM
                    |
                    v
            Live risk calculations

---

# Real-Time WebSocket Architecture

The application uses the ws package with a central WebSocket manager.

Web_Sockets/ws_manager.js creates separate gateways for different domains.

    HTTP Server
         |
      upgrade
         |
    ws_manager
         |
         +-- Chat Gateway
         |
         +-- Market Data Gateway
         |
         +-- Futures Gateway
         |
         +-- Social Gateway

## Market data

The market gateway maintains an upstream Binance WebSocket connection and distributes normalized data to browser clients.

It handles:

- ticker data
- K-lines
- live prices
- market snapshots
- portfolio valuation support

The browser connects to the application's WebSocket rather than directly to Binance.

## Futures data

The futures gateway broadcasts engine-derived information such as:

- positions
- margin
- PnL
- liquidation events
- order-book updates

## Social data

The social gateway can propagate:

- likes
- follows
- comments
- posts
- notifications

## Chat

Chat uses a dedicated WebSocket gateway and room manager rather than sharing market-data traffic.

---

# Social Platform

The social subsystem is primarily MongoDB/Mongoose based.

Core entities include:

    SocialProfile
         |
         +-- Post
         |     +-- Media
         |     +-- Poll
         |     +-- Hashtags
         |
         +-- Follow
         +-- Like
         +-- Bookmark
         +-- Comment
         +-- Reply
         +-- UserActivity
         +-- Notification

## Posts

Posts can contain:

- text
- images
- videos
- hashtags
- polls
- market sentiment
- optional trading-signal information

Posts also maintain denormalized counters for:

- likes
- comments
- views
- shares
- saves
- clicks
- watch time

These counters become inputs to the feed-ranking system.

## Social profiles

A social profile is associated with the SQL user identity through a user ID and also carries username/email information used by the social layer.

This gives the application a clear separation:

    MySQL
      = account identity / financial identity

    MongoDB
      = social identity / social content

---

# Feed and Recommendation Pipeline

The feed is implemented as a staged pipeline instead of putting ranking logic directly inside route handlers.

    Route
      |
      v
    feedService
      |
      +-- Candidate posts
      +-- Author context
      +-- Viewer interests
      +-- Friendship context
      |
      v
    feedRanking
      |
      +-- Friendship score
      +-- Interest score
      +-- Engagement score
      +-- Recency score
      |
      v
    recommendationService
      |
      +-- Recommendation boost
      |
      v
    Pagination
      |
      v
    Enrichment
      |
      v
    API response

The current ranking formula is:

    score =
        friendship × 0.35
      + interest   × 0.25
      + engagement × 0.25
      + recency    × 0.15

Engagement considers multiple signals, with stronger emphasis on:

- shares
- comments
- saves
- likes

and weaker supporting signals such as:

- views
- clicks
- watch time

The ranking logic is isolated in feedRanking.js.

feedService.js handles:

- candidate retrieval
- viewer context
- ranking orchestration
- pagination
- enrichment

This separation makes it possible to change the ranking algorithm without rewriting the route layer.

---

# Chat System

The chat subsystem provides public and private real-time rooms.

## Room lifecycle

    Create Room
        |
        +-- Generate room ID
        +-- Validate capacity
        +-- Hash private-room password
        +-- Persist room metadata in MySQL
        +-- Store live room state in Node memory
                 |
                 v
             WebSocket
                 |
          +------+------+
          |             |
       Members       Messages

## Persistent room state

MySQL stores metadata such as:

- room ID
- name
- owner
- visibility
- password hash
- maximum capacity
- current user count

## Live room state

Node memory stores:

- room members
- WebSocket connections
- messages
- polls
- reactions
- pinned-message state

## Chat features

- Public rooms
- Private/password-protected rooms
- Capacity limits
- Message history
- Replies
- Message edits
- Message deletion
- Reactions
- Read receipts
- Pinned messages
- Polls
- Link previews
- Media attachments
- Avatar resolution

Live room state is intentionally cleared during startup because an in-memory room from a previous process cannot represent a currently active WebSocket room.

---

# AI Support Assistant

The AI subsystem uses Gemini as a customer-support assistant.

The flow is:

    User question
         |
         v
    chatbotController
         |
         +-- Validate message
         +-- Score FAQ keywords
         +-- Select relevant FAQ entries
                 |
                 v
            geminiService
                 |
                 +-- System instructions
                 +-- FAQ context
                 +-- Recent conversation history
                 +-- Gemini API
                         |
                         v
                      Response

The local knowledge base is AI_chatbot/faq.json.

Instead of embeddings, the current implementation uses lightweight keyword scoring because the FAQ collection is small enough for that approach.

The chatbot also provides a graceful fallback response when the external AI service is unavailable.

The default model is gemini-2.5-flash, configurable through the environment.

---

# Media Pipeline

The repository contains upload and media services for social content and chat attachments.

Technologies include:

- Multer for uploads
- Sharp for image processing
- FFmpeg integration for video processing
- S3-compatible object storage

Typical image processing:

    Original
       |
       +-- Thumbnail
       +-- Compressed version
       +-- BlurHash
       +-- Original asset

Typical video processing:

    Original video
          |
          +-- 480p
          +-- 720p

The goal is to avoid forcing every client to download the largest representation of an asset.

---

# Representative Data Flows

## Spot order

    Browser
       |
       | HTTP order request
       v
    Express route
       |
       +-- JWT validation
       +-- Order validation
       +-- Balance/business checks
       +-- Durable order persistence
       |
       v
    Spot engine client
       |
       | TCP / JSON lines
       v
    C++ Spot Engine
       |
       +-- Match
       +-- ORDER_ACK
       +-- EXECUTION / book update
       |
       v
    Node event handlers
       |
       +-- Persist execution
       +-- Broadcast WebSocket update
       |
       v
    Browser

## Futures mark-price update

    Binance
       |
       v
    futuresPriceFeed
       |
       | MARK_PRICE_UPDATE
       v
    C++ Futures Engine
       |
       +-- PnL
       +-- Margin
       +-- Liquidation checks
       +-- Position updates
       |
       +----------------------+
       |                      |
       v                      v
    LiveStateStore         Persistence
       |                      |
       v                      v
    WebSocket             MySQL where
    broadcast             persistence is required

## Wallet transfer

    Browser
       |
       v
    POST /api/wallets/transfer
       |
       v
    JWT middleware
       |
       v
    walletTransfer.js
       |
       +-- Acquire dedicated connection
       +-- BEGIN
       +-- Lock wallets in canonical order
       +-- Validate spendable balance
       +-- Debit
       +-- Credit
       +-- COMMIT
       +-- Release connection
       |
       +-- Sync futures engine if required

## Social feed

    Browser
       |
       v
    Social route
       |
       v
    feedService
       |
       +-- Candidate posts
       +-- Author context
       +-- Interest context
       +-- Friendship context
       |
       v
    feedRanking
       |
       v
    recommendationService
       |
       v
    Pagination
       |
       v
    Enrichment
       |
       v
    Browser

---

# Local Development

## Requirements

You will need:

- Node.js
- npm
- MySQL
- MongoDB
- C++20 compiler
- Standalone Asio
- Network access for Binance market data
- Gemini API credentials for the AI assistant
- Object-storage credentials for media features

The current C++ build scripts are configured around a Windows/MSYS2 UCRT64 + g++ environment.

## Install dependencies

    npm install

## Environment configuration

The application loads its main environment configuration from:

    routes/.env

Do not commit this file.

The current code references variables including:

    DB_HOST=
    DB_USERNAME=
    DB_PASSWORD=
    DB_NAME=

    JWT_SECRET_KEY=

    MONGO_URI=

    GEMINI_API_KEY=
    GEMINI_MODEL=gemini-2.5-flash

    TRADE_ENGINE_HOST=127.0.0.1
    TRADE_ENGINE_PORT=9000

    FUTURES_ENGINE_HOST=127.0.0.1
    FUTURES_ENGINE_PORT=9001

Mail and object-storage configuration is also required for the corresponding features.

## Start Node

    npm run dev

Default application URL:

    http://localhost:7070

## Build and run Spot Engine

    npm run spot

This builds the C++ spot engine and starts it.

## Build and run Futures Engine

    npm run futures

This builds the C++ futures engine and starts it.

## Suggested local process layout

    Terminal 1 -> npm run futures
    Terminal 2 -> npm run spot
    Terminal 3 -> npm run dev

The Node application then connects to the two TCP engines.

---

# Security and Consistency

Several parts of the repository explicitly address concurrency and sensitive operations.

### Password hashing

Passwords are hashed with bcrypt before persistence.

### JWT authentication

Protected routes use JWT authentication middleware.

### HTTP-only authentication cookie

The authentication token is stored in a cookie configured for HTTP-only access.

### SQL transactions

Multi-step financial mutations use database transactions.

### Row-level locking

Critical balance operations use SELECT ... FOR UPDATE.

### Canonical wallet locking

Wallet transfers use a fixed lock ordering to reduce deadlock risk.

### Available vs locked holdings

Spot holdings distinguish transferable funds from funds reserved by open orders.

### Engine synchronization

Futures state can be rehydrated from durable MySQL state after engine connectivity changes.

### Event-driven executions

Trading executions are treated as asynchronous events because an order may fill after its original HTTP request has completed.

---

# Architectural Limitations

cordEX.online should currently be considered a **demo/development trading platform**, not a production financial exchange.

Important limitations include:

### 1. Trading engine state is process-local

The C++ engines keep important live state in RAM. Engine restarts require reconciliation/rehydration.

### 2. Single Node application process

The current application is not designed for horizontal scaling across multiple Node instances with shared WebSocket state.

### 3. In-memory chat rooms

Active room state exists in Node memory. Restarting the Node process removes live room state.

### 4. No distributed event broker

There is currently no Kafka, Redis Streams, or equivalent distributed event bus between application components.

### 5. No distributed WebSocket coordination

Multiple Node instances would require shared presence and fan-out infrastructure before the current WebSocket architecture could be horizontally scaled.

### 6. External service dependencies

Live functionality depends on external services such as Binance and Gemini.

### 7. Demo trading model

The platform provides demo funds and should not be interpreted as a real-money exchange or custody platform.

---

# Design Principles

## 1. Separate hot state from durable state

High-frequency calculations belong in memory/engine processes; durable business state belongs in databases.

## 2. Keep financial mutations transactional

Balances, holdings, and transfers should be changed atomically.

## 3. Treat executions as events

A resting order can execute long after its original HTTP request. Execution handling therefore belongs in an event-driven path.

## 4. Isolate ranking logic

Feed ranking is separated from route handlers so ranking algorithms can evolve independently.

## 5. Separate real-time domains

Chat, market data, futures data, and social updates use different WebSocket gateways.

## 6. Let Node orchestrate

Node.js coordinates authentication, persistence, APIs, external services, and clients while C++ focuses on trading-specific computation.

## 7. Rehydrate ephemeral state

Whenever important runtime state exists only in memory, the system should have a path to reconstruct it from durable state.

---

# Project Status

cordEX.online is an evolving engineering project containing implementations for:

- JWT authentication
- Email verification
- Demo wallets
- Wallet transfers
- Spot trading
- Futures trading
- Live market data
- Social profiles
- Posts and media
- Comments and replies
- Likes and bookmarks
- Follow relationships
- Notifications
- Ranked feeds
- Real-time chat
- AI support
- Media processing

The architecture is intentionally modular so individual domains can eventually be extracted into independently deployed services if operational scale requires it.

---

# License

The project currently declares the ISC License in package.json.

---

# Author

**Muneeb Khan**

Built as an engineering project exploring:

- Backend architecture
- Transactional financial systems
- Real-time systems
- C++ to Node.js interoperability
- Database modeling
- Social-platform architecture
- Recommendation systems
- WebSocket systems
- AI-assisted support
