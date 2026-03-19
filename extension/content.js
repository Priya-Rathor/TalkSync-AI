// TalkSync Content Script — CSP-safe (no inline handlers)
(function () {
  if (window.__TALKSYNC__) return;
  window.__TALKSYNC__ = true;

  let recognition   = null;
  let isRunning     = false;
  let debTimer      = null;
  let isTranslating = false;
  let pendingText   = null;

  let cfg = {
    geminiApiKey: '',
    srcLang:      'en',
    tgtLang:      'hi',
    autoSpeak:    false
  };

  const SPEECH_LANG = {
    en:'en-US', hi:'hi-IN', pa:'pa-IN', ur:'ur-PK',
    bn:'bn-BD', te:'te-IN', ta:'ta-IN',
    es:'es-ES', fr:'fr-FR', de:'de-DE', ar:'ar-SA', zh:'zh-CN'
  };
  const G_CODES = {
    en:'en', hi:'hi', pa:'pa', ur:'ur', bn:'bn',
    te:'te', ta:'ta', es:'es', fr:'fr', de:'de', ar:'ar', zh:'zh-CN'
  };
  const LANG_NAMES = {
    en:'English',  hi:'Hindi',   pa:'Punjabi', ur:'Urdu',
    bn:'Bengali',  te:'Telugu',  ta:'Tamil',   es:'Spanish',
    fr:'French',   de:'German',  ar:'Arabic',  zh:'Chinese'
  };

  // Load settings then build
  chrome.storage.sync.get(null, (s) => {
    cfg = { ...cfg, ...s };
    buildUI();
  });

  // Messages from popup
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'START')    { startRec();  sendResponse({ ok: true }); }
    if (msg.type === 'STOP')     { stopRec();   sendResponse({ ok: true }); }
    if (msg.type === 'SETTINGS') {
      cfg = { ...cfg, ...msg.settings };
      syncDropdowns();
      sendResponse({ ok: true });
    }
    return true;
  });

  // ═══════════════════════════════════════════════════
  //  BUILD UI  — NO inline handlers anywhere
  // ═══════════════════════════════════════════════════
  function buildUI() {
    if (document.getElementById('ts-box')) return;

    // ── Inject CSS ──────────────────────────────────
    const style = document.createElement('style');
    style.textContent = `
      #ts-box {
        all: initial;
        position: fixed !important;
        top: 16px !important;
        left: 50% !important;
        transform: translateX(-50%) !important;
        width: 500px !important;
        max-width: calc(100vw - 32px) !important;
        z-index: 2147483647 !important;
        font-family: 'Segoe UI', Arial, sans-serif !important;
        font-size: 13px !important;
        line-height: 1.4 !important;
        color: #e8ecf5 !important;
        background: rgba(5,8,15,0.97) !important;
        border: 2px solid rgba(0,229,160,0.45) !important;
        border-radius: 14px !important;
        box-shadow: 0 20px 60px rgba(0,0,0,0.9), 0 0 24px rgba(0,229,160,0.08) !important;
        overflow: visible !important;
      }
      #ts-drag-bar {
        display: flex !important;
        align-items: center !important;
        justify-content: space-between !important;
        padding: 9px 13px !important;
        background: rgba(0,229,160,0.07) !important;
        border-bottom: 1px solid rgba(0,229,160,0.18) !important;
        border-radius: 12px 12px 0 0 !important;
        cursor: grab !important;
        gap: 10px !important;
        user-select: none !important;
      }
      #ts-drag-bar:active { cursor: grabbing !important; }
      #ts-logo {
        display: flex !important;
        align-items: center !important;
        gap: 7px !important;
        font-weight: 800 !important;
        font-size: 13px !important;
        color: #00e5a0 !important;
        flex-shrink: 0 !important;
        pointer-events: none !important;
      }
      #ts-dot {
        width: 9px !important; height: 9px !important;
        border-radius: 50% !important;
        background: #3d4d66 !important;
        display: inline-block !important;
        transition: background 0.3s !important;
        pointer-events: none !important;
      }
      #ts-dot.live {
        background: #f04f4f !important;
        box-shadow: 0 0 8px #f04f4f !important;
        animation: tsPulse 1s infinite !important;
      }
      @keyframes tsPulse {
        0%,100% { opacity:1; transform:scale(1); }
        50%      { opacity:0.3; transform:scale(0.7); }
      }
      #ts-drag-hint {
        font-size: 9px !important;
        color: rgba(0,229,160,0.4) !important;
        letter-spacing: 1.5px !important;
        pointer-events: none !important;
      }
      #ts-hdr-btns {
        display: flex !important;
        align-items: center !important;
        gap: 6px !important;
        flex-shrink: 0 !important;
      }
      #ts-start-btn {
        background: #00e5a0 !important;
        color: #000 !important;
        border: none !important;
        border-radius: 7px !important;
        padding: 5px 14px !important;
        font-size: 11px !important;
        font-weight: 800 !important;
        cursor: pointer !important;
        font-family: inherit !important;
        transition: all 0.15s !important;
        white-space: nowrap !important;
      }
      #ts-start-btn:hover { filter: brightness(1.15) !important; }
      #ts-start-btn.live  { background: #f04f4f !important; color: #fff !important; }
      #ts-min-btn {
        background: rgba(255,255,255,0.06) !important;
        border: 1px solid rgba(255,255,255,0.1) !important;
        border-radius: 6px !important;
        color: #7e8ba8 !important;
        width: 26px !important; height: 26px !important;
        display: flex !important; align-items: center !important; justify-content: center !important;
        cursor: pointer !important;
        font-size: 16px !important;
        font-family: inherit !important;
        transition: all 0.15s !important;
        flex-shrink: 0 !important;
      }
      #ts-min-btn:hover { background: rgba(255,255,255,0.14) !important; color: #fff !important; }

      /* ── Language row ── */
      #ts-lang-bar {
        display: flex !important;
        align-items: center !important;
        gap: 8px !important;
        padding: 8px 13px !important;
        background: rgba(255,255,255,0.025) !important;
        border-bottom: 1px solid rgba(255,255,255,0.07) !important;
      }
      .ts-lbl {
        font-size: 9px !important;
        font-weight: 700 !important;
        text-transform: uppercase !important;
        letter-spacing: 1px !important;
        color: #3d4d66 !important;
        flex-shrink: 0 !important;
      }
      .ts-dd {
        flex: 1 !important;
        background: rgba(255,255,255,0.08) !important;
        border: 1px solid rgba(255,255,255,0.14) !important;
        border-radius: 8px !important;
        color: #e8ecf5 !important;
        font-size: 12px !important;
        font-weight: 600 !important;
        padding: 6px 9px !important;
        outline: none !important;
        cursor: pointer !important;
        font-family: inherit !important;
        transition: border-color 0.15s !important;
        appearance: auto !important;
      }
      .ts-dd:hover { border-color: rgba(0,229,160,0.4) !important; }
      .ts-dd:focus { border-color: #00e5a0 !important; outline: none !important; }
      .ts-dd option { background: #0d1117 !important; color: #e8ecf5 !important; }
      #ts-swap-btn {
        background: rgba(0,229,160,0.1) !important;
        border: 1px solid rgba(0,229,160,0.28) !important;
        border-radius: 8px !important;
        color: #00e5a0 !important;
        font-size: 15px !important;
        width: 30px !important; height: 30px !important;
        display: flex !important; align-items: center !important; justify-content: center !important;
        cursor: pointer !important;
        flex-shrink: 0 !important;
        transition: all 0.2s !important;
        font-family: inherit !important;
      }
      #ts-swap-btn:hover {
        background: rgba(0,229,160,0.22) !important;
        transform: rotate(180deg) !important;
      }

      /* ── Translation panels ── */
      #ts-panels {
        display: grid !important;
        grid-template-columns: 1fr 1px 1fr !important;
        min-height: 85px !important;
      }
      .ts-panel {
        padding: 11px 14px !important;
        display: flex !important;
        flex-direction: column !important;
        gap: 5px !important;
      }
      #ts-divider { background: rgba(255,255,255,0.06) !important; }
      .ts-panel-lbl {
        font-size: 9px !important;
        font-weight: 700 !important;
        text-transform: uppercase !important;
        letter-spacing: 1.1px !important;
        color: #3d4d66 !important;
      }
      #ts-orig-text {
        font-size: 12px !important;
        line-height: 1.7 !important;
        color: #7e8ba8 !important;
        min-height: 38px !important;
        word-break: break-word !important;
      }
      #ts-tran-text {
        font-size: 16px !important;
        line-height: 1.7 !important;
        color: #e8ecf5 !important;
        font-weight: 700 !important;
        min-height: 38px !important;
        word-break: break-word !important;
      }

      /* ── Footer ── */
      #ts-foot {
        display: flex !important;
        align-items: center !important;
        justify-content: space-between !important;
        padding: 6px 13px !important;
        border-top: 1px solid rgba(255,255,255,0.05) !important;
        background: rgba(0,0,0,0.3) !important;
        border-radius: 0 0 12px 12px !important;
      }
      #ts-status-txt { font-size: 10px !important; color: #3d4d66 !important; }
      #ts-eng {
        font-size: 9px !important;
        font-weight: 700 !important;
        padding: 2px 8px !important;
        border-radius: 20px !important;
        display: none !important;
      }
      #ts-eng.gemini {
        display: inline-block !important;
        background: rgba(0,229,160,0.1) !important;
        color: #00e5a0 !important;
        border: 1px solid rgba(0,229,160,0.25) !important;
      }
      #ts-eng.google {
        display: inline-block !important;
        background: rgba(77,142,245,0.1) !important;
        color: #4d8ef5 !important;
        border: 1px solid rgba(77,142,245,0.25) !important;
      }
      #ts-clock { font-size: 9px !important; color: #3d4d66 !important; }

      /* ── Minimized ── */
      #ts-box.ts-minimized #ts-lang-bar,
      #ts-box.ts-minimized #ts-panels,
      #ts-box.ts-minimized #ts-foot { display: none !important; }
    `;
    document.head.appendChild(style);

    // ── Build HTML using DOM (NO innerHTML with handlers) ──
    const box = document.createElement('div');
    box.id = 'ts-box';

    // Drag bar
    const dragBar = document.createElement('div');
    dragBar.id = 'ts-drag-bar';

    const logo = document.createElement('div');
    logo.id = 'ts-logo';
    const dot = document.createElement('span');
    dot.id = 'ts-dot';
    logo.appendChild(dot);
    logo.appendChild(document.createTextNode(' 🎙 TalkSync'));

    const hint = document.createElement('span');
    hint.id = 'ts-drag-hint';
    hint.textContent = '⠿ DRAG TO MOVE';

    const hdrBtns = document.createElement('div');
    hdrBtns.id = 'ts-hdr-btns';

    const startBtn = document.createElement('button');
    startBtn.id = 'ts-start-btn';
    startBtn.textContent = '▶ Start';

    const minBtn = document.createElement('button');
    minBtn.id = 'ts-min-btn';
    minBtn.textContent = '−';

    hdrBtns.appendChild(startBtn);
    hdrBtns.appendChild(minBtn);
    dragBar.appendChild(logo);
    dragBar.appendChild(hint);
    dragBar.appendChild(hdrBtns);

    // Lang bar
    const langBar = document.createElement('div');
    langBar.id = 'ts-lang-bar';

    const lblFrom = document.createElement('span');
    lblFrom.className = 'ts-lbl';
    lblFrom.textContent = 'From';

    const srcSel = document.createElement('select');
    srcSel.id = 'ts-src-dd';
    srcSel.className = 'ts-dd';

    const swapBtn = document.createElement('button');
    swapBtn.id = 'ts-swap-btn';
    swapBtn.textContent = '⇄';

    const lblTo = document.createElement('span');
    lblTo.className = 'ts-lbl';
    lblTo.textContent = 'To';

    const tgtSel = document.createElement('select');
    tgtSel.id = 'ts-tgt-dd';
    tgtSel.className = 'ts-dd';

    // Populate dropdowns
    Object.entries(LANG_NAMES).forEach(([val, label]) => {
      const o1 = document.createElement('option');
      o1.value = val; o1.textContent = label;
      srcSel.appendChild(o1);

      const o2 = document.createElement('option');
      o2.value = val; o2.textContent = label;
      tgtSel.appendChild(o2);
    });

    srcSel.value = cfg.srcLang || 'en';
    tgtSel.value = cfg.tgtLang || 'hi';

    langBar.appendChild(lblFrom);
    langBar.appendChild(srcSel);
    langBar.appendChild(swapBtn);
    langBar.appendChild(lblTo);
    langBar.appendChild(tgtSel);

    // Panels
    const panels = document.createElement('div');
    panels.id = 'ts-panels';

    const leftPanel = document.createElement('div');
    leftPanel.className = 'ts-panel';
    const leftLbl = document.createElement('div');
    leftLbl.className = 'ts-panel-lbl';
    leftLbl.textContent = '🎤 Original';
    const origText = document.createElement('div');
    origText.id = 'ts-orig-text';
    origText.textContent = 'Press ▶ Start to begin…';
    leftPanel.appendChild(leftLbl);
    leftPanel.appendChild(origText);

    const divider = document.createElement('div');
    divider.id = 'ts-divider';

    const rightPanel = document.createElement('div');
    rightPanel.className = 'ts-panel';
    const rightLbl = document.createElement('div');
    rightLbl.className = 'ts-panel-lbl';
    rightLbl.textContent = '🌐 Translation';
    const tranText = document.createElement('div');
    tranText.id = 'ts-tran-text';
    tranText.textContent = '—';
    rightPanel.appendChild(rightLbl);
    rightPanel.appendChild(tranText);

    panels.appendChild(leftPanel);
    panels.appendChild(divider);
    panels.appendChild(rightPanel);

    // Footer
    const foot = document.createElement('div');
    foot.id = 'ts-foot';
    const statusTxt = document.createElement('span');
    statusTxt.id = 'ts-status-txt';
    statusTxt.textContent = 'Ready';
    const eng = document.createElement('span');
    eng.id = 'ts-eng';
    const clock = document.createElement('span');
    clock.id = 'ts-clock';
    foot.appendChild(statusTxt);
    foot.appendChild(eng);
    foot.appendChild(clock);

    // Assemble
    box.appendChild(dragBar);
    box.appendChild(langBar);
    box.appendChild(panels);
    box.appendChild(foot);
    document.body.appendChild(box);

    // ── Wire ALL events via addEventListener (CSP-safe) ──

    startBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      isRunning ? stopRec() : startRec();
    });

    minBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isMin = box.classList.toggle('ts-minimized');
      minBtn.textContent = isMin ? '+' : '−';
    });

    srcSel.addEventListener('change', (e) => {
      e.stopPropagation();
      cfg.srcLang = srcSel.value;
      chrome.storage.sync.set({ srcLang: cfg.srcLang });
      setStatus('From: ' + LANG_NAMES[cfg.srcLang]);
      if (isRunning) { stopRec(); setTimeout(startRec, 250); }
    });

    tgtSel.addEventListener('change', (e) => {
      e.stopPropagation();
      cfg.tgtLang = tgtSel.value;
      chrome.storage.sync.set({ tgtLang: cfg.tgtLang });
      setStatus('To: ' + LANG_NAMES[cfg.tgtLang]);
    });

    swapBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const tmp = srcSel.value;
      srcSel.value = tgtSel.value;
      tgtSel.value = tmp;
      cfg.srcLang = srcSel.value;
      cfg.tgtLang = tgtSel.value;
      chrome.storage.sync.set({ srcLang: cfg.srcLang, tgtLang: cfg.tgtLang });
      setStatus('Swapped ↔ ' + LANG_NAMES[cfg.srcLang] + ' → ' + LANG_NAMES[cfg.tgtLang]);
      if (isRunning) { stopRec(); setTimeout(startRec, 250); }
    });

    // ── Drag (pixel-based, no transform conflict) ────────
    let dragging = false;
    let startMX, startMY, startBX, startBY;

    dragBar.addEventListener('mousedown', (e) => {
      const tag = e.target.tagName;
      if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'OPTION') return;
      dragging = true;

      const r = box.getBoundingClientRect();
      startBX = r.left;
      startBY = r.top;
      startMX = e.clientX;
      startMY = e.clientY;

      // Switch from transform centering to pixel positioning
      box.style.left      = startBX + 'px';
      box.style.top       = startBY + 'px';
      box.style.transform = 'none';

      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      let nx = startBX + (e.clientX - startMX);
      let ny = startBY + (e.clientY - startMY);
      // Keep inside viewport
      nx = Math.max(0, Math.min(window.innerWidth  - (box.offsetWidth  || 500), nx));
      ny = Math.max(0, Math.min(window.innerHeight - (box.offsetHeight || 180), ny));
      box.style.left = nx + 'px';
      box.style.top  = ny + 'px';
    });

    document.addEventListener('mouseup', () => { dragging = false; });
  }

  function syncDropdowns() {
    const s = document.getElementById('ts-src-dd');
    const t = document.getElementById('ts-tgt-dd');
    if (s && cfg.srcLang) s.value = cfg.srcLang;
    if (t && cfg.tgtLang) t.value = cfg.tgtLang;
  }

  // ═══════════════════════════════════════════════════
  //  SPEECH RECOGNITION
  // ═══════════════════════════════════════════════════
  function startRec() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setStatus('❌ Chrome required'); return; }

    isRunning = true;
    setStatus('🎙️ Listening…');
    const dot = document.getElementById('ts-dot');
    if (dot) dot.className = 'live';
    const btn = document.getElementById('ts-start-btn');
    if (btn) { btn.textContent = '⏹ Stop'; btn.className = 'live'; }

    recognition = new SR();
    recognition.lang            = SPEECH_LANG[cfg.srcLang] || 'en-US';
    recognition.continuous      = true;
    recognition.interimResults  = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (ev) => {
      let interim = '', final = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript;
        ev.results[i].isFinal ? (final += t) : (interim += t);
      }
      const el = document.getElementById('ts-orig-text');
      if (!el) return;
      if (final) {
        el.textContent = final;
        clearTimeout(debTimer);
        triggerTrans(final.trim());
      } else if (interim) {
        el.textContent = interim + '…';
        if (interim.trim().split(' ').length >= 4) {
          clearTimeout(debTimer);
          debTimer = setTimeout(() => triggerTrans(interim.trim()), 900);
        }
      }
    };

    recognition.onerror = (e) => {
      if (['no-speech', 'aborted'].includes(e.error)) return;
      setStatus('⚠️ ' + e.error);
    };
    recognition.onend = () => {
      if (isRunning) setTimeout(() => { try { recognition.start(); } catch(e) {} }, 300);
    };
    recognition.start();
  }

  function stopRec() {
    isRunning = false;
    clearTimeout(debTimer);
    recognition?.stop();
    const dot = document.getElementById('ts-dot');
    if (dot) dot.className = '';
    const btn = document.getElementById('ts-start-btn');
    if (btn) { btn.textContent = '▶ Start'; btn.className = ''; }
    setStatus('Stopped');
  }

  // ═══════════════════════════════════════════════════
  //  TRANSLATION
  // ═══════════════════════════════════════════════════
  async function triggerTrans(text) {
    if (isTranslating) { pendingText = text; return; }
    await runTrans(text);
    if (pendingText) { const n = pendingText; pendingText = null; await runTrans(n); }
  }

  async function runTrans(text) {
    isTranslating = true;
    setStatus('⚡ Translating…');
    const tranEl = document.getElementById('ts-tran-text');
    if (tranEl) tranEl.textContent = '…';

    const src = cfg.srcLang, tgt = cfg.tgtLang;
    let result = null, engine = '';

    if (cfg.geminiApiKey && cfg.geminiApiKey.startsWith('AIza')) {
      try { result = await callGemini(text, src, tgt); engine = 'gemini'; }
      catch (e) { console.warn('[TalkSync] Gemini:', e.message); }
    }
    if (!result) {
      try { result = await callGoogle(text, src, tgt); engine = 'google'; }
      catch (e) { console.warn('[TalkSync] Google:', e.message); }
    }

    if (result) {
      if (tranEl) tranEl.textContent = result;
      const engEl = document.getElementById('ts-eng');
      if (engEl) {
        engEl.textContent = engine === 'gemini' ? '✨ Gemini' : '🌐 Google';
        engEl.className   = engine;
      }
      const clk = document.getElementById('ts-clock');
      if (clk) clk.textContent = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
      if (cfg.autoSpeak) {
        const u = new SpeechSynthesisUtterance(result);
        u.lang = SPEECH_LANG[tgt] || 'hi-IN'; u.rate = 0.95;
        speechSynthesis.speak(u);
      }
      try { chrome.runtime.sendMessage({ type: 'TRANSLATION', original: text, translated: result, engine }); } catch(e) {}
    } else {
      if (tranEl) tranEl.textContent = '⚠️ Translation failed';
    }

    setStatus('🎙️ Listening…');
    isTranslating = false;
  }

  async function callGemini(text, src, tgt) {
    const prompt = `Translate this ${LANG_NAMES[src]||src} text to ${LANG_NAMES[tgt]||tgt}. Return ONLY the translated text, nothing else.\n\nText: ${text}`;
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${cfg.geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 512 }
        }),
        signal: AbortSignal.timeout(9000)
      }
    );
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d?.error?.message || `HTTP ${res.status}`);
    }
    const d = await res.json();
    const out = d?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!out) throw new Error('Empty response');
    return out;
  }

  async function callGoogle(text, src, tgt) {
    const sl = G_CODES[src] || src;
    const tl = G_CODES[tgt] || tgt;
    const res = await fetch(
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`,
      { signal: AbortSignal.timeout(7000) }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    return d[0].map(c => c[0]).filter(Boolean).join('');
  }

  function setStatus(msg) {
    const el = document.getElementById('ts-status-txt');
    if (el) el.textContent = msg;
  }

})();