"""
OrbDesk Host Agent v2 — Оптимизированный до 60 FPS

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
import time
from concurrent.futures import ThreadPoolExecutor

try:
    import mss
    import pyautogui
except ImportError:
    print("Установите зависимости:")
    print("  pip install mss pyautogui websockets")
    sys.exit(1)

try:
    import websockets
except ImportError:
    print("Установите websockets:")
    print("  pip install websockets")
    sys.exit(1)

# ═══ Выбор JPEG-энкодера ═══
# turbojpeg в 10-15 раз быстрее Pillow
USE_TURBOJPEG = False
try:
    from turbojpeg import TurboJPEG, TJPF_BGRA, TJSAMP_420, TJFLAG_FASTDCT
    import numpy as np
    jpeg = TurboJPEG()
    USE_TURBOJPEG = True
    print("⚡ TurboJPEG: АКТИВЕН (максимальная скорость)")
except ImportError:
    try:
        from PIL import Image
        print("⚠️  TurboJPEG не найден, используем Pillow (медленнее)")
        print("    Для максимального FPS установите: pip install PyTurboJPEG numpy")
        print("    И установите libjpeg-turbo: https://libjpeg-turbo.org/")
    except ImportError:
        print("Установите Pillow или PyTurboJPEG:")
        print("  pip install Pillow")
        print("  или (быстрее): pip install PyTurboJPEG numpy")
        sys.exit(1)

# ═══ НАСТРОЙКИ ═══
HUB_URL = "https://web-production-0af6c.up.railway.app"

# Профили качества: quality, scale, fps
QUALITY_PROFILES = {
    "low":    {"quality": 30, "scale": 0.35, "fps": 15},
    "medium": {"quality": 50, "scale": 0.50, "fps": 30},
    "high":   {"quality": 70, "scale": 0.65, "fps": 60},
}

current_profile = "medium"
QUALITY = QUALITY_PROFILES[current_profile]["quality"]
FPS = QUALITY_PROFILES[current_profile]["fps"]
SCALE = QUALITY_PROFILES[current_profile]["scale"]

# ═══ Инициализация ═══
pyautogui.PAUSE = 0
pyautogui.FAILSAFE = False

control_allowed = True
ws_connection = None
held_modifiers = set()

# Пул потоков для захвата экрана (не блокирует event loop)
capture_executor = ThreadPoolExecutor(max_workers=2)


def gen_code():
    return ''.join(random.choices(string.digits, k=6))


# ═══ Захват экрана (оптимизированный) ═══

def capture_turbo():
    """Захват с TurboJPEG — максимальная скорость."""
    with mss.mss() as sct:
        mon = sct.monitors[1]
        shot = sct.grab(mon)
        # mss возвращает BGRA, turbojpeg может принять его напрямую
        raw = np.frombuffer(shot.raw, dtype=np.uint8).reshape(
            (shot.height, shot.width, 4)
        )

        if SCALE < 1:
            new_w = int(shot.width * SCALE)
            new_h = int(shot.height * SCALE)
            # Быстрый resize через numpy (nearest neighbor — моментальный)
            raw = raw[::int(1/SCALE), ::int(1/SCALE)]

        return jpeg.encode(
            raw,
            pixel_format=TJPF_BGRA,
            quality=QUALITY,
            jpeg_subsample=TJSAMP_420,
            flags=TJFLAG_FASTDCT
        )


def capture_pillow():
    """Захват с Pillow — медленнее, но универсальный."""
    with mss.mss() as sct:
        mon = sct.monitors[1]
        shot = sct.grab(mon)
        img = Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")
        if SCALE < 1:
            new_w = int(img.width * SCALE)
            new_h = int(img.height * SCALE)
            # BILINEAR вместо LANCZOS — в 3x быстрее, разница минимальна
            img = img.resize((new_w, new_h), Image.BILINEAR)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=QUALITY, optimize=False)
        return buf.getvalue()


def capture():
    """Выбирает лучший доступный энкодер."""
    if USE_TURBOJPEG:
        return capture_turbo()
    return capture_pillow()


# ═══ Обработка команд ═══

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


# ═══ Терминальный контроль ═══

def keyboard_listener():
    global control_allowed, ws_connection
    while True:
        try:
            cmd = input().strip().lower()
            if cmd == "c":
                control_allowed = not control_allowed
                status = "✅ РАЗРЕШЕНО" if control_allowed else "🔒 ЗАПРЕЩЕНО"
                print(f"\n  Управление: {status}\n")
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

    if HUB_URL.startswith("https://"):
        HUB_URL = HUB_URL.replace("https://", "wss://")
    elif HUB_URL.startswith("http://"):
        HUB_URL = HUB_URL.replace("http://", "ws://")

    code = gen_code()
    url = f"{HUB_URL}/ws/host?code={code}"

    encoder = "TurboJPEG ⚡" if USE_TURBOJPEG else "Pillow 🐢"
    print()
    print("╔══════════════════════════════════════════════╗")
    print("║         OrbDesk Host Agent v2                ║")
    print("╠══════════════════════════════════════════════╣")
    print(f"║   Код доступа:   {code}                        ║")
    print(f"║   Качество:      {current_profile.upper():10s}              ║")
    print(f"║   Целевой FPS:   {FPS:3d}                         ║")
    print(f"║   Энкодер:       {encoder:20s}    ║")
    print("╠══════════════════════════════════════════════╣")
    print("║   C — вкл/выкл управление мышью             ║")
    print("║   K — выгнать зрителей                      ║")
    print("║   Q — завершить                             ║")
    print("╚══════════════════════════════════════════════╝")
    print()

    t = threading.Thread(target=keyboard_listener, daemon=True)
    t.start()

    while True:
        try:
            print(f"🔗 Подключение к {HUB_URL}...")

            import urllib.request
            http_base = HUB_URL.replace("wss://", "https://").replace("ws://", "http://")
            try:
                req = urllib.request.urlopen(f"{http_base}/session/create")
                _ = req.read()
            except:
                pass

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

                # ═══ Пайплайн: захват в потоке, отправка асинхронно ═══
                frame_count = 0
                fps_timer = time.time()

                try:
                    while True:
                        t_start = time.time()

                        # Захват + кодирование в отдельном потоке → не блокирует event loop
                        frame = await loop.run_in_executor(capture_executor, capture)

                        # Отправка кадра
                        await ws.send(frame)

                        # FPS-счётчик
                        frame_count += 1
                        elapsed = time.time() - fps_timer
                        if elapsed >= 3.0:
                            real_fps = frame_count / elapsed
                            size_kb = len(frame) / 1024
                            print(f"  📈 {real_fps:.1f} FPS | {size_kb:.0f} KB/кадр | {current_profile.upper()}")
                            frame_count = 0
                            fps_timer = time.time()

                        # Точный тайминг для целевого FPS
                        frame_time = time.time() - t_start
                        target_time = 1.0 / FPS
                        sleep_time = target_time - frame_time
                        if sleep_time > 0:
                            await asyncio.sleep(sleep_time)

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
