#!/usr/bin/env python3
"""
ALO Learning Journey — local Piper TTS daemon (bn_BD + en_US, $0 per request).

Why this exists
---------------
`src/lib/local-audio.ts` already calls a small HTTP contract when
`PIPER_BASE_URL` is set:

    POST /synthesize  { text, voice, speed }
    -> audio/wav bytes  (or {"audio_base64": "…"})

Nothing in the repo served that contract, so `PIPER_BASE_URL` sat empty and every
request fell through to `espeak` — which is robotic. This daemon fills the gap
with Piper voices the owner downloads once, so Bangla sounds natural and no
cloud TTS is ever used.

Voices (free, .onnx + .onnx.json from rhasspy/piper-voices)
----------------------------------------------------------
    bn_BD-google-medium      — Bangla, ~63 MB, the default here
    en_US-lessac-medium      — English, ~63 MB
Download:
    python3 scripts/services/piper_server.py --list-voices   # URLs to fetch
    # or let it download on first use:
    PIPER_SERVICE_MODEL_DIR=/opt/alo/models/piper \
      python3 scripts/services/piper_server.py --download bn_BD-google-medium

Run
---
    # pip install piper-tts   (or place the `piper` binary on PATH)
    python3 scripts/services/piper_server.py --port 8788 \
        --model-dir /opt/alo/models/piper \
        --preload bn_BD-google-medium,en_US-lessac-medium

Then `.env`:  PIPER_BASE_URL=http://127.0.0.1:8788

Hard rules
----------
  - Bind 127.0.0.1 only; this process has no auth.
  - If Piper or the voice is missing, answer 503 with the reason — never a
    silent success with empty audio (the Node side then falls back to espeak,
    which is honest because espeak really did speak).
  - Cap the text (default 5,000 chars) exactly like the Node side does.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.request
from pathlib import Path

MAX_TEXT = int(os.environ.get("PIPER_MAX_TEXT", "5000"))
VOICES = {
    "bn_BD-google-medium": (
        "bn",
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/bn/bn_BD/google/medium/bn_BD-google-medium.onnx",
    ),
    "en_US-lessac-medium": (
        "en",
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx",
    ),
}

_LOCK = threading.Lock()


def log(message: str) -> None:
    print(f"[piper] {message}", flush=True)


def piper_binary() -> str | None:
    """The `piper` CLI, from PATH or from the same venv the daemon runs in."""
    found = os.environ.get("PIPER_BIN") or shutil.which("piper")
    if found and Path(found).exists():
        return found
    sibling = Path(sys.executable).parent / "piper"
    if sibling.exists():
        return str(sibling)
    return None


def download_voice(name: str, model_dir: Path) -> Path:
    if name not in VOICES:
        raise ValueError(f"unknown voice {name}")
    model_dir.mkdir(parents=True, exist_ok=True)
    _, url = VOICES[name]
    target = model_dir / f"{name}.onnx"
    config = model_dir / f"{name}.onnx.json"
    if target.exists() and config.exists():
        return target
    log(f"downloading {name} → {target} (one time, ~63 MB)")
    urllib.request.urlretrieve(url, target)  # noqa: S310 - fixed https URL from VOICES
    urllib.request.urlretrieve(url + ".json", config)  # noqa: S310
    return target


def synthesize(text: str, voice: str, speed: float, model_dir: Path) -> bytes:
    binary = piper_binary()
    if not binary:
        raise RuntimeError("piper binary not found — pip install piper-tts (or set PIPER_BIN)")
    model = download_voice(voice, model_dir)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
        out = handle.name
    try:
        with _LOCK:  # piper is CPU-bound; one synthesis at a time on a small box
            proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
                [binary, "--model", str(model), "--output_file", out, "--length_scale", f"{1.0 / max(0.25, min(4.0, speed)):.3f}"],
                input=text.encode("utf-8"),
                capture_output=True,
                timeout=120,
                check=False,
            )
        if proc.returncode != 0:
            raise RuntimeError(f"piper failed: {proc.stderr.decode('utf-8', 'replace')[:200]}")
        data = Path(out).read_bytes()
        if len(data) < 44:
            raise RuntimeError("piper produced no audio")
        return data
    finally:
        try:
            os.unlink(out)
        except OSError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser(description="Local Piper TTS daemon")
    parser.add_argument("--host", default=os.environ.get("PIPER_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PIPER_PORT", "8788")))
    parser.add_argument("--model-dir", default=os.environ.get("PIPER_SERVICE_MODEL_DIR", "/opt/alo/models/piper"))
    parser.add_argument("--preload", default=os.environ.get("PIPER_SERVICE_PRELOAD", "bn_BD-google-medium,en_US-lessac-medium"))
    parser.add_argument("--download", default=None, help="download one voice and exit")
    parser.add_argument("--list-voices", action="store_true")
    args = parser.parse_args()
    model_dir = Path(args.model_dir)

    if args.list_voices:
        for name, (lang, url) in VOICES.items():
            print(f"{name:26} {lang:3} {url}")
        return 0
    if args.download:
        print(download_voice(args.download, model_dir))
        return 0

    preload = [v.strip() for v in args.preload.split(",") if v.strip()]
    have_binary = piper_binary()
    if have_binary:
        for voice in preload:
            try:
                download_voice(voice, model_dir)
            except Exception as exc:  # network or disk — report, do not crash
                log(f"preload {voice} skipped: {exc}")
    else:
        log("piper binary not found yet — /synthesize will answer 503 until it is installed")

    try:
        from fastapi import FastAPI, HTTPException  # type: ignore
        from fastapi.responses import Response  # type: ignore
        from pydantic import BaseModel  # type: ignore
        import uvicorn  # type: ignore
    except Exception:
        return serve_stdlib(args, model_dir, preload)

    app = FastAPI(title="ALO local Piper TTS", version="1.0.0")

    class Body(BaseModel):
        text: str
        voice: str = "bn_BD-google-medium"
        speed: float = 1.0

    @app.get("/health")
    def health() -> dict:
        return {
            "ok": bool(have_binary),
            "binary": have_binary,
            "modelDir": str(model_dir),
            "voices": {n: (model_dir / f"{n}.onnx").exists() for n in VOICES},
            "paid": False,
            "usdPerRequest": 0,
        }

    @app.post("/synthesize")
    def synth(body: Body) -> Response:
        if not body.text.strip():
            raise HTTPException(status_code=400, detail="text is required")
        if len(body.text) > MAX_TEXT:
            raise HTTPException(status_code=413, detail=f"text exceeds {MAX_TEXT} characters")
        try:
            audio = synthesize(body.text, body.voice, body.speed, model_dir)
        except Exception as exc:
            raise HTTPException(status_code=503, detail=str(exc)[:300])
        return Response(content=audio, media_type="audio/wav")

    log(f"listening on http://{args.host}:{args.port} (model dir {model_dir})")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    return 0


def serve_stdlib(args, model_dir: Path, preload: list[str]) -> int:  # pragma: no cover
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _json(self, code: int, payload: dict) -> None:
            body = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            if self.path.split("?")[0] != "/health":
                return self._json(404, {"error": "not found"})
            self._json(
                200,
                {
                    "ok": bool(piper_binary()),
                    "binary": piper_binary(),
                    "modelDir": str(model_dir),
                    "voices": {n: (model_dir / f"{n}.onnx").exists() for n in VOICES},
                    "paid": False,
                    "usdPerRequest": 0,
                    "note": "FastAPI not installed; this stdlib server only reports health",
                },
            )

        def do_POST(self) -> None:  # noqa: N802
            if self.path.split("?")[0] != "/synthesize":
                return self._json(404, {"error": "not found"})
            length = int(self.headers.get("content-length") or 0)
            self.rfile.read(length)
            self._json(501, {"detail": "install fastapi + uvicorn to synthesize"})

        def log_message(self, *_a) -> None:
            return

    log("fastapi/uvicorn not found — stdlib health-only mode. pip install fastapi uvicorn")
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
