const { spawn } = require('child_process');
const http = require('http');
const https = require('https');

const { getAdvancedConfig } = require('../config/configManager');
const { YT_DLP_EXE, getCookiesPath, buildChildProcessEnv, appendYtDlpJsRuntimeArgs } = require('../config/runtime');
const logger = require('../utils/logger');

const isYouTubeLikeUrl = (url) => /(^https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)\b/i.test(url);
const isBilibiliHost = (host = '') => {
    const normalizedHost = String(host || '').toLowerCase();
    return normalizedHost.endsWith('bilibili.com')
        || normalizedHost === 'b23.tv'
        || normalizedHost.endsWith('.b23.tv')
        || normalizedHost === 'bili2233.cn'
        || normalizedHost.endsWith('.bili2233.cn');
};

const trimUrlBoundaryChars = (value = '') => {
    let result = String(value || '').trim();
    if (!result) return '';

    while (result && !/[a-z0-9]/i.test(result[0])) {
        result = result.slice(1);
    }
    while (result && !/[a-z0-9/#?=&%_-]/i.test(result[result.length - 1])) {
        result = result.slice(0, -1).trimEnd();
    }

    return result.trim();
};

const normalizePossibleUrl = (value = '') => {
    const candidate = trimUrlBoundaryChars(value);
    if (!candidate) return null;

    const nextUrl = /^[a-z][a-z\d+.-]*:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
    try {
        const parsed = new URL(nextUrl);
        if (!/^https?:$/i.test(parsed.protocol)) return null;
        if (!parsed.hostname || !parsed.hostname.includes('.')) return null;
        return parsed.toString();
    } catch (error) {
        return null;
    }
};

const extractAllUrlsFromText = (value = '') => {
    const text = String(value || '').trim();
    if (!text) return [];

    const candidates = [];
    const directUrl = normalizePossibleUrl(text);
    if (directUrl) {
        candidates.push(directUrl);
    }

    const withSchemePattern = /https?:\/\/[^\s<>"'`]+/ig;
    for (const match of text.matchAll(withSchemePattern)) {
        const token = match && match[0] ? match[0] : '';
        if (!token) continue;
        const parsed = normalizePossibleUrl(token);
        if (parsed) candidates.push(parsed);
    }

    const domainPattern = /(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/[^\s<>"'`]*)?/ig;
    for (const match of text.matchAll(domainPattern)) {
        const token = match && match[0] ? match[0] : '';
        if (!token) continue;

        const matchIndex = Number(match.index) || 0;
        const prevChar = matchIndex > 0 ? text[matchIndex - 1] : '';
        if (prevChar === '@') continue;

        const parsed = normalizePossibleUrl(token);
        if (parsed) candidates.push(parsed);
    }

    const unique = [];
    const seen = new Set();
    for (const item of candidates) {
        if (!item || seen.has(item)) continue;
        seen.add(item);
        unique.push(item);
    }

    return unique;
};

const isBilibiliShortUrl = (url = '') => {
    try {
        const host = new URL(url).hostname.toLowerCase();
        return host === 'b23.tv'
            || host.endsWith('.b23.tv')
            || host === 'bili2233.cn'
            || host.endsWith('.bili2233.cn');
    } catch (error) {
        return /(^https?:\/\/)?([a-z0-9-]+\.)?(b23\.tv|bili2233\.cn)\b/i.test(String(url || ''));
    }
};

const requestRedirectMeta = (url, method = 'HEAD', timeoutMs = 7000) => new Promise((resolve, reject) => {
    let parsed;
    try {
        parsed = new URL(url);
    } catch (error) {
        reject(error);
        return;
    }

    const transport = parsed.protocol === 'http:' ? http : https;
    const request = transport.request(parsed, {
        method,
        timeout: timeoutMs,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
            'Accept': '*/*',
        },
    }, (response) => {
        const locationHeader = response.headers.location;
        const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
        response.resume();
        resolve({
            statusCode: Number(response.statusCode) || 0,
            location: typeof location === 'string' ? location : '',
        });
    });

    request.on('timeout', () => {
        request.destroy(new Error(`timeout_${timeoutMs}`));
    });
    request.on('error', reject);
    request.end();
});

const resolveShortUrlRedirect = async (url, maxRedirects = 6) => {
    let currentUrl = url;

    for (let index = 0; index < maxRedirects; index += 1) {
        let metadata = null;
        try {
            metadata = await requestRedirectMeta(currentUrl, 'HEAD', 7000);
        } catch (error) {
            metadata = null;
        }

        if (!metadata || metadata.statusCode === 405 || metadata.statusCode === 501) {
            try {
                metadata = await requestRedirectMeta(currentUrl, 'GET', 7000);
            } catch (error) {
                metadata = null;
            }
        }

        if (!metadata) return currentUrl;

        if (metadata.statusCode >= 300 && metadata.statusCode < 400 && metadata.location) {
            try {
                currentUrl = new URL(metadata.location, currentUrl).toString();
                continue;
            } catch (error) {
                return currentUrl;
            }
        }

        return currentUrl;
    }

    return currentUrl;
};

const normalizeIncomingUrls = async (input = '') => {
    const extractedUrls = extractAllUrlsFromText(input);
    if (extractedUrls.length === 0) return [];

    const normalizedUrls = [];
    const seen = new Set();

    for (const extractedUrl of extractedUrls) {
        const nextUrl = isBilibiliShortUrl(extractedUrl)
            ? (await resolveShortUrlRedirect(extractedUrl)) || extractedUrl
            : extractedUrl;

        if (nextUrl !== extractedUrl) {
            logger.info('Fetcher', 'Resolved Bilibili short URL', { shortUrl: extractedUrl, resolvedUrl: nextUrl });
        }

        if (!seen.has(nextUrl)) {
            seen.add(nextUrl);
            normalizedUrls.push(nextUrl);
        }
    }

    return normalizedUrls;
};

const getBilibiliRequestedPartNumber = (url = '') => {
    const normalizedUrl = String(url || '').trim();
    if (!normalizedUrl) return null;
    try {
        const parsed = new URL(normalizedUrl);
        if (!isBilibiliHost(parsed.hostname)) return null;
        const pathname = parsed.pathname.toLowerCase();
        if (!pathname.startsWith('/video/')) return null;
        const requestedPart = Number(parsed.searchParams.get('p'));
        return Number.isInteger(requestedPart) && requestedPart > 0 ? requestedPart : null;
    } catch (error) {
        const match = normalizedUrl.match(/[?&]p=(\d+)/i);
        const requestedPart = match ? Number(match[1]) : null;
        return Number.isInteger(requestedPart) && requestedPart > 0 ? requestedPart : null;
    }
};

const isBilibiliVideoUrl = (url = '') => {
    const normalizedUrl = String(url || '').trim();
    if (!normalizedUrl) return false;
    try {
        const parsed = new URL(normalizedUrl);
        if (!isBilibiliHost(parsed.hostname)) return false;
        return parsed.pathname.toLowerCase().startsWith('/video/');
    } catch (error) {
        return /bilibili\.com\/video\//i.test(normalizedUrl);
    }
};

const extractBilibiliBvid = (url = '') => {
    const normalizedUrl = String(url || '').trim();
    if (!normalizedUrl) return null;
    try {
        const parsed = new URL(normalizedUrl);
        if (!isBilibiliHost(parsed.hostname)) return null;
        const match = parsed.pathname.match(/\/video\/(BV[\da-zA-Z]+)/i);
        return match ? match[1] : null;
    } catch (error) {
        const match = normalizedUrl.match(/\/video\/(BV[\da-zA-Z]+)/i);
        return match ? match[1] : null;
    }
};

const detectSourcePlatform = (url = '') => {
    const normalizedUrl = String(url || '').trim();
    if (!normalizedUrl) return null;
    try {
        const parsed = new URL(normalizedUrl);
        const host = parsed.hostname.toLowerCase();
        if (host === 'music.youtube.com') return 'ytmusic';
        if (host.endsWith('youtube.com') || host === 'youtu.be') return 'youtube';
        if (isBilibiliHost(host)) return 'bilibili';
    } catch (error) {
        if (/music\.youtube\.com/i.test(normalizedUrl)) return 'ytmusic';
        if (/youtube\.com|youtu\.be/i.test(normalizedUrl)) return 'youtube';
        if (/bilibili\.com|b23\.tv|bili2233\.cn/i.test(normalizedUrl)) return 'bilibili';
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

const fetchBilibiliPageList = async (bvid) => {
    if (!bvid) return null;
    const apiUrl = `https://api.bilibili.com/x/player/pagelist?bvid=${encodeURIComponent(bvid)}&jsonp=jsonp`;
    try {
        const response = await requestJson(apiUrl, 10000);
        if (response && response.code === 0 && Array.isArray(response.data) && response.data.length > 0) {
            return response.data;
        }
    } catch (error) {
        logger.warn('Fetcher', 'Bilibili pagelist API request failed', { bvid, error });
    }
    return null;
};

const normalizeBilibiliPartItems = ({
    bvid,
    pageList,
    videoTitle,
    uploader,
    requestedPart = null,
    sourcePlatform = 'bilibili',
    fallbackTitle = null,
    fallbackTrack = null,
    fallbackDuration = null,
}) => {
    if (!bvid || !Array.isArray(pageList) || pageList.length === 0) return [];
    const totalParts = pageList.length;
    const requestedPartNumber = Number.isInteger(requestedPart) && requestedPart > 0 ? requestedPart : null;
    const requestedPartExists = requestedPartNumber ? pageList.some((part) => Number(part?.page) === requestedPartNumber) : false;

    return pageList.map((part) => {
        const partNumber = Number(part?.page) || 1;
        const partTitle = part?.part || `P${partNumber}`;
        const resolvedVideoTitle = videoTitle || fallbackTitle || `Video ${bvid}`;
        const resolvedTrack = part?.part || fallbackTrack || `${resolvedVideoTitle} - P${partNumber}`;

        return {
            title: totalParts > 1 ? `P${partNumber} - ${partTitle} - ${resolvedVideoTitle}` : resolvedVideoTitle,
            uploader: uploader || 'Unknown',
            artist: uploader || 'Unknown',
            album: resolvedVideoTitle,
            track: resolvedTrack,
            duration: Number.isFinite(part?.duration) ? part.duration : fallbackDuration,
            sourceId: bvid,
            extractor: 'BiliBili',
            pic: null,
            originalUrl: `https://www.bilibili.com/video/${bvid}?p=${partNumber}`,
            sourcePlatform,
            partNumber,
            partTitle,
            partCount: totalParts,
            groupKey: totalParts > 1 ? bvid : null,
            groupTitle: resolvedVideoTitle,
            groupSubtitle: uploader || 'Unknown',
            groupDescription: totalParts > 1 ? `${totalParts} parts` : '',
            selected: requestedPartNumber ? (requestedPartExists ? partNumber === requestedPartNumber : true) : true,
            cid: part?.cid || null,
        };
    });
};

const fetchBilibiliVideoView = async (bvid) => {
    if (!bvid) return null;
    const apiUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
    try {
        const response = await requestJson(apiUrl, 10000);
        if (response && response.code === 0 && response.data) {
            return {
                title: response.data.title || null,
                uploader: response.data.owner && response.data.owner.name ? response.data.owner.name : null,
            };
        }
    } catch (error) {
        logger.warn('Fetcher', 'Bilibili view API request failed', { bvid, error });
    }
    return null;
};

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

    const videoViewCache = new Map();
    const pageListCache = new Map();
    const getCachedVideoView = async (bvid) => {
        const normalizedBvid = String(bvid || '').trim();
        if (!normalizedBvid) return null;
        if (videoViewCache.has(normalizedBvid)) return videoViewCache.get(normalizedBvid);
        const value = await fetchBilibiliVideoView(normalizedBvid);
        videoViewCache.set(normalizedBvid, value);
        return value;
    };
    const getCachedPageList = async (bvid) => {
        const normalizedBvid = String(bvid || '').trim();
        if (!normalizedBvid) return null;
        if (pageListCache.has(normalizedBvid)) return pageListCache.get(normalizedBvid);
        const value = await fetchBilibiliPageList(normalizedBvid);
        pageListCache.set(normalizedBvid, value);
        return value;
    };

    const list = [];
    for (const item of allMedias) {
        const bvid = String(item?.bvid || '').trim();
        const fallbackTitle = String(item?.title || '').trim();
        const fallbackUploader = item?.upper && item.upper.name ? item.upper.name : 'Unknown';
        const fallbackDuration = Number.isFinite(item?.duration) ? item.duration : null;

        if (!bvid) {
            list.push({
                title: fallbackTitle || 'Unknown Title',
                uploader: fallbackUploader,
                artist: fallbackUploader,
                album: '',
                track: fallbackTitle || 'Unknown Title',
                duration: fallbackDuration,
                sourceId: null,
                extractor: 'BiliBili',
                pic: null,
                originalUrl: url,
                sourcePlatform: detectSourcePlatform(url),
                selected: true,
            });
            continue;
        }

        const pageList = await getCachedPageList(bvid);
        if (Array.isArray(pageList) && pageList.length > 1) {
            const videoView = await getCachedVideoView(bvid);
            const videoTitle = videoView && videoView.title ? videoView.title : fallbackTitle || `Video ${bvid}`;
            const uploader = videoView && videoView.uploader ? videoView.uploader : fallbackUploader;
            list.push(...normalizeBilibiliPartItems({
                bvid,
                pageList,
                videoTitle,
                uploader,
                requestedPart: null,
                sourcePlatform: detectSourcePlatform(url),
                fallbackTitle,
                fallbackTrack: fallbackTitle || `Video ${bvid}`,
                fallbackDuration,
            }));
            continue;
        }

        list.push({
            title: fallbackTitle || `Video ${bvid}`,
            uploader: fallbackUploader,
            artist: fallbackUploader,
            album: '',
            track: fallbackTitle || `Video ${bvid}`,
            duration: fallbackDuration,
            sourceId: bvid,
            extractor: 'BiliBili',
            pic: null,
            originalUrl: `https://www.bilibili.com/video/${bvid}`,
            sourcePlatform: detectSourcePlatform(url),
            selected: true,
        });
    }

    logger.info('Fetcher', `Bilibili favorites lookup returned ${list.length} item(s)`, { mediaId });
    return {
        list,
    };
};

const fetchSingleUrlInfo = async (normalizedUrl) => {
    const playlistMode = isPlaylistLikeUrl(normalizedUrl) || isBilibiliShortUrl(normalizedUrl);
    const biliFavMatch = normalizedUrl.match(/space\.bilibili\.com\/\d+\/favlist\?.*fid=(\d+)/);

    if (biliFavMatch) {
        const fromApi = await fetchBilibiliFavorites(normalizedUrl, biliFavMatch[1]);
        if (fromApi) return fromApi;
        logger.warn('Fetcher', 'Bilibili favorites API returned no data, falling back to yt-dlp', { url: normalizedUrl });
    }

    const bvid = extractBilibiliBvid(normalizedUrl);
    if (bvid && isBilibiliVideoUrl(normalizedUrl)) {
        const pageList = await fetchBilibiliPageList(bvid);
        if (pageList && pageList.length > 1) {
            const videoView = await fetchBilibiliVideoView(bvid);
            const videoTitle = videoView && videoView.title ? videoView.title : `Video ${bvid}`;
            const uploader = videoView && videoView.uploader ? videoView.uploader : 'Unknown';
            const requestedPart = getBilibiliRequestedPartNumber(normalizedUrl);
            logger.info('Fetcher', `Bilibili multi-part video detected with ${pageList.length} parts`, { bvid });
            return {
                list: normalizeBilibiliPartItems({
                    bvid,
                    pageList,
                    videoTitle,
                    uploader,
                    requestedPart,
                    sourcePlatform: 'bilibili',
                    fallbackTitle: videoTitle,
                    fallbackTrack: videoTitle,
                    fallbackDuration: null,
                }),
            };
        }
    }

    return runYtDlp(normalizedUrl, { playlistMode });
};

const fetchUrlInfo = async (url) => {
    const rawInput = typeof url === 'string' ? url : '';
    const normalizedUrls = await normalizeIncomingUrls(rawInput);
    if (normalizedUrls.length === 0) {
        logger.warn('Fetcher', 'Ignoring parse request without a recognizable URL', { input: rawInput });
        return null;
    }

    if (normalizedUrls.length === 1) {
        return fetchSingleUrlInfo(normalizedUrls[0]);
    }

    logger.info('Fetcher', `Detected ${normalizedUrls.length} URLs from mixed input`, {
        inputLength: rawInput.length,
        urlCount: normalizedUrls.length,
    });

    const list = [];
    const seenSongUrls = new Set();

    for (const sourceUrl of normalizedUrls) {
        const result = await fetchSingleUrlInfo(sourceUrl);
        if (!result || !Array.isArray(result.list) || result.list.length === 0) continue;

        for (const item of result.list) {
            if (!item || typeof item !== 'object') continue;
            const songUrl = String(item.originalUrl || '').trim();
            if (songUrl && seenSongUrls.has(songUrl)) continue;
            if (songUrl) seenSongUrls.add(songUrl);
            list.push(item);
        }
    }

    return list.length > 0 ? { list } : null;
};

module.exports = {
    fetchUrlInfo,
};
