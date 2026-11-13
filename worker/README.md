# todone transcriber

Turns Ask todone recordings into words on an Apple Silicon Mac you run. It only connects out to the server (it asks
for work), so nothing on the Mac is exposed to the internet. About 3 GB of disk, ~2 GB of memory while working.

```sh
brew install ffmpeg python@3.12
mkdir -p ~/todone-worker && cp worker.py ~/todone-worker/
python3.12 -m venv ~/todone-worker/.venv
~/todone-worker/.venv/bin/pip install mlx-whisper
```

Make a token (`openssl rand -hex 32`), set it as `AI_WORKER_TOKEN` on the server, and put the same one in
`com.todone.worker.plist`. Then:

```sh
cp com.todone.worker.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.todone.worker.plist
tail -f ~/todone-worker/worker.log
```

The first recording downloads the model (`WHISPER_MODEL`, default `mlx-community/whisper-large-v3-turbo`, ~1.6 GB).
If the Mac is off, recordings wait up to 10 minutes and then fail with a note to type instead; nothing is sent
anywhere else.
