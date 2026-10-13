/**
 * Marker-comment regions: the generator's surgical seam. Hand-authored
 * preamble outside the markers is never touched; only the region body is
 * replaced (spec §3 Layer 1).
 */
const start = (name) => `<!-- GENERATED:${name} START -->`;
const end = (name) => `<!-- GENERATED:${name} END -->`;

function locate(text, name) {
    const s = text.indexOf(start(name));
    const e = text.indexOf(end(name));
    if (s === -1 || e === -1 || e < s) {
        throw new Error(`markers for region "${name}" not found (need "${start(name)}" … "${end(name)}")`);
    }
    return { s, e, startLen: start(name).length };
}

/** @returns {string} the body between the named markers */
export function extractRegion(text, name) {
    const { s, e, startLen } = locate(text, name);
    return text.slice(s + startLen, e);
}

/** @returns {string} text with the named region's body replaced by `body` */
export function replaceRegion(text, name, body) {
    const { s, e, startLen } = locate(text, name);
    return text.slice(0, s + startLen) + '\n' + body.trim() + '\n' + text.slice(e);
}
