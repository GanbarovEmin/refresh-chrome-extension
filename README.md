# Refresh

Refresh is a small Chrome extension for controlled auto-refresh on the current tab.
Choose a 1, 5, or 10 minute interval, start it from the popup, and the extension
will reload only that tab.

The timer is activity-aware: clicks, typing, scrolling, pointer movement, input,
focus, and touch activity reset the countdown so the page does not refresh while
you are actively working.

## Features

- Refreshes only the tab where the extension was started.
- Supports fixed intervals: `1 min`, `5 min`, and `10 min`.
- Resets the timer after page interaction.
- Shows live status and countdown in the popup.
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
3. Choose `1 min`, `5 min`, or `10 min`.
4. Click `Start refresh`.

Click `Stop refresh` to disable auto-refresh for the current tab.

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
src/content.js      Page activity detection
src/popup.js        Popup state and controls
assets/             SVG and PNG extension icons
```

## Development Notes

This project is intentionally build-free. Edit the files directly, reload the
extension from `chrome://extensions`, and test it on a normal web page or local
HTML file.
