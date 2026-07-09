// Shared helpers used by the service worker, popup, and options page.
// Loaded via importScripts() in the service worker and via a <script> tag in
// popup.html / options.html. Exposes helpers on globalThis.RefreshShared so it
// works in both classic-worker and window contexts without a build step.
(function (root) {
  function getErrorMessage(error) {
    if (error && typeof error.message === "string") {
      return error.message;
    }

    return String(error || "Unexpected error.");
  }

  function formatIntervalLabel(intervalSeconds) {
    const minutes = Number(intervalSeconds) / 60;

    if (Number.isInteger(minutes)) {
      return `${minutes} min`;
    }

    return `${Number(minutes.toFixed(2))} min`;
  }

  root.RefreshShared = {
    getErrorMessage,
    formatIntervalLabel
  };
})(typeof self !== "undefined" ? self : globalThis);
