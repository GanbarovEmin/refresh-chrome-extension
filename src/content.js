(() => {
  const INSTALL_FLAG = "__refresh_extension_content_installed__";
  const CLICK_THROTTLE_MS = 1000;
  const GUARD_THROTTLE_MS = 500;
  const EDITABLE_SELECTOR = "input, textarea, select, [contenteditable]";

  if (window[INSTALL_FLAG]) {
    sendRuntimeMessage({ type: "REFRESH_CONTENT_READY", at: Date.now() });
    return;
  }

  window[INSTALL_FLAG] = true;

  let lastClickSentAt = 0;
  let lastGuardSentAt = 0;
  let hasDirtyInput = false;
  const initialEditableValues = new WeakMap();

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

  function getEditableValue(element) {
    if (!element) {
      return "";
    }

    if (element.isContentEditable) {
      return element.textContent || "";
    }

    if (element.tagName === "SELECT" && element.multiple) {
      return [...element.options]
        .filter((option) => option.selected)
        .map((option) => option.value)
        .join("\u0000");
    }

    if (element.type === "checkbox" || element.type === "radio") {
      return element.checked ? "checked" : "unchecked";
    }

    return element.value || "";
  }

  function rememberInitialValue(element) {
    if (isEditableElement(element) && !initialEditableValues.has(element)) {
      initialEditableValues.set(element, getEditableValue(element));
    }
  }

  function isDirtyEditable(element) {
    if (!isEditableElement(element)) {
      return false;
    }

    rememberInitialValue(element);

    const initialValue = initialEditableValues.get(element);
    const currentValue = getEditableValue(element);

    return currentValue !== initialValue && currentValue !== "";
  }

  function updateDirtyState() {
    const editables = document.querySelectorAll(EDITABLE_SELECTOR);
    hasDirtyInput = [...editables].some((element) => isDirtyEditable(element));
  }

  function snapshotCurrentEditableValues() {
    const editables = document.querySelectorAll(EDITABLE_SELECTOR);

    for (const element of editables) {
      if (isEditableElement(element)) {
        initialEditableValues.set(element, getEditableValue(element));
      }
    }
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
      rememberInitialValue(event.target);
      updateDirtyState();
      sendGuardState(event.type);
    }
  }

  function reportFocusChange(event) {
    if (isEditableElement(event.target)) {
      rememberInitialValue(event.target);
    }

    window.setTimeout(() => {
      updateDirtyState();
      sendGuardState(event.type, true);
    }, 0);
  }

  function reportSubmit() {
    snapshotCurrentEditableValues();
    hasDirtyInput = false;
    sendGuardState("submit", true);
  }

  function reportReset() {
    window.setTimeout(() => {
      snapshotCurrentEditableValues();
      hasDirtyInput = false;
      sendGuardState("reset", true);
    }, 0);
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
  window.addEventListener("reset", reportReset, guardListenerOptions);

  sendRuntimeMessage({ type: "REFRESH_CONTENT_READY", at: Date.now() });
  sendGuardState("ready", true);
})();
