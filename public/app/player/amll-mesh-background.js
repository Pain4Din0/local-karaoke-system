const meshVertShader = `
precision highp float;

attribute vec2 a_pos;
attribute vec3 a_color;
attribute vec2 a_uv;
varying vec3 v_color;
varying vec2 v_uv;

uniform float u_aspect;

void main() {
    v_color = a_color;
    v_uv = a_uv;
    vec2 pos = a_pos;
    if (u_aspect > 1.0) {
        pos.y *= u_aspect;
    } else {
        pos.x /= u_aspect;
    }
    gl_Position = vec4(pos, 0.0, 1.0);
}
`;

const meshFragShader = `
precision highp float;

varying vec3 v_color;
varying vec2 v_uv;
uniform sampler2D u_texture;
uniform float u_time;
uniform float u_volume;
uniform float u_alpha;

const float INV_255 = 1.0 / 255.0;
const float HALF_INV_255 = 0.5 / 255.0;
const float GRADIENT_NOISE_A = 52.9829189;
const vec2 GRADIENT_NOISE_B = vec2(0.06711056, 0.00583715);

float gradientNoise(in vec2 uv) {
    return fract(GRADIENT_NOISE_A * fract(dot(uv, GRADIENT_NOISE_B)));
}

vec2 rot(vec2 v, float angle) {
    float s = sin(angle);
    float c = cos(angle);
    return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
}

void main() {
    float volumeEffect = u_volume * 2.0;
    float timeVolume = u_time + u_volume;
    float dither = INV_255 * gradientNoise(gl_FragCoord.xy) - HALF_INV_255;
    vec2 centeredUV = v_uv - vec2(0.2);
    vec2 rotatedUV = rot(centeredUV, timeVolume * 2.0);
    vec2 finalUV = rotatedUV * max(0.001, 1.0 - volumeEffect) + vec2(0.5);
    vec4 result = texture2D(u_texture, finalUV);
    float alphaVolumeFactor = u_alpha * max(0.5, 1.0 - u_volume * 0.5);
    result.rgb *= v_color * alphaVolumeFactor;
    result.a *= alphaVolumeFactor;
    result.rgb += vec3(dither);
    float dist = distance(v_uv, vec2(0.5));
    float vignette = smoothstep(0.8, 0.3, dist);
    float mask = 0.6 + vignette * 0.4;
    result.rgb *= mask;
    gl_FragColor = result;
}
`;

const quadVertShader = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
    gl_Position = vec4(a_pos, 0.0, 1.0);
    v_uv = a_pos * 0.5 + 0.5;
}
`;

const quadFragShader = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_texture;
uniform float u_alpha;
void main() {
    vec4 color = texture2D(u_texture, v_uv);
    gl_FragColor = vec4(color.rgb, color.a * u_alpha);
}
`;

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function clampByte(value) {
    return clamp(Math.round(value), 0, 255);
}

function easeInOutSine(x) {
    return -(Math.cos(Math.PI * x) - 1) / 2;
}

function createWorkingCanvas(width, height) {
    if ('OffscreenCanvas' in window) {
        return new OffscreenCanvas(width, height);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
}

function p(cx, cy, x, y, ur = 0, vr = 0, up = 1, vp = 1) {
    return Object.freeze({ cx, cy, x, y, ur, vr, up, vp });
}

function preset(width, height, conf) {
    return Object.freeze({ width, height, conf });
}

function mat4Create() {
    const out = new Float32Array(16);
    out[0] = 1;
    out[5] = 1;
    out[10] = 1;
    out[15] = 1;
    return out;
}

function mat4FromValues() {
    return new Float32Array(arguments);
}

function mat4Transpose(out, a) {
    if (out === a) {
        const a01 = a[1];
        const a02 = a[2];
        const a03 = a[3];
        const a12 = a[6];
        const a13 = a[7];
        const a23 = a[11];
        out[1] = a[4];
        out[2] = a[8];
        out[3] = a[12];
        out[4] = a01;
        out[6] = a[9];
        out[7] = a[13];
        out[8] = a02;
        out[9] = a12;
        out[11] = a[14];
        out[12] = a03;
        out[13] = a13;
        out[14] = a23;
    } else {
        out[0] = a[0];
        out[1] = a[4];
        out[2] = a[8];
        out[3] = a[12];
        out[4] = a[1];
        out[5] = a[5];
        out[6] = a[9];
        out[7] = a[13];
        out[8] = a[2];
        out[9] = a[6];
        out[10] = a[10];
        out[11] = a[14];
        out[12] = a[3];
        out[13] = a[7];
        out[14] = a[11];
        out[15] = a[15];
    }
    return out;
}

function mat4Copy(out, a) {
    out.set(a);
    return out;
}

function mat4Multiply(out, a, b) {
    const a00 = a[0];
    const a01 = a[1];
    const a02 = a[2];
    const a03 = a[3];
    const a10 = a[4];
    const a11 = a[5];
    const a12 = a[6];
    const a13 = a[7];
    const a20 = a[8];
    const a21 = a[9];
    const a22 = a[10];
    const a23 = a[11];
    const a30 = a[12];
    const a31 = a[13];
    const a32 = a[14];
    const a33 = a[15];
    let b0 = b[0];
    let b1 = b[1];
    let b2 = b[2];
    let b3 = b[3];
    out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    b0 = b[4];
    b1 = b[5];
    b2 = b[6];
    b3 = b[7];
    out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    b0 = b[8];
    b1 = b[9];
    b2 = b[10];
    b3 = b[11];
    out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    b0 = b[12];
    b1 = b[13];
    b2 = b[14];
    b3 = b[15];
    out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    return out;
}

function vec4Create() {
    return new Float32Array(4);
}

function vec4TransformMat4(out, a, m) {
    const x = a[0];
    const y = a[1];
    const z = a[2];
    const w = a[3];
    out[0] = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
    out[1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
    out[2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
    out[3] = m[3] * x + m[7] * y + m[11] * z + m[15] * w;
    return out;
}

const H = mat4FromValues(
    2, -2, 1, 1,
    -3, 3, -2, -1,
    0, 0, 1, 0,
    1, 0, 0, 0
);
const H_T = mat4Transpose(mat4Create(), H);

function blurImage(imageData, radius, quality) {
    const pixels = imageData.data;
    const width = imageData.width;
    const height = imageData.height;
    let rsum;
    let gsum;
    let bsum;
    let asum;
    let x;
    let y;
    let i;
    let p;
    let p1;
    let p2;
    let yp;
    let yi;
    let yw;
    const wm = width - 1;
    const hm = height - 1;
    const rad1x = radius + 1;
    const divx = radius + rad1x;
    const rad1y = radius + 1;
    const divy = radius + rad1y;
    const div2 = 1 / (divx * divy);
    const r = [];
    const g = [];
    const b = [];
    const a = [];
    const vmin = [];
    const vmax = [];
    while (quality-- > 0) {
        yw = yi = 0;
        for (y = 0; y < height; y++) {
            rsum = pixels[yw] * rad1x;
            gsum = pixels[yw + 1] * rad1x;
            bsum = pixels[yw + 2] * rad1x;
            asum = pixels[yw + 3] * rad1x;
            for (i = 1; i <= radius; i++) {
                p = yw + ((i > wm ? wm : i) << 2);
                rsum += pixels[p++];
                gsum += pixels[p++];
                bsum += pixels[p++];
                asum += pixels[p];
            }
            for (x = 0; x < width; x++) {
                r[yi] = rsum;
                g[yi] = gsum;
                b[yi] = bsum;
                a[yi] = asum;
                if (y === 0) {
                    vmin[x] = Math.min(x + rad1x, wm) << 2;
                    vmax[x] = Math.max(x - radius, 0) << 2;
                }
                p1 = yw + vmin[x];
                p2 = yw + vmax[x];
                rsum += pixels[p1++] - pixels[p2++];
                gsum += pixels[p1++] - pixels[p2++];
                bsum += pixels[p1++] - pixels[p2++];
                asum += pixels[p1] - pixels[p2];
                yi++;
            }
            yw += width << 2;
        }
        for (x = 0; x < width; x++) {
            yp = x;
            rsum = r[yp] * rad1y;
            gsum = g[yp] * rad1y;
            bsum = b[yp] * rad1y;
            asum = a[yp] * rad1y;
            for (i = 1; i <= radius; i++) {
                yp += i > hm ? 0 : width;
                rsum += r[yp];
                gsum += g[yp];
                bsum += b[yp];
                asum += a[yp];
            }
            yi = x << 2;
            for (y = 0; y < height; y++) {
                pixels[yi] = (rsum * div2 + 0.5) | 0;
                pixels[yi + 1] = (gsum * div2 + 0.5) | 0;
                pixels[yi + 2] = (bsum * div2 + 0.5) | 0;
                pixels[yi + 3] = (asum * div2 + 0.5) | 0;
                if (x === 0) {
                    vmin[y] = Math.min(y + rad1y, hm) * width;
                    vmax[y] = Math.max(y - radius, 0) * width;
                }
                p1 = x + vmin[y];
                p2 = x + vmax[y];
                rsum += r[p1] - r[p2];
                gsum += g[p1] - g[p2];
                bsum += b[p1] - b[p2];
                asum += a[p1] - a[p2];
                yi += width << 2;
            }
        }
    }
}

const CONTROL_POINT_PRESETS = [
    preset(5, 5, [
        p(0, 0, -1, -1, 0, 0, 1, 1),
        p(1, 0, -0.5, -1, 0, 0, 1, 1),
        p(2, 0, 0, -1, 0, 0, 1, 1),
        p(3, 0, 0.5, -1, 0, 0, 1, 1),
        p(4, 0, 1, -1, 0, 0, 1, 1),
        p(0, 1, -1, -0.5, 0, 0, 1, 1),
        p(1, 1, -0.5, -0.5, 0, 0, 1, 1),
        p(2, 1, -0.0052029684413368305, -0.6131420587090777, 0, 0, 1, 1),
        p(3, 1, 0.5884227308309977, -0.3990805107556692, 0, 0, 1, 1),
        p(4, 1, 1, -0.5, 0, 0, 1, 1),
        p(0, 2, -1, 0, 0, 0, 1, 1),
        p(1, 2, -0.4210024670505933, -0.11895058380429502, 0, 0, 1, 1),
        p(2, 2, -0.1019613423315412, -0.023812118047224606, 0, -47, 0.629, 0.849),
        p(3, 2, 0.40275125660925437, -0.06345314544600389, 0, 0, 1, 1),
        p(4, 2, 1, 0, 0, 0, 1, 1),
        p(0, 3, -1, 0.5, 0, 0, 1, 1),
        p(1, 3, 0.06801958477287173, 0.5205913248960121, -31, -45, 1, 1),
        p(2, 3, 0.21446469120128908, 0.29331610114301043, 6, -56, 0.566, 1.321),
        p(3, 3, 0.5, 0.5, 0, 0, 1, 1),
        p(4, 3, 1, 0.5, 0, 0, 1, 1),
        p(0, 4, -1, 1, 0, 0, 1, 1),
        p(1, 4, -0.31378372841550195, 1, 0, 0, 1, 1),
        p(2, 4, 0.26153633255328046, 1, 0, 0, 1, 1),
        p(3, 4, 0.5, 1, 0, 0, 1, 1),
        p(4, 4, 1, 1, 0, 0, 1, 1),
    ]),
    preset(4, 4, [
        p(0, 0, -1, -1, 0, 0, 1, 1),
        p(1, 0, -0.33333333333333337, -1, 0, 0, 1, 1),
        p(2, 0, 0.33333333333333326, -1, 0, 0, 1, 1),
        p(3, 0, 1, -1, 0, 0, 1, 1),
        p(0, 1, -1, -0.04495399932657351, 0, 0, 1, 1),
        p(1, 1, -0.24056117520129328, -0.22465999020104, 0, 0, 1, 1),
        p(2, 1, 0.334758885767489, -0.00531297192779423, 0, 0, 1, 1),
        p(3, 1, 0.9989920470678106, -0.3382976020775408, 8, 0, 0.566, 1.792),
        p(0, 2, -1, 0.33333333333333326, 0, 0, 1, 1),
        p(1, 2, -0.3425497314639411, -0.000027501607956947893, 0, 0, 1, 1),
        p(2, 2, 0.3321437945812673, 0.1981776353859399, 0, 0, 1, 1),
        p(3, 2, 1, 0.0766118180296832, 0, 0, 1, 1),
        p(0, 3, -1, 1, 0, 0, 1, 1),
        p(1, 3, -0.33333333333333337, 1, 0, 0, 1, 1),
        p(2, 3, 0.33333333333333326, 1, 0, 0, 1, 1),
        p(3, 3, 1, 1, 0, 0, 1, 1),
    ]),
    preset(4, 4, [
        p(0, 0, -1, -1, 0, 0, 1, 2.075),
        p(1, 0, -0.33333333333333337, -1, 0, 0, 1, 1),
        p(2, 0, 0.33333333333333326, -1, 0, 0, 1, 1),
        p(3, 0, 1, -1, 0, 0, 1, 1),
        p(0, 1, -1, -0.4545779491139603, 0, 0, 1, 1),
        p(1, 1, -0.33333333333333337, -0.33333333333333337, 0, 0, 1, 1),
        p(2, 1, 0.0889403142626457, -0.6025711180694033, -32, 45, 1, 1),
        p(3, 1, 1, -0.33333333333333337, 0, 0, 1, 1),
        p(0, 2, -1, -0.07402408608567845, 1, 0, 1, 0.094),
        p(1, 2, -0.2719422694359541, 0.09775369930903222, 25, -18, 1.321, 0),
        p(2, 2, 0.19877414408395877, 0.4307383294587789, 48, -40, 0.755, 0.975),
        p(3, 2, 1, 0.33333333333333326, -37, 0, 1, 1),
        p(0, 3, -1, 1, 0, 0, 1, 1),
        p(1, 3, -0.33333333333333337, 1, 0, 0, 1, 1),
        p(2, 3, 0.5125850864305672, 1, -20, -18, 0, 1.604),
        p(3, 3, 1, 1, 0, 0, 1, 1),
    ]),
    preset(5, 5, [
        p(0, 0, -1, -1, 0, 0, 1, 1),
        p(1, 0, -0.4501953125, -1, 0, 55, 1, 2.075),
        p(2, 0, 0.1953125, -1, 0, 0, 1, 1),
        p(3, 0, 0.4580078125, -1, 0, -25, 1, 1),
        p(4, 0, 1, -1, 0, 0, 1, 1),
        p(0, 1, -1, -0.2514475377525607, -16, 0, 2.327, 0.943),
        p(1, 1, -0.55859375, -0.6609325945787148, 47, 0, 2.358, 0.377),
        p(2, 1, 0.232421875, -0.5244375756366635, -66, -25, 1.855, 1.164),
        p(3, 1, 0.685546875, -0.3753706470552125, 0, 0, 1, 1),
        p(4, 1, 1, -0.6699125300354287, 0, 0, 1, 1),
        p(0, 2, -1, 0.035910396862284255, 0, 0, 1, 1),
        p(1, 2, -0.4921875, 0.005378616309457018, 90, 23, 1, 1.981),
        p(2, 2, 0.021484375, -0.1365043639066228, 0, 42, 1, 1),
        p(3, 2, 0.4765625, 0.05925822904974043, -30, 0, 1.95, 0.44),
        p(4, 2, 1, 0.251428847823418, 0, 0, 1, 1),
        p(0, 3, -1, 0.6968336464764276, -68, 0, 1, 0.786),
        p(1, 3, -0.6904296875, 0.5890744209958608, -68, 0, 1, 1),
        p(2, 3, 0.1845703125, 0.3879238667654693, 61, 0, 1, 1),
        p(3, 3, 0.60546875, 0.4633553246018661, -47, -59, 0.849, 1.73),
        p(4, 3, 1, 0.6214021886400309, -33, 0, 0.377, 1.604),
        p(0, 4, -1, 1, 0, 0, 1, 1),
        p(1, 4, -0.5, 1, 0, -73, 1, 1),
        p(2, 4, -0.3271484375, 1, 0, -24, 0.314, 2.704),
        p(3, 4, 0.5, 1, 0, 0, 1, 1),
        p(4, 4, 1, 1, 0, 0, 1, 1),
    ]),
    preset(5, 5, [
        p(0, 0, -1, -1),
        p(1, 0, -0.6393, -1, 0, 0, 1, 2.3884),
        p(2, 0, 0, -1),
        p(3, 0, 0.5, -1),
        p(4, 0, 1, -1),
        p(0, 1, -1, -0.2301),
        p(1, 1, -0.6934, -0.331, 0, -0.7188, 1, 1.063),
        p(2, 1, -0.0082, -0.6814, -0.2583, 0, 1.0964, 1),
        p(3, 1, 0.5836, -0.531, 0.7029, 0, 1.5466, 1),
        p(4, 1, 1, -0.6407),
        p(0, 2, -1, 0.2973, 0, 0, 1.8352, 1),
        p(1, 2, -0.4082, 0.0602),
        p(2, 2, -0.1803, -0.3646, -0.2998, 0, 1.1513, 1),
        p(3, 2, 0.477, -0.1027, 0.8903, -0.1882, 1.0807, 0.8551),
        p(4, 2, 1, -0.2973),
        p(0, 3, -1, 0.7628, 0, 0, 2.3868, 1),
        p(1, 3, -0.2525, 0.4814, -0.8406, -1.6199, 1.4093, 1.2215),
        p(2, 3, 0.3607, 0.2814, -1.0713, -0.0529, 1.0025, 0.7611),
        p(3, 3, 0.4885, 0.623, 0, 0.8184, 1, 1.2876),
        p(4, 3, 1, 0.5),
        p(0, 4, -1, 1),
        p(1, 4, -0.4033, 1),
        p(2, 4, 0.2672, 1),
        p(3, 4, 0.5967, 1),
        p(4, 4, 1, 1),
    ]),
    preset(5, 5, [
        p(0, 0, -1, -1),
        p(1, 0, -0.2197, -1),
        p(2, 0, 0.0197, -1),
        p(3, 0, 0.8033, -1),
        p(4, 0, 1, -1),
        p(0, 1, -1, -0.5451),
        p(1, 1, -0.4885, -0.4035, -1.0246, -0.2268, 1.1936, 0.8005),
        p(2, 1, -0.1213, -0.2867, 0, -0.6981, 1, 0.809),
        p(3, 1, 0.3246, -0.5628, 0, -1.2188, 1, 1.044),
        p(4, 1, 1, -0.3292),
        p(0, 2, -1, 0.1416),
        p(1, 2, -0.341, -0.0142, 0, -0.4004, 1, 1.1293),
        p(2, 2, -0.0393, -0.023, 0.2915, -0.373, 1.044, 0.9879),
        p(3, 2, 0.3148, -0.0673, -0.7853, -0.8962, 1.4709, 1.0247),
        p(4, 2, 1, 0.1912),
        p(0, 3, -1, 0.5),
        p(1, 3, -0.2689, 0.2743, 0.3404, -0.5248, 1.0184, 0.4391),
        p(2, 3, 0.0721, 0.269, 0.5302, 0.1244, 0.6723, 0.3225),
        p(3, 3, 0.4148, 0.3894, -0.6977, -0.6783, 0.8094, 0.9247),
        p(4, 3, 1, 0.446),
        p(0, 4, -1, 1),
        p(1, 4, -0.7311, 1),
        p(2, 4, 0.323, 1),
        p(3, 4, 0.6393, 1),
        p(4, 4, 1, 1),
    ]),
];
function randomRange(min, max) {
    return Math.random() * (max - min) + min;
}

function smoothstep(edge0, edge1, x) {
    const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
}

function fract(x) {
    return x - Math.floor(x);
}

function noise(x, y) {
    return fract(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453);
}

function smoothNoise(x, y) {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = x0 + 1;
    const y1 = y0 + 1;
    const xf = x - x0;
    const yf = y - y0;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const n00 = noise(x0, y0);
    const n10 = noise(x1, y0);
    const n01 = noise(x0, y1);
    const n11 = noise(x1, y1);
    const nx0 = n00 * (1 - u) + n10 * u;
    const nx1 = n01 * (1 - u) + n11 * u;
    return nx0 * (1 - v) + nx1 * v;
}

function computeNoiseGradient(perlinFn, x, y, epsilon = 0.001) {
    const n1 = perlinFn(x + epsilon, y);
    const n2 = perlinFn(x - epsilon, y);
    const n3 = perlinFn(x, y + epsilon);
    const n4 = perlinFn(x, y - epsilon);
    const dx = (n1 - n2) / (2 * epsilon);
    const dy = (n3 - n4) / (2 * epsilon);
    const length = Math.sqrt(dx * dx + dy * dy) || 1;
    return [dx / length, dy / length];
}

function smoothifyControlPoints(conf, width, height, iterations = 2, factor = 0.5, factorIterationModifier = 0.1) {
    let grid = [];
    let currentFactor = factor;
    for (let j = 0; j < height; j++) {
        grid[j] = [];
        for (let i = 0; i < width; i++) {
            grid[j][i] = conf[j * width + i];
        }
    }
    const kernel = [[1, 2, 1], [2, 4, 2], [1, 2, 1]];
    const kernelSum = 16;
    for (let iteration = 0; iteration < iterations; iteration++) {
        const newGrid = [];
        for (let j = 0; j < height; j++) {
            newGrid[j] = [];
            for (let i = 0; i < width; i++) {
                if (i === 0 || i === width - 1 || j === 0 || j === height - 1) {
                    newGrid[j][i] = grid[j][i];
                    continue;
                }
                let sumX = 0;
                let sumY = 0;
                let sumUR = 0;
                let sumVR = 0;
                let sumUP = 0;
                let sumVP = 0;
                for (let dj = -1; dj <= 1; dj++) {
                    for (let di = -1; di <= 1; di++) {
                        const weight = kernel[dj + 1][di + 1];
                        const neighbour = grid[j + dj][i + di];
                        sumX += neighbour.x * weight;
                        sumY += neighbour.y * weight;
                        sumUR += neighbour.ur * weight;
                        sumVR += neighbour.vr * weight;
                        sumUP += neighbour.up * weight;
                        sumVP += neighbour.vp * weight;
                    }
                }
                const current = grid[j][i];
                newGrid[j][i] = p(
                    i,
                    j,
                    current.x * (1 - currentFactor) + (sumX / kernelSum) * currentFactor,
                    current.y * (1 - currentFactor) + (sumY / kernelSum) * currentFactor,
                    current.ur * (1 - currentFactor) + (sumUR / kernelSum) * currentFactor,
                    current.vr * (1 - currentFactor) + (sumVR / kernelSum) * currentFactor,
                    current.up * (1 - currentFactor) + (sumUP / kernelSum) * currentFactor,
                    current.vp * (1 - currentFactor) + (sumVP / kernelSum) * currentFactor
                );
            }
        }
        grid = newGrid;
        currentFactor = Math.min(1, Math.max(currentFactor + factorIterationModifier, 0));
    }
    for (let j = 0; j < height; j++) {
        for (let i = 0; i < width; i++) {
            conf[j * width + i] = grid[j][i];
        }
    }
}

function generateControlPoints(width, height, variationFraction = randomRange(0.4, 0.6), normalOffset = randomRange(0.3, 0.6), blendFactor = 0.8, smoothIters = Math.floor(randomRange(3, 5)), smoothFactor = randomRange(0.2, 0.3), smoothModifier = randomRange(-0.1, -0.05)) {
    const w = width || Math.floor(randomRange(3, 6));
    const h = height || Math.floor(randomRange(3, 6));
    const conf = [];
    const dx = w === 1 ? 0 : 2 / (w - 1);
    const dy = h === 1 ? 0 : 2 / (h - 1);
    for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
            const baseX = (w === 1 ? 0 : i / (w - 1)) * 2 - 1;
            const baseY = (h === 1 ? 0 : j / (h - 1)) * 2 - 1;
            const isBorder = i === 0 || i === w - 1 || j === 0 || j === h - 1;
            const pertX = isBorder ? 0 : randomRange(-variationFraction * dx, variationFraction * dx);
            const pertY = isBorder ? 0 : randomRange(-variationFraction * dy, variationFraction * dy);
            let x = baseX + pertX;
            let y = baseY + pertY;
            const ur = isBorder ? 0 : randomRange(-60, 60);
            const vr = isBorder ? 0 : randomRange(-60, 60);
            const up = isBorder ? 1 : randomRange(0.8, 1.2);
            const vp = isBorder ? 1 : randomRange(0.8, 1.2);
            if (!isBorder) {
                const uNorm = (baseX + 1) / 2;
                const vNorm = (baseY + 1) / 2;
                const gradient = computeNoiseGradient(smoothNoise, uNorm, vNorm, 0.001);
                let offsetX = gradient[0] * normalOffset;
                let offsetY = gradient[1] * normalOffset;
                const distToBorder = Math.min(uNorm, 1 - uNorm, vNorm, 1 - vNorm);
                const weight = smoothstep(0, 1, distToBorder);
                offsetX *= weight;
                offsetY *= weight;
                x = x * (1 - blendFactor) + (x + offsetX) * blendFactor;
                y = y * (1 - blendFactor) + (y + offsetY) * blendFactor;
            }
            conf.push(p(i, j, x, y, ur, vr, up, vp));
        }
    }
    smoothifyControlPoints(conf, w, h, smoothIters, smoothFactor, smoothModifier);
    return preset(w, h, conf);
}

class GLProgram {
    constructor(gl, vertexShaderSource, fragmentShaderSource, label = 'unknown') {
        this.gl = gl;
        this.label = label;
        this.notFoundUniforms = new Set();
        this.vertexShader = this.createShader(gl.VERTEX_SHADER, vertexShaderSource);
        this.fragmentShader = this.createShader(gl.FRAGMENT_SHADER, fragmentShaderSource);
        this.program = this.createProgram();
        this.attrs = {};
        const count = gl.getProgramParameter(this.program, gl.ACTIVE_ATTRIBUTES);
        for (let index = 0; index < count; index++) {
            const info = gl.getActiveAttrib(this.program, index);
            if (!info) continue;
            const location = gl.getAttribLocation(this.program, info.name);
            if (location === -1) continue;
            this.attrs[info.name] = location;
        }
    }

    createShader(type, source) {
        const shader = this.gl.createShader(type);
        if (!shader) throw new Error('Failed to create shader');
        this.gl.shaderSource(shader, source);
        this.gl.compileShader(shader);
        if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
            throw new Error(`Failed to compile shader "${this.label}": ${this.gl.getShaderInfoLog(shader)}`);
        }
        return shader;
    }

    createProgram() {
        const program = this.gl.createProgram();
        if (!program) throw new Error('Failed to create program');
        this.gl.attachShader(program, this.vertexShader);
        this.gl.attachShader(program, this.fragmentShader);
        this.gl.linkProgram(program);
        if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
            const error = this.gl.getProgramInfoLog(program);
            this.gl.deleteProgram(program);
            throw new Error(`Failed to link program "${this.label}": ${error}`);
        }
        return program;
    }

    use() {
        this.gl.useProgram(this.program);
    }

    warnUniformNotFound(name) {
        if (this.notFoundUniforms.has(name)) return;
        this.notFoundUniforms.add(name);
        console.warn(`[AMLL] Failed to get uniform location for "${this.label}": ${name}`);
    }

    setUniform1f(name, value) {
        const location = this.gl.getUniformLocation(this.program, name);
        if (location == null) this.warnUniformNotFound(name);
        else this.gl.uniform1f(location, value);
    }

    setUniform1i(name, value) {
        const location = this.gl.getUniformLocation(this.program, name);
        if (location == null) this.warnUniformNotFound(name);
        else this.gl.uniform1i(location, value);
    }

    dispose() {
        this.gl.deleteShader(this.vertexShader);
        this.gl.deleteShader(this.fragmentShader);
        this.gl.deleteProgram(this.program);
    }
}

class Mesh {
    constructor(gl, attrPos, attrColor, attrUV) {
        this.gl = gl;
        this.attrPos = attrPos;
        this.attrColor = attrColor;
        this.attrUV = attrUV;
        this.vertexWidth = 0;
        this.vertexHeight = 0;
        this.vertexIndexLength = 0;
        this.wireFrame = false;
        this.vertexBuffer = gl.createBuffer();
        this.indexBuffer = gl.createBuffer();
        if (!this.vertexBuffer || !this.indexBuffer) throw new Error('Failed to create mesh buffers');
        this.vertexData = new Float32Array(0);
        this.indexData = new Uint16Array(0);
        this.bind();
        this.resize(2, 2);
        this.update();
    }

    setWireFrame(enable) {
        this.wireFrame = enable;
        this.resize(this.vertexWidth, this.vertexHeight);
    }

    setVertexData(vx, vy, x, y, r, g, b, u, v) {
        const index = (vx + vy * this.vertexWidth) * 7;
        if (index >= this.vertexData.length - 6) return;
        const data = this.vertexData;
        data[index] = x;
        data[index + 1] = y;
        data[index + 2] = r;
        data[index + 3] = g;
        data[index + 4] = b;
        data[index + 5] = u;
        data[index + 6] = v;
    }

    draw() {
        if (this.wireFrame) {
            this.gl.drawElements(this.gl.LINES, this.vertexIndexLength, this.gl.UNSIGNED_SHORT, 0);
            return;
        }
        this.gl.drawElements(this.gl.TRIANGLES, this.vertexIndexLength, this.gl.UNSIGNED_SHORT, 0);
    }

    resize(vertexWidth, vertexHeight) {
        this.vertexWidth = vertexWidth;
        this.vertexHeight = vertexHeight;
        this.vertexIndexLength = vertexWidth * vertexHeight * (this.wireFrame ? 10 : 6);
        this.vertexData = new Float32Array(vertexWidth * vertexHeight * 7);
        this.indexData = new Uint16Array(this.vertexIndexLength);
        for (let y = 0; y < vertexHeight; y++) {
            for (let x = 0; x < vertexWidth; x++) {
                this.setVertexData(
                    x,
                    y,
                    (x / (vertexWidth - 1)) * 2 - 1 || 0,
                    (y / (vertexHeight - 1)) * 2 - 1 || 0,
                    1,
                    1,
                    1,
                    x / (vertexWidth - 1),
                    y / (vertexHeight - 1)
                );
            }
        }
        for (let y = 0; y < vertexHeight - 1; y++) {
            for (let x = 0; x < vertexWidth - 1; x++) {
                if (this.wireFrame) {
                    const index = (y * vertexWidth + x) * 10;
                    this.indexData[index] = y * vertexWidth + x;
                    this.indexData[index + 1] = y * vertexWidth + x + 1;
                    this.indexData[index + 2] = y * vertexWidth + x + 1;
                    this.indexData[index + 3] = (y + 1) * vertexWidth + x;
                    this.indexData[index + 4] = (y + 1) * vertexWidth + x;
                    this.indexData[index + 5] = (y + 1) * vertexWidth + x + 1;
                    this.indexData[index + 6] = (y + 1) * vertexWidth + x + 1;
                    this.indexData[index + 7] = y * vertexWidth + x + 1;
                    this.indexData[index + 8] = y * vertexWidth + x;
                    this.indexData[index + 9] = (y + 1) * vertexWidth + x;
                } else {
                    const index = (y * vertexWidth + x) * 6;
                    this.indexData[index] = y * vertexWidth + x;
                    this.indexData[index + 1] = y * vertexWidth + x + 1;
                    this.indexData[index + 2] = (y + 1) * vertexWidth + x;
                    this.indexData[index + 3] = y * vertexWidth + x + 1;
                    this.indexData[index + 4] = (y + 1) * vertexWidth + x + 1;
                    this.indexData[index + 5] = (y + 1) * vertexWidth + x;
                }
            }
        }
        this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
        this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, this.indexData, this.gl.STATIC_DRAW);
    }

    bind() {
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.vertexBuffer);
        this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
        if (typeof this.attrPos === 'number' && this.attrPos >= 0) {
            this.gl.vertexAttribPointer(this.attrPos, 2, this.gl.FLOAT, false, 4 * 7, 0);
            this.gl.enableVertexAttribArray(this.attrPos);
        }
        if (typeof this.attrColor === 'number' && this.attrColor >= 0) {
            this.gl.vertexAttribPointer(this.attrColor, 3, this.gl.FLOAT, false, 4 * 7, 4 * 2);
            this.gl.enableVertexAttribArray(this.attrColor);
        }
        if (typeof this.attrUV === 'number' && this.attrUV >= 0) {
            this.gl.vertexAttribPointer(this.attrUV, 2, this.gl.FLOAT, false, 4 * 7, 4 * 5);
            this.gl.enableVertexAttribArray(this.attrUV);
        }
    }

    update() {
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.vertexBuffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, this.vertexData, this.gl.DYNAMIC_DRAW);
    }

    dispose() {
        this.gl.deleteBuffer(this.vertexBuffer);
        this.gl.deleteBuffer(this.indexBuffer);
    }
}

class ControlPoint {
    constructor() {
        this.color = { r: 1, g: 1, b: 1 };
        this.location = { x: 0, y: 0 };
        this.uTangent = { x: 0, y: 0 };
        this.vTangent = { x: 0, y: 0 };
        this._uRot = 0;
        this._vRot = 0;
        this._uScale = 1;
        this._vScale = 1;
    }

    get uRot() {
        return this._uRot;
    }

    set uRot(value) {
        this._uRot = value;
        this.updateUTangent();
    }

    get vRot() {
        return this._vRot;
    }

    set vRot(value) {
        this._vRot = value;
        this.updateVTangent();
    }

    get uScale() {
        return this._uScale;
    }

    set uScale(value) {
        this._uScale = value;
        this.updateUTangent();
    }

    get vScale() {
        return this._vScale;
    }

    set vScale(value) {
        this._vScale = value;
        this.updateVTangent();
    }

    updateUTangent() {
        this.uTangent.x = Math.cos(this._uRot) * this._uScale;
        this.uTangent.y = Math.sin(this._uRot) * this._uScale;
    }

    updateVTangent() {
        this.vTangent.x = -Math.sin(this._vRot) * this._vScale;
        this.vTangent.y = Math.cos(this._vRot) * this._vScale;
    }
}

function meshCoefficients(p00, p01, p10, p11, axis, output) {
    output[0] = p00.location[axis];
    output[1] = p01.location[axis];
    output[2] = p00.vTangent[axis];
    output[3] = p01.vTangent[axis];
    output[4] = p10.location[axis];
    output[5] = p11.location[axis];
    output[6] = p10.vTangent[axis];
    output[7] = p11.vTangent[axis];
    output[8] = p00.uTangent[axis];
    output[9] = p01.uTangent[axis];
    output[10] = 0;
    output[11] = 0;
    output[12] = p10.uTangent[axis];
    output[13] = p11.uTangent[axis];
    output[14] = 0;
    output[15] = 0;
    return output;
}

function colorCoefficients(p00, p01, p10, p11, axis, output) {
    output.fill(0);
    output[0] = p00.color[axis];
    output[1] = p01.color[axis];
    output[4] = p10.color[axis];
    output[5] = p11.color[axis];
    return output;
}

class Map2D {
    constructor(width, height) {
        this.resize(width, height);
    }

    resize(width, height) {
        this._width = width;
        this._height = height;
        this._data = new Array(width * height).fill(null);
    }

    set(x, y, value) {
        this._data[x + y * this._width] = value;
    }

    get(x, y) {
        return this._data[x + y * this._width];
    }

    get width() {
        return this._width;
    }

    get height() {
        return this._height;
    }
}

class BHPMesh extends Mesh {
    constructor(gl, attrPos, attrColor, attrUV) {
        super(gl, attrPos, attrColor, attrUV);
        this._subDivisions = 10;
        this._controlPoints = new Map2D(3, 3);
        this.tempX = mat4Create();
        this.tempY = mat4Create();
        this.tempR = mat4Create();
        this.tempG = mat4Create();
        this.tempB = mat4Create();
        this.tempXAcc = mat4Create();
        this.tempYAcc = mat4Create();
        this.tempRAcc = mat4Create();
        this.tempGAcc = mat4Create();
        this.tempBAcc = mat4Create();
        this.tempUx = vec4Create();
        this.tempUy = vec4Create();
        this.tempUr = vec4Create();
        this.tempUg = vec4Create();
        this.tempUb = vec4Create();
        this.resizeControlPoints(3, 3);
    }

    setWireFrame(enable) {
        super.setWireFrame(enable);
        this.updateMesh();
    }

    resetSubdivition(subDivisions) {
        this._subDivisions = subDivisions;
        super.resize(
            (this._controlPoints.width - 1) * subDivisions,
            (this._controlPoints.height - 1) * subDivisions
        );
    }

    resizeControlPoints(width, height) {
        if (!(width >= 2 && height >= 2)) {
            throw new Error('Control points must be at least 2x2');
        }
        this._controlPoints.resize(width, height);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const point = new ControlPoint();
                point.location.x = (x / (width - 1)) * 2 - 1;
                point.location.y = (y / (height - 1)) * 2 - 1;
                point.uTangent.x = 2 / (width - 1);
                point.vTangent.y = 2 / (height - 1);
                this._controlPoints.set(x, y, point);
            }
        }
        this.resetSubdivition(this._subDivisions);
    }

    getControlPoint(x, y) {
        return this._controlPoints.get(x, y);
    }

    precomputeMatrix(matrix, output) {
        mat4Copy(output, matrix);
        mat4Transpose(output, output);
        mat4Multiply(output, output, H);
        mat4Multiply(output, H_T, output);
        return output;
    }

    updateMesh() {
        const subDivM1 = this._subDivisions - 1;
        const tW = subDivM1 * (this._controlPoints.height - 1);
        const tH = subDivM1 * (this._controlPoints.width - 1);
        const controlPointsWidth = this._controlPoints.width;
        const controlPointsHeight = this._controlPoints.height;
        const invSubDivM1 = 1 / subDivM1;
        const invTH = 1 / tH;
        const invTW = 1 / tW;
        const normPowers = new Float32Array(this._subDivisions * 4);
        for (let index = 0; index < this._subDivisions; index++) {
            const normalized = index * invSubDivM1;
            const offset = index * 4;
            normPowers[offset] = normalized ** 3;
            normPowers[offset + 1] = normalized ** 2;
            normPowers[offset + 2] = normalized;
            normPowers[offset + 3] = 1;
        }
        for (let x = 0; x < controlPointsWidth - 1; x++) {
            for (let y = 0; y < controlPointsHeight - 1; y++) {
                const p00 = this._controlPoints.get(x, y);
                const p01 = this._controlPoints.get(x, y + 1);
                const p10 = this._controlPoints.get(x + 1, y);
                const p11 = this._controlPoints.get(x + 1, y + 1);
                meshCoefficients(p00, p01, p10, p11, 'x', this.tempX);
                meshCoefficients(p00, p01, p10, p11, 'y', this.tempY);
                colorCoefficients(p00, p01, p10, p11, 'r', this.tempR);
                colorCoefficients(p00, p01, p10, p11, 'g', this.tempG);
                colorCoefficients(p00, p01, p10, p11, 'b', this.tempB);
                this.precomputeMatrix(this.tempX, this.tempXAcc);
                this.precomputeMatrix(this.tempY, this.tempYAcc);
                this.precomputeMatrix(this.tempR, this.tempRAcc);
                this.precomputeMatrix(this.tempG, this.tempGAcc);
                this.precomputeMatrix(this.tempB, this.tempBAcc);
                const sX = x / (controlPointsWidth - 1);
                const sY = y / (controlPointsHeight - 1);
                const baseVx = y * this._subDivisions;
                const baseVy = x * this._subDivisions;
                for (let u = 0; u < this._subDivisions; u++) {
                    const vxOffset = baseVx + u;
                    const uIndex = u * 4;
                    this.tempUx[0] = normPowers[uIndex];
                    this.tempUx[1] = normPowers[uIndex + 1];
                    this.tempUx[2] = normPowers[uIndex + 2];
                    this.tempUx[3] = normPowers[uIndex + 3];
                    vec4TransformMat4(this.tempUx, this.tempUx, this.tempXAcc);
                    this.tempUy[0] = normPowers[uIndex];
                    this.tempUy[1] = normPowers[uIndex + 1];
                    this.tempUy[2] = normPowers[uIndex + 2];
                    this.tempUy[3] = normPowers[uIndex + 3];
                    vec4TransformMat4(this.tempUy, this.tempUy, this.tempYAcc);
                    this.tempUr[0] = normPowers[uIndex];
                    this.tempUr[1] = normPowers[uIndex + 1];
                    this.tempUr[2] = normPowers[uIndex + 2];
                    this.tempUr[3] = normPowers[uIndex + 3];
                    vec4TransformMat4(this.tempUr, this.tempUr, this.tempRAcc);
                    this.tempUg[0] = normPowers[uIndex];
                    this.tempUg[1] = normPowers[uIndex + 1];
                    this.tempUg[2] = normPowers[uIndex + 2];
                    this.tempUg[3] = normPowers[uIndex + 3];
                    vec4TransformMat4(this.tempUg, this.tempUg, this.tempGAcc);
                    this.tempUb[0] = normPowers[uIndex];
                    this.tempUb[1] = normPowers[uIndex + 1];
                    this.tempUb[2] = normPowers[uIndex + 2];
                    this.tempUb[3] = normPowers[uIndex + 3];
                    vec4TransformMat4(this.tempUb, this.tempUb, this.tempBAcc);
                    for (let v = 0; v < this._subDivisions; v++) {
                        const vy = baseVy + v;
                        const vIndex = v * 4;
                        const v0 = normPowers[vIndex];
                        const v1 = normPowers[vIndex + 1];
                        const v2 = normPowers[vIndex + 2];
                        const v3 = normPowers[vIndex + 3];
                        this.setVertexData(
                            vxOffset,
                            vy,
                            v0 * this.tempUx[0] + v1 * this.tempUx[1] + v2 * this.tempUx[2] + v3 * this.tempUx[3],
                            v0 * this.tempUy[0] + v1 * this.tempUy[1] + v2 * this.tempUy[2] + v3 * this.tempUy[3],
                            v0 * this.tempUr[0] + v1 * this.tempUr[1] + v2 * this.tempUr[2] + v3 * this.tempUr[3],
                            v0 * this.tempUg[0] + v1 * this.tempUg[1] + v2 * this.tempUg[2] + v3 * this.tempUg[3],
                            v0 * this.tempUb[0] + v1 * this.tempUb[1] + v2 * this.tempUb[2] + v3 * this.tempUb[3],
                            sX + v * invTH,
                            1 - sY - u * invTW
                        );
                    }
                }
            }
        }
        this.update();
    }
}

class GLTexture {
    constructor(gl, imageData) {
        this.gl = gl;
        this.tex = gl.createTexture();
        if (!this.tex) throw new Error('Failed to create texture');
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imageData);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
    }

    bind() {
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.tex);
    }

    dispose() {
        this.gl.deleteTexture(this.tex);
    }
}

export class AMLLMeshBackground {
    constructor(container) {
        this.container = container;
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'amll-bg-canvas';
        this.container.appendChild(this.canvas);

        this.gl = this.canvas.getContext('webgl', { antialias: true, alpha: true });
        this.fallbackContext = this.gl ? null : this.canvas.getContext('2d');
        this.reduceImageSizeCanvas = createWorkingCanvas(32, 32);
        this.fallbackTextureCanvas = createWorkingCanvas(32, 32);
        this.meshStates = [];
        this.fbo = null;
        this.fboTexture = null;
        this.quadBuffer = null;
        this.mainProgram = null;
        this.quadProgram = null;
        this.frameHandle = 0;
        this.isPlaying = false;
        this.disposed = false;
        this.lastFrameTime = performance.now();
        this.lastTickTime = 0;
        this.frameTime = 0;
        this.volume = 0;
        this.isNoCover = true;
        this.resizeObserver = null;
        this.lastFallbackImageData = null;
        this.onTickBound = this.onTick.bind(this);
        this.onResizeBound = this.resize.bind(this);

        if (this.gl) {
            this.setupGL();
        }

        if ('ResizeObserver' in window) {
            this.resizeObserver = new ResizeObserver(() => {
                this.resize();
            });
            this.resizeObserver.observe(this.container);
        }
        window.addEventListener('resize', this.onResizeBound);
        this.resize();
    }

    setupGL() {
        const gl = this.gl;
        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.ALWAYS);

        this.mainProgram = new GLProgram(gl, meshVertShader, meshFragShader, 'amll-mesh-main');
        this.quadProgram = new GLProgram(gl, quadVertShader, quadFragShader, 'amll-mesh-quad');
        this.quadBuffer = gl.createBuffer();
        if (!this.quadBuffer) throw new Error('Failed to create quad buffer');
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
        gl.bufferData(
            gl.ARRAY_BUFFER,
            new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
            gl.STATIC_DRAW
        );
    }

    resize() {
        const rect = this.container.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.round(rect.width * dpr));
        const height = Math.max(1, Math.round(rect.height * dpr));
        if (this.canvas.width === width && this.canvas.height === height) return;

        this.canvas.width = width;
        this.canvas.height = height;

        if (this.gl) {
            this.gl.viewport(0, 0, width, height);
            this.updateFBO(width, height);
            this.drawFrame(performance.now(), 16);
        } else {
            this.redrawFallback();
        }
    }

    updateFBO(width, height) {
        if (!this.gl) return;
        const gl = this.gl;
        if (this.fbo) gl.deleteFramebuffer(this.fbo);
        if (this.fboTexture) gl.deleteTexture(this.fboTexture);
        this.fboTexture = gl.createTexture();
        this.fbo = gl.createFramebuffer();
        if (!this.fboTexture || !this.fbo) throw new Error('Failed to create framebuffer resources');

        gl.bindTexture(gl.TEXTURE_2D, this.fboTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTexture, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    requestFrame() {
        if (this.disposed || this.frameHandle) return;
        this.frameHandle = requestAnimationFrame(this.onTickBound);
    }

    onTick(tickTime) {
        this.frameHandle = 0;
        if (this.disposed) return;
        const interval = 1000 / 60;
        const delta = tickTime - this.lastTickTime;
        if (delta < interval) {
            this.requestFrame();
            return;
        }
        if (Number.isNaN(this.lastFrameTime)) {
            this.lastFrameTime = tickTime;
        }
        const frameDelta = tickTime - this.lastFrameTime;
        this.lastFrameTime = tickTime;
        this.lastTickTime = tickTime - (delta % interval);
        if (this.isPlaying) {
            this.frameTime += frameDelta;
        }
        const canBeStatic = this.drawFrame(this.frameTime || tickTime, frameDelta);
        if (this.isPlaying || !canBeStatic) {
            this.requestFrame();
        } else {
            this.lastFrameTime = Number.NaN;
        }
    }

    drawFrame(tickTime, delta) {
        if (this.gl) {
            return this.drawWebGLFrame(tickTime, delta);
        }
        this.redrawFallback();
        return true;
    }

    drawWebGLFrame(tickTime, delta) {
        const gl = this.gl;
        const latestMeshState = this.meshStates[this.meshStates.length - 1];
        let canBeStatic = false;
        const deltaFactor = delta / 500;

        if (latestMeshState) {
            latestMeshState.mesh.bind();
            if (this.isNoCover) {
                let hasActiveStates = false;
                for (let index = this.meshStates.length - 1; index >= 0; index--) {
                    const state = this.meshStates[index];
                    if (state.alpha <= -0.1) {
                        state.mesh.dispose();
                        state.texture.dispose();
                        this.meshStates.splice(index, 1);
                    } else {
                        state.alpha = Math.max(-0.1, state.alpha - deltaFactor);
                        hasActiveStates = true;
                    }
                }
                canBeStatic = !hasActiveStates;
            } else {
                if (latestMeshState.alpha >= 1.1) {
                    const removed = this.meshStates.splice(0, this.meshStates.length - 1);
                    for (const state of removed) {
                        state.mesh.dispose();
                        state.texture.dispose();
                    }
                } else {
                    latestMeshState.alpha = Math.min(1.1, latestMeshState.alpha + deltaFactor);
                }
                canBeStatic = this.meshStates.length === 1 && latestMeshState.alpha >= 1.1 && !this.isPlaying;
            }
        } else {
            canBeStatic = true;
        }

        if (!this.fbo) return canBeStatic;

        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        for (const state of this.meshStates) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
            gl.disable(gl.BLEND);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            this.mainProgram.use();
            gl.activeTexture(gl.TEXTURE0);
            this.mainProgram.setUniform1f('u_time', tickTime / 10000);
            this.mainProgram.setUniform1f('u_aspect', this.canvas.width / this.canvas.height);
            this.mainProgram.setUniform1i('u_texture', 0);
            this.mainProgram.setUniform1f('u_volume', this.volume);
            this.mainProgram.setUniform1f('u_alpha', 1.0);
            state.texture.bind();
            state.mesh.bind();
            state.mesh.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.enable(gl.BLEND);
            gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            this.quadProgram.use();
            this.quadProgram.setUniform1i('u_texture', 0);
            this.quadProgram.setUniform1f('u_alpha', easeInOutSine(clamp(state.alpha, 0, 1)));
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.fboTexture);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
            const attrPos = this.quadProgram.attrs.a_pos;
            gl.vertexAttribPointer(attrPos, 2, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(attrPos);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            gl.disableVertexAttribArray(attrPos);
        }

        gl.flush();
        return canBeStatic;
    }

    getImageSize(source) {
        if (!source) return { width: 0, height: 0 };
        if (source instanceof HTMLVideoElement) {
            return { width: source.videoWidth, height: source.videoHeight };
        }
        if (source instanceof HTMLImageElement) {
            return { width: source.naturalWidth, height: source.naturalHeight };
        }
        return {
            width: source.width || 0,
            height: source.height || 0,
        };
    }

    preprocessAlbum(source) {
        const size = this.getImageSize(source);
        if (!size.width || !size.height) return null;
        const canvas = this.reduceImageSizeCanvas;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return null;

        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(source, 0, 0, size.width, size.height, 0, 0, canvas.width, canvas.height);
        const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
        const pixels = imageData.data;
        for (let index = 0; index < pixels.length; index += 4) {
            let r = pixels[index];
            let g = pixels[index + 1];
            let b = pixels[index + 2];
            r = (r - 128) * 0.4 + 128;
            g = (g - 128) * 0.4 + 128;
            b = (b - 128) * 0.4 + 128;
            const gray = r * 0.3 + g * 0.59 + b * 0.11;
            r = gray * -2 + r * 3;
            g = gray * -2 + g * 3;
            b = gray * -2 + b * 3;
            r = (r - 128) * 1.7 + 128;
            g = (g - 128) * 1.7 + 128;
            b = (b - 128) * 1.7 + 128;
            pixels[index] = clampByte(r * 0.75);
            pixels[index + 1] = clampByte(g * 0.75);
            pixels[index + 2] = clampByte(b * 0.75);
        }
        blurImage(imageData, 2, 4);
        return imageData;
    }

    redrawFallback() {
        if (!this.fallbackContext || !this.lastFallbackImageData) return;
        const textureCanvas = this.fallbackTextureCanvas;
        const textureContext = textureCanvas.getContext('2d');
        if (!textureContext) return;
        textureContext.putImageData(this.lastFallbackImageData, 0, 0);
        this.fallbackContext.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.fallbackContext.drawImage(textureCanvas, 0, 0, this.canvas.width, this.canvas.height);
    }

    async setAlbum(source) {
        if (!source) {
            this.isNoCover = true;
            this.requestFrame();
            return;
        }
        const imageData = this.preprocessAlbum(source);
        if (!imageData) {
            this.isNoCover = true;
            this.requestFrame();
            return;
        }
        this.isNoCover = false;

        if (!this.gl) {
            this.lastFallbackImageData = imageData;
            this.redrawFallback();
            return;
        }

        const newMesh = new BHPMesh(
            this.gl,
            this.mainProgram.attrs.a_pos,
            this.mainProgram.attrs.a_color,
            this.mainProgram.attrs.a_uv
        );
        newMesh.resetSubdivition(50);

        const chosenPreset = Math.random() > 0.8
            ? generateControlPoints(6, 6)
            : CONTROL_POINT_PRESETS[Math.floor(Math.random() * CONTROL_POINT_PRESETS.length)];

        newMesh.resizeControlPoints(chosenPreset.width, chosenPreset.height);
        const uPower = 2 / (chosenPreset.width - 1);
        const vPower = 2 / (chosenPreset.height - 1);
        for (const controlPoint of chosenPreset.conf) {
            const point = newMesh.getControlPoint(controlPoint.cx, controlPoint.cy);
            point.location.x = controlPoint.x;
            point.location.y = controlPoint.y;
            point.uRot = (controlPoint.ur * Math.PI) / 180;
            point.vRot = (controlPoint.vr * Math.PI) / 180;
            point.uScale = uPower * controlPoint.up;
            point.vScale = vPower * controlPoint.vp;
        }
        newMesh.updateMesh();
        this.meshStates.push({
            mesh: newMesh,
            texture: new GLTexture(this.gl, imageData),
            alpha: 0,
        });
        this.drawFrame(performance.now(), 16);
        this.requestFrame();
    }

    setLowFreqVolume(volume) {
        this.volume = clamp(Number(volume) || 0, 0, 10) / 10;
        if (this.isPlaying) {
            this.requestFrame();
        }
    }

    play() {
        if (this.isPlaying) return;
        this.isPlaying = true;
        this.lastFrameTime = performance.now();
        this.requestFrame();
    }

    pause() {
        this.isPlaying = false;
        if (!this.meshStates.length || (this.meshStates.length === 1 && this.meshStates[0].alpha >= 1.1)) {
            if (this.frameHandle) {
                cancelAnimationFrame(this.frameHandle);
                this.frameHandle = 0;
            }
        }
    }

    dispose() {
        this.disposed = true;
        if (this.frameHandle) {
            cancelAnimationFrame(this.frameHandle);
            this.frameHandle = 0;
        }
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        window.removeEventListener('resize', this.onResizeBound);
        if (this.gl) {
            for (const state of this.meshStates) {
                state.mesh.dispose();
                state.texture.dispose();
            }
            if (this.mainProgram) this.mainProgram.dispose();
            if (this.quadProgram) this.quadProgram.dispose();
            if (this.quadBuffer) this.gl.deleteBuffer(this.quadBuffer);
            if (this.fbo) this.gl.deleteFramebuffer(this.fbo);
            if (this.fboTexture) this.gl.deleteTexture(this.fboTexture);
        }
        this.meshStates = [];
        if (this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
    }
}
