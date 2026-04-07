const { spawn } = require('child_process');
const https = require('https');

const { getAdvancedConfig } = require('../config/configManager');
const { YT_DLP_EXE, getCookiesPath, buildChildProcessEnv, appendYtDlpJsRuntimeArgs } = require('../config/runtime');
const logger = require('../utils/logger');

const isYouTubeLikeUrl = (url) => /(^https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)\b/i.test(url);

const getBilibiliRequestedPartNumber = (url = '') => {
    const normalizedUrl = String(url || '').trim();
    if (!normalizedUrl) return null;
    try {
        const parsed = new URL(normalizedUrl);
        if (!parsed.hostname.toLowerCase().endsWith('bilibili.com')) return null;
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
        if (!parsed.hostname.toLowerCase().endsWith('bilibili.com')) return false;
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
        if (!parsed.hostname.toLowerCase().endsWith('bilibili.com')) return null;
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

module.exports = {
    fetchUrlInfo,
};
