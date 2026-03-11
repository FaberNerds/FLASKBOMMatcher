/**
 * Toast Notification System
 * Provides non-blocking, auto-dismissing notifications
 */

class ToastManager {
    constructor() {
        this.container = this.createContainer();
        this.toasts = new Map();
        this.idCounter = 0;
    }

    /**
     * Creates the toast container element
     * @returns {HTMLElement} The toast container
     */
    createContainer() {
        const container = document.createElement('div');
        container.className = 'toast-container';
        container.setAttribute('aria-live', 'polite');
        container.setAttribute('aria-atomic', 'true');
        document.body.appendChild(container);
        return container;
    }

    /**
     * Shows a toast notification
     * @param {string} message - The message to display
     * @param {string} type - Type of toast (success, error, warning, info)
     * @param {number} duration - Duration in milliseconds (0 = no auto-dismiss)
     * @returns {number} Toast ID for manual dismissal
     */
    show(message, type = 'info', duration = 4000) {
        const id = this.idCounter++;
        const toast = this.createToast(id, message, type);

        this.container.appendChild(toast);
        this.toasts.set(id, toast);

        // Trigger animation
        requestAnimationFrame(() => {
            toast.classList.add('toast-show');
        });

        // Auto-dismiss if duration > 0
        if (duration > 0) {
            setTimeout(() => this.dismiss(id), duration);
        }

        return id;
    }

    /**
     * Creates a toast element
     * @param {number} id - Toast ID
     * @param {string} message - Message text
     * @param {string} type - Toast type
     * @returns {HTMLElement} The toast element
     */
    createToast(id, message, type) {
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.setAttribute('role', 'alert');
        toast.setAttribute('data-toast-id', id);

        const icons = {
            success: '✓',
            error: '✕',
            warning: '⚠',
            info: 'ℹ'
        };

        toast.innerHTML = `
            <div class="toast-icon" aria-hidden="true">${icons[type] || icons.info}</div>
            <div class="toast-message">${this.escapeHtml(message)}</div>
            <button class="toast-close" aria-label="Close notification">×</button>
        `;

        // Add close button handler
        toast.querySelector('.toast-close').addEventListener('click', () => {
            this.dismiss(id);
        });

        return toast;
    }

    /**
     * Dismisses a toast by ID
     * @param {number} id - Toast ID to dismiss
     */
    dismiss(id) {
        const toast = this.toasts.get(id);
        if (!toast) return;

        toast.classList.remove('toast-show');

        // Remove from DOM after animation
        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
            this.toasts.delete(id);
        }, 300);
    }

    /**
     * Dismisses all toasts
     */
    dismissAll() {
        this.toasts.forEach((_, id) => this.dismiss(id));
    }

    /**
     * Convenience methods for different toast types
     */
    success(message, duration = 4000) {
        return this.show(message, 'success', duration);
    }

    error(message, duration = 6000) {
        return this.show(message, 'error', duration);
    }

    warning(message, duration = 5000) {
        return this.show(message, 'warning', duration);
    }

    info(message, duration = 4000) {
        return this.show(message, 'info', duration);
    }

    /**
     * Shows a loading toast that doesn't auto-dismiss
     * Returns a function to update/dismiss it
     * @param {string} message - Loading message
     * @returns {Object} Control object with update and dismiss methods
     */
    loading(message) {
        const id = this.show(message, 'info', 0);

        return {
            update: (newMessage) => {
                const toast = this.toasts.get(id);
                if (toast) {
                    const messageEl = toast.querySelector('.toast-message');
                    if (messageEl) {
                        messageEl.textContent = this.escapeHtml(newMessage);
                    }
                }
            },
            dismiss: () => this.dismiss(id),
            success: (newMessage) => {
                this.dismiss(id);
                return this.success(newMessage);
            },
            error: (newMessage) => {
                this.dismiss(id);
                return this.error(newMessage);
            }
        };
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

// Create global toast instance immediately (scripts are at end of body)
window.toast = new ToastManager();
console.log('Toast system initialized');

// Export for modules (if needed)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ToastManager;
}
