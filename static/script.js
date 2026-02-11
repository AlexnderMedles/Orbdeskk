// ═══ Элементы ═══
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

// ═══ Навигация ═══
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
// ПОДКЛЮЧЕНИЕ
// ═══════════════════════════════════════════════════════

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
    };

    ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
            // Бинарный кадр экрана
            const blob = new Blob([e.data], { type: 'image/jpeg' });
            const url = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = () => {
                if (canvas.width !== img.width || canvas.height !== img.height) {
                    canvas.width = img.width;
                    canvas.height = img.height;
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
    };
}

function updateControlBadge(allowed) {
    controlBadge.className = 'control-badge ' + (allowed ? 'allowed' : 'denied');
    controlBadge.textContent = allowed ? '🎮 Управление' : '👁️ Просмотр';
}

document.getElementById('close-session').addEventListener('click', () => {
    if (ws) ws.close();
    ws = null;
    sessionCode = '';
    showPage('landing');
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

canvas.addEventListener('wheel', (e) => {
    if (!controlAllowed) return;
    e.preventDefault();
    send({ action: 'scroll', delta: e.deltaY > 0 ? -3 : 3 });
}, { passive: false });

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
    if (!pages.remote.classList.contains('active') || !controlAllowed) return;
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
