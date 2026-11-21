/** Tiny HTML templating with auto-escaping. raw() marks trusted fragments. */
export class Raw {
  constructor(public value: string) {}
  toString() {
    return this.value;
  }
}
export const raw = (s: string) => new Raw(s);

export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0] ?? "";
  values.forEach((v, i) => {
    if (Array.isArray(v)) out += v.map((x) => (x instanceof Raw ? x.value : esc(x))).join("");
    else if (v instanceof Raw) out += v.value;
    else if (v === null || v === undefined || v === false) out += "";
    else out += esc(v);
    out += strings[i + 1] ?? "";
  });
  return new Raw(out);
}

const LISBON = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Lisbon",
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  timeZoneName: "short",
});

/** Stored in UTC, shown in Europe/Lisbon with a zone label (SPEC §7). */
export function lisbon(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : LISBON.format(d);
}

export const pct = (x: number | null | undefined) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
export const ms = (x: number | null | undefined) => (x == null ? "—" : x >= 10_000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x)} ms`);
export const flop = (x: number | null | undefined) => (x == null ? "n/a" : x < 0.0001 ? x.toExponential(2) : String(+x.toPrecision(6)));
export const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-6)}` : a);
