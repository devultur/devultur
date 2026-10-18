// Reference HTTP runner for `TRANSCODE_RUNNER=http` (VPS, Hetzner, local dev). Receives the job the
// Worker POSTs and runs its `command` with its `env` inside the transcode image (Docker), or, in
// `local` mode, directly on this machine (needs ffmpeg, ffprobe, curl and bc). Job status flows back
// to the Worker via the script's webhooks; this server only queues and executes.
//
// Requirements: Node >= 22.18 (runs .ts without a build) and Docker in `docker` mode.
//   docker build -t devultur-ffmpeg infra/transcode
//   RUNNER_SECRET=$(openssl rand -base64 32) node infra/transcode/http-runner/server.ts
// Put it behind HTTPS (Caddy, Cloudflare Tunnel): the job carries the upload credential and secrets in `env`.
//
// Variables: RUNNER_SECRET (required, = the Worker's TRANSCODE_RUNNER_SECRET), PORT (8080),
// RUNNER_MODE (`docker` | `local`), TRANSCODE_IMAGE (`devultur-ffmpeg`), MAX_CONCURRENT_JOBS (2).
import { type ChildProcess, spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

interface JobRequest {
	version: 1;
	videoId: string;
	command: string[];
	env: Record<string, string>;
}

interface QueuedJob extends JobRequest {
	jobId: string;
}

const SECRET = process.env.RUNNER_SECRET ?? "";
const PORT = Number(process.env.PORT ?? 8080);
const MODE = process.env.RUNNER_MODE === "local" ? "local" : "docker";
const IMAGE = process.env.TRANSCODE_IMAGE ?? "devultur-ffmpeg";
const MAX_CONCURRENT_JOBS = Math.max(1, Number(process.env.MAX_CONCURRENT_JOBS ?? 2));
const MAX_BODY_BYTES = 1024 * 1024;

if (!SECRET) {
	console.error("RUNNER_SECRET is required");
	process.exit(1);
}

const queue: QueuedJob[] = [];
const running = new Map<string, ChildProcess>();

function isAuthorized(header: string | undefined): boolean {
	const expected = Buffer.from(`Bearer ${SECRET}`);
	const received = Buffer.from(header ?? "");
	return received.length === expected.length && timingSafeEqual(received, expected);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	if (typeof value !== "object" || value === null) return false;
	return Object.values(value).every((entry) => typeof entry === "string");
}

function parseJob(raw: unknown): JobRequest | null {
	const job = raw as Partial<JobRequest> | null;
	if (job?.version !== 1 || typeof job.videoId !== "string" || !job.videoId) return null;
	if (!Array.isArray(job.command) || job.command.length === 0) return null;
	if (!job.command.every((part) => typeof part === "string") || !isStringRecord(job.env)) return null;
	return job as JobRequest;
}

// docker: the env VALUES travel through the process env (`-e NAME` with no value), never through argv.
function spawnJob(job: QueuedJob): ChildProcess {
	const [executable = "sh", ...args] = job.command;
	const env = { PATH: process.env.PATH ?? "", ...job.env };
	if (MODE === "local") return spawn(executable, args, { env, stdio: ["ignore", "pipe", "pipe"] });

	const envFlags = Object.keys(job.env).flatMap((name) => ["-e", name]);
	const dockerArgs = ["run", "--rm", "--name", job.jobId, ...envFlags, "--entrypoint", executable, IMAGE, ...args];
	return spawn("docker", dockerArgs, { env, stdio: ["ignore", "pipe", "pipe"] });
}

function pump(): void {
	while (running.size < MAX_CONCURRENT_JOBS && queue.length > 0) {
		const job = queue.shift();
		if (!job) return;
		const child = spawnJob(job);
		running.set(job.jobId, child);
		const log = (chunk: Buffer) => process.stdout.write(`[${job.jobId}] ${chunk}`);
		child.stdout?.on("data", log);
		child.stderr?.on("data", log);
		child.on("close", (code) => {
			console.log(`[${job.jobId}] exited with ${code}`);
			running.delete(job.jobId);
			pump();
		});
	}
}

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) reject(new Error("body too large"));
			else chunks.push(chunk);
		});
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		request.on("error", reject);
	});
}

function reply(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "Content-Type": "application/json" });
	response.end(JSON.stringify(body));
}

async function handleCreate(request: IncomingMessage, response: ServerResponse): Promise<void> {
	const job = parseJob(JSON.parse(await readBody(request)));
	if (!job) return reply(response, 400, { error: "invalid job" });
	const jobId = `transcode-${job.videoId.replace(/[^a-zA-Z0-9_-]/g, "")}-${Date.now().toString(36)}`;
	queue.push({ ...job, jobId });
	pump();
	reply(response, 202, { jobId, queued: queue.length });
}

function handleCancel(jobId: string, response: ServerResponse): void {
	const queuedIndex = queue.findIndex((job) => job.jobId === jobId);
	if (queuedIndex >= 0) queue.splice(queuedIndex, 1);
	running.get(jobId)?.kill("SIGTERM");
	if (MODE === "docker") spawn("docker", ["stop", jobId], { stdio: "ignore" });
	reply(response, 202, { jobId, cancelled: true });
}

createServer((request, response) => {
	const url = new URL(request.url ?? "/", "http://runner");
	if (url.pathname === "/health") return reply(response, 200, { running: running.size, queued: queue.length });
	if (!isAuthorized(request.headers.authorization)) return reply(response, 401, { error: "unauthorized" });

	if (request.method === "POST" && url.pathname === "/jobs") {
		handleCreate(request, response).catch(() => reply(response, 400, { error: "invalid body" }));
		return;
	}
	const cancelMatch = url.pathname.match(/^\/jobs\/([^/]+)$/);
	if (request.method === "DELETE" && cancelMatch?.[1])
		return handleCancel(decodeURIComponent(cancelMatch[1]), response);
	reply(response, 404, { error: "not found" });
}).listen(PORT, () => console.log(`transcode http runner on :${PORT} (${MODE}, ${MAX_CONCURRENT_JOBS} slots)`));
