// The stub keeps the worker deliberately empty: the agent loop lives in the
// side panel document, which is the whole point of the architecture note.
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});
