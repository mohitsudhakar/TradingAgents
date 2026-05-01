"""FastAPI app — REST + WebSocket front for the analysis runner."""

from __future__ import annotations

import asyncio
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from tradingagents import portfolio
from tradingagents.llm_clients.model_catalog import MODEL_OPTIONS
from tradingagents.universe import universe_for_api

from . import batch_storage, storage
from .batch_runner import BatchRunner, build_batch
from .exports import batch_to_docx, session_to_docx
from .runner import (
    ANALYST_AGENT_NAMES,
    ANALYST_ORDER,
    FIXED_TEAMS,
    SECTION_AGENT,
    SessionRunner,
    build_session,
)

load_dotenv()
load_dotenv(".env.enterprise", override=False)

PROVIDERS = [
    {"key": "openai", "label": "OpenAI", "url": "https://api.openai.com/v1"},
    {"key": "google", "label": "Google", "url": None},
    {"key": "anthropic", "label": "Anthropic", "url": "https://api.anthropic.com/"},
    {"key": "xai", "label": "xAI", "url": "https://api.x.ai/v1"},
    {"key": "deepseek", "label": "DeepSeek", "url": "https://api.deepseek.com"},
    {"key": "qwen", "label": "Qwen", "url": "https://dashscope.aliyuncs.com/compatible-mode/v1"},
    {"key": "glm", "label": "GLM", "url": "https://open.bigmodel.cn/api/paas/v4/"},
    {"key": "ollama", "label": "Ollama", "url": "http://localhost:11434/v1"},
]

LANGUAGES = [
    "English", "Chinese", "Japanese", "Korean", "Hindi", "Spanish",
    "Portuguese", "French", "German", "Arabic", "Russian",
]

_runners: Dict[str, SessionRunner] = {}
_runners_lock = asyncio.Lock()
_batch_runners: Dict[str, BatchRunner] = {}
_batch_runners_lock = asyncio.Lock()


def _register_session_runner(runner: SessionRunner) -> None:
    """Register a SessionRunner spawned by a BatchRunner so /api/sessions works."""
    _runners[runner.session["id"]] = runner


@asynccontextmanager
async def lifespan(app: FastAPI):
    storage.ensure_dir()
    batch_storage.ensure_dir()
    yield


app = FastAPI(title="TradingAgents Web", lifespan=lifespan)
STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/", response_class=HTMLResponse)
async def index() -> HTMLResponse:
    return HTMLResponse((STATIC_DIR / "index.html").read_text(encoding="utf-8"))


@app.get("/api/config")
async def get_config() -> Dict[str, Any]:
    teams: List[Dict[str, Any]] = [
        {"name": "Analyst Team", "agents": [ANALYST_AGENT_NAMES[a] for a in ANALYST_ORDER]}
    ]
    teams.extend({"name": name, "agents": list(agents)} for name, agents in FIXED_TEAMS)
    return {
        "providers": PROVIDERS,
        "models": MODEL_OPTIONS,
        "analysts": [{"key": a, "label": ANALYST_AGENT_NAMES[a]} for a in ANALYST_ORDER],
        "teams": teams,
        "section_agent": SECTION_AGENT,
        "languages": LANGUAGES,
        "universe": universe_for_api(),
    }


def _summary(s: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": s["id"],
        "ticker": s["ticker"],
        "analysis_date": s["analysis_date"],
        "status": s["status"],
        "created_at": s["created_at"],
        "completed_at": s.get("completed_at"),
    }


@app.get("/api/sessions")
async def list_sessions() -> List[Dict[str, Any]]:
    return [_summary(s) for s in storage.list_all()]


class CreateSessionPayload(BaseModel):
    ticker: str = Field(min_length=1)
    analysis_date: str = Field(min_length=8)
    llm_provider: str
    backend_url: Optional[str] = None
    quick_think_llm: str
    deep_think_llm: str
    research_depth: int = 1
    analysts: List[str] = []
    google_thinking_level: Optional[str] = None
    openai_reasoning_effort: Optional[str] = None
    anthropic_effort: Optional[str] = None
    output_language: str = "English"


@app.post("/api/sessions")
async def create_session(payload: CreateSessionPayload) -> Dict[str, Any]:
    session = build_session(payload.model_dump())
    storage.save(session)
    loop = asyncio.get_running_loop()
    runner = SessionRunner(session, loop)
    async with _runners_lock:
        _runners[session["id"]] = runner
    runner.start()
    return _summary(session)


@app.get("/api/sessions/{sid}")
async def get_session(sid: str) -> Dict[str, Any]:
    runner = _runners.get(sid)
    if runner:
        return runner.snapshot()
    s = storage.load(sid)
    if not s:
        raise HTTPException(404, "Session not found")
    return s


@app.delete("/api/sessions/{sid}")
async def delete_session(sid: str) -> Dict[str, Any]:
    runner = _runners.get(sid)
    if runner and runner.session.get("status") == "running":
        raise HTTPException(409, "Cannot delete a running session")
    async with _runners_lock:
        _runners.pop(sid, None)
    storage.delete(sid)
    return {"deleted": True}


@app.websocket("/api/sessions/{sid}/stream")
async def stream(ws: WebSocket, sid: str) -> None:
    await ws.accept()
    runner = _runners.get(sid)
    if not runner:
        s = storage.load(sid)
        if not s:
            await ws.close(code=4404)
            return
        await ws.send_json({"type": "session", "session": s})
        await ws.close()
        return

    queue = runner.subscribe()
    await ws.send_json({"type": "session", "session": runner.snapshot()})
    try:
        while True:
            event = await queue.get()
            await ws.send_json(event)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        runner.unsubscribe(queue)


def _batch_summary(b: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": b["id"],
        "analysis_date": b["analysis_date"],
        "status": b["status"],
        "created_at": b["created_at"],
        "completed_at": b.get("completed_at"),
        "ticker_count": len(b.get("items", [])),
        "tickers": [it["ticker"] for it in b.get("items", [])],
    }


@app.get("/api/batches")
async def list_batches() -> List[Dict[str, Any]]:
    return [_batch_summary(b) for b in batch_storage.list_all()]


class CreateBatchPayload(BaseModel):
    tickers: List[str] = Field(min_length=1)
    analysis_date: str = Field(min_length=8)
    llm_provider: str
    backend_url: Optional[str] = None
    quick_think_llm: str
    deep_think_llm: str
    research_depth: int = 1
    analysts: List[str] = []
    google_thinking_level: Optional[str] = None
    openai_reasoning_effort: Optional[str] = None
    anthropic_effort: Optional[str] = None
    output_language: str = "English"
    max_concurrency: int = Field(4, ge=1, le=16)


@app.post("/api/batches")
async def create_batch(payload: CreateBatchPayload) -> Dict[str, Any]:
    batch = build_batch(payload.model_dump())
    batch_storage.save(batch)
    loop = asyncio.get_running_loop()
    runner = BatchRunner(batch, loop, register_session=_register_session_runner)
    async with _batch_runners_lock:
        _batch_runners[batch["id"]] = runner
    runner.start()
    return _batch_summary(batch)


@app.get("/api/batches/{bid}")
async def get_batch(bid: str) -> Dict[str, Any]:
    runner = _batch_runners.get(bid)
    if runner:
        return runner.snapshot()
    b = batch_storage.load(bid)
    if not b:
        raise HTTPException(404, "Batch not found")
    return b


@app.delete("/api/batches/{bid}")
async def delete_batch(bid: str) -> Dict[str, Any]:
    runner = _batch_runners.get(bid)
    if runner and runner.batch.get("status") in ("running", "composing_report", "pending"):
        raise HTTPException(409, "Cannot delete a running batch")
    async with _batch_runners_lock:
        _batch_runners.pop(bid, None)
    batch_storage.delete(bid)
    return {"deleted": True}


@app.websocket("/api/batches/{bid}/stream")
async def stream_batch(ws: WebSocket, bid: str) -> None:
    await ws.accept()
    runner = _batch_runners.get(bid)
    if not runner:
        b = batch_storage.load(bid)
        if not b:
            await ws.close(code=4404)
            return
        await ws.send_json({"type": "batch", "batch": b})
        await ws.close()
        return

    queue = runner.subscribe()
    await ws.send_json({"type": "batch", "batch": runner.snapshot()})
    try:
        while True:
            event = await queue.get()
            await ws.send_json(event)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        runner.unsubscribe(queue)


def _docx_response(blob: bytes, filename: str) -> Response:
    return Response(
        content=blob,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _safe_filename(*parts: str) -> str:
    cleaned = "_".join(part for part in parts if part)
    cleaned = re.sub(r"[^A-Za-z0-9_.\-]+", "_", cleaned).strip("_")
    return cleaned or "export"


@app.get("/api/sessions/{sid}/export.docx")
async def export_session(sid: str) -> Response:
    runner = _runners.get(sid)
    session = runner.snapshot() if runner else storage.load(sid)
    if not session:
        raise HTTPException(404, "Session not found")
    blob = session_to_docx(session)
    fname = _safe_filename(session.get("ticker", "session"), session.get("analysis_date", ""), sid[:8]) + ".docx"
    return _docx_response(blob, fname)


@app.get("/api/batches/{bid}/export.docx")
async def export_batch(bid: str) -> Response:
    runner = _batch_runners.get(bid)
    batch = runner.snapshot() if runner else batch_storage.load(bid)
    if not batch:
        raise HTTPException(404, "Batch not found")
    blob = batch_to_docx(batch)
    fname = _safe_filename("basket", batch.get("analysis_date", ""), bid[:8]) + ".docx"
    return _docx_response(blob, fname)


@app.get("/api/portfolio")
async def get_portfolio() -> Dict[str, Any]:
    return {"positions": portfolio.load_all()}


class PortfolioPayload(BaseModel):
    positions: Dict[str, Dict[str, Any]] = Field(default_factory=dict)


@app.put("/api/portfolio")
async def put_portfolio(payload: PortfolioPayload) -> Dict[str, Any]:
    portfolio.save_all(payload.positions)
    return {"positions": portfolio.load_all()}


def _raise_fd_limit(target: int = 8192) -> None:
    """Raise the per-process file-descriptor soft limit.

    macOS defaults to 256 FDs, which is far too low for a batch of 100+
    concurrent yfinance + LLM HTTP clients. We bump the soft limit up to
    ``target`` (or the system hard limit, whichever is lower).
    """
    try:
        import resource

        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        new_soft = min(target, hard) if hard != resource.RLIM_INFINITY else target
        if new_soft > soft:
            resource.setrlimit(resource.RLIMIT_NOFILE, (new_soft, hard))
    except (ImportError, ValueError, OSError):
        # `resource` isn't available on Windows; setrlimit may also refuse
        # certain values. Falling back to the OS default is fine — the
        # storage layer retries on EMFILE.
        pass


def main() -> None:
    """`python -m web` entrypoint."""
    import os
    import uvicorn

    _raise_fd_limit()
    host = os.getenv("TRADINGAGENTS_WEB_HOST", "127.0.0.1")
    port = int(os.getenv("TRADINGAGENTS_WEB_PORT", "8765"))
    uvicorn.run("web.server:app", host=host, port=port, reload=False)
