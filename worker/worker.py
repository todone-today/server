"""todone's transcriber: turns Ask todone recordings into words, on a machine you run (an Apple Silicon Mac).

It only connects out: it asks the server for the next recording, transcribes it with Whisper (MLX), sends the words
back, and deletes its copy. The server never connects to it. Settings come from the environment:

  TODONE_URL       the web app's address, e.g. https://todone.today
  AI_WORKER_TOKEN  the same long random token the server has
  WHISPER_MODEL    optional, default mlx-community/whisper-large-v3-turbo
"""

import base64
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request

import mlx_whisper

URL = os.environ["TODONE_URL"].rstrip("/") + "/api/ai/worker"
TOKEN = os.environ["AI_WORKER_TOKEN"]
MODEL = os.environ.get("WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")
EXT = {"audio/webm": ".webm", "audio/ogg": ".ogg", "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/mpeg": ".mp3", "audio/wav": ".wav"}


def call(path, body=None):
    req = urllib.request.Request(
        URL + path,
        data=json.dumps(body or {}).encode(),
        method="POST",
        headers={"authorization": f"Bearer {TOKEN}", "content-type": "application/json", "user-agent": "todone-worker"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"null") if r.status == 200 else None


def transcribe(job):
    with tempfile.NamedTemporaryFile(suffix=EXT.get(job["type"], ".webm")) as f:
        f.write(base64.b64decode(job["audio"]))
        f.flush()
        # Language detected per recording: Hindi stays Hindi, English stays English, nothing is translated.
        r = mlx_whisper.transcribe(f.name, path_or_hf_repo=MODEL, condition_on_previous_text=False)
    return r["text"].strip(), r.get("language")


def main():
    print(f"todone transcriber: {MODEL}, polling {URL}", flush=True)
    idle = 2
    while True:
        try:
            job = call("/claim")
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            print("server unreachable:", e, flush=True)
            time.sleep(min(idle := idle * 2, 60))
            continue
        if not job:
            idle = 2
            time.sleep(2)
            continue
        started = time.time()
        try:
            text, lang = transcribe(job)
            call(f"/jobs/{job['id']}", {"transcript": text, "language": lang})
            print(f"{job['id']}: {lang}, {len(text)} chars in {time.time() - started:.1f}s", flush=True)
        except Exception as e:  # one bad recording mustn't stop the worker
            print(f"{job['id']}: failed: {e}", file=sys.stderr, flush=True)
            try:
                call(f"/jobs/{job['id']}/fail", {"error": "Couldn't transcribe that recording. Try again."})
            except Exception:
                pass


if __name__ == "__main__":
    main()
