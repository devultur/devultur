// The component's client of the media Worker, from the env the app mounts the component with.
import { createWorkerClient, type WorkerClient } from "@devultur/core";
import { env } from "./_generated/server";

export function getMediaClient(): WorkerClient {
	return createWorkerClient(env.DEVULTUR_SECRET, env.DEVULTUR_API_URL);
}
