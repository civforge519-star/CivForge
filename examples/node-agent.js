import fetch from "node-fetch";

const HTTP_BASE = process.env.CIVFORGE_HTTP ?? "https://civforge-worker.civforge519.workers.dev";
const AGENT_ID = process.env.AGENT_ID;
const AGENT_KEY = process.env.AGENT_KEY;

if (!AGENT_ID || !AGENT_KEY) {
  console.error("Set AGENT_ID and AGENT_KEY");
  process.exit(1);
}

const observe = async () => {
  const response = await fetch(`${HTTP_BASE}/agent/${AGENT_ID}/observe?worldId=public`, {
    headers: { Authorization: `Bearer ${AGENT_KEY}` }
  });
  return response.json();
};

const act = async (action) => {
  const response = await fetch(`${HTTP_BASE}/agent/${AGENT_ID}/act?worldId=public`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${AGENT_KEY}`
    },
    body: JSON.stringify(action)
  });
  return response.json();
};

const main = async () => {
  const obs = await observe();
  const action = {
    id: crypto.randomUUID(),
    type: "gather",
    agentId: AGENT_ID,
    unitId: obs.unit.id,
    payload: {},
    createdAt: Date.now()
  };
  const result = await act(action);
  console.log("action result", result);
};

main().catch((err) => console.error(err));

