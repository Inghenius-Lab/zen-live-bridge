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


# ===== v0.11 SAFETY GUARDS =====
# Guard 6: AUDIT LOG. El extension no puede escribir ficheros (WebExtension no
# tiene API de disco), asi que el log va aqui, en el puente: es el unico punto
# por el que pasan TODOS los comandos, tanto del CLI (TCP 8790) como del panel
# web (HTTP 8789). Complementario del historial del panel, no sustituto.
STATE_DIR = os.path.dirname(TOKEN_FILE)
AUDIT_FILE = os.path.join(STATE_DIR, "audit.jsonl")
AUDIT_MAX_BYTES = 5 * 1024 * 1024

# Clasificacion de comandos. WRITE son los que MUTAN la pagina o el navegador;
# READ son los que solo observan. El read-only mode (guard 3) se apoya en esto.
READ_CMDS = {
    "ping", "tabs", "text", "snap", "snapRefs", "links", "locate", "annotate",
    "interactive", "annotate-clear", "exists", "wait", "console", "history",
    "css", "network", "screenshot", "shot", "cookies", "cookiesFor",
    "listContainers", "list-containers", "doctor", "snapshot",
}
# localstorage/sessionstorage dependen de la accion: list/get leen, set/delete/clear escriben.
STORAGE_WRITE_ACTIONS = {"set", "delete", "clear"}

def is_write_command(req):
    """True si el comando MUTA la pagina o el navegador."""
    cmd = str(req.get("cmd", "") or "")
    if cmd in ("localstorage", "sessionstorage"):
        return str(req.get("action", "list") or "list").lower() in STORAGE_WRITE_ACTIONS
    if cmd == "storage-clear":
        return True
    return cmd not in READ_CMDS

def audit_target(req):
    """Descripcion del objetivo del comando SIN el valor sensible.

    Lo unico que se guarda del fill es el selector y la longitud del texto
    escrito, nunca el texto: un audit log con el valor dentro es un segundo
    sitio donde acaba la contrasena que el usuario escribio.
    """
    cmd = str(req.get("cmd", "") or "")
    out = {}
    if req.get("url"):
        u = str(req["url"])
        # Solo esquema+host+path: la query string lleva tokens de sesion.
        try:
            from urllib.parse import urlsplit
            sp = urlsplit(u)
            out["url"] = "%s://%s%s" % (sp.scheme, sp.netloc, sp.path)
        except Exception:
            out["url"] = u[:120]
    if req.get("sel"):
        out["sel"] = str(req["sel"])[:120]
    if req.get("ref"):
        out["ref"] = str(req["ref"])[:16]
    if req.get("key"):
        out["key"] = str(req["key"])[:40]
    if req.get("text"):
        out["text"] = str(req["text"])[:40]
    if req.get("n") is not None:
        out["n"] = req["n"]
    if "value" in req:
        # Solo la longitud. El contenido jamas.
        out["value_len"] = len(str(req.get("value") or ""))
    if "expr" in req:
        out["expr_len"] = len(str(req.get("expr") or ""))
    if req.get("tabId") is not None:
        out["tabId"] = req["tabId"]
    if req.get("action"):
        out["action"] = str(req["action"])[:20]
    return out

# Guard 3: READ-ONLY MODE. Flag apagado por defecto: cambiar el comportamiento
# por defecto de una herramienta que ya usa el usuario seria una decision suya,
# no nuestra. Se activa con `zen-live readonly on`.
READONLY_DEFAULT = os.environ.get("ZEN_LIVE_READONLY", "0") == "1"

# Guard 4: RATE LIMIT. 120 escrituras/min es alto para un humano y bajo para un
# bucle runaway que esta clicando miles de veces. Configurable con
# ZEN_LIVE_RATE_LIMIT (0 = sin limite).
RATE_LIMIT_DEFAULT = int(os.environ.get("ZEN_LIVE_RATE_LIMIT", "120"))
RATE_WINDOW = 60.0

# Guard 5: SITIOS PROTEGIDOS. Patron de URL (bancos, pago, salud, gobierno).
# No es un muro: es un freno que obliga a repetir el comando con confirm_token,
# de modo que la intencion tiene que ser explicita y queda en el audit log.
PROTECTED_PATTERNS = [
    ("banco", r"(paypal|stripe|payoneer|mercadopago|mercadolibre|checkout\.|/payment|/pago|/transfer|wire-?transfer)"),
    ("banco", r"(bbva|santander|banorte|hsbc|barclays|chase\.com|bankofamerica|wellsfargo|citi\.com|/banco|/banking|/netbanking|/online-?banking)"),
    ("salud", r"(salud|health|mychart|patientportal|/patients?|hospital|clinic|medic(?:a|al)|/historia-clinica)"),
    ("gobierno", r"(\.gob(\.|$)|\.gob\.ve|\.gob\.mx|\.gob\.es|sede\.electronic|agencia\b.*\btribut|hacienda|sat\.gob|agencia-?tributaria|registro-?civil)"),
    ("infraestructura", r"(github\.com/.*/(settings|admin)|gitlab\.com/.*/(settings|admin)|cloudflare\.com|console\.aws|docker\.hub)"),
]
PROTECTED_COMPILED = [(label, __import__("re").compile(p, __import__("re").I)) for label, p in PROTECTED_PATTERNS]

def protected_match(url):
    if not url:
        return None
    u = str(url)
    for label, rx in PROTECTED_COMPILED:
        if rx.search(u):
            return label
    return None

class Guards:
    """Estado de los guards que necesitan memoria (read-only, rate, tokens)."""
    def __init__(self):
        self.readonly = READONLY_DEFAULT
        self.rate_limit = RATE_LIMIT_DEFAULT
        self.write_times = []          # marcas de tiempo de escrituras (rate limit)
        self.confirmed = {}            # token -> (cmd, url, expira)

    def snapshot(self):
        return {"readonly": self.readonly, "rate_limit": self.rate_limit,
                "writes_last_min": len([t for t in self.write_times if time.time() - t < RATE_WINDOW]),
                "audit_file": AUDIT_FILE}

    def check(self, req):
        """Devuelve None si pasa, o dict de denegacion."""
        cmd = str(req.get("cmd", "?") or "?")
        # ping/doctor/listContainers/audit/guards son de administracion: nunca se
        # bloquean a si mismos, o no habria forma de desactivar el read-only.
        if cmd in ("ping", "doctor", "shutdown", "guards", "audit", "listContainers", "list-containers"):
            return None
        write = is_write_command(req)
        now = time.time()
        if self.readonly and write:
            return {"guard": "read-only",
                    "error": "read-only: %s es una escritura y el modo lectura esta activo "
                             "(desactivalo con: zen-live readonly off)" % cmd}
        if write and self.rate_limit > 0:
            self.write_times = [t for t in self.write_times if now - t < RATE_WINDOW]
            if len(self.write_times) >= self.rate_limit:
                return {"guard": "rate-limit",
                        "error": "rate limit: %d escrituras en los ultimos 60s (maximo %d). "
                                 "Espera o subelo con: zen-live ratelimit N"
                                 % (len(self.write_times), self.rate_limit)}
        # Guard 5: solo para escrituras (leer una pagina de un banco no es arriesgado).
        if write and req.get("url"):
            label = protected_match(req.get("url"))
            if label:
                tok = req.get("confirm_token")
                key = (cmd, str(req.get("url")))
                if tok:
                    exp = self.confirmed.get(str(tok))
                    if exp and exp["key"] == key and exp["exp"] > now:
                        return None
                    if exp and exp["exp"] <= now:
                        self.confirmed.pop(str(tok), None)
                import hashlib as _h
                new_tok = _h.sha256(("%s|%s|%s" % (cmd, req.get("url"), self._salt())).encode()).hexdigest()[:16]
                self.confirmed[new_tok] = {"key": key, "exp": now + 300}
                return {"guard": "protected-site",
                        "confirm_token": new_tok,
                        "error": "requiere confirmacion: sitio protegido (%s). "
                                 "Repite el comando con confirm_token=%s si de verdad quieres seguir. "
                                 "El token vale 5 minutos y solo para este comando y esta URL." % (label, new_tok)}
        if write:
            self.write_times.append(time.time())
        return None

    @staticmethod
    def _salt():
        # El token depende del token del puente: reiniciar el puente invalida
        # los confirm_tokens ya emitidos, que es justo lo que se quiere.
        try:
            with open(TOKEN_FILE) as f:
                return f.read().strip()
        except OSError:
            return "salt"

def audit(req, decision, guard=None, reason=None, tab_id=None):
    """Escribe una linea JSON. NUNCA lanza: auditar no puede romper el puente."""
    try:
        entry = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "decision": decision,
            "guard": guard,
            "cmd": str(req.get("cmd", "?") or "?"),
            "target": audit_target(req),
        }
        if reason:
            entry["reason"] = str(reason)[:200]
        if tab_id is not None:
            entry["tabId"] = tab_id
        d = os.path.dirname(AUDIT_FILE)
        if d:
            os.makedirs(d, mode=0o700, exist_ok=True)
        # Rotacion por tamano: un log que crece sin limite llena el disco.
        try:
            if os.path.exists(AUDIT_FILE) and os.path.getsize(AUDIT_FILE) > AUDIT_MAX_BYTES:
                os.replace(AUDIT_FILE, AUDIT_FILE + ".1")
        except OSError:
            pass
        fd = os.open(AUDIT_FILE, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "a") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass

def audit_tail(n=40):
    try:
        with open(AUDIT_FILE) as f:
            lines = f.readlines()
        out = []
        for ln in lines[-int(n):]:
            try:
                out.append(json.loads(ln))
            except Exception:
                continue
        return out
    except FileNotFoundError:
        return []

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
        self.guards = Guards()          # guards 3/4/5: read-only, rate, protegidos
        self.lock = threading.Lock()
        self.history = []           # historial de acciones para deshacer
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
    # --- historial de acciones -------------------------------------------
    # Un agente con tu sesion real es una caja negra si no dejas rastro. Cada
    # comando que pasa por la UI se guarda aqui con su inversa posible, para
    # que el panel pueda listarlo y deshacerlo. Solo se guardan los que pasan
    # por /api/cmd (la UI); el CLI deja su propio rastro en la terminal.
    HISTORY_MAX = 200

    # Solo tiene sentido deshacer lo que se puede deshacer de verdad. Un click
    # en "archivar" no se puede revertir desde aqui, asi que se registra pero se
    # marca sin inversa en vez de fingir que se puede.
    UNDOABLE = {"goto": "back", "back": "forward", "forward": "back", "reload": "reload",
                "scroll": "scroll-invert", "set-range": "set-range-prev",
                "fill": "fill-prev", "shadowfill": "fill-prev", "select": "select-prev",
                "annotate": "annotate-clear", "annotate-clear": "annotate"}

    def record(self, req):
        entry = {"id": len(self.history), "ts": time.time(), "cmd": req.get("cmd", "?"),
                 "tab": req.get("tabId"), "arg": req.get("sel") or req.get("text") or req.get("n"),
                 "ok": None, "undo": self.UNDOABLE.get(req.get("cmd", "")),
                 "label": self._label(req)}
        # Para los que necesitan el valor previo, se toma del DOM antes de actuar.
        if req.get("cmd") in ("fill", "shadowfill", "set-range", "select"):
            try:
                prev = self.send_command({"cmd": "inputvalue", "tabId": req.get("tabId"),
                                          "sel": req.get("sel") or req.get("text"), "timeout": 10})
                entry["prev"] = prev.get("value") if isinstance(prev, dict) else None
            except Exception:
                entry["prev"] = None
        self.history.append(entry)
        if len(self.history) > self.HISTORY_MAX:
            del self.history[:len(self.history) - self.HISTORY_MAX]
        return entry

    @staticmethod
    def _label(req):
        c, a = req.get("cmd", "?"), req.get("sel") or req.get("text") or req.get("n")
        if c in ("goto",): return a or ""
        if c == "click-at": return "elemento #%s" % a
        if c == "scroll": return str(a or "abajo")
        if c == "annotate": return "numerar elementos"
        if c == "annotate-clear": return "quitar numeros"
        if c == "reload": return "recargar"
        if c in ("back", "forward"): return c
        if a is None: return c          # sin argumento no inventar un "None"
        return ("%s %s" % (c, a)).strip()

    def undo(self, entry_id):
        """Revierte una entrada del historial. Devuelve el resultado del comando
        inverso, o explica por que no se pudo."""
        entry = next((e for e in self.history if e["id"] == entry_id), None)
        if entry is None:
            return {"ok": False, "error": f"no existe la accion {entry_id}"}
        how = entry.get("undo")
        if not how:
            return {"ok": False, "error": f"'{entry['cmd']}' no se puede deshacer",
                    "hint": "las acciones irreversibles (click, enviar, borrar) no tienen vuelta atras"}
        t = entry.get("tab")
        if how == "back":      cmd = {"cmd": "back", "tabId": t}
        elif how == "forward": cmd = {"cmd": "forward", "tabId": t}
        elif how == "reload":  cmd = {"cmd": "reload", "tabId": t}
        elif how == "scroll-invert":
            d = entry.get("arg") or "down"
            op = {"up": "down", "down": "up", "top": "bottom", "bottom": "top"}.get(str(d).lower(), "up")
            cmd = {"cmd": "scroll", "tabId": t, "sel": op}
        elif how == "annotate-clear": cmd = {"cmd": "annotate-clear", "tabId": t}
        elif how == "annotate":       cmd = {"cmd": "annotate", "tabId": t}
        elif how in ("fill-prev", "select-prev"):
            if entry.get("prev") is None:
                return {"ok": False, "error": "no se guardo el valor anterior, no se puede restaurar"}
            cmd = {"cmd": "fill", "tabId": t, "sel": entry.get("arg"), "text": entry["prev"]}
        else:
            cmd = {"cmd": how, "tabId": t}
        cmd["timeout"] = 20
        res = self.send_command(cmd, timeout=20)
        entry["undone"] = True
        return {"ok": bool(res.get("ok")) if isinstance(res, dict) else True,
                "deshecho": entry["label"] or entry["cmd"], "result": res}

    def send_command(self, command, timeout=120):
        # Guards 3/4/5 + audit (6). send_command es el unico camino que usan
        # tanto el CLI (TCP 8790) como el panel web (HTTP 8789), asi que un
        # solo punto de control basta para los dos y no se puede saltar por el
        # otro camino. Los guards 1 y 2 viven en la extension (ahi esta el DOM).
        cmd = str(command.get("cmd", "?") or "?")
        if cmd == "guards":
            return {"ok": True, **self.guards.snapshot()}
        if cmd == "audit":
            return {"ok": True, "file": AUDIT_FILE, "entries": audit_tail(command.get("limit", 40))}
        denial = self.guards.check(command)
        if denial:
            audit(command, "denegado", denial.get("guard"), denial.get("error"))
            return {"ok": False, **denial}
        # NO se audita aqui como "permitido": el comando todavia no se ha
        # ejecutado. Los guards 1 y 2 viven en la extension y pueden denegarlo
        # despues; el log se escribe una sola vez, con la decision final (mas
        # abajo, cuando llega la respuesta). Asi no sale "permitido" seguido de
        # "denegado" para la misma orden, que parece una fuga del guard.
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
            audit(command, "denegado", "timeout", f"timeout ({timeout}s)")
            return {"ok": False, "error": f"timeout ({timeout}s): la extension no respondio"}
        res = ev["result"]
        # Decision final: si la extension denies (guard 1 o 2) se deniega; si no,
        # permitted. Una sola linea por orden, con lo que de verdad paso.
        if isinstance(res, dict) and not res.get("ok") and res.get("guard"):
            audit(command, "denegado", res.get("guard"), res.get("error"))
        else:
            ok = res.get("ok") if isinstance(res, dict) else True
            audit(command, "permitido" if ok else "denegado", None,
                  None if ok else (res.get("error") if isinstance(res, dict) else None))
        return res

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
    try:
        import sys as _s
        _last = _s.stderr
        print(f"[http]   -> {status}", file=_last, flush=True)
    except Exception:
        pass
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
    path = path.partition("?")[0]
    headers = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    n = int(headers.get("content-length", "0") or 0)
    body = rest
    # parts[1] arrastra el query ("/api/history?limit=50"), y sin separarlo las
    # comparaciones exactas de ruta no matchean nunca.
    path, _, qs = path.partition("?")
    query = {}
    for pair in qs.split("&"):
        if "=" in pair:
            k, v = pair.split("=", 1)
            query[k] = [v]
    while len(body) < n:
        chunk = conn.recv(65536)
        if not chunk:
            break
        body += chunk
    return method, path, headers, body, query


def handle_http(server, conn):
    conn.settimeout(30)
    try:
        method, path, headers, body, query = read_http(conn)
        if method is None:
            return

        # Log de acceso minimo. Sirve para depurar, y sobre todo para
        # comprobar sin adivinar que el panel esta hablando con la API: si no
        # aparece /api/status, el token no llego al iframe.
        if path.startswith("/api/") or os.environ.get("ZEN_LIVE_HTTP_VERBOSE"):
            # Loguear solo si llevaba header no prueba nada: un token
            # equivocado tambien lo lleva. Se anota el token real (corto) y se
            # luego refleja el status en la misma linea.
            _h = headers.get("x-zen-live-token") or ""
            who = ("anon" if not _h else f"tok:{_h[:6]}")
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

            if path == "/api/guards" and method == "POST":
                # Unico sitio donde se cambia el estado de los guards. Va por
                # HTTP (con token) y no como comando mas de la extension: si
                # fuera un cmd normal, en read-only no habria forma de apagarlo.
                try:
                    req = json.loads(body or b"{}")
                except Exception as e:
                    http_json(conn, "400 Bad Request", {"ok": False, "error": f"json: {e}"})
                    return
                op = req.get("op")
                val = req.get("value")
                if op == "readonly":
                    if val is None or str(val).lower() == "status":
                        pass
                    elif str(val).lower() in ("on", "1", "true", "yes"):
                        server.guards.readonly = True
                    elif str(val).lower() in ("off", "0", "false", "no"):
                        server.guards.readonly = False
                    else:
                        http_json(conn, "400 Bad Request", {"ok": False, "error": "valor: on|off|status"})
                        return
                    audit({"cmd": "guards:readonly", "value": val}, "permitido", "control",
                          "read-only -> %s" % server.guards.readonly)
                elif op == "ratelimit":
                    if val not in (None, "", "status"):
                        try:
                            server.guards.rate_limit = int(val)
                        except ValueError:
                            http_json(conn, "400 Bad Request", {"ok": False, "error": "ratelimit debe ser un numero"})
                            return
                        audit({"cmd": "guards:ratelimit", "value": val}, "permitido", "control",
                              "rate limit -> %d" % server.guards.rate_limit)
                else:
                    http_json(conn, "400 Bad Request", {"ok": False, "error": "op: readonly|ratelimit"})
                    return
                http_json(conn, "200 OK", {"ok": True, **server.guards.snapshot()})
                return

            if path == "/api/history" and method == "GET":
                n = int((query.get("limit") or ["50"])[0])
                http_json(conn, "200 OK", {"ok": True, "history": server.history[-n:]})
                return

            if path == "/api/undo" and method == "POST":
                try:
                    req = json.loads(body or b"{}")
                except Exception as e:
                    http_json(conn, "400 Bad Request", {"ok": False, "error": f"json: {e}"})
                    return
                res = server.undo(int(req.get("id", -1)))
                http_json(conn, "200 OK", res)
                return

            if path == "/api/cmd" and method == "POST":
                try:
                    req = json.loads(body or b"{}")
                except Exception as e:
                    http_json(conn, "400 Bad Request", {"ok": False, "error": f"json: {e}"})
                    return
                t = req.get("timeout", 30)
                entry = server.record(req)
                result = server.send_command({**req, "timeout": t}, timeout=t)
                entry["ok"] = bool(result.get("ok")) if isinstance(result, dict) else True
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