# BOM Matcher

A Flask web application that matches Bill of Materials (BOM) lines to parts in **Exact Globe ERP**. Upload a customer BOM file, map its columns, and let the application find matching internal part numbers (IPNs/FaberNrs) using intelligent multi-strategy search: MPN lookup, parameterized component matching, and description-based search.

---

## Features

### BOM Upload & Column Mapping
- Drag-and-drop file upload (`.xlsx`, `.xls`, `.csv`)
- Auto-detects sheet names, header rows, and CSV delimiters
- Configurable row range (start/end) with right-click context menu
- Flexible column mapping with multi-column concatenation support
- Remembers mappings per filename for quick re-uploads
- Customer selection for filtering customer-specific parts

### Intelligent Component Matching
Three search strategies executed in parallel, ranked by confidence:

1. **MPN Search** -- Searches Exact Globe by Manufacturer Part Number with automatic variant generation (tape-and-reel suffixes, distributor codes, dash/space normalization)
2. **Parameterized Search** -- For generic resistors, capacitors, and inductors: extracts electrical parameters (value, tolerance, voltage, package, dielectric) from descriptions and matches against a local SQLite index built from ERP data
3. **Description Search** -- Keyword-based fallback using ERP description fields

**Result ranking considers:**
- Customer-specific IPN prefixes (7xx, 9xx, 500xx)
- Active vs. discontinued (Vervallen) status
- Confidence score tiers (high/medium/low)
- Stock availability and cost optimization
- Manufacturer match boosting

### MPNfree Detection
Rule-based classification of generic components (standard resistors, capacitors, inductors) that don't require a specific manufacturer. User overrides supported.

### Interactive Processing UI
- Split-panel layout: customer BOM (left), ERP matches (right), parameters (bottom)
- Synchronized scrolling across all panels
- Full-screen detail modal with sortable suggestion list
- Copy mode (clipboard shortcuts for MPN/description)
- Delete mode (hide irrelevant rows)
- Text search and status filtering (Matched / Partial / No match)
- Zoom controls (60-120%) with persistence
- Keyboard navigation (arrow keys, Enter, Delete)
- Right-click context menu (re-search, manual search, copy, delete)

### Export
- Excel download with original BOM data plus matched columns (FaberNr, description, manufacturer, MPN, MPNfree status)
- Color-coded confidence: green (high), yellow (partial), red (no match), gray (MPNfree)

### BOM History
- Stores up to 100 previous BOM sessions with metadata
- Reload any previous session to restore matches and selections

### Settings & Administration
- Test Exact Globe database connection
- Rebuild parameter index on demand with statistics
- Manage custom package aliases (e.g., "UNIFIED-C0603" -> "0603")

---

## Architecture

```
FLASKBOMMatcher/
├── app.py                        # Application entry point & server setup
├── config.py                     # Configuration (env vars, paths, constants)
├── requirements.txt              # Python dependencies
├── .flaskenv                     # Flask dev environment variables
│
├── routes/                       # Flask blueprints
│   ├── pages.py                  # Page routes (upload, process, settings, history)
│   ├── upload_api.py             # File upload & column mapping endpoints
│   ├── match_api.py              # IPN matching & search endpoints
│   ├── export_api.py             # Excel export endpoint
│   ├── settings_api.py           # Settings & configuration endpoints
│   └── history_api.py            # BOM history endpoints
│
├── services/                     # Business logic
│   ├── match_service.py          # Core matching orchestration (parallel search)
│   ├── search_service.py         # SQL queries to Exact Globe
│   ├── db_service.py             # Thread-safe connection pool
│   ├── session_service.py        # Session management & data persistence
│   ├── file_service.py           # Multi-format file reading (xlsx/xls/csv)
│   ├── export_service.py         # Excel export with color coding
│   ├── ai_service.py             # Rule-based MPNfree assessment
│   ├── category_detect_service.py # Component category detection (regex)
│   ├── category_index_service.py # SQLite parameter index for R/C matching
│   ├── param_extract_service.py  # Parameter extraction from descriptions
│   ├── mpn_normalize_service.py  # MPN variant generation for fuzzy matching
│   ├── klant_cache_service.py    # Customer (KlantNr/KlantNaam) cache
│   ├── package_alias_service.py  # User-defined package aliases
│   ├── credential_service.py     # Encrypted credential storage
│   └── cleanup_service.py        # Automatic file cleanup
│
├── templates/                    # Jinja2 HTML templates
│   ├── base.html                 # Base layout (topbar, loading overlay, toasts)
│   ├── upload.html               # File upload & column mapping page
│   ├── process.html              # Processing/matching page (split-panel)
│   ├── settings.html             # Settings page
│   └── history.html              # BOM history page
│
├── static/
│   ├── css/
│   │   ├── main.css              # Design system (colors, components, layout)
│   │   └── matcher.css           # Application-specific styles
│   └── js/
│       ├── upload.js             # Upload page logic
│       ├── process.js            # Process page logic (core UI)
│       ├── process-params.js     # Parameter panel rendering
│       ├── history.js            # History page logic
│       ├── modal.js              # Modal/dialog management
│       ├── toast.js              # Toast notification system
│       └── sanitize.js           # HTML sanitization (XSS prevention)
│
├── ssl/                          # SSL certificate generation
│   └── generate_cert.py
├── uploads/                      # Temporary file storage (auto-cleaned)
└── SERVER_DEPLOY_README.md       # Server deployment guide
```

---

## Technology Stack

| Layer | Technology |
|-------|-----------|
| **Backend** | Python 3.11+, Flask, Jinja2 |
| **Database** | SQL Server (Exact Globe ERP) via pyodbc, SQLite (local parameter index) |
| **Frontend** | Vanilla JavaScript, CSS3 design system (no frameworks) |
| **Server** | Cheroot (CherryPy WSGI server) with SSL |
| **Authentication** | Windows Credential Manager (keyring) |
| **Encryption** | Fernet symmetric encryption (cryptography) |
| **Deployment** | Windows Service (pywin32) |

---

## Prerequisites

- **Python 3.11+**
- **ODBC Driver 17 or 18 for SQL Server** ([download from Microsoft](https://learn.microsoft.com/en-us/sql/connect/odbc/download-odbc-driver-for-sql-server))
- **Network access** to your Exact Globe SQL Server (read-only)
- **Windows** (required for Windows Credential Manager and Windows Service support)

---

## Quick Start

### 1. Clone & install

```powershell
git clone <repository-url> BOMMatcher
cd BOMMatcher

python -m venv .venv
.venv\Scripts\activate

pip install -r requirements.txt
```

### 2. Configure environment

Create a `.env` file (or use the included `.flaskenv` for development):

```ini
FLASK_DEBUG=true        # Enable debug mode (development only)
FLASK_PORT=50085        # Server port
FLASK_HOST=0.0.0.0      # Bind address
```

### 3. Set up database credentials

Store your Exact Globe SQL Server credentials in Windows Credential Manager:

- **Service**: `Prod_SQL_DB_Luminovo`
- **Username**: your SQL login
- **Password**: your SQL password

Or configure via the Settings page (`/settings`) after first launch.

### 4. Run

```powershell
python app.py
```

Open `http://localhost:50085` in your browser.

On first startup the application will:
- Load the customer (Klant) cache from ERP
- Build the parameter index for resistor/capacitor matching
- Clean up old uploaded files

---

## Production Deployment

For deploying as a Windows Service with HTTPS, see [SERVER_DEPLOY_README.md](SERVER_DEPLOY_README.md).

Summary:

```powershell
# Generate SSL certificate
python ssl/generate_cert.py

# Install and start the Windows Service
python app.py install
python app.py start

# Other service commands
python app.py stop
python app.py update
python app.py remove
```

The service runs Cheroot with SSL on the configured port (default 50085).

---

## Configuration

All configuration is managed through environment variables and [config.py](config.py):

| Variable | Default | Description |
|----------|---------|-------------|
| `FLASK_DEBUG` | `false` | Enable debug mode |
| `FLASK_HOST` | `0.0.0.0` | Bind address |
| `FLASK_PORT` | `50085` | Server port |
| `USE_HTTPS` | `false` | Enable SSL (requires certs in `ssl/`) |
| `SECRET_KEY` | auto-generated | Flask secret key (stored encrypted in `~/.bommatcher/`) |
| `FILE_RETENTION_HOURS` | `168` | Hours before uploaded files are auto-deleted |

### Persistent data locations

| Path | Contents |
|------|----------|
| `~/.bommatcher/param_index.db` | SQLite parameter index (rebuilt from ERP) |
| `~/.bommatcher/credentials.enc` | Encrypted Flask secret key |
| `~/.bommatcher/package_aliases.json` | User-defined package aliases |
| `./uploads/` | Temporary BOM files and session data |

---

## User Workflow

1. **Upload** -- Navigate to `/`, upload a BOM file (drag-and-drop or browse). Select the sheet, set the header row, and optionally limit the row range.

2. **Map columns** -- Map your BOM columns to the standard fields: Manufacturer, MPN, Description (required), Quantity, Refdes. Optionally select a customer to filter customer-specific parts.

3. **Match** -- On the process page (`/process`), click **Find IPN** to run the parallel search. The application searches by MPN, parameters, and description simultaneously and ranks results.

4. **Review** -- Review matches in the split-panel UI. Use the detail modal to see all suggestions, manually search, or override selections. Click **Select MPNfree** to mark generic components.

5. **Export** -- Click **Export** to download an Excel file with the original BOM data plus matched FaberNr, description, manufacturer, MPN, and MPNfree status columns, color-coded by match confidence.

---

## API Reference

### Pages

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Upload page |
| GET | `/process` | Processing page |
| GET | `/settings` | Settings page |
| GET | `/history` | BOM history page |
| GET | `/health` | Health check endpoint |

### Upload API

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/upload` | Upload BOM file |
| GET | `/api/sheets` | List Excel sheet names |
| POST | `/api/reload` | Reload file with different settings |
| GET | `/api/klanten` | List all customers |
| POST | `/api/set-mapping` | Save column mapping & customer |
| GET | `/api/bom-data` | Get current BOM data & results |
| GET | `/api/upload-state` | Get upload state for back navigation |
| POST | `/api/clear-process-data` | Clear search results |

### Match API

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/match/find-ipn` | Batch search all BOM rows |
| POST | `/api/match/find-ipn-single` | Re-search a single row |
| POST | `/api/match/manual-search` | Manual search by MPN/IPN/description |
| POST | `/api/match/mpnfree` | Run MPNfree assessment |
| POST | `/api/match/delete` | Delete match for a row |
| POST | `/api/match/override` | Override FaberNr or MPNfree flag |

### Export API

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/export` | Download matched Excel file |

### Settings API

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/settings/test-connection` | Test Exact DB connection |
| POST | `/api/settings/rebuild-index` | Rebuild parameter index |
| GET | `/api/settings/index-stats` | Get index statistics |
| GET | `/api/settings/package-aliases` | List package aliases |
| POST | `/api/settings/package-aliases` | Add package alias |
| DELETE | `/api/settings/package-aliases` | Remove package alias |

### History API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/history` | List all history entries |
| POST | `/api/history/load` | Load a previous BOM session |
| POST | `/api/history/delete` | Delete a history entry |

---

## Security

- **CSRF protection** via Flask-WTF on all state-changing endpoints
- **Rate limiting** via Flask-Limiter (200/day, 100/hour global; 10/min uploads; 5/min searches)
- **Secure headers**: Content-Security-Policy, HSTS, X-Frame-Options, X-Content-Type-Options, X-XSS-Protection
- **Encrypted credential storage** using Fernet symmetric encryption with machine-derived keys
- **Windows Credential Manager** for database credentials (never stored in files)
- **HTML sanitization** on all user-provided content rendered in the UI
- **Session isolation** via unique UUID per browser session

---

## Matching Algorithm Details

### MPN Variant Generation
The application generates multiple search variants from a single MPN to handle manufacturer naming inconsistencies:
- Tape-and-reel suffixes (`-TR`, `CT-ND`)
- Reel size codes (`,115`, `,215`, `-115`, `-215`)
- Distributor suffixes (`-ND`, `-CT`, `-DKR`, `-1-ND`)
- Whitespace and dash normalization

### Parameterized Matching (Resistors & Capacitors)
Regex-based extraction of electrical parameters from BOM descriptions:
- **Resistors**: Value (8E2, 4R7, 100K), tolerance, power rating, package size
- **Capacitors**: Capacitance (10uF, 100pF), voltage rating, dielectric (X7R, C0G, NP0), package
- **Inductors**: Inductance (100uH), impedance, package

Parameters are scored with weighted matching:
- Value/capacitance: 40% weight
- Package: 25% weight
- Voltage: 25% weight
- Tolerance: 20% weight

**Substitution rules** allow directional matching (e.g., higher voltage rating is acceptable for capacitors). **Disqualifying parameters** (wrong package, wrong core value) immediately eliminate candidates.

**Dielectric hierarchy**: NP0/C0G > X8R > X7R > X5R > Y5V (higher-rank dielectrics can substitute for lower-rank ones).

### Result Ranking
1. Filter by customer-specific IPN prefixes if customer selected
2. Active (non-Vervallen) items ranked before discontinued
3. Group by confidence tier: >= 99.5% > >= 95% > >= 70% > < 70%
4. Within comparable cost (+-2 cents or +-10%), prefer in-stock items
5. Lowest cost as final tiebreaker

---

## Troubleshooting

| Symptom | Solution |
|---------|----------|
| Service won't start | Check `service_stdout.log` and `service_stderr.log` in the project directory |
| SSL errors in browser | Regenerate certs: `python ssl/generate_cert.py` |
| Port already in use | Change `FLASK_PORT` in `.env` and update the firewall rule |
| DB connection fails | Verify credentials at `/settings`, check ODBC driver is installed |
| No matches found | Rebuild the parameter index at `/settings`, verify DB connectivity |
| Service crashes on startup | Run `python app.py` directly to see error output in the console |
