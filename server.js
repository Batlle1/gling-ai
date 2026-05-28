require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const { OpenAI } = require('openai');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configuración de OpenAI (Groq Whisper)
const openai = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
});

// Configuración de Google Gemini
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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
const extractAndChunkAudio = (inputPath, baseName) => {
    return new Promise((resolve, reject) => {
        console.log(`Extrayendo y dividiendo audio de ${baseName}...`);
        const outputPattern = path.join(uploadsDir, `${baseName}_audio_%03d.mp3`);
        
        ffmpeg(inputPath)
            .noVideo()
            .audioCodec('libmp3lame')
            .audioBitrate('32k')
            .audioChannels(1)
            .audioFrequency(16000)
            .outputOptions([
                '-f', 'segment',
                '-segment_time', '3600', // Segmentar cada hora
                '-c:a', 'libmp3lame'
            ])
            .on('end', () => {
                const files = fs.readdirSync(uploadsDir)
                    .filter(f => f.startsWith(`${baseName}_audio_`) && f.endsWith('.mp3'))
                    .sort();
                resolve(files.map(f => path.join(uploadsDir, f)));
            })
            .on('error', reject)
            .save(outputPattern);
    });
};

// --- API REAL: Transcripción con Groq Whisper ---
const transcribeAudioWithGroq = async (chunkPath) => {
    console.log(`Transcribiendo con Groq (Whisper-large-v3): ${chunkPath}`);
    const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(chunkPath),
        model: 'whisper-large-v3',
        response_format: 'verbose_json',
    });
    return transcription.segments;
};

// --- API REAL: Análisis Semántico con Gemini 3.1 Pro ---
const analyzeTranscriptWithGemini = async (transcriptText) => {
    console.log("Analizando transcripción con Gemini 3.1 Pro...");
    
    const systemInstruction = "Eres un editor de video experto. Analiza esta transcripción. Devuelve un objeto JSON estructurado donde identifiques muletillas, silencios largos o frases repetidas (tomas malas) marcándolas con 'isCut: true'. Mantén el resto como 'isCut: false'. Devuelve SOLO el arreglo JSON directo (ej. [{\"id\":1, \"text\":\"...\", \"start\":0.0, \"end\":2.5, \"isCut\":false}]), manteniendo exactamente todos los IDs y tiempos originales, solo modificando el campo 'isCut'.";

    const response = await ai.models.generateContent({
        model: 'gemini-3.1-pro',
        contents: transcriptText,
        config: {
            systemInstruction: systemInstruction,
            responseMimeType: 'application/json',
            temperature: 0.1
        }
    });

    try {
        const jsonResult = JSON.parse(response.text);
        return Array.isArray(jsonResult) ? jsonResult : (jsonResult.segments || jsonResult);
    } catch (e) {
        console.error("Error parseando JSON de Gemini:", e);
        return null;
    }
};

// Endpoint POST para la subida inicial del video
app.post('/api/upload', upload.single('video'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No se subió ningún video' });

        const filename = req.file.filename;
        const inputPath = path.join(uploadsDir, filename);
        const baseName = path.basename(filename, path.extname(filename));
        const videoUrl = `/uploads/${filename}`;
        
        // 1. Extraer y picar audio
        const audioChunks = await extractAndChunkAudio(inputPath, baseName);
        
        // 2. Transcripción Secuencial en Groq
        let fullTranscript = [];
        let currentOffset = 0; 
        
        for (let i = 0; i < audioChunks.length; i++) {
            const chunkPath = audioChunks[i];
            const groqSegments = await transcribeAudioWithGroq(chunkPath);
            
            if (groqSegments && groqSegments.length > 0) {
                groqSegments.forEach(seg => {
                    fullTranscript.push({
                        id: Date.now() + Math.random(),
                        text: seg.text,
                        start: currentOffset + seg.start,
                        end: currentOffset + seg.end,
                        isCut: false
                    });
                });
            }
            // FFmpeg -segment_time corta estricto en el tiempo configurado
            currentOffset += 3600; 
        }

        // 3. Análisis en Gemini
        const transcriptJSONString = JSON.stringify(fullTranscript);
        let analyzedTranscript = await analyzeTranscriptWithGemini(transcriptJSONString);

        if (!analyzedTranscript || analyzedTranscript.length === 0) {
            console.warn("Gemini falló al analizar. Retornando transcript crudo de Groq.");
            analyzedTranscript = fullTranscript;
        }

        // Limpieza de MP3 temporales
        audioChunks.forEach(chunk => fs.unlinkSync(chunk));

        res.json({
            message: 'Upload y análisis de IA completado',
            videoUrl: videoUrl,
            filename: filename,
            transcript: analyzedTranscript
        });
    } catch (error) {
        console.error("Error en upload:", error);
        res.status(500).json({ error: 'Fallo al procesar la subida del video' });
    }
});

// Endpoint POST para procesar el video final (Edición Robusta CFR)
app.post('/api/process-video', (req, res) => {
    const { filename, segments } = req.body;
    
    if (!filename || !segments) return res.status(400).json({ error: 'Faltan parámetros' });

    const inputPath = path.join(uploadsDir, filename);
    const outputPath = path.join(uploadsDir, `edited-${filename}`);
    const keptSegments = segments.filter(seg => !seg.isCut);

    if (keptSegments.length === 0) return res.status(400).json({ error: 'Sin segmentos válidos' });

    console.log(`Iniciando procesamiento CFR con filter_complex para: ${filename}`);

    let filterComplex = [];
    let concatInputs = [];

    keptSegments.forEach((seg, i) => {
        filterComplex.push(`[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS[v${i}]`);
        filterComplex.push(`[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${i}]`);
        concatInputs.push(`[v${i}][a${i}]`);
    });

    const concatFilter = `${concatInputs.join('')}concat=n=${keptSegments.length}:v=1:a=1[outv][outa]`;
    filterComplex.push(concatFilter);

    ffmpeg(inputPath)
        .complexFilter(filterComplex)
        .outputOptions([
            '-map', '[outv]',
            '-map', '[outa]',
            '-fps_mode', 'cfr', 
            '-async', '1',      
            '-c:v', 'libx264',  
            '-preset', 'fast',
            '-c:a', 'aac'
        ])
        .on('end', () => console.log(`Guardado en: ${outputPath}`))
        .on('error', (err) => console.error('Error FFmpeg:', err))
        .save(outputPath);

    res.json({ message: 'Procesamiento CFR iniciado', outputUrl: `/uploads/edited-${filename}` });
});

app.listen(port, () => console.log(`Server escuchando en ${port}`));
