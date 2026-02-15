const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { exec } = require('child_process');

// Services & Config
const { loadAdvancedConfig, saveAdvancedConfig, getAdvancedConfig, resetAdvancedConfigToDefault } = require('./src/config/configManager');
const state = require('./src/utils/state');
const { getNetworkInterfaces, getWifiSSID, deleteSongFile } = require('./src/services/system');
const { processDownloadQueue } = require('./src/services/downloader');
const { queueKaraokeProcessing, queueAllReadySongsForKaraoke, processNextKaraoke } = require('./src/services/karaoke');
const { fetchUrlInfo } = require('./src/services/fetcher');

// Initialize Config
loadAdvancedConfig();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Set global IO instance
state.setIO(io);

const ROOT_DIR = __dirname;
const DOWNLOAD_DIR = path.join(ROOT_DIR, 'downloads');

app.use(express.static(path.join(ROOT_DIR, 'public')));
app.use(express.json());
app.use('/downloads', express.static(DOWNLOAD_DIR));

// Helper: Promote Next Song
const promoteNextSong = () => {
    if (state.currentPlaying) {
        const historyItem = { ...state.currentPlaying, playedAt: new Date() };
        state.history.unshift(historyItem);
        if (state.history.length > 50) state.history.pop();
        const fileToDelete = { ...state.currentPlaying };
        const delayMs = (getAdvancedConfig().system || {}).deleteDelayMs ?? 20000;
        setTimeout(() => deleteSongFile(fileToDelete), delayMs);
    }

    if (state.playlist.length > 0) {
        state.currentPlaying = state.playlist.shift();
        state.playerStatus.playing = true;
        state.playerStatus.currentTime = 0;
        state.playerStatus.pitch = 0;
        state.playerStatus.vocalRemoval = false; // Auto-reset vocal removal
    } else {
        state.currentPlaying = null;
        state.playerStatus.playing = false;
    }

    state.emitSync();
    processDownloadQueue();
};

io.on('connection', async (socket) => {
    state.emitSync();

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
            if (!state.currentPlaying) {
                state.currentPlaying = song;
                state.playerStatus.playing = true;
            } else {
                state.playlist.push(song);
            }
            addedCount++;
        });

        if (addedCount > 0) {
            io.emit('add_success', addedCount);
            state.emitSync();
            processDownloadQueue();
        }
    });

    // Legacy support
    socket.on('add_song', async (data) => {
        const { url, requester } = data;
        const result = await fetchUrlInfo(url);
        if (result && result.list && result.list.length > 0) {
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
            if (!state.currentPlaying) {
                state.currentPlaying = song;
                state.playerStatus.playing = true;
            } else {
                state.playlist.push(song);
            }
            io.emit('add_success');
            state.emitSync();
            processDownloadQueue();
        } else {
            socket.emit('error_msg', 'Parse Error');
        }
    });

    socket.on('readd_history', (historyItem) => {
        const newSong = { ...historyItem, id: Date.now(), status: 'pending', progress: 0, src: null, localPath: null };
        if (!state.currentPlaying) {
            state.currentPlaying = newSong;
            state.playerStatus.playing = true;
        } else {
            state.playlist.push(newSong);
        }
        io.emit('add_success');
        state.emitSync();
        processDownloadQueue();
    });

    socket.on('next_song', (data) => {
        if (data && data.manual) {
            io.emit('exec_control', { type: 'cut' });
        }
        promoteNextSong();
    });

    socket.on('manage_queue', ({ action, id }) => {
        const index = state.playlist.findIndex(item => item.id === id);
        if (index !== -1) {
            const item = state.playlist.splice(index, 1)[0];
            if (action === 'delete') deleteSongFile(item);
            if (action === 'top') state.playlist.unshift(item);
            state.emitSync();
            processDownloadQueue();
            if (state.autoProcessKaraoke && !state.isProcessingKaraoke) processNextKaraoke();
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
        state.autoProcessKaraoke = !!enabled;
        console.log(`[Settings] autoProcessKaraoke: ${state.autoProcessKaraoke}`);
        if (state.autoProcessKaraoke) {
            queueAllReadySongsForKaraoke();
        }
        state.emitSync();
    });

    socket.on('shuffle_queue', () => {
        // Fisher-Yates shuffle
        for (let i = state.playlist.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [state.playlist[i], state.playlist[j]] = [state.playlist[j], state.playlist[i]];
        }
        console.log('[Queue] Playlist shuffled');
        state.emitSync();
        if (state.autoProcessKaraoke && !state.isProcessingKaraoke) processNextKaraoke();
    });

    socket.on('control_action', (action) => {
        if (action.type === 'toggle') state.playerStatus.playing = !state.playerStatus.playing;
        if (action.type === 'seek') state.playerStatus.currentTime = action.value;
        if (action.type === 'volume') state.playerStatus.volume = action.value;
        if (action.type === 'pitch') state.playerStatus.pitch = action.value;
        if (action.type === 'vocal_removal') {
            // Manual trigger
            if (action.value && state.currentPlaying && state.currentPlaying.status === 'ready' &&
                !state.currentPlaying.karaokeReady && !state.currentPlaying.karaokeProcessing) {
                queueKaraokeProcessing(state.currentPlaying, true); // prioritize
                console.log(`[Karaoke] Manual trigger for: ${state.currentPlaying.title}`);
            }
            state.playerStatus.vocalRemoval = action.value;
        }
        io.emit('exec_control', action);
    });

    socket.on('player_tick', (data) => {
        state.playerStatus = { ...state.playerStatus, ...data };
        io.volatile.emit('sync_tick', state.playerStatus);
    });

    socket.on('system_reset', () => {
        [...state.playlist, state.currentPlaying ? [state.currentPlaying] : [], ...state.history].flat().forEach(s => s && deleteSongFile(s));
        state.playlist = [];
        state.history = [];
        state.currentPlaying = null;
        state.playerStatus = { playing: false, currentTime: 0, duration: 0, volume: 0.8, pitch: 0, vocalRemoval: false };
        state.autoProcessKaraoke = false;
        // manualKaraokeQueue should also be cleared likely, but it's internal to karaoke service. 
        // We can ignore for now or add a clear method to karaoke service.
        state.emitSync();
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