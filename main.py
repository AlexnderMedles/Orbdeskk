import asyncio
import json
import os
import random
import string
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

app = FastAPI()

# ═══════════════════════════════════════════════════════
# Сессии
# ═══════════════════════════════════════════════════════

sessions: dict = {}
MAX_VIEWERS = 5

def gen_code():
    while True:
        c = ''.join(random.choices(string.digits, k=6))
        if c not in sessions:
            return c


# ═══════════════════════════════════════════════════════
# API
# ═══════════════════════════════════════════════════════

@app.get("/session/create")
async def create_session():
    code = gen_code()
    sessions[code] = {"host": None, "viewers": [], "control_allowed": True}
    return {"code": code}

@app.get("/session/check")
async def check_session(code: str = Query("")):
    s = sessions.get(code)
    if s and s["host"]:
        return {"online": True, "viewers": len(s["viewers"]),
                "control": s["control_allowed"]}
    return {"online": False}

@app.get("/download/agent")
async def download_agent():
    return FileResponse("orbdesk_host.py", filename="orbdesk_host.py",
                        media_type="application/octet-stream")


# ═══════════════════════════════════════════════════════
# WebSocket: Хост-агент
# ═══════════════════════════════════════════════════════

@app.websocket("/ws/host")
async def ws_host(ws: WebSocket, code: str = Query("")):
    if not code or len(code) != 6:
        await ws.close(code=4000, reason="Bad code")
        return
    # Автосоздание сессии если агент подключается с новым кодом
    if code not in sessions:
        sessions[code] = {"host": None, "viewers": [], "control_allowed": True}
    if sessions[code]["host"]:
        await ws.close(code=4003, reason="Already connected")
        return

    await ws.accept()
    sessions[code]["host"] = ws
    print(f"[Hub] Host ON: {code}")

    try:
        while True:
            data = await ws.receive()
            if "bytes" in data:
                # Кадр экрана → рассылаем зрителям
                frame = data["bytes"]
                dead = []
                for v in sessions[code]["viewers"]:
                    try:
                        await v.send_bytes(frame)
                    except:
                        dead.append(v)
                for d in dead:
                    sessions[code]["viewers"].remove(d)

            elif "text" in data:
                msg = json.loads(data["text"])
                t = msg.get("type")

                if t == "control_toggle":
                    sessions[code]["control_allowed"] = msg["allowed"]
                    # Уведомляем зрителей
                    for v in sessions[code]["viewers"]:
                        try:
                            await v.send_text(json.dumps({
                                "type": "control_status",
                                "allowed": msg["allowed"]
                            }))
                        except: pass

                elif t == "kick":
                    # Выгоняем всех зрителей
                    for v in list(sessions[code]["viewers"]):
                        try:
                            await v.close(code=4020, reason="Kicked")
                        except: pass
                    sessions[code]["viewers"].clear()

    except (WebSocketDisconnect, Exception):
        pass
    finally:
        if code in sessions:
            for v in sessions[code]["viewers"]:
                try:
                    await v.close(code=4010, reason="Host left")
                except: pass
            del sessions[code]
        print(f"[Hub] Host OFF: {code}")


# ═══════════════════════════════════════════════════════
# WebSocket: Зритель
# ═══════════════════════════════════════════════════════

@app.websocket("/ws/viewer")
async def ws_viewer(ws: WebSocket, code: str = Query("")):
    s = sessions.get(code)
    if not s or not s["host"]:
        await ws.close(code=4001, reason="Offline")
        return
    if len(s["viewers"]) >= MAX_VIEWERS:
        await ws.close(code=4002, reason="Full")
        return

    await ws.accept()
    s["viewers"].append(ws)
    cnt = len(s["viewers"])
    print(f"[Hub] Viewer+ {code} ({cnt})")

    # Отправляем текущий статус контроля
    try:
        await ws.send_text(json.dumps({
            "type": "control_status",
            "allowed": s["control_allowed"]
        }))
    except: pass

    # Уведомляем хоста о кол-ве зрителей
    try:
        await s["host"].send_text(json.dumps({
            "type": "viewer_count", "count": cnt
        }))
    except: pass

    try:
        while True:
            msg = await ws.receive_text()
            # Если контроль разрешён — пересылаем хосту
            if s.get("control_allowed", False):
                host = s.get("host")
                if host:
                    try:
                        await host.send_text(msg)
                    except: pass
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        if code in sessions and ws in sessions[code]["viewers"]:
            sessions[code]["viewers"].remove(ws)
            cnt = len(sessions[code]["viewers"])
            print(f"[Hub] Viewer- {code} ({cnt})")
            try:
                await sessions[code]["host"].send_text(json.dumps({
                    "type": "viewer_count", "count": cnt
                }))
            except: pass


# ═══════════════════════════════════════════════════════
app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 30052))
    uvicorn.run(app, host="0.0.0.0", port=port)
