const DATA_PATHS = {
  flights: "data/flights.json",
  summary: "data/summary.json",
};

const state = {
  year: "all",
  direction: "all",
  threshold: 15,
  tableMode: "routes",
  tableSort: "avg_delay",
  tableSearch: "",
};

const appData = {
  flights: [],
  summary: null,
};

const charts = {};
const chartPalette = ["#1e40af", "#0f766e", "#d97706", "#b91c1c", "#3b82f6"];
const directionLabels = {
  arrival: "Arrivals",
  departure: "Departures",
};
const weekdayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function $(selector) {
  return document.querySelector(selector);
}

function setText(selector, value) {
  const node = $(selector);
  if (node) node.textContent = value;
}

function formatInteger(value) {
  return new Intl.NumberFormat("en-US").format(value || 0);
}

function formatMinutes(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${Math.round(value)} min`;
}

function formatDecimal(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return value.toFixed(1);
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${value.toFixed(1)}%`;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function percent(numerator, denominator) {
  return denominator ? (numerator / denominator) * 100 : 0;
}

function groupBy(items, keyFn) {
  return items.reduce((groups, item) => {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
    return groups;
  }, new Map());
}

function isCompleted(record) {
  return Number.isFinite(record.delay_minutes);
}

function aggregate(records, threshold = state.threshold) {
  const completed = records.filter(isCompleted);
  const delays = completed.map((record) => record.delay_minutes);
  const delayed = completed.filter((record) => record.delay_minutes > threshold);
  const severe = completed.filter((record) => record.delay_minutes > 60);
  const cancelled = records.filter((record) => record.cancelled);
  const unknown = records.filter((record) => record.unknown_status);

  return {
    totalFlights: records.length,
    completedFlights: completed.length,
    avgDelay: mean(delays),
    medianDelay: median(delays),
    maxDelay: delays.length ? Math.max(...delays) : null,
    delayedCount: delayed.length,
    delayedPct: percent(delayed.length, completed.length),
    severeCount: severe.length,
    severePct: percent(severe.length, completed.length),
    cancelledCount: cancelled.length,
    unknownCount: unknown.length,
  };
}

function filteredFlights() {
  return appData.flights.filter((record) => {
    const yearMatch = state.year === "all" || String(record.year) === state.year;
    const directionMatch = state.direction === "all" || record.direction === state.direction;
    return yearMatch && directionMatch;
  });
}

function normalizeFlights(payload) {
  const records = Array.isArray(payload)
    ? payload
    : payload.records.map((row) =>
        payload.schema.reduce((record, field, index) => {
          record[field] = row[index];
          return record;
        }, {})
      );

  return records.map((record) => ({
    ...record,
    year: Number(record.year),
    weekday: Number(record.weekday),
    scheduled_hour: Number(record.scheduled_hour),
    delay_minutes:
      record.delay_minutes === null || record.delay_minutes === undefined
        ? null
        : Number(record.delay_minutes),
    delayed_15: Boolean(record.delayed_15),
    severe_60: Boolean(record.severe_60),
    cancelled: Boolean(record.cancelled),
    unknown_status: Boolean(record.unknown_status),
  }));
}

function setupFilters() {
  const years = [...new Set(appData.flights.map((record) => record.year))].sort((a, b) => a - b);
  const yearFilter = $("#yearFilter");
  yearFilter.innerHTML = [
    '<option value="all">All years</option>',
    ...years.map((year) => `<option value="${year}">${year}</option>`),
  ].join("");

  yearFilter.addEventListener("change", (event) => {
    state.year = event.target.value;
    renderDashboard();
  });

  $("#directionFilter").addEventListener("change", (event) => {
    state.direction = event.target.value;
    renderDashboard();
  });

  $("#thresholdFilter").addEventListener("change", (event) => {
    state.threshold = Number(event.target.value);
    renderDashboard();
  });

  $("#resetFilters").addEventListener("click", () => {
    state.year = "all";
    state.direction = "all";
    state.threshold = 15;
    $("#yearFilter").value = "all";
    $("#directionFilter").value = "all";
    $("#thresholdFilter").value = "15";
    renderDashboard();
  });

  $("#tableSearch").addEventListener("input", (event) => {
    state.tableSearch = event.target.value.trim().toLowerCase();
    renderTable(filteredFlights());
  });

  $("#tableSort").addEventListener("change", (event) => {
    state.tableSort = event.target.value;
    renderTable(filteredFlights());
  });

  document.querySelectorAll("[data-table-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.tableMode = button.dataset.tableMode;
      document
        .querySelectorAll("[data-table-mode]")
        .forEach((item) => item.classList.toggle("is-active", item === button));
      $("#entityHeader").textContent = state.tableMode === "routes" ? "Route" : "Flight";
      renderTable(filteredFlights());
    });
  });
}

function updateMeta(records) {
  const summary = appData.summary;
  const generated = summary?.generated_at ? new Date(summary.generated_at) : null;
  setText(
    "#datasetRange",
    summary ? `Range ${summary.scrape_start} to ${summary.scrape_end}` : "Range unavailable"
  );
  setText("#datasetCount", `${formatInteger(records.length)} selected flights`);
  setText(
    "#datasetUpdated",
    generated && !Number.isNaN(generated.getTime())
      ? `Updated ${generated.toLocaleDateString()}`
      : "Update time unavailable"
  );
}

function renderKpis(records) {
  const metrics = aggregate(records);
  const issueTotal = metrics.cancelledCount + metrics.unknownCount;
  setText("#kpiFlights", formatInteger(metrics.totalFlights));
  setText("#kpiCompleted", `${formatInteger(metrics.completedFlights)} completed`);
  setText("#kpiAverage", formatMinutes(metrics.avgDelay));
  setText("#kpiMedian", `${formatMinutes(metrics.medianDelay)} median`);
  setText("#kpiDelayed", formatPercent(metrics.delayedPct));
  setText(
    "#kpiDelayedCount",
    `${formatInteger(metrics.delayedCount)} flights over ${state.threshold} min`
  );
  setText("#kpiSevere", formatPercent(metrics.severePct));
  setText("#kpiSevereCount", `${formatInteger(metrics.severeCount)} over 60 min`);
  setText("#kpiIssues", formatInteger(issueTotal));
  setText("#kpiUnknown", `${formatInteger(metrics.unknownCount)} unknown`);
}

function getChart(id) {
  if (!charts[id]) {
    charts[id] = echarts.init(document.getElementById(id), null, { renderer: "canvas" });
  }
  return charts[id];
}

function chartBaseOption() {
  return {
    color: chartPalette,
    textStyle: {
      fontFamily: "Fira Sans, Arial, sans-serif",
      color: "#111827",
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: "#ffffff",
      borderColor: "#bfdbfe",
      borderWidth: 1,
      textStyle: { color: "#111827" },
    },
    grid: {
      left: 54,
      right: 26,
      top: 44,
      bottom: 58,
      containLabel: true,
    },
  };
}

function renderTrendChart(records) {
  const chart = getChart("trendChart");
  const months = [...new Set(records.map((record) => record.month))].sort();
  const directions =
    state.direction === "all" ? ["arrival", "departure"] : [state.direction];

  const series = directions.map((direction) => ({
    name: directionLabels[direction],
    type: "line",
    smooth: true,
    showSymbol: false,
    symbolSize: 6,
    connectNulls: true,
    emphasis: { focus: "series" },
    data: months.map((month) => {
      const items = records.filter(
        (record) => record.month === month && record.direction === direction && isCompleted(record)
      );
      const value = mean(items.map((record) => record.delay_minutes));
      return value === null ? null : Number(value.toFixed(1));
    }),
  }));

  chart.setOption({
    ...chartBaseOption(),
    legend: { top: 0, right: 12 },
    xAxis: {
      type: "category",
      data: months,
      axisLabel: { hideOverlap: true },
    },
    yAxis: {
      type: "value",
      name: "Minutes",
      splitLine: { lineStyle: { color: "#e5edf8" } },
    },
    series,
  });
}

function renderDirectionChart(records) {
  const chart = getChart("directionChart");
  const directions =
    state.direction === "all" ? ["arrival", "departure"] : [state.direction];
  const labels = directions.map((direction) => directionLabels[direction]);
  const aggregates = directions.map((direction) =>
    aggregate(records.filter((record) => record.direction === direction))
  );

  chart.setOption({
    ...chartBaseOption(),
    legend: { top: 0, right: 12 },
    xAxis: { type: "category", data: labels },
    yAxis: [
      {
        type: "value",
        name: "Minutes",
        splitLine: { lineStyle: { color: "#e5edf8" } },
      },
      {
        type: "value",
        name: "%",
        min: 0,
        max: 100,
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: "Avg delay",
        type: "bar",
        barMaxWidth: 44,
        data: aggregates.map((item) =>
          item.avgDelay === null ? null : Number(item.avgDelay.toFixed(1))
        ),
      },
      {
        name: `Delayed > ${state.threshold} min`,
        type: "line",
        yAxisIndex: 1,
        symbolSize: 8,
        data: aggregates.map((item) => Number(item.delayedPct.toFixed(1))),
      },
    ],
  });
}

function buildRouteRows(records) {
  return [...groupBy(records, (record) => `${record.direction}|${record.route}`).entries()].map(
    ([key, items]) => {
      const [direction, route] = key.split("|");
      return {
        entity: route,
        subEntity: directionLabels[direction],
        direction,
        ...aggregate(items),
      };
    }
  );
}

function buildFlightRows(records) {
  return [
    ...groupBy(
      records,
      (record) => `${record.direction}|${record.flight_number}|${record.route}`
    ).entries(),
  ].map(([key, items]) => {
    const [direction, flightNumber, route] = key.split("|");
    return {
      entity: flightNumber,
      subEntity: route,
      direction,
      ...aggregate(items),
    };
  });
}

function sortRows(rows) {
  const sorters = {
    avg_delay: (row) => row.avgDelay ?? -Infinity,
    delayed_pct: (row) => row.delayedPct ?? -Infinity,
    total_flights: (row) => row.totalFlights,
    max_delay: (row) => row.maxDelay ?? -Infinity,
  };
  const getValue = sorters[state.tableSort] || sorters.avg_delay;
  return rows.sort((a, b) => getValue(b) - getValue(a) || b.totalFlights - a.totalFlights);
}

function renderRouteChart(records) {
  const chart = getChart("routeChart");
  let rows = buildRouteRows(records)
    .filter((row) => row.completedFlights >= 5 && row.avgDelay !== null)
    .sort((a, b) => b.avgDelay - a.avgDelay)
    .slice(0, 10);

  if (!rows.length) {
    rows = buildRouteRows(records)
      .filter((row) => row.avgDelay !== null)
      .sort((a, b) => b.avgDelay - a.avgDelay)
      .slice(0, 10);
  }

  rows = rows.reverse();
  chart.setOption({
    ...chartBaseOption(),
    grid: { left: 150, right: 24, top: 16, bottom: 24, containLabel: false },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      valueFormatter: (value) => `${value} min`,
    },
    xAxis: {
      type: "value",
      name: "Minutes",
      splitLine: { lineStyle: { color: "#e5edf8" } },
    },
    yAxis: {
      type: "category",
      data: rows.map((row) => `${row.entity} (${row.direction[0].toUpperCase()})`),
      axisLabel: {
        width: 136,
        overflow: "truncate",
      },
    },
    series: [
      {
        name: "Avg delay",
        type: "bar",
        barMaxWidth: 18,
        data: rows.map((row) => Number(row.avgDelay.toFixed(1))),
      },
    ],
  });
}

function renderHeatmap(records) {
  const chart = getChart("heatmapChart");
  const grouped = groupBy(
    records.filter(isCompleted),
    (record) => `${record.weekday}|${record.scheduled_hour}`
  );
  const data = [];
  const values = [];

  for (let weekday = 0; weekday < 7; weekday += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const items = grouped.get(`${weekday}|${hour}`) || [];
      const avg = mean(items.map((record) => record.delay_minutes));
      const value = avg === null ? null : Number(avg.toFixed(1));
      data.push([hour, weekday, value]);
      if (value !== null) values.push(value);
    }
  }

  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;

  chart.setOption({
    ...chartBaseOption(),
    tooltip: {
      position: "top",
      formatter: (params) => {
        const [hour, weekday, value] = params.value;
        return `${weekdayLabels[weekday]} ${String(hour).padStart(2, "0")}:00<br/>${
          value === null ? "No flights" : `${value} min average delay`
        }`;
      },
    },
    grid: { left: 58, right: 30, top: 28, bottom: 74 },
    xAxis: {
      type: "category",
      data: Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}:00`),
      splitArea: { show: true },
      axisLabel: { interval: 2 },
    },
    yAxis: {
      type: "category",
      data: weekdayLabels,
      splitArea: { show: true },
    },
    visualMap: {
      min,
      max,
      calculable: true,
      orient: "horizontal",
      left: "center",
      bottom: 12,
      inRange: {
        color: ["#dbeafe", "#3b82f6", "#d97706", "#b91c1c"],
      },
    },
    series: [
      {
        name: "Avg delay",
        type: "heatmap",
        data,
        label: { show: false },
        emphasis: {
          itemStyle: {
            shadowBlur: 8,
            shadowColor: "rgba(15, 23, 42, 0.25)",
          },
        },
      },
    ],
  });
}

function renderTable(records) {
  const rows = state.tableMode === "routes" ? buildRouteRows(records) : buildFlightRows(records);
  const search = state.tableSearch;
  const filteredRows = rows.filter((row) => {
    const haystack = `${row.entity} ${row.subEntity} ${row.direction}`.toLowerCase();
    return !search || haystack.includes(search);
  });
  const sortedRows = sortRows(filteredRows).slice(0, 25);
  const body = $("#rankedTableBody");

  if (!sortedRows.length) {
    body.innerHTML = `<tr><td colspan="8">No matching rows for the selected filters.</td></tr>`;
    return;
  }

  body.innerHTML = sortedRows
    .map(
      (row, index) => `
        <tr>
          <td class="numeric">${index + 1}</td>
          <td>
            <span class="entity-main">${escapeHtml(row.entity)}</span>
            <span class="entity-sub">${escapeHtml(row.subEntity)}</span>
          </td>
          <td><span class="direction-pill">${escapeHtml(row.direction)}</span></td>
          <td class="numeric">${formatInteger(row.totalFlights)}</td>
          <td class="numeric">${formatMinutes(row.avgDelay)}</td>
          <td class="numeric">${formatPercent(row.delayedPct)}</td>
          <td class="numeric">${formatPercent(row.severePct)}</td>
          <td class="numeric">${formatMinutes(row.maxDelay)}</td>
        </tr>
      `
    )
    .join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderDashboard() {
  const records = filteredFlights();
  updateMeta(records);
  renderKpis(records);
  renderTrendChart(records);
  renderDirectionChart(records);
  renderRouteChart(records);
  renderHeatmap(records);
  renderTable(records);
  setText("#statusMessage", "");
}

async function loadJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load ${path}: ${response.status}`);
  }
  return response.json();
}

async function init() {
  try {
    const [flights, summary] = await Promise.all([
      loadJson(DATA_PATHS.flights),
      loadJson(DATA_PATHS.summary),
    ]);
    appData.flights = normalizeFlights(flights);
    appData.summary = summary;
    setupFilters();
    renderDashboard();
    window.addEventListener("resize", () => {
      Object.values(charts).forEach((chart) => chart.resize());
    });
  } catch (error) {
    setText(
      "#statusMessage",
      "Dashboard data could not be loaded. Run the scraper and open the site through a local server."
    );
    console.error(error);
  }
}

document.addEventListener("DOMContentLoaded", init);
