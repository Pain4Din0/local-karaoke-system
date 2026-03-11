const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { getAdvancedConfig } = require('../config/configManager');
const { getCookiesPath } = require('./system');

const ROOT_DIR = path.join(__dirname, '../../');

const isYouTubeLikeUrl = (url) => /(^https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)\b/i.test(url);

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
    } catch (e) {
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

const runYtDlp = (url, resolve, options = {}) => {
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
    const cookies = getCookiesPath(url);
    if (cookies) args.push('--cookies', cookies);
    args.push(url);

    const ytDlpExe = fs.existsSync(path.join(ROOT_DIR, 'yt-dlp.exe')) ? path.join(ROOT_DIR, 'yt-dlp.exe') : 'yt-dlp';
    const child = spawn(ytDlpExe, args);
    let output = '';
    child.stdout.on('data', d => output += d);
    child.on('close', code => {
        if (code === 0) {
            try {
                const lines = output.trim().split('\n');
                const items = lines.map(line => {
                    try {
                        return JSON.parse(line);
                    } catch (e) { return null; }
                }).filter(x => x);

                if (items.length === 0) {
                    resolve(null);
                    return;
                }

                const formattedItems = items.map(data => {
                    let title = data.title;
                    if (!title && data.id) title = `Video ${data.id}`;

                    return {
                        title: title || 'Unknown Title',
                        uploader: data.uploader || data.uploader_id || 'Unknown',
                        pic: null, // Thumbnails disabled per user request
                        originalUrl: buildOriginalUrl(data, url)
                    };
                });

                if (formattedItems.length > 0) {
                    resolve({ list: formattedItems });
                } else {
                    resolve(null);
                }
            } catch (e) {
                console.error('[yt-dlp] JSON parse failed:', e.message);
                resolve(null);
            }
        } else {
            console.error(`[yt-dlp] Process exited with code ${code}`);
            resolve(null);
        }
    });
    child.on('error', (err) => {
        console.error('[yt-dlp] Spawn error:', err.message);
        resolve(null);
    });
};

const fetchUrlInfo = (url) => {
    return new Promise((resolve) => {
        const playlistMode = isPlaylistLikeUrl(url);

        // 1. Try Bilibili Favorites API first
        const biliFavMatch = url.match(/space\.bilibili\.com\/\d+\/favlist\?.*fid=(\d+)/);
        if (biliFavMatch) {
            (async () => {
                const mediaId = biliFavMatch[1];
                let allMedias = [];
                let pn = 1;
                let hasMore = true;

                const fetchPage = (p) => new Promise(res => {
                    // Use ps=20 as ps=50 causes -400 error
                    const apiUrl = `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${mediaId}&pn=${p}&ps=20&keyword=&order=mtime&type=0&tid=0&platform=web`;
                    https.get(apiUrl, {
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36)' }
                    }, (r) => {
                        let d = '';
                        r.on('data', c => d += c);
                        r.on('end', () => {
                            try {
                                const j = JSON.parse(d);
                                if (j.code === 0 && j.data && j.data.medias) {
                                    res({ medias: j.data.medias, hasMore: j.data.has_more });
                                } else {
                                    // console.error('[API] Bilibili Error:', j);
                                    res({ medias: [], hasMore: false });
                                }
                            } catch (e) { res({ medias: [], hasMore: false }); }
                        });
                    }).on('error', () => res({ medias: [], hasMore: false }));
                });

                // Fetch up to 5 pages (100 items)
                while (hasMore && pn <= 5) {
                    try {
                        const res = await fetchPage(pn);
                        if (res.medias.length > 0) {
                            allMedias = allMedias.concat(res.medias);
                            hasMore = res.hasMore;
                            pn++;
                        } else {
                            hasMore = false;
                        }
                    } catch (e) { hasMore = false; }
                }

                if (allMedias.length > 0) {
                    const list = allMedias.map(item => ({
                        title: item.title,
                        uploader: item.upper ? item.upper.name : 'Unknown',
                        pic: null, // Thumbnails disabled per user request
                        originalUrl: `https://www.bilibili.com/video/${item.bvid}`
                    }));
                    resolve({ list });
                    return;
                }

                // Fallback to yt-dlp if API fails or returns empty
                runYtDlp(url, resolve, { playlistMode });
            })();
            return; // Early return to prevent running yt-dlp immediately
        }

        // 2. Default yt-dlp logic for all other URLs or if Bilibili API failed
        runYtDlp(url, resolve, { playlistMode });
    });
};

module.exports = {
    fetchUrlInfo
};
