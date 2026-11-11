#!/usr/bin/env python3
"""Deterministic QR rendering, safe composition, and decode verification.

The helper owns payload encoding and QR pixels. It does not call an image
provider or access the network. Host image generation may supply a background,
which this helper keeps outside the QR safe area before final verification.
"""

# /// script
# requires-python = ">=3.12,<3.14"
# dependencies = ["Pillow==11.3.0", "segno==1.6.6", "zxing-cpp==2.3.0"]
# ///

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import segno
from PIL import Image, ImageDraw, ImageOps

try:
    import zxingcpp
except ImportError:  # Rendering still works; verification reports verification_unavailable.
    zxingcpp = None


SCHEMA_VERSION = 1
MAX_PAYLOAD_BYTES = 4096
MAX_CANVAS = 4096
MAX_INPUT_BYTES = 8 * 1024 * 1024
SEGNO_VERSION = str(getattr(segno, "__version__", "unknown"))
ZXING_CPP_VERSION = "2.3.0"
ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
COLOR_PATTERN = re.compile(r"^#[0-9A-Fa-f]{6}$")
DIGEST_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")

BUILTIN_THEMES: dict[str, dict[str, Any]] = {
    "minimal": {
        "dark": "#111827",
        "light": "#FFFFFF",
        "finder_dark": "#111827",
        "finder_light": "#FFFFFF",
        "frame": "#111827",
        "background": "#FFFFFF",
        "image_generation": False,
    },
    "editorial": {
        "dark": "#20372B",
        "light": "#F7F1E3",
        "finder_dark": "#20372B",
        "finder_light": "#F7F1E3",
        "frame": "#20372B",
        "background": "#E8DDC8",
        "image_generation": True,
    },
    "botanical": {
        "dark": "#264E36",
        "light": "#F5F2E8",
        "finder_dark": "#264E36",
        "finder_light": "#F5F2E8",
        "frame": "#264E36",
        "background": "#D8E3D1",
        "image_generation": True,
    },
    "night": {
        "dark": "#111827",
        "light": "#F8FAFC",
        "finder_dark": "#111827",
        "finder_light": "#F8FAFC",
        "frame": "#F8FAFC",
        "background": "#172033",
        "image_generation": True,
    },
    "festival": {
        "dark": "#351A75",
        "light": "#FFF7ED",
        "finder_dark": "#351A75",
        "finder_light": "#FFF7ED",
        "frame": "#351A75",
        "background": "#F3D6B3",
        "image_generation": True,
    },
}

REQUEST_FIELDS = {
    "schema_version",
    "qr_id",
    "payload_type",
    "payload",
    "output",
    "error_correction",
    "style",
    "logo",
    "background",
    "privacy",
}
OUTPUT_FIELDS = {"format", "scale", "border", "width", "height"}
STYLE_BUILTIN_FIELDS = {"theme"}
STYLE_CUSTOM_FIELDS = {"theme", "dark", "light", "frame", "background", "image_generation"}
PRIVACY_FIELDS = {"allow_raw_payload_in_manifest"}


class QRCodeError(Exception):
    """A safe, structured helper error."""

    def __init__(self, category: str, message: str) -> None:
        super().__init__(message)
        self.category = category
        self.message = message


def fail(category: str, message: str) -> None:
    raise QRCodeError(category, message)


def require_object(value: object, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail("invalid_input", f"{name} must be an object")
    return value


def strict_fields(value: dict[str, Any], allowed: set[str], name: str) -> None:
    unexpected = sorted(set(value) - allowed)
    if unexpected:
        fail("invalid_input", f"{name} contains unsupported fields: {', '.join(unexpected)}")


def require_string(value: object, name: str, *, max_length: int | None = None) -> str:
    if not isinstance(value, str) or not value:
        fail("invalid_input", f"{name} must be a non-empty string")
    if max_length is not None and len(value) > max_length:
        fail("invalid_input", f"{name} exceeds its maximum length")
    return value


def require_integer(value: object, name: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        fail("invalid_input", f"{name} must be an integer from {minimum} to {maximum}")
    return value


def require_bool(value: object, name: str) -> bool:
    if not isinstance(value, bool):
        fail("invalid_input", f"{name} must be a boolean")
    return value


def require_color(value: object, name: str) -> str:
    color = require_string(value, name)
    if not COLOR_PATTERN.fullmatch(color):
        fail("invalid_style", f"{name} must be an opaque #RRGGBB color")
    return color.upper()


def payload_bytes(payload: str) -> bytes:
    try:
        encoded = payload.encode("utf-8")
    except UnicodeEncodeError as error:
        fail("invalid_payload", f"payload is not valid UTF-8: {error.reason}")
    if not encoded or len(encoded) > MAX_PAYLOAD_BYTES:
        fail("invalid_payload", "payload must contain between 1 and 4096 UTF-8 bytes")
    return encoded


def digest(data: bytes) -> str:
    return f"sha256:{hashlib.sha256(data).hexdigest()}"


def file_digest(path: Path) -> str:
    try:
        return digest(path.read_bytes())
    except OSError as error:
        fail("filesystem_error", f"could not read {path}: {error.strerror or 'read failed'}")


def validate_id(value: object, name: str) -> str:
    identifier = require_string(value, name)
    if not ID_PATTERN.fullmatch(identifier):
        fail("invalid_input", f"{name} must use lowercase letters, digits, dot, dash, or underscore")
    return identifier


def validate_absolute_file(path_value: object, name: str, *, max_bytes: int = MAX_INPUT_BYTES) -> Path:
    raw = require_string(path_value, name)
    path = Path(raw)
    if not path.is_absolute():
        fail("unsafe_path", f"{name} must be absolute")
    if path.is_symlink() or not path.is_file():
        fail("unsafe_path", f"{name} must be a regular non-symlink file")
    try:
        size = path.stat().st_size
    except OSError as error:
        fail("filesystem_error", f"could not inspect {name}: {error.strerror or 'stat failed'}")
    if size > max_bytes:
        fail("unsafe_path", f"{name} is larger than the supported input limit")
    return path.resolve()


def validate_output_dir(value: object) -> Path:
    raw = require_string(value, "output_dir")
    path = Path(raw)
    if not path.is_absolute():
        fail("unsafe_path", "output_dir must be absolute")
    if path.exists() and path.is_symlink():
        fail("unsafe_path", "output_dir must not be a symlink")
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        fail("filesystem_error", f"could not create output_dir: {error.strerror or 'mkdir failed'}")
    return path.resolve()


def strict_path_collision(path: Path) -> None:
    if path.exists() or path.is_symlink():
        fail("output_collision", f"output already exists: {path.name}")


def atomic_write_bytes(path: Path, data: bytes) -> None:
    strict_path_collision(path)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb", dir=path.parent, prefix=".qr-", suffix=".tmp", delete=False
        ) as handle:
            temporary = Path(handle.name)
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except OSError as error:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
        fail("filesystem_error", f"could not write {path.name}: {error.strerror or 'write failed'}")


def atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    payload = (json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8")
    atomic_write_bytes(path, payload)


def rgb(color: str) -> tuple[int, int, int]:
    return tuple(int(color[index : index + 2], 16) for index in (1, 3, 5))  # type: ignore[return-value]


def relative_luminance(color: str) -> float:
    channels = []
    for component in rgb(color):
        value = component / 255
        channels.append(value / 12.92 if value <= 0.03928 else ((value + 0.055) / 1.055) ** 2.4)
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]


def contrast_ratio(first: str, second: str) -> float:
    light = max(relative_luminance(first), relative_luminance(second))
    dark = min(relative_luminance(first), relative_luminance(second))
    return (light + 0.05) / (dark + 0.05)


def resolve_style(style_value: object) -> dict[str, Any]:
    style = require_object(style_value, "style")
    theme = require_string(style.get("theme"), "style.theme")
    if theme in BUILTIN_THEMES:
        strict_fields(style, STYLE_BUILTIN_FIELDS, "style")
        resolved = dict(BUILTIN_THEMES[theme])
    elif theme == "custom":
        strict_fields(style, STYLE_CUSTOM_FIELDS, "style")
        for required in ("dark", "light", "frame", "background"):
            if required not in style:
                fail("invalid_style", f"custom style requires style.{required}")
        resolved = {
            "dark": require_color(style["dark"], "style.dark"),
            "light": require_color(style["light"], "style.light"),
            "finder_dark": require_color(style["dark"], "style.dark"),
            "finder_light": require_color(style["light"], "style.light"),
            "frame": require_color(style["frame"], "style.frame"),
            "background": require_color(style["background"], "style.background"),
            "image_generation": require_bool(style.get("image_generation", False), "style.image_generation"),
        }
    else:
        fail("invalid_style", f"unsupported theme: {theme}")
    resolved["theme"] = theme
    for field in ("dark", "light", "finder_dark", "finder_light", "frame", "background"):
        resolved[field] = require_color(resolved[field], f"resolved style.{field}")
    if contrast_ratio(resolved["dark"], resolved["light"]) < 4.5:
        fail("invalid_style", "dark and light QR module colors do not meet the minimum contrast")
    return resolved


def build_image_generation_prompt(request: dict[str, Any]) -> str:
    """Build a payload-free prompt for a decorative background or theme study."""

    style = request.get("style_resolved")
    if not isinstance(style, dict):
        style = resolve_style(request.get("style"))
    theme = str(style["theme"])
    return (
        "Create a decorative QR-code background concept in the "
        f"{theme} visual theme using restrained, high-contrast brand-safe composition. "
        "Leave a quiet, opaque central area marked [QR SAFE AREA] completely empty: "
        "do not draw a QR code, barcode, encoded text, finder pattern, modules, "
        "logo, or fake scan target. Keep all ornament, texture, and typography outside "
        "that protected area. This is a background concept only; a deterministic local "
        "renderer will place and verify the QR code afterward."
    )


def validate_request(value: object) -> dict[str, Any]:
    request = require_object(value, "request")
    strict_fields(request, REQUEST_FIELDS, "request")
    if request.get("schema_version") != SCHEMA_VERSION:
        fail("invalid_input", "schema_version must be 1")
    validate_id(request.get("qr_id"), "qr_id")
    payload_type = require_string(request.get("payload_type"), "payload_type")
    if payload_type not in {"text", "url", "wifi", "vcard", "custom"}:
        fail("invalid_input", "payload_type is unsupported")
    payload = require_string(request.get("payload"), "payload", max_length=MAX_PAYLOAD_BYTES)
    payload_bytes(payload)

    output = require_object(request.get("output"), "output")
    strict_fields(output, OUTPUT_FIELDS, "output")
    output_format = require_string(output.get("format"), "output.format")
    if output_format not in {"png", "svg"}:
        fail("invalid_input", "output.format must be png or svg")
    scale = require_integer(output.get("scale"), "output.scale", 2, 64)
    border = require_integer(output.get("border"), "output.border", 4, 32)
    width = output.get("width")
    height = output.get("height")
    if (width is None) != (height is None):
        fail("invalid_input", "output.width and output.height must be supplied together")
    if width is not None:
        require_integer(width, "output.width", 128, MAX_CANVAS)
        require_integer(height, "output.height", 128, MAX_CANVAS)
        if output_format == "svg":
            fail("invalid_input", "SVG output cannot request a raster canvas size")

    error_correction = require_string(request.get("error_correction"), "error_correction")
    if error_correction not in {"L", "M", "Q", "H"}:
        fail("invalid_input", "error_correction must be L, M, Q, or H")
    style = resolve_style(request.get("style"))

    privacy = require_object(request.get("privacy"), "privacy")
    strict_fields(privacy, PRIVACY_FIELDS, "privacy")
    require_bool(privacy.get("allow_raw_payload_in_manifest"), "privacy.allow_raw_payload_in_manifest")

    logo = request.get("logo")
    if logo is not None:
        logo_object = require_object(logo, "logo")
        strict_fields(logo_object, {"path", "authorized"}, "logo")
        validate_absolute_file(logo_object.get("path"), "logo.path")
        if logo_object.get("authorized") is not True:
            fail("approval_required", "logo.authorized must be true")
        if output_format != "png":
            fail("invalid_input", "logo composition requires PNG output")
        if error_correction != "H":
            fail("invalid_input", "logo composition requires error correction H")

    background = request.get("background")
    if background is not None:
        background_object = require_object(background, "background")
        strict_fields(background_object, {"path", "authorized"}, "background")
        validate_absolute_file(background_object.get("path"), "background.path")
        if background_object.get("authorized") is not True:
            fail("approval_required", "background.authorized must be true")

    return {
        **request,
        "payload_bytes": payload_bytes(payload),
        "payload_sha256": digest(payload_bytes(payload)),
        "output": {**output, "scale": scale, "border": border},
        "style_resolved": style,
    }


def make_qr(request: dict[str, Any]) -> Any:
    try:
        return segno.make(
            request["payload"],
            error=request["error_correction"],
            micro=False,
        )
    except (TypeError, ValueError) as error:
        fail("encoder_error", f"QR encoder rejected the payload: {error}")


def validate_qr_geometry(qr: Any, request: dict[str, Any]) -> tuple[int, int]:
    try:
        width, height = qr.symbol_size(
            scale=request["output"]["scale"],
            border=request["output"]["border"],
        )
    except (TypeError, ValueError) as error:
        fail("geometry_failure", f"QR geometry could not be determined: {error}")
    if width > MAX_CANVAS or height > MAX_CANVAS:
        fail("geometry_failure", f"QR output is larger than the {MAX_CANVAS}px canvas limit")
    return width, height


def segno_kwargs(request: dict[str, Any]) -> dict[str, Any]:
    style = request["style_resolved"]
    return {
        "dark": style["dark"],
        "light": style["light"],
        "data_dark": style["dark"],
        "data_light": style["light"],
        "finder_dark": style["finder_dark"],
        "finder_light": style["finder_light"],
        "format_dark": style["dark"],
        "format_light": style["light"],
        "version_dark": style["dark"],
        "version_light": style["light"],
        "alignment_dark": style["dark"],
        "alignment_light": style["light"],
        "border": request["output"]["border"],
        "scale": request["output"]["scale"],
    }


def qr_png_image(qr: Any, request: dict[str, Any]) -> Image.Image:
    stream = io.BytesIO()
    try:
        qr.save(stream, kind="png", **segno_kwargs(request))
    except (TypeError, ValueError) as error:
        fail("render_error", f"QR rasterization failed: {error}")
    stream.seek(0)
    try:
        return Image.open(stream).convert("RGBA")
    except OSError as error:
        fail("render_error", f"QR raster output could not be loaded: {error}")


def apply_logo(image: Image.Image, request: dict[str, Any]) -> Image.Image:
    logo_value = request.get("logo")
    if logo_value is None:
        return image
    logo_path = validate_absolute_file(logo_value["path"], "logo.path")
    try:
        logo = Image.open(logo_path).convert("RGBA")
    except OSError as error:
        fail("logo_error", f"logo could not be loaded: {error}")
    max_size = max(24, int(min(image.size) * 0.18))
    logo.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
    pad = max(4, max_size // 10)
    patch_size = (logo.width + (pad * 2), logo.height + (pad * 2))
    patch = Image.new("RGBA", patch_size, request["style_resolved"]["light"])
    left = (image.width - patch.width) // 2
    top = (image.height - patch.height) // 2
    if left < 0 or top < 0:
        fail("logo_error", "logo safe area does not fit within the QR output")
    image = image.copy()
    image.paste(patch, (left, top), patch)
    image.paste(logo, (left + pad, top + pad), logo)
    return image


def fit_canvas(image: Image.Image, request: dict[str, Any]) -> Image.Image:
    output = request["output"]
    width = output.get("width")
    height = output.get("height")
    if width is None or height is None:
        return image
    if image.width > width or image.height > height:
        fail("geometry_failure", "QR output is larger than the requested canvas")
    canvas = Image.new("RGBA", (width, height), request["style_resolved"]["background"])
    left = (width - image.width) // 2
    top = (height - image.height) // 2
    canvas.alpha_composite(image, (left, top))
    return draw_frame(canvas, (left, top, left + image.width - 1, top + image.height - 1), request)


def draw_frame(canvas: Image.Image, qr_box: tuple[int, int, int, int], request: dict[str, Any]) -> Image.Image:
    left, top, right, bottom = qr_box
    gap = max(6, request["output"]["scale"] // 2)
    frame_left = max(0, left - gap)
    frame_top = max(0, top - gap)
    frame_right = min(canvas.width - 1, right + gap)
    frame_bottom = min(canvas.height - 1, bottom + gap)
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle(
        (frame_left, frame_top, frame_right, frame_bottom),
        radius=min(18, gap * 2),
        outline=request["style_resolved"]["frame"],
        width=max(2, request["output"]["scale"] // 2),
    )
    return canvas


def write_segno_output(path: Path, qr: Any, request: dict[str, Any]) -> None:
    strict_path_collision(path)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb", dir=path.parent, prefix=".qr-", suffix=".tmp", delete=False
        ) as handle:
            temporary = Path(handle.name)
        qr.save(temporary, kind=path.suffix.removeprefix("."), **segno_kwargs(request))
        os.replace(temporary, path)
    except (OSError, TypeError, ValueError) as error:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
        fail("render_error", f"QR output could not be written: {error}")


def write_png_image(path: Path, image: Image.Image) -> None:
    stream = io.BytesIO()
    image.convert("RGBA").save(stream, format="PNG", optimize=False)
    atomic_write_bytes(path, stream.getvalue())


def decode_png(path: Path) -> tuple[str, str]:
    if zxingcpp is None:
        fail("decoder_error", "QR decoder zxing-cpp is not installed")
    try:
        image = Image.open(path).convert("RGB")
    except (OSError, ValueError) as error:
        fail("decoder_error", f"PNG could not be loaded for verification: {error}")
    grayscale = image.convert("L")
    candidates = (
        (image, False),
        (grayscale, False),
        (ImageOps.autocontrast(grayscale), False),
        (grayscale, True),
        (ImageOps.autocontrast(grayscale), True),
    )
    decoder_error: Exception | None = None
    for candidate, is_pure in candidates:
        try:
            barcode = zxingcpp.read_barcode(
                candidate,
                formats=zxingcpp.BarcodeFormat.QRCode,
                is_pure=is_pure,
            )
        except (TypeError, ValueError, RuntimeError) as error:
            decoder_error = error
            continue
        if barcode is not None and barcode.valid and isinstance(barcode.text, str):
            return barcode.text, digest(barcode.text.encode("utf-8"))
    if decoder_error is not None:
        fail("decoder_error", f"QR decoder failed: {decoder_error}")
    fail("decode_mismatch", "QR decoder did not return a valid QR payload")


def output_public(path: Path, output_format: str) -> dict[str, str]:
    return {"path": str(path), "format": output_format, "sha256": file_digest(path)}


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def build_manifest(
    request: dict[str, Any],
    qr: Any,
    output_path: Path,
    verification_path: Path,
    state: str,
    *,
    failure_category: str | None = None,
    decoded_digest: str | None = None,
    image_generation_status: str = "not_requested",
) -> dict[str, Any]:
    style = request["style_resolved"]
    try:
        with Image.open(verification_path) as verification_image:
            output_width, output_height = verification_image.size
    except (OSError, ValueError) as error:
        fail("filesystem_error", f"verification image dimensions could not be read: {error}")
    output = {
        **output_public(output_path, request["output"]["format"]),
        "verification_image_path": str(verification_path),
        "width": output_width,
        "height": output_height,
        "scale": request["output"]["scale"],
        "border": request["output"]["border"],
    }
    provenance: dict[str, Any] = {}
    for field in ("logo", "background"):
        value = request.get(field)
        if value is not None:
            path = validate_absolute_file(value["path"], f"{field}.path")
            provenance[field] = {
                "path": str(path),
                "sha256": file_digest(path),
                "authorized": bool(value["authorized"]),
            }
    created_at = utc_timestamp()
    manifest: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "qr_id": request["qr_id"],
        "variant_id": f"{request['qr_id']}-{style['theme']}",
        "payload_type": request["payload_type"],
        "payload_sha256": request["payload_sha256"],
        "output": output,
        "qr": {
            "encoder": "Segno",
            "encoder_version": SEGNO_VERSION,
            "version": qr.version,
            "error_correction": request["error_correction"],
            "mask": qr.mask,
            "modules": qr.symbol_size(scale=1, border=0)[0],
            "quiet_zone_modules": request["output"]["border"],
        },
        "style": {
            "theme": style["theme"],
            "dark": style["dark"],
            "light": style["light"],
            "frame": style["frame"],
            "background": style["background"],
            "image_generation_allowed": style["image_generation"],
        },
        "image_generation": {
            "status": image_generation_status,
            "payload_redacted": True,
            "prompt_sha256": digest(build_image_generation_prompt(request).encode("utf-8")),
        },
        "provenance": provenance,
        "decoder": {
            "name": "ZXing-C++",
            "version": ZXING_CPP_VERSION,
            "decoded_payload_sha256": decoded_digest,
        },
        "state": state,
        "baseline_preserved": True,
        "raw_payload_included": bool(request["privacy"]["allow_raw_payload_in_manifest"]),
        "created_at": created_at,
        "verified_at": created_at if state == "verified" else None,
    }
    if failure_category is not None:
        manifest["failure_category"] = failure_category
    if request["privacy"]["allow_raw_payload_in_manifest"]:
        manifest["payload"] = request["payload"]
    return manifest


def verify_path(path: Path, expected_digest: str) -> str:
    decoded_text, decoded_digest = decode_png(path)
    del decoded_text
    if decoded_digest != expected_digest:
        fail("decode_mismatch", "decoded payload digest differs from the expected payload digest")
    return decoded_digest


def render_request(request: dict[str, Any], output_dir: Path) -> dict[str, Any]:
    qr = make_qr(request)
    validate_qr_geometry(qr, request)
    style = request["style_resolved"]
    variant_id = f"{request['qr_id']}-{style['theme']}"
    output_format = request["output"]["format"]
    output_path = output_dir / f"{variant_id}.{output_format}"
    verification_path = output_path if output_format == "png" else output_dir / f"{variant_id}.verification.png"

    if output_format == "svg":
        write_segno_output(output_path, qr, request)
        verification_image = qr_png_image(qr, request)
        verification_image = apply_logo(verification_image, request)
        write_png_image(verification_path, verification_image)
    else:
        image = apply_logo(qr_png_image(qr, request), request)
        image = fit_canvas(image, request)
        write_png_image(output_path, image)

    state = "verified"
    failure_category: str | None = None
    decoded_digest: str | None = None
    try:
        decoded_digest = verify_path(verification_path, request["payload_sha256"])
    except QRCodeError as error:
        state = (
            "verification_unavailable"
            if error.category == "decoder_error"
            else error.category
            if error.category == "decode_mismatch"
            else "verification_unavailable"
        )
        failure_category = error.category

    manifest = build_manifest(
        request,
        qr,
        output_path,
        verification_path,
        state,
        failure_category=failure_category,
        decoded_digest=decoded_digest,
    )
    manifest_path = output_dir / f"{variant_id}.manifest.json"
    atomic_write_json(manifest_path, manifest)
    manifest["manifest_path"] = str(manifest_path)
    return manifest


def load_request(path_value: object) -> dict[str, Any]:
    path = validate_absolute_file(path_value, "input", max_bytes=MAX_INPUT_BYTES)
    try:
        return validate_request(json.loads(path.read_text(encoding="utf-8")))
    except UnicodeError as error:
        fail("invalid_input", f"input is not valid UTF-8: {error}")
    except json.JSONDecodeError as error:
        fail("invalid_input", f"input is not valid JSON at line {error.lineno}")


def load_manifest(path_value: object) -> dict[str, Any]:
    path = validate_absolute_file(path_value, "input", max_bytes=MAX_INPUT_BYTES)
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeError, json.JSONDecodeError) as error:
        fail("invalid_input", f"manifest is not valid JSON: {error}")
    manifest = require_object(manifest, "manifest")
    if manifest.get("schema_version") != SCHEMA_VERSION:
        fail("invalid_input", "manifest schema_version must be 1")
    expected_digest = manifest.get("payload_sha256")
    if not isinstance(expected_digest, str) or not DIGEST_PATTERN.fullmatch(expected_digest):
        fail("invalid_input", "manifest payload_sha256 is invalid")
    output = require_object(manifest.get("output"), "manifest.output")
    verification_path = output.get("verification_image_path")
    if not isinstance(verification_path, str):
        verification_path = output.get("path")
    return {**manifest, "verification_path": validate_absolute_file(verification_path, "verification_image")}


def command_validate(args: argparse.Namespace) -> dict[str, Any]:
    request = load_request(args.input)
    return {
        "ok": True,
        "command": "validate",
        "qr_id": request["qr_id"],
        "payload_type": request["payload_type"],
        "payload_sha256": request["payload_sha256"],
        "payload_bytes": len(request["payload_bytes"]),
        "theme": request["style_resolved"]["theme"],
        "output_format": request["output"]["format"],
        "raw_payload_included": False,
    }


def command_render(args: argparse.Namespace) -> dict[str, Any]:
    request = load_request(args.input)
    output_dir = validate_output_dir(args.output_dir)
    manifest = render_request(request, output_dir)
    return {"ok": True, "command": "render", **manifest}


def command_compose(args: argparse.Namespace) -> dict[str, Any]:
    request = load_request(args.input)
    output_dir = validate_output_dir(args.output_dir)
    qr_path = validate_absolute_file(args.qr, "qr")
    if qr_path.suffix.lower() != ".png":
        fail("invalid_input", "compose requires a PNG QR input")
    verify_path(qr_path, request["payload_sha256"])

    background_path: Path | None = None
    if args.background is not None:
        approved_background = request.get("background")
        if not isinstance(approved_background, dict) or approved_background.get("authorized") is not True:
            fail("approval_required", "compose background must be declared and authorized in the request")
        background_path = validate_absolute_file(args.background, "background")
        approved_path = validate_absolute_file(approved_background.get("path"), "background.path")
        if background_path != approved_path:
            fail("approval_required", "compose background does not match the authorized request background")
    elif request.get("background") is not None:
        background_path = validate_absolute_file(request["background"]["path"], "background.path")

    try:
        qr_image = Image.open(qr_path).convert("RGBA")
        if qr_image.width > MAX_CANVAS or qr_image.height > MAX_CANVAS:
            fail("geometry_failure", f"QR input is larger than the {MAX_CANVAS}px canvas limit")
        if background_path is None:
            width = request["output"].get("width") or qr_image.width
            height = request["output"].get("height") or qr_image.height
            background = Image.new("RGBA", (width, height), request["style_resolved"]["background"])
        else:
            background = Image.open(background_path).convert("RGBA")
            width = request["output"].get("width") or background.width
            height = request["output"].get("height") or background.height
            background = ImageOps.fit(background, (width, height), method=Image.Resampling.LANCZOS)
        if width > MAX_CANVAS or height > MAX_CANVAS:
            fail("geometry_failure", f"composition is larger than the {MAX_CANVAS}px canvas limit")
    except (OSError, ValueError) as error:
        fail("compose_error", f"background or QR could not be loaded: {error}")

    if qr_image.width > width or qr_image.height > height:
        fail("geometry_failure", "QR safe area does not fit within the composition canvas")
    left = (width - qr_image.width) // 2
    top = (height - qr_image.height) // 2
    canvas = background.copy()
    canvas.alpha_composite(qr_image, (left, top))
    canvas = draw_frame(canvas, (left, top, left + qr_image.width - 1, top + qr_image.height - 1), request)
    variant_id = f"{request['qr_id']}-{request['style_resolved']['theme']}-composed"
    output_path = output_dir / f"{variant_id}.png"
    write_png_image(output_path, canvas)
    state = "verified"
    failure_category: str | None = None
    decoded_digest: str | None = None
    try:
        decoded_digest = verify_path(output_path, request["payload_sha256"])
    except QRCodeError as error:
        state = "verification_unavailable" if error.category == "decoder_error" else error.category
        failure_category = error.category
    manifest = build_manifest(
        request,
        make_qr(request),
        output_path,
        output_path,
        state,
        failure_category=failure_category,
        decoded_digest=decoded_digest,
        image_generation_status="background_supplied" if background_path else "not_requested",
    )
    manifest_path = output_dir / f"{variant_id}.manifest.json"
    atomic_write_json(manifest_path, manifest)
    manifest["manifest_path"] = str(manifest_path)
    return {"ok": True, "command": "compose", **manifest}


def command_verify(args: argparse.Namespace) -> dict[str, Any]:
    manifest = load_manifest(args.input)
    decoded_digest = verify_path(manifest["verification_path"], manifest["payload_sha256"])
    return {
        "ok": True,
        "command": "verify",
        "qr_id": manifest.get("qr_id"),
        "variant_id": manifest.get("variant_id"),
        "state": "verified",
        "payload_sha256": manifest["payload_sha256"],
        "decoded_payload_sha256": decoded_digest,
        "verification_image": str(manifest["verification_path"]),
    }


def command_manifest(args: argparse.Namespace) -> dict[str, Any]:
    manifest = load_manifest(args.input)
    manifest.pop("verification_path", None)
    manifest["ok"] = True
    manifest["command"] = "manifest"
    return manifest


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)
    for name in ("validate", "render", "compose", "verify", "manifest"):
        command = commands.add_parser(name)
        command.add_argument("--input", required=True, help="absolute request or manifest JSON path")
        if name == "render" or name == "compose":
            command.add_argument("--output-dir", required=True, help="absolute task-owned output directory")
        if name == "compose":
            command.add_argument("--qr", required=True, help="absolute verified QR PNG path")
            command.add_argument("--background", help="absolute authorized background image path")
    return root


def run(args: argparse.Namespace) -> dict[str, Any]:
    if args.command == "validate":
        return command_validate(args)
    if args.command == "render":
        return command_render(args)
    if args.command == "compose":
        return command_compose(args)
    if args.command == "verify":
        return command_verify(args)
    if args.command == "manifest":
        return command_manifest(args)
    fail("invalid_input", "unsupported command")


def main() -> int:
    try:
        result = run(parser().parse_args())
    except QRCodeError as error:
        print(
            json.dumps(
                {"ok": False, "error": {"category": error.category, "message": error.message}},
                ensure_ascii=False,
                sort_keys=True,
            )
        )
        return 1
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
