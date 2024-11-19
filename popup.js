let updateInterval = null;

document.addEventListener('DOMContentLoaded', function() {
  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab, .tab-content').forEach(el => el.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(tab.dataset.tab).classList.add('active');
	  
      if (tab.dataset.tab === 'tabs') {
        updateTabList(true);
	  } else {
        // Clear the interval when switching away from the tabs view
        if (updateInterval) {
          clearInterval(updateInterval);
          updateInterval = null;
        }
      }
    });
  });

  // Load saved settings
  chrome.storage.local.get(['timerSettings', 'minTabs'], function(result) {
    if (result.timerSettings) {
      document.getElementById('days').value = result.timerSettings.days;
      document.getElementById('hours').value = result.timerSettings.hours;
      document.getElementById('minutes').value = result.timerSettings.minutes;
    }
    if (result.minTabs) {
      document.getElementById('minTabs').value = result.minTabs;
    }
  });

  document.getElementById('saveSettings').addEventListener('click', function() {
    const settings = {
      days: parseInt(document.getElementById('days').value) || 0,
      hours: parseInt(document.getElementById('hours').value) || 0,
      minutes: parseInt(document.getElementById('minutes').value) || 0
    };
    
    const minTabs = Math.max(1, parseInt(document.getElementById('minTabs').value) || 5);

    chrome.storage.local.set({
      timerSettings: settings,
      minTabs: minTabs
    }, function() {
      // Just save the settings, don't recalculate timers
      chrome.runtime.sendMessage({ 
        type: 'settingsUpdated',
        settings: settings,
        resetTimers: false
      });
    });
  });

  // Add reset timers button handler
  document.getElementById('resetTimers').addEventListener('click', function() {
    chrome.storage.local.get(['timerSettings'], function(result) {
      const settings = result.timerSettings || defaultSettings;
      chrome.runtime.sendMessage({ 
        type: 'settingsUpdated',
        settings: settings,
        resetTimers: true
      });
    });
  });

  // Initial tab list update
  if (document.querySelector('[data-tab="tabs"]').classList.contains('active')) {
    updateTabList(true);
  }
});

window.addEventListener('unload', () => {
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
  }
});

function getTimerDuration(settings) {
  const { days, hours, minutes } = settings || { days: 14, hours: 0, minutes: 0 };
  return (days * 24 * 60 + hours * 60 + minutes) * 60 * 1000;
}

function updateTabList(forceRefresh = false) {
  const tabList = document.getElementById('tabList');
  if (!tabList) return;
  
  if (forceRefresh) {
    tabList.innerHTML = '<div class="tab-item">Loading...</div>';
  }

  chrome.runtime.sendMessage({ type: 'getTabsStatus' }, function(response) {
    if (!response || !Array.isArray(response.tabs)) {
      console.error('Invalid response:', response);
      tabList.innerHTML = '<div class="tab-item">Error loading tabs</div>';
      return;
    }

    const tabs = [...response.tabs];
    console.log('Received tabs:', tabs); // Debug log
    
    chrome.storage.local.get(['minTabs'], function(result) {
      const minTabs = result.minTabs || 5;
      
      if (!tabs.length) {
        tabList.innerHTML = '<div class="tab-item">No tabs to display</div>';
        return;
      }

      // Ensure all required properties exist before sorting
      tabs.forEach(tab => {
        if (!tab.lastActive) tab.lastActive = Date.now();
        if (!tab.title) tab.title = 'Untitled Tab';
        if (typeof tab.index !== 'number') tab.index = 0;
      });

      // Group tabs by window first
      const tabsByWindow = new Map();
      tabs.forEach(tab => {
        if (!tabsByWindow.has(tab.windowId)) {
          tabsByWindow.set(tab.windowId, []);
        }
        tabsByWindow.get(tab.windowId).push(tab);
      });

      // Process each window's tabs to determine protected status
      tabsByWindow.forEach(windowTabs => {
        // Sort tabs by their original index to determine protection status
        const sortedWindowTabs = [...windowTabs].sort((a, b) => a.index - b.index);
        const unpinnedTabs = sortedWindowTabs.filter(t => !t.pinned);
        
        // Mark protected tabs (youngest by position, not by time)
        unpinnedTabs.slice(0, minTabs).forEach(tab => {
          tab.isProtected = true;
        });
      });

      // First organize tabs by window and sort within each window
      const windowGroups = new Map();
      tabs.forEach(tab => {
        if (!windowGroups.has(tab.windowId)) {
          windowGroups.set(tab.windowId, []);
        }
        windowGroups.get(tab.windowId).push(tab);
      });

      // Sort tabs within each window group
      windowGroups.forEach(windowTabs => {
        windowTabs.sort((a, b) => {
          const statusA = getTabStatus(a, tabs, minTabs);
          const statusB = getTabStatus(b, tabs, minTabs);
          
          // First sort by status
          if (statusA.order !== statusB.order) {
            return statusA.order - statusB.order;
          }
          
          // Then by index for pinned and protected tabs
          if (statusA.status !== 'Timer') {
            return a.index - b.index;
          }
          
          // Timer tabs by last active time
          return b.lastActive - a.lastActive;
        });
      });

      // Create the final sorted array
      const sortedTabs = [];
      // Sort windows by their IDs to maintain consistent order
      Array.from(windowGroups.keys()).sort().forEach(windowId => {
        const windowTabs = windowGroups.get(windowId);
        sortedTabs.push(...windowTabs);
      });

      if (forceRefresh) {
        tabList.innerHTML = '';
        
        let currentWindowId = null;
        let windowCounter = 1;
        
        sortedTabs.forEach(tab => {
          // Add window separator if needed
          if (tab.windowId !== currentWindowId) {
            currentWindowId = tab.windowId;
            
            const separator = document.createElement('div');
            separator.className = 'window-separator';
            separator.dataset.windowId = tab.windowId;
            
            const titleContainer = document.createElement('div');
            titleContainer.className = 'window-title-container';
            
            const title = document.createElement('span');
            title.textContent = `Window ${windowCounter++}`;
            titleContainer.appendChild(title);
            
            // Check window status and add badge if idle
            getWindowStatus(tab.windowId, sortedTabs).then(status => {
              if (!status.active) {
                const badge = document.createElement('span');
                badge.className = 'window-status-badge idle';
                badge.textContent = 'Idle';
                badge.title = `Inactive for ${formatTimeLeft(status.timeSinceActive)}`;
                titleContainer.appendChild(badge);
              }
            });

            separator.appendChild(titleContainer);
            
            // Add click handler for the window separator
            separator.addEventListener('click', () => {
              chrome.windows.update(tab.windowId, { 
                focused: true
              });
            });
            
            tabList.appendChild(separator);
          }

          // Get status
          const status = getTabStatus(tab, sortedTabs, minTabs);

          // Create tab item
          const div = document.createElement('div');
          div.className = 'tab-item';
          div.dataset.tabId = tab.id;
          
          // Add click handler to switch to tab
          div.addEventListener('click', () => {
            chrome.tabs.update(tab.id, { active: true });
            chrome.windows.update(tab.windowId, { focused: true });
          });
          
          if (status.status !== 'Timer') {
            div.classList.add(`status-${status.status.toLowerCase()}`);
          }

          // Create favicon container
          const favicon = document.createElement('img');
          favicon.className = 'tab-favicon';
          favicon.width = 16;
          favicon.height = 16;

          // Use the direct favIconUrl if available, otherwise use a default icon
          if (tab.favIconUrl && !tab.favIconUrl.startsWith('chrome://')) {
            favicon.src = tab.favIconUrl;
          } else {
            favicon.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="%23ddd"/></svg>';
          }

          // Handle load errors
          favicon.onerror = () => {
            favicon.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="%23ddd"/></svg>';
          };

          const titleContainer = document.createElement('div');
          titleContainer.className = 'title-container';
          
          const title = document.createElement('div');
          title.className = 'tab-title';
          title.textContent = tab.title || 'Untitled Tab';
          
          const statusBadge = document.createElement('div');
          statusBadge.className = `status-badge ${status.status.toLowerCase()}`;
          
          // Add tooltip information and status
          if (status.status === 'Timer') {
            console.log('Processing timer tab:', {
              id: tab.id,
              title: tab.title,
              expiryTime: tab.expiryTime,
              fullTab: tab
            });

            if (tab.isPaused) {
              statusBadge.textContent = 'Paused';
              tooltipText = `${formatTimeLeft(tab.timeRemaining)} remaining`;
            } else if (!tab.expiryTime) {
              console.error('Missing expiry time for tab:', {
                id: tab.id,
                title: tab.title,
                expiryTime: tab.expiryTime,
                fullTab: tab
              });
              statusBadge.textContent = 'Error';
              tooltipText = 'Timer error';
            } else {
              div.dataset.expiryTime = tab.expiryTime;
              const timeLeft = tab.expiryTime - Date.now();
              statusBadge.textContent = formatTimeLeft(timeLeft);
              tooltipText = `Created: ${new Date(tab.lastActive).toLocaleTimeString()}.${String(tab.createdAt % 1000).padStart(3, '0')}`;
            }
          } else if (status.status === 'Protected') {
            statusBadge.textContent = status.status;
            tooltipText = tab.isPaused ? 
              `Timer paused with ${formatTimeLeft(tab.timeRemaining)} remaining` : 
              'Protected by minimum tabs setting';
            
            // Update the protected status in background
            chrome.runtime.sendMessage({
              type: 'updateProtectedStatus',
              tabId: tab.id,
              isProtected: true
            });
          } else {
            statusBadge.textContent = status.status;
            tooltipText = 'Pinned tab - timer disabled';
          }
          
          // Add tooltip attributes
          statusBadge.title = tooltipText;
          statusBadge.setAttribute('data-tooltip', tooltipText);
          
          // Assemble the components
          titleContainer.appendChild(favicon);
          titleContainer.appendChild(title);
          div.appendChild(titleContainer);
          div.appendChild(statusBadge);
          tabList.appendChild(div);
        });
      }

      startRealtimeUpdates();
    });
  });
}

function getTabStatus(tab, allTabs, minTabs) {
  if (tab.pinned) return { status: 'Pinned', order: 1 };
  
  // Check if tab has been visited
  const isUnvisited = tab.lastActive === tab.createdAt;
  if (isUnvisited) {
    return { status: 'Timer', order: 3 }; // Never protect unvisited tabs
  }
  
  // Get unpinned tabs in this window that have been visited
  const windowTabs = allTabs.filter(t => 
    t.windowId === tab.windowId && 
    !t.pinned && 
    t.lastActive !== t.createdAt
  );
  
  // Sort by lastActive time, newest first
  const sortedTabs = [...windowTabs].sort((a, b) => {
    const aActive = a.lastActive || 0;
    const bActive = b.lastActive || 0;
    return bActive - aActive;
  });
  
  // Check if this tab is among the protected ones (youngest tabs)
  const isProtected = sortedTabs.findIndex(t => t.id === tab.id) < minTabs;
  if (isProtected) return { status: 'Protected', order: 2 };
  
  return { status: 'Timer', order: 3 };
}

function startRealtimeUpdates() {
  // Clear any existing interval
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
  }
  
  // Update every second
  updateInterval = setInterval(() => {
    const tabList = document.getElementById('tabList');
    if (!tabList || !document.querySelector('[data-tab="tabs"].active')) {
      // Stop updates if tab list is not visible
      clearInterval(updateInterval);
      updateInterval = null;
      return;
    }

    updateCountdowns();
  }, 1000); // Update every second

  // Check for closed tabs less frequently
  setInterval(() => {
    if (document.querySelector('[data-tab="tabs"].active')) {
      checkForClosedTabs();
    }
  }, 5000);
}

function updateCountdowns() {
  const now = Date.now();
  const tabItems = document.querySelectorAll('.tab-item[data-expiry-time]');
  
  tabItems.forEach(item => {
    const expiryTime = parseInt(item.dataset.expiryTime);
    if (expiryTime) {
      const timeLeft = expiryTime - now;
      const statusBadge = item.querySelector('.status-badge.timer');
      if (statusBadge) {
        if (timeLeft <= 0) {
          statusBadge.textContent = 'Closing soon...';
        } else {
          const seconds = Math.floor(timeLeft / 1000);
          const minutes = Math.floor(seconds / 60);
          const remainingSeconds = seconds % 60;
          
          if (minutes < 10) {
            // Show MM:SS format for last 10 minutes
            statusBadge.textContent = `${minutes}:${remainingSeconds.toString().padStart(2, '0')} left`;
          } else {
            // For times over 10 minutes, show standard format
            const hours = Math.floor(minutes / 60);
            const remainingMinutes = minutes % 60;
            const parts = [];
            
            if (hours >= 24) {
              const days = Math.floor(hours / 24);
              const remainingHours = hours % 24;
              if (days > 0) parts.push(`${days}d`);
              if (remainingHours > 0) parts.push(`${remainingHours}h`);
            } else if (hours > 0) {
              parts.push(`${hours}h`);
            }
            
            if (remainingMinutes > 0) parts.push(`${remainingMinutes}m`);
            
            statusBadge.textContent = parts.join(' ') + ' left';
          }
        }
      }
    }
  });
}

function checkForClosedTabs() {
  const tabItems = [...document.querySelectorAll('.tab-item[data-tab-id]')];
  
  // Use Promise.all to check all tabs simultaneously
  Promise.all(tabItems.map(item => {
    return new Promise((resolve) => {
      const tabId = parseInt(item.dataset.tabId);
      if (tabId) {
        chrome.tabs.get(tabId, (tab) => {
          if (chrome.runtime.lastError) {
            resolve(true); // Tab needs to be removed
          } else {
            resolve(false);
          }
        });
      } else {
        resolve(false);
      }
    });
  })).then(results => {
    if (results.some(needsUpdate => needsUpdate)) {
      updateTabList(true);
    }
  });
}

function formatTimeLeft(ms) {
  if (!ms || ms <= 0) return 'Closing soon...';
  
  const totalSeconds = ms / 1000;
  const days = Math.floor(totalSeconds / (24 * 60 * 60));
  const hours = Math.floor((totalSeconds % (24 * 60 * 60)) / (60 * 60));
  const minutes = Math.floor((totalSeconds % (60 * 60)) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const hundredths = Math.floor((ms % 1000) / 10);
  
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || (days === 0 && hours === 0)) {
    if (minutes < 10) {
      parts.push(`${minutes}:${seconds.toString().padStart(2, '0')}.${hundredths.toString().padStart(2, '0')}`);
    } else {
      parts.push(`${minutes}m`);
    }
  }
  
  return parts.join(' ') + ' left';
}

async function getTabsStatus() {
  const tabs = await chrome.tabs.query({});
  return tabs.map(tab => {
    const data = tabData[tab.id];
    return {
      id: tab.id,
      title: tab.title || 'Untitled Tab',
      pinned: tab.pinned,
      expiryTime: data ? data.expiryTime : null,
      windowId: tab.windowId,
      lastActive: data ? data.lastActive : null
    };
  }); // Remove the filter to include all tabs
}

window.addEventListener('unload', () => {
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
  }
});

// Add this function to check window status
async function getWindowStatus(windowId, tabs) {
  // Get the most recent activity time from any active tab in the window
  const windowTabs = tabs.filter(t => t.windowId === windowId);
  const activeTimes = windowTabs
    .filter(tab => !tab.pinned && tab.lastActive)
    .map(tab => tab.lastActive);

  if (activeTimes.length === 0) return { active: true }; // Consider new windows active

  const lastActiveTime = Math.max(...activeTimes);
  const timeSinceActive = Date.now() - lastActiveTime;

  // Get time limit from settings
  const settings = await chrome.storage.local.get(['timerSettings']);
  const timeLimit = getTimerDuration(settings.timerSettings);

  return {
    active: timeSinceActive < timeLimit,
    lastActive: lastActiveTime,
    timeSinceActive
  };
}