# AeroTrace

AeroTrace is a local-first flight recorder and analysis dashboard for Microsoft Flight Simulator. It provides a Next.js operations dashboard, an interactive MapLibre route map, telemetry charts and timeline, a loopback-only Python connector, versioned telemetry contracts, selectable demo and SimConnect providers, and SQLite persistence.

**Demo mode is visibly marked and uses synthetic data only.** Real recordings use a distinct `simconnect` source and are never populated from demo telemetry. The real adapter is optional and requires Windows and the separately installed `requirements-msfs.txt` dependency. It has mock coverage, but has not been validated against a live simulator on this machine.

## Requirements

- Node.js 20.9 or newer (current Next.js installation requirement).
- Python 3.11 or newer, 64-bit on Windows for the planned SimConnect integration.
- Microsoft Flight Simulator and a 64-bit Windows Python installation are required for real recording. They are not required for demo mode.

## Install and run

From the repository root, in separate terminals:

```powershell
npm install
python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
npm run connector
```

In another terminal, run `npm run dev`, then open <http://127.0.0.1:3000>. The frontend and connector bind to loopback only (`127.0.0.1:3000` and `127.0.0.1:8765`). The frontend uses Next.js Webpack mode for the MapLibre ESM worker in this Windows setup. Do not change either bind address to `0.0.0.0` for ordinary local use. The frontend rejects connector URL overrides that do not point to loopback HTTP.

## Public demo deployment

`NEXT_PUBLIC_DEMO_MODE` selects the data source at **build time**. Set it to `true` in the deployment platform's build environment before building the public demo. The recorder, flight history, and report pages then use generated sample flights through the existing flight contracts and UI. Recording controls are read-only, and the local Python connector and local archive are not contacted. Every page displays **DEMO DATA — NOT LIVE MSFS TELEMETRY**. MapLibre's existing public demo map style still needs an internet connection.

Deployment steps:

1. Use a hosting platform with Next.js App Router support and configure `NEXT_PUBLIC_DEMO_MODE=true` for the production build (and preview builds, if needed).
2. Build and deploy the Next.js app with the platform's standard Next.js integration: `npm ci` followed by `npm run build`.
3. Do not deploy or start `npm run connector` for the public demo. Verify `/`, `/flights`, and a flight opened from the sample list after deployment.
4. To return to a local MSFS build, set `NEXT_PUBLIC_DEMO_MODE=false` or remove it, then rebuild and deploy. `NEXT_PUBLIC_` values are embedded at build time, so changing the platform variable without rebuilding does not change the running bundle.

For a local production preview of the sample-data build, set `NEXT_PUBLIC_DEMO_MODE=true` before `npm run build`, then run `npm run start`. The existing local connector behavior is preserved when the flag is `false` or unset.

To exercise the workflow, select **DEMO**, choose **Start Demo Flight**, let samples arrive, then choose **Complete Flight**. For real recording, install the optional package in the project environment with `python -m pip install -r requirements-msfs.txt`, start MSFS, select **MSFS**, wait for **WAITING FOR FLIGHT**, then choose **Start MSFS Flight**. Complete Flight persists only observed SimConnect readings. A missing SimVar remains unavailable; a paused simulator produces no samples. The selected provider cannot be switched during recording. Completed sessions and samples are saved under `%USERPROFILE%\.aerotrace\flights.sqlite3` by default. Set `AEROTRACE_DB` to use a different SQLite file. Set `NEXT_PUBLIC_AEROTRACE_API_URL` if the loopback connector uses a different local URL.

The route map loads its style and vector tiles from `https://demotiles.maplibre.org/style.json`, a public MapLibre demo service. Map tiles require an internet connection; telemetry capture, charts and local persistence continue to use the local connector. Replace this style with a production tile provider before distributing AeroTrace broadly. The app does not send telemetry to the tile provider.

## Development commands

```powershell
npm run dev             # Next.js dev server, 127.0.0.1:3000
npm run build           # Production frontend build
npm run start           # Serve build, 127.0.0.1:3000
npm run lint            # ESLint
npm run format          # Format supported files
npm run format:check    # Check formatting
npm run connector       # Local API at 127.0.0.1:8765
npm run test:frontend   # Frontend API/data workflow tests
npm run test:connector  # Python contract, lifecycle, API and WebSocket tests
```

## Architecture

- `src/app` — Next.js App Router shell and global styling.
- `src/components/flight-console.tsx` — retained console entry point.
- `src/components/flight-dashboard.tsx` — dashboard lifecycle, connector status, demo controls and telemetry integration.
- `src/components/flight-history.tsx` — persisted session history and available summaries.
- `src/components/post-flight-report.tsx` — report fetch/retry state, playback controls and summary presentation.
- `src/components/flight-replay-map.tsx`, `flight-report-charts.tsx`, and `flight-report-timeline.tsx` — recorded route replay, synchronized telemetry charts, and backend event/phase timeline.
- `src/lib/flight-api.ts` — validated client for persisted flight reports, analysis, paginated telemetry, and idempotent completion confirmation.
- `src/lib/flight-report-model.ts` — display-only chart thinning and unit conversion; it does not modify saved samples or backend summaries.
- `src/app/flights` — history and direct session report routes.
- `src/components/route-map.tsx` — MapLibre route from received position samples, aircraft marker, heading and map controls.
- `src/components/flight-charts.tsx` — altitude, airspeed/ground speed and vertical-speed charts, visually downsampled for long recordings while retaining raw samples in state/storage.
- `src/components/event-timeline.tsx` — session events based on connector lifecycle and received telemetry; inferred data gaps and calculated on-ground changes are labelled.
- `src/lib/contracts.ts` — TypeScript mirror of versioned JSON contracts.
- `connector/contracts.py` — authoritative Python/Pydantic validation for incoming and stored telemetry.
- `connector/lifecycle.py` — explicit legal state transitions.
- `connector/providers.py` — shared telemetry provider contract and synthetic provider.
- `connector/simconnect_provider.py` — optional Windows adapter for Python-SimConnect, with explicit unit conversion, source validation, pause state and connection checks.
- `connector/storage.py` — SQLite repository with atomic sample/count commits, ordering indexes and active-session recovery.
- `connector/analysis.py` — deterministic phase, route, event and summary calculations over stored samples.
- `connector/api.py` — loopback HTTP API, telemetry WebSocket and lifecycle orchestration. The database opens at connector startup so interrupted sessions can be recovered.

## Data contract v1.0

Both session and telemetry objects carry `schemaVersion: "1.0"`. Timestamps are ISO 8601 with an offset. The SimConnect wrapper exposes no source sample timestamp through its basic request API, so real sample timestamps mean UTC observation time at AeroTrace, not simulator time. Each telemetry field has a unit in its name: latitude/longitude/heading in degrees, altitude in metres MSL, airspeed/ground speed/vertical speed in metres per second. The adapter requests latitude/longitude in degrees, plane altitude in feet (MSL), true heading in radians, indicated airspeed and ground velocity in knots, vertical speed in feet/minute, and SIM ON GROUND as Bool, then converts to the canonical units. `null` means unavailable or rejected as invalid. `source` distinguishes `demo` from `simconnect`; `quality` distinguishes simulator-observed values from calculated values. Demo values are calculated and should never be presented as actual aircraft measurements.

A `FlightSession` has a persistent UUID, source, lifecycle state, start/completion/interruption timestamps, sample count, optional aircraft name and optional error. Flight lifecycle progression is `disconnected → connected → recording → finalizing → completed`. If the connector restarts while a session is recording/finalizing, startup marks it `interrupted`; it is never silently completed. Simulator connectivity is separate: `not_detected`, `connecting`, `waiting_for_flight`, `recording`, `connection_lost`, `reconnecting`, or `error`. A connected simulator does not begin recording until the user starts a flight.

Each sample insert and session sample-count update commit in one SQLite transaction. Stored timestamps are normalized to UTC. New writes deduplicate by session/sample ID and by session/UTC observation timestamp. A sample must reference an existing recording session and match its provider; finalization changes the persisted state first, so later samples are refused. Historical duplicate rows are preserved when opening older databases; analysis reports equal-timestamp duplicates and uses a deterministic sample for calculations. Flight/sample reads are ordered by timestamp and sample ID. SQLite uses WAL mode, foreign keys, a session/time index and per-operation connection cleanup. A per-database operating-system lock prevents a second connector process from treating another live connector's active session as interrupted. If the owning connector exits unexpectedly, its next startup marks recording/finalizing sessions as interrupted and repairs the persisted sample count; it does not mark them completed.

## Local protocol

Base URL: `http://127.0.0.1:8765` (WebSocket: `ws://127.0.0.1:8765`). The service allows browser requests only from the local Next.js development origins.

| Method | Path                                  | Purpose                                                                                           |
| ------ | ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `GET`  | `/health`                             | Connector availability and version.                                                               |
| `GET`  | `/api/status`                         | Current lifecycle, active session, source and optional error message.                             |
| `POST` | `/api/provider/select/demo`           | Explicitly select synthetic demo mode; unavailable while recording/finalizing.                    |
| `POST` | `/api/provider/select/simconnect`     | Explicitly connect to MSFS; failures are returned and never fall back to demo.                    |
| `POST` | `/api/flights/start`                  | Start the selected provider. Real source requires a connected simulator.                          |
| `POST` | `/api/demo/start`                     | Start an explicitly synthetic demo session; returns `409` if already recording/finalizing.        |
| `POST` | `/api/flights/complete`               | Finalize the named session using `{"sessionId":"<uuid>"}`; idempotent for that completed session. |
| `GET`  | `/api/flights`                        | List stored sessions.                                                                             |
| `GET`  | `/api/flights/{session_id}`           | Flight metadata and calculated summary.                                                           |
| `GET`  | `/api/flights/{session_id}/analysis`  | Full summary, classified phases, derived events and route segments.                               |
| `GET`  | `/api/flights/{session_id}/events`    | Session, takeoff/landing and telemetry/route-gap events.                                          |
| `GET`  | `/api/flights/{session_id}/phases`    | Time intervals with phase confidence and uncertainty.                                             |
| `GET`  | `/api/flights/{session_id}/telemetry` | Timestamp-ordered samples; accepts optional `offset` and `limit` (1–10,000; default 1,000).       |
| `WS`   | `/ws/telemetry`                       | Stream each validated telemetry sample as a JSON text frame.                                      |

The `/api/status` response reports flight `state`, active `source`, selected `selectedSource`, `session`, and a `simulator` object containing connection `state`, `paused`, and optional `message`. Completion is scoped to the supplied session ID: repeating completion for that same completed session returns its saved record, an unknown session returns `404`, and a non-active or interrupted session returns `409`. A delayed retry cannot complete a different, newer recording. A complete report has `{session, recordingStatus, summary}`; the analysis endpoint returns `{sessionId, recordingStatus, summary, phases, events, routeSegments}`. Missing telemetry values remain `null`. Telemetry history stays a JSON array for frontend compatibility; add `offset`/`limit` to page it. Clients should validate `schemaVersion` and ignore unsupported versions. AeroTrace reads data only and does not write simulation variables. Mutating browser requests and WebSocket handshakes reject unrecognized browser origins; non-browser local clients may omit `Origin`.

## Recorder, history and post-flight report

- `/` is the recorder. **Complete Flight** submits the active session ID, waits for the connector to confirm that exact persisted session as completed, then loads its report, analysis and telemetry pages before navigating to `/flights/{session_id}`. If report retrieval fails after completion, **Retry Report** loads the saved session again without resubmitting completion. If finalization itself fails, the action can safely be retried; the backend completion endpoint is idempotent for that session ID.
- `/flights` lists sessions returned by `GET /api/flights`. It loads each session's existing report summary for duration and route distance. If one summary is unavailable, that session remains in the list and can still be opened to retry its report.
- `/flights/{session_id}` loads report and analysis metadata and pages through persisted telemetry with `offset` and `limit`. It supports direct URLs and browser refresh; the simulator does not need to remain connected. Interrupted and active reports retain their actual status.
- Report timestamps are shown in UTC. Aircraft is shown only when recorded; the connector does not identify departure or destination airports, so the report labels them as unavailable.
- Route replay uses the API's persisted route segments, including known gaps, and the samples saved for that session. Playback selection updates the map position, readouts and shared UTC cursor across the charts. Chart rendering is evenly thinned to at most 1,200 points; persisted samples and the recorded map track are not changed by display thinning.
- Summary values come from the backend analysis response. Missing measurements stay unavailable, demo source is explicitly labelled synthetic, and the data-quality section reports null-field counts, route gaps and unsupported calculations.
- The live recorder retains a rolling view of at most 5,000 samples in the browser. On initial connection and each WebSocket reconnect, it checks the current session and fetches the bounded persisted tail, then merges by sample ID and UTC observation time. The header's sample count is the connector's persisted session count; the chart labels the rolling window when it is smaller than the full recording. Complete reports page all persisted telemetry.
- `npm run test:frontend` covers exact-session completion payloads, loopback-only API overrides, bounded and identity-checked telemetry sync, ordering/deduplication, elapsed chart labels, duplicate-action locking, report identity/retry behavior, interrupted reports, source provenance, missing values and chart alignment. It uses mocked HTTP responses and does not require MSFS.

## Summary and analysis definitions

- Recording duration uses `startedAt` to `completedAt` for completed sessions; active sessions use the current time. An interrupted/error session only reports the span through its last persisted sample and labels the duration accordingly. This wall-clock interval can include pause/disconnect time.
- Airborne duration is separate and uses observed `onGround` transitions. Complete observed takeoff/landing pairs are summed; an unlanded takeoff is partial. No takeoff/landing duration is reported without an observed transition.
- Altitude, indicated airspeed, ground speed and vertical-rate extrema use available non-null samples only. Average ground speed is the arithmetic mean of available ground-speed samples.
- Sample coverage is an approximate 1 Hz sample count divided by expected wall-clock samples, capped at 100%; it does not subtract pauses/outages. Position coverage is the percent of samples with both valid coordinates.
- Route distance is the sum of great-circle distances between valid, consecutive fixes with at most a 30-second gap. A longer gap is excluded, split into separate route segments and reported as a route-gap event. The straight-line segment between fixes is an approximation of the recorded track, not an interpolated path.
- Phase rules use observed ground state and vertical speed. Climb/descent use a 0.8 m/s threshold; short phase flickers under 10 seconds are smoothed when neighboring phases agree. A sustained final descent (at least 30 seconds) before an observed landing is labelled approach with medium confidence because altitude is MSL and no AGL value is available. Unsupported classifications remain `uncertain` with a reason. Phase time sums only intervals between samples no more than 30 seconds apart.
- Events do not estimate departure/destination airports, touchdown vertical speed or landing quality. No measurements are filled in across gaps.

## MSFS integration scope and limitations

The optional dependency is `SimConnect==0.4.26` from [odwdinc/Python-SimConnect on PyPI](https://pypi.org/project/SimConnect/), whose published README identifies MSFS 2020 and Windows/64-bit Python. PyPI declares Python `>=3.6` but only lists classifiers through Python 3.8; compatibility with the project's newer Python runtime is unverified. It bundles/uses the legacy SimConnect DLL, so an SDK install is not required by this adapter. The package's [GitHub README](https://github.com/odwdinc/Python-SimConnect) and PyPI metadata identify its license as AGPL-3.0; review that license before redistribution. Microsoft's [MSFS 2024 SDK compatibility note](https://docs.flightsimulator.com/msfs2024/retail/programming-apis/simconnect/simconnect-sdk/) says legacy clients built with the MSFS 2020 SDK are detected as 2020 clients and continue to work without 2024-only features. That documents compatibility at the SDK level, but AeroTrace has not been live-tested on MSFS 2024; the Python package itself only advertises 2020. Live MSFS 2020 behavior also needs a smoke test with the installation that will be used.

The adapter runs only on Windows. Select MSFS to attempt a local SimConnect connection. It retries after disconnection, preserves the selected real provider, and never substitutes demo data. The package's request API timestamps samples at receipt/observation time because it does not expose source timestamps in this integration. During startup/loading, unsupported or invalid values are `null`; entirely empty samples are not stored. Pause/unpause events are read from SimConnect and pause suppresses new samples. The adapter has mocked tests only in this repository run; live startup/shutdown, loading and pause behavior remain to be confirmed with MSFS installed.

## Verification notes

The dashboard consumes telemetry only from the connector. Its WebSocket reconnects with backoff and synchronizes the most recent persisted sample window after each connection, deduplicating by sample ID. The map fits the route once per session and also provides explicit fit and center controls. Live charts and the timeline use a bounded rolling window; saved reports page the complete recording. Charts render at most 900 evenly spaced points from the available view. Chart gaps remain visible when a metric is unavailable. Sub-minute chart elapsed labels are shown in seconds rather than repeating `0m`.

The event timeline reports confirmed start/completion and received telemetry, observed on-ground flag changes, and inferred sample gaps. It does not label touchdown quality, unstable approaches or landing performance. Real SimConnect recording cannot be verified without an installed simulator and SDK. Browser map rendering depends on access to the public MapLibre demo style/tiles.
