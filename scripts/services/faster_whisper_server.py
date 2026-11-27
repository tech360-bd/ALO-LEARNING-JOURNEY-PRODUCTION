#!/usr/bin/env python3
"""
ALO Learning Journey — local faster-whisper ASR daemon (CPU int8, $0 per request).

Why this exists
---------------
`/api/asr-transcribe` and `/api/v1/asr` already speak ONE local protocol:

    POST /transcribe   { audio_base64 | audio_url, language, prompt, enable_diarization }
    ->  { text, segments, duration_sec, language }

This script is that server, running on the owner's own box. No cloud, no key, no
per-minute charge: `faster-whisper` decodes locally (CTranslate2, `int8` on CPU),
which is accurate enough for Bangla and English classroom audio and needs no GPU.

Run
---
    pip install "faster-whisper==1.0.3" fastapi uvicorn
    python scripts/services/faster_whisper_server.py --port 8787 --model medium --language bn

Then in `.env` (or the Super Admin Config panel):

    FASTER_WHISPER_URL=http://127.0.0.1:8787

Model notes (all free, downloaded once from Hugging Face):
    tiny/base/small/medium  — CPU-friendly; `medium` is the practical Bangla choice
    large-v3                — best accuracy, needs ~4 GB RAM and is ~4x slower on CPU
`--model small` on a 2-vCPU box transcribes roughly 1x realtime; `medium` ~0.4x.
Start with `small`, measure, then move up.

Hard rules kept from the rest of the repo
-----------------------------------------
  - Bind to 127.0.0.1 only. This process has no auth (it is a private speaker
    model server); exposing it would let anyone on the network burn CPU.
  - Refuse an `audio_url` that is not http(s) — the same SSRF posture as the web
    side. If the box later needs to block private ranges, do it here too.
  - Cap the upload (default 25 MB) so one request cannot exhaust memory.
  - Report `simulated: false` only when a real transcription happened. When the
    model is not installed yet, health says so instead of inventing text.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import io
import json
import os
import sys
import tempfile
import time
import urllib.parse
import urllib.request

MAX_BYTES = int(os.environ.get("WHISPER_MAX_BYTES", str(25 * 1024 * 1024)))
ALLOWED_LANGS = {"bn", "bn-BD", "en", "en-US", "auto"}


def log(message: str) -> None:
    print(f"[faster-whisper] {message}", flush=True)


# ── Model ────────────────────────────────────────────────────────────────────
class Transcriber:
    """Holds the loaded model so a request never pays the load cost twice."""

    def __init__(self, model_name: str, device: str, compute_type: str) -> None:
        self.model_name = model_name
        self.device = device
        self.compute_type = compute_type
        self.model = None
        self.load_error: str | None = None
        self.loaded_at: float | None = None

    def load(self) -> None:
        try:
            from faster_whisper import WhisperModel  # type: ignore
        except Exception as exc:  # pragma: no cover - depends on the box
            self.load_error = (
                "faster-whisper is not installed "
                f"({exc.__class__.__name__}). Run: pip install \"faster-whisper==1.0.3\""
            )
            log(self.load_error)
            return
        try:
            started = time.time()
            self.model = WhisperModel(self.model_name, device=self.device, compute_type=self.compute_type)
            self.loaded_at = time.time()
            log(f"model {self.model_name!r} loaded on {self.device}/{self.compute_type} in {self.loaded_at - started:.1f}s")
        except Exception as exc:  # pragma: no cover
            self.load_error = f"model load failed: {exc}"
            log(self.load_error)

    def ready(self) -> bool:
        return self.model is not None

    def transcribe(self, audio_path: str, language: str, prompt: str | None) -> dict:
        assert self.model is not None
        started = time.time()
        lang = None if language in ("auto", "") else language.split("-")[0]
        segments, info = self.model.transcribe(
            audio_path,
            language=lang,
            beam_size=5,
            vad_filter=True,           # skip silence: classroom audio has long pauses
            vad_parameters={"min_silence_duration_ms": 500},
            initial_prompt=prompt,     # lets the caller bias proper nouns (e.g. "ALO", student names)
        )
        rows = []
        texts = []
        for seg in segments:
            texts.append(seg.text)
            rows.append(
                {
                    "start": round(float(seg.start), 2),
                    "end": round(float(seg.end), 2),
                    "text": seg.text.strip(),
                }
            )
        return {
            "text": "".join(texts).strip(),
            "segments": rows,
            "duration_sec": round(float(getattr(info, "duration", 0.0) or 0.0), 2),
            "language": getattr(info, "language", language),
            "processing_sec": round(time.time() - started, 2),
        }


TRANSCRIBER = Transcriber("medium", "cpu", "int8")


# ── Audio acquisition ────────────────────────────────────────────────────────
def write_bytes(data: bytes) -> str:
    handle = tempfile.NamedTemporaryFile(prefix="alo-asr-", suffix=".audio", delete=False)
    handle.write(data)
    handle.close()
    return handle.name


def fetch_url(url: str) -> bytes:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("audio_url must be http(s)")
    request = urllib.request.Request(url, headers={"User-Agent": "ALO-ASR/1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310 - scheme checked above
        data = response.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError(f"audio larger than {MAX_BYTES} bytes")
    return data


# ── HTTP (stdlib only, so it runs before pip finishes) ───────────────────────
def main() -> int:
    parser = argparse.ArgumentParser(description="Local faster-whisper ASR daemon")
    parser.add_argument("--host", default=os.environ.get("WHISPER_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("WHISPER_PORT", "8787")))
    parser.add_argument("--model", default=os.environ.get("WHISPER_MODEL", "medium"))
    parser.add_argument("--device", default=os.environ.get("WHISPER_DEVICE", "cpu"))
    parser.add_argument("--compute-type", default=os.environ.get("WHISPER_COMPUTE_TYPE", "int8"))
    parser.add_argument("--language", default=os.environ.get("WHISPER_LANGUAGE", "bn"))
    parser.add_argument("--no-load", action="store_true", help="serve /health only (smoke test)")
    args = parser.parse_args()

    globals()["TRANSCRIBER"] = Transcriber(args.model, args.device, args.compute_type)
    if not args.no_load:
        TRANSCRIBER.load()

    try:
        from fastapi import FastAPI, HTTPException  # type: ignore
        from pydantic import BaseModel  # type: ignore
        import uvicorn  # type: ignore
    except Exception:
        return serve_stdlib(args)

    app = FastAPI(title="ALO local faster-whisper", version="1.0.0")

    class TranscribeBody(BaseModel):
        audio_base64: str | None = None
        audio_url: str | None = None
        language: str | None = None
        prompt: str | None = None
        enable_diarization: bool = False

    @app.get("/health")
    def health() -> dict:
        return {
            "ok": TRANSCRIBER.ready(),
            "model": TRANSCRIBER.model_name,
            "device": TRANSCRIBER.device,
            "compute_type": TRANSCRIBER.compute_type,
            "error": TRANSCRIBER.load_error,
            "paid": False,
            "usdPerMinute": 0,
        }

    @app.post("/transcribe")
    def transcribe(body: TranscribeBody) -> dict:
        if not TRANSCRIBER.ready():
            raise HTTPException(status_code=503, detail=TRANSCRIBER.load_error or "model not loaded")
        language = body.language or args.language
        if language not in ALLOWED_LANGS:
            raise HTTPException(status_code=400, detail=f"unsupported language {language}")
        path = None
        try:
            if body.audio_base64:
                try:
                    raw = base64.b64decode(body.audio_base64.split(",")[-1], validate=True)
                except (binascii.Error, ValueError):
                    raise HTTPException(status_code=400, detail="audio_base64 is not valid base64")
                if len(raw) > MAX_BYTES:
                    raise HTTPException(status_code=413, detail="audio too large")
                path = write_bytes(raw)
            elif body.audio_url:
                try:
                    path = write_bytes(fetch_url(body.audio_url))
                except ValueError as exc:
                    raise HTTPException(status_code=400, detail=str(exc))
            else:
                raise HTTPException(status_code=400, detail="audio_base64 or audio_url is required")
            result = TRANSCRIBER.transcribe(path, language, body.prompt)
            result.update({"provider": "faster-whisper", "model_id": TRANSCRIBER.model_name, "simulated": False, "paid": False})
            return result
        finally:
            if path:
                try:
                    os.unlink(path)
                except OSError:
                    pass

    log(f"listening on http://{args.host}:{args.port} (model={args.model})")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    return 0


def serve_stdlib(args) -> int:  # pragma: no cover - exercised only without FastAPI
    """Zero-dependency fallback so the service can be smoke-tested before pip."""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _send(self, code: int, payload: dict) -> None:
            body = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            if self.path.split("?")[0] != "/health":
                return self._send(404, {"error": "not found"})
            self._send(
                200,
                {
                    "ok": TRANSCRIBER.ready(),
                    "model": TRANSCRIBER.model_name,
                    "error": TRANSCRIBER.load_error,
                    "paid": False,
                    "usdPerMinute": 0,
                    "note": "FastAPI not installed; this stdlib server only reports health",
                },
            )

        def do_POST(self) -> None:  # noqa: N802
            if self.path.split("?")[0] != "/transcribe":
                return self._send(404, {"error": "not found"})
            length = int(self.headers.get("content-length") or 0)
            self.rfile.read(length)
            if not TRANSCRIBER.ready():
                return self._send(503, {"detail": TRANSCRIBER.load_error or "model not loaded"})
            self._send(501, {"detail": "install fastapi + uvicorn to transcribe"})

        def log_message(self, *_args) -> None:  # keep the daemon log clean
            return

    log(
        "fastapi/uvicorn not found — running the stdlib health-only server. "
        "Install with: pip install fastapi uvicorn"
    )
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
