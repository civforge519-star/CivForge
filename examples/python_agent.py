import os
import requests
import uuid
import time

HTTP_BASE = os.environ.get("CIVFORGE_HTTP", "https://civforge-worker.civforge519.workers.dev")
AGENT_ID = os.environ.get("AGENT_ID")
AGENT_KEY = os.environ.get("AGENT_KEY")

if not AGENT_ID or not AGENT_KEY:
    raise SystemExit("Set AGENT_ID and AGENT_KEY")

def observe():
    res = requests.get(
        f"{HTTP_BASE}/agent/{AGENT_ID}/observe?worldId=public",
        headers={"Authorization": f"Bearer {AGENT_KEY}"}
    )
    res.raise_for_status()
    return res.json()

def act(action):
    res = requests.post(
        f"{HTTP_BASE}/agent/{AGENT_ID}/act?worldId=public",
        json=action,
        headers={"Authorization": f"Bearer {AGENT_KEY}"}
    )
    res.raise_for_status()
    return res.json()

if __name__ == "__main__":
    obs = observe()
    action = {
        "id": str(uuid.uuid4()),
        "type": "gather",
        "agentId": AGENT_ID,
        "unitId": obs["unit"]["id"],
        "payload": {},
        "createdAt": int(time.time() * 1000)
    }
    print(act(action))

