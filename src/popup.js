const stateLabel = document.querySelector("#tab-state");
const statusPanel = document.querySelector("#status-panel");
const progressRingValue = document.querySelector("#progress-ring-value");
const countdown = document.querySelector("#countdown");
const statusMessage = document.querySelector("#status-message");
const resetMessage = document.querySelector("#reset-message");
const toggleButton = document.querySelector("#toggle-refresh");
const resetButton = document.querySelector("#reset-timer");
const refreshNowButton = document.querySelector("#refresh-now");
const stopButton = document.querySelector("#stop-refresh");
const smartModeInput = document.querySelector("#smart-mode");
const activeTabModeInput = document.querySelector("#active-tab-mode");
const typingProtectionInput = document.querySelector("#typing-protection");
const nextRefreshAtValue = document.querySelector("#next-refresh-at");
const lastRefreshValue = document.querySelector("#last-refresh");
const refreshCountValue = document.querySelector("#refresh-count");
const historyList = document.querySelector("#history-list");
const intervalInputs = [...document.querySelectorAll("input[name='interval']")];
const customField = document.querySelector("#custom-field");
const customMinutesInput = document.querySelector("#custom-minutes");
const siteHostname = document.querySelector("#site-hostname");
const siteStatus = document.querySelector("#site-status");
const rememberSiteButton = document.querySelector("#remember-site");
const useSiteProfileButton = document.querySelector("#use-site-profile");
const neverRunSiteButton = document.querySelector("#never-run-site");
const openOptionsButton = document.querySelector("#open-options");
const activeTabsCount = document.querySelector("#active-tabs-count");
const activeTabsList = document.querySelector("#active-tabs-list");

const PREFERRED_INTERVAL_KEY = "refresh.preferredInterval";
const SAFETY_SETTINGS_KEY = "refresh.safetySettings.v1";
const MIN_CUSTOM_MINUTES = 1;
const MAX_CUSTOM_MINUTES = 999;
const PRESET_SECONDS = [60, 300, 600];

let activeTab = null;
let currentSession = null;
let siteContext = null;
let activeSessions = [];
let countdownTimer = null;
let isBusy = false;

init().catch((error) => {
  renderError(getErrorMessage(error));
});

async function init() {
  await restorePreferredInterval();
  await restoreSafetySettings();
  activeTab = await getActiveTab();
  await refreshState();
  await refreshWorkspaceState();

  toggleButton.addEventListener("click", async () => {
    if (isBusy) {
      return;
    }

    if (currentSession && currentSession.enabled && currentSession.paused) {
      await resumeRefresh();
    } else if (currentSession && currentSession.enabled) {
      await pauseRefresh();
    } else {
      await startRefresh();
    }
  });

  resetButton.addEventListener("click", () => {
    runSessionAction("REFRESH_RESET_TIMER").catch((error) => {
      renderError(getErrorMessage(error));
    });
  });

  refreshNowButton.addEventListener("click", () => {
    runSessionAction("REFRESH_REFRESH_NOW").catch((error) => {
      renderError(getErrorMessage(error));
    });
  });

  stopButton.addEventListener("click", () => {
    stopRefresh().catch((error) => {
      renderError(getErrorMessage(error));
    });
  });

  rememberSiteButton.addEventListener("click", () => {
    saveCurrentSiteProfile().catch((error) => {
      renderError(getErrorMessage(error));
    });
  });

  useSiteProfileButton.addEventListener("click", () => {
    useSavedSiteProfile().catch((error) => {
      renderError(getErrorMessage(error));
    });
  });

  neverRunSiteButton.addEventListener("click", () => {
    setNeverRunForSite().catch((error) => {
      renderError(getErrorMessage(error));
    });
  });

  openOptionsButton.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  activeTabsList.addEventListener("click", (event) => {
    const button = event.target instanceof Element
      ? event.target.closest("button[data-action][data-tab-id]")
      : null;

    if (!button) {
      return;
    }

    handleActiveTabAction(button.dataset.action, Number(button.dataset.tabId)).catch((error) => {
      renderError(getErrorMessage(error));
    });
  });

  smartModeInput.addEventListener("change", handleSafetySettingsChange);
  activeTabModeInput.addEventListener("change", handleSafetySettingsChange);
  typingProtectionInput.addEventListener("change", handleSafetySettingsChange);

  for (const input of intervalInputs) {
    input.addEventListener("change", () => {
      updateCustomVisibility();
      savePreferredSelection().catch(() => {});

      if (!currentSession || !currentSession.enabled) {
        renderState(currentSession);
      }
    });
  }

  customMinutesInput.addEventListener("input", () => {
    customMinutesInput.setAttribute("aria-invalid", "false");
    savePreferredSelection().catch(() => {});

    if (!currentSession || !currentSession.enabled) {
      renderState(currentSession);
    }
  });

  countdownTimer = window.setInterval(() => {
    if (isBusy) {
      renderState(currentSession);
      return;
    }

    refreshState()
      .then(() => refreshWorkspaceState())
      .catch((error) => {
        renderError(getErrorMessage(error));
      });
  }, 1000);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || typeof tab.id !== "number") {
    throw new Error("No active tab was found.");
  }

  return tab;
}

async function refreshState() {
  const response = await sendMessage({
    type: "REFRESH_GET_STATE",
    tabId: activeTab.id
  });

  if (!response.ok) {
    throw new Error(response.error);
  }

  currentSession = response.session;
  renderState(currentSession);
}

async function refreshWorkspaceState() {
  await refreshSiteContext();
  await refreshActiveSessions();
}

async function refreshSiteContext() {
  const response = await sendMessage({
    type: "REFRESH_GET_SITE_CONTEXT",
    tabId: activeTab.id
  });

  if (!response.ok) {
    throw new Error(response.error);
  }

  siteContext = response;
  renderSiteContext();
}

async function refreshActiveSessions() {
  const response = await sendMessage({
    type: "REFRESH_GET_ACTIVE_SESSIONS",
    currentTabId: activeTab.id
  });

  if (!response.ok) {
    throw new Error(response.error);
  }

  activeSessions = Array.isArray(response.sessions) ? response.sessions : [];
  renderActiveSessions(activeSessions, Number(response.total) || activeSessions.length);
}

async function startRefresh() {
  const selection = getSelectedIntervalSelection();

  if (!selection.ok) {
    renderValidationError(selection.error);
    return;
  }

  setBusy(true);

  try {
    await savePreferredSelection();

    const response = await sendMessage({
      type: "REFRESH_START",
      tabId: activeTab.id,
      intervalSeconds: selection.intervalSeconds,
      settings: getSafetySettings()
    });

    if (!response.ok) {
      currentSession = {
        enabled: false,
        error: response.error
      };
      renderState(currentSession);
      return;
    }

    currentSession = response.session;
    renderState(currentSession);
    await refreshWorkspaceState();
  } finally {
    setBusy(false);
  }
}

async function stopRefresh() {
  setBusy(true);

  try {
    const response = await sendMessage({
      type: "REFRESH_STOP",
      tabId: activeTab.id
    });

    if (!response.ok) {
      throw new Error(response.error);
    }

    currentSession = null;
    renderState(currentSession);
    await refreshWorkspaceState();
  } finally {
    setBusy(false);
  }
}

async function saveCurrentSiteProfile() {
  const selection = currentSession && currentSession.enabled
    ? { ok: true, intervalSeconds: currentSession.intervalSeconds }
    : getSelectedIntervalSelection();

  if (!selection.ok) {
    renderValidationError(selection.error);
    return;
  }

  setBusy(true);

  try {
    const settings = currentSession && currentSession.enabled
      ? {
        smartMode: currentSession.smartMode !== false,
        activeTabOnly: Boolean(currentSession.activeTabOnly),
        typingProtectionEnabled: currentSession.typingProtectionEnabled !== false
      }
      : getSafetySettings();
    const response = await sendMessage({
      type: "REFRESH_SAVE_SITE_PROFILE",
      tabId: activeTab.id,
      profile: {
        intervalSeconds: selection.intervalSeconds,
        ...settings
      }
    });

    if (!response.ok) {
      throw new Error(response.error);
    }

    await refreshSiteContext();
  } finally {
    setBusy(false);
  }
}

async function useSavedSiteProfile() {
  const rule = siteContext && siteContext.rule;

  if (!rule || rule.type !== "saved-profile") {
    return;
  }

  setSelectedIntervalSeconds(rule.intervalSeconds);
  setSafetySettings(rule);
  updateCustomVisibility();
  await savePreferredSelection();
  await saveSafetySettings();
  await startRefresh();
}

async function setNeverRunForSite() {
  setBusy(true);

  try {
    const response = await sendMessage({
      type: "REFRESH_SET_NEVER_RUN",
      tabId: activeTab.id
    });

    if (!response.ok) {
      throw new Error(response.error);
    }

    currentSession = null;
    renderState(currentSession);
    await refreshWorkspaceState();
  } finally {
    setBusy(false);
  }
}

async function handleActiveTabAction(action, tabId) {
  if (!Number.isInteger(tabId)) {
    return;
  }

  if (action === "open") {
    const response = await sendMessage({
      type: "REFRESH_FOCUS_TAB",
      tabId
    });

    if (!response.ok) {
      throw new Error(response.error);
    }

    return;
  }

  if (action === "stop") {
    const response = await sendMessage({
      type: "REFRESH_STOP",
      tabId
    });

    if (!response.ok) {
      throw new Error(response.error);
    }

    if (tabId === activeTab.id) {
      currentSession = null;
      renderState(currentSession);
    }

    await refreshWorkspaceState();
  }
}

async function pauseRefresh() {
  await runSessionAction("REFRESH_PAUSE");
}

async function resumeRefresh() {
  await runSessionAction("REFRESH_RESUME");
}

async function runSessionAction(type) {
  setBusy(true);

  try {
    const response = await sendMessage({
      type,
      tabId: activeTab.id
    });

    if (!response.ok) {
      currentSession = {
        enabled: false,
        error: response.error
      };
      renderState(currentSession);
      return;
    }

    currentSession = response.session;
    renderState(currentSession);
    await refreshWorkspaceState();
  } finally {
    setBusy(false);
  }
}

async function handleSafetySettingsChange() {
  await saveSafetySettings();

  if (!currentSession || !currentSession.enabled) {
    return;
  }

  await runSessionSettingsUpdate();
}

async function runSessionSettingsUpdate() {
  setBusy(true);

  try {
    const response = await sendMessage({
      type: "REFRESH_UPDATE_SETTINGS",
      tabId: activeTab.id,
      settings: getSafetySettings()
    });

    if (!response.ok) {
      throw new Error(response.error);
    }

    currentSession = response.session;
    renderState(currentSession);
  } finally {
    setBusy(false);
  }
}

function renderState(session) {
  clearStatusClasses();
  customMinutesInput.setAttribute("aria-invalid", "false");

  if (session && session.intervalSeconds) {
    setSelectedIntervalSeconds(session.intervalSeconds);
  }

  updateCustomVisibility();

  if (session && session.error) {
    setControlsDisabled(false);
    setStatusVisualState("error");
    renderProgressRing(0);
    stateLabel.textContent = "Error";
    stateLabel.classList.add("is-error");
    countdown.textContent = "Blocked";
    statusMessage.textContent = session.error;
    statusMessage.classList.add("is-error");
    resetMessage.textContent = "Not available";
    nextRefreshAtValue.textContent = "Not scheduled";
    lastRefreshValue.textContent = "Never";
    refreshCountValue.textContent = "0";
    renderHistory(session.history);
    setSessionActionsDisabled(true);
    toggleButton.textContent = "Start refresh";
    return;
  }

  if (!session || !session.enabled) {
    setControlsDisabled(false);
    setStatusVisualState("inactive");
    renderProgressRing(0);
    stateLabel.textContent = "Inactive";
    countdown.textContent = "Not scheduled";
    statusMessage.textContent = "Choose an interval and start refresh for this tab.";
    resetMessage.textContent = "Not started";
    nextRefreshAtValue.textContent = "Not scheduled";
    lastRefreshValue.textContent = "Never";
    refreshCountValue.textContent = "0";
    renderHistory([]);
    setSessionActionsDisabled(true);
    toggleButton.textContent = "Start refresh";
    return;
  }

  setSafetySettings(session);
  setControlsDisabled(true);
  setSessionActionsDisabled(false);

  const remainingMs = getSessionRemainingMs(session);
  const progressRatio = getProgressRatio(session, remainingMs);
  const recentlyClicked = session.lastResetReason === "click" && session.lastActivityAt && Date.now() - session.lastActivityAt < 3500;
  const intervalLabel = formatIntervalLabel(session.intervalSeconds);

  if (session.paused) {
    setStatusVisualState("paused");
    stateLabel.textContent = "Paused";
    stateLabel.classList.add("is-paused");
    statusMessage.textContent = `Paused with ${formatRemainingTime(remainingMs)} remaining. Resume keeps the saved countdown.`;
    toggleButton.textContent = "Resume";
  } else if (session.skipReason === "inactive") {
    setStatusVisualState("skipped");
    stateLabel.textContent = "Skipped";
    stateLabel.classList.add("is-skipped");
    statusMessage.textContent = "Skipped because tab is inactive.";
    toggleButton.textContent = "Pause";
  } else if (session.skipReason === "typing") {
    setStatusVisualState("postponed");
    stateLabel.textContent = "Waiting";
    stateLabel.classList.add("is-postponed");
    statusMessage.textContent = "Typing detected. Refresh postponed.";
    toggleButton.textContent = "Pause";
  } else if (recentlyClicked) {
    setStatusVisualState("waiting");
    stateLabel.textContent = "Waiting";
    stateLabel.classList.add("is-waiting");
    statusMessage.textContent = `Click detected. Timer restarted for ${intervalLabel}.`;
    toggleButton.textContent = "Pause";
  } else {
    setStatusVisualState("active");
    stateLabel.textContent = "Active";
    stateLabel.classList.add("is-active");
    statusMessage.textContent = session.smartMode
      ? `Running every ${intervalLabel}. Click inside the page resets the timer.`
      : `Running every ${intervalLabel}. Smart mode is off; clicks are logged only.`;
    toggleButton.textContent = "Pause";
  }

  countdown.textContent = formatRemainingTime(remainingMs);
  renderProgressRing(progressRatio);
  resetMessage.textContent = formatLastResetReason(session.lastResetReason);
  nextRefreshAtValue.textContent = session.paused ? "Paused" : formatTimestamp(session.nextRefreshAt || session.dueAt, "Not scheduled");
  lastRefreshValue.textContent = formatTimestamp(session.lastRefreshAt);
  refreshCountValue.textContent = String(Number(session.refreshCount || 0));
  renderHistory(session.history);
}

function renderValidationError(message) {
  clearStatusClasses();
  setControlsDisabled(false);
  setStatusVisualState("error");
  renderProgressRing(0);
  stateLabel.textContent = "Error";
  stateLabel.classList.add("is-error");
  countdown.textContent = "Not scheduled";
  statusMessage.textContent = message;
  statusMessage.classList.add("is-error");
  resetMessage.textContent = "Not started";
  nextRefreshAtValue.textContent = "Not scheduled";
  lastRefreshValue.textContent = "Never";
  refreshCountValue.textContent = "0";
  renderHistory([]);
  setSessionActionsDisabled(true);
  customMinutesInput.setAttribute("aria-invalid", "true");
  toggleButton.textContent = "Start refresh";
}

function clearStatusClasses() {
  stateLabel.classList.remove("is-active", "is-waiting", "is-paused", "is-skipped", "is-postponed", "is-error");
  statusMessage.classList.remove("is-error");
}

function getSelectedIntervalSelection() {
  const selected = intervalInputs.find((input) => input.checked);
  const selectedValue = selected ? selected.value : "60";

  if (selectedValue !== "custom") {
    return { ok: true, intervalSeconds: Number(selectedValue) };
  }

  const customMinutes = Number(customMinutesInput.value);

  if (!Number.isFinite(customMinutes) || customMinutes < MIN_CUSTOM_MINUTES || customMinutes > MAX_CUSTOM_MINUTES) {
    return { ok: false, error: "Enter a custom interval from 1 to 999 minutes." };
  }

  return {
    ok: true,
    intervalSeconds: Math.round(customMinutes * 60)
  };
}

function setSelectedIntervalSeconds(intervalSeconds) {
  const roundedSeconds = Math.round(Number(intervalSeconds));
  const presetInput = intervalInputs.find((input) => Number(input.value) === roundedSeconds);

  for (const input of intervalInputs) {
    input.checked = presetInput ? input === presetInput : input.value === "custom";
  }

  if (!presetInput && roundedSeconds >= 60) {
    customMinutesInput.value = trimNumber(roundedSeconds / 60);
  }
}

function setControlsDisabled(disabled) {
  for (const input of intervalInputs) {
    input.disabled = disabled;
  }

  customMinutesInput.disabled = disabled;
}

function setSessionActionsDisabled(disabled) {
  resetButton.disabled = disabled;
  refreshNowButton.disabled = disabled;
  stopButton.disabled = disabled;
}

function setStatusVisualState(state) {
  statusPanel.classList.remove("is-active", "is-paused", "is-skipped", "is-postponed", "is-waiting", "is-error");

  if (state && state !== "inactive") {
    statusPanel.classList.add(`is-${state}`);
  }
}

function renderProgressRing(ratio) {
  const progress = clamp(Number(ratio) || 0, 0, 1);
  progressRingValue.style.strokeDashoffset = String(100 - progress * 100);
}

function setSafetyControlsDisabled(disabled) {
  smartModeInput.disabled = disabled;
  activeTabModeInput.disabled = disabled;
  typingProtectionInput.disabled = disabled;
}

function updateCustomVisibility() {
  const selected = intervalInputs.find((input) => input.checked);
  const isCustom = selected && selected.value === "custom";
  customField.classList.toggle("is-visible", Boolean(isCustom));
}

function getSafetySettings() {
  return {
    smartMode: smartModeInput.checked,
    activeTabOnly: activeTabModeInput.value === "active",
    typingProtectionEnabled: typingProtectionInput.checked
  };
}

function setSafetySettings(settings = {}) {
  smartModeInput.checked = settings.smartMode !== false;
  activeTabModeInput.value = settings.activeTabOnly ? "active" : "always";
  typingProtectionInput.checked = settings.typingProtectionEnabled !== false;
}

function formatRemainingTime(ms) {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function getSessionRemainingMs(session) {
  if (session.paused) {
    return Math.max(0, Number(session.pausedRemainingMs) || 0);
  }

  return Math.max(0, Number(session.dueAt) - Date.now());
}

function getProgressRatio(session, remainingMs) {
  const intervalMs = Number(session.intervalSeconds) * 1000;

  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return 0;
  }

  return remainingMs / intervalMs;
}

function formatIntervalLabel(intervalSeconds) {
  const minutes = intervalSeconds / 60;

  if (Number.isInteger(minutes)) {
    return `${minutes} min`;
  }

  return `${trimNumber(minutes)} min`;
}

function formatLastResetReason(reason) {
  if (reason === "click") {
    return "Click";
  }

  if (reason === "refresh") {
    return "Auto refresh";
  }

  if (reason === "start") {
    return "Start";
  }

  if (reason === "pause") {
    return "Pause";
  }

  if (reason === "resume") {
    return "Resume";
  }

  if (reason === "manual-reset") {
    return "Reset timer";
  }

  if (reason === "manual-refresh") {
    return "Refresh now";
  }

  return "Not started";
}

function renderHistory(history = []) {
  historyList.textContent = "";

  const events = Array.isArray(history) ? history.slice(-5).reverse() : [];

  if (!events.length) {
    const item = document.createElement("li");
    item.textContent = "No events yet";
    historyList.append(item);
    return;
  }

  for (const event of events) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    const time = document.createElement("time");

    label.textContent = event.label || "Event";
    time.textContent = formatTimestamp(event.at, "");
    item.append(label, time);
    historyList.append(item);
  }
}

function renderSiteContext() {
  const hostname = siteContext && siteContext.hostname;
  const rule = siteContext && siteContext.rule;
  const supported = Boolean(siteContext && siteContext.supported);
  const isBlocked = rule && rule.type === "never-run";
  const hasSavedProfile = rule && rule.type === "saved-profile";
  const hasRunningSession = Boolean(currentSession && currentSession.enabled);

  siteStatus.classList.toggle("is-blocked", Boolean(isBlocked));
  siteHostname.textContent = hostname || "No domain";

  if (!supported) {
    siteStatus.textContent = siteContext && siteContext.unsupportedReason
      ? siteContext.unsupportedReason
      : "Site profiles are available for regular web domains.";
  } else if (isBlocked) {
    siteStatus.textContent = "Refresh is disabled for this domain. Remove the rule in Options to run it again.";
  } else if (hasSavedProfile) {
    siteStatus.textContent = `Saved profile available: ${formatIntervalLabel(rule.intervalSeconds)}.`;
  } else {
    siteStatus.textContent = "No profile saved for this site.";
  }

  rememberSiteButton.disabled = isBusy || !supported || isBlocked;
  useSiteProfileButton.disabled = isBusy || !supported || !hasSavedProfile || hasRunningSession || isBlocked;
  neverRunSiteButton.disabled = isBusy || !supported || isBlocked;
  openOptionsButton.disabled = isBusy;

  if (isBlocked && !hasRunningSession) {
    renderDomainBlockedStatus();
  }

  applySiteRestriction();
}

function renderDomainBlockedStatus() {
  clearStatusClasses();
  setStatusVisualState("error");
  renderProgressRing(0);
  stateLabel.textContent = "Blocked";
  stateLabel.classList.add("is-error");
  countdown.textContent = "Blocked";
  statusMessage.textContent = "Refresh is disabled for this domain. Remove the rule in Options to start again.";
  statusMessage.classList.add("is-error");
  resetMessage.textContent = "Domain rule";
  nextRefreshAtValue.textContent = "Not scheduled";
  lastRefreshValue.textContent = "Never";
  refreshCountValue.textContent = "0";
  renderHistory([]);
  setSessionActionsDisabled(true);
  toggleButton.textContent = "Start refresh";
}

function renderActiveSessions(sessions = [], total = sessions.length) {
  activeTabsList.textContent = "";
  activeTabsCount.textContent = String(total);

  if (!sessions.length) {
    const item = document.createElement("li");
    item.textContent = "No active refresh tabs";
    activeTabsList.append(item);
    return;
  }

  for (const session of sessions) {
    const item = document.createElement("li");
    const main = document.createElement("div");
    const title = document.createElement("strong");
    const meta = document.createElement("span");
    const controls = document.createElement("div");
    const openButton = document.createElement("button");
    const stopButtonItem = document.createElement("button");

    item.className = "active-tab-item";
    main.className = "active-tab-main";
    controls.className = "active-tab-controls";
    title.textContent = session.title || session.hostname || "Untitled";
    title.title = title.textContent;
    meta.textContent = `${session.hostname || "local"} · ${formatIntervalLabel(session.intervalSeconds)} · ${formatActiveTabStatus(session)}`;
    openButton.className = "active-tab-action";
    openButton.type = "button";
    openButton.textContent = "Open";
    openButton.dataset.action = "open";
    openButton.dataset.tabId = String(session.tabId);
    stopButtonItem.className = "active-tab-action";
    stopButtonItem.type = "button";
    stopButtonItem.textContent = "Stop";
    stopButtonItem.dataset.action = "stop";
    stopButtonItem.dataset.tabId = String(session.tabId);

    main.append(title, meta);

    if (session.isCurrent) {
      const currentLabel = document.createElement("span");
      currentLabel.className = "active-tab-current";
      currentLabel.textContent = "Current";
      controls.append(currentLabel);
    } else {
      controls.append(openButton);
    }

    controls.append(stopButtonItem);
    item.append(main, controls);
    activeTabsList.append(item);
  }
}

function formatActiveTabStatus(session) {
  if (session.paused) {
    return "Paused";
  }

  if (session.skipReason === "inactive") {
    return "Skipped";
  }

  if (session.skipReason === "typing") {
    return "Waiting";
  }

  return formatRemainingTime(Math.max(0, Number(session.dueAt) - Date.now()));
}

function formatTimestamp(timestamp, fallback = "Never") {
  const value = Number(timestamp);

  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function trimNumber(value) {
  return Number(value.toFixed(2)).toString();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

async function restorePreferredInterval() {
  const result = await chrome.storage.local.get(PREFERRED_INTERVAL_KEY);
  const preferred = result[PREFERRED_INTERVAL_KEY];

  if (typeof preferred === "number" && PRESET_SECONDS.includes(preferred * 60)) {
    setSelectedIntervalSeconds(preferred * 60);
    return;
  }

  if (!preferred || typeof preferred !== "object") {
    updateCustomVisibility();
    return;
  }

  if (preferred.mode === "custom") {
    const customMinutes = Number(preferred.customMinutes);

    if (Number.isFinite(customMinutes)) {
      customMinutesInput.value = trimNumber(customMinutes);
    }

    for (const input of intervalInputs) {
      input.checked = input.value === "custom";
    }
  } else if (PRESET_SECONDS.includes(Number(preferred.intervalSeconds))) {
    setSelectedIntervalSeconds(Number(preferred.intervalSeconds));
  }

  updateCustomVisibility();
}

async function restoreSafetySettings() {
  const result = await chrome.storage.local.get(SAFETY_SETTINGS_KEY);
  const settings = result[SAFETY_SETTINGS_KEY];

  if (!settings || typeof settings !== "object") {
    setSafetySettings();
    return;
  }

  setSafetySettings(settings);
}

async function savePreferredSelection() {
  const selection = getSelectedIntervalSelection();
  const selected = intervalInputs.find((input) => input.checked);

  if (!selected || !selection.ok) {
    return;
  }

  await chrome.storage.local.set({
    [PREFERRED_INTERVAL_KEY]: {
      mode: selected.value === "custom" ? "custom" : "preset",
      intervalSeconds: selection.intervalSeconds,
      customMinutes: selected.value === "custom" ? Number(customMinutesInput.value) : null
    }
  });
}

async function saveSafetySettings() {
  await chrome.storage.local.set({
    [SAFETY_SETTINGS_KEY]: getSafetySettings()
  });
}

function setBusy(nextBusy) {
  isBusy = nextBusy;
  toggleButton.disabled = nextBusy;
  resetButton.disabled = nextBusy || !(currentSession && currentSession.enabled);
  refreshNowButton.disabled = nextBusy || !(currentSession && currentSession.enabled);
  stopButton.disabled = nextBusy || !(currentSession && currentSession.enabled);
  setSafetyControlsDisabled(nextBusy);

  if (siteContext) {
    renderSiteContext();
  }

  applySiteRestriction();
}

function applySiteRestriction() {
  const rule = siteContext && siteContext.rule;
  const isBlocked = rule && rule.type === "never-run";
  const hasRunningSession = Boolean(currentSession && currentSession.enabled);

  if (!isBusy) {
    toggleButton.disabled = Boolean(isBlocked && !hasRunningSession);
  }
}

function renderError(message) {
  clearStatusClasses();
  currentSession = null;
  setControlsDisabled(false);
  setStatusVisualState("error");
  renderProgressRing(0);
  stateLabel.textContent = "Error";
  stateLabel.classList.add("is-error");
  countdown.textContent = "Blocked";
  statusMessage.textContent = message;
  statusMessage.classList.add("is-error");
  resetMessage.textContent = "Not available";
  nextRefreshAtValue.textContent = "Not scheduled";
  lastRefreshValue.textContent = "Never";
  refreshCountValue.textContent = "0";
  renderHistory([]);
  setSessionActionsDisabled(true);
  toggleButton.textContent = "Start refresh";
}

function getErrorMessage(error) {
  if (error && typeof error.message === "string") {
    return error.message;
  }

  return String(error || "Unexpected error.");
}

window.addEventListener("unload", () => {
  if (countdownTimer) {
    window.clearInterval(countdownTimer);
  }
});
