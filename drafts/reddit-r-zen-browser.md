# Reddit: r/zen_browser — borrador (NO publicar sin tu OK)

## Título
I built a bridge so an agent can drive Zen (and it turned into a browser-security
post-mortem)

## Cuerpo

Hey — I built [zen-live-bridge](https://github.com/Inghenius-Lab/zen-live-bridge), a
local bridge that lets an AI agent control Zen through the browser profile you're
already logged into. Zen doesn't have `about:debugging`, so there's no way for an
agent to attach, hence the bridge.

It's not a product pitch, it's a portfolio piece, and I want to write up two things
that cost me real debugging time, because I couldn't find them written down anywhere.

**1. If your click ends with `el.click()`, coordinates are lying to you.**

When you synthesise a click to hit an element precisely, this is the usual shape:

```js
el.dispatchEvent(new PointerEvent("pointerdown", { clientX: x, clientY: y, bubbles: true }));
// ...pointerup, mouseup...
el.click();   // <-- this one carries clientX: 0, clientY: 0
```

`HTMLElement.click()` fires a *fresh* event with no coordinates. Anything that
tracks movement across the whole gesture — sliders, video scrubbers, drag handles,
any custom "press and drag to seek" — sees your final event at the top-left corner
and jumps there instead. It looks like the element "didn't respond" or "went to 0".

Fix: dispatch the final `click` yourself with the real coordinates, and only fall
back to `el.click()` for checkbox/radio, where the toggle semantics matter more than
the position.

**2. `eval` is blocked by CSP on most sites now. That's not a blocker, it's a design constraint.**

X, Gmail and a lot of everything else kill `eval` in content scripts. So the
"read the page and decide what to click" loop that every tutorial shows you is dead
on arrival. What survived CSP and still let me drive X end to end:

- `locate(selector)` → returns coordinates, doesn't click. Asking *where* is allowed
  even when running arbitrary code isn't.
- `annotate()` → draws numbered boxes over interactive elements, returns the count.
  Then `click-at N`. Both sides derive the index from the same deterministic DOM
  walk, so index N means the same element on both calls.
- `exists(selector)` → a CSP-safe `wait`. Cheap, and it doesn't need `--allow-eval`.

The whole point of `annotate` is that you can *see* the numbering in a screenshot and
just point at a number. No JS, no guessing.

**The security part, which I'd genuinely like people to check.**

The bridge listens on `127.0.0.1` and drives your authenticated session. Mine shipped
with **no auth at all**. I proved it on myself before fixing it:

```
$ python3 -c "connect to 127.0.0.1:8790, send {'cmd':'tabs'}"
  -> ok: true, 36 tabs, including Telegram, WhatsApp, Gmail
```

Any local process, no credential. Before you build one of these: **test that**. I
now require a shared token (`0600`, `hmac.compare_digest`), the WebSocket rejects any
`Origin` that isn't `moz-extension://`, and the README says plainly what that does
*not* protect against — a process already running as you can read the token file, and
no secret on disk fixes that. If you want real isolation, you need process isolation
or a permission-restricted socket.

Full disclosure: `mikesmullin/mcp-zen` does the Origin + Host check on both its HTTP
and WebSocket sides and got this right before I did — worth reading if you're building
the same thing. And their `IMPROVEMENTS.md` documents several agent-tooling failure
modes that cost them days, which is what prompted this post.

Repo is MIT. Happy to answer anything about the bridge or the click bug.

## Notas para mi
- NO mencionar precios, dinero, ni "esto es para mi portafolio profesional".
- Creditar a mcp-zen explícitamente. Es lo que da credibilidad.
- El bloque de arriba lo pegué de mi propia README, es texto real y verificado.
