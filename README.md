# Refresh

Refresh is a lightweight Chrome extension for controlled auto-refresh on the
current tab. Pick a preset or custom interval, start it from the popup, and the
extension reloads only that tab.

The timer is click-aware: only a real click inside the page resets the
countdown. Opening the tab, switching focus, moving the mouse, scrolling, or
typing without a click does not restart the timer.

## Features

- Refreshes only the tab where the extension was started.
- Supports fixed intervals: `1 min`, `5 min`, and `10 min`.
- Supports a custom exact interval from `1` to `999` minutes.
- Provides `Pause`, `Resume`, `Reset timer`, `Refresh now`, and `Stop`.
- Shows live countdown, last refresh time, refresh count, and last reset reason.
- Shows a compact countdown badge on the extension icon.
- Uses Manifest V3 with no backend, no external APIs, and no CDN dependencies.
- Includes source SVG plus Chrome PNG icon sizes.

## Install

1. Open `chrome://extensions`.
2. Turn on `Developer mode`.
3. Choose `Load unpacked`.
4. Select this folder.

## Use

1. Open the page you want to refresh.
2. Click the `Refresh` extension icon.
3. Choose `1 min`, `5 min`, `10 min`, or `Custom`.
4. Click `Start refresh`.

## Controls

- `Pause` stops the countdown without deleting the session.
- `Resume` continues from the saved remaining time.
- `Reset timer` restarts the countdown for the full selected interval without
  reloading the page.
- `Refresh now` reloads the tab immediately and schedules the next refresh for
  the full selected interval.
- `Stop` removes the session from the current tab and clears the badge.

## Status And Badge Behavior

The popup shows the next refresh countdown, the last refresh time, the number of
refreshes in the current browser session, and the last reset reason. Reset
reasons include `Start`, `Click`, `Pause`, `Resume`, `Reset timer`,
`Refresh now`, and `Auto refresh`.

The toolbar badge shows a compact countdown while refresh is active. When the
session is paused, the badge switches to a paused state.

## Limitations

Chrome blocks extension scripts on browser system pages such as `chrome://`,
the Chrome Web Store, and other restricted pages. On those pages the extension
shows a blocked status instead of trying to run.

Session stats are stored in `chrome.storage.session`, so they reset when the
browser session ends.

## Project Structure

```text
manifest.json       Chrome extension manifest
popup.html          Extension popup markup
popup.css           Popup styling
src/background.js   Per-tab timer, alarms, reload flow
src/content.js      Page click detection
src/popup.js        Popup state and controls
icons/              Source SVG and PNG extension icons
```

## Development Notes

This project is intentionally build-free. Edit the files directly, reload the
extension from `chrome://extensions`, and test it on a normal web page or local
HTML file.
