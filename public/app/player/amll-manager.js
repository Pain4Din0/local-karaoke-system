/**
 * Apple Music-like Lyrics Manager (AMLL Manager)
 * 
 * Inspired by @applemusic-like-lyrics/core, this module provides:
 * - Dynamic gradient background from album art colors
 * - Apple Music-style scrolling lyrics with glow/blur effects
 * - Word-by-word synced highlighting with smooth transitions
 * - Play/pause animation states for background
 */

import { AMLLLyricPlayer } from './amll-lyric-player.js';

// ── Color Extraction ───────────────────────────────────────

const extractDominantColors = (imageSource, numColors = 5) => {
    return new Promise((resolve) => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const size = 64;
        canvas.width = size;
        canvas.height = size;

        const processImage = (img) => {
            try {
                ctx.drawImage(img, 0, 0, size, size);
                const data = ctx.getImageData(0, 0, size, size).data;
                const buckets = new Map();

                for (let i = 0; i < data.length; i += 16) { // sample every 4th pixel
                    const r = data[i];
                    const g = data[i + 1];
                    const b = data[i + 2];
                    const a = data[i + 3];
                    if (a < 128) continue;

                    // Skip greyish colors if possible
                    const max = Math.max(r, g, b);
                    const min = Math.min(r, g, b);
                    if (max - min < 30) continue; 

                    const key = `${Math.round(r/16)*16},${Math.round(g/16)*16},${Math.round(b/16)*16}`;
                    buckets.set(key, (buckets.get(key) || 0) + 1);
                }

                let sorted = [...buckets.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .map(([key]) => {
                        const [r, g, b] = key.split(',').map(Number);
                        return { r, g, b };
                    });

                // If we didn't get enough vibrant colors, include the ones we skipped
                if (sorted.length < numColors) {
                    for (let i = 0; i < data.length; i += 32) {
                        const r = data[i];
                        const g = data[i+1];
                        const b = data[i+2];
                        const key = `${Math.round(r/16)*16},${Math.round(g/16)*16},${Math.round(b/16)*16}`;
                        if (!buckets.has(key)) {
                            sorted.push({r, g, b});
                            buckets.set(key, 1);
                        }
                        if (sorted.length >= numColors * 2) break;
                    }
                }

                // Filter out colors too close to each other and too dark/bright
                const filtered = [];
                for (const color of sorted) {
                    const brightness = (color.r * 299 + color.g * 587 + color.b * 114) / 1000;
                    if (brightness < 20 || brightness > 230) continue;

                    const tooClose = filtered.some((existing) => {
                        const dr = existing.r - color.r;
                        const dg = existing.g - color.g;
                        const db = existing.b - color.b;
                        return Math.sqrt(dr * dr + dg * dg + db * db) < 50;
                    });

                    if (!tooClose) {
                        filtered.push(color);
                        if (filtered.length >= numColors) break;
                    }
                }

                // Fallback colors if extraction yields too few
                while (filtered.length < numColors) {
                    filtered.push({ r: 40 + filtered.length * 30, g: 20 + filtered.length * 15, b: 60 + filtered.length * 20 });
                }

                resolve(filtered);
            } catch (error) {
                console.warn('[AMLL] Color extraction failed:', error);
                resolve([
                    { r: 120, g: 40, b: 80 },
                    { r: 60, g: 30, b: 90 },
                    { r: 150, g: 60, b: 50 },
                    { r: 80, g: 50, b: 120 },
                    { r: 40, g: 70, b: 100 },
                ]);
            }
        };

        if (imageSource instanceof HTMLVideoElement) {
            processImage(imageSource);
        } else if (imageSource instanceof HTMLImageElement) {
            if (imageSource.complete) {
                processImage(imageSource);
            } else {
                imageSource.onload = () => processImage(imageSource);
                imageSource.onerror = () => resolve([
                    { r: 120, g: 40, b: 80 },
                    { r: 60, g: 30, b: 90 },
                    { r: 150, g: 60, b: 50 },
                    { r: 80, g: 50, b: 120 },
                    { r: 40, g: 70, b: 100 },
                ]);
            }
        } else {
            resolve([
                { r: 120, g: 40, b: 80 },
                { r: 60, g: 30, b: 90 },
                { r: 150, g: 60, b: 50 },
                { r: 80, g: 50, b: 120 },
                { r: 40, g: 70, b: 100 },
            ]);
        }
    });
};

const rgbToString = (c, alpha = 1) => `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`;

const saturateColor = (c, factor = 1.3) => {
    const avg = (c.r + c.g + c.b) / 3;
    return {
        r: Math.min(255, Math.round(avg + (c.r - avg) * factor)),
        g: Math.min(255, Math.round(avg + (c.g - avg) * factor)),
        b: Math.min(255, Math.round(avg + (c.b - avg) * factor)),
    };
};


// ── Mesh Gradient Background ───────────────────────────────

class MeshGradientBackground {
    constructor(container) {
        this.container = container;
        this.canvas = document.createElement('canvas');
        this.ctx = this.canvas.getContext('2d');
        this.canvas.className = 'amll-bg-canvas';
        this.container.appendChild(this.canvas);

        this.colors = [];
        this.blobs = [];
        this.animationId = null;
        this.isPlaying = false;
        this.lastTime = 0;

        this._resize = this._resize.bind(this);
        this._animate = this._animate.bind(this);
        window.addEventListener('resize', this._resize);
        this._resize();
    }

    _resize() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const rect = this.container.getBoundingClientRect();
        this.canvas.width = rect.width * dpr * 0.5; // render at half res for performance + blur
        this.canvas.height = rect.height * dpr * 0.5;
        this.canvas.style.width = rect.width + 'px';
        this.canvas.style.height = rect.height + 'px';
        this.width = this.canvas.width;
        this.height = this.canvas.height;
    }

    setColors(colors) {
        this.colors = colors;
        this.blobs = [];
        
        // Add more blobs for a richer fluid effect
        const numBlobs = Math.max(8, colors.length * 2);
        for (let i = 0; i < numBlobs; i++) {
            const color = colors[i % colors.length];
            this.blobs.push({
                x: Math.random(),
                y: Math.random(),
                radius: 0.3 + Math.random() * 0.4,
                color: saturateColor(color, 1.4),
                vx: (Math.random() - 0.5) * 0.0004,
                vy: (Math.random() - 0.5) * 0.0004,
                phase: Math.random() * Math.PI * 2,
                speed: 0.0001 + Math.random() * 0.0002,
                baseRadius: 0.3 + Math.random() * 0.4
            });
        }
        this._draw();
    }

    _draw() {
        if (!this.ctx || !this.width || !this.height) return;
        const { ctx, width, height } = this;

        // Dark base
        ctx.fillStyle = '#050505';
        ctx.fillRect(0, 0, width, height);

        // Use lighter blend mode for more vibrant fluid effect
        ctx.globalCompositeOperation = 'screen';

        for (const blob of this.blobs) {
            const x = blob.x * width;
            const y = blob.y * height;
            const r = blob.radius * Math.min(width, height);

            const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
            gradient.addColorStop(0, rgbToString(blob.color, 0.6));
            gradient.addColorStop(0.4, rgbToString(blob.color, 0.25));
            gradient.addColorStop(1, rgbToString(blob.color, 0));

            ctx.fillStyle = gradient;
            ctx.fillRect(0, 0, width, height);
        }

        ctx.globalCompositeOperation = 'source-over';
    }

    _animate(timestamp) {
        if (!this.isPlaying) return;

        const delta = timestamp - this.lastTime;
        if (delta < 16) { // target 60fps for background if possible
            this.animationId = requestAnimationFrame(this._animate);
            return;
        }
        this.lastTime = timestamp;

        for (const blob of this.blobs) {
            blob.phase += blob.speed * delta;
            
            // Smoother movement
            blob.x += blob.vx * delta + Math.sin(blob.phase) * 0.00015 * delta;
            blob.y += blob.vy * delta + Math.cos(blob.phase * 0.8) * 0.00015 * delta;
            
            // Subtle radius pulse
            blob.radius = blob.baseRadius + Math.sin(blob.phase * 0.5) * 0.05;

            // Bounce with soft edges
            if (blob.x < -0.3) { blob.x = -0.3; blob.vx = Math.abs(blob.vx); }
            if (blob.x > 1.3) { blob.x = 1.3; blob.vx = -Math.abs(blob.vx); }
            if (blob.y < -0.3) { blob.y = -0.3; blob.vy = Math.abs(blob.vy); }
            if (blob.y > 1.3) { blob.y = 1.3; blob.vy = -Math.abs(blob.vy); }
        }

        this._draw();
        this.animationId = requestAnimationFrame(this._animate);
    }

    play() {
        if (this.isPlaying) return;
        this.isPlaying = true;
        this.lastTime = performance.now();
        this.animationId = requestAnimationFrame(this._animate);
    }

    pause() {
        this.isPlaying = false;
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }

    dispose() {
        this.pause();
        window.removeEventListener('resize', this._resize);
        if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    }
}

// ── AMLL Manager (Public API) ──────────────────────────────

export class AMLLManager {
    constructor() {
        this.overlay = null;
        this.bgContainer = null;
        this.content = null;
        this.leftPanel = null;
        this.rightPanel = null;
        this.coverContainer = null;
        this.lyricsContainer = null;
        this.metaContainer = null;
        this.qrContainer = null;

        this.background = null;
        this.lyrics = null;
        this.isVisible = false;
        this.isPlaying = false;
        this.currentTime = 0;
        this.coverImg = null;
        this.seekHandler = null;
        this.lineContextMenuHandler = null;
        this.bottomInfo = null;
        this.currentLyricsData = null;
        this.localeStrings = {
            songwriterLabel: 'Songwriter:',
        };
        this.resizeObserver = null;
        this.layoutFrame = 0;
    }

    init(appEl) {
        if (this.overlay) return;

        // Create overlay structure
        this.overlay = document.createElement('div');
        this.overlay.id = 'amll-overlay';
        this.overlay.className = 'amll-overlay amll-shell amll-paused';

        // Background layer
        this.bgContainer = document.createElement('div');
        this.bgContainer.className = 'amll-bg';
        this.overlay.appendChild(this.bgContainer);

        // Content layer
        this.content = document.createElement('div');
        this.content.className = 'amll-content amll-shell-layout';
        this.overlay.appendChild(this.content);

        // Left panel (cover)
        this.leftPanel = document.createElement('div');
        this.leftPanel.className = 'amll-left-panel';
        this.content.appendChild(this.leftPanel);

        this.coverContainer = document.createElement('div');
        this.coverContainer.className = 'amll-cover-wrapper';
        this.leftPanel.appendChild(this.coverContainer);

        this.coverImg = document.createElement('canvas');
        this.coverImg.className = 'amll-cover-img';
        this.coverImg.width = 400;
        this.coverImg.height = 400;
        this.coverContainer.appendChild(this.coverImg);

        this.metaContainer = document.createElement('div');
        this.metaContainer.className = 'amll-meta';
        this.leftPanel.appendChild(this.metaContainer);

        // QR code – repositioned bottom-left
        this.qrContainer = document.createElement('div');
        this.qrContainer.className = 'amll-qr-corner';
        this.leftPanel.appendChild(this.qrContainer);

        // Right panel (lyrics)
        this.rightPanel = document.createElement('div');
        this.rightPanel.className = 'amll-right-panel';
        this.content.appendChild(this.rightPanel);

        this.lyricsContainer = document.createElement('div');
        this.lyricsContainer.className = 'amll-lyrics-container';
        this.rightPanel.appendChild(this.lyricsContainer);

        appEl.appendChild(this.overlay);

        // Initialize sub-components now that elements are in the DOM and have bounds
        this.background = new MeshGradientBackground(this.bgContainer);
        this.lyrics = new AMLLLyricPlayer(this.lyricsContainer);
        this.lyrics.setWordFadeWidth(0.5);
        this.lyrics.setEnableSpring(true);
        this.lyrics.setEnableBlur(true);
        this.lyrics.setEnableScale(true);
        this.lyrics.setHidePassedLines(false);
        this.bottomInfo = document.createElement('div');
        this.bottomInfo.className = 'amll-bottom-info';
        this.lyrics.getBottomLineElement().appendChild(this.bottomInfo);
        this.lyricsContainer.addEventListener('amll-line-click', (event) => {
            const line = event.detail?.line;
            if (!line || !this.seekHandler) return;
            this.seekHandler(line.startTime / 1000);
        });
        this.lyricsContainer.addEventListener('amll-line-contextmenu', (event) => {
            if (!this.lineContextMenuHandler) return;
            this.lineContextMenuHandler(event.detail);
        });

        this.resizeObserver = new ResizeObserver(() => {
            this.scheduleLayoutUpdate();
        });
        this.resizeObserver.observe(this.overlay);
        this.resizeObserver.observe(this.coverContainer);
        this.resizeObserver.observe(this.rightPanel);
        this.scheduleLayoutUpdate();
    }

    setSeekHandler(handler) {
        this.seekHandler = typeof handler === 'function' ? handler : null;
    }

    setLineContextMenuHandler(handler) {
        this.lineContextMenuHandler = typeof handler === 'function' ? handler : null;
    }

    setLocaleStrings(strings = {}) {
        this.localeStrings = {
            ...this.localeStrings,
            ...strings,
        };
        if (this.currentLyricsData) {
            this.setBottomInfo(this.buildBottomInfo(this.currentLyricsData));
        }
    }

    scheduleLayoutUpdate() {
        if (this.layoutFrame) return;
        this.layoutFrame = requestAnimationFrame(() => {
            this.layoutFrame = 0;
            this.updateLayout();
        });
    }

    updateLayout() {
        if (!this.content || !this.coverContainer || !this.rightPanel || !this.lyrics) return;

        const contentRect = this.content.getBoundingClientRect();
        if (!contentRect.width || !contentRect.height) return;

        const isVertical = contentRect.width < contentRect.height;
        this.content.classList.toggle('amll-vertical', isVertical);
        this.content.classList.toggle('amll-horizontal', !isVertical);

        this.lyrics.setWordFadeWidth(0.5);
        this.lyrics.setEnableSpring(true);
        this.lyrics.setEnableBlur(true);
        this.lyrics.setEnableScale(true);
        this.lyrics.setHidePassedLines(false);

        if (isVertical) {
            this.lyrics.setAlignAnchor('top');
            this.lyrics.setAlignPosition(0.1);
            return;
        }

        const coverRect = this.coverContainer.getBoundingClientRect();
        const lyricRect = this.rightPanel.getBoundingClientRect();
        if (!lyricRect.height) return;

        const coverCenter = coverRect.top + coverRect.height / 2;
        const relativeCenter = (coverCenter - lyricRect.top) / lyricRect.height;
        const alignPosition = Math.max(0, Math.min(1, relativeCenter));
        this.lyrics.setAlignAnchor('center');
        this.lyrics.setAlignPosition(alignPosition);
    }

    async setAlbumArt(videoElement, picUrl) {
        if (!videoElement) return;

        try {
            const ctx = this.coverImg.getContext('2d');
            const size = 400;
            const drawSource = (source) => {
                ctx.clearRect(0, 0, size, size);
                ctx.drawImage(source, 0, 0, size, size);
            };
            const drawFallback = () => {
                try {
                    drawSource(videoElement);
                } catch (e) {
                    ctx.fillStyle = '#000';
                    ctx.fillRect(0, 0, size, size);
                }
            };

            let extractSource = videoElement;
            if (picUrl) {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                const imageReady = new Promise((resolve, reject) => {
                    img.onload = () => resolve(img);
                    img.onerror = reject;
                });
                img.src = picUrl;
                try {
                    await imageReady;
                    drawSource(img);
                    extractSource = img;
                } catch (e) {
                    drawFallback();
                }
            } else {
                drawFallback();
                if (videoElement.readyState < 2) {
                    videoElement.addEventListener('loadeddata', () => {
                        this.refreshCover(videoElement);
                    }, { once: true });
                }
            }

            const colors = await extractDominantColors(extractSource);
            this.background.setColors(colors);
            this.scheduleLayoutUpdate();
        } catch (error) {
            console.warn('[AMLL] Failed to set album art:', error);
        }
    }

    refreshCover(videoElement) {
        if (!videoElement || !this.coverImg) return;
        try {
            const ctx = this.coverImg.getContext('2d');
            ctx.drawImage(videoElement, 0, 0, 400, 400);
            this.scheduleLayoutUpdate();
        } catch (e) {
            // ignore cross-origin
        }
    }

    setMeta(title, artist, requester) {
        if (!this.metaContainer) return;
        this.metaContainer.innerHTML = `
            <div class="amll-meta-title">${this._escapeHtml(title || '')}</div>
            <div class="amll-meta-artist">${this._escapeHtml(artist || '')}</div>
        `;
        this.scheduleLayoutUpdate();
    }

    setBottomInfo(content = '') {
        if (!this.bottomInfo) return;
        this.bottomInfo.innerHTML = content || '';
        this.scheduleLayoutUpdate();
    }

    setLyrics(lyricsData) {
        if (!this.lyrics) return;
        this.currentLyricsData = lyricsData;
        this.lyrics.setLines(lyricsData);
        this.lyrics.seek(this.currentTime);
        this.lyrics.setPlaying(this.isPlaying);
        this.setBottomInfo(this.buildBottomInfo(lyricsData));
        this.scheduleLayoutUpdate();
    }

    setCurrentTime(seconds) {
        this.currentTime = seconds;
        if (!this.lyrics) return;
        this.lyrics.setCurrentTime(seconds);
    }

    seek(seconds) {
        this.currentTime = seconds;
        if (!this.lyrics) return;
        this.lyrics.seek(seconds);
    }

    setPlaying(playing) {
        this.isPlaying = playing;
        if (this.lyrics) this.lyrics.setPlaying(playing);
        if (this.background) {
            if (playing) this.background.play();
            else this.background.pause();
        }
        if (this.overlay) {
            this.overlay.classList.toggle('amll-paused', !playing);
        }
    }

    show() {
        if (this.isVisible) return;
        this.isVisible = true;
        if (this.overlay) {
            this.overlay.classList.add('amll-visible');
        }
        document.body.dataset.amllLyricsOpen = '';
        this.scheduleLayoutUpdate();
    }

    hide() {
        if (!this.isVisible) return;
        this.isVisible = false;
        if (this.overlay) {
            this.overlay.classList.remove('amll-visible');
        }
        if (this.lyrics) this.lyrics.setPlaying(false);
        if (this.background) this.background.pause();
        delete document.body.dataset.amllLyricsOpen;
    }

    moveQRCode(qrElement) {
        if (!this.qrContainer || !qrElement) return;
        // Clone the QR content
        this.qrContainer.innerHTML = '';
        const clone = qrElement.cloneNode(true);
        clone.style.width = '100px';
        clone.style.height = '100px';
        // Scale inner images
        const imgs = clone.querySelectorAll('img, canvas');
        for (const img of imgs) {
            img.style.width = '100px';
            img.style.height = '100px';
        }
        this.qrContainer.appendChild(clone);
        this.scheduleLayoutUpdate();
    }

    dispose() {
        this.hide();
        if (this.background) this.background.dispose();
        if (this.lyrics) this.lyrics.dispose();
        if (this.resizeObserver) this.resizeObserver.disconnect();
        if (this.layoutFrame) {
            cancelAnimationFrame(this.layoutFrame);
            this.layoutFrame = 0;
        }
        if (this.overlay && this.overlay.parentNode) {
            this.overlay.parentNode.removeChild(this.overlay);
        }
        this.overlay = null;
        this.background = null;
        this.lyrics = null;
        this.resizeObserver = null;
        this.currentLyricsData = null;
    }

    _escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    buildBottomInfo(lyricsData) {
        const songwriters = lyricsData?.metadata?.songwriters;
        if (!Array.isArray(songwriters) || songwriters.length === 0) return '';
        const names = songwriters
            .map((name) => this._escapeHtml(String(name || '').trim()))
            .filter((name) => name.length > 0);
        if (names.length === 0) return '';
        const label = this._escapeHtml(this.localeStrings.songwriterLabel || 'Songwriter:');
        return `<strong>${label}</strong>${names.join(', ')}`;
    }
}
