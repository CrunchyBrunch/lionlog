import { parse, type DefaultTreeAdapterTypes } from "parse5";

export type HtmlNode = DefaultTreeAdapterTypes.Node;
export type HtmlElement = DefaultTreeAdapterTypes.Element;

export function parseHtml(html: string): DefaultTreeAdapterTypes.Document {
  return parse(html);
}

export function isElement(node: HtmlNode): node is HtmlElement {
  return "tagName" in node;
}

export function getAttribute(element: HtmlElement, name: string): string | undefined {
  return element.attrs.find((attribute) => attribute.name.toLowerCase() === name.toLowerCase())?.value;
}

export function hasClass(element: HtmlElement, className: string): boolean {
  return (getAttribute(element, "class") ?? "").split(/\s+/).includes(className);
}

export function descendants(
  root: HtmlNode,
  predicate: (element: HtmlElement) => boolean,
): HtmlElement[] {
  const matches: HtmlElement[] = [];
  walk(root, (node) => {
    if (isElement(node) && predicate(node)) matches.push(node);
  });
  return matches;
}

export function firstDescendant(
  root: HtmlNode,
  predicate: (element: HtmlElement) => boolean,
): HtmlElement | undefined {
  let match: HtmlElement | undefined;
  walk(root, (node) => {
    if (!match && isElement(node) && predicate(node)) match = node;
  });
  return match;
}

export function normalizedText(root: HtmlNode): string {
  const chunks: string[] = [];
  walk(root, (node) => {
    if ("value" in node) chunks.push(node.value);
  });
  return normalizeText(chunks.join(" "));
}

export function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .split("")
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (codePoint > 31 && codePoint !== 127)
        || codePoint === 9
        || codePoint === 10
        || codePoint === 13;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function walk(root: HtmlNode, visit: (node: HtmlNode) => void): void {
  visit(root);
  if (!("childNodes" in root)) return;
  for (const child of root.childNodes) walk(child, visit);
}
