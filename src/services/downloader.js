const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getAdvancedConfig } = require('../config/configManager');
const state = require('../utils/state');
const { analyzeLoudness, getCookiesPath } = require('./system');
const { queueKaraokeProcessing } = require('./karaoke');

const ROOT_DIR = path.join(__dirname, '../../');
const DOWNLOAD_DIR = path.join(ROOT_DIR, 'downloads');

// Ensure download directory exists
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

const handleDownloadError = (song, message) => {
    state.activeDownloads.delete(song.id);
    if (state.currentDownloadingId === song.id) {
        state.currentDownloadingId = null;
        state.isDownloading = false;
    }
    console.error(`[System] ${message}`);
    song.status = 'error';
    state.emitSync();
    processDownloadQueue();
};

const startDownload = (song) => {
    if (state.activeDownloads.has(song.id)) return;
    const isCurrent = state.currentPlaying && state.currentPlaying.id === song.id;
    if (isCurrent) {
        state.isDownloading = true;
        state.currentDownloadingId = song.id;
    }
    song.status = 'downloading';
    song.progress = 0;
    state.emitSync();

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

    const ytDlpExe = fs.existsSync(path.join(ROOT_DIR, 'yt-dlp.exe')) ? path.join(ROOT_DIR, 'yt-dlp.exe') : 'yt-dlp';
    const videoProcess = spawn(ytDlpExe, videoArgs);
    state.activeDownloads.set(song.id, videoProcess);

    videoProcess.stdout.on('data', (data) => {
        const match = data.toString().match(/(\d+\.?\d*)%/);
        if (match) {
            // Video download counts as 0-50% progress
            const percent = parseFloat(match[1]) * 0.5;
            if (percent > song.progress) {
                song.progress = percent;
                if (state.io) state.io.emit('update_progress', { id: song.id, progress: percent });
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
        state.activeDownloads.set(song.id, audioProcess);

        audioProcess.stdout.on('data', (data) => {
            const match = data.toString().match(/(\d+\.?\d*)%/);
            if (match) {
                // Audio download counts as 50-80% progress
                const percent = 50 + parseFloat(match[1]) * 0.3;
                if (percent > song.progress) {
                    song.progress = percent;
                    if (state.io) state.io.emit('update_progress', { id: song.id, progress: percent });
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
            if (state.io) state.io.emit('update_progress', { id: song.id, progress: 80 });

            // Step 3: Analyze loudness with FFmpeg (quick, ~1-2 seconds)
            analyzeLoudness(audioPath, (loudnessGain) => {
                song.progress = 95;
                if (state.io) state.io.emit('update_progress', { id: song.id, progress: 95 });

                state.activeDownloads.delete(song.id);

                if (state.currentDownloadingId === song.id) {
                    state.currentDownloadingId = null;
                    state.isDownloading = false;
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

                if (state.autoProcessKaraoke) queueKaraokeProcessing(song);
                if (state.currentPlaying && state.currentPlaying.id === song.id) state.playerStatus.playing = true;
                state.emitSync();
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

const processDownloadQueue = () => {
    const maxConcurrent = Math.max(1, Math.min(5, (getAdvancedConfig().system || {}).maxConcurrentDownloads || 1));
    const activeCount = state.activeDownloads.size;
    if (activeCount >= maxConcurrent) return;

    const pending = [];
    if (state.currentPlaying && state.currentPlaying.status === 'pending') pending.push(state.currentPlaying);
    state.playlist.forEach(s => { if (s && s.status === 'pending') pending.push(s); });
    for (const song of pending) {
        if (state.activeDownloads.has(song.id)) continue;
        if (state.activeDownloads.size >= maxConcurrent) break;
        startDownload(song);
    }
};

module.exports = {
    startDownload,
    processDownloadQueue
};
