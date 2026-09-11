import type {
  AdapterOpenContext,
  DocumentAdapter,
  DocumentInfo,
  PageSize,
  RenderViewport,
  ViewerWarning,
} from "../contracts.js";
import { abortError, ViewerError } from "../errors.js";
import { drawEncodedImage } from "./bitmap.js";

interface SvgHandle {
  readonly data: Uint8Array;
  /** Intrinsic size from the root `width`/`height` or `viewBox`, when declared. */
  readonly size: PageSize | undefined;
  readonly warnings: readonly ViewerWarning[];
}

export class SvgDocumentAdapter implements DocumentAdapter<SvgHandle> {
  readonly id = "svg";
  readonly formats = ["svg"] as const;

  async open(
    data: Uint8Array,
    context: AdapterOpenContext,
  ): Promise<SvgHandle> {
    if (context.signal.aborted) throw abortError();
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch (error) {
      throw new ViewerError("invalid-file", "SVG must be valid UTF-8", {
        cause: error,
      });
    }
    const sanitized = sanitizeSvg(source);
    const changed = sanitized !== source;
    return {
      data: new TextEncoder().encode(sanitized),
      size: parseSvgSize(sanitized),
      warnings: changed
        ? [
            {
              code: "external-resource-blocked",
              message: "Active SVG content or external resources were removed",
            },
          ]
        : [],
    };
  }

  async getInfo(handle: SvgHandle): Promise<DocumentInfo> {
    return {
      format: "svg",
      unit: "image",
      pageCount: 1,
      ...(handle.size ? { pageSizes: [handle.size] } : {}),
      warnings: handle.warnings,
    };
  }

  async render(
    handle: SvgHandle,
    target: HTMLCanvasElement | OffscreenCanvas,
    viewport: RenderViewport,
    signal?: AbortSignal,
  ): Promise<void> {
    if (viewport.pageIndex !== 0)
      throw new ViewerError("render-failed", "SVG page index is out of range");
    if (signal?.aborted) throw abortError();
    await drawEncodedImage(handle.data, "image/svg+xml", target, {
      dpr: viewport.devicePixelRatio,
      scale: viewport.zoom,
      ...(viewport.width === undefined ? {} : { cssWidth: viewport.width }),
      ...(viewport.height === undefined ? {} : { cssHeight: viewport.height }),
    });
    if (signal?.aborted) throw abortError();
  }

  async getTextMap(): Promise<readonly []> {
    return [];
  }

  close(): void {}
}

export function sanitizeSvg(source: string): string {
  const withoutDoctype = source.replace(/<!DOCTYPE[\s\S]*?>/gi, "");
  if (typeof DOMParser === "undefined")
    return sanitizeSvgFallback(withoutDoctype);
  const document = new DOMParser().parseFromString(
    withoutDoctype,
    "image/svg+xml",
  );
  if (
    document.querySelector("parsererror") ||
    document.documentElement.localName !== "svg"
  )
    throw new ViewerError("invalid-file", "Malformed SVG document");
  const blocked = new Set([
    "script",
    "style",
    "foreignobject",
    "iframe",
    "object",
    "embed",
    "audio",
    "video",
    "canvas",
  ]);
  for (const element of [...document.querySelectorAll("*")]) {
    if (blocked.has(element.localName.toLowerCase())) {
      element.remove();
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (
        name.startsWith("on") ||
        ((name === "href" || name === "xlink:href" || name === "src") &&
          !value.startsWith("#")) ||
        (/url\s*\(/i.test(value) && !/url\s*\(\s*['"]?#/i.test(value)) ||
        /expression\s*\(|@import/i.test(value)
      )
        element.removeAttribute(attribute.name);
    }
  }
  return new XMLSerializer().serializeToString(document.documentElement);
}

/** CSS absolute units → CSS pixels; percentages and unknown units are ignored. */
const SVG_LENGTH_UNITS: Readonly<Record<string, number>> = {
  "": 1,
  px: 1,
  pt: 96 / 72,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
};

/**
 * Intrinsic size of the root `<svg>` in CSS pixels at zoom 1: explicit
 * `width`/`height` win, a `viewBox` stands in for a missing pair, and a
 * document that declares neither has no natural size (the viewport keeps its
 * fallback page geometry).
 */
export function parseSvgSize(source: string): PageSize | undefined {
  const root = /<svg\b([^>]*)>/i.exec(source);
  if (!root) return undefined;
  const width = parseSvgLength(svgAttribute(root[1] ?? "", "width"));
  const height = parseSvgLength(svgAttribute(root[1] ?? "", "height"));
  if (width && height) return { width, height };
  const viewBox = svgAttribute(root[1] ?? "", "viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    viewBox?.length === 4 &&
    viewBox.every(Number.isFinite) &&
    viewBox[2]! > 0 &&
    viewBox[3]! > 0
  ) {
    // One declared side scales the viewBox aspect; none means viewBox units.
    if (width) return { width, height: (width * viewBox[3]!) / viewBox[2]! };
    if (height) return { width: (height * viewBox[2]!) / viewBox[3]!, height };
    return { width: viewBox[2]!, height: viewBox[3]! };
  }
  return undefined;
}

function svgAttribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    "i",
  ).exec(attributes);
  return match?.[1] ?? match?.[2];
}

function parseSvgLength(value: string | undefined): number | undefined {
  const match = /^\s*([0-9]*\.?[0-9]+(?:e[+-]?[0-9]+)?)\s*([a-z%]*)\s*$/i.exec(
    value ?? "",
  );
  if (!match) return undefined;
  const factor = SVG_LENGTH_UNITS[match[2]!.toLowerCase()];
  if (factor === undefined) return undefined;
  const length = Number(match[1]) * factor;
  return Number.isFinite(length) && length > 0 ? length : undefined;
}

export function createSvgAdapter(): SvgDocumentAdapter {
  return new SvgDocumentAdapter();
}

function sanitizeSvgFallback(source: string): string {
  let result = source;
  for (const tag of [
    "script",
    "style",
    "foreignObject",
    "iframe",
    "object",
    "embed",
    "audio",
    "video",
    "canvas",
  ]) {
    const paired = new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "gi");
    const single = new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi");
    result = result.replace(paired, "").replace(single, "");
  }
  result = result
    .replace(/\s+on[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(
      /\s+(?:href|xlink:href|src)\s*=\s*(?:"(?!#)[^"]*"|'(?!#)[^']*'|(?!#)[^\s>"']+)/gi,
      "",
    )
    .replace(
      /\s+style\s*=\s*(?:"[^"]*(?:url|expression|@import)[^"]*"|'[^']*(?:url|expression|@import)[^']*')/gi,
      "",
    );
  if (!/<svg(?:\s|>)/i.test(result))
    throw new ViewerError("invalid-file", "Malformed SVG document");
  return result;
}
