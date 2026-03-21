const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { DOWNLOAD_DIR, SCRIPTS_DIR, PYTHON_EXE, ensureRuntimeDirs, buildChildProcessEnv } = require('../config/runtime');
const state = require('../utils/state');
const logger = require('../utils/logger');

const inflightLyrics = new Map();
const LYRICS_HELPER = path.join(SCRIPTS_DIR, 'lyrics', 'fetch_lyrics.py');
const MISSING_LYRICS_CACHE_TTL_MS = 5 * 60 * 1000;
const SUPPORTED_PROVIDER_KEYS = new Set(['ytmusic', 'apple_music', 'qq_music', 'musixmatch', 'lrclib']);
let lyricsSessionId = 0;

ensureRuntimeDirs();

const normalizeSpace = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const stripDecorators = (value) => normalizeSpace(value)
    .replace(/[【\[].*?(歌词|歌詞|lyric|lyrics|official|mv|m\/v|video|audio|karaoke|中字|中日字幕|中字版|4k|hd).*?[】\]]/gi, ' ')
    .replace(/\((?:[^)(]*(歌词|歌詞|lyric|lyrics|official|mv|m\/v|video|audio|karaoke|中字|中日字幕|中字版|4k|hd)[^)(]*)\)/gi, ' ')
    .replace(/(?:^|\s)-\s*(official|mv|m\/v|video|audio|lyrics?|karaoke)\b.*$/gi, ' ')
    .replace(/[|｜].*$/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const buildWordSegments = (words, lineEnd) => {
    if (!Array.isArray(words) || words.length === 0) return null;
    const filtered = words
        .map((word) => ({
            text: word && word.text !== undefined && word.text !== null ? String(word.text) : '',
            start: Number(word && word.start),
            end: Number.isFinite(Number(word && word.end)) ? Number(word.end) : null,
        }))
        .filter((word) => Number.isFinite(word.start) && word.text.trim() !== '')
        .sort((a, b) => a.start - b.start);
    if (filtered.length === 0) return null;

    return filtered.map((word, index) => {
        const next = filtered[index + 1];
        const fallbackEnd = next ? next.start : lineEnd;
        const candidateEnd = Number.isFinite(word.end) && word.end > word.start ? word.end : fallbackEnd;
        return {
            text: word.text,
            start: word.start,
            end: Math.max(word.start + 0.01, candidateEnd),
        };
    });
};

const finalizeTimedLines = (lines, fallbackDuration) => {
    if (!Array.isArray(lines) || lines.length === 0) return [];

    const normalized = lines
        .map((line) => ({
            start: Number(line && line.start),
            end: Number.isFinite(Number(line && line.end)) ? Number(line.end) : null,
            text: normalizeSpace(line && line.text),
            words: Array.isArray(line && line.words) ? line.words : null,
        }))
        .filter((line) => Number.isFinite(line.start) && line.text)
        .sort((a, b) => a.start - b.start);

    for (let i = 0; i < normalized.length; i++) {
        const current = normalized[i];
        const next = normalized[i + 1];
        const fallbackEnd = Number.isFinite(fallbackDuration) ? fallbackDuration : current.start + 5;
        const candidateEnd = next ? next.start : fallbackEnd;
        current.end = Number.isFinite(current.end) && current.end > current.start
            ? current.end
            : Math.max(current.start + 0.4, candidateEnd);
        current.words = buildWordSegments(current.words, current.end);
    }

    return normalized;
};

const runPythonJson = (scriptPath, payload, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_EXE, [scriptPath], {
        shell: false,
        env: buildChildProcessEnv(),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const done = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
    };

    const timer = setTimeout(() => {
        try { proc.kill(); } catch (error) { }
        done(new Error('python_helper_timeout'));
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => stdout += chunk.toString());
    proc.stderr.on('data', (chunk) => stderr += chunk.toString());
    proc.on('error', (error) => done(error));
    proc.on('close', (code) => {
        if (code !== 0 && !stdout.trim()) {
            done(new Error(`python_helper_exit_${code}:${stderr.trim()}`));
            return;
        }
        try {
            done(null, JSON.parse(stdout.trim() || '{}'));
        } catch (error) {
            done(new Error(`python_helper_invalid_json:${stderr.trim() || stdout.trim()}`));
        }
    });

    proc.stdin.write(JSON.stringify(payload || {}));
    proc.stdin.end();
});

const normalizeSourceKey = (sourceKey = 'auto') => String(sourceKey || 'auto').replace(/[^a-z0-9_-]/gi, '_');
const getLyricsCachePath = (songId, sourceKey = 'auto') => path.join(DOWNLOAD_DIR, `${songId}_lyrics_${normalizeSourceKey(sourceKey)}.json`);

const isLegacyAppleLineCache = (parsed) => {
    if (!parsed || parsed.provider !== 'apple_music' || parsed.type !== 'word' || !Array.isArray(parsed.lines) || parsed.lines.length < 2) {
        return false;
    }
    const comparableLines = parsed.lines.filter((line) => line && typeof line.text === 'string' && Array.isArray(line.words) && line.words.length === 1);
    if (comparableLines.length < 2) return false;
    return comparableLines.length === parsed.lines.length && comparableLines.every((line) => {
        const [word] = line.words;
        return word
            && typeof word.text === 'string'
            && normalizeSpace(word.text) === normalizeSpace(line.text)
            && Math.abs(Number(word.start) - Number(line.start)) < 0.001
            && Math.abs(Number(word.end) - Number(line.end)) < 0.001;
    });
};

const loadCachedLyrics = (songId, sourceKey = 'auto') => {
    const cachePath = getLyricsCachePath(songId, sourceKey);
    if (!fs.existsSync(cachePath)) return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        if (!parsed || typeof parsed !== 'object') return null;
        if (parsed.expiresAt && Date.now() > parsed.expiresAt) {
            try { fs.unlinkSync(cachePath); } catch (error) { }
            return null;
        }
        if (parsed.found !== true && parsed.found !== false) return null;
        if (parsed.found === true && parsed.provider && !SUPPORTED_PROVIDER_KEYS.has(parsed.provider)) {
            try { fs.unlinkSync(cachePath); } catch (error) { }
            return null;
        }
        if (parsed.found === true && isLegacyAppleLineCache(parsed)) {
            try { fs.unlinkSync(cachePath); } catch (error) { }
            return null;
        }
        return parsed;
    } catch (error) {
        logger.warn('Lyrics', `Failed to read lyrics cache for song ${songId}`, error);
        return null;
    }
};

const saveCachedLyrics = (songId, data, sourceKey = 'auto') => {
    if (!data || (data.found !== true && data.found !== false)) return;
    try {
        const payload = { ...data, cachedAt: Date.now() };
        if (data.found !== true) {
            payload.expiresAt = Date.now() + MISSING_LYRICS_CACHE_TTL_MS;
        }
        fs.writeFileSync(getLyricsCachePath(songId, sourceKey), JSON.stringify(payload, null, 2), 'utf8');
    } catch (error) {
        logger.warn('Lyrics', `Failed to write lyrics cache for song ${songId}`, error);
    }
};

const invalidateLyricsSession = (reason = 'manual') => {
    lyricsSessionId += 1;
    inflightLyrics.clear();
    logger.info('Lyrics', 'Invalidated in-flight lyrics session', {
        reason,
        sessionId: lyricsSessionId,
    });
    return lyricsSessionId;
};

const updateSongLyricsState = (song, data) => {
    if (!song) return;
    song.lyricsStatus = data && data.found ? 'ready' : 'missing';
    song.lyricsSource = data ? data.source : null;
    song.lyricsType = data ? data.type : null;
    song.lyricsAvailable = !!(data && data.found);
    if (song === state.currentPlaying || state.playlist.includes(song)) {
        state.emitSync();
    }
};

const buildSongQuery = (song) => {
    const title = stripDecorators(song.track || song.title || '');
    const artist = normalizeSpace(song.artist || song.uploader || '');
    return {
        title,
        artist,
        album: normalizeSpace(song.album || ''),
        duration: Number.isFinite(song.duration) ? Math.round(song.duration) : null,
    };
};

const createLyricsPayload = ({ source, provider, type, lines, plainLyrics, metadata, attemptedSources }) => {
    const explicitType = type === 'word' || type === 'line' ? type : null;
    const inferredType = explicitType || (Array.isArray(lines) && lines.some((line) => Array.isArray(line && line.words) && line.words.length > 0) ? 'word' : 'line');
    const cleanedLines = Array.isArray(lines)
        ? lines.map((line, index) => ({
            id: index + 1,
            start: Number(line.start.toFixed(3)),
            end: Number((line.end || line.start + 4).toFixed(3)),
            text: line.text,
            words: inferredType === 'word' && Array.isArray(line.words) && line.words.length > 0
                ? line.words.map((word, wordIndex) => ({
                    id: wordIndex + 1,
                    text: word.text,
                    start: Number(word.start.toFixed(3)),
                    end: Number((word.end || line.end || word.start + 0.5).toFixed(3)),
                }))
                : null,
        }))
        : [];

    return {
        found: cleanedLines.length > 0,
        source,
        provider,
        type: inferredType,
        attemptedSources: Array.isArray(attemptedSources) ? attemptedSources : [],
        plainLyrics: plainLyrics || cleanedLines.map((line) => line.text).join('\n'),
        metadata,
        lines: cleanedLines,
    };
};

const buildMissingPayload = (song, attemptedSources = []) => ({
    found: false,
    source: null,
    provider: null,
    type: null,
    attemptedSources,
    plainLyrics: '',
    metadata: {
        track: song.track || song.title,
        artist: song.artist || song.uploader,
        album: song.album || '',
    },
    lines: [],
});

const helperResultToPayload = (song, result) => {
    if (!result || result.ok !== true) return null;
    if (result.found !== true || !Array.isArray(result.lines) || result.lines.length === 0) {
        return buildMissingPayload(song, Array.isArray(result.attemptedSources) ? result.attemptedSources : []);
    }

    const normalizedLines = finalizeTimedLines(result.lines, song.duration);
    if (normalizedLines.length === 0) {
        return buildMissingPayload(song, Array.isArray(result.attemptedSources) ? result.attemptedSources : []);
    }

    return createLyricsPayload({
        source: result.source || result.provider || 'Lyrics',
        provider: result.provider || 'unknown',
        type: result.type || 'line',
        lines: normalizedLines,
        plainLyrics: result.plainLyrics || '',
        metadata: result.metadata || {
            track: song.track || song.title,
            artist: song.artist || song.uploader,
            album: song.album || '',
        },
        attemptedSources: result.attemptedSources || [],
    });
};

const isYouTubeMusicSong = (song) => {
    if (!song) return false;
    if (song.sourcePlatform === 'ytmusic') return true;
    return /(^https?:\/\/)?music\.youtube\.com\b/i.test(String(song.originalUrl || ''));
};

const fetchLyricsFromHelper = async (song, sourceKey) => {
    if (!fs.existsSync(LYRICS_HELPER)) return null;

    const query = buildSongQuery(song);
    const result = await runPythonJson(LYRICS_HELPER, {
        sourceId: song.sourceId || null,
        track: query.title,
        artist: query.artist,
        album: query.album,
        duration: query.duration,
        originalUrl: song.originalUrl || null,
        preferredSource: sourceKey,
    }).catch((error) => {
        logger.warn('Lyrics', `Lyrics helper failed for ${song.title}`, error);
        return null;
    });

    return helperResultToPayload(song, result);
};

const findSongById = (songId) => {
    const lookupId = String(songId);
    const candidates = [
        state.currentPlaying,
        ...state.playlist,
        ...state.history,
    ].filter(Boolean);
    return candidates.find((song) => String(song.id) === lookupId) || null;
};

const fetchLyricsForSong = async (song, options = {}) => {
    if (!song || !song.id) return null;
    const sourceKey = options.preferredSource || 'auto';

    if (!options.force) {
        const cached = loadCachedLyrics(song.id, sourceKey);
        if (cached) {
            if (sourceKey === 'auto') {
                song.lyricsData = cached;
                updateSongLyricsState(song, cached);
            }
            return cached;
        }
    }

    const inflightKey = `${song.id}:${sourceKey}`;
    if (inflightLyrics.has(inflightKey)) return inflightLyrics.get(inflightKey);

    const startedSessionId = lyricsSessionId;
    const isStale = () => startedSessionId !== lyricsSessionId;

    const task = (async () => {
        let data = null;

        if (!isYouTubeMusicSong(song)) {
            data = buildMissingPayload(song, []);
        } else {
            data = await fetchLyricsFromHelper(song, sourceKey);
        }

        if (isStale()) {
            logger.info('Lyrics', 'Discarded stale lyrics result after session change', {
                songId: song.id,
                sourceKey,
                startedSessionId,
                currentSessionId: lyricsSessionId,
            });
            return null;
        }

        const finalData = data || buildMissingPayload(song, []);
        if (sourceKey === 'auto') {
            song.lyricsData = finalData;
            updateSongLyricsState(song, finalData);
        }
        saveCachedLyrics(song.id, finalData, sourceKey);
        return finalData;
    })().finally(() => {
        inflightLyrics.delete(inflightKey);
    });

    inflightLyrics.set(inflightKey, task);
    return task;
};

const prefetchLyrics = (song) => {
    fetchLyricsForSong(song).catch((error) => {
        logger.warn('Lyrics', 'Prefetch failed', error);
    });
};

const getLyricsBySongId = async (songId, options = {}) => {
    const song = findSongById(songId);
    const sourceKey = options.preferredSource || 'auto';
    if (!song) {
        const cached = loadCachedLyrics(songId, sourceKey);
        return cached || null;
    }
    return fetchLyricsForSong(song, options);
};

const deleteLyricsCache = (songId) => {
    if (!fs.existsSync(DOWNLOAD_DIR)) return;
    for (const file of fs.readdirSync(DOWNLOAD_DIR)) {
        if (file.startsWith(`${songId}_lyrics_`)) {
            try { fs.unlinkSync(path.join(DOWNLOAD_DIR, file)); } catch (error) { }
        }
    }
};

module.exports = {
    fetchLyricsForSong,
    getLyricsBySongId,
    prefetchLyrics,
    deleteLyricsCache,
    invalidateLyricsSession,
};
