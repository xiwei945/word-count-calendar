import { App, Modal } from 'obsidian';

export class ConfirmationModal extends Modal {
    private settled = false;
    private resolveDecision: ((confirmed: boolean) => void) | null = null;

    constructor(
        app: App,
        private readonly title: string,
        private readonly message: string,
        private readonly confirmLabel: string
    ) {
        super(app);
    }

    waitForDecision(): Promise<boolean> {
        return new Promise(resolve => {
            this.resolveDecision = resolve;
            this.open();
        });
    }

    onOpen(): void {
        this.titleEl.setText(this.title);
        this.contentEl.empty();
        this.contentEl.createEl('p', { text: this.message });

        const actions = this.contentEl.createDiv({ cls: 'word-count-calendar-confirm-actions' });
        const cancel = actions.createEl('button', { text: '取消' });
        cancel.addEventListener('click', () => this.decide(false));

        const confirm = actions.createEl('button', {
            text: this.confirmLabel,
            cls: 'mod-warning'
        });
        confirm.addEventListener('click', () => this.decide(true));
        cancel.focus();
    }

    onClose(): void {
        if (!this.settled) {
            this.settled = true;
            this.resolveDecision?.(false);
        }
        this.contentEl.empty();
    }

    private decide(confirmed: boolean): void {
        if (this.settled) return;
        this.settled = true;
        this.resolveDecision?.(confirmed);
        this.close();
    }
}
