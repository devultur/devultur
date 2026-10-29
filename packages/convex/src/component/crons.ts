// The component's scheduled work: forgetting processed lifecycle event ids after 7 days (lifecycle.ts), apart from the
// mutations that record them.
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Hourly, `PRUNE_BATCH` ids a run: well above the rate a Worker's lifecycle events arrive at.
crons.hourly("prune processed lifecycle events", { minuteUTC: 17 }, internal.lifecycle.pruneProcessedEvents, {});

export default crons;
