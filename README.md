# Tunisair Delay Dashboard

Static BI-style dashboard for analyzing Tunisair delays at Tunis-Carthage airport from public airport pages.

## Stack

- Python scraper with `requests` and `beautifulsoup4`
- Static HTML/CSS/JavaScript
- Apache ECharts from CDN
- GitHub Pages hosting

## Project Structure

```text
.
|-- index.html
|-- assets/
|   |-- app.js
|   `-- styles.css
|-- data/
|   |-- flights.csv
|   |-- flights.json
|   |-- summary.json
|   |-- monthly.json
|   |-- routes.json
|   |-- flight_numbers.json
|   |-- time_patterns.json
|   `-- scrape_errors.json
|-- scripts/
|   `-- scrape_flights.py
`-- requirements.txt
```

## Refresh the Data

Install scraper dependencies:

```powershell
py -m pip install -r requirements.txt
```

Run a small validation scrape:

```powershell
py scripts\scrape_flights.py --start 2025-01-01 --end 2025-01-07 --workers 2 --delay 0.05
```

Run the full dataset scrape:

```powershell
py scripts\scrape_flights.py --start 2020-01-01 --end 2026-06-09 --workers 4 --delay 0.12
```

The scraper writes:

- `data/flights.csv` for audit/export
- `data/flights.json` as a compact schema-plus-rows browser dataset for dashboard interactivity
- aggregate JSON files for reusable analytics outputs

## Run Locally

Serve the static dashboard from the repository root:

```powershell
py -m http.server 8000
```

Open:

```text
http://localhost:8000
```

Do not open `index.html` directly with `file://`; browser security rules can block JSON loading.

## Deploy Free on GitHub Pages

1. Push this repository to GitHub.
2. In GitHub, open repository settings.
3. Go to `Pages`.
4. Set the source to `Deploy from a branch`.
5. Select branch `main` and folder `/root`.
6. Save.

The public URL will look like:

```text
https://<github-username>.github.io/idaraty-interview/
```

## Data Notes

- `departure` pages use the status word `DECOLLE`.
- `arrival` pages use the status word `ATTERRI`.
- Delay is computed as actual local time minus scheduled local time.
- When a flight crosses midnight, the scraper chooses the nearest reasonable time difference.
- Delayed rate is computed from flights that have an actual time, not from cancelled or unknown-status rows.
