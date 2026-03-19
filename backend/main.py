"""
TalkSync Backend — FastAPI + Gemini + Google Translate fallback
Run: uvicorn main:app --reload --port 8000
"""

import os
import json
import asyncio
import httpx
import logging
from datetime import datetime
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from dotenv import load_dotenv

# ── Optional Gemini SDK ───────────────────────────────────────
try:
    import google.generativeai as genai
    GEMINI_SDK = True
except ImportError:
    GEMINI_SDK = False

load_dotenv()

# ── Logging ───────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger("talksync")

# ── Config ────────────────────────────────────────────────────
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_MODEL   = "gemini-1.5-flash"

LANG_NAMES = {
    "en":"English",   "hi":"Hindi",    "pa":"Punjabi",  "ur":"Urdu",
    "bn":"Bengali",   "te":"Telugu",   "ta":"Tamil",    "es":"Spanish",
    "fr":"French",    "de":"German",   "ar":"Arabic",   "zh":"Chinese",
    "ja":"Japanese",  "ko":"Korean",   "ru":"Russian",  "pt":"Portuguese",
}
G_CODES = {
    "en":"en","hi":"hi","pa":"pa","ur":"ur","bn":"bn","te":"te",
    "ta":"ta","es":"es","fr":"fr","de":"de","ar":"ar","zh":"zh-CN",
    "ja":"ja","ko":"ko","ru":"ru","pt":"pt",
}

# ── App ───────────────────────────────────────────────────────
app = FastAPI(title="TalkSync API", version="3.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")
if os.path.exists(FRONTEND_DIR):
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

# ── Models ────────────────────────────────────────────────────
class TranslateRequest(BaseModel):
    text: str
    source_lang: str = "en"
    target_lang: str = "hi"
    api_key: Optional[str] = None
    glossary: Optional[dict] = None
    context: Optional[str] = None

class TranslateResponse(BaseModel):
    original_text: str
    translated_text: str
    source_lang: str
    target_lang: str
    engine: str
    timestamp: str

class ValidateKeyRequest(BaseModel):
    api_key: str

session_transcript: list[dict] = []

# ── WebSocket Manager ─────────────────────────────────────────
class WSManager:
    def __init__(self):
        self.connections: list[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.connections.append(ws)

    def disconnect(self, ws: WebSocket):
        if ws in self.connections:
            self.connections.remove(ws)

    async def broadcast(self, data: dict):
        msg = json.dumps(data)
        dead = []
        for ws in self.connections:
            try:
                await ws.send_text(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.connections.remove(ws)

ws_manager = WSManager()

# ═══════════════════════════════════════════════════════════════
#  TRANSLATION ENGINES
# ═══════════════════════════════════════════════════════════════

async def translate_gemini(text: str, src: str, tgt: str,
                            key: str, glossary: dict = None,
                            context: str = "") -> str:
    if not GEMINI_SDK:
        raise RuntimeError("google-generativeai not installed")
    if not key:
        raise RuntimeError("No API key")

    genai.configure(api_key=key)
    model = genai.GenerativeModel(GEMINI_MODEL)

    gloss_text = ""
    if glossary:
        gloss_text = "\nGlossary:\n" + "\n".join(
            f"  {k} → {v}" for k, v in glossary.items()
        )
    ctx_text = f"\nContext: {context}" if context else ""

    prompt = (
        f"Translate the following {LANG_NAMES.get(src, src)} text "
        f"to {LANG_NAMES.get(tgt, tgt)}.\n"
        f"Return ONLY the translated text — no explanations, no labels.\n"
        f"{ctx_text}{gloss_text}\n\nText:\n{text}"
    )

    response = await asyncio.to_thread(model.generate_content, prompt)
    result = response.text.strip()
    if not result:
        raise RuntimeError("Empty Gemini response")
    return result


async def translate_google(text: str, src: str, tgt: str) -> str:
    sl = G_CODES.get(src, src)
    tl = G_CODES.get(tgt, tgt)
    params = {"client": "gtx", "sl": sl, "tl": tl, "dt": "t", "q": text}
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(
            "https://translate.googleapis.com/translate_a/single",
            params=params
        )
    r.raise_for_status()
    data = r.json()
    return "".join(chunk[0] for chunk in data[0] if chunk[0])


async def run_translation(text: str, src: str, tgt: str,
                           key: str = "", glossary: dict = None,
                           context: str = "") -> tuple[str, str]:
    """
    Returns (translated_text, engine)
    Priority: Gemini → Google Translate
    """
    # Try Gemini first if any key is available
    effective_key = (key or GEMINI_API_KEY or "").strip()
    if effective_key:
        try:
            result = await translate_gemini(text, src, tgt, effective_key, glossary, context)
            log.info(f"[Gemini] {src}→{tgt}: {text[:40]}...")
            return result, "gemini"
        except Exception as e:
            log.warning(f"[Gemini] Failed: {e} — trying Google Translate")

    # Always fall back to Google Translate
    try:
        result = await translate_google(text, src, tgt)
        log.info(f"[Google] {src}→{tgt}: {text[:40]}...")
        return result, "google"
    except Exception as e:
        log.error(f"[Google] Failed: {e}")
        raise RuntimeError(f"All engines failed: {e}")


# ═══════════════════════════════════════════════════════════════
#  ROUTES
# ═══════════════════════════════════════════════════════════════

@app.get("/")
async def root():
    index = os.path.join(FRONTEND_DIR, "index.html")
    if os.path.exists(index):
        return FileResponse(index)
    return {"status": "TalkSync API v3 running", "docs": "/docs"}


@app.get("/health")
async def health():
    return {
        "status":            "ok",
        "gemini_configured": bool(GEMINI_API_KEY),
        "gemini_sdk":        GEMINI_SDK,
        "fallback":          "google_translate",
        "version":           "3.0.0",
        "timestamp":         datetime.utcnow().isoformat(),
    }


@app.post("/validate-key")
async def validate_key(req: ValidateKeyRequest):
    if not req.api_key.strip().startswith("AIza"):
        raise HTTPException(status_code=400, detail="Invalid key — must start with AIza")
    try:
        if GEMINI_SDK:
            genai.configure(api_key=req.api_key)
            model = genai.GenerativeModel(GEMINI_MODEL)
            await asyncio.to_thread(model.generate_content, "Say ok")
        return {"valid": True, "model": GEMINI_MODEL}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/translate", response_model=TranslateResponse)
async def translate_endpoint(req: TranslateRequest):
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    if req.source_lang == req.target_lang:
        return TranslateResponse(
            original_text=text, translated_text=text,
            source_lang=req.source_lang, target_lang=req.target_lang,
            engine="none", timestamp=datetime.utcnow().isoformat()
        )

    try:
        translated, engine = await run_translation(
            text     = text,
            src      = req.source_lang,
            tgt      = req.target_lang,
            key      = (req.api_key or "").strip(),
            glossary = req.glossary or {},
            context  = req.context or "",
        )
    except Exception as e:
        log.error(f"Translation failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

    entry = {
        "original":    text,
        "translated":  translated,
        "source_lang": req.source_lang,
        "target_lang": req.target_lang,
        "engine":      engine,
        "timestamp":   datetime.utcnow().isoformat(),
    }
    session_transcript.append(entry)
    await ws_manager.broadcast({"event": "translation", **entry})

    return TranslateResponse(
        original_text  = text,
        translated_text= translated,
        source_lang    = req.source_lang,
        target_lang    = req.target_lang,
        engine         = engine,
        timestamp      = entry["timestamp"],
    )


@app.get("/transcript")
async def get_transcript():
    return {"entries": session_transcript, "count": len(session_transcript)}


@app.delete("/transcript")
async def clear_transcript():
    session_transcript.clear()
    return {"message": "Transcript cleared"}


@app.get("/languages")
async def get_languages():
    return {"languages": LANG_NAMES}


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws_manager.connect(ws)
    await ws.send_text(json.dumps({"event": "connected", "message": "TalkSync ready"}))
    try:
        while True:
            raw = await ws.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_text(json.dumps({"event": "error", "message": "Invalid JSON"}))
                continue

            text = data.get("text", "").strip()
            src  = data.get("source_lang", "en")
            tgt  = data.get("target_lang", "hi")
            key  = data.get("api_key", "")

            if not text:
                continue

            await ws.send_text(json.dumps({"event": "translating", "original": text}))
            try:
                translated, engine = await run_translation(text, src, tgt, key)
                result = {
                    "event": "translation", "original": text,
                    "translated": translated, "source_lang": src,
                    "target_lang": tgt, "engine": engine,
                    "timestamp": datetime.utcnow().isoformat(),
                }
                session_transcript.append({k: v for k, v in result.items() if k != "event"})
                await ws.send_text(json.dumps(result))
                await ws_manager.broadcast(result)
            except Exception as e:
                await ws.send_text(json.dumps({"event": "error", "message": str(e)}))

    except WebSocketDisconnect:
        ws_manager.disconnect(ws)


@app.on_event("startup")
async def startup():
    print("\n" + "="*52)
    print("  🎙  TalkSync API v3.0")
    print("="*52)
    print(f"  Gemini key : {'✅ Set in .env' if GEMINI_API_KEY else '⚠️  Not set'}")
    print(f"  Gemini SDK : {'✅ Installed' if GEMINI_SDK else '❌ pip install google-generativeai'}")
    print(f"  Fallback   : ✅ Google Translate (free, always works)")
    print(f"  Docs       : http://localhost:8000/docs")
    print("="*52 + "\n")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)