"""FastAPI app — REST + WebSocket front for the analysis runner."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from tradingagents.llm_clients.model_catalog import MODEL_OPTIONS

from . import storage
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    storage.ensure_dir()
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


def main() -> None:
    """`python -m web` entrypoint."""
    import os
    import uvicorn

    host = os.getenv("TRADINGAGENTS_WEB_HOST", "127.0.0.1")
    port = int(os.getenv("TRADINGAGENTS_WEB_PORT", "8765"))
    uvicorn.run("web.server:app", host=host, port=port, reload=False)
