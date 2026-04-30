"""JSON-file persistence for web analysis sessions."""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

_LOCK = threading.RLock()
_BASE = Path(os.path.expanduser("~/.tradingagents/web_sessions"))


def _path(session_id: str) -> Path:
    return _BASE / f"{session_id}.json"


def ensure_dir() -> None:
    _BASE.mkdir(parents=True, exist_ok=True)


def save(session: Dict[str, Any]) -> None:
    ensure_dir()
    sid = session["id"]
    with _LOCK:
        tmp = _path(sid).with_suffix(".tmp")
        tmp.write_text(json.dumps(session, default=str))
        tmp.replace(_path(sid))


def load(session_id: str) -> Optional[Dict[str, Any]]:
    p = _path(session_id)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def list_all() -> List[Dict[str, Any]]:
    ensure_dir()
    out: List[Dict[str, Any]] = []
    for p in _BASE.glob("*.json"):
        try:
            out.append(json.loads(p.read_text()))
        except (OSError, json.JSONDecodeError):
            continue
    out.sort(key=lambda s: s.get("created_at", 0), reverse=True)
    return out


def delete(session_id: str) -> bool:
    p = _path(session_id)
    if p.exists():
        p.unlink()
        return True
    return False
