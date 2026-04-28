const stateLabel = document.querySelector("#tab-state");
const countdown = document.querySelector("#countdown");
const statusMessage = document.querySelector("#status-message");
const toggleButton = document.querySelector("#toggle-refresh");
const intervalInputs = [...document.querySelectorAll("input[name='interval']")];
const PREFERRED_INTERVAL_KEY = "refresh.preferredInterval";

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
      if (input.checked) {
        savePreferredInterval(Number(input.value)).catch(() => {});
      }

      if (!currentSession || !currentSession.enabled) {
        renderState(currentSession);
      }
    });
  }

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
  setBusy(true);

  try {
    await savePreferredInterval(getSelectedInterval());

    const response = await sendMessage({
      type: "REFRESH_START",
      tabId: activeTab.id,
      intervalMinutes: getSelectedInterval()
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

  if (session && session.intervalMinutes) {
    setSelectedInterval(session.intervalMinutes);
  }

  if (session && session.error) {
    setIntervalInputsDisabled(false);
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
    setIntervalInputsDisabled(false);
    stateLabel.textContent = "Inactive";
    countdown.textContent = "Not scheduled";
    statusMessage.textContent = "Choose an interval and start refresh for this tab.";
    toggleButton.textContent = "Start refresh";
    toggleButton.classList.remove("is-stop");
    return;
  }

  setIntervalInputsDisabled(true);

  const remainingMs = Math.max(0, session.dueAt - Date.now());
  const recentlyActive = session.lastActivityAt && Date.now() - session.lastActivityAt < 3500;

  if (recentlyActive) {
    stateLabel.textContent = "Waiting";
    stateLabel.classList.add("is-waiting");
    statusMessage.textContent = "Page interaction detected. Timer restarted after activity.";
  } else {
    stateLabel.textContent = "Active";
    stateLabel.classList.add("is-active");
    statusMessage.textContent = "Refresh is running on this tab. Any page interaction resets the timer.";
  }

  countdown.textContent = formatRemainingTime(remainingMs);
  toggleButton.textContent = "Stop refresh";
  toggleButton.classList.add("is-stop");
}

function clearStatusClasses() {
  stateLabel.classList.remove("is-active", "is-waiting", "is-error");
  statusMessage.classList.remove("is-error");
}

function getSelectedInterval() {
  const selected = intervalInputs.find((input) => input.checked);
  return Number(selected ? selected.value : 1);
}

function setSelectedInterval(intervalMinutes) {
  for (const input of intervalInputs) {
    input.checked = Number(input.value) === Number(intervalMinutes);
  }
}

function setIntervalInputsDisabled(disabled) {
  for (const input of intervalInputs) {
    input.disabled = disabled;
  }
}

function formatRemainingTime(ms) {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

async function restorePreferredInterval() {
  const result = await chrome.storage.local.get(PREFERRED_INTERVAL_KEY);
  const preferredInterval = Number(result[PREFERRED_INTERVAL_KEY]);

  if ([1, 5, 10].includes(preferredInterval)) {
    setSelectedInterval(preferredInterval);
  }
}

async function savePreferredInterval(intervalMinutes) {
  if (![1, 5, 10].includes(Number(intervalMinutes))) {
    return;
  }

  await chrome.storage.local.set({ [PREFERRED_INTERVAL_KEY]: Number(intervalMinutes) });
}

function setBusy(nextBusy) {
  isBusy = nextBusy;
  toggleButton.disabled = nextBusy;
}

function renderError(message) {
  clearStatusClasses();
  currentSession = null;
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
