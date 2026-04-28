const SESSION_KEY = "refresh.sessions.v1";
const ALARM_PREFIX = "refresh-tab:";
const ACTIVITY_IDLE_DELAY_MS = 1500;
const SUPPORTED_PROTOCOLS = ["http:", "https:", "file:"];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));

  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) {
    return;
  }

  const tabId = Number(alarm.name.slice(ALARM_PREFIX.length));
  handleRefreshAlarm(tabId).catch(async (error) => {
    await setTabError(tabId, getErrorMessage(error));
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  removeSession(tabId).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") {
    return;
  }

  restoreContentScript(tabId).catch(async (error) => {
    await setTabError(tabId, getErrorMessage(error));
  });
});

chrome.runtime.onStartup.addListener(() => {
  restoreAlarms().catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  restoreAlarms().catch(() => {});
});

async function handleMessage(message, sender) {
  if (!message || typeof message.type !== "string") {
    return { ok: false, error: "Unknown message." };
  }

  if (message.type === "REFRESH_GET_STATE") {
    return getStateResponse(message.tabId);
  }

  if (message.type === "REFRESH_START") {
    return startSession(message.tabId, message.intervalMinutes);
  }

  if (message.type === "REFRESH_STOP") {
    await removeSession(message.tabId);
    return { ok: true };
  }

  if (message.type === "REFRESH_USER_ACTIVITY") {
    const tabId = sender.tab && sender.tab.id;
    await resetSessionAfterActivity(tabId, message.at);
    return { ok: true };
  }

  if (message.type === "REFRESH_CONTENT_READY") {
    return { ok: true };
  }

  return { ok: false, error: "Unknown message." };
}

async function startSession(tabId, intervalMinutes) {
  const normalizedTabId = normalizeTabId(tabId);
  const normalizedInterval = normalizeInterval(intervalMinutes);
  const tab = await chrome.tabs.get(normalizedTabId);
  const unsupportedReason = getUnsupportedReason(tab.url);

  if (unsupportedReason) {
    await setTabError(normalizedTabId, unsupportedReason, tab.url);
    return { ok: false, error: unsupportedReason };
  }

  const now = Date.now();
  const session = {
    tabId: normalizedTabId,
    intervalMinutes: normalizedInterval,
    enabled: true,
    dueAt: now + minutesToMs(normalizedInterval),
    startedAt: now,
    lastActivityAt: null,
    lastRefreshAt: null,
    lastResetReason: "start",
    url: tab.url || "",
    title: tab.title || ""
  };

  try {
    await injectContentScript(normalizedTabId);
  } catch (error) {
    const message = getErrorMessage(error);
    await setTabError(normalizedTabId, message, tab.url);
    throw new Error(message);
  }

  await saveSession(session);
  await scheduleAlarm(session);

  return { ok: true, session };
}

async function getStateResponse(tabId) {
  const normalizedTabId = normalizeTabId(tabId);
  const sessions = await readSessions();
  const session = sessions[String(normalizedTabId)] || null;

  return { ok: true, session, now: Date.now() };
}

async function resetSessionAfterActivity(tabId, activityAt) {
  if (typeof tabId !== "number") {
    return;
  }

  const sessions = await readSessions();
  const key = String(tabId);
  const session = sessions[key];

  if (!session || !session.enabled) {
    return;
  }

  const now = Number(activityAt) || Date.now();
  session.lastActivityAt = now;
  session.lastResetReason = "activity";
  session.dueAt = now + ACTIVITY_IDLE_DELAY_MS + minutesToMs(session.intervalMinutes);

  sessions[key] = session;
  await writeSessions(sessions);
  await scheduleAlarm(session);
}

async function handleRefreshAlarm(tabId) {
  const sessions = await readSessions();
  const key = String(tabId);
  const session = sessions[key];

  if (!session || !session.enabled) {
    await clearAlarm(tabId);
    return;
  }

  if (Date.now() + 500 < session.dueAt) {
    await scheduleAlarm(session);
    return;
  }

  const tab = await chrome.tabs.get(tabId);
  const unsupportedReason = getUnsupportedReason(tab.url);

  if (unsupportedReason) {
    await setTabError(tabId, unsupportedReason, tab.url);
    return;
  }

  await chrome.tabs.reload(tabId);

  const now = Date.now();
  session.lastRefreshAt = now;
  session.lastResetReason = "refresh";
  session.dueAt = now + minutesToMs(session.intervalMinutes);
  session.url = tab.url || session.url || "";
  session.title = tab.title || session.title || "";

  sessions[key] = session;
  await writeSessions(sessions);
  await scheduleAlarm(session);
}

async function restoreContentScript(tabId) {
  const sessions = await readSessions();
  const session = sessions[String(tabId)];

  if (!session || !session.enabled) {
    return;
  }

  const tab = await chrome.tabs.get(tabId);
  const unsupportedReason = getUnsupportedReason(tab.url);

  if (unsupportedReason) {
    await setTabError(tabId, unsupportedReason, tab.url);
    return;
  }

  session.url = tab.url || session.url || "";
  session.title = tab.title || session.title || "";
  sessions[String(tabId)] = session;
  await writeSessions(sessions);
  await injectContentScript(tabId);
}

async function restoreAlarms() {
  const sessions = await readSessions();
  const now = Date.now();

  await Promise.all(
    Object.values(sessions).map(async (session) => {
      if (!session || !session.enabled) {
        return;
      }

      if (session.dueAt <= now) {
        session.dueAt = now + minutesToMs(session.intervalMinutes);
        await saveSession(session);
      }

      await scheduleAlarm(session);
    })
  );
}

async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["src/content.js"]
  });
}

async function scheduleAlarm(session) {
  await chrome.alarms.create(getAlarmName(session.tabId), { when: session.dueAt });
}

async function clearAlarm(tabId) {
  await chrome.alarms.clear(getAlarmName(tabId));
}

async function removeSession(tabId) {
  const normalizedTabId = normalizeTabId(tabId);
  const sessions = await readSessions();

  delete sessions[String(normalizedTabId)];
  await writeSessions(sessions);
  await clearAlarm(normalizedTabId);
}

async function setTabError(tabId, error, url = "") {
  const normalizedTabId = normalizeTabId(tabId);
  const sessions = await readSessions();

  sessions[String(normalizedTabId)] = {
    tabId: normalizedTabId,
    enabled: false,
    intervalMinutes: null,
    dueAt: null,
    error,
    errorAt: Date.now(),
    url
  };

  await writeSessions(sessions);
  await clearAlarm(normalizedTabId);
}

async function saveSession(session) {
  const sessions = await readSessions();
  sessions[String(session.tabId)] = session;
  await writeSessions(sessions);
}

async function readSessions() {
  const data = await chrome.storage.session.get(SESSION_KEY);
  const sessions = data[SESSION_KEY];

  if (!sessions || typeof sessions !== "object") {
    return {};
  }

  return sessions;
}

async function writeSessions(sessions) {
  await chrome.storage.session.set({ [SESSION_KEY]: sessions });
}

function getAlarmName(tabId) {
  return `${ALARM_PREFIX}${tabId}`;
}

function normalizeTabId(tabId) {
  const normalized = Number(tabId);

  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new Error("No active tab was found.");
  }

  return normalized;
}

function normalizeInterval(intervalMinutes) {
  const normalized = Number(intervalMinutes);

  if ([1, 5, 10].includes(normalized)) {
    return normalized;
  }

  throw new Error("Choose a 1, 5, or 10 minute interval.");
}

function minutesToMs(minutes) {
  return minutes * 60 * 1000;
}

function getUnsupportedReason(urlValue) {
  if (!urlValue) {
    return "This tab cannot be refreshed by the extension.";
  }

  let url;

  try {
    url = new URL(urlValue);
  } catch (error) {
    return "This tab has an unsupported URL.";
  }

  if (!SUPPORTED_PROTOCOLS.includes(url.protocol)) {
    return "Refresh cannot run on browser system pages.";
  }

  if (url.hostname === "chrome.google.com" || url.hostname === "chromewebstore.google.com") {
    return "Chrome blocks extensions from running on the Chrome Web Store.";
  }

  return "";
}

function getErrorMessage(error) {
  if (error && typeof error.message === "string") {
    return error.message;
  }

  return String(error || "Unexpected error.");
}
