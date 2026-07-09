// Shared helpers used by the service worker, popup, and options page.
// Loaded via importScripts() in the service worker and via a <script> tag in
// popup.html / options.html. Exposes helpers on globalThis.RefreshShared so it
// works in both classic-worker and window contexts without a build step.
(function (root) {
  function getMsg(key, subs) {
    if (typeof chrome !== "undefined" && chrome.i18n && typeof chrome.i18n.getMessage === "function") {
      const value = chrome.i18n.getMessage(key, subs);

      if (value) {
        return value;
      }
    }

    return key;
  }

  function getErrorMessage(error) {
    if (error && typeof error.message === "string") {
      return error.message;
    }

    return String(error || getMsg("errorUnexpected"));
  }

  function formatIntervalLabel(intervalSeconds) {
    const minutes = Number(intervalSeconds) / 60;
    const unit = getMsg("unitMin");
    const value = Number.isInteger(minutes) ? String(minutes) : String(Number(minutes.toFixed(2)));

    return `${value} ${unit}`;
  }

  // Fills static UI strings from _locales. Elements opt in with data-i18n
  // (textContent), data-i18n-placeholder, data-i18n-label (aria-label), or
  // data-i18n-title. No-op in the service worker (no document).
  function localizePage() {
    if (typeof document === "undefined") {
      return;
    }

    const fill = (attr, apply) => {
      for (const el of document.querySelectorAll(`[${attr}]`)) {
        const message = getMsg(el.getAttribute(attr));

        if (message) {
          apply(el, message);
        }
      }
    };

    fill("data-i18n", (el, message) => {
      el.textContent = message;
    });
    fill("data-i18n-placeholder", (el, message) => {
      el.setAttribute("placeholder", message);
    });
    fill("data-i18n-label", (el, message) => {
      el.setAttribute("aria-label", message);
    });
    fill("data-i18n-title", (el, message) => {
      el.setAttribute("title", message);
    });
  }

  root.RefreshShared = {
    getMsg,
    getErrorMessage,
    formatIntervalLabel,
    localizePage
  };
})(typeof self !== "undefined" ? self : globalThis);
