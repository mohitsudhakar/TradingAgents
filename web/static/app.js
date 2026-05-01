// TradingAgents web UI — single-page app, no build step.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  config: null,
  sessions: [],
  batches: [],
  view: "empty",       // "empty" | "config" | "session" | "batch-config" | "batch"
  activeSessionId: null,
  activeBatchId: null,
  session: null,       // full session payload
  batch: null,         // full batch payload
  ws: null,
  batchWs: null,
};

// ---------- bootstrap ----------

window.addEventListener("DOMContentLoaded", async () => {
  // Attach listeners FIRST so the UI is responsive even if data load fails.
  $("#new-session-btn").addEventListener("click", openConfigView);
  $("#new-batch-btn").addEventListener("click", openBatchConfigView);
  $("#bf-provider").addEventListener("change", syncBatchProviderDependentFields);
  $("#portfolio-btn").addEventListener("click", openPortfolioView);
  $("#pf-add-row").addEventListener("click", () => addPortfolioRow());
  $("#pf-save").addEventListener("click", savePortfolio);
  $("#s-export-btn").addEventListener("click", exportSession);
  $("#b-export-btn").addEventListener("click", exportBatch);
  initSidebarSections();
  $("#config-form").addEventListener("submit", submitConfig);
  $("#batch-form").addEventListener("submit", submitBatch);
  $("#bf-select-all").addEventListener("click", () => toggleAllBatchTickers(true));
  $("#bf-clear").addEventListener("click", () => toggleAllBatchTickers(false));
  $("#m-close").addEventListener("click", closeAgentModal);
  $("#agent-modal").addEventListener("click", (e) => {
    if (e.target.id === "agent-modal") closeAgentModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAgentModal();
  });

  try { await loadConfig();   } catch (e) { console.error("loadConfig failed:", e); }
  try { await loadSessions(); } catch (e) { console.error("loadSessions failed:", e); }
  try { await loadBatches();  } catch (e) { console.error("loadBatches failed:", e); }
  setView(state.sessions.length ? "session-or-empty" : "empty");
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

async function loadBatches() {
  const res = await fetch("/api/batches");
  state.batches = await res.json();
  renderBatchList();
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
  $("#view-batch-config").classList.toggle("hidden", v !== "batch-config");
  $("#view-batch").classList.toggle("hidden", v !== "batch");
  $("#view-portfolio").classList.toggle("hidden", v !== "portfolio");
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
  renderSessionStats();
  renderFinal();
  renderAgents();
}

function renderSessionStats() {
  $("#s-stats").innerHTML = formatStatsLine(state.session?.stats);
  $("#s-team-timings").innerHTML = formatTeamTimings(state.session?.team_timings);
}

function formatTeamTimings(timings) {
  if (!timings || !Object.keys(timings).length) return "";
  // Render in canonical team order so the line stays stable across runs.
  const order = ["Analyst Team", "Research Team", "Trading Team", "Risk Management", "Portfolio Management"];
  const seen = new Set(order);
  const teams = order.filter((t) => t in timings).concat(
    Object.keys(timings).filter((t) => !seen.has(t))
  );
  const parts = [];
  for (const team of teams) {
    const t = timings[team] || {};
    if (t.duration_s !== null && t.duration_s !== undefined) {
      parts.push(`<span class="stat">${escapeHTML(team)} <strong>${fmtDuration(t.duration_s)}</strong></span>`);
    } else if (t.started_at) {
      const elapsed = Math.max(0, (Date.now() / 1000) - t.started_at);
      parts.push(`<span class="stat">${escapeHTML(team)} <strong>${fmtDuration(elapsed)}…</strong></span>`);
    }
  }
  return parts.join("");
}

function fmtDuration(secs) {
  const s = Number(secs) || 0;
  if (s < 1) return `${(s * 1000).toFixed(0)}ms`;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}m ${r}s`;
}

function formatStatsLine(stats) {
  if (!stats) return "";
  const tin = Number(stats.tokens_in || 0);
  const tout = Number(stats.tokens_out || 0);
  const calls = Number(stats.llm_calls || 0);
  const tools = Number(stats.tool_calls || 0);
  if (!tin && !tout && !calls && !tools) return "";
  return [
    `<span class="stat">↓ in <strong>${fmtNum(tin)}</strong></span>`,
    `<span class="stat">↑ out <strong>${fmtNum(tout)}</strong></span>`,
    `<span class="stat">Σ <strong>${fmtNum(tin + tout)}</strong> tokens</span>`,
    `<span class="stat"><strong>${calls}</strong> LLM calls</span>`,
    `<span class="stat"><strong>${tools}</strong> tool calls</span>`,
  ].join("");
}

function fmtNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
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

  if (event.type === "stats") {
    s.stats = event.stats;
    renderSessionStats();
    return;
  }

  if (event.type === "team_timing") {
    s.team_timings = s.team_timings || {};
    s.team_timings[event.team] = event.timing;
    renderSessionStats();
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

// ---------- batch flow ----------

function renderBatchList() {
  const ul = $("#batch-list");
  ul.innerHTML = "";
  if (!state.batches.length) {
    const empty = document.createElement("div");
    empty.className = "subtle";
    empty.style.padding = "8px 4px";
    empty.style.fontSize = "12px";
    empty.textContent = "No baskets yet.";
    ul.appendChild(empty);
    return;
  }
  for (const b of state.batches) {
    const li = document.createElement("li");
    li.className = "session-item";
    if (b.id === state.activeBatchId) li.classList.add("active");
    li.innerHTML = `
      <div class="session-ticker">
        <span>Basket · ${b.ticker_count} tk</span>
        <span class="session-status ${b.status}">${batchStatusLabel(b.status)}</span>
      </div>
      <div class="session-date">${b.analysis_date} · ${formatRelative(b.created_at)}</div>
    `;
    li.addEventListener("click", () => openBatch(b.id));
    ul.appendChild(li);
  }
}

function batchStatusLabel(s) {
  if (s === "running")           return "● live";
  if (s === "composing_report")  return "● writing";
  if (s === "completed")         return "✓ done";
  if (s === "failed")            return "✕ failed";
  if (s === "completed_no_report") return "✓ partial";
  return "queued";
}

function openBatchConfigView() {
  if (!state.config) {
    alert("Config didn't load — check the browser console (likely the server isn't running the new code; restart `python -m web` and hard-reload).");
    return;
  }
  state.activeSessionId = null;
  state.session = null;
  state.activeBatchId = null;
  state.batch = null;
  closeWebsocket();
  closeBatchWebsocket();
  $$(".session-item").forEach((el) => el.classList.remove("active"));

  // Initialize date if empty.
  if (!$("#bf-date").value) $("#bf-date").value = new Date().toISOString().slice(0, 10);

  populateBatchProviderSelect();
  populateBatchAnalystChips();
  populateBatchLanguageSelect();
  syncBatchProviderDependentFields();
  renderUniverse();

  setView("batch-config");
}

function populateBatchProviderSelect() {
  const sel = $("#bf-provider");
  if (sel.options.length) return;
  for (const p of state.config.providers) {
    const opt = document.createElement("option");
    opt.value = p.key;
    opt.textContent = p.label;
    sel.appendChild(opt);
  }
}

function populateBatchAnalystChips() {
  const wrap = $("#bf-analysts");
  if (wrap.children.length) return;
  for (const a of state.config.analysts) {
    const c = document.createElement("div");
    c.className = "chip active";
    c.dataset.key = a.key;
    c.textContent = a.label;
    c.addEventListener("click", () => c.classList.toggle("active"));
    wrap.appendChild(c);
  }
}

function populateBatchLanguageSelect() {
  const sel = $("#bf-language");
  if (sel.options.length) return;
  for (const lang of state.config.languages) {
    const opt = document.createElement("option");
    opt.value = lang;
    opt.textContent = lang;
    sel.appendChild(opt);
  }
}

function syncBatchProviderDependentFields() {
  const provider = $("#bf-provider").value;
  const models = state.config.models[provider] || { quick: [], deep: [] };
  fillModelSelect("#bf-quick", models.quick);
  fillModelSelect("#bf-deep", models.deep);

  const wrap = $("#bf-thinking-wrap");
  const label = $("#bf-thinking-label");
  const sel = $("#bf-thinking");
  sel.innerHTML = "";

  let opts = null;
  if (provider === "google") {
    label.textContent = "Thinking mode";
    opts = [["high","Enable Thinking (recommended)"],["minimal","Minimal / Disable"]];
  } else if (provider === "openai") {
    label.textContent = "Reasoning effort";
    opts = [["medium","Medium (default)"],["high","High (more thorough)"],["low","Low (faster)"]];
  } else if (provider === "anthropic") {
    label.textContent = "Effort level";
    opts = [["high","High (recommended)"],["medium","Medium"],["low","Low (faster)"]];
  }
  if (!opts) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");
  for (const [v, lbl] of opts) {
    const o = document.createElement("option");
    o.value = v; o.textContent = lbl;
    sel.appendChild(o);
  }
}

function renderUniverse() {
  const wrap = $("#bf-universe");
  wrap.innerHTML = "";
  const universe = state.config.universe || [];
  if (!universe.length) {
    wrap.innerHTML = `<div class="subtle" style="padding:18px">No instruments returned by /api/config. Restart <code>python -m web</code> so the server picks up the new universe.</div>`;
    return;
  }
  for (const cat of universe) {
    const card = document.createElement("div");
    card.className = "universe-cat";
    card.innerHTML = `
      <div class="universe-cat-head">
        <span>${escapeHTML(cat.category)}</span>
        <button type="button" class="cat-toggle">all</button>
      </div>
      <div class="universe-tickers"></div>
    `;
    const tickerWrap = card.querySelector(".universe-tickers");
    for (const tk of cat.tickers) {
      const chip = document.createElement("div");
      chip.className = "ticker-chip";
      chip.dataset.symbol = tk.symbol;
      chip.innerHTML = `<span>${escapeHTML(tk.symbol)}</span><span class="tk-name">${escapeHTML(tk.name)}</span>`;
      chip.addEventListener("click", () => {
        chip.classList.toggle("active");
        updateBatchCount();
      });
      tickerWrap.appendChild(chip);
    }
    const toggle = card.querySelector(".cat-toggle");
    toggle.addEventListener("click", () => {
      const chips = tickerWrap.querySelectorAll(".ticker-chip");
      const allOn = Array.from(chips).every((c) => c.classList.contains("active"));
      chips.forEach((c) => c.classList.toggle("active", !allOn));
      updateBatchCount();
    });
    wrap.appendChild(card);
  }
  updateBatchCount();
}

function toggleAllBatchTickers(on) {
  $$("#bf-universe .ticker-chip").forEach((c) => c.classList.toggle("active", on));
  updateBatchCount();
}

function updateBatchCount() {
  const n = $$("#bf-universe .ticker-chip.active").length;
  $("#bf-count").textContent = `(${n} selected)`;
}

async function submitBatch(e) {
  e.preventDefault();
  const btn = $("#batch-go-btn");
  const tickers = $$("#bf-universe .ticker-chip.active").map((c) => c.dataset.symbol);
  if (!tickers.length) {
    alert("Select at least one instrument.");
    return;
  }
  if (tickers.length > 30 && !confirm(`You picked ${tickers.length} instruments. This will run ${tickers.length} full multi-agent analyses sequentially. Continue?`)) {
    return;
  }
  const analysts = $$("#bf-analysts .chip.active").map((c) => c.dataset.key);
  if (!analysts.length) {
    alert("Pick at least one analyst.");
    return;
  }

  const provider = $("#bf-provider").value;
  const providerObj = state.config.providers.find((p) => p.key === provider);
  const payload = {
    tickers,
    analysis_date: $("#bf-date").value,
    llm_provider: provider,
    backend_url: providerObj?.url || null,
    quick_think_llm: $("#bf-quick").value,
    deep_think_llm: $("#bf-deep").value,
    research_depth: parseInt($("#bf-depth").value, 10),
    analysts,
    output_language: $("#bf-language").value,
    max_concurrency: parseInt($("#bf-concurrency").value, 10),
  };
  const thinking = $("#bf-thinking").value;
  if (provider === "google")    payload.google_thinking_level = thinking;
  if (provider === "openai")    payload.openai_reasoning_effort = thinking;
  if (provider === "anthropic") payload.anthropic_effort = thinking;

  btn.disabled = true;
  btn.querySelector(".go-btn-label").textContent = "Spinning up…";
  try {
    const res = await fetch("/api/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    const summary = await res.json();
    await loadBatches();
    openBatch(summary.id);
  } catch (err) {
    alert(`Failed to start batch: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.querySelector(".go-btn-label").textContent = "Run basket";
  }
}

async function openBatch(id) {
  state.activeBatchId = id;
  state.activeSessionId = null;
  state.session = null;
  closeWebsocket();
  closeBatchWebsocket();
  $$(".session-item").forEach((el) => el.classList.remove("active"));

  setView("batch");
  const res = await fetch(`/api/batches/${id}`);
  if (!res.ok) {
    alert("Batch not found");
    setView("empty");
    return;
  }
  state.batch = await res.json();
  renderBatch();
  renderBatchList();
  if (["pending", "running", "composing_report"].includes(state.batch.status)) {
    openBatchWebsocket(id);
  }
}

function renderBatch() {
  const b = state.batch;
  $("#b-title").textContent = `Basket · ${b.analysis_date}`;
  $("#b-meta").textContent = `${b.config.llm_provider} · deep=${b.config.deep_think_llm} · quick=${b.config.quick_think_llm} · depth=${b.config.research_depth} · ${b.items.length} instruments`;
  const pill = $("#b-status");
  pill.textContent = batchStatusLabel(b.status);
  pill.className = `status-pill ${b.status}`;
  renderBatchTotals();
  renderBatchItems();
  renderBatchReport();
}

function renderBatchTotals() {
  $("#b-totals").innerHTML = formatStatsLine(state.batch?.totals);
  $("#b-team-totals").innerHTML = formatTeamTotals(state.batch?.team_totals);
}

function formatTeamTotals(team_totals) {
  if (!team_totals || !Object.keys(team_totals).length) return "";
  const order = ["Analyst Team", "Research Team", "Trading Team", "Risk Management", "Portfolio Management"];
  const seen = new Set(order);
  const teams = order.filter((t) => t in team_totals).concat(
    Object.keys(team_totals).filter((t) => !seen.has(t))
  );
  const parts = [];
  for (const team of teams) {
    const t = team_totals[team] || {};
    if (!t.count) continue;
    parts.push(
      `<span class="stat">${escapeHTML(team)} ` +
      `Σ <strong>${fmtDuration(t.total_s)}</strong> ` +
      `<span style="color:var(--text-faint);font-size:11px">(avg ${fmtDuration(t.avg_s)} · max ${fmtDuration(t.max_s)} · n=${t.count})</span>` +
      `</span>`
    );
  }
  return parts.join("");
}

function renderBatchItems() {
  const b = state.batch;
  const wrap = $("#b-items");
  wrap.innerHTML = "";
  const done = b.items.filter((it) => it.status === "completed" || it.status === "failed").length;
  $("#b-counter").textContent = `${done} / ${b.items.length}`;
  for (const it of b.items) {
    const div = document.createElement("div");
    div.className = `batch-item ${it.status}`;
    const tin = Number(it.stats?.tokens_in || 0);
    const tout = Number(it.stats?.tokens_out || 0);
    const tokenLabel = (tin || tout) ? `${fmtNum(tin + tout)} tok` : "";
    div.innerHTML = `
      <span class="bi-tk">${escapeHTML(it.ticker)}</span>
      ${tokenLabel ? `<span class="bi-tokens">${tokenLabel}</span>` : ""}
      <span class="bi-status">${escapeHTML(it.status)}</span>
    `;
    if (it.session_id) {
      div.addEventListener("click", () => openSession(it.session_id));
    }
    wrap.appendChild(div);
  }
}

function renderBatchReport() {
  const b = state.batch;
  const body = $("#b-report-body");
  const tag = $("#b-report-tag");
  if (b.report) {
    body.classList.add("markdown");
    body.classList.remove("subtle");
    body.innerHTML = renderMarkdown(b.report);
    tag.textContent = "ready";
    tag.className = "final-card-tag";
    return;
  }
  body.classList.remove("markdown");
  body.classList.add("subtle");
  if (b.status === "composing_report") {
    body.textContent = "All instruments done — composing the consolidated report…";
    tag.textContent = "writing";
  } else if (b.status === "completed_no_report") {
    body.textContent = `Analyses finished but report generation failed: ${b.report_error || "unknown error"}`;
    tag.textContent = "failed";
  } else if (b.status === "failed") {
    body.textContent = `Batch failed: ${b.error || "unknown error"}`;
    tag.textContent = "failed";
  } else {
    const done = b.items.filter((it) => it.status === "completed" || it.status === "failed").length;
    body.textContent = `${done} of ${b.items.length} instruments analyzed. Report appears once all are done.`;
    tag.textContent = "awaiting";
  }
}

function openBatchWebsocket(id) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/api/batches/${id}/stream`);
  state.batchWs = ws;
  ws.onmessage = (e) => {
    if (state.activeBatchId !== id) return;
    const event = JSON.parse(e.data);
    handleBatchEvent(event);
  };
  ws.onclose = () => {
    if (state.batchWs === ws) state.batchWs = null;
  };
}

function closeBatchWebsocket() {
  if (state.batchWs) {
    try { state.batchWs.close(); } catch {}
    state.batchWs = null;
  }
}

// ---------- exports ----------

function exportSession() {
  if (!state.activeSessionId) return;
  triggerDownload(`/api/sessions/${state.activeSessionId}/export.docx`);
}

function exportBatch() {
  if (!state.activeBatchId) return;
  triggerDownload(`/api/batches/${state.activeBatchId}/export.docx`);
}

function triggerDownload(href) {
  // The endpoint sets Content-Disposition; navigating via a hidden link
  // lets the browser handle the filename + save dialog.
  const a = document.createElement("a");
  a.href = href;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------- sidebar collapsible sections ----------

const SIDEBAR_PREFS_KEY = "ta-sidebar-collapsed";

function initSidebarSections() {
  let collapsed = {};
  try {
    collapsed = JSON.parse(localStorage.getItem(SIDEBAR_PREFS_KEY) || "{}") || {};
  } catch { collapsed = {}; }

  for (const section of $$(".sidebar-section")) {
    const key = section.dataset.section;
    if (collapsed[key]) section.classList.add("collapsed");
    const toggle = section.querySelector(".section-toggle");
    toggle.addEventListener("click", () => {
      section.classList.toggle("collapsed");
      collapsed[key] = section.classList.contains("collapsed");
      try { localStorage.setItem(SIDEBAR_PREFS_KEY, JSON.stringify(collapsed)); } catch {}
    });
  }
}

// ---------- portfolio editor ----------

async function openPortfolioView() {
  state.activeSessionId = null;
  state.session = null;
  state.activeBatchId = null;
  state.batch = null;
  closeWebsocket();
  closeBatchWebsocket();
  $$(".session-item").forEach((el) => el.classList.remove("active"));

  setView("portfolio");
  await loadPortfolio();
}

async function loadPortfolio() {
  const tbody = $("#pf-rows");
  tbody.innerHTML = "";
  let positions = {};
  try {
    const res = await fetch("/api/portfolio");
    if (res.ok) {
      const data = await res.json();
      positions = data.positions || {};
    }
  } catch (e) {
    console.error("loadPortfolio failed:", e);
  }
  const entries = Object.entries(positions);
  if (!entries.length) {
    addPortfolioRow();
  } else {
    for (const [sym, pos] of entries) {
      addPortfolioRow({ symbol: sym, qty: pos.qty, avg_cost: pos.avg_cost, notes: pos.notes });
    }
  }
  updatePortfolioCount();
}

function addPortfolioRow(seed = {}) {
  const tbody = $("#pf-rows");
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><input class="pf-symbol" placeholder="AAPL" value="${escapeAttr(seed.symbol)}" /></td>
    <td><input class="pf-qty" type="number" step="any" placeholder="100" value="${escapeAttr(seed.qty)}" /></td>
    <td><input class="pf-cost" type="number" step="any" placeholder="180.50" value="${escapeAttr(seed.avg_cost)}" /></td>
    <td><input class="pf-notes" placeholder="core holding, long-term" value="${escapeAttr(seed.notes)}" /></td>
    <td><button type="button" class="pf-del" aria-label="Remove row">×</button></td>
  `;
  tr.querySelector(".pf-del").addEventListener("click", () => {
    tr.remove();
    updatePortfolioCount();
  });
  for (const inp of tr.querySelectorAll("input")) {
    inp.addEventListener("input", updatePortfolioCount);
  }
  tbody.appendChild(tr);
  updatePortfolioCount();
}

function escapeAttr(v) {
  if (v === null || v === undefined || v === "") return "";
  return String(v).replace(/"/g, "&quot;");
}

function updatePortfolioCount() {
  const rows = $$("#pf-rows tr");
  const filled = rows.filter((r) => {
    const sym = r.querySelector(".pf-symbol").value.trim();
    const qty = r.querySelector(".pf-qty").value.trim();
    return sym && qty && Number(qty) !== 0;
  });
  $("#pf-count").textContent = `${filled.length} position${filled.length === 1 ? "" : "s"}`;
}

async function savePortfolio() {
  const rows = $$("#pf-rows tr");
  const positions = {};
  for (const r of rows) {
    const sym = r.querySelector(".pf-symbol").value.trim().toUpperCase();
    const qtyRaw = r.querySelector(".pf-qty").value.trim();
    if (!sym || !qtyRaw) continue;
    const qty = Number(qtyRaw);
    if (!Number.isFinite(qty) || qty === 0) continue;
    const entry = { qty };
    const costRaw = r.querySelector(".pf-cost").value.trim();
    if (costRaw) {
      const c = Number(costRaw);
      if (Number.isFinite(c)) entry.avg_cost = c;
    }
    const notes = r.querySelector(".pf-notes").value.trim();
    if (notes) entry.notes = notes;
    positions[sym] = entry;
  }

  const btn = $("#pf-save");
  btn.disabled = true;
  btn.querySelector(".go-btn-label").textContent = "Saving…";
  try {
    const res = await fetch("/api/portfolio", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ positions }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    btn.querySelector(".go-btn-label").textContent = "Saved";
    setTimeout(() => { btn.querySelector(".go-btn-label").textContent = "Save"; btn.disabled = false; }, 1200);
  } catch (err) {
    alert(`Failed to save portfolio: ${err.message}`);
    btn.querySelector(".go-btn-label").textContent = "Save";
    btn.disabled = false;
  }
}

function handleBatchEvent(event) {
  if (!state.batch) return;
  if (event.type === "batch") {
    state.batch = event.batch;
    renderBatch();
    loadBatches();
    if (["completed", "failed", "completed_no_report"].includes(event.batch.status)) {
      closeBatchWebsocket();
    }
    return;
  }
  if (event.type === "item") {
    state.batch.items[event.index] = event.item;
    renderBatchItems();
    renderBatchReport();
    return;
  }
  if (event.type === "totals") {
    state.batch.totals = event.totals;
    if (event.team_totals) state.batch.team_totals = event.team_totals;
    renderBatchTotals();
    return;
  }
}
