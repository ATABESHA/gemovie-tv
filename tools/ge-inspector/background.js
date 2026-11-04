// Clicking the toolbar button opens the inspector in a new tab.
chrome.action.onClicked.addListener(function () {
  chrome.tabs.create({ url: chrome.runtime.getURL('inspector.html') });
});
