const express = require('express');
const http = require('http');
const path = require('path');
const { exec } = require('child_process');
const { Server } = require('socket.io');

const { loadAdvancedConfig, saveAdvancedConfig, getAdvancedConfig, resetAdvancedConfigToDefault } = require('./src/config/configManager');
const { describeRuntimeBinaries, DOWNLOAD_DIR, ROOT_DIR, ensureRuntimeDirs } = require('./src/config/runtime');
const state = require('./src/utils/state');
const logger = require('./src/utils/logger');
const { createSongFromMeta, createSongFromHistoryItem, getRequesterName } = require('./src/utils/song');
const { getNetworkInterfaces, getWifiSSID, deleteSongFile } = require('./src/services/system');
const { processDownloadQueue } = require('./src/services/downloader');
const { queueKaraokeProcessing, queueAllReadySongsForKaraoke, processNextKaraoke, clearKaraokeQueue } = require('./src/services/karaoke');
const { fetchUrlInfo, lookupBilibiliFavoritesByUid } = require('./src/services/fetcher');
const { getLyricsBySongId, invalidateLyricsSession } = require('./src/services/lyrics');
const { cleanupRuntimeArtifacts } = require('./src/services/maintenance');
const {
    searchYouTubeMusic,
    getYouTubeMusicDetail,
    resolveYouTubeMusicCounterparts,
    serializeYtMusicError,
} = require('./src/services/ytmusicSearch');

const ALLOWED_LYRICS_SOURCES = new Set(['auto', 'ytmusic', 'apple_music', 'qq_music']);
const ALLOWED_QUEUE_ACTIONS = new Set(['delete', 'top']);
const pendingDeleteTimers = new Map();
let shutdownInProgress = false;

ensureRuntimeDirs();
loadAdvancedConfig();

const applyLyricsSettingsFromAdvancedConfig = (config = getAdvancedConfig()) => {
    const lyricsConfig = (config && config.lyrics && typeof config.lyrics === 'object') ? config.lyrics : {};
    state.playerStatus.lyricsEnabled = lyricsConfig.enabled !== undefined ? !!lyricsConfig.enabled : true;
    state.playerStatus.lyricsSource = ALLOWED_LYRICS_SOURCES.has(lyricsConfig.source) ? lyricsConfig.source : 'auto';
    state.playerStatus.lyricsUtatenRomajiEnabled = !!lyricsConfig.utatenRomajiEnabled;
};

applyLyricsSettingsFromAdvancedConfig();

const startupConfig = getAdvancedConfig();
if ((startupConfig.system || {}).cleanupOrphanedCacheOnStart !== false) {
    cleanupRuntimeArtifacts({ removeMedia: true, reason: 'startup' });
}

logger.info('Startup', 'Runtime binaries resolved', describeRuntimeBinaries());
logger.info('Startup', 'Advanced configuration loaded', {
    maxConcurrentDownloads: startupConfig.system.maxConcurrentDownloads,
    deleteDelayMs: startupConfig.system.deleteDelayMs,
    maxHistoryItems: startupConfig.system.maxHistoryItems,
    cleanupOrphanedCacheOnStart: startupConfig.system.cleanupOrphanedCacheOnStart,
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

state.setIO(io);

app.use(express.static(path.join(ROOT_DIR, 'public'), {
    setHeaders: (res, filePath) => {
        if (/\.(html|js|css)$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    },
}));
app.use(express.json({ limit: '256kb' }));
app.use('/downloads', express.static(DOWNLOAD_DIR));

const emitSocketError = (socket, message, details = {}, code = 'bad_request', extra = {}) => {
    socket.emit('error_msg', { message, details, code, ...extra });
};

const getRequestIdFromPayload = (payload) => {
    if (!payload || typeof payload !== 'object') return '';
    return typeof payload.requestId === 'string' ? payload.requestId.trim() : '';
};

const clampNumber = (value, fallback, min, max) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(max, Math.max(min, numeric));
};

const toBoolean = (value, fallback = false) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return fallback;
};

const summarizePayload = (payload) => {
    if (payload === null || payload === undefined) return payload;
    if (Array.isArray(payload)) return { type: 'array', length: payload.length };
    if (typeof payload === 'object') {
        return Object.keys(payload).slice(0, 10);
    }
    return payload;
};

const cancelPendingDelete = (songId) => {
    if (!pendingDeleteTimers.has(songId)) return;
    clearTimeout(pendingDeleteTimers.get(songId));
    pendingDeleteTimers.delete(songId);
};

const cancelAllPendingDeletes = () => {
    for (const timer of pendingDeleteTimers.values()) {
        clearTimeout(timer);
    }
    pendingDeleteTimers.clear();
};

const deleteSongResources = (song) => {
    if (!song || !song.id) return;
    cancelPendingDelete(song.id);
    deleteSongFile(song);
};

const buildResetSummary = () => ({
    currentPlayingId: state.currentPlaying ? state.currentPlaying.id : null,
    playlistLength: state.playlist.length,
    historyLength: state.history.length,
    trackedSongs: state.getAllSongs().length,
    activeDownloads: state.activeDownloads.size,
    activeKaraokeProcesses: state.activeKaraokeProcesses.size,
    pendingDeleteTimers: pendingDeleteTimers.size,
});

const scheduleSongCleanup = (song) => {
    if (!song || !song.id) return;

    const deleteDelayMs = clampNumber((getAdvancedConfig().system || {}).deleteDelayMs, 20000, 0, 600000);
    cancelPendingDelete(song.id);

    const timer = setTimeout(() => {
        pendingDeleteTimers.delete(song.id);
        deleteSongFile(song);
    }, deleteDelayMs);

    pendingDeleteTimers.set(song.id, timer);
};

const pushSongIntoQueue = (song) => {
    if (!state.currentPlaying) {
        state.currentPlaying = song;
        state.playerStatus.playing = true;
        return;
    }
    state.playlist.push(song);
};

const enqueueSongs = (songs, requester) => {
    const normalizedRequester = getRequesterName(requester);
    let addedCount = 0;

    for (const meta of songs) {
        const song = createSongFromMeta(meta, normalizedRequester);
        pushSongIntoQueue(song);
        addedCount += 1;
    }

    if (addedCount > 0) {
        logger.info('Queue', `Added ${addedCount} song(s) to queue`, { requester: normalizedRequester });
    }

    return addedCount;
};

const promoteNextSong = () => {
    if (state.currentPlaying) {
        const historyItem = { ...state.currentPlaying, playedAt: new Date().toISOString() };
        state.history.unshift(historyItem);
        const maxHistoryItems = clampNumber((getAdvancedConfig().system || {}).maxHistoryItems, 50, 1, 500);
        while (state.history.length > maxHistoryItems) {
            const removedHistory = state.history.pop();
            deleteSongResources(removedHistory);
        }
        scheduleSongCleanup(state.currentPlaying);
    }

    if (state.playlist.length > 0) {
        state.currentPlaying = state.playlist.shift();
        state.playerStatus.playing = true;
        state.playerStatus.currentTime = 0;
        state.playerStatus.duration = 0;
        state.playerStatus.pitch = 0;
        state.playerStatus.vocalRemoval = false;
    } else {
        state.currentPlaying = null;
        state.playerStatus.playing = false;
        state.playerStatus.currentTime = 0;
        state.playerStatus.duration = 0;
        state.playerStatus.pitch = 0;
        state.playerStatus.vocalRemoval = false;
    }

    state.emitSync();
    processDownloadQueue();
};

const resetSystemState = ({ resetAdvancedConfig = false, clearClientStorage = false, reason = 'system_reset' } = {}) => {
    const resetSummary = buildResetSummary();
    invalidateLyricsSession(reason);

    const songs = state.getAllSongs();
    for (const song of songs) {
        deleteSongResources(song);
    }

    cancelAllPendingDeletes();
    clearKaraokeQueue();
    const cleanupSummary = cleanupRuntimeArtifacts({ removeMedia: true, reason });

    const advancedConfigReset = resetAdvancedConfig ? resetAdvancedConfigToDefault() : true;

    state.resetRuntimeState();
    applyLyricsSettingsFromAdvancedConfig();
    state.emitSync();
    if (clearClientStorage) {
        io.emit('exec_control', { type: 'clear_client_storage' });
    }
    io.emit('exec_control', { type: 'reload' });
    const completedSummary = {
        ...resetSummary,
        ...cleanupSummary,
        resetAdvancedConfig,
        advancedConfigReset,
        clearClientStorage,
    };
    logger.info('System', resetAdvancedConfig ? 'Factory reset completed' : 'Runtime reset completed', completedSummary);
    return completedSummary;
};

const wrapSocketHandler = (socket, eventName, handler, fallbackMessage) => {
    socket.on(eventName, async (payload) => {
        try {
            await handler(payload);
        } catch (error) {
            const requestId = getRequestIdFromPayload(payload);
            logger.error('Socket', `Unhandled error in ${eventName}`, {
                socketId: socket.id,
                payload: summarizePayload(payload),
                error,
            });
            emitSocketError(
                socket,
                fallbackMessage || `${eventName} failed`,
                { event: eventName },
                'internal_error',
                requestId ? { requestId } : {},
            );
        }
    });
};

app.get('/api/lyrics/:songId', async (req, res) => {
    try {
        const requestedSource = typeof req.query.source === 'string' ? req.query.source : 'auto';
        const preferredSource = ALLOWED_LYRICS_SOURCES.has(requestedSource) ? requestedSource : 'auto';
        const lyrics = await getLyricsBySongId(req.params.songId, { preferredSource });
        if (!lyrics) {
            res.status(404).json({ found: false, message: 'Lyrics not found' });
            return;
        }
        res.json(lyrics);
    } catch (error) {
        logger.error('Lyrics', 'Lyrics API request failed', error);
        res.status(500).json({ found: false, message: 'Lyrics lookup failed' });
    }
});

app.get('/api/health', (_req, res) => {
    res.json({
        ok: true,
        currentPlayingId: state.currentPlaying ? state.currentPlaying.id : null,
        playlistLength: state.playlist.length,
        historyLength: state.history.length,
        activeDownloads: state.activeDownloads.size,
        activeKaraokeProcesses: state.activeKaraokeProcesses.size,
        pendingDeleteTimers: pendingDeleteTimers.size,
    });
});

app.use((error, req, res, next) => {
    if (!error) {
        next();
        return;
    }

    logger.error('HTTP', 'Request handling failed', {
        method: req.method,
        path: req.path,
        error,
    });

    if (res.headersSent) {
        next(error);
        return;
    }

    const statusCode = error.type === 'entity.parse.failed' ? 400 : 500;
    res.status(statusCode).json({
        ok: false,
        message: statusCode === 400 ? 'Invalid JSON payload' : 'Internal server error',
    });
});

io.on('connection', async (socket) => {
    logger.info('Socket', 'Client connected', { socketId: socket.id });
    state.emitSync();

    try {
        const networks = getNetworkInterfaces();
        const ssid = await getWifiSSID();
        const actualPort = server.address() ? server.address().port : PORT;
        socket.emit('system_info', { networks, ssid, port: actualPort });
    } catch (error) {
        logger.warn('Socket', 'Failed to emit system info on connect', error);
    }

    wrapSocketHandler(socket, 'parse_url', async (url) => {
        const normalizedUrl = typeof url === 'string' ? url.trim() : '';
        if (!normalizedUrl) {
            emitSocketError(socket, 'Please provide a valid URL', { event: 'parse_url' });
            return;
        }

        const result = await fetchUrlInfo(normalizedUrl);
        if (result && Array.isArray(result.list) && result.list.length > 0) {
            socket.emit('parse_result', result);
            return;
        }

        emitSocketError(socket, 'Unable to parse the provided URL', { url: normalizedUrl }, 'parse_failed');
    }, 'Failed to parse URL');

    wrapSocketHandler(socket, 'bilibili_lookup_uid', async (payload) => {
        const requestId = getRequestIdFromPayload(payload);
        const uidInput = payload && typeof payload.uid === 'string' ? payload.uid.trim() : '';
        if (!uidInput) {
            socket.emit('bilibili_uid_result', {
                requestId,
                ok: false,
                code: 'invalid_request',
                message: 'Please provide a valid Bilibili UID',
            });
            return;
        }

        try {
            const result = await lookupBilibiliFavoritesByUid(uidInput);
            socket.emit('bilibili_uid_result', {
                requestId,
                ok: true,
                ...result,
            });
        } catch (error) {
            logger.warn('Fetcher', 'Bilibili UID lookup failed', {
                socketId: socket.id,
                requestId,
                uidInput,
                error,
            });
            socket.emit('bilibili_uid_result', {
                requestId,
                ok: false,
                code: 'lookup_failed',
                message: error && error.message ? error.message : 'Unable to lookup this Bilibili UID',
            });
        }
    }, 'Failed to lookup Bilibili UID');

    wrapSocketHandler(socket, 'add_batch_songs', async (data) => {
        const songs = data && Array.isArray(data.songs) ? data.songs : [];
        const requester = data && data.requester;
        const requestId = getRequestIdFromPayload(data);
        if (songs.length === 0) {
            emitSocketError(
                socket,
                'No songs were provided to add',
                { event: 'add_batch_songs' },
                'bad_request',
                requestId ? { requestId } : {},
            );
            return;
        }

        const addedCount = enqueueSongs(songs, requester);
        if (addedCount > 0) {
            io.emit('add_success', requestId ? { count: addedCount, requestId } : { count: addedCount });
            state.emitSync();
            processDownloadQueue();
        }
    }, 'Failed to add songs');

    wrapSocketHandler(socket, 'add_song', async (data) => {
        const url = data && typeof data.url === 'string' ? data.url.trim() : '';
        const requestId = getRequestIdFromPayload(data);
        if (!url) {
            emitSocketError(
                socket,
                'Please provide a valid URL',
                { event: 'add_song' },
                'bad_request',
                requestId ? { requestId } : {},
            );
            return;
        }

        const result = await fetchUrlInfo(url);
        if (!result || !Array.isArray(result.list) || result.list.length === 0) {
            emitSocketError(
                socket,
                'Unable to parse the provided URL',
                { url },
                'parse_failed',
                requestId ? { requestId } : {},
            );
            return;
        }

        enqueueSongs([result.list[0]], data.requester);
        io.emit('add_success', requestId ? { count: 1, requestId } : { count: 1 });
        state.emitSync();
        processDownloadQueue();
    }, 'Failed to add song');

    wrapSocketHandler(socket, 'ytmusic_search', async (payload) => {
        const requestId = payload && payload.requestId ? payload.requestId : null;
        const query = payload && typeof payload.query === 'string' ? payload.query.trim() : '';

        if (!query) {
            socket.emit('ytmusic_search_result', {
                requestId,
                ok: true,
                query: '',
                filter: 'songs',
                sections: [],
                suggestions: [],
            });
            return;
        }

        try {
            const result = await searchYouTubeMusic(query, {
                filter: payload && typeof payload.filter === 'string' ? payload.filter : 'songs',
                limit: payload && payload.limit,
                language: payload && payload.language,
            });
            socket.emit('ytmusic_search_result', {
                requestId,
                ok: true,
                ...result,
            });
        } catch (error) {
            const normalizedError = serializeYtMusicError(error);
            logger.warn('YTMusic', 'Search request failed', {
                socketId: socket.id,
                requestId,
                query,
                error: normalizedError,
            });
            socket.emit('ytmusic_search_result', {
                requestId,
                ok: false,
                error: normalizedError,
                query,
                filter: payload && typeof payload.filter === 'string' ? payload.filter : 'songs',
                sections: [],
                suggestions: [],
            });
            emitSocketError(socket, normalizedError.message, normalizedError.details, normalizedError.code);
        }
    }, 'Failed to search YouTube Music');

    wrapSocketHandler(socket, 'ytmusic_get_detail', async (payload) => {
        const requestId = payload && payload.requestId ? payload.requestId : null;
        const detailRequest = payload && payload.detail && typeof payload.detail === 'object' ? payload.detail : {};

        try {
            const detail = await getYouTubeMusicDetail({
                ...detailRequest,
                language: detailRequest.language || (payload && payload.language),
            });
            socket.emit('ytmusic_detail_result', {
                requestId,
                ok: true,
                detail,
            });
        } catch (error) {
            const normalizedError = serializeYtMusicError(error);
            logger.warn('YTMusic', 'Detail request failed', {
                socketId: socket.id,
                requestId,
                detailRequest: summarizePayload(detailRequest),
                error: normalizedError,
            });
            socket.emit('ytmusic_detail_result', {
                requestId,
                ok: false,
                error: normalizedError,
            });
            emitSocketError(socket, normalizedError.message, normalizedError.details, normalizedError.code);
        }
    }, 'Failed to load YouTube Music detail');

    wrapSocketHandler(socket, 'ytmusic_resolve_counterparts', async (payload) => {
        const requestId = payload && payload.requestId ? payload.requestId : null;
        const tracks = payload && Array.isArray(payload.tracks) ? payload.tracks : [];

        try {
            const items = await resolveYouTubeMusicCounterparts(tracks, {
                language: payload && payload.language,
            });
            socket.emit('ytmusic_counterparts_result', {
                requestId,
                ok: true,
                items,
            });
        } catch (error) {
            const normalizedError = serializeYtMusicError(error);
            logger.warn('YTMusic', 'Counterpart resolution failed', {
                socketId: socket.id,
                requestId,
                trackCount: tracks.length,
                error: normalizedError,
            });
            socket.emit('ytmusic_counterparts_result', {
                requestId,
                ok: false,
                error: normalizedError,
                items: [],
            });
        }
    }, 'Failed to resolve YouTube Music counterparts');

    wrapSocketHandler(socket, 'readd_history', async (historyItem) => {
        const requestId = getRequestIdFromPayload(historyItem);
        if (!historyItem || typeof historyItem !== 'object') {
            emitSocketError(
                socket,
                'Invalid history entry',
                { event: 'readd_history' },
                'bad_request',
                requestId ? { requestId } : {},
            );
            return;
        }

        const replaySong = createSongFromHistoryItem(historyItem);
        pushSongIntoQueue(replaySong);
        io.emit('add_success', requestId ? { count: 1, requestId } : { count: 1 });
        state.emitSync();
        processDownloadQueue();
    }, 'Failed to re-add song from history');

    wrapSocketHandler(socket, 'next_song', async (data) => {
        if (data && data.manual) {
            io.emit('exec_control', { type: 'cut' });
        }
        promoteNextSong();
    }, 'Failed to skip song');

    wrapSocketHandler(socket, 'manage_queue', async (payload) => {
        const action = payload && payload.action;
        const id = payload && payload.id;
        if (!ALLOWED_QUEUE_ACTIONS.has(action)) {
            emitSocketError(socket, 'Unsupported queue action', { action }, 'invalid_action');
            return;
        }

        const index = state.playlist.findIndex((item) => item.id === id);
        if (index === -1) {
            emitSocketError(socket, 'Song was not found in queue', { id }, 'not_found');
            return;
        }

        const item = state.playlist.splice(index, 1)[0];
        if (action === 'delete') {
            deleteSongResources(item);
            logger.info('Queue', `Deleted song from queue: ${item.title}`, { songId: item.id });
        }
        if (action === 'top') {
            state.playlist.unshift(item);
            logger.info('Queue', `Moved song to top: ${item.title}`, { songId: item.id });
        }

        state.emitSync();
        processDownloadQueue();
        if (state.autoProcessKaraoke && !state.isProcessingKaraoke) processNextKaraoke();
    }, 'Failed to update queue');

    wrapSocketHandler(socket, 'get_advanced_config', async () => {
        socket.emit('advanced_config', getAdvancedConfig());
    }, 'Failed to load advanced settings');

    wrapSocketHandler(socket, 'set_advanced_config', async (config) => {
        if (!config || typeof config !== 'object') {
            emitSocketError(socket, 'Invalid advanced config payload', { event: 'set_advanced_config' });
            return;
        }

        const ok = saveAdvancedConfig(config);
        if (!ok) {
            emitSocketError(socket, 'Failed to save advanced settings', {}, 'save_failed');
            return;
        }

        const nextConfig = getAdvancedConfig();
        applyLyricsSettingsFromAdvancedConfig(nextConfig);
        socket.emit('advanced_config', nextConfig);
        socket.emit('advanced_config_saved');
        io.volatile.emit('sync_tick', state.playerStatus);
        state.emitSync();
        logger.info('Config', 'Advanced settings updated');
    }, 'Failed to save advanced settings');

    wrapSocketHandler(socket, 'reset_advanced_config', async () => {
        const ok = resetAdvancedConfigToDefault();
        if (!ok) {
            emitSocketError(socket, 'Failed to restore default settings', {}, 'restore_failed');
            return;
        }

        const nextConfig = getAdvancedConfig();
        applyLyricsSettingsFromAdvancedConfig(nextConfig);
        socket.emit('advanced_config', nextConfig);
        socket.emit('advanced_config_saved');
        io.volatile.emit('sync_tick', state.playerStatus);
        state.emitSync();
        logger.info('Config', 'Advanced settings restored to defaults');
    }, 'Failed to restore advanced settings');

    wrapSocketHandler(socket, 'set_auto_process', async (enabled) => {
        state.autoProcessKaraoke = !!enabled;
        logger.info('Settings', 'Updated auto karaoke processing', { enabled: state.autoProcessKaraoke });
        if (state.autoProcessKaraoke) {
            queueAllReadySongsForKaraoke();
        }
        state.emitSync();
    }, 'Failed to update auto-process setting');

    wrapSocketHandler(socket, 'shuffle_queue', async () => {
        if (state.playlist.length < 2) return;
        for (let i = state.playlist.length - 1; i > 0; i -= 1) {
            const j = Math.floor(Math.random() * (i + 1));
            [state.playlist[i], state.playlist[j]] = [state.playlist[j], state.playlist[i]];
        }
        logger.info('Queue', 'Playlist shuffled', { size: state.playlist.length });
        state.emitSync();
        if (state.autoProcessKaraoke && !state.isProcessingKaraoke) processNextKaraoke();
    }, 'Failed to shuffle queue');

    wrapSocketHandler(socket, 'control_action', async (action) => {
        if (!action || typeof action !== 'object' || typeof action.type !== 'string') {
            emitSocketError(socket, 'Invalid control action', { action: summarizePayload(action) });
            return;
        }

        const nextAction = { ...action };
        switch (nextAction.type) {
            case 'toggle':
                state.playerStatus.playing = !state.playerStatus.playing;
                break;
            case 'seek':
                nextAction.value = clampNumber(nextAction.value, state.playerStatus.currentTime, 0, Number.MAX_SAFE_INTEGER);
                state.playerStatus.currentTime = nextAction.value;
                break;
            case 'volume':
                nextAction.value = clampNumber(nextAction.value, state.playerStatus.volume, 0, 1);
                state.playerStatus.volume = nextAction.value;
                break;
            case 'pitch':
                nextAction.value = clampNumber(nextAction.value, state.playerStatus.pitch, -12, 12);
                state.playerStatus.pitch = nextAction.value;
                break;
            case 'lyrics_toggle':
                nextAction.value = toBoolean(nextAction.value, state.playerStatus.lyricsEnabled);
                state.playerStatus.lyricsEnabled = nextAction.value;
                break;
            case 'lyrics_source':
                nextAction.value = ALLOWED_LYRICS_SOURCES.has(nextAction.value) ? nextAction.value : 'auto';
                state.playerStatus.lyricsSource = nextAction.value;
                break;
            case 'loudness_norm':
                nextAction.value = toBoolean(nextAction.value, state.playerStatus.loudnessNorm);
                state.playerStatus.loudnessNorm = nextAction.value;
                break;
            case 'vocal_removal':
                nextAction.value = toBoolean(nextAction.value, state.playerStatus.vocalRemoval);
                if (
                    nextAction.value &&
                    state.currentPlaying &&
                    state.currentPlaying.status === 'ready' &&
                    !state.currentPlaying.karaokeReady &&
                    !state.currentPlaying.karaokeProcessing
                ) {
                    queueKaraokeProcessing(state.currentPlaying, true);
                    logger.info('Karaoke', `Manual karaoke trigger for ${state.currentPlaying.title}`, {
                        songId: state.currentPlaying.id,
                    });
                }
                state.playerStatus.vocalRemoval = nextAction.value;
                break;
            case 'replay':
                state.playerStatus.currentTime = 0;
                state.playerStatus.playing = true;
                break;
            case 'seek_fwd':
            case 'seek_rew':
            case 'reload':
            case 'cut':
                break;
            default:
                emitSocketError(socket, 'Unsupported control action', { type: nextAction.type }, 'invalid_action');
                return;
        }

        io.emit('exec_control', nextAction);
        io.volatile.emit('sync_tick', state.playerStatus);
        state.emitSync();
    }, 'Failed to execute control action');

    wrapSocketHandler(socket, 'player_tick', async (data) => {
        if (!data || typeof data !== 'object') return;

        const nextStatus = { ...state.playerStatus };
        if (data.playing !== undefined) nextStatus.playing = !!data.playing;
        if (data.currentTime !== undefined) nextStatus.currentTime = clampNumber(data.currentTime, nextStatus.currentTime, 0, Number.MAX_SAFE_INTEGER);
        if (data.duration !== undefined) nextStatus.duration = clampNumber(data.duration, nextStatus.duration, 0, Number.MAX_SAFE_INTEGER);
        if (data.volume !== undefined) nextStatus.volume = clampNumber(data.volume, nextStatus.volume, 0, 1);
        if (data.pitch !== undefined) nextStatus.pitch = clampNumber(data.pitch, nextStatus.pitch, -12, 12);
        if (data.vocalRemoval !== undefined) nextStatus.vocalRemoval = !!data.vocalRemoval;
        if (data.loudnessNorm !== undefined) nextStatus.loudnessNorm = !!data.loudnessNorm;
        if (data.lyricsEnabled !== undefined) nextStatus.lyricsEnabled = !!data.lyricsEnabled;
        if (data.lyricsSource !== undefined) nextStatus.lyricsSource = ALLOWED_LYRICS_SOURCES.has(data.lyricsSource) ? data.lyricsSource : nextStatus.lyricsSource;
        if (data.lyricsUtatenRomajiEnabled !== undefined) nextStatus.lyricsUtatenRomajiEnabled = !!data.lyricsUtatenRomajiEnabled;

        state.playerStatus = nextStatus;
        io.volatile.emit('sync_tick', state.playerStatus);
    }, 'Failed to sync player tick');

    wrapSocketHandler(socket, 'system_reset', async () => {
        resetSystemState({
            resetAdvancedConfig: false,
            clearClientStorage: false,
            reason: 'system_reset',
        });
    }, 'Failed to reset system');

    wrapSocketHandler(socket, 'system_factory_reset', async () => {
        const result = resetSystemState({
            resetAdvancedConfig: true,
            clearClientStorage: true,
            reason: 'system_factory_reset',
        });

        if (!result.advancedConfigReset) {
            emitSocketError(socket, 'Factory reset completed with warnings', result, 'partial_failure');
        }
    }, 'Failed to perform factory reset');

    socket.on('disconnect', (reason) => {
        logger.info('Socket', 'Client disconnected', { socketId: socket.id, reason });
    });
});

const openPlayerInBrowser = (port) => {
    if (process.env.NO_AUTO_OPEN === '1' || process.env.CI === 'true') {
        logger.info('System', 'Browser auto-open is disabled by environment', { port });
        return;
    }

    const url = `http://localhost:${port}/player.html`;
    logger.info('System', 'Attempting to open browser', { url });

    let command;
    switch (process.platform) {
        case 'win32':
            command = `start "" "${url}"`;
            break;
        case 'darwin':
            command = `open "${url}"`;
            break;
        default:
            command = `xdg-open "${url}"`;
            break;
    }

    exec(command, (error) => {
        if (error) {
            logger.warn('System', 'Failed to open browser automatically', error);
        }
    });
};

const performShutdownCleanup = () => {
    invalidateLyricsSession('shutdown');
    cancelAllPendingDeletes();
    clearKaraokeQueue();
    for (const song of state.getAllSongs()) {
        deleteSongFile(song);
    }
    cleanupRuntimeArtifacts({ removeMedia: true, reason: 'shutdown' });
};

const shutdownProcess = (exitCode, reason, error) => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    logger.error('Process', reason, error);

    try {
        performShutdownCleanup();
    } catch (cleanupError) {
        logger.error('Process', 'Shutdown cleanup failed', cleanupError);
    }

    server.close(() => {
        process.exit(exitCode);
    });

    setTimeout(() => process.exit(exitCode), 3000).unref();
};

process.on('unhandledRejection', (error) => {
    logger.error('Process', 'Unhandled promise rejection', error);
});

process.on('uncaughtException', (error) => {
    shutdownProcess(1, 'Uncaught exception', error);
});

['SIGINT', 'SIGTERM'].forEach((signal) => {
    process.on(signal, () => {
        if (shutdownInProgress) return;
        shutdownInProgress = true;
        logger.warn('Process', `Received ${signal}, cleaning up before exit`);
        performShutdownCleanup();
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000).unref();
    });
});

server.on('error', (error) => {
    logger.error('Server', 'HTTP server error', error);
});

const PORT = 0;
server.listen(PORT, '0.0.0.0', () => {
    const actualPort = server.address().port;
    logger.info('Server', 'Server started', { port: actualPort });
    openPlayerInBrowser(actualPort);
});
