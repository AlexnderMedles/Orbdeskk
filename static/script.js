// ═══════════════════════════════════════════════════════
// Элементы
// ═══════════════════════════════════════════════════════

const pages = {
    landing: document.getElementById('landing-page'),
    host: document.getElementById('host-page'),
    viewer: document.getElementById('viewer-page'),
    remote: document.getElementById('remote-page'),
};

const canvas = document.getElementById('screen-canvas');
const ctx = canvas.getContext('2d');
const pinDigits = document.querySelectorAll('.pin-digit');
const pinError = document.getElementById('pin-error');
const connectBtn = document.getElementById('connect-btn');
const loader = document.getElementById('loader');
const controlBadge = document.getElementById('control-badge');

let ws = null;
let sessionCode = '';
let controlAllowed = false;


// ═══════════════════════════════════════════════════════
// Навигация
// ═══════════════════════════════════════════════════════

function showPage(name) {
    Object.values(pages).forEach(p => p.classList.remove('active'));
    pages[name].classList.add('active');
}

document.getElementById('btn-host').addEventListener('click', () => showPage('host'));
document.getElementById('btn-viewer').addEventListener('click', () => {
    showPage('viewer');
    resetPin();
    setTimeout(() => pinDigits[0].focus(), 100);
});
document.getElementById('back-from-host').addEventListener('click', () => showPage('landing'));
document.getElementById('back-from-viewer').addEventListener('click', () => showPage('landing'));


// ═══════════════════════════════════════════════════════
// PIN
// ═══════════════════════════════════════════════════════

function resetPin() {
    pinDigits.forEach(d => { d.value = ''; d.classList.remove('filled', 'error'); });
    pinError.textContent = '';
    connectBtn.disabled = true;
    connectBtn.textContent = 'Подключиться';
}

function getPinCode() {
    return Array.from(pinDigits).map(d => d.value).join('');
}

pinDigits.forEach((digit, idx) => {
    digit.addEventListener('input', (e) => {
        const val = e.target.value.replace(/\D/g, '');
        e.target.value = val.slice(-1);
        if (val) {
            digit.classList.add('filled');
            digit.classList.remove('error');
            if (idx < pinDigits.length - 1) pinDigits[idx + 1].focus();
        } else {
            digit.classList.remove('filled');
        }
        connectBtn.disabled = getPinCode().length < 6;
        pinError.textContent = '';
    });

    digit.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !digit.value && idx > 0) {
            pinDigits[idx - 1].focus();
            pinDigits[idx - 1].value = '';
            pinDigits[idx - 1].classList.remove('filled');
        }
        if (e.key === 'Enter' && getPinCode().length === 6) connectViewer();
    });

    digit.addEventListener('paste', (e) => {
        e.preventDefault();
        const paste = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
        if (paste.length >= 6) {
            paste.slice(0, 6).split('').forEach((ch, i) => {
                pinDigits[i].value = ch;
                pinDigits[i].classList.add('filled');
            });
            pinDigits[5].focus();
            connectBtn.disabled = false;
        }
    });
});

connectBtn.addEventListener('click', connectViewer);


// ═══════════════════════════════════════════════════════
// FPS & Info
// ═══════════════════════════════════════════════════════

let frameCount = 0;
let lastFpsUpdate = performance.now();
let measuredFps = 0;

function updateFpsCounter() {
    frameCount++;
    const now = performance.now();
    if (now - lastFpsUpdate >= 1000) {
        measuredFps = Math.round(frameCount * 1000 / (now - lastFpsUpdate));
        frameCount = 0;
        lastFpsUpdate = now;
        const fpsEl = document.getElementById('info-fps');
        if (fpsEl) fpsEl.textContent = measuredFps;
    }
}


// ═══════════════════════════════════════════════════════
// Подключение
// ═══════════════════════════════════════════════════════

let connectionTime = 0;

async function connectViewer() {
    const code = getPinCode();
    if (code.length < 6) return;

    connectBtn.disabled = true;
    connectBtn.textContent = 'Проверка...';

    try {
        const resp = await fetch(`/session/check?code=${code}`);
        const data = await resp.json();
        if (!data.online) {
            pinError.textContent = 'Хост не найден или оффлайн';
            pinDigits.forEach(d => d.classList.add('error'));
            connectBtn.disabled = false;
            connectBtn.textContent = 'Подключиться';
            return;
        }
    } catch {
        pinError.textContent = 'Ошибка связи с сервером';
        connectBtn.disabled = false;
        connectBtn.textContent = 'Подключиться';
        return;
    }

    sessionCode = code;
    showPage('remote');
    loader.style.display = '';
    canvas.style.display = 'none';
    document.getElementById('session-status').textContent = 'Подключение...';
    updateControlBadge(false);

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/ws/viewer?code=${code}`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
        loader.style.display = 'none';
        canvas.style.display = '';
        document.getElementById('session-status').textContent = 'В сети';
        connectionTime = Date.now();
        showToast('✅ Подключено!');
    };

    ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
            // Бинарный кадр экрана
            updateFpsCounter();
            const blob = new Blob([e.data], { type: 'image/jpeg' });
            const url = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = () => {
                if (canvas.width !== img.width || canvas.height !== img.height) {
                    canvas.width = img.width;
                    canvas.height = img.height;
                    // Обновляем разрешение в инфо
                    const resEl = document.getElementById('info-resolution');
                    if (resEl) resEl.textContent = `${img.width}×${img.height}`;
                }
                ctx.drawImage(img, 0, 0);
                URL.revokeObjectURL(url);
            };
            img.src = url;
        } else {
            // JSON сообщение
            try {
                const msg = JSON.parse(e.data);
                if (msg.type === 'control_status') {
                    controlAllowed = msg.allowed;
                    updateControlBadge(msg.allowed);
                    showToast(msg.allowed ? '🎮 Управление разрешено' : '👁️ Только просмотр');
                }
            } catch { }
        }
    };

    ws.onclose = (e) => {
        const msgs = {
            4001: 'Неверный код или хост оффлайн',
            4002: 'Слишком много зрителей',
            4010: 'Хост завершил сеанс',
            4020: 'Хост вас выгнал',
        };
        if (msgs[e.code]) {
            showPage('viewer');
            pinError.textContent = msgs[e.code];
            pinDigits.forEach(d => d.classList.add('error'));
        } else {
            document.getElementById('session-status').textContent = 'Отключено';
        }
        connectBtn.disabled = false;
        connectBtn.textContent = 'Подключиться';
        // Закрываем все оверлеи
        closeAllOverlays();
    };

    // Обновление задержки
    setInterval(() => {
        if (connectionTime && ws && ws.readyState === WebSocket.OPEN) {
            const latencyEl = document.getElementById('info-latency');
            if (latencyEl) {
                const elapsed = Math.round((Date.now() - connectionTime) / 1000);
                const min = Math.floor(elapsed / 60);
                const sec = elapsed % 60;
                latencyEl.textContent = min > 0 ? `${min}м ${sec}с` : `${sec}с`;
            }
        }
    }, 1000);
}

function updateControlBadge(allowed) {
    controlBadge.className = 'control-badge ' + (allowed ? 'allowed' : 'denied');
    controlBadge.textContent = allowed ? '🎮 Управление' : '👁️ Просмотр';
}

document.getElementById('close-session').addEventListener('click', () => {
    if (ws) ws.close();
    ws = null;
    sessionCode = '';
    connectionTime = 0;
    showPage('landing');
    closeAllOverlays();
});


// ═══════════════════════════════════════════════════════
// УПРАВЛЕНИЕ: мышь + клавиатура
// ═══════════════════════════════════════════════════════

function send(data) {
    if (!controlAllowed) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

function coords(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}

let lastMove = 0;
canvas.addEventListener('mousemove', (e) => {
    if (!controlAllowed) return;
    const now = Date.now();
    if (now - lastMove > 50) {
        send({ action: 'move', ...coords(e) });
        lastMove = now;
    }
});

canvas.addEventListener('mousedown', (e) => {
    if (!controlAllowed) return;
    const btn = e.button === 0 ? 'left' : (e.button === 2 ? 'right' : 'middle');
    send({ action: 'click', ...coords(e), button: btn });
});

canvas.addEventListener('dblclick', (e) => {
    if (!controlAllowed) return;
    e.preventDefault();
    const btn = 'left';
    send({ action: 'dblclick', ...coords(e), button: btn });
});

canvas.addEventListener('wheel', (e) => {
    if (!controlAllowed) return;
    e.preventDefault();
    send({ action: 'scroll', delta: e.deltaY > 0 ? -3 : 3 });
}, { passive: false });

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// Клавиатура — улучшенная обработка
window.addEventListener('keydown', (e) => {
    if (!pages.remote.classList.contains('active') || !controlAllowed) return;
    // Не перехватываем, если фокус в оверлее
    if (e.target.closest('.overlay-panel')) return;
    if (['F5', 'r'].includes(e.key) && e.ctrlKey) return;
    e.preventDefault();

    let key = e.key.toLowerCase();
    if (key === 'control') key = 'ctrl';
    if (key === 'escape') key = 'esc';
    send({ action: 'key', key });
});

document.getElementById('fullscreen').addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
});


// ═══════════════════════════════════════════════════════
// OVERLAYS: Settings & System Keys
// ═══════════════════════════════════════════════════════

const settingsOverlay = document.getElementById('settings-overlay');
const syskeysOverlay = document.getElementById('syskeys-overlay');
const btnSettings = document.getElementById('btn-settings');
const btnSyskeys = document.getElementById('btn-syskeys');

function closeAllOverlays() {
    settingsOverlay.classList.add('hidden');
    syskeysOverlay.classList.add('hidden');
    btnSettings.classList.remove('active');
    btnSyskeys.classList.remove('active');
}

function toggleOverlay(overlay, btn) {
    const isHidden = overlay.classList.contains('hidden');
    closeAllOverlays();
    if (isHidden) {
        overlay.classList.remove('hidden');
        btn.classList.add('active');
    }
}

btnSettings.addEventListener('click', () => toggleOverlay(settingsOverlay, btnSettings));
btnSyskeys.addEventListener('click', () => toggleOverlay(syskeysOverlay, btnSyskeys));

// Закрытие по крестику
document.querySelectorAll('.overlay-close').forEach(btn => {
    btn.addEventListener('click', () => {
        const targetId = btn.dataset.close;
        document.getElementById(targetId).classList.add('hidden');
        btnSettings.classList.remove('active');
        btnSyskeys.classList.remove('active');
    });
});

// Закрытие по клику вне оверлея
document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.overlay-panel') &&
        !e.target.closest('.nav-icon-btn')) {
        closeAllOverlays();
    }
});


// ═══ Quality Selector ═══
const qualitySelector = document.getElementById('quality-selector');
qualitySelector.addEventListener('click', (e) => {
    const btn = e.target.closest('.q-btn');
    if (!btn) return;
    const quality = btn.dataset.quality;

    // Обновляем UI
    qualitySelector.querySelectorAll('.q-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // Отправляем хосту через WebSocket
    send({ action: 'set_quality', profile: quality });
    showToast(`📊 Качество: ${{ 'low': 'Низкое (15 FPS)', 'medium': 'Среднее (30 FPS)', 'high': 'Высокое (60 FPS)' }[quality]}`);
});


// ═══ System Keys ═══
const heldModifiers = new Set();

// Модификаторы (удержание)
document.querySelectorAll('.modifier-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const mod = btn.dataset.mod;
        if (heldModifiers.has(mod)) {
            heldModifiers.delete(mod);
            btn.classList.remove('held');
            send({ action: 'keyup', key: mod });
        } else {
            heldModifiers.add(mod);
            btn.classList.add('held');
            send({ action: 'keydown', key: mod });
        }
    });
});

// Обычные клавиши
document.querySelectorAll('.syskey-btn:not(.modifier-btn):not(.hotkey-btn)').forEach(btn => {
    btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        if (!key) return;

        // Если есть зажатые модификаторы — отправляем как hotkey
        if (heldModifiers.size > 0) {
            const keys = [...heldModifiers, key];
            send({ action: 'hotkey', keys });
            // Отпускаем модификаторы
            releaseAllModifiers();
        } else {
            send({ action: 'key', key });
        }

        // Визуальная обратная связь
        btn.style.transform = 'scale(0.9)';
        setTimeout(() => btn.style.transform = '', 150);
    });
});

// Готовые комбинации
document.querySelectorAll('.hotkey-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const hotkey = btn.dataset.hotkey;
        if (!hotkey) return;
        const keys = hotkey.split(',');
        send({ action: 'hotkey', keys });

        // Визуальная обратная связь
        btn.style.transform = 'scale(0.9)';
        setTimeout(() => btn.style.transform = '', 150);
    });
});

function releaseAllModifiers() {
    heldModifiers.forEach(mod => {
        send({ action: 'keyup', key: mod });
    });
    heldModifiers.clear();
    document.querySelectorAll('.modifier-btn').forEach(b => b.classList.remove('held'));
}


// ═══════════════════════════════════════════════════════
// Toast
// ═══════════════════════════════════════════════════════

let toastTimeout = null;

function showToast(message) {
    let toast = document.querySelector('.toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.className = 'toast';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');

    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
        toast.classList.remove('show');
    }, 2500);
}
