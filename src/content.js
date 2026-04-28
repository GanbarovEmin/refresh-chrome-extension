(() => {
  const INSTALL_FLAG = "__refresh_extension_content_installed__";
  const CLICK_THROTTLE_MS = 1000;

  if (window[INSTALL_FLAG]) {
    sendRuntimeMessage({ type: "REFRESH_CONTENT_READY", at: Date.now() });
    return;
  }

  window[INSTALL_FLAG] = true;

  let lastClickSentAt = 0;

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

  function reportClick(event) {
    const now = Date.now();

    if (now - lastClickSentAt < CLICK_THROTTLE_MS) {
      return;
    }

    lastClickSentAt = now;
    sendRuntimeMessage({
      type: "REFRESH_USER_ACTIVITY",
      eventType: event.type,
      at: now
    });
  }

  const listenerOptions = { capture: true, passive: true };
  const clickEvents = [
    "pointerdown",
    "mousedown",
    "click"
  ];

  for (const eventName of clickEvents) {
    window.addEventListener(eventName, reportClick, listenerOptions);
  }

  sendRuntimeMessage({ type: "REFRESH_CONTENT_READY", at: Date.now() });
})();
