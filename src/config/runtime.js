const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '../../');
const DOWNLOAD_DIR = path.join(ROOT_DIR, 'downloads');
const SEPARATED_DIR = path.join(ROOT_DIR, 'separated');
const SCRIPTS_DIR = path.join(ROOT_DIR, 'scripts');

const resolveBundledBinary = (filename, fallbackCommand) => {
    const bundledPath = path.join(ROOT_DIR, filename);
    return fs.existsSync(bundledPath) ? bundledPath : fallbackCommand;
};

const YT_DLP_EXE = resolveBundledBinary('yt-dlp.exe', 'yt-dlp');
const FFMPEG_EXE = resolveBundledBinary('ffmpeg.exe', 'ffmpeg');
const PORTABLE_PYTHON = path.join(ROOT_DIR, 'python', 'python.exe');
const PYTHON_EXE = fs.existsSync(PORTABLE_PYTHON) ? PORTABLE_PYTHON : 'python';
const NODE_EXE = process.execPath && /^node(?:\.exe)?$/i.test(path.basename(process.execPath))
    ? process.execPath
    : 'node';

const ensureDirSync = (dirPath) => {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
    return dirPath;
};

const ensureRuntimeDirs = () => {
    ensureDirSync(DOWNLOAD_DIR);
    ensureDirSync(SEPARATED_DIR);
};

const isYouTubeLikeUrl = (url = '') => /(^https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)\b/i.test(String(url || ''));

const buildChildProcessEnv = () => {
    const env = { ...process.env };
    if (typeof NODE_EXE === 'string' && NODE_EXE !== 'node' && fs.existsSync(NODE_EXE)) {
        const nodeDir = path.dirname(NODE_EXE);
        const currentPath = env.PATH || env.Path || '';
        const segments = currentPath.split(path.delimiter).filter(Boolean);
        if (!segments.includes(nodeDir)) {
            const nextPath = `${nodeDir}${path.delimiter}${currentPath}`;
            env.PATH = nextPath;
            env.Path = nextPath;
        }
    }
    return env;
};

const appendYtDlpJsRuntimeArgs = (args, url = '') => {
    if (!Array.isArray(args) || !isYouTubeLikeUrl(url)) return;
    args.push('--js-runtimes', 'node');
};

const getCookiesPath = (url = '') => {
    if (typeof url !== 'string' || !url.trim()) return null;
    const normalizedUrl = url.toLowerCase();

    if (normalizedUrl.includes('bilibili.com')) {
        const cookiePath = path.join(ROOT_DIR, 'cookies_bilibili.txt');
        return fs.existsSync(cookiePath) ? cookiePath : null;
    }

    if (normalizedUrl.includes('youtube.com') || normalizedUrl.includes('youtu.be') || normalizedUrl.includes('music.youtube.com')) {
        const cookiePath = path.join(ROOT_DIR, 'cookies_youtube.txt');
        return fs.existsSync(cookiePath) ? cookiePath : null;
    }

    return null;
};

const describeRuntimeBinaries = () => ({
    rootDir: ROOT_DIR,
    downloadDir: DOWNLOAD_DIR,
    separatedDir: SEPARATED_DIR,
    ytDlp: YT_DLP_EXE,
    ffmpeg: FFMPEG_EXE,
    python: PYTHON_EXE,
    node: NODE_EXE,
});

module.exports = {
    ROOT_DIR,
    DOWNLOAD_DIR,
    SEPARATED_DIR,
    SCRIPTS_DIR,
    YT_DLP_EXE,
    FFMPEG_EXE,
    PYTHON_EXE,
    NODE_EXE,
    ensureDirSync,
    ensureRuntimeDirs,
    isYouTubeLikeUrl,
    buildChildProcessEnv,
    appendYtDlpJsRuntimeArgs,
    getCookiesPath,
    describeRuntimeBinaries,
};
