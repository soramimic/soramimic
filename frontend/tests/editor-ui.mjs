export async function openLine(page, line = 0) {
	const panel = page.locator("#editor-panel");
	if (await panel.evaluate((node) => node.classList.contains("open"))) {
		await page.locator(".panel-close").click();
	}
	await page.locator(`.review-line[data-line="${line}"] .review-word`).first().click();
	await page.locator(".review-unit").first().waitFor({ state: "visible" });
	await page.locator(".review-unit").first().scrollIntoViewIfNeeded();
}

export async function selectRange(page, line, start, end = start) {
	await openLine(page, line);
	const units = page.locator(".review-unit");
	await units.nth(start).scrollIntoViewIfNeeded();
	const from = await units.nth(start).boundingBox();
	const to = await units.nth(end).boundingBox();
	const x = from.x + from.width / 2, y = from.y + from.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(to.x + to.width / 2 + (start === end ? 8 : 0), to.y + to.height / 2, { steps: 4 });
	await page.mouse.up();
}

export async function selectReading(page, line, reading) {
	await openLine(page, line);
	const index = (await page.locator(".review-unit").allTextContents()).indexOf(reading);
	if (index < 0) throw new Error(`missing reading ${reading}`);
	await selectRange(page, line, index);
}

export async function menuAction(page, id) {
	await closeSelection(page);
	if (!await page.locator(".review-menu").evaluate((menu) => menu.open)) {
		await page.locator(".review-menu > summary").click();
	}
	await page.locator(id).click();
}

export async function closeSelection(page) {
	if (await page.locator("#editor-panel").evaluate((panel) => panel.classList.contains("open"))) {
		await page.locator(".panel-close").click();
	}
}
