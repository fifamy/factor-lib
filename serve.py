"""本地开发服务器：发 no-cache 头，避免浏览器缓存旧的 app.js / index.html / parquet。

用法（在 frontend/ 目录下）：
    python3 serve.py            # 默认 8000 端口
    python3 serve.py 8080       # 指定端口

改完代码直接刷新浏览器即可看到最新版，无需 Cmd+Shift+R 清缓存。
"""
import http.server
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # 精简日志：只打非 favicon 请求
        if "favicon" not in (args[0] if args else ""):
            super().log_message(fmt, *args)


# 多线程：DuckDB-Wasm 会并发发多个 parquet Range 请求，单线程会 ERR_EMPTY_RESPONSE
class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    allow_reuse_address = True
    daemon_threads = True


with ThreadingHTTPServer(("", PORT), NoCacheHandler) as httpd:
    print(f"因子库 dev server (no-cache, threaded) → http://localhost:{PORT}")
    httpd.serve_forever()
