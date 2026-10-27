"""SQLite repository. Analysis depends on this repository boundary, not SQL rows."""
import sqlite3
import os
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Iterator
from uuid import UUID

from .contracts import FlightSession, Lifecycle, TelemetrySample


class SessionNotRecording(ValueError):
    """Raised when a sample arrives after its session entered finalization."""


class ActiveSessionExists(ValueError):
    """Raised when another connector process already owns an active recording."""


class ConnectorAlreadyRunning(RuntimeError):
    """Raised when the same SQLite archive is already owned by another connector."""


class SQLiteFlightStore:
    def __init__(self, path: str | Path, *, initialize: bool = True):
        self.path = str(path)
        self._lock = Lock()
        self._process_lock_handle = None
        self._initialized = False
        if initialize:
            self.initialize()

    def initialize(self) -> None:
        """Create the schema after exclusive connector ownership is acquired."""
        if self._initialized:
            return
        with self._connection() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("""CREATE TABLE IF NOT EXISTS flights (
                session_id TEXT PRIMARY KEY, payload TEXT NOT NULL)""")
            db.execute("""CREATE TABLE IF NOT EXISTS telemetry (
                sample_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES flights(session_id),
                timestamp TEXT NOT NULL, payload TEXT NOT NULL)""")
            db.execute("CREATE INDEX IF NOT EXISTS ix_telemetry_session_time ON telemetry(session_id, timestamp, sample_id)")
            db.execute("CREATE INDEX IF NOT EXISTS ix_flights_started ON flights(json_extract(payload, '$.startedAt'))")
        self._initialized = True

    def acquire_process_lock(self) -> None:
        """Prevent a second connector from recovering a live process's session."""
        if self._process_lock_handle is not None:
            return
        lock_path = f"{self.path}.connector.lock"
        handle = open(lock_path, "a+b")
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            handle.close()
            raise ConnectorAlreadyRunning(
                "This flight archive is already open in another AeroTrace connector."
            ) from exc
        self._process_lock_handle = handle

    def release_process_lock(self) -> None:
        handle, self._process_lock_handle = self._process_lock_handle, None
        if handle is None:
            return
        try:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=5, check_same_thread=False)
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=5000")
        return db

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        db = self._connect()
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def _session(row: tuple[str] | None) -> FlightSession | None:
        return FlightSession.model_validate_json(row[0]) if row else None

    def create_session(self, session: FlightSession) -> None:
        if session.state != Lifecycle.RECORDING or session.sampleCount != 0:
            raise ValueError("New sessions must begin recording with zero samples")
        with self._lock, self._connection() as db:
            db.execute("BEGIN IMMEDIATE")
            active = db.execute(
                "SELECT 1 FROM flights WHERE json_extract(payload, '$.state') IN (?,?) LIMIT 1",
                (Lifecycle.RECORDING.value, Lifecycle.FINALIZING.value),
            ).fetchone()
            if active:
                raise ActiveSessionExists("Another flight session is already active")
            db.execute("INSERT INTO flights(session_id,payload) VALUES(?,?)", (str(session.sessionId), session.model_dump_json()))

    def save_session(self, session: FlightSession) -> None:
        with self._lock, self._connection() as db:
            db.execute("INSERT INTO flights(session_id,payload) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET payload=excluded.payload", (str(session.sessionId), session.model_dump_json()))

    def record_sample(self, sample: TelemetrySample, session_update: FlightSession | None = None) -> tuple[FlightSession, bool]:
        """Insert an observation and increment sampleCount atomically; dedupe new writes."""
        utc_timestamp = sample.timestamp.astimezone(timezone.utc)
        timestamp = utc_timestamp.isoformat(timespec="microseconds")
        persisted_sample = sample.model_copy(update={"timestamp": utc_timestamp})
        with self._lock, self._connection() as db:
            db.execute("BEGIN IMMEDIATE")
            current = self._session(db.execute("SELECT payload FROM flights WHERE session_id=?", (str(sample.sessionId),)).fetchone())
            if current is None:
                raise ValueError("Telemetry references an unknown flight session")
            if current.state != Lifecycle.RECORDING:
                raise SessionNotRecording(f"Flight session is {current.state.value}, not recording")
            if current.source != sample.source:
                raise ValueError("Telemetry source does not match its recording session")
            collision = db.execute("SELECT session_id FROM telemetry WHERE sample_id=?", (str(sample.sampleId),)).fetchone()
            if collision and collision[0] != str(sample.sessionId):
                raise ValueError("Sample ID is already associated with another session")
            duplicate_time = db.execute("SELECT 1 FROM telemetry WHERE session_id=? AND timestamp=? LIMIT 1", (str(sample.sessionId), timestamp)).fetchone()
            if collision or duplicate_time:
                return current, False
            db.execute("INSERT INTO telemetry(sample_id,session_id,timestamp,payload) VALUES(?,?,?,?)", (str(sample.sampleId), str(sample.sessionId), timestamp, persisted_sample.model_dump_json()))
            base = session_update or current
            if base.sessionId != current.sessionId or base.source != current.source:
                raise ValueError("Session update does not match the persisted flight")
            updated = base.model_copy(update={"sampleCount": current.sampleCount + 1})
            db.execute("UPDATE flights SET payload=? WHERE session_id=?", (updated.model_dump_json(), str(sample.sessionId)))
            return updated, True

    def save_sample(self, sample: TelemetrySample) -> None:
        """Compatibility helper; recording code should use record_sample()."""
        self.record_sample(sample)

    def begin_finalize(self, session_id: UUID) -> FlightSession:
        with self._lock, self._connection() as db:
            db.execute("BEGIN IMMEDIATE")
            current = self._session(db.execute("SELECT payload FROM flights WHERE session_id=?", (str(session_id),)).fetchone())
            if current is None:
                raise KeyError(str(session_id))
            if current.state in {Lifecycle.COMPLETED, Lifecycle.FINALIZING}:
                return current
            if current.state != Lifecycle.RECORDING:
                raise SessionNotRecording(f"Flight session is {current.state.value}")
            updated = current.model_copy(update={"state": Lifecycle.FINALIZING})
            db.execute("UPDATE flights SET payload=? WHERE session_id=?", (updated.model_dump_json(), str(session_id)))
            return updated

    def complete_session(self, session_id: UUID, completed_at: datetime | None = None) -> FlightSession:
        with self._lock, self._connection() as db:
            db.execute("BEGIN IMMEDIATE")
            current = self._session(db.execute("SELECT payload FROM flights WHERE session_id=?", (str(session_id),)).fetchone())
            if current is None:
                raise KeyError(str(session_id))
            if current.state == Lifecycle.COMPLETED:
                return current
            if current.state != Lifecycle.FINALIZING:
                raise SessionNotRecording(f"Flight session is {current.state.value}, not finalizing")
            completed_at = completed_at or datetime.now(timezone.utc)
            if completed_at.tzinfo is None:
                raise ValueError("Completion timestamps must include a UTC offset")
            updated = current.model_copy(update={"state": Lifecycle.COMPLETED, "completedAt": completed_at.astimezone(timezone.utc)})
            db.execute("UPDATE flights SET payload=? WHERE session_id=?", (updated.model_dump_json(), str(session_id)))
            return updated

    def get_session(self, session_id: str | UUID) -> FlightSession | None:
        with self._lock, self._connection() as db:
            row = db.execute("SELECT payload FROM flights WHERE session_id=?", (str(session_id),)).fetchone()
        return self._session(row)

    def get_latest_session(self) -> FlightSession | None:
        with self._lock, self._connection() as db:
            row = db.execute("SELECT payload FROM flights ORDER BY json_extract(payload, '$.startedAt') DESC, session_id DESC LIMIT 1").fetchone()
        return self._session(row)

    def list_sessions(self) -> list[FlightSession]:
        with self._lock, self._connection() as db:
            rows = db.execute("SELECT payload FROM flights ORDER BY json_extract(payload, '$.startedAt') DESC, session_id DESC").fetchall()
        return [FlightSession.model_validate_json(row[0]) for row in rows]

    def get_samples(self, session_id: str, offset: int = 0, limit: int | None = None) -> list[TelemetrySample]:
        query = "SELECT payload FROM telemetry WHERE session_id=? ORDER BY timestamp, sample_id"
        params: tuple[object, ...] = (session_id,)
        if limit is not None:
            query += " LIMIT ? OFFSET ?"
            params += (limit, offset)
        elif offset:
            query += " LIMIT -1 OFFSET ?"
            params += (offset,)
        with self._lock, self._connection() as db:
            rows = db.execute(query, params).fetchall()
        return [TelemetrySample.model_validate_json(row[0]) for row in rows]

    def sample_count(self, session_id: str | UUID) -> int:
        with self._lock, self._connection() as db:
            row = db.execute("SELECT COUNT(*) FROM telemetry WHERE session_id=?", (str(session_id),)).fetchone()
        return int(row[0])

    def recover_interrupted(self) -> int:
        """Mark active sessions left by process loss as interrupted, never completed."""
        recovered = 0
        with self._lock, self._connection() as db:
            rows = db.execute("SELECT session_id,payload FROM flights").fetchall()
            for session_id, payload in rows:
                saved = FlightSession.model_validate_json(payload)
                actual_count = db.execute("SELECT COUNT(*) FROM telemetry WHERE session_id=?", (session_id,)).fetchone()[0]
                updates: dict[str, object] = {}
                if saved.sampleCount != actual_count:
                    updates["sampleCount"] = actual_count
                if saved.state in {Lifecycle.RECORDING, Lifecycle.FINALIZING}:
                    updates.update(
                        state=Lifecycle.INTERRUPTED,
                        interruptedAt=datetime.now(timezone.utc),
                        error="Connector restarted before this flight was completed.",
                    )
                    recovered += 1
                if updates:
                    repaired = saved.model_copy(update=updates)
                    db.execute("UPDATE flights SET payload=? WHERE session_id=?", (repaired.model_dump_json(), session_id))
        return recovered
