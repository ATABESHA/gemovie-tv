"""Preview the Kinogo TV interface in a PC browser.

Serves kinogo/src/main/assets at /assets/ and forwards /api/... to the catalogue's API
with the app key, the same way the Android app does.  Run:  python tools/kinogo-preview/serve.py
then open http://localhost:8771/assets/index.html  (arrow keys + Enter = remote, Backspace = Back).
"""
import http.server, os, sys, urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'kinogo', 'src', 'main', 'assets')
API = 'https://geo.mevicer.ge/rest-api/v130/'
KEY = 'ttohdhqbu8dtxmd40om3jdy6'
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8771


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def do_GET(self):
        if self.path.startswith('/api/'):
            try:
                req = urllib.request.Request(API + self.path[5:], headers={'API-KEY': KEY, 'User-Agent': 'KinogoTV-preview'})
                body = urllib.request.urlopen(req, timeout=30).read()
                code = 200
            except Exception as e:
                body, code = ('{"error":"%s"}' % e).encode(), 502
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.startswith('/assets/'):
            self.path = self.path[7:]
        super().do_GET()


http.server.ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
