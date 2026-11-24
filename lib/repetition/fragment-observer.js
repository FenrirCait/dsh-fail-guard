// Observation only. Text buffers are bounded, per request, and never exported.
export const LIMITS = Object.freeze({ blocks: 64, line: 256, window: 12, minFragments: 8 });
const short = /^[\p{L}][\p{L}]?[\p{L}]?[\p{L}]?[。.!！?？]?$/u;
const inline = /([\p{L}]{1,3}[。.!！?？])\s*/uy;
const fence = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/u;
const closeFence = /^[ \t]*$/u;
/** Forward every frame as received. Emit at most one metadata-only report per source. */
export async function* observeFragments(source, onSignal) {
    const blocks = new Map();
    const window = [];
    let enabled = true;
    const stop = () => {
        enabled = false;
        blocks.clear();
        window.length = 0;
    };
    const signal = (event) => {
        stop();
        try {
            onSignal(Object.freeze(event));
        }
        catch { /* Observability cannot change the stream. */ }
    };
    const progress = () => {
        window.length = 0;
        // Do not carry a partial reasoning line through visible progress.
        for (const state of blocks.values()) {
            if (state.pending)
                state.skipLine = true;
        }
    };
    const line = (raw, state) => {
        const marker = fence.exec(raw);
        if (state.fence) {
            if (marker && marker[1][0] === state.fence.char && marker[1].length >= state.fence.length && closeFence.test(marker[2]))
                state.fence = null;
            return;
        }
        if (marker) {
            state.fence = { char: marker[1][0], length: marker[1].length };
            window.length = 0;
            return;
        }
        if (state.skipLine)
            return;
        const value = raw.trim();
        if (!value)
            return;
        // Exclude formatting instead of treating it as repetition evidence.
        if (/^(?:[-*+]\s|\d{1,3}[.)]\s|[|>#]|\[[ xX]\]|[~`])/u.test(value) || value.includes('|')) {
            window.length = 0;
            return;
        }
        const distinctUnits = new Set();
        let pos = 0;
        let units = 0;
        // Walk a bounded line from the beginning, never search arbitrary substrings.
        while (pos < value.length) {
            inline.lastIndex = pos;
            const m = inline.exec(value);
            if (!m)
                break;
            pos = inline.lastIndex;
            units++;
            distinctUnits.add(m[1]);
            if (distinctUnits.size > 3)
                break;
        }
        if (pos === value.length && units >= LIMITS.minFragments && distinctUnits.size <= 3 && 2 * distinctUnits.size <= units) {
            signal({ rule: 'inline-fragments', fragments: units, distinct: distinctUnits.size });
            return;
        }
        window.push(value.length <= 4 && short.test(value) ? value : null);
        if (window.length > LIMITS.window)
            window.shift();
        const fragments = window.filter(x => x !== null);
        const distinct = new Set(fragments).size;
        if (fragments.length >= LIMITS.minFragments && 4 * fragments.length >= 3 * window.length && distinct <= 3 && 2 * distinct <= fragments.length) {
            signal({ rule: 'fragment-window', fragments: fragments.length, distinct, lines: window.length });
        }
    };
    const feed = (text, state) => {
        let start = 0;
        while (enabled && start < text.length) {
            const end = text.indexOf('\n', start);
            const length = (end < 0 ? text.length : end) - start;
            // An overlong line might open a fence: stop observing rather than flag code.
            if (state.pending.length + length > LIMITS.line) {
                stop();
                return;
            }
            state.pending += text.slice(start, start + length);
            if (end < 0)
                break;
            flush(state);
            start = end + 1;
        }
    };
    const flush = (state) => {
        if (state.pending.length)
            line(state.pending.replace(/\r$/u, ''), state);
        state.pending = '';
        state.skipLine = false;
    };
    for await (const frame of source) {
        if (enabled) {
            if (frame.type === 'block-start' && frame.blockType === 'reasoning') {
                if (blocks.size >= LIMITS.blocks || blocks.has(frame.index))
                    stop();
                else
                    blocks.set(frame.index, { pending: '', skipLine: false, fence: null });
            }
            else if (frame.type === 'reasoning-delta') {
                const state = blocks.get(frame.index);
                if (state)
                    feed(frame.text, state);
            }
            else if (frame.type === 'block-end') {
                const state = blocks.get(frame.index);
                if (state) {
                    flush(state);
                    blocks.delete(frame.index);
                }
            }
            else if (frame.type === 'finish')
                stop();
            else if (frame.type === 'block-start' || frame.type === 'text-delta' || frame.type === 'tool-call-delta')
                progress();
        }
        yield frame;
    }
}
