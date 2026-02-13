import asyncio
import json
import os
import random
import string
import zipfile
import io
import time
import uuid
import shutil
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, Request, UploadFile, File
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

app = FastAPI()

# ═══════════════════════════════════════════════════════
# Сессии
# ═══════════════════════════════════════════════════════

sessions: dict = {}
MAX_VIEWERS = 5
UPLOAD_DIR = "uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)

# Цвета для Ghost Cursors
CURSOR_COLORS = [
    "#ff6b6b", "#4ecdc4", "#ffe66d", "#a29bfe",
    "#fd79a8", "#00cec9", "#fab1a0", "#6c5ce7",
]

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
        "viewer_meta": {},       # ws -> {id, color, name}
        "control_allowed": True,
        "password": None,
        "chat_history": [],
        "monitors": [],
        "metrics_history": [],   # последние 60 точек CPU/RAM
        "last_metrics": None,
        "next_color_idx": 0,
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

# 🔗 ПРЯМАЯ ССЫЛКА НА СКАЧИВАНИЕ (GitHub Releases)
# Вставь сюда ссылку на свой .exe после того как создашь релиз на GitHub
HOST_DOWNLOAD_URL = "" 

@app.get("/download/host")
async def download_host():
    """Отдаёт .exe (через редирект или локально) или ZIP."""
    # 1. Если настроена внешняя ссылка — перенаправляем туда
    if HOST_DOWNLOAD_URL.startswith("http"):
        from fastapi.responses import RedirectResponse
        return RedirectResponse(HOST_DOWNLOAD_URL)

    # 2. Иначе ищем локально в корне или в dist/
    exe_path = "OrbDesk_Host.exe"
    if not os.path.exists(exe_path):
        exe_path = os.path.join("dist", "OrbDesk_Host.exe")
    
    if os.path.exists(exe_path):
        return FileResponse(
            exe_path,
            media_type="application/octet-stream",
            filename="OrbDesk_Host.exe"
        )

    files_to_zip = ["orbdesk_host.py", "run_host.bat", "requirements_host.txt"]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in files_to_zip:
            if os.path.exists(f):
                z.write(f, f)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=OrbDesk_Host_Agent.zip"}
    )


# ═══════════════════════════════════════════════════════
# File Upload API (OrbDrop)
# ═══════════════════════════════════════════════════════

@app.post("/api/upload/{code}")
async def upload_file(code: str, file: UploadFile = File(...)):
    s = sessions.get(code)
    if not s or not s["host"]:
        return JSONResponse({"error": "Session not found"}, status_code=404)

    file_id = str(uuid.uuid4())[:8]
    safe_name = os.path.basename(file.filename or "file")
    save_dir = os.path.join(UPLOAD_DIR, code)
    os.makedirs(save_dir, exist_ok=True)
    save_path = os.path.join(save_dir, f"{file_id}_{safe_name}")

    with open(save_path, "wb") as f:
        content = await file.read()
        f.write(content)

    size_kb = len(content) / 1024

    # Уведомляем хоста о файле
    try:
        await s["host"].send_text(json.dumps({
            "type": "file_incoming",
            "file_id": file_id,
            "filename": safe_name,
            "size_kb": round(size_kb, 1),
        }))
    except:
        pass

    return {"file_id": file_id, "filename": safe_name, "size_kb": round(size_kb, 1)}

@app.get("/api/download_file/{code}/{file_id}")
async def download_file(code: str, file_id: str):
    save_dir = os.path.join(UPLOAD_DIR, code)
    if not os.path.exists(save_dir):
        return JSONResponse({"error": "Not found"}, status_code=404)
    for fname in os.listdir(save_dir):
        if fname.startswith(file_id):
            return FileResponse(
                os.path.join(save_dir, fname),
                filename=fname[len(file_id) + 1:],
            )
    return JSONResponse({"error": "File not found"}, status_code=404)


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
        "last_metrics": s.get("last_metrics"),
    }

@app.get("/api/dashboard/metrics")
async def dashboard_metrics(code: str = Query("")):
    s = sessions.get(code)
    if not s or not s["host"]:
        return JSONResponse({"error": "Not found"}, status_code=404)
    return {"metrics": s.get("metrics_history", [])}

@app.post("/api/dashboard/toggle_control")
async def dashboard_toggle(request: Request):
    body = await request.json()
    code = body.get("code", "")
    s = sessions.get(code)
    if not s or not s["host"]:
        return JSONResponse({"error": "Not found"}, status_code=404)

    s["control_allowed"] = not s["control_allowed"]
    allowed = s["control_allowed"]
    for v in s["viewers"]:
        try:
            await v.send_text(json.dumps({
                "type": "control_status", "allowed": allowed
            }))
        except: pass
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
    s["viewer_meta"].clear()
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
            "host": None, "viewers": [], "viewer_meta": {},
            "control_allowed": True, "password": None,
            "chat_history": [], "monitors": [],
            "metrics_history": [], "last_metrics": None,
            "next_color_idx": 0,
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
                        sessions[code]["viewer_meta"].pop(d, None)

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
                    sessions[code]["viewer_meta"].clear()

                elif t == "set_password":
                    sessions[code]["password"] = msg.get("password")

                elif t == "monitor_list":
                    sessions[code]["monitors"] = msg.get("monitors", [])
                    for v in sessions[code]["viewers"]:
                        try:
                            await v.send_text(json.dumps(msg))
                        except: pass

                elif t == "chat":
                    msg["from"] = "host"
                    sessions[code]["chat_history"].append(msg)
                    if len(sessions[code]["chat_history"]) > 100:
                        sessions[code]["chat_history"] = sessions[code]["chat_history"][-50:]
                    for v in sessions[code]["viewers"]:
                        try:
                            await v.send_text(json.dumps(msg))
                        except: pass

                elif t == "clipboard_sync":
                    # Хост отправил содержимое буфера → рассылаем зрителям
                    for v in sessions[code]["viewers"]:
                        try:
                            await v.send_text(json.dumps(msg))
                        except: pass

                elif t == "system_metrics":
                    # CPU/RAM метрики от хоста
                    sessions[code]["last_metrics"] = msg
                    hist = sessions[code]["metrics_history"]
                    hist.append(msg)
                    if len(hist) > 60:
                        sessions[code]["metrics_history"] = hist[-60:]

                elif t == "screenshot_result":
                    # Скриншот по запросу Quick Action → зрителям
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
            # Чистим загруженные файлы
            upload_dir = os.path.join(UPLOAD_DIR, code)
            if os.path.exists(upload_dir):
                shutil.rmtree(upload_dir, ignore_errors=True)
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

    if s.get("password") and password != s["password"]:
        await ws.close(code=4003, reason="Wrong password")
        return

    await ws.accept()
    s["viewers"].append(ws)

    # Назначаем viewer_id и цвет для Ghost Cursors
    viewer_id = str(uuid.uuid4())[:6]
    color_idx = s["next_color_idx"] % len(CURSOR_COLORS)
    s["next_color_idx"] += 1
    viewer_color = CURSOR_COLORS[color_idx]
    s["viewer_meta"][ws] = {"id": viewer_id, "color": viewer_color}

    cnt = len(s["viewers"])
    print(f"[Hub] Viewer+ {code} ({cnt}) id={viewer_id}")

    # Отправляем viewer_id и цвет новому зрителю
    try:
        await ws.send_text(json.dumps({
            "type": "viewer_identity",
            "viewer_id": viewer_id,
            "color": viewer_color,
        }))
    except: pass

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
                msg["from"] = "viewer"
                s["chat_history"].append(msg)
                if len(s["chat_history"]) > 100:
                    s["chat_history"] = s["chat_history"][-50:]
                try:
                    await s["host"].send_text(json.dumps(msg))
                except: pass
                for v in s["viewers"]:
                    if v != ws:
                        try:
                            await v.send_text(json.dumps(msg))
                        except: pass

            elif t == "draw":
                for v in s["viewers"]:
                    if v != ws:
                        try:
                            await v.send_text(text)
                        except: pass

            elif t == "draw_clear":
                for v in s["viewers"]:
                    if v != ws:
                        try:
                            await v.send_text(text)
                        except: pass

            elif t == "cursor_pos":
                # Ghost Cursors — рассылаем другим зрителям
                meta = s["viewer_meta"].get(ws, {})
                msg["viewer_id"] = meta.get("id", "?")
                msg["color"] = meta.get("color", "#fff")
                out = json.dumps(msg)
                for v in s["viewers"]:
                    if v != ws:
                        try:
                            await v.send_text(out)
                        except: pass

            elif t == "clipboard_sync":
                # Зритель отправил текст из буфера → хосту
                try:
                    await s["host"].send_text(json.dumps(msg))
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
            sessions[code]["viewer_meta"].pop(ws, None)
            cnt = len(sessions[code]["viewers"])
            print(f"[Hub] Viewer- {code} ({cnt})")
            # Сообщаем другим зрителям что этот курсор ушёл
            for v in sessions[code]["viewers"]:
                try:
                    await v.send_text(json.dumps({
                        "type": "cursor_remove",
                        "viewer_id": viewer_id,
                    }))
                except: pass
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
