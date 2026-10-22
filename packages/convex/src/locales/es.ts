// Spanish messages for Devultur errors: `describeDevulturError(error, devulturErrorLabels)`.
import type { DevulturErrorLabels } from "../error-labels";
import { formatBytes, formatDate } from "../error-labels";

const LOCALE = "es";

export const devulturErrorLabels: DevulturErrorLabels = {
	file_too_large: (details) => {
		const limit = typeof details.limit === "number" ? formatBytes(details.limit, LOCALE) : null;
		return limit ? `El archivo supera el tamaño máximo (${limit}).` : "El archivo supera el tamaño máximo.";
	},
	content_type_not_allowed: "Este tipo de archivo no está permitido.",
	content_type_mismatch: "El contenido del archivo no coincide con su tipo.",
	content_unverified: "No se pudo verificar la subida. Vuelve a intentarlo.",
	unsupported_content_type: "Este tipo de archivo no es compatible.",
	media_type_mismatch: "El tipo de archivo no coincide con el tipo de contenido esperado.",
	already_exists: "Ya existe un archivo con este nombre.",
	write_conflict: "El archivo cambió mientras se guardaba. Vuelve a intentarlo.",
	upload_not_found: "No se encontró la subida o ya venció. Vuelve a empezarla.",
	invalid_upload_key: "Esta subida no es válida.",
	invalid_path: "La ruta del archivo no es válida.",
	path_required: "Esta subida necesita una ruta de archivo.",
	invalid_expires_in: "El tiempo de vencimiento no es válido.",
	invalid_file_expires_in: "El tiempo de vencimiento del archivo no es válido.",
	invalid_cache_control: "La configuración de caché no es válida.",
	invalid_limits: "Los límites de la subida no son válidos.",
	invalid_prefix: "La carpeta no es válida.",
	invalid_visibility: "La visibilidad debe ser pública o privada.",
	invalid_cursor: "La página de resultados no es válida. Vuelve a cargar la lista.",
	invalid_sha256: "La suma de verificación del archivo no es válida.",
	sha256_mismatch: "El archivo se dañó durante la subida. Vuelve a intentarlo.",
	max_files_reached: "Alcanzaste el número máximo de archivos para esta subida.",
	invalid_multipart: "La solicitud de subida no es válida.",
	invalid_size: "El tamaño del archivo no es válido.",
	invalid_part: "Una parte de la subida no es válida. Vuelve a intentarlo.",
	invalid_parts: "La subida está incompleta. Vuelve a intentarlo.",
	part_size_mismatch: "Una parte de la subida tiene un tamaño incorrecto. Vuelve a intentarlo.",
	part_sha256_required: "A una parte de la subida le falta la suma de verificación.",
	invalid_media_metadata: (details) => {
		if (details.field === "title") return "El título no puede tener más de 200 caracteres.";
		if (details.field === "alt") return "El texto alternativo no puede tener más de 1000 caracteres.";
		if (details.field === "tags") return "Usa como máximo 20 etiquetas, de hasta 50 caracteres cada una.";
		return "Los datos del archivo no son válidos.";
	},
	expired: "Este archivo ya venció.",
	invalid_key: "La referencia del archivo no es válida.",
	invalid_max_uses: "El número de usos no es válido.",
	link_exists: "Este enlace de descarga ya existe.",
	link_not_found: "Este enlace de descarga no existe.",
	link_expired: "Este enlace de descarga ya venció.",
	link_used: "Este enlace de descarga ya se usó.",
	not_configured: "Esta función no está configurada.",
	retention_active: (details) => {
		if (details.hold === true) return "Este archivo tiene una retención legal y no se puede modificar ni eliminar.";
		const until = formatDate(details.until, LOCALE);
		return until
			? `Este archivo está protegido hasta el ${until} y no se puede modificar ni eliminar antes de esa fecha.`
			: "Este archivo está protegido y no se puede modificar ni eliminar.";
	},
	lock_conflict: "La protección del archivo cambió mientras tanto. Vuelve a intentarlo.",
	compliance_extend_only: "La protección de este archivo solo se puede extender.",
	lock_privilege_required: "No tienes permiso para acortar ni quitar la protección de este archivo.",
	lock_record_unreadable: "No se pudo leer la protección del archivo.",
	lock_below_minimum: "Esta subida requiere una protección más estricta.",
	invalid_lock: "La configuración de protección no es válida.",
	invalid_hold: "La configuración de retención legal no es válida.",
	reserved_key: "Este nombre de archivo está reservado.",
	keys_bucket_missing: "En este momento no se pueden guardar archivos de forma segura.",
	encryption_key_missing: "Este archivo ya no se puede leer. Vuelve a subirlo.",
	unauthorized: "No tienes autorización para hacer esto.",
	session_mismatch: "Tu sesión cambió. Vuelve a cargar la página.",
	token_rejected: "Se denegó el acceso.",
	reserved_user_id: "Este identificador de usuario está reservado.",
	invalid_scopes: "Los permisos solicitados no son válidos.",
	transcode_not_configured: "El procesamiento de video no está configurado.",
	transcode_runner_unavailable:
		"El procesamiento de video está ocupado en este momento. Vuelve a intentarlo más tarde.",
	transcode_launch_failed: "No se pudo procesar el video.",
	original_not_retained:
		"El video original ya no está disponible, así que no se puede volver a procesar. Vuelve a subirlo.",
	locale_not_allowed: "Los subtítulos no están disponibles en este idioma.",
	captions_provider_rate_limited:
		"El servicio de subtítulos está ocupado en este momento. Vuelve a intentarlo más tarde.",
	captions_provider_error: "No se pudieron generar los subtítulos.",
	captions_failed: "No se pudieron generar los subtítulos.",
	webhook_secret_missing: "El procesamiento de video no está configurado.",
	worker_auth_secret_missing: "El servicio de medios no está configurado.",
	worker_error: "El servicio de medios no pudo completar la solicitud.",
	http_error: "No se pudo cargar el archivo.",
	too_large: "El archivo es demasiado grande para la vista previa.",
	unsupported_type: "Este tipo de archivo no tiene vista previa.",
	type_mismatch: "El contenido del archivo no coincide con su tipo.",
};
