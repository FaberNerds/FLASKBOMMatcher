"""
BOM Matcher - Database Service
Thread-safe connection pool for Exact Globe SQL Server.
Credentials are retrieved from Windows Credential Manager (keyring).
"""
import pyodbc
import keyring
import logging
import threading
from typing import Optional, Generator
from contextlib import contextmanager
from queue import Queue, Empty

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Exact Globe SQL Server configuration
# ---------------------------------------------------------------------------
DB_SERVER = "FAB-SQL01"
DB_DATABASE = "001"
DB_DRIVER = "ODBC Driver 18 for SQL Server"
TRUST_SERVER_CERTIFICATE = True
ENCRYPT = True
CONNECTION_TIMEOUT = 15  # seconds

# Connection pool settings
POOL_MIN_SIZE = 2
POOL_MAX_SIZE = 10
POOL_GET_TIMEOUT = 5       # seconds
POOL_EXHAUSTED_WAIT = 30   # seconds

# Keyring credentials (Windows Credential Manager)
KEYRING_SERVICE = "Prod_SQL_DB_Luminovo"
KEYRING_USER = "Luminovo"


class DatabaseConnectionPool:
    """Thread-safe connection pool for MS SQL Server.

    Singleton — only one pool instance exists across the application.
    """

    _instance = None
    _lock = threading.Lock()

    def __new__(cls, *args, **kwargs):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
        return cls._instance

    def __init__(self, min_size: int = POOL_MIN_SIZE, max_size: int = POOL_MAX_SIZE):
        if self._initialized:
            return

        self.min_size = min_size
        self.max_size = max_size
        self._pool = Queue(maxsize=max_size)
        self._size = 0
        self._lock = threading.Lock()

        # Pre-populate with minimum connections
        for _ in range(min_size):
            conn = self._create_connection()
            if conn:
                self._pool.put(conn)
                self._size += 1

        self._initialized = True
        logger.info(f"Connection pool initialized: {self._size}/{self.max_size}")

    def _create_connection(self) -> Optional[pyodbc.Connection]:
        """Create a new database connection using keyring credentials."""
        try:
            password = keyring.get_password(KEYRING_SERVICE, KEYRING_USER)
            if not password:
                logger.error("Database password not found in keyring")
                return None

            conn_str = (
                f"DRIVER={{{DB_DRIVER}}};"
                f"SERVER={DB_SERVER};"
                f"DATABASE={DB_DATABASE};"
                f"UID={KEYRING_USER};"
                f"PWD={password};"
                f"TrustServerCertificate={'yes' if TRUST_SERVER_CERTIFICATE else 'no'};"
                f"Encrypt={'yes' if ENCRYPT else 'no'};"
                f"Connection Timeout={CONNECTION_TIMEOUT};"
            )

            conn = pyodbc.connect(conn_str, timeout=CONNECTION_TIMEOUT)
            return conn

        except Exception as e:
            logger.error(f"Failed to create connection: {e}")
            return None

    @contextmanager
    def get_connection(self) -> Generator[Optional[pyodbc.Connection], None, None]:
        """Context manager: yields a connection, returns it to the pool after use."""
        conn = None
        try:
            # Try to get from pool
            try:
                conn = self._pool.get(timeout=POOL_GET_TIMEOUT)
            except Empty:
                # Pool empty — create new if under max
                with self._lock:
                    if self._size < self.max_size:
                        conn = self._create_connection()
                        if conn:
                            self._size += 1
                            logger.info(f"Created new connection: {self._size}/{self.max_size}")
                    else:
                        logger.warning("Connection pool exhausted, waiting...")
                        conn = self._pool.get(timeout=POOL_EXHAUSTED_WAIT)

            # Verify connection is alive
            if conn:
                try:
                    cursor = conn.cursor()
                    cursor.execute("SELECT 1")
                    cursor.fetchall()
                    cursor.close()
                except Exception:
                    logger.warning("Stale connection detected, recreating")
                    try:
                        conn.close()
                    except Exception:
                        pass
                    conn = self._create_connection()

            yield conn

        finally:
            if conn:
                try:
                    self._pool.put_nowait(conn)
                except Exception:
                    try:
                        conn.close()
                    except Exception:
                        pass
                    with self._lock:
                        self._size = max(0, self._size - 1)


# ---------------------------------------------------------------------------
# Lazy pool initialization (created on first use, not at import time)
# ---------------------------------------------------------------------------
_db_pool = None
_pool_lock = threading.Lock()


def _get_pool() -> DatabaseConnectionPool:
    global _db_pool
    if _db_pool is None:
        with _pool_lock:
            if _db_pool is None:
                _db_pool = DatabaseConnectionPool(
                    min_size=POOL_MIN_SIZE,
                    max_size=POOL_MAX_SIZE,
                )
    return _db_pool


@contextmanager
def get_connection_context() -> Generator[Optional[pyodbc.Connection], None, None]:
    """Get a database connection from the pool (context manager).

    Usage:
        with get_connection_context() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT ...")
    """
    with _get_pool().get_connection() as conn:
        yield conn
