// Keep the full-screen editor inside the visible area while iOS moves browser
// controls or its keyboard. Lock the page separately from the scrollable dialog.
export function lockPanelViewport(panel) {
	const root = document.documentElement;
	const pageX = window.scrollX, pageY = window.scrollY;
	const viewport = window.visualViewport;
	let frame = 0;
	root.style.setProperty("--review-page-x", `${-pageX}px`);
	root.style.setProperty("--review-page-y", `${-pageY}px`);
	root.classList.add("review-selecting");
	const sync = () => {
		panel.style.setProperty("--review-panel-top", `${Math.max(0, viewport?.offsetTop || 0)}px`);
		panel.style.setProperty("--review-panel-left", `${Math.max(0, viewport?.offsetLeft || 0)}px`);
		panel.style.setProperty("--review-panel-height", `${viewport?.height || window.innerHeight}px`);
		panel.style.setProperty("--review-panel-width", `${viewport?.width || window.innerWidth}px`);
	};
	const schedule = () => {
		if (frame) return;
		frame = requestAnimationFrame(() => { frame = 0; sync(); });
	};
	viewport?.addEventListener("resize", schedule);
	viewport?.addEventListener("scroll", schedule);
	window.addEventListener("resize", schedule);
	sync();
	return () => {
		cancelAnimationFrame(frame);
		viewport?.removeEventListener("resize", schedule);
		viewport?.removeEventListener("scroll", schedule);
		window.removeEventListener("resize", schedule);
		for (const side of ["top", "left", "height", "width"]) panel.style.removeProperty(`--review-panel-${side}`);
		root.classList.remove("review-selecting");
		root.style.removeProperty("--review-page-x");
		root.style.removeProperty("--review-page-y");
		window.scrollTo(pageX, pageY);
	};
}
