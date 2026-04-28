const SESSION_KEY = "refresh.sessions.v1";
const ALARM_PREFIX = "refresh-tab:";
const ACTIVITY_IDLE_DELAY_MS = 1500;
const BADGE_TICK_MS = 1000;
const MIN_INTERVAL_SECONDS = 60;
const MAX_INTERVAL_SECONDS = 999 * 60;
const SUPPORTED_PROTOCOLS = ["http:", "https:", "file:"];

let badgeTimerId = null;

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
    return startSession(message.tabId, message.intervalSeconds, message.intervalMinutes);
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

async function startSession(tabId, intervalSeconds, legacyIntervalMinutes) {
  const normalizedTabId = normalizeTabId(tabId);
  const normalizedIntervalSeconds = normalizeIntervalSeconds(intervalSeconds, legacyIntervalMinutes);
  const tab = await chrome.tabs.get(normalizedTabId);
  const unsupportedReason = getUnsupportedReason(tab.url);

  if (unsupportedReason) {
    await setTabError(normalizedTabId, unsupportedReason, tab.url);
    return { ok: false, error: unsupportedReason };
  }

  const now = Date.now();
  const session = {
    tabId: normalizedTabId,
    intervalSeconds: normalizedIntervalSeconds,
    enabled: true,
    dueAt: now + secondsToMs(normalizedIntervalSeconds),
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
  await updateBadgeForSession(session);
  ensureBadgeTicker();

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
  session.dueAt = now + ACTIVITY_IDLE_DELAY_MS + secondsToMs(session.intervalSeconds);

  sessions[key] = session;
  await writeSessions(sessions);
  await scheduleAlarm(session);
  await updateBadgeForSession(session);
  ensureBadgeTicker();
}

async function handleRefreshAlarm(tabId) {
  const sessions = await readSessions();
  const key = String(tabId);
  const session = sessions[key];

  if (!session || !session.enabled) {
    await clearAlarm(tabId);
    await clearBadge(tabId);
    await stopBadgeTickerIfIdle();
    return;
  }

  if (Date.now() + 500 < session.dueAt) {
    await scheduleAlarm(session);
    await updateBadgeForSession(session);
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
  session.dueAt = now + secondsToMs(session.intervalSeconds);
  session.url = tab.url || session.url || "";
  session.title = tab.title || session.title || "";

  sessions[key] = session;
  await writeSessions(sessions);
  await scheduleAlarm(session);
  await updateBadgeForSession(session);
  ensureBadgeTicker();
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
  await updateBadgeForSession(session);
  ensureBadgeTicker();
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
        session.dueAt = now + secondsToMs(session.intervalSeconds);
        await saveSession(session);
      }

      await scheduleAlarm(session);
      await updateBadgeForSession(session);
    })
  );

  ensureBadgeTicker();
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
  await clearBadge(normalizedTabId);
  await stopBadgeTickerIfIdle();
}

async function setTabError(tabId, error, url = "") {
  const normalizedTabId = normalizeTabId(tabId);
  const sessions = await readSessions();

  sessions[String(normalizedTabId)] = {
    tabId: normalizedTabId,
    enabled: false,
    intervalSeconds: null,
    dueAt: null,
    error,
    errorAt: Date.now(),
    url
  };

  await writeSessions(sessions);
  await clearAlarm(normalizedTabId);
  await clearBadge(normalizedTabId);
  await stopBadgeTickerIfIdle();
}

async function saveSession(session) {
  const sessions = await readSessions();
  sessions[String(session.tabId)] = normalizeSession(session);
  await writeSessions(sessions);
}

async function readSessions() {
  const data = await chrome.storage.session.get(SESSION_KEY);
  const sessions = data[SESSION_KEY];

  if (!sessions || typeof sessions !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(sessions).map(([key, session]) => [key, normalizeSession(session)])
  );
}

async function writeSessions(sessions) {
  await chrome.storage.session.set({ [SESSION_KEY]: sessions });
}

function ensureBadgeTicker() {
  if (badgeTimerId) {
    return;
  }

  badgeTimerId = setInterval(() => {
    updateAllBadges().catch(() => {});
  }, BADGE_TICK_MS);

  updateAllBadges().catch(() => {});
}

async function stopBadgeTickerIfIdle() {
  const sessions = await readSessions();
  const hasActiveSession = Object.values(sessions).some((session) => session && session.enabled);

  if (hasActiveSession || !badgeTimerId) {
    return;
  }

  clearInterval(badgeTimerId);
  badgeTimerId = null;
}

async function updateAllBadges() {
  const sessions = await readSessions();
  const activeSessions = Object.values(sessions).filter((session) => session && session.enabled);

  if (!activeSessions.length) {
    await stopBadgeTickerIfIdle();
    return;
  }

  await Promise.all(activeSessions.map((session) => updateBadgeForSession(session)));
}

async function updateBadgeForSession(session) {
  if (!session || !session.enabled) {
    return;
  }

  const badgeText = formatBadgeText(session.dueAt);

  await chrome.action.setBadgeBackgroundColor({
    tabId: session.tabId,
    color: "#1a73e8"
  });

  if (chrome.action.setBadgeTextColor) {
    await chrome.action.setBadgeTextColor({
      tabId: session.tabId,
      color: "#ffffff"
    });
  }

  await chrome.action.setBadgeText({
    tabId: session.tabId,
    text: badgeText
  });
}

async function clearBadge(tabId) {
  await chrome.action.setBadgeText({ tabId, text: "" });
}

function formatBadgeText(dueAt) {
  const remainingSeconds = Math.ceil(Math.max(0, dueAt - Date.now()) / 1000);

  if (remainingSeconds <= 0) {
    return "Now";
  }

  if (remainingSeconds < 60) {
    return `${remainingSeconds}s`;
  }

  const remainingMinutes = Math.ceil(remainingSeconds / 60);

  if (remainingMinutes > 99) {
    return "99m";
  }

  return `${remainingMinutes}m`;
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

function normalizeSession(session) {
  if (!session || typeof session !== "object") {
    return session;
  }

  if (!session.enabled && !session.intervalSeconds && !session.intervalMinutes) {
    return session;
  }

  const intervalSeconds = normalizeIntervalSeconds(session.intervalSeconds, session.intervalMinutes);

  return {
    ...session,
    intervalSeconds
  };
}

function normalizeIntervalSeconds(intervalSeconds, legacyIntervalMinutes) {
  const seconds = Number(intervalSeconds);

  if (Number.isFinite(seconds) && seconds >= MIN_INTERVAL_SECONDS && seconds <= MAX_INTERVAL_SECONDS) {
    return Math.round(seconds);
  }

  const minutes = Number(legacyIntervalMinutes);

  if (Number.isFinite(minutes) && minutes > 0) {
    const legacySeconds = Math.round(minutes * 60);

    if (legacySeconds >= MIN_INTERVAL_SECONDS && legacySeconds <= MAX_INTERVAL_SECONDS) {
      return legacySeconds;
    }
  }

  throw new Error("Choose an interval from 1 to 999 minutes.");
}

function secondsToMs(seconds) {
  return seconds * 1000;
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
