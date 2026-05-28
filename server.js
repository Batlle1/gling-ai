require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 20 * 1024 * 1024 * 1024 } // 20GB Limit
});

// --- EXTRACCIÓN DE AUDIO Y CHUNKING (Optimizado para Groq 25MB) ---
// Extrae el audio a MP3 (32kbps, Mono, 16kHz) para compresión extrema.
// Además usa el muxer de segmentos para dividir el audio cada 3600 segundos (1 hora).
const extractAndChunkAudio = (inputPath, baseName) => {
    return new Promise((resolve, reject) => {
        console.log(`Extrayendo y dividiendo audio de ${baseName}...`);
        const outputPattern = path.join(uploadsDir, `${baseName}_audio_%03d.mp3`);
        
        ffmpeg(inputPath)
            .noVideo()
            .audioCodec('libmp3lame')
            .audioBitrate('32k')       // Compresión extrema para Groq API
            .audioChannels(1)          // Mono
            .audioFrequency(16000)     // Frecuencia recomendada para Whisper
            .outputOptions([
                '-f', 'segment',
                '-segment_time', '3600', // 3600s = 1 hr (aprox 14MB en 32kbps)
                '-c:a', 'libmp3lame'
            ])
            .on('end', () => {
                console.log(`Audio extraído y dividido para ${baseName}`);
                // Buscar los archivos generados
                const files = fs.readdirSync(uploadsDir)
                    .filter(f => f.startsWith(`${baseName}_audio_`) && f.endsWith('.mp3'))
                    .sort();
                resolve(files.map(f => path.join(uploadsDir, f)));
            })
            .on('error', (err) => {
                console.error("Error extrayendo audio:", err);
                reject(err);
            })
            .save(outputPattern);
    });
};

// Simulador de API de Transcripción (Groq/Whisper) secuencial
const mockTranscribeAudioChunks = async (audioChunks) => {
    let fullTranscript = [];
    let currentOffset = 0; // Segundos acumulados

    // Simulamos un proceso secuencial
    for (let i = 0; i < audioChunks.length; i++) {
        const chunkPath = audioChunks[i];
        console.log(`Transcribiendo chunk: ${chunkPath} (offset: ${currentOffset}s)`);
        
        // Simulación: Cada chunk genera un par de segmentos.
        // En la vida real, sumarías currentOffset al 'start' y 'end' del JSON retornado por Groq.
        fullTranscript.push(
            { id: Date.now() + Math.random(), text: `Segmento 1 del chunk ${i}.`, start: currentOffset + 0.0, end: currentOffset + 2.5, isCut: false },
            { id: Date.now() + Math.random(), text: `Eeeh (silencio)...`, start: currentOffset + 2.5, end: currentOffset + 4.0, isCut: true },
            { id: Date.now() + Math.random(), text: `Continuamos el video.`, start: currentOffset + 4.0, end: currentOffset + 10.0, isCut: false }
        );

        // Supongamos que en la simulación el chunk dura 3600s, 
        // pero para esta maqueta avanzamos el offset un valor fijo solo para demostrar.
        currentOffset += 3600; 
    }

    return fullTranscript;
};

// Endpoint POST para la subida inicial del video
app.post('/api/upload', upload.single('video'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No se subió ningún video' });

        const filename = req.file.filename;
        const inputPath = path.join(uploadsDir, filename);
        const baseName = path.basename(filename, path.extname(filename));
        const videoUrl = `/uploads/${filename}`;
        
        // Ejecutamos la extracción y división (Chunking) del audio
        const audioChunks = await extractAndChunkAudio(inputPath, baseName);
        
        // Enviamos los chunks secuencialmente a la API
        const fullTranscript = await mockTranscribeAudioChunks(audioChunks);

        res.json({
            message: 'Upload y análisis completado con éxito',
            videoUrl: videoUrl,
            filename: filename,
            transcript: fullTranscript
        });
    } catch (error) {
        console.error("Error en upload:", error);
        res.status(500).json({ error: 'Fallo al procesar la subida del video' });
    }
});

// Endpoint POST para procesar el video final (Edición Robusta CFR)
app.post('/api/process-video', (req, res) => {
    const { filename, segments } = req.body;
    
    if (!filename || !segments) {
        return res.status(400).json({ error: 'Nombre de archivo y segmentos son requeridos' });
    }

    const inputPath = path.join(uploadsDir, filename);
    const outputPath = path.join(uploadsDir, `edited-${filename}`);

    const keptSegments = segments.filter(seg => !seg.isCut);

    if (keptSegments.length === 0) {
        return res.status(400).json({ error: 'No hay segmentos válidos para exportar' });
    }

    console.log(`Iniciando procesamiento CFR con filter_complex para: ${filename}`);

    // --- CORRECCIÓN DE DESINCRONIZACIÓN DE FFMPEG (filter_complex) ---
    // En lugar de select/aselect, usamos trim, setpts, y concat. 
    // Esto es mucho más preciso y forzoso para evitar desincronizaciones en videos largos (ej. OBS).
    
    let filterComplex = [];
    let concatInputs = [];

    keptSegments.forEach((seg, i) => {
        // Cortar Video: Usamos trim, y luego reseteamos los PTS (Presentation TimeStamp) a cero
        filterComplex.push(`[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS[v${i}]`);
        
        // Cortar Audio: Usamos atrim, y reseteamos PTS
        filterComplex.push(`[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${i}]`);
        
        // Etiquetamos las entradas para el filtro de concatenación
        concatInputs.push(`[v${i}][a${i}]`);
    });

    // Filtro de concatenación
    // n = número de segmentos, v = 1 stream de video, a = 1 stream de audio
    const concatFilter = `${concatInputs.join('')}concat=n=${keptSegments.length}:v=1:a=1[outv][outa]`;
    filterComplex.push(concatFilter);

    // Ejecución asíncrona de FFmpeg
    ffmpeg(inputPath)
        .complexFilter(filterComplex)
        .outputOptions([
            '-map', '[outv]',
            '-map', '[outa]',
            '-fps_mode', 'cfr', // Fuerza Constant Framerate (antes -vsync 1)
            '-async', '1',      // Fuerza la sincronización de audio extendiendo o acortando muestras
            '-c:v', 'libx264',  // Re-encode asegurado para estabilidad
            '-preset', 'fast',
            '-c:a', 'aac'
        ])
        .on('start', (cmd) => console.log('FFmpeg Cmd:', cmd))
        .on('end', () => {
            console.log(`Procesamiento finalizado exitosamente. Guardado en: ${outputPath}`);
        })
        .on('error', (err) => {
            console.error('Error durante el procesamiento con FFmpeg:', err);
        })
        .save(outputPath);

    // Retorna inmediatamente al frontend
    res.json({ 
        message: 'Procesamiento de video CFR iniciado asíncronamente',
        outputUrl: `/uploads/edited-${filename}`
    });
});

app.listen(port, () => {
    console.log(`Servidor de AI Video Editor escuchando en el puerto ${port}`);
});
