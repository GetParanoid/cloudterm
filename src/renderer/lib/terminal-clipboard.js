/** Clipboard actions read xterm's selection, which is separate from DOM selection. */
export function createTerminalClipboardHandlers({ getTerminal, clipboard, isMac = false, onError }) {
    const copy = async () => {
        // Snapshot before IPC or a focus change can alter the selection.
        const text = getTerminal()?.getSelection();
        if (!text) return false;
        try {
            await clipboard.writeText(text);
            return true;
        } catch {
            onError('Could not copy terminal selection');
            return false;
        }
    };

    const paste = async () => {
        const term = getTerminal();
        if (!term) return;
        try {
            const text = await clipboard.readText();
            // Do not deliver a pending paste to a replacement session.
            if (text && getTerminal() === term) term.paste(text);
        } catch {
            onError('Could not paste from clipboard');
        }
    };

    const handleKeyEvent = (event) => {
        if (event.type !== 'keydown' || event.altKey || event.isComposing) return true;
        const control = event.ctrlKey && !event.metaKey;
        const command = isMac && event.metaKey && !event.ctrlKey;
        const copyKey = event.code === 'KeyC' || event.key?.toLowerCase() === 'c';
        const pasteKey = event.code === 'KeyV' || event.key?.toLowerCase() === 'v';

        if (copyKey && (command || (control && (event.shiftKey || getTerminal()?.hasSelection())))) {
            event.preventDefault();
            event.stopPropagation();
            void copy();
            return false;
        }
        if (pasteKey && (command || (control && event.shiftKey))) {
            // Suppress Chromium's native paste so text reaches the shell once.
            event.preventDefault();
            event.stopPropagation();
            void paste();
            return false;
        }
        // In particular, Ctrl+C without a selection remains a shell interrupt.
        return true;
    };

    const handleContextMenu = (event) => {
        event.preventDefault();
        if (getTerminal()?.hasSelection()) void copy();
        else void paste();
    };

    return { copy, paste, handleKeyEvent, handleContextMenu };
}
