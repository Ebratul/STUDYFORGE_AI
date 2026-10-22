export type Area = { name: string; complete: boolean; prefixes: string[] };
export const AREAS: Area[];
export function extractKeys(root?: string): Map<string, string[]>;
export function areaOf(file: string): string[];
export function coverage(keys: Map<string, string[]>, bn: Record<string, string>): { area: string; complete: boolean; total: number; translated: number; missing: string[] }[];
export function readCatalog(name: string, root?: string): Record<string, string>;
export function placeholders(s: string): string[];
