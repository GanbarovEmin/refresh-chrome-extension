(() => {
  const INSTALL_FLAG = "__refresh_extension_content_installed__";
  const CLICK_THROTTLE_MS = 1000;
  const GUARD_THROTTLE_MS = 500;

  if (window[INSTALL_FLAG]) {
    sendRuntimeMessage({ type: "REFRESH_CONTENT_READY", at: Date.now() });
    return;
  }

  window[INSTALL_FLAG] = true;

  let lastClickSentAt = 0;
  let lastGuardSentAt = 0;
  let hasDirtyInput = false;

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

  function isEditableElement(element) {
    if (!element || element === document.body || element === document.documentElement) {
      return false;
    }

    if (element.isContentEditable) {
      return true;
    }

    const tagName = element.tagName;

    return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
  }

  function getGuardState(reason) {
    const focusedEditable = isEditableElement(document.activeElement);

    return {
      type: "REFRESH_GUARD_STATE",
      reason,
      focusedEditable,
      dirtyInput: hasDirtyInput,
      guardActive: focusedEditable || hasDirtyInput,
      at: Date.now()
    };
  }

  function sendGuardState(reason, force = false) {
    const now = Date.now();

    if (!force && now - lastGuardSentAt < GUARD_THROTTLE_MS) {
      return;
    }

    lastGuardSentAt = now;
    sendRuntimeMessage(getGuardState(reason));
  }

  function reportGuardInput(event) {
    if (isEditableElement(event.target)) {
      hasDirtyInput = true;
      sendGuardState(event.type);
    }
  }

  function reportFocusChange(event) {
    window.setTimeout(() => {
      sendGuardState(event.type, true);
    }, 0);
  }

  function reportSubmit() {
    hasDirtyInput = false;
    sendGuardState("submit", true);
  }

  const listenerOptions = { capture: true, passive: true };
  const guardListenerOptions = { capture: true, passive: true };
  const clickEvents = [
    "pointerdown",
    "mousedown",
    "click"
  ];

  for (const eventName of clickEvents) {
    window.addEventListener(eventName, reportClick, listenerOptions);
  }

  window.addEventListener("input", reportGuardInput, guardListenerOptions);
  window.addEventListener("change", reportGuardInput, guardListenerOptions);
  window.addEventListener("focusin", reportFocusChange, guardListenerOptions);
  window.addEventListener("focusout", reportFocusChange, guardListenerOptions);
  window.addEventListener("submit", reportSubmit, guardListenerOptions);

  sendRuntimeMessage({ type: "REFRESH_CONTENT_READY", at: Date.now() });
  sendGuardState("ready", true);
})();
