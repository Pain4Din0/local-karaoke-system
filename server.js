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
    // Cleanup function to remove Demucs-generated files
    // Demucs creates folder based on input filename without extension (ID_audio)
    const songSeparatedDir = path.join(SEPARATED_DIR, 'htdemucs', `${songId}_audio`);
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

    // Use audio-only file for faster Demucs processing
    const audioPath = song.localAudioPath;
    if (!song || !audioPath || !fs.existsSync(audioPath)) return;
    if (song.karaokeReady || song.karaokeProcessing) return;

    song.karaokeProcessing = true;
    song.karaokeProgress = 0;
    console.log(`[Karaoke] Processing audio: ${path.basename(audioPath)}`);
    io.emit('sync_state', { playlist, currentPlaying, playerStatus, history, autoProcessKaraoke });

    const args = [
        '-n', 'htdemucs',
        '--two-stems', 'vocals',
        '--mp3',
        '-d', 'cpu',
        '-o', SEPARATED_DIR,
        audioPath
    ];

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
            // Demucs creates folder based on input filename without extension (e.g., ID_audio)
            const noVocalsPath = path.join(SEPARATED_DIR, 'htdemucs', `${song.id}_audio`, 'no_vocals.mp3');
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
    currentDownloadingId = song.id;
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

    // Step 1: Download video-only (no audio)
    const videoArgs = [
        '-f', 'bestvideo[ext=mp4]/bestvideo',
        '-o', videoPath,
        '--no-playlist',
        '-N', '16', '--http-chunk-size', '10M'
    ];
    if (cookies) videoArgs.push('--cookies', cookies);
    videoArgs.push(song.originalUrl);

    const videoProcess = spawn('yt-dlp.exe', videoArgs);
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
        const audioArgs = [
            '-f', 'bestaudio[ext=m4a]/bestaudio',
            '-o', audioPath,
            '--no-playlist',
            '-N', '16'
        ];
        if (cookies) audioArgs.push('--cookies', cookies);
        audioArgs.push(song.originalUrl);

        const audioProcess = spawn('yt-dlp.exe', audioArgs);
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

                    console.log(`[System] Ready: ${song.title} (Loudness Gain: ${loudnessGain.toFixed(2)} dB)`);
                    song.status = 'ready';
                    song.progress = 100;

                    // New path structure
                    song.src = `/downloads/${videoFilename}`;
                    song.audioSrc = `/downloads/${audioFilename}`;
                    song.localVideoPath = videoPath;
                    song.localAudioPath = audioPath;
                    song.loudnessGain = loudnessGain; // dB adjustment for normalization
                    song.karaokeReady = false;
                    song.karaokeSrc = null;

                    if (autoProcessKaraoke) {
                        queueKaraokeProcessing(song);
                    }

                    playerStatus.playing = true;
                    io.emit('sync_state', { playlist, currentPlaying, playerStatus, history, autoProcessKaraoke });
                    processDownloadQueue();
                }
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
// Returns gain adjustment in dB to normalize to -16 LUFS
const analyzeLoudness = (audioPath, callback) => {
    const ffmpegArgs = [
        '-i', audioPath,
        '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json',
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
                const targetLUFS = -16;
                const gain = targetLUFS - inputLUFS;
                const clampedGain = Math.max(-12, Math.min(12, gain));
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

// Helper function to run yt-dlp logic
const runYtDlp = (url, resolve) => {
    const args = ['--flat-playlist', '--dump-json', '--no-playlist'];
    const cookies = getCookiesPath(url);
    if (cookies) args.push('--cookies', cookies);
    args.push(url);

    // Ensure we use the local yt-dlp.exe if available
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
        setTimeout(() => deleteSongFile(fileToDelete), 20000); // Increased delay
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

    socket.on('next_song', promoteNextSong);
    socket.on('manage_queue', ({ action, id }) => {
        const index = playlist.findIndex(item => item.id === id);
        if (index !== -1) {
            const item = playlist.splice(index, 1)[0];
            if (action === 'delete') deleteSongFile(item);
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