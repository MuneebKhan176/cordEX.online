# cordEX.online — Product, Architecture & Technical Reference

**Document purpose:** One combined non-technical and technical explanation of the cordEX.online project, including how its trading, wallet, realtime, social, chat, notification, and AI-support components connect.

**Repository:** [MuneebKhan176/cordEX.online](https://github.com/MuneebKhan176/cordEX.online)  
**Architecture baseline:** repository `main` branch and project README inspected for this document.  
**Status note:** This describes the implementation documented in the repository. Where a requested capability (especially trading-history RAG/report generation) is not evidenced by the inspected implementation, it is explicitly distinguished from the existing feature rather than presented as completed.

---

# Part I — Non-Technical Overview

## 1. What cordEX.online is

cordEX.online is a demonstration cryptocurrency trading and community platform. It brings several experiences into one product:

- **Trading:** spot orders and futures positions.
- **Wallets:** funding, spot, and futures balances, plus transfers between them.
- **Live market information:** streaming prices and chart data.
- **Community:** profiles, posts, likes, comments, follows, bookmarks, polls, and a ranked feed.
- **Live chat:** public and private rooms with interactive messages.
- **Notifications:** social and application events surfaced to users.
- **AI assistance:** a Gemini-powered support chatbot that uses a local FAQ knowledge base.
- **Media:** upload and media-processing support.

The platform is more than a collection of independent pages. These features share user identity, financial state, live events, and application services. A trade can change an order or position, update a wallet-related view, emit a realtime event, and later become part of the user's historical activity.

## 2. The simplest way to understand the architecture

Think of cordEX.online as a company with four main kinds of responsibility:

1. **The application backend (Node.js/Express)** is the coordinator. It receives browser requests, checks identity and permissions, validates inputs, talks to databases and other services, and returns results.
2. **MySQL** stores important structured account and trading records. It is the durable record for financial/application data such as users, wallets, orders, positions, and transfers.
3. **MongoDB** stores social and content-oriented information, such as profiles, posts, comments, likes, follows, and notifications.
4. **The C++ trading engines** perform the latency-sensitive work of maintaining live order books, matching orders, and updating futures risk state. They are separate processes that the Node backend communicates with over TCP.

The browser is the presentation layer: it displays information and sends user actions to the backend. WebSockets provide a live channel for data that changes frequently, so the browser does not have to repeatedly ask for every update.

## 3. Why there are two databases and two trading engines

### MySQL and MongoDB have different jobs

MySQL is well suited to structured records and multi-step operations that must stay consistent. For example, transferring funds between two wallets should not debit one wallet while failing to credit the other. The backend uses SQL transactions and row locks for such operations.

MongoDB is used for social content, where documents and relationships such as posts, replies, profile data, and reactions are convenient to model and evolve.

This division is useful, but it creates a cross-database boundary: a SQL account and a Mongo social profile cannot be committed as one ordinary database transaction. The application therefore creates the SQL account records first and then creates or repairs the social profile separately.

### Spot and futures are different trading problems

- **Spot trading** concerns buying and selling assets, available and reserved holdings, order books, and executions.
- **Futures trading** also needs to track leveraged positions, margin, unrealized profit/loss, mark prices, funding, take-profit/stop-loss rules, and liquidation conditions.

Both use a separate C++ process so their fast-changing execution state is not handled entirely inside ordinary HTTP route code. Node remains responsible for user-facing APIs and durable persistence.

## 4. A user journey: from account creation to trading

1. A user registers and receives an email verification code.
2. After verification, the backend creates the user, account, and trading wallets in a SQL transaction.
3. It creates the corresponding social profile in MongoDB.
4. The user logs in; the backend issues a JWT in an HTTP cookie.
5. The user opens the dashboard and requests balances, market data, social content, or trading panels.
6. For a trade, the backend validates the request and communicates with the appropriate C++ engine.
7. The engine can return acknowledgements, execution events, or order-book updates.
8. Node processes those messages, persists applicable results, and broadcasts relevant updates to connected clients.
9. Social actions and chat activity use their own domain services and realtime channels, while notifications communicate relevant events back to the user.

This is a conceptual view. Individual endpoint details and ordering depend on the specific operation.

## 5. How the social system works

The social system gives a trading application a community layer. Users can have profiles, publish posts, attach media, follow other users, react to posts, comment, bookmark content, and interact with polls or market-related posts.

The feed does not simply return posts in database order. The documented design retrieves candidate posts, builds viewer context, scores the candidates, applies recommendation adjustments, paginates, and enriches the result for display.

The documented feed score is:

- Friendship/context: 35%
- Interests: 25%
- Engagement: 25%
- Recency: 15%

Engagement includes stronger signals such as shares, comments, and saves, with views, clicks, and watch time acting as supporting signals. These scores help order content; they do not guarantee that a post is accurate or financially sound.

## 6. How chat rooms work

Chat has a separate realtime gateway and room manager, so a busy chat room does not need to share the same message path as market-price updates.

A room has two kinds of state:

- **Saved room metadata:** room ID, name, owner, visibility, password hash where applicable, capacity, and related details are stored in MySQL.
- **Live room state:** connected members, WebSocket connections, current messages and interaction state are managed in Node memory.

The documented feature set includes public and private rooms, capacity limits, message history, replies, edits/deletions, reactions, read receipts, pinned messages, polls, link previews, and media attachments.

A key distinction: room metadata can survive a process restart, but active WebSocket connections cannot. In-memory membership and other live room state must be rebuilt when users reconnect.

## 7. How notifications fit in

Notifications connect actions to awareness. A follow, like, comment, or other supported event can create a notification record, and the social WebSocket layer can propagate relevant events to a connected client.

Conceptually, the process is:

**Action → domain validation → event/notification creation → persistence → realtime delivery (when connected) → notification display.**

Realtime delivery and durable notification storage solve different problems. A WebSocket message is a quick live update; a stored notification is what lets the application show the event after the recipient has been offline. Exact notification triggers and delivery guarantees depend on the implemented handler for each event.

## 8. AI support versus trading-history analysis

The current repository README documents a **Gemini support chatbot**. It retrieves relevant entries from `AI_chatbot/faq.json` using keyword scoring, then supplies selected FAQ context, system instructions, and recent conversation history to Gemini.

This is a lightweight retrieval-augmented support flow, but it is **not the same as a full semantic-vector RAG system over personal trading history**. The inspected documentation does not establish that the chatbot currently retrieves a user's full trading ledger, builds embeddings over trading records, or generates personalized performance reports from those records.

A genuine trading-history analysis/report feature would need an additional, explicit data pipeline: authorize the requesting user, retrieve only that user's relevant SQL trading records, calculate verified metrics, prepare a bounded and well-structured context, ask the model to explain the results, and return a report with traceable numbers and limitations. It should never let the model invent balances, fills, fees, PnL, or risk metrics. The detailed technical section explains this distinction and a safe integration design.

---

# Part II — Technical Architecture

## 9. Technology stack

| Layer | Technology | Responsibility |
|---|---|---|
| Web application | Node.js, Express 5 | HTTP routes, application orchestration, validation, authentication integration |
| Frontend | HTML, CSS, browser JavaScript | Pages and interactive trading, wallet, social, and chat interfaces |
| Relational database | MySQL via `mysql2` | User/account records, wallets, orders, positions, transfers, and room metadata |
| Document database | MongoDB via Mongoose | Social profiles and content-oriented documents |
| Authentication | JWT, bcrypt/bcryptjs, cookies | Password verification, identity tokens, protected routes |
| Email | Nodemailer / project mailer | Registration verification email |
| Realtime transport | `ws` WebSocket library | Market, futures, social, and chat realtime connections |
| Spot engine | C++20, Standalone Asio, TCP | Order book and spot matching behavior |
| Futures engine | C++20, TCP | Live futures state and risk-related calculations |
| Market feed | External exchange WebSocket/API integration | Upstream prices and chart data, including Binance market data |
| AI support | Gemini API | Natural-language answers grounded in selected FAQ context |
| Media support | Multer, Sharp, FFmpeg integration, S3-compatible SDK | Upload handling, image/media processing, and object storage integration |

Configuration, credentials, endpoints, and model selection should be read from environment/configuration files; secrets must not be embedded in source code.

## 10. Repository map

The following paths are documented in the repository README and provide the main architectural landmarks:

- `web.js` — application entry point and service wiring.
- `db_connection.js` — MySQL pool and database configuration.
- `routes/authRoutes.js` — registration, verification, login, dashboard data, and logout.
- `middle/middleware.js` — JWT authentication middleware.
- `Wallets_Config/` — wallet creation, transfer logic, IDs, and spot-holding locks.
- `Spot_Engine/` — C++ spot engine and Node TCP client.
- `Futures_Engine/` — C++ futures engine, bootstrap, price feed, live state, persistence, and rehydration.
- `Web_Sockets/` — WebSocket manager and market/futures/chat gateways.
- `Social_Platform/` — social models, posts, profiles, follows, insights, notifications, feed and socket logic.
- `chat/` — chat authentication, database helpers, handlers, managers, and services.
- `routes/` — HTTP route modules for wallets, spot, futures, chat rooms, uploads, and WebSocket authentication.
- `AI_chatbot/` — `chatbotController.js`, `geminiService.js`, `faq.json`, and dependency requirements.
- `Frontend/` — authentication, trading panels, wallets, social square, chat rooms, and dashboard UI.

This is a module map, not a claim that every folder is an independently deployed microservice. The repository is best understood as a **modular monolith plus separate native engine processes**.

## 11. Runtime topology and module relationships

```text
Browser
  | HTTP / REST
  | WebSocket upgrades
  v
Node.js / Express — web.js (port 7070)
  |
  +-- Authentication / authorization
  +-- Wallet and transfer routes/services
  +-- Spot routes ---------------- TCP :9000 ----------------> C++ Spot Engine
  +-- Futures routes ------------- TCP :9001 ----------------> C++ Futures Engine
  +-- Market WebSocket gateway <------ upstream market feed
  +-- Futures WebSocket gateway <----- futures engine events
  +-- Social routes/services -------> MongoDB
  +-- Notification/social sockets
  +-- Chat routes + room manager ---> MySQL room metadata
  +-- AI support controller --------> FAQ retrieval + Gemini API
  +-- Media upload / processing ----> object storage / media tools

MySQL: users, accounts, wallets, orders, positions, transfers, room metadata
MongoDB: social profiles, posts, comments, likes, follows, bookmarks, notifications
C++ RAM: live order books and futures calculations
Node RAM: WebSocket connections, chat-room membership, transient coordination
```

The important engineering boundary is that **transport, live state, and durable state are not interchangeable**. A WebSocket event is not a database commit; an in-memory order book is not a durable order ledger; a Mongo profile is not the authoritative financial account.

## 12. Application server and initialization

The documented `web.js` entry point connects to MongoDB, creates the Express application, registers HTTP routes, serves frontend assets/uploads, attaches WebSocket gateways, bootstraps the futures subsystem, initializes the chat manager, and starts the HTTP server on port 7070.

The application uses a central WebSocket manager to route upgrades to separate domain gateways. This avoids coupling every feature to one giant socket handler and lets each domain define its own message types and lifecycle.

Initialization order matters: database connectivity and engine clients must be available before dependent modules rely on them. The 404 handler belongs after feature route registration so it does not intercept valid routes.

## 13. Authentication and account provisioning

### Registration and verification

The documented flow is:

1. Validate submitted fields.
2. Hash the password using bcrypt/bcryptjs.
3. Create a pending-user record with a verification code and expiry.
4. Send the code by email.
5. Validate the submitted code and expiry.
6. Acquire one dedicated MySQL connection.
7. Begin a SQL transaction and create the user, account, spot/futures wallets, and default USDT holding.
8. Remove the pending record and commit the transaction.
9. Create/upsert the MongoDB social profile after the SQL commit.
10. Issue a JWT cookie.

The code in `routes/authRoutes.js` documents a ten-minute verification-code lifetime. SQL user/account/wallet creation is atomic within MySQL. Mongo profile creation occurs afterward, so it is not part of that SQL transaction; the dashboard path includes a self-healing upsert to repair a missing profile.

### Login and route protection

Login looks up the user, compares the submitted password with the bcrypt hash, signs a JWT containing the user ID/email/username, and sets the `token` cookie. Protected routes use the JWT middleware to establish the requester identity.

**Deployment hardening:** the inspected route currently sets the cookie with `secure: false` for localhost development and a one-day login token expiry. Production must use HTTPS and secure cookie settings; token expiry, logout invalidation, CSRF posture, rate limiting, and secret management should be reviewed before real-money use. The documented demo balance endpoint is a simulation feature, not a real deposit rail.

## 14. Database ownership and consistency

### MySQL

MySQL is the primary durable store for consistency-sensitive financial and application records, including users, accounts, wallet balances/holdings, orders, positions, transfers, and chat-room metadata.

The code uses a connection pool for ordinary queries. Multi-statement transactions must check out one physical connection, issue BEGIN/COMMIT/ROLLBACK on that connection, and release it in a `finally` block. Using a pool object as if it were a dedicated transaction connection is incorrect because separate queries may execute on different connections.

### MongoDB

MongoDB/Mongoose stores social profiles, posts, media references, comments/replies, follows, likes, bookmarks, polls, hashtags, activity, and notifications.

Because SQL and MongoDB do not share one local transaction, the application relies on ordered writes and repair/upsert behavior at integration boundaries. This is a form of eventual consistency, not a distributed atomic commit.

### Cross-store design rule

Store a stable user identifier in both stores. Treat SQL as the authority for account identity and financial state; treat Mongo as the authority for social documents. Any operation spanning both must define what happens if the second write fails and how it is repaired.

## 15. Wallet model and safe transfers

The logical wallet model consists of:

- **Funding wallet/account balance:** primary account-level balance.
- **Spot wallet:** asset holdings split into available and locked quantities.
- **Futures wallet:** durable futures collateral/balance, coordinated with the live futures engine.

For spot holdings, available quantity can be spent or transferred; locked quantity is reserved for open orders. That distinction prevents the same asset units from being simultaneously spent and reserved.

Wallet transfers follow a transactional pattern:

1. Begin a MySQL transaction.
2. Lock the required wallet rows.
3. Validate the source's spendable balance.
4. Debit the source and credit the destination.
5. Commit, or roll back on failure.
6. Synchronize the futures engine when the affected wallet requires it.

The documented lock order is canonical—funding, then spot, then futures—regardless of transfer direction. Consistent lock ordering reduces deadlock risk. For robust financial accounting, all balance-changing paths should also be idempotent where retried, have durable transaction references, and be reconciled against fills and ledger entries.

## 16. Spot trading engine

### Responsibilities

The spot engine is a separate C++ process, with a default local TCP endpoint of `127.0.0.1:9000`. Node communicates through `Spot_Engine/engineClient.js`.

**Node owns:** user authentication, authorization, request validation, business rules, durable persistence, HTTP APIs, and browser-facing event delivery.

**C++ owns:** in-memory order books, matching/execution logic, MARKET and LIMIT order handling, OCO-related execution behavior, and engine-level checks.

The C++ engine does not directly access MySQL. This isolates matching logic from database-driver concerns and the Node request lifecycle.

### TCP protocol and event handling

The protocol uses newline-delimited JSON. Node sends commands such as `PLACE_ORDER`; the engine can emit an acknowledgement, execution event, and order-book update. One request may therefore lead to multiple lines/messages, and the client must not assume one TCP response equals one complete request/response pair.

The shared client maintains a persistent TCP connection, request IDs, pending-request tracking, queued writes, timeouts, reconnection behavior, and asynchronous event handling.

### Important state limitation

The order book is documented as RAM-only. On process restart, the in-memory book is lost. Durable open orders must be reconciled with persisted SQL orders and restored/re-submitted safely. A production-grade engine should define a deterministic recovery protocol and ensure replay cannot duplicate fills.

### Conceptual order path

```text
Browser submits order
  -> Express route authenticates and validates
  -> Node client sends newline-delimited JSON over TCP
  -> C++ engine validates/matches against live order book
  -> ACK / execution / book-update messages
  -> Node correlates request replies and handles asynchronous events
  -> applicable execution/order records are persisted
  -> WebSocket gateway broadcasts relevant updates
  -> browser refreshes order, balance, and market views
```

Exact persistence sequencing and rollback behavior must be confirmed per handler before treating this conceptual path as an exchange-grade atomic execution guarantee.

## 17. Futures trading engine

The futures engine runs as a separate C++ process, with a documented default endpoint of `127.0.0.1:9001`. Its Node-side integration is split across:

- `futuresEngineClient.js`
- `futuresBootstrap.js`
- `futuresPriceFeed.js`
- `futuresRehydrate.js`
- `LiveStateStore.js`
- `futures_Persistence.js`
- `futuresWalletMerge.js`

### Why the futures engine is more complex

A futures position is not simply an asset holding. Its risk depends on position size and direction, leverage, entry/mark prices, margin, unrealized PnL, funding, and liquidation thresholds. The engine maintains fast-changing state in memory to calculate these values without forcing every market tick to become a synchronous SQL transaction.

### Price and mark-price paths

The documented price feed sends `PRICE_UPDATE` for matching and `MARK_PRICE_UPDATE` for PnL, margin, and liquidation calculations. The README describes approximate one-second price ticks and two-second mark-price ticks. Those are implementation defaults, not a universal guarantee of exchange-grade freshness.

### Request/response versus push messages

Request/response commands include `PLACE_ORDER` and `CANCEL_ORDER`. Push-style messages include `PRICE_UPDATE`, `MARK_PRICE_UPDATE`, `FUNDING_TICK`, `UPDATE_TP_SL`, `SYNC_WALLET`, and `SYNC_POSITION`.

This distinction is essential: a high-frequency update is often a one-way state update, while an order placement needs a correlated response.

### Rehydration after restart

The engine's RAM state can be reconstructed from durable SQL state through `futuresRehydrate.js` and synchronization messages such as `SYNC_WALLET` and `SYNC_POSITION`. The engine then resumes live calculations and emits updates.

Recovery must reconcile database records and engine state before accepting new risk. Persisted state should be treated as the restart baseline, and live events should be applied in a controlled, idempotent way.

## 18. Realtime WebSocket network

`Web_Sockets/ws_manager.js` is the central gateway manager. The README describes distinct gateways for:

- Market data
- Futures updates
- Social events
- Chat rooms

### Market data gateway

`marketData_ws.js` maintains an upstream market-data connection and distributes normalized information to browser clients, including tickers, K-lines, live prices, and snapshots. Clients connect to cordEX's gateway rather than each creating their own upstream market connection. This centralizes feed management and fan-out.

### Futures gateway

The futures socket distributes engine-derived updates such as positions, margin, PnL, liquidation events, and order-book information to subscribed clients. The UI can react immediately without polling the REST API for each small change.

### Social gateway

The social socket layer propagates supported events such as likes, follows, comments, posts, and notifications. Durable social records live in MongoDB; sockets are the realtime delivery channel.

### Operational concerns

WebSockets require connection authentication, heartbeat/ping-pong handling, disconnect cleanup, subscription validation, and bounded fan-out. The market-data implementation documents heartbeat checks. Sensitive events must be sent only to authorized users/rooms; public market broadcasts and private account updates need different authorization rules.

## 19. Social subsystem and feed ranking

The social layer is implemented primarily with MongoDB/Mongoose and organized under `Social_Platform/`.

### Main entities

- Social profile
- Post and media attachment
- Comment and reply
- Follow relationship
- Like and bookmark
- Poll and hashtag
- User activity
- Notification

Posts can include text, images/video, hashtags, polls, market sentiment, and optional trading-signal information. Denormalized counters track engagement such as likes, comments, views, shares, saves, clicks, and watch time.

### Feed ranking pipeline

The documented pipeline separates responsibilities:

1. A route receives the feed request.
2. `feedService` retrieves candidate posts and context.
3. `feedRanking` scores candidates.
4. `recommendationService` applies recommendation boosts.
5. Pagination selects the requested slice.
6. Enrichment adds the data the UI needs.
7. The API returns the ordered feed.

The documented formula is:

```text
score =
    friendship × 0.35
  + interest   × 0.25
  + engagement × 0.25
  + recency    × 0.15
```

The separation means scoring can evolve without rewriting route handlers. Counters and ranking scores are product signals, not proof of investment quality or trustworthiness.

## 20. Notification system

The repository documents `Social_Platform/notifications.js` and social socket support. At the architecture level, notifications are the durable/social layer's representation of events that matter to a user; WebSockets make them visible quickly while the recipient is connected.

A well-defined notification event should identify:
- The recipient
- The actor, if any
- The event type
- The relevant object (post, comment, follow, etc.)
- Creation time and read/unread state
- A link or payload sufficient for the UI to open the relevant context

Typical integration points include social actions, such as follows, likes, and comments, and event broadcasting through the social gateway. Exact triggers should be traced in each handler rather than assumed from the existence of the module.

To avoid duplicate notifications under retries, event creation should be idempotent or carry a unique event key. Notification creation should not be considered successful merely because a socket message was sent.

## 21. Chat architecture in depth

### HTTP and WebSocket roles

HTTP routes create rooms, fetch metadata/history, and handle operations suited to request/response. WebSockets carry interactive live messages and room events. `routes/chatRoom_Routes.js`, `Web_Sockets/chatrooms_ws.js`, and the `chat/` modules divide route, authentication, database, handler, manager, and service responsibilities.

### Room creation and access

The documented room lifecycle includes generating a room ID, validating capacity, hashing a private-room password when applicable, saving room metadata to MySQL, and adding the live room to Node's in-memory manager.

Private-room password hashes—not plaintext passwords—should be persisted. A successful room lookup alone must not grant membership; the join path must validate room visibility, credentials, capacity, and the user's authenticated identity.

### Live interaction

The documented room features include message history, replies, edit/delete, reactions, read receipts, pinned messages, polls, link previews, and media attachments. The manager tracks connected users and active room state, while handlers/services implement individual operations.

### Restart and scaling boundary

In-memory membership and socket references are process-local. Restarting Node clears live state; users reconnect and room state is rebuilt. Running multiple Node instances would require a shared coordination/pub-sub layer and a strategy for routing messages to users connected to different instances. Without that, a room's live membership cannot be assumed to be globally consistent across instances.

## 22. AI support assistant: what exists today

The documented files are:

- `AI_chatbot/chatbotController.js`
- `AI_chatbot/geminiService.js`
- `AI_chatbot/faq.json`

The documented flow is:

1. The controller validates the user's message.
2. It scores FAQ entries using lightweight keyword matching.
3. It selects relevant FAQ items.
4. It combines those items with system instructions and recent conversation history.
5. It calls Gemini (the README lists `gemini-2.5-flash` as the default configurable model).
6. It returns the model's answer, with a fallback when the external AI service is unavailable.

Because the knowledge base is a small FAQ file, keyword scoring is a reasonable simple retrieval approach. It is retrieval-augmented in the broad sense that retrieved FAQ text grounds the model's response, but it is not a vector-database implementation.

### What should not be claimed without further code evidence

The inspected README does not document a personal trading-history RAG pipeline, embeddings, vector index, per-user ledger retrieval, or a reporting service. The presence of a Gemini chatbot does not by itself prove that it can answer a user's actual performance questions from SQL records.

## 23. Designing a real trading-history RAG/report feature

This section is an architectural design for the requested capability, not a claim that it is already implemented.

### Recommended separation: calculate first, explain second

Trading history contains exact financial facts. Do not ask an LLM to calculate the source of truth from loosely formatted records. Use deterministic code for metrics and let the model explain the verified results.

**A. Identity and authorization**
- Require the user's authenticated identity from trusted middleware.
- Never accept an arbitrary user ID from the prompt as authorization.
- Scope every query to the authenticated user.
- Exclude other users' orders, balances, private positions, and social data.

**B. Structured SQL retrieval**
- Query the user's relevant orders, fills/trades, fees, realized PnL, funding payments, and position records from MySQL.
- Apply a requested date range and explicit limits.
- Use parameterized SQL and pagination.
- Distinguish order submissions from actual fills; an unfilled order is not a completed trade.
- Use the most authoritative durable records available for each metric.

**C. Deterministic metrics service**
Calculate and validate figures in application code or SQL, including only metrics whose source data is reliable:
- Number of filled trades and traded volume
- Realized PnL, fees, and funding paid/received
- Win/loss counts under a clearly stated definition
- Average win/loss and largest gain/loss
- Performance over time, if the required timestamps and valuation data exist

Unrealized PnL requires an appropriate current or historical mark price. Return “unavailable” when required source data is missing; do not substitute a guess. Define whether values are gross or net of fees and funding.

**D. Context preparation / retrieval**
- Convert verified records and metrics into bounded, typed context.
- For questions about specific trades, retrieve the relevant trade/fill rows and their timestamps.
- For narrative explanations, retrieve only the small subset relevant to the question.
- If semantic retrieval over large historical notes or journal text is needed, embeddings and a vector index may help. They are not necessary for basic SQL-based numeric reporting.
- Keep retrieval results separate from system instructions; treat user-provided text and stored notes as untrusted data.

**E. Model explanation**
- Give Gemini a clear task and a structured JSON payload of verified metrics.
- Instruct it to explain patterns without changing the numeric facts.
- Ask it to label correlations as observations, not causal proof or guaranteed future predictions.
- Require the model to state data coverage and missing fields.
- Validate the output schema and check that any quoted totals match the computed metrics.

**F. Report response**
Return a structured report such as:
- Reporting period and data coverage
- Summary of activity
- Verified performance metrics
- Observed patterns and examples with trade references
- Risk/limitations section
- Clear distinction between historical analysis and financial advice

### Proposed architecture

```text
Authenticated request
  -> Trading-history report route
  -> User-scoped SQL query service
  -> Deterministic metrics/calculation service
  -> Context builder (bounded, typed, redacted)
  -> Optional semantic retrieval for unstructured notes
  -> Gemini explanation
  -> Output/schema and numeric validation
  -> Report response + optional report persistence
```

### Why this is safer than “send all history to the model”

It limits token cost, prevents cross-user data exposure, gives exact numbers a deterministic source, keeps prompts bounded, makes results easier to test, and avoids treating an LLM as a ledger or trading engine. A vector database should only be introduced if there is a real semantic retrieval need; structured trading records are usually best queried directly from SQL.

## 24. Media and upload subsystem

The repository README identifies upload/media support using Multer, Sharp, FFmpeg integration, and an S3-compatible SDK. These pieces serve different purposes:

- Multer handles incoming multipart uploads in the Node application.
- Sharp supports image transformation.
- FFmpeg supports video/audio processing tasks.
- An S3-compatible SDK connects to object storage for media files.

The exact file lifecycle, size limits, processing queues, and cleanup guarantees should be checked in the upload routes and worker code before relying on specific operational guarantees. Large media should generally be stored as objects and referenced by keys/metadata rather than copied into database rows.

## 25. End-to-end connections between domains

### A. Order placement

```text
Trading UI -> Express route -> auth/validation -> TCP engine client
           -> C++ matching engine -> acknowledgement/execution events
           -> Node event handling -> SQL persistence
           -> relevant WebSocket broadcasts -> trading UI
```

The order API, C++ engine, SQL records, and socket updates must agree on order IDs, execution IDs, status transitions, and failure recovery. A response acknowledgement is not necessarily the same thing as a completed fill.

### B. Futures price update

```text
Upstream market feed -> futuresPriceFeed.js
                     -> C++ futures engine
                     -> mark price / PnL / margin / liquidation calculations
                     -> event/persistence integration
                     -> futures WebSocket gateway
                     -> subscribed browser panels
```

The feed, engine calculations, persistence, and client display have different timing. The UI should show freshness/status where it matters and should not imply a value is current if the feed is disconnected.

### C. Social interaction and notification

```text
User action -> social route/service -> validate actor/object
            -> write social record in MongoDB
            -> create applicable notification record
            -> publish socket event when appropriate
            -> recipient UI updates
```

This sequence is a domain-level model. The exact ordering and error handling should be verified per action; a socket event should not be the only record of an important notification.

### D. Chat message

```text
Client joins authenticated room WebSocket
  -> room manager validates room membership
  -> message handler validates payload and permissions
  -> persistence/history operation where implemented
  -> room fan-out to connected members
  -> reconnecting clients retrieve appropriate history
```

Live fan-out and saved history are separate concerns. If a message is only held in memory, it cannot be assumed to survive a process restart.

### E. AI support question

```text
Question -> chatbotController -> FAQ keyword retrieval
         -> prompt/context construction -> Gemini
         -> fallback/error handling -> answer to client
```

The current documented FAQ retrieval should not be conflated with personal trade-history retrieval. A history report requires the separate authorized SQL/metrics/context pipeline described above.

## 26. Reliability, security, and consistency considerations

The following are key architecture boundaries to protect:

1. **Authentication is not authorization.** A valid JWT proves identity, not permission to access every room, order, wallet, profile, or report.
2. **SQL transactions are local to one SQL connection.** Cross-store SQL/Mongo operations need repair logic and observability.
3. **Engine memory is volatile.** Spot order books and futures live state need recovery/reconciliation after restarts.
4. **Events can be duplicated or missed.** Use stable IDs, idempotent handlers, durable records, and reconciliation for important financial events.
5. **WebSockets are delivery channels, not sources of truth.** Persist important state independently and authorize subscriptions.
6. **Chat memory is process-local.** Multi-instance deployments need shared realtime coordination if rooms span instances.
7. **AI output is not financial truth.** Numeric reports should originate in deterministic calculations and be validated before being shown.
8. **Media processing needs limits.** Validate file type/size, isolate FFmpeg processing, constrain resource use, and control object-storage access.
9. **Production cookies and secrets need hardening.** Use HTTPS, secure cookies, safe secret storage, rate limits, and explicit CSRF strategy.
10. **Demo trading is not a production exchange.** Real-money readiness would require substantially stronger financial accounting, engine recovery, market-data resilience, operational monitoring, and independent security review.

## 27. Architecture summary

cordEX.online is a modular monolithic web application connected to two native C++ trading processes. Node.js/Express coordinates the user-facing application, MySQL holds structured financial state, MongoDB holds social content, and WebSockets deliver changing market, futures, social, and chat events. The spot and futures engines separate latency-sensitive trading logic from ordinary web request handling.

The strongest way to understand the system is to follow ownership:

- **Identity and application orchestration:** Node.js/Express
- **Durable financial records:** MySQL
- **Social/content records:** MongoDB
- **Spot matching state:** C++ spot engine
- **Live futures risk state:** C++ futures engine, with SQL-backed rehydration
- **Realtime delivery:** WebSocket gateways
- **Chat membership and live room state:** Node process memory, with persistent room metadata in MySQL
- **Current AI support retrieval:** keyword-scored FAQ entries plus Gemini
- **Personal trading-history reports:** requires a separate, explicitly authorized SQL retrieval and deterministic metrics pipeline unless further implementation code proves it already exists

This separation makes the project easier to reason about: each module has a primary responsibility, while the integration points—database transactions, engine TCP messages, WebSocket events, and cross-database profile creation—are where consistency and reliability deserve the most attention.
