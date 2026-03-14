"""
BOM Matcher - Flask Web Application
Matches BOM lines to parts in Exact Globe ERP system.

Version: V1.0.0
"""
import logging
from logging.handlers import RotatingFileHandler
from flask import Flask, jsonify, request
from routes import register_blueprints
import config

# Security imports (graceful fallback)
try:
    from flask_wtf.csrf import CSRFProtect
    CSRF_AVAILABLE = True
except ImportError:
    CSRF_AVAILABLE = False

try:
    from flask_limiter import Limiter
    from flask_limiter.util import get_remote_address
    LIMITER_AVAILABLE = True
except ImportError:
    LIMITER_AVAILABLE = False

# Configure logging
import sys
class _ShortNameFormatter(logging.Formatter):
    """Formatter that shortens logger names for readable terminal output."""
    def format(self, record):
        # 'services.match_service' -> 'match', 'routes.match_api' -> 'match_api'
        parts = record.name.rsplit('.', 1)
        record.shortname = parts[-1].replace('_service', '').replace('_api', '_api')
        return super().format(record)

log_format = '%(asctime)s  %(shortname)-12s  %(message)s'
log_datefmt = '%H:%M:%S'
root_logger = logging.getLogger()
root_logger.setLevel(logging.INFO)
root_logger.handlers.clear()

# Always log to stdout
stream_handler = logging.StreamHandler(sys.stdout)
stream_handler.setLevel(logging.DEBUG if config.DEBUG_MODE else logging.INFO)
stream_handler.setFormatter(_ShortNameFormatter(log_format, datefmt=log_datefmt))
root_logger.addHandler(stream_handler)

if not config.DEBUG_MODE:
    # Production: also log to file
    import os as _os
    _log_path = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), 'server.log')
    file_handler = RotatingFileHandler(_log_path, maxBytes=10*1024*1024, backupCount=5)
    file_handler.setFormatter(_ShortNameFormatter(log_format, datefmt=log_datefmt))
    file_handler.setLevel(logging.INFO)
    root_logger.addHandler(file_handler)
logger = logging.getLogger(__name__)

# Initialize Flask app
app = Flask(__name__)

try:
    app.config['SECRET_KEY'] = config.get_secret_key()
except Exception as e:
    logger.warning(f"Could not load secret from credential service: {e}")
    app.config['SECRET_KEY'] = config.SECRET_KEY

app.config['MAX_CONTENT_LENGTH'] = config.MAX_CONTENT_LENGTH
app.config['UPLOAD_FOLDER'] = str(config.UPLOAD_FOLDER)

import os
use_https = os.environ.get('USE_HTTPS', 'false').lower() == 'true'
app.config['SESSION_COOKIE_SECURE'] = use_https
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'

# CSRF Protection
if CSRF_AVAILABLE:
    app.config['WTF_CSRF_CHECK_DEFAULT'] = False
    csrf = CSRFProtect(app)

    @app.before_request
    def check_csrf():
        if request.method in ('GET', 'HEAD', 'OPTIONS', 'TRACE'):
            return
        if request.content_type and 'application/json' in request.content_type:
            return
        try:
            csrf.protect()
        except Exception as e:
            logger.warning(f"CSRF validation failed: {e}")
            if not app.config.get('TESTING'):
                from flask import abort
                abort(400)
else:
    csrf = None

# Rate Limiting
if LIMITER_AVAILABLE:
    limiter = Limiter(
        key_func=get_remote_address,
        app=app,
        default_limits=["200 per day", "100 per hour"],
        storage_uri="memory://",
    )
else:
    limiter = None

# Ensure upload folder exists
config.UPLOAD_FOLDER.mkdir(exist_ok=True)

# File cleanup on startup
if not config.DEBUG_MODE:
    try:
        from services.cleanup_service import cleanup_old_files
        cleanup_old_files(config.UPLOAD_FOLDER, config.FILE_RETENTION_HOURS)
    except ImportError:
        pass

# Pre-load klant cache (KlantNr -> KlantNaam mapping)
try:
    from services.klant_cache_service import ensure_loaded as _load_klant_cache
    _load_klant_cache()
except Exception as e:
    logger.warning(f"Could not pre-load klant cache: {e}")

# Register all blueprints
register_blueprints(app)

# Apply rate limits
if limiter:
    limiter.limit("10 per minute")(app.view_functions.get('upload.upload_file', lambda: None))
    limiter.limit("5 per minute")(app.view_functions.get('match.find_ipn', lambda: None))
    limiter.limit("5 per minute")(app.view_functions.get('match.assess_mpnfree', lambda: None))


@app.after_request
def add_security_headers(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'SAMEORIGIN'
    response.headers['X-XSS-Protection'] = '1; mode=block'
    if app.config.get('SESSION_COOKIE_SECURE'):
        response.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
    csp = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' data:; "
        "connect-src 'self';"
    )
    response.headers['Content-Security-Policy'] = csp
    return response


@app.route('/health')
def health_check():
    return jsonify({
        'status': 'healthy',
        'version': '1.0',
        'csrf_protection': CSRF_AVAILABLE,
        'rate_limiting': LIMITER_AVAILABLE
    })


@app.errorhandler(413)
def too_large(e):
    return jsonify({'error': 'File too large. Maximum size is 16MB.'}), 413


@app.errorhandler(500)
def internal_error(e):
    logger.error(f"Internal error: {e}")
    return jsonify({'error': 'Internal server error'}), 500


@app.errorhandler(429)
def rate_limit_error(e):
    return jsonify({'error': 'Too many requests. Please slow down.'}), 429


if __name__ == '__main__':
    ssl_cert = 'ssl2/cert.pem'
    ssl_key = 'ssl2/key.pem'

    if not (os.path.exists(ssl_cert) and os.path.exists(ssl_key)):
        ssl_cert = 'ssl/cert.pem'
        ssl_key = 'ssl/key.pem'

    if os.path.exists(ssl_cert) and os.path.exists(ssl_key):
        logger.info(f"Starting HTTPS server on {config.FLASK_HOST}:{config.FLASK_PORT}")
        app.run(debug=config.DEBUG_MODE, host=config.FLASK_HOST, port=config.FLASK_PORT,
                use_reloader=False, ssl_context=(ssl_cert, ssl_key))
    else:
        logger.info(f"Starting HTTP server on {config.FLASK_HOST}:{config.FLASK_PORT}")
        app.run(debug=config.DEBUG_MODE, host=config.FLASK_HOST, port=config.FLASK_PORT,
                use_reloader=False)
