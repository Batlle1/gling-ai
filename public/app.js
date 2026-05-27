// Referencias a elementos del DOM
const player = document.getElementById('player');
const videoInput = document.getElementById('videoInput');
const uploadBtn = document.getElementById('uploadBtn');
const uploadStatus = document.getElementById('uploadStatus');
const transcriptContainer = document.getElementById('transcriptContainer');
const exportBtn = document.getElementById('exportBtn');

// Controles inferiores
const playPauseBtn = document.getElementById('playPauseBtn');
const speedSelect = document.getElementById('speedSelect');
const skipCutsToggle = document.getElementById('skipCutsToggle');
const timelineTrack = document.getElementById('timelineTrack');
const playhead = document.getElementById('playhead');

// Estado Global
let currentVideoFilename = null;
let segments = []; // [{id, text, start, end, isCut}]
let videoDuration = 0;

// --- 1. LÓGICA DE SUBIDA DE VIDEO ---
uploadBtn.addEventListener('click', async () => {
    const file = videoInput.files[0];
    if (!file) {
        alert('Por favor selecciona un archivo de video primero.');
        return;
    }

    const formData = new FormData();
    formData.append('video', file);

    uploadStatus.textContent = 'Subiendo y analizando video...';
    uploadStatus.style.color = 'var(--text-muted)';
    uploadBtn.disabled = true;

    try {
        const response = await fetch('/api/upload', {
            method: 'POST',
            body: formData
        });
        const data = await response.json();
        
        if (data.error) throw new Error(data.error);

        // Guardamos el estado recibido desde el backend
        currentVideoFilename = data.filename;
        segments = data.transcript;
        
        // Cargamos el video en el reproductor HTML5
        player.src = data.videoUrl;
        
        // Cuando los metadatos del video cargan, calculamos la duración y renderizamos la UI
        player.onloadedmetadata = () => {
            videoDuration = player.duration;
            renderTranscript();
            renderTimeline();
            exportBtn.disabled = false;
        };

        // Actualización visual post-subida
        uploadStatus.textContent = '¡Video cargado con éxito!';
        uploadStatus.style.color = '#4ade80'; // Verde
        
        // Ocultamos sección de subida y mostramos el transcript
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

// --- 2. RENDERIZADO DEL PANEL DE TRANSCRIPCIÓN (IZQUIERDA) ---
function renderTranscript() {
    transcriptContainer.innerHTML = '';
    
    segments.forEach((seg, index) => {
        // Creación del bloque de segmento
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

        // Evento: Al hacer clic en el texto, el video salta a ese segundo (Seek)
        segEl.addEventListener('click', (e) => {
            // Evita conflictos si se hace clic explícitamente en el botón de Cut/Uncut
            if (e.target.tagName !== 'BUTTON') {
                player.currentTime = seg.start;
                player.play();
            }
        });

        transcriptContainer.appendChild(segEl);
    });
}

// --- 3. RENDERIZADO DE LÍNEA DE TIEMPO (ABAJO) ---
function renderTimeline() {
    timelineTrack.innerHTML = '';
    
    // Los bloques son proporcionales a la duración del video
    segments.forEach((seg) => {
        const block = document.createElement('div');
        block.className = `timeline-block ${seg.isCut ? 'cut' : ''}`;
        
        const widthPercent = ((seg.end - seg.start) / videoDuration) * 100;
        block.style.width = `${widthPercent}%`;
        
        // Evento de búsqueda por línea de tiempo
        block.addEventListener('click', () => {
            player.currentTime = seg.start;
        });

        timelineTrack.appendChild(block);
    });
}

// --- 4. FUNCIÓN GLOBAL: ALTERNAR ESTADO DE CORTE (CUT/UNCUT) ---
window.toggleCut = function(event, index) {
    event.stopPropagation(); // Evitar el trigger del salto de video
    
    // Alterna el estado booleano
    segments[index].isCut = !segments[index].isCut;
    
    // Renderiza reactivamente
    renderTranscript();
    renderTimeline();
}

// --- 5. LÓGICA DE REPRODUCCIÓN EN TIEMPO REAL Y "SKIP CUTS" ---
player.addEventListener('timeupdate', () => {
    if (!videoDuration) return;
    
    const ct = player.currentTime;
    
    // Mueve visualmente el playhead (rojo)
    const playheadPercent = (ct / videoDuration) * 100;
    playhead.style.left = `calc(20px + ${playheadPercent}%)`;

    // Detecta el segmento activo en este milisegundo exacto
    const activeIndex = segments.findIndex(seg => ct >= seg.start && ct < seg.end);
    
    // CORE LOGIC: "Skip Cuts"
    // Si el usuario tiene el toggle activado y el segmento actual está marcado como cortado
    if (skipCutsToggle.checked && activeIndex !== -1 && segments[activeIndex].isCut) {
        
        // Buscar el próximo segmento en el arreglo que NO esté cortado
        const nextValidSegment = segments.slice(activeIndex).find(seg => !seg.isCut);
        
        if (nextValidSegment) {
            // Efectúa el salto mágico instantáneo
            player.currentTime = nextValidSegment.start;
        } else {
            // Si no hay más segmentos válidos, pausa el video.
            player.pause(); 
        }
    }

    // Actualiza UI: Resalta el segmento activo actual (sincronía visual)
    document.querySelectorAll('.segment').forEach((el, i) => {
        el.classList.toggle('active', i === activeIndex && !segments[i].isCut);
    });
    
    document.querySelectorAll('.timeline-block').forEach((el, i) => {
        el.classList.toggle('active', i === activeIndex && !segments[i].isCut);
    });
});

// --- 6. CONTROLES DEL REPRODUCTOR ---
playPauseBtn.addEventListener('click', () => {
    if (player.paused) {
        player.play();
    } else {
        player.pause();
    }
});

// Sincronizar el ícono del botón
player.addEventListener('play', () => playPauseBtn.textContent = '⏸');
player.addEventListener('pause', () => playPauseBtn.textContent = '▶');

// Control de velocidad
speedSelect.addEventListener('change', (e) => {
    player.playbackRate = parseFloat(e.target.value);
});

// --- 7. EXPORTACIÓN DEL VIDEO ---
exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    exportBtn.textContent = 'Procesando en Servidor...';

    try {
        const response = await fetch('/api/process-video', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                filename: currentVideoFilename,
                segments: segments // Enviamos el JSON actualizado
            })
        });
        
        const data = await response.json();
        if(data.error) throw new Error(data.error);

        alert('¡El procesamiento FFmpeg ha iniciado en el backend!\n\nRevisa el archivo final en: ' + data.outputUrl);
    } catch (err) {
        console.error(err);
        alert('Hubo un error al intentar exportar el video.');
    } finally {
        exportBtn.disabled = false;
        exportBtn.textContent = 'Exportar Edición';
    }
});

// --- UTILIDAD ---
// Formatea segundos (ej: 65) a formato de tiempo (ej: "01:05")
function formatTime(seconds) {
    const d = new Date(seconds * 1000);
    return d.toISOString().substring(14, 19);
}
