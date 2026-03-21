const os = require('os');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const { getAdvancedConfig } = require('../config/configManager');
const { DOWNLOAD_DIR, SEPARATED_DIR, FFMPEG_EXE, ensureRuntimeDirs, getCookiesPath } = require('../config/runtime');
const state = require('../utils/state');
const logger = require('../utils/logger');
const { deleteLyricsCache } = require('./lyrics');

ensureRuntimeDirs();

const pendingFileDeleteRetries = new Map();

const safeKillProcessTree = (proc, label) => {
    if (!proc || !proc.pid) return;

    if (process.platform === 'win32') {
        try {
            spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], { shell: true })
                .on('error', (error) => logger.warn('Process', `taskkill failed for ${label}`, error));
            return;
        } catch (error) {
            logger.warn('Process', `taskkill threw for ${label}`, error);
        }
    }

    try {
        proc.kill('SIGKILL');
    } catch (error) {
        logger.warn('Process', `Failed to terminate ${label}`, error);
    }
};

const safeReadDir = (dirPath) => {
    try {
        return fs.readdirSync(dirPath);
    } catch (error) {
        logger.warn('System', `Failed to list directory: ${dirPath}`, error);
        return [];
    }
};

const safeReadDirEntries = (dirPath) => {
    try {
        return fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (error) {
        logger.warn('System', `Failed to list directory entries: ${dirPath}`, error);
        return [];
    }
};

const clearPendingFileDeleteRetry = (filePath) => {
    const timer = pendingFileDeleteRetries.get(filePath);
    if (!timer) return;
    clearTimeout(timer);
    pendingFileDeleteRetries.delete(filePath);
};

const scheduleFileDeleteRetry = (filePath, retries, delayMs) => {
    clearPendingFileDeleteRetry(filePath);
    const timer = setTimeout(() => {
        pendingFileDeleteRetries.delete(filePath);
        deleteFileWithRetries(filePath, retries, delayMs);
    }, delayMs);
    pendingFileDeleteRetries.set(filePath, timer);
};

const deleteFileWithRetries = (filePath, retries = 3, delayMs = 1000) => {
    if (!filePath) return;
    if (!fs.existsSync(filePath)) {
        clearPendingFileDeleteRetry(filePath);
        return;
    }

    try {
        fs.unlinkSync(filePath);
        clearPendingFileDeleteRetry(filePath);
        logger.info('System', 'Deleted file', { filePath });
    } catch (error) {
        if (retries > 0) {
            scheduleFileDeleteRetry(filePath, retries - 1, delayMs);
            return;
        }
        clearPendingFileDeleteRetry(filePath);
        logger.warn('System', `Failed to delete file after retries: ${filePath}`, error);
    }
};

const deleteGeneratedFilesBySongId = (songId) => {
    if (!songId) return;
    const prefixes = [
        `${songId}_video`,
        `${songId}_audio`,
        `${songId}_karaoke`,
        `${songId}_lyrics_`,
        `${songId}_lyriccap`,
    ];

    for (const filename of safeReadDir(DOWNLOAD_DIR)) {
        if (!prefixes.some((prefix) => filename.startsWith(prefix))) continue;
        deleteFileWithRetries(path.join(DOWNLOAD_DIR, filename));
    }
};

const removeSeparatedSongArtifacts = (songId) => {
    if (!songId) return 0;

    const removedPaths = [];
    const directOutputDir = path.join(SEPARATED_DIR, `${songId}_audio`);

    if (fs.existsSync(directOutputDir)) {
        try {
            fs.rmSync(directOutputDir, { recursive: true, force: true });
            removedPaths.push(directOutputDir);
        } catch (error) {
            logger.warn('System', `Failed to delete separated directory: ${directOutputDir}`, error);
        }
    }

    for (const entry of safeReadDirEntries(SEPARATED_DIR)) {
        if (!entry.isDirectory()) continue;
        const songSeparatedDir = path.join(SEPARATED_DIR, entry.name, `${songId}_audio`);
        if (!fs.existsSync(songSeparatedDir)) continue;
        try {
            fs.rmSync(songSeparatedDir, { recursive: true, force: true });
            removedPaths.push(songSeparatedDir);
        } catch (error) {
            logger.warn('System', `Failed to delete separated directory: ${songSeparatedDir}`, error);
        }
    }

    if (removedPaths.length > 0) {
        logger.info('System', 'Deleted separated directories', {
            songId,
            paths: removedPaths,
        });
    }

    return removedPaths.length;
};

const getNetworkInterfaces = () => {
    const nets = os.networkInterfaces();
    const results = [];

    for (const name of Object.keys(nets)) {
        const interfaces = Array.isArray(nets[name]) ? nets[name] : [];
        for (const net of interfaces) {
            if (!net || net.family !== 'IPv4' || net.internal) continue;
            results.push({
                name,
                ip: net.address,
            });
        }
    }

    return results.length > 0 ? results : [{ name: 'Localhost', ip: '127.0.0.1' }];
};

const getWifiSSID = () => new Promise((resolve) => {
    if (process.platform !== 'win32') {
        resolve('Unsupported on this OS');
        return;
    }

    exec('netsh wlan show interfaces', { timeout: 5000 }, (error, stdout) => {
        if (error) {
            logger.warn('System', 'Failed to query Wi-Fi SSID', error);
            resolve('Unknown Network');
            return;
        }

        const match = stdout.match(/^\s*SSID\s*:\s*(.+)$/m);
        if (match && match[1]) {
            resolve(match[1].trim());
            return;
        }

        resolve('Wired / Hotspot');
    });
});

const deleteSongFile = (song) => {
    if (!song || !song.id) return;

    const downloadProc = state.activeDownloads.get(song.id);
    if (downloadProc) {
        logger.info('System', `Cancelling download for ${song.title}`, { songId: song.id });
        downloadProc.__terminatedBySystem = true;
        downloadProc.__terminationReason = 'song_cleanup';
        safeKillProcessTree(downloadProc, `download:${song.id}`);
        state.activeDownloads.delete(song.id);
        if (state.currentDownloadingId === song.id) {
            state.currentDownloadingId = null;
            state.isDownloading = false;
        }
    }

    const activeKaraoke = state.activeKaraokeProcesses.get(song.id);
    if (activeKaraoke) {
        logger.info('System', `Cancelling karaoke processing for ${song.title}`, { songId: song.id });
        activeKaraoke.proc.__terminatedBySystem = true;
        activeKaraoke.proc.__terminationReason = 'song_cleanup';
        safeKillProcessTree(activeKaraoke.proc, `karaoke:${song.id}`);
        if (activeKaraoke.song) {
            activeKaraoke.song.karaokeProcessing = false;
            activeKaraoke.song.karaokeProgress = 0;
        }
        state.activeKaraokeProcesses.delete(song.id);
        if (state.activeKaraokeProcesses.size === 0) {
            state.isProcessingKaraoke = false;
        }
    }

    removeSeparatedSongArtifacts(song.id);

    if (song.localVideoPath) deleteFileWithRetries(song.localVideoPath);
    if (song.localAudioPath) deleteFileWithRetries(song.localAudioPath);
    deleteGeneratedFilesBySongId(song.id);
    deleteLyricsCache(song.id);
};

const analyzeLoudness = (audioPath) => new Promise((resolve) => {
    const fcfg = getAdvancedConfig().ffmpeg || {};
    const I = fcfg.loudnessI != null ? fcfg.loudnessI : -16;
    const TP = fcfg.loudnessTP != null ? fcfg.loudnessTP : -1.5;
    const LRA = fcfg.loudnessLRA != null ? fcfg.loudnessLRA : 11;
    const clamp = Math.max(0, fcfg.loudnessGainClamp != null ? fcfg.loudnessGainClamp : 12);
    const ffmpegArgs = [
        '-i', audioPath,
        '-af', `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:print_format=json`,
        '-f', 'null',
        '-',
    ];

    logger.info('Loudness', `Analyzing ${path.basename(audioPath)}`);

    const proc = spawn(FFMPEG_EXE, ffmpegArgs, { shell: false });
    let stderr = '';
    let settled = false;

    const finalize = (gain) => {
        if (settled) return;
        settled = true;
        resolve(gain);
    };

    const timer = setTimeout(() => {
        safeKillProcessTree(proc, `ffmpeg:${path.basename(audioPath)}`);
        logger.warn('Loudness', `FFmpeg analysis timed out for ${audioPath}`);
        finalize(0);
    }, 30000);

    proc.stderr.on('data', (data) => {
        stderr += data.toString();
    });

    proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
            logger.warn('Loudness', 'FFmpeg analysis failed, falling back to 0dB gain', { code, audioPath });
            finalize(0);
            return;
        }

        try {
            const jsonMatch = stderr.match(/\{[\s\S]*"input_i"[\s\S]*\}/);
            if (!jsonMatch) {
                logger.warn('Loudness', 'Could not parse FFmpeg loudness output', { audioPath });
                finalize(0);
                return;
            }

            const loudnessData = JSON.parse(jsonMatch[0]);
            const inputLUFS = parseFloat(loudnessData.input_i);
            const gain = I - inputLUFS;
            const clampedGain = Math.max(-clamp, Math.min(clamp, gain));
            logger.info('Loudness', 'Analysis completed', {
                inputLUFS: Number.isFinite(inputLUFS) ? Number(inputLUFS.toFixed(1)) : null,
                clampedGain: Number(clampedGain.toFixed(2)),
            });
            finalize(clampedGain);
        } catch (error) {
            logger.warn('Loudness', 'Failed to parse FFmpeg loudness JSON', error);
            finalize(0);
        }
    });

    proc.on('error', (error) => {
        clearTimeout(timer);
        logger.error('Loudness', 'Failed to spawn FFmpeg', error);
        finalize(0);
    });
});

module.exports = {
    getNetworkInterfaces,
    getWifiSSID,
    getCookiesPath,
    deleteSongFile,
    removeSeparatedSongArtifacts,
    analyzeLoudness,
};
