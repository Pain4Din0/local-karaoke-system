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
let playerStatus = { playing: false, currentTime: 0, duration: 0, volume: 0.8 };

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

            if (currentPlaying && currentPlaying.id === song.id) {
                playerStatus.playing = true;
                io.emit('sync_state', { playlist, currentPlaying, playerStatus, history });
            } else {
                io.emit('sync_state', { playlist, currentPlaying, playerStatus, history });
            }
            processDownloadQueue();
        } else {
            console.error(`[System] Failed: ${code}`);
            song.status = 'error';
            io.emit('sync_state', { playlist, currentPlaying, playerStatus, history });
            processDownloadQueue();
        }
    });
};

const deleteSongFile = (song) => {
    if (song && song.localPath && fs.existsSync(song.localPath)) {
        try { fs.unlinkSync(song.localPath); } catch (e) { }
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
    } else {
        currentPlaying = null;
        playerStatus.playing = false;
    }

    io.emit('sync_state', { playlist, currentPlaying, playerStatus, history });
    processDownloadQueue();
};

io.on('connection', async (socket) => {
    socket.emit('sync_state', { playlist, currentPlaying, playerStatus, history });

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
            io.emit('sync_state', { playlist, currentPlaying, playerStatus, history });
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
        io.emit('sync_state', { playlist, currentPlaying, playerStatus, history });
        processDownloadQueue();
    });

    socket.on('next_song', promoteNextSong);
    socket.on('manage_queue', ({ action, id }) => {
        const index = playlist.findIndex(item => item.id === id);
        if (index !== -1) {
            const item = playlist.splice(index, 1)[0];
            if (action === 'delete' && item.status === 'ready') deleteSongFile(item);
            if (action === 'top') playlist.unshift(item);
            io.emit('sync_state', { playlist, currentPlaying, playerStatus, history });
            processDownloadQueue();
        }
    });

    socket.on('control_action', (action) => {
        if (action.type === 'toggle') playerStatus.playing = !playerStatus.playing;
        if (action.type === 'seek') playerStatus.currentTime = action.value;
        if (action.type === 'volume') playerStatus.volume = action.value;
        io.emit('exec_control', action);
    });

    socket.on('player_tick', (data) => {
        playerStatus = { ...playerStatus, ...data };
        io.volatile.emit('sync_tick', playerStatus);
    });

    socket.on('system_reset', () => {
        [...playlist, currentPlaying ? [currentPlaying] : [], ...history].flat().forEach(s => s && deleteSongFile(s));
        playlist = []; history = []; currentPlaying = null;
        playerStatus = { playing: false, currentTime: 0, duration: 0, volume: 0.8 };
        io.emit('sync_state', { playlist, currentPlaying, playerStatus, history });
        io.emit('exec_control', { type: 'reload' });
    });
});

const PORT = 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});