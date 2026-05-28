// Referencias a elementos del DOM
const player = document.getElementById('player');
const videoInput = document.getElementById('videoInput');
const uploadBtn = document.getElementById('uploadBtn');
const uploadStatus = document.getElementById('uploadStatus');
const transcriptContainer = document.getElementById('transcriptContainer');
const exportBtn = document.getElementById('exportBtn');
const splitBtn = document.getElementById('splitBtn');

// Controles inferiores
const playPauseBtn = document.getElementById('playPauseBtn');
const speedSelect = document.getElementById('speedSelect');
const skipCutsToggle = document.getElementById('skipCutsToggle');
const timelineContainer = document.getElementById('timelineContainer');
const timelineTrack = document.getElementById('timelineTrack');
const playhead = document.getElementById('playhead');

// Thumbnail Hover
const thumbContainer = document.getElementById('thumbContainer');
const thumbVideo = document.getElementById('thumbVideo');
const thumbTime = document.getElementById('thumbTime');

// Estado Global
let currentVideoFilename = null;
let segments = []; 
let videoDuration = 0;

// --- AUTO-GUARDADO (LOCALSTORAGE) ---
function saveState() {
    if (!currentVideoFilename || segments.length === 0) return;
    localStorage.setItem(`videoState_${currentVideoFilename}`, JSON.stringify(segments));
}

function loadState(filename) {
    const saved = localStorage.getItem(`videoState_${filename}`);
    if (saved) {
        segments = JSON.parse(saved);
        return true;
    }
    return false;
}

// --- 1. LÓGICA DE SUBIDA DE VIDEO ---
uploadBtn.addEventListener('click', async () => {
    const file = videoInput.files[0];
    if (!file) return alert('Por favor selecciona un archivo de video primero.');

    const formData = new FormData();
    formData.append('video', file);

    uploadStatus.textContent = 'Procesando en IA (Whisper + Gemini)...';
    uploadStatus.style.color = 'var(--text-muted)';
    uploadBtn.disabled = true;

    try {
        const response = await fetch('/api/upload', {
            method: 'POST',
            body: formData
        });
        const data = await response.json();
        
        if (data.error) throw new Error(data.error);

        currentVideoFilename = data.filename;
        
        if (!loadState(currentVideoFilename)) {
            segments = data.transcript;
            saveState(); 
        }
        
        player.src = data.videoUrl;
        thumbVideo.src = data.videoUrl; 
        
        player.onloadedmetadata = () => {
            videoDuration = player.duration;
            renderTranscript();
            renderTimeline();
            exportBtn.disabled = false;
            splitBtn.disabled = false;
        };

        uploadStatus.textContent = '¡Análisis IA completado!';
        uploadStatus.style.color = '#4ade80';
        
        setTimeout(() => {
            document.getElementById('uploadSection').style.display = 'none';
            transcriptContainer.style.display = 'block';
        }, 1000);

    } catch (err) {
        console.error("Error subiendo video:", err);
        uploadStatus.textContent = 'Error procesando archivo.';
        uploadStatus.style.color = '#ff5555';
        uploadBtn.disabled = false;
    }
});

// --- 2. RENDERIZADO DEL PANEL DE TRANSCRIPCIÓN ---
function renderTranscript() {
    transcriptContainer.innerHTML = '';
    
    segments.forEach((seg, index) => {
        const segEl = document.createElement('div');
        segEl.className = `segment ${seg.isCut ? 'cut' : ''}`;
        segEl.dataset.index = index;
        
        segEl.innerHTML = `
            <div class="segment-header">
                <span>${formatTime(seg.start)} - ${formatTime(seg.end)}</span>
                <button class="toggle-cut-btn" onclick="toggleCut(event, ${index})">
                    ${seg.isCut ? 'Uncut' : 'Cut'}
                </button>
            </div>
            <div class="segment-text">${seg.text}</div>
        `;

        segEl.addEventListener('click', (e) => {
            if (e.target.tagName !== 'BUTTON') {
                player.currentTime = seg.start;
                player.play();
            }
        });

        transcriptContainer.appendChild(segEl);
    });
}

// --- 3. RENDERIZADO DE LÍNEA DE TIEMPO ---
function renderTimeline() {
    timelineTrack.innerHTML = '';
    
    segments.forEach((seg) => {
        const block = document.createElement('div');
        block.className = `timeline-block ${seg.isCut ? 'cut' : ''}`;
        
        const widthPercent = ((seg.end - seg.start) / videoDuration) * 100;
        block.style.width = `${widthPercent}%`;
        
        timelineTrack.appendChild(block);
    });
}

// --- 4. ALTERNAR ESTADO DE CORTE ---
window.toggleCut = function(event, index) {
    event.stopPropagation();
    segments[index].isCut = !segments[index].isCut;
    saveState();
    renderTranscript();
    renderTimeline();
}

// --- 5. LÓGICA SPLIT (Corte Manual) ---
function performSplit() {
    if (!videoDuration) return;
    const ct = player.currentTime;
    
    const activeIndex = segments.findIndex(seg => ct > seg.start && ct < seg.end);
    if (activeIndex === -1) return;
    
    const activeSeg = segments[activeIndex];
    
    if (ct - activeSeg.start < 0.1 || activeSeg.end - ct < 0.1) return;

    const seg1 = { ...activeSeg, end: ct };
    const seg2 = { ...activeSeg, start: ct, id: Date.now() }; 
    
    segments.splice(activeIndex, 1, seg1, seg2);
    
    saveState();
    renderTranscript();
    renderTimeline();
}

splitBtn.addEventListener('click', performSplit);

window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 's' && document.activeElement.tagName !== 'INPUT' && videoDuration) {
        performSplit();
    }
});

// --- 6. DRAGGABLE PLAYHEAD & FREE SCRUBBING EXACTO ---
let isDraggingPlayhead = false;

// Calcula el tiempo relativo a partir del click/arrastre en el track
function seekFromMouseEvent(e) {
    if (!videoDuration) return;
    
    // getBoundingClientRect() garantiza la posición X exacta independientemente de los hijos
    const rect = timelineTrack.getBoundingClientRect();
    let x = e.clientX - rect.left; 
    let percent = x / rect.width;
    
    if (percent < 0) percent = 0;
    if (percent > 1) percent = 1;
    
    player.currentTime = percent * videoDuration;
}

// Click en cualquier lado del contenedor para saltar
timelineContainer.addEventListener('mousedown', (e) => {
    // Solo si el click no es explícitamente en el playhead (que tiene drag)
    if (e.target !== playhead && e.target !== thumbContainer && e.target !== thumbVideo && e.target !== thumbTime) {
        seekFromMouseEvent(e);
    }
});

// Drag & Drop explícito del Playhead
playhead.addEventListener('mousedown', (e) => {
    isDraggingPlayhead = true;
    e.stopPropagation(); // Evita que se propague al contenedor
});

// Escuchas en todo el documento para que el drag no se pierda al mover rápido el mouse
document.addEventListener('mouseup', () => {
    isDraggingPlayhead = false;
});

document.addEventListener('mousemove', (e) => {
    if (!videoDuration) return;
    
    // Si arrastra el cabezal, actualiza el video
    if (isDraggingPlayhead) {
        seekFromMouseEvent(e);
        return; // Salir para no procesar el hover thumbnail simultáneamente
    }
    
    // Lógica para Hover Thumbnail (YouTube style) si no estamos arrastrando el cabezal
    const rect = timelineTrack.getBoundingClientRect();
    let x = e.clientX - rect.left;
    
    // Solo mostramos thumbnail si el cursor está sobre la barra
    if (x >= 0 && x <= rect.width && e.clientY >= rect.top - 20 && e.clientY <= rect.bottom + 20) {
        let percent = x / rect.width;
        const hoverTime = percent * videoDuration;
        
        thumbContainer.style.display = 'block';
        
        let thumbX = e.clientX;
        const thumbWidth = 160; 
        if (thumbX < thumbWidth / 2) thumbX = thumbWidth / 2;
        if (thumbX > window.innerWidth - thumbWidth / 2) thumbX = window.innerWidth - thumbWidth / 2;
        
        thumbContainer.style.left = `${thumbX}px`;
        thumbTime.textContent = formatTime(hoverTime);
        
        if (Math.abs(thumbVideo.currentTime - hoverTime) > 0.5) {
            thumbVideo.currentTime = hoverTime;
        }
    } else {
        thumbContainer.style.display = 'none';
    }
});

timelineContainer.addEventListener('mouseleave', () => {
    if (!isDraggingPlayhead) {
        thumbContainer.style.display = 'none';
    }
});

// --- 7. LÓGICA DE REPRODUCCIÓN EN TIEMPO REAL Y "SKIP CUTS" ---
player.addEventListener('timeupdate', () => {
    if (!videoDuration) return;
    
    const ct = player.currentTime;
    
    const playheadPercent = (ct / videoDuration) * 100;
    playhead.style.left = `calc(20px + ${playheadPercent}%)`;

    const activeIndex = segments.findIndex(seg => ct >= seg.start && ct < seg.end);
    
    // "Skip Cuts"
    if (skipCutsToggle.checked && activeIndex !== -1 && segments[activeIndex].isCut) {
        const nextValidSegment = segments.slice(activeIndex).find(seg => !seg.isCut);
        if (nextValidSegment) {
            player.currentTime = nextValidSegment.start;
        } else {
            player.pause(); 
        }
    }

    // Reactividad Visual
    document.querySelectorAll('.segment').forEach((el, i) => {
        el.classList.toggle('active', i === activeIndex && !segments[i].isCut);
    });
    
    document.querySelectorAll('.timeline-block').forEach((el, i) => {
        el.classList.toggle('active', i === activeIndex && !segments[i].isCut);
    });
});

// --- 8. CONTROLES DEL REPRODUCTOR ---
playPauseBtn.addEventListener('click', () => {
    if (player.paused) player.play();
    else player.pause();
});

player.addEventListener('play', () => playPauseBtn.textContent = '⏸');
player.addEventListener('pause', () => playPauseBtn.textContent = '▶');

speedSelect.addEventListener('change', (e) => {
    player.playbackRate = parseFloat(e.target.value);
});

// --- 9. EXPORTACIÓN DEL VIDEO ---
exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    exportBtn.textContent = 'Procesando en Servidor...';

    try {
        const response = await fetch('/api/process-video', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                filename: currentVideoFilename,
                segments: segments 
            })
        });
        
        const data = await response.json();
        if(data.error) throw new Error(data.error);

        alert('¡El procesamiento FFmpeg ha iniciado!\n\nRevisa el archivo final en: ' + data.outputUrl);
    } catch (err) {
        console.error(err);
        alert('Hubo un error al intentar exportar el video.');
    } finally {
        exportBtn.disabled = false;
        exportBtn.textContent = 'Exportar Edición';
    }
});

function formatTime(seconds) {
    const d = new Date(seconds * 1000);
    return d.toISOString().substring(14, 19); 
}
