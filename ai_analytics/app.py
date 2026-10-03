import hmac
import logging
import time
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from . import tools
from .config import settings
from .db import GENERIC_ERROR, ToolError

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)
log = logging.getLogger("ai_analytics.app")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    log.info("Starting analytics service (DB %s:%s/%s as %s)",
             settings.db_host, settings.db_port, settings.db_name, settings.db_user)
    if tools.db.check_connection():
        log.info("Startup check PASSED: database and all required tables reachable.")
    else:
        log.error("Startup check FAILED: fix the errors above. Tool calls will return errors until then.")
    yield


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


def require_service_auth(x_internal_secret: str = Header(default="")):
    ok = hmac.compare_digest(
        x_internal_secret.encode("utf-8"), settings.internal_secret.encode("utf-8")
    )
    if not ok:
        log.warning("Rejected request: X-Internal-Secret does not match AI_INTERNAL_SERVICE_SECRET "
                    "(Node and Python .env values differ?)")
        raise HTTPException(status_code=401, detail="Unauthorized")


class Args(BaseModel):
    model_config = ConfigDict(extra="forbid")
    days: int = Field(30, ge=1, le=365)
    symbol: Optional[str] = Field(None, pattern=r"^[A-Za-z0-9]{2,20}$")
    limit: int = Field(20, ge=1, le=50)


class ToolRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: str = Field(..., pattern=r"^[A-Za-z0-9_-]{1,20}$")
    args: Args = Field(default_factory=Args)


@app.get("/health")
def health():
    return {"db": "ok" if tools.db.check_connection() else "error"}


@app.post("/v1/tool/{name}", dependencies=[Depends(require_service_auth)])
def run_tool(name: str, req: ToolRequest):
    fn = tools.TOOLS.get(name)
    if fn is None:
        log.warning("Unknown tool requested: %s", name)
        raise HTTPException(status_code=404, detail="Unknown tool")
    t0 = time.perf_counter()
    try:
        data = fn(req.user_id, req.args)
        log.info("tool=%s user=%s OK (%.0f ms)", name, req.user_id, (time.perf_counter() - t0) * 1000)
        return {"success": True, "data": data}
    except ToolError as e:
        log.error("tool=%s user=%s FAILED: %s", name, req.user_id, e)
        return {"success": False, "error": str(e)}
    except Exception:
        log.exception("tool=%s user=%s crashed with an unhandled error", name, req.user_id)
        return {"success": False, "error": GENERIC_ERROR}