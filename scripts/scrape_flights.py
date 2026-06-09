from __future__ import annotations

import argparse
import calendar
import csv
import json
import re
import statistics
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import requests
from bs4 import BeautifulSoup


BASE_URL = "https://www.aeroport-de-tunis-carthage.com"
PAGE_URLS = {
    "departure": (
        BASE_URL
        + "/tunisie-aeroport-de-tunis-carthage-vol-depart-compagnie-TUNISAIR+-date-{date}"
    ),
    "arrival": (
        BASE_URL
        + "/tunisie-aeroport-de-tunis-carthage-vol-arrivee-compagnie-TUNISAIR+-date-{date}"
    ),
}
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (compatible; TunisairDelayDashboard/1.0; "
        "+https://github.com/)"
    )
}
TIME_RE = re.compile(r"\b([0-2]?\d):([0-5]\d)(?::([0-5]\d))?\b")


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value.replace("\xa0", " ")).strip()


def fold_text(value: str) -> str:
    normalized = unicodedata.normalize("NFD", value)
    no_accents = "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn")
    return no_accents.upper()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Scrape Tunisair arrival/departure delays from Tunis-Carthage pages."
    )
    parser.add_argument("--start", default="2020-01-01", help="Start date, YYYY-MM-DD.")
    parser.add_argument(
        "--end",
        default=date.today().isoformat(),
        help="End date, YYYY-MM-DD. Defaults to today.",
    )
    parser.add_argument("--out-dir", default="data", help="Output directory.")
    parser.add_argument(
        "--cache-dir",
        default=".cache/aeroport-pages",
        help="HTML cache directory. Use --no-cache to disable.",
    )
    parser.add_argument("--no-cache", action="store_true", help="Disable HTML caching.")
    parser.add_argument("--workers", type=int, default=4, help="Concurrent fetch workers.")
    parser.add_argument(
        "--delay",
        type=float,
        default=0.12,
        help="Delay before each network request per worker, in seconds.",
    )
    parser.add_argument("--timeout", type=float, default=20.0, help="Request timeout.")
    parser.add_argument("--retries", type=int, default=1, help="Retries per failed page.")
    parser.add_argument(
        "--progress-every",
        type=int,
        default=100,
        help="Print progress after this many pages.",
    )
    return parser.parse_args()


def date_range(start: date, end: date) -> list[date]:
    if end < start:
        raise ValueError("End date must be after start date.")
    days = (end - start).days
    return [start + timedelta(days=offset) for offset in range(days + 1)]


def parse_time_value(value: str) -> tuple[int, int] | None:
    match = TIME_RE.search(value)
    if not match:
        return None
    hour = int(match.group(1))
    minute = int(match.group(2))
    if hour > 23:
        return None
    return hour, minute


def extract_actual_time(status: str) -> str | None:
    status_folded = fold_text(status)
    if "ANNULE" in status_folded or "CANCEL" in status_folded:
        return None
    matches = list(TIME_RE.finditer(status))
    if not matches:
        return None
    match = matches[-1]
    hour = int(match.group(1))
    minute = int(match.group(2))
    if hour > 23:
        return None
    return f"{hour:02d}:{minute:02d}"


def compute_delay_minutes(day: date, scheduled: str, actual: str | None) -> int | None:
    scheduled_parts = parse_time_value(scheduled)
    actual_parts = parse_time_value(actual or "")
    if not scheduled_parts or not actual_parts:
        return None

    scheduled_dt = datetime.combine(day, datetime.min.time()).replace(
        hour=scheduled_parts[0], minute=scheduled_parts[1]
    )
    actual_same_day = datetime.combine(day, datetime.min.time()).replace(
        hour=actual_parts[0], minute=actual_parts[1]
    )
    candidates = [
        actual_same_day - scheduled_dt,
        actual_same_day + timedelta(days=1) - scheduled_dt,
        actual_same_day - timedelta(days=1) - scheduled_dt,
    ]
    closest = min(candidates, key=lambda item: abs(item.total_seconds()))
    return round(closest.total_seconds() / 60)


def fetch_html(
    scrape_day: date,
    direction: str,
    cache_dir: Path | None,
    delay: float,
    timeout: float,
    retries: int,
) -> tuple[date, str, str, str | None]:
    url = PAGE_URLS[direction].format(date=scrape_day.isoformat())
    cache_path = None
    if cache_dir is not None:
        cache_path = cache_dir / f"{scrape_day.isoformat()}-{direction}.html"
        if cache_path.exists():
            return scrape_day, direction, cache_path.read_text(encoding="utf-8"), None

    last_error = None
    for attempt in range(retries + 1):
        try:
            if delay > 0:
                time.sleep(delay)
            response = requests.get(url, headers=HEADERS, timeout=timeout)
            response.raise_for_status()
            text = response.content.decode("windows-1252", errors="replace")
            if cache_path is not None:
                cache_path.parent.mkdir(parents=True, exist_ok=True)
                cache_path.write_text(text, encoding="utf-8")
            return scrape_day, direction, text, None
        except requests.RequestException as exc:
            last_error = str(exc)
            if attempt < retries:
                time.sleep(0.5 * (attempt + 1))

    return scrape_day, direction, "", last_error or "Unknown request error"


def parse_page(html: str, scrape_day: date, direction: str) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "html.parser")
    records: list[dict[str, Any]] = []
    source_url = PAGE_URLS[direction].format(date=scrape_day.isoformat())

    for row in soup.find_all("tr"):
        cells = [clean_text(cell.get_text(" ", strip=True)) for cell in row.find_all("td", recursive=False)]
        if len(cells) < 5:
            continue

        scheduled_time, route, company, flight_number, status = cells[:5]
        if not re.match(r"^\d{1,2}:\d{2}(?::\d{2})?$", scheduled_time):
            continue
        if "TUNISAIR" not in fold_text(company):
            continue

        actual_time = extract_actual_time(status)
        delay_minutes = compute_delay_minutes(scrape_day, scheduled_time, actual_time)
        folded_status = fold_text(status)
        cancelled = "ANNULE" in folded_status or "CANCEL" in folded_status
        unknown_status = not cancelled and delay_minutes is None

        records.append(
            {
                "date": scrape_day.isoformat(),
                "year": scrape_day.year,
                "month": f"{scrape_day.year}-{scrape_day.month:02d}",
                "weekday": scrape_day.weekday(),
                "weekday_name": calendar.day_name[scrape_day.weekday()],
                "direction": direction,
                "scheduled_time": scheduled_time[:5],
                "scheduled_hour": int(scheduled_time[:2]),
                "route": route,
                "company": company,
                "flight_number": flight_number,
                "status": status,
                "actual_time": actual_time,
                "delay_minutes": delay_minutes,
                "delayed_15": delay_minutes is not None and delay_minutes > 15,
                "severe_60": delay_minutes is not None and delay_minutes > 60,
                "cancelled": cancelled,
                "unknown_status": unknown_status,
                "source_url": source_url,
            }
        )

    return records


def mean(values: list[int]) -> float | None:
    return round(sum(values) / len(values), 1) if values else None


def median(values: list[int]) -> float | None:
    return round(statistics.median(values), 1) if values else None


def pct(numerator: int, denominator: int) -> float:
    return round((numerator / denominator) * 100, 1) if denominator else 0.0


def completed(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [record for record in records if record["delay_minutes"] is not None]


def summarize(records: list[dict[str, Any]], start: date, end: date) -> dict[str, Any]:
    completed_records = completed(records)
    delays = [record["delay_minutes"] for record in completed_records]
    delayed_count = sum(1 for record in completed_records if record["delayed_15"])
    severe_count = sum(1 for record in completed_records if record["severe_60"])
    cancelled_count = sum(1 for record in records if record["cancelled"])
    unknown_count = sum(1 for record in records if record["unknown_status"])

    return {
        "generated_at": datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
        "scrape_start": start.isoformat(),
        "scrape_end": end.isoformat(),
        "source": BASE_URL,
        "airline": "TUNISAIR",
        "airport": "Tunis-Carthage",
        "total_flights": len(records),
        "completed_flights": len(completed_records),
        "cancelled_flights": cancelled_count,
        "unknown_statuses": unknown_count,
        "avg_delay_minutes": mean(delays),
        "median_delay_minutes": median(delays),
        "max_delay_minutes": max(delays) if delays else None,
        "delayed_15_count": delayed_count,
        "delayed_15_pct": pct(delayed_count, len(completed_records)),
        "severe_60_count": severe_count,
        "severe_60_pct": pct(severe_count, len(completed_records)),
    }


def group_records(records: list[dict[str, Any]], keys: tuple[str, ...]) -> dict[tuple[Any, ...], list[dict[str, Any]]]:
    grouped: dict[tuple[Any, ...], list[dict[str, Any]]] = {}
    for record in records:
        grouped.setdefault(tuple(record[key] for key in keys), []).append(record)
    return grouped


def aggregate_group(items: list[dict[str, Any]]) -> dict[str, Any]:
    completed_items = completed(items)
    delays = [item["delay_minutes"] for item in completed_items]
    return {
        "total_flights": len(items),
        "completed_flights": len(completed_items),
        "avg_delay_minutes": mean(delays),
        "median_delay_minutes": median(delays),
        "max_delay_minutes": max(delays) if delays else None,
        "delayed_15_count": sum(1 for item in completed_items if item["delayed_15"]),
        "delayed_15_pct": pct(sum(1 for item in completed_items if item["delayed_15"]), len(completed_items)),
        "severe_60_count": sum(1 for item in completed_items if item["severe_60"]),
        "severe_60_pct": pct(sum(1 for item in completed_items if item["severe_60"]), len(completed_items)),
        "cancelled_flights": sum(1 for item in items if item["cancelled"]),
        "unknown_statuses": sum(1 for item in items if item["unknown_status"]),
    }


def build_monthly(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    output = []
    for (month_value, direction), items in group_records(records, ("month", "direction")).items():
        output.append({"month": month_value, "direction": direction, **aggregate_group(items)})
    return sorted(output, key=lambda item: (item["month"], item["direction"]))


def build_routes(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    output = []
    for (route, direction), items in group_records(records, ("route", "direction")).items():
        output.append({"route": route, "direction": direction, **aggregate_group(items)})
    return sorted(
        output,
        key=lambda item: (
            item["avg_delay_minutes"] is None,
            -(item["avg_delay_minutes"] or -9999),
            -item["total_flights"],
        ),
    )


def build_flight_numbers(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    output = []
    for (flight_number, route, direction), items in group_records(
        records, ("flight_number", "route", "direction")
    ).items():
        output.append(
            {
                "flight_number": flight_number,
                "route": route,
                "direction": direction,
                **aggregate_group(items),
            }
        )
    return sorted(
        output,
        key=lambda item: (
            item["avg_delay_minutes"] is None,
            -(item["avg_delay_minutes"] or -9999),
            -item["total_flights"],
        ),
    )


def build_time_patterns(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    output = []
    grouped = group_records(records, ("weekday", "scheduled_hour"))
    for weekday in range(7):
        for hour in range(24):
            items = grouped.get((weekday, hour), [])
            output.append(
                {
                    "weekday": weekday,
                    "weekday_name": calendar.day_name[weekday],
                    "hour": hour,
                    **aggregate_group(items),
                }
            )
    return output


def build_dashboard_records(records: list[dict[str, Any]]) -> dict[str, Any]:
    schema = [
        "date",
        "year",
        "month",
        "weekday",
        "direction",
        "scheduled_hour",
        "route",
        "flight_number",
        "delay_minutes",
        "cancelled",
        "unknown_status",
    ]
    return {
        "schema": schema,
        "records": [[record[field] for field in schema] for record in records],
    }


def write_json(path: Path, payload: Any, *, compact: bool = False) -> None:
    if compact:
        text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    else:
        text = json.dumps(payload, ensure_ascii=False, indent=2)
    path.write_text(text, encoding="utf-8")


def write_csv(path: Path, records: list[dict[str, Any]]) -> None:
    fieldnames = [
        "date",
        "year",
        "month",
        "weekday",
        "weekday_name",
        "direction",
        "scheduled_time",
        "scheduled_hour",
        "route",
        "company",
        "flight_number",
        "status",
        "actual_time",
        "delay_minutes",
        "delayed_15",
        "severe_60",
        "cancelled",
        "unknown_status",
        "source_url",
    ]
    with path.open("w", encoding="utf-8", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(records)


def scrape(args: argparse.Namespace) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    start = date.fromisoformat(args.start)
    end = date.fromisoformat(args.end)
    days = date_range(start, end)
    cache_dir = None if args.no_cache else Path(args.cache_dir)
    tasks = [(scrape_day, direction) for scrape_day in days for direction in PAGE_URLS]
    records: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []

    print(f"Scraping {len(tasks)} pages from {start} to {end}...")
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
        futures = [
            executor.submit(
                fetch_html,
                scrape_day,
                direction,
                cache_dir,
                args.delay,
                args.timeout,
                args.retries,
            )
            for scrape_day, direction in tasks
        ]
        for index, future in enumerate(as_completed(futures), start=1):
            scrape_day, direction, html, error = future.result()
            if error:
                errors.append(
                    {
                        "date": scrape_day.isoformat(),
                        "direction": direction,
                        "error": error,
                    }
                )
            else:
                records.extend(parse_page(html, scrape_day, direction))
            if args.progress_every and index % args.progress_every == 0:
                print(f"  fetched {index}/{len(tasks)} pages, records={len(records)}")

    if errors:
        print(f"Completed with {len(errors)} page errors. See scrape_errors.json.")
    return (
        sorted(records, key=lambda item: (item["date"], item["direction"], item["scheduled_time"])),
        errors,
    )


def main() -> None:
    args = parse_args()
    start = date.fromisoformat(args.start)
    end = date.fromisoformat(args.end)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    records, errors = scrape(args)
    write_csv(out_dir / "flights.csv", records)
    write_json(out_dir / "flights.json", build_dashboard_records(records), compact=True)
    write_json(out_dir / "scrape_errors.json", errors)
    write_json(out_dir / "summary.json", summarize(records, start, end))
    write_json(out_dir / "monthly.json", build_monthly(records))
    write_json(out_dir / "routes.json", build_routes(records))
    write_json(out_dir / "flight_numbers.json", build_flight_numbers(records))
    write_json(out_dir / "time_patterns.json", build_time_patterns(records))

    print(f"Wrote {len(records)} records to {out_dir.resolve()}")


if __name__ == "__main__":
    main()
