"use client";

import React from "react";
import type { MediaSession } from "./media-session";

/** Asks for the viewer token while `isNeeded` (a private media is shown). Under eager issuance it does nothing. */
export function useRequestTokenWhen(session: Pick<MediaSession, "requestToken" | "token">, isNeeded: boolean): void {
	const { requestToken, token } = session;
	const hasToken = token !== null;
	React.useEffect(() => {
		if (isNeeded && !hasToken) requestToken();
	}, [isNeeded, hasToken, requestToken]);
}
