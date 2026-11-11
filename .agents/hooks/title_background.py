#!/usr/bin/env python3
"""Rename only the originating Codex thread from an asynchronous prompt hook."""

from __future__ import annotations

from collections import deque
from contextlib import closing
import importlib.util
import json
import os
from pathlib import Path
import queue
import shutil
import sqlite3
import subprocess
import sys
import threading
import time


def sibling(name: str):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


titles = sibling("session_title")
generator = titles._generator
RPC_TIMEOUT = 3
APP_CLI_MAC = Path(
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/"
    "CodexCLI.app/Contents/MacOS/codex"
)


class Unavailable(Exception):
    """The exact-session host state or title API cannot be verified."""


def codex_home() -> Path:
    return Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")).resolve()


def cli_path() -> str:
    candidates = (
        os.environ.get("AGENTIC_WORKFLOWS_TITLE_CODEX_CLI"),
        os.environ.get("CODEX_CLI_PATH"),
        str(APP_CLI_MAC),
        shutil.which("codex"),
    )
    for value in candidates:
        if value and Path(value).is_file() and os.access(value, os.X_OK):
            return value
    raise Unavailable("Codex app-server CLI unavailable")


def local_thread(session_id: str, home: Path) -> dict:
    home = home.resolve()
    db = home / "state_5.sqlite"
    if not db.is_file():
        raise Unavailable("local thread store unavailable")
    try:
        with closing(sqlite3.connect(db.as_uri() + "?mode=ro", uri=True, timeout=1)) as conn:
            row = conn.execute(
                "SELECT id, name, is_pinned, archived, rollout_path "
                "FROM threads WHERE id = ?", (session_id,)
            ).fetchone()
    except sqlite3.Error as error:
        raise Unavailable("local thread state unavailable") from error
    if not row or row[0] != session_id or row[2] not in (0, 1) or row[3] not in (0, 1):
        raise Unavailable("exact thread state unavailable")
    rollout = Path(row[4]).resolve() if isinstance(row[4], str) else None
    if not rollout or not rollout.is_relative_to(home / "sessions") or not rollout.name.endswith(f"-{session_id}.jsonl"):
        raise Unavailable("exact transcript unavailable")
    try:
        sidebar_state = json.loads((home / ".codex-global-state.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise Unavailable("sidebar pin state unavailable") from error
    pinned_ids = sidebar_state.get("pinned-thread-ids") if isinstance(sidebar_state, dict) else None
    if not isinstance(pinned_ids, list) or any(not isinstance(value, str) for value in pinned_ids):
        raise Unavailable("sidebar pin state invalid")
    return {"title": row[1] or "", "pinned": bool(row[2]) or session_id in pinned_ids,
            "archived": bool(row[3]), "rollout": rollout}


def message_text(item: dict) -> tuple[str | None, str, str | None]:
    """Select user text by content kind; modifiers are separate content parts."""
    content = item.get("content")
    metadata = item.get("internal_chat_message_metadata_passthrough") or {}
    if not isinstance(content, list) or any(not isinstance(part, dict) for part in content):
        raise Unavailable("transcript content unavailable")
    if not isinstance(metadata, dict):
        raise Unavailable("transcript metadata unavailable")
    raw = "\n".join(part["text"] for part in content
                    if part.get("type") == "input_text" and isinstance(part.get("text"), str))
    kinds = metadata.get("content_item_kinds")
    if not isinstance(kinds, list) or not kinds or any(not isinstance(kind, str) for kind in kinds):
        raise Unavailable("transcript content kinds unavailable")
    if "user.text" not in kinds:
        return None, raw, metadata.get("turn_id")
    if len(kinds) == len(content):
        parts = [part for part, kind in zip(content, kinds) if kind == "user.text"]
    elif all(kind in {"user.text", "user.image", "user.audio"} for kind in kinds):
        # Older transcripts can summarize genuine modalities instead of mapping each part.
        parts = content
    else:
        raise Unavailable("mixed transcript content kinds are not aligned")
    texts = [part["text"] for part in parts
             if part.get("type") == "input_text" and isinstance(part.get("text"), str)
             and not titles.internal_context(part["text"])]
    message = "\n".join(texts)
    return message if message.strip() else None, raw, metadata.get("turn_id")


def genuine_messages(rollout: Path, turn_id: str, prompt: str) -> tuple[list[str], int]:
    """Read only this rollout; synthetic context and tool messages are excluded."""
    first = None
    recent: deque[str] = deque(maxlen=7)
    previous_count = 0
    current_seen = False
    current_genuine = False
    message_count = 0
    try:
        with rollout.open(encoding="utf-8") as stream:
            for line in stream:
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue  # An active rollout can end with an incomplete line.
                item = entry.get("payload", {})
                if entry.get("type") != "response_item" or item.get("type") != "message" or item.get("role") != "user":
                    continue
                message, raw, message_turn = message_text(item)
                if message_turn == turn_id and prompt.strip() in (raw.strip(), (message or "").strip()):
                    current_seen = True
                    current_genuine = message is not None
                if message is None:
                    continue
                message_count += 1
                if message_turn != turn_id:
                    previous_count += 1
                if first is None:
                    first = message
                recent.append(message)
    except OSError as error:
        raise Unavailable("exact transcript unreadable") from error
    if current_seen and not current_genuine:
        return [], previous_count
    if not current_seen:
        if first is None:
            first = prompt
        recent.append(prompt)
        message_count += 1
    messages = [first, *recent] if message_count > len(recent) else list(recent)
    return messages[-8:], previous_count


class AppServer:
    def __init__(self, cli: str):
        self.cli = cli
        self.process = None
        self.lines: queue.Queue[str | None] = queue.Queue()
        self.next_id = 0

    def __enter__(self):
        try:
            self.process = subprocess.Popen(
                [self.cli, "app-server", "--stdio"], stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                text=True, bufsize=1,
            )
        except OSError as error:
            raise Unavailable("app-server unavailable") from error
        threading.Thread(target=self._read_lines, daemon=True).start()
        try:
            self.request("initialize", {"clientInfo": {"name": "async-title-hook", "version": "1"}})
            self._send({"method": "initialized", "params": {}})
        except Unavailable:
            self.__exit__(None, None, None)
            raise
        return self

    def _read_lines(self):
        assert self.process and self.process.stdout
        for line in self.process.stdout:
            self.lines.put(line)
        self.lines.put(None)

    def _send(self, value: dict):
        try:
            assert self.process and self.process.stdin
            self.process.stdin.write(json.dumps(value, separators=(",", ":")) + "\n")
            self.process.stdin.flush()
        except (OSError, ValueError) as error:
            raise Unavailable("app-server connection lost") from error

    def request(self, method: str, params: dict) -> dict:
        self.next_id += 1
        request_id = self.next_id
        self._send({"id": request_id, "method": method, "params": params})
        deadline = time.monotonic() + RPC_TIMEOUT
        while True:
            try:
                line = self.lines.get(timeout=max(0, deadline - time.monotonic()))
            except queue.Empty as error:
                raise Unavailable("app-server request timed out") from error
            if line is None:
                raise Unavailable("app-server disconnected")
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise Unavailable("invalid app-server response") from error
            if value.get("id") != request_id:
                continue  # Ignore notifications; this worker has one outstanding request.
            if value.get("error") or not isinstance(value.get("result"), dict):
                raise Unavailable("app-server request failed")
            return value["result"]

    def read(self, session_id: str) -> str:
        thread = self.request("thread/read", {"threadId": session_id, "includeTurns": False}).get("thread")
        if not isinstance(thread, dict) or thread.get("id") != session_id:
            raise Unavailable("exact thread readback failed")
        name = thread.get("name")
        if name is not None and not isinstance(name, str):
            raise Unavailable("invalid thread title")
        return name or ""

    def set_title(self, session_id: str, title: str) -> None:
        self.request("thread/name/set", {"threadId": session_id, "name": title})

    def __exit__(self, *_):
        if self.process:
            try:
                self.process.terminate()
            except OSError:
                pass
            try:
                self.process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=1)


def eligible(current: str, prior: str | None, opted_in: bool, first_turn: bool) -> bool:
    if prior is not None:
        return current == prior
    return not current or opted_in or first_turn


def process(payload: dict, path: Path, *, home: Path | None = None,
            host_factory=None, generate=None) -> str:
    prompt = titles.user_prompt(payload)
    if prompt is None:
        return "ignored"
    session_id, turn_id = payload["session_id"], payload["turn_id"]
    home = home or codex_home()
    try:
        before = local_thread(session_id, home)
        if before["pinned"] or before["archived"]:
            return "protected"
        messages, previous_count = genuine_messages(before["rollout"], turn_id, prompt)
        if not messages:
            return "ignored"
        accepted = titles.accept_event(payload, path)
        if accepted is None:
            return "ignored"
        sequence, prior, opted_in = accepted
        if host_factory is None or generate is None:
            cli = cli_path()
            host_factory = host_factory or (lambda: AppServer(cli))
            generate = generate or (lambda context: generator.generate(context, cli=cli))
        with host_factory() as host:
            initial_title = host.read(session_id)
            if initial_title != before["title"] or not eligible(initial_title, prior, opted_in, previous_count == 0):
                return "protected"
            result = generate({"recent_user_messages": messages})
            if result.get("status") != "generated" or not generator.valid_title(result.get("title")):
                return "unavailable"
            candidate = result["title"]
            with titles.locked(path):
                if not titles.current(path, session_id, turn_id, sequence):
                    return "stale"
                after = local_thread(session_id, home)
                if after["pinned"] or after["archived"] or after["title"] != initial_title:
                    return "protected"
                if host.read(session_id) != initial_title:
                    return "protected"
                if candidate != initial_title:
                    host.set_title(session_id, candidate)
                if host.read(session_id) != candidate:
                    return "unavailable"
                if not titles.record_locked(path, session_id, turn_id, sequence, candidate):
                    return "stale"
            return "renamed" if candidate != initial_title else "unchanged"
    except (Unavailable, OSError, sqlite3.Error, ValueError):
        return "unavailable"


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        process(payload, titles.state_path())
    except (OSError, ValueError, TypeError):
        pass  # Background title failures never interrupt the user turn.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
