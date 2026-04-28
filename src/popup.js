const stateLabel = document.querySelector("#tab-state");
const countdown = document.querySelector("#countdown");
const statusMessage = document.querySelector("#status-message");
const toggleButton = document.querySelector("#toggle-refresh");
const intervalInputs = [...document.querySelectorAll("input[name='interval']")];
const customField = document.querySelector("#custom-field");
const customMinutesInput = document.querySelector("#custom-minutes");

const PREFERRED_INTERVAL_KEY = "refresh.preferredInterval";
const MIN_CUSTOM_MINUTES = 1;
const MAX_CUSTOM_MINUTES = 999;
const PRESET_SECONDS = [60, 300, 600];

let activeTab = null;
let currentSession = null;
let countdownTimer = null;
let isBusy = false;

init().catch((error) => {
  renderError(getErrorMessage(error));
});

async function init() {
  await restorePreferredInterval();
  activeTab = await getActiveTab();
  await refreshState();

  toggleButton.addEventListener("click", async () => {
    if (isBusy) {
      return;
    }

    if (currentSession && currentSession.enabled) {
      await stopRefresh();
    } else {
      await startRefresh();
    }
  });

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

    refreshState().catch((error) => {
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
      intervalSeconds: selection.intervalSeconds
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
    stateLabel.textContent = "Error";
    stateLabel.classList.add("is-error");
    countdown.textContent = "Blocked";
    statusMessage.textContent = session.error;
    statusMessage.classList.add("is-error");
    toggleButton.textContent = "Start refresh";
    toggleButton.classList.remove("is-stop");
    return;
  }

  if (!session || !session.enabled) {
    setControlsDisabled(false);
    stateLabel.textContent = "Inactive";
    countdown.textContent = "Not scheduled";
    statusMessage.textContent = "Choose an interval and start refresh for this tab.";
    toggleButton.textContent = "Start refresh";
    toggleButton.classList.remove("is-stop");
    return;
  }

  setControlsDisabled(true);

  const remainingMs = Math.max(0, session.dueAt - Date.now());
  const recentlyActive = session.lastActivityAt && Date.now() - session.lastActivityAt < 3500;
  const intervalLabel = formatIntervalLabel(session.intervalSeconds);

  if (recentlyActive) {
    stateLabel.textContent = "Waiting";
    stateLabel.classList.add("is-waiting");
    statusMessage.textContent = `Interaction detected. Timer restarted for ${intervalLabel}.`;
  } else {
    stateLabel.textContent = "Active";
    stateLabel.classList.add("is-active");
    statusMessage.textContent = `Running every ${intervalLabel}. Page activity resets the timer.`;
  }

  countdown.textContent = formatRemainingTime(remainingMs);
  toggleButton.textContent = "Stop refresh";
  toggleButton.classList.add("is-stop");
}

function renderValidationError(message) {
  clearStatusClasses();
  setControlsDisabled(false);
  stateLabel.textContent = "Error";
  stateLabel.classList.add("is-error");
  countdown.textContent = "Not scheduled";
  statusMessage.textContent = message;
  statusMessage.classList.add("is-error");
  customMinutesInput.setAttribute("aria-invalid", "true");
  toggleButton.textContent = "Start refresh";
  toggleButton.classList.remove("is-stop");
}

function clearStatusClasses() {
  stateLabel.classList.remove("is-active", "is-waiting", "is-error");
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

function updateCustomVisibility() {
  const selected = intervalInputs.find((input) => input.checked);
  const isCustom = selected && selected.value === "custom";
  customField.classList.toggle("is-visible", Boolean(isCustom));
}

function formatRemainingTime(ms) {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatIntervalLabel(intervalSeconds) {
  const minutes = intervalSeconds / 60;

  if (Number.isInteger(minutes)) {
    return `${minutes} min`;
  }

  return `${trimNumber(minutes)} min`;
}

function trimNumber(value) {
  return Number(value.toFixed(2)).toString();
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

function setBusy(nextBusy) {
  isBusy = nextBusy;
  toggleButton.disabled = nextBusy;
}

function renderError(message) {
  clearStatusClasses();
  currentSession = null;
  setControlsDisabled(false);
  stateLabel.textContent = "Error";
  stateLabel.classList.add("is-error");
  countdown.textContent = "Blocked";
  statusMessage.textContent = message;
  statusMessage.classList.add("is-error");
  toggleButton.textContent = "Start refresh";
  toggleButton.classList.remove("is-stop");
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
