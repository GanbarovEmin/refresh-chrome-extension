const SESSION_KEY = "refresh.sessions.v1";
const DOMAIN_RULES_KEY = "refresh.domainRules.v1";
const ALARM_PREFIX = "refresh-tab:";
const BADGE_TICK_MS = 1000;
const MIN_INTERVAL_SECONDS = 60;
const MAX_INTERVAL_SECONDS = 999 * 60;
const POSTPONE_DELAY_MS = 60 * 1000;
const MAX_HISTORY_ITEMS = 10;
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

chrome.tabs.onActivated.addListener(({ tabId }) => {
  processDueSession(tabId).catch(async (error) => {
    await setTabError(tabId, getErrorMessage(error));
  });
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    return;
  }

  chrome.tabs.query({ active: true, windowId }).then(([tab]) => {
    if (tab && typeof tab.id === "number") {
      return processDueSession(tab.id);
    }

    return null;
  }).catch(() => {});
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

  if (message.type === "REFRESH_GET_SITE_CONTEXT") {
    return getSiteContext(message.tabId);
  }

  if (message.type === "REFRESH_SAVE_SITE_PROFILE") {
    return saveSiteProfile(message.tabId, message.profile);
  }

  if (message.type === "REFRESH_SET_NEVER_RUN") {
    return setNeverRunRule(message.tabId);
  }

  if (message.type === "REFRESH_SET_DOMAIN_NEVER_RUN") {
    return setNeverRunDomain(message.hostname);
  }

  if (message.type === "REFRESH_DELETE_DOMAIN_RULE") {
    return deleteDomainRule(message.hostname);
  }

  if (message.type === "REFRESH_GET_DOMAIN_RULES") {
    return getDomainRulesResponse();
  }

  if (message.type === "REFRESH_GET_ACTIVE_SESSIONS") {
    return getActiveSessionsResponse(message.currentTabId);
  }

  if (message.type === "REFRESH_FOCUS_TAB") {
    return focusTab(message.tabId);
  }

  if (message.type === "REFRESH_START") {
    return startSession(message);
  }

  if (message.type === "REFRESH_STOP") {
    await removeSession(message.tabId);
    return { ok: true };
  }

  if (message.type === "REFRESH_PAUSE") {
    return pauseSession(message.tabId);
  }

  if (message.type === "REFRESH_RESUME") {
    return resumeSession(message.tabId);
  }

  if (message.type === "REFRESH_RESET_TIMER") {
    return resetSessionTimer(message.tabId);
  }

  if (message.type === "REFRESH_REFRESH_NOW") {
    return refreshSessionNow(message.tabId);
  }

  if (message.type === "REFRESH_UPDATE_SETTINGS") {
    return updateSessionSettings(message.tabId, message.settings);
  }

  if (message.type === "REFRESH_USER_ACTIVITY") {
    const tabId = sender.tab && sender.tab.id;
    await resetSessionAfterActivity(tabId, message.at);
    return { ok: true };
  }

  if (message.type === "REFRESH_GUARD_STATE") {
    const tabId = sender.tab && sender.tab.id;
    await updateGuardState(tabId, message);
    return { ok: true };
  }

  if (message.type === "REFRESH_CONTENT_READY") {
    return { ok: true };
  }

  return { ok: false, error: "Unknown message." };
}

async function startSession(message) {
  const { tabId, intervalSeconds, intervalMinutes: legacyIntervalMinutes } = message;
  const normalizedTabId = normalizeTabId(tabId);
  const normalizedIntervalSeconds = normalizeIntervalSeconds(intervalSeconds, legacyIntervalMinutes);
  const settings = normalizeSettings(message.settings || message);
  const tab = await chrome.tabs.get(normalizedTabId);
  const unsupportedReason = getUnsupportedReason(tab.url);
  const hostname = getHostname(tab.url);

  if (unsupportedReason) {
    await setTabError(normalizedTabId, unsupportedReason, tab.url);
    return { ok: false, error: unsupportedReason };
  }

  if (hostname) {
    const rule = await getDomainRule(hostname);

    if (rule && rule.type === "never-run") {
      return {
        ok: false,
        error: "Refresh is disabled for this domain. Remove the rule in Options to run it here."
      };
    }
  }

  const now = Date.now();
  const dueAt = now + secondsToMs(normalizedIntervalSeconds);
  const session = {
    tabId: normalizedTabId,
    intervalSeconds: normalizedIntervalSeconds,
    enabled: true,
    dueAt,
    startedAt: now,
    lastActivityAt: null,
    lastRefreshAt: null,
    lastManualRefreshAt: null,
    lastResetReason: "start",
    paused: false,
    pausedRemainingMs: null,
    pauseStartedAt: null,
    refreshCount: 0,
    smartMode: settings.smartMode,
    activeTabOnly: settings.activeTabOnly,
    typingProtectionEnabled: settings.typingProtectionEnabled,
    nextRefreshAt: dueAt,
    skipReason: null,
    postponedUntil: null,
    guardState: getDefaultGuardState(),
    history: [createHistoryEntry("start", "Started", now)],
    url: tab.url || "",
    title: tab.title || ""
  };

  await saveSession(session);

  try {
    await injectContentScript(normalizedTabId);
  } catch (error) {
    const messageText = getErrorMessage(error);
    await setTabError(normalizedTabId, messageText, tab.url);
    throw new Error(messageText);
  }

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

async function getSiteContext(tabId) {
  const normalizedTabId = normalizeTabId(tabId);
  const tab = await chrome.tabs.get(normalizedTabId);
  const unsupportedReason = getUnsupportedReason(tab.url);
  const hostname = getHostname(tab.url);
  const rule = hostname ? await getDomainRule(hostname) : null;

  return {
    ok: true,
    hostname,
    rule,
    supported: !unsupportedReason && Boolean(hostname),
    unsupportedReason
  };
}

async function saveSiteProfile(tabId, profile = {}) {
  const normalizedTabId = normalizeTabId(tabId);
  const tab = await chrome.tabs.get(normalizedTabId);
  const hostname = getHostname(tab.url);

  if (!hostname) {
    return { ok: false, error: "This page does not have a supported domain." };
  }

  const intervalSeconds = normalizeIntervalSeconds(profile.intervalSeconds);
  const settings = normalizeSettings(profile.settings || profile);
  const rules = await readDomainRules();
  const rule = {
    type: "saved-profile",
    hostname,
    intervalSeconds,
    smartMode: settings.smartMode,
    activeTabOnly: settings.activeTabOnly,
    typingProtectionEnabled: settings.typingProtectionEnabled,
    updatedAt: Date.now()
  };

  rules[hostname] = rule;
  await writeDomainRules(rules);

  return { ok: true, hostname, rule };
}

async function setNeverRunRule(tabId) {
  const normalizedTabId = normalizeTabId(tabId);
  const tab = await chrome.tabs.get(normalizedTabId);
  const hostname = getHostname(tab.url);

  if (!hostname) {
    return { ok: false, error: "This page does not have a supported domain." };
  }

  const rules = await readDomainRules();
  const rule = {
    type: "never-run",
    hostname,
    updatedAt: Date.now()
  };

  rules[hostname] = rule;
  await writeDomainRules(rules);
  await removeSession(normalizedTabId);

  return { ok: true, hostname, rule };
}

async function deleteDomainRule(hostname) {
  const normalizedHostname = normalizeHostname(hostname);
  const rules = await readDomainRules();

  delete rules[normalizedHostname];
  await writeDomainRules(rules);

  return { ok: true, hostname: normalizedHostname };
}

async function setNeverRunDomain(hostname) {
  const normalizedHostname = normalizeHostname(hostname);

  if (!normalizedHostname) {
    return { ok: false, error: "Choose a valid domain." };
  }

  const rules = await readDomainRules();
  const rule = {
    type: "never-run",
    hostname: normalizedHostname,
    updatedAt: Date.now()
  };

  rules[normalizedHostname] = rule;
  await writeDomainRules(rules);

  return { ok: true, hostname: normalizedHostname, rule };
}

async function getDomainRulesResponse() {
  const rules = await readDomainRules();

  return {
    ok: true,
    rules: Object.values(rules).sort((a, b) => String(a.hostname).localeCompare(String(b.hostname)))
  };
}

async function getActiveSessionsResponse(currentTabId) {
  const sessions = await readSessions();
  const normalizedCurrentTabId = Number(currentTabId);
  const activeSessions = [];

  for (const session of Object.values(sessions)) {
    if (!session || !session.enabled) {
      continue;
    }

    try {
      const tab = await chrome.tabs.get(session.tabId);
      activeSessions.push(formatActiveSession(session, tab, session.tabId === normalizedCurrentTabId));
    } catch (error) {
      await removeSession(session.tabId);
    }
  }

  activeSessions.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || a.hostname.localeCompare(b.hostname));

  return { ok: true, sessions: activeSessions.slice(0, 4), total: activeSessions.length };
}

async function focusTab(tabId) {
  const normalizedTabId = normalizeTabId(tabId);
  const tab = await chrome.tabs.get(normalizedTabId);

  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(normalizedTabId, { active: true });

  return { ok: true };
}

async function resetSessionAfterActivity(tabId, activityAt) {
  if (typeof tabId !== "number") {
    return;
  }

  const sessions = await readSessions();
  const key = String(tabId);
  const session = sessions[key];

  if (!session || !session.enabled || session.paused) {
    return;
  }

  const now = Number(activityAt) || Date.now();
  session.lastActivityAt = now;
  session.lastResetReason = "click";

  if (session.smartMode) {
    session.dueAt = now + secondsToMs(session.intervalSeconds);
    session.nextRefreshAt = session.dueAt;
    session.skipReason = null;
    session.postponedUntil = null;
    await scheduleAlarm(session);
  }

  addHistory(session, "click", session.smartMode ? "Click reset" : "Click logged", now);

  sessions[key] = session;
  await writeSessions(sessions);
  await updateBadgeForSession(session);
  ensureBadgeTicker();
}

async function updateGuardState(tabId, guardMessage) {
  if (typeof tabId !== "number") {
    return;
  }

  const sessions = await readSessions();
  const key = String(tabId);
  const session = sessions[key];

  if (!session || !session.enabled) {
    return;
  }

  session.guardState = {
    focusedEditable: Boolean(guardMessage.focusedEditable),
    dirtyInput: Boolean(guardMessage.dirtyInput),
    guardActive: Boolean(guardMessage.guardActive),
    reason: typeof guardMessage.reason === "string" ? guardMessage.reason : "unknown",
    updatedAt: Number(guardMessage.at) || Date.now()
  };

  sessions[key] = session;
  await writeSessions(sessions);

  if (!session.guardState.guardActive && session.skipReason === "typing") {
    await processDueSession(tabId);
  }
}

async function pauseSession(tabId) {
  const normalizedTabId = normalizeTabId(tabId);
  const sessions = await readSessions();
  const key = String(normalizedTabId);
  const session = getEnabledSession(sessions, key);
  const now = Date.now();

  if (session.paused) {
    await updateBadgeForSession(session);
    return { ok: true, session };
  }

  session.paused = true;
  session.pausedRemainingMs = Math.max(0, Number(session.dueAt) - now);
  session.pauseStartedAt = now;
  session.lastResetReason = "pause";
  session.nextRefreshAt = null;
  session.skipReason = null;
  session.postponedUntil = null;
  addHistory(session, "pause", "Paused", now);

  sessions[key] = session;
  await writeSessions(sessions);
  await clearAlarm(normalizedTabId);
  await updateBadgeForSession(session);
  ensureBadgeTicker();

  return { ok: true, session };
}

async function resumeSession(tabId) {
  const normalizedTabId = normalizeTabId(tabId);
  const sessions = await readSessions();
  const key = String(normalizedTabId);
  const session = getEnabledSession(sessions, key);
  const now = Date.now();
  const remainingMs = Math.max(0, Number(session.pausedRemainingMs) || secondsToMs(session.intervalSeconds));

  session.paused = false;
  session.pausedRemainingMs = null;
  session.pauseStartedAt = null;
  session.lastResetReason = "resume";
  session.dueAt = now + remainingMs;
  session.nextRefreshAt = session.dueAt;
  session.skipReason = null;
  session.postponedUntil = null;
  addHistory(session, "resume", "Resumed", now);

  sessions[key] = session;
  await writeSessions(sessions);
  await scheduleAlarm(session);
  await updateBadgeForSession(session);
  ensureBadgeTicker();

  return { ok: true, session };
}

async function resetSessionTimer(tabId) {
  const normalizedTabId = normalizeTabId(tabId);
  const sessions = await readSessions();
  const key = String(normalizedTabId);
  const session = getEnabledSession(sessions, key);
  const now = Date.now();
  const fullIntervalMs = secondsToMs(session.intervalSeconds);

  session.lastResetReason = "manual-reset";
  session.skipReason = null;
  session.postponedUntil = null;
  addHistory(session, "manual-reset", "Reset timer", now);

  if (session.paused) {
    session.pausedRemainingMs = fullIntervalMs;
    session.pauseStartedAt = now;
    session.nextRefreshAt = null;
    await clearAlarm(normalizedTabId);
  } else {
    session.dueAt = now + fullIntervalMs;
    session.nextRefreshAt = session.dueAt;
    await scheduleAlarm(session);
  }

  sessions[key] = session;
  await writeSessions(sessions);
  await updateBadgeForSession(session);
  ensureBadgeTicker();

  return { ok: true, session };
}

async function refreshSessionNow(tabId) {
  const normalizedTabId = normalizeTabId(tabId);
  const sessions = await readSessions();
  const key = String(normalizedTabId);
  const session = getEnabledSession(sessions, key);
  const tab = await chrome.tabs.get(normalizedTabId);
  const unsupportedReason = getUnsupportedReason(tab.url);

  if (unsupportedReason) {
    await setTabError(normalizedTabId, unsupportedReason, tab.url);
    return { ok: false, error: unsupportedReason };
  }

  await chrome.tabs.reload(normalizedTabId);

  const now = Date.now();
  session.lastRefreshAt = now;
  session.lastManualRefreshAt = now;
  session.lastResetReason = "manual-refresh";
  session.refreshCount = Number(session.refreshCount || 0) + 1;
  session.paused = false;
  session.pausedRemainingMs = null;
  session.pauseStartedAt = null;
  session.dueAt = now + secondsToMs(session.intervalSeconds);
  session.nextRefreshAt = session.dueAt;
  session.skipReason = null;
  session.postponedUntil = null;
  session.url = tab.url || session.url || "";
  session.title = tab.title || session.title || "";
  addHistory(session, "manual-refresh", "Refresh now", now);

  sessions[key] = session;
  await writeSessions(sessions);
  await scheduleAlarm(session);
  await updateBadgeForSession(session);
  ensureBadgeTicker();

  return { ok: true, session };
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

  if (session.paused) {
    await clearAlarm(tabId);
    await updateBadgeForSession(session);
    return;
  }

  if (Date.now() + 500 < session.dueAt && !session.skipReason) {
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

  if (session.activeTabOnly && !(await isTabCurrentlyActive(tab))) {
    await postponeSession(session, "inactive", "Skipped because tab is inactive.");
    return;
  }

  if (session.typingProtectionEnabled && session.guardState && session.guardState.guardActive) {
    await postponeSession(session, "typing", "Typing detected. Refresh postponed.");
    return;
  }

  await chrome.tabs.reload(tabId);

  const now = Date.now();
  session.lastRefreshAt = now;
  session.lastResetReason = "refresh";
  session.refreshCount = Number(session.refreshCount || 0) + 1;
  session.dueAt = now + secondsToMs(session.intervalSeconds);
  session.nextRefreshAt = session.dueAt;
  session.skipReason = null;
  session.postponedUntil = null;
  session.url = tab.url || session.url || "";
  session.title = tab.title || session.title || "";
  addHistory(session, "refresh", "Auto refresh", now);

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
  await processDueSession(tabId);
}

async function restoreAlarms() {
  const sessions = await readSessions();
  const now = Date.now();

  await Promise.all(
    Object.values(sessions).map(async (session) => {
      if (!session || !session.enabled) {
        return;
      }

      if (session.paused) {
        await clearAlarm(session.tabId);
        await updateBadgeForSession(session);
        return;
      }

      if (session.dueAt <= now && !session.skipReason) {
        session.dueAt = now + secondsToMs(session.intervalSeconds);
        session.nextRefreshAt = session.dueAt;
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
  const previousSession = sessions[String(normalizedTabId)];
  const history = normalizeHistory(previousSession && previousSession.history);
  history.push(createHistoryEntry("error", error));

  sessions[String(normalizedTabId)] = {
    tabId: normalizedTabId,
    enabled: false,
    intervalSeconds: null,
    dueAt: null,
    paused: false,
    pausedRemainingMs: null,
    nextRefreshAt: null,
    skipReason: "error",
    postponedUntil: null,
    history: history.slice(-MAX_HISTORY_ITEMS),
    error,
    errorAt: Date.now(),
    url
  };

  await writeSessions(sessions);
  await clearAlarm(normalizedTabId);
  await setErrorBadge(normalizedTabId);
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

async function readDomainRules() {
  const data = await chrome.storage.local.get(DOMAIN_RULES_KEY);
  const rules = data[DOMAIN_RULES_KEY];

  if (!rules || typeof rules !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(rules)
      .map(([hostname, rule]) => normalizeDomainRule(hostname, rule))
      .filter(Boolean)
      .map((rule) => [rule.hostname, rule])
  );
}

async function writeDomainRules(rules) {
  await chrome.storage.local.set({ [DOMAIN_RULES_KEY]: rules });
}

async function getDomainRule(hostname) {
  const rules = await readDomainRules();
  return rules[normalizeHostname(hostname)] || null;
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

  const badgeState = getBadgeState(session);

  await chrome.action.setBadgeBackgroundColor({
    tabId: session.tabId,
    color: badgeState.color
  });

  if (chrome.action.setBadgeTextColor) {
    await chrome.action.setBadgeTextColor({
      tabId: session.tabId,
      color: "#ffffff"
    });
  }

  await chrome.action.setBadgeText({
    tabId: session.tabId,
    text: badgeState.text
  });
}

async function clearBadge(tabId) {
  await chrome.action.setBadgeText({ tabId, text: "" });
}

async function setErrorBadge(tabId) {
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#d93025" });

  if (chrome.action.setBadgeTextColor) {
    await chrome.action.setBadgeTextColor({ tabId, color: "#ffffff" });
  }

  await chrome.action.setBadgeText({ tabId, text: "!" });
}

function getBadgeState(session) {
  if (session.paused) {
    return { text: "PAU", color: "#5f6368" };
  }

  if (session.skipReason === "inactive") {
    return { text: "SKIP", color: "#f29900" };
  }

  if (session.skipReason === "typing") {
    return { text: "WAIT", color: "#f29900" };
  }

  return { text: formatBadgeText(session.dueAt), color: "#1a73e8" };
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
  const paused = Boolean(session.paused);
  const normalizedDueAt = Number(session.dueAt) || null;

  return {
    ...session,
    intervalSeconds,
    paused,
    pausedRemainingMs: paused ? Math.max(0, Number(session.pausedRemainingMs) || 0) : null,
    pauseStartedAt: paused && Number.isFinite(Number(session.pauseStartedAt)) ? Number(session.pauseStartedAt) : null,
    lastManualRefreshAt: Number.isFinite(Number(session.lastManualRefreshAt)) ? Number(session.lastManualRefreshAt) : null,
    refreshCount: Math.max(0, Math.round(Number(session.refreshCount) || 0)),
    smartMode: session.smartMode !== false,
    activeTabOnly: Boolean(session.activeTabOnly),
    typingProtectionEnabled: session.typingProtectionEnabled !== false,
    nextRefreshAt: paused ? null : (Number(session.nextRefreshAt) || normalizedDueAt),
    skipReason: typeof session.skipReason === "string" ? session.skipReason : null,
    postponedUntil: Number.isFinite(Number(session.postponedUntil)) ? Number(session.postponedUntil) : null,
    guardState: normalizeGuardState(session.guardState),
    history: normalizeHistory(session.history)
  };
}

function getEnabledSession(sessions, key) {
  const session = sessions[key];

  if (!session || !session.enabled) {
    throw new Error("Refresh is not running on this tab.");
  }

  return session;
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

function normalizeSettings(settings = {}) {
  return {
    smartMode: settings.smartMode !== false,
    activeTabOnly: Boolean(settings.activeTabOnly),
    typingProtectionEnabled: settings.typingProtectionEnabled !== false
  };
}

function normalizeHostname(hostname) {
  return String(hostname || "").trim().toLowerCase();
}

function getHostname(urlValue) {
  if (!urlValue) {
    return "";
  }

  try {
    return normalizeHostname(new URL(urlValue).hostname);
  } catch (error) {
    return "";
  }
}

function normalizeDomainRule(hostname, rule) {
  if (!rule || typeof rule !== "object") {
    return null;
  }

  const normalizedHostname = normalizeHostname(rule.hostname || hostname);

  if (!normalizedHostname) {
    return null;
  }

  if (rule.type === "never-run") {
    return {
      type: "never-run",
      hostname: normalizedHostname,
      updatedAt: Number(rule.updatedAt) || Date.now()
    };
  }

  if (rule.type === "saved-profile") {
    try {
      const intervalSeconds = normalizeIntervalSeconds(rule.intervalSeconds);
      const settings = normalizeSettings(rule);

      return {
        type: "saved-profile",
        hostname: normalizedHostname,
        intervalSeconds,
        smartMode: settings.smartMode,
        activeTabOnly: settings.activeTabOnly,
        typingProtectionEnabled: settings.typingProtectionEnabled,
        updatedAt: Number(rule.updatedAt) || Date.now()
      };
    } catch (error) {
      return null;
    }
  }

  return null;
}

function formatActiveSession(session, tab, isCurrent) {
  return {
    tabId: session.tabId,
    title: tab.title || session.title || "Untitled",
    url: tab.url || session.url || "",
    hostname: getHostname(tab.url || session.url) || "local",
    intervalSeconds: session.intervalSeconds,
    dueAt: session.dueAt,
    paused: session.paused,
    skipReason: session.skipReason,
    status: getSessionStatus(session),
    isCurrent
  };
}

function getSessionStatus(session) {
  if (session.paused) {
    return "Paused";
  }

  if (session.skipReason === "inactive") {
    return "Skipped";
  }

  if (session.skipReason === "typing") {
    return "Waiting";
  }

  return "Active";
}

function getDefaultGuardState() {
  return {
    focusedEditable: false,
    dirtyInput: false,
    guardActive: false,
    reason: "initial",
    updatedAt: null
  };
}

function normalizeGuardState(guardState) {
  if (!guardState || typeof guardState !== "object") {
    return getDefaultGuardState();
  }

  return {
    focusedEditable: Boolean(guardState.focusedEditable),
    dirtyInput: Boolean(guardState.dirtyInput),
    guardActive: Boolean(guardState.guardActive),
    reason: typeof guardState.reason === "string" ? guardState.reason : "unknown",
    updatedAt: Number.isFinite(Number(guardState.updatedAt)) ? Number(guardState.updatedAt) : null
  };
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      type: typeof item.type === "string" ? item.type : "event",
      label: typeof item.label === "string" ? item.label : "Event",
      at: Number.isFinite(Number(item.at)) ? Number(item.at) : Date.now()
    }))
    .slice(-MAX_HISTORY_ITEMS);
}

function createHistoryEntry(type, label, at = Date.now()) {
  return { type, label, at };
}

function addHistory(session, type, label, at = Date.now()) {
  session.history = normalizeHistory(session.history);
  session.history.push(createHistoryEntry(type, label, at));
  session.history = session.history.slice(-MAX_HISTORY_ITEMS);
}

async function updateSessionSettings(tabId, settings) {
  const normalizedTabId = normalizeTabId(tabId);
  const sessions = await readSessions();
  const key = String(normalizedTabId);
  const session = getEnabledSession(sessions, key);
  const normalizedSettings = normalizeSettings(settings);

  session.smartMode = normalizedSettings.smartMode;
  session.activeTabOnly = normalizedSettings.activeTabOnly;
  session.typingProtectionEnabled = normalizedSettings.typingProtectionEnabled;
  addHistory(session, "settings", "Settings updated");

  sessions[key] = session;
  await writeSessions(sessions);
  await updateBadgeForSession(session);
  await processDueSession(normalizedTabId);

  const latestSessions = await readSessions();
  return { ok: true, session: latestSessions[key] || session };
}

async function postponeSession(session, reason, label) {
  const sessions = await readSessions();
  const key = String(session.tabId);
  const now = Date.now();

  session.skipReason = reason;
  session.postponedUntil = now + POSTPONE_DELAY_MS;
  session.dueAt = session.postponedUntil;
  session.nextRefreshAt = session.dueAt;
  addHistory(session, reason === "inactive" ? "skipped-inactive" : "postponed-typing", label, now);

  sessions[key] = session;
  await writeSessions(sessions);
  await scheduleAlarm(session);
  await updateBadgeForSession(session);
  ensureBadgeTicker();
}

async function isTabCurrentlyActive(tab) {
  if (!tab || !tab.active) {
    return false;
  }

  const tabWindow = await chrome.windows.get(tab.windowId);
  return Boolean(tabWindow && tabWindow.focused);
}

async function processDueSession(tabId) {
  const sessions = await readSessions();
  const session = sessions[String(tabId)];
  const isDue = Date.now() >= Number(session && session.dueAt);

  if (!session || !session.enabled || session.paused || (!isDue && !session.skipReason)) {
    return;
  }

  await handleRefreshAlarm(tabId);
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
