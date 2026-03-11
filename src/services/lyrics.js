const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const state = require('../utils/state');

const ROOT_DIR = path.join(__dirname, '../../');
const DOWNLOAD_DIR = path.join(ROOT_DIR, 'downloads');
const YTMUSIC_HELPER = path.join(ROOT_DIR, 'scripts', 'fetch_ytmusic_lyrics.py');
const YT_DLP_EXE = fs.existsSync(path.join(ROOT_DIR, 'yt-dlp.exe'))
    ? path.join(ROOT_DIR, 'yt-dlp.exe')
    : 'yt-dlp';

const inflightLyrics = new Map();
const CAPTION_LANGS = ['zh-Hans', 'zh-Hant', 'zh-CN', 'zh-TW', 'zh', 'en', 'ja'];

const isYouTubeLikeUrl = (url = '') => /(^https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)\b/i.test(url);
const getCookiesPath = (url = '') => {
    if (url.includes('youtube.com') || url.includes('youtu.be') || url.includes('music.youtube.com')) {
        const filePath = path.join(ROOT_DIR, 'cookies_youtube.txt');
        return fs.existsSync(filePath) ? filePath : null;
    }
    if (url.includes('bilibili.com')) {
        const filePath = path.join(ROOT_DIR, 'cookies_bilibili.txt');
        return fs.existsSync(filePath) ? filePath : null;
    }
    return null;
};

const normalizeSpace = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const stripDecorators = (value) => normalizeSpace(value)
    .replace(/[【\[].*?(歌词|歌詞|lyric|lyrics|official|mv|m\/v|video|audio|karaoke|中字|中日字幕|中字版|4k|hd).*?[】\]]/gi, ' ')
    .replace(/\((?:[^)(]*(歌词|歌詞|lyric|lyrics|official|mv|m\/v|video|audio|karaoke|中字|中日字幕|中字版|4k|hd)[^)(]*)\)/gi, ' ')
    .replace(/(?:^|\s)-\s*(official|mv|m\/v|video|audio|lyrics?|karaoke)\b.*$/gi, ' ')
    .replace(/[|｜].*$/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const normalizeKey = (value) => stripDecorators(value).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff]+/gi, '');

const parseTimeTag = (timeText) => {
    const match = String(timeText || '').trim().match(/^(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?$/);
    if (!match) return null;
    const minutes = Number(match[1]);
    const seconds = Number(match[2]);
    const fractionRaw = match[3] || '0';
    const fraction = fractionRaw.length === 3 ? Number(fractionRaw) / 1000 : Number(fractionRaw) / 100;
    return (minutes * 60) + seconds + fraction;
};

const parseSrtOrVttTime = (value) => {
    const match = String(value || '').trim().match(/^(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{3})$/);
    if (!match) return null;
    const hours = Number(match[1] || 0);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    const ms = Number(match[4]);
    return (hours * 3600) + (minutes * 60) + seconds + (ms / 1000);
};

const stripHtml = (value) => String(value || '')
    .replace(/<\d{2}:\d{2}(?::\d{2})?[.,]\d{2,3}>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();

const buildWordSegments = (lineText, words, lineEnd) => {
    if (!Array.isArray(words) || words.length === 0) return null;
    const filtered = words
        .filter((word) => word && Number.isFinite(word.start) && word.text)
        .sort((a, b) => a.start - b.start);
    if (filtered.length === 0) return null;
    return filtered.map((word, index) => ({
        text: word.text,
        start: word.start,
        end: index < filtered.length - 1 ? filtered[index + 1].start : lineEnd,
    }));
};

const finalizeTimedLines = (lines, fallbackDuration) => {
    if (!Array.isArray(lines) || lines.length === 0) return [];
    const sorted = lines
        .filter((line) => line && Number.isFinite(line.start) && line.text)
        .sort((a, b) => a.start - b.start);

    for (let i = 0; i < sorted.length; i++) {
        const current = sorted[i];
        const next = sorted[i + 1];
        const fallbackEnd = Number.isFinite(fallbackDuration) ? fallbackDuration : current.start + 5;
        const candidateEnd = next ? next.start : fallbackEnd;
        current.end = Number.isFinite(current.end) && current.end > current.start
            ? current.end
            : Math.max(current.start + 0.4, candidateEnd);
        current.words = buildWordSegments(current.text, current.words, current.end);
    }

    return sorted;
};

const parseLrc = (rawText, fallbackDuration) => {
    const lines = [];
    let hasWordTiming = false;

    for (const rawLine of String(rawText || '').split(/\r?\n/)) {
        const timeTags = [...rawLine.matchAll(/\[(\d{1,2}:\d{2}(?:[.:]\d{1,3})?)\]/g)];
        if (!timeTags.length) continue;

        const textWithoutLineTags = rawLine.replace(/\[(\d{1,2}:\d{2}(?:[.:]\d{1,3})?)\]/g, '');
        const wordMatches = [...textWithoutLineTags.matchAll(/<(\d{1,2}:\d{2}(?:[.:]\d{1,3})?)>([^<]+)/g)];
        const plainText = stripHtml(textWithoutLineTags.replace(/<(\d{1,2}:\d{2}(?:[.:]\d{1,3})?)>/g, ''));

        const inlineWords = wordMatches.map((match) => ({
            start: parseTimeTag(match[1]),
            text: normalizeSpace(match[2]),
        })).filter((word) => Number.isFinite(word.start) && word.text);

        if (inlineWords.length > 0) hasWordTiming = true;

        for (const match of timeTags) {
            const start = parseTimeTag(match[1]);
            if (!Number.isFinite(start) || !plainText) continue;
            lines.push({
                start,
                end: null,
                text: plainText,
                words: inlineWords.length > 0 ? inlineWords : null,
            });
        }
    }

    const normalized = finalizeTimedLines(lines, fallbackDuration);
    if (normalized.length === 0) return null;
    return {
        type: hasWordTiming ? 'word' : 'line',
        lines: normalized,
    };
};

const parseVtt = (rawText, fallbackDuration) => {
    const blocks = String(rawText || '')
        .replace(/\r/g, '')
        .split(/\n\s*\n/)
        .map((block) => block.trim())
        .filter(Boolean);
    const lines = [];

    for (const block of blocks) {
        const parts = block.split('\n').map((line) => line.trim()).filter(Boolean);
        const timeLineIndex = parts.findIndex((line) => line.includes('-->'));
        if (timeLineIndex === -1) continue;
        const timeLine = parts[timeLineIndex];
        const timeMatch = timeLine.match(/^(.+?)\s+-->\s+(.+?)(?:\s|$)/);
        if (!timeMatch) continue;

        const start = parseSrtOrVttTime(timeMatch[1].trim());
        const end = parseSrtOrVttTime(timeMatch[2].trim());
        const text = stripHtml(parts.slice(timeLineIndex + 1).join(' '));

        if (!Number.isFinite(start) || !text) continue;
        const previous = lines[lines.length - 1];
        if (previous && previous.text === text && Math.abs(previous.end - start) < 0.05) {
            previous.end = Number.isFinite(end) ? end : previous.end;
            continue;
        }
        lines.push({ start, end, text, words: null });
    }

    const normalized = finalizeTimedLines(lines, fallbackDuration);
    if (normalized.length === 0) return null;
    return {
        type: 'line',
        lines: normalized,
    };
};

const requestJson = (url) => new Promise((resolve, reject) => {
    https.get(url, {
        headers: {
            'User-Agent': 'local-karaoke-system/1.0',
            'Accept': 'application/json, text/plain;q=0.9, */*;q=0.8',
        }
    }, (response) => {
        let body = '';
        response.on('data', (chunk) => body += chunk);
        response.on('end', () => {
            if (response.statusCode && response.statusCode >= 400) {
                reject(new Error(`HTTP ${response.statusCode}`));
                return;
            }
            try {
                resolve(body ? JSON.parse(body) : null);
            } catch (error) {
                reject(error);
            }
        });
    }).on('error', reject);
});

const requestText = (url) => new Promise((resolve, reject) => {
    https.get(url, {
        headers: {
            'User-Agent': 'local-karaoke-system/1.0',
            'Accept': 'text/plain, text/vtt, */*;q=0.8',
        }
    }, (response) => {
        let body = '';
        response.on('data', (chunk) => body += chunk);
        response.on('end', () => {
            if (response.statusCode && response.statusCode >= 400) {
                reject(new Error(`HTTP ${response.statusCode}`));
                return;
            }
            resolve(body);
        });
    }).on('error', reject);
});

const runPythonJson = (scriptPath, payload, timeoutMs = 25000) => new Promise((resolve, reject) => {
    const proc = spawn('python', [scriptPath], { shell: false });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const done = (error, result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
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

const loadCachedLyrics = (songId, sourceKey = 'auto') => {
    const cachePath = getLyricsCachePath(songId, sourceKey);
    if (!fs.existsSync(cachePath)) return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        if (!parsed || parsed.found !== true) return null;
        return parsed;
    } catch (error) {
        return null;
    }
};

const saveCachedLyrics = (songId, data, sourceKey = 'auto') => {
    if (!data || data.found !== true) return;
    try {
        fs.writeFileSync(getLyricsCachePath(songId, sourceKey), JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
        console.error('[Lyrics] Failed to cache lyrics:', error.message);
    }
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

const scoreSearchResult = (result, query) => {
    const trackName = result.trackName || result.track_name || result.name || '';
    const artistName = result.artistName || result.artist_name || result.artist || '';
    const resultDuration = Number(result.duration || result.length || 0);
    const normalizedTrack = normalizeKey(trackName);
    const normalizedArtist = normalizeKey(artistName);
    const normalizedQueryTitle = normalizeKey(query.title);
    const normalizedQueryArtist = normalizeKey(query.artist);

    let score = 0;
    if (normalizedQueryTitle) {
        if (normalizedTrack === normalizedQueryTitle) score += 80;
        else if (normalizedTrack.includes(normalizedQueryTitle) || normalizedQueryTitle.includes(normalizedTrack)) score += 50;
    }

    if (normalizedQueryArtist) {
        if (normalizedArtist === normalizedQueryArtist) score += 40;
        else if (normalizedArtist.includes(normalizedQueryArtist) || normalizedQueryArtist.includes(normalizedArtist)) score += 20;
    }

    if (query.duration && resultDuration) {
        const delta = Math.abs(query.duration - resultDuration);
        if (delta <= 2) score += 25;
        else if (delta <= 5) score += 15;
        else if (delta <= 10) score += 5;
    }

    if (result.syncedLyrics || result.synced_lyrics) score += 20;
    return score;
};

const createLyricsPayload = ({ source, provider, type, lines, plainLyrics, metadata, attemptedSources }) => {
    const cleanedLines = Array.isArray(lines)
        ? lines.map((line, index) => ({
            id: index + 1,
            start: Number(line.start.toFixed(3)),
            end: Number((line.end || line.start + 4).toFixed(3)),
            text: line.text,
            words: Array.isArray(line.words) && line.words.length > 0
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
        type,
        attemptedSources,
        plainLyrics: plainLyrics || cleanedLines.map((line) => line.text).join('\n'),
        metadata,
        lines: cleanedLines,
    };
};

const fetchLyricsFromYouTubeCaptions = async (song, attemptedSources) => {
    if (!isYouTubeLikeUrl(song.originalUrl)) return null;
    attemptedSources.push('youtube_captions');

    const tempBase = path.join(DOWNLOAD_DIR, `${song.id}_lyriccap`);
    const args = [
        '--skip-download',
        '--no-playlist',
        '--write-subs',
        '--write-auto-subs',
        '--sub-format', 'vtt',
        '--sub-langs', CAPTION_LANGS.join(','),
        '-o', `${tempBase}.%(ext)s`,
        song.originalUrl
    ];
    const cookies = getCookiesPath(song.originalUrl);
    if (cookies) {
        args.splice(args.length - 1, 0, '--cookies', cookies);
    }

    await new Promise((resolve) => {
        const proc = spawn(YT_DLP_EXE, args, { shell: false });
        proc.on('close', () => resolve());
        proc.on('error', () => resolve());
    });

    const candidates = fs.readdirSync(DOWNLOAD_DIR)
        .filter((name) => name.startsWith(`${song.id}_lyriccap`) && name.endsWith('.vtt'))
        .sort((a, b) => {
            const aScore = CAPTION_LANGS.findIndex((lang) => a.includes(`.${lang}.`));
            const bScore = CAPTION_LANGS.findIndex((lang) => b.includes(`.${lang}.`));
            return (aScore === -1 ? 999 : aScore) - (bScore === -1 ? 999 : bScore);
        });

    try {
        for (const filename of candidates) {
            const fullPath = path.join(DOWNLOAD_DIR, filename);
            const parsed = parseVtt(fs.readFileSync(fullPath, 'utf8'), song.duration);
            if (parsed && parsed.lines.length > 0) {
                return createLyricsPayload({
                    source: 'YouTube Captions',
                    provider: 'youtube_captions',
                    type: parsed.type,
                    lines: parsed.lines,
                    metadata: {
                        track: song.track || song.title,
                        artist: song.artist || song.uploader,
                    },
                    attemptedSources,
                });
            }
        }
    } finally {
        for (const filename of candidates) {
            try { fs.unlinkSync(path.join(DOWNLOAD_DIR, filename)); } catch (error) { }
        }
    }

    return null;
};

const fetchLyricsFromYtMusic = async (song, attemptedSources) => {
    attemptedSources.push('ytmusic');
    if (!fs.existsSync(YTMUSIC_HELPER)) return null;

    const query = buildSongQuery(song);
    const result = await runPythonJson(YTMUSIC_HELPER, {
        sourceId: song.sourceId || null,
        track: query.title,
        artist: query.artist,
        album: query.album,
        duration: query.duration,
        originalUrl: song.originalUrl || null,
    }).catch((error) => {
        console.error(`[Lyrics] YTMusic helper failed for ${song.title}: ${error.message}`);
        return null;
    });

    if (!result || !result.ok || !Array.isArray(result.lines) || result.lines.length === 0) {
        return null;
    }

    const normalized = finalizeTimedLines(result.lines.map((line) => ({
        start: Number(line.start),
        end: Number.isFinite(line.end) ? Number(line.end) : null,
        text: normalizeSpace(line.text),
        words: null,
    })), song.duration);

    if (normalized.length === 0) return null;

    return createLyricsPayload({
        source: 'YouTube Music',
        provider: 'ytmusic',
        type: 'line',
        lines: normalized,
        metadata: {
            track: result.metadata && result.metadata.track ? result.metadata.track : song.track || song.title,
            artist: result.metadata && result.metadata.artist ? result.metadata.artist : song.artist || song.uploader,
            album: result.metadata && result.metadata.album ? result.metadata.album : song.album || '',
            videoId: result.videoId || song.sourceId || null,
            browseId: result.browseId || null,
        },
        attemptedSources,
    });
};

const fetchLyricsFromLrclib = async (song, attemptedSources) => {
    attemptedSources.push('lrclib');
    const query = buildSongQuery(song);
    const search = new URL('https://lrclib.net/api/search');
    if (query.title) search.searchParams.set('track_name', query.title);
    if (query.artist) search.searchParams.set('artist_name', query.artist);
    if (query.album) search.searchParams.set('album_name', query.album);

    const results = await requestJson(search.toString()).catch(() => []);
    if (!Array.isArray(results) || results.length === 0) return null;

    const best = [...results].sort((a, b) => scoreSearchResult(b, query) - scoreSearchResult(a, query))[0];
    if (!best) return null;

    const syncedLyrics = best.syncedLyrics || best.synced_lyrics || '';
    const plainLyrics = best.plainLyrics || best.plain_lyrics || '';
    const parsed = syncedLyrics ? parseLrc(syncedLyrics, query.duration) : null;

    if (parsed && parsed.lines.length > 0) {
        return createLyricsPayload({
            source: 'LRCLIB',
            provider: 'lrclib',
            type: parsed.type,
            lines: parsed.lines,
            plainLyrics,
            metadata: {
                track: best.trackName || best.track_name || song.track || song.title,
                artist: best.artistName || best.artist_name || song.artist || song.uploader,
                album: best.albumName || best.album_name || song.album || '',
            },
            attemptedSources,
        });
    }

    return null;
};

const fetchLyricsFromSidecar = async (song, attemptedSources) => {
    attemptedSources.push('sidecar');
    const sidecars = [
        path.join(DOWNLOAD_DIR, `${song.id}.lrc`),
        path.join(DOWNLOAD_DIR, `${song.id}.vtt`),
        path.join(DOWNLOAD_DIR, `${song.id}.srt`),
    ];

    for (const filePath of sidecars) {
        if (!fs.existsSync(filePath)) continue;
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = filePath.endsWith('.lrc')
            ? parseLrc(raw, song.duration)
            : parseVtt(raw, song.duration);
        if (parsed && parsed.lines.length > 0) {
            return createLyricsPayload({
                source: 'Local Sidecar',
                provider: 'sidecar',
                type: parsed.type,
                lines: parsed.lines,
                metadata: {
                    track: song.track || song.title,
                    artist: song.artist || song.uploader,
                    album: song.album || '',
                },
                attemptedSources,
            });
        }
    }

    return null;
};

const buildMissingPayload = (song, attemptedSources) => ({
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

const findSongById = (songId) => {
    const numericId = Number(songId);
    const candidates = [
        state.currentPlaying,
        ...state.playlist,
        ...state.history,
    ].filter(Boolean);
    return candidates.find((song) => Number(song.id) === numericId) || null;
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

    const task = (async () => {
        const attemptedSources = [];
        const providerMap = {
            sidecar: fetchLyricsFromSidecar,
            ytmusic: fetchLyricsFromYtMusic,
            youtube_captions: fetchLyricsFromYouTubeCaptions,
            lrclib: fetchLyricsFromLrclib,
        };
        const providerOrder = sourceKey === 'auto'
            ? ['sidecar', 'ytmusic', 'youtube_captions', 'lrclib']
            : [sourceKey];

        for (const providerKey of providerOrder) {
            const provider = providerMap[providerKey];
            if (!provider) continue;
            try {
                const data = await provider(song, attemptedSources);
                if (data && data.found) {
                    if (sourceKey === 'auto') {
                        song.lyricsData = data;
                        updateSongLyricsState(song, data);
                    }
                    saveCachedLyrics(song.id, data, sourceKey);
                    return data;
                }
            } catch (error) {
                console.error(`[Lyrics] Provider failed for ${song.title}: ${error.message}`);
            }
        }

        const missing = buildMissingPayload(song, attemptedSources);
        if (sourceKey === 'auto') {
            song.lyricsData = missing;
            updateSongLyricsState(song, missing);
        }
        return missing;
    })().finally(() => {
        inflightLyrics.delete(inflightKey);
    });

    inflightLyrics.set(inflightKey, task);
    return task;
};

const prefetchLyrics = (song) => {
    fetchLyricsForSong(song).catch((error) => {
        console.error('[Lyrics] Prefetch failed:', error.message);
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
    for (const file of fs.readdirSync(DOWNLOAD_DIR)) {
        if (file.startsWith(`${songId}_lyriccap`) || file.startsWith(`${songId}_lyrics_`)) {
            try { fs.unlinkSync(path.join(DOWNLOAD_DIR, file)); } catch (error) { }
        }
    }
};

module.exports = {
    fetchLyricsForSong,
    getLyricsBySongId,
    prefetchLyrics,
    deleteLyricsCache,
};
