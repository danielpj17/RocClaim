// Clicking the toolbar icon opens the side panel instead of a popup. A side
// panel stays put when you click into the page or switch tabs; a popup closes.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
