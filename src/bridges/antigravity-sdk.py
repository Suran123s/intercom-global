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
    inbox_file = MESH_DIR / f"{agent_name.lower()}.json"
    if not inbox_file.exists():
        return []
    try:
        with open(inbox_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        unread = [m for m in data if not m.get("read", False)]
        for m in data:
            m["read"] = True
        with open(inbox_file, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        return unread
    except Exception as e:
        print(f"[Error reading inbox]: {e}")
        return []

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
            print(f"- From {m.get('from')}: {m.get('message')}")

if __name__ == "__main__":
    main()
