# Timed Tabs
A Chrome extension that automatically closes inactive tabs after a customizable time period. Helps manage browser tab clutter while ensuring recently used tabs are protected.

## Features
- Automatically closes tabs after user-defined inactivity period (default: 14 days)
- Protects a minimum number of tabs per window from auto-closing
- Real-time countdown display for each tab
- Pinned tabs are exempt from auto-closing
- Survives browser restarts and crashes (Untested)
- Pause timers for protected tabs
- Window-based tab management
- Protection for unvisited tabs (new tabs opened in background)

## Settings
- Customize inactivity period (days, hours, minutes)
- Set minimum number of protected tabs per window
- Reset all timers manually if needed

## Installation
1. Clone this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right
4. Click "Load unpacked" and select the extension directory

## Development
The extension is built using:
- Chrome Extension Manifest V3
- Vanilla JavaScript
- Chrome Storage API for persistence
- Chrome Tabs API for tab management

## Usage
After installation, the extension will:
- Start tracking tab inactivity
- Show countdown timers in the popup
- Automatically close tabs that exceed the inactivity period
- Maintain at least the minimum number of tabs per window
- Preserve tab state across browser sessions

## License
MIT License
