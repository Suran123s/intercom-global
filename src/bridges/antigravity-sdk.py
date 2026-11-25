# src/bridges/antigravity-sdk.py - Antigravity Python SDK Bridge
import os
import sys
import json
import tempfile
from pathlib import Path

# Ensure UTF-8 stdout on Windows
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def get_mesh_dir() -> Path:
    """Resolve the active mesh directory dynamically from INTERCOM_MESH_DIR or repo default."""
    configured = os.environ.get("INTERCOM_MESH_DIR", "").strip()
    if configured:
        p = Path(configured)
        return p if p.is_absolute() else (Path.cwd() / p).resolve()
    return Path(__file__).resolve().parent.parent.parent / "mesh"


def get_agent_dir_path() -> Path:
    """Resolve the Pi coding agent directory dynamically from PI_CODING_AGENT_DIR or home."""
    configured = os.environ.get("PI_CODING_AGENT_DIR", "").strip()
    if configured:
        p = Path(configured)
        return p if p.is_absolute() else (Path.cwd() / p).resolve()
    home = os.environ.get("USERPROFILE") or os.environ.get("HOME") or str(Path.home())
    return Path(home) / ".pi" / "agent"


def get_broker_port(default_port=None):
    """Resolve the Pi Intercom broker port dynamically from broker.port.json or PORT env."""
    port_file = get_agent_dir_path() / "intercom" / "broker.port.json"
    if port_file.exists():
        try:
            with open(port_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            port_val = data.get("port")
            if isinstance(port_val, int) and 1 <= port_val <= 65535:
                return port_val
        except Exception:
            pass

    for env_key in ("PI_INTERCOM_PORT", "INTERCOM_PORT", "PORT"):
        raw = os.environ.get(env_key, "").strip()
        if raw:
            try:
                parsed = int(raw)
                if 1 <= parsed <= 65535:
                    return parsed
            except ValueError:
                pass

    return default_port


def get_daemon_port(default_port: int = 4150) -> int:
    """Resolve the Intercom HTTP daemon port dynamically from INTERCOM_PORT or PORT env."""
    for env_key in ("INTERCOM_PORT", "PORT"):
        raw = os.environ.get(env_key, "").strip()
        if raw:
            try:
                parsed = int(raw)
                if 1 <= parsed <= 65535:
                    return parsed
            except ValueError:
                pass
    return default_port


MESH_DIR = get_mesh_dir()
MESH_DIR.mkdir(parents=True, exist_ok=True)

try:
    from google.antigravity import Agent
    sdk_available = True
except ImportError:
    sdk_available = False


def check_inbox(agent_name="antigravity"):
    unread = []
    seen_ids = set()
    mesh_dir = get_mesh_dir()
    clean_agent = str(agent_name or "antigravity").lower()

    # 1. Discrete Inboxes (Configured/Global Mesh & Local Workspace)
    candidate_inboxes = [
        mesh_dir / "inbox" / clean_agent,
        Path.cwd() / ".agents" / "mesh" / "inbox" / clean_agent
    ]
    if not os.environ.get("INTERCOM_MESH_DIR", "").strip():
        home_dir = os.environ.get("USERPROFILE") or os.environ.get("HOME")
        if home_dir:
            candidate_inboxes.append(Path(home_dir) / ".intercom-global" / "mesh" / "inbox" / clean_agent)

    # Deduplicate resolved paths while preserving order
    unique_inboxes = []
    seen_dirs = set()
    for d in candidate_inboxes:
        resolved = str(d.resolve())
        if resolved not in seen_dirs:
            seen_dirs.add(resolved)
            unique_inboxes.append(d)

    for inbox_dir in unique_inboxes:
        if not inbox_dir.exists():
            continue
        for json_file in sorted(inbox_dir.glob("*.json")):
            if json_file.name.startswith(".tmp_") or json_file.name.startswith("."):
                continue
            try:
                with open(json_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                msg_id = data.get("id") or data.get("messageId") or json_file.stem
                if msg_id in seen_ids:
                    continue
                seen_ids.add(msg_id)

                sender = data.get("sender") or data.get("from") or "unknown"
                payload = data.get("payload")
                if isinstance(payload, dict) and "message" in payload:
                    body = payload["message"]
                else:
                    body = data.get("message") or data.get("content") or ""

                unread.append({
                    "id": msg_id,
                    "from": sender,
                    "sender": sender,
                    "message": body,
                    "type": data.get("type", "task_dispatch"),
                    "priority": data.get("priority", "NORMAL"),
                    "timestamp": data.get("timestamp"),
                    "file": str(json_file)
                })
            except Exception:
                # ignore malformed files
                continue

    # 2. Legacy Monolithic Fallback (mesh/<agent_name>.json)
    legacy_file = mesh_dir / f"{clean_agent}.json"
    if legacy_file.exists():
        try:
            with open(legacy_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, list):
                modified = False
                for m in data:
                    if isinstance(m, dict) and not m.get("read", False):
                        m_id = m.get("id") or m.get("messageId")
                        if not m_id or m_id not in seen_ids:
                            unread.append(m)
                            if m_id:
                                seen_ids.add(m_id)
                        m["read"] = True
                        modified = True
                if modified:
                    tmp_fd, tmp_path = tempfile.mkstemp(
                        prefix=f".{legacy_file.name}.",
                        suffix=".tmp",
                        dir=str(legacy_file.parent)
                    )
                    try:
                        with os.fdopen(tmp_fd, "w", encoding="utf-8") as tf:
                            json.dump(data, tf, indent=2)
                        os.replace(tmp_path, legacy_file)
                    finally:
                        if os.path.exists(tmp_path):
                            try:
                                os.unlink(tmp_path)
                            except OSError:
                                pass
        except Exception:
            pass

    return unread


def main():
    mesh_dir = get_mesh_dir()
    mesh_dir.mkdir(parents=True, exist_ok=True)
    broker_port = get_broker_port()
    daemon_port = get_daemon_port()

    print("🚀 [ANTIGRAVITY PYTHON BRIDGE]")
    print(f"📁 Mesh Directory: {mesh_dir}")
    print(f"🌐 Daemon Port   : {daemon_port}")
    if broker_port is not None:
        print(f"🔌 Broker Port   : {broker_port}")
    print(f"📦 SDK Installed : {sdk_available}")

    unread = check_inbox("antigravity")
    if not unread:
        print("📭 No unread messages in inbox.")
    else:
        print(f"📬 Found {len(unread)} unread task(s):")
        for m in unread:
            print(f"- From {m.get('from') or m.get('sender')}: {m.get('message')}")


if __name__ == "__main__":
    main()
