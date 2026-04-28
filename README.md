# Refresh

Refresh is a small Chrome extension for controlled auto-refresh on the current tab.
Choose a preset or custom interval, start it from the popup, and the extension
will reload only that tab.

The timer is click-aware: only a real click inside the page resets the countdown.
Opening the tab, switching focus, moving the mouse, scrolling, or typing without
a click does not restart the timer.

## Features

- Refreshes only the tab where the extension was started.
- Supports fixed intervals: `1 min`, `5 min`, and `10 min`.
- Supports a custom exact interval from `1` to `999` minutes.
- Resets the timer only after a click inside the page.
- Shows live status and countdown in the popup.
- Shows a short countdown badge on the extension icon.
- Uses Manifest V3 with no backend, no external APIs, and no CDN dependencies.
- Includes SVG source icon plus Chrome PNG icon sizes.

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

Click `Stop refresh` to disable auto-refresh for the current tab.

The toolbar badge shows a compact countdown while refresh is active. The popup
also shows the last reset reason: `start`, `click`, or `refresh`.

## Limitations

Chrome blocks extension scripts on browser system pages such as `chrome://`,
the Chrome Web Store, and other restricted pages. On those pages the extension
shows a blocked status instead of trying to run.

## Project Structure

```text
manifest.json       Chrome extension manifest
popup.html          Extension popup markup
popup.css           Popup styling
src/background.js   Per-tab timer, alarms, reload flow
src/content.js      Page click detection
src/popup.js        Popup state and controls
assets/             SVG and PNG extension icons
```

## Development Notes

This project is intentionally build-free. Edit the files directly, reload the
extension from `chrome://extensions`, and test it on a normal web page or local
HTML file.
