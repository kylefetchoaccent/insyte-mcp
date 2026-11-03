// Diff of the data sets two systems expose: fields (name and type), keys and navigations.

import { DataSet } from "../insyte.js";

export interface SchemaDiff {
  onlyInA: string[];
  onlyInB: string[];
  common: number;
  identical: number;
  // One line per common data set that differs.
  changed: { name: string; line: string }[];
}

const list = (xs: string[]) => xs.join(", ");
const edm = (t: string) => t.replace(/^Edm\./, "");

export function diffSchemas(a: DataSet[], b: DataSet[], nameA: string, nameB: string): SchemaDiff {
  const mapA = new Map(a.map((s) => [s.name, s]));
  const mapB = new Map(b.map((s) => [s.name, s]));
  const onlyInA = [...mapA.keys()].filter((n) => !mapB.has(n)).sort();
  const onlyInB = [...mapB.keys()].filter((n) => !mapA.has(n)).sort();
  const both = [...mapA.keys()].filter((n) => mapB.has(n)).sort();
  const changed: SchemaDiff["changed"] = [];

  for (const name of both) {
    const sa = mapA.get(name)!;
    const sb = mapB.get(name)!;
    const parts: string[] = [];
    const fa = new Map(sa.fields.map((f) => [f.name, f.type]));
    const fb = new Map(sb.fields.map((f) => [f.name, f.type]));
    const fOnlyA = [...fa].filter(([n]) => !fb.has(n)).map(([n, t]) => `${n} (${edm(t)})`);
    const fOnlyB = [...fb].filter(([n]) => !fa.has(n)).map(([n, t]) => `${n} (${edm(t)})`);
    const typed = [...fa].filter(([n, t]) => fb.has(n) && fb.get(n) !== t).map(([n, t]) => `${n} ${nameA}=${edm(t)} ${nameB}=${edm(fb.get(n)!)}`);
    if (fOnlyA.length) parts.push(`fields only in ${nameA}: ${list(fOnlyA)}`);
    if (fOnlyB.length) parts.push(`fields only in ${nameB}: ${list(fOnlyB)}`);
    if (typed.length) parts.push(`type differs: ${list(typed)}`);
    if (sa.key.join(",") !== sb.key.join(",")) parts.push(`key ${nameA}=${sa.key.join("+")} ${nameB}=${sb.key.join("+")}`);
    const shape = (n: { name: string; targetType: string; collection: boolean }) => `${n.name} -> ${n.collection ? "many " : ""}${n.targetType}`;
    const na = new Map(sa.navigations.map((n) => [n.name, shape(n)]));
    const nb = new Map(sb.navigations.map((n) => [n.name, shape(n)]));
    const nOnlyA = [...na].filter(([n]) => !nb.has(n)).map(([, s]) => s);
    const nOnlyB = [...nb].filter(([n]) => !na.has(n)).map(([, s]) => s);
    const nDiff = [...na].filter(([n, s]) => nb.has(n) && nb.get(n) !== s).map(([n, s]) => `${n} ${nameA}: ${s}; ${nameB}: ${nb.get(n)}`);
    if (nOnlyA.length) parts.push(`navigations only in ${nameA}: ${list(nOnlyA)}`);
    if (nOnlyB.length) parts.push(`navigations only in ${nameB}: ${list(nOnlyB)}`);
    if (nDiff.length) parts.push(`navigation differs: ${list(nDiff)}`);
    if (parts.length) changed.push({ name, line: `- ${name}: ${parts.join(" | ")}` });
  }
  return { onlyInA, onlyInB, common: both.length, identical: both.length - changed.length, changed };
}
