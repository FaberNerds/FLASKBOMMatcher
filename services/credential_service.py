"""
BOM Matcher - Credential Service
Cross-platform encrypted credential storage using Fernet symmetric encryption.
Adapted from BOMcompare — changed path to ~/.bommatcher/, salt to "bommatcher-v1".
Exact DB credentials use keyring (Windows Credential Manager) via ExactSearchTool.
"""
import os
import json
import base64
import hashlib
import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# Try to import cryptography, gracefully handle if not installed
try:
    from cryptography.fernet import Fernet, InvalidToken
    CRYPTO_AVAILABLE = True
except ImportError:
    CRYPTO_AVAILABLE = False
    logger.warning("cryptography not installed - credentials will be stored in plaintext")


class CredentialManager:
    """
    Manages encrypted credential storage.
    Uses Fernet symmetric encryption with a key derived from a machine-specific identifier.
    """

    def __init__(self, storage_path: Optional[Path] = None):
        if storage_path is None:
            storage_path = Path.home() / '.bommatcher' / 'credentials.enc'

        self.storage_path = storage_path
        self.storage_path.parent.mkdir(parents=True, exist_ok=True)
        self._fernet = self._get_fernet() if CRYPTO_AVAILABLE else None

    def _get_machine_id(self) -> str:
        """Get a machine-specific identifier for key derivation."""
        import socket
        import getpass

        components = [
            socket.gethostname(),
            getpass.getuser(),
            "bommatcher-v1"
        ]
        return "|".join(components)

    def _get_fernet(self) -> 'Fernet':
        """Create a Fernet instance with a machine-derived key."""
        machine_id = self._get_machine_id()
        key_bytes = hashlib.sha256(machine_id.encode()).digest()
        key = base64.urlsafe_b64encode(key_bytes)
        return Fernet(key)

    def _encrypt(self, data: str) -> str:
        if self._fernet:
            return self._fernet.encrypt(data.encode()).decode()
        return data

    def _decrypt(self, data: str) -> str:
        if self._fernet:
            try:
                return self._fernet.decrypt(data.encode()).decode()
            except InvalidToken:
                logger.warning("Failed to decrypt credentials - may have been created on different machine")
                return ""
        return data

    def get_credentials(self, key: str) -> Optional[dict]:
        all_creds = self._load_all()
        if all_creds is None:
            return None
        return all_creds.get(key)

    def set_credentials(self, key: str, credentials: dict) -> bool:
        all_creds = self._load_all()
        if all_creds is None:
            logger.warning(f"Aborting save for '{key}' because existing config could not be decrypted safely.")
            return False
        all_creds[key] = credentials
        self._save_all(all_creds)
        return True

    def delete_credentials(self, key: str) -> bool:
        all_creds = self._load_all()
        if all_creds is None:
            return False
        if key in all_creds:
            del all_creds[key]
            self._save_all(all_creds)
            return True
        return False

    def list_keys(self) -> list:
        all_creds = self._load_all()
        if all_creds is None:
            return []
        return list(all_creds.keys())

    def _load_all(self) -> dict:
        if not self.storage_path.exists():
            return {}
        try:
            encrypted_data = self.storage_path.read_text()
            if not encrypted_data:
                return {}
            decrypted_data = self._decrypt(encrypted_data)
            if not decrypted_data and encrypted_data:
                logger.error(f"Decryption failed for {self.storage_path}")
                return None
            return json.loads(decrypted_data)
        except (json.JSONDecodeError, Exception) as e:
            logger.error(f"Error loading credentials from {self.storage_path}: {e}")
            return None

    def _save_all(self, data: dict) -> None:
        try:
            json_data = json.dumps(data)
            encrypted_data = self._encrypt(json_data)
            self.storage_path.write_text(encrypted_data)
        except Exception as e:
            logger.error(f"Error saving credentials: {e}")
            raise


# Global credential manager instance
_credential_manager: Optional[CredentialManager] = None


def get_credential_manager() -> CredentialManager:
    global _credential_manager
    if _credential_manager is None:
        _credential_manager = CredentialManager()
    return _credential_manager


# ============================================================================
# OpenRouter API Key Storage
# ============================================================================

def save_openrouter_credentials(api_key: str) -> None:
    mgr = get_credential_manager()
    mgr.set_credentials('openrouter', {'api_key': api_key})


def get_openrouter_api_key() -> Optional[str]:
    mgr = get_credential_manager()
    creds = mgr.get_credentials('openrouter')
    return creds.get('api_key') if creds else None


# ============================================================================
# Mistral API Key Storage
# ============================================================================

def save_mistral_credentials(api_key: str) -> None:
    mgr = get_credential_manager()
    mgr.set_credentials('mistral', {'api_key': api_key})


def get_mistral_api_key() -> Optional[str]:
    mgr = get_credential_manager()
    creds = mgr.get_credentials('mistral')
    return creds.get('api_key') if creds else None


# ============================================================================
# AI Provider Selection
# ============================================================================

def save_ai_provider(provider: str) -> None:
    if provider not in ('mistral', 'openrouter', 'ollama'):
        raise ValueError(f"Invalid provider: {provider}")
    mgr = get_credential_manager()
    mgr.set_credentials('ai_provider', {'provider': provider})


def get_ai_provider() -> str:
    mgr = get_credential_manager()
    creds = mgr.get_credentials('ai_provider')
    if creds:
        return creds.get('provider', 'mistral')
    return 'mistral'


# ============================================================================
# Ollama Settings Storage
# ============================================================================

def save_ollama_settings(host: str, model: str) -> None:
    """Save Ollama host URL and model name."""
    mgr = get_credential_manager()
    mgr.set_credentials('ollama', {'host': host, 'model': model})


def get_ollama_settings() -> dict:
    """Get Ollama host and model. Returns defaults if not configured."""
    mgr = get_credential_manager()
    creds = mgr.get_credentials('ollama')
    if creds:
        return {
            'host': creds.get('host', 'http://DESKTOP-DANIELCLEAVER:11434'),
            'model': creds.get('model', 'qwen3.5:9b')
        }
    return {
        'host': 'http://DESKTOP-DANIELCLEAVER:11434',
        'model': 'qwen3.5:9b'
    }


# ============================================================================
# ERP Description Examples Storage
# ============================================================================

def save_erp_examples(examples: str) -> None:
    """Save ERP description examples for AI prompt context."""
    mgr = get_credential_manager()
    mgr.set_credentials('erp_examples', {'examples': examples})


def get_erp_examples() -> str:
    """Get ERP description examples."""
    mgr = get_credential_manager()
    creds = mgr.get_credentials('erp_examples')
    return creds.get('examples', '') if creds else ''


# ============================================================================
# Flask Secret Key Storage
# ============================================================================

def generate_secret_key() -> str:
    import secrets
    return secrets.token_hex(32)


def save_flask_secret_key(secret_key: str) -> None:
    mgr = get_credential_manager()
    mgr.set_credentials('flask_secret', {'secret_key': secret_key})
    logger.info("Flask secret key saved to secure storage")


def get_flask_secret_key() -> Optional[str]:
    env_key = os.environ.get('SECRET_KEY')
    if env_key and env_key != 'dev-secret-key-change-in-production':
        return env_key
    mgr = get_credential_manager()
    creds = mgr.get_credentials('flask_secret')
    return creds.get('secret_key') if creds else None


def mask_secret(secret: str, show_chars: int = 4) -> str:
    if not secret or len(secret) <= show_chars:
        return '****'
    return '*' * (len(secret) - show_chars) + secret[-show_chars:]
