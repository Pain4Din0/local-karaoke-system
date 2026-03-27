const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { PYTHON_EXE, SCRIPTS_DIR, buildChildProcessEnv } = require('../config/runtime');
const logger = require('../utils/logger');

const YTMUSIC_HELPER = path.join(SCRIPTS_DIR, 'ytmusic', 'search.py');
const ALLOWED_FILTERS = new Set(['all', 'songs', 'albums', 'artists', 'singles']);
const ALLOWED_DETAIL_KINDS = new Set(['album', 'playlist', 'artist', 'artist_collection']);
const SEARCH_CACHE_TTL_MS = 20000;
const DETAIL_CACHE_TTL_MS = 30000;
const MAX_CACHE_ENTRIES = 80;
const LANGUAGE_ALIASES = {
    zh: 'zh_CN',
    'zh-cn': 'zh_CN',
    'zh_cn': 'zh_CN',
    'zh-tw': 'zh_TW',
    'zh_tw': 'zh_TW',
    ja: 'ja',
    'ja-jp': 'ja',
    en: 'en',
    'en-us': 'en',
    'en-gb': 'en',
};
const searchCache = new Map();
const detailCache = new Map();
const inflightSearches = new Map();
const inflightDetails = new Map();

class YtMusicSearchError extends Error {
    constructor(message, code = 'ytmusic_failed', details = {}) {
        super(message);
        this.name = 'YtMusicSearchError';
        this.code = code;
        this.details = details;
    }
}

const clampNumber = (value, fallback, min, max) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(max, Math.max(min, numeric));
};

const normalizeText = (value, fallback = '', maxLength = 300) => {
    if (value === undefined || value === null) return fallback;
    const text = String(value).trim();
    if (!text) return fallback;
    return text.slice(0, maxLength);
};

const cloneJson = (value) => {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
};

const sanitizeLanguage = (value) => {
    const normalized = normalizeText(value, 'en', 20).replace(/-/g, '_').toLowerCase();
    return LANGUAGE_ALIASES[normalized] || 'en';
};

const pruneCache = (cache) => {
    const now = Date.now();
    for (const [key, entry] of cache.entries()) {
        if (!entry || entry.expiresAt <= now) {
            cache.delete(key);
        }
    }

    while (cache.size > MAX_CACHE_ENTRIES) {
        const oldestKey = cache.keys().next().value;
        if (!oldestKey) break;
        cache.delete(oldestKey);
    }
};

const getCachedValue = (cache, key) => {
    pruneCache(cache);
    const entry = cache.get(key);
    if (!entry || entry.expiresAt <= Date.now()) {
        cache.delete(key);
        return null;
    }
    return cloneJson(entry.value);
};

const setCachedValue = (cache, key, value, ttlMs) => {
    cache.set(key, {
        value: cloneJson(value),
        expiresAt: Date.now() + ttlMs,
    });
    pruneCache(cache);
};

const runWithCache = async ({ cache, inflight, key, ttlMs, factory }) => {
    const cached = getCachedValue(cache, key);
    if (cached !== null) return cached;

    if (inflight.has(key)) {
        return cloneJson(await inflight.get(key));
    }

    const task = Promise.resolve()
        .then(factory)
        .then((result) => {
            setCachedValue(cache, key, result, ttlMs);
            return result;
        })
        .finally(() => {
            inflight.delete(key);
        });

    inflight.set(key, task);
    return cloneJson(await task);
};

const ensureHelperExists = () => {
    if (fs.existsSync(YTMUSIC_HELPER)) return;
    throw new YtMusicSearchError('YouTube Music helper is missing on the host', 'helper_missing', {
        helperPath: YTMUSIC_HELPER,
    });
};

const runPythonJson = (payload, timeoutMs = 30000) => new Promise((resolve, reject) => {
    ensureHelperExists();

    const proc = spawn(PYTHON_EXE, [YTMUSIC_HELPER], {
        shell: false,
        env: buildChildProcessEnv(),
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
    };

    const timer = setTimeout(() => {
        try {
            proc.kill();
        } catch (error) {
            logger.warn('YTMusic', 'Failed to terminate timed out helper process', error);
        }
        finish(new YtMusicSearchError('YouTube Music helper timed out', 'helper_timeout'));
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
    });

    proc.on('error', (error) => {
        finish(new YtMusicSearchError('Failed to start YouTube Music helper', 'helper_spawn_failed', {
            error: error.message,
        }));
    });

    proc.on('close', (code) => {
        const trimmedStdout = stdout.trim();
        const trimmedStderr = stderr.trim();

        if (!trimmedStdout) {
            finish(new YtMusicSearchError('YouTube Music helper returned no data', 'helper_empty_response', {
                code,
                stderr: trimmedStderr,
            }));
            return;
        }

        try {
            const parsed = JSON.parse(trimmedStdout);
            if (!parsed || parsed.ok !== true) {
                finish(new YtMusicSearchError(
                    normalizeText(parsed && parsed.message, 'YouTube Music request failed', 500),
                    normalizeText(parsed && parsed.code, 'ytmusic_failed', 80),
                    parsed && parsed.details && typeof parsed.details === 'object'
                        ? parsed.details
                        : { code, stderr: trimmedStderr },
                ));
                return;
            }

            finish(null, parsed);
        } catch (error) {
            finish(new YtMusicSearchError('Invalid YouTube Music helper response', 'helper_invalid_json', {
                code,
                stderr: trimmedStderr,
                stdout: trimmedStdout.slice(0, 1000),
            }));
        }
    });

    try {
        proc.stdin.write(JSON.stringify(payload || {}));
        proc.stdin.end();
    } catch (error) {
        finish(new YtMusicSearchError('Failed to send request to YouTube Music helper', 'helper_stdin_failed', {
            error: error.message,
        }));
    }
});

const sanitizeFilter = (value) => {
    const filter = normalizeText(value, 'songs', 30).toLowerCase();
    return ALLOWED_FILTERS.has(filter) ? filter : 'songs';
};

const sanitizeDetailLimit = (kind, value) => {
    const fallback = kind === 'playlist' ? 200 : 100;
    const max = kind === 'playlist' ? 500 : 500;
    return clampNumber(value, fallback, 1, max);
};

const sanitizeDetailRequest = (request = {}) => {
    const kind = normalizeText(request.kind, '', 40).toLowerCase();
    if (!ALLOWED_DETAIL_KINDS.has(kind)) {
        throw new YtMusicSearchError('Unsupported YouTube Music detail request', 'invalid_kind', {
            kind,
        });
    }

    const payload = { kind };
    const title = normalizeText(request.title, '', 200);
    if (title) payload.title = title;
    const language = normalizeText(request.language, '', 20);
    if (language) payload.language = language;

    if (kind === 'album' || kind === 'artist') {
        payload.browseId = normalizeText(request.browseId, '', 200);
        if (!payload.browseId) {
            throw new YtMusicSearchError('Missing YouTube Music browseId', 'invalid_request', { kind });
        }
    }

    if (kind === 'playlist') {
        payload.playlistId = normalizeText(request.playlistId, '', 200);
        if (!payload.playlistId) {
            throw new YtMusicSearchError('Missing YouTube Music playlistId', 'invalid_request', { kind });
        }
    }

    if (kind === 'artist_collection') {
        payload.channelId = normalizeText(request.channelId, '', 200);
        payload.params = normalizeText(request.params, '', 600);
        payload.collection = normalizeText(request.collection, 'albums', 40).toLowerCase();
        if (!payload.channelId || !payload.params) {
            throw new YtMusicSearchError('Missing artist collection data', 'invalid_request', {
                kind,
            });
        }
    }

    payload.limit = sanitizeDetailLimit(kind, request.limit);

    return payload;
};

const sanitizeCounterpartTracks = (tracks) => {
    if (!Array.isArray(tracks)) return [];
    const sanitized = [];
    const seen = new Set();

    for (const track of tracks) {
        if (!track || typeof track !== 'object') continue;
        const videoId = normalizeText(track.videoId, '', 120);
        if (!videoId) continue;
        const playlistId = normalizeText(track.playlistId, '', 120);
        const key = `${videoId}:${playlistId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        sanitized.push({
            videoId,
            playlistId: playlistId || null,
        });
    }

    return sanitized;
};

const searchYouTubeMusic = async (query, options = {}) => {
    const normalizedQuery = normalizeText(query, '', 200);
    const filter = sanitizeFilter(options.filter);
    const limit = clampNumber(options.limit, 24, 1, 120);
    const language = sanitizeLanguage(options.language);
    const cacheKey = JSON.stringify({
        query: normalizedQuery,
        filter,
        limit,
        language,
    });

    return runWithCache({
        cache: searchCache,
        inflight: inflightSearches,
        key: cacheKey,
        ttlMs: SEARCH_CACHE_TTL_MS,
        factory: async () => {
            const result = await runPythonJson({
                action: 'search',
                query: normalizedQuery,
                filter,
                limit,
                language,
            }, limit > 72 ? 45000 : 30000);

            return {
                query: normalizedQuery,
                filter,
                sections: Array.isArray(result.sections) ? result.sections : [],
                suggestions: [],
            };
        },
    });
};

const getYouTubeMusicDetail = async (request) => {
    const detailRequest = sanitizeDetailRequest(request);
    const language = sanitizeLanguage(request && request.language);
    const timeoutMs = detailRequest.limit > 200 ? 60000 : (detailRequest.kind === 'artist_collection' ? 40000 : 30000);
    const cacheKey = JSON.stringify({
        detailRequest,
        language,
    });

    return runWithCache({
        cache: detailCache,
        inflight: inflightDetails,
        key: cacheKey,
        ttlMs: DETAIL_CACHE_TTL_MS,
        factory: async () => {
            const result = await runPythonJson({
                action: 'detail',
                ...detailRequest,
                language,
            }, timeoutMs);

            if (!result.detail || typeof result.detail !== 'object') {
                throw new YtMusicSearchError('YouTube Music detail response is incomplete', 'invalid_detail_payload');
            }

            return result.detail;
        },
    });
};

const resolveYouTubeMusicCounterparts = async (tracks, options = {}) => {
    const normalizedTracks = sanitizeCounterpartTracks(tracks);
    const language = sanitizeLanguage(options.language);
    if (normalizedTracks.length === 0) return [];
    const timeoutMs = Math.min(60000, 12000 + (normalizedTracks.length * 2500));
    const result = await runPythonJson({
        action: 'counterparts',
        language,
        tracks: normalizedTracks,
    }, timeoutMs);
    const responseItems = Array.isArray(result.items) ? result.items : [];

    return normalizedTracks.map((track) => (
        responseItems.find((item) => (
            normalizeText(item && item.sourceVideoId, '', 120) === track.videoId
        )) || {
            sourceVideoId: track.videoId,
            counterpart: null,
        }
    ));
};

const serializeYtMusicError = (error) => {
    if (error instanceof YtMusicSearchError) {
        return {
            code: error.code,
            message: error.message,
            details: error.details || {},
        };
    }

    return {
        code: 'ytmusic_failed',
        message: normalizeText(error && error.message, 'YouTube Music request failed', 500),
        details: {},
    };
};

module.exports = {
    searchYouTubeMusic,
    getYouTubeMusicDetail,
    resolveYouTubeMusicCounterparts,
    serializeYtMusicError,
};
