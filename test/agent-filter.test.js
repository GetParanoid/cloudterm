/**
 * Offering only some agent keys: the filtering agent a host with picked keys
 * connects through, and what a stored pick list normalises to.
 *
 * The agent under the filter is a fake holding three real ed25519 keys, so the
 * fingerprints are computed the same way a live agent's would be.
 */
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const { BaseAgent, utils: { generateKeyPairSync, parseKey } } = require('ssh2');

const { filteredAgent } = require(path.join(__dirname, '..', 'src', 'main', 'agent.js'));
const { normalizeAgentKeys, MAX_AGENT_KEYS } = require(path.join(__dirname, '..', 'src', 'main', 'agent-keys.js'));

let passed = 0;
const check = (label, fn) => {
    try {
        fn();
        console.log(`  ok   ${label}`);
        passed++;
    } catch (error) {
        console.log(`  FAIL ${label}`);
        console.log(`       ${error.message}`);
        process.exitCode = 1;
    }
};

const fingerprint = (key) =>
    'SHA256:' + crypto.createHash('sha256').update(key.getPublicSSH()).digest('base64').replace(/=+$/, '');

const keys = ['alpha', 'bravo', 'charlie'].map(comment => {
    const key = parseKey(generateKeyPairSync('ed25519', { comment }).public);
    return Object.assign(key, { comment });
});
const [alpha, bravo, charlie] = keys;

/** An agent holding `keys`, answering synchronously and recording what it was asked. */
function fakeAgent({ withStream = true } = {}) {
    const calls = [];
    const agent = new class extends BaseAgent {
        getIdentities(callback) {
            callback(null, keys);
        }

        sign(pubKey, data, options, callback) {
            calls.push({ pubKey, data, options, callback });
            (typeof options === 'function' ? options : callback)(null, Buffer.from('signed'));
        }
    }();
    if (withStream) agent.getStream = (callback) => callback(null, 'the real agent');
    return { agent, calls };
}

const identities = (agent) => {
    let result;
    agent.getIdentities((error, list) => {
        if (error) throw error;
        result = list;
    });
    return result;
};

/* ---------------- filtering ---------------- */

console.log('\nfiltered agent');

check('offers only the picked keys', () => {
    const { agent } = fakeAgent();
    const offered = identities(filteredAgent(agent, [fingerprint(bravo)]));
    assert.deepStrictEqual(offered, [bravo]);
});

check('offers them in the order picked, not the agent order', () => {
    const { agent } = fakeAgent();
    const offered = identities(filteredAgent(agent, [fingerprint(charlie), fingerprint(alpha)]));
    assert.deepStrictEqual(offered, [charlie, alpha]);
});

check('a pick the agent is not holding is skipped, not an error', () => {
    const { agent } = fakeAgent();
    const offered = identities(filteredAgent(agent, ['SHA256:' + 'A'.repeat(43), fingerprint(alpha)]));
    assert.deepStrictEqual(offered, [alpha]);
});

check('an agent error is passed through', () => {
    const failing = new class extends BaseAgent {
        getIdentities(callback) { callback(new Error('locked')); }
    }();
    let seen;
    filteredAgent(failing, [fingerprint(alpha)]).getIdentities((error) => { seen = error; });
    assert.strictEqual(seen?.message, 'locked');
});

check('is an ssh2 agent, so config.agent accepts it', () => {
    assert.ok(filteredAgent(fakeAgent().agent, []) instanceof BaseAgent);
});

/* ---------------- delegation ---------------- */

console.log('\ndelegation');

check('sign goes to the real agent with the same arguments', () => {
    const { agent, calls } = fakeAgent();
    const data = Buffer.from('payload');
    const options = { hash: 'sha512' };
    let signature;
    filteredAgent(agent, [fingerprint(alpha)]).sign(alpha, data, options, (error, sig) => { signature = sig; });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].pubKey, alpha);
    assert.strictEqual(calls[0].data, data);
    assert.strictEqual(calls[0].options, options);
    assert.strictEqual(String(signature), 'signed');
});

check('sign without options still reaches the callback', () => {
    const { agent } = fakeAgent();
    let signature;
    filteredAgent(agent, [fingerprint(alpha)]).sign(alpha, Buffer.from('x'), (error, sig) => { signature = sig; });
    assert.strictEqual(String(signature), 'signed');
});

check('forwarding hands over the real agent, unfiltered', () => {
    const filtered = filteredAgent(fakeAgent().agent, [fingerprint(alpha)]);
    let stream;
    filtered.getStream((error, value) => { stream = value; });
    assert.strictEqual(stream, 'the real agent');
});

check('no getStream when the real agent cannot be forwarded', () => {
    const filtered = filteredAgent(fakeAgent({ withStream: false }).agent, [fingerprint(alpha)]);
    assert.strictEqual(typeof filtered.getStream, 'undefined');
});

/* ---------------- stored picks ---------------- */

console.log('\nstored pick list');

check('keeps fingerprint and comment, in order', () => {
    const list = normalizeAgentKeys([
        { fingerprint: fingerprint(bravo), comment: ' bravo ' },
        { fingerprint: fingerprint(alpha), comment: 'alpha' },
    ]);
    assert.deepStrictEqual(list, [
        { fingerprint: fingerprint(bravo), comment: 'bravo' },
        { fingerprint: fingerprint(alpha), comment: 'alpha' },
    ]);
});

check('accepts bare fingerprint strings', () => {
    assert.deepStrictEqual(normalizeAgentKeys([fingerprint(alpha)]), [{ fingerprint: fingerprint(alpha), comment: '' }]);
});

check('drops malformed entries and duplicates', () => {
    const list = normalizeAgentKeys([
        'MD5:aa:bb',
        { fingerprint: 'SHA256:short' },
        null,
        42,
        { fingerprint: fingerprint(alpha) },
        { fingerprint: fingerprint(alpha), comment: 'again' },
    ]);
    assert.deepStrictEqual(list.map(key => key.fingerprint), [fingerprint(alpha)]);
});

check('anything but an array is no picks', () => {
    assert.deepStrictEqual(normalizeAgentKeys(undefined), []);
    assert.deepStrictEqual(normalizeAgentKeys('SHA256:x'), []);
    assert.deepStrictEqual(normalizeAgentKeys({}), []);
});

check(`caps the list at ${MAX_AGENT_KEYS}`, () => {
    const many = Array.from({ length: MAX_AGENT_KEYS + 5 }, (_, index) =>
        'SHA256:' + crypto.createHash('sha256').update(String(index)).digest('base64').replace(/=+$/, ''));
    assert.strictEqual(normalizeAgentKeys(many).length, MAX_AGENT_KEYS);
});

console.log(`\n${passed} passed${process.exitCode ? ', with failures' : ''}\n`);
