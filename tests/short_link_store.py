"""Development store for short share links (in memory; forgets everything on exit).

It only ever receives ciphertext: the browser encrypts each recipe and keeps the key in the
link's #fragment. Contract: POST /s (bytes, <= 64 KB) -> {"id": "..."}; GET /s/<id> -> bytes;
GET /health -> ok.

Usage: python tests/short_link_store.py [port=8799]
"""
import json, secrets, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BYTES = 64 * 1024
STORE = {}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body=b"", ctype="application/octet-stream"):
        self.send_response(code)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, b"ok", "text/plain")
        if self.path.startswith("/s/") and self.path[3:] in STORE:
            return self._send(200, STORE[self.path[3:]])
        self._send(404, b"not found", "text/plain")

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        if self.path != "/s" or not 0 < n <= MAX_BYTES:
            return self._send(400, b"bad request", "text/plain")
        sid = secrets.token_urlsafe(6)  # 8 characters
        STORE[sid] = self.rfile.read(n)
        self._send(201, json.dumps({"id": sid}).encode(), "application/json")

    def log_message(self, fmt, *args):
        sys.stderr.write("store: " + fmt % args + "\n")


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8799
    print(f"short-link store on http://127.0.0.1:{port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
