const { spawn } = require('child_process');
const https = require('https');

const { getAdvancedConfig } = require('../config/configManager');
const { YT_DLP_EXE, getCookiesPath, buildChildProcessEnv, appendYtDlpJsRuntimeArgs } = require('../config/runtime');
const logger = require('../utils/logger');

const isYouTubeLikeUrl = (url) => /(^https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)\b/i.test(url);

const detectSourcePlatform = (url = '') => {
    const normalizedUrl = String(url || '').trim();
    if (!normalizedUrl) return null;
    try {
        const parsed = new URL(normalizedUrl);
        const host = parsed.hostname.toLowerCase();
        if (host === 'music.youtube.com') return 'ytmusic';
        if (host.endsWith('youtube.com') || host === 'youtu.be') return 'youtube';
        if (host.endsWith('bilibili.com')) return 'bilibili';
    } catch (error) {
        if (/music\.youtube\.com/i.test(normalizedUrl)) return 'ytmusic';
        if (/youtube\.com|youtu\.be/i.test(normalizedUrl)) return 'youtube';
        if (/bilibili\.com/i.test(normalizedUrl)) return 'bilibili';
    }
    return null;
};

const isPlaylistLikeUrl = (url) => {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        const pathname = parsed.pathname.toLowerCase();
        const listId = parsed.searchParams.get('list');

        if (host === 'music.youtube.com') {
            if (pathname.startsWith('/playlist') || pathname.startsWith('/browse')) return true;
            if (listId && listId.trim()) return true;
        }

        if (host.endsWith('youtube.com') || host === 'youtu.be') {
            if (pathname.startsWith('/playlist')) return true;
            if (listId && listId.trim()) return true;
        }

        if (host.endsWith('bilibili.com')) {
            if (pathname.includes('/favlist')) return true;
            if (pathname.includes('/list/')) return true;
            if (pathname.includes('/medialist/')) return true;
            if (parsed.searchParams.get('fid')) return true;
        }
    } catch (error) {
        return /[?&]list=|music\.youtube\.com\/(playlist|browse)|bilibili\.com\/.*(favlist|list|medialist)/i.test(url);
    }

    return false;
};

const buildOriginalUrl = (data, sourceUrl) => {
    let itemUrl = data.url || data.webpage_url || data.original_url;
    if (!itemUrl && data.id) {
        if (data.ie_key === 'Youtube' || data.ie_key === 'YoutubeTab' || !data.ie_key || isYouTubeLikeUrl(sourceUrl)) {
            itemUrl = `https://www.youtube.com/watch?v=${data.id}`;
        } else if (data.ie_key === 'BiliBili') {
            itemUrl = `https://www.bilibili.com/video/${data.id}`;
        } else {
            itemUrl = sourceUrl;
        }
    }

    if (typeof itemUrl === 'string' && !/^https?:\/\//i.test(itemUrl) && data.id && isYouTubeLikeUrl(sourceUrl)) {
        itemUrl = `https://www.youtube.com/watch?v=${data.id}`;
    }

    return itemUrl || sourceUrl;
};

const runYtDlp = (url, options = {}) => new Promise((resolve) => {
    const cfg = getAdvancedConfig().ytdlp;
    const args = [];
    const playlistMode = options.playlistMode === true;

    if (cfg.flatPlaylist !== false) args.push('--flat-playlist');
    if (cfg.dumpJson !== false) args.push('--dump-json');
    if (!playlistMode && cfg.noPlaylist !== false) args.push('--no-playlist');
    if (cfg.proxy) args.push('--proxy', cfg.proxy);
    if (cfg.socketTimeout) args.push('--socket-timeout', String(cfg.socketTimeout));
    if (cfg.userAgent) args.push('--user-agent', cfg.userAgent);
    if (cfg.noCheckCertificates) args.push('--no-check-certificates');
    if (cfg.noWarnings) args.push('--no-warnings');
    appendYtDlpJsRuntimeArgs(args, url);

    const cookies = getCookiesPath(url);
    if (cookies) args.push('--cookies', cookies);
    args.push(url);

    logger.info('Fetcher', 'Running yt-dlp metadata lookup', {
        url,
        playlistMode,
        executable: YT_DLP_EXE,
    });

    const child = spawn(YT_DLP_EXE, args, { shell: false, env: buildChildProcessEnv() });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
    };

    const timer = setTimeout(() => {
        try {
            child.kill('SIGKILL');
        } catch (error) {
            logger.warn('Fetcher', 'Failed to terminate timed out yt-dlp metadata process', error);
        }
        logger.error('Fetcher', 'yt-dlp metadata lookup timed out', { url });
        finish(null);
    }, 45000);

    child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
    });

    child.on('close', (code) => {
        if (code !== 0) {
            logger.error('Fetcher', 'yt-dlp metadata lookup failed', { url, code, stderr: stderr.trim() });
            finish(null);
            return;
        }

        try {
            const lines = stdout.trim().split('\n').filter(Boolean);
            const items = lines
                .map((line) => {
                    try {
                        return JSON.parse(line);
                    } catch (error) {
                        logger.warn('Fetcher', 'Failed to parse yt-dlp JSON line', { line });
                        return null;
                    }
                })
                .filter(Boolean);

            if (items.length === 0) {
                logger.warn('Fetcher', 'yt-dlp returned no metadata items', { url });
                finish(null);
                return;
            }

            const formattedItems = items.map((data) => {
                const title = data.title || (data.id ? `Video ${data.id}` : 'Unknown Title');
                return {
                    title,
                    uploader: data.uploader || data.uploader_id || 'Unknown',
                    artist: data.artist || data.album_artist || data.creator || data.uploader || data.uploader_id || 'Unknown',
                    album: data.album || '',
                    track: data.track || title,
                    duration: Number.isFinite(data.duration) ? data.duration : null,
                    sourceId: data.id || null,
                    extractor: data.ie_key || null,
                    pic: null,
                    originalUrl: buildOriginalUrl(data, url),
                    sourcePlatform: detectSourcePlatform(url),
                };
            });

            logger.info('Fetcher', `yt-dlp metadata lookup succeeded with ${formattedItems.length} item(s)`, { url });
            finish({ list: formattedItems });
        } catch (error) {
            logger.error('Fetcher', 'Failed to normalize yt-dlp metadata output', error);
            finish(null);
        }
    });

    child.on('error', (error) => {
        logger.error('Fetcher', 'Failed to spawn yt-dlp metadata process', error);
        finish(null);
    });
});

const requestJson = (url, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const request = https.get(url, {
        timeout: timeoutMs,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
            'Accept': 'application/json, text/plain;q=0.9, */*;q=0.8',
        },
    }, (response) => {
        let body = '';
        response.on('data', (chunk) => {
            body += chunk;
        });
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
    });

    request.on('timeout', () => {
        request.destroy(new Error(`timeout_${timeoutMs}`));
    });
    request.on('error', reject);
});

const fetchBilibiliFavorites = async (url, mediaId) => {
    let allMedias = [];
    let pageNumber = 1;
    let hasMore = true;

    while (hasMore && pageNumber <= 5) {
        const apiUrl = `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${mediaId}&pn=${pageNumber}&ps=20&keyword=&order=mtime&type=0&tid=0&platform=web`;

        try {
            const response = await requestJson(apiUrl);
            if (response && response.code === 0 && response.data && Array.isArray(response.data.medias) && response.data.medias.length > 0) {
                allMedias = allMedias.concat(response.data.medias);
                hasMore = !!response.data.has_more;
                pageNumber += 1;
                continue;
            }
        } catch (error) {
            logger.warn('Fetcher', 'Bilibili favorites API request failed', { url, mediaId, pageNumber, error });
        }

        hasMore = false;
    }

    if (allMedias.length === 0) return null;

    logger.info('Fetcher', `Bilibili favorites lookup returned ${allMedias.length} item(s)`, { mediaId });
    return {
        list: allMedias.map((item) => ({
            title: item.title,
            uploader: item.upper ? item.upper.name : 'Unknown',
            artist: item.upper ? item.upper.name : 'Unknown',
            album: '',
            track: item.title,
            duration: Number.isFinite(item.duration) ? item.duration : null,
            sourceId: item.bvid || null,
            extractor: 'BiliBili',
            pic: null,
            originalUrl: item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : url,
            sourcePlatform: detectSourcePlatform(url),
        })),
    };
};

const fetchUrlInfo = async (url) => {
    const normalizedUrl = typeof url === 'string' ? url.trim() : '';
    if (!normalizedUrl) {
        logger.warn('Fetcher', 'Ignoring empty URL parse request');
        return null;
    }

    const playlistMode = isPlaylistLikeUrl(normalizedUrl);
    const biliFavMatch = normalizedUrl.match(/space\.bilibili\.com\/\d+\/favlist\?.*fid=(\d+)/);

    if (biliFavMatch) {
        const fromApi = await fetchBilibiliFavorites(normalizedUrl, biliFavMatch[1]);
        if (fromApi) return fromApi;
        logger.warn('Fetcher', 'Bilibili favorites API returned no data, falling back to yt-dlp', { url: normalizedUrl });
    }

    return runYtDlp(normalizedUrl, { playlistMode });
};

module.exports = {
    fetchUrlInfo,
};
