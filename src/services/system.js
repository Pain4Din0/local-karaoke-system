const os = require('os');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getAdvancedConfig } = require('../config/configManager');
const state = require('../utils/state');

// Adjust paths relative to src/services
const ROOT_DIR = path.join(__dirname, '../../');
const DOWNLOAD_DIR = path.join(ROOT_DIR, 'downloads');

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

const getCookiesPath = (url) => {
    if (url.includes('bilibili.com')) {
        const p = path.join(ROOT_DIR, 'cookies_bilibili.txt');
        return fs.existsSync(p) ? p : null;
    }
    if (url.includes('youtube.com') || url.includes('youtu.be')) {
        const p = path.join(ROOT_DIR, 'cookies_youtube.txt');
        return fs.existsSync(p) ? p : null;
    }
    return null;
};

const deleteSongFile = (song) => {
    if (!song) return;

    // 1. Terminate Active Download
    const downloadProc = state.activeDownloads.get(song.id);
    if (downloadProc) {
        console.log(`[System] Cancelling download for: ${song.title}`);
        try {
            spawn('taskkill', ['/pid', downloadProc.pid, '/f', '/t'], { shell: true });
        } catch (e) {
            try { downloadProc.kill('SIGKILL'); } catch (e2) { }
        }
    }

    // 2. Terminate Active Karaoke
    const activeKaraoke = state.activeKaraokeProcesses.get(song.id);
    if (activeKaraoke) {
        try {
            spawn('taskkill', ['/pid', activeKaraoke.proc.pid, '/f', '/t'], { shell: true });
        } catch (e) {
            try { activeKaraoke.proc.kill('SIGKILL'); } catch (e2) { }
        }
        state.activeKaraokeProcesses.delete(song.id);
    }

    const SEPARATED_DIR = path.join(ROOT_DIR, 'separated');
    const modelName = (getAdvancedConfig().demucs && getAdvancedConfig().demucs.model) ? getAdvancedConfig().demucs.model : 'htdemucs';
    const songSeparatedDir = path.join(SEPARATED_DIR, modelName, `${song.id}_audio`);

    if (fs.existsSync(songSeparatedDir)) {
        try {
            fs.rmSync(songSeparatedDir, { recursive: true, force: true });
        } catch (e) {
            console.error(`[System] Cleanup failed: ${e.message}`);
        }
    }

    // 3. Delete Files (Retry mechanism for locked files)
    const tryDelete = (filePath, retries = 3) => {
        if (!filePath || !fs.existsSync(filePath)) return;
        try {
            fs.unlinkSync(filePath);
            console.log(`[System] Deleted: ${filePath}`);
        } catch (e) {
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

const analyzeLoudness = (audioPath, callback) => {
    const fcfg = getAdvancedConfig().ffmpeg || {};
    const I = fcfg.loudnessI != null ? fcfg.loudnessI : -16;
    const TP = fcfg.loudnessTP != null ? fcfg.loudnessTP : -1.5;
    const LRA = fcfg.loudnessLRA != null ? fcfg.loudnessLRA : 11;
    const clamp = Math.max(0, fcfg.loudnessGainClamp != null ? fcfg.loudnessGainClamp : 12);
    const ffmpegArgs = [
        '-i', audioPath,
        '-af', `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:print_format=json`,
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
                const targetLUFS = I;
                const gain = targetLUFS - inputLUFS;
                const clampedGain = Math.max(-clamp, Math.min(clamp, gain));
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

module.exports = {
    getNetworkInterfaces,
    getWifiSSID,
    getCookiesPath,
    deleteSongFile,
    analyzeLoudness
};
