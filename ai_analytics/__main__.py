"""Start the analytics service:   python -m ai_analytics      (run from the repo root)

Host and port are taken from AI_ANALYTICS_SERVICE_URL in routes/.env — the same
variable the Node app calls — so the two can never disagree. Any configuration
problem is printed in plain words instead of dying silently."""
import os
import sys
from pathlib import Path
from urllib.parse import urlparse


def main() -> int:
    env_file = Path(__file__).resolve().parent.parent / "routes" / ".env"
    print(f"[ai_analytics] reading env from: {env_file}  (exists: {env_file.exists()})")

    try:
        from .config import settings  # noqa: F401  (validates env, loads .env)
        from .app import app
    except RuntimeError as e:
        print(f"[ai_analytics] CONFIG ERROR: {e}", file=sys.stderr)
        print("[ai_analytics] Fix routes/.env (or move the ai_analytics folder to the repo root) and retry.",
              file=sys.stderr)
        return 1
    except ModuleNotFoundError as e:
        print(f"[ai_analytics] MISSING PACKAGE: {e}. Run: pip install -r ai_analytics/requirements.txt",
              file=sys.stderr)
        return 1

    import uvicorn

    url = urlparse(os.environ.get("AI_ANALYTICS_SERVICE_URL", "http://127.0.0.1:8001"))
    host = url.hostname or "127.0.0.1"
    if host == "localhost":
        host = "127.0.0.1"  # Node connects to 127.0.0.1 too (avoids the ::1 vs 127.0.0.1 mismatch)
    port = url.port or 8001

    print(f"[ai_analytics] listening on http://{host}:{port}  (Node must call exactly this address)")
    uvicorn.run(app, host=host, port=port, log_level="info")
    return 0


if __name__ == "__main__":
    sys.exit(main())