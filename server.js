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

let playlist = [];
let history = [];
let currentPlaying = null;
let isDownloading = false;
let playerStatus = { playing: false, currentTime: 0, duration: 0, volume: 0.8, pitch: 0, vocalRemoval: false };
let autoProcessKaraoke = false; // Global setting: auto-process songs for karaoke
let karaokeProcessingQueue = []; // Queue of songs waiting to be processed
let isProcessingKaraoke = false;

// --- Demucs-based Vocal Separation ---
const SEPARATED_DIR = path.join(__dirname, 'separated');
if (!fs.existsSync(SEPARATED_DIR)) fs.mkdirSync(SEPARATED_DIR);

// Track active processes for termination
const activeKaraokeProcesses = new Map(); // songId -> { proc, song }

const cleanupSeparatedFiles = (songId) => {
    // Clean up the separated folder for a specific song
    const songSeparatedDir = path.join(SEPARATED_DIR, 'htdemucs', songId.toString());
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
    // Also remove from queue if pending
    const queueIdx = karaokeProcessingQueue.findIndex(s => s && s.id === songId);
    if (queueIdx !== -1) {
        karaokeProcessingQueue.splice(queueIdx, 1);
    }
};

const processVocalSeparation = (song) => {
    if (!song || !song.localPath || !fs.existsSync(song.localPath)) return;
    if (song.karaokeReady || song.karaokeProcessing) return;

    song.karaokeProcessing = true;
    song.karaokeProgress = 0;
    console.log(`[Karaoke] Processing: ${song.title}`);
    io.emit('sync_state', { playlist, currentPlaying, playerStatus, history, autoProcessKaraoke });

    const args = [
        '-n', 'htdemucs',
        '--two-stems', 'vocals',
        '--mp3',
        '-d', 'cpu',
        '-o', SEPARATED_DIR,
        song.localPath
    ];

    const proc = spawn('demucs', args, { shell: true });
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
            const noVocalsPath = path.join(SEPARATED_DIR, 'htdemucs', song.id.toString(), 'no_vocals.mp3');
            if (fs.existsSync(noVocalsPath)) {
                const karaokePath = path.join(DOWNLOAD_DIR, `${song.id}_karaoke.mp3`);
                fs.copyFileSync(noVocalsPath, karaokePath);
                song.karaokeSrc = `/downloads/${song.id}_karaoke.mp3`;
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
        processNextKaraoke();
    });

    proc.on('error', (err) => {
        activeKaraokeProcesses.delete(song.id);
        song.karaokeProcessing = false;
        song.karaokeProgress = 0;
        console.error(`[Karaoke] Spawn error: ${err.message}`);
        cleanupSeparatedFiles(song.id);
        processNextKaraoke();
    });
};

const processNextKaraoke = () => {
    if (karaokeProcessingQueue.length === 0) {
        isProcessingKaraoke = false;
        return;
    }
    isProcessingKaraoke = true;
    const nextSong = karaokeProcessingQueue.shift();
    if (nextSong && nextSong.status === 'ready' && !nextSong.karaokeReady) {
        processVocalSeparation(nextSong);
    } else {
        processNextKaraoke();
    }
};

const queueKaraokeProcessing = (song, prioritize = false) => {
    if (!song || song.karaokeReady || song.karaokeProcessing) return;
    if (karaokeProcessingQueue.includes(song)) return;
    if (prioritize) {
        karaokeProcessingQueue.unshift(song);
    } else {
        karaokeProcessingQueue.push(song);
    }
    if (!isProcessingKaraoke) processNextKaraoke();
};

const queueAllReadySongsForKaraoke = () => {
    const allSongs = [currentPlaying, ...playlist].filter(s => s && s.status === 'ready' && !s.karaokeReady && !s.karaokeProcessing);
    allSongs.forEach(song => queueKaraokeProcessing(song));
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
    if (isDownloading) return;
    if (currentPlaying && currentPlaying.status === 'pending') {
        startDownload(currentPlaying);
        return;
    }
    const targetSong = playlist.find(s => s.status === 'pending');
    if (targetSong) startDownload(targetSong);
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
    isDownloading = true;
    song.status = 'downloading';
    song.progress = 0;
    io.emit('sync_state', { playlist, currentPlaying, playerStatus, history });

    console.log(`[System] Downloading: ${song.title}`);
    const outputFilename = `${song.id}.mp4`;
    const outputPath = path.join(DOWNLOAD_DIR, outputFilename);

    const args = [
        '-f', 'bestvideo+bestaudio/best',
        '--merge-output-format', 'mp4',
        '-o', outputPath,
        '--no-playlist',
        '-N', '16', '--http-chunk-size', '10M'
    ];

    const cookies = getCookiesPath(song.originalUrl);
    if (cookies) args.push('--cookies', cookies);

    args.push(song.originalUrl);

    const dlProcess = spawn('yt-dlp.exe', args);

    dlProcess.stdout.on('data', (data) => {
        const match = data.toString().match(/(\d+\.\d+)%/);
        if (match) {
            const percent = parseFloat(match[1]);
            if (percent > song.progress) {
                song.progress = percent;
                if (Math.floor(percent) % 5 === 0 || percent >= 100) {
                    io.emit('update_progress', { id: song.id, progress: percent });
                }
            }
        }
    });

    dlProcess.on('close', (code) => {
        isDownloading = false;
        if (code === 0) {
            console.log(`[System] Ready: ${song.title}`);
            song.status = 'ready';
            song.progress = 100;
            song.src = `/downloads/${outputFilename}`;
            song.localPath = outputPath;
            song.karaokeReady = false; // Initialize karaoke status
            song.karaokeSrc = null;

            // Queue for karaoke processing if enabled
            if (autoProcessKaraoke) {
                queueKaraokeProcessing(song);
            }

            playerStatus.playing = true;
            io.emit('sync_state', { playlist, currentPlaying, playerStatus, history, autoProcessKaraoke });
            processDownloadQueue();
        } else {
            console.error(`[System] Failed: ${code}`);
            song.status = 'error';
            io.emit('sync_state', { playlist, currentPlaying, playerStatus, history, autoProcessKaraoke });
            processDownloadQueue();
        }
    });
};

const deleteSongFile = (song) => {
    if (!song) return;
    // Terminate any active karaoke processing for this song
    if (song.id) {
        terminateKaraokeProcess(song.id);
        cleanupSeparatedFiles(song.id);
    }
    // Delete the main song file
    if (song.localPath && fs.existsSync(song.localPath)) {
        try { fs.unlinkSync(song.localPath); } catch (e) { }
    }
    // Delete karaoke file if exists
    if (song.id) {
        const karaokePath = path.join(DOWNLOAD_DIR, `${song.id}_karaoke.mp3`);
        if (fs.existsSync(karaokePath)) {
            try { fs.unlinkSync(karaokePath); } catch (e) { }
        }
    }
};

const fetchMetadata = (url) => {
    return new Promise((resolve) => {
        const args = ['--flat-playlist', '--dump-json', '--no-playlist'];
        const cookies = getCookiesPath(url);
        if (cookies) args.push('--cookies', cookies);
        args.push(url);

        const child = spawn('yt-dlp.exe', args);
        let output = '';
        child.stdout.on('data', d => output += d);
        child.on('close', code => {
            if (code === 0) {
                try {
                    const data = JSON.parse(output);
                    resolve({ title: data.title, uploader: data.uploader || 'Unknown', pic: data.thumbnail || '' });
                } catch (e) { resolve(null); }
            } else { resolve(null); }
        });
    });
};

const promoteNextSong = () => {
    if (currentPlaying) {
        const historyItem = { ...currentPlaying, playedAt: new Date() };
        history.unshift(historyItem);
        if (history.length > 50) history.pop();
        const fileToDelete = { ...currentPlaying };
        setTimeout(() => deleteSongFile(fileToDelete), 5000);
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
    socket.emit('system_info', { networks, ssid, port: PORT });

    socket.on('add_song', async (data) => {
        const { url, requester } = data;
        const meta = await fetchMetadata(url);
        if (meta) {
            const song = {
                id: Date.now(),
                title: meta.title,
                uploader: meta.uploader,
                pic: meta.pic,
                requester,
                originalUrl: url,
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

    socket.on('next_song', promoteNextSong);
    socket.on('manage_queue', ({ action, id }) => {
        const index = playlist.findIndex(item => item.id === id);
        if (index !== -1) {
            const item = playlist.splice(index, 1)[0];
            if (action === 'delete' && item.status === 'ready') deleteSongFile(item);
            if (action === 'top') playlist.unshift(item);
            io.emit('sync_state', { playlist, currentPlaying, playerStatus, history, autoProcessKaraoke });
            processDownloadQueue();
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

const PORT = 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});