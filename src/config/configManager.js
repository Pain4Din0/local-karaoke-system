const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const ADVANCED_CONFIG_PATH = path.join(__dirname, '../../advanced-config.json');
const ALLOWED_LYRICS_SOURCES = new Set(['auto', 'ytmusic', 'apple_music', 'qq_music', 'musixmatch', 'lrclib']);
const ALLOWED_DEMUCS_OUTPUT_FORMATS = new Set(['mp3', 'wav', 'flac']);

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
        maxHistoryItems: 50,
        cleanupOrphanedCacheOnStart: true,
    },
    lyrics: {
        enabled: true,
        source: 'auto',
        utatenRomajiEnabled: false,
    },
};

let advancedConfig = null;

const cloneDefaultConfig = () => JSON.parse(JSON.stringify(DEFAULT_ADVANCED_CONFIG));

const clampNumber = (value, fallback, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY, integer = false } = {}) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    const bounded = Math.min(max, Math.max(min, numeric));
    return integer ? Math.round(bounded) : bounded;
};

const normalizeHeaders = (headers) => {
    if (!Array.isArray(headers)) return [];
    return headers
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .slice(0, 20);
};

const normalizeText = (value, fallback = '') => {
    const text = String(value || '').trim();
    return text || fallback;
};

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

function normalizeAdvancedConfig(inputConfig = {}) {
    const merged = deepMerge(cloneDefaultConfig(), inputConfig);

    merged.ytdlp.concurrentFragments = clampNumber(merged.ytdlp.concurrentFragments, DEFAULT_ADVANCED_CONFIG.ytdlp.concurrentFragments, { min: 1, max: 32, integer: true });
    merged.ytdlp.socketTimeout = clampNumber(merged.ytdlp.socketTimeout, DEFAULT_ADVANCED_CONFIG.ytdlp.socketTimeout, { min: 0, max: 3600, integer: true });
    merged.ytdlp.retries = clampNumber(merged.ytdlp.retries, DEFAULT_ADVANCED_CONFIG.ytdlp.retries, { min: 0, max: 50, integer: true });
    merged.ytdlp.fragmentRetries = clampNumber(merged.ytdlp.fragmentRetries, DEFAULT_ADVANCED_CONFIG.ytdlp.fragmentRetries, { min: 0, max: 50, integer: true });
    merged.ytdlp.addHeader = normalizeHeaders(merged.ytdlp.addHeader);
    merged.ytdlp.noPlaylist = !!merged.ytdlp.noPlaylist;
    merged.ytdlp.noCheckCertificates = !!merged.ytdlp.noCheckCertificates;
    merged.ytdlp.geoBypass = !!merged.ytdlp.geoBypass;
    merged.ytdlp.flatPlaylist = !!merged.ytdlp.flatPlaylist;
    merged.ytdlp.dumpJson = !!merged.ytdlp.dumpJson;
    merged.ytdlp.noWarnings = !!merged.ytdlp.noWarnings;
    merged.ytdlp.ignoreErrors = !!merged.ytdlp.ignoreErrors;
    merged.ytdlp.abortOnError = !!merged.ytdlp.abortOnError;
    merged.ytdlp.noPart = !!merged.ytdlp.noPart;
    merged.ytdlp.restrictFilenames = !!merged.ytdlp.restrictFilenames;
    merged.ytdlp.windowsFilenames = !!merged.ytdlp.windowsFilenames;
    merged.ytdlp.noOverwrites = !!merged.ytdlp.noOverwrites;
    merged.ytdlp.forceIPv4 = !!merged.ytdlp.forceIPv4;
    merged.ytdlp.forceIPv6 = !!merged.ytdlp.forceIPv6;

    merged.demucs.overlap = clampNumber(merged.demucs.overlap, DEFAULT_ADVANCED_CONFIG.demucs.overlap, { min: 0, max: 0.99 });
    merged.demucs.segment = clampNumber(merged.demucs.segment, DEFAULT_ADVANCED_CONFIG.demucs.segment, { min: 1, max: 300 });
    merged.demucs.shifts = clampNumber(merged.demucs.shifts, DEFAULT_ADVANCED_CONFIG.demucs.shifts, { min: 0, max: 20, integer: true });
    merged.demucs.jobs = clampNumber(merged.demucs.jobs, DEFAULT_ADVANCED_CONFIG.demucs.jobs, { min: 0, max: 32, integer: true });
    merged.demucs.overlapOutput = !!merged.demucs.overlapOutput;
    merged.demucs.float32 = !!merged.demucs.float32;
    merged.demucs.noSegment = !!merged.demucs.noSegment;
    merged.demucs.model = normalizeText(merged.demucs.model, DEFAULT_ADVANCED_CONFIG.demucs.model);
    merged.demucs.twoStems = normalizeText(merged.demucs.twoStems, DEFAULT_ADVANCED_CONFIG.demucs.twoStems);
    merged.demucs.outputFormat = ALLOWED_DEMUCS_OUTPUT_FORMATS.has(String(merged.demucs.outputFormat || '').trim().toLowerCase())
        ? String(merged.demucs.outputFormat).trim().toLowerCase()
        : DEFAULT_ADVANCED_CONFIG.demucs.outputFormat;

    merged.ffmpeg.loudnessI = clampNumber(merged.ffmpeg.loudnessI, DEFAULT_ADVANCED_CONFIG.ffmpeg.loudnessI, { min: -70, max: 0 });
    merged.ffmpeg.loudnessTP = clampNumber(merged.ffmpeg.loudnessTP, DEFAULT_ADVANCED_CONFIG.ffmpeg.loudnessTP, { min: -9, max: 0 });
    merged.ffmpeg.loudnessLRA = clampNumber(merged.ffmpeg.loudnessLRA, DEFAULT_ADVANCED_CONFIG.ffmpeg.loudnessLRA, { min: 1, max: 30 });
    merged.ffmpeg.loudnessGainClamp = clampNumber(merged.ffmpeg.loudnessGainClamp, DEFAULT_ADVANCED_CONFIG.ffmpeg.loudnessGainClamp, { min: 0, max: 30 });

    merged.system.deleteDelayMs = clampNumber(merged.system.deleteDelayMs, DEFAULT_ADVANCED_CONFIG.system.deleteDelayMs, { min: 0, max: 600000, integer: true });
    merged.system.maxConcurrentDownloads = clampNumber(merged.system.maxConcurrentDownloads, DEFAULT_ADVANCED_CONFIG.system.maxConcurrentDownloads, { min: 1, max: 5, integer: true });
    merged.system.maxHistoryItems = clampNumber(merged.system.maxHistoryItems, DEFAULT_ADVANCED_CONFIG.system.maxHistoryItems, { min: 1, max: 500, integer: true });
    merged.system.cleanupOrphanedCacheOnStart = merged.system.cleanupOrphanedCacheOnStart !== false;

    merged.lyrics.enabled = merged.lyrics.enabled !== false;
    merged.lyrics.source = ALLOWED_LYRICS_SOURCES.has(merged.lyrics.source) ? merged.lyrics.source : DEFAULT_ADVANCED_CONFIG.lyrics.source;
    merged.lyrics.utatenRomajiEnabled = !!merged.lyrics.utatenRomajiEnabled;

    return merged;
}

function loadAdvancedConfig() {
    try {
        if (fs.existsSync(ADVANCED_CONFIG_PATH)) {
            const raw = fs.readFileSync(ADVANCED_CONFIG_PATH, 'utf8');
            const loaded = JSON.parse(raw);
            advancedConfig = normalizeAdvancedConfig(loaded);
            return advancedConfig;
        }
    } catch (e) {
        logger.error('Config', 'Failed to load advanced-config.json', e);
    }
    advancedConfig = cloneDefaultConfig();
    return advancedConfig;
}

function saveAdvancedConfig(config) {
    try {
        const toSave = normalizeAdvancedConfig(config);
        fs.writeFileSync(ADVANCED_CONFIG_PATH, JSON.stringify(toSave, null, 2), 'utf8');
        advancedConfig = toSave;
        return true;
    } catch (e) {
        logger.error('Config', 'Failed to save advanced-config.json', e);
        return false;
    }
}

function getAdvancedConfig() {
    if (!advancedConfig) loadAdvancedConfig();
    return JSON.parse(JSON.stringify(advancedConfig));
}

function resetAdvancedConfigToDefault() {
    try {
        advancedConfig = cloneDefaultConfig();
        fs.writeFileSync(ADVANCED_CONFIG_PATH, JSON.stringify(advancedConfig, null, 2), 'utf8');
        logger.info('Config', 'Restored default advanced settings');
        return true;
    } catch (e) {
        logger.error('Config', 'Failed to reset advanced config', e);
        return false;
    }
}

module.exports = {
    loadAdvancedConfig,
    saveAdvancedConfig,
    getAdvancedConfig,
    resetAdvancedConfigToDefault
};
