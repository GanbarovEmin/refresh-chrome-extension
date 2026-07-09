importScripts("/src/shared.js");

const { getErrorMessage, getMsg } = self.RefreshShared;

const PREFERRED_INTERVAL_KEY = "refresh.preferredInterval";
const SAFETY_SETTINGS_KEY = "refresh.safetySettings.v1";

const SESSION_KEY = "refresh.sessions.v1";
const DOMAIN_RULES_KEY = "refresh.domainRules.v1";
const ALARM_PREFIX = "refresh-tab:";
const BADGE_ALARM = "refresh-badge-tick";
const BADGE_TICK_MINUTES = 0.5;
const MIN_INTERVAL_SECONDS = 60;
const MAX_INTERVAL_SECONDS = 999 * 60;
const POSTPONE_DELAY_MS = 60 * 1000;
const MAX_HISTORY_ITEMS = 10;
const SUPPORTED_PROTOCOLS = ["http:", "https:", "file:"];

const lastBadgeByTab = new Map();

// Serializes every read-modify-write of the sessions object. Without this,
// concurrent handlers (content-script activity, alarm firing, tab/window focus
// events) each did readSessions() -> mutate -> writeSessions(whole object) and
// silently clobbered each other. withSessions() chains mutations so each one
// reads the freshest state and its write completes before the next starts.
let sessionsMutationChain = Promise.resolve();

function withSessions(mutator) {
  const run = sessionsMutationChain.then(async () => {
    const sessions = await readSessions();
    const result = await mutator(sessions);
    await writeSessions(sessions);
    return result;
  });

  sessionsMutationChain = run.then(
    () => {},
    () => {}
  );

  return run;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));

  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BADGE_ALARM) {
    updateAllBadges().catch(() => {});
    return;
  }

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

  // Transient failures (tab closing, navigation revoking access) must not turn
  // into a persisted error state, so swallow them quietly here.
  restoreContentScript(tabId).catch(() => {});
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  processDueSession(tabId).catch(() => {});
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

if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener((command) => {
    handleCommand(command).catch(() => {});
  });
}

chrome.runtime.onStartup.addListener(() => {
  restoreAlarms().catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  restoreAlarms().catch(() => {});
});

async function handleMessage(message, sender) {
  if (!message || typeof message.type !== "string") {
    return { ok: false, error: getMsg("errorUnknownMessage") };
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

  if (message.type === "REFRESH_IMPORT_DOMAIN_RULES") {
    return importDomainRules(message.rules);
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
        error: getMsg("errorDomainDisabled")
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

  // The content script powers click-reset and typing protection. The
  // alarm-based refresh still works without it, so an injection failure is not
  // fatal to the session.
  await injectContentScript(normalizedTabId);
  await scheduleAlarm(session);
  await updateBadgeForSession(session);
  ensureBadgeTicker();

  return { ok: true, session };
}

async function getStateResponse(tabId) {
  const normalizedTabId = normalizeTabId(tabId);
  const sessions = await readSessions();
  const session = sessions[String(normalizedTabId)] || null;

  if (session && !session.enabled && session.error) {
    const tab = await chrome.tabs.get(normalizedTabId).catch(() => null);
    const currentUrl = tab && tab.url ? tab.url : "";
    const isSupportedNow = currentUrl && !getUnsupportedReason(currentUrl);
    const isDifferentPage = currentUrl && currentUrl !== session.url;

    if (isSupportedNow && isDifferentPage) {
      await removeSession(normalizedTabId);
      return { ok: true, session: null, now: Date.now() };
    }
  }

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
    return { ok: false, error: getMsg("errorNoDomain") };
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
    return { ok: false, error: getMsg("errorNoDomain") };
  }

  const rules = await readDomainRules();
  const rule = {
    type: "never-run",
    hostname,
    updatedAt: Date.now()
  };

  rules[hostname] = rule;
  await writeDomainRules(rules);
  await removeSessionsForHostname(hostname);

  return { ok: true, hostname, rule };
}

async function deleteDomainRule(hostname) {
  const normalizedHostname = normalizeHostname(hostname);

  if (!normalizedHostname) {
    return { ok: false, error: getMsg("errorInvalidDomain") };
  }

  const rules = await readDomainRules();

  delete rules[normalizedHostname];
  await writeDomainRules(rules);

  return { ok: true, hostname: normalizedHostname };
}

async function setNeverRunDomain(hostname) {
  const normalizedHostname = normalizeHostname(hostname);

  if (!normalizedHostname) {
    return { ok: false, error: getMsg("errorInvalidDomain") };
  }

  const rules = await readDomainRules();
  const rule = {
    type: "never-run",
    hostname: normalizedHostname,
    updatedAt: Date.now()
  };

  rules[normalizedHostname] = rule;
  await writeDomainRules(rules);
  await removeSessionsForHostname(normalizedHostname);

  return { ok: true, hostname: normalizedHostname, rule };
}

async function getDomainRulesResponse() {
  const rules = await readDomainRules();

  return {
    ok: true,
    rules: Object.values(rules).sort((a, b) => String(a.hostname).localeCompare(String(b.hostname)))
  };
}

async function importDomainRules(incoming) {
  const list = Array.isArray(incoming)
    ? incoming
    : (incoming && Array.isArray(incoming.rules) ? incoming.rules : null);

  if (!list) {
    return { ok: false, error: getMsg("optionsImportError") };
  }

  const rules = await readDomainRules();
  let imported = 0;
  let skipped = 0;

  for (const entry of list) {
    const normalized = normalizeDomainRule(entry && entry.hostname, entry);

    if (normalized) {
      rules[normalized.hostname] = normalized;
      imported += 1;
    } else {
      skipped += 1;
    }
  }

  await writeDomainRules(rules);

  return { ok: true, imported, skipped };
}

async function handleCommand(command) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || typeof tab.id !== "number") {
    return;
  }

  const sessions = await readSessions();
  const session = sessions[String(tab.id)];
  const isRunning = Boolean(session && session.enabled);

  if (command === "refresh-now") {
    if (isRunning) {
      await refreshSessionNow(tab.id);
    }

    return;
  }

  if (command === "toggle-refresh") {
    if (isRunning && session.paused) {
      await resumeSession(tab.id);
    } else if (isRunning) {
      await pauseSession(tab.id);
    } else {
      const preferred = await resolvePreferredInterval();
      await startSession({
        tabId: tab.id,
        intervalSeconds: preferred.intervalSeconds,
        settings: preferred.settings
      });
    }
  }
}

async function resolvePreferredInterval() {
  const data = await chrome.storage.local.get([PREFERRED_INTERVAL_KEY, SAFETY_SETTINGS_KEY]);
  const preferred = data[PREFERRED_INTERVAL_KEY];
  const settings = normalizeSettings(data[SAFETY_SETTINGS_KEY] || {});

  let intervalSeconds = MIN_INTERVAL_SECONDS;

  if (typeof preferred === "number" && Number.isFinite(preferred)) {
    intervalSeconds = Math.round(preferred * 60);
  } else if (preferred && typeof preferred === "object" && Number.isFinite(Number(preferred.intervalSeconds))) {
    intervalSeconds = Number(preferred.intervalSeconds);
  }

  try {
    intervalSeconds = normalizeIntervalSeconds(intervalSeconds);
  } catch (error) {
    intervalSeconds = MIN_INTERVAL_SECONDS;
  }

  return { intervalSeconds, settings };
}

async function getActiveSessionsResponse(currentTabId) {
  const sessions = await readSessions();
  const normalizedCurrentTabId = Number(currentTabId);
  const activeSessions = [];
  const staleTabIds = [];

  for (const session of Object.values(sessions)) {
    if (!session || !session.enabled) {
      continue;
    }

    try {
      const tab = await chrome.tabs.get(session.tabId);
      activeSessions.push(formatActiveSession(session, tab, session.tabId === normalizedCurrentTabId));
    } catch (error) {
      staleTabIds.push(session.tabId);
    }
  }

  if (staleTabIds.length) {
    await Promise.all(staleTabIds.map((tabId) => removeSession(tabId)));
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

  const now = Number(activityAt) || Date.now();
  const session = await withSessions((sessions) => {
    const key = String(tabId);
    const current = sessions[key];

    if (!current || !current.enabled || current.paused) {
      return null;
    }

    current.lastActivityAt = now;
    current.lastResetReason = "click";

    if (current.smartMode) {
      current.dueAt = now + secondsToMs(current.intervalSeconds);
      current.nextRefreshAt = current.dueAt;
      current.skipReason = null;
      current.postponedUntil = null;
    }

    addHistory(current, "click", current.smartMode ? "Click reset" : "Click logged", now);

    return current;
  });

  if (!session) {
    return;
  }

  if (session.smartMode) {
    await scheduleAlarm(session);
  }

  await updateBadgeForSession(session);
  ensureBadgeTicker();
}

async function updateGuardState(tabId, guardMessage) {
  if (typeof tabId !== "number") {
    return;
  }

  const session = await withSessions((sessions) => {
    const key = String(tabId);
    const current = sessions[key];

    if (!current || !current.enabled) {
      return null;
    }

    current.guardState = {
      focusedEditable: Boolean(guardMessage.focusedEditable),
      dirtyInput: Boolean(guardMessage.dirtyInput),
      guardActive: Boolean(guardMessage.guardActive),
      reason: typeof guardMessage.reason === "string" ? guardMessage.reason : "unknown",
      updatedAt: Number(guardMessage.at) || Date.now()
    };

    return current;
  });

  if (session && !session.guardState.guardActive && session.skipReason === "typing") {
    await processDueSession(tabId);
  }
}

async function pauseSession(tabId) {
  const normalizedTabId = normalizeTabId(tabId);
  const now = Date.now();
  const session = await withSessions((sessions) => {
    const key = String(normalizedTabId);
    const current = getEnabledSession(sessions, key);

    if (current.paused) {
      return current;
    }

    current.paused = true;
    current.pausedRemainingMs = Math.max(0, Number(current.dueAt) - now);
    current.pauseStartedAt = now;
    current.lastResetReason = "pause";
    current.nextRefreshAt = null;
    current.skipReason = null;
    current.postponedUntil = null;
    addHistory(current, "pause", "Paused", now);

    return current;
  });

  await clearAlarm(normalizedTabId);
  await updateBadgeForSession(session);
  ensureBadgeTicker();

  return { ok: true, session };
}

async function resumeSession(tabId) {
  const normalizedTabId = normalizeTabId(tabId);
  const now = Date.now();
  const session = await withSessions((sessions) => {
    const key = String(normalizedTabId);
    const current = getEnabledSession(sessions, key);
    const remainingMs = Math.max(0, Number(current.pausedRemainingMs) || secondsToMs(current.intervalSeconds));

    current.paused = false;
    current.pausedRemainingMs = null;
    current.pauseStartedAt = null;
    current.lastResetReason = "resume";
    current.dueAt = now + remainingMs;
    current.nextRefreshAt = current.dueAt;
    current.skipReason = null;
    current.postponedUntil = null;
    addHistory(current, "resume", "Resumed", now);

    return current;
  });

  await scheduleAlarm(session);
  await updateBadgeForSession(session);
  ensureBadgeTicker();

  return { ok: true, session };
}

async function resetSessionTimer(tabId) {
  const normalizedTabId = normalizeTabId(tabId);
  const now = Date.now();
  const session = await withSessions((sessions) => {
    const key = String(normalizedTabId);
    const current = getEnabledSession(sessions, key);
    const fullIntervalMs = secondsToMs(current.intervalSeconds);

    current.lastResetReason = "manual-reset";
    current.skipReason = null;
    current.postponedUntil = null;
    addHistory(current, "manual-reset", "Reset timer", now);

    if (current.paused) {
      current.pausedRemainingMs = fullIntervalMs;
      current.pauseStartedAt = now;
      current.nextRefreshAt = null;
    } else {
      current.dueAt = now + fullIntervalMs;
      current.nextRefreshAt = current.dueAt;
    }

    return current;
  });

  if (session.paused) {
    await clearAlarm(normalizedTabId);
  } else {
    await scheduleAlarm(session);
  }

  await updateBadgeForSession(session);
  ensureBadgeTicker();

  return { ok: true, session };
}

async function refreshSessionNow(tabId) {
  const normalizedTabId = normalizeTabId(tabId);
  const key = String(normalizedTabId);
  const existing = await readSessions();
  getEnabledSession(existing, key);

  const tab = await chrome.tabs.get(normalizedTabId);
  const unsupportedReason = getUnsupportedReason(tab.url);

  if (unsupportedReason) {
    await setTabError(normalizedTabId, unsupportedReason, tab.url);
    return { ok: false, error: unsupportedReason };
  }

  await chrome.tabs.reload(normalizedTabId);

  const now = Date.now();
  const session = await withSessions((sessions) => {
    const current = getEnabledSession(sessions, key);

    current.lastRefreshAt = now;
    current.lastManualRefreshAt = now;
    current.lastResetReason = "manual-refresh";
    current.refreshCount = Number(current.refreshCount || 0) + 1;
    current.paused = false;
    current.pausedRemainingMs = null;
    current.pauseStartedAt = null;
    current.dueAt = now + secondsToMs(current.intervalSeconds);
    current.nextRefreshAt = current.dueAt;
    current.skipReason = null;
    current.postponedUntil = null;
    current.url = tab.url || current.url || "";
    current.title = tab.title || current.title || "";
    addHistory(current, "manual-refresh", "Refresh now", now);

    return current;
  });

  await scheduleAlarm(session);
  await updateBadgeForSession(session);
  ensureBadgeTicker();

  return { ok: true, session };
}

async function handleRefreshAlarm(tabId) {
  const key = String(tabId);
  const sessions = await readSessions();
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
  const updated = await withSessions((current) => {
    const target = current[key];

    if (!target || !target.enabled) {
      return null;
    }

    target.lastRefreshAt = now;
    target.lastResetReason = "refresh";
    target.refreshCount = Number(target.refreshCount || 0) + 1;
    target.dueAt = now + secondsToMs(target.intervalSeconds);
    target.nextRefreshAt = target.dueAt;
    target.skipReason = null;
    target.postponedUntil = null;
    target.url = tab.url || target.url || "";
    target.title = tab.title || target.title || "";
    addHistory(target, "refresh", "Auto refresh", now);

    return target;
  });

  if (!updated) {
    await clearAlarm(tabId);
    await clearBadge(tabId);
    await stopBadgeTickerIfIdle();
    return;
  }

  await scheduleAlarm(updated);
  await updateBadgeForSession(updated);
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

  const updated = await withSessions((current) => {
    const target = current[String(tabId)];

    if (!target || !target.enabled) {
      return null;
    }

    target.url = tab.url || target.url || "";
    target.title = tab.title || target.title || "";

    return target;
  });

  if (!updated) {
    return;
  }

  await injectContentScript(tabId);
  await updateBadgeForSession(updated);
  ensureBadgeTicker();
  await processDueSession(tabId);
}

async function restoreAlarms() {
  const now = Date.now();
  const sessions = await withSessions((current) => {
    for (const session of Object.values(current)) {
      if (!session || !session.enabled || session.paused) {
        continue;
      }

      if (session.dueAt <= now && !session.skipReason) {
        session.dueAt = now + secondsToMs(session.intervalSeconds);
        session.nextRefreshAt = session.dueAt;
      }
    }

    return current;
  });

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

      await scheduleAlarm(session);
      await updateBadgeForSession(session);
    })
  );

  ensureBadgeTicker();
}

async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content.js"]
    });

    return true;
  } catch (error) {
    // Injection can fail on restricted pages or when the tab navigates away
    // mid-flight. Click-reset / typing protection go quiet, but the timer-based
    // refresh keeps working, so this is not treated as a session error.
    return false;
  }
}

async function scheduleAlarm(session) {
  await chrome.alarms.create(getAlarmName(session.tabId), { when: session.dueAt });
}

async function clearAlarm(tabId) {
  await chrome.alarms.clear(getAlarmName(tabId));
}

async function removeSession(tabId) {
  const normalizedTabId = normalizeTabId(tabId);

  await withSessions((sessions) => {
    delete sessions[String(normalizedTabId)];
  });

  await clearAlarm(normalizedTabId);
  await clearBadge(normalizedTabId);
  await stopBadgeTickerIfIdle();
}

async function removeSessionsForHostname(hostname) {
  const normalizedHostname = normalizeHostname(hostname);

  if (!normalizedHostname) {
    return 0;
  }

  const sessions = await readSessions();
  const matchingTabIds = [];
  const orphanTabIds = [];

  for (const session of Object.values(sessions)) {
    if (!session || typeof session.tabId !== "number") {
      continue;
    }

    let sessionHostname = "";

    try {
      const tab = await chrome.tabs.get(session.tabId);
      sessionHostname = getHostname(tab.url) || getHostname(session.url);
    } catch (error) {
      sessionHostname = getHostname(session.url);

      if (!sessionHostname) {
        orphanTabIds.push(session.tabId);
        continue;
      }
    }

    if (sessionHostname === normalizedHostname) {
      matchingTabIds.push(session.tabId);
    }
  }

  const toRemove = [...new Set([...matchingTabIds, ...orphanTabIds])];
  await Promise.all(toRemove.map((tabId) => removeSession(tabId)));

  return matchingTabIds.length;
}

async function setTabError(tabId, error, url = "") {
  const normalizedTabId = normalizeTabId(tabId);

  await withSessions((sessions) => {
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
  });

  await clearAlarm(normalizedTabId);
  await setErrorBadge(normalizedTabId);
  await stopBadgeTickerIfIdle();
}

async function saveSession(session) {
  await withSessions((sessions) => {
    sessions[String(session.tabId)] = normalizeSession(session);
  });
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

// A short periodic alarm keeps the toolbar countdown moving. This replaces a
// 1s setInterval, which was unreliable (lost when the MV3 service worker sleeps)
// and wasteful (it kept the worker artificially alive). Badge text is derived
// from dueAt on demand, so precision is coarse but the display never freezes.
function ensureBadgeTicker() {
  chrome.alarms.get(BADGE_ALARM)
    .then((existing) => {
      if (!existing) {
        return chrome.alarms.create(BADGE_ALARM, { periodInMinutes: BADGE_TICK_MINUTES });
      }

      return null;
    })
    .catch(() => {});

  updateAllBadges().catch(() => {});
}

async function stopBadgeTickerIfIdle() {
  const sessions = await readSessions();
  const hasActiveSession = Object.values(sessions).some((session) => session && session.enabled);

  if (hasActiveSession) {
    return;
  }

  await chrome.alarms.clear(BADGE_ALARM);
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
  await setBadgeVisual(session.tabId, badgeState.text, badgeState.color);
}

async function setBadgeVisual(tabId, text, color) {
  const cacheKey = `${text}|${color}`;

  if (lastBadgeByTab.get(tabId) === cacheKey) {
    return;
  }

  lastBadgeByTab.set(tabId, cacheKey);

  await chrome.action.setBadgeBackgroundColor({
    tabId,
    color
  });

  if (chrome.action.setBadgeTextColor) {
    await chrome.action.setBadgeTextColor({
      tabId,
      color: "#ffffff"
    });
  }

  await chrome.action.setBadgeText({
    tabId,
    text
  });
}

async function clearBadge(tabId) {
  lastBadgeByTab.delete(tabId);
  await chrome.action.setBadgeText({ tabId, text: "" });
}

async function setErrorBadge(tabId) {
  await setBadgeVisual(tabId, "!", "#d93025");
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
    throw new Error(getMsg("errorNoTab"));
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
    throw new Error(getMsg("errorNotRunning"));
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

  throw new Error(getMsg("errorIntervalRange"));
}

function normalizeSettings(settings = {}) {
  return {
    smartMode: settings.smartMode !== false,
    activeTabOnly: Boolean(settings.activeTabOnly),
    typingProtectionEnabled: settings.typingProtectionEnabled !== false
  };
}

function normalizeHostname(hostname) {
  const rawValue = String(hostname || "").trim().toLowerCase();

  if (!rawValue) {
    return "";
  }

  let normalized = rawValue;

  try {
    normalized = new URL(rawValue).hostname;
  } catch (error) {
    normalized = rawValue;
  }

  normalized = normalized.replace(/\.$/, "");

  if (!normalized || normalized.includes("/") || normalized.includes("\\") || normalized.includes("..")) {
    return "";
  }

  if (!/^[a-z0-9.-]+$/.test(normalized)) {
    return "";
  }

  return normalized;
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
  const key = String(normalizedTabId);
  const normalizedSettings = normalizeSettings(settings);
  const session = await withSessions((sessions) => {
    const current = getEnabledSession(sessions, key);

    current.smartMode = normalizedSettings.smartMode;
    current.activeTabOnly = normalizedSettings.activeTabOnly;
    current.typingProtectionEnabled = normalizedSettings.typingProtectionEnabled;
    addHistory(current, "settings", "Settings updated");

    return current;
  });

  await updateBadgeForSession(session);
  await processDueSession(normalizedTabId);

  const latestSessions = await readSessions();
  return { ok: true, session: latestSessions[key] || session };
}

async function postponeSession(session, reason, label) {
  const key = String(session.tabId);
  const now = Date.now();
  const updated = await withSessions((sessions) => {
    const current = sessions[key];

    if (!current || !current.enabled) {
      return null;
    }

    current.skipReason = reason;
    current.postponedUntil = now + POSTPONE_DELAY_MS;
    current.dueAt = current.postponedUntil;
    current.nextRefreshAt = current.dueAt;
    addHistory(current, reason === "inactive" ? "skipped-inactive" : "postponed-typing", label, now);

    return current;
  });

  if (!updated) {
    return;
  }

  await scheduleAlarm(updated);
  await updateBadgeForSession(updated);
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

  if (!session || !session.enabled || session.paused) {
    return;
  }

  const isDue = Date.now() >= Number(session.dueAt);

  if (!isDue && !session.skipReason) {
    return;
  }

  await handleRefreshAlarm(tabId);
}

function secondsToMs(seconds) {
  return seconds * 1000;
}

function getUnsupportedReason(urlValue) {
  if (!urlValue) {
    return getMsg("errorUnsupportedTab");
  }

  let url;

  try {
    url = new URL(urlValue);
  } catch (error) {
    return getMsg("errorUnsupportedUrl");
  }

  if (!SUPPORTED_PROTOCOLS.includes(url.protocol)) {
    return getMsg("errorSystemPage");
  }

  if (url.hostname === "chrome.google.com" || url.hostname === "chromewebstore.google.com") {
    return getMsg("errorWebStore");
  }

  return "";
}
