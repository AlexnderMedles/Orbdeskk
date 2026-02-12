"""
OrbDesk Host Agent — запустите на ПК, которым хотите поделиться.

    python orbdesk_host.py

Управление в терминале:
    C — разрешить/запретить управление мышью/клавиатурой
    K — выгнать всех зрителей
    Q — завершить
"""
import asyncio
import io
import json
import random
import string
import sys
import threading

try:
    import mss
    import pyautogui
    from PIL import Image
except ImportError:
    print("Установите зависимости:")
    print("  pip install mss pyautogui Pillow websockets")
    sys.exit(1)

try:
    import websockets
except ImportError:
    print("Установите websockets:")
    print("  pip install websockets")
    sys.exit(1)

# ═══ НАСТРОЙКИ ═══
# Замените на ваш Railway URL после деплоя!
HUB_URL = "https://web-production-0af6c.up.railway.app"

# Профили качества: (JPEG quality, Scale, FPS)
QUALITY_PROFILES = {
    "low":    {"quality": 35, "scale": 0.40, "fps": 10},
    "medium": {"quality": 55, "scale": 0.55, "fps": 15},
    "high":   {"quality": 80, "scale": 0.75, "fps": 20},
}

current_profile = "medium"
QUALITY = QUALITY_PROFILES[current_profile]["quality"]
FPS = QUALITY_PROFILES[current_profile]["fps"]
SCALE = QUALITY_PROFILES[current_profile]["scale"]

# ═══ Инициализация ═══
pyautogui.PAUSE = 0
pyautogui.FAILSAFE = False
sct = mss.mss()

control_allowed = True
ws_connection = None

# Состояние зажатых модификаторов
held_modifiers = set()


def gen_code():
    return ''.join(random.choices(string.digits, k=6))


def capture():
    mon = sct.monitors[1]
    shot = sct.grab(mon)
    img = Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")
    if SCALE < 1:
        img = img.resize((int(img.width * SCALE), int(img.height * SCALE)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=QUALITY)
    return buf.getvalue()


def handle_cmd(data_str):
    """Выполняет команду управления от зрителя."""
    global QUALITY, FPS, SCALE, current_profile
    if not control_allowed:
        return
    try:
        d = json.loads(data_str)
        a = d.get("action")
        sw, sh = pyautogui.size()

        if a == "move":
            pyautogui.moveTo(d["x"] * sw, d["y"] * sh, _pause=False)

        elif a == "click":
            pyautogui.click(x=d["x"] * sw, y=d["y"] * sh,
                            button=d.get("button", "left"))

        elif a == "dblclick":
            pyautogui.doubleClick(x=d["x"] * sw, y=d["y"] * sh,
                                  button=d.get("button", "left"))

        elif a == "scroll":
            pyautogui.scroll(d.get("delta", 0))

        elif a == "key":
            k = d.get("key", "")
            if k:
                pyautogui.press(k)

        elif a == "hotkey":
            # Комбинации клавиш: ["ctrl", "c"], ["alt", "tab"] и т.д.
            keys = d.get("keys", [])
            if keys:
                pyautogui.hotkey(*keys)

        elif a == "keydown":
            k = d.get("key", "")
            if k:
                pyautogui.keyDown(k)
                held_modifiers.add(k)

        elif a == "keyup":
            k = d.get("key", "")
            if k:
                pyautogui.keyUp(k)
                held_modifiers.discard(k)

        elif a == "type":
            text = d.get("text", "")
            if text:
                pyautogui.typewrite(text, interval=0.02)

        elif a == "set_quality":
            profile = d.get("profile", "medium")
            if profile in QUALITY_PROFILES:
                current_profile = profile
                p = QUALITY_PROFILES[profile]
                QUALITY = p["quality"]
                SCALE = p["scale"]
                FPS = p["fps"]
                print(f"  📊 Качество: {profile.upper()} (Q={QUALITY}, Scale={SCALE}, FPS={FPS})")

    except:
        pass


def keyboard_listener():
    """Слушаем нажатия в терминале."""
    global control_allowed, ws_connection
    while True:
        try:
            cmd = input().strip().lower()
            if cmd == "c":
                control_allowed = not control_allowed
                status = "✅ РАЗРЕШЕНО" if control_allowed else "🔒 ЗАПРЕЩЕНО"
                print(f"\n  Управление: {status}\n")
                # Отправляем серверу
                if ws_connection:
                    asyncio.run_coroutine_threadsafe(
                        ws_connection.send(json.dumps({
                            "type": "control_toggle",
                            "allowed": control_allowed
                        })),
                        loop
                    )
            elif cmd == "k":
                print("\n  👢 Выгоняю всех зрителей...\n")
                if ws_connection:
                    asyncio.run_coroutine_threadsafe(
                        ws_connection.send(json.dumps({"type": "kick"})),
                        loop
                    )
            elif cmd == "q":
                print("\n  👋 Завершение...\n")
                # Отпускаем все зажатые модификаторы
                for mod in list(held_modifiers):
                    try:
                        pyautogui.keyUp(mod)
                    except:
                        pass
                held_modifiers.clear()
                if ws_connection:
                    asyncio.run_coroutine_threadsafe(
                        ws_connection.close(), loop
                    )
                sys.exit(0)
        except (EOFError, KeyboardInterrupt):
            sys.exit(0)


loop = None


async def run():
    global ws_connection, loop, control_allowed
    global HUB_URL

    loop = asyncio.get_event_loop()

    # Автоматическое исправление протокола (https -> wss, http -> ws)
    if HUB_URL.startswith("https://"):
        HUB_URL = HUB_URL.replace("https://", "wss://")
    elif HUB_URL.startswith("http://"):
        HUB_URL = HUB_URL.replace("http://", "ws://")

    code = gen_code()
    url = f"{HUB_URL}/ws/host?code={code}"

    print()
    print("╔══════════════════════════════════════════════╗")
    print("║           OrbDesk Host Agent                 ║")
    print("╠══════════════════════════════════════════════╣")
    print(f"║   Код доступа:   {code}                        ║")
    print(f"║   Качество:      {current_profile.upper():10s}              ║")
    print("╠══════════════════════════════════════════════╣")
    print("║   C — вкл/выкл управление мышью             ║")
    print("║   K — выгнать зрителей                      ║")
    print("║   Q — завершить                             ║")
    print("╚══════════════════════════════════════════════╝")
    print()

    # Запуск слушателя клавиатуры в отдельном потоке
    t = threading.Thread(target=keyboard_listener, daemon=True)
    t.start()

    while True:
        try:
            print(f"🔗 Подключение к {HUB_URL}...")

            # Создаём сессию через HTTP (меняем протокол обратно)
            import urllib.request
            http_base = HUB_URL.replace("wss://", "https://").replace("ws://", "http://")
            
            try:
                req = urllib.request.urlopen(f"{http_base}/session/create")
                _ = req.read()
            except:
                pass


            # Подключаемся по WebSocket
            async with websockets.connect(url, max_size=10_000_000) as ws:
                ws_connection = ws
                print(f"✅ Подключено! Управление: {'✅ РАЗРЕШЕНО' if control_allowed else '🔒 ЗАПРЕЩЕНО'}")
                print()

                async def receive():
                    try:
                        async for msg in ws:
                            try:
                                d = json.loads(msg)
                                if d.get("type") == "viewer_count":
                                    print(f"  👥 Зрителей: {d['count']}")
                                elif d.get("action"):
                                    handle_cmd(msg)
                            except:
                                handle_cmd(msg)
                    except:
                        pass

                recv = asyncio.create_task(receive())
                try:
                    while True:
                        frame = capture()
                        await ws.send(frame)
                        await asyncio.sleep(1 / FPS)
                except:
                    recv.cancel()
                    raise

        except KeyboardInterrupt:
            print("\n👋 Остановлено.")
            break
        except Exception as e:
            ws_connection = None
            print(f"⚠️ Отключено: {e}")
            print("🔄 Переподключение через 3 сек...")
            await asyncio.sleep(3)


if __name__ == "__main__":
    try:
        if sys.platform == 'win32':
            asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
