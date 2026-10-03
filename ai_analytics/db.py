import logging
import re
import time
from datetime import date, datetime
from decimal import Decimal

import pymysql
import pymysql.cursors

from .config import settings

log = logging.getLogger("ai_analytics.db")

GENERIC_ERROR = "Unable to retrieve trading data."

REQUIRED_TABLES = [
    "ai_futures_positions", "ai_futures_trades",
    "ai_futures_funding", "ai_spot_trades",
]


class ToolError(Exception):
    """Message is safe to show to the LLM / end user."""


_USER_FILTER = re.compile(r"\buser_id\s*=\s*%s")


def _clean(value):
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return value


def explain_db_error(e: Exception) -> str:
    """Turn a PyMySQL error into a precise, developer-facing hint (console only)."""
    code = e.args[0] if e.args and isinstance(e.args[0], int) else None
    msg = e.args[1] if len(e.args) > 1 else str(e)
    s = settings
    hints = {
        2002: f"Cannot reach MySQL at {s.db_host}:{s.db_port}. Is MySQL running? Check AI_DB_HOST / AI_DB_PORT.",
        2003: f"Cannot connect to MySQL at {s.db_host}:{s.db_port}. Is MySQL running / port correct / firewall?",
        1045: f"Access denied for '{s.db_user}'. Wrong AI_DB_USER/AI_DB_PASSWORD, or the user does not exist for this host "
              f"(create it for both 'localhost' and '127.0.0.1'). If the password contains '#', quote it in .env.",
        1044: f"User '{s.db_user}' has no access to database '{s.db_name}'. GRANT SELECT ON `{s.db_name}`.* TO '{s.db_user}'@'localhost';",
        1049: f"Database '{s.db_name}' does not exist. Check AI_DB_NAME.",
        1142: f"SELECT not granted to '{s.db_user}' on a table used here. Run GRANT SELECT ON `{s.db_name}`.<table> ...; FLUSH PRIVILEGES;",
        1143: f"SELECT not granted to '{s.db_user}' on a column used here.",
        1146: f"A table used by this query does not exist in `{s.db_name}`. Check the table names / run your schema SQL on this database.",
        1054: "The query uses a column that does not exist in your table. Compare the column names with your schema.",
        1064: "SQL syntax error in the developer-written query.",
        2006: "MySQL server has gone away. Retry; check wait_timeout / MySQL restarts.",
        2013: "Lost connection to MySQL during the query (timeout or crash).",
    }
    hint = hints.get(code, "Unclassified MySQL error.")
    return f"MySQL error {code}: {msg} -> {hint}"


class ReadOnlyDB:
    """Executes developer-written, parameterized SELECTs as the restricted
    AI database user. It never accepts SQL from the LLM or from HTTP input."""

    def _connect(self):
        try:
            conn = pymysql.connect(
                host=settings.db_host,
                port=settings.db_port,
                user=settings.db_user,
                password=settings.db_password,
                database=settings.db_name,
                cursorclass=pymysql.cursors.DictCursor,
                charset="utf8mb4",
                connect_timeout=5,
                read_timeout=10,
                autocommit=True,
            )
        except RuntimeError as e:
            # PyMySQL raises RuntimeError (not MySQLError) when 'cryptography' is missing.
            if "cryptography" in str(e):
                log.error("[DB] connect failed: %s -> run: pip install cryptography "
                          "(needed for MySQL 8 caching_sha2_password auth)", e)
            raise
        with conn.cursor() as cur:
            cur.execute("SET SESSION TRANSACTION READ ONLY")
        return conn

    def check_connection(self) -> bool:
        """Step-by-step startup diagnostics. Never raises."""
        s = settings
        log.info("[DB] Checking connection: %s@%s:%s/%s", s.db_user, s.db_host, s.db_port, s.db_name)
        try:
            conn = self._connect()
        except pymysql.MySQLError as e:
            log.error("[DB] CONNECT FAILED. %s", explain_db_error(e))
            return False
        except Exception as e:
            log.error("[DB] CONNECT FAILED (non-MySQL error): %s: %s", type(e).__name__, e)
            return False

        ok = True
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT CURRENT_USER() AS u, DATABASE() AS d, VERSION() AS v")
                row = cur.fetchone()
                log.info("[DB] Connected OK as %s, database=%s, MySQL %s", row["u"], row["d"], row["v"])
                for t in REQUIRED_TABLES:
                    try:
                        cur.execute(f"SELECT 1 FROM `{t}` LIMIT 1")
                        cur.fetchall()
                        log.info("[DB] table %-24s OK", t)
                    except pymysql.MySQLError as e:
                        ok = False
                        log.error("[DB] table %-24s FAILED. %s", t, explain_db_error(e))
        finally:
            conn.close()
        return ok

    def fetch_for_user(self, sql: str, user_id: str, params=()):
        s = sql.strip()
        if not s.upper().startswith("SELECT") or ";" in s:
            raise RuntimeError("Only single SELECT statements are allowed")
        m = _USER_FILTER.search(s)
        if not m or s.find("%s") != m.end() - 2:
            raise RuntimeError("Query must filter on `user_id = %s` as its first placeholder")

        started = time.perf_counter()
        label = re.sub(r"\s+", " ", s)[:110]
        try:
            conn = self._connect()
            try:
                with conn.cursor() as cur:
                    cur.execute(s, (user_id, *params))
                    rows = cur.fetchall()
            finally:
                conn.close()
        except pymysql.MySQLError as e:
            log.error("[DB] query FAILED (user_id=%s) %s | %s", user_id, label, explain_db_error(e))
            raise ToolError(GENERIC_ERROR)

        log.info("[DB] query OK (user_id=%s) %d rows in %.0f ms | %s",
                 user_id, len(rows), (time.perf_counter() - started) * 1000, label)
        return [{k: _clean(v) for k, v in row.items()} for row in rows]