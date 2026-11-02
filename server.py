"""Local web server for Ghost Charts: serves the page and runs update_data.py when the UI asks.

Run:  python server.py   (then open http://localhost:8765)
Only listens on 127.0.0.1, so nothing outside this computer can reach it.
"""
import json
import os
import subprocess
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
update_lock = threading.Lock()


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Data files change after an update; make the browser always re-check them.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_POST(self):
        if self.path != "/api/update":
            return self.send_error(404)
        if not update_lock.acquire(blocking=False):
            return self.reply(409, {"ok": False, "log": "An update is already running."})
        try:
            r = subprocess.run([sys.executable, os.path.join(HERE, "update_data.py")],
                               capture_output=True, text=True, timeout=900)
            log = (r.stdout + r.stderr).strip()
            self.reply(200, {"ok": r.returncode == 0, "log": log})
        except subprocess.TimeoutExpired:
            self.reply(200, {"ok": False, "log": "Update timed out after 15 minutes."})
        finally:
            update_lock.release()

    def reply(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), partial(Handler, directory=HERE))
    print(f"Ghost Charts running at http://localhost:{PORT}  (close this window to stop)")
    srv.serve_forever()
