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
USE_TURBOJPEG = False
try:
    import numpy as np
    from turbojpeg import TurboJPEG, TJPF_BGRA, TJSAMP_420, TJFLAG_FASTDCT
    
    # Пытаемся инициализировать DLL
    try:
        jpeg = TurboJPEG()
    except Exception:
        # Если не нашлось по умолчанию, пробуем типичные пути Windows
        import os
        possible_dll_names = ["turbojpeg.dll", "libturbojpeg.dll"]
        possible_roots = ["C:\\libjpeg-turbo64", "C:\\libjpeg-turbo", "C:\\Program Files\\libjpeg-turbo64"]
        
        jpeg = None
        for root in possible_roots:
            for name in possible_dll_names:
                p = os.path.join(root, "bin", name)
                if os.path.exists(p):
                    try:
                        jpeg = TurboJPEG(p)
                        if jpeg: break
                    except:
                        continue
            if jpeg: break
        
        if not jpeg:
            raise RuntimeError("DLL_NOT_FOUND")

    USE_TURBOJPEG = True
    print("⚡ TurboJPEG: АКТИВЕН (максимальная скорость 60 FPS)")

except ImportError as e:
    # Ошибка: не установлен модуль в Python
    missing_mod = str(e).split("'")[-2] if "'" in str(e) else "turbojpeg"
    print(f"⚠️  TurboJPEG не активен: Не установлен Python-модуль '{missing_mod}'")
    print(f"    Решение: Выполни команду в консоли:")
    print(f"    python -m pip install PyTurboJPEG numpy")
    print("    После этого перезапусти скрипт.")
    print("    Сейчас работаем через Pillow 🐢 (около 15-20 FPS)")

except Exception as e:
    # Ошибка: модуль есть, но нет самой либы (DLL) в системе
    if "DLL_NOT_FOUND" in str(e) or "library not found" in str(e).lower():
        print("⚠️  TurboJPEG не активен: В системе не найден движок libjpeg-turbo (DLL).")
        print("    Решение:")
        print("    1. Проверь, что ты установил программу в C:\\libjpeg-turbo64")
        print("    2. Проверь, что внутри C:\\libjpeg-turbo64\\bin есть файл turbojpeg.dll")
    else:
        print(f"⚠️  TurboJPEG не активен: {e}")
    
    print("    Сейчас работаем через Pillow 🐢 (около 15-20 FPS)")

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
current_monitor = 1  # mss monitor index (1 = primary)

# Сессионный пароль
SESSION_PASSWORD = ''.join(random.choices(string.ascii_uppercase + string.digits, k=4))

# Пул потоков для захвата экрана (не блокирует event loop)
capture_executor = ThreadPoolExecutor(max_workers=2)


def gen_code():
    return ''.join(random.choices(string.digits, k=6))


def get_monitor_list():
    """Возвращает список мониторов."""
    with mss.mss() as sct:
        monitors = []
        for i, m in enumerate(sct.monitors):
            if i == 0:  # skip 'all monitors' virtual
                continue
            monitors.append({
                "index": i,
                "width": m["width"],
                "height": m["height"],
                "left": m["left"],
                "top": m["top"],
            })
        return monitors


# ═══ Захват экрана (оптимизированный) ═══

def capture_turbo():
    """Захват с TurboJPEG — максимальная скорость."""
    with mss.mss() as sct:
        mon = sct.monitors[current_monitor]
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
        mon = sct.monitors[current_monitor]
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
    global QUALITY, FPS, SCALE, current_profile, current_monitor
    if not control_allowed:
        # Разрешаем set_quality и set_monitor даже без контроля
        try:
            d = json.loads(data_str)
            a = d.get("action")
            if a not in ("set_quality", "set_monitor"):
                return
        except:
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
                print(f"\n  📊 Качество: {profile.upper()} (Q={QUALITY}, Scale={SCALE}, FPS={FPS})")
        elif a == "set_monitor":
            idx = d.get("index", 1)
            with mss.mss() as sct:
                if 1 <= idx < len(sct.monitors):
                    current_monitor = idx
                    print(f"\n  🖥️ Монитор: #{idx}")
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

    monitors = get_monitor_list()
    encoder = "TurboJPEG ⚡" if USE_TURBOJPEG else "Pillow 🐢"
    print()
    print("╔══════════════════════════════════════════════╗")
    print("║         OrbDesk Host Agent v3                ║")
    print("╠══════════════════════════════════════════════╣")
    print(f"║   Код доступа:   {code}                        ║")
    print(f"║   Пароль:        {SESSION_PASSWORD}                       ║")
    print(f"║   Мониторов:     {len(monitors)}                          ║")
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

                # Отправляем пароль и список мониторов хабу
                await ws.send(json.dumps({"type": "set_password", "password": SESSION_PASSWORD}))
                await ws.send(json.dumps({"type": "monitor_list", "monitors": monitors}))

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
                last_time = time.perf_counter()

                try:
                    while True:
                        # Захват + кодирование в отдельном потоке
                        frame = await loop.run_in_executor(capture_executor, capture)

                        # Отправка кадра
                        await ws.send(frame)

                        # FPS-счётчик (одна строка с \r чтобы не спамить)
                        frame_count += 1
                        now = time.time()
                        elapsed = now - fps_timer
                        if elapsed >= 1.0:
                            real_fps = frame_count / elapsed
                            size_kb = len(frame) / 1024
                            sys.stdout.write(f"\r  📈 {real_fps:.1f} FPS | {size_kb:.0f} KB/кадр | {current_profile.upper()}   ")
                            sys.stdout.flush()
                            frame_count = 0
                            fps_timer = now

                        # Точный тайминг
                        target_interval = 1.0 / FPS
                        curr_time = time.perf_counter()
                        work_time = curr_time - last_time
                        sleep_time = target_interval - work_time
                        
                        if sleep_time > 0:
                            # Вычитаем 1-2мс на накладные расходы asyncio
                            await asyncio.sleep(max(0, sleep_time - 0.001))
                        
                        last_time = time.perf_counter()

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
        # Убрали принудительную установку WindowsSelectorEventLoopPolicy, 
        # так как она устарела и вызывает предупреждения.
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
