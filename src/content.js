(() => {
  const INSTALL_FLAG = "__refresh_extension_content_installed__";
  const ACTIVITY_THROTTLE_MS = 1000;

  if (window[INSTALL_FLAG]) {
    sendRuntimeMessage({ type: "REFRESH_CONTENT_READY", at: Date.now() });
    return;
  }

  window[INSTALL_FLAG] = true;

  let lastActivitySentAt = 0;

  function sendRuntimeMessage(payload) {
    try {
      const result = chrome.runtime.sendMessage(payload);

      if (result && typeof result.catch === "function") {
        result.catch(() => {});
      }
    } catch (error) {
      // The extension context can disappear during reloads or updates.
    }
  }

  function reportActivity(event) {
    const now = Date.now();

    if (now - lastActivitySentAt < ACTIVITY_THROTTLE_MS) {
      return;
    }

    lastActivitySentAt = now;
    sendRuntimeMessage({
      type: "REFRESH_USER_ACTIVITY",
      eventType: event.type,
      at: now
    });
  }

  const listenerOptions = { capture: true, passive: true };
  const activityEvents = [
    "pointerdown",
    "pointermove",
    "keydown",
    "scroll",
    "wheel",
    "input",
    "focus",
    "touchstart"
  ];

  for (const eventName of activityEvents) {
    window.addEventListener(eventName, reportActivity, listenerOptions);
  }

  sendRuntimeMessage({ type: "REFRESH_CONTENT_READY", at: Date.now() });
})();
