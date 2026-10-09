const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function run() {
    const source = fs.readFileSync(path.join(__dirname, '../src/renderer/lib/terminal-clipboard.js'), 'utf8');
    const { createTerminalClipboardHandlers } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    let selection = 'first line\nsecond line\t雪';
    const writes = [];
    const pastes = [];
    const errors = [];
    const term = { getSelection: () => selection, hasSelection: () => !!selection, paste: text => pastes.push(text) };
    let current = term;
    let read = async () => 'echo hello\n';
    const clipboard = { writeText: async text => writes.push(text), readText: () => read() };
    const handlers = createTerminalClipboardHandlers({
        getTerminal: () => current, clipboard, onError: message => errors.push(message),
    });
    const event = (code, modifiers = {}) => ({
        type: 'keydown', code, ctrlKey: true, ...modifiers,
        prevented: 0, stopped: 0,
        preventDefault() { this.prevented++; },
        stopPropagation() { this.stopped++; },
    });
    const key = event('KeyC');
    assert.strictEqual(handlers.handleKeyEvent(key), false, 'selected Ctrl+C must not reach the shell');
    assert.strictEqual(key.prevented, 1, 'native copy must not overwrite the IPC copy');
    assert.strictEqual(key.stopped, 1);
    assert.deepStrictEqual(writes, [selection], 'multiline, tabs and Unicode are preserved');
    assert.strictEqual(selection, 'first line\nsecond line\t雪', 'copy keeps the selection');

    selection = '';
    const interrupt = event('KeyC');
    assert.strictEqual(handlers.handleKeyEvent(interrupt), true, 'unselected Ctrl+C remains SIGINT');
    assert.strictEqual(interrupt.prevented, 0);
    assert.strictEqual(handlers.handleKeyEvent(event('KeyC', { shiftKey: true })), false);
    assert.strictEqual(writes.length, 1, 'empty selections must not erase the clipboard');

    selection = 'selected output';
    handlers.handleContextMenu(event());
    assert.strictEqual(writes.at(-1), selection, 'right-click copies selected output');
    assert.strictEqual(pastes.length, 0, 'right-click must not execute clipboard contents over a selection');
    selection = '';
    handlers.handleContextMenu(event());
    await new Promise(setImmediate);
    assert.deepStrictEqual(pastes, ['echo hello\n'], 'unselected right-click pastes using xterm.paste');

    const pasteKey = event('KeyV', { shiftKey: true });
    assert.strictEqual(handlers.handleKeyEvent(pasteKey), false);
    await new Promise(setImmediate);
    assert.strictEqual(pasteKey.prevented, 1, 'native paste is suppressed to prevent duplicate input');
    assert.strictEqual(pastes.length, 2);
    assert.strictEqual(handlers.handleKeyEvent(event('KeyV')), true, 'ordinary paste stays with xterm');

    selection = 'copy me';
    for (const modifiers of [{ altKey: true }, { type: 'keyup' }, { type: 'keypress' }, { isComposing: true }, { metaKey: true }]) {
        assert.strictEqual(handlers.handleKeyEvent(event('KeyC', modifiers)), true);
    }
    assert.strictEqual(handlers.handleKeyEvent(event('KeyF', { shiftKey: true })), true, 'find is handled by the terminal view');
    assert.strictEqual(handlers.handleKeyEvent(event('', { key: 'c' })), false, 'key fallback supports events without a code');

    const mac = createTerminalClipboardHandlers({ getTerminal: () => current, clipboard, isMac: true, onError: message => errors.push(message) });
    assert.strictEqual(mac.handleKeyEvent(event('KeyC', { ctrlKey: false, metaKey: true })), false, 'Cmd+C copies on Mac');
    assert.strictEqual(writes.at(-1), selection);
    assert.strictEqual(mac.handleKeyEvent(event('KeyV', { ctrlKey: false, metaKey: true })), false, 'Cmd+V pastes on Mac');
    await new Promise(setImmediate);

    let finishRead;
    read = () => new Promise(resolve => { finishRead = resolve; });
    const pending = handlers.paste();
    current = { ...term };
    finishRead('stale clipboard');
    const before = pastes.length;
    await pending;
    assert.strictEqual(pastes.length, before, 'pending paste cannot leak into a replacement session');
    current = term;

    clipboard.writeText = async () => { throw new Error('clipboard unavailable'); };
    assert.strictEqual(await handlers.copy(), false);
    read = async () => { throw new Error('clipboard unavailable'); };
    await handlers.paste();
    assert.deepStrictEqual(errors, ['Could not copy terminal selection', 'Could not paste from clipboard']);
    current = null;
    assert.strictEqual(await handlers.copy(), false);
    await handlers.paste();
    console.log('Terminal clipboard regression tests passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
