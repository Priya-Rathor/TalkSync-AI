// TalkSync Background Service Worker
console.log('[TalkSync] Background service worker started');

chrome.runtime.onInstalled.addListener(() => {
  console.log('[TalkSync] Extension installed');
  chrome.storage.sync.set({
    srcLang: 'en',
    tgtLang: 'hi',
    geminiApiKey: '',
    autoSpeak: false,
    overlayPos: 'bottom'
  });
});

// Forward messages between popup and content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[TalkSync BG] Message:', msg.type);

  if (msg.type === 'TO_CONTENT') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) { sendResponse({ ok: false, error: 'No active tab' }); return; }
      chrome.tabs.sendMessage(tabs[0].id, msg.data, (res) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: true, data: res });
        }
      });
    });
    return true; // keep channel open for async
  }
});