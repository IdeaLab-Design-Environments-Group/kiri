type Listener = (event: any) => void;

class MockClassList {
  private readonly names = new Set<string>();

  constructor(initial = "") {
    for (const name of initial.split(/\s+/).filter(Boolean)) this.names.add(name);
  }

  add(...names: string[]): void {
    for (const name of names) this.names.add(name);
  }

  remove(...names: string[]): void {
    for (const name of names) this.names.delete(name);
  }

  contains(name: string): boolean {
    return this.names.has(name);
  }

  toString(): string {
    return Array.from(this.names).join(" ");
  }
}

export class MockElement {
  readonly children: MockElement[] = [];
  readonly listeners = new Map<string, Listener[]>();
  parent: MockElement | null = null;
  classList = new MockClassList();
  private _className = "";
  textContent = "";
  hidden = false;
  disabled = false;
  type = "";
  accept = "";
  title = "";
  src = "";
  value = "";
  href = "";
  download = "";
  files?: File[];
  dataset: Record<string, string> = {};
  innerHTMLValue = "";
  contentWindow?: { postMessage: (payload: unknown, target: string) => void };

  constructor(readonly tagName: string) {}

  set className(value: string) {
    this._className = value;
    this.classList = new MockClassList(value);
  }

  get className(): string {
    return this._className;
  }

  append(...nodes: any[]): void {
    for (const node of nodes) {
      if (node instanceof MockElement) {
        node.parent = this;
        this.children.push(node);
      }
    }
  }

  appendChild(node: MockElement): MockElement {
    this.append(node);
    return node;
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  dispatch(type: string, event: any = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  click(): void {
    this.dispatch("click", { target: this });
  }

  remove(): void {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
    this.parent = null;
  }

  set innerHTML(value: string) {
    this.innerHTMLValue = value;
    this.children.length = 0;
    const tagRe = /<([a-z0-9-]+)([^>]*)>([^<]*)/gi;
    let match: RegExpExecArray | null;
    while ((match = tagRe.exec(value))) {
      const [, tag, attrs, text] = match;
      const child = new MockElement(tag);
      const classMatch = /class="([^"]+)"/.exec(attrs);
      if (classMatch) child.className = classMatch[1];
      const dataKMatch = /data-k="([^"]+)"/.exec(attrs);
      if (dataKMatch) child.dataset.k = dataKMatch[1];
      const typeMatch = /type="([^"]+)"/.exec(attrs);
      if (typeMatch) child.type = typeMatch[1];
      const minMatch = /min="([^"]+)"/.exec(attrs);
      if (minMatch) (child as any).min = minMatch[1];
      const maxMatch = /max="([^"]+)"/.exec(attrs);
      if (maxMatch) (child as any).max = maxMatch[1];
      const stepMatch = /step="([^"]+)"/.exec(attrs);
      if (stepMatch) (child as any).step = stepMatch[1];
      const valueMatch = /value="([^"]+)"/.exec(attrs);
      if (valueMatch) child.value = valueMatch[1];
      if (text.trim()) child.textContent = text.trim();
      child.parent = this;
      this.children.push(child);
    }
  }

  get innerHTML(): string {
    return this.innerHTMLValue;
  }

  querySelector(selector: string): MockElement | null {
    if (selector.startsWith(".")) {
      return childByClass(this, selector.slice(1)) ?? null;
    }
    const dataMatch = /^\[data-k="([^"]+)"\]$/.exec(selector);
    if (dataMatch) {
      return childByData(this, "k", dataMatch[1]) ?? null;
    }
    return childrenByTag(this, selector)[0] ?? null;
  }

  querySelectorAll(selector: string): MockElement[] {
    if (selector.startsWith(".")) return childrenByClass(this, selector.slice(1));
    return childrenByTag(this, selector);
  }
}

export class MockDocument {
  readonly body = new MockElement("body");
  readonly created: MockElement[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  createElement(tag: string): MockElement {
    const element = new MockElement(tag);
    this.created.push(element);
    return element;
  }

  querySelector(selector: string): MockElement | null {
    if (selector.startsWith(".")) {
      return childByClass(this.body, selector.slice(1)) ?? null;
    }
    return childrenByTag(this.body, selector)[0] ?? null;
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  dispatch(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

export class MockWindow {
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  dispatch(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

export function installDom(): { document: MockDocument; window: MockWindow } {
  const document = new MockDocument();
  const window = new MockWindow();
  (globalThis as any).document = document;
  (globalThis as any).window = window;
  return { document, window };
}

export function childByClass(root: MockElement, className: string): MockElement | undefined {
  if (root.className.split(/\s+/).includes(className)) return root;
  for (const child of root.children) {
    const found = childByClass(child, className);
    if (found) return found;
  }
  return undefined;
}

export function childrenByClass(root: MockElement, className: string): MockElement[] {
  const out: MockElement[] = [];
  if (root.className.split(/\s+/).includes(className)) out.push(root);
  for (const child of root.children) out.push(...childrenByClass(child, className));
  return out;
}

export function childByData(root: MockElement, key: string, value: string): MockElement | undefined {
  if (root.dataset[key] === value) return root;
  for (const child of root.children) {
    const found = childByData(child, key, value);
    if (found) return found;
  }
  return undefined;
}

export function childrenByTag(root: MockElement, tag: string): MockElement[] {
  const out: MockElement[] = [];
  if (root.tagName === tag) out.push(root);
  for (const child of root.children) out.push(...childrenByTag(child, tag));
  return out;
}
