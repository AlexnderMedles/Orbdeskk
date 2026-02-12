import asyncio
import json
import os
import random
import string
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse

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
    sessions[code] = {
        "host": None,
        "viewers": [],
        "control_allowed": True,
        "password": None,
        "chat_history": [],
        "monitors": [],
    }
    return {"code": code}

@app.get("/session/check")
async def check_session(code: str = Query("")):
    s = sessions.get(code)
    if s and s["host"]:
        return {
            "online": True,
            "viewers": len(s["viewers"]),
            "control": s["control_allowed"],
            "has_password": s.get("password") is not None,
        }
    return {"online": False}

@app.get("/download/agent")
async def download_agent():
    return FileResponse("orbdesk_host.py", filename="orbdesk_host.py",
                        media_type="application/octet-stream")


# ═══════════════════════════════════════════════════════
# Dashboard API
# ═══════════════════════════════════════════════════════

@app.get("/api/dashboard")
async def dashboard_info(code: str = Query("")):
    s = sessions.get(code)
    if not s or not s["host"]:
        return JSONResponse({"error": "Session not found"}, status_code=404)
    return {
        "code": code,
        "viewers": len(s["viewers"]),
        "control_allowed": s["control_allowed"],
        "has_password": s.get("password") is not None,
        "monitors": s.get("monitors", []),
    }

@app.post("/api/dashboard/toggle_control")
async def dashboard_toggle(request: Request):
    body = await request.json()
    code = body.get("code", "")
    s = sessions.get(code)
    if not s or not s["host"]:
        return JSONResponse({"error": "Not found"}, status_code=404)
    
    s["control_allowed"] = not s["control_allowed"]
    allowed = s["control_allowed"]
    # Уведомляем зрителей
    for v in s["viewers"]:
        try:
            await v.send_text(json.dumps({
                "type": "control_status", "allowed": allowed
            }))
        except: pass
    # Уведомляем хоста
    try:
        await s["host"].send_text(json.dumps({
            "type": "control_toggled", "allowed": allowed
        }))
    except: pass
    return {"allowed": allowed}

@app.post("/api/dashboard/kick")
async def dashboard_kick(request: Request):
    body = await request.json()
    code = body.get("code", "")
    s = sessions.get(code)
    if not s:
        return JSONResponse({"error": "Not found"}, status_code=404)
    for v in list(s["viewers"]):
        try:
            await v.close(code=4020, reason="Kicked")
        except: pass
    s["viewers"].clear()
    return {"kicked": True}


# ═══════════════════════════════════════════════════════
# WebSocket: Хост-агент
# ═══════════════════════════════════════════════════════

@app.websocket("/ws/host")
async def ws_host(ws: WebSocket, code: str = Query("")):
    if not code or len(code) != 6:
        await ws.close(code=4000, reason="Bad code")
        return
    if code not in sessions:
        sessions[code] = {
            "host": None, "viewers": [], "control_allowed": True,
            "password": None, "chat_history": [], "monitors": [],
        }
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
                # Кадр экрана → рассылаем зрителям ПАРАЛЛЕЛЬНО
                frame = data["bytes"]
                viewers = sessions[code]["viewers"]
                if viewers:
                    async def _send(v):
                        try:
                            await v.send_bytes(frame)
                            return True
                        except:
                            return False
                    results = await asyncio.gather(*[_send(v) for v in viewers])
                    dead = [v for v, ok in zip(viewers, results) if not ok]
                    for d in dead:
                        viewers.remove(d)

            elif "text" in data:
                msg = json.loads(data["text"])
                t = msg.get("type")

                if t == "control_toggle":
                    sessions[code]["control_allowed"] = msg["allowed"]
                    for v in sessions[code]["viewers"]:
                        try:
                            await v.send_text(json.dumps({
                                "type": "control_status",
                                "allowed": msg["allowed"]
                            }))
                        except: pass

                elif t == "kick":
                    for v in list(sessions[code]["viewers"]):
                        try:
                            await v.close(code=4020, reason="Kicked")
                        except: pass
                    sessions[code]["viewers"].clear()

                elif t == "set_password":
                    sessions[code]["password"] = msg.get("password")

                elif t == "monitor_list":
                    sessions[code]["monitors"] = msg.get("monitors", [])
                    # Пересылаем зрителям
                    for v in sessions[code]["viewers"]:
                        try:
                            await v.send_text(json.dumps(msg))
                        except: pass

                elif t == "chat":
                    # Хост отправил сообщение → рассылаем зрителям
                    msg["from"] = "host"
                    sessions[code]["chat_history"].append(msg)
                    if len(sessions[code]["chat_history"]) > 100:
                        sessions[code]["chat_history"] = sessions[code]["chat_history"][-50:]
                    for v in sessions[code]["viewers"]:
                        try:
                            await v.send_text(json.dumps(msg))
                        except: pass

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
async def ws_viewer(ws: WebSocket, code: str = Query(""), password: str = Query("")):
    s = sessions.get(code)
    if not s or not s["host"]:
        await ws.close(code=4001, reason="Offline")
        return
    if len(s["viewers"]) >= MAX_VIEWERS:
        await ws.close(code=4002, reason="Full")
        return
    
    # Проверка пароля
    if s.get("password") and password != s["password"]:
        await ws.close(code=4003, reason="Wrong password")
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

    # Отправляем список мониторов
    if s.get("monitors"):
        try:
            await ws.send_text(json.dumps({
                "type": "monitor_list",
                "monitors": s["monitors"]
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
            text = await ws.receive_text()
            msg = json.loads(text)
            t = msg.get("type", msg.get("action", ""))

            if t == "chat":
                # Зритель отправил чат → всем (хост + другие зрители)
                msg["from"] = "viewer"
                s["chat_history"].append(msg)
                if len(s["chat_history"]) > 100:
                    s["chat_history"] = s["chat_history"][-50:]
                # Хосту
                try:
                    await s["host"].send_text(json.dumps(msg))
                except: pass
                # Другим зрителям
                for v in s["viewers"]:
                    if v != ws:
                        try:
                            await v.send_text(json.dumps(msg))
                        except: pass

            elif t == "draw":
                # Рисование → всем зрителям и хосту
                for v in s["viewers"]:
                    if v != ws:
                        try:
                            await v.send_text(text)
                        except: pass

            elif t == "draw_clear":
                # Очистка рисунка → всем зрителям
                for v in s["viewers"]:
                    if v != ws:
                        try:
                            await v.send_text(text)
                        except: pass

            else:
                # Управление (move, click, key и т.п.) → хосту
                if s.get("control_allowed", False):
                    host = s.get("host")
                    if host:
                        try:
                            await host.send_text(text)
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
