"""Loopback-only HTTP/WebSocket API for the AeroTrace local application."""
import asyncio
import os
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from threading import Lock
from uuid import UUID, uuid4

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .contracts import CompleteFlightRequest, FlightSession, Lifecycle, SimulatorState, Source, TelemetrySample, utc_now
from .analysis import FlightAnalysis, FlightEvent, FlightReport, PhaseInterval, analyze_flight
from .lifecycle import LifecycleMachine
from .providers import DemoTelemetryProvider, TelemetryProvider
from .simconnect_provider import SimConnectTelemetryProvider
from .storage import ActiveSessionExists, SQLiteFlightStore, SessionNotRecording

DB_PATH = Path(os.environ.get("AEROTRACE_DB", Path.home() / ".aerotrace" / "flights.sqlite3"))
store: SQLiteFlightStore | None = None
store_lock = Lock()
machine = LifecycleMachine()
session: FlightSession | None = None
provider: TelemetryProvider | None = None
sim_provider: SimConnectTelemetryProvider | None = None
selected_source: Source = Source.DEMO
simulator_state: SimulatorState = SimulatorState.NOT_DETECTED
simulator_message: str | None = None
monitor_task: asyncio.Task | None = None
sample_task: asyncio.Task | None = None
subscribers: set[asyncio.Queue[str]] = set()
state_lock = asyncio.Lock()
ALLOWED_BROWSER_ORIGINS = frozenset({"http://localhost:3000", "http://127.0.0.1:3000"})
DEFAULT_TELEMETRY_PAGE_SIZE = 1000


def get_store() -> SQLiteFlightStore:
    """Open the local database only when an API operation needs persistence."""
    global store
    if store is None:
        with store_lock:
            if store is None:
                DB_PATH.parent.mkdir(parents=True, exist_ok=True)
                store = SQLiteFlightStore(DB_PATH, initialize=False)
    return store


async def producer() -> None:
    global session
    while session is not None and session.state == Lifecycle.RECORDING:
        try:
            if session.source == Source.SIMCONNECT:
                if simulator_state not in {SimulatorState.CONNECTED, SimulatorState.RECORDING} or sim_provider is None:
                    await asyncio.sleep(1)
                    continue
                if sim_provider.is_paused():
                    await asyncio.sleep(1)
                    continue
                sample = sim_provider.next_sample(session.sessionId)
                if getattr(sim_provider, "aircraft", None):
                    session = session.model_copy(update={"aircraft": sim_provider.aircraft})
            elif provider is not None:
                sample = provider.next_sample(session.sessionId)
            else:
                return
        except ConnectionError as exc:
            set_simulator(SimulatorState.LOST, str(exc))
            await asyncio.sleep(1)
            continue
        except Exception as exc:
            set_simulator(SimulatorState.ERROR, f"SimConnect telemetry error: {exc}")
            if session is not None:
                session = session.model_copy(update={"state": Lifecycle.ERROR, "error": str(exc)})
                machine.state = Lifecycle.ERROR
                get_store().save_session(session)
            return
        if all(value is None for value in (sample.latitudeDeg, sample.longitudeDeg, sample.altitudeM,
                    sample.headingDeg, sample.airspeedMps, sample.groundSpeedMps,
                    sample.verticalSpeedMps, sample.onGround)):
            await asyncio.sleep(1)
            continue
        try:
            session, inserted = get_store().record_sample(sample, session)
            if not inserted:
                await asyncio.sleep(1)
                continue
            payload = sample.model_dump_json()
            for queue in list(subscribers):
                if queue.full():
                    with suppress(asyncio.QueueEmpty):
                        queue.get_nowait()
                with suppress(asyncio.QueueFull):
                    queue.put_nowait(payload)
        except SessionNotRecording:
            return
        except Exception as exc:  # Fail visibly and preserve the state for diagnosis.
            if session is not None:
                session = session.model_copy(update={"state": Lifecycle.ERROR, "error": str(exc)})
                machine.state = Lifecycle.ERROR
                with suppress(Exception):
                    get_store().save_session(session)
            return
        await asyncio.sleep(1)


@asynccontextmanager
async def lifespan(_: FastAPI):
    global monitor_task, session, machine, provider, sample_task
    database = get_store()
    database.acquire_process_lock()
    try:
        database.initialize()
        database.recover_interrupted()
        session = database.get_latest_session()
        machine = LifecycleMachine(session.state if session else Lifecycle.DISCONNECTED)
        provider = None
        sample_task = None
        monitor_task = asyncio.create_task(simulator_monitor())
        yield
    finally:
        if monitor_task:
            monitor_task.cancel()
            with suppress(asyncio.CancelledError):
                await monitor_task
            monitor_task = None
        if sample_task:
            sample_task.cancel()
            with suppress(asyncio.CancelledError):
                await sample_task
            sample_task = None
        if sim_provider:
            with suppress(Exception):
                sim_provider.disconnect()
        database.release_process_lock()


app = FastAPI(title="AeroTrace Local Connector", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=list(ALLOWED_BROWSER_ORIGINS), allow_methods=["GET", "POST"], allow_headers=["content-type"])


@app.middleware("http")
async def guard_browser_mutations(request: Request, call_next):
    """CORS controls response access; this separately prevents cross-site mutations."""
    origin = request.headers.get("origin")
    if request.method not in {"GET", "HEAD", "OPTIONS"} and origin and origin not in ALLOWED_BROWSER_ORIGINS:
        return JSONResponse(status_code=403, content={"detail": "Browser origin is not allowed"})
    return await call_next(request)


def status_payload(session_override: FlightSession | None = None) -> dict:
    displayed_session = session if session_override is None else session_override
    displayed_state = machine.state if session_override is None else session_override.state
    paused = bool(sim_provider and getattr(sim_provider, "is_paused", lambda: False)())
    return {"state": displayed_state.value, "source": displayed_session.source.value if displayed_session else None, "selectedSource": selected_source.value, "simulator": {"state": simulator_state.value, "message": simulator_message, "paused": paused}, "session": displayed_session.model_dump(mode="json") if displayed_session else None, "message": displayed_session.error if displayed_session and displayed_session.error else None}


def set_simulator(state: SimulatorState, message: str | None = None) -> None:
    global simulator_state, simulator_message
    simulator_state, simulator_message = state, message


async def simulator_monitor() -> None:
    """Observe and reconnect the explicitly selected simulator; never changes provider."""
    global sim_provider
    while True:
        await asyncio.sleep(1)
        if selected_source != Source.SIMCONNECT:
            continue
        if simulator_state == SimulatorState.ERROR:
            continue
        if sim_provider is not None and sim_provider.is_connected():
            if simulator_state in {SimulatorState.LOST, SimulatorState.RECONNECTING, SimulatorState.CONNECTING}:
                set_simulator(SimulatorState.RECORDING if session and session.state == Lifecycle.RECORDING and session.source == Source.SIMCONNECT else SimulatorState.WAITING)
            continue
        if simulator_state in {SimulatorState.CONNECTED, SimulatorState.WAITING, SimulatorState.RECORDING}:
            set_simulator(SimulatorState.LOST, "SimConnect connection lost; attempting reconnect.")
        if simulator_state == SimulatorState.LOST:
            set_simulator(SimulatorState.RECONNECTING)
            await asyncio.sleep(2)
        try:
            if sim_provider:
                with suppress(Exception):
                    sim_provider.disconnect()
            sim_provider = SimConnectTelemetryProvider()
            sim_provider.connect()
            set_simulator(SimulatorState.RECORDING if session and session.state == Lifecycle.RECORDING and session.source == Source.SIMCONNECT else SimulatorState.WAITING)
        except RuntimeError as exc:
            set_simulator(SimulatorState.ERROR, str(exc))
        except Exception as exc:
            set_simulator(SimulatorState.LOST, str(exc))


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "aerotrace-connector", "version": "0.1.0"}


@app.get("/api/status")
def get_status() -> dict:
    return status_payload()


@app.post("/api/demo/start")
async def start_demo() -> dict:
    global session, provider, sample_task
    async with state_lock:
        if selected_source != Source.DEMO:
            raise HTTPException(409, "Select demo mode before starting a demo flight")
        if machine.state in {Lifecycle.RECORDING, Lifecycle.FINALIZING} or (session is not None and session.state in {Lifecycle.RECORDING, Lifecycle.FINALIZING}):
            raise HTTPException(409, "A flight session is already active")
        now = utc_now()
        session_id = uuid4()
        new_session = FlightSession(sessionId=session_id, source=Source.DEMO, state=Lifecycle.RECORDING, startedAt=now, completedAt=None, interruptedAt=None, sampleCount=0, aircraft="AeroTrace Synthetic Test Aircraft", error=None)
        try:
            get_store().create_session(new_session)
        except ActiveSessionExists as exc:
            raise HTTPException(409, str(exc)) from exc
        if machine.state in {Lifecycle.DISCONNECTED, Lifecycle.COMPLETED, Lifecycle.INTERRUPTED, Lifecycle.ERROR}:
            machine.transition(Lifecycle.CONNECTED)
        machine.transition(Lifecycle.RECORDING)
        session = new_session
        provider = DemoTelemetryProvider(session_id)
        sample_task = asyncio.create_task(producer())
        return status_payload()


@app.post("/api/provider/select/{source}")
async def select_provider(source: str) -> dict:
    global selected_source, sim_provider
    if source not in {Source.DEMO.value, Source.SIMCONNECT.value}:
        raise HTTPException(422, "Provider must be 'demo' or 'simconnect'")
    chosen = Source(source)
    async with state_lock:
        if machine.state in {Lifecycle.RECORDING, Lifecycle.FINALIZING} or (session is not None and session.state in {Lifecycle.RECORDING, Lifecycle.FINALIZING}):
            raise HTTPException(409, "Provider cannot change during an active flight")
        selected_source = chosen
        if chosen == Source.DEMO:
            set_simulator(SimulatorState.NOT_DETECTED)
            if sim_provider:
                try:
                    sim_provider.disconnect()
                except Exception:
                    pass
            sim_provider = None
            return status_payload()
        if selected_source == chosen and sim_provider is not None and sim_provider.is_connected():
            return status_payload()
        if sim_provider is not None:
            with suppress(Exception):
                sim_provider.disconnect()
        set_simulator(SimulatorState.CONNECTING)
        sim_provider = SimConnectTelemetryProvider()
        return status_payload()


@app.post("/api/flights/start")
async def start_selected_flight() -> dict:
    if selected_source == Source.DEMO:
        return await start_demo()
    global session, provider, sample_task
    async with state_lock:
        if selected_source != Source.SIMCONNECT:
            raise HTTPException(409, "The selected telemetry provider changed; refresh status before starting")
        if simulator_state not in {SimulatorState.CONNECTED, SimulatorState.WAITING} or sim_provider is None or not sim_provider.is_connected():
            raise HTTPException(409, "Connect MSFS before starting a real recording")
        if machine.state in {Lifecycle.RECORDING, Lifecycle.FINALIZING} or (session is not None and session.state in {Lifecycle.RECORDING, Lifecycle.FINALIZING}):
            raise HTTPException(409, "A flight session is already active")
        new_session = FlightSession(sessionId=uuid4(), source=Source.SIMCONNECT, state=Lifecycle.RECORDING, startedAt=utc_now(), interruptedAt=None, sampleCount=0, aircraft=None)
        try:
            get_store().create_session(new_session)
        except ActiveSessionExists as exc:
            raise HTTPException(409, str(exc)) from exc
        if machine.state in {Lifecycle.DISCONNECTED, Lifecycle.COMPLETED, Lifecycle.INTERRUPTED, Lifecycle.ERROR}:
            machine.transition(Lifecycle.CONNECTED)
        machine.transition(Lifecycle.RECORDING)
        session = new_session
        provider = None
        sample_task = asyncio.create_task(producer())
        set_simulator(SimulatorState.RECORDING)
        return status_payload()


@app.post("/api/flights/complete")
async def complete_flight(request: CompleteFlightRequest) -> dict:
    global session, sample_task
    async with state_lock:
        persisted = get_store().get_session(request.sessionId)
        if persisted is None:
            raise HTTPException(404, "Flight session was not found")
        if persisted.state == Lifecycle.COMPLETED:
            return status_payload(persisted)
        if persisted.state not in {Lifecycle.RECORDING, Lifecycle.FINALIZING}:
            raise HTTPException(409, f"Flight session is {persisted.state.value} and cannot be completed")
        if session is None or session.sessionId != persisted.sessionId:
            raise HTTPException(409, "This recording is not the connector's active session")
        if persisted.state == Lifecycle.RECORDING:
            if machine.state == Lifecycle.RECORDING:
                machine.transition(Lifecycle.FINALIZING)
            session = get_store().begin_finalize(persisted.sessionId)
        if sample_task and session.sessionId == persisted.sessionId:
            sample_task.cancel()
            with suppress(asyncio.CancelledError):
                await sample_task
        sample_task = None
        session = get_store().complete_session(persisted.sessionId, utc_now())
        machine.state = Lifecycle.COMPLETED
        if session.source == Source.SIMCONNECT and sim_provider and sim_provider.is_connected():
            set_simulator(SimulatorState.WAITING)
        elif session.source == Source.SIMCONNECT:
            set_simulator(SimulatorState.LOST, "Recording completed after the simulator connection was lost.")
        return status_payload(session)


@app.get("/api/flights")
def list_flights() -> list[FlightSession]:
    return get_store().list_sessions()


def _flight_analysis(session_id: UUID) -> tuple[FlightSession, FlightAnalysis]:
    saved = get_store().get_session(session_id)
    if saved is None:
        raise HTTPException(404, "Flight session was not found")
    samples = get_store().get_samples(str(session_id))
    return saved, analyze_flight(saved, samples)


@app.get("/api/flights/{session_id}", response_model=FlightReport)
def get_flight(session_id: UUID) -> FlightReport:
    saved, analysis = _flight_analysis(session_id)
    return FlightReport(session=saved, recordingStatus=analysis.recordingStatus, summary=analysis.summary)


@app.get("/api/flights/{session_id}/telemetry")
def flight_telemetry(
    session_id: UUID,
    offset: int = Query(0, ge=0),
    limit: int = Query(DEFAULT_TELEMETRY_PAGE_SIZE, ge=1, le=10000),
) -> list[TelemetrySample]:
    if get_store().get_session(session_id) is None:
        raise HTTPException(404, "Flight session was not found")
    return get_store().get_samples(str(session_id), offset=offset, limit=limit)


@app.get("/api/flights/{session_id}/analysis", response_model=FlightAnalysis)
def flight_analysis(session_id: UUID) -> FlightAnalysis:
    return _flight_analysis(session_id)[1]


@app.get("/api/flights/{session_id}/events", response_model=list[FlightEvent])
def flight_events(session_id: UUID) -> list[FlightEvent]:
    return _flight_analysis(session_id)[1].events


@app.get("/api/flights/{session_id}/phases", response_model=list[PhaseInterval])
def flight_phases(session_id: UUID) -> list[PhaseInterval]:
    return _flight_analysis(session_id)[1].phases


@app.websocket("/ws/telemetry")
async def telemetry_socket(websocket: WebSocket) -> None:
    origin = websocket.headers.get("origin")
    if origin and origin not in ALLOWED_BROWSER_ORIGINS:
        await websocket.close(code=1008, reason="Browser origin is not allowed")
        return
    await websocket.accept()
    queue: asyncio.Queue[str] = asyncio.Queue(maxsize=2)
    subscribers.add(queue)
    try:
        while True:
            await websocket.send_text(await queue.get())
    except WebSocketDisconnect:
        pass
    finally:
        subscribers.discard(queue)
