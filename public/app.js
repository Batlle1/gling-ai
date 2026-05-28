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
let segments = []; // [{id, text, start, end, isCut}]
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
    if (!file) {
        alert('Por favor selecciona un archivo de video primero.');
        return;
    }

    const formData = new FormData();
    formData.append('video', file);

    uploadStatus.textContent = 'Subiendo y procesando audio (Groq Whisper)...';
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
        
        // Carga desde localStorage si existe edición previa
        if (!loadState(currentVideoFilename)) {
            segments = data.transcript;
            saveState(); // Guarda estado inicial
        }
        
        player.src = data.videoUrl;
        thumbVideo.src = data.videoUrl; // Carga el video oculto para miniaturas
        
        player.onloadedmetadata = () => {
            videoDuration = player.duration;
            renderTranscript();
            renderTimeline();
            exportBtn.disabled = false;
            splitBtn.disabled = false;
        };

        uploadStatus.textContent = '¡Video cargado con éxito!';
        uploadStatus.style.color = '#4ade80';
        
        setTimeout(() => {
            document.getElementById('uploadSection').style.display = 'none';
            transcriptContainer.style.display = 'block';
        }, 1000);

    } catch (err) {
        console.error("Error subiendo video:", err);
        uploadStatus.textContent = 'Error al subir el video.';
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
    
    // Evitar cortes muy pequeños (< 0.1s de los bordes)
    if (ct - activeSeg.start < 0.1 || activeSeg.end - ct < 0.1) return;

    // Dividimos el segmento en dos
    const seg1 = { ...activeSeg, end: ct };
    const seg2 = { ...activeSeg, start: ct, id: Date.now() }; // Nuevo ID para el pedazo restante
    
    segments.splice(activeIndex, 1, seg1, seg2);
    
    saveState();
    renderTranscript();
    renderTimeline();
}

splitBtn.addEventListener('click', performSplit);

// Atajo de teclado 'S'
window.addEventListener('keydown', (e) => {
    // Si el usuario no está en un input y presiona S
    if (e.key.toLowerCase() === 's' && document.activeElement.tagName !== 'INPUT' && videoDuration) {
        performSplit();
    }
});

// --- 6. FREE SCRUBBING Y HOVER THUMBNAIL ---
let isDraggingTimeline = false;

function seekFromMouseEvent(e) {
    if (!videoDuration) return;
    const rect = timelineTrack.getBoundingClientRect();
    // Offset de 20px manejado por el contenedor padre, pero track es exacto
    let x = e.clientX - rect.left; 
    let percent = x / rect.width;
    if (percent < 0) percent = 0;
    if (percent > 1) percent = 1;
    player.currentTime = percent * videoDuration;
}

timelineContainer.addEventListener('mousedown', (e) => {
    isDraggingTimeline = true;
    seekFromMouseEvent(e);
});

window.addEventListener('mouseup', () => {
    isDraggingTimeline = false;
});

timelineContainer.addEventListener('mousemove', (e) => {
    if (!videoDuration) return;
    
    // Si está arrastrando, hacer scrubbing libre
    if (isDraggingTimeline) {
        seekFromMouseEvent(e);
    }
    
    // Lógica para Hover Thumbnail (YouTube style)
    const rect = timelineTrack.getBoundingClientRect();
    let x = e.clientX - rect.left;
    let percent = x / rect.width;
    if (percent < 0) percent = 0;
    if (percent > 1) percent = 1;
    
    const hoverTime = percent * videoDuration;
    
    thumbContainer.style.display = 'block';
    
    // Posicionar contenedor de miniatura sin salirse de la pantalla
    let thumbX = e.clientX;
    const thumbWidth = 160; 
    if (thumbX < thumbWidth / 2) thumbX = thumbWidth / 2;
    if (thumbX > window.innerWidth - thumbWidth / 2) thumbX = window.innerWidth - thumbWidth / 2;
    
    thumbContainer.style.left = `${thumbX}px`;
    thumbTime.textContent = formatTime(hoverTime);
    
    // Actualizar video secundario (limitar frecuencia para mejor rendimiento)
    if (Math.abs(thumbVideo.currentTime - hoverTime) > 0.5) {
        thumbVideo.currentTime = hoverTime;
    }
});

timelineContainer.addEventListener('mouseleave', () => {
    thumbContainer.style.display = 'none';
});

// --- 7. LÓGICA DE REPRODUCCIÓN EN TIEMPO REAL Y "SKIP CUTS" ---
player.addEventListener('timeupdate', () => {
    if (!videoDuration) return;
    
    const ct = player.currentTime;
    
    const playheadPercent = (ct / videoDuration) * 100;
    playhead.style.left = `calc(20px + ${playheadPercent}%)`;

    const activeIndex = segments.findIndex(seg => ct >= seg.start && ct < seg.end);
    
    // "Skip Cuts" Mágico
    if (skipCutsToggle.checked && activeIndex !== -1 && segments[activeIndex].isCut) {
        const nextValidSegment = segments.slice(activeIndex).find(seg => !seg.isCut);
        if (nextValidSegment) {
            player.currentTime = nextValidSegment.start;
        } else {
            player.pause(); 
        }
    }

    // UI Updates Reactivos
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

        alert('¡El procesamiento CFR FFmpeg (filter_complex) ha iniciado!\n\nRevisa el archivo final en: ' + data.outputUrl);
    } catch (err) {
        console.error(err);
        alert('Hubo un error al intentar exportar el video.');
    } finally {
        exportBtn.disabled = false;
        exportBtn.textContent = 'Exportar Edición';
    }
});

// --- UTILIDAD ---
function formatTime(seconds) {
    const d = new Date(seconds * 1000);
    return d.toISOString().substring(14, 19); // Muestra HH:MM:SS de manera simple
}
