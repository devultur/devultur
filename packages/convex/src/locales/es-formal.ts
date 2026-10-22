// Formal Spanish («usted») for everything `@devultur/convex/locales/es` exports, under the same names. It is derived
// from `es`: only the strings that address the reader are overridden, so the rest can't drift between the two.
import type { AttachmentLabels } from "../attachment-labels";
import type { DevulturErrorLabels } from "../error-labels";
import { describeDevulturError, labelText } from "../error-labels";
import type { MediaLibraryLabels } from "../media-library-labels";
import type { MediaPickerLabels } from "../media-picker-labels";
import type { PreviewLabels } from "../preview-labels";
import * as es from "./es";

const TRY_AGAIN = "Vuelva a intentarlo.";
const TRY_AGAIN_LATER = "Vuelva a intentarlo más tarde.";

export const devulturErrorLabels: DevulturErrorLabels = {
	...es.devulturErrorLabels,
	content_unverified: `No se pudo verificar la subida. ${TRY_AGAIN}`,
	write_conflict: `El archivo cambió mientras se guardaba. ${TRY_AGAIN}`,
	upload_not_found: "No se encontró la subida o ya venció. Vuelva a empezarla.",
	invalid_cursor: "La página de resultados no es válida. Vuelva a cargar la lista.",
	sha256_mismatch: `El archivo se dañó durante la subida. ${TRY_AGAIN}`,
	max_files_reached: "Alcanzó el número máximo de archivos para esta subida.",
	invalid_part: `Una parte de la subida no es válida. ${TRY_AGAIN}`,
	invalid_parts: `La subida está incompleta. ${TRY_AGAIN}`,
	part_size_mismatch: `Una parte de la subida tiene un tamaño incorrecto. ${TRY_AGAIN}`,
	invalid_media_metadata: (details) => {
		if (details.field === "tags") return "Use como máximo 20 etiquetas, de hasta 50 caracteres cada una.";
		return labelText(es.devulturErrorLabels.invalid_media_metadata, details);
	},
	lock_conflict: `La protección del archivo cambió mientras tanto. ${TRY_AGAIN}`,
	lock_privilege_required: "No tiene permiso para acortar ni quitar la protección de este archivo.",
	encryption_key_missing: "Este archivo ya no se puede leer. Vuelva a subirlo.",
	unauthorized: "No tiene autorización para hacer esto.",
	session_mismatch: "Su sesión cambió. Vuelva a cargar la página.",
	user_mismatch: "Solo puede ver y cambiar su propio progreso.",
	transcode_runner_unavailable: `El procesamiento de video está ocupado en este momento. ${TRY_AGAIN_LATER}`,
	original_not_retained:
		"El video original ya no está disponible, así que no se puede volver a procesar. Vuelva a subirlo.",
	captions_provider_rate_limited: `El servicio de subtítulos está ocupado en este momento. ${TRY_AGAIN_LATER}`,
	token_unavailable: `No se pudo autorizar el acceso a este archivo. ${TRY_AGAIN}`,
};

export const attachmentLabels: AttachmentLabels = es.attachmentLabels;

export const previewLabels: PreviewLabels = {
	...es.previewLabels,
	error: (code) =>
		code === "page_cap" ? "Descargue el archivo para ver todas las páginas." : labelText(devulturErrorLabels[code]),
};

export const mediaLibraryLabels: MediaLibraryLabels = {
	...es.mediaLibraryLabels,
	searchPlaceholder: "Busque por título o nombre de archivo",
	error: (error) => describeDevulturError(error, devulturErrorLabels) ?? "No se pudieron cargar los archivos.",
};

export const mediaPickerLabels: MediaPickerLabels = {
	...es.mediaPickerLabels,
	dropHint: (multiple) => (multiple ? "o suelte los archivos aquí" : "o suelte un archivo aquí"),
	uploadError: (error) => describeDevulturError(error, devulturErrorLabels) ?? `La subida falló. ${TRY_AGAIN}`,
};
