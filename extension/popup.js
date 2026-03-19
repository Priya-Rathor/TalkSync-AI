// TalkSync Popup JS
// Controls the extension popup UI and communicates with content.js

let isRunning = false;

// ── Load saved settings on open ──────────────────────────
chrome.storage.sync.get(null, (settings) => {
  if (settings.srcLang)        document.getElementById('src-lang').value      = settings.srcLang;
  if (settings.tgtLang)        document.getElementById('tgt-lang').value      = settings.tgtLang;
  if (settings.overlayPosition) document.getElementById('sel-position').value = settings.overlayPosition;
  if (settings.fontSize)       document.getElementById('sel-font').value      = settings.fontSize;
  if (settings.autoSpeak)      document.getElementById('tog-speak').classList.toggle('on', settings.autoSpeak);

  // Load Gemini key
  if (settings.geminiApiKey) {
    document.getElementById('gemini-key').value = settings.geminiApiKey;
    setKeyStatus('saved', `✨ Gemini key saved — AI translation active`);
  }
});

// ── Check if we're on a Meet tab ─────────────────────────
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const url = tabs[0]?.url || '';
  const onMeet = url.includes('meet.google.com');
  document.getElementById('not-meet-msg').style.display = onMeet ? 'none'  : 'flex';
  document.getElementById('main-panel').style.display   = onMeet ? 'flex'  : 'none';
});

// ── Listen for results from content script ───────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'TRANSLATION_RESULT') {
    document.getElementById('preview-orig').textContent = msg.original   || '—';
    document.getElementById('preview-tran').textContent = msg.translated || '—';
    // Show which engine was used
    if (msg.engine === 'gemini') {
      document.getElementById('preview-tran').style.color = '#00e5a0';
    } else {
      document.getElementById('preview-tran').style.color = '';
    }
  }
  if (msg.type === 'STATUS') {
    updateRunningState(msg.isRunning);
  }
});

// ── Toggle start/stop ────────────────────────────────────
function toggleTranslation() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    const type = isRunning ? 'STOP' : 'START';

    chrome.tabs.sendMessage(tabs[0].id, { type }, () => {
      if (chrome.runtime.lastError) {
        // Inject content script if not loaded yet
        chrome.scripting.executeScript(
          { target: { tabId: tabs[0].id }, files: ['content.js'] },
          () => {
            chrome.scripting.insertCSS(
              { target: { tabId: tabs[0].id }, files: ['overlay.css'] },
              () => {
                setTimeout(() => {
                  chrome.tabs.sendMessage(tabs[0].id, { type });
                  isRunning = !isRunning;
                  updateRunningState(isRunning);
                }, 500);
              }
            );
          }
        );
        return;
      }
      isRunning = !isRunning;
      updateRunningState(isRunning);
    });
  });
}

// ── Update UI state ──────────────────────────────────────
function updateRunningState(running) {
  isRunning = running;
  const btn  = document.getElementById('main-btn');
  const pill = document.getElementById('status-pill');
  const txt  = document.getElementById('status-text');

  if (running) {
    btn.textContent  = '⏹ Stop Translation';
    btn.className    = 'big-btn stop';
    pill.className   = 'status-pill live';
    txt.textContent  = 'Live';
  } else {
    btn.innerHTML    = '🎙️ Start Translation';
    btn.className    = 'big-btn start';
    pill.className   = 'status-pill';
    txt.textContent  = 'Idle';
  }
}

// ════════════════════════════════════════════════════════
//  GEMINI API KEY MANAGEMENT
// ════════════════════════════════════════════════════════

function saveApiKey() {
  const key = document.getElementById('gemini-key').value.trim();
  const btn = document.getElementById('save-key-btn');

  if (!key) {
    setKeyStatus('err', '⚠️ Paste your API key first');
    return;
  }
  if (!key.startsWith('AIza')) {
    setKeyStatus('err', '⚠️ Invalid key — should start with "AIza"');
    return;
  }

  btn.textContent = 'Validating…';
  btn.disabled = true;

  // Validate the key with a quick Gemini API call
  validateGeminiKey(key).then(valid => {
    btn.textContent = 'Save Key';
    btn.disabled = false;

    if (valid) {
      chrome.storage.sync.set({ geminiApiKey: key }, () => {
        setKeyStatus('saved', '✅ Gemini key saved — AI translation active!');
        sendSettingsUpdate();
      });
    } else {
      setKeyStatus('err', '❌ Key invalid or quota exceeded');
    }
  });
}

async function validateGeminiKey(key) {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Say "ok" only.' }] }],
          generationConfig: { maxOutputTokens: 5 }
        }),
        signal: AbortSignal.timeout(8000)
      }
    );
    return res.ok;
  } catch {
    return false;
  }
}

function clearApiKey() {
  document.getElementById('gemini-key').value = '';
  chrome.storage.sync.remove('geminiApiKey', () => {
    setKeyStatus('', '🌐 Key cleared — using Google Translate');
    sendSettingsUpdate();
  });
}

function toggleKeyVis() {
  const input = document.getElementById('gemini-key');
  const btn   = document.getElementById('key-toggle-vis');
  if (input.type === 'password') {
    input.type   = 'text';
    btn.textContent = '🙈';
  } else {
    input.type   = 'password';
    btn.textContent = '👁';
  }
}

function setKeyStatus(type, msg) {
  const el = document.getElementById('key-status');
  el.textContent = msg;
  el.className   = 'key-status' + (type === 'saved' ? ' has-key' : type === 'err' ? ' err' : '');
}

// Also save on Enter key in input
document.getElementById('gemini-key')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveApiKey();
});

// ── Save settings + notify content script ────────────────
function saveSetting(key, value) {
  chrome.storage.sync.set({ [key]: value });
  sendSettingsUpdate();
}

function sendSettingsUpdate() {
  chrome.storage.sync.get(null, (settings) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'UPDATE_SETTINGS', settings });
      }
    });
  });
}

// ── Toggle switches ──────────────────────────────────────
function toggleOpt(key, elemId) {
  const el = document.getElementById(elemId);
  const nowOn = el.classList.toggle('on');
  saveSetting(key, nowOn);
}

// ── Swap languages ───────────────────────────────────────
function swapLangs() {
  const src = document.getElementById('src-lang');
  const tgt = document.getElementById('tgt-lang');
  [src.value, tgt.value] = [tgt.value, src.value];
  chrome.storage.sync.set({ srcLang: src.value, tgtLang: tgt.value });
  sendSettingsUpdate();
}

// ── Open standalone dashboard ────────────────────────────
function openDashboard() {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
}