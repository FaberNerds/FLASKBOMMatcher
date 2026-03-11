/**
 * Modal Dialog System
 * Provides customizable modal dialogs to replace native alerts/confirms/prompts
 */

class ModalManager {
    constructor() {
        this.activeModals = new Set();
        this.setupKeyboardHandlers();
    }

    /**
     * Sets up global keyboard handlers for modals
     */
    setupKeyboardHandlers() {
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.activeModals.size > 0) {
                // Close the most recently opened modal
                const modal = Array.from(this.activeModals).pop();
                if (modal && modal.closeOnEscape) {
                    modal.reject();
                }
            }
        });
    }

    /**
     * Shows a confirmation dialog
     * @param {Object} options - Dialog options
     * @returns {Promise<boolean>} True if confirmed, false if cancelled
     */
    confirm(options) {
        const {
            title = 'Confirm',
            message = 'Are you sure?',
            confirmText = 'Confirm',
            cancelText = 'Cancel',
            type = 'info', // info, danger, warning
            closeOnEscape = true
        } = options;

        return new Promise((resolve, reject) => {
            const modal = this.createModal({
                title,
                content: `<p style="margin: 0; color: var(--text-main);">${this.escapeHtml(message)}</p>`,
                buttons: [
                    {
                        text: cancelText,
                        class: 'btn btn-outline',
                        onClick: () => {
                            this.closeModal(modalContext);
                            resolve(false);
                        }
                    },
                    {
                        text: confirmText,
                        class: `btn ${type === 'danger' ? 'btn-danger' : 'btn-primary'}`,
                        onClick: () => {
                            this.closeModal(modalContext);
                            resolve(true);
                        }
                    }
                ],
                size: 'small'
            });

            const modalContext = {
                element: modal,
                closeOnEscape,
                reject: () => {
                    this.closeModal(modalContext);
                    resolve(false);
                }
            };

            this.showModal(modalContext);
        });
    }

    /**
     * Shows a prompt dialog for text input
     * @param {Object} options - Dialog options
     * @returns {Promise<string|null>} Input value or null if cancelled
     */
    prompt(options) {
        const {
            title = 'Input Required',
            message = 'Please enter a value:',
            defaultValue = '',
            placeholder = '',
            confirmText = 'Confirm',
            cancelText = 'Cancel',
            validator = null,
            closeOnEscape = true
        } = options;

        return new Promise((resolve, reject) => {
            const inputId = 'modal-input-' + Date.now();
            const content = `
                <p style="margin: 0 0 16px; color: var(--text-main);">${this.escapeHtml(message)}</p>
                <input 
                    type="text" 
                    class="form-input" 
                    id="${inputId}"
                    value="${this.escapeHtml(defaultValue)}"
                    placeholder="${this.escapeHtml(placeholder)}"
                    style="width: 100%;"
                />
                <div id="${inputId}-error" class="form-error" style="color: var(--color-danger); font-size: 12px; margin-top: 4px; display: none;"></div>
            `;

            const modal = this.createModal({
                title,
                content,
                buttons: [
                    {
                        text: cancelText,
                        class: 'btn btn-outline',
                        onClick: () => {
                            this.closeModal(modalContext);
                            resolve(null);
                        }
                    },
                    {
                        text: confirmText,
                        class: 'btn btn-primary',
                        onClick: () => {
                            const input = modal.querySelector(`#${inputId}`);
                            const value = input.value.trim();
                            const errorEl = modal.querySelector(`#${inputId}-error`);

                            // Validate if validator provided
                            if (validator) {
                                const validationResult = validator(value);
                                if (validationResult !== true) {
                                    errorEl.textContent = validationResult || 'Invalid input';
                                    errorEl.style.display = 'block';
                                    input.focus();
                                    return;
                                }
                            }

                            this.closeModal(modalContext);
                            resolve(value);
                        }
                    }
                ],
                size: 'small'
            });

            const modalContext = {
                element: modal,
                closeOnEscape,
                reject: () => {
                    this.closeModal(modalContext);
                    resolve(null);
                }
            };

            this.showModal(modalContext);

            // Focus and select input
            setTimeout(() => {
                const input = modal.querySelector(`#${inputId}`);
                if (input) {
                    input.focus();
                    input.select();

                    // Submit on Enter key
                    input.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter') {
                            modal.querySelector('.btn-primary').click();
                        }
                    });
                }
            }, 100);
        });
    }

    /**
     * Shows an alert dialog
     * @param {Object} options - Dialog options
     * @returns {Promise<void>}
     */
    alert(options) {
        const {
            title = 'Alert',
            message = '',
            type = 'info',
            confirmText = 'OK'
        } = options;

        return new Promise((resolve) => {
            const modal = this.createModal({
                title,
                content: `<p style="margin: 0; color: var(--text-main);">${this.escapeHtml(message)}</p>`,
                buttons: [
                    {
                        text: confirmText,
                        class: 'btn btn-primary',
                        onClick: () => {
                            this.closeModal(modalContext);
                            resolve();
                        }
                    }
                ],
                size: 'small'
            });

            const modalContext = {
                element: modal,
                closeOnEscape: true,
                reject: () => {
                    this.closeModal(modalContext);
                    resolve();
                }
            };

            this.showModal(modalContext);
        });
    }

    /**
     * Creates a modal element
     * @param {Object} config - Modal configuration
     * @returns {HTMLElement} Modal overlay element
     */
    createModal(config) {
        const {
            title,
            subtitle = '',
            content,
            buttons = [],
            size = 'medium'
        } = config;

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';

        const modal = document.createElement('div');
        modal.className = `modal modal-${size}`;

        let html = `
            <div class="modal-header">
                <h3 class="modal-title">${this.escapeHtml(title)}</h3>
                ${subtitle ? `<p class="modal-subtitle">${this.escapeHtml(subtitle)}</p>` : ''}
            </div>
            <div class="modal-body">
                ${content}
            </div>
        `;

        if (buttons.length > 0) {
            html += '<div class="modal-footer">';
            const timestamp = Date.now();  // Capture timestamp once
            buttons.forEach((btn, index) => {
                const btnId = `modal-btn-${timestamp}-${index}`;
                btn._btnId = btnId;  // Store ID on button config for handler attachment
                html += `<button id="${btnId}" class="${btn.class}">${this.escapeHtml(btn.text)}</button>`;
            });
            html += '</div>';
        }

        modal.innerHTML = html;

        // Attach button handlers
        buttons.forEach((btn, index) => {
            setTimeout(() => {
                const btnEl = modal.querySelector(`#${btn._btnId}`);
                if (btnEl && btn.onClick) {
                    btnEl.addEventListener('click', btn.onClick);
                }
            }, 0);
        });

        overlay.appendChild(modal);

        // Close on backdrop click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                const modalContext = Array.from(this.activeModals).find(m => m.element === overlay);
                if (modalContext && modalContext.closeOnEscape) {
                    modalContext.reject();
                }
            }
        });

        return overlay;
    }

    /**
     * Shows a modal
     * @param {Object} modalContext - Modal context with element and handlers
     */
    showModal(modalContext) {
        document.body.appendChild(modalContext.element);
        this.activeModals.add(modalContext);

        // Trigger display with animation
        requestAnimationFrame(() => {
            modalContext.element.classList.add('show');
        });

        // Prevent body scroll
        document.body.style.overflow = 'hidden';
    }

    /**
     * Closes a modal
     * @param {Object} modalContext - Modal context to close
     */
    closeModal(modalContext) {
        modalContext.element.classList.remove('show');
        this.activeModals.delete(modalContext);

        setTimeout(() => {
            if (modalContext.element.parentNode) {
                modalContext.element.parentNode.removeChild(modalContext.element);
            }

            // Re-enable body scroll if no more modals
            if (this.activeModals.size === 0) {
                document.body.style.overflow = '';
            }
        }, 300);
    }

    /**
     * Escapes HTML to prevent XSS
     * @param {string} text - Text to escape
     * @returns {string} Escaped text
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Create global modal instance immediately (scripts are at end of body)
window.modal = new ModalManager();
console.log('Modal system initialized');

// Export for modules (if needed)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ModalManager;
}
