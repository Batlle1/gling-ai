require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');

const app = express();
const port = process.env.PORT || 3000;

// Configuración de middlewares
// Permitimos payloads grandes para el envío del JSON final
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Asegurar que exista el directorio de uploads en el host/contenedor
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configuración de Multer para manejar Chunked Uploads de archivos grandes (e.g. 20GB)
// Esto guarda directamente al disco en el volumen mapeado sin saturar la RAM del contenedor
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        // Generar un nombre único para evitar colisiones
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 20 * 1024 * 1024 * 1024 } // Límite de 20GB para archivos crudos
});

// Endpoint POST para la subida inicial del video
app.post('/api/upload', upload.single('video'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No se subió ningún video' });
        }

        const videoUrl = `/uploads/${req.file.filename}`;
        
        // --- SIMULACIÓN DE API DE TRANSCRIPCIÓN (Whisper/OpenAI o Gemini) ---
        // En una implementación de producción real, aquí se llamaría al modelo de IA 
        // para transcribir el audio, extraer tiempos y retornar la estructura en JSON.
        // Simularemos un script de muestra (con algunos segmentos propuestos para corte).
        const mockTranscript = [
            { id: 1, text: "Hola y bienvenidos a este nuevo tutorial.", start: 0.0, end: 2.5, isCut: false },
            { id: 2, text: "Eeeh...", start: 2.5, end: 4.0, isCut: true }, // Silencio o muletilla detectada por IA
            { id: 3, text: "Hoy aprenderemos a construir un clon de Gling AI.", start: 4.0, end: 7.0, isCut: false },
            { id: 4, text: "mmmm... bueno...", start: 7.0, end: 9.0, isCut: true }, // Silencio o muletilla detectada por IA
            { id: 5, text: "Usando Docker y Node.js de forma eficiente.", start: 9.0, end: 12.0, isCut: false }
        ];

        res.json({
            message: 'Upload completado con éxito',
            videoUrl: videoUrl,
            filename: req.file.filename,
            transcript: mockTranscript
        });
    } catch (error) {
        console.error("Error en upload:", error);
        res.status(500).json({ error: 'Fallo al procesar la subida del video' });
    }
});

// Endpoint POST para procesar el video final (edición no destructiva)
app.post('/api/process-video', (req, res) => {
    const { filename, segments } = req.body;
    
    if (!filename || !segments) {
        return res.status(400).json({ error: 'Nombre de archivo y segmentos son requeridos' });
    }

    const inputPath = path.join(__dirname, 'uploads', filename);
    const outputPath = path.join(__dirname, 'uploads', `edited-${filename}`);

    // Solo mantenemos los segmentos que el usuario NO marcó como cortados (isCut: false)
    const keptSegments = segments.filter(seg => !seg.isCut);

    if (keptSegments.length === 0) {
        return res.status(400).json({ error: 'No hay segmentos válidos para exportar' });
    }

    // Construir la cadena de filtros 'select' y 'aselect' para fluent-ffmpeg
    // Ejemplo: between(t,0,2.5)+between(t,4.0,7.0)
    let videoSelects = [];
    let audioSelects = [];

    keptSegments.forEach(seg => {
        const expr = `between(t,${seg.start},${seg.end})`;
        videoSelects.push(expr);
        audioSelects.push(expr);
    });

    // Combinamos las expresiones. setpts restablece los timestamps para no tener pausas negras.
    const videoFilter = `select='${videoSelects.join('+')}',setpts=N/FRAME_RATE/TB`;
    const audioFilter = `aselect='${audioSelects.join('+')}',asetpts=N/SR/TB`;

    console.log(`Iniciando procesamiento de video: ${filename}`);

    // Ejecución asíncrona de FFmpeg
    ffmpeg(inputPath)
        .outputOptions([
            '-vf', videoFilter,
            '-af', audioFilter,
            '-async', '1' // Mantiene el audio y video sincronizados tras cortes agresivos
        ])
        .on('end', () => {
            console.log(`Procesamiento finalizado exitosamente. Guardado en: ${outputPath}`);
        })
        .on('error', (err) => {
            console.error('Error durante el procesamiento con FFmpeg:', err);
        })
        .save(outputPath);

    // Retorna inmediatamente al frontend para no bloquear la solicitud
    res.json({ 
        message: 'Procesamiento de video iniciado asíncronamente',
        outputUrl: `/uploads/edited-${filename}`
    });
});

app.listen(port, () => {
    console.log(`Servidor de AI Video Editor escuchando en el puerto ${port}`);
});
