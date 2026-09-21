/**
 * The service worker is deliberately thin. An MV3 worker is torn down after
 * roughly 30 seconds idle, so nothing long-running lives here — the agent loop
 * runs in the side panel document instead. This only opens the panel.
 */

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
    console.error('Could not set side panel behaviour', error);
  });
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId === undefined) return;
  chrome.sidePanel.open({ windowId: tab.windowId }).catch((error) => {
    console.error('Could not open side panel', error);
  });
});
