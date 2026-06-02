#!/usr/bin/env python3
"""
serve.py — simple HTTP server for local development.

Adds the two headers required for cross-origin isolation so that
SharedArrayBuffer (and shared WebAssembly.Memory) can be transferred
between a Web Worker and the main thread via postMessage.

Usage: python serve.py [port]   (default port: 8080)
"""

import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler


class IsolatedHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        print(fmt % args)


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
print(f"Serving at http://localhost:{port}  (COOP + COEP enabled)")
HTTPServer(("", port), IsolatedHandler).serve_forever()
