const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getAdvancedConfig } = require('../config/configManager');
const state = require('../utils/state');

const ROOT_DIR = path.join(__dirname, '../../');
const SEPARATED_DIR = path.join(ROOT_DIR, 'separated');
const DOWNLOAD_DIR = path.join(ROOT_DIR, 'downloads');

if (!fs.existsSync(SEPARATED_DIR)) fs.mkdirSync(SEPARATED_DIR);

// Detect Python executable (portable version takes priority)
const PORTABLE_PYTHON = path.join(ROOT_DIR, 'python', 'python.exe');
const PYTHON_EXE = fs.existsSync(PORTABLE_PYTHON) ? PORTABLE_PYTHON : 'python';

let manualKaraokeQueue = []; // Queue for manually triggered processing (high priority)

const cleanupSeparatedFiles = (songId) => {
    const modelName = (getAdvancedConfig().demucs && getAdvancedConfig().demucs.model) ? getAdvancedConfig().demucs.model : 'htdemucs';
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
    const activeProc = state.activeKaraokeProcesses.get(songId);
    if (activeProc) {
        console.log(`[Karaoke] Terminating process for song ${songId}`);
        try {
            // Kill the process tree on Windows
            spawn('taskkill', ['/pid', activeProc.proc.pid, '/f', '/t'], { shell: true });
        } catch (e) {
            try { activeProc.proc.kill('SIGKILL'); } catch (e2) { }
        }
        if (activeProc.song) {
            activeProc.song.karaokeProcessing = false;
            activeProc.song.karaokeProgress = 0;
        }
        state.activeKaraokeProcesses.delete(songId);
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
    state.emitSync(); // Sync state update

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
    state.activeKaraokeProcesses.set(song.id, { proc, song });

    proc.stderr.on('data', (data) => {
        const line = data.toString();
        // Parse progress from Demucs output (e.g., "50%|...")
        const progressMatch = line.match(/(\d+(?:\.\d+)?)\s*%/);
        if (progressMatch) {
            const progress = Math.min(99, Math.round(parseFloat(progressMatch[1])));
            if (progress > (song.karaokeProgress || 0)) {
                song.karaokeProgress = progress;
                if (state.io) state.io.emit('karaoke_progress', { id: song.id, progress });
            }
        }
        if (line.trim()) console.log(`[Demucs] ${line.trim()}`);
    });

    proc.on('close', (code) => {
        state.activeKaraokeProcesses.delete(song.id);
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
        state.emitSync();
        state.isProcessingKaraoke = false; // Reset flag to allow next process
        processNextKaraoke();
    });

    proc.on('error', (err) => {
        state.activeKaraokeProcesses.delete(song.id);
        song.karaokeProcessing = false;
        song.karaokeProgress = 0;
        console.error(`[Karaoke] Spawn error: ${err.message}`);
        cleanupSeparatedFiles(song.id);
        state.isProcessingKaraoke = false; // Reset flag to allow next process
        processNextKaraoke();
    });
};

const processNextKaraoke = () => {
    if (state.isProcessingKaraoke) return;

    // 1. Check manual queue first (High Priority)
    if (manualKaraokeQueue.length > 0) {
        const nextSong = manualKaraokeQueue.shift();
        if (nextSong && nextSong.status === 'ready' && !nextSong.karaokeReady && !nextSong.karaokeProcessing) {
            state.isProcessingKaraoke = true;
            processVocalSeparation(nextSong);
            return;
        } else {
            // Invalid entry in manual queue, try next
            processNextKaraoke();
            return;
        }
    }

    // 2. Check auto-process queue (Playlist Order)
    if (state.autoProcessKaraoke) {
        // Find the first song in playlist (or current) that needs processing
        // Order: Current Song -> Playlist [0] -> Playlist [1] ...
        const candidates = [state.currentPlaying, ...state.playlist].filter(s => s && s.status === 'ready' && !s.karaokeReady && !s.karaokeProcessing);

        if (candidates.length > 0) {
            const nextSong = candidates[0];
            state.isProcessingKaraoke = true;
            processVocalSeparation(nextSong);
            return;
        }
    }

    // No candidates found
    state.isProcessingKaraoke = false;
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
    if (!state.isProcessingKaraoke) processNextKaraoke();
};

const queueAllReadySongsForKaraoke = () => {
    // Just trigger the processor, it will scan the list if autoProcess is on
    if (!state.isProcessingKaraoke) processNextKaraoke();
};

module.exports = {
    processVocalSeparation,
    terminateKaraokeProcess,
    processNextKaraoke,
    queueKaraokeProcessing,
    queueAllReadySongsForKaraoke
};
