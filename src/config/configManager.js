const fs = require('fs');
const path = require('path');

const ADVANCED_CONFIG_PATH = path.join(__dirname, '../../advanced-config.json');

const DEFAULT_ADVANCED_CONFIG = {
    ytdlp: {
        videoFormat: 'bestvideo[ext=mp4]/bestvideo',
        audioFormat: 'bestaudio[ext=m4a]/bestaudio',
        concurrentFragments: 16,
        httpChunkSize: '10M',
        noPlaylist: true,
        proxy: '',
        socketTimeout: 0,
        retries: 10,
        fragmentRetries: 10,
        userAgent: '',
        extractorArgs: '',
        postprocessorArgs: '',
        noCheckCertificates: false,
        limitRate: '',
        geoBypass: true,
        addHeader: [],
        mergeOutputFormat: '',
        flatPlaylist: true,
        dumpJson: true,
        noWarnings: false,
        ignoreErrors: false,
        abortOnError: false,
        noPart: false,
        restrictFilenames: false,
        windowsFilenames: false,
        noOverwrites: false,
        forceIPv4: false,
        forceIPv6: false,
    },
    demucs: {
        model: 'htdemucs',
        twoStems: 'vocals',
        outputFormat: 'mp3',
        overlap: 0.25,
        segment: 7.8,
        shifts: 1,
        overlapOutput: false,
        float32: false,
        clipMode: 'rescale',
        noSegment: false,
        jobs: 0,
        device: '',
        repo: '',
    },
    ffmpeg: {
        loudnessI: -16,
        loudnessTP: -1.5,
        loudnessLRA: 11,
        loudnessGainClamp: 12,
    },
    system: {
        deleteDelayMs: 20000,
        maxConcurrentDownloads: 1,
    },
};

let advancedConfig = null;

function deepMerge(target, source) {
    if (!source || typeof source !== 'object') return target;
    for (const key of Object.keys(source)) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) && source[key] !== null) {
            if (!target[key] || typeof target[key] !== 'object') target[key] = {};
            deepMerge(target[key], source[key]);
        } else if (source[key] !== undefined && source[key] !== null) {
            target[key] = source[key];
        }
    }
    return target;
}

function loadAdvancedConfig() {
    try {
        if (fs.existsSync(ADVANCED_CONFIG_PATH)) {
            const raw = fs.readFileSync(ADVANCED_CONFIG_PATH, 'utf8');
            const loaded = JSON.parse(raw);
            advancedConfig = deepMerge({ ...DEFAULT_ADVANCED_CONFIG }, loaded);
            return advancedConfig;
        }
    } catch (e) {
        console.error('[Config] Failed to load advanced-config.json:', e.message);
    }
    advancedConfig = JSON.parse(JSON.stringify(DEFAULT_ADVANCED_CONFIG));
    return advancedConfig;
}

function saveAdvancedConfig(config) {
    try {
        const toSave = deepMerge(JSON.parse(JSON.stringify(DEFAULT_ADVANCED_CONFIG)), config);
        fs.writeFileSync(ADVANCED_CONFIG_PATH, JSON.stringify(toSave, null, 2), 'utf8');
        advancedConfig = toSave;
        return true;
    } catch (e) {
        console.error('[Config] Failed to save advanced-config.json:', e.message);
        return false;
    }
}

function getAdvancedConfig() {
    if (!advancedConfig) loadAdvancedConfig();
    return JSON.parse(JSON.stringify(advancedConfig));
}

function resetAdvancedConfigToDefault() {
    try {
        advancedConfig = JSON.parse(JSON.stringify(DEFAULT_ADVANCED_CONFIG));
        fs.writeFileSync(ADVANCED_CONFIG_PATH, JSON.stringify(advancedConfig, null, 2), 'utf8');
        console.log('[Config] Restored default advanced settings');
        return true;
    } catch (e) {
        console.error('[Config] Failed to reset advanced config:', e.message);
        return false;
    }
}

module.exports = {
    loadAdvancedConfig,
    saveAdvancedConfig,
    getAdvancedConfig,
    resetAdvancedConfigToDefault
};
