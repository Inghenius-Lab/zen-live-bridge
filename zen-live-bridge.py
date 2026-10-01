#!/usr/bin/env python3
"""Zen Live Bridge server — puente entre agentes (TCP) y la extension Zen (WebSocket).

Arquitectura:
  agente/CLI  --TCP 127.0.0.1:8790 (JSON lines)-->  zen-live-bridge.py
  extension   --WS  127.0.0.1:8788 (JSON)----------> zen-live-bridge.py
La extension (WebExtension MV2 en Zen) se conecta como cliente WS; el server
reenvia comandos con id y devuelve las respuestas al agente que los pidio.

Zero dependencias: WS implementado a mano (RFC 6455, frames texto, payload
hasta 64-bit). Solo escucha en 127.0.0.1.
"""
import base64, hashlib, hmac, json, os, secrets, socket, struct, sys, threading, time

TCP_PORT = int(os.environ.get("ZEN_LIVE_TCP", "8790"))  # 8787 = stt-server (canonico ecosistema)
WS_PORT = int(os.environ.get("ZEN_LIVE_WS", "8788"))
TOKEN_FILE = os.path.expanduser(
    os.environ.get("ZEN_LIVE_TOKEN_FILE", "~/.local/state/zen-live-bridge/token"))


def load_or_make_token():
    """Token compartido entre puente, CLI y extension.

    Que protege y que NO, para no creerse mas de lo que es:
      - SI: paginas web (no pueden leer un archivo 0600), otros usuarios de la
        misma maquina, y conexiones accidentales.
      - NO: un proceso que ya corre como este usuario, porque puede leer el
        archivo del token igual que cualquier otra cosa. Contra eso ningun
        secreto en disco sirve; haria falta aislamiento o un socket con
        permisos de usuario.
    """
    try:
        with open(TOKEN_FILE) as f:
            t = f.read().strip()
            if t:
                return t
    except FileNotFoundError:
        pass
    d = os.path.dirname(TOKEN_FILE)
    if d:
        os.makedirs(d, mode=0o700, exist_ok=True)
    t = secrets.token_urlsafe(32)
    fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(t + "\n")
    return t


def token_ok(candidate, expected=None):
    exp = expected if expected is not None else load_or_make_token()
    if not candidate or not exp:
        return False
    return hmac.compare_digest(str(candidate), str(exp))
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

class WsClient:
    """Una conexion WebSocket (la extension)."""
    def __init__(self, sock):
        self.sock = sock
        self.buf = b""
    def recv_exact(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("cerrado")
            self.buf += chunk
        data, self.buf = self.buf[:n], self.buf[n:]
        return data
    def read_frame(self):
        h = self.recv_exact(2)
        opcode = h[0] & 0x0F
        masked = bool(h[1] & 0x80)
        ln = h[1] & 0x7F
        if ln == 126:
            ln = struct.unpack(">H", self.recv_exact(2))[0]
        elif ln == 127:
            ln = struct.unpack(">Q", self.recv_exact(8))[0]
        if ln > 64 * 1024 * 1024:
            raise ConnectionError("frame demasiado grande")
        mask = self.recv_exact(4) if masked else b""
        payload = self.recv_exact(ln)
        if masked:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        return opcode, payload
    def send_text(self, text):
        data = text.encode() if isinstance(text, str) else text
        hdr = bytearray([0x81])
        ln = len(data)
        if ln < 126:
            hdr.append(ln)
        elif ln < 65536:
            hdr.append(126); hdr += struct.pack(">H", ln)
        else:
            hdr.append(127); hdr += struct.pack(">Q", ln)
        self.sock.sendall(bytes(hdr) + data)
    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass

class WsServer:
    def __init__(self):
        self.token = load_or_make_token()
        self.lock = threading.Lock()
        self.client = None          # conexion WS activa de la extension
        self.pending = {}           # id -> threading.Event + resultado
        self.seq = 0
        self.sock = socket.socket()
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", WS_PORT))
        self.sock.listen(2)
        self.sock.settimeout(0.5)
    def run(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            try:
                self._handshake(conn)
            except Exception:
                conn.close()
                continue
            conn.settimeout(None)  # bloqueante tras el handshake: la conexion vive hasta que la extension la cierre
            ws = WsClient(conn)
            with self.lock:
                old, self.client = self.client, ws
            if old:
                old.close()
            print(f"[ws] extension conectada ({time.strftime('%H:%M:%S')})", flush=True)
            threading.Thread(target=self._reader, args=(ws,), daemon=True).start()
            threading.Thread(target=self._keepalive, args=(ws,), daemon=True).start()
    def _handshake(self, conn):
        conn.settimeout(10)
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = conn.recv(4096)
            if not chunk:
                raise ConnectionError("no request")
            data += chunk
        request_line = data.decode("latin1").split("\r\n")[0]
        headers = {}
        for line in data.decode("latin1").split("\r\n")[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()

        # Token en la query del path: /?t=TOKEN
        # Ojo: request_line es "GET /?t=TOKEN HTTP/1.1". Partirlo por "?"
        # deja "t=TOKEN HTTP/1.1", o sea el token con el codigo HTTP pegado y
        # la comparacion falla siempre. Hay que quedarse con el path primero.
        path = request_line.split(" ")[1] if " " in request_line else request_line
        got = ""
        if "?" in path:
            for pair in path.split("?", 1)[1].split("&"):
                if pair.startswith("t="):
                    got = pair[2:]
        if not token_ok(got):
            conn.sendall(b"HTTP/1.1 401 Unauthorized\r\n\r\n")
            raise ConnectionError("token invalido")

        # Solo la extension puede conectarse. Una pagina web que intentara
        # ws://127.0.0.1:8788 mandaria su propio Origin y se rechaza. Es
        # defensa en profundidad: el token ya la frena.
        origin = headers.get("origin", "")
        if origin and not origin.startswith("moz-extension://"):
            conn.sendall(b"HTTP/1.1 403 Forbidden\r\n\r\n")
            raise ConnectionError("origin no permitido")

        key = headers.get("sec-websocket-key", "")
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        conn.sendall(
            ("HTTP/1.1 101 Switching Protocols\r\n"
             "Upgrade: websocket\r\n"
             "Connection: Upgrade\r\n"
             f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode()
        )
    def _reader(self, ws):
        try:
            while True:
                opcode, payload = ws.read_frame()
                if opcode == 0x8:  # close
                    break
                if opcode == 0x9:  # ping -> pong
                    self._send_pong(ws, payload)
                    continue
                if opcode != 0x1:
                    continue
                try:
                    msg = json.loads(payload.decode())
                except Exception:
                    continue
                ev = self.pending.pop(msg.get("id"), None)
                if ev:
                    ev["result"] = msg
                    ev["event"].set()
        except Exception as e:
            import traceback
            print(f"[ws] READER ERROR: {e}\n{traceback.format_exc()}", flush=True)
        finally:
            with self.lock:
                if self.client is ws:
                    self.client = None
            print("[ws] extension desconectada", flush=True)
            ws.close()
    def _send_pong(self, ws, payload):
        try:
            ws.sock.sendall(bytes([0x8A, len(payload)]) + payload)
        except Exception:
            pass
    def _keepalive(self, ws):
        """Ping de aplicacion cada 5s: mantiene vivo el service worker MV3
        (trafico continuo = no idle) y detecta la caida del SW (al suspenderse
        muere su socket, el send falla y el reader cierra la conexion)."""
        while True:
            time.sleep(5)
            with self.lock:
                if self.client is not ws:
                    return
            try:
                ws.send_text(json.dumps({"id": 0, "cmd": "ping"}))
            except Exception:
                return
    def send_command(self, command, timeout=120):
        with self.lock:
            if not self.client:
                return {"ok": False, "error": "sin extension conectada: carga Zen Live Bridge en about:debugging o instalala"}
            self.seq += 1
            cmd_id = self.seq
            ev = {"event": threading.Event(), "result": None}
            self.pending[cmd_id] = ev
            try:
                self.client.send_text(json.dumps({"id": cmd_id, **command}))
            except Exception as e:
                self.pending.pop(cmd_id, None)
                return {"ok": False, "error": f"ws send: {e}"}
        if not ev["event"].wait(timeout):
            self.pending.pop(cmd_id, None)
            return {"ok": False, "error": f"timeout ({timeout}s): la extension no respondio"}
        return ev["result"]

def handle_tcp_conn(server, conn):
    conn.settimeout(600)
    buf = b""
    try:
        while True:
            chunk = conn.recv(65536)
            if not chunk:
                return
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                line = line.strip()
                if not line:
                    continue
                try:
                    cmd = json.loads(line.decode())
                except Exception as e:
                    conn.sendall((json.dumps({"ok": False, "error": f"json: {e}"}) + "\n").encode())
                    continue
                if not token_ok(cmd.get("token"), server.token):
                    conn.sendall((json.dumps({
                        "ok": False,
                        "error": "token invalido. Rotalo con: rm ~/.local/state/zen-live-bridge/token "
                                  "&& zen-live serve && ./package.sh --restart-zen",
                    }) + "\n").encode())
                    continue
                if cmd.get("cmd") == "shutdown":
                    result = {"ok": True, "bye": True}
                else:
                    result = server.send_command(cmd, timeout=cmd.get("timeout", 120))
                conn.sendall((json.dumps(result) + "\n").encode())
                if cmd.get("cmd") == "shutdown":
                    return
    except Exception as e:
        try:
            conn.sendall((json.dumps({"ok": False, "error": f"tcp: {e}"}) + "\n").encode())
        except Exception:
            pass
    finally:
        conn.close()

# ---------------------------------------------------------------- UI local
# Sirve la web de /ui/ y una API que relayea contra la extension por el WS.
# Puerto aparte del TCP de linea-JSON a proposito: mezclar dos protocolos en el
# mismo puerto obliga a sniffear los primeros bytes y es fragil de mantener.
HTTP_PORT = int(os.environ.get("ZEN_LIVE_HTTP", "8789"))
WEBUI_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "webui")

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".json": "application/json; charset=utf-8",
}


def http_json(conn, status, payload):
    body = json.dumps(payload).encode()
    conn.sendall(
        f"HTTP/1.1 {status}\r\n"
        f"Content-Type: application/json; charset=utf-8\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Cache-Control: no-store\r\n"
        "Connection: close\r\n\r\n".encode() + body)


def read_http(conn, limit=1 << 20):
    """Lee method + path + headers + body. Suficiente para /api/cmd con JSON."""
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = conn.recv(65536)
        if not chunk:
            return None, None, {}, b""
        buf += chunk
        if len(buf) > limit:
            return None, None, {}, b""
    head, _, rest = buf.partition(b"\r\n\r\n")
    lines = head.decode("latin1").split("\r\n")
    parts = (lines[0].split(" ") + ["", "", ""])[:3]
    method, path = parts[0], parts[1]
    headers = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    n = int(headers.get("content-length", "0") or 0)
    body = rest
    while len(body) < n:
        chunk = conn.recv(65536)
        if not chunk:
            break
        body += chunk
    return method, path, headers, body


def handle_http(server, conn):
    conn.settimeout(30)
    try:
        method, path, headers, body = read_http(conn)
        if method is None:
            return

        # Log de acceso minimo. Sirve para depurar, y sobre todo para
        # comprobar sin adivinar que el panel esta hablando con la API: si no
        # aparece /api/status, el token no llego al iframe.
        if path.startswith("/api/") or os.environ.get("ZEN_LIVE_HTTP_VERBOSE"):
            who = "ui-anon" if not headers.get("x-zen-live-token") else "ui-con-token"
            print(f"[http] {method} {path} {who}", file=sys.stderr, flush=True)

        # Las paginas de /ui/ no piden token: no tienen nada sensible, solo la
        # maquetacion. El token se exige en /api/, que es lo unico que manda
        # algo al navegador. Asi una pagina cualquiera que iframee /ui/ no
        # obtiene nada, y la UI carga sinTTP credentials inline.
        if path.startswith("/api/"):
            if not token_ok(headers.get("x-zen-live-token"), server.token):
                http_json(conn, "401 Unauthorized", {"ok": False, "error": "token invalido"})
                return

            if path == "/api/status":
                r = server.send_command({"cmd": "ping"}, timeout=8)
                http_json(conn, "200 OK", {
                    "ok": True,
                    "extension": bool(r.get("ok")),
                    "version": r.get("version", ""),
                    "http_port": HTTP_PORT,
                })
                return

            if path == "/api/cmd" and method == "POST":
                try:
                    req = json.loads(body or b"{}")
                except Exception as e:
                    http_json(conn, "400 Bad Request", {"ok": False, "error": f"json: {e}"})
                    return
                t = req.get("timeout", 30)
                result = server.send_command({**req, "timeout": t}, timeout=t)
                http_json(conn, "200 OK", result if isinstance(result, dict) else {"ok": True})
                return

            http_json(conn, "404 Not Found", {"ok": False, "error": f"ruta no existe: {path}"})
            return

        # ---- archivos estaticos de la UI ----
        if path in ("/", "/ui", "/ui/"):
            path = "/ui/index.html"
        rel = path.lstrip("/")
        if rel.startswith("ui/"):
            rel = rel[3:]
        root = os.path.normpath(WEBUI_DIR)
        # Sin esta comprobacion, un ../../etc/passwd sale del directorio.
        full = os.path.normpath(os.path.join(root, rel))
        if not full.startswith(root):
            http_json(conn, "403 Forbidden", {"ok": False, "error": "fuera del directorio de la UI"})
            return
        if not os.path.isfile(full):
            http_json(conn, "404 Not Found", {"ok": False, "error": f"no existe: {path}"})
            return
        ctype = CONTENT_TYPES.get(os.path.splitext(full)[1], "application/octet-stream")
        with open(full, "rb") as f:
            data = f.read()
        conn.sendall(
            f"HTTP/1.1 200 OK\r\nContent-Type: {ctype}\r\n"
            f"Content-Length: {len(data)}\r\nCache-Control: no-store\r\n"
            "Connection: close\r\n\r\n".encode() + data)
    except Exception as e:
        try:
            http_json(conn, "500 Internal Server Error", {"ok": False, "error": str(e)})
        except Exception:
            pass
    finally:
        conn.close()


def serve_http(server):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", HTTP_PORT))
    sock.listen(16)
    while True:
        try:
            conn, _ = sock.accept()
            threading.Thread(target=handle_http, args=(server, conn), daemon=True).start()
        except Exception as e:
            print(f"[http] error: {e}", file=sys.stderr)


def main():
    server = WsServer()
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    threading.Thread(target=serve_http, args=(server,), daemon=True).start()
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("127.0.0.1", TCP_PORT))
    s.listen(8)
    print(f"[zen-live-bridge] ws=127.0.0.1:{WS_PORT} tcp=127.0.0.1:{TCP_PORT} http=127.0.0.1:{HTTP_PORT}", flush=True)
    while True:
        try:
            conn, _ = s.accept()
        except OSError:
            break
        threading.Thread(target=handle_tcp_conn, args=(server, conn), daemon=True).start()

if __name__ == "__main__":
    main()