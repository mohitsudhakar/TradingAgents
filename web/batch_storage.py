"""JSON-file persistence for batch analysis runs."""

from __future__ import annotations

import errno
import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

_LOCK = threading.RLock()
_BASE = Path(os.path.expanduser("~/.tradingagents/web_batches"))


def _path(batch_id: str) -> Path:
    return _BASE / f"{batch_id}.json"


def ensure_dir() -> None:
    _BASE.mkdir(parents=True, exist_ok=True)


def save(batch: Dict[str, Any]) -> None:
    """Persist a batch record. Retries briefly on EMFILE so transient FD
    pressure during a large concurrent batch doesn't drop a snapshot."""
    ensure_dir()
    bid = batch["id"]
    payload = json.dumps(batch, default=str)
    with _LOCK:
        tmp = _path(bid).with_suffix(".tmp")
        for attempt in range(5):
            try:
                tmp.write_text(payload)
                tmp.replace(_path(bid))
                return
            except OSError as exc:
                if exc.errno != errno.EMFILE or attempt == 4:
                    raise
                time.sleep(0.1 * (attempt + 1))


def load(batch_id: str) -> Optional[Dict[str, Any]]:
    p = _path(batch_id)
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
    out.sort(key=lambda b: b.get("created_at", 0), reverse=True)
    return out


def delete(batch_id: str) -> bool:
    p = _path(batch_id)
    if p.exists():
        p.unlink()
        return True
    return False
