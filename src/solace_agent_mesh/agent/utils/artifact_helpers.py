"""
Helper functions for artifact management, including metadata handling and schema inference.
"""

import base64
import binascii
import json
import csv
import io
import inspect
import datetime
import os
from typing import Any, Dict, Optional, Tuple, List, Union, TYPE_CHECKING
from datetime import timezone
from google.adk.artifacts import BaseArtifactService
from google.genai import types as adk_types
from solace_ai_connector.common.log import log
from ...common.utils.mime_helpers import is_text_based_mime_type, is_text_based_file

if TYPE_CHECKING:
    from google.adk.tools import ToolContext

METADATA_SUFFIX = ".metadata.json"
DEFAULT_SCHEMA_MAX_KEYS = 20


def is_filename_safe(filename: str) -> bool:
    """
    Checks if a filename is safe for artifact creation.
    - Must not be empty or just whitespace.
    - Must not contain path traversal sequences ('..').
    - Must not contain path separators ('/' or '\\').
    - Must not be a reserved name like '.' or '..'.

    Args:
        filename: The filename to validate.

    Returns:
        True if the filename is safe, False otherwise.
    """
    if not filename or not filename.strip():
        return False

    # Check for path traversal
    if ".." in filename:
        return False

    # Check for path separators
    if "/" in filename or "\\" in filename:
        return False

    # Check for reserved names
    if filename.strip() in [".", ".."]:
        return False

    return True


def ensure_correct_extension(filename_from_llm: str, desired_extension: str) -> str:
    """
    Ensures a filename has the correct extension, handling cases where the LLM
    might provide a filename with or without an extension, or with the wrong one.

    Args:
        filename_from_llm: The filename string provided by the LLM.
        desired_extension: The correct extension for the file (e.g., 'png', 'md').
                           Should be provided without a leading dot.

    Returns:
        A string with the correctly formatted filename.
    """
    if not filename_from_llm:
        return f"unnamed.{desired_extension.lower()}"
    filename_stripped = filename_from_llm.strip()
    desired_ext_clean = desired_extension.lower().strip().lstrip(".")
    base_name, current_ext = os.path.splitext(filename_stripped)
    current_ext_clean = current_ext.lower().lstrip(".")
    if current_ext_clean == desired_ext_clean:
        return filename_stripped
    else:
        return f"{base_name}.{desired_ext_clean}"


def _inspect_structure(
    data: Any, max_depth: int, max_keys: int, current_depth: int = 0
) -> Any:
    """
    Recursively inspects data structure up to max_depth and max_keys for dictionaries.
    """
    if current_depth >= max_depth:
        return type(data).__name__
    if isinstance(data, dict):
        if not data:
            return {}
        inspected_dict = {}
        keys = list(data.keys())
        keys_to_inspect = keys[:max_keys]
        for key in keys_to_inspect:
            inspected_dict[key] = _inspect_structure(
                data[key], max_depth, max_keys, current_depth + 1
            )
        if len(keys) > max_keys:
            inspected_dict["..."] = f"{len(keys) - max_keys} more keys"
        return inspected_dict
    elif isinstance(data, list):
        if not data:
            return []
        return [_inspect_structure(data[0], max_depth, max_keys, current_depth + 1)]
    else:
        return type(data).__name__


def _infer_schema(
    content_bytes: bytes,
    mime_type: str,
    depth: int = 3,
    max_keys: int = DEFAULT_SCHEMA_MAX_KEYS,
) -> Dict[str, Any]:
    """
    Infers basic schema information for common text-based types.
    Args:
        content_bytes: The raw byte content.
        mime_type: The MIME type.
        depth: Maximum recursion depth for nested structures.
        max_keys: Maximum number of dictionary keys to inspect at each level.
    Returns:
        A dictionary representing the inferred schema, including an 'inferred' flag
        and potential 'error' field.
    """
    schema_info = {"type": mime_type, "inferred": False, "error": None}
    normalized_mime_type = mime_type.lower() if mime_type else ""
    try:
        if normalized_mime_type == "text/csv":
            try:
                text_content = io.TextIOWrapper(
                    io.BytesIO(content_bytes), encoding="utf-8"
                )
                reader = csv.reader(text_content)
                header = next(reader)
                schema_info["columns"] = header
                schema_info["inferred"] = True
            except (StopIteration, csv.Error, UnicodeDecodeError) as e:
                schema_info["error"] = f"CSV header inference failed: {e}"
        elif normalized_mime_type in ["application/json", "text/json"]:
            try:
                data = json.loads(content_bytes.decode("utf-8"))
                schema_info["structure"] = _inspect_structure(data, depth, max_keys)
                schema_info["inferred"] = True
            except (json.JSONDecodeError, UnicodeDecodeError) as e:
                schema_info["error"] = f"JSON structure inference failed: {e}"
        elif normalized_mime_type in [
            "application/yaml",
            "text/yaml",
            "application/x-yaml",
            "text/x-yaml",
        ]:
            try:
                import yaml

                data = yaml.safe_load(content_bytes)
                schema_info["structure"] = _inspect_structure(data, depth, max_keys)
                schema_info["inferred"] = True
            except ImportError:
                schema_info["error"] = "YAML inference skipped: PyYAML not installed."
            except (yaml.YAMLError, UnicodeDecodeError) as e:
                schema_info["error"] = f"YAML structure inference failed: {e}"
    except Exception as e:
        schema_info["error"] = f"Unexpected error during schema inference: {e}"
    if schema_info["error"]:
        log.warning(
            "Schema inference for mime_type '%s' encountered error: %s",
            mime_type,
            schema_info["error"],
        )
    elif not schema_info["inferred"]:
        log.debug(
            "No specific schema inference logic applied for mime_type '%s'.", mime_type
        )
    return schema_info


async def save_artifact_with_metadata(
    artifact_service: BaseArtifactService,
    app_name: str,
    user_id: str,
    session_id: str,
    filename: str,
    content_bytes: bytes,
    mime_type: str,
    metadata_dict: Dict[str, Any],
    timestamp: datetime.datetime,
    explicit_schema: Optional[Dict] = None,
    schema_inference_depth: int = 2,
    schema_max_keys: int = DEFAULT_SCHEMA_MAX_KEYS,
    tool_context: Optional["ToolContext"] = None,
) -> Dict[str, Any]:
    """
    Saves a data artifact and its corresponding metadata artifact using BaseArtifactService.
    """
    log_identifier = f"[ArtifactHelper:save:{filename}]"
    log.debug("%s Saving artifact and metadata (async)...", log_identifier)
    data_version = None
    metadata_version = None
    metadata_filename = f"{filename}{METADATA_SUFFIX}"
    status = "error"
    status_message = "Initialization error"
    try:
        data_artifact_part = adk_types.Part.from_bytes(
            data=content_bytes, mime_type=mime_type
        )
        log.debug(
            f"{log_identifier} artifact_service object type: {type(artifact_service)}"
        )
        log.debug(
            f"{log_identifier} artifact_service object dir: {dir(artifact_service)}"
        )
        if hasattr(artifact_service, "save_artifact"):
            save_artifact_method = getattr(artifact_service, "save_artifact")
            log.debug(
                f"{log_identifier} type of artifact_service.save_artifact: {type(save_artifact_method)}"
            )
            log.debug(
                f"{log_identifier} Is save_artifact a coroutine function? {inspect.iscoroutinefunction(save_artifact_method)}"
            )
            log.debug(
                f"{log_identifier} Is save_artifact an async generator function? {inspect.isasyncgenfunction(save_artifact_method)}"
            )
            if callable(save_artifact_method):
                try:
                    sig = inspect.signature(save_artifact_method)
                    log.debug(f"{log_identifier} Signature of save_artifact: {sig}")
                except Exception as e_inspect:
                    log.debug(
                        f"{log_identifier} Could not get signature of save_artifact: {e_inspect}"
                    )
        save_data_method = getattr(artifact_service, "save_artifact")
        data_version = await save_data_method(
            app_name=app_name,
            user_id=user_id,
            session_id=session_id,
            filename=filename,
            artifact=data_artifact_part,
        )
        log.info(
            "%s Saved data artifact '%s' as version %s.",
            log_identifier,
            filename,
            data_version,
        )

        # Populate artifact_delta for ADK callbacks if tool_context is provided
        if (
            tool_context
            and hasattr(tool_context, "actions")
            and hasattr(tool_context.actions, "artifact_delta")
        ):
            tool_context.actions.artifact_delta[filename] = data_version
            log.debug(
                "%s Populated artifact_delta for ADK callbacks: %s -> %s",
                log_identifier,
                filename,
                data_version,
            )

        final_metadata = {
            "filename": filename,
            "mime_type": mime_type,
            "size_bytes": len(content_bytes),
            "timestamp_utc": (
                timestamp
                if isinstance(timestamp, (int, float))
                else timestamp.timestamp()
            ),
            **(metadata_dict or {}),
        }
        if explicit_schema:
            final_metadata["schema"] = {
                "type": mime_type,
                "inferred": False,
                **explicit_schema,
            }
            log.debug("%s Using explicit schema provided by caller.", log_identifier)
        else:
            inferred_schema = _infer_schema(
                content_bytes, mime_type, schema_inference_depth, schema_max_keys
            )
            final_metadata["schema"] = inferred_schema
            if inferred_schema.get("inferred"):
                log.debug(
                    "%s Added inferred schema (max_keys=%d).",
                    log_identifier,
                    schema_max_keys,
                )
            elif inferred_schema.get("error"):
                log.warning(
                    "%s Schema inference failed: %s",
                    log_identifier,
                    inferred_schema["error"],
                )
        try:
            metadata_bytes = json.dumps(final_metadata, indent=2).encode("utf-8")
            metadata_artifact_part = adk_types.Part.from_bytes(
                data=metadata_bytes, mime_type="application/json"
            )
            save_metadata_method = getattr(artifact_service, "save_artifact")
            metadata_version = await save_metadata_method(
                app_name=app_name,
                user_id=user_id,
                session_id=session_id,
                filename=metadata_filename,
                artifact=metadata_artifact_part,
            )
            log.info(
                "%s Saved metadata artifact '%s' as version %s.",
                log_identifier,
                metadata_filename,
                metadata_version,
            )
            status = "success"
            status_message = "Artifact and metadata saved successfully."
        except Exception as meta_save_err:
            log.exception(
                "%s Failed to save metadata artifact '%s': %s",
                log_identifier,
                metadata_filename,
                meta_save_err,
            )
            status = "partial_success"
            status_message = f"Data artifact saved (v{data_version}), but failed to save metadata: {meta_save_err}"
    except Exception as data_save_err:
        log.exception(
            "%s Failed to save data artifact '%s': %s",
            log_identifier,
            filename,
            data_save_err,
        )
        status = "error"
        status_message = f"Failed to save data artifact: {data_save_err}"
    return {
        "status": status,
        "data_filename": filename,
        "data_version": data_version,
        "metadata_filename": metadata_filename,
        "metadata_version": metadata_version,
        "message": status_message,
    }


def format_metadata_for_llm(metadata: Dict[str, Any]) -> str:
    """Formats loaded metadata into an LLM-friendly text block."""
    lines = []
    filename = metadata.get("filename", "Unknown Filename")
    version = metadata.get("version", "N/A")
    lines.append(f"--- Metadata for artifact '{filename}' (v{version}) ---")
    lines.append("**Artifact Metadata:**")
    if "description" in metadata:
        lines.append(f"*   **Description:** {metadata['description']}")
    if "source" in metadata:
        lines.append(f"*   **Source:** {metadata['source']}")
    if "mime_type" in metadata:
        lines.append(f"*   **Type:** {metadata['mime_type']}")
    if "size_bytes" in metadata:
        lines.append(f"*   **Size:** {metadata['size_bytes']} bytes")
    schema = metadata.get("schema", {})
    schema_type = schema.get("type", metadata.get("mime_type", "unknown"))
    schema_details = []
    if schema.get("inferred"):
        schema_details.append("(Inferred)")
    if "columns" in schema:
        schema_details.append(f"Columns: {','.join(schema['columns'])}")
    if "structure" in schema:
        schema_details.append(f"Structure: {json.dumps(schema['structure'])}")
    if schema.get("error"):
        schema_details.append(f"Schema Error: {schema['error']}")
    if schema_details:
        lines.append(f"*   **Schema:** {schema_type} {' '.join(schema_details)}")
    elif schema_type != "unknown":
        lines.append(f"*   **Schema Type:** {schema_type}")
    custom_fields = {
        k: v
        for k, v in metadata.items()
        if k
        not in [
            "filename",
            "mime_type",
            "size_bytes",
            "timestamp_utc",
            "schema",
            "version",
            "description",
            "source",
        ]
    }
    if custom_fields:
        lines.append("*   **Other:**")
        for k, v in custom_fields.items():
            lines.append(f"    *   {k}: {v}")
    lines.append("--- End Metadata ---")
    return "\n".join(lines)


def decode_and_get_bytes(
    content_str: str, mime_type: str, log_identifier: str
) -> Tuple[bytes, str]:
    """
    Decodes content if necessary (based on mime_type) and returns bytes and final mime_type.
    Args:
        content_str: The input content string (potentially base64).
        mime_type: The provided MIME type.
        log_identifier: Identifier for logging.
    Returns:
        A tuple containing (content_bytes, final_mime_type).
    """
    file_bytes: bytes
    final_mime_type = mime_type
    normalized_mime_type = mime_type.lower() if mime_type else ""
    if is_text_based_mime_type(normalized_mime_type):
        file_bytes = content_str.encode("utf-8")
        log.debug(
            "%s Encoded text content for text mimeType '%s'.",
            log_identifier,
            mime_type,
        )
    else:
        try:
            file_bytes = base64.b64decode(content_str, validate=True)
            log.debug(
                "%s Decoded base64 content for non-text mimeType '%s'.",
                log_identifier,
                mime_type,
            )
        except (binascii.Error, ValueError) as decode_error:
            log.warning(
                "%s Failed to base64 decode content for mimeType '%s'. Treating as text/plain. Error: %s",
                log_identifier,
                mime_type,
                decode_error,
            )
            file_bytes = content_str.encode("utf-8")
            final_mime_type = "text/plain"
    return file_bytes, final_mime_type


from google.adk.artifacts import BaseArtifactService
from datetime import datetime, timezone
import traceback
from ...common.types import ArtifactInfo


async def get_latest_artifact_version(
    artifact_service: BaseArtifactService,
    app_name: str,
    user_id: str,
    session_id: str,
    filename: str,
) -> Optional[int]:
    """
    Retrieves the latest version number for a given artifact.

    Args:
        artifact_service: The artifact service instance.
        app_name: The application name.
        user_id: The user ID.
        session_id: The session ID.
        filename: The name of the artifact.

    Returns:
        The latest version number as an integer, or None if no versions exist.
    """
    log_identifier = f"[ArtifactHelper:get_latest_version:{filename}]"
    try:
        if not hasattr(artifact_service, "list_versions"):
            log.warning(
                "%s Artifact service does not support 'list_versions'.", log_identifier
            )
            return None

        versions = await artifact_service.list_versions(
            app_name=app_name, user_id=user_id, session_id=session_id, filename=filename
        )
        if not versions:
            log.debug("%s No versions found for artifact.", log_identifier)
            return None

        latest_version = max(versions)
        log.debug("%s Resolved latest version to %d.", log_identifier, latest_version)
        return latest_version
    except Exception as e:
        log.error("%s Error resolving latest version: %s", log_identifier, e)
        return None


async def get_artifact_info_list(
    artifact_service: BaseArtifactService,
    app_name: str,
    user_id: str,
    session_id: str,
) -> List[ArtifactInfo]:
    """
    Retrieves detailed information for all artifacts using the artifact service.

    Args:
        artifact_service: The artifact service instance.
        app_name: The application name.
        user_id: The user ID.
        session_id: The session ID.

    Returns:
        A list of ArtifactInfo objects.
    """
    log_prefix = f"[ArtifactHelper:get_info_list] App={app_name}, User={user_id}, Session={session_id} -"
    artifact_info_list: List[ArtifactInfo] = []

    try:
        list_keys_method = getattr(artifact_service, "list_artifact_keys")
        keys = await list_keys_method(
            app_name=app_name, user_id=user_id, session_id=session_id
        )
        log.info(
            "%s Found %d artifact keys. Fetching details...", log_prefix, len(keys)
        )

        for filename in keys:
            if filename.endswith(METADATA_SUFFIX):
                continue

            log_identifier_item = f"{log_prefix} [{filename}]"
            try:

                version_count: int = 0
                latest_version_num: Optional[int] = await get_latest_artifact_version(
                    artifact_service, app_name, user_id, session_id, filename
                )

                if hasattr(artifact_service, "list_versions"):
                    try:
                        available_versions = await artifact_service.list_versions(
                            app_name=app_name,
                            user_id=user_id,
                            session_id=session_id,
                            filename=filename,
                        )
                        version_count = len(available_versions)
                    except Exception as list_ver_err:
                        log.error(
                            "%s Error listing versions for count: %s.",
                            log_identifier_item,
                            list_ver_err,
                        )

                data = await load_artifact_content_or_metadata(
                    artifact_service=artifact_service,
                    app_name=app_name,
                    user_id=user_id,
                    session_id=session_id,
                    filename=filename,
                    version="latest",
                    load_metadata_only=True,
                    log_identifier_prefix=log_identifier_item,
                )

                metadata = data.get("metadata", {})
                mime_type = metadata.get("mime_type", "application/data")
                size = metadata.get("size_bytes", 0)
                schema_definition = metadata.get("schema", {})
                description = metadata.get("description", "No description provided")
                loaded_version_num = data.get("version", latest_version_num)

                last_modified_ts = metadata.get("timestamp_utc")
                last_modified_ts = metadata.get("timestamp_utc")
                last_modified_iso = (
                    datetime.fromtimestamp(
                        last_modified_ts, tz=timezone.utc
                    ).isoformat()
                    if last_modified_ts
                    else None
                )

                artifact_info_list.append(
                    ArtifactInfo(
                        filename=filename,
                        mime_type=mime_type,
                        size=size,
                        last_modified=last_modified_iso,
                        schema_definition=schema_definition,
                        description=description,
                        version=loaded_version_num,
                        version_count=version_count,
                    )
                )
                log.debug(
                    "%s Successfully processed artifact info.", log_identifier_item
                )

            except FileNotFoundError:
                log.warning(
                    "%s Artifact file not found by service for key '%s'. Skipping.",
                    log_prefix,
                    filename,
                )
            except Exception as detail_e:
                log.error(
                    "%s Error processing details for artifact '%s': %s\n%s",
                    log_prefix,
                    filename,
                    detail_e,
                    traceback.format_exc(),
                )
                artifact_info_list.append(
                    ArtifactInfo(
                        filename=filename,
                        size=0,
                        description=f"Error loading details: {detail_e}",
                        mime_type="application/octet-stream",
                    )
                )

    except Exception as e:
        log.exception(
            "%s Error listing artifact keys or processing list: %s", log_prefix, e
        )
        return []
    return artifact_info_list


async def load_artifact_content_or_metadata(
    artifact_service: BaseArtifactService,
    app_name: str,
    user_id: str,
    session_id: str,
    filename: str,
    version: Union[int, str],
    load_metadata_only: bool = False,
    return_raw_bytes: bool = False,
    max_content_length: Optional[int] = None,
    component: Optional[Any] = None,
    log_identifier_prefix: str = "[ArtifactHelper:load]",
    encoding: str = "utf-8",
    error_handling: str = "strict",
) -> Dict[str, Any]:
    """
    Loads the content or metadata of a specific artifact version using the artifact service.
    """
    log_identifier_req = f"{log_identifier_prefix}:{filename}:{version}"
    log.debug(
        "%s Processing request (load_metadata_only=%s, return_raw_bytes=%s) (async).",
        log_identifier_req,
        load_metadata_only,
        return_raw_bytes,
    )

    if max_content_length is None and component:
        max_content_length = component.get_config(
            "text_artifact_content_max_length", 1000
        )
        if max_content_length < 100:
            log.warning(
                "%s text_artifact_content_max_length too small (%d), using minimum: 100",
                log_identifier_req,
                max_content_length,
            )
            max_content_length = 100
        elif max_content_length > 100000:
            log.warning(
                "%s text_artifact_content_max_length too large (%d), using maximum: 100000",
                log_identifier_req,
                max_content_length,
            )
            max_content_length = 100000
    elif max_content_length is None:
        max_content_length = 1000

    log.debug(
        "%s Using max_content_length: %d characters (from %s).",
        log_identifier_req,
        max_content_length,
        "app config" if component else "default",
    )

    try:
        actual_version: int
        if isinstance(version, str) and version.lower() == "latest":
            log.debug(
                "%s Requested version is 'latest', resolving...", log_identifier_req
            )
            try:
                list_versions_method = getattr(artifact_service, "list_versions")
                available_versions = await list_versions_method(
                    app_name=app_name,
                    user_id=user_id,
                    session_id=session_id,
                    filename=filename,
                )
                if not available_versions:
                    raise FileNotFoundError(
                        f"Artifact '{filename}' has no versions available to determine 'latest'."
                    )
                actual_version = max(available_versions)
                log.info(
                    "%s Resolved 'latest' to version %d.",
                    log_identifier_req,
                    actual_version,
                )
            except Exception as list_err:
                log.error(
                    "%s Failed to list versions for '%s' to resolve 'latest': %s",
                    log_identifier_req,
                    filename,
                    list_err,
                )
                raise FileNotFoundError(
                    f"Could not determine latest version for '{filename}': {list_err}"
                ) from list_err
        elif isinstance(version, int):
            actual_version = version
        elif isinstance(version, str):
            try:
                actual_version = int(version)
            except ValueError:
                raise ValueError(
                    f"Invalid version specified: '{version}'. Must be a positive integer string or 'latest'."
                )
        else:
            raise ValueError(
                f"Invalid version type: '{type(version).__name__}'. Must be an integer or 'latest'."
            )

        if actual_version < 0:
            raise ValueError(
                f"Version number must be a positive integer. Got: {actual_version}"
            )

        target_filename = (
            f"{filename}{METADATA_SUFFIX}" if load_metadata_only else filename
        )
        version_to_load = actual_version

        log_identifier = f"{log_identifier_prefix}:{filename}:{version_to_load}"

        log.debug(
            "%s Attempting to load '%s' v%d (async)",
            log_identifier,
            target_filename,
            version_to_load,
        )

        load_artifact_method = getattr(artifact_service, "load_artifact")
        artifact_part = await load_artifact_method(
            app_name=app_name,
            user_id=user_id,
            session_id=session_id,
            filename=target_filename,
            version=version_to_load,
        )

        if not artifact_part or not artifact_part.inline_data:
            raise FileNotFoundError(
                f"Artifact '{target_filename}' version {version_to_load} not found or has no data."
            )

        mime_type = artifact_part.inline_data.mime_type
        data_bytes = artifact_part.inline_data.data
        size_bytes = len(data_bytes)

        if load_metadata_only:
            if mime_type != "application/json":
                log.warning(
                    "%s Expected metadata file '%s' v%d to be application/json, but got '%s'. Attempting parse anyway.",
                    log_identifier,
                    target_filename,
                    version_to_load,
                    mime_type,
                )
            try:
                metadata_dict = json.loads(data_bytes.decode("utf-8"))
                log.info(
                    "%s Successfully loaded and parsed metadata for '%s' v%d.",
                    log_identifier,
                    filename,
                    version_to_load,
                )
                return {
                    "status": "success",
                    "filename": filename,
                    "version": version_to_load,
                    "metadata": metadata_dict,
                }

            except (json.JSONDecodeError, UnicodeDecodeError) as parse_err:
                raise ValueError(
                    f"Failed to parse metadata file '{target_filename}' v{version_to_load}: {parse_err}"
                ) from parse_err

        else:
            if return_raw_bytes:
                log.info(
                    "%s Loaded artifact '%s' v%d (%d bytes, type: %s). Returning raw_bytes.",
                    log_identifier,
                    filename,
                    version_to_load,
                    size_bytes,
                    mime_type,
                )
                return {
                    "status": "success",
                    "filename": filename,
                    "version": version_to_load,
                    "mime_type": mime_type,
                    "raw_bytes": data_bytes,
                    "size_bytes": size_bytes,
                }
            else:
                is_text = is_text_based_file(mime_type, data_bytes)

                if is_text:
                    try:
                        content_str = data_bytes.decode(encoding, errors=error_handling)
                        if len(content_str) > max_content_length:
                            truncated_content = content_str[:max_content_length] + "..."
                            log.info(
                                "%s Loaded and decoded text artifact '%s' v%d. Returning truncated content (%d chars, limit: %d).",
                                log_identifier,
                                filename,
                                version_to_load,
                                len(truncated_content),
                                max_content_length,
                            )
                        else:
                            truncated_content = content_str
                            log.info(
                                "%s Loaded and decoded text artifact '%s' v%d. Returning full content (%d chars).",
                                log_identifier,
                                filename,
                                version_to_load,
                                len(content_str),
                            )
                        return {
                            "status": "success",
                            "filename": filename,
                            "version": version_to_load,
                            "mime_type": mime_type,
                            "content": truncated_content,
                            "size_bytes": size_bytes,
                        }
                    except UnicodeDecodeError as decode_err:
                        log.error(
                            "%s Failed to decode text artifact '%s' v%d with encoding '%s': %s",
                            log_identifier,
                            filename,
                            version_to_load,
                            mime_type,
                            decode_err,
                        )
                        raise ValueError(
                            f"Failed to decode artifact '{filename}' v{version_to_load} as {encoding}."
                        ) from decode_err
                else:
                    log.info(
                        "%s Loaded binary/unknown artifact '%s' v%d. Returning metadata summary.",
                        log_identifier,
                        filename,
                        version_to_load,
                    )

                    metadata_for_binary = {}
                    if not filename.endswith(METADATA_SUFFIX):
                        try:
                            metadata_filename_for_binary = (
                                f"{filename}{METADATA_SUFFIX}"
                            )
                            log.debug(
                                "%s Attempting to load linked metadata file '%s' for binary artifact '%s' v%d.",
                                log_identifier,
                                metadata_filename_for_binary,
                                filename,
                                version_to_load,
                            )
                            metadata_data = await load_artifact_content_or_metadata(
                                artifact_service=artifact_service,
                                app_name=app_name,
                                user_id=user_id,
                                session_id=session_id,
                                filename=f"{filename}{METADATA_SUFFIX}",
                                version=version,
                                load_metadata_only=True,
                                log_identifier_prefix=f"{log_identifier}[meta_for_binary]",
                            )
                            if metadata_data.get("status") == "success":
                                metadata_for_binary = metadata_data.get("metadata", {})
                        except Exception as e_meta_bin:
                            log.warning(
                                f"{log_identifier} Could not load metadata for binary artifact {filename}: {e_meta_bin}"
                            )
                            metadata_for_binary = {
                                "error": f"Could not load metadata: {e_meta_bin}"
                            }

                    return {
                        "status": "success",
                        "filename": filename,
                        "version": version_to_load,
                        "mime_type": mime_type,
                        "size_bytes": size_bytes,
                        "metadata": metadata_for_binary,
                        "content": f"Binary data of type {mime_type}. Content not displayed.",
                    }

    except FileNotFoundError as fnf_err:
        log.warning("%s Artifact not found: %s", log_identifier_req, fnf_err)
        return {"status": "not_found", "message": str(fnf_err)}
    except ValueError as val_err:
        log.error(
            "%s Value error during artifact load: %s", log_identifier_req, val_err
        )
        return {"status": "error", "message": str(val_err)}
    except Exception as e:
        log.exception(
            "%s Unexpected error loading artifact '%s' version '%s': %s",
            log_identifier_req,
            filename,
            version,
            e,
        )
        return {
            "status": "error",
            "message": f"Unexpected error loading artifact: {e}",
        }
