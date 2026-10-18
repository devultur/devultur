// Durable Object that starts the transcode container (`cloudflare` runner). Separate entry
// (`@devultur/self-host/transcode-container`) because it imports `cloudflare:workers`: only the Worker that
// opts into Cloudflare Containers loads it, re-exporting it from its entry:
//   export { TranscodeContainer } from "@devultur/self-host/transcode-container";
import { DurableObject } from "cloudflare:workers";
import {
	type ContainerHandle,
	type ContainerLaunchRequest,
	type ContainerLaunchResult,
	startTranscodeContainer,
	watchContainer,
} from "./cloudflare";

export class TranscodeContainer extends DurableObject {
	private get container(): ContainerHandle | undefined {
		return this.ctx.container as ContainerHandle | undefined;
	}

	async launch(request: ContainerLaunchRequest): Promise<ContainerLaunchResult> {
		const started = startTranscodeContainer(this.container, request);
		// A pending `monitor()` prevents the DO from being evicted until the container exits (or 15 min,
		// whichever comes first). Past that the container keeps running; only the untrapped-crash report is lost.
		if (started.exited) this.ctx.waitUntil(watchContainer(started.exited, request.env));
		return { alreadyRunning: started.alreadyRunning };
	}

	async cancel(): Promise<void> {
		if (this.container?.running) await this.container.destroy(new Error("transcode cancelled"));
	}
}
