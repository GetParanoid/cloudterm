import { useEffect, useState } from 'react';

/**
 * Samples a pane's server for the resource bar underneath it.
 *
 * The pane asks, not main, because only the pane knows whether anyone is
 * looking: a background tab, the file browser, or a minimised window each
 * pause it. A pause keeps the last reading on screen rather than blanking it.
 *
 * Ticks are a timeout chain rather than an interval, so a slow server delays
 * the next sample instead of stacking requests behind it.
 */

const INTERVAL = 2000;

/** Sixty seconds of graph at one sample per interval. */
export const CPU_HISTORY = 60000 / INTERVAL;

/** After this many failures in a row, ask less often until one succeeds. */
const FAILURE_LIMIT = 3;
const BACKOFF = 10000;

const EMPTY = { latest: null, history: [], unsupported: false };

export function useResourceStats({ paneId, enabled, live }) {
    const [state, setState] = useState(EMPTY);
    const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');

    useEffect(() => {
        const update = () => setVisible(document.visibilityState !== 'hidden');
        document.addEventListener('visibilitychange', update);
        return () => document.removeEventListener('visibilitychange', update);
    }, []);

    // A dropped connection ends the graph: the next one may be a rebooted
    // server, and a line joining the two would draw a minute that never
    // happened. The last reading stays, dimmed by the bar, until a new one
    // arrives. "Unsupported" is forgotten too, since the host can change under
    // a pane when the host record is edited.
    useEffect(() => {
        if (!live) {
            setState(current => (current.history.length || current.unsupported
                ? { ...current, history: [], unsupported: false }
                : current));
        }
    }, [live]);

    const running = Boolean(enabled && live && visible && !state.unsupported && window.api?.stats);

    useEffect(() => {
        if (!running) return undefined;

        let cancelled = false;
        let timer = null;
        let failures = 0;

        const tick = async () => {
            let result;
            try {
                result = await window.api.stats.sample(paneId);
            } catch (error) {
                result = { success: false, message: error?.message };
            }
            if (cancelled) return;

            if (result?.success) {
                failures = 0;
                if (!result.supported) {
                    // Nothing to poll for; the effect stops on this state.
                    setState(current => ({ ...current, latest: result, unsupported: true }));
                    return;
                }
                setState(current => ({
                    latest: result,
                    history: typeof result.cpu === 'number'
                        ? [...current.history, result.cpu].slice(-CPU_HISTORY)
                        : current.history,
                    unsupported: false,
                }));
            } else {
                failures++;
            }

            timer = setTimeout(tick, failures >= FAILURE_LIMIT ? BACKOFF : INTERVAL);
        };

        tick();
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
    }, [running, paneId]);

    return state;
}
