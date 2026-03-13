const path = require('path');
const { spawn } = require('child_process');

const { getAdvancedConfig } = require('../config/configManager');
const {
    DOWNLOAD_DIR,
    YT_DLP_EXE,
    ensureRuntimeDirs,
    buildChildProcessEnv,
    appendYtDlpJsRuntimeArgs,
    isYouTubeLikeUrl,
} = require('../config/runtime');
const state = require('../utils/state');
const logger = require('../utils/logger');
const { setSongError } = require('../utils/song');
const { analyzeLoudness, deleteSongFile, getCookiesPath } = require('./system');
const { queueKaraokeProcessing } = require('./karaoke');
const { prefetchLyrics } = require('./lyrics');

ensureRuntimeDirs();

const emitProgress = (song, progress) => {
    if (!song) return;
    const nextProgress = Math.max(0, Math.min(100, Number(progress) || 0));
    if (nextProgress <= (song.progress || 0)) return;
    song.progress = nextProgress;
    if (state.io) {
        state.io.emit('update_progress', { id: song.id, progress: nextProgress });
    }
};

const emitSongError = (song, stage, message, details) => {
    setSongError(song, message, stage);
    logger.error('Download', message, {
        songId: song && song.id,
        title: song && song.title,
        stage,
        ...details,
    });

    if (state.io && song) {
        state.io.emit('song_error', {
            id: song.id,
            title: song.title,
            stage,
            message,
        });
    }
};

const resetDownloadFlags = (songId) => {
    state.activeDownloads.delete(songId);
    if (state.currentDownloadingId === songId) {
        state.currentDownloadingId = null;
        state.isDownloading = false;
    }
};

const advanceQueueAfterFailure = (song) => {
    if (!song) return;

    if (state.currentPlaying && state.currentPlaying.id === song.id) {
        state.currentPlaying = state.playlist.length > 0 ? state.playlist.shift() : null;
        state.playerStatus.playing = !!state.currentPlaying;
        state.playerStatus.currentTime = 0;
        state.playerStatus.duration = 0;
        state.playerStatus.pitch = 0;
        state.playerStatus.vocalRemoval = false;
        return;
    }

    const queueIndex = state.playlist.findIndex((item) => item.id === song.id);
    if (queueIndex !== -1) {
        state.playlist.splice(queueIndex, 1);
    }
};

const handleDownloadError = (song, stage, message, details) => {
    if (!song) return;
    resetDownloadFlags(song.id);
    song.status = 'error';
    emitSongError(song, stage, message, details);
    deleteSongFile(song);
    advanceQueueAfterFailure(song);
    state.emitSync();
    processDownloadQueue();
};

const appendSharedYtDlpArgs = (args, cfg, cookies, originalUrl, { includeHttpChunkSize = false, includeFragmentRetries = false } = {}) => {
    appendYtDlpJsRuntimeArgs(args, originalUrl);
    if (cfg.noPlaylist !== false) args.push('--no-playlist');
    if (cfg.concurrentFragments) args.push('-N', String(cfg.concurrentFragments));
    if (includeHttpChunkSize && cfg.httpChunkSize) args.push('--http-chunk-size', cfg.httpChunkSize);
    if (cfg.proxy) args.push('--proxy', cfg.proxy);
    if (cfg.socketTimeout) args.push('--socket-timeout', String(cfg.socketTimeout));
    if (cfg.retries !== undefined && cfg.retries !== null) args.push('--retries', String(cfg.retries));
    if (includeFragmentRetries && cfg.fragmentRetries !== undefined && cfg.fragmentRetries !== null) {
        args.push('--fragment-retries', String(cfg.fragmentRetries));
    }
    if (cfg.userAgent) args.push('--user-agent', cfg.userAgent);
    if (cfg.noCheckCertificates) args.push('--no-check-certificates');
    if (cfg.limitRate) args.push('--limit-rate', cfg.limitRate);
    if (cfg.forceIPv4) args.push('--force-ipv4');
    if (cfg.forceIPv6) args.push('--force-ipv6');
    if (cfg.noPart) args.push('--no-part');
    if (cfg.restrictFilenames) args.push('--restrict-filenames');
    if (cfg.windowsFilenames) args.push('--windows-filenames');
    if (cfg.noOverwrites) args.push('--no-overwrites');
    if (cfg.ignoreErrors) args.push('--ignore-errors');
    if (cfg.abortOnError) args.push('--abort-on-error');
    if (cfg.noWarnings) args.push('--no-warnings');

    if (Array.isArray(cfg.addHeader) && cfg.addHeader.length) {
        cfg.addHeader.forEach((header) => args.push('--add-header', header));
    }

    if (cfg.extractorArgs) {
        cfg.extractorArgs.split(/\s+/).filter(Boolean).forEach((value) => args.push(value));
    }

    if (cfg.postprocessorArgs) {
        cfg.postprocessorArgs.split(/\s+/).filter(Boolean).forEach((value) => args.push(value));
    }

    if (cookies) args.push('--cookies', cookies);
};

const attachProgressListeners = (proc, song, { baseProgress, spanProgress }) => {
    const logTail = [];
    const pushLogLine = (source, line) => {
        const trimmed = String(line || '').trim();
        if (!trimmed) return;
        logTail.push(`[${source}] ${trimmed}`);
        if (logTail.length > 30) logTail.shift();
    };

    const handleChunk = (source) => (data) => {
        const text = data.toString();
        const lines = text.split(/\r?\n/);
        for (const line of lines) {
            if (!line.trim()) continue;
            pushLogLine(source, line);
            const match = line.match(/(\d+(?:\.\d+)?)%/);
            if (!match) continue;
            const percent = baseProgress + (parseFloat(match[1]) * spanProgress);
            emitProgress(song, percent);
        }
    };

    proc.stdout.on('data', handleChunk('stdout'));
    proc.stderr.on('data', handleChunk('stderr'));

    return () => logTail.join('\n');
};

const shouldRetryWithFallbackFormat = (stageName, output = '') => {
    const normalized = String(output || '').toLowerCase();
    if (stageName !== 'video' && stageName !== 'audio') return false;
    return normalized.includes('requested format is not available')
        || normalized.includes('no video formats')
        || normalized.includes('no audio formats')
        || normalized.includes('format not available');
};

const buildVideoFormatCandidates = (configuredFormat) => {
    const candidates = [
        configuredFormat || 'bestvideo[ext=mp4]/bestvideo',
        'best[ext=mp4]/best',
    ];
    return [...new Set(candidates.filter(Boolean))];
};

const buildAudioFormatCandidates = (configuredFormat) => {
    const candidates = [
        configuredFormat || 'bestaudio[ext=m4a]/bestaudio',
        'bestaudio/best',
    ];
    return [...new Set(candidates.filter(Boolean))];
};

const buildVideoArgs = ({ cfg, cookies, outputPath, originalUrl, format }) => {
    const args = ['-f', format, '-o', outputPath];
    appendSharedYtDlpArgs(args, cfg, cookies, originalUrl, { includeHttpChunkSize: true, includeFragmentRetries: true });
    if (isYouTubeLikeUrl(originalUrl)) {
        args.push('--remux-video', 'mp4');
    }
    args.push(originalUrl);
    return args;
};

const buildAudioArgs = ({ cfg, cookies, outputPath, originalUrl, format }) => {
    const args = ['-f', format, '-o', outputPath];
    appendSharedYtDlpArgs(args, cfg, cookies, originalUrl, { includeFragmentRetries: true });
    args.push(originalUrl);
    return args;
};

const runDownloadStage = ({ song, stageName, attemptFormats, baseProgress, spanProgress, createArgs, onSuccess }) => {
    const formats = Array.isArray(attemptFormats) && attemptFormats.length > 0 ? attemptFormats : [null];
    let attemptIndex = 0;

    const startAttempt = () => {
        const currentFormat = formats[attemptIndex];
        const args = createArgs(currentFormat);
        const proc = spawn(YT_DLP_EXE, args, { shell: false, env: buildChildProcessEnv() });
        state.activeDownloads.set(song.id, proc);
        const getTailLogs = attachProgressListeners(proc, song, { baseProgress, spanProgress });

        logger.info('Download', `Starting ${stageName} attempt ${attemptIndex + 1} for ${song.title}`, {
            songId: song.id,
            format: currentFormat,
        });

        proc.on('close', async (code) => {
            const output = getTailLogs();
            if (proc.__terminatedBySystem) {
                resetDownloadFlags(song.id);
                logger.info('Download', `${stageName} stage terminated during cleanup`, {
                    songId: song.id,
                    title: song.title,
                    reason: proc.__terminationReason || 'cleanup',
                    code,
                });
                return;
            }

            if (code !== 0) {
                if (attemptIndex < formats.length - 1 && shouldRetryWithFallbackFormat(stageName, output)) {
                    logger.warn('Download', `${stageName} attempt ${attemptIndex + 1} failed, retrying with fallback format`, {
                        songId: song.id,
                        output,
                    });
                    attemptIndex += 1;
                    startAttempt();
                    return;
                }

                handleDownloadError(song, stageName, `${stageName} download failed`, {
                    code,
                    output,
                    attemptsTried: attemptIndex + 1,
                });
                return;
            }

            try {
                await onSuccess();
            } catch (error) {
                handleDownloadError(song, stageName, `${stageName} post-processing failed`, {
                    error,
                    output,
                });
            }
        });

        proc.on('error', (error) => {
            if (proc.__terminatedBySystem) {
                resetDownloadFlags(song.id);
                logger.info('Download', `${stageName} spawn terminated during cleanup`, {
                    songId: song.id,
                    title: song.title,
                    reason: proc.__terminationReason || 'cleanup',
                });
                return;
            }
            handleDownloadError(song, stageName, `${stageName} spawn failed`, error);
        });
    };

    startAttempt();
};

const startDownload = (song) => {
    if (!song || state.activeDownloads.has(song.id)) return;

    const isCurrent = state.currentPlaying && state.currentPlaying.id === song.id;
    if (isCurrent) {
        state.isDownloading = true;
        state.currentDownloadingId = song.id;
    }

    const cfg = getAdvancedConfig().ytdlp;
    const cookies = getCookiesPath(song.originalUrl);
    const videoFilename = `${song.id}_video.mp4`;
    const audioFilename = `${song.id}_audio.m4a`;
    const videoPath = path.join(DOWNLOAD_DIR, videoFilename);
    const audioPath = path.join(DOWNLOAD_DIR, audioFilename);

    song.status = 'downloading';
    song.progress = 0;
    song.localVideoPath = videoPath;
    song.localAudioPath = audioPath;
    song.lastError = null;
    state.emitSync();

    logger.info('Download', `Starting download for ${song.title}`, {
        songId: song.id,
        originalUrl: song.originalUrl,
    });

    runDownloadStage({
        song,
        stageName: 'video',
        attemptFormats: buildVideoFormatCandidates(cfg.videoFormat),
        baseProgress: 0,
        spanProgress: 0.5,
        createArgs: (format) => buildVideoArgs({
            cfg,
            cookies,
            outputPath: videoPath,
            originalUrl: song.originalUrl,
            format,
        }),
        onSuccess: async () => {
            logger.info('Download', `Video stage completed for ${song.title}`, { file: videoFilename });

            runDownloadStage({
                song,
                stageName: 'audio',
                attemptFormats: buildAudioFormatCandidates(cfg.audioFormat),
                baseProgress: 50,
                spanProgress: 0.3,
                createArgs: (format) => buildAudioArgs({
                    cfg,
                    cookies,
                    outputPath: audioPath,
                    originalUrl: song.originalUrl,
                    format,
                }),
                onSuccess: async () => {
                    logger.info('Download', `Audio stage completed for ${song.title}`, { file: audioFilename });
                    emitProgress(song, 80);
                    const loudnessGain = await analyzeLoudness(audioPath);
                    emitProgress(song, 95);
                    resetDownloadFlags(song.id);

                    song.status = 'ready';
                    song.progress = 100;
                    song.src = `/downloads/${videoFilename}`;
                    song.audioSrc = `/downloads/${audioFilename}`;
                    song.loudnessGain = loudnessGain;
                    song.karaokeReady = false;
                    song.karaokeProcessing = false;
                    song.karaokeProgress = 0;
                    song.karaokeSrc = null;
                    song.lyricsData = null;
                    song.lyricsStatus = 'loading';
                    song.lyricsSource = null;
                    song.lyricsType = null;
                    song.lyricsAvailable = false;

                    if (state.autoProcessKaraoke) queueKaraokeProcessing(song);
                    if (state.currentPlaying && state.currentPlaying.id === song.id) {
                        state.playerStatus.playing = true;
                    }

                    logger.info('Download', `Song is ready: ${song.title}`, {
                        songId: song.id,
                        loudnessGain: Number(loudnessGain.toFixed(2)),
                    });

                    state.emitSync();
                    prefetchLyrics(song);
                    processDownloadQueue();
                },
            });
        },
    });
};

const processDownloadQueue = () => {
    const maxConcurrent = Math.max(1, Math.min(5, (getAdvancedConfig().system || {}).maxConcurrentDownloads || 1));
    if (state.activeDownloads.size >= maxConcurrent) return;

    const pendingSongs = [];
    if (state.currentPlaying && state.currentPlaying.status === 'pending') {
        pendingSongs.push(state.currentPlaying);
    }
    state.playlist.forEach((song) => {
        if (song && song.status === 'pending') pendingSongs.push(song);
    });

    for (const song of pendingSongs) {
        if (state.activeDownloads.size >= maxConcurrent) break;
        if (state.activeDownloads.has(song.id)) continue;
        startDownload(song);
    }
};

module.exports = {
    startDownload,
    processDownloadQueue,
};
