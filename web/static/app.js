// TradingAgents web UI — single-page app, no build step.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  config: null,
  sessions: [],
  view: "empty",       // "empty" | "config" | "session"
  activeSessionId: null,
  session: null,       // full session payload
  ws: null,
};

// ---------- bootstrap ----------

window.addEventListener("DOMContentLoaded", async () => {
  await loadConfig();
  await loadSessions();
  setView(state.sessions.length ? "session-or-empty" : "empty");

  $("#new-session-btn").addEventListener("click", openConfigView);
  $("#config-form").addEventListener("submit", submitConfig);
  $("#m-close").addEventListener("click", closeAgentModal);
  $("#agent-modal").addEventListener("click", (e) => {
    if (e.target.id === "agent-modal") closeAgentModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAgentModal();
  });
});

async function loadConfig() {
  const res = await fetch("/api/config");
  state.config = await res.json();
  populateProviderSelect();
  populateAnalystChips();
  populateLanguageSelect();
  syncProviderDependentFields();
  $("#f-provider").addEventListener("change", syncProviderDependentFields);

  $("#f-date").value = new Date().toISOString().slice(0, 10);
  $("#f-ticker").value = "SPY";
}

async function loadSessions() {
  const res = await fetch("/api/sessions");
  state.sessions = await res.json();
  renderSessionList();
}

// ---------- views ----------

function setView(v) {
  if (v === "session-or-empty") {
    if (state.sessions.length) {
      openSession(state.sessions[0].id);
    } else {
      setView("empty");
    }
    return;
  }
  state.view = v;
  $("#view-empty").classList.toggle("hidden", v !== "empty");
  $("#view-config").classList.toggle("hidden", v !== "config");
  $("#view-session").classList.toggle("hidden", v !== "session");
}

function openConfigView() {
  state.activeSessionId = null;
  state.session = null;
  closeWebsocket();
  $$(".session-item").forEach((el) => el.classList.remove("active"));
  setView("config");
}

// ---------- sidebar ----------

function renderSessionList() {
  const ul = $("#session-list");
  ul.innerHTML = "";
  if (!state.sessions.length) {
    const empty = document.createElement("div");
    empty.className = "subtle";
    empty.style.padding = "12px 4px";
    empty.style.fontSize = "12px";
    empty.textContent = "No sessions yet. Start a new analysis above.";
    ul.appendChild(empty);
    return;
  }
  for (const s of state.sessions) {
    const li = document.createElement("li");
    li.className = "session-item";
    if (s.id === state.activeSessionId) li.classList.add("active");
    li.innerHTML = `
      <div class="session-ticker">
        <span>${escapeHTML(s.ticker)}</span>
        <span class="session-status ${s.status}">${statusLabel(s.status)}</span>
      </div>
      <div class="session-date">${s.analysis_date} · ${formatRelative(s.created_at)}</div>
    `;
    li.addEventListener("click", () => openSession(s.id));
    ul.appendChild(li);
  }
}

function statusLabel(s) {
  if (s === "running")   return "● live";
  if (s === "completed") return "✓ done";
  if (s === "failed")    return "✕ failed";
  return "queued";
}

function formatRelative(ts) {
  if (!ts) return "";
  const diff = (Date.now() / 1000) - ts;
  if (diff < 60)    return "just now";
  if (diff < 3600)  return `${Math.floor(diff/60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

// ---------- config form ----------

function populateProviderSelect() {
  const sel = $("#f-provider");
  sel.innerHTML = "";
  for (const p of state.config.providers) {
    const opt = document.createElement("option");
    opt.value = p.key;
    opt.textContent = p.label;
    sel.appendChild(opt);
  }
}

function populateAnalystChips() {
  const wrap = $("#f-analysts");
  wrap.innerHTML = "";
  for (const a of state.config.analysts) {
    const c = document.createElement("div");
    c.className = "chip active";
    c.dataset.key = a.key;
    c.textContent = a.label;
    c.addEventListener("click", () => c.classList.toggle("active"));
    wrap.appendChild(c);
  }
}

function populateLanguageSelect() {
  const sel = $("#f-language");
  sel.innerHTML = "";
  for (const lang of state.config.languages) {
    const opt = document.createElement("option");
    opt.value = lang;
    opt.textContent = lang;
    sel.appendChild(opt);
  }
}

function syncProviderDependentFields() {
  const provider = $("#f-provider").value;
  const models = state.config.models[provider] || { quick: [], deep: [] };

  fillModelSelect("#f-quick", models.quick);
  fillModelSelect("#f-deep",  models.deep);

  // Provider-specific thinking field
  const wrap = $("#f-thinking-wrap");
  const label = $("#f-thinking-label");
  const sel = $("#f-thinking");
  sel.innerHTML = "";

  let opts = null;
  if (provider === "google") {
    label.textContent = "Thinking mode";
    opts = [
      ["high",    "Enable Thinking (recommended)"],
      ["minimal", "Minimal / Disable"],
    ];
  } else if (provider === "openai") {
    label.textContent = "Reasoning effort";
    opts = [
      ["medium", "Medium (default)"],
      ["high",   "High (more thorough)"],
      ["low",    "Low (faster)"],
    ];
  } else if (provider === "anthropic") {
    label.textContent = "Effort level";
    opts = [
      ["high",   "High (recommended)"],
      ["medium", "Medium"],
      ["low",    "Low (faster)"],
    ];
  }

  if (!opts) {
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  for (const [v, lbl] of opts) {
    const o = document.createElement("option");
    o.value = v; o.textContent = lbl;
    sel.appendChild(o);
  }
}

function fillModelSelect(selector, options) {
  const sel = $(selector);
  sel.innerHTML = "";
  for (const [label, value] of options) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    sel.appendChild(o);
  }
}

async function submitConfig(e) {
  e.preventDefault();
  const btn = $("#go-btn");
  btn.disabled = true;
  btn.querySelector(".go-btn-label").textContent = "Spinning up…";

  const provider = $("#f-provider").value;
  const providerObj = state.config.providers.find((p) => p.key === provider);

  const analysts = $$("#f-analysts .chip.active").map((c) => c.dataset.key);
  if (!analysts.length) {
    alert("Pick at least one analyst.");
    btn.disabled = false;
    btn.querySelector(".go-btn-label").textContent = "Let's go";
    return;
  }

  const payload = {
    ticker: $("#f-ticker").value.trim(),
    analysis_date: $("#f-date").value,
    llm_provider: provider,
    backend_url: providerObj?.url || null,
    quick_think_llm: $("#f-quick").value,
    deep_think_llm: $("#f-deep").value,
    research_depth: parseInt($("#f-depth").value, 10),
    analysts,
    output_language: $("#f-language").value,
  };
  const thinking = $("#f-thinking").value;
  if (provider === "google")    payload.google_thinking_level = thinking;
  if (provider === "openai")    payload.openai_reasoning_effort = thinking;
  if (provider === "anthropic") payload.anthropic_effort = thinking;

  try {
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    const summary = await res.json();
    await loadSessions();
    openSession(summary.id);
  } catch (err) {
    alert(`Failed to start analysis: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.querySelector(".go-btn-label").textContent = "Let's go";
  }
}

// ---------- session view ----------

async function openSession(id) {
  state.activeSessionId = id;
  closeWebsocket();
  $$(".session-item").forEach((el) => el.classList.remove("active"));

  setView("session");

  const res = await fetch(`/api/sessions/${id}`);
  if (!res.ok) {
    alert("Session not found");
    setView("empty");
    return;
  }
  state.session = await res.json();
  renderSession();
  renderSessionList();

  if (state.session.status === "running" || state.session.status === "pending") {
    openWebsocket(id);
  }
}

function renderSession() {
  const s = state.session;
  $("#s-title").textContent = `${s.ticker} · ${s.analysis_date}`;
  $("#s-meta").textContent = `${s.config.llm_provider} · deep=${s.config.deep_think_llm} · quick=${s.config.quick_think_llm} · depth=${s.config.research_depth}`;
  const pill = $("#s-status");
  pill.textContent = s.status;
  pill.className = `status-pill ${s.status}`;
  renderFinal();
  renderAgents();
}

function renderFinal() {
  const s = state.session;
  const final = s.report_sections?.final_trade_decision;
  const body = $("#s-final-body");
  const tag = $("#s-final-tag");

  if (!final) {
    body.classList.remove("markdown");
    body.classList.add("subtle");
    if (s.status === "failed") {
      body.textContent = `Analysis failed: ${s.error || "unknown error"}`;
      tag.textContent = "failed";
      tag.className = "final-card-tag";
    } else if (s.status === "running") {
      body.textContent = "Agents are still deliberating…";
      tag.textContent = "in progress";
      tag.className = "final-card-tag";
    } else {
      body.textContent = "The Portfolio Manager will weigh in once the debate concludes…";
      tag.textContent = "awaiting";
      tag.className = "final-card-tag";
    }
    return;
  }

  body.classList.add("markdown");
  body.classList.remove("subtle");
  body.innerHTML = renderMarkdown(final);

  const verdict = inferVerdict(final);
  tag.textContent = verdict || "decision";
  tag.className = `final-card-tag ${verdict?.toLowerCase() || ""}`;
}

function inferVerdict(text) {
  const m = text.match(/\b(BUY|SELL|HOLD)\b/i);
  return m ? m[1].toUpperCase() : null;
}

function renderAgents() {
  const s = state.session;
  const grid = $("#s-agents");
  grid.innerHTML = "";
  for (const team of state.config.teams) {
    const present = team.agents.filter((a) => a in s.agent_status);
    if (!present.length) continue;
    const label = document.createElement("div");
    label.className = "team-label";
    label.textContent = team.name;
    grid.appendChild(label);

    for (const agent of present) {
      grid.appendChild(buildAgentCard(agent, team.name));
    }
  }
}

function buildAgentCard(agent, teamName) {
  const s = state.session;
  const status = s.agent_status[agent] || "pending";
  const card = document.createElement("div");
  card.className = "agent-card";
  if (status === "in_progress") card.classList.add("active-status");
  if (status === "completed")   card.classList.add("completed-status");
  card.dataset.agent = agent;

  const section = sectionForAgent(agent);
  const content = section ? s.report_sections?.[section] : null;
  const preview = content
    ? stripMarkdown(content).slice(0, 140)
    : (status === "in_progress" ? "Thinking…" : "Awaiting their turn.");

  card.innerHTML = `
    <div class="agent-card-top">
      <span class="agent-dot ${status}"></span>
      <div class="agent-name">${escapeHTML(agent)}</div>
    </div>
    <div class="agent-meta">${escapeHTML(teamName)} · ${status.replace("_", " ")}</div>
    <div class="agent-preview">${escapeHTML(preview)}</div>
  `;
  card.addEventListener("click", () => openAgentModal(agent, teamName));
  return card;
}

function sectionForAgent(agent) {
  const map = state.config.section_agent || {};
  for (const [section, owner] of Object.entries(map)) {
    if (owner === agent) return section;
  }
  return null;
}

// ---------- modal ----------

function openAgentModal(agent, teamName) {
  const s = state.session;
  $("#m-title").textContent = agent;
  $("#m-team").textContent = `${teamName} · ${(s.agent_status[agent] || "pending").replace("_", " ")}`;
  const section = sectionForAgent(agent);
  const content = section ? s.report_sections?.[section] : null;
  const body = $("#m-body");
  if (content) {
    body.classList.add("markdown");
    body.innerHTML = renderMarkdown(content);
  } else {
    body.classList.remove("markdown");
    const status = s.agent_status[agent] || "pending";
    body.innerHTML = `<p class="subtle">${
      status === "in_progress"
        ? "This agent is still working. Output will stream in here as it's produced."
        : "No output yet — this agent hasn't started or doesn't produce a primary report."
    }</p>`;
  }
  $("#agent-modal").classList.remove("hidden");
}

function closeAgentModal() {
  $("#agent-modal").classList.add("hidden");
}

// ---------- websocket ----------

function openWebsocket(id) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/api/sessions/${id}/stream`);
  state.ws = ws;
  ws.onmessage = (e) => {
    if (state.activeSessionId !== id) return;
    const event = JSON.parse(e.data);
    handleEvent(event);
  };
  ws.onclose = () => {
    if (state.ws === ws) state.ws = null;
  };
}

function closeWebsocket() {
  if (state.ws) {
    try { state.ws.close(); } catch {}
    state.ws = null;
  }
}

function handleEvent(event) {
  const s = state.session;
  if (!s) return;

  if (event.type === "session") {
    state.session = event.session;
    renderSession();
    loadSessions();      // refresh sidebar status
    if (event.session.status === "completed" || event.session.status === "failed") {
      closeWebsocket();
    }
    return;
  }

  if (event.type === "agent_status") {
    s.agent_status[event.agent] = event.status;
    updateAgentCard(event.agent);
    return;
  }

  if (event.type === "report") {
    s.report_sections = s.report_sections || {};
    s.report_sections[event.section] = event.content;
    renderFinal();
    if (event.agent) updateAgentCard(event.agent);
    return;
  }

  if (event.type === "message") {
    s.messages = s.messages || [];
    s.messages.push(event.message);
    return;
  }
}

function updateAgentCard(agent) {
  const card = document.querySelector(`.agent-card[data-agent="${cssEscape(agent)}"]`);
  if (!card) return;
  // Find the team for this agent.
  const team = (state.config.teams.find((t) => t.agents.includes(agent)) || {}).name || "";
  const fresh = buildAgentCard(agent, team);
  card.replaceWith(fresh);
}

// ---------- utils ----------

function escapeHTML(str) {
  return (str ?? "").toString().replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function cssEscape(s) {
  return s.replace(/"/g, '\\"');
}

function stripMarkdown(s) {
  return s.replace(/[#*_`>]/g, "").replace(/\s+/g, " ").trim();
}

function renderMarkdown(s) {
  if (typeof marked !== "undefined") {
    try { return marked.parse(s); } catch { /* fall through */ }
  }
  return `<pre>${escapeHTML(s)}</pre>`;
}
