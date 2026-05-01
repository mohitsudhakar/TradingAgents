"""JSON-file persistence for web analysis sessions."""

from __future__ import annotations

import errno
import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

_LOCK = threading.RLock()
_BASE = Path(os.path.expanduser("~/.tradingagents/web_sessions"))


def _path(session_id: str) -> Path:
    return _BASE / f"{session_id}.json"


def ensure_dir() -> None:
    _BASE.mkdir(parents=True, exist_ok=True)


def save(session: Dict[str, Any]) -> None:
    """Persist a session record. Retries briefly on EMFILE so transient FD
    pressure during a large concurrent batch doesn't drop a snapshot."""
    ensure_dir()
    sid = session["id"]
    payload = json.dumps(session, default=str)
    with _LOCK:
        tmp = _path(sid).with_suffix(".tmp")
        for attempt in range(5):
            try:
                tmp.write_text(payload)
                tmp.replace(_path(sid))
                return
            except OSError as exc:
                if exc.errno != errno.EMFILE or attempt == 4:
                    raise
                time.sleep(0.1 * (attempt + 1))


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
