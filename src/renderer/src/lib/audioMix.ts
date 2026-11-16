// One mixer for the lanes' videos (Sweep, Pass), so several can play their
// sound at once without clipping. Each video's sound goes through its own
// gain into a shared master: the Settings volume, then a limiter. While
// more than one is audible, each is turned down by 1 / √(how many), so the
// sum stays near one file's level; the limiter catches what peaks above.
//
// A video joins with attach() (it must have crossOrigin set before its src
// loads, or Web Audio hears silence) and is then heard only through here:
// its own volume stays at 1 and audible / not is its gain.

const RAMP_S = 0.06; // gain changes ease in, so there are no clicks

interface Source {
    node: MediaElementAudioSourceNode;
    gain: GainNode;
    audible: boolean;
}

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let failed = false;
// In the mix now.
const sources = new Map<HTMLMediaElement, Source>();
// Every element ever routed, for its lifetime: a browser lets an element's
// sound be taken only once, and once taken it's heard nowhere else. So the
// route is kept and only unplugged from the mix (e.g. React's strict mode
// mounts, unmounts and mounts again; taking it twice would leave silence).
const routes = new WeakMap<HTMLMediaElement, Source>();
let masterVolume = 1;

function graph(): { ctx: AudioContext; master: GainNode } | null {
    if (failed) return null;
    if (ctx && master) return { ctx, master };
    try {
        ctx = new AudioContext();
        master = ctx.createGain();
        master.gain.value = away ? 0 : masterVolume;
        // A limiter: hard knee, high ratio, fast attack, just under 0 dBFS.
        const limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -3;
        limiter.knee.value = 0;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.003;
        limiter.release.value = 0.25;
        master.connect(limiter);
        limiter.connect(ctx.destination);
        // Started suspended without a gesture: any key or click wakes it.
        const wake = () => {
            if (ctx?.state === "suspended") ctx.resume().catch(() => {});
        };
        window.addEventListener("keydown", wake, true);
        window.addEventListener("mousedown", wake, true);
        return { ctx, master };
    } catch (err) {
        console.error("Audio mixer unavailable:", err);
        failed = true;
        return null;
    }
}

function rebalance(): void {
    const g = graph();
    if (!g) return;
    let n = 0;
    for (const s of sources.values()) if (s.audible) n++;
    const share = n > 1 ? 1 / Math.sqrt(n) : 1;
    for (const s of sources.values()) {
        s.gain.gain.setTargetAtTime(s.audible ? share : 0, g.ctx.currentTime, RAMP_S / 3);
    }
}

/** Routes a video's sound through the mixer. False if the mixer isn't
 *  available (the caller falls back to the element's own volume). */
export function attach(el: HTMLMediaElement): boolean {
    if (sources.has(el)) return true;
    const g = graph();
    if (!g) return false;
    if (g.ctx.state === "suspended") g.ctx.resume().catch(() => {});
    const known = routes.get(el);
    if (known) {
        known.audible = false;
        // (A plain .value is ignored while ramps are scheduled.)
        known.gain.gain.cancelScheduledValues(g.ctx.currentTime);
        known.gain.gain.setValueAtTime(0, g.ctx.currentTime);
        known.gain.connect(g.master);
        sources.set(el, known);
        return true;
    }
    try {
        const node = g.ctx.createMediaElementSource(el);
        const gain = g.ctx.createGain();
        gain.gain.value = 0;
        node.connect(gain);
        gain.connect(g.master);
        el.volume = 1;
        const src = { node, gain, audible: false };
        routes.set(el, src);
        sources.set(el, src);
        return true;
    } catch (err) {
        // e.g. this element was already given to another source.
        console.error("Couldn't route video audio:", err);
        return false;
    }
}

/** Takes a video out of the mix (its route is kept, see `routes`). */
export function detach(el: HTMLMediaElement): void {
    const s = sources.get(el);
    if (!s) return;
    s.gain.disconnect();
    s.audible = false;
    sources.delete(el);
    rebalance();
}

export function setAudible(el: HTMLMediaElement, audible: boolean): void {
    const s = sources.get(el);
    if (!s || s.audible === audible) return;
    s.audible = audible;
    rebalance();
}

// The window in the background (with "pause when unfocused" on): the lanes'
// videos keep playing, only their sound goes.
let away = false;

function applyMaster(): void {
    if (master && ctx) master.gain.setTargetAtTime(away ? 0 : masterVolume, ctx.currentTime, RAMP_S / 3);
}

/** The Settings volume (0–1, already curved). */
export function setMasterVolume(v: number): void {
    masterVolume = v;
    applyMaster();
}

/** Silences (or brings back) everything in the mix, without pausing. */
export function setAway(on: boolean): void {
    away = on;
    applyMaster();
}

/** Whether a video's sound is in the mixer (so it's silenced, not paused,
 *  when the window goes to the background). */
export function isMixed(el: HTMLMediaElement): boolean {
    return sources.has(el);
}
