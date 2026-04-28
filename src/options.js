const rulesList = document.querySelector("#rules-list");
const reloadButton = document.querySelector("#reload-rules");

init().catch((error) => {
  renderError(getErrorMessage(error));
});

async function init() {
  reloadButton.addEventListener("click", () => {
    loadRules().catch((error) => {
      renderError(getErrorMessage(error));
    });
  });

  rulesList.addEventListener("click", (event) => {
    const button = event.target instanceof Element
      ? event.target.closest("button[data-action][data-hostname]")
      : null;

    if (!button) {
      return;
    }

    handleRuleAction(button.dataset.action, button.dataset.hostname).catch((error) => {
      renderError(getErrorMessage(error));
    });
  });

  await loadRules();
}

async function loadRules() {
  const response = await chrome.runtime.sendMessage({ type: "REFRESH_GET_DOMAIN_RULES" });

  if (!response.ok) {
    throw new Error(response.error);
  }

  renderRules(response.rules || []);
}

function renderRules(rules) {
  rulesList.textContent = "";

  if (!rules.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No domain rules yet.";
    rulesList.append(empty);
    return;
  }

  for (const rule of rules) {
    const item = document.createElement("article");
    const content = document.createElement("div");
    const title = document.createElement("div");
    const hostname = document.createElement("strong");
    const badge = document.createElement("span");
    const meta = document.createElement("p");
    const actions = document.createElement("div");
    const deleteButton = document.createElement("button");

    item.className = "rule-item";
    title.className = "rule-title";
    badge.className = rule.type === "never-run" ? "rule-badge is-blocked" : "rule-badge";
    actions.className = "rule-actions";
    deleteButton.className = "rule-action is-danger";
    deleteButton.type = "button";
    deleteButton.textContent = rule.type === "never-run" ? "Allow domain" : "Remove profile";
    deleteButton.dataset.action = "delete";
    deleteButton.dataset.hostname = rule.hostname;
    hostname.textContent = rule.hostname;
    badge.textContent = rule.type === "never-run" ? "Never run" : "Saved profile";
    meta.className = "rule-meta";
    meta.textContent = getRuleMeta(rule);

    title.append(hostname, badge);
    content.append(title, meta);

    if (rule.type === "saved-profile") {
      const blockButton = document.createElement("button");
      blockButton.className = "rule-action";
      blockButton.type = "button";
      blockButton.textContent = "Never run";
      blockButton.dataset.action = "never-run";
      blockButton.dataset.hostname = rule.hostname;
      actions.append(blockButton);
    }

    actions.append(deleteButton);
    item.append(content, actions);
    rulesList.append(item);
  }
}

async function handleRuleAction(action, hostname) {
  if (action === "delete") {
    const response = await chrome.runtime.sendMessage({
      type: "REFRESH_DELETE_DOMAIN_RULE",
      hostname
    });

    if (!response.ok) {
      throw new Error(response.error);
    }

    await loadRules();
    return;
  }

  if (action === "never-run") {
    const response = await chrome.runtime.sendMessage({
      type: "REFRESH_SET_DOMAIN_NEVER_RUN",
      hostname
    });

    if (!response.ok) {
      throw new Error(response.error);
    }

    await loadRules();
  }
}

function getRuleMeta(rule) {
  const updatedAt = formatTimestamp(rule.updatedAt);

  if (rule.type === "never-run") {
    return `Blocked domain · updated ${updatedAt}`;
  }

  return `${formatIntervalLabel(rule.intervalSeconds)} · Smart ${formatOnOff(rule.smartMode)} · Active tab only ${formatOnOff(rule.activeTabOnly)} · Typing guard ${formatOnOff(rule.typingProtectionEnabled)} · updated ${updatedAt}`;
}

function formatIntervalLabel(intervalSeconds) {
  const minutes = Number(intervalSeconds) / 60;

  if (Number.isInteger(minutes)) {
    return `${minutes} min`;
  }

  return `${Number(minutes.toFixed(2))} min`;
}

function formatOnOff(value) {
  return value ? "on" : "off";
}

function formatTimestamp(timestamp) {
  const value = Number(timestamp);

  if (!Number.isFinite(value) || value <= 0) {
    return "unknown";
  }

  return new Date(value).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function renderError(message) {
  rulesList.textContent = "";

  const error = document.createElement("p");
  error.className = "empty-state";
  error.textContent = message;
  rulesList.append(error);
}

function getErrorMessage(error) {
  if (error && typeof error.message === "string") {
    return error.message;
  }

  return String(error || "Unexpected error.");
}
