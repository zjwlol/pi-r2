import type { Component } from "@earendil-works/pi-tui";
import type { TspKind, TspProps, TspSpan, TspText } from "./wire.ts";

export interface NativeNode {
	readonly k: TspKind;
	readonly p?: TspProps;
	readonly c?: readonly NativeChild[];
	readonly key?: string;
	readonly reveal?: "start" | "end" | "nearest";
}

export type NativeChild = NativeNode | Component;

export interface DescribeContext {
	readonly checkoutShown: boolean;
	readonly cols: number;
	readonly reduceMotion: boolean;
	readonly dark: boolean;
	readonly hour12?: boolean;
	supports(kind: TspKind): boolean;
	feature(name: string): boolean;
}

export interface NativeRegions {
	readonly main: readonly NativeChild[];
	readonly dock: readonly NativeChild[];
	readonly layer: readonly NativeChild[];
}

export type NativeUiEvent =
	| { readonly type: "toggle"; readonly key: string; readonly collapsed: boolean }
	| { readonly type: "select"; readonly key: string; readonly item: string }
	| { readonly type: "activate"; readonly key: string; readonly item: string }
	| { readonly type: "action"; readonly key: string; readonly act: string; readonly value?: string; readonly mods: readonly string[] }
	| { readonly type: "change"; readonly key: string; readonly item: string; readonly value: unknown }
	| { readonly type: "edit"; readonly key: string; readonly from: number; readonly to: number; readonly text: string; readonly cursor: number; readonly len: number }
	| { readonly type: "undo"; readonly key: string }
	| { readonly type: "send"; readonly key: string; readonly text: string };

export interface NativeAware {
	describe?(cx: DescribeContext): NativeNode | null;
	handleNativeEvent?(event: NativeUiEvent): void;
}

export function isComponent(child: NativeChild): child is Component {
	return typeof (child as Component).render === "function";
}

export function node(k: TspKind, p?: TspProps, c?: readonly NativeChild[], key?: string): NativeNode {
	const out: { k: TspKind; p?: TspProps; c?: readonly NativeChild[]; key?: string } = { k };
	if (p !== undefined) out.p = p;
	if (c !== undefined) out.c = c;
	if (key !== undefined) out.key = key;
	return out;
}

export function span(t: string, s?: string, extra?: Omit<TspSpan, "t" | "s">): TspSpan {
	return s === undefined && extra === undefined ? { t } : { t, s, ...extra };
}

export function text(content: TspText, p?: Omit<TspProps, "text" | "spans">, key?: string): NativeNode {
	return typeof content === "string" ? node("text", { ...p, text: content }, undefined, key) : node("text", { ...p, spans: content }, undefined, key);
}

export function col(c: readonly NativeChild[], p?: TspProps, key?: string): NativeNode {
	return node("col", p, c, key);
}

export function row(c: readonly NativeChild[], p?: TspProps, key?: string): NativeNode {
	return node("row", p, c, key);
}

export function card(p: TspProps, c: readonly NativeChild[], key?: string): NativeNode {
	return node("card", p, c, key);
}

export function md(source: string, p?: Omit<TspProps, "text">, key?: string): NativeNode {
	return node("md", { ...p, text: source }, undefined, key);
}

export function code(source: string, p?: Omit<TspProps, "text">, key?: string): NativeNode {
	return node("code", { ...p, text: source }, undefined, key);
}

export function diff(unified: string, p?: Omit<TspProps, "text">, key?: string): NativeNode {
	return node("diff", { ...p, text: unified }, undefined, key);
}

export function ansi(output: string, p?: Omit<TspProps, "text">, key?: string): NativeNode {
	return node("ansi", { ...p, text: output }, undefined, key);
}

export function spacer(size: "none" | "xs" | "sm" | "md" | "lg" = "sm", key?: string): NativeNode {
	return node("spacer", { size }, undefined, key);
}

export function rule(key?: string): NativeNode {
	return node("rule", undefined, undefined, key);
}

export const EMPTY_NODE: NativeNode = node("col", { hidden: true });

export function compact<T>(items: readonly (T | undefined | null | false)[]): T[] {
	const out: T[] = [];
	for (const entry of items) if (entry !== undefined && entry !== null && entry !== false) out.push(entry);
	return out;
}

export function sameFingerprint(a: readonly unknown[] | undefined, b: readonly unknown[]): boolean {
	if (!a || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (x === y) continue;
		if (Array.isArray(x) && Array.isArray(y)) {
			if (x.length !== y.length) return false;
			for (let j = 0; j < x.length; j++) if (x[j] !== y[j]) return false;
			continue;
		}
		if (typeof x === "number" && typeof y === "number" && Number.isNaN(x) && Number.isNaN(y)) continue;
		return false;
	}
	return true;
}

export function stripAnsi(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\x1b\[[0-9;?<>=!]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b[_P^][^\x1b]*\x1b\\/g, "").replace(/\x1b[()][A-Za-z0-9]/g, "").replace(/\x1b[=>78]/g, "");
}
