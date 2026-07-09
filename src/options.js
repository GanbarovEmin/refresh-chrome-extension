const { getErrorMessage, formatIntervalLabel, getMsg, localizePage } = self.RefreshShared;

const rulesList = document.querySelector("#rules-list");
const reloadButton = document.querySelector("#reload-rules");
const exportButton = document.querySelector("#export-rules");
const importButton = document.querySelector("#import-rules");
const importFileInput = document.querySelector("#import-file");
const searchInput = document.querySelector("#rules-search");
const rulesSummary = document.querySelector("#rules-summary");

let allRules = [];

init().catch((error) => {
  renderError(getErrorMessage(error));
});

async function init() {
  localizePage();

  reloadButton.addEventListener("click", () => {
    loadRules().catch((error) => {
      renderError(getErrorMessage(error));
    });
  });

  exportButton.addEventListener("click", () => {
    exportRules();
  });

  importButton.addEventListener("click", () => {
    importFileInput.click();
  });

  importFileInput.addEventListener("change", () => {
    handleImportFile().catch((error) => {
      renderError(getErrorMessage(error));
    });
  });

  searchInput.addEventListener("input", () => {
    renderRules(getFilteredRules());
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

  allRules = Array.isArray(response.rules) ? response.rules : [];
  renderRules(getFilteredRules());
}

function renderRules(rules) {
  rulesList.textContent = "";
  renderRulesSummary(rules.length);

  if (!rules.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = allRules.length ? getMsg("optionsEmptySearch") : getMsg("optionsEmpty");
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

    item.className = rule.type === "never-run" ? "rule-item is-blocked" : "rule-item";
    title.className = "rule-title";
    badge.className = rule.type === "never-run" ? "rule-badge is-blocked" : "rule-badge";
    actions.className = "rule-actions";
    deleteButton.className = "rule-action is-danger";
    deleteButton.type = "button";
    deleteButton.textContent = rule.type === "never-run" ? getMsg("ruleAllow") : getMsg("ruleRemove");
    deleteButton.dataset.action = "delete";
    deleteButton.dataset.hostname = rule.hostname;
    deleteButton.setAttribute("aria-label", getMsg("ruleActionLabel", [deleteButton.textContent, rule.hostname]));
    hostname.textContent = rule.hostname;
    badge.textContent = rule.type === "never-run" ? getMsg("ruleBadgeBlocked") : getMsg("ruleBadgeSaved");
    meta.className = "rule-meta";
    meta.textContent = getRuleMeta(rule);

    title.append(hostname, badge);
    content.append(title, meta);

    if (rule.type === "saved-profile") {
      const blockButton = document.createElement("button");
      blockButton.className = "rule-action";
      blockButton.type = "button";
      blockButton.textContent = getMsg("ruleNeverRun");
      blockButton.dataset.action = "never-run";
      blockButton.dataset.hostname = rule.hostname;
      blockButton.setAttribute("aria-label", getMsg("ruleNeverRunLabel", rule.hostname));
      actions.append(blockButton);
    }

    actions.append(deleteButton);
    item.append(content, actions);
    rulesList.append(item);
  }
}

function getFilteredRules() {
  const query = searchInput.value.trim().toLowerCase();

  if (!query) {
    return allRules;
  }

  return allRules.filter((rule) => String(rule.hostname || "").toLowerCase().includes(query));
}

function renderRulesSummary(visibleCount) {
  const savedCount = allRules.filter((rule) => rule.type === "saved-profile").length;
  const blockedCount = allRules.filter((rule) => rule.type === "never-run").length;

  rulesSummary.textContent = getMsg("optionsSummary", [String(visibleCount), String(savedCount), String(blockedCount)]);
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
    return getMsg("ruleMetaBlocked", updatedAt);
  }

  return getMsg("ruleMetaSaved", [
    formatIntervalLabel(rule.intervalSeconds),
    formatOnOff(rule.smartMode),
    formatOnOff(rule.activeTabOnly),
    formatOnOff(rule.typingProtectionEnabled),
    updatedAt
  ]);
}

function formatOnOff(value) {
  return value ? getMsg("onoffOn") : getMsg("onoffOff");
}

function formatTimestamp(timestamp) {
  const value = Number(timestamp);

  if (!Number.isFinite(value) || value <= 0) {
    return getMsg("valueUnknown");
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
  rulesSummary.textContent = getMsg("optionsLoadError");

  const error = document.createElement("p");
  error.className = "empty-state";
  error.textContent = message;
  rulesList.append(error);
}

function exportRules() {
  const payload = {
    kind: "refresh-domain-rules",
    version: 1,
    exportedAt: new Date().toISOString(),
    rules: allRules
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = "refresh-domain-rules.json";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function handleImportFile() {
  const file = importFileInput.files && importFileInput.files[0];
  importFileInput.value = "";

  if (!file) {
    return;
  }

  let parsed;

  try {
    parsed = JSON.parse(await file.text());
  } catch (error) {
    renderError(getMsg("optionsImportError"));
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: "REFRESH_IMPORT_DOMAIN_RULES",
    rules: parsed
  });

  if (!response.ok) {
    throw new Error(response.error);
  }

  await loadRules();
  rulesSummary.textContent = getMsg("optionsImported", [String(response.imported), String(response.skipped)]);
}
