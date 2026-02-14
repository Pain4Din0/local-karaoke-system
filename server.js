const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

// --- Advanced settings (yt-dlp, demucs, ffmpeg, etc.) ---
const ADVANCED_CONFIG_PATH = path.join(__dirname, 'advanced-config.json');

const DEFAULT_ADVANCED_CONFIG = {
    ytdlp: {
        videoFormat: 'bestvideo[ext=mp4]/bestvideo',
        audioFormat: 'bestaudio[ext=m4a]/bestaudio',
        concurrentFragments: 16,
        httpChunkSize: '10M',
        noPlaylist: true,
        proxy: '',
        socketTimeout: 0,
        retries: 10,
        fragmentRetries: 10,
        userAgent: '',
        extractorArgs: '',
        postprocessorArgs: '',
        noCheckCertificates: false,
        limitRate: '',
        geoBypass: true,
        addHeader: [],
        mergeOutputFormat: '',
        flatPlaylist: true,
        dumpJson: true,
        noWarnings: false,
        ignoreErrors: false,
        abortOnError: false,
        noPart: false,
        restrictFilenames: false,
        windowsFilenames: false,
        noOverwrites: false,
        forceIPv4: false,
        forceIPv6: false,
    },
    demucs: {
        model: 'htdemucs',
        twoStems: 'vocals',
        outputFormat: 'mp3',
        overlap: 0.25,
        segment: 7.8,
        shifts: 1,
        overlapOutput: false,
        float32: false,
        clipMode: 'rescale',
        noSegment: false,
        jobs: 0,
        device: '',
        repo: '',
    },
    ffmpeg: {
        loudnessI: -16,
        loudnessTP: -1.5,
        loudnessLRA: 11,
        loudnessGainClamp: 12,
    },
    system: {
        deleteDelayMs: 20000,
        maxConcurrentDownloads: 1,
    },
};

let advancedConfig = null;

function loadAdvancedConfig() {
    try {
        if (fs.existsSync(ADVANCED_CONFIG_PATH)) {
            const raw = fs.readFileSync(ADVANCED_CONFIG_PATH, 'utf8');
            const loaded = JSON.parse(raw);
            advancedConfig = deepMerge({ ...DEFAULT_ADVANCED_CONFIG }, loaded);
            return advancedConfig;
        }
    } catch (e) {
        console.error('[Config] Failed to load advanced-config.json:', e.message);
    }
    advancedConfig = JSON.parse(JSON.stringify(DEFAULT_ADVANCED_CONFIG));
    return advancedConfig;
}

function deepMerge(target, source) {
    if (!source || typeof source !== 'object') return target;
    for (const key of Object.keys(source)) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) && source[key] !== null) {
            if (!target[key] || typeof target[key] !== 'object') target[key] = {};
            deepMerge(target[key], source[key]);
        } else if (source[key] !== undefined && source[key] !== null) {
            target[key] = source[key];
        }
    }
    return target;
}

function saveAdvancedConfig(config) {
    try {
        const toSave = deepMerge(JSON.parse(JSON.stringify(DEFAULT_ADVANCED_CONFIG)), config);
        fs.writeFileSync(ADVANCED_CONFIG_PATH, JSON.stringify(toSave, null, 2), 'utf8');
        advancedConfig = toSave;
        return true;
    } catch (e) {
        console.error('[Config] Failed to save advanced-config.json:', e.message);
        return false;
    }
}

function getAdvancedConfig() {
    if (!advancedConfig) loadAdvancedConfig();
    return JSON.parse(JSON.stringify(advancedConfig));
}

function resetAdvancedConfigToDefault() {
    try {
        advancedConfig = JSON.parse(JSON.stringify(DEFAULT_ADVANCED_CONFIG));
        fs.writeFileSync(ADVANCED_CONFIG_PATH, JSON.stringify(advancedConfig, null, 2), 'utf8');
        console.log('[Config] Restored default advanced settings');
        return true;
    } catch (e) {
        console.error('[Config] Failed to reset advanced config:', e.message);
        return false;
    }
}

loadAdvancedConfig();

let playlist = [];
let history = [];
let currentPlaying = null;
let isDownloading = false;
let playerStatus = { playing: false, currentTime: 0, duration: 0, volume: 0.8, pitch: 0, vocalRemoval: false };
let autoProcessKaraoke = false; // Global setting: auto-process songs for karaoke
// let karaokeProcessingQueue = []; // Removed in favor of dynamic scanning
let isProcessingKaraoke = false;
let currentDownloadingId = null; // Track specific song ID for download synchronization

// --- Demucs-based Vocal Separation ---
const SEPARATED_DIR = path.join(__dirname, 'separated');
if (!fs.existsSync(SEPARATED_DIR)) fs.mkdirSync(SEPARATED_DIR);

// Detect Python executable (portable version takes priority)
const PORTABLE_PYTHON = path.join(__dirname, 'python', 'python.exe');
const PYTHON_EXE = fs.existsSync(PORTABLE_PYTHON) ? PORTABLE_PYTHON : 'python';

// Track active processes for termination
const activeKaraokeProcesses = new Map(); // songId -> { proc, song }
const activeDownloads = new Map(); // songId -> proc

const cleanupSeparatedFiles = (songId) => {
    const modelName = (advancedConfig && advancedConfig.demucs && advancedConfig.demucs.model) ? advancedConfig.demucs.model : 'htdemucs';
    const songSeparatedDir = path.join(SEPARATED_DIR, modelName, `${songId}_audio`);
    if (fs.existsSync(songSeparatedDir)) {
        try {
            fs.rmSync(songSeparatedDir, { recursive: true, force: true });
            console.log(`[Karaoke] Cleaned up: ${songSeparatedDir}`);
        } catch (e) {
            console.error(`[Karaoke] Cleanup failed: ${e.message}`);
        }
    }
};

const terminateKaraokeProcess = (songId) => {
    const activeProc = activeKaraokeProcesses.get(songId);
    if (activeProc) {
        console.log(`[Karaoke] Terminating process for song ${songId}`);
        try {
            // Kill the process tree on Windows
            spawn('taskkill', ['/pid', activeProc.proc.pid, '/f', '/t'], { shell: true });
        } catch (e) {
            try { activeProc.proc.kill('SIGKILL'); } catch (e2) { }
        }
        activeProc.song.karaokeProcessing = false;
        activeProc.song.karaokeProgress = 0;
        activeKaraokeProcesses.delete(songId);
        cleanupSeparatedFiles(songId);
    }
    // Also remove from manual queue if pending
    const queueIdx = manualKaraokeQueue.findIndex(s => s && s.id === songId);
    if (queueIdx !== -1) {
        manualKaraokeQueue.splice(queueIdx, 1);
    }
};



const processVocalSeparation = (song) => {

    // Use audio-only file for faster Demucs processing
    const audioPath = song.localAudioPath;
    if (!song || !audioPath || !fs.existsSync(audioPath)) return;
    if (song.karaokeReady || song.karaokeProcessing) return;

    song.karaokeProcessing = true;
    song.karaokeProgress = 0;
    console.log(`[Karaoke] Processing audio: ${path.basename(audioPath)}`);
    io.emit('sync_state', { playlist, currentPlaying, playerStatus, history, autoProcessKaraoke });

    const dcfg = getAdvancedConfig().demucs;
    const args = ['-n', dcfg.model || 'htdemucs', '-o', SEPARATED_DIR];
    if (dcfg.twoStems) args.push('--two-stems', dcfg.twoStems);
    if (dcfg.outputFormat === 'mp3') args.push('--mp3');
    else if (dcfg.outputFormat) args.push('--mp3'); // default to mp3 for karaoke
    if (dcfg.overlap != null && dcfg.overlap !== 0.25) args.push('--overlap', String(dcfg.overlap));
    if (dcfg.segment != null && dcfg.segment !== 7.8) args.push('--segment', String(dcfg.segment));
    if (dcfg.shifts != null && dcfg.shifts !== 1) args.push('--shifts', String(dcfg.shifts));
    if (dcfg.overlapOutput) args.push('--overlap-output');
    if (dcfg.float32) args.push('--float32');
    if (dcfg.clipMode) args.push('--clip-mode', dcfg.clipMode);
    if (dcfg.noSegment) args.push('--no-segment');
    if (dcfg.jobs) args.push('--jobs', String(dcfg.jobs));
    if (dcfg.device) args.push('--device', dcfg.device);
    if (dcfg.repo) args.push('--repo', dcfg.repo);
    args.push(audioPath);

    // Use python -m demucs to ensure it works with portable Python
    const proc = spawn(PYTHON_EXE, ['-m', 'demucs', ...args], { shell: true });
    activeKaraokeProcesses.set(song.id, { proc, song });

    proc.stderr.on('data', (data) => {
        const line = data.toString();
        // Parse progress from Demucs output (e.g., "50%|...")
        const progressMatch = line.match(/(\d+(?:\.\d+)?)\s*%/);
        if (progressMatch) {
            const progress = Math.min(99, Math.round(parseFloat(progressMatch[1])));
            if (progress > (song.karaokeProgress || 0)) {
                song.karaokeProgress = progress;
                io.emit('karaoke_progress', { id: song.id, progress });
            }
        }
        if (line.trim()) console.log(`[Demucs] ${line.trim()}`);
    });

    proc.on('close', (code) => {
        activeKaraokeProcesses.delete(song.id);
        song.karaokeProcessing = false;

        if (code === 0) {
            const modelName = (getAdvancedConfig().demucs || {}).model || 'htdemucs';
            const noVocalsPath = path.join(SEPARATED_DIR, modelName, `${song.id}_audio`, 'no_vocals.mp3');
            if (fs.existsSync(noVocalsPath)) {
                const karaokePath = path.join(DOWNLOAD_DIR, `${song.id}_karaoke.mp3`);
                fs.copyFileSync(noVocalsPath, karaokePath);
                song.karaokeSrc = `/downloads/${song.id}_karaoke.mp3?t=${Date.now()}`;
                song.karaokeReady = true;
                song.karaokeProgress = 100;
                console.log(`[Karaoke] Ready: ${song.title}`);
                // Cleanup separated files after successful copy
                cleanupSeparatedFiles(song.id);
            } else {
                console.error(`[Karaoke] Output not found: ${noVocalsPath}`);
            }
        } else if (code !== null) {
            console.error(`[Karaoke] Failed with code ${code}`);
            cleanupSeparatedFiles(song.id);
        }
        io.emit('sync_state', { playlist, currentPlaying, playerStatus, history, autoProcessKaraoke });
        isProcessingKaraoke = false; // Reset flag to allow next process
        processNextKaraoke();
    });

    proc.on('error', (err) => {
        activeKaraokeProcesses.delete(song.id);
        song.karaokeProcessing = false;
        song.karaokeProgress = 0;
        console.error(`[Karaoke] Spawn error: ${err.message}`);
        cleanupSeparatedFiles(song.id);
        isProcessingKaraoke = false; // Reset flag to allow next process
        processNextKaraoke();
    });
};


let manualKaraokeQueue = []; // Queue for manually triggered processing (high priority)

// ... existing code ...

const processNextKaraoke = () => {
    if (isProcessingKaraoke) return;

    // 1. Check manual queue first (High Priority)
    if (manualKaraokeQueue.length > 0) {
        const nextSong = manualKaraokeQueue.shift();
        if (nextSong && nextSong.status === 'ready' && !nextSong.karaokeReady && !nextSong.karaokeProcessing) {
            isProcessingKaraoke = true;
            processVocalSeparation(nextSong);
            return;
        } else {
            // Invalid entry in manual queue, try next
            processNextKaraoke();
            return;
        }
    }

    // 2. Check auto-process queue (Playlist Order)
    if (autoProcessKaraoke) {
        // Find the first song in playlist (or current) that needs processing
        // Order: Current Song -> Playlist [0] -> Playlist [1] ...
        const candidates = [currentPlaying, ...playlist].filter(s => s && s.status === 'ready' && !s.karaokeReady && !s.karaokeProcessing);

        if (candidates.length > 0) {
            const nextSong = candidates[0];
            isProcessingKaraoke = true;
            processVocalSeparation(nextSong);
            return;
        }
    }

    // No candidates found
    isProcessingKaraoke = false;
};

const queueKaraokeProcessing = (song, prioritize = false) => {
    if (!song || song.karaokeReady || song.karaokeProcessing) return;

    if (prioritize) {
        // Add to manual queue if not already there
        if (!manualKaraokeQueue.find(s => s.id === song.id)) {
            manualKaraokeQueue.push(song);
        }
    }

    // Always try to process next (trigger check)
    if (!isProcessingKaraoke) processNextKaraoke();
};

const queueAllReadySongsForKaraoke = () => {
    // Just trigger the processor, it will scan the list if autoProcess is on
    if (!isProcessingKaraoke) processNextKaraoke();
};

// --- Get all available network interfaces ---
const getNetworkInterfaces = () => {
    const nets = os.networkInterfaces();
    const results = [];

    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            // Skip non-IPv4 and internal addresses
            if (net.family === 'IPv4' && !net.internal) {
                results.push({
                    name: name, // Network interface name (e.g., Wi-Fi, Ethernet)
                    ip: net.address
                });
            }
        }
    }
    return results.length > 0 ? results : [{ name: 'Localhost', ip: '127.0.0.1' }];
};

// --- Get connected WiFi SSID (Reference only) ---
const getWifiSSID = () => {
    return new Promise((resolve) => {
        exec('netsh wlan show interfaces', (error, stdout) => {
            if (error) return resolve('Unknown Network');
            const match = stdout.match(/SSID\s*:\s*(.+)/);
            if (match && match[1]) {
                resolve(match[1].trim());
            } else {
                resolve('Wired / Hotspot');
            }
        });
    });
};

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use('/downloads', express.static(DOWNLOAD_DIR));

const processDownloadQueue = () => {
    const maxConcurrent = Math.max(1, Math.min(5, (getAdvancedConfig().system || {}).maxConcurrentDownloads || 1));
    const activeCount = activeDownloads.size;
    if (activeCount >= maxConcurrent) return;

    const pending = [];
    if (currentPlaying && currentPlaying.status === 'pending') pending.push(currentPlaying);
    playlist.forEach(s => { if (s && s.status === 'pending') pending.push(s); });
    for (const song of pending) {
        if (activeDownloads.has(song.id)) continue;
        if (activeDownloads.size >= maxConcurrent) break;
        startDownload(song);
    }
};

const getCookiesPath = (url) => {
    if (url.includes('bilibili.com')) {
        const p = path.join(__dirname, 'cookies_bilibili.txt');
        return fs.existsSync(p) ? p : null;
    }
    if (url.includes('youtube.com') || url.includes('youtu.be')) {
        const p = path.join(__dirname, 'cookies_youtube.txt');
        return fs.existsSync(p) ? p : null;
    }
    return null;
};

const startDownload = (song) => {
    if (activeDownloads.has(song.id)) return;
    const isCurrent = currentPlaying && currentPlaying.id === song.id;
    if (isCurrent) {
        isDownloading = true;
        currentDownloadingId = song.id;
    }
    song.status = 'downloading';
    song.progress = 0;
    io.emit('sync_state', { playlist, currentPlaying, playerStatus, history });

    console.log(`[System] Downloading: ${song.title}`);

    // New file structure: separate video and audio
    const videoFilename = `${song.id}_video.mp4`;
    const audioFilename = `${song.id}_audio.m4a`;
    const videoPath = path.join(DOWNLOAD_DIR, videoFilename);
    const audioPath = path.join(DOWNLOAD_DIR, audioFilename);

    const cookies = getCookiesPath(song.originalUrl);
    const cfg = getAdvancedConfig().ytdlp;

    // Step 1: Download video-only (no audio)
    const videoArgs = ['-f', cfg.videoFormat || 'bestvideo[ext=mp4]/bestvideo', '-o', videoPath];
    if (cfg.noPlaylist !== false) videoArgs.push('--no-playlist');
    if (cfg.concurrentFragments) videoArgs.push('-N', String(cfg.concurrentFragments));
    if (cfg.httpChunkSize) videoArgs.push('--http-chunk-size', cfg.httpChunkSize);
    if (cfg.proxy) videoArgs.push('--proxy', cfg.proxy);
    if (cfg.socketTimeout) videoArgs.push('--socket-timeout', String(cfg.socketTimeout));
    if (cfg.retries) videoArgs.push('--retries', String(cfg.retries));
    if (cfg.fragmentRetries) videoArgs.push('--fragment-retries', String(cfg.fragmentRetries));
    if (cfg.userAgent) videoArgs.push('--user-agent', cfg.userAgent);
    if (cfg.noCheckCertificates) videoArgs.push('--no-check-certificates');
    if (cfg.limitRate) videoArgs.push('--limit-rate', cfg.limitRate);
    if (cfg.forceIPv4) videoArgs.push('--force-ipv4');
    if (cfg.forceIPv6) videoArgs.push('--force-ipv6');
    if (cfg.noPart) videoArgs.push('--no-part');
    if (cfg.restrictFilenames) videoArgs.push('--restrict-filenames');
    if (cfg.windowsFilenames) videoArgs.push('--windows-filenames');
    if (cfg.noOverwrites) videoArgs.push('--no-overwrites');
    if (cfg.ignoreErrors) videoArgs.push('--ignore-errors');
    if (cfg.abortOnError) videoArgs.push('--abort-on-error');
    if (cfg.noWarnings) videoArgs.push('--no-warnings');
    if (Array.isArray(cfg.addHeader) && cfg.addHeader.length) cfg.addHeader.forEach(h => { videoArgs.push('--add-header', h); });
    if (cfg.extractorArgs) { cfg.extractorArgs.split(/\s+/).filter(Boolean).forEach(a => videoArgs.push(a)); }
    if (cfg.postprocessorArgs) { cfg.postprocessorArgs.split(/\s+/).filter(Boolean).forEach(a => videoArgs.push(a)); }
    if (cookies) videoArgs.push('--cookies', cookies);
    videoArgs.push(song.originalUrl);

    const ytDlpExe = fs.existsSync(path.join(__dirname, 'yt-dlp.exe')) ? path.join(__dirname, 'yt-dlp.exe') : 'yt-dlp';
    const videoProcess = spawn(ytDlpExe, videoArgs);
    activeDownloads.set(song.id, videoProcess);

    videoProcess.stdout.on('data', (data) => {
        const match = data.toString().match(/(\d+\.?\d*)%/);
        if (match) {
            // Video download counts as 0-50% progress
            const percent = parseFloat(match[1]) * 0.5;
            if (percent > song.progress) {
                song.progress = percent;
                io.emit('update_progress', { id: song.id, progress: percent });
            }
        }
    });

    videoProcess.on('close', (code) => {
        if (code !== 0) {
            handleDownloadError(song, `Video download failed with code ${code}`);
            return;
        }
        console.log(`[System] Video downloaded: ${videoFilename}`);

        // Step 2: Download audio-only
        const audioArgs = ['-f', cfg.audioFormat || 'bestaudio[ext=m4a]/bestaudio', '-o', audioPath];
        if (cfg.noPlaylist !== false) audioArgs.push('--no-playlist');
        if (cfg.concurrentFragments) audioArgs.push('-N', String(cfg.concurrentFragments));
        if (cfg.proxy) audioArgs.push('--proxy', cfg.proxy);
        if (cfg.socketTimeout) audioArgs.push('--socket-timeout', String(cfg.socketTimeout));
        if (cfg.retries) audioArgs.push('--retries', String(cfg.retries));
        if (cfg.userAgent) audioArgs.push('--user-agent', cfg.userAgent);
        if (cfg.noCheckCertificates) audioArgs.push('--no-check-certificates');
        if (cfg.limitRate) audioArgs.push('--limit-rate', cfg.limitRate);
        if (cfg.forceIPv4) audioArgs.push('--force-ipv4');
        if (cfg.forceIPv6) audioArgs.push('--force-ipv6');
        if (cfg.noPart) audioArgs.push('--no-part');
        if (cfg.restrictFilenames) audioArgs.push('--restrict-filenames');
        if (cfg.windowsFilenames) audioArgs.push('--windows-filenames');
        if (cfg.noOverwrites) audioArgs.push('--no-overwrites');
        if (Array.isArray(cfg.addHeader) && cfg.addHeader.length) cfg.addHeader.forEach(h => { audioArgs.push('--add-header', h); });
        if (cfg.extractorArgs) { cfg.extractorArgs.split(/\s+/).filter(Boolean).forEach(a => audioArgs.push(a)); }
        if (cfg.postprocessorArgs) { cfg.postprocessorArgs.split(/\s+/).filter(Boolean).forEach(a => audioArgs.push(a)); }
        if (cookies) audioArgs.push('--cookies', cookies);
        audioArgs.push(song.originalUrl);

        const audioProcess = spawn(ytDlpExe, audioArgs);
        activeDownloads.set(song.id, audioProcess);

        audioProcess.stdout.on('data', (data) => {
            const match = data.toString().match(/(\d+\.?\d*)%/);
            if (match) {
                // Audio download counts as 50-80% progress
                const percent = 50 + parseFloat(match[1]) * 0.3;
                if (percent > song.progress) {
                    song.progress = percent;
                    io.emit('update_progress', { id: song.id, progress: percent });
                }
            }
        });

        audioProcess.on('close', (audioCode) => {
            if (audioCode !== 0) {
                handleDownloadError(song, `Audio download failed with code ${audioCode}`);
                return;
            }
            console.log(`[System] Audio downloaded: ${audioFilename}`);
            song.progress = 80;
            io.emit('update_progress', { id: song.id, progress: 80 });

            // Step 3: Analyze loudness with FFmpeg (quick, ~1-2 seconds)
            analyzeLoudness(audioPath, (loudnessGain) => {
                song.progress = 95;
                io.emit('update_progress', { id: song.id, progress: 95 });

                activeDownloads.delete(song.id);

                if (currentDownloadingId === song.id) {
                    currentDownloadingId = null;
                    isDownloading = false;
                }

                console.log(`[System] Ready: ${song.title} (Loudness Gain: ${loudnessGain.toFixed(2)} dB)`);
                song.status = 'ready';
                song.progress = 100;
                song.src = `/downloads/${videoFilename}`;
                song.audioSrc = `/downloads/${audioFilename}`;
                song.localVideoPath = videoPath;
                song.localAudioPath = audioPath;
                song.loudnessGain = loudnessGain;
                song.karaokeReady = false;
                song.karaokeSrc = null;

                if (autoProcessKaraoke) queueKaraokeProcessing(song);
                if (currentPlaying && currentPlaying.id === song.id) playerStatus.playing = true;
                io.emit('sync_state', { playlist, currentPlaying, playerStatus, history, autoProcessKaraoke });
                processDownloadQueue();
            });
        });

        audioProcess.on('error', (err) => {
            handleDownloadError(song, `Audio spawn error: ${err.message}`);
        });
    });

    videoProcess.on('error', (err) => {
        handleDownloadError(song, `Video spawn error: ${err.message}`);
    });
};

// Helper: Handle download errors
const handleDownloadError = (song, message) => {
    activeDownloads.delete(song.id);
    if (currentDownloadingId === song.id) {
        currentDownloadingId = null;
        isDownloading = false;
    }
    console.error(`[System] ${message}`);
    song.status = 'error';
    io.emit('sync_state', { playlist, currentPlaying, playerStatus, history, autoProcessKaraoke });
    processDownloadQueue();
};

// Analyze audio loudness using FFmpeg loudnorm filter
const analyzeLoudness = (audioPath, callback) => {
    const fcfg = getAdvancedConfig().ffmpeg || {};
    const I = fcfg.loudnessI != null ? fcfg.loudnessI : -16;
    const TP = fcfg.loudnessTP != null ? fcfg.loudnessTP : -1.5;
    const LRA = fcfg.loudnessLRA != null ? fcfg.loudnessLRA : 11;
    const clamp = Math.max(0, fcfg.loudnessGainClamp != null ? fcfg.loudnessGainClamp : 12);
    const ffmpegArgs = [
        '-i', audioPath,
        '-af', `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:print_format=json`,
        '-f', 'null',
        '-'
    ];

    console.log(`[Loudness] Analyzing: ${path.basename(audioPath)}`);

    const proc = spawn('ffmpeg', ffmpegArgs);
    let stderr = '';

    proc.stderr.on('data', (data) => {
        stderr += data.toString();
    });

    proc.on('close', (code) => {
        if (code !== 0) {
            console.error('[Loudness] FFmpeg analysis failed, using default gain');
            callback(0);
            return;
        }

        try {
            const jsonMatch = stderr.match(/\{[\s\S]*"input_i"[\s\S]*\}/);
            if (jsonMatch) {
                const loudnessData = JSON.parse(jsonMatch[0]);
                const inputLUFS = parseFloat(loudnessData.input_i);
                const targetLUFS = I;
                const gain = targetLUFS - inputLUFS;
                const clampedGain = Math.max(-clamp, Math.min(clamp, gain));
                console.log(`[Loudness] Input: ${inputLUFS.toFixed(1)} LUFS, Gain: ${clampedGain.toFixed(2)} dB`);
                callback(clampedGain);
            } else {
                console.error('[Loudness] Could not parse FFmpeg output');
                callback(0);
            }
        } catch (e) {
            console.error('[Loudness] Parse error:', e.message);
            callback(0);
        }
    });

    proc.on('error', (err) => {
        console.error('[Loudness] Spawn error:', err.message);
        callback(0);
    });
};


const deleteSongFile = (song) => {
    if (!song) return;

    // 1. Terminate Active Download
    const downloadProc = activeDownloads.get(song.id);
    if (downloadProc) {
        console.log(`[System] Cancelling download for: ${song.title}`);
        try {
            spawn('taskkill', ['/pid', downloadProc.pid, '/f', '/t'], { shell: true });
        } catch (e) {
            try { downloadProc.kill('SIGKILL'); } catch (e2) { }
        }
        // activeDownloads.delete(song.id); // Let close handler handle cleanup
        // isDownloading = false; // Let close handler handle state transition

        // Ensure we process next if queue exists, but give a small delay for process cleanup
        // setTimeout(processDownloadQueue, 500); // Removed to avoid race condition
    }

    // 2. Terminate Active Karaoke
    if (song.id) {
        terminateKaraokeProcess(song.id);
        cleanupSeparatedFiles(song.id);
    }

    // 3. Delete Files (Retry mechanism for locked files)
    const tryDelete = (filePath, retries = 3) => {
        if (!filePath || !fs.existsSync(filePath)) return;
        try {
            fs.unlinkSync(filePath);
            console.log(`[System] Deleted: ${filePath}`);
        } catch (e) {
            // console.error(`[System] Delete retry ${retries} for ${filePath}: ${e.message}`);
            if (retries > 0) {
                setTimeout(() => tryDelete(filePath, retries - 1), 1000);
            }
        }
    };

    // Delete separate video and audio files
    if (song.localVideoPath) tryDelete(song.localVideoPath);
    if (song.localAudioPath) tryDelete(song.localAudioPath);
    if (song.id) {
        const karaokePath = path.join(DOWNLOAD_DIR, `${song.id}_karaoke.mp3`);
        tryDelete(karaokePath);
    }
};

const fetchUrlInfo = (url) => {
    return new Promise((resolve) => {
        // 1. Try Bilibili Favorites API first
        const biliFavMatch = url.match(/space\.bilibili\.com\/\d+\/favlist\?.*fid=(\d+)/);
        if (biliFavMatch) {
            (async () => {
                const mediaId = biliFavMatch[1];
                let allMedias = [];
                let pn = 1;
                let hasMore = true;
                const https = require('https'); // Require https locally

                const fetchPage = (p) => new Promise(res => {
                    // Use ps=20 as ps=50 causes -400 error
                    const apiUrl = `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${mediaId}&pn=${p}&ps=20&keyword=&order=mtime&type=0&tid=0&platform=web`;
                    https.get(apiUrl, {
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36)' }
                    }, (r) => {
                        let d = '';
                        r.on('data', c => d += c);
                        r.on('end', () => {
                            try {
                                const j = JSON.parse(d);
                                if (j.code === 0 && j.data && j.data.medias) {
                                    res({ medias: j.data.medias, hasMore: j.data.has_more });
                                } else {
                                    // console.error('[API] Bilibili Error:', j);
                                    res({ medias: [], hasMore: false });
                                }
                            } catch (e) { res({ medias: [], hasMore: false }); }
                        });
                    }).on('error', () => res({ medias: [], hasMore: false }));
                });

                // Fetch up to 5 pages (100 items)
                while (hasMore && pn <= 5) {
                    try {
                        const res = await fetchPage(pn);
                        if (res.medias.length > 0) {
                            allMedias = allMedias.concat(res.medias);
                            hasMore = res.hasMore;
                            pn++;
                        } else {
                            hasMore = false;
                        }
                    } catch (e) { hasMore = false; }
                }

                if (allMedias.length > 0) {
                    const list = allMedias.map(item => ({
                        title: item.title,
                        uploader: item.upper ? item.upper.name : 'Unknown',
                        pic: null, // Thumbnails disabled per user request
                        originalUrl: `https://www.bilibili.com/video/${item.bvid}`
                    }));
                    resolve({ list });
                    return;
                }

                // Fallback to yt-dlp if API fails or returns empty
                runYtDlp(url, resolve);
            })();
            return; // Early return to prevent running yt-dlp immediately
        }

        // 2. Default yt-dlp logic for all other URLs or if Bilibili API failed
        runYtDlp(url, resolve);
    });
};

// Helper function to run yt-dlp logic (parse URL / playlist)
const runYtDlp = (url, resolve) => {
    const cfg = getAdvancedConfig().ytdlp;
    const args = [];
    if (cfg.flatPlaylist !== false) args.push('--flat-playlist');
    if (cfg.dumpJson !== false) args.push('--dump-json');
    if (cfg.noPlaylist !== false) args.push('--no-playlist');
    if (cfg.proxy) args.push('--proxy', cfg.proxy);
    if (cfg.socketTimeout) args.push('--socket-timeout', String(cfg.socketTimeout));
    if (cfg.userAgent) args.push('--user-agent', cfg.userAgent);
    if (cfg.noCheckCertificates) args.push('--no-check-certificates');
    if (cfg.noWarnings) args.push('--no-warnings');
    const cookies = getCookiesPath(url);
    if (cookies) args.push('--cookies', cookies);
    args.push(url);

    const ytDlpExe = fs.existsSync(path.join(__dirname, 'yt-dlp.exe')) ? path.join(__dirname, 'yt-dlp.exe') : 'yt-dlp';
    const child = spawn(ytDlpExe, args);
    let output = '';
    child.stdout.on('data', d => output += d);
    child.on('close', code => {
        if (code === 0) {
            try {
                const lines = output.trim().split('\n');
                const items = lines.map(line => {
                    try {
                        return JSON.parse(line);
                    } catch (e) { return null; }
                }).filter(x => x);

                if (items.length === 0) {
                    resolve(null);
                    return;
                }

                const formattedItems = items.map(data => {
                    // Construct a usable URL
                    let itemUrl = data.url || data.webpage_url;
                    if (!itemUrl && data.id) {
                        // Heuristic for YouTube IDs if url is missing/just ID
                        if (data.ie_key === 'Youtube' || !data.ie_key) {
                            itemUrl = `https://www.youtube.com/watch?v=${data.id}`;
                        } else if (data.ie_key === 'BiliBili') {
                            itemUrl = `https://www.bilibili.com/video/${data.id}`;
                        } else {
                            itemUrl = url; // Fallback to provided URL (might be wrong for playlists)
                        }
                    }

                    // Handle Bilibili specific fields or missing titles
                    let title = data.title;
                    if (!title && data.id) title = `Video ${data.id}`;

                    return {
                        title: title || 'Unknown Title',
                        uploader: data.uploader || data.uploader_id || 'Unknown',
                        pic: null, // Thumbnails disabled per user request
                        originalUrl: itemUrl || url
                    };
                });

                if (formattedItems.length > 0) {
                    resolve({ list: formattedItems });
                } else {
                    resolve(null);
                }
            } catch (e) {
                console.error('[yt-dlp] JSON parse failed:', e.message);
                resolve(null);
            }
        } else {
            console.error(`[yt-dlp] Process exited with code ${code}`);
            resolve(null);
        }
    });
    child.on('error', (err) => {
        console.error('[yt-dlp] Spawn error:', err.message);
        resolve(null);
    });
};

const promoteNextSong = () => {
    if (currentPlaying) {
        const historyItem = { ...currentPlaying, playedAt: new Date() };
        history.unshift(historyItem);
        if (history.length > 50) history.pop();
        const fileToDelete = { ...currentPlaying };
        const delayMs = (getAdvancedConfig().system || {}).deleteDelayMs ?? 20000;
        setTimeout(() => deleteSongFile(fileToDelete), delayMs);
    }

    if (playlist.length > 0) {
        currentPlaying = playlist.shift();
        playerStatus.playing = true;
        playerStatus.currentTime = 0;
        playerStatus.pitch = 0;
        playerStatus.vocalRemoval = false; // Auto-reset vocal removal
    } else {
        currentPlaying = null;
        playerStatus.playing = false;
    }

    io.emit('sync_state', { playlist, currentPlaying, playerStatus, history, autoProcessKaraoke });
    processDownloadQueue();
};


io.on('connection', async (socket) => {
    socket.emit('sync_state', { playlist, currentPlaying, playerStatus, history, autoProcessKaraoke });

    const networks = getNetworkInterfaces();
    const ssid = await getWifiSSID();
    const actualPort = server.address() ? server.address().port : PORT;
    socket.emit('system_info', { networks, ssid, port: actualPort });

    // New: Parse URL and return list
    socket.on('parse_url', async (url) => {
        const result = await fetchUrlInfo(url);
        if (result && result.list && result.list.length > 0) {
            socket.emit('parse_result', result);
        } else {
            socket.emit('error_msg', 'Parse Error or No Content');
        }
    });

    // New: Batch add songs
    socket.on('add_batch_songs', async (data) => {
        const { songs, requester } = data;
        if (!songs || !Array.isArray(songs) || songs.length === 0) return;

        let addedCount = 0;
        songs.forEach(meta => {
            const song = {
                id: Date.now() + Math.floor(Math.random() * 1000), // Ensure unique IDs
                title: meta.title,
                uploader: meta.uploader,
                pic: meta.pic,
                requester,
                originalUrl: meta.originalUrl,
                status: 'pending',
                progress: 0,
                src: null
            };
            if (!currentPlaying) {
                currentPlaying = song;
                playerStatus.playing = true;
            } else {
                playlist.push(song);
            }
            addedCount++;
        });

        if (addedCount > 0) {
            io.emit('add_success', addedCount);
            io.emit('sync_state', { playlist, currentPlaying, playerStatus, history, autoProcessKaraoke });
            processDownloadQueue();
        }
    });

    // Legacy support (optional, or redirect to use new approach internally if we want to keep the event)
    // We can keep it or remove it. The frontend will be updated to use parse_url -> add_batch_songs.
    // usage of add_song in frontend is being replaced.
    // I will keep it for now just in case.
    socket.on('add_song', async (data) => {
        const { url, requester } = data;
        // Re-use logic for single song adding
        const result = await fetchUrlInfo(url);
        if (result && result.list && result.list.length > 0) {
            // Just take the first one
            const meta = result.list[0];
            const song = {
                id: Date.now(),
                title: meta.title,
                uploader: meta.uploader,
                pic: meta.pic,
                requester,
                originalUrl: meta.originalUrl,
                status: 'pending',
                progress: 0,
                src: null
            };
            if (!currentPlaying) {
                currentPlaying = song;
                playerStatus.playing = true;
            } else {
                playlist.push(song);
            }
            io.emit('add_success');
            io.emit('sync_state', { playlist, currentPlaying, playerStatus, history, autoProcessKaraoke });
            processDownloadQueue();
        } else {
            socket.emit('error_msg', 'Parse Error');
        }
    });

    socket.on('readd_history', (historyItem) => {
        const newSong = { ...historyItem, id: Date.now(), status: 'pending', progress: 0, src: null, localPath: null };
        if (!currentPlaying) {
            currentPlaying = newSong;
            playerStatus.playing = true;
        } else {
            playlist.push(newSong);
        }
        io.emit('add_success');
        io.emit('sync_state', { playlist, currentPlaying, playerStatus, history, autoProcessKaraoke });
        processDownloadQueue();
    });

    socket.on('next_song', (data) => {
        if (data && data.manual) {
            io.emit('exec_control', { type: 'cut' });
        }
        promoteNextSong();
    });
    socket.on('manage_queue', ({ action, id }) => {
        const index = playlist.findIndex(item => item.id === id);
        if (index !== -1) {
            const item = playlist.splice(index, 1)[0];
            if (action === 'delete') deleteSongFile(item);
            if (action === 'top') playlist.unshift(item);
            io.emit('sync_state', { playlist, currentPlaying, playerStatus, history, autoProcessKaraoke });
            processDownloadQueue();
            if (autoProcessKaraoke && !isProcessingKaraoke) processNextKaraoke();
        }
    });

    socket.on('get_advanced_config', () => {
        socket.emit('advanced_config', getAdvancedConfig());
    });

    socket.on('set_advanced_config', (config) => {
        if (config && typeof config === 'object') {
            const ok = saveAdvancedConfig(config);
            if (ok) {
                socket.emit('advanced_config', getAdvancedConfig());
                socket.emit('advanced_config_saved');
            } else {
                socket.emit('error_msg', 'Failed to save advanced config');
            }
        }
    });

    socket.on('reset_advanced_config', () => {
        const ok = resetAdvancedConfigToDefault();
        if (ok) {
            socket.emit('advanced_config', getAdvancedConfig());
            socket.emit('advanced_config_saved');
        } else {
            socket.emit('error_msg', 'Failed to restore default settings');
        }
    });

    socket.on('set_auto_process', (enabled) => {
        autoProcessKaraoke = !!enabled;
        console.log(`[Settings] autoProcessKaraoke: ${autoProcessKaraoke}`);
        if (autoProcessKaraoke) {
            queueAllReadySongsForKaraoke();
        }
        io.emit('sync_state', { playlist, currentPlaying, playerStatus, history, autoProcessKaraoke });
    });

    socket.on('shuffle_queue', () => {
        // Fisher-Yates shuffle for playlist (waiting list only)
        for (let i = playlist.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [playlist[i], playlist[j]] = [playlist[j], playlist[i]];
        }
        console.log('[Queue] Playlist shuffled');
        io.emit('sync_state', { playlist, currentPlaying, playerStatus, history, autoProcessKaraoke });
        if (autoProcessKaraoke && !isProcessingKaraoke) processNextKaraoke();
    });

    socket.on('control_action', (action) => {
        if (action.type === 'toggle') playerStatus.playing = !playerStatus.playing;
        if (action.type === 'seek') playerStatus.currentTime = action.value;
        if (action.type === 'volume') playerStatus.volume = action.value;
        if (action.type === 'pitch') playerStatus.pitch = action.value;
        if (action.type === 'vocal_removal') {
            // Manual trigger: if not ready and not processing, start processing
            if (action.value && currentPlaying && currentPlaying.status === 'ready' &&
                !currentPlaying.karaokeReady && !currentPlaying.karaokeProcessing) {
                queueKaraokeProcessing(currentPlaying, true); // prioritize
                console.log(`[Karaoke] Manual trigger for: ${currentPlaying.title}`);
            }
            playerStatus.vocalRemoval = action.value;
        }
        io.emit('exec_control', action);
    });

    socket.on('player_tick', (data) => {
        playerStatus = { ...playerStatus, ...data };
        io.volatile.emit('sync_tick', playerStatus);
    });

    socket.on('system_reset', () => {
        [...playlist, currentPlaying ? [currentPlaying] : [], ...history].flat().forEach(s => s && deleteSongFile(s));
        playlist = []; history = []; currentPlaying = null;
        playerStatus = { playing: false, currentTime: 0, duration: 0, volume: 0.8, pitch: 0, vocalRemoval: false };
        autoProcessKaraoke = false;
        karaokeProcessingQueue = [];
        io.emit('sync_state', { playlist, currentPlaying, playerStatus, history, autoProcessKaraoke });
        io.emit('exec_control', { type: 'reload' });
    });
});

const PORT = 0; // Let OS assign a free port
server.listen(PORT, '0.0.0.0', () => {
    const actualPort = server.address().port;
    console.log(`Server running on port ${actualPort}`);

    // Auto-open browser
    const url = `http://localhost:${actualPort}/player.html`;
    console.log(`[System] Opening browser: ${url}`);

    let command;
    switch (process.platform) {
        case 'win32': command = `start "" "${url}"`; break;
        case 'darwin': command = `open "${url}"`; break;
        default: command = `xdg-open "${url}"`; break;
    }

    exec(command, (err) => {
        if (err) console.error(`[System] Failed to open browser: ${err.message}`);
    });
});