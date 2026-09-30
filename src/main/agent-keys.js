/**
 * Which of the agent's keys a host offers.
 *
 * Kept free of dependencies for the same reason as `host-tags.js`, so the
 * store, the connection layer and the tests agree on one record shape without
 * requiring each other.
 *
 * A host picks keys by fingerprint, never by anything secret: the private
 * halves stay in the agent, which is the whole point of using one. The comment
 * is kept beside it for display only, so a pick can still be named while the
 * agent is locked and cannot say what the fingerprint belongs to.
 *
 * An empty list means "offer every key", which is how every host behaved
 * before this existed.
 */

/** An OpenSSH SHA256 fingerprint: the prefix and unpadded base64. */
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;

/** Well past any real use; a host is meant to name the one or two it uses. */
const MAX_AGENT_KEYS = 16;

const MAX_COMMENT_LENGTH = 128;

/**
 * A pick list from whatever the record held. Order is kept, since it is the
 * order the keys are offered in; duplicates keep their first place.
 */
function normalizeAgentKeys(raw) {
    if (!Array.isArray(raw)) return [];

    const seen = new Set();
    const keys = [];
    for (const entry of raw) {
        const print = String((typeof entry === 'string' ? entry : entry?.fingerprint) ?? '').trim();
        if (!FINGERPRINT.test(print) || seen.has(print)) continue;
        seen.add(print);
        keys.push({
            fingerprint: print,
            comment: typeof entry?.comment === 'string' ? entry.comment.trim().slice(0, MAX_COMMENT_LENGTH) : '',
        });
    }

    return keys.slice(0, MAX_AGENT_KEYS);
}

module.exports = {
    MAX_AGENT_KEYS,
    normalizeAgentKeys,
};
