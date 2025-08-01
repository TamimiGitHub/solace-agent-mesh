"""
An ADK ArtifactService implementation using the local filesystem for storage.
"""

import os
import json
import shutil
import logging
import asyncio
import unicodedata
from typing import Optional, List

from google.adk.artifacts import BaseArtifactService
from google.genai import types as adk_types
from typing_extensions import override

logger = logging.getLogger(__name__)

METADATA_FILE_SUFFIX = ".meta"


class FilesystemArtifactService(BaseArtifactService):
    """
    An artifact service implementation using the local filesystem.

    Stores artifacts in a structured directory based on a configured scope
    (namespace, app name, or custom), user ID, session ID (or 'user' namespace),
    filename, and version. Metadata (like mime_type) is stored in a companion file.
    """

    def __init__(self, base_path: str, scope_identifier: str):
        """
        Initializes the FilesystemArtifactService.

        Args:
            base_path: The root directory where all artifacts will be stored.
            scope_identifier: The sanitized identifier representing the storage scope
                              (e.g., sanitized namespace, app name, or custom value).

        Raises:
            ValueError: If base_path or scope_identifier is not provided or the
                        scoped base path cannot be created.
        """
        if not base_path:
            raise ValueError("base_path cannot be empty for FilesystemArtifactService")
        if not scope_identifier:
            raise ValueError(
                "scope_identifier cannot be empty for FilesystemArtifactService"
            )

        self.base_path = os.path.abspath(base_path)
        self.scope_identifier = scope_identifier
        self.scope_base_path = os.path.join(self.base_path, self.scope_identifier)

        try:
            os.makedirs(self.scope_base_path, exist_ok=True)
            logger.info(
                "FilesystemArtifactService initialized. Scoped base path: %s",
                self.scope_base_path,
            )
        except OSError as e:
            logger.error(
                "Failed to create scoped base directory '%s': %s",
                self.scope_base_path,
                e,
            )
            raise ValueError(
                f"Could not create or access scoped base_path '{self.scope_base_path}': {e}"
            ) from e

    def _file_has_user_namespace(self, filename: str) -> bool:
        """Checks if the filename has a user namespace."""
        return filename.startswith("user:")

    def _get_artifact_dir(
        self, app_name: str, user_id: str, session_id: str, filename: str
    ) -> str:
        """
        Constructs the directory path for a specific artifact (all versions)
        within the configured scope.
        The app_name parameter is ignored for path construction but kept for signature compatibility.
        """
        user_id_sanitized = os.path.basename(user_id)
        session_id_sanitized = os.path.basename(session_id)
        filename_sanitized = os.path.basename(filename)

        if self._file_has_user_namespace(filename):
            filename_dir = os.path.basename(filename.split(":", 1)[1])
            return os.path.join(
                self.scope_base_path, user_id_sanitized, "user", filename_dir
            )
        else:
            return os.path.join(
                self.scope_base_path,
                user_id_sanitized,
                session_id_sanitized,
                filename_sanitized,
            )

    def _get_version_path(self, artifact_dir: str, version: int) -> str:
        """Constructs the file path for a specific artifact version's data."""
        return os.path.join(artifact_dir, str(version))

    def _get_metadata_path(self, artifact_dir: str, version: int) -> str:
        """Constructs the file path for a specific artifact version's metadata."""
        return os.path.join(artifact_dir, f"{version}{METADATA_FILE_SUFFIX}")

    @override
    async def save_artifact(
        self,
        *,
        app_name: str,
        user_id: str,
        session_id: str,
        filename: str,
        artifact: adk_types.Part,
    ) -> int:
        log_prefix = f"[FSArtifact:Save:{filename}] "

        filename = self._normalize_filename_unicode(filename)
        artifact_dir = self._get_artifact_dir(app_name, user_id, session_id, filename)
        try:
            await asyncio.to_thread(os.makedirs, artifact_dir, exist_ok=True)
        except OSError as e:
            logger.error(
                "%sFailed to create artifact directory '%s': %s",
                log_prefix,
                artifact_dir,
                e,
            )
            raise IOError(f"Could not create artifact directory: {e}") from e

        versions = await self.list_versions(
            app_name=app_name,
            user_id=user_id,
            session_id=session_id,
            filename=filename,
        )
        version = 0 if not versions else max(versions) + 1

        version_path = self._get_version_path(artifact_dir, version)
        metadata_path = self._get_metadata_path(artifact_dir, version)

        try:
            if not artifact.inline_data or artifact.inline_data.data is None:
                raise ValueError("Artifact Part has no inline_data to save.")

            def _write_data_file():
                with open(version_path, "wb") as f:
                    f.write(artifact.inline_data.data)

            await asyncio.to_thread(_write_data_file)
            logger.debug("%sWrote data to %s", log_prefix, version_path)

            metadata = {"mime_type": artifact.inline_data.mime_type}

            def _write_metadata_file():
                with open(metadata_path, "w", encoding="utf-8") as f:
                    json.dump(metadata, f)

            await asyncio.to_thread(_write_metadata_file)
            logger.debug("%sWrote metadata to %s", log_prefix, metadata_path)

            logger.info(
                "%sSaved artifact '%s' version %d successfully.",
                log_prefix,
                filename,
                version,
            )
            return version
        except (IOError, OSError, ValueError, TypeError) as e:
            logger.error(
                "%sFailed to save artifact '%s' version %d: %s",
                log_prefix,
                filename,
                version,
                e,
            )
            if await asyncio.to_thread(os.path.exists, version_path):
                await asyncio.to_thread(os.remove, version_path)
            if await asyncio.to_thread(os.path.exists, metadata_path):
                await asyncio.to_thread(os.remove, metadata_path)
            raise IOError(f"Failed to save artifact version {version}: {e}") from e

    @override
    async def load_artifact(
        self,
        *,
        app_name: str,
        user_id: str,
        session_id: str,
        filename: str,
        version: Optional[int] = None,
    ) -> Optional[adk_types.Part]:
        log_prefix = f"[FSArtifact:Load:{filename}] "
        filename = self._normalize_filename_unicode(filename)
        artifact_dir = self._get_artifact_dir(app_name, user_id, session_id, filename)

        if not await asyncio.to_thread(os.path.isdir, artifact_dir):
            logger.debug("%sArtifact directory not found: %s", log_prefix, artifact_dir)
            return None

        load_version = version
        if load_version is None:
            versions = await self.list_versions(
                app_name=app_name,
                user_id=user_id,
                session_id=session_id,
                filename=filename,
            )
            if not versions:
                logger.debug("%sNo versions found for artifact.", log_prefix)
                return None
            load_version = max(versions)
            logger.debug("%sLoading latest version: %d", log_prefix, load_version)
        else:
            logger.debug("%sLoading specified version: %d", log_prefix, load_version)

        version_path = self._get_version_path(artifact_dir, load_version)
        metadata_path = self._get_metadata_path(artifact_dir, load_version)

        if not await asyncio.to_thread(
            os.path.exists, version_path
        ) or not await asyncio.to_thread(os.path.exists, metadata_path):
            logger.warning(
                "%sData or metadata file missing for version %d.",
                log_prefix,
                load_version,
            )
            return None

        try:

            def _read_metadata_file():
                with open(metadata_path, "r", encoding="utf-8") as f:
                    return json.load(f)

            metadata = await asyncio.to_thread(_read_metadata_file)
            mime_type = metadata.get("mime_type", "application/octet-stream")

            def _read_data_file():
                with open(version_path, "rb") as f:
                    return f.read()

            data_bytes = await asyncio.to_thread(_read_data_file)

            artifact_part = adk_types.Part.from_bytes(
                data=data_bytes, mime_type=mime_type
            )
            logger.info(
                "%sLoaded artifact '%s' version %d successfully (%d bytes, %s).",
                log_prefix,
                filename,
                load_version,
                len(data_bytes),
                mime_type,
            )
            return artifact_part

        except (IOError, OSError, json.JSONDecodeError) as e:
            logger.error(
                "%sFailed to load artifact '%s' version %d: %s",
                log_prefix,
                filename,
                load_version,
                e,
            )
            return None

    @override
    async def list_artifact_keys(
        self, *, app_name: str, user_id: str, session_id: str
    ) -> List[str]:
        log_prefix = f"[FSArtifact:ListKeys] "
        filenames = set()
        user_id_sanitized = os.path.basename(user_id)
        session_id_sanitized = os.path.basename(session_id)

        session_base_dir = os.path.join(
            self.scope_base_path, user_id_sanitized, session_id_sanitized
        )
        if await asyncio.to_thread(os.path.isdir, session_base_dir):
            try:
                for item in await asyncio.to_thread(os.listdir, session_base_dir):
                    item_path = os.path.join(session_base_dir, item)
                    if await asyncio.to_thread(os.path.isdir, item_path):
                        filenames.add(item)
            except OSError as e:
                logger.warning(
                    "%sError listing session directory '%s': %s",
                    log_prefix,
                    session_base_dir,
                    e,
                )

        user_base_dir = os.path.join(self.scope_base_path, user_id_sanitized, "user")
        if await asyncio.to_thread(os.path.isdir, user_base_dir):
            try:
                for item in await asyncio.to_thread(os.listdir, user_base_dir):
                    item_path = os.path.join(user_base_dir, item)
                    if await asyncio.to_thread(os.path.isdir, item_path):
                        filenames.add(f"user:{item}")
            except OSError as e:
                logger.warning(
                    "%sError listing user directory '%s': %s",
                    log_prefix,
                    user_base_dir,
                    e,
                )

        sorted_filenames = sorted(list(filenames))
        logger.debug("%sFound %d artifact keys.", log_prefix, len(sorted_filenames))
        return sorted_filenames

    @override
    async def delete_artifact(
        self, *, app_name: str, user_id: str, session_id: str, filename: str
    ) -> None:
        log_prefix = f"[FSArtifact:Delete:{filename}] "
        artifact_dir = self._get_artifact_dir(app_name, user_id, session_id, filename)

        if not await asyncio.to_thread(os.path.isdir, artifact_dir):
            logger.debug("%sArtifact directory not found: %s", log_prefix, artifact_dir)
            return

        try:
            await asyncio.to_thread(shutil.rmtree, artifact_dir)
            logger.info(
                "%sRemoved artifact directory and all its contents: %s",
                log_prefix,
                artifact_dir,
            )
        except OSError as e:
            logger.error(
                "%sError deleting artifact directory '%s': %s",
                log_prefix,
                artifact_dir,
                e,
            )

    @override
    async def list_versions(
        self, *, app_name: str, user_id: str, session_id: str, filename: str
    ) -> List[int]:
        log_prefix = f"[FSArtifact:ListVersions:{filename}] "
        artifact_dir = self._get_artifact_dir(app_name, user_id, session_id, filename)
        versions = []

        if not await asyncio.to_thread(os.path.isdir, artifact_dir):
            logger.debug("%sArtifact directory not found: %s", log_prefix, artifact_dir)
            return []

        try:
            for item in await asyncio.to_thread(os.listdir, artifact_dir):
                if (
                    await asyncio.to_thread(
                        os.path.isfile, os.path.join(artifact_dir, item)
                    )
                    and item.isdigit()
                ):
                    versions.append(int(item))
        except OSError as e:
            logger.error(
                "%sError listing versions in directory '%s': %s",
                log_prefix,
                artifact_dir,
                e,
            )
            return []

        sorted_versions = sorted(versions)
        logger.debug("%sFound versions: %s", log_prefix, sorted_versions)
        return sorted_versions

    def _normalize_filename_unicode(self, filename: str) -> str:
        """
        Normalizes Unicode characters in a filename to their standard form.
        Specifically targets compatibility characters like non-breaking spaces (\u202f)
        and converts them to their regular ASCII equivalents (a standard space).
        """
        return unicodedata.normalize("NFKC", filename)
