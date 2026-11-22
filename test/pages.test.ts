import { describe, expect, it } from "vitest";
import { call } from "./helpers";

describe("pages", () => {
  it("board has the expandable submit panel and the nav Connect link hook", async () => {
    const r = await call("/");
    expect(r.status).toBe(200);
    expect(r.text).toContain('<details class="submit-panel" id="submit-panel">');
    expect(r.text).toContain("<summary>Submit a signed receipt</summary>");
    expect(r.text).toContain('id="submit-auth-note"');
    expect(r.text).toContain('id="nav-connect"');
    expect(r.text).toMatch(/\/static\/app\.js\?v=\w+[\s\S]*\/static\/submit\.js\?v=\w+/);
    expect(r.text).toMatch(/\/static\/style\.css\?v=\w+/);
  });

  it("every page loads app.js (nav session state); connect keeps step 3", async () => {
    for (const path of ["/methodology", "/connect"]) {
      const r = await call(path);
      expect(r.text).toContain("/static/app.js");
      expect(r.text).toContain('id="nav-connect"');
    }
    const c = await call("/connect");
    expect(c.text).toContain('id="step3"');
    expect(c.text).not.toContain('id="submit-auth-note"');
  });

  it("serves the shared scripts", async () => {
    for (const s of ["app.js", "submit.js", "connect.js"]) expect((await call(`/static/${s}`)).status).toBe(200);
  });
});
