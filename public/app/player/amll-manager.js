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

const darkenColor = (c, factor = 0.4) => ({
    r: Math.round(c.r * factor),
    g: Math.round(c.g * factor),
    b: Math.round(c.b * factor),
});

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


// ── Apple Music-style Lyrics Renderer ──────────────────────

class AppleMusicLyrics {
    constructor(container) {
        this.container = container;
        this.lines = [];
        this.lineElements = [];
        this.currentLineIndex = -1;
        this.currentTime = 0;
        this.isPlaying = false;
        this.targetScrollTop = 0;
        this.currentScrollTop = 0;
        this.scrollVelocity = 0;
        this.lastFrameTime = performance.now();

        this.header = document.createElement('div');
        this.header.className = 'amll-lyrics-header';
        this.container.appendChild(this.header);

        this.sectionIndicator = document.createElement('div');
        this.sectionIndicator.className = 'amll-section-indicator';
        this.header.appendChild(this.sectionIndicator);

        this.agentIndicator = document.createElement('div');
        this.agentIndicator.className = 'amll-agent-indicator';
        this.header.appendChild(this.agentIndicator);

        this.scrollContainer = document.createElement('div');
        this.scrollContainer.className = 'amll-lyrics-scroll';
        this.container.appendChild(this.scrollContainer);

        this.innerContainer = document.createElement('div');
        this.innerContainer.className = 'amll-lyrics-inner';
        this.scrollContainer.appendChild(this.innerContainer);
    }

    setLines(lyricsData) {
        this.lines = [];
        this.lineElements = [];
        this.currentLineIndex = -1;
        this.innerContainer.innerHTML = '';
        this.targetScrollTop = 0;
        this.currentScrollTop = 0;
        this.scrollVelocity = 0;
        this.lastFrameTime = performance.now();
        this.scrollContainer.scrollTop = 0;
        this.container.classList.remove('amll-has-duet-lines');
        this._updateIndicators(null);

        if (!lyricsData || !lyricsData.found || !Array.isArray(lyricsData.lines) || lyricsData.lines.length === 0) {
            return;
        }

        // Add top spacer for centering first line
        const topSpacer = document.createElement('div');
        topSpacer.className = 'amll-lyrics-spacer';
        this.innerContainer.appendChild(topSpacer);

        let lastEndTime = 0;
        for (let i = 0; i < lyricsData.lines.length; i++) {
            const line = lyricsData.lines[i];
            
            // Insert instrumental indicator if there's a large gap (> 5 seconds)
            if (line.start - lastEndTime > 5) {
                const instEl = document.createElement('div');
                instEl.className = 'amll-lyrics-line amll-instrumental';
                instEl.dataset.start = lastEndTime;
                instEl.dataset.end = line.start;
                
                const dotContainer = document.createElement('div');
                dotContainer.className = 'amll-instrumental-dots';
                for (let j = 0; j < 3; j++) {
                    const dot = document.createElement('span');
                    dot.className = 'amll-instrumental-dot';
                    dotContainer.appendChild(dot);
                }
                instEl.appendChild(dotContainer);
                
                this.innerContainer.appendChild(instEl);
                this.lineElements.push(instEl);
                this.lines.push({
                    start: lastEndTime,
                    end: line.start,
                    isInstrumental: true
                });
            }

            const lineData = {
                id: line.id,
                start: line.start,
                end: line.end,
                text: line.text || '',
                words: Array.isArray(line.words) ? line.words : null,
                backgroundText: line.backgroundText || '',
                backgroundWords: Array.isArray(line.backgroundWords) ? line.backgroundWords : null,
                translations: Array.isArray(line.translations) ? line.translations : [],
                romanizations: Array.isArray(line.romanizations) ? line.romanizations : [],
                section: line.section || '',
                agent: line.agent || '',
                agentName: line.agentName || '',
                oppositeTurn: !!line.oppositeTurn,
            };
            this.lines.push(lineData);

            const el = document.createElement('div');
            el.className = 'amll-lyrics-line';
            el.dataset.lineId = line.id;
            if (lineData.oppositeTurn) {
                el.classList.add('amll-opposite-turn');
                this.container.classList.add('amll-has-duet-lines');
            }

            // 1. Background lyrics (Interlaced)
            if (lineData.backgroundText || (lineData.backgroundWords && lineData.backgroundWords.length > 0)) {
                el.classList.add('amll-has-background');
                const bgEl = document.createElement('div');
                bgEl.className = 'amll-line-bg';
                this._renderWordTrack(bgEl, lineData.backgroundWords, lineData.backgroundText, 'amll-bg-word');
                el.appendChild(bgEl);
            }

            // 2. Main lyrics
            const mainEl = document.createElement('div');
            mainEl.className = 'amll-line-main';
            this._renderWordTrack(mainEl, lineData.words, lineData.text, 'amll-word');
            el.appendChild(mainEl);

            // 3. Romanizations
            if (lineData.romanizations.length > 0) {
                el.classList.add('amll-has-romanization');
                for (const rom of lineData.romanizations) {
                    const romEl = document.createElement('div');
                    romEl.className = 'amll-line-romanization';
                    this._renderWordTrack(romEl, rom.words, rom.text, 'amll-rom-word');
                    el.appendChild(romEl);
                }
            }

            // 4. Translations
            if (lineData.translations.length > 0) {
                el.classList.add('amll-has-translation');
                for (const trans of lineData.translations) {
                    const transEl = document.createElement('div');
                    transEl.className = 'amll-line-translation';
                    this._renderWordTrack(transEl, trans.words, trans.text, 'amll-trans-word');
                    el.appendChild(transEl);
                }
            }

            this.innerContainer.appendChild(el);
            this.lineElements.push(el);
            lastEndTime = line.end;
        }

        // Add bottom spacer
        const bottomSpacer = document.createElement('div');
        bottomSpacer.className = 'amll-lyrics-spacer';
        this.innerContainer.appendChild(bottomSpacer);
    }

    setCurrentTime(timeInSeconds) {
        this.currentTime = timeInSeconds;
        this._updateActiveState();
    }

    setPlaying(playing) {
        this.isPlaying = playing;
    }

    _renderWordTrack(container, words, text, wordClassName) {
        if (Array.isArray(words) && words.length > 0) {
            container.classList.add('amll-lyrics-line-words');
            for (const word of words) {
                const shellEl = document.createElement('span');
                shellEl.className = wordClassName;
                shellEl.dataset.start = word.start;
                shellEl.dataset.end = word.end;
                shellEl.style.setProperty('--word-progress', '0');

                const baseEl = document.createElement('span');
                baseEl.className = `${wordClassName}-base`;
                baseEl.textContent = word.text;
                shellEl.appendChild(baseEl);

                const fillWrapEl = document.createElement('span');
                fillWrapEl.className = `${wordClassName}-fill-wrap`;
                const fillEl = document.createElement('span');
                fillEl.className = `${wordClassName}-fill`;
                fillEl.textContent = word.text;
                fillWrapEl.appendChild(fillEl);
                shellEl.appendChild(fillWrapEl);

                container.appendChild(shellEl);
            }
            return;
        }
        container.textContent = text || '';
    }

    _syncWordState(wordEls, words, timeInSeconds) {
        for (let index = 0; index < wordEls.length; index++) {
            const word = words[index];
            const wordEl = wordEls[index];
            if (!word || !wordEl) continue;

            if (timeInSeconds >= word.end) {
                wordEl.classList.add('amll-word-sung');
                wordEl.classList.remove('amll-word-singing', 'amll-word-upcoming');
                wordEl.style.setProperty('--word-progress', '1');
            } else if (timeInSeconds >= word.start) {
                wordEl.classList.add('amll-word-singing');
                wordEl.classList.remove('amll-word-sung', 'amll-word-upcoming');
                const progress = Math.min(1, (timeInSeconds - word.start) / Math.max(0.001, word.end - word.start));
                wordEl.style.setProperty('--word-progress', progress.toFixed(3));
            } else {
                wordEl.classList.add('amll-word-upcoming');
                wordEl.classList.remove('amll-word-sung', 'amll-word-singing');
                wordEl.style.setProperty('--word-progress', '0');
            }
        }
    }

    _updateIndicators(line) {
        const section = line && line.section ? line.section : '';
        const agent = line && line.agentName ? line.agentName : '';
        this.sectionIndicator.textContent = section;
        this.sectionIndicator.classList.toggle('is-visible', !!section);
        this.agentIndicator.textContent = agent;
        this.agentIndicator.classList.toggle('is-visible', !!agent);
    }

    _stepScrollSpring() {
        const now = performance.now();
        const delta = Math.min(0.05, Math.max(0.001, (now - this.lastFrameTime) / 1000));
        this.lastFrameTime = now;

        const stiffness = 240;
        const damping = 28;
        const displacement = this.targetScrollTop - this.currentScrollTop;
        const acceleration = (displacement * stiffness) - (this.scrollVelocity * damping);

        this.scrollVelocity += acceleration * delta;
        this.currentScrollTop += this.scrollVelocity * delta;

        if (Math.abs(displacement) < 0.5 && Math.abs(this.scrollVelocity) < 1) {
            this.currentScrollTop = this.targetScrollTop;
            this.scrollVelocity = 0;
        }

        this.scrollContainer.scrollTop = this.currentScrollTop;
    }

    _updateActiveState() {
        const t = this.currentTime;
        const activeIndices = [];

        // Find all active lines (supporting overlaps)
        for (let i = 0; i < this.lines.length; i++) {
            if (t >= this.lines[i].start && t < this.lines[i].end) {
                activeIndices.push(i);
            }
        }

        // If no active line, find the last passed one for reference
        let referenceIndex = activeIndices.length > 0 ? activeIndices[0] : -1;
        if (referenceIndex === -1) {
            for (let i = this.lines.length - 1; i >= 0; i--) {
                if (t >= this.lines[i].end) {
                    referenceIndex = i;
                    break;
                }
            }
        }

        // Update class states for each line
        for (let i = 0; i < this.lineElements.length; i++) {
            const el = this.lineElements[i];
            const line = this.lines[i];
            const isActive = activeIndices.includes(i);
            const isPassed = i < (activeIndices.length > 0 ? activeIndices[0] : (referenceIndex + 1)) && !isActive;
            const isUpcoming = i > (activeIndices.length > 0 ? activeIndices[activeIndices.length - 1] : referenceIndex) && !isActive;
            
            // Calculate distance for blur effect
            let distance = 0;
            if (!isActive) {
                if (activeIndices.length > 0) {
                    distance = Math.min(...activeIndices.map(idx => Math.abs(i - idx)));
                } else {
                    distance = Math.abs(i - referenceIndex);
                }
            }

            const mainWords = el.querySelectorAll('.amll-word');
            const bgWords = el.querySelectorAll('.amll-bg-word');
            const romWords = el.querySelectorAll('.amll-rom-word');
            const transWords = el.querySelectorAll('.amll-trans-word');

            el.classList.toggle('amll-active', isActive);
            el.classList.toggle('amll-passed', isPassed);
            el.classList.toggle('amll-upcoming', isUpcoming);

            // Progressive blur for distance
            if (isActive) {
                el.style.filter = 'blur(0px)';
                el.style.opacity = '1';
                el.style.transform = 'scale(1.02)'; // Slightly larger active line
            } else if (distance <= 1) {
                el.style.filter = 'blur(0px)';
                el.style.opacity = isPassed ? '0.3' : '0.45';
                el.style.transform = 'scale(0.96)';
            } else if (distance <= 2) {
                el.style.filter = 'blur(1.5px)';
                el.style.opacity = '0.25';
                el.style.transform = 'scale(0.92)';
            } else if (distance <= 3) {
                el.style.filter = 'blur(3px)';
                el.style.opacity = '0.15';
                el.style.transform = 'scale(0.88)';
            } else {
                el.style.filter = `blur(${Math.min(6, distance * 1.5)}px)`;
                el.style.opacity = '0.08';
                el.style.transform = 'scale(0.85)';
            }

            // Sync words for all lines to ensure correct state (sung/upcoming)
            // even when lines are not active.
            if (line.words && line.words.length > 0) {
                this._syncWordState(mainWords, line.words, t);
            }
            if (line.backgroundWords && line.backgroundWords.length > 0) {
                this._syncWordState(bgWords, line.backgroundWords, t);
            }

            // Sync auxiliary word states if they have word timings
            if (line.romanizations && line.romanizations.length > 0) {
                let romWordIndex = 0;
                for (const rom of line.romanizations) {
                    if (rom.words && rom.words.length > 0) {
                        const wordsToSync = Array.from(romWords).slice(romWordIndex, romWordIndex + rom.words.length);
                        this._syncWordState(wordsToSync, rom.words, t);
                        romWordIndex += rom.words.length;
                    }
                }
            }
            if (line.translations && line.translations.length > 0) {
                let transWordIndex = 0;
                for (const trans of line.translations) {
                    if (trans.words && trans.words.length > 0) {
                        const wordsToSync = Array.from(transWords).slice(transWordIndex, transWordIndex + trans.words.length);
                        this._syncWordState(wordsToSync, trans.words, t);
                        transWordIndex += trans.words.length;
                    }
                }
            }
        }

        const primaryActiveIndex = activeIndices.length > 0 ? activeIndices[0] : -1;
        this._updateIndicators(primaryActiveIndex >= 0 ? this.lines[primaryActiveIndex] : null);

        // Scroll active line into center
        if (primaryActiveIndex !== this.currentLineIndex && primaryActiveIndex >= 0) {
            this.currentLineIndex = primaryActiveIndex;
            this._scrollToLine(primaryActiveIndex);
        }
        this._stepScrollSpring();
    }

    _scrollToLine(index) {
        const el = this.lineElements[index];
        if (!el) return;

        // Use offsetTop to compute absolute layout position (ignores CSS transforms and ongoing smooth scrolls)
        let offsetTop = el.offsetTop;
        let offsetParent = el.offsetParent;

        // Traverse up to scrollContainer in case of nested positioning
        while (offsetParent && offsetParent !== this.scrollContainer && this.scrollContainer.contains(offsetParent)) {
            offsetTop += offsetParent.offsetTop;
            offsetParent = offsetParent.offsetParent;
        }

        const targetCenter = this.scrollContainer.clientHeight * 0.35;
        this.targetScrollTop = Math.max(0, offsetTop + (el.offsetHeight / 2) - targetCenter);
    }

    dispose() {
        this.innerContainer.innerHTML = '';
        if (this.scrollContainer.parentNode) {
            this.scrollContainer.parentNode.removeChild(this.scrollContainer);
        }
    }
}


// ── AMLL Manager (Public API) ──────────────────────────────

export class AMLLManager {
    constructor() {
        this.overlay = null;
        this.bgContainer = null;
        this.coverContainer = null;
        this.lyricsContainer = null;
        this.metaContainer = null;
        this.qrContainer = null;

        this.background = null;
        this.lyrics = null;
        this.isVisible = false;
        this.isPlaying = false;
        this.coverImg = null;
        this.animFrameId = null;
        this._artRef = null;
    }

    init(appEl) {
        if (this.overlay) return;

        // Create overlay structure
        this.overlay = document.createElement('div');
        this.overlay.id = 'amll-overlay';
        this.overlay.className = 'amll-overlay';

        // Background layer
        this.bgContainer = document.createElement('div');
        this.bgContainer.className = 'amll-bg';
        this.overlay.appendChild(this.bgContainer);

        // Content layer
        const content = document.createElement('div');
        content.className = 'amll-content';
        this.overlay.appendChild(content);

        // Left panel (cover)
        const leftPanel = document.createElement('div');
        leftPanel.className = 'amll-left-panel';
        content.appendChild(leftPanel);

        this.coverContainer = document.createElement('div');
        this.coverContainer.className = 'amll-cover-wrapper';
        leftPanel.appendChild(this.coverContainer);

        this.coverImg = document.createElement('canvas');
        this.coverImg.className = 'amll-cover-img';
        this.coverImg.width = 400;
        this.coverImg.height = 400;
        this.coverContainer.appendChild(this.coverImg);

        this.metaContainer = document.createElement('div');
        this.metaContainer.className = 'amll-meta';
        leftPanel.appendChild(this.metaContainer);

        // QR code – repositioned bottom-left
        this.qrContainer = document.createElement('div');
        this.qrContainer.className = 'amll-qr-corner';
        leftPanel.appendChild(this.qrContainer);

        // Right panel (lyrics)
        const rightPanel = document.createElement('div');
        rightPanel.className = 'amll-right-panel';
        content.appendChild(rightPanel);

        this.lyricsContainer = document.createElement('div');
        this.lyricsContainer.className = 'amll-lyrics-container';
        rightPanel.appendChild(this.lyricsContainer);

        appEl.appendChild(this.overlay);

        // Initialize sub-components now that elements are in the DOM and have bounds
        this.background = new MeshGradientBackground(this.bgContainer);
        this.lyrics = new AMLLLyricPlayer(this.lyricsContainer);
    }

    async setAlbumArt(videoElement, picUrl) {
        if (!videoElement) return;

        // Draw the video frame to the cover canvas
        try {
            const ctx = this.coverImg.getContext('2d');
            const size = 400;

            // Try to draw from video - for YT Music this is a static album cover
            const drawCover = () => {
                try {
                    ctx.drawImage(videoElement, 0, 0, size, size);
                } catch (e) {
                    // cross-origin or not ready
                    ctx.fillStyle = '#1a1a2e';
                    ctx.fillRect(0, 0, size, size);
                }
            };

            if (videoElement.readyState >= 2) {
                drawCover();
            } else {
                videoElement.addEventListener('loadeddata', drawCover, { once: true });
            }

            // Extract colors from picUrl or video
            let extractSource = videoElement;
            if (picUrl) {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.src = picUrl;
                extractSource = img;
            }
            const colors = await extractDominantColors(extractSource);
            this.background.setColors(colors);
        } catch (error) {
            console.warn('[AMLL] Failed to set album art:', error);
        }
    }

    refreshCover(videoElement) {
        if (!videoElement || !this.coverImg) return;
        try {
            const ctx = this.coverImg.getContext('2d');
            ctx.drawImage(videoElement, 0, 0, 400, 400);
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
    }

    setLyrics(lyricsData) {
        if (!this.lyrics) return;
        this.lyrics.setLines(lyricsData);
    }

    setCurrentTime(seconds) {
        if (!this.lyrics) return;
        this.lyrics.setCurrentTime(seconds);
    }

    seek(seconds) {
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
    }

    hide() {
        if (!this.isVisible) return;
        this.isVisible = false;
        if (this.overlay) {
            this.overlay.classList.remove('amll-visible');
        }
        if (this.lyrics) this.lyrics.setPlaying(false);
        if (this.background) this.background.pause();
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
    }

    dispose() {
        this.hide();
        if (this.background) this.background.dispose();
        if (this.lyrics) this.lyrics.dispose();
        if (this.overlay && this.overlay.parentNode) {
            this.overlay.parentNode.removeChild(this.overlay);
        }
        this.overlay = null;
        this.background = null;
        this.lyrics = null;
    }

    _escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}
