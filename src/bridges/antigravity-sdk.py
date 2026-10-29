# src/bridges/antigravity-sdk.py - Antigravity Python SDK Bridge
import os
import sys
import json
import glob
from pathlib import Path

# Ensure UTF-8 stdout on Windows
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

MESH_DIR = Path(__file__).parent.parent.parent / "mesh"
MESH_DIR.mkdir(parents=True, exist_ok=True)

try:
    from google.antigravity import Agent
    sdk_available = True
except ImportError:
    sdk_available = False

def check_inbox(agent_name="antigravity"):
    unread = []
    seen_ids = set()

    # 1. Discrete Inboxes (Global Mesh & Local Workspace)
    candidate_inboxes = [
        MESH_DIR / "inbox" / agent_name.lower(),
        Path.cwd() / ".agents" / "mesh" / "inbox" / agent_name.lower()
    ]
    home_dir = os.environ.get("USERPROFILE") or os.environ.get("HOME")
    if home_dir:
        candidate_inboxes.append(Path(home_dir) / ".intercom-global" / "mesh" / "inbox" / agent_name.lower())

    for inbox_dir in candidate_inboxes:
        if not inbox_dir.exists():
            continue
        for json_file in sorted(inbox_dir.glob("*.json")):
            if json_file.name.startswith(".tmp_"):
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
            except Exception as e:
                # ignore malformed files
                continue

    # 2. Legacy Monolithic Fallback (mesh/<agent_name>.json)
    legacy_file = MESH_DIR / f"{agent_name.lower()}.json"
    if legacy_file.exists():
        try:
            with open(legacy_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, list):
                for m in data:
                    if not m.get("read", False):
                        m_id = m.get("id") or m.get("messageId")
                        if not m_id or m_id not in seen_ids:
                            unread.append(m)
                            if m_id:
                                seen_ids.add(m_id)
                        m["read"] = True
                with open(legacy_file, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=2)
        except Exception as e:
            pass

    return unread

def main():
    print("🚀 [ANTIGRAVITY PYTHON BRIDGE]")
    print(f"📁 Mesh Directory: {MESH_DIR}")
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
