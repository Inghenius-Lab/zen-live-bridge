import importlib.util, re
spec = importlib.util.spec_from_file_location("otp", "/tmp/otp.py")
otp = importlib.util.module_from_spec(spec); spec.loader.exec_module(otp)

def code_de(cuerpo):
    """Replica EXACTA de la logica de otp.extract (no una copia)."""
    best = None
    KW = r"(?:c[oó]digo|code|passcode|otp|2fa)"
    for m in re.finditer(r"([^\n]{0,40}" + KW + r"[^\n]{0,60})", cuerpo, re.I):
        c = otp.CODE.search(m.group(1))
        if c:
            best = c.group(1); break
    return best

casos = [
  ("Google: 'tu codigo es NNNNNN'",  "Tu codigo de verificacion es 123456. No lo compartas.", "123456"),
  ("'verification code: NNNNNN'",    "Your verification code: 847291", "847291"),
  ("AWS",                            "Your AWS verification code is 654321", "654321"),
  ("GitHub: 'NNNNNN es tu codigo'",  "123456 es tu codigo de inicio de sesion", "123456"),
  ("telefono + codigo",              "Tu numero es 5551234567 y tu codigo es 111222", "111222"),
  ("code al final de linea",         "Verifica tu cuenta. Codigo: 246810", "246810"),
  ("SIN palabra clave",              "El PIN es 987654", None),
  ("newsletter con fechas",          "Oferta 20261001 del 15 al 20 de octubre", None),
  ("PIN de 4 digitos",               "Tu PIN 1234 para la tarjeta", None),
  ("numero de pedido largo",         "Pedido 20261001123456 confirmado", None),
]
fallos = 0
for nombre, cuerpo, esp in casos:
    got = code_de(cuerpo)
    ok = got == esp
    if not ok: fallos += 1
    print("  %-32s esperado=%-8s obtenido=%-8s %s" % (nombre, esp or "ninguno", got or "ninguno", "OK" if ok else "FALLO"))
print("\n  total: %d casos, %d fallos" % (len(casos), fallos))
