class PitchProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.bufferSize = 8192; // Large buffer for smooth grains
        // Separate buffers for stereo
        this.bufferL = new Float32Array(this.bufferSize);
        this.bufferR = new Float32Array(this.bufferSize);
        this.writePos = 0;

        // Grain state
        this.phase = 0;
        this.grainSize = 2048; // ~46ms at 44.1kHz - good balance for vocals
        this.window = new Float32Array(this.grainSize);

        // Pre-calculate Hanning window for smoother overlap (eliminates "triangle" modulation)
        for (let i = 0; i < this.grainSize; i++) {
            // 0.5 * (1 - cos(2*PI*i/N))
            this.window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (this.grainSize - 1)));
        }
    }

    static get parameterDescriptors() {
        return [{
            name: 'pitch',
            defaultValue: 0,
            minValue: -12,
            maxValue: 12,
            automationRate: "k-rate"
        }];
    }

    // Cubic Hermite Interpolation for high-quality resampling (eliminates "electric/metallic" aliasing)
    // p0: y[n-1], p1: y[n], p2: y[n+1], p3: y[n+2]
    // t: fractional part (0.0 - 1.0)
    cubicHermite(p0, p1, p2, p3, t) {
        const a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
        const b = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3;
        const c = -0.5 * p0 + 0.5 * p2;
        const d = p1;

        return a * t * t * t + b * t * t + c * t + d;
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];
        const pitch = parameters.pitch[0];

        // If no input, silence
        if (!input || !input.length) return true;

        const inputL = input[0];
        const inputR = input[1] || input[0]; // Fallback to mono if missing right channel
        const outputL = output[0];
        const outputR = output[1] || output[0];
        const bufferLen = this.bufferSize;

        // Passthrough logic for 0 pitch or close to it
        if (Math.abs(pitch) < 0.05) {
            for (let i = 0; i < inputL.length; i++) {
                // Update internal buffer even in passthrough to avoid clicks when enabling
                this.bufferL[this.writePos] = inputL[i];
                this.bufferR[this.writePos] = inputR[i];
                this.writePos = (this.writePos + 1) % bufferLen;

                outputL[i] = inputL[i];
                if (output.length > 1) outputR[i] = inputR[i];
            }
            return true;
        }

        // Calculate pitch ratio: 2^(semitones/12)
        const ratio = Math.pow(2, pitch / 12);

        // Speed difference determines how fast we move through the grain
        // pitch > 0 (ratio > 1): play faster, grain shortens effectively
        // pitch < 0 (ratio < 1): play slower, grain lengthens effectively
        // In this 'rotating tape head' model:
        // relative_speed = 1.0 - ratio
        const speed = (1.0 - ratio);

        for (let i = 0; i < inputL.length; i++) {
            // 1. Write input to circular buffer
            this.bufferL[this.writePos] = inputL[i];
            this.bufferR[this.writePos] = inputR[i];

            // 2. Update Grain Phase
            // We have two grains (taps) 180 degrees out of phase for constant power overlap
            this.phase += speed / this.grainSize;

            // Wrap phase [0, 1]
            if (this.phase > 1.0) this.phase -= 1.0;
            if (this.phase < 0.0) this.phase += 1.0;

            // 3. Calculate Delay Offsets for two overlapping grains
            // Grain A starts at phase 0, Grain B starts at phase 0.5
            let phaseA = this.phase;
            let phaseB = (this.phase + 0.5) % 1.0;

            // Map phase to delay in samples (0 to grainSize)
            let delayA = phaseA * this.grainSize;
            let delayB = phaseB * this.grainSize;

            // 4. Determine Read Positions in Buffer
            // readPos = writePos - delay
            let readPosA = (this.writePos - delayA + bufferLen) % bufferLen;
            let readPosB = (this.writePos - delayB + bufferLen) % bufferLen;

            // 5. Cubic Interpolation Read
            // To do cubic, we need 4 points: intPos-1, intPos, intPos+1, intPos+2

            // -- GRAIN A --
            const intPosA = Math.floor(readPosA);
            const fracA = readPosA - intPosA;

            // Function to safely read buffer with wrapping
            const getSample = (buf, pos) => buf[(pos + bufferLen) % bufferLen];

            // Left Channel Grain A
            const la0 = getSample(this.bufferL, intPosA - 1);
            const la1 = getSample(this.bufferL, intPosA);
            const la2 = getSample(this.bufferL, intPosA + 1);
            const la3 = getSample(this.bufferL, intPosA + 2);
            const valLA = this.cubicHermite(la0, la1, la2, la3, fracA);

            // Right Channel Grain A
            const ra0 = getSample(this.bufferR, intPosA - 1);
            const ra1 = getSample(this.bufferR, intPosA);
            const ra2 = getSample(this.bufferR, intPosA + 1);
            const ra3 = getSample(this.bufferR, intPosA + 2);
            const valRA = this.cubicHermite(ra0, ra1, ra2, ra3, fracA);


            // -- GRAIN B --
            const intPosB = Math.floor(readPosB);
            const fracB = readPosB - intPosB;

            // Left Channel Grain B
            const lb0 = getSample(this.bufferL, intPosB - 1);
            const lb1 = getSample(this.bufferL, intPosB);
            const lb2 = getSample(this.bufferL, intPosB + 1);
            const lb3 = getSample(this.bufferL, intPosB + 2);
            const valLB = this.cubicHermite(lb0, lb1, lb2, lb3, fracB);

            // Right Channel Grain B
            const rb0 = getSample(this.bufferR, intPosB - 1);
            const rb1 = getSample(this.bufferR, intPosB);
            const rb2 = getSample(this.bufferR, intPosB + 1);
            const rb3 = getSample(this.bufferR, intPosB + 2);
            const valRB = this.cubicHermite(rb0, rb1, rb2, rb3, fracB);


            // 6. Windowing (Crossfade)
            // Use pre-calculated Hanning window based on phase (0.0 to 1.0)
            // Phase goes from 0 to 1 over the grain life.
            // We map phase (0..1) to window index (0..grainSize-1)
            const winIdxA = Math.floor(phaseA * (this.grainSize - 1));
            const winIdxB = Math.floor(phaseB * (this.grainSize - 1));

            const gainA = this.window[winIdxA];
            const gainB = this.window[winIdxB];

            // 7. Mix and Output
            outputL[i] = valLA * gainA + valLB * gainB;
            if (output.length > 1) {
                outputR[i] = valRA * gainA + valRB * gainB;
            }

            // 8. Increment circular buffer head
            this.writePos = (this.writePos + 1) % bufferLen;
        }

        return true;
    }
}

registerProcessor('pitch-processor', PitchProcessor);
