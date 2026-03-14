"""
BOM Matcher - Configuration
"""
import os
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

# Base directory
BASE_DIR = Path(__file__).parent.resolve()

# Upload folder for temporary files
UPLOAD_FOLDER = BASE_DIR / 'uploads'
UPLOAD_FOLDER.mkdir(exist_ok=True)

# Allowed file extensions
ALLOWED_EXTENSIONS = {'xlsx', 'xls', 'csv'}

# Maximum file size (16 MB)
MAX_CONTENT_LENGTH = 16 * 1024 * 1024

# Environment configuration
DEBUG_MODE = os.environ.get('FLASK_DEBUG', 'false').lower() == 'true'
FLASK_HOST = os.environ.get('FLASK_HOST', '0.0.0.0')
FLASK_PORT = int(os.environ.get('FLASK_PORT', '50085'))

# File cleanup settings (hours) - 1 week default
FILE_RETENTION_HOURS = int(os.environ.get('FILE_RETENTION_HOURS', '168'))

# Standard BOM columns for mapping
STANDARD_COLUMNS = [
    'Manufacturer',
    'MPN',
    'Description',
    'Quantity',
    'Refdes',
]


def get_secret_key() -> str:
    """
    Get the Flask secret key from credential service or generate one.

    Priority:
    1. Environment variable SECRET_KEY (if not default)
    2. Stored in credential service
    3. Auto-generate and store new key
    """
    from services.credential_service import (
        get_flask_secret_key,
        save_flask_secret_key,
        generate_secret_key
    )

    # Try to get from credential service (also checks env var)
    key = get_flask_secret_key()
    if key:
        return key

    # Generate new key and save it
    logger.info("No secret key configured - generating new secure key")
    new_key = generate_secret_key()
    save_flask_secret_key(new_key)
    return new_key


# Lazy load SECRET_KEY to avoid circular imports
SECRET_KEY = os.environ.get('SECRET_KEY', 'dev-secret-key-change-in-production')
