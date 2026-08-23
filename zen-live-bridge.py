#!/usr/bin/env python3
"""Zen Live Bridge server — puente entre agentes (TCP) y la extension Zen (WebSocket).

Arquitectura:
  agente/CLI  --TCP 127.0.0.1:8787 (JSON lines)-->  zen-live-bridge.py
  extension   --WS  127.0.0.1:8788 (JSON)----------> zen-live-bridge.py
La extension (WebExtension MV2 en Zen) se conecta como cliente WS; el server
reenvia comandos con id y devuelve las respuestas al agente que los pidio.

Zero dependencias: WS implementado a mano (RFC 6455, frames texto, payload
hasta 64-bit). Solo escucha en 127.0.0.1.
"""
import base64, hashlib, json, os, socket, struct, sys, threading, time

TCP_PORT = int(os.environ.get("ZEN_LIVE_TCP", "8787"))
WS_PORT = int(os.environ.get("ZEN_LIVE_WS", "8788"))
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
        headers = {}
        for line in data.decode("latin1").split("\r\n")[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()
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

def main():
    server = WsServer()
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("127.0.0.1", TCP_PORT))
    s.listen(8)
    print(f"[zen-live-bridge] ws=127.0.0.1:{WS_PORT} tcp=127.0.0.1:{TCP_PORT} (150 pergamino)", flush=True)
    while True:
        try:
            conn, _ = s.accept()
        except OSError:
            break
        threading.Thread(target=handle_tcp_conn, args=(server, conn), daemon=True).start()

if __name__ == "__main__":
    main()