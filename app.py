"""
BOM Matcher - Flask Web Application
Matches BOM lines to parts in Exact Globe ERP system.

Version: V1.0.0
"""
import logging
import os
import sys
from logging.handlers import RotatingFileHandler
from flask import Flask, jsonify, request
from routes import register_blueprints
import config

# ---- Service Imports (pywin32) ----
# Windows Service support - graceful fallback for dev/Linux environments
try:
    import win32serviceutil
    import win32service
    import win32event
    import servicemanager
except ImportError:
    win32serviceutil = None

# ---- WSGI Server for Windows Service ----
# Cheroot is CherryPy's production WSGI server with SSL support and graceful shutdown
try:
    from cheroot.wsgi import Server as WSGIServer
    from cheroot.ssl.builtin import BuiltinSSLAdapter
except ImportError:
    WSGIServer = None
    BuiltinSSLAdapter = None

basedir = os.path.abspath(os.path.dirname(__file__))

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
    _log_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'server.log')
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

# Rebuild parameter index on startup
try:
    from services.category_index_service import build_index as _build_index
    logger.info("Rebuilding parameter index on startup...")
    _stats = _build_index()
    logger.info(f"Index rebuilt: {_stats.get('total_components', 0)} components, "
                f"{_stats.get('total_parameters', 0)} parameters in {_stats.get('elapsed_seconds', 0):.1f}s")
except Exception as e:
    logger.warning(f"Could not rebuild parameter index on startup: {e}")

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


# ---- Windows Service Class ----
if win32serviceutil is not None:
    class BOMMatcherService(win32serviceutil.ServiceFramework):
        """Windows Service wrapper for the BOM Matcher Tool."""
        _svc_name_ = "BOMMatcherService"
        _svc_display_name_ = "BOM Matcher Service"
        _svc_description_ = (
            "Web application for matching BOM lines to parts "
            "in Exact Globe ERP system."
        )

        def __init__(self, args):
            win32serviceutil.ServiceFramework.__init__(self, args)
            self.hWaitStop = win32event.CreateEvent(None, 0, 0, None)
            self.server = None

        def SvcStop(self):
            """Called when the service is asked to stop."""
            self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
            svc_logger = logging.getLogger(__name__)
            svc_logger.info("Service stop requested - shutting down...")

            # Stop Cheroot server gracefully
            if self.server is not None:
                try:
                    self.server.stop()
                    svc_logger.info("Cheroot server stopped")
                except Exception as e:
                    svc_logger.error(f"Error stopping server: {e}")

            win32event.SetEvent(self.hWaitStop)

        def SvcDoRun(self):
            """Called when the service is asked to start."""
            servicemanager.LogMsg(
                servicemanager.EVENTLOG_INFORMATION_TYPE,
                servicemanager.PYS_SERVICE_STARTED,
                (self._svc_name_, '')
            )

            # Force working directory to app.py location
            os.chdir(basedir)

            # Redirect stdout/stderr for headless service operation
            if sys.stdout is None:
                sys.stdout = open(os.path.join(basedir, 'service_stdout.log'), 'a', encoding='utf-8')
            if sys.stderr is None:
                sys.stderr = open(os.path.join(basedir, 'service_stderr.log'), 'a', encoding='utf-8')

            try:
                self.main()
            except Exception as e:
                logging.getLogger(__name__).error(f"Service crashed: {e}", exc_info=True)
                servicemanager.LogErrorMsg(f"BOMMatcherService crashed: {str(e)}")
                raise

        def main(self):
            """Main service loop using Cheroot for SSL support and graceful shutdown."""
            svc_logger = logging.getLogger(__name__)
            svc_logger.info("Service main() started - preparing to launch...")

            if WSGIServer is None:
                raise ImportError("Cheroot is not installed. Install with: pip install cheroot")

            port = int(os.environ.get('FLASK_PORT', config.FLASK_PORT))
            svc_logger.info(f"Creating Cheroot WSGI server on 0.0.0.0:{port}...")

            self.server = WSGIServer(('0.0.0.0', port), app)

            # Configure SSL
            ssl_cert = os.path.join(basedir, 'ssl', 'cert.pem')
            ssl_key = os.path.join(basedir, 'ssl', 'key.pem')
            if os.path.exists(ssl_cert) and os.path.exists(ssl_key):
                self.server.ssl_adapter = BuiltinSSLAdapter(ssl_cert, ssl_key)
                svc_logger.info("SSL enabled")
            else:
                svc_logger.warning("SSL certificates not found - running without HTTPS")

            svc_logger.info("Cheroot server starting...")
            self.server.start()  # Blocks until server.stop() is called
            svc_logger.info("Server has stopped")


if __name__ == '__main__':
    # Windows Service mode: when CLI args are passed (install/start/stop/remove)
    if win32serviceutil and len(sys.argv) > 1:
        win32serviceutil.HandleCommandLine(BOMMatcherService)
    else:
        # Development / Standalone mode
        debug_mode = os.environ.get('FLASK_DEBUG', 'False').lower() in ('true', '1', 'yes')

        # SSL configuration
        ssl_cert = os.path.join(basedir, 'ssl', 'cert.pem')
        ssl_key = os.path.join(basedir, 'ssl', 'key.pem')

        if os.path.exists(ssl_cert) and os.path.exists(ssl_key):
            ssl_context = (ssl_cert, ssl_key)
            logger.info("Starting with HTTPS (SSL enabled)")
        else:
            ssl_context = None
            logger.warning(
                "SSL certificate not found. Starting without HTTPS. "
                "Run 'python ssl/generate_cert.py' to generate a self-signed certificate."
            )

        port = int(os.environ.get('FLASK_PORT', config.FLASK_PORT))
        app.run(debug=debug_mode, host='0.0.0.0', port=port, use_reloader=False, ssl_context=ssl_context)
