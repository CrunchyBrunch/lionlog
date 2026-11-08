// Offline process preload for the producer entry-point regression. No network fallback.
globalThis.fetch = async (_url, init) => {
  const form = new URLSearchParams(String(init?.body ?? ""));
  const campus = form.get("selCampus");
  const date = form.get("selMenuDate");
  const meal = form.get("selMeal");
  const fallback = process.env.LIONLOG_TEST_SHAPE === "fallback";
  const expectedMeal = fallback ? "Dinner" : "Lunch";
  if (!campus || date !== "11/8/26" || (meal !== "" && meal !== expectedMeal)) {
    throw new Error("Unexpected offline fixture request");
  }
  const controls = `<select name="selCampus"><option value="${campus}" selected>${campus}</option></select>
    <select name="selMenuDate"><option value="${date}" selected>${date}</option></select>
    <select name="selMeal"><option value="${expectedMeal}" selected>${expectedMeal}</option></select>`;
  const shape = fallback
    ? campus === "11" ? `<p data-menu-empty>No menu items are available</p>`
      : `<div class="menu-category-section"><h2>PRIVATE_SENTINEL_NEVER_LOG</h2></div>
        <div class="daily-menu-item">PRIVATE_SENTINEL_NEVER_LOG</div>`
    : process.env.LIONLOG_TEST_SHAPE === "item"
    ? `<div class="menu-category-section"><h2>PRIVATE_SENTINEL_NEVER_LOG</h2><div class="daily-menu-changed">Item</div></div>`
    : `<div class="menu-category-changed"><h2>PRIVATE_SENTINEL_NEVER_LOG</h2><div class="daily-menu-item">Item</div></div>`;
  return new Response(`<html><body>${controls}${meal ? shape : ""}</body></html>`,
    { status: 200, headers: { "content-type": "text/html" } });
};
