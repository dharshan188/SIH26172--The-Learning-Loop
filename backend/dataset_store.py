"""Durable, restart-safe storage for the MARVIN wake-word dataset."""

from __future__ import annotations

import csv
import hashlib
import io
import os
import re
import shutil
import sqlite3
import tarfile
import threading
import uuid
import wave
import zipfile
from datetime import datetime, timezone
from pathlib import Path


SAMPLE_RATE = 16_000
CATEGORIES = {
    "positive_marvin": ("", "positive_marvin"),
    "hard_negative": ("", "hard_negative"),
    "normal_speech": ("", "normal_speech"),
    "background_noise": ("", "background_noise"),
    "final_positive": ("final_test", "positive_marvin"),
    "final_negative": ("final_test", "negative"),
}
CONTINUOUS = {"normal_speech", "background_noise", "final_negative"}
MANIFEST_FIELDS = [
    "sample_id", "split", "category", "speaker_id", "session_id", "path",
    "prompt", "label", "environment", "distance", "style", "duration_seconds",
    "sample_rate", "channels", "num_samples", "file_size", "sha256", "created_at",
]


def _safe(value: str, fallback: str) -> str:
    value = re.sub(r"[^a-zA-Z0-9_-]+", "_", (value or "").strip()).strip("_")
    return value[:80] or fallback


class DatasetError(RuntimeError):
    pass


class DatasetStore:
    def __init__(self, root: str | Path):
        self.root = Path(root).expanduser().resolve()
        self.db_path = self.root / "database" / "dataset.db"
        self.manifest_path = self.root / "metadata" / "samples.csv"
        self.lock = threading.RLock()
        self._create_layout()
        self._init_db()
        self.reconcile()

    def _create_layout(self):
        directories = [
            "positive_marvin", "hard_negative", "normal_speech", "background_noise",
            "final_test/positive_marvin", "final_test/negative",
            "metadata", "database", "backups", ".pending", ".trash",
        ]
        for item in directories:
            (self.root / item).mkdir(parents=True, exist_ok=True)

    def _connect(self):
        db = sqlite3.connect(self.db_path, timeout=30)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA synchronous=FULL")
        db.execute("PRAGMA foreign_keys=ON")
        return db

    def _init_db(self):
        with self._connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS samples (
                    sample_id TEXT PRIMARY KEY,
                    dataset_split TEXT NOT NULL,
                    category TEXT NOT NULL,
                    speaker_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    filename TEXT NOT NULL,
                    relative_path TEXT NOT NULL UNIQUE,
                    prompt TEXT NOT NULL DEFAULT '',
                    label TEXT NOT NULL DEFAULT '',
                    environment TEXT NOT NULL DEFAULT '',
                    distance TEXT NOT NULL DEFAULT '',
                    speaking_style TEXT NOT NULL DEFAULT '',
                    sample_rate INTEGER NOT NULL,
                    channels INTEGER NOT NULL,
                    sample_width INTEGER NOT NULL,
                    duration_seconds REAL NOT NULL,
                    num_samples INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    accepted INTEGER NOT NULL DEFAULT 1,
                    deleted INTEGER NOT NULL DEFAULT 0,
                    file_size INTEGER NOT NULL,
                    sha256 TEXT NOT NULL,
                    integrity_status TEXT NOT NULL DEFAULT 'ok'
                );
                CREATE INDEX IF NOT EXISTS idx_samples_active ON samples(accepted, deleted, integrity_status);
                CREATE INDEX IF NOT EXISTS idx_samples_category ON samples(category);
                CREATE INDEX IF NOT EXISTS idx_samples_sha ON samples(sha256);
                CREATE TABLE IF NOT EXISTS pending (
                    pending_id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE,
                    duration_seconds REAL NOT NULL, num_samples INTEGER NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
                    detail TEXT NOT NULL, created_at TEXT NOT NULL
                );
            """)

    @staticmethod
    def inspect_wav(path: Path) -> dict:
        try:
            with wave.open(str(path), "rb") as wav:
                channels = wav.getnchannels()
                width = wav.getsampwidth()
                rate = wav.getframerate()
                frames = wav.getnframes()
                compression = wav.getcomptype()
        except (wave.Error, EOFError, OSError) as exc:
            raise DatasetError(f"invalid WAV: {exc}") from exc
        if rate != SAMPLE_RATE or channels != 1 or width != 2 or compression != "NONE":
            raise DatasetError(f"WAV must be mono 16000 Hz signed PCM16 (got {channels}ch/{rate}Hz/{width * 8}bit/{compression})")
        duration = frames / rate
        if frames <= 0 or duration <= 0 or duration > 6 * 60 * 60:
            raise DatasetError(f"invalid WAV duration: {duration:.3f}s")
        return {"sample_rate": rate, "channels": channels, "sample_width": width,
                "num_samples": frames, "duration_seconds": duration}

    @staticmethod
    def _fsync_dir(path: Path):
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def stage_pcm(self, pcm: bytes) -> dict:
        if not pcm or len(pcm) % 2:
            raise DatasetError("PCM16 payload is empty or has an odd byte count")
        pending_id = uuid.uuid4().hex
        final = self.root / ".pending" / f"{pending_id}.wav"
        temp = final.with_suffix(".wav.part")
        with self.lock:
            try:
                with open(temp, "xb") as raw:
                    with wave.open(raw, "wb") as wav:
                        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(SAMPLE_RATE)
                        wav.writeframes(pcm)
                    raw.flush(); os.fsync(raw.fileno())
                info = self.inspect_wav(temp)
                os.replace(temp, final)
                self._fsync_dir(final.parent)
                with self._connect() as db:
                    db.execute("INSERT INTO pending VALUES (?, ?, ?, ?, ?)",
                               (pending_id, str(final), info["duration_seconds"], info["num_samples"], self._now()))
                return {"pending_id": pending_id, **info}
            finally:
                temp.unlink(missing_ok=True)

    def begin_stream(self) -> dict:
        """Open a disk-backed PCM16 WAV candidate for incremental writes."""
        pending_id = uuid.uuid4().hex
        final = self.root / ".pending" / f"{pending_id}.wav"
        temp = final.with_suffix(".wav.part")
        raw = open(temp, "xb")
        wav = wave.open(raw, "wb")
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(SAMPLE_RATE)
        return {"pending_id": pending_id, "final": final, "temp": temp,
                "raw": raw, "wav": wav, "pcm_bytes": 0, "last_fsync_bytes": 0}

    def append_stream(self, stream: dict, pcm: bytes):
        if len(pcm) % 2:
            raise DatasetError("continuous PCM frame has an odd byte count")
        stream["wav"].writeframesraw(pcm)
        stream["pcm_bytes"] += len(pcm)
        if stream["pcm_bytes"] - stream["last_fsync_bytes"] >= SAMPLE_RATE * 2 * 5:
            stream["raw"].flush(); os.fsync(stream["raw"].fileno())
            stream["last_fsync_bytes"] = stream["pcm_bytes"]

    def finish_stream(self, stream: dict) -> dict:
        """Close and atomically stage an incremental WAV for normal acceptance."""
        try:
            stream["wav"].close()
            stream["raw"].close()
            info = self.inspect_wav(stream["temp"])
            with open(stream["temp"], "rb") as handle: os.fsync(handle.fileno())
            os.replace(stream["temp"], stream["final"])
            self._fsync_dir(stream["final"].parent)
            with self._connect() as db:
                db.execute("INSERT INTO pending VALUES (?, ?, ?, ?, ?)",
                           (stream["pending_id"], str(stream["final"]), info["duration_seconds"],
                            info["num_samples"], self._now()))
            return {"pending_id": stream["pending_id"], **info}
        except Exception:
            try: stream["wav"].close()
            except Exception: pass
            try: stream["raw"].close()
            except Exception: pass
            raise

    def abort_stream(self, stream: dict):
        """Close and remove a stream that never successfully started."""
        try: stream["wav"].close()
        except Exception: pass
        try: stream["raw"].close()
        except Exception: pass
        stream["temp"].unlink(missing_ok=True)

    def reject_pending(self, pending_id: str):
        with self.lock, self._connect() as db:
            row = db.execute("SELECT path FROM pending WHERE pending_id=?", (pending_id,)).fetchone()
            if not row:
                raise DatasetError("pending recording not found")
            Path(row["path"]).unlink(missing_ok=True)
            db.execute("DELETE FROM pending WHERE pending_id=?", (pending_id,))

    def accept_pending(self, pending_id: str, category: str, metadata: dict) -> dict:
        if category not in CATEGORIES:
            raise DatasetError(f"unknown category: {category}")
        speaker = _safe(metadata.get("speaker_id", ""), "speaker_unknown")
        session = _safe(metadata.get("session_id", ""), "session_unknown")
        split, folder = CATEGORIES[category]
        with self.lock:
            with self._connect() as db:
                pending = db.execute("SELECT * FROM pending WHERE pending_id=?", (pending_id,)).fetchone()
            if not pending:
                raise DatasetError("pending recording not found or already handled")
            source = Path(pending["path"])
            info = self.inspect_wav(source)
            sample_id = uuid.uuid4().hex
            sequence = self._next_sequence(category)
            token = _safe(metadata.get("label") or ("marvin" if "positive" in category else category), "audio")
            if category == "positive_marvin":
                filename = f"marvin_{sequence:04d}.wav"
                target_dir = self.root / split / folder
            elif category == "normal_speech":
                filename = f"normal_speech_{sequence:03d}.wav"
                target_dir = self.root / folder
            else:
                filename = (f"{folder}_{sequence:06d}.wav" if category in CONTINUOUS else
                            f"{speaker}_{session}_{token}_{sequence:06d}.wav")
                target_dir = self.root / split / folder / speaker / session
            target_dir.mkdir(parents=True, exist_ok=True)
            target = target_dir / filename
            if target.exists():
                raise DatasetError("refusing to overwrite an existing WAV")
            relative = target.relative_to(self.root).as_posix()
            created = self._now()
            digest = self._sha256(source)
            file_size = source.stat().st_size
            try:
                os.replace(source, target)
                self._fsync_dir(target_dir)
                with self._connect() as db:
                    db.execute("BEGIN IMMEDIATE")
                    db.execute("""INSERT INTO samples
                        (sample_id,dataset_split,category,speaker_id,session_id,filename,relative_path,
                         prompt,label,environment,distance,speaking_style,sample_rate,channels,sample_width,
                         duration_seconds,num_samples,created_at,accepted,deleted,file_size,sha256,integrity_status)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,0,?,?, 'ok')""",
                        (sample_id, split, category, speaker, session, filename, relative,
                         metadata.get("prompt", ""), metadata.get("label", ""), metadata.get("environment", ""),
                         metadata.get("distance", ""), metadata.get("speaking_style", ""), info["sample_rate"],
                         info["channels"], info["sample_width"], info["duration_seconds"], info["num_samples"],
                         created, file_size, digest))
                    db.execute("DELETE FROM pending WHERE pending_id=?", (pending_id,))
                    db.execute("INSERT INTO events(kind,detail,created_at) VALUES('save',?,?)", (sample_id, created))
                # Success is impossible until the final file re-validates and the committed row exists.
                self.inspect_wav(target)
                with self._connect() as db:
                    if not db.execute("SELECT 1 FROM samples WHERE sample_id=?", (sample_id,)).fetchone():
                        raise DatasetError("database verification failed")
                manifest_warning = None
                try:
                    self.export_manifest()
                except OSError as exc:
                    # The WAV and SQLite row are already durable; report the secondary export issue
                    # without pretending the accepted sample was lost.
                    manifest_warning = str(exc)
                return {"sample_id": sample_id, "path": str(target), "relative_path": relative,
                        "sha256": digest, "file_size": file_size,
                        "manifest_warning": manifest_warning, **info}
            except Exception:
                # A moved WAV is intentionally retained. Startup reconciliation indexes/flags it.
                raise

    def delete_sample(self, sample_id: str) -> dict:
        with self.lock, self._connect() as db:
            row = db.execute("SELECT * FROM samples WHERE sample_id=? AND deleted=0", (sample_id,)).fetchone()
            if not row:
                raise DatasetError("active sample not found")
            source = self.root / row["relative_path"]
            trash = self.root / ".trash" / f"{sample_id}_{row['filename']}"
            if source.exists():
                os.replace(source, trash); self._fsync_dir(trash.parent)
            db.execute("UPDATE samples SET deleted=1,accepted=0,integrity_status='trashed' WHERE sample_id=?", (sample_id,))
        self.export_manifest()
        return {"sample_id": sample_id, "trash_path": str(trash)}

    def _next_sequence(self, category: str) -> int:
        with self._connect() as db:
            row = db.execute("SELECT COUNT(*) AS n FROM samples WHERE category=?", (category,)).fetchone()
            return int(row["n"]) + 1

    def reconcile(self) -> dict:
        with self.lock:
            with self._connect() as db:
                rows = db.execute("SELECT sample_id,relative_path,sha256 FROM samples WHERE deleted=0").fetchall()
                indexed = {row["relative_path"]: row for row in rows}
                for relative, row in indexed.items():
                    path = self.root / relative
                    status = "ok"
                    if not path.exists(): status = "missing"
                    else:
                        try:
                            self.inspect_wav(path)
                            if row["sha256"] and self._sha256(path) != row["sha256"]: status = "corrupt"
                        except DatasetError: status = "corrupt"
                    db.execute("UPDATE samples SET integrity_status=? WHERE sample_id=?", (status, row["sample_id"]))
                disk_wavs = []
                for base in self._audio_roots():
                    disk_wavs.extend(base.rglob("*.wav"))
                unindexed = [p.relative_to(self.root).as_posix() for p in disk_wavs if p.relative_to(self.root).as_posix() not in indexed]
            self.export_manifest()
            return self.status(unindexed=unindexed)

    def export_manifest(self) -> dict:
        temp = self.manifest_path.with_suffix(".csv.part")
        with self.lock, self._connect() as db:
            rows = db.execute("""SELECT sample_id,dataset_split AS split,category,speaker_id,session_id,
                relative_path AS path,prompt,label,environment,distance,speaking_style AS style,duration_seconds,
                sample_rate,channels,num_samples,file_size,sha256,created_at FROM samples
                WHERE accepted=1 AND deleted=0 AND integrity_status='ok' ORDER BY created_at,sample_id""").fetchall()
            with open(temp, "w", newline="", encoding="utf-8") as handle:
                writer = csv.DictWriter(handle, fieldnames=MANIFEST_FIELDS)
                writer.writeheader(); writer.writerows(dict(row) for row in rows)
                handle.flush(); os.fsync(handle.fileno())
            os.replace(temp, self.manifest_path); self._fsync_dir(self.manifest_path.parent)
            self._export_group_csv(db, "speakers.csv", "speaker_id")
            self._export_group_csv(db, "sessions.csv", "session_id")
        return {"path": str(self.manifest_path), "rows": len(rows)}

    def _export_group_csv(self, db, filename: str, field: str):
        path = self.root / "metadata" / filename
        temp = path.with_suffix(".csv.part")
        rows = db.execute(f"""SELECT {field}, COUNT(*) AS accepted_samples,
            SUM(duration_seconds) AS duration_seconds, MIN(created_at) AS first_recording,
            MAX(created_at) AS last_recording FROM samples
            WHERE accepted=1 AND deleted=0 AND integrity_status='ok' GROUP BY {field} ORDER BY {field}""").fetchall()
        fields = [field, "accepted_samples", "duration_seconds", "first_recording", "last_recording"]
        with open(temp, "w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=fields); writer.writeheader()
            writer.writerows(dict(row) for row in rows); handle.flush(); os.fsync(handle.fileno())
        os.replace(temp, path)

    def backup(self) -> dict:
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        destination = self.root / "backups" / f"marvin_dataset_backup_{stamp}.tar.gz"
        if destination.exists(): destination = destination.with_name(destination.stem + f"_{uuid.uuid4().hex[:6]}.tar.gz")
        with self.lock:
            self.export_manifest()
            with tarfile.open(destination, "w:gz") as archive:
                for name in ("positive_marvin", "hard_negative", "normal_speech", "background_noise", "final_test", "metadata", "database"):
                    archive.add(self.root / name, arcname=name, recursive=True)
            with open(destination, "rb") as handle: os.fsync(handle.fileno())
        return {"path": str(destination), "file_size": destination.stat().st_size}

    def create_marvin_zip(self) -> dict:
        """Create a ZIP of accepted positive WAVs and the current CSV manifest."""
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        destination = self.root / "backups" / f"marvin_dataset_{stamp}.zip"
        with self.lock:
            self.export_manifest()
            with self._connect() as db:
                rows = db.execute("""SELECT sample_id,dataset_split AS split,category,speaker_id,session_id,
                    relative_path AS path,prompt,label,environment,distance,speaking_style AS style,duration_seconds,
                    sample_rate,channels,num_samples,file_size,sha256,created_at,filename,relative_path FROM samples
                    WHERE category='positive_marvin' AND accepted=1 AND deleted=0
                    AND integrity_status='ok' ORDER BY created_at,sample_id""").fetchall()
            with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                used = set()
                for index, row in enumerate(rows, 1):
                    source = self.root / row["relative_path"]
                    name = row["filename"]
                    if name in used:
                        name = f"marvin_{index:04d}.wav"
                    used.add(name)
                    archive.write(source, f"wav/{name}")
                manifest = io.StringIO()
                writer = csv.DictWriter(manifest, fieldnames=MANIFEST_FIELDS)
                writer.writeheader()
                writer.writerows({key: row[key] for key in MANIFEST_FIELDS} for row in rows)
                archive.writestr("samples.csv", manifest.getvalue())
        return {"path": str(destination), "file_size": destination.stat().st_size,
                "samples": len(rows)}

    def latest_sample(self, category: str) -> dict:
        with self._connect() as db:
            row = db.execute("""SELECT sample_id,filename,relative_path,duration_seconds,file_size
                FROM samples WHERE category=? AND accepted=1 AND deleted=0 AND integrity_status='ok'
                ORDER BY created_at DESC,sample_id DESC LIMIT 1""", (category,)).fetchone()
        if not row:
            raise DatasetError(f"no accepted {category} recording exists")
        return {**dict(row), "path": str(self.root / row["relative_path"])}

    def status(self, unindexed: list[str] | None = None) -> dict:
        with self._connect() as db:
            valid = "accepted=1 AND deleted=0 AND integrity_status='ok'"
            counts = {row["category"]: row["n"] for row in db.execute(
                f"SELECT category,COUNT(*) n FROM samples WHERE {valid} GROUP BY category")}
            durations = {row["category"]: row["seconds"] or 0 for row in db.execute(
                f"SELECT category,SUM(duration_seconds) seconds FROM samples WHERE {valid} GROUP BY category")}
            errors = {row["integrity_status"]: row["n"] for row in db.execute(
                "SELECT integrity_status,COUNT(*) n FROM samples WHERE deleted=0 GROUP BY integrity_status")}
            duplicate_hashes = db.execute(f"SELECT COUNT(*) n FROM (SELECT sha256 FROM samples WHERE {valid} GROUP BY sha256 HAVING COUNT(*)>1)").fetchone()["n"]
            speakers = db.execute(f"SELECT COUNT(DISTINCT speaker_id) n FROM samples WHERE {valid}").fetchone()["n"]
            sessions = db.execute(f"SELECT COUNT(DISTINCT session_id) n FROM samples WHERE {valid}").fetchone()["n"]
            last = db.execute("SELECT created_at FROM events WHERE kind='save' ORDER BY id DESC LIMIT 1").fetchone()
            if unindexed is None:
                indexed = {r[0] for r in db.execute("SELECT relative_path FROM samples WHERE deleted=0")}
                unindexed = [p.relative_to(self.root).as_posix() for base in self._audio_roots() for p in base.rglob("*.wav") if p.relative_to(self.root).as_posix() not in indexed]
        disk_wavs = [p for base in self._audio_roots() for p in base.rglob("*.wav")]
        disk_size = sum(p.stat().st_size for p in disk_wavs if p.is_file())
        missing, corrupt = errors.get("missing", 0), errors.get("corrupt", 0)
        return {
            "dataset_root": str(self.root), "healthy": not (missing or corrupt or unindexed or duplicate_hashes),
            "total_wav_files": len(disk_wavs), "total_dataset_size": disk_size, "counts": counts,
            "durations": durations, "speakers": speakers, "sessions": sessions, "missing_files": missing,
            "corrupt_files": corrupt, "unindexed_files": len(unindexed), "unindexed_paths": unindexed[:100],
            "duplicate_hashes": duplicate_hashes, "last_successful_save": last["created_at"] if last else None,
        }

    @staticmethod
    def _sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with open(path, "rb") as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b""): digest.update(block)
        return digest.hexdigest()

    def _audio_roots(self):
        return [self.root / "positive_marvin", self.root / "hard_negative",
                self.root / "normal_speech", self.root / "background_noise",
                self.root / "final_test"]

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat()
