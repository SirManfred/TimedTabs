// Constants and state management
const DEFAULT_SETTINGS = {
  days: 14,
  hours: 0,
  minutes: 0,
  minTabs: 5
};

let currentSettings = { ...DEFAULT_SETTINGS };

const state = {
  tabData: {},
  tabGroups: {
    years: {},
    months: {},
    days: {},
    hours: {},
    minutes: {}
  },
  checkInterval: null
};


async function initializeExtension() {
  try {
    console.log('Starting extension initialization');
    await handleTabRestoration();
    
    const tabs = await chrome.tabs.query({});
    const activeTab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    const activeTabId = activeTab?.id;
    
    console.log(`Found ${tabs.length} tabs, active tab: ${activeTabId}`);
    
    // Initialize timers for all inactive, unpinned tabs
    for (const tab of tabs) {
      if (!tab.pinned && tab.id !== activeTabId) {
        await initializeTabTimer(tab.id);
      }
    }
    
    startPeriodicChecks();
    console.log('Extension initialization completed successfully');
    return true;
  } catch (error) {
    console.error('Extension initialization failed:', error);
    // Attempt recovery by starting periodic checks
    startPeriodicChecks();
    return false;
  }
}

// Utility functions
function getTimerDuration(settings) {
  const { days, hours, minutes } = settings;
  return (days * 24 * 60 + hours * 60 + minutes) * 60 * 1000;
}

function calculateExpiryTime(lastActive, settings) {
  return lastActive + getTimerDuration(settings);
}

async function safeTabOperation(operation, fallback = null) {
  try {
    return await operation();
  } catch (error) {
    console.error('Tab operation failed:', error);
    return fallback;
  }
}

function validateTabData(data) {
  const now = Date.now();
  return {
    lastActive: typeof data?.lastActive === 'number' ? data.lastActive : now,
    settings: data?.settings || currentSettings,
    expiryTime: typeof data?.expiryTime === 'number' ? data.expiryTime : calculateExpiryTime(now, currentSettings),
    createdAt: data?.createdAt || performance.now(),
    isPaused: Boolean(data?.isPaused),
    visited: Boolean(data?.visited),
    timeRemaining: data?.timeRemaining || null
  };
}

// Group management functions
function addToGroup(groupType, timeUnit, tabId, expiryTime) {
  if (!state.tabGroups[groupType][timeUnit]) {
    state.tabGroups[groupType][timeUnit] = {
      tabs: [],
      expiryTime: expiryTime
    };
  }
  if (!state.tabGroups[groupType][timeUnit].tabs.includes(tabId)) {
    state.tabGroups[groupType][timeUnit].tabs.push(tabId);
  }
}

function removeTabFromGroups(tabId) {
  Object.keys(state.tabGroups).forEach(groupType => {
    Object.keys(state.tabGroups[groupType]).forEach(timeUnit => {
      const group = state.tabGroups[groupType][timeUnit];
      group.tabs = group.tabs.filter(id => id !== tabId);
      
      if (group.tabs.length === 0) {
        delete state.tabGroups[groupType][timeUnit];
      }
    });
  });
}

function groupTab(tabId, expiryTime) {
  const now = Date.now();
  const expiry = new Date(expiryTime);
  const currentDate = new Date(now);
  
  removeTabFromGroups(tabId);
  
  if (expiry.getFullYear() > currentDate.getFullYear()) {
    addToGroup('years', expiry.getFullYear(), tabId, expiryTime);
  } else if (expiry.getMonth() > currentDate.getMonth()) {
    addToGroup('months', expiry.getMonth(), tabId, expiryTime);
  } else if (expiry.getDate() > currentDate.getDate()) {
    addToGroup('days', expiry.getDate(), tabId, expiryTime);
  } else if (expiry.getHours() > currentDate.getHours()) {
    addToGroup('hours', expiry.getHours(), tabId, expiryTime);
  } else {
    addToGroup('minutes', expiry.getMinutes(), tabId, expiryTime);
  }
}

// Tab management functions
async function initializeTabTimer(tabId) {
  const result = await chrome.storage.local.get(['timerSettings']);
  const settings = result.timerSettings || currentSettings;
  
  const tab = await safeTabOperation(() => chrome.tabs.get(tabId));
  if (!tab || tab.pinned) return;
  
  const now = Date.now();
  const tabInfo = {
    lastActive: now,
    settings,
    expiryTime: calculateExpiryTime(now, settings),
    createdAt: performance.now(),
    isPaused: false,
    visited: false
  };
  
  state.tabData[tabId] = validateTabData(tabInfo);
  groupTab(tabId, state.tabData[tabId].expiryTime);
  
  console.log(`Initialized timer for tab ${tabId}:`, state.tabData[tabId]);
}

async function canCloseTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const allTabs = await chrome.tabs.query({ windowId: tab.windowId });
    const settings = await chrome.storage.local.get(['minTabs']);
    const minTabs = settings.minTabs || currentSettings.minTabs;
    
    const unpinnedTabs = allTabs.filter(t => !t.pinned).length;
    return unpinnedTabs > minTabs;
  } catch (error) {
    console.error('Error checking if tab can be closed:', error);
    return false;
  }
}

async function closeExpiredTab(tabId) {
  if (await canCloseTab(tabId)) {
    await safeTabOperation(() => chrome.tabs.remove(tabId));
    removeTabFromGroups(tabId);
    delete state.tabData[tabId];
  }
}


// Timer management
async function checkTimeGroup(groupType, timeUnit) {
  const group = state.tabGroups[groupType][timeUnit];
  if (!group) return;
  
  const now = Date.now();
  console.log(`Checking ${groupType} group ${timeUnit}, found ${group.tabs.length} tabs`);
  
  for (const tabId of [...group.tabs]) {
    const tab = state.tabData[tabId];
    if (!tab) {
      removeTabFromGroups(tabId);
      continue;
    }
    
    if (now >= tab.expiryTime) {
      try {
        const tabInfo = await chrome.tabs.get(parseInt(tabId));
        if (!tabInfo.pinned && await canCloseTab(parseInt(tabId))) {
          await closeExpiredTab(parseInt(tabId));
        }
      } catch (error) {
        console.error('Error handling tab:', tabId, error);
        removeTabFromGroups(tabId);
        delete state.tabData[tabId];
      }
    }
  }
}

async function checkExpiredTabs() {
  const now = Date.now();
  
  // Check each time group
  for (const groupType of Object.keys(state.tabGroups)) {
    for (const timeUnit of Object.keys(state.tabGroups[groupType])) {
      await checkTimeGroup(groupType, timeUnit);
    }
  }
  
  // Check by window
  const tabs = await chrome.tabs.query({});
  const tabsByWindow = new Map();
  
  tabs.forEach(tab => {
    if (!tabsByWindow.has(tab.windowId)) {
      tabsByWindow.set(tab.windowId, []);
    }
    tabsByWindow.get(tab.windowId).push(tab);
  });
  
  for (const [windowId, windowTabs] of tabsByWindow) {
    const unpinnedTabs = windowTabs.filter(t => !t.pinned);
    
    if (unpinnedTabs.length > currentSettings.minTabs) {
      for (const tab of windowTabs) {
        const data = state.tabData[tab.id];
        if (data && !tab.pinned && now >= data.expiryTime && !data.isPaused) {
          await closeExpiredTab(tab.id);
        }
      }
    }
  }
}

function startPeriodicChecks() {
  if (state.checkInterval) {
    clearInterval(state.checkInterval);
  }
  state.checkInterval = setInterval(checkExpiredTabs, 5000);
}

// Pause/Resume functionality
function handlePause(tabId) {
  const data = state.tabData[tabId];
  if (data && !data.isPaused) {
    const now = Date.now();
    data.pausedAt = now;
    data.timeRemaining = data.expiryTime - now;
    data.isPaused = true;
    removeTabFromGroups(tabId);
  }
}

function handleResume(tabId) {
  const data = state.tabData[tabId];
  if (data && data.isPaused) {
    const now = Date.now();
    data.lastActive = now;
    data.expiryTime = now + data.timeRemaining;
    data.isPaused = false;
    delete data.pausedAt;
    delete data.timeRemaining;
    groupTab(tabId, data.expiryTime);
  }
}

async function recalculateAllTabTimers(newSettings) {
  const tabs = await chrome.tabs.query({});
  
  for (const tab of tabs) {
    if (!tab.pinned && state.tabData[tab.id]) {
      const lastActive = state.tabData[tab.id].lastActive;
      const expiryTime = calculateExpiryTime(lastActive, newSettings);
      
      if (Date.now() >= expiryTime && await canCloseTab(tab.id)) {
        await closeExpiredTab(tab.id);
        continue;
      }
      
      state.tabData[tab.id] = validateTabData({
        ...state.tabData[tab.id],
        settings: newSettings,
        expiryTime
      });
      
      groupTab(tab.id, expiryTime);
    }
  }
}

// Status reporting
async function getTabsStatus() {
  try {
    const tabs = await chrome.tabs.query({});
    return tabs.map(tab => {
      const data = state.tabData[tab.id];
      if (!data) {
        return {
          id: tab.id,
          title: tab.title || 'Untitled Tab',
          pinned: tab.pinned,
          expiryTime: null,
          windowId: tab.windowId,
          lastActive: Date.now(),
          index: tab.index,
          isPaused: false
        };
      }

      const validatedData = validateTabData(data);
      return {
        id: tab.id,
        title: tab.title || 'Untitled Tab',
        pinned: tab.pinned,
        expiryTime: validatedData.expiryTime,
        windowId: tab.windowId,
        lastActive: validatedData.lastActive,
        index: tab.index,
        createdAt: validatedData.createdAt,
        isPaused: validatedData.isPaused,
        timeRemaining: validatedData.isPaused ? 
          validatedData.timeRemaining : 
          validatedData.expiryTime - Date.now()
      };
    });
  } catch (error) {
    console.error('Error getting tab status:', error);
    return [];
  }
}

// Event handlers
chrome.runtime.onInstalled.addListener(async () => {
  console.log('Extension installed');
  await initializeExtension();
});



chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.hasOwnProperty('pinned')) {
    if (changeInfo.pinned) {
      removeTabFromGroups(tabId);
      delete state.tabData[tabId];
    } else {
      chrome.tabs.query({ active: true, currentWindow: true }, ([activeTab]) => {
        if (!activeTab || activeTab.id !== tabId) {
          initializeTabTimer(tabId);
        }
      });
    }
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const now = Date.now();
  const existingData = state.tabData[activeInfo.tabId];
  
  if (existingData) {
    // Update the lastActive time when tab is visited
    state.tabData[activeInfo.tabId] = validateTabData({
      ...existingData,
      lastActive: now,
      expiryTime: calculateExpiryTime(now, existingData.settings || currentSettings),
      visited: true // Mark as visited
    });
    
    groupTab(activeInfo.tabId, state.tabData[activeInfo.tabId].expiryTime);
  }
  const tabs = await chrome.tabs.query({ currentWindow: true });
  for (const tab of tabs) {
    if (tab.id !== activeInfo.tabId && !tab.pinned) {
      const tabData = state.tabData[tab.id];
      if (tabData && now >= tabData.expiryTime) {
        await closeExpiredTab(tab.id);
      } else if (!tabData) {
        await initializeTabTimer(tab.id);
      }
    }
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  if (!tab.pinned) {
    const now = Date.now();
    state.tabData[tab.id] = validateTabData({
      lastActive: now,
      settings: currentSettings,
      expiryTime: calculateExpiryTime(now, currentSettings),
      createdAt: now, // Use same timestamp for both to mark as unvisited
      isPaused: false,
      visited: false
    });
    
    groupTab(tab.id, state.tabData[tab.id].expiryTime);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  removeTabFromGroups(tabId);
  delete state.tabData[tabId];
});
// The first part remains the same until the chrome.runtime.onMessage.addListener...

// Complete message handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'settingsUpdated') {
    currentSettings = { ...message.settings };
    if (message.resetTimers) {
      recalculateAllTabTimers(currentSettings);
    }
    sendResponse({ success: true });
  }
  else if (message.type === 'getTabsStatus') {
    console.log('Getting tab status, current tabData:', state.tabData);
    getTabsStatus()
      .then(tabs => {
        console.log('Sending tab status:', tabs);
        sendResponse({ tabs });
      })
      .catch(error => {
        console.error('Error in getTabsStatus:', error);
        sendResponse({ tabs: [] });
      });
    return true;
  }
  else if (message.type === 'pauseTab') {
    handlePause(message.tabId);
    sendResponse({ success: true });
  }
  else if (message.type === 'resumeTab') {
    handleResume(message.tabId);
    sendResponse({ success: true });
  }
  else if (message.type === 'resetTab') {
    const tabId = message.tabId;
    if (state.tabData[tabId]) {
      const now = Date.now();
      state.tabData[tabId] = validateTabData({
        ...state.tabData[tabId],
        lastActive: now,
        expiryTime: calculateExpiryTime(now, state.tabData[tabId].settings || currentSettings),
        isPaused: false
      });
      groupTab(tabId, state.tabData[tabId].expiryTime);
    }
    sendResponse({ success: true });
  }
  return true;
});

// Add back tab initialization on replacement
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  try {
    removeTabFromGroups(removedTabId);
    delete state.tabData[removedTabId];
    initializeTabTimer(addedTabId);
  } catch (error) {
    console.error('Error handling tab replacement:', error);
  }
});

// Add back focused window handling
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    chrome.tabs.query({ active: true, windowId }, ([activeTab]) => {
      if (activeTab && !activeTab.pinned) {
        const now = Date.now();
        if (state.tabData[activeTab.id]) {
          state.tabData[activeTab.id].lastActive = now;
          state.tabData[activeTab.id].expiryTime = calculateExpiryTime(
            now,
            state.tabData[activeTab.id].settings || currentSettings
          );
          groupTab(activeTab.id, state.tabData[activeTab.id].expiryTime);
        } else {
          initializeTabTimer(activeTab.id);
        }
      }
    });
  }
});

// Add back tab audible state handling
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.hasOwnProperty('audible')) {
    if (changeInfo.audible) {
      const data = state.tabData[tabId];
      if (data) {
        data.isPaused = true;
        removeTabFromGroups(tabId);
      }
    } else {
      const data = state.tabData[tabId];
      if (data) {
        data.isPaused = false;
        const now = Date.now();
        data.lastActive = now;
        data.expiryTime = calculateExpiryTime(now, data.settings || currentSettings);
        groupTab(tabId, data.expiryTime);
      }
    }
  }
});

// Add back comprehensive tab restoration
async function handleTabRestoration() {
  const result = await chrome.storage.local.get(['tabStates', 'timerSettings', 'minTabs']);
  currentSettings = result.timerSettings || DEFAULT_SETTINGS;
  
  if (result.tabStates) {
    const now = Date.now();
    const tabs = await chrome.tabs.query({});
    const windowTabs = {};
    
    // Group tabs by window
    tabs.forEach(tab => {
      if (!windowTabs[tab.windowId]) {
        windowTabs[tab.windowId] = [];
      }
      windowTabs[tab.windowId].push(tab);
    });
    
    // Process each window's tabs
    for (const windowId in windowTabs) {
      const windowTabsList = windowTabs[windowId];
      const unpinnedTabs = windowTabsList.filter(tab => !tab.pinned);
      let tabsToKeep = result.minTabs || currentSettings.minTabs;
      
      for (const tab of unpinnedTabs) {
        const oldState = result.tabStates[tab.id];
        
        if (oldState) {
          if (oldState.isPaused) {
            state.tabData[tab.id] = validateTabData({
              ...oldState,
              timeRemaining: oldState.timeRemaining
            });
          } else {
            const expiryTime = calculateExpiryTime(oldState.lastActive, oldState.settings);
            
            if (now >= expiryTime && unpinnedTabs.length > tabsToKeep) {
              await safeTabOperation(() => chrome.tabs.remove(tab.id));
            } else {
              state.tabData[tab.id] = validateTabData({
                ...oldState,
                expiryTime
              });
              groupTab(tab.id, expiryTime);
            }
          }
          tabsToKeep--;
        } else {
          await initializeTabTimer(tab.id);
          tabsToKeep--;
        }
      }
    }
  }
  
  // Start periodic checks after restoration
  startPeriodicChecks();
}

// Add back initialization error handling
chrome.runtime.onStartup.addListener(async () => {
  try {
    await handleTabRestoration();
    console.log('Extension startup completed successfully');
  } catch (error) {
    console.error('Error during extension startup:', error);
    // Attempt recovery
    startPeriodicChecks();
  }
});

// Add back suspension state handling
chrome.runtime.onSuspend.addListener(async () => {
  try {
    if (state.checkInterval) {
      clearInterval(state.checkInterval);
      state.checkInterval = null;
    }
    
    // Save current state
    await chrome.storage.local.set({
      tabStates: state.tabData,
      tabGroups: state.tabGroups,
      timerSettings: currentSettings
    });
    
    console.log('Extension state saved successfully');
  } catch (error) {
    console.error('Error saving extension state:', error);
  }
});

// Add back additional tab event handling
chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
  if (state.tabData[tabId]) {
    const now = Date.now();
    state.tabData[tabId].lastActive = now;
    state.tabData[tabId].expiryTime = calculateExpiryTime(
      now,
      state.tabData[tabId].settings || currentSettings
    );
    groupTab(tabId, state.tabData[tabId].expiryTime);
  }
});

chrome.tabs.onDetached.addListener((tabId) => {
  if (state.tabData[tabId]) {
    const now = Date.now();
    state.tabData[tabId].lastActive = now;
    state.tabData[tabId].expiryTime = calculateExpiryTime(
      now,
      state.tabData[tabId].settings || currentSettings
    );
    groupTab(tabId, state.tabData[tabId].expiryTime);
  }
});



chrome.runtime.onConnect.addListener(port => {
  port.onDisconnect.addListener(() => {
    // Cleanup when the port disconnects
    if (state.checkInterval) {
      clearInterval(state.checkInterval);
      state.checkInterval = null;
    }
  });
});