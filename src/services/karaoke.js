const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { getAdvancedConfig } = require('../config/configManager');
const { DOWNLOAD_DIR, PYTHON_EXE, SEPARATED_DIR, ensureRuntimeDirs } = require('../config/runtime');
const state = require('../utils/state');
const logger = require('../utils/logger');
const { setSongError } = require('../utils/song');

ensureRuntimeDirs();

let manualKaraokeQueue = [];

const cleanupSeparatedFiles = (songId) => {
    const modelName = (getAdvancedConfig().demucs && getAdvancedConfig().demucs.model) ? getAdvancedConfig().demucs.model : 'htdemucs';
    const songSeparatedDir = path.join(SEPARATED_DIR, modelName, `${songId}_audio`);
    if (!fs.existsSync(songSeparatedDir)) return;

    try {
        fs.rmSync(songSeparatedDir, { recursive: true, force: true });
        logger.info('Karaoke', 'Removed separated files', { songId, path: songSeparatedDir });
    } catch (error) {
        logger.warn('Karaoke', `Failed to remove separated files for ${songId}`, error);
    }
};

const emitSongError = (song, message, stage = 'karaoke', extra = {}) => {
    setSongError(song, message, stage);
    logger.error('Karaoke', message, {
        songId: song && song.id,
        title: song && song.title,
        ...extra,
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

const terminateKaraokeProcess = (songId) => {
    const activeProc = state.activeKaraokeProcesses.get(songId);
    if (activeProc) {
        logger.info('Karaoke', `Terminating active process for song ${songId}`);
        activeProc.proc.__terminatedBySystem = true;
        activeProc.proc.__terminationReason = 'karaoke_cleanup';
        if (process.platform === 'win32') {
            try {
                spawn('taskkill', ['/pid', String(activeProc.proc.pid), '/f', '/t'], { shell: true })
                    .on('error', (error) => logger.warn('Karaoke', `taskkill failed for ${songId}`, error));
            } catch (error) {
                logger.warn('Karaoke', `taskkill threw for ${songId}`, error);
            }
        } else {
            try {
                activeProc.proc.kill('SIGKILL');
            } catch (error) {
                logger.warn('Karaoke', `Failed to kill process for ${songId}`, error);
            }
        }

        if (activeProc.song) {
            activeProc.song.karaokeProcessing = false;
            activeProc.song.karaokeProgress = 0;
        }

        state.activeKaraokeProcesses.delete(songId);
        cleanupSeparatedFiles(songId);
    }

    manualKaraokeQueue = manualKaraokeQueue.filter((song) => song && song.id !== songId);
};

const clearKaraokeQueue = () => {
    manualKaraokeQueue = [];
    for (const songId of [...state.activeKaraokeProcesses.keys()]) {
        terminateKaraokeProcess(songId);
    }
    state.isProcessingKaraoke = false;
};

const processVocalSeparation = (song) => {
    const audioPath = song && song.localAudioPath;
    if (!song || !audioPath || !fs.existsSync(audioPath)) {
        emitSongError(song, 'Cannot start karaoke processing: audio file is missing');
        state.isProcessingKaraoke = false;
        processNextKaraoke();
        return;
    }
    if (song.karaokeReady || song.karaokeProcessing) return;

    song.karaokeProcessing = true;
    song.karaokeProgress = 0;
    state.emitSync();

    logger.info('Karaoke', `Starting vocal separation for ${song.title}`, {
        songId: song.id,
        audioPath,
    });

    const dcfg = getAdvancedConfig().demucs;
    const args = ['-m', 'demucs', '-n', dcfg.model || 'htdemucs', '-o', SEPARATED_DIR];

    if (dcfg.twoStems) args.push('--two-stems', dcfg.twoStems);
    if (dcfg.outputFormat === 'mp3' || dcfg.outputFormat) args.push('--mp3');
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

    const proc = spawn(PYTHON_EXE, args, { shell: false });
    const logTail = [];
    let finished = false;
    const finishOnce = (handler) => {
        if (finished) return;
        finished = true;
        handler();
    };
    state.activeKaraokeProcesses.set(song.id, { proc, song });

    proc.stderr.on('data', (data) => {
        const line = data.toString().trim();
        if (!line) return;
        logTail.push(line);
        if (logTail.length > 20) logTail.shift();

        const progressMatch = line.match(/(\d+(?:\.\d+)?)\s*%/);
        if (progressMatch) {
            const progress = Math.min(99, Math.round(parseFloat(progressMatch[1])));
            if (progress > (song.karaokeProgress || 0)) {
                song.karaokeProgress = progress;
                if (state.io) state.io.emit('karaoke_progress', { id: song.id, progress });
            }
        }

        logger.info('Demucs', line, { songId: song.id });
    });

    proc.on('close', (code) => {
        finishOnce(() => {
            state.activeKaraokeProcesses.delete(song.id);
            song.karaokeProcessing = false;

            if (proc.__terminatedBySystem) {
                logger.info('Karaoke', 'Karaoke processing terminated during cleanup', {
                    songId: song.id,
                    title: song.title,
                    reason: proc.__terminationReason || 'cleanup',
                    code,
                });
                cleanupSeparatedFiles(song.id);
            } else if (code === 0) {
                const modelName = (getAdvancedConfig().demucs || {}).model || 'htdemucs';
                const noVocalsPath = path.join(SEPARATED_DIR, modelName, `${song.id}_audio`, 'no_vocals.mp3');
                if (fs.existsSync(noVocalsPath)) {
                    const karaokePath = path.join(DOWNLOAD_DIR, `${song.id}_karaoke.mp3`);
                    fs.copyFileSync(noVocalsPath, karaokePath);
                    song.karaokeSrc = `/downloads/${song.id}_karaoke.mp3?t=${Date.now()}`;
                    song.karaokeReady = true;
                    song.karaokeProgress = 100;
                    logger.info('Karaoke', `Karaoke track ready for ${song.title}`, { songId: song.id });
                    cleanupSeparatedFiles(song.id);
                } else {
                    emitSongError(song, 'Demucs finished but no_vocals.mp3 was not produced', 'karaoke', {
                        expectedOutput: noVocalsPath,
                    });
                    cleanupSeparatedFiles(song.id);
                }
            } else if (code !== null) {
                emitSongError(song, `Demucs exited with code ${code}`, 'karaoke', {
                    output: logTail.join('\n'),
                });
                cleanupSeparatedFiles(song.id);
            }

            state.emitSync();
            state.isProcessingKaraoke = false;
            processNextKaraoke();
        });
    });

    proc.on('error', (error) => {
        finishOnce(() => {
            state.activeKaraokeProcesses.delete(song.id);
            song.karaokeProcessing = false;
            song.karaokeProgress = 0;
            if (proc.__terminatedBySystem) {
                logger.info('Karaoke', 'Demucs spawn terminated during cleanup', {
                    songId: song.id,
                    title: song.title,
                    reason: proc.__terminationReason || 'cleanup',
                });
            } else {
                emitSongError(song, 'Failed to spawn Demucs process', 'karaoke', error);
            }
            cleanupSeparatedFiles(song.id);
            state.emitSync();
            state.isProcessingKaraoke = false;
            processNextKaraoke();
        });
    });
};

const processNextKaraoke = () => {
    if (state.isProcessingKaraoke) return;

    if (manualKaraokeQueue.length > 0) {
        const nextSong = manualKaraokeQueue.shift();
        if (nextSong && nextSong.status === 'ready' && !nextSong.karaokeReady && !nextSong.karaokeProcessing) {
            state.isProcessingKaraoke = true;
            processVocalSeparation(nextSong);
            return;
        }
        processNextKaraoke();
        return;
    }

    if (state.autoProcessKaraoke) {
        const candidates = [state.currentPlaying, ...state.playlist]
            .filter((song) => song && song.status === 'ready' && !song.karaokeReady && !song.karaokeProcessing);

        if (candidates.length > 0) {
            state.isProcessingKaraoke = true;
            processVocalSeparation(candidates[0]);
            return;
        }
    }

    state.isProcessingKaraoke = false;
};

const queueKaraokeProcessing = (song, prioritize = false) => {
    if (!song || song.karaokeReady || song.karaokeProcessing) return;

    if (prioritize && !manualKaraokeQueue.find((item) => item && item.id === song.id)) {
        manualKaraokeQueue.push(song);
    }

    if (!state.isProcessingKaraoke) {
        processNextKaraoke();
    }
};

const queueAllReadySongsForKaraoke = () => {
    if (!state.isProcessingKaraoke) {
        processNextKaraoke();
    }
};

module.exports = {
    processVocalSeparation,
    terminateKaraokeProcess,
    clearKaraokeQueue,
    processNextKaraoke,
    queueKaraokeProcessing,
    queueAllReadySongsForKaraoke,
};
