// @vitest-environment jsdom

import { defaultVideoPlayerLabels, QualityButton, VideoPlayer, type VideoPlayerLabels } from "@devultur/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { videoPlayerLabels as spanishLabels } from "./locales/es";
import { videoPlayerLabels as formalSpanishLabels } from "./locales/es-formal";

const SRC = "https://media.example/v1/media/public/video/v1/video.mp4";
const captions = [{ locale: "es", label: "Español", src: "https://media.example/captions/es.vtt" }];

function renderPlayer(labels?: Partial<VideoPlayerLabels>) {
	return render(<VideoPlayer src={SRC} captions={captions} metrics={false} labels={labels} />);
}

afterEach(cleanup);

describe("<VideoPlayer labels>", () => {
	it("names the player and its controls in English by default", () => {
		renderPlayer();

		expect(screen.getByRole("application", { name: "Video player" })).toBeTruthy();
		expect(screen.getByRole("toolbar", { name: "Video controls" })).toBeTruthy();
		expect(screen.getAllByRole("button", { name: "Play" })).toHaveLength(2);
		expect(screen.getByRole("slider", { name: "Seek" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Mute" })).toBeTruthy();
		expect(screen.getByRole("slider", { name: "Volume" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Playback speed" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Fullscreen" })).toBeTruthy();
	});

	it("shows the Spanish strings from locales/es", () => {
		renderPlayer(spanishLabels);

		expect(screen.getByRole("application", { name: "Reproductor de video" })).toBeTruthy();
		expect(screen.getByRole("toolbar", { name: "Controles del video" })).toBeTruthy();
		expect(screen.getAllByRole("button", { name: "Reproducir" })).toHaveLength(2);
		expect(screen.getByRole("slider", { name: "Posición del video" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Silenciar" })).toBeTruthy();
		expect(screen.getByRole("slider", { name: "Volumen" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Pantalla completa" })).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Subtítulos" }));
		expect(screen.getByRole("button", { name: "Desactivados" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Velocidad de reproducción" }));
		expect(screen.getByRole("button", { name: "Normal" })).toBeTruthy();
	});

	it("keeps the defaults for the strings it isn't given", () => {
		renderPlayer({ play: "Reproducir", volume: undefined });

		expect(screen.getAllByRole("button", { name: "Reproducir" })).toHaveLength(2);
		expect(screen.getByRole("slider", { name: "Volume" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Captions" })).toBeTruthy();
	});

	it("labels a control used on its own", () => {
		const state = { qualityLevels: [{ height: 720 }, { height: 1080 }], currentQuality: -1 };
		render(<QualityButton state={state as never} controls={{} as never} labels={spanishLabels} />);

		expect(screen.getByRole("button", { name: "Calidad del video" }).textContent).toBe("Automática");
	});

	it("has every string in both Spanish locales", () => {
		const names = Object.keys(defaultVideoPlayerLabels).sort();
		expect(Object.keys(spanishLabels).sort()).toEqual(names);
		expect(Object.keys(formalSpanishLabels).sort()).toEqual(names);
		expectTypeOf(spanishLabels).toEqualTypeOf<VideoPlayerLabels>();
		expectTypeOf<React.ComponentProps<typeof VideoPlayer>["labels"]>().toEqualTypeOf<
			Partial<VideoPlayerLabels> | undefined
		>();
	});
});
