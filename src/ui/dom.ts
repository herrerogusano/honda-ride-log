/**
 * Small helpers to build DOM and SVG nodes. Text always goes in as text
 * nodes, never as HTML, and there are no inline styles or handlers: the
 * Content Security Policy would block them.
 */

type Child = Node | string | null | undefined | false;

export interface Props {
  readonly class?: string;
  readonly id?: string;
  /** Plain attributes (ARIA, type, for, value...). `style` and `on*` are not allowed. */
  readonly attrs?: Readonly<Record<string, string | number | boolean | null | undefined>>;
  readonly on?: Readonly<Record<string, (event: Event) => void>>;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const FORBIDDEN_ATTRIBUTE = /^(style|on.*|srcdoc)$/i;

function apply(node: Element, props: Props, children: readonly Child[]): void {
  if (props.class !== undefined) node.setAttribute("class", props.class);
  if (props.id !== undefined) node.id = props.id;
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    if (FORBIDDEN_ATTRIBUTE.test(name)) throw new Error(`attribute not allowed: ${name}`);
    if (value === null || value === undefined || value === false) continue;
    node.setAttribute(name, value === true ? "" : String(value));
  }
  for (const [type, listener] of Object.entries(props.on ?? {})) node.addEventListener(type, listener);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  apply(node, props, children);
  return node;
}

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  apply(node, props, children);
  return node;
}

export function clear(node: Element): void {
  node.replaceChildren();
}

let counter = 0;

/** A document-unique id for ARIA references. */
export function uniqueId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}
