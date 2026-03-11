"""
Routes Package
Flask blueprints for organizing application routes.
"""
from flask import Flask


def register_blueprints(app: Flask) -> None:
    """Register all blueprints with the Flask application."""
    from routes.pages import pages_bp
    from routes.upload_api import upload_bp
    from routes.match_api import match_bp
    from routes.settings_api import settings_bp
    from routes.export_api import export_bp

    app.register_blueprint(pages_bp)
    app.register_blueprint(upload_bp, url_prefix='/api')
    app.register_blueprint(match_bp, url_prefix='/api')
    app.register_blueprint(settings_bp, url_prefix='/api')
    app.register_blueprint(export_bp, url_prefix='/api')
